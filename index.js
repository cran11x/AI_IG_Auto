require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('redis');

const app = express();
app.use(express.json());

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const GROK_API_KEY = process.env.GROK_API_KEY;

const GROK_URL = 'https://api.x.ai/v1/chat/completions';
const GROK_MODEL = process.env.GROK_MODEL || 'grok-4';

const UCHAT_URL = 'https://www.uchat.com.au/api/subscriber/send-text';
const REDIS_URL = process.env.REDIS_URL;
const REDIS_KEY_PREFIX = process.env.REDIS_KEY_PREFIX || 'autodms';
const REQUIRE_REDIS = String(process.env.REQUIRE_REDIS || '').toLowerCase() === 'true';

/** If set, GET /messages* requires ?token=... or X-View-Token header (use when tunneling). */
const VIEW_MESSAGES_TOKEN = process.env.VIEW_MESSAGES_TOKEN;

// Max user+assistant turns kept (one optional system message is kept at index 0)
const MAX_HISTORY = 20;

// ── Bot config (Esma, Sara, …) ──────────────────────────────────────────────
const { BOTS, DEFAULT_BOT_ID, getBot, listBotIds } = require('./prompts/bots');
const { withTimeAwareMessages } = require('./prompts/timeContext');

// ── Conversation store (Redis primary; in-memory fallback) ───────────────────
// In-memory maps su keyani po `${botId}:${subscriberId}` da Esma i Sara nemaju zajedničku istoriju.
const conversations = new Map();
const redisClient = REDIS_URL ? createClient({ url: REDIS_URL }) : null;
let redisEnabled = false;

/** Svaki POST /webhook (zadnjih MAX_TRIGGER_LOG) — da vidiš što UChat triggera šalje. */
const MAX_TRIGGER_LOG = 100;
const triggerLog = [];

function rawJsonPreview(body, max = 4000) {
  try {
    const s = JSON.stringify(body, null, 0);
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return String(body).slice(0, max);
  }
}

function pushTrigger(entry) {
  triggerLog.unshift(entry);
  if (triggerLog.length > MAX_TRIGGER_LOG) triggerLog.length = MAX_TRIGGER_LOG;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const memKey = (botId, subscriberId) => `${botId}:${subscriberId}`;

const conversationKey = (botId, subscriberId) =>
  `${REDIS_KEY_PREFIX}:${botId}:conversation:${subscriberId}`;
const conversationIndexKey = (botId) => `${REDIS_KEY_PREFIX}:${botId}:conversations`;

async function loadConversation(botId, subscriberId) {
  if (redisEnabled) {
    const raw = await redisClient.get(conversationKey(botId, subscriberId));
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return conversations.get(memKey(botId, subscriberId));
}

async function saveConversation(botId, subscriberId, messages) {
  if (redisEnabled) {
    await redisClient
      .multi()
      .set(conversationKey(botId, subscriberId), JSON.stringify(messages))
      .sAdd(conversationIndexKey(botId), subscriberId)
      .exec();
    return;
  }
  conversations.set(memKey(botId, subscriberId), messages);
}

async function listConversationIds(botId) {
  if (redisEnabled) {
    return redisClient.sMembers(conversationIndexKey(botId));
  }
  const prefix = `${botId}:`;
  return [...conversations.keys()]
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));
}

