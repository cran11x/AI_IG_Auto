#!/usr/bin/env node
/**
 * Prompt tester — više Esma varijanti + ista test povijest.
 *
 *   npm run test:prompt
 *   npm run test:prompt -- --variants     → ispiše sve imena varijanti
 *   npm run test:prompt -- --variant=slowburn
 *   npm run test:prompt -- --variant=shortdry "yo" "prove it"
 *   npm run test:prompt -- --plain "hello"
 */
require('dotenv').config();
const axios = require('axios');
const { variants, listVariants } = require('./prompts/variants');
const { withTimeAwareMessages } = require('./prompts/timeContext');

const GROK_URL = 'https://api.x.ai/v1/chat/completions';
const GROK_MODEL = process.env.GROK_MODEL || 'grok-4';
const GROK_API_KEY = process.env.GROK_API_KEY;

const DEFAULT_LINES = [
  'yo esma whats up',
  'I slept well baby how about you',
  'You are really pretty',
  'What would you do if you were here right now',
  'kako si lepa danas'
];

function parseArgs(argv) {
  let plain = false;
  let listOnly = false;
  let variant = 'production';
  const rest = [];
  for (const a of argv) {
    if (a === '--plain') plain = true;
    else if (a === '--variants' || a === '--list') listOnly = true;
    else if (a.startsWith('--variant=')) variant = a.slice('--variant='.length);
    else rest.push(a);
  }
  return { plain, listOnly, variant, rest };
}

function buildInitialMessages(systemText, nameLine) {
  if (!systemText) return [];
  let system = systemText;
  if (nameLine) system += `\nYou are currently talking to: ${nameLine}.`;
  return [{ role: 'system', content: system }];
}

async function callGrok(messages) {
  const payloadMessages = withTimeAwareMessages(messages);
  const res = await axios.post(
    GROK_URL,
    { model: GROK_MODEL, messages: payloadMessages, temperature: 0.85 },
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROK_API_KEY}`
      }
    }
  );
  return res.data.choices[0].message.content;
}

async function main() {
  const argv = process.argv.slice(2);
  const { plain, listOnly, variant, rest } = parseArgs(argv);

  if (listOnly) {
    console.log('Varijante:', listVariants());
    console.log('\nPrimjer: npm run test:prompt -- --variant=slowburn');
    return;
  }

  const lines = rest.length ? rest : DEFAULT_LINES;

  if (!GROK_API_KEY) {
    console.error('Missing GROK_API_KEY in .env');
    process.exit(1);
  }

  if (!plain && !variants[variant]) {
    console.error(`Unknown variant "${variant}". Dostupno: ${listVariants()}`);
    process.exit(1);
  }

  const nameLine = 'Stanley (@stanleymartinez1986)';
  const systemBody = plain ? null : variants[variant];
  let messages = buildInitialMessages(systemBody, nameLine);

  if (plain) console.log('Mode: plain (no system)\n');
  else console.log(`Mode: variant "${variant}"\n`);

  for (let i = 0; i < lines.length; i++) {
    const userText = lines[i];
    console.log('─'.repeat(60));
    console.log(`USER [${i + 1}/${lines.length}]:`, userText);
    messages.push({ role: 'user', content: userText });
    try {
      const reply = await callGrok(messages);
      console.log('REPLY:', reply);
      messages.push({ role: 'assistant', content: reply });
    } catch (e) {
      const d = e.response?.data || e.message;
      console.error('ERR:', typeof d === 'string' ? d : JSON.stringify(d, null, 2));
      process.exit(1);
    }
  }
  console.log('─'.repeat(60));
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
