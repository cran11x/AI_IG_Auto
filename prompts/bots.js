/**
 * Multi-bot konfiguracija. Svaki bot dijeli istu webhook/debounce/Grok/UChat logiku
 * iz index.js, ali ima vlastiti prompt, timezone, UChat API key i namespace u Redisu.
 *
 * Dodavanje novog bota:
 *   1. Napravi prompt fajl u prompts/<id>.js i exportaj prompt string.
 *   2. Dodaj entry u BOTS niže s id, displayName, prompt, timezone, uchatApiKey.
 *   3. Dodaj rutu u index.js (POST /webhook/uchat/<id>) — vidi tamo postojeće rute.
 */

const { ESMA_PROMPT } = require('./esma');
const { SARA_PROMPT } = require('./sara');

let saraEnabled = String(process.env.SARA_ENABLED || '').toLowerCase() === 'true';

function buildBots() {
  const bots = {
    esma: {
      id: 'esma',
      displayName: 'Esma',
      prompt: ESMA_PROMPT,
      timezone: process.env.ESMA_TIMEZONE || 'Europe/London',
      uchatApiKey: process.env.UCHAT_ESMA_API_KEY,
      exclusiveLink: String(process.env.ESMA_EXCLUSIVE_LINK || '').trim() || null
    }
  };
  if (saraEnabled) {
    bots.sara = {
      id: 'sara',
      displayName: 'Sara',
      prompt: SARA_PROMPT,
      timezone: process.env.SARA_TIMEZONE || 'America/New_York',
      uchatApiKey: process.env.UCHAT_SARA_API_KEY,
      exclusiveLink: String(process.env.SARA_EXCLUSIVE_LINK || '').trim() || null
    };
  }
  return bots;
}

const DEFAULT_BOT_ID = 'esma';

let BOTS = buildBots();

function getBot(botId) {
  if (!botId) return BOTS[DEFAULT_BOT_ID];
  return BOTS[String(botId).toLowerCase()] || null;
}

function listBotIds() {
  return Object.keys(BOTS);
}

function getEffectivePrompt(botId, promptOverride) {
  const bot = getBot(botId);
  if (!bot) return null;
  return promptOverride || bot.prompt;
}

function isSaraEnabled() {
  return saraEnabled;
}

function setSaraEnabled(enabled) {
  saraEnabled = !!enabled;
  BOTS = buildBots();
}

module.exports = {
  BOTS,
  DEFAULT_BOT_ID,
  getBot,
  listBotIds,
  getEffectivePrompt,
  isSaraEnabled,
  setSaraEnabled
};