// ── Pending flush (debounce user message clusters) ───────────────────────────
function readPositiveIntMs(envName, fallback) {
  const v = parseInt(process.env[envName] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const DEBOUNCE_MIN_MS = readPositiveIntMs('DEBOUNCE_MIN_MS', 30 * 60 * 1000);
let DEBOUNCE_MAX_MS = readPositiveIntMs('DEBOUNCE_MAX_MS', 90 * 60 * 1000);
if (DEBOUNCE_MAX_MS < DEBOUNCE_MIN_MS) {
  DEBOUNCE_MAX_MS = DEBOUNCE_MIN_MS + 60 * 1000;
}
const WORKER_POLL_MS = 15 * 1000;

const pendingMemStore = new Map();
const memoryFlushLocks = new Set();

const pendingRedisKey = (botId, subscriberId) =>
  `${REDIS_KEY_PREFIX}:${botId}:pending:${subscriberId}`;
const pendingIndexKey = (botId) => `${REDIS_KEY_PREFIX}:${botId}:pendingIndex`;
const flushLockRedisKey = (botId, subscriberId) =>
  `${REDIS_KEY_PREFIX}:${botId}:flushlock:${subscriberId}`;

function randomDebounceMs() {
  return DEBOUNCE_MIN_MS + Math.random() * (DEBOUNCE_MAX_MS - DEBOUNCE_MIN_MS);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countUserMessages(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.filter((m) => m.role === 'user').length;
}

function lastNonSystemRole(messages) {
  const tail = messages.filter((m) => m.role !== 'system');
  return tail.length ? tail[tail.length - 1].role : undefined;
}

/** Split Grok reply into 1–3 short chunks for natural DM sending. */
function splitReplySmart(reply) {
  const text = String(reply || '').trim();
  if (!text) return [];
  const maxParts = 4;
  const maxLen = 135;

  const mergeToParts = (chunks) => {
    const trimmed = chunks.map((c) => String(c).trim()).filter(Boolean);
    if (!trimmed.length) return [];
    const out = [];
    let buf = '';
    for (const c of trimmed) {
      if (!buf) buf = c;
      else if (buf.length + 1 + c.length <= maxLen) buf += `\n${c}`;
      else {
        out.push(buf);
        buf = c;
      }
    }
    if (buf) out.push(buf);

    // Blaga randomizacija: u ~30% slučajeva spoji zadnje dvije poruke ako nisu preduge, da varira broj poruka
    if (out.length > 1 && Math.random() < 0.3) {
      const last1 = out.pop();
      const last2 = out.pop();
      if (last1 && last2 && (last1.length + last2.length) < 160) {
        out.push(`${last2}\n${last1}`);
      } else {
        if (last2) out.push(last2);
        if (last1) out.push(last1);
      }
    }

    while (out.length > maxParts) {
      out[out.length - 2] = `${out[out.length - 2]}\n${out.pop()}`;
    }
    return out.length ? out : [text];
  };

  if (text.length <= maxLen) return [text];

  const para = text.split(/\n\n+/);
  if (para.length >= 2) return mergeToParts(para);

  const sentences = text.split(/(?<=[.!?])\s+/);
  if (sentences.length >= 2) return mergeToParts(sentences);

  const mid = Math.ceil(text.length / 2);
  return mergeToParts([text.slice(0, mid), text.slice(mid)]);
}

async function loadPending(botId, subscriberId) {
  if (redisEnabled) {
    const raw = await redisClient.get(pendingRedisKey(botId, subscriberId));
    if (!raw) return undefined;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return pendingMemStore.get(memKey(botId, subscriberId));
}

async function persistPendingStore(botId, subscriberId, payload) {
  if (redisEnabled) {
    await redisClient
      .multi()
      .set(pendingRedisKey(botId, subscriberId), JSON.stringify(payload))
      .sAdd(pendingIndexKey(botId), subscriberId)
      .exec();
    return;
  }
  pendingMemStore.set(memKey(botId, subscriberId), payload);
}

async function schedulePending(botId, subscriberId, meta) {
  const existing = (await loadPending(botId, subscriberId)) || {};
  const dueAt = Date.now() + randomDebounceMs();
  const payload = {
    ...existing,
    ...meta,
    botId,
    dueAt
  };
  await persistPendingStore(botId, subscriberId, payload);
  return dueAt;
}

async function clearPending(botId, subscriberId) {
  if (redisEnabled) {
    await redisClient
      .multi()
      .del(pendingRedisKey(botId, subscriberId))
      .sRem(pendingIndexKey(botId), subscriberId)
      .exec();
    return;
  }
  pendingMemStore.delete(memKey(botId, subscriberId));
}

async function listPendingIds(botId) {
  if (redisEnabled) {
    return redisClient.sMembers(pendingIndexKey(botId));
  }
  const prefix = `${botId}:`;
  return [...pendingMemStore.keys()]
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));
}

async function acquireFlushLock(botId, subscriberId) {
  if (redisEnabled) {
    const ok = await redisClient.set(flushLockRedisKey(botId, subscriberId), '1', { NX: true, EX: 120 });
    return ok === 'OK';
  }
  const k = memKey(botId, subscriberId);
  if (memoryFlushLocks.has(k)) return false;
  memoryFlushLocks.add(k);
  return true;
}

async function releaseFlushLock(botId, subscriberId) {
  if (redisEnabled) {
    await redisClient.del(flushLockRedisKey(botId, subscriberId));
    return;
  }
  memoryFlushLocks.delete(memKey(botId, subscriberId));
}

async function flushPending(botId, subscriberId) {
  if (!GROK_API_KEY) return;
  const bot = getBot(botId);
  if (!bot) return;

  const pendingRaw = await loadPending(botId, subscriberId);
  if (!pendingRaw || pendingRaw.dueAt > Date.now()) return;

  const msgsBefore = await loadConversation(botId, subscriberId);
  if (!Array.isArray(msgsBefore) || msgsBefore.length === 0) {
    await clearPending(botId, subscriberId);
    return;
  }
  if (lastNonSystemRole(msgsBefore) !== 'user') {
    await clearPending(botId, subscriberId);
    return;
  }

  const userSnap = countUserMessages(msgsBefore);

  const got = await acquireFlushLock(botId, subscriberId);
  if (!got) return;

  try {
    const pendingAgain = await loadPending(botId, subscriberId);
    if (!pendingAgain || pendingAgain.dueAt > Date.now()) return;

    const messagesForGrok = await loadConversation(botId, subscriberId);
    if (countUserMessages(messagesForGrok) !== userSnap) return;

    const grokMessages = withTimeAwareMessages(messagesForGrok, bot.timezone);

    const grokResponse = await axios.post(
      GROK_URL,
      {
        model: GROK_MODEL,
        messages: grokMessages,
        temperature: 0.8
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GROK_API_KEY}`
        },
        timeout: 60000
      }
    );

    const reply = grokResponse.data.choices[0].message.content;

    const messagesAfterGrok = await loadConversation(botId, subscriberId);
    if (countUserMessages(messagesAfterGrok) !== userSnap) {
      console.warn(`⚠️  [${bot.id}/${subscriberId}] Flush aborted after Grok (new user messages).`);
      return;
    }

    const parts = splitReplySmart(reply);
    const chunks = parts.length ? parts : [String(reply)];

    const uchatApiKey = bot.uchatApiKey;
    if (uchatApiKey) {
      for (let i = 0; i < chunks.length; i++) {
        const part = chunks[i];
        await axios.post(
          UCHAT_URL,
          { user_ns: subscriberId, content: part },
          {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${uchatApiKey}`
            },
            timeout: 15000
          }
        );
        if (i < chunks.length - 1) {
          await sleep(1500 + Math.random() * 2500);
        }
      }
    } else {
      console.warn(`⚠️  UChat API key missing for bot=${bot.id}; reply not sent for ${subscriberId}`);
    }

    const fresh = await loadConversation(botId, subscriberId);
    if (countUserMessages(fresh) !== userSnap) return;

    fresh.push({ role: 'assistant', content: reply });
    trimHistory(fresh);
    await saveConversation(botId, subscriberId, fresh);

    await clearPending(botId, subscriberId);

    pushTrigger({
      id: `${Date.now()}-flush-${Math.random().toString(36).slice(2, 9)}`,
      at: new Date().toISOString(),
      outcome: 'flushed',
      bot: bot.id,
      subscriber_id: subscriberId,
      reply_preview: String(reply).slice(0, 200)
    });

    console.log(`✅ [${bot.id}/${subscriberId}] Flushed cluster (${chunks.length} UChat part(s))`);
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error(`❌ Flush failed [${bot.id}/${subscriberId}]:`, detail);
  } finally {
    await releaseFlushLock(botId, subscriberId);
  }
}

