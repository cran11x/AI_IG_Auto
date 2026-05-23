require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('redis');

const { applyPitchTrackingToReply } = require('./pitchTracking');

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

/** Public URL of this app (no trailing slash). Used for /r/… pitch click tracking redirects. */
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').trim();

// Max user+assistant turns kept (one optional system message is kept at index 0)
const MAX_HISTORY = 20;

// ── Bot config (Esma, Sara, …) ──────────────────────────────────────────────
const { BOTS, DEFAULT_BOT_ID, getBot, listBotIds, isSaraEnabled, setSaraEnabled } = require('./prompts/bots');
const { variants } = require('./prompts/variants');
const { withTimeAwareMessages } = require('./prompts/timeContext');
const { createPromptLab } = require('./promptLab');
const { createChatAnalyzer } = require('./chatAnalyzer');
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
const pitchClickListKey = (botId, subscriberId) =>
  `${REDIS_KEY_PREFIX}:${botId}:pitchClick:${subscriberId}`;

/** @type {Map<string, object[]>} */
const pitchClickMemStore = new Map();

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

async function logPitchClickEvent(botId, subscriberId, data) {
  const line = JSON.stringify(data);
  if (redisEnabled) {
    const key = pitchClickListKey(botId, subscriberId);
    await redisClient.rPush(key, line);
    await redisClient.lTrim(key, -500, -1);
    return;
  }
  const k = memKey(botId, subscriberId);
  let arr = pitchClickMemStore.get(k) || [];
  try {
    arr = [...arr, JSON.parse(line)];
  } catch {
    arr.push({ raw: line, ts: new Date().toISOString() });
  }
  if (arr.length > 500) arr = arr.slice(-500);
  pitchClickMemStore.set(k, arr);
}

async function listPitchClickEvents(botId, subscriberId) {
  if (redisEnabled) {
    const raw = await redisClient.lRange(pitchClickListKey(botId, subscriberId), 0, -1);
    return raw.map((r) => {
      try {
        return JSON.parse(r);
      } catch {
        return null;
      }
    }).filter(Boolean);
  }
  return [...(pitchClickMemStore.get(memKey(botId, subscriberId)) || [])];
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
  let full = nameLine ? `${promptBody}\n${nameLine}` : promptBody;
  if (String(promptBody).includes('CURRENT_EXCLUSIVE_LINK')) {
    full += [
      '',
      'Output rule for the exclusive link: when you pitch, include the URL exactly as the literal text CURRENT_EXCLUSIVE_LINK (no other domain, no URL shorteners).',
      'The system will replace that token with the real trackable link before the user sees it.'
    ].join('\n');
  }
  return full;
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
  return fetchUchatChatMessagesWithOptions(bot, { user_ns: subscriberId, limit });
}

