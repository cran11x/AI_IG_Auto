require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('redis');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const GROK_API_KEY = process.env.GROK_API_KEY;

const GROK_URL = 'https://api.x.ai/v1/chat/completions';
const GROK_MODEL = process.env.GROK_MODEL || 'grok-4';

const UCHAT_URL = 'https://www.uchat.com.au/api/subscriber/send-text';
const UCHAT_HISTORY_URL = 'https://www.uchat.com.au/api/subscriber/chat-messages';
const REDIS_URL = process.env.REDIS_URL;
const REDIS_KEY_PREFIX = process.env.REDIS_KEY_PREFIX || 'autodms';
const REQUIRE_REDIS = String(process.env.REQUIRE_REDIS || '').toLowerCase() === 'true';

// Auto-import last UChat messages into Redis on first webhook for a subscriber.
const UCHAT_HISTORY_IMPORT_ENABLED =
  String(process.env.UCHAT_HISTORY_IMPORT_ENABLED || 'true').toLowerCase() !== 'false';
const UCHAT_HISTORY_IMPORT_LIMIT = (() => {
  const raw = parseInt(process.env.UCHAT_HISTORY_IMPORT_LIMIT || '', 10);
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw, 100);
  return 15;
})();
const UCHAT_HISTORY_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env.UCHAT_HISTORY_TIMEOUT_MS || '', 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 12000;
})();

/** If set, GET /messages* requires ?token=... or X-View-Token header (use when tunneling). */
const VIEW_MESSAGES_TOKEN = process.env.VIEW_MESSAGES_TOKEN;

// Max user+assistant turns kept (one optional system message is kept at index 0)
const MAX_HISTORY = 20;

// ── Bot config (Esma, Sara, …) ──────────────────────────────────────────────
const { BOTS, DEFAULT_BOT_ID, getBot, listBotIds } = require('./prompts/bots');
const { variants } = require('./prompts/variants');
const { withTimeAwareMessages } = require('./prompts/timeContext');
const { createPromptLab } = require('./promptLab');
let promptLab = null;

// ── Conversation store (Redis primary; in-memory fallback) ───────────────────
// In-memory maps su keyani po `${botId}:${subscriberId}` da Esma i Sara nemaju zajedničku istoriju.
const conversations = new Map();
const subscriberMetaStore = new Map();
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
const subscriberMetaKey = (botId, subscriberId) =>
  `${REDIS_KEY_PREFIX}:${botId}:subscriberMeta:${subscriberId}`;

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