async function pendingWorkerTick() {
  try {
    for (const botId of listBotIds()) {
      const ids = await listPendingIds(botId);
      await Promise.all(ids.map((id) => flushPending(botId, String(id))));
    }
  } catch (e) {
    console.error('worker tick error', e.message);
  }
}

let pendingWorkerStarted = false;
function startPendingWorker() {
  if (pendingWorkerStarted) return;
  pendingWorkerStarted = true;
  setInterval(pendingWorkerTick, WORKER_POLL_MS);
  console.log(
    `⏳ Pending worker (debounce ${DEBOUNCE_MIN_MS / 60000}-${DEBOUNCE_MAX_MS / 60000} min, poll ${WORKER_POLL_MS / 1000}s)`
  );
}

// Get or create conversation history for a (bot, subscriber) pair
async function getHistory(botId, subscriberId, firstName, igUsername) {
  const bot = getBot(botId);
  let existing = await loadConversation(botId, subscriberId);
  if (!existing) {
    let customPrompt = bot.prompt;
    if (firstName || igUsername) {
      const namePart = [firstName, igUsername ? `(@${igUsername})` : ''].filter(Boolean).join(' ');
      customPrompt += `\nYou are currently talking to: ${namePart}.`;
    }

    existing = [{ role: 'system', content: customPrompt }];
    await saveConversation(botId, subscriberId, existing);
  }
  return existing;
}

