#!/usr/bin/env node
/**
 * CLI: export filtered conversations to ./exports/
 *
 * Usage:
 *   node export-conversations.js --bot=esma --limit=50
 *   node export-conversations.js --bot=sara --linkSent=true --minMessages=4
 *   node export-conversations.js --format=json --out=./exports/esma-bad.json
 *
 * Requires REDIS_URL (or in-memory only if server ran locally without Redis — usually empty).
 */
const fs = require('fs');
const path = require('path');
const { getBot, listBotIds } = require('./prompts/bots');
const { exportConversations, formatExportBody } = require('./conversationExport');
const { createConversationStorage } = require('./conversationStorage');

function parseArgs(argv) {
  const opts = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq > 2) {
      opts[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      opts[arg.slice(2)] = 'true';
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const storage = await createConversationStorage();

  try {
    const result = await exportConversations(
      {
        listBotIds,
        getBot,
        listConversationIds: storage.listConversationIds,
        loadConversation: storage.loadConversation,
        loadSubscriberMeta: storage.loadSubscriberMeta,
        listPitchClickEvents: storage.listPitchClickEvents
      },
      {
        bot: opts.bot,
        since: opts.since,
        until: opts.until,
        minMessages: opts.minMessages || opts['min-messages'],
        limit: opts.limit,
        linkSent: opts.linkSent || opts['link-sent'],
        format: opts.format || 'jsonl'
      }
    );

    const body = formatExportBody(result);
    const botSlug = result.filters.botId || 'all';
    const ext = result.format === 'json' ? 'json' : 'jsonl';
    const defaultName = `conversations-${botSlug}-${new Date().toISOString().slice(0, 10)}.${ext}`;
    const outPath = path.resolve(opts.out || path.join('exports', defaultName));

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, body, 'utf8');

    console.log(`Exported ${result.count} conversation(s) → ${outPath}`);
    if (!result.count) {
      console.log('Tip: try lowering minMessages or removing linkSent filter.');
      process.exitCode = 1;
    }
  } finally {
    await storage.close();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Export failed:', err.message);
    process.exit(1);
  });
}
