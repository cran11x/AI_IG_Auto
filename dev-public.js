/**
 * Starts index.js, waits until / responds, then opens a public HTTPS tunnel
 * so you can paste https://....../webhook into ManyChat → External Request.
 */
require('dotenv').config();
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const localtunnel = require('localtunnel');

const PORT = Number(process.env.PORT || 3000);
const indexPath = path.join(__dirname, 'index.js');

function waitForServerReady(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(`http://127.0.0.1:${PORT}/`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error(`Server did not respond on port ${PORT} within ${timeoutMs}ms`));
        } else {
          setTimeout(tryOnce, 400);
        }
      });
    };
    tryOnce();
  });
}

function printManyChatSteps(webhookUrl) {
  console.log('\n--- ManyChat (you do this in the browser) ---');
  console.log('1. Automation → New Message / Instagram trigger → add "External Request".');
  console.log('2. Method: POST   URL: ' + webhookUrl);
  console.log('3. Body: JSON — include subscriber id + last user text (use ManyChat Dynamic Content / merge fields; names differ by account), e.g.:');
  console.log('   { "subscriber_id": "<Subscriber ID>", "last_input_text": "<Last Text Input>" }');
  console.log('   (or send the full subscriber object — index.js reads nested shapes.)');
  console.log('4. Save, publish, DM your page from another account to test.');
  console.log('---\n');
}

async function main() {
  const child = spawn(process.execPath, [indexPath], {
    stdio: 'inherit',
    cwd: __dirname,
    env: process.env
  });

  let tunnelRef = null;

  const shutdown = () => {
    if (tunnelRef) {
      try {
        tunnelRef.close();
      } catch (_) {
        /* ignore */
      }
      tunnelRef = null;
    }
    child.kill('SIGINT');
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  child.on('exit', (code) => process.exit(code == null ? 1 : code));

  await waitForServerReady();

  let tunnel;
  try {
    tunnel = await localtunnel({ port: PORT });
    tunnelRef = tunnel;
  } catch (e) {
    console.error('Tunnel failed:', e.message);
    child.kill('SIGINT');
    process.exit(1);
  }

  const base = tunnel.url.replace(/\/$/, '');
  const webhookUrl = `${base}/webhook`;

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Public webhook URL (paste into ManyChat):');
  console.log(webhookUrl);
  console.log('Health check:', base + '/');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  printManyChatSteps(webhookUrl);

  tunnel.on('close', () => {
    console.log('Tunnel closed.');
    child.kill('SIGINT');
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