// Trim history (keep optional system at [0]; otherwise last MAX_HISTORY user/assistant msgs)
function trimHistory(messages) {
  if (messages.length === 0) return;
  const hasSystem = messages[0].role === 'system';
  const tail = hasSystem ? messages.slice(1) : messages.slice();
  if (tail.length <= MAX_HISTORY) return;
  const trimmed = tail.slice(tail.length - MAX_HISTORY);
  const systemMsg = hasSystem ? messages[0] : null;
  messages.length = 0;
  if (systemMsg) messages.push(systemMsg, ...trimmed);
  else messages.push(...trimmed);
}

// Pull subscriber id + last user text from Make.com or UChat payload shapes
function extractWebhookFields(body) {
  // Očekujemo strukturu npr: { "sender_id": "123", "text": "Bok", "name": "Dani" }
  // Ili za UChat: { "user_ns": "...", "text": "...", "name": "...", "username": "..." }

  const pickFirstNonEmpty = (...vals) => {
    for (const v of vals) {
      if (v == null) continue;
      const s = String(v).trim();
      if (s) return s;
    }
    return undefined;
  };

  const looksLikeStoryEvent = (payload) => {
    const obviousFlags = [
      payload.story,
      payload.story_reply,
      payload.story_reaction,
      payload.story_reply_id,
      payload.story_id,
      payload.story_pk,
      payload.reply_to_story,
      payload.replied_to_story
    ];
    if (obviousFlags.some(Boolean)) return true;

    const textFlags = [
      payload.event,
      payload.type,
      payload.message_type,
      payload.trigger,
      payload.action,
      payload.source
    ]
      .filter(Boolean)
      .map((v) => String(v).toLowerCase());

    return textFlags.some((v) => v.includes('story'));
  };

  const subscriberId = body.user_ns || body.sender_id || body.id || body.subscriber_id;
  let userText = pickFirstNonEmpty(
    body.text,
    body.message,
    body.last_input_text,
    body.caption,
    body.reply,
    body.prompt,
    body.story_reply_text,
    body.story_reply?.text,
    body.payload?.text
  );

  // Some story-reply/reaction webhooks arrive without text; convert them into safe fallback input.
  if (!userText && looksLikeStoryEvent(body)) {
    const reaction = pickFirstNonEmpty(
      body.story_reaction,
      body.reaction,
      body.emoji,
      body.story_reply?.emoji,
      body.payload?.emoji
    );
    userText = reaction ? `story reaction ${reaction}` : 'replied to your story';
  }

  const firstName = body.name || body.first_name;
  const igUsername = body.username || body.ig_username;

  return {
    subscriberId: subscriberId != null ? String(subscriberId) : undefined,
    userText: userText != null ? String(userText).trim() : undefined,
    firstName: firstName || undefined,
    igUsername: igUsername || undefined
  };
}

function assertViewMessagesAuth(req, res) {
  if (!VIEW_MESSAGES_TOKEN) return true;
  const got =
    req.query.token ||
    req.headers['x-view-token'] ||
    req.headers['x-view-messages-token'];
  if (got !== VIEW_MESSAGES_TOKEN) {
    res.status(401).json({ error: 'Unauthorized', hint: 'Set ?token= or X-View-Token' });
    return false;
  }
  return true;
}

/** Strip system prompt body for API / UI (keep role label). */
function redactMessagesForView(messages) {
  return messages.map((m) =>
    m.role === 'system'
      ? { role: 'system', content: '[system prompt]' }
      : { role: m.role, content: m.content }
  );
}

