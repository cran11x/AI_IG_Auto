/**
 * Read-only conversation storage for CLI export (mirrors index.js Redis keys).
 */
require('dotenv').config();
const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL;
const REDIS_KEY_PREFIX = process.env.REDIS_KEY_PREFIX || 'autodms';

const conversations = new Map();
const subscriberMetaStore = new Map();
const pitchClickMemStore = new Map();

const memKey = (botId, subscriberId) => `${botId}:${subscriberId}`;

const conversationKey = (botId, subscriberId) =>
  `${REDIS_KEY_PREFIX}:${botId}:conversation:${subscriberId}`;
const conversationIndexKey = (botId) => `${REDIS_KEY_PREFIX}:${botId}:conversations`;
const subscriberMetaKey = (botId, subscriberId) =>
  `${REDIS_KEY_PREFIX}:${botId}:subscriberMeta:${subscriberId}`;
const pitchClickListKey = (botId, subscriberId) =>
  `${REDIS_KEY_PREFIX}:${botId}:pitchClick:${subscriberId}`;

async function loadConversation(redisClient, botId, subscriberId) {
  if (redisClient) {
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

async function listConversationIds(redisClient, botId) {
  if (redisClient) {
    return redisClient.sMembers(conversationIndexKey(botId));
  }
  const prefix = `${botId}:`;
  return [...conversations.keys()]
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));
}

async function loadSubscriberMeta(redisClient, botId, subscriberId) {
  if (redisClient) {
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

async function listPitchClickEvents(redisClient, botId, subscriberId) {
  if (redisClient) {
    const raw = await redisClient.lRange(pitchClickListKey(botId, subscriberId), 0, -1);
    return raw
      .map((r) => {
        try {
          return JSON.parse(r);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
  return [...(pitchClickMemStore.get(memKey(botId, subscriberId)) || [])];
}

/**
 * @returns {Promise<{ loadConversation, listConversationIds, loadSubscriberMeta, listPitchClickEvents, close }>}
 */
async function createConversationStorage() {
  let redisClient = null;
  if (REDIS_URL) {
    redisClient = createClient({ url: REDIS_URL });
    await redisClient.connect();
  }

  return {
    loadConversation: (botId, subscriberId) => loadConversation(redisClient, botId, subscriberId),
    listConversationIds: (botId) => listConversationIds(redisClient, botId),
    loadSubscriberMeta: (botId, subscriberId) => loadSubscriberMeta(redisClient, botId, subscriberId),
    listPitchClickEvents: (botId, subscriberId) => listPitchClickEvents(redisClient, botId, subscriberId),
    async close() {
      if (redisClient) await redisClient.quit();
    }
  };
}

module.exports = { createConversationStorage };
