/**
 * Export production conversations for prompt review (filter by bot, dates, link sent, etc.).
 */

function toCleanString(value) {
  return String(value == null ? '' : value).trim();
}

function nonSystemMessages(messages) {
  return (Array.isArray(messages) ? messages : []).filter((m) => m && m.role !== 'system');
}

function messageTimestamp(message) {
  const raw = message?.createdAt || message?.ts || message?.time || message?.date;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function conversationTimeBounds(messages) {
  const nonSys = nonSystemMessages(messages);
  const stamps = nonSys.map(messageTimestamp).filter(Boolean);
  if (!stamps.length) return { startedAt: null, endedAt: null };
  stamps.sort();
  return { startedAt: stamps[0], endedAt: stamps[stamps.length - 1] };
}

function linkPatternsForBot(bot) {
  const patterns = new Set();
  const exclusive = bot?.exclusiveLink ? String(bot.exclusiveLink).trim() : '';
  if (exclusive) patterns.add(exclusive);
  patterns.add('exclu.at');
  if (process.env.EXCLU_ESMA_LINK) patterns.add(String(process.env.EXCLU_ESMA_LINK).trim());
  if (process.env.EXCLU_LINK) patterns.add(String(process.env.EXCLU_LINK).trim());
  if (bot?.id) patterns.add(`/r/${bot.id}/`);
  return [...patterns].filter(Boolean);
}

function textHasLink(text, patterns) {
  const hay = String(text || '');
  if (!hay) return false;
  return patterns.some((p) => hay.includes(p));
}

function detectLinkSent(messages, bot) {
  const patterns = linkPatternsForBot(bot);
  const nonSys = nonSystemMessages(messages);
  for (const message of nonSys) {
    if (message.role !== 'assistant') continue;
    if (textHasLink(message.content, patterns)) {
      return { linkSent: true, linkSentAt: messageTimestamp(message) };
    }
  }
  return { linkSent: false, linkSentAt: null };
}

function serializeMessages(messages) {
  return nonSystemMessages(messages).map((m) => ({
    role: m.role,
    content: m.content != null ? String(m.content) : '',
    ...(m.createdAt ? { createdAt: m.createdAt } : {}),
    ...(m.imageUrl ? { imageUrl: m.imageUrl } : {})
  }));
}

function buildExportRecord({ botId, subscriberId, messages, meta, pitchEvents, bot }) {
  const nonSys = nonSystemMessages(messages);
  const { startedAt, endedAt } = conversationTimeBounds(messages);
  const linkInfo = detectLinkSent(messages, bot);
  const pitchSent = Array.isArray(pitchEvents) && pitchEvents.length > 0;

  return {
    botId,
    subscriberId,
    meta: meta && typeof meta === 'object' ? meta : {},
    startedAt,
    endedAt,
    messageCount: nonSys.length,
    linkSent: linkInfo.linkSent || pitchSent,
    linkSentAt: linkInfo.linkSentAt,
    messages: serializeMessages(messages),
    pitchEvents: Array.isArray(pitchEvents) ? pitchEvents : []
  };
}

function parseExportFilters(input = {}) {
  const botId = toCleanString(input.bot || input.botId) || null;
  const since = toCleanString(input.since) || null;
  const until = toCleanString(input.until) || null;
  const minMessages = Math.max(0, parseInt(input.minMessages || input.min_messages || '0', 10) || 0);
  const limit = Math.max(1, Math.min(parseInt(input.limit || '100', 10) || 100, 2000));
  const linkSentRaw = toCleanString(input.linkSent ?? input.link_sent);
  let linkSent = null;
  if (linkSentRaw === 'true' || linkSentRaw === '1') linkSent = true;
  if (linkSentRaw === 'false' || linkSentRaw === '0') linkSent = false;
  const format = toCleanString(input.format || 'jsonl').toLowerCase() === 'json' ? 'json' : 'jsonl';
  return { botId, since, until, minMessages, limit, linkSent, format };
}

function passesDateFilter(record, since, until) {
  const start = record.startedAt ? new Date(record.startedAt) : null;
  const end = record.endedAt ? new Date(record.endedAt) : start;
  if (since) {
    const sinceDate = new Date(since);
    if (!Number.isNaN(sinceDate.getTime()) && end && end < sinceDate) return false;
  }
  if (until) {
    const untilDate = new Date(until);
    if (!Number.isNaN(untilDate.getTime()) && start && start > untilDate) return false;
  }
  return true;
}

function passesLinkFilter(record, linkSent) {
  if (linkSent === true) return !!record.linkSent;
  if (linkSent === false) return !record.linkSent;
  return true;
}

/**
 * @param {object} deps
 * @param {() => string[]} deps.listBotIds
 * @param {(id: string) => object|null} deps.getBot
 * @param {(botId: string) => Promise<string[]>} deps.listConversationIds
 * @param {(botId: string, subscriberId: string) => Promise<object[]|undefined>} deps.loadConversation
 * @param {(botId: string, subscriberId: string) => Promise<object>} deps.loadSubscriberMeta
 * @param {(botId: string, subscriberId: string) => Promise<object[]>} [deps.listPitchClickEvents]
 * @param {object} [filters]
 */
async function exportConversations(deps, filters = {}) {
  const parsed = parseExportFilters(filters);
  const {
    listBotIds,
    getBot,
    listConversationIds,
    loadConversation,
    loadSubscriberMeta,
    listPitchClickEvents
  } = deps;

  const botIds = parsed.botId
    ? (getBot(parsed.botId) ? [parsed.botId.toLowerCase()] : [])
    : listBotIds();

  const records = [];

  for (const botId of botIds) {
    const bot = getBot(botId);
    if (!bot) continue;
    const ids = await listConversationIds(botId);
    for (const subscriberId of ids) {
      if (records.length >= parsed.limit) break;
      const [messages, meta, pitchEvents] = await Promise.all([
        loadConversation(botId, subscriberId),
        loadSubscriberMeta(botId, subscriberId),
        listPitchClickEvents
          ? listPitchClickEvents(botId, subscriberId)
          : Promise.resolve([])
      ]);
      if (!Array.isArray(messages)) continue;

      const record = buildExportRecord({
        botId,
        subscriberId,
        messages,
        meta,
        pitchEvents,
        bot
      });

      if (record.messageCount < parsed.minMessages) continue;
      if (!passesDateFilter(record, parsed.since, parsed.until)) continue;
      if (!passesLinkFilter(record, parsed.linkSent)) continue;

      records.push(record);
      if (records.length >= parsed.limit) break;
    }
    if (records.length >= parsed.limit) break;
  }

  records.sort((a, b) => String(b.endedAt || '').localeCompare(String(a.endedAt || '')));

  return {
    count: records.length,
    format: parsed.format,
    filters: parsed,
    conversations: records
  };
}

function formatExportBody(result) {
  if (result.format === 'json') {
    return JSON.stringify({ count: result.count, filters: result.filters, conversations: result.conversations }, null, 2);
  }
  if (!result.conversations.length) {
    return '{"note":"no conversations matched filters"}\n';
  }
  return `${result.conversations.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

module.exports = {
  nonSystemMessages,
  buildExportRecord,
  parseExportFilters,
  exportConversations,
  formatExportBody,
  detectLinkSent
};