// ── Webhook handler factory (per-bot route → shared logic) ───────────────────
function makeWebhookHandler(botId) {
  return async (req, res) => {
    const triggerId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const bot = getBot(botId);
    try {
      const body = req.body;
      console.log(`📩 [${bot ? bot.id : '?'}] Incoming webhook:`, JSON.stringify(body).slice(0, 500));

      if (!bot) {
        pushTrigger({
          id: triggerId,
          at: new Date().toISOString(),
          outcome: 'skipped',
          reason: 'unknown_bot',
          bot: botId,
          raw_json: rawJsonPreview(body || {})
        });
        return res.status(404).json({
          status: 'error',
          reason: `Unknown bot id "${botId}". Known: ${listBotIds().join(', ')}`
        });
      }

      const { subscriberId, userText, firstName, igUsername } = extractWebhookFields(body);

      if (!GROK_API_KEY) {
        console.error('❌ GROK_API_KEY missing');
        return res.status(500).json({ status: 'error', reason: 'GROK_API_KEY not configured' });
      }

      if (!subscriberId || !userText) {
        const reason = !subscriberId ? 'missing_sender_id' : 'missing_text';
        console.warn('⚠️  Skipping (queue):', { bot: bot.id, reason, subscriberId, userText });
        pushTrigger({
          id: triggerId,
          at: new Date().toISOString(),
          outcome: 'skipped',
          reason,
          bot: bot.id,
          subscriber_id: subscriberId ?? null,
          first_name: firstName ?? null,
          ig_username: igUsername ?? null,
          user_text: userText ?? null,
          raw_json: rawJsonPreview(body)
        });
        return res.status(400).json({
          status: 'error',
          reason: 'Missing sender_id or text in body'
        });
      }

      console.log(`👤 [${bot.id}/${subscriberId}] User says: "${userText}"`);

      const messages = await getHistory(bot.id, subscriberId, firstName, igUsername);
      messages.push({ role: 'user', content: userText });
      trimHistory(messages);
      await saveConversation(bot.id, subscriberId, messages);

      const dueAt = await schedulePending(bot.id, subscriberId, {
        firstName,
        igUsername,
        path: req.path
      });

      pushTrigger({
        id: triggerId,
        at: new Date().toISOString(),
        outcome: 'queued',
        bot: bot.id,
        subscriber_id: subscriberId,
        first_name: firstName ?? null,
        ig_username: igUsername ?? null,
        user_text: userText,
        scheduled_for: new Date(dueAt).toISOString(),
        raw_json: rawJsonPreview(body)
      });

      return res.status(202).json({
        status: 'queued',
        bot: bot.id,
        scheduled_for: new Date(dueAt).toISOString(),
        sender_id: subscriberId
      });
    } catch (err) {
      const detail = err.response?.data || err.message;
      console.error('❌ Webhook error:', detail);
      const body = req.body;
      const { subscriberId, userText, firstName, igUsername } = extractWebhookFields(body || {});
      pushTrigger({
        id: triggerId,
        at: new Date().toISOString(),
        outcome: 'error',
        bot: bot ? bot.id : botId,
        subscriber_id: subscriberId ?? null,
        first_name: firstName ?? null,
        ig_username: igUsername ?? null,
        user_text: userText ?? null,
        error: typeof detail === 'string' ? detail.slice(0, 500) : rawJsonPreview(detail, 800),
        raw_json: rawJsonPreview(body || {})
      });
      return res.status(500).json({ error: 'Internal server error', detail });
    }
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────
// Per-bot routes (preferred): /webhook/uchat/esma, /webhook/uchat/sara, …
for (const botId of listBotIds()) {
  const handler = makeWebhookHandler(botId);
  app.post(`/webhook/uchat/${botId}`, handler);
  app.post(`/webhook/${botId}`, handler);
}

// Backward-compat: stari URL-ovi i dalje gađaju default (Esma)
const defaultHandler = makeWebhookHandler(DEFAULT_BOT_ID);
app.post('/webhook', defaultHandler);
app.post('/webhook/', defaultHandler);
app.post('/webhook/make', defaultHandler);
app.post('/webhook/uchat', defaultHandler);

// Browser šalje GET — webhook je samo POST
const webhookGetInfoHtml = `<!DOCTYPE html>
<html lang="hr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Webhook — samo POST</title>
<style>body{font-family:system-ui;max-width:40rem;margin:2rem;line-height:1.5} code{background:#f0f0f0;padding:2px 6px;border-radius:4px}</style>
</head><body>
<h1>Ovo nije greška</h1>
<p><strong>UChat External Request šalje <code>POST</code></strong> na ovaj URL. Preglednik kad otvoriš link uvijek šalje <strong><code>GET</code></strong>, pa Express nema GET rutu za webhook — zato si prije vidio „Cannot GET”.</p>
<p>Per-bot rute: <code>POST /webhook/uchat/esma</code>, <code>POST /webhook/uchat/sara</code>.</p>
<p>Za test u browseru otvori: <a href="/">/</a> (health), <a href="/triggers?format=html">/triggers</a> ili <a href="/messages?format=html">/messages</a>.</p>
</body></html>`;
app.get('/webhook', (_req, res) => res.type('html').send(webhookGetInfoHtml));
app.get('/webhook/make', (_req, res) => res.type('html').send(webhookGetInfoHtml));
app.get('/webhook/', (_req, res) => res.type('html').send(webhookGetInfoHtml));
app.get('/webhook/uchat', (_req, res) => res.type('html').send(webhookGetInfoHtml));
for (const botId of listBotIds()) {
  app.get(`/webhook/uchat/${botId}`, (_req, res) => res.type('html').send(webhookGetInfoHtml));
  app.get(`/webhook/${botId}`, (_req, res) => res.type('html').send(webhookGetInfoHtml));
}

// ── GET / — health check ─────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  const lines = listBotIds().map((id) => {
    const b = BOTS[id];
    const keyOk = !!b.uchatApiKey;
    return `  • ${b.displayName} (${b.id}) — POST /webhook/uchat/${b.id} — UChat key ${keyOk ? 'OK' : 'MISSING'}`;
  });
  res.type('text').send(`Multi-bot UChat + Grok webhook running 🚀\n\nBots:\n${lines.join('\n')}\n`);
});