async function fetchUchatChatMessagesWithOptions(bot, options) {
  const params = {
    user_ns: options.user_ns,
    user_id: options.user_id,
    include_bot: options.include_bot ?? 1,
    include_note: options.include_note ?? 0,
    include_system: options.include_system ?? 0,
    msg_type: options.msg_type,
    start_time: options.start_time,
    end_time: options.end_time,
    limit: options.limit
  };
  Object.keys(params).forEach((key) => {
    if (params[key] == null || params[key] === '') delete params[key];
  });
  const response = await axios.get(UCHAT_HISTORY_URL, {
    params,
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
    const createdAt = getUchatMessageTime(m);
    return { role, content, ...(createdAt ? { createdAt } : {}) };
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

function normalizeUchatLiveChatMessages(rawMessages, limit) {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) return [];
  const sorted = rawMessages
    .filter((m) => m && typeof m === 'object')
    .slice()
    .sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
  const out = [];
  for (const m of sorted) {
    const type = String(m.type || '').toLowerCase();
    if (type === 'note' || type === 'system') continue;
    const msgType = String(m.msg_type || 'text').toLowerCase();
    const role = type === 'in' ? 'user' : 'assistant';
    const text = getUchatMessageText(m);
    const imageUrl = msgType === 'image' ? extractFirstImageUrl(m.payload, m.content, m) : undefined;
    const createdAt = getUchatMessageTime(m);
    const content = text || (imageUrl ? 'sent you a photo' : '');
    if (!content && !imageUrl) continue;
    out.push({
      role,
      content,
      ...(createdAt ? { createdAt } : {}),
      ...(imageUrl ? { imageUrl } : {}),
      uchat: {
        id: m.id ?? null,
        type: m.type ?? null,
        msg_type: m.msg_type ?? null,
        sender_id: m.sender_id ?? null,
        ts: m.ts ?? null,
        delivery_status: getUchatDeliveryStatus(m).summary
      }
    });
  }
  const safeLimit = Math.max(1, Number(limit) || 100);
  return out.slice(-safeLimit);
}

async function buildSystemMessageForExistingConversation(bot, subscriberId, existingMessages) {
  const meta = await loadSubscriberMeta(bot.id, subscriberId);
  const content = await buildSystemPrompt(bot, meta.firstName, meta.igUsername, existingMessages);
  return { role: 'system', content };
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

function getLastAssistantMessage(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === 'assistant' && String(msg.content || '').trim()) {
      return { index: i, content: String(msg.content).trim(), createdAt: msg.createdAt || null };
    }
  }
  return null;
}

function normalizeDeliveryText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function getUchatMessageText(message) {
  if (!message || typeof message !== 'object') return '';
  if (typeof message.content === 'string' && message.content.trim()) return message.content.trim();
  if (typeof message?.payload?.text === 'string') return message.payload.text.trim();
  return '';
}

function getUchatMessageTime(message) {
  const raw = message?.created_at || message?.createdAt || message?.timestamp || message?.time || message?.date;
  if (raw) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const ts = Number(message?.ts || message?.created_time || message?.createdTime);
  if (Number.isFinite(ts) && ts > 0) {
    const millis = ts > 1e12 ? ts : ts * 1000;
    const d = new Date(millis);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function collectUchatStatusValues(value, out = []) {
  if (!value || out.length > 40) return out;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return out;
  if (Array.isArray(value)) {
    value.forEach((item) => collectUchatStatusValues(item, out));
    return out;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const keyLower = String(key).toLowerCase();
      if (
        keyLower.includes('status') ||
        keyLower.includes('error') ||
        keyLower.includes('fail') ||
        keyLower.includes('reason')
      ) {
        if (child != null && typeof child !== 'object') out.push(`${key}:${String(child)}`);
        else if (child != null) out.push(`${key}:${rawJsonPreview(child, 160)}`);
      }
      if (child && typeof child === 'object') collectUchatStatusValues(child, out);
    }
  }
  return out;
}

function getUchatDeliveryStatus(message) {
  const values = collectUchatStatusValues(message);
  const joined = values.join(' | ');
  const lower = joined.toLowerCase();
  const failed = /\b(fail|failed|error|undeliver|not delivered|rejected|blocked|disconnect|disconnected)\b/.test(lower);
  const sent = /\b(delivered|sent|success|succeeded|ok)\b/.test(lower) && !failed;
  return {
    failed,
    sent,
    values,
    summary: joined || null
  };
}

function looksLikeImageUrl(value) {
  const s = String(value || '').trim();
  if (!/^https?:\/\//i.test(s)) return false;
  return (
    /\.(png|jpe?g|gif|webp)(\?|#|$)/i.test(s) ||
    /\/image\//i.test(s) ||
    /(?:image|photo|picture|media|attachment)/i.test(s)
  );
}

function extractFirstImageUrl(...values) {
  if (values.length > 1) {
    for (const item of values) {
      const found = extractFirstImageUrl(item);
      if (found) return found;
    }
    return undefined;
  }
  const value = values[0];
  if (!value) return undefined;
  if (typeof value === 'string') return looksLikeImageUrl(value) ? value.trim() : undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractFirstImageUrl(item);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value === 'object') {
    const type = String(value.type || value.mime_type || value.mimetype || value.content_type || '').toLowerCase();
    const maybeUrl = value.url || value.image_url || value.media_url || value.file_url || value.download_url || value.src;
    if (maybeUrl && (!type || type.includes('image') || looksLikeImageUrl(maybeUrl))) {
      const found = extractFirstImageUrl(maybeUrl);
      if (found) return found;
    }
    for (const key of ['image', 'photo', 'picture', 'media', 'attachment', 'payload']) {
      const found = extractFirstImageUrl(value[key]);
      if (found) return found;
    }
  }
  return undefined;
}

function isUchatOutbound(message) {
  return String(message?.type || '').toLowerCase() !== 'in';
}

async function uchatHasAssistantText(bot, subscriberId, text, limit = 50) {
  if (!bot?.uchatApiKey) {
    return { delivered: false, reason: 'no_uchat_key', rawCount: 0 };
  }

  const raw = await fetchUchatChatMessages(bot, subscriberId, limit);
  const outboundMessages = raw.filter(isUchatOutbound);
  const outbound = outboundMessages
    .map((message) => ({
      text: getUchatMessageText(message),
      createdAt: getUchatMessageTime(message),
      delivery: getUchatDeliveryStatus(message)
    }))
    .filter((item) => item.text);
  const outboundTexts = outbound.map((item) => item.text);
  const normalizedOutbound = outbound.map((item) => normalizeDeliveryText(item.text));
  const normalizedFull = normalizeDeliveryText(text);

  if (!normalizedFull) {
    return { delivered: false, reason: 'empty_text', rawCount: raw.length };
  }

  const fullIdx = normalizedOutbound.findIndex((out) => out === normalizedFull);
  if (fullIdx >= 0) {
    const matched = outbound[fullIdx];
    return {
      delivered: true,
      failed: !!matched.delivery?.failed,
      matchedText: outboundTexts[fullIdx],
      matchedAt: matched.createdAt || null,
      deliveryStatus: matched.delivery?.summary || null,
      rawCount: raw.length
    };
  }

  for (let start = 0; start < normalizedOutbound.length; start++) {
    let joined = '';
    const matchedParts = [];
    const matchedDelivery = [];
    for (let end = start; end < Math.min(normalizedOutbound.length, start + 6); end++) {
      joined = normalizeDeliveryText([joined, normalizedOutbound[end]].filter(Boolean).join(' '));
      matchedParts.push(outboundTexts[end]);
      matchedDelivery.push(outbound[end]?.delivery);
      if (joined === normalizedFull) {
        const failed = matchedDelivery.some((delivery) => delivery?.failed);
        return {
          delivered: true,
          failed,
          matchedText: matchedParts.join('\n'),
          deliveryStatus: matchedDelivery.map((delivery) => delivery?.summary).filter(Boolean).join(' | ') || null,
          rawCount: raw.length
        };
      }
      if (joined.length > normalizedFull.length + 20) break;
    }
  }

  return { delivered: false, rawCount: raw.length, outboundCount: outboundTexts.length };
}

function lastNonSystemRole(messages) {
  const tail = messages.filter((m) => m.role !== 'system');
  return tail.length ? tail[tail.length - 1].role : undefined;
}

/**
 * Natural DM-style send logic.
 * Distribution per call: ~45% one message, ~35% two, ~20% three.
 * Short replies always go as one message.
 */
function splitReplySmart(reply) {
  const text = String(reply || '').trim();
  if (!text) return [];

  const maxLen = 120;

  const r = Math.random();
  let target = 1;
  if (r > 0.80) target = 3;
  else if (r > 0.45) target = 2;

  if (target === 1 || text.length <= maxLen) {
    return [text];
  }

  const splitOnPara = text.split(/\n\n+/).map((s) => s.trim()).filter(Boolean);
  let pieces = splitOnPara.length >= target
    ? splitOnPara
    : text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);

  if (pieces.length < target) {
    return [text];
  }

  const groupSize = Math.ceil(pieces.length / target);
  const chunks = [];
  for (let i = 0; i < pieces.length; i += groupSize) {
    chunks.push(pieces.slice(i, i + groupSize).join(' '));
  }

  return chunks.slice(0, target);
}

async function sendUchatText(bot, subscriberId, text) {
  if (!bot?.uchatApiKey) {
    throw new Error(`UChat API key missing for bot=${bot?.id || 'unknown'}`);
  }
  const parts = splitReplySmart(text);
  const chunks = parts.length ? parts : [String(text)];
  for (let i = 0; i < chunks.length; i++) {
    await axios.post(
      UCHAT_URL,
      { user_ns: subscriberId, content: chunks[i] },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bot.uchatApiKey}`
        },
        timeout: 15000
      }
    );
    if (i < chunks.length - 1) {
      await sleep(1500 + Math.random() * 2500);
    }
  }
  return chunks;
}

function formatMessageForGrok(message) {
  if (!message?.imageUrl || message.role !== 'user') return message;
  const text = String(message.content || '').trim() || 'sent you a photo';
  return {
    ...message,
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: message.imageUrl } }
    ]
  };
}

function formatMessagesForGrok(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map(formatMessageForGrok);
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

    const grokMessages = formatMessagesForGrok(withTimeAwareMessages(messagesForGrok, bot.timezone));

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

    const { content: replyOut, pitchMeta } = applyPitchTrackingToReply({
      reply,
      bot,
      subscriberId,
      publicBaseUrl: PUBLIC_BASE_URL
    });

    const parts = splitReplySmart(replyOut);
    const chunks = parts.length ? parts : [String(replyOut)];

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

    const assistantMsg = {
      role: 'assistant',
      content: replyOut,
      createdAt: new Date().toISOString(),
      ...(pitchMeta ? { pitch: pitchMeta } : {})
    };
    fresh.push(assistantMsg);
    trimHistory(fresh);
    await saveConversation(botId, subscriberId, fresh);

    await clearPending(botId, subscriberId);

    pushTrigger({
      id: `${Date.now()}-flush-${Math.random().toString(36).slice(2, 9)}`,
      at: new Date().toISOString(),
      outcome: 'flushed',
      bot: bot.id,
      subscriber_id: subscriberId,
      reply_preview: String(replyOut).slice(0, 200),
      pitch_id: pitchMeta?.pitchId || null
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
  const chatImageUrl = extractFirstImageUrl(
    body.message_image,
    body.message_image_url,
    body.chat_image,
    body.chat_image_url,
    body.media_url,
    body.attachment_url,
    body.file_url,
    body.image_url,
    body.payload?.media_url,
    body.payload?.attachment_url,
    body.payload?.file_url,
    body.payload?.image_url,
    body.payload?.attachments,
    body.attachments,
    body.media,
    body.files
  );

  if (!userText && chatImageUrl) {
    userText = 'sent you a photo';
  }

  return {
    subscriberId: subscriberId != null ? String(subscriberId) : undefined,
    userText: userText != null ? String(userText).trim() : undefined,
    firstName: firstName || undefined,
    igUsername: igUsername || undefined,
    imageUrl: imageUrl || undefined,
    chatImageUrl: chatImageUrl || undefined
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
      : { role: m.role, content: m.content, imageUrl: m.imageUrl, createdAt: m.createdAt }
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
  const navItem = (href, label, isPrimary) =>
    `<a class="${isPrimary ? 'primary' : 'secondary'}" href="${href}?format=html${tokenQ}">${escHtml(label)}</a>`;
  const primaryNav = [
    ['/admin', 'Admin'],
    ['/conversations', 'Conversations'],
    ['/prompt-lab', 'Prompt Lab'],
    ['/analyzer', 'Analyzer']
  ]
    .map(([h, l]) => navItem(h, l, true))
    .join('');
  const secondaryNav = [
    ['/bots', 'Bots'],
    ['/pending', 'Pending'],
    ['/messages', 'Threads'],
    ['/triggers', 'Triggers'],
    ['/history-imports', 'Imports'],
    ['/delivery-check', 'Delivery'],
    ['/live-chat-sync', 'Sync'],
    ['/failed', 'Failed']
  ]
    .map(([h, l]) => navItem(h, l, false))
    .join('');

  return `<!DOCTYPE html>
<html lang="hr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
<style>
  :root{
    --bg:#f5f7fb;
    --surface:#fff;
    --surface-2:#fafbff;
    --text:#0f172a;
    --muted:#64748b;
    --border:#e2e8f0;
    --border-strong:#cbd5e1;
    --accent:#2563eb;
    --accent-soft:#dbeafe;
    --ok:#15803d;
    --bad:#b91c1c;
    --warn:#b45309;
    --shadow:0 1px 2px rgba(15,23,42,.04),0 1px 3px rgba(15,23,42,.06);
  }
  *{box-sizing:border-box}
  html{background:var(--bg)}
  body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:0;color:var(--text);font-size:15px;line-height:1.5}
  a{color:var(--accent);text-decoration:none}
  a:hover{text-decoration:underline}
  .layout{max-width:1180px;margin:0 auto;padding:1rem 1.25rem 3rem}
  h1{margin:1rem 0 .25rem;font-size:clamp(1.4rem,4vw,1.85rem);line-height:1.15;letter-spacing:-.01em;font-weight:700}
  h2{margin:1.5rem 0 .55rem;font-size:1.1rem;font-weight:650;letter-spacing:-.005em}
  p{margin:.55rem 0}
  hr{border:0;border-top:1px solid var(--border);margin:1rem 0}

  .topbar{position:sticky;top:0;z-index:10;background:rgba(245,247,251,.92);backdrop-filter:blur(10px);border-bottom:1px solid var(--border);padding:.55rem 1.25rem .35rem;margin:0}
  .topbar-inner{max-width:1180px;margin:0 auto}
  .nav{display:flex;flex-wrap:wrap;gap:.35rem;align-items:center}
  .nav a{display:inline-flex;align-items:center;height:34px;padding:0 .8rem;border-radius:8px;font-size:13px;font-weight:600;border:1px solid transparent;color:var(--muted);white-space:nowrap}
  .nav a.primary{background:var(--surface);border-color:var(--border);color:var(--text)}
  .nav a.primary:hover{border-color:var(--border-strong);text-decoration:none}
  .nav a.secondary{color:var(--muted);font-weight:500;font-size:12.5px;height:30px;padding:0 .65rem}
  .nav a.secondary:hover{color:var(--text);background:var(--surface);text-decoration:none}
  .nav-divider{width:1px;height:20px;background:var(--border);margin:0 .35rem}

  .grid{display:grid;gap:1rem}
  .grid-2{grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
  .grid-3{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}
  .grid-4{grid-template-columns:repeat(auto-fit,minmax(180px,1fr))}

  .card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:1rem 1.1rem;box-shadow:var(--shadow)}
  .card h2{margin:0 0 .5rem}
  .card.muted-card{background:var(--surface-2)}

  .stat{display:block;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:.85rem 1rem;text-decoration:none;color:inherit;box-shadow:var(--shadow);transition:border-color .12s,transform .12s}
  .stat:hover{border-color:var(--border-strong);text-decoration:none;transform:translateY(-1px)}
  .stat .label{font-size:11.5px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
  .stat .value{font-size:1.7rem;font-weight:700;letter-spacing:-.02em;line-height:1.05;margin-top:.15rem}
  .stat .hint{font-size:12px;color:var(--muted);margin-top:.2rem}
  .stat.danger .value{color:var(--bad)}
  .stat.ok .value{color:var(--ok)}

  table{border-collapse:separate;border-spacing:0;width:100%;background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;box-shadow:var(--shadow);font-size:13.5px}
  thead{background:var(--surface-2)}
  th,td{padding:.6rem .75rem;text-align:left;vertical-align:top;border-bottom:1px solid var(--border)}
  th{font-weight:650;font-size:12px;letter-spacing:.03em;text-transform:uppercase;color:var(--muted)}
  tbody tr:last-child td{border-bottom:0}
  tbody tr:hover{background:var(--surface-2)}
  td.nowrap{white-space:nowrap}

  code,pre{background:var(--surface-2);border:1px solid var(--border);border-radius:6px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
  code{padding:1px 6px}
  pre{padding:.6rem .75rem;white-space:pre-wrap;word-break:break-word;max-width:100%;overflow-x:auto;margin:.4rem 0}

  .muted{color:var(--muted);font-size:12.5px}
  .ok{color:var(--ok);font-weight:600}
  .bad{color:var(--bad);font-weight:600}
  .warn{color:var(--warn);font-weight:600}
  .pill{display:inline-block;padding:1px 8px;border-radius:999px;background:var(--accent-soft);color:#1e40af;font-size:11.5px;font-weight:600;letter-spacing:.02em}

  .subscriber{display:flex;align-items:center;gap:.6rem;min-width:180px}
  .avatar{width:34px;height:34px;border-radius:999px;object-fit:cover;border:1px solid var(--border);background:var(--accent-soft);flex:0 0 auto}
  .avatar.placeholder{display:inline-flex;align-items:center;justify-content:center;font-weight:700;color:#1e40af;font-size:13px}
  .subscriber-main{font-weight:650;line-height:1.2}
  .subscriber-sub{color:var(--muted);font-size:11.5px;margin-top:1px}

  .actions{display:flex;gap:.45rem;flex-wrap:wrap;margin:.5rem 0}
  .button{display:inline-flex;align-items:center;height:34px;padding:0 .85rem;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);text-decoration:none;font-weight:600;font-size:13px;cursor:pointer}
  .button:hover{border-color:var(--border-strong);text-decoration:none}
  .button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
  .button.primary:hover{filter:brightness(.95)}

  .thread{display:flex;flex-direction:column;gap:.55rem;margin:.75rem 0}
  .bubble{max-width:min(92%,720px);padding:.7rem .85rem;border-radius:14px;border:1px solid var(--border);background:var(--surface)}
  .bubble.user{align-self:flex-start;background:#eff6ff;border-color:#bfdbfe}
  .bubble.assistant{align-self:flex-end;background:var(--surface-2)}
  .bubble.system{align-self:center;background:#fefce8;border-color:#fde68a}
  .bubble strong{display:block;margin-bottom:.3rem;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
  .bubble pre{margin:0;background:transparent;border:0;padding:0;font:inherit;white-space:pre-wrap;word-break:break-word}

  .stack{display:grid;gap:.75rem}
  .nowrap{white-space:nowrap}
  details summary{cursor:pointer;font-weight:600}

  @media (max-width:720px){
    .layout{padding:.85rem .85rem 3rem}
    .topbar{padding:.5rem .85rem .3rem}
    .nav a{font-size:12.5px;height:32px;padding:0 .65rem}
    .nav a.secondary{font-size:12px;height:28px}
    table{display:block;background:transparent;border:0;border-radius:0;box-shadow:none;font-size:13px}
    thead{display:none}
    tbody{display:block;width:100%}
    tr{display:block;width:100%;margin:.55rem 0;background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow);overflow:hidden}
    td{display:block;width:100%;padding:.55rem .8rem;border-bottom:1px solid var(--border)}
    td:last-child{border-bottom:0}
    td::before{content:attr(data-label);display:block;margin-bottom:.18rem;color:var(--muted);font-size:11px;font-weight:650;letter-spacing:.04em;text-transform:uppercase}
    td[colspan]::before{display:none}
    td[colspan]{background:var(--surface-2)}
    .button{height:36px;font-size:13px}
  }
</style>
</head><body>
<header class="topbar">
  <div class="topbar-inner">
    <div class="nav">
      ${primaryNav}
      <span class="nav-divider" aria-hidden="true"></span>
      ${secondaryNav}
    </div>
  </div>
</header>
<main class="layout">
<h1>${escHtml(title)}</h1>
${bodyHtml}
</main>
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
        last_preview: last?.content
          ? `${last.imageUrl ? '[image] ' : ''}${String(last.content).slice(0, 120)}`
          : (last?.imageUrl ? '[image]' : null)
      });
    }
  }
  return rows;
}

async function collectDeliveryCheckRows(filterBotId, maxConversations) {
  const botsToList = filterBotId
    ? (getBot(filterBotId) ? [filterBotId.toLowerCase()] : [])
    : listBotIds();
  const safeLimit = Math.max(1, Math.min(Number(maxConversations) || 100, 500));
  const rows = [];

  for (const botId of botsToList) {
    const bot = getBot(botId);
    if (!bot) continue;
    const ids = (await listConversationIds(botId)).slice(0, Math.max(0, safeLimit - rows.length));
    for (const id of ids) {
      const [messages, meta] = await Promise.all([
        loadConversation(botId, id),
        loadSubscriberMeta(botId, id)
      ]);
      if (!Array.isArray(messages)) continue;

      const lastAssistant = getLastAssistantMessage(messages);
      if (!lastAssistant) {
        rows.push({
          bot: bot.id,
          subscriber_id: id,
          meta,
          status: 'skipped',
          reason: 'no_assistant_message'
        });
        continue;
      }

      if (!bot.uchatApiKey) {
        rows.push({
          bot: bot.id,
          subscriber_id: id,
          meta,
          status: 'error',
          reason: 'missing_uchat_key',
          assistant_index: lastAssistant.index,
          assistant_preview: lastAssistant.content.slice(0, 220),
          local_created_at: lastAssistant.createdAt
        });
        continue;
      }

      try {
        const delivery = await uchatHasAssistantText(bot, id, lastAssistant.content);
        rows.push({
          bot: bot.id,
          subscriber_id: id,
          meta,
          status: delivery.failed ? 'failed' : (delivery.delivered ? 'delivered' : 'missing'),
          assistant_index: lastAssistant.index,
          assistant_preview: lastAssistant.content.slice(0, 220),
          local_created_at: lastAssistant.createdAt,
          raw_count: delivery.rawCount,
          outbound_count: delivery.outboundCount ?? null,
          matched_preview: delivery.matchedText ? String(delivery.matchedText).slice(0, 220) : null,
          matched_at: delivery.matchedAt || null,
          delivery_status: delivery.deliveryStatus || null,
          reason: delivery.reason || null
        });
      } catch (err) {
        const detail = err.response?.data || err.message;
        rows.push({
          bot: bot.id,
          subscriber_id: id,
          meta,
          status: 'error',
          assistant_index: lastAssistant.index,
          assistant_preview: lastAssistant.content.slice(0, 220),
          local_created_at: lastAssistant.createdAt,
          error: typeof detail === 'string' ? detail.slice(0, 300) : rawJsonPreview(detail, 300)
        });
      }

      if (rows.length >= safeLimit) break;
    }
    if (rows.length >= safeLimit) break;
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
  listPitchClickEvents,
  withTimeAwareMessages
});

createChatAnalyzer({
  app,
  getBot,
  listBotIds,
  redisClient,
  isRedisEnabled: () => redisEnabled,
  REDIS_KEY_PREFIX,
  assertViewMessagesAuth,
  wantsHtmlResponse,
  adminPageShell,
  escHtml,
  renderSubscriberCell,
  tokenQuerySuffix,
  tokenQueryFirst,
  VIEW_MESSAGES_TOKEN,
  loadConversation,
  listConversationIds,
  loadSubscriberMeta,
  listPitchClickEvents,
  callGrokWithPrompt: promptLab.callGrokWithPrompt,
  createDraftFromAnalyzer: promptLab.createDraftFromAnalyzer,
  getEffectivePromptBody,
  PUBLIC_BASE_URL,
  GROK_API_KEY
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

      const { subscriberId, userText, firstName, igUsername, imageUrl, chatImageUrl } = extractWebhookFields(body);

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
      messages.push({
        role: 'user',
        content: userText,
        createdAt: new Date().toISOString(),
        ...(chatImageUrl ? { imageUrl: chatImageUrl } : {})
      });
    trimHistory(messages);
      await saveConversation(bot.id, subscriberId, messages);

      const dueAt = await schedulePending(bot.id, subscriberId, {
        firstName,
        igUsername,
        imageUrl,
        chatImageUrl,
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
        chat_image_url: chatImageUrl ?? null,
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
      const { subscriberId, userText, firstName, igUsername, imageUrl, chatImageUrl } = extractWebhookFields(body || {});
    pushTrigger({
      id: triggerId,
      at: new Date().toISOString(),
      outcome: 'error',
        bot: bot ? bot.id : botId,
      subscriber_id: subscriberId ?? null,
      first_name: firstName ?? null,
      ig_username: igUsername ?? null,
        image_url: imageUrl ?? null,
        chat_image_url: chatImageUrl ?? null,
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

// ── Pitch click tracking (302 redirect — no VIEW_MESSAGES_TOKEN gate) ───────
app.get('/r/:botId/:subscriberId/:pitchId', async (req, res) => {
  const botId = String(req.params.botId || '').toLowerCase();
  const subscriberId = String(req.params.subscriberId || '').trim();
  const pitchId = String(req.params.pitchId || '').trim();
  const bot = getBot(botId);
  if (!bot || !subscriberId || !pitchId) {
    return res.status(400).type('text').send('Bad request');
  }
  const dest = bot.exclusiveLink;
  if (!dest) {
    return res.status(503).type('text').send('Exclusive link not configured for this bot');
  }
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    .trim();
  const remote = req.socket?.remoteAddress || '';
  try {
    await logPitchClickEvent(bot.id, subscriberId, {
      pitchId,
      ts: new Date().toISOString(),
      ip: forwarded || remote,
      ua: String(req.headers['user-agent'] || '').slice(0, 500)
    });
  } catch (err) {
    console.error('❌ pitch click log:', err.message);
  }
  res.redirect(302, dest);
});

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
          `${t.chat_image_url ? '[image] ' : ''}${(t.user_text || '').slice(0, 120)}`
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
      last_preview: last?.content
            ? `${last.imageUrl ? '[image] ' : ''}${String(last.content).slice(0, 120)}`
            : (last?.imageUrl ? '[image]' : null)
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
        (m) => {
          const imageHtml = m.imageUrl
            ? `<div style="margin-top:.6rem"><a href="${esc(m.imageUrl)}" target="_blank" rel="noreferrer"><img src="${esc(m.imageUrl)}" alt="chat image" style="max-width:min(100%,320px);border-radius:12px;border:1px solid #dbe1ea"></a></div>`
            : '';
          return `<div class="bubble ${esc(m.role)}"><strong>${esc(m.role)}</strong><pre>${esc(m.content)}</pre>${imageHtml}</div>`;
        }
      )
      .join('\n');
    const bodyHtml = `
      <div class="actions">
        <a class="button" href="/messages?format=html${tokenQ}">All threads</a>
        <a class="button" href="/conversations?format=html&bot=${encodeURIComponent(bot.id)}${tokenQ}">${esc(bot.displayName)} conversations</a>
        <a class="button" href="/prompt-lab/test?format=html&botId=${encodeURIComponent(bot.id)}&subscriberId=${encodeURIComponent(subscriberId)}${tokenQ}">Open in Prompt Lab</a>
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

app.get('/delivery-check', async (req, res) => {
  if (!assertViewMessagesAuth(req, res)) return;

  try {
    const filterBot = req.query.bot ? String(req.query.bot).toLowerCase() : null;
    const limit = parseInt(req.query.limit || '100', 10);
    const rows = await collectDeliveryCheckRows(filterBot, limit);
    const counts = rows.reduce((acc, row) => {
      acc[row.status] = (acc[row.status] || 0) + 1;
      return acc;
    }, {});

    if (!wantsHtmlResponse(req)) {
      return res.json({
        count: rows.length,
        counts,
        bot_filter: filterBot,
        rows
      });
    }

    const tokenQ = tokenQuerySuffix();
    const botOptions = [
      `<option value=""${filterBot ? '' : ' selected'}>all bots</option>`,
      ...listBotIds().map((id) => `<option value="${escHtml(id)}"${id === filterBot ? ' selected' : ''}>${escHtml(id)}</option>`)
    ].join('');
    const statusNote = req.query.resend
      ? `<div class="card"><strong>Resend:</strong> ${escHtml(req.query.resend)}</div>`
      : '';

    const trs = rows
      .map((row) => {
        const statusHtml = row.status === 'missing'
          ? '<span class="bad">missing from UChat</span>'
          : row.status === 'failed'
            ? '<span class="bad">failed in UChat</span>'
          : row.status === 'delivered'
            ? '<span class="ok">seen in UChat</span>'
            : `<span class="pill">${escHtml(row.status)}</span>`;
        const resendHtml = row.status === 'missing' || row.status === 'failed'
          ? `<form method="post" action="/delivery-check/resend?format=html${tokenQ}" onsubmit="return confirm('Resend this saved assistant reply to UChat?')">
              <input type="hidden" name="botId" value="${escHtml(row.bot)}">
              <input type="hidden" name="subscriberId" value="${escHtml(row.subscriber_id)}">
              <input type="hidden" name="assistantIndex" value="${escHtml(row.assistant_index)}">
              <button class="button" type="submit">Resend</button>
            </form>`
          : row.status === 'delivered'
            ? `<form method="post" action="/delivery-check/resend?format=html${tokenQ}" onsubmit="return confirm('UChat has this message, but IG may not. Resend anyway?')">
                <input type="hidden" name="botId" value="${escHtml(row.bot)}">
                <input type="hidden" name="subscriberId" value="${escHtml(row.subscriber_id)}">
                <input type="hidden" name="assistantIndex" value="${escHtml(row.assistant_index)}">
                <input type="hidden" name="force" value="1">
                <button class="button" type="submit">Resend anyway</button>
              </form>`
          : '';
        const detailParts = [];
        if (row.local_created_at) detailParts.push(`local: ${row.local_created_at}`);
        if (row.matched_at) detailParts.push(`uchat: ${row.matched_at}`);
        if (row.delivery_status) detailParts.push(`status: ${row.delivery_status}`);
        if (row.error || row.reason) detailParts.push(row.error || row.reason);
        if (row.matched_preview) detailParts.push(`matched in UChat: ${row.matched_preview}`);
        const detail = detailParts.join(' · ');
        return `<tr>
          <td><span class="pill">${escHtml(row.bot)}</span></td>
          <td>${renderSubscriberCell(row.meta, row.subscriber_id)}</td>
          <td>${statusHtml}</td>
          <td><pre>${escHtml(row.assistant_preview || '')}</pre></td>
          <td>${escHtml(detail)}</td>
          <td>${resendHtml}</td>
        </tr>`;
      })
      .join('');

    const body = `
      ${statusNote}
      <p class="muted">Important: <strong>seen in UChat</strong> only means UChat has the outbound text. It does not prove Instagram received it. If UChat was disconnected from IG during that time, use <strong>Resend anyway</strong> after reviewing the row.</p>
      <form method="get" action="/delivery-check" class="card">
        <input type="hidden" name="format" value="html">
        <p><label>Bot<br><select name="bot">${botOptions}</select></label></p>
        <p><label>Max conversations<br><input name="limit" type="number" min="1" max="500" value="${escHtml(Number.isFinite(limit) ? limit : 100)}"></label></p>
        ${VIEW_MESSAGES_TOKEN ? `<input type="hidden" name="token" value="${escHtml(VIEW_MESSAGES_TOKEN)}">` : ''}
        <button class="button" type="submit">Scan delivery</button>
        <a class="button" href="/delivery-check?format=json${tokenQ}">JSON</a>
      </form>
      <div class="card">
        <strong>Summary:</strong>
        seen in UChat ${escHtml(counts.delivered || 0)} · failed in UChat ${escHtml(counts.failed || 0)} · missing from UChat ${escHtml(counts.missing || 0)} · errors ${escHtml(counts.error || 0)} · skipped ${escHtml(counts.skipped || 0)}
      </div>
      <table>
        <thead><tr><th>Bot</th><th>User</th><th>Status</th><th>Last assistant reply</th><th>Detail</th><th>Action</th></tr></thead>
        <tbody>${trs || '<tr><td colspan="6" class="muted">No conversations found.</td></tr>'}</tbody>
      </table>
    `;
    return res.type('html').send(adminPageShell('Delivery Check', body));
  } catch (err) {
    console.error('❌ /delivery-check error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Failed to check delivery', detail: err.message });
  }
});

app.post('/delivery-check/resend', async (req, res) => {
  if (!assertViewMessagesAuth(req, res)) return;

  const botId = String(req.body.botId || '').toLowerCase();
  const subscriberId = String(req.body.subscriberId || '').trim();
  const assistantIndex = Number(req.body.assistantIndex);
  const force = String(req.body.force || '') === '1';
  const bot = getBot(botId);

  try {
    if (!bot) return res.status(404).json({ status: 'error', reason: 'unknown_bot' });
    if (!subscriberId || !Number.isInteger(assistantIndex)) {
      return res.status(400).json({ status: 'error', reason: 'missing_or_invalid_input' });
    }

    const messages = await loadConversation(bot.id, subscriberId);
    const msg = Array.isArray(messages) ? messages[assistantIndex] : null;
    if (!msg || msg.role !== 'assistant' || !String(msg.content || '').trim()) {
      return res.status(409).json({ status: 'error', reason: 'assistant_message_changed' });
    }

    const delivery = await uchatHasAssistantText(bot, subscriberId, msg.content);
    if (delivery.delivered && !delivery.failed && !force) {
      pushTrigger({
        id: `${Date.now()}-delivery-skip-${Math.random().toString(36).slice(2, 9)}`,
        at: new Date().toISOString(),
        outcome: 'delivery_already_delivered',
        bot: bot.id,
        subscriber_id: subscriberId,
        reply_preview: String(msg.content).slice(0, 200)
      });
      if (wantsHtmlResponse(req)) {
        return res.redirect(`/delivery-check?format=html&bot=${encodeURIComponent(bot.id)}&resend=already_delivered${tokenQuerySuffix()}`);
      }
      return res.json({ status: 'already_delivered', delivery });
    }

    const chunks = await sendUchatText(bot, subscriberId, msg.content);
    pushTrigger({
      id: `${Date.now()}-${force ? 'delivery-force-resend' : 'delivery-resend'}-${Math.random().toString(36).slice(2, 9)}`,
      at: new Date().toISOString(),
      outcome: force ? 'delivery_force_resend' : 'delivery_resend',
      bot: bot.id,
      subscriber_id: subscriberId,
      assistant_index: assistantIndex,
      uchat_parts: chunks.length,
      reply_preview: String(msg.content).slice(0, 200)
    });

    if (wantsHtmlResponse(req)) {
      return res.redirect(`/delivery-check?format=html&bot=${encodeURIComponent(bot.id)}&resend=${force ? 'force_sent' : 'sent'}${tokenQuerySuffix()}`);
    }
    return res.json({
      status: force ? 'force_sent' : 'sent',
      bot: bot.id,
      subscriber_id: subscriberId,
      assistant_index: assistantIndex,
      chunks: chunks.length
    });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('❌ /delivery-check/resend error:', detail);
    if (wantsHtmlResponse(req)) {
      return res.redirect(`/delivery-check?format=html&bot=${encodeURIComponent(botId)}&resend=error${tokenQuerySuffix()}`);
    }
    return res.status(500).json({
      status: 'error',
      reason: typeof detail === 'string' ? detail : rawJsonPreview(detail, 500)
    });
  }
});

app.get('/live-chat-sync', async (req, res) => {
  if (!assertViewMessagesAuth(req, res)) return;

  const botId = String(req.query.bot || DEFAULT_BOT_ID).toLowerCase();
  const subscriberId = String(req.query.subscriberId || req.query.user_ns || '').trim();
  const limit = Math.max(1, Math.min(parseInt(req.query.limit || '50', 10) || 50, 100));
  const bot = getBot(botId);

  try {
    if (!bot) return res.status(404).json({ error: 'Unknown bot', bot: botId });
    if (!wantsHtmlResponse(req) && !subscriberId) {
      return res.status(400).json({ error: 'Missing subscriberId/user_ns' });
    }

    const localMessages = subscriberId ? (await loadConversation(bot.id, subscriberId)) || [] : [];
    const meta = subscriberId ? await loadSubscriberMeta(bot.id, subscriberId) : {};
    let raw = [];
    let normalized = [];
    let fetchError = null;
    if (subscriberId) {
      try {
        raw = await fetchUchatChatMessagesWithOptions(bot, {
          user_ns: subscriberId,
          include_bot: 1,
          include_note: 0,
          include_system: 0,
          limit
        });
        normalized = normalizeUchatLiveChatMessages(raw, limit);
      } catch (err) {
        const detail = err.response?.data || err.message;
        fetchError = typeof detail === 'string' ? detail : rawJsonPreview(detail, 500);
      }
    }

    if (!wantsHtmlResponse(req)) {
      return res.json({
        bot: bot.id,
        subscriber_id: subscriberId,
        local_count: Array.isArray(localMessages) ? localMessages.filter((m) => m.role !== 'system').length : 0,
        uchat_raw_count: raw.length,
        normalized_count: normalized.length,
        fetch_error: fetchError,
        messages: normalized,
        raw
      });
    }

    const tokenQ = tokenQuerySuffix();
    const botOptions = listBotIds()
      .map((id) => `<option value="${escHtml(id)}"${id === bot.id ? ' selected' : ''}>${escHtml(id)}</option>`)
      .join('');
    const previewRows = normalized
      .map((m) => `<tr>
        <td><span class="pill">${escHtml(m.role)}</span></td>
        <td>${escHtml(m.createdAt || '')}</td>
        <td><pre>${escHtml(m.content || '')}</pre>${m.imageUrl ? `<a href="${escHtml(m.imageUrl)}" target="_blank" rel="noreferrer">image</a>` : ''}</td>
        <td><code>${escHtml(m.uchat?.id ?? '')}</code> ${escHtml(m.uchat?.msg_type || '')}</td>
      </tr>`)
      .join('');
    const localCount = Array.isArray(localMessages) ? localMessages.filter((m) => m.role !== 'system').length : 0;
    const body = `
      <p class="muted">Pulls UChat live chat messages for one subscriber and lets you replace local Redis conversation history with that UChat history. This is UChat sync, not direct Instagram API sync.</p>
      <form method="get" action="/live-chat-sync" class="card">
        <input type="hidden" name="format" value="html">
        ${VIEW_MESSAGES_TOKEN ? `<input type="hidden" name="token" value="${escHtml(VIEW_MESSAGES_TOKEN)}">` : ''}
        <p><label>Bot<br><select name="bot">${botOptions}</select></label></p>
        <p><label>Subscriber user_ns<br><input name="subscriberId" value="${escHtml(subscriberId)}" style="width:100%" required></label></p>
        <p><label>Limit<br><input name="limit" type="number" min="1" max="100" value="${escHtml(limit)}"></label></p>
        <button class="button" type="submit">Pull UChat live chat</button>
      </form>
      ${subscriberId ? `<div class="card">
        ${renderSubscriberCell(meta, subscriberId)}
        <p class="muted">Local messages: ${escHtml(localCount)} · UChat raw: ${escHtml(raw.length)} · normalized: ${escHtml(normalized.length)}</p>
        ${fetchError ? `<p class="bad">${escHtml(fetchError)}</p>` : ''}
        ${normalized.length ? `<form method="post" action="/live-chat-sync/apply?format=html${tokenQ}" onsubmit="return confirm('Replace local conversation history with this UChat live chat snapshot?')">
          <input type="hidden" name="botId" value="${escHtml(bot.id)}">
          <input type="hidden" name="subscriberId" value="${escHtml(subscriberId)}">
          <input type="hidden" name="limit" value="${escHtml(limit)}">
          <button class="button" type="submit">Sync local history from UChat</button>
        </form>` : ''}
      </div>` : ''}
      <table>
        <thead><tr><th>Role</th><th>Time</th><th>Message</th><th>UChat</th></tr></thead>
        <tbody>${previewRows || '<tr><td colspan="4" class="muted">Enter subscriber user_ns and pull live chat.</td></tr>'}</tbody>
      </table>
    `;
    return res.type('html').send(adminPageShell('Live Chat Sync', body));
  } catch (err) {
    console.error('❌ /live-chat-sync error:', err.response?.data || err.message);
    return res.status(500).json({ error: 'Failed to pull live chat', detail: err.message });
  }
});

app.post('/live-chat-sync/apply', async (req, res) => {
  if (!assertViewMessagesAuth(req, res)) return;

  const botId = String(req.body.botId || DEFAULT_BOT_ID).toLowerCase();
  const subscriberId = String(req.body.subscriberId || '').trim();
  const limit = Math.max(1, Math.min(parseInt(req.body.limit || '50', 10) || 50, 100));
  const bot = getBot(botId);

  try {
    if (!bot) return res.status(404).json({ error: 'Unknown bot', bot: botId });
    if (!subscriberId) return res.status(400).json({ error: 'Missing subscriberId' });
    const existing = (await loadConversation(bot.id, subscriberId)) || [];
    const raw = await fetchUchatChatMessagesWithOptions(bot, {
      user_ns: subscriberId,
      include_bot: 1,
      include_note: 0,
      include_system: 0,
      limit
    });
    const normalized = normalizeUchatLiveChatMessages(raw, limit);
    const systemMessage = await buildSystemMessageForExistingConversation(bot, subscriberId, existing);
    const nextMessages = [systemMessage, ...normalized];
    trimHistory(nextMessages);
    await saveConversation(bot.id, subscriberId, nextMessages);

    pushTrigger({
      id: `${Date.now()}-live-chat-sync-${Math.random().toString(36).slice(2, 9)}`,
      at: new Date().toISOString(),
      outcome: 'live_chat_sync',
      bot: bot.id,
      subscriber_id: subscriberId,
      imported_count: normalized.length,
      raw_count: raw.length
    });

    if (wantsHtmlResponse(req)) {
      return res.redirect(`/messages/${encodeURIComponent(bot.id)}/${encodeURIComponent(subscriberId)}?format=html${tokenQuerySuffix()}`);
    }
    return res.json({
      status: 'ok',
      bot: bot.id,
      subscriber_id: subscriberId,
      imported_count: normalized.length,
      raw_count: raw.length
    });
  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('❌ /live-chat-sync/apply error:', detail);
    return res.status(500).json({
      error: 'Failed to sync live chat',
      detail: typeof detail === 'string' ? detail : rawJsonPreview(detail, 500)
    });
  }
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
        delivery_check: `/delivery-check${tokenFirst}`,
        live_chat_sync: `/live-chat-sync${tokenFirst}`,
        prompt_lab: `/prompt-lab${tokenFirst}`,
        analyzer: `/analyzer${tokenFirst}`
      }
    });
  }

  const publicBaseConfigured = !!String(PUBLIC_BASE_URL || '').trim();
  const grokConfigured = !!GROK_API_KEY;
  const tokenConfigured = !!VIEW_MESSAGES_TOKEN;
  const exclusiveCount = listBotIds().filter((id) => !!getBot(id)?.exclusiveLink).length;

  const stat = (href, label, value, hint, modifier = '') =>
    `<a class="stat ${modifier}" href="${href}">
      <div class="label">${escHtml(label)}</div>
      <div class="value">${escHtml(String(value))}</div>
      ${hint ? `<div class="hint">${hint}</div>` : ''}
    </a>`;

  const body = `
    <p class="muted">Operational overview. Click any tile to drill in.</p>

    <div class="grid grid-4" style="margin-top:.85rem">
      ${stat(`/conversations?format=html${tokenQ}`, 'Conversations', conversations.length, 'all bots combined')}
      ${stat(`/pending?format=html${tokenQ}`, 'Pending replies', pending.length, pending.length ? 'awaiting flush' : 'queue clear', pending.length ? '' : 'ok')}
      ${stat(`/failed?format=html${tokenQ}`, 'Failed (recent)', failed.length, 'in-memory log', failed.length ? 'danger' : '')}
      ${stat(`/history-imports?format=html${tokenQ}`, 'History imports', imports.length, 'first-touch UChat pulls')}
    </div>

    <h2>AI tuning</h2>
    <div class="grid grid-2">
      <a class="card stat" href="/prompt-lab?format=html${tokenQ}" style="display:block">
        <div class="label">Prompt Lab</div>
        <div class="value" style="font-size:1.15rem">Drafts &amp; A/B tests</div>
        <div class="hint">Clone the live prompt, edit safely, A/B against real conversations, then promote.</div>
      </a>
      <a class="card stat" href="/analyzer?format=html${tokenQ}" style="display:block">
        <div class="label">Chat &amp; Pitch Analyzer</div>
        <div class="value" style="font-size:1.15rem">Scores &amp; insights</div>
        <div class="hint">LLM judge + click tracking; one-click "Suggest prompt patch" feeds into Prompt Lab.</div>
      </a>
    </div>

    <h2>Bots</h2>
    <div class="grid grid-3">
      ${bots.map((b) => `
        <div class="card">
          <div class="label muted" style="font-size:11.5px;letter-spacing:.04em;text-transform:uppercase">${escHtml(b.id)}</div>
          <div style="font-size:1.05rem;font-weight:650;margin-top:.1rem">${escHtml(b.display_name)}</div>
          <div class="muted" style="margin-top:.35rem">tz <code>${escHtml(b.timezone)}</code></div>
          <div class="muted" style="margin-top:.15rem">UChat key ${b.uchat_key === 'present' ? '<span class="ok">present</span>' : '<span class="bad">missing</span>'}</div>
          <div class="muted" style="margin-top:.15rem">conversations ${escHtml(String(b.conversation_count))} · pending ${escHtml(String(b.pending_count))}</div>
          <div class="actions" style="margin-top:.65rem">
            <a class="button" href="/conversations?format=html&bot=${encodeURIComponent(b.id)}${tokenQ}">Threads</a>
            <a class="button" href="/analyzer/conversations?format=html&bot=${encodeURIComponent(b.id)}${tokenQ}">Analyze</a>
          </div>
        </div>`).join('')}
    </div>

    <h2>System</h2>
    <div class="card">
      <div class="grid grid-3">
        <div>
          <div class="label muted" style="font-size:11.5px;letter-spacing:.04em;text-transform:uppercase">Storage</div>
          <div style="font-weight:650;margin-top:.15rem">${redisEnabled ? '<span class="ok">Redis connected</span>' : '<span class="warn">In-memory only</span>'}</div>
          <div class="muted">${redisEnabled ? 'persistent across restarts' : 'restart wipes state'}</div>
        </div>
        <div>
          <div class="label muted" style="font-size:11.5px;letter-spacing:.04em;text-transform:uppercase">Grok</div>
          <div style="font-weight:650;margin-top:.15rem">${grokConfigured ? '<span class="ok">API key set</span>' : '<span class="bad">missing</span>'}</div>
          <div class="muted">model ${escHtml(GROK_MODEL)}</div>
        </div>
        <div>
          <div class="label muted" style="font-size:11.5px;letter-spacing:.04em;text-transform:uppercase">Admin auth</div>
          <div style="font-weight:650;margin-top:.15rem">${tokenConfigured ? '<span class="ok">token required</span>' : '<span class="warn">unprotected</span>'}</div>
          <div class="muted">${tokenConfigured ? '?token= or X-View-Token' : 'set VIEW_MESSAGES_TOKEN before exposing'}</div>
        </div>
        <div>
          <div class="label muted" style="font-size:11.5px;letter-spacing:.04em;text-transform:uppercase">Pitch tracking</div>
          <div style="font-weight:650;margin-top:.15rem">${publicBaseConfigured ? '<span class="ok">PUBLIC_BASE_URL set</span>' : '<span class="warn">not set</span>'}</div>
          <div class="muted">${publicBaseConfigured ? escHtml(PUBLIC_BASE_URL) : 'add to .env so /r/… click links work'}</div>
        </div>
        <div>
          <div class="label muted" style="font-size:11.5px;letter-spacing:.04em;text-transform:uppercase">Exclusive links</div>
          <div style="font-weight:650;margin-top:.15rem">${exclusiveCount}/${listBotIds().length} bots configured</div>
          <div class="muted">SARA_EXCLUSIVE_LINK / ESMA_EXCLUSIVE_LINK</div>
        </div>
        <div>
          <div class="label muted" style="font-size:11.5px;letter-spacing:.04em;text-transform:uppercase">Debounce window</div>
          <div style="font-weight:650;margin-top:.15rem">${formatDelay(DEBOUNCE_MIN_MS)} – ${formatDelay(DEBOUNCE_MAX_MS)}</div>
          <div class="muted">silence required before a Grok flush</div>
        </div>
      </div>
    </div>

    <h2>Debug shortcuts</h2>
    <div class="actions">
      <a class="button" href="/messages?format=html${tokenQ}">Threads</a>
      <a class="button" href="/triggers?format=html${tokenQ}">Triggers</a>
      <a class="button" href="/delivery-check?format=html${tokenQ}">Delivery check</a>
      <a class="button" href="/live-chat-sync?format=html${tokenQ}">Live chat sync</a>
      <a class="button" href="/history-imports?format=html${tokenQ}">History imports</a>
      <a class="button" href="/failed?format=html${tokenQ}">Failed events</a>
    </div>
  `;
  res.type('html').send(adminPageShell('Admin', body));
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

  const saraOn = isSaraEnabled();
  const saraStatus = saraOn
    ? '<span class="ok">enabled</span>'
    : '<span class="bad">disabled (banned)</span>';
  const saraAction = `
    <form method="post" action="/bots/sara/toggle?format=html${tokenQ}" style="display:inline">
      <input type="hidden" name="enabled" value="${saraOn ? 'false' : 'true'}">
      <button class="button" type="submit">${saraOn ? 'Disable Sara' : 'Enable Sara'}</button>
    </form>
  `;

  const body = `
    <div class="card" style="margin-bottom:1rem">
      <strong>Sara status:</strong> ${saraStatus} &nbsp; ${saraAction}
      <span class="muted" style="margin-left:.5rem">Toggle only affects runtime. Restart needed for webhook routes if enabling.</span>
    </div>
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

// Toggle Sara (ban/unban) — dashboard only
app.post('/bots/sara/toggle', async (req, res) => {
  if (!assertViewMessagesAuth(req, res)) return;
  const enabled = String(req.body.enabled || '').toLowerCase() === 'true';
  setSaraEnabled(enabled);
  if (wantsHtmlResponse(req)) {
    return res.redirect(`/bots?format=html${tokenQuerySuffix()}`);
  }
  res.json({ sara_enabled: isSaraEnabled() });
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
      `   GET  /delivery-check?format=html ← Review missing UChat deliveries${VIEW_MESSAGES_TOKEN ? ' (token required)' : ''}`
    );
    console.log(
      `   GET  /live-chat-sync?format=html ← Pull UChat live chat history${VIEW_MESSAGES_TOKEN ? ' (token required)' : ''}`
    );
    console.log(
      `   GET  /prompt-lab?format=html ← Prompt drafts + A/B tests${VIEW_MESSAGES_TOKEN ? ' (token required)' : ''}`
    );
    console.log(
      `   GET  /analyzer?format=html   ← Chat & pitch scores + insights${VIEW_MESSAGES_TOKEN ? ' (token required)' : ''}`
    );
    console.log('   GET  /r/:bot/:subscriber/:pitchId ← Pitch click tracking → exclusive link (no token)');
    console.log(`   Tip: npm run dev:public      → Public HTTPS URL (TUNNEL=serveo|pinggy|cloudflare)\n`);
  });
}

startServer().catch((err) => {
  console.error('❌ Failed to start server:', err.message);
  process.exit(1);
});