async function loadSubscriberMeta(botId, subscriberId) {
  if (redisEnabled) {
    const raw = await redisClient.get(subscriberMetaKey(botId, subscriberId));
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return subscriberMetaStore.get(memKey(botId, subscriberId)) || {};
}

function compactSubscriberMeta(meta) {
  const clean = {};
  if (meta.firstName) clean.firstName = String(meta.firstName).trim();
  if (meta.igUsername) clean.igUsername = String(meta.igUsername).replace(/^@/, '').trim();
  if (meta.imageUrl) clean.imageUrl = String(meta.imageUrl).trim();
  return Object.fromEntries(Object.entries(clean).filter(([, v]) => v));
}

async function saveSubscriberMeta(botId, subscriberId, meta) {
  const clean = compactSubscriberMeta(meta || {});
  if (!Object.keys(clean).length) return;
  const existing = await loadSubscriberMeta(botId, subscriberId);
  const next = {
    ...existing,
    ...clean,
    updated_at: new Date().toISOString()
  };
  if (redisEnabled) {
    await redisClient.set(subscriberMetaKey(botId, subscriberId), JSON.stringify(next));
    return;
  }
  subscriberMetaStore.set(memKey(botId, subscriberId), next);
}

async function getEffectivePromptBody(bot) {
  if (!bot) return '';
  if (promptLab?.getEffectivePrompt) {
    const body = await promptLab.getEffectivePrompt(bot.id);
    if (body) return body;
  }
  return bot.prompt;
}

function extractExistingNameLine(messages) {
  const system = Array.isArray(messages) && messages[0]?.role === 'system'
    ? String(messages[0].content || '')
    : '';
  const match = system.match(/(?:^|\n)(You are currently talking to: .+)$/m);
  return match ? match[1].trim() : '';
}

function buildNameLine(firstName, igUsername, existingMessages) {
  const namePart = [firstName, igUsername ? `(@${String(igUsername).replace(/^@/, '')})` : '']
    .filter(Boolean)
    .join(' ');
  if (namePart) return `You are currently talking to: ${namePart}.`;
  return extractExistingNameLine(existingMessages);
}

async function buildSystemPrompt(bot, firstName, igUsername, existingMessages) {
  const promptBody = await getEffectivePromptBody(bot);
  const nameLine = buildNameLine(firstName, igUsername, existingMessages);
  return nameLine ? `${promptBody}\n${nameLine}` : promptBody;
}

async function syncConversationSystemPrompt(bot, subscriberId, messages) {
  if (!Array.isArray(messages) || !bot) return messages;
  const meta = await loadSubscriberMeta(bot.id, subscriberId);
  const systemPrompt = await buildSystemPrompt(bot, meta.firstName, meta.igUsername, messages);
  if (messages[0]?.role === 'system') {
    if (messages[0].content !== systemPrompt) {
      messages[0] = { ...messages[0], content: systemPrompt };
      await saveConversation(bot.id, subscriberId, messages);
    }
  } else {
    messages.unshift({ role: 'system', content: systemPrompt });
    await saveConversation(bot.id, subscriberId, messages);
  }
  return messages;
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

function formatDelay(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (!hours && !minutes) parts.push(`${seconds}s`);
  return parts.join(' ');
}

function isInvalidUchatUserNsError(detail) {
  if (!detail) return false;
  const message = typeof detail === 'string' ? detail : detail.message || detail.error || '';
  const userNsErrors = Array.isArray(detail.errors?.user_ns) ? detail.errors.user_ns : [];
  return [message, ...userNsErrors]
    .map((v) => String(v).toLowerCase())
    .some((v) => v.includes('user ns format is invalid'));
}

function isMissingUchatBotUserError(detail) {
  if (!detail) return false;
  const message = typeof detail === 'string' ? detail : detail.message || detail.error || '';
  return String(message).toLowerCase().includes('no query results for model [app\\models\\chatbot\\botuser]');
}

function isKnownTestSubscriberId(subscriberId) {
  const id = String(subscriberId || '').trim().toLowerCase();
  if (!id) return true;
  if (id.includes('{{') || id.includes('}}')) return true;
  return (
    /^render_(esma|sara)_test_\d+$/.test(id) ||
    /^local_.*_test$/.test(id) ||
    /^test_(esma|sara)_/.test(id) ||
    /_test_\d+$/.test(id)
  );
}

// ── UChat chat-messages import (one-shot bootstrap) ──────────────────────────
async function fetchUchatChatMessages(bot, subscriberId, limit) {
  const response = await axios.get(UCHAT_HISTORY_URL, {
    params: {
      user_ns: subscriberId,
      include_bot: 1,
      include_note: 0,
      include_system: 0,
      limit
    },
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${bot.uchatApiKey}`
    },
    timeout: UCHAT_HISTORY_TIMEOUT_MS
  });
  const data = response.data?.data;
  return Array.isArray(data) ? data : [];
}

function normalizeUchatMessages(rawMessages, latestUserText, limit) {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) return [];

  const textOnly = rawMessages.filter((m) => {
    if (!m || typeof m !== 'object') return false;
    if (m.msg_type && String(m.msg_type).toLowerCase() !== 'text') return false;
    const content = typeof m.content === 'string'
      ? m.content
      : typeof m?.payload?.text === 'string' ? m.payload.text : '';
    return content.trim().length > 0;
  });

  textOnly.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));

  const mapped = textOnly.map((m) => {
    const type = String(m.type || '').toLowerCase();
    const role = type === 'in' ? 'user' : 'assistant';
    const content = typeof m.content === 'string' && m.content.trim()
      ? m.content.trim()
      : String(m?.payload?.text || '').trim();
    return { role, content };
  });

  const safeLimit = Math.max(1, Number(limit) || 15);
  const tail = mapped.slice(-safeLimit);

  if (tail.length && latestUserText && tail[tail.length - 1].role === 'user') {
    const last = tail[tail.length - 1].content.trim().toLowerCase();
    const incoming = String(latestUserText).trim().toLowerCase();
    if (last === incoming) tail.pop();
  }

  return tail;
}

async function bootstrapHistoryForNewConversation(bot, subscriberId, customPrompt, latestUserText) {
  const baseMessages = [{ role: 'system', content: customPrompt }];

  if (!UCHAT_HISTORY_IMPORT_ENABLED) {
    return { messages: baseMessages, importStatus: { status: 'disabled', count: 0 } };
  }
  if (!bot.uchatApiKey) {
    return {
      messages: baseMessages,
      importStatus: { status: 'skipped', reason: 'no_uchat_key', count: 0 }
    };
  }
  if (isKnownTestSubscriberId(subscriberId)) {
    return {
      messages: baseMessages,
      importStatus: { status: 'skipped', reason: 'test_subscriber', count: 0 }
    };
  }

  try {
    const raw = await fetchUchatChatMessages(bot, subscriberId, UCHAT_HISTORY_IMPORT_LIMIT);
    const normalized = normalizeUchatMessages(raw, latestUserText, UCHAT_HISTORY_IMPORT_LIMIT);
    if (!normalized.length) {
      return {
        messages: baseMessages,
        importStatus: { status: 'empty', count: 0, raw_count: raw.length }
      };
    }
    const merged = [...baseMessages, ...normalized];
    trimHistory(merged);
    return {
      messages: merged,
      importStatus: {
        status: 'imported',
        count: normalized.length,
        raw_count: raw.length,
        preview: normalized.map((m) => ({
          role: m.role,
          content: String(m.content || '').slice(0, 500)
        }))
      }
    };
  } catch (err) {
    const detail = err.response?.data || err.message;
    const errorPreview = typeof detail === 'string'
      ? detail.slice(0, 300)
      : rawJsonPreview(detail, 300);
    console.warn(`⚠️  [${bot.id}/${subscriberId}] UChat history import failed: ${errorPreview}`);
    return {
      messages: baseMessages,
      importStatus: { status: 'failed', count: 0, error: errorPreview }
    };
  }
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
  if (isKnownTestSubscriberId(subscriberId)) {
    await clearPending(botId, subscriberId);
    pushTrigger({
      id: `${Date.now()}-discard-${Math.random().toString(36).slice(2, 9)}`,
      at: new Date().toISOString(),
      outcome: 'discarded',
      reason: 'test_subscriber_id',
      bot: bot.id,
      subscriber_id: subscriberId
    });
    console.warn(`🧹 [${bot.id}/${subscriberId}] Cleared test pending message before calling Grok/UChat`);
    return;
  }

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

    const messagesForGrok = await syncConversationSystemPrompt(
      bot,
      subscriberId,
      await loadConversation(botId, subscriberId)
    );
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
    if (isInvalidUchatUserNsError(detail) || isMissingUchatBotUserError(detail)) {
      const reason = isInvalidUchatUserNsError(detail) ? 'invalid_user_ns' : 'missing_uchat_bot_user';
      await clearPending(bot.id, subscriberId);
      pushTrigger({
        id: `${Date.now()}-discard-${Math.random().toString(36).slice(2, 9)}`,
        at: new Date().toISOString(),
        outcome: 'discarded',
        reason,
        bot: bot.id,
        subscriber_id: subscriberId,
        error: typeof detail === 'string' ? detail.slice(0, 500) : rawJsonPreview(detail, 800)
      });
      console.warn(`🧹 [${bot.id}/${subscriberId}] Cleared pending message because UChat rejected this subscriber`);
    }
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

// Get or create conversation history for a (bot, subscriber) pair.
// On first creation, attempts a one-shot import of the last UChat messages
// so Grok continues the chat instead of starting from scratch.
async function getHistory(botId, subscriberId, firstName, igUsername, latestUserText) {
  const bot = getBot(botId);
  const existing = await loadConversation(botId, subscriberId);
  if (existing) {
    return { messages: existing, importStatus: null };
  }

  const customPrompt = await buildSystemPrompt(bot, firstName, igUsername);

  const { messages, importStatus } = await bootstrapHistoryForNewConversation(
    bot,
    subscriberId,
    customPrompt,
    latestUserText
  );
  await saveConversation(botId, subscriberId, messages);

  if (importStatus?.status === 'imported') {
    console.log(
      `📚 [${bot.id}/${subscriberId}] Imported ${importStatus.count} prior UChat message(s) into history`
    );
  }

  return { messages, importStatus };
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
  // Ili za UChat: { "user_ns": "...", "text": "...", "name": "...", "username": "...", "image": "..." }

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

  const firstName = pickFirstNonEmpty(body.name, body.first_name, body.full_name, body.subscriber?.name);
  const igUsername = pickFirstNonEmpty(
    body.username,
    body.ig_username,
    body.instagram_username,
    body.user_name,
    body.subscriber?.username,
    body.contact?.username
  );
  const imageUrl = pickFirstNonEmpty(
    body.image,
    body.profile_pic,
    body.profile_pic_url,
    body.profile_picture,
    body.profile_picture_url,
    body.avatar,
    body.avatar_url,
    body.picture,
    body.picture_url,
    body.photo,
    body.photo_url,
    body.ig_profile_pic,
    body.payload?.image,
    body.payload?.profile_pic,
    body.subscriber?.image,
    body.subscriber?.profile_pic,
    body.subscriber?.profile_pic_url,
    body.contact?.image,
    body.contact?.avatar
  );

  return {
    subscriberId: subscriberId != null ? String(subscriberId) : undefined,
    userText: userText != null ? String(userText).trim() : undefined,
    firstName: firstName || undefined,
    igUsername: igUsername || undefined,
    imageUrl: imageUrl || undefined
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

// ── Admin / debug helpers ────────────────────────────────────────────────────

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function tokenQuerySuffix() {
  return VIEW_MESSAGES_TOKEN ? `&token=${encodeURIComponent(VIEW_MESSAGES_TOKEN)}` : '';
}

function tokenQueryFirst() {
  return VIEW_MESSAGES_TOKEN ? `?token=${encodeURIComponent(VIEW_MESSAGES_TOKEN)}` : '';
}

function wantsHtmlResponse(req) {
  return (
    req.query.format === 'html' ||
    (typeof req.headers.accept === 'string' && req.headers.accept.includes('text/html'))
  );
}

function subscriberDisplayName(meta, fallbackId) {
  if (meta?.firstName) return meta.firstName;
  if (meta?.igUsername) return `@${meta.igUsername}`;
  return fallbackId;
}

function renderSubscriberCell(meta, subscriberId) {
  const cleanMeta = meta || {};
  const username = cleanMeta.igUsername ? `@${cleanMeta.igUsername}` : '';
  const title = subscriberDisplayName(cleanMeta, subscriberId);
  const sub = [username, subscriberId].filter(Boolean).join(' · ');
  const initial = String(title || subscriberId || '?').trim().charAt(0).toUpperCase() || '?';
  const avatar = cleanMeta.imageUrl
    ? `<img class="avatar" src="${escHtml(cleanMeta.imageUrl)}" alt="${escHtml(title)}">`
    : `<span class="avatar placeholder">${escHtml(initial)}</span>`;
  return `<div class="subscriber">${avatar}<div><div class="subscriber-main">${escHtml(title)}</div><div class="subscriber-sub">${escHtml(sub)}</div></div></div>`;
}

function adminPageShell(title, bodyHtml) {
  const tokenQ = tokenQuerySuffix();
  return `<!DOCTYPE html>
<html lang="hr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
<style>
  *{box-sizing:border-box}
  html{background:#f7f8fb}
  body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0 auto;padding:1rem;max-width:1100px;color:#111827}
  a{color:#1d4ed8}
  h1{margin:.9rem 0 .35rem;font-size:clamp(1.45rem,6vw,2rem);line-height:1.1}
  nav{position:sticky;top:0;z-index:10;display:flex;gap:.45rem;overflow-x:auto;padding:.65rem .2rem .7rem;margin:-1rem -1rem .8rem;background:rgba(247,248,251,.96);backdrop-filter:blur(8px);border-bottom:1px solid #e5e7eb}
  nav a{flex:0 0 auto;display:inline-flex;align-items:center;min-height:38px;padding:.45rem .7rem;border:1px solid #dbe1ea;border-radius:999px;background:#fff;color:#111827;text-decoration:none;font-size:14px;font-weight:650;box-shadow:0 1px 2px rgba(16,24,40,.04)}
  nav a:active{transform:translateY(1px)}
  table{border-collapse:collapse;width:100%;min-width:720px;margin-top:.5rem;background:#fff}
  th,td{border:1px solid #ccc;padding:.5rem;text-align:left;vertical-align:top;font-size:14px}
  th{background:#f4f4f4}
  code,pre{background:#f6f8fa;padding:2px 6px;border-radius:4px;font-size:12px}
  pre{padding:.5rem;white-space:pre-wrap;word-break:break-word;max-width:100%;overflow-x:auto}
  table{display:block;overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:12px;box-shadow:0 1px 3px rgba(16,24,40,.08)}
  tbody,thead,tr{width:100%}
  .muted{color:#666;font-size:12px}
  .ok{color:#117a3a;font-weight:600}
  .bad{color:#a00;font-weight:600}
  .pill{display:inline-block;padding:1px 6px;border-radius:8px;background:#eef;font-size:12px}
  .subscriber{display:flex;align-items:center;gap:.6rem;min-width:190px}
  .avatar{width:38px;height:38px;border-radius:999px;object-fit:cover;border:1px solid #dbe1ea;background:#eef;flex:0 0 auto}
  .avatar.placeholder{display:inline-flex;align-items:center;justify-content:center;font-weight:750;color:#475569}
  .subscriber-main{font-weight:700}
  .subscriber-sub{color:#666;font-size:12px;margin-top:1px}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:.85rem;margin:.75rem 0;box-shadow:0 1px 3px rgba(16,24,40,.08)}
  .actions{display:flex;gap:.5rem;flex-wrap:wrap;margin:.75rem 0}
  .button{display:inline-flex;align-items:center;min-height:38px;padding:.45rem .75rem;border:1px solid #dbe1ea;border-radius:10px;background:#fff;color:#111827;text-decoration:none;font-weight:650}
  .thread{display:flex;flex-direction:column;gap:.65rem;margin:1rem 0}
  .bubble{max-width:min(92%,720px);padding:.75rem .85rem;border-radius:16px;border:1px solid #e5e7eb;box-shadow:0 1px 2px rgba(16,24,40,.05)}
  .bubble.user{align-self:flex-start;background:#e8f4ff}
  .bubble.assistant{align-self:flex-end;background:#f3f4f6}
  .bubble.system{align-self:center;background:#fff8e1}
  .bubble strong{display:block;margin-bottom:.35rem;font-size:12px;letter-spacing:.02em;text-transform:uppercase;color:#4b5563}
  .bubble pre{margin:0;background:transparent;padding:0;font:inherit;white-space:pre-wrap;word-break:break-word}
  .stack{display:grid;gap:.75rem}
  .nowrap{white-space:nowrap}
  @media (max-width:640px){
    body{padding:.8rem;font-size:15px}
    nav{margin:-.8rem -.8rem .75rem;padding:.6rem .75rem;flex-wrap:wrap;overflow-x:visible}
    nav a{min-height:42px;padding:.55rem .78rem;font-size:13px;flex:1 1 auto;justify-content:center}
    p{line-height:1.45}
    code,pre{font-size:11px}
    table{display:block;min-width:0;width:100%;overflow:visible;background:transparent;box-shadow:none;border-radius:0}
    thead{display:none}
    tbody{display:block;width:100%}
    tr{display:block;width:100%;margin:.75rem 0;padding:.15rem 0;background:#fff;border:1px solid #e5e7eb;border-radius:14px;box-shadow:0 1px 3px rgba(16,24,40,.08);overflow:hidden}
    td{display:block;width:100%;border:0;border-bottom:1px solid #eef2f7;padding:.65rem .75rem;font-size:13px}
    td:last-child{border-bottom:0}
    td::before{content:attr(data-label);display:block;margin-bottom:.22rem;color:#667085;font-size:11px;font-weight:750;letter-spacing:.02em;text-transform:uppercase}
    td[colspan]::before{display:none}
    td[colspan]{background:#fafafa}
    .subscriber{min-width:0}
    .button{min-height:42px}
    .bubble{max-width:100%;border-radius:14px}
    .avatar{width:34px;height:34px}
  }
</style>
</head><body>
<nav>
  <a href="/admin?format=html${tokenQ}">Admin</a>
  <a href="/bots?format=html${tokenQ}">Bots</a>
  <a href="/conversations?format=html${tokenQ}">Conversations</a>
  <a href="/pending?format=html${tokenQ}">Pending</a>
  <a href="/history-imports?format=html${tokenQ}">History Imports</a>
  <a href="/failed?format=html${tokenQ}">Failed</a>
  <a href="/messages?format=html${tokenQ}">Messages</a>
  <a href="/triggers?format=html${tokenQ}">Triggers</a>
  <a href="/prompt-lab?format=html${tokenQ}">Prompt Lab</a>
</nav>
<h1>${escHtml(title)}</h1>
${bodyHtml}
<script>
  document.querySelectorAll('table').forEach((table) => {
    const labels = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent.trim());
    table.querySelectorAll('tbody tr').forEach((row) => {
      Array.from(row.children).forEach((cell, index) => {
        if (!cell.hasAttribute('data-label') && labels[index]) cell.setAttribute('data-label', labels[index]);
      });
    });
  });
</script>
</body></html>`;
}

async function collectBotsStatus() {
  const rows = [];
  for (const id of listBotIds()) {
    const bot = BOTS[id];
    const conversationIds = await listConversationIds(id);
    const pendingIds = await listPendingIds(id);
    rows.push({
      id: bot.id,
      display_name: bot.displayName,
      timezone: bot.timezone,
      uchat_key: bot.uchatApiKey ? 'present' : 'missing',
      route: `/webhook/uchat/${bot.id}`,
      conversation_count: conversationIds.length,
      pending_count: pendingIds.length
    });
  }
  return rows;
}

async function collectAllConversations(filterBotId) {
  const botsToList = filterBotId
    ? (getBot(filterBotId) ? [filterBotId.toLowerCase()] : [])
    : listBotIds();
  const rows = [];
  for (const botId of botsToList) {
    const ids = await listConversationIds(botId);
    const tuples = await Promise.all(
      ids.map(async (id) => [id, await loadConversation(botId, id), await loadSubscriberMeta(botId, id)])
    );
    for (const [id, msgs, meta] of tuples) {
      if (!Array.isArray(msgs)) continue;
      const nonSys = msgs.filter((m) => m.role !== 'system');
      const last = nonSys[nonSys.length - 1];
      rows.push({
        bot: botId,
        subscriber_id: id,
        meta,
        message_count: nonSys.length,
        last_role: last?.role || null,
        last_preview: last?.content ? String(last.content).slice(0, 120) : null
      });
    }
  }
  return rows;
}

async function collectAllPending(filterBotId) {
  const botsToList = filterBotId
    ? (getBot(filterBotId) ? [filterBotId.toLowerCase()] : [])
    : listBotIds();
  const now = Date.now();
  const rows = [];
  for (const botId of botsToList) {
    const ids = await listPendingIds(botId);
    const tuples = await Promise.all(
      ids.map(async (id) => [id, await loadPending(botId, id), await loadSubscriberMeta(botId, id)])
    );
    for (const [id, payload, meta] of tuples) {
      if (!payload || typeof payload !== 'object') continue;
      const dueAt = Number(payload.dueAt) || 0;
      const remainingMs = dueAt - now;
      const mergedMeta = {
        ...meta,
        firstName: payload.firstName || meta.firstName,
        igUsername: payload.igUsername || meta.igUsername,
        imageUrl: payload.imageUrl || meta.imageUrl
      };
      rows.push({
        bot: botId,
        subscriber_id: id,
        meta: mergedMeta,
        first_name: mergedMeta.firstName || null,
        ig_username: mergedMeta.igUsername || null,
        image_url: mergedMeta.imageUrl || null,
        path: payload.path || null,
        due_at: dueAt ? new Date(dueAt).toISOString() : null,
        wait_remaining_ms: remainingMs,
        wait_remaining_human: remainingMs > 0 ? formatDelay(remainingMs) : 'overdue'
      });
    }
  }
  rows.sort((a, b) => (a.wait_remaining_ms || 0) - (b.wait_remaining_ms || 0));
  return rows;
}

const FAILED_OUTCOMES = new Set(['error', 'skipped', 'discarded', 'wrong_path']);

function collectFailedTriggers() {
  return triggerLog.filter((t) => FAILED_OUTCOMES.has(t.outcome));
}

function collectHistoryImports() {
  return triggerLog.filter((t) => t.import_status);
}

promptLab = createPromptLab({
  app,
  axios,
  BOTS,
  variants,
  getBot,
  listBotIds,
  redisClient,
  isRedisEnabled: () => redisEnabled,
  REDIS_KEY_PREFIX,
  GROK_URL,
  GROK_MODEL,
  GROK_API_KEY,
  assertViewMessagesAuth,
  wantsHtmlResponse,
  adminPageShell,
  escHtml,
  renderSubscriberCell,
  tokenQuerySuffix,
  tokenQueryFirst,
  loadConversation,
  listConversationIds,
  loadSubscriberMeta,
  withTimeAwareMessages
});

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

      const { subscriberId, userText, firstName, igUsername, imageUrl } = extractWebhookFields(body);

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
          image_url: imageUrl ?? null,
          user_text: userText ?? null,
          raw_json: rawJsonPreview(body)
        });
        return res.status(400).json({
          status: 'error',
          reason: 'Missing sender_id or text in body'
        });
      }

      console.log(`👤 [${bot.id}/${subscriberId}] User says: "${userText}"`);
      await saveSubscriberMeta(bot.id, subscriberId, { firstName, igUsername, imageUrl });

      const { messages, importStatus } = await getHistory(
        bot.id,
        subscriberId,
        firstName,
        igUsername,
        userText
      );
      messages.push({ role: 'user', content: userText });
      trimHistory(messages);
      await saveConversation(bot.id, subscriberId, messages);

      const dueAt = await schedulePending(bot.id, subscriberId, {
        firstName,
        igUsername,
        imageUrl,
        path: req.path
      });
      const waitMs = dueAt - Date.now();
      console.log(
        `⏱️  [${bot.id}/${subscriberId}] Reply scheduled in ${formatDelay(waitMs)} (at ${new Date(dueAt).toISOString()})`
      );

      pushTrigger({
        id: triggerId,
        at: new Date().toISOString(),
        outcome: 'queued',
        bot: bot.id,
        subscriber_id: subscriberId,
        first_name: firstName ?? null,
        ig_username: igUsername ?? null,
        image_url: imageUrl ?? null,
        user_text: userText,
        scheduled_for: new Date(dueAt).toISOString(),
        import_status: importStatus || null,
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
      const { subscriberId, userText, firstName, igUsername, imageUrl } = extractWebhookFields(body || {});
      pushTrigger({
        id: triggerId,
        at: new Date().toISOString(),
        outcome: 'error',
        bot: bot ? bot.id : botId,
        subscriber_id: subscriberId ?? null,
        first_name: firstName ?? null,
        ig_username: igUsername ?? null,
        image_url: imageUrl ?? null,
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
<style>
  *{box-sizing:border-box}
  html{background:#f7f8fb}
  body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:42rem;margin:0 auto;padding:1rem;line-height:1.55;color:#111827}
  h1{font-size:clamp(1.6rem,7vw,2.25rem);line-height:1.1;margin:1rem 0}
  p{margin:.85rem 0}
  code{background:#f0f0f0;padding:2px 6px;border-radius:4px;word-break:break-word}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:16px;padding:1rem;margin:1rem 0;box-shadow:0 1px 3px rgba(16,24,40,.08)}
  .actions{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0}
  .actions a{display:inline-flex;align-items:center;min-height:42px;padding:.55rem .8rem;border:1px solid #dbe1ea;border-radius:999px;background:#fff;color:#111827;text-decoration:none;font-weight:650}
</style>
</head><body>
<div class="card">
<h1>Ovo nije greška</h1>
<p><strong>UChat External Request šalje <code>POST</code></strong> na ovaj URL. Preglednik kad otvoriš link uvijek šalje <strong><code>GET</code></strong>, pa Express nema GET rutu za webhook — zato si prije vidio „Cannot GET”.</p>
<p>Per-bot rute: <code>POST /webhook/uchat/esma</code>, <code>POST /webhook/uchat/sara</code>.</p>
<p>Za test u browseru otvori:</p>
<div class="actions">
  <a href="/">Health</a>
  <a href="/admin?format=html">Dashboard</a>
  <a href="/triggers?format=html">Triggers</a>
  <a href="/messages?format=html">Messages</a>
</div>
</div>
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
    const formatImport = (s) => {
      if (!s || typeof s !== 'object') return '';
      const parts = [s.status];
      if (typeof s.count === 'number') parts.push(`${s.count} msg`);
      if (s.reason) parts.push(s.reason);
      if (s.error) parts.push(s.error.slice(0, 80));
      return parts.filter(Boolean).join(' · ');
    };
    const rows = triggerLog
      .map((t) => {
        const raw = esc(t.raw_json || '');
        const meta = {
          firstName: t.first_name,
          igUsername: t.ig_username,
          imageUrl: t.image_url
        };
        return `<tr><td style="white-space:nowrap">${esc(t.at)}</td><td><code>${esc(
          t.bot || ''
        )}</code></td><td><code>${esc(t.outcome)}</code></td><td>${renderSubscriberCell(meta, t.subscriber_id ?? '')}</td><td>${esc(
          (t.user_text || '').slice(0, 120)
        )}</td><td>${esc(formatImport(t.import_status))}</td><td>${esc(t.reason || t.error || t.reply_preview || '')}</td></tr>
<tr><td colspan="7" style="background:#fafafa;font-size:12px"><details><summary>raw JSON</summary><pre style="white-space:pre-wrap;word-break:break-all;margin:8px 0">${raw}</pre></details></td></tr>`;
      })
      .join('\n');
    const bodyHtml = `
      <p class="muted">Zadnjih ${MAX_TRIGGER_LOG} zahtjeva. Ovdje vidiš webhook payload, import status i greške.</p>
      <div class="actions">
        <a class="button" href="/messages?format=html${tokenQ}">Threads</a>
        <a class="button" href="/triggers?format=json${tokenQ}">JSON</a>
      </div>
      <table><thead><tr><th>Vrijeme (UTC)</th><th>Bot</th><th>Ishod</th><th>sender_id</th><th>Tekst</th><th>Import</th><th>Napomena</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7">Još nema triggera - pošalji poruku kad je flow povezan.</td></tr>'}</tbody></table>
    `;
    res.type('html').send(adminPageShell('Dolazni Webhookovi', bodyHtml));
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
      const tuples = await Promise.all(
        ids.map(async (id) => [id, await loadConversation(botId, id), await loadSubscriberMeta(botId, id)])
      );
      for (const [id, msgs, meta] of tuples) {
        if (!Array.isArray(msgs)) continue;
        const nonSys = msgs.filter((m) => m.role !== 'system');
        const last = nonSys[nonSys.length - 1];
        rows.push({
          bot: botId,
          subscriber_id: id,
          meta,
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
            `<tr><td><code>${esc(r.bot)}</code></td><td>${renderSubscriberCell(r.meta, r.subscriber_id)}<a class="muted" href="/messages/${encodeURIComponent(r.bot)}/${encodeURIComponent(r.subscriber_id)}?format=html${tokenQ}">open thread</a></td><td>${r.message_count}</td><td>${esc(r.last_role || '')}</td><td>${esc(r.last_preview || '')}</td></tr>`
        )
        .join('\n');
      const bodyHtml = `
        <p class="muted">${redisEnabled ? 'Redis-backed' : 'In-memory'} threads. ${VIEW_MESSAGES_TOKEN ? 'Token required.' : ''}</p>
        <div class="actions">
          <a class="button" href="/triggers?format=html${tokenQ}">Dolazni triggeri</a>
          <a class="button" href="/messages?format=json${tokenQ}">JSON</a>
        </div>
        <table><thead><tr><th>Bot</th><th>User</th><th>Msgs</th><th>Last role</th><th>Preview</th></tr></thead>
        <tbody>${lines || '<tr><td colspan="5">No messages yet</td></tr>'}</tbody></table>
      `;
      res.type('html').send(adminPageShell(`${redisEnabled ? 'Redis' : 'In-memory'} Threads`, bodyHtml));
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
  const meta = await loadSubscriberMeta(bot.id, subscriberId);

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
          `<div class="bubble ${esc(m.role)}"><strong>${esc(m.role)}</strong><pre>${esc(m.content)}</pre></div>`
      )
      .join('\n');
    const bodyHtml = `
      <div class="actions">
        <a class="button" href="/messages?format=html${tokenQ}">All threads</a>
        <a class="button" href="/conversations?format=html&bot=${encodeURIComponent(bot.id)}${tokenQ}">${esc(bot.displayName)} conversations</a>
        <form method="post" action="/prompt-lab/fixtures/from-conversation?format=html${tokenQ}" style="display:inline-flex;gap:.35rem;flex-wrap:wrap">
          <input type="hidden" name="botId" value="${esc(bot.id)}">
          <input type="hidden" name="subscriberId" value="${esc(subscriberId)}">
          <input name="name" value="${esc(`${bot.displayName} ${subscriberDisplayName(meta, subscriberId)}`)}" style="min-height:38px;padding:.45rem .55rem;border:1px solid #dbe1ea;border-radius:10px">
          <button class="button" type="submit">Save as test fixture</button>
        </form>
      </div>
      <div class="card">
        ${renderSubscriberCell(meta, subscriberId)}
      </div>
      <div class="thread">${blocks}</div>
    `;
    res.type('html').send(adminPageShell(`${esc(bot.displayName)} Thread`, bodyHtml));
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

// ── Admin / debug panel ──────────────────────────────────────────────────────
app.get('/admin', async (req, res) => {
  if (!assertViewMessagesAuth(req, res)) return;
  const tokenQ = tokenQuerySuffix();
  const tokenFirst = tokenQueryFirst();
  const [bots, pending, conversations] = await Promise.all([
    collectBotsStatus(),
    collectAllPending(),
    collectAllConversations()
  ]);
  const failed = collectFailedTriggers();
  const imports = collectHistoryImports();

  if (!wantsHtmlResponse(req)) {
    return res.json({
      auth_required: !!VIEW_MESSAGES_TOKEN,
      stats: {
        bot_count: bots.length,
        conversation_count: conversations.length,
        pending_count: pending.length,
        history_import_count: imports.length,
        failed_recent: failed.length
      },
      links: {
        bots: `/bots${tokenFirst}`,
        conversations: `/conversations${tokenFirst}`,
        pending: `/pending${tokenFirst}`,
        history_imports: `/history-imports${tokenFirst}`,
        failed: `/failed${tokenFirst}`,
        messages: `/messages${tokenFirst}`,
        triggers: `/triggers${tokenFirst}`,
        prompt_lab: `/prompt-lab${tokenFirst}`
      }
    });
  }

  const body = `
    <p class="muted">Read-only dashboard. Use the links above for details.</p>
    <table>
      <thead><tr><th>Section</th><th>Count</th><th>Open</th></tr></thead>
      <tbody>
        <tr><td>Bots</td><td>${bots.length}</td><td><a href="/bots?format=html${tokenQ}">/bots</a></td></tr>
        <tr><td>Conversations</td><td>${conversations.length}</td><td><a href="/conversations?format=html${tokenQ}">/conversations</a></td></tr>
        <tr><td>Pending replies</td><td>${pending.length}</td><td><a href="/pending?format=html${tokenQ}">/pending</a></td></tr>
        <tr><td>History imports</td><td>${imports.length}</td><td><a href="/history-imports?format=html${tokenQ}">/history-imports</a></td></tr>
        <tr><td>Failed / discarded (recent)</td><td>${failed.length}</td><td><a href="/failed?format=html${tokenQ}">/failed</a></td></tr>
        <tr><td>Prompt Lab</td><td>drafts / fixtures</td><td><a href="/prompt-lab?format=html${tokenQ}">/prompt-lab</a></td></tr>
      </tbody>
    </table>
    <p class="muted">Auth: ${VIEW_MESSAGES_TOKEN ? 'token required (?token= or X-View-Token)' : '<span class="bad">no token configured</span>'}</p>
  `;
  res.type('html').send(adminPageShell('Admin / Debug', body));
});

app.get('/bots', async (req, res) => {
  if (!assertViewMessagesAuth(req, res)) return;
  const rows = await collectBotsStatus();
  if (!wantsHtmlResponse(req)) return res.json({ count: rows.length, bots: rows });

  const tokenQ = tokenQuerySuffix();
  const trs = rows
    .map((r) => {
      const keyHtml = r.uchat_key === 'present'
        ? '<span class="ok">present</span>'
        : '<span class="bad">missing</span>';
      return `<tr>
        <td><code>${escHtml(r.id)}</code></td>
        <td>${escHtml(r.display_name)}</td>
        <td>${escHtml(r.timezone)}</td>
        <td>${keyHtml}</td>
        <td><code>${escHtml(r.route)}</code></td>
        <td>${r.conversation_count} <a class="muted" href="/conversations?format=html&bot=${encodeURIComponent(r.id)}${tokenQ}">view</a></td>
        <td>${r.pending_count} <a class="muted" href="/pending?format=html&bot=${encodeURIComponent(r.id)}${tokenQ}">view</a></td>
      </tr>`;
    })
    .join('');

  const body = `
    <table>
      <thead><tr>
        <th>ID</th><th>Display</th><th>Timezone</th><th>UChat key</th><th>Route</th>
        <th>Conversations</th><th>Pending</th>
      </tr></thead>
      <tbody>${trs || '<tr><td colspan="7" class="muted">No bots configured.</td></tr>'}</tbody>
    </table>
  `;
  res.type('html').send(adminPageShell('Bots', body));
});

app.get('/conversations', async (req, res) => {
  if (!assertViewMessagesAuth(req, res)) return;
  const filterBot = req.query.bot ? String(req.query.bot) : null;
  const rows = await collectAllConversations(filterBot);
  if (!wantsHtmlResponse(req)) return res.json({ count: rows.length, bot_filter: filterBot, conversations: rows });

  const tokenQ = tokenQuerySuffix();
  const trs = rows
    .map((r) => {
      const detailHref = `/messages/${encodeURIComponent(r.bot)}/${encodeURIComponent(r.subscriber_id)}?format=html${tokenQ}`;
      return `<tr>
        <td><span class="pill">${escHtml(r.bot)}</span></td>
        <td>${renderSubscriberCell(r.meta, r.subscriber_id)}</td>
        <td>${r.message_count}</td>
        <td>${escHtml(r.last_role || '—')}</td>
        <td>${escHtml(r.last_preview || '')}</td>
        <td><a href="${detailHref}">open</a></td>
      </tr>`;
    })
    .join('');

  const body = `
    <p class="muted">${filterBot ? `Filtered by bot: <code>${escHtml(filterBot)}</code>. ` : ''}Conversation history is preserved across prompt/code changes.</p>
    <table>
      <thead><tr>
        <th>Bot</th><th>User</th><th>Messages</th><th>Last role</th><th>Last preview</th><th></th>
      </tr></thead>
      <tbody>${trs || '<tr><td colspan="6" class="muted">No conversations yet.</td></tr>'}</tbody>
    </table>
  `;
  res.type('html').send(adminPageShell('Conversations', body));
});

app.get('/pending', async (req, res) => {
  if (!assertViewMessagesAuth(req, res)) return;
  const filterBot = req.query.bot ? String(req.query.bot) : null;
  const rows = await collectAllPending(filterBot);
  if (!wantsHtmlResponse(req)) return res.json({ count: rows.length, bot_filter: filterBot, pending: rows });

  const tokenHeaderTip = VIEW_MESSAGES_TOKEN
    ? ` -H "X-View-Token: ${VIEW_MESSAGES_TOKEN}"`
    : '';
  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const tokenForCurl = VIEW_MESSAGES_TOKEN
    ? `?token=${encodeURIComponent(VIEW_MESSAGES_TOKEN)}`
    : '';

  const trs = rows
    .map((r) => {
      const wait = r.wait_remaining_ms > 0
        ? `${escHtml(r.wait_remaining_human)} <span class="muted">(at ${escHtml(r.due_at || '')})</span>`
        : `<span class="bad">overdue</span>`;
      const curlCmd = `curl -X POST "${baseUrl}/clear-pending/${encodeURIComponent(r.bot)}/${encodeURIComponent(r.subscriber_id)}${tokenForCurl}"${tokenHeaderTip}`;
      return `<tr>
        <td><span class="pill">${escHtml(r.bot)}</span></td>
        <td><code>${escHtml(r.subscriber_id)}</code></td>
        <td>${renderSubscriberCell(r.meta, r.subscriber_id)}</td>
        <td>${escHtml(r.path || '')}</td>
        <td>${wait}</td>
        <td><pre>${escHtml(curlCmd)}</pre></td>
      </tr>`;
    })
    .join('');

  const body = `
    <p class="muted">Pending replies waiting for debounce. Cleanup is POST-only — copy the command from the last column to clear.</p>
    <table>
      <thead><tr>
        <th>Bot</th><th>Subscriber</th><th>User</th><th>Path</th><th>Wait remaining</th><th>Clear (POST only)</th>
      </tr></thead>
      <tbody>${trs || '<tr><td colspan="6" class="muted">No pending replies.</td></tr>'}</tbody>
    </table>
  `;
  res.type('html').send(adminPageShell('Pending', body));
});

app.get('/history-imports', (req, res) => {
  if (!assertViewMessagesAuth(req, res)) return;
  const items = collectHistoryImports();
  if (!wantsHtmlResponse(req)) {
    return res.json({
      count: items.length,
      note: 'Recent in-memory import events only. Restart clears this view; imported messages remain in Redis conversations.',
      imports: items.map(({ raw_json, ...rest }) => rest)
    });
  }

  const tokenQ = tokenQuerySuffix();
  const trs = items
    .map((t) => {
      const status = t.import_status || {};
      const preview = Array.isArray(status.preview) ? status.preview : [];
      const previewHtml = preview.length
        ? preview
          .map((m) => `<div style="margin:6px 0"><span class="pill">${escHtml(m.role || '')}</span> ${escHtml(m.content || '')}</div>`)
          .join('')
        : '<span class="muted">No imported message preview recorded.</span>';
      const meta = {
        firstName: t.first_name,
        igUsername: t.ig_username,
        imageUrl: t.image_url
      };
      const detailHref = `/messages/${encodeURIComponent(t.bot || DEFAULT_BOT_ID)}/${encodeURIComponent(t.subscriber_id || '')}?format=html${tokenQ}`;
      return `<tr>
        <td>${escHtml(t.at || '')}</td>
        <td><span class="pill">${escHtml(t.bot || '')}</span></td>
        <td>${renderSubscriberCell(meta, t.subscriber_id || '')}</td>
        <td>${escHtml(status.status || '')}</td>
        <td>${escHtml(status.count ?? 0)} / raw ${escHtml(status.raw_count ?? '')}</td>
        <td>${previewHtml}</td>
        <td><a href="${detailHref}">thread</a></td>
      </tr>`;
    })
    .join('');

  const body = `
    <p class="muted">Recent UChat history bootstrap attempts. This dashboard list is in-memory only; imported messages are saved in Redis and visible in each thread.</p>
    <table>
      <thead><tr>
        <th>At</th><th>Bot</th><th>Subscriber</th><th>Status</th><th>Imported</th><th>Extracted preview</th><th></th>
      </tr></thead>
      <tbody>${trs || '<tr><td colspan="7" class="muted">No history imports recorded yet. A new subscriber must message first.</td></tr>'}</tbody>
    </table>
  `;
  res.type('html').send(adminPageShell('History Imports', body));
});

app.get('/failed', (req, res) => {
  if (!assertViewMessagesAuth(req, res)) return;
  const items = collectFailedTriggers();
  if (!wantsHtmlResponse(req)) {
    return res.json({
      count: items.length,
      note: 'Recent in-memory triggerLog only. Restart clears this.',
      failed: items.map(({ raw_json, ...rest }) => ({ ...rest, raw_json: raw_json || null }))
    });
  }
  const trs = items
    .map((t) => `<tr>
      <td>${escHtml(t.at || '')}</td>
      <td><span class="pill">${escHtml(t.outcome)}</span></td>
      <td>${escHtml(t.bot || '')}</td>
      <td><code>${escHtml(t.subscriber_id || '')}</code></td>
      <td>${escHtml(t.reason || '')}</td>
      <td>${escHtml(typeof t.error === 'string' ? t.error : (t.error ? JSON.stringify(t.error).slice(0, 300) : ''))}</td>
      <td><pre>${escHtml(t.raw_json || '')}</pre></td>
    </tr>`)
    .join('');

  const body = `
    <p class="muted">Recent <code>error</code> / <code>skipped</code> / <code>discarded</code> / <code>wrong_path</code> events. In-memory only — clears on restart.</p>
    <table>
      <thead><tr>
        <th>At</th><th>Outcome</th><th>Bot</th><th>Subscriber</th><th>Reason</th><th>Error</th><th>Raw</th>
      </tr></thead>
      <tbody>${trs || '<tr><td colspan="7" class="muted">No failed events recorded.</td></tr>'}</tbody>
    </table>
  `;
  res.type('html').send(adminPageShell('Failed / Discarded', body));
});

// POST-only: clears ONLY the pending reply queue + flush lock for that subscriber.
// Conversation history is intentionally preserved.
app.post('/clear-pending/:botId/:subscriberId', async (req, res) => {
  if (!assertViewMessagesAuth(req, res)) return;
  const { botId, subscriberId } = req.params;
  const bot = getBot(botId);
  if (!bot) {
    return res.status(404).json({
      status: 'error',
      reason: `Unknown bot id "${botId}". Known: ${listBotIds().join(', ')}`
    });
  }
  if (!subscriberId) {
    return res.status(400).json({ status: 'error', reason: 'Missing subscriberId' });
  }

  const before = await loadPending(bot.id, subscriberId);
  await clearPending(bot.id, subscriberId);
  await releaseFlushLock(bot.id, subscriberId);

  console.log(`🧹 [admin] Cleared pending [${bot.id}/${subscriberId}] (had=${!!before})`);
  return res.json({
    status: 'ok',
    bot: bot.id,
    subscriber_id: subscriberId,
    had_pending: !!before,
    note: 'Conversation history preserved.'
  });
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
    console.log(
      `   GET  /admin?format=html      ← Admin / debug panel${VIEW_MESSAGES_TOKEN ? ' (token required)' : ''}`
    );
    console.log(
      `   GET  /prompt-lab?format=html ← Prompt drafts + A/B tests${VIEW_MESSAGES_TOKEN ? ' (token required)' : ''}`
    );
    console.log(`   Tip: npm run dev:public      → Public HTTPS URL (TUNNEL=serveo|pinggy|cloudflare)\n`);
  });
}

startServer().catch((err) => {
  console.error('❌ Failed to start server:', err.message);
  process.exit(1);
});