// ── GET /triggers — svi dolazni webhook pozivi ───────────────────────────────
app.get('/triggers', (req, res) => {
  if (!assertViewMessagesAuth(req, res)) return;

  const wantsHtml =
    req.query.format === 'html' ||
    (typeof req.headers.accept === 'string' &&
      req.headers.accept.includes('text/html'));

  const tokenQ = VIEW_MESSAGES_TOKEN
    ? `&token=${encodeURIComponent(VIEW_MESSAGES_TOKEN)}`
    : '';

  if (wantsHtml) {
    const esc = (s) =>
      String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    const rows = triggerLog
      .map((t) => {
        const raw = esc(t.raw_json || '');
        const namePart = [t.first_name, t.ig_username ? `@${t.ig_username}` : ''].filter(Boolean).join(' ');
        return `<tr><td style="white-space:nowrap">${esc(t.at)}</td><td><code>${esc(
          t.bot || ''
        )}</code></td><td><code>${esc(t.outcome)}</code></td><td>${esc(t.subscriber_id ?? '')}<br><small style="color:#666">${esc(namePart)}</small></td><td>${esc(
          (t.user_text || '').slice(0, 120)
        )}</td><td>${esc(t.reason || t.error || t.reply_preview || '')}</td></tr>
<tr><td colspan="6" style="background:#fafafa;font-size:12px"><details><summary>raw JSON</summary><pre style="white-space:pre-wrap;word-break:break-all;margin:8px 0">${raw}</pre></details></td></tr>`;
      })
      .join('\n');
    res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Webhook triggers</title>
<style>body{font-family:system-ui;margin:1rem;} table{border-collapse:collapse;width:100%} th,td{border:1px solid #ccc;padding:8px;text-align:left} th{background:#f4f4f4} code{font-size:12px}</style>
</head><body>
<h1>Dolazni webhookovi (trigeri)</h1>
<p>Zadnjih ${MAX_TRIGGER_LOG} zahtjeva. <a href="/messages?format=html${tokenQ}">Threads →</a></p>
<table><thead><tr><th>Vrijeme (UTC)</th><th>Bot</th><th>Ishod</th><th>sender_id</th><th>Tekst</th><th>Napomena</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6">Još nema triggera — pošalji poruku kad je flow povezan.</td></tr>'}</tbody></table>
<p><a href="/triggers?format=json${tokenQ}">JSON</a></p>
</body></html>`);
    return;
  }

  res.json({
    count: triggerLog.length,
    triggers: triggerLog.map(({ raw_json, ...rest }) => ({
      ...rest,
      raw_json_length: raw_json?.length ?? 0,
      raw_json
    })),
    hint: 'Svaki red = jedan HTTP POST na /webhook/.... Pogledaj raw_json ako payload nije ispravan.'
  });
});

// ── GET /messages — list svih (bot, subscriber) threadova ────────────────────
app.get('/messages', async (req, res) => {
  if (!assertViewMessagesAuth(req, res)) return;

  try {
    const wantsHtml =
      req.query.format === 'html' ||
      (typeof req.headers.accept === 'string' &&
        req.headers.accept.includes('text/html'));

    const filterBot = req.query.bot ? String(req.query.bot).toLowerCase() : null;
    const botsToList = filterBot ? [filterBot] : listBotIds();

    const rows = [];
    for (const botId of botsToList) {
      if (!getBot(botId)) continue;
      const ids = await listConversationIds(botId);
      const tuples = await Promise.all(ids.map(async (id) => [id, await loadConversation(botId, id)]));
      for (const [id, msgs] of tuples) {
        if (!Array.isArray(msgs)) continue;
        const nonSys = msgs.filter((m) => m.role !== 'system');
        const last = nonSys[nonSys.length - 1];
        rows.push({
          bot: botId,
          subscriber_id: id,
          message_count: nonSys.length,
          last_role: last?.role,
          last_preview: last?.content ? String(last.content).slice(0, 120) : null
        });
      }
    }

    if (wantsHtml) {
      const esc = (s) =>
        String(s)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      const tokenQ = VIEW_MESSAGES_TOKEN
        ? `&token=${encodeURIComponent(VIEW_MESSAGES_TOKEN)}`
        : '';
      const lines = rows
        .map(
          (r) =>
            `<tr><td><code>${esc(r.bot)}</code></td><td><a href="/messages/${encodeURIComponent(r.bot)}/${encodeURIComponent(r.subscriber_id)}?format=html${tokenQ}">${esc(r.subscriber_id)}</a></td><td>${r.message_count}</td><td>${esc(r.last_role || '')}</td><td>${esc(r.last_preview || '')}</td></tr>`
        )
        .join('\n');
      res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Grok threads</title>
<style>body{font-family:system-ui;margin:1rem;} table{border-collapse:collapse;width:100%} th,td{border:1px solid #ccc;padding:8px;text-align:left} th{background:#f4f4f4}</style>
</head><body>
<h1>${redisEnabled ? 'Redis' : 'In-memory'} threads</h1>
<p>${VIEW_MESSAGES_TOKEN ? 'Token required.' : ''} <a href="/triggers?format=html${tokenQ}">Dolazni triggeri →</a></p>
<table><thead><tr><th>Bot</th><th>Subscriber</th><th>Msgs</th><th>Last role</th><th>Preview</th></tr></thead>
<tbody>${lines || '<tr><td colspan="5">No messages yet</td></tr>'}</tbody></table>
<p><a href="/messages?format=json${tokenQ}">JSON</a></p>
</body></html>`);
      return;
    }

    res.json({
      count: rows.length,
      subscribers: rows,
      hint: 'GET /messages/:botId/:subscriber_id for full thread; ?bot=esma to filter; ?format=html for UI'
    });
  } catch (err) {
    console.error('❌ /messages error:', err.message);
    return res.status(500).json({ error: 'Failed to read conversations' });
  }
});

// ── GET /messages/:botId/:subscriberId — one thread ──────────────────────────
async function renderThread(req, res, botId, subscriberId) {
  const bot = getBot(botId);
  if (!bot) {
    return res.status(404).json({ error: 'Unknown bot id', bot: botId });
  }

  const msgs = await loadConversation(bot.id, subscriberId);
  if (!msgs) {
    return res.status(404).json({ error: 'Unknown subscriber_id', bot: bot.id, subscriber_id: subscriberId });
  }

  const wantsHtml =
    req.query.format === 'html' ||
    (typeof req.headers.accept === 'string' &&
      req.headers.accept.includes('text/html'));

  const view = redactMessagesForView(msgs);

  if (wantsHtml) {
    const esc = (s) =>
      String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    const tokenQ = VIEW_MESSAGES_TOKEN
      ? `&token=${encodeURIComponent(VIEW_MESSAGES_TOKEN)}`
      : '';
    const blocks = view
      .map(
        (m) =>
          `<div style="margin:12px 0;padding:12px;border-radius:8px;background:${m.role === 'user' ? '#e8f4ff' : m.role === 'assistant' ? '#f0f0f0' : '#fff8e1'}"><strong>${esc(m.role)}</strong><pre style="white-space:pre-wrap;margin:8px 0 0;font:inherit">${esc(m.content)}</pre></div>`
      )
      .join('\n');
    res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Thread ${esc(bot.id)}/${esc(subscriberId)}</title>
<style>body{font-family:system-ui;margin:1rem;max-width:720px}</style>
</head><body>
<p><a href="/messages?format=html${tokenQ}">← All threads</a></p>
<h1>${esc(bot.displayName)} · ${esc(subscriberId)}</h1>
${blocks}
</body></html>`);
    return;
  }

  res.json({ bot: bot.id, subscriber_id: subscriberId, messages: view });
}

app.get('/messages/:botId/:subscriberId', async (req, res) => {
  if (!assertViewMessagesAuth(req, res)) return;
  await renderThread(req, res, req.params.botId, req.params.subscriberId);
});

// Backward-compat: /messages/:subscriberId → default bot
app.get('/messages/:subscriberId', async (req, res) => {
  if (!assertViewMessagesAuth(req, res)) return;
  // Ako je :subscriberId zapravo botId, redirect na listing tog bota
  if (getBot(req.params.subscriberId)) {
    const tokenQ = VIEW_MESSAGES_TOKEN
      ? `&token=${encodeURIComponent(VIEW_MESSAGES_TOKEN)}`
      : '';
    return res.redirect(`/messages?bot=${req.params.subscriberId}&format=${req.query.format || 'json'}${tokenQ}`);
  }
  await renderThread(req, res, DEFAULT_BOT_ID, req.params.subscriberId);
});

// POST na krivi URL — zapiši u triggere radi debuga
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  const triggerId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  pushTrigger({
    id: triggerId,
    at: new Date().toISOString(),
    outcome: 'wrong_path',
    reason: `POST ${req.path} — koristi POST .../webhook/uchat/<bot>`,
    subscriber_id: null,
    user_text: null,
    raw_json: rawJsonPreview(req.body || {})
  });
  return res.status(404).json({
    error: 'Use POST /webhook/uchat/<bot>',
    path: req.path,
    bots: listBotIds(),
    hint: 'Per-bot URL: /webhook/uchat/esma ili /webhook/uchat/sara'
  });
});

// ── Global error handler ─────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('💥 Unhandled error:', err.message);
  res.status(500).json({ error: 'Something broke' });
});

// ── Start server ─────────────────────────────────────────────────────────────
async function startServer() {
  if (REQUIRE_REDIS && !redisClient) {
    throw new Error('REQUIRE_REDIS=true but REDIS_URL is missing');
  }

  if (redisClient) {
    redisClient.on('error', (err) => {
      console.error('❌ Redis error:', err.message);
    });
    await redisClient.connect();
    redisEnabled = true;
    console.log('🧠 Conversation storage: Redis connected');
  } else {
    console.warn('⚠️  REDIS_URL not set. Using in-memory conversations only.');
  }

  startPendingWorker();

  app.listen(PORT, () => {
    console.log(`\n🟢 Webhook server running on http://localhost:${PORT}`);
    for (const botId of listBotIds()) {
      const b = BOTS[botId];
      const keyOk = !!b.uchatApiKey;
      console.log(`   POST /webhook/uchat/${b.id}  ← ${b.displayName} (UChat key ${keyOk ? 'OK' : 'MISSING'})`);
    }
    console.log(`   POST /webhook                ← legacy alias → ${DEFAULT_BOT_ID}`);
    console.log(`   GET  /                       ← Health check`);
    console.log(
      `   GET  /messages?format=html   ← View ${redisEnabled ? 'Redis-backed' : 'in-memory'} Grok threads${VIEW_MESSAGES_TOKEN ? ' (token required)' : ''}`
    );
    console.log(
      `   GET  /triggers?format=html   ← Dolazni POST /webhook${VIEW_MESSAGES_TOKEN ? ' (token required)' : ''}`
    );
    console.log(`   Tip: npm run dev:public      → Public HTTPS URL (TUNNEL=serveo|pinggy|cloudflare)\n`);
  });
}

startServer().catch((err) => {
  console.error('❌ Failed to start server:', err.message);
  process.exit(1);
});
