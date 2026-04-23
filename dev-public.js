/**
 * Starts index.js, waits until / responds, then opens a public HTTPS tunnel
 * so you can paste https://....../webhook/uchat into UChat → External Request.
 *
 * Default: Serveo (URLs like *.serveousercontent.com — same style as many setups).
 * Override: TUNNEL=pinggy  →  ssh reverse tunnel to pinggy.io
 */
require('dotenv').config();
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 3000);
const indexPath = path.join(__dirname, 'index.js');
const TUNNEL_MODE = (process.env.TUNNEL || 'serveo').toLowerCase();

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

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

function printUchatSteps(webhookUrl) {
  console.log('\n--- UChat Setup ---');
  console.log('1. Odaberi "External Request" (HTTP Request) blok');
  console.log('2. Request URL: ' + webhookUrl);
  console.log('3. Method: POST');
  console.log('4. Headers: Content-Type: application/json');
  console.log('5. Body: odaberi Raw / JSON i upiši:');
  console.log('   {');
  console.log('     "user_ns": "{{user_ns}}",');
  console.log('     "text": "{{last_input_text}}",');
  console.log('     "name": "{{first_name}}",');
  console.log('     "username": "{{instagram_username}}"');
  console.log('   }');
  console.log('   (Važno: ubaci varijable klikom na izbornik)');
  console.log('---\n');
}

function parseTunnelBase(text) {
  const clean = stripAnsi(text);
  if (TUNNEL_MODE === 'pinggy') {
    const m = clean.match(/https:\/\/[a-zA-Z0-9.-]+\.pinggy-free\.link/);
    return m ? m[0].replace(/\/$/, '') : null;
  }
  if (TUNNEL_MODE === 'cloudflare') {
    const m = clean.match(/https:\/\/[a-zA-Z0-9.-]+\.trycloudflare\.com/);
    return m ? m[0].replace(/\/$/, '') : null;
  }
  // serveo: https://xxxxx-xx-xx-xx-xx.serveousercontent.com
  const m = clean.match(/https:\/\/[a-zA-Z0-9.-]+\.serveousercontent\.com/);
  return m ? m[0].replace(/\/$/, '') : null;
}

async function main() {
  let tunnelProc;

  const child = spawn(process.execPath, [indexPath], {
    stdio: 'inherit',
    cwd: __dirname,
    env: process.env
  });

  const shutdown = () => {
    if (tunnelProc && !tunnelProc.killed) {
      try {
        tunnelProc.kill('SIGINT');
      } catch {
        /* ignore */
      }
    }
    child.kill('SIGINT');
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  child.on('exit', (code) => process.exit(code == null ? 1 : code));

  await waitForServerReady();

  const printed = { done: false };

  const onTunnelChunk = (data) => {
    if (printed.done) return;
    const base = parseTunnelBase(data.toString());
    if (!base) return;
    printed.done = true;
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Public webhook URL (UChat External Request):');
    console.log(`${base}/webhook/uchat`);
    console.log('Health check:', `${base}/`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    printUchatSteps(`${base}/webhook/uchat`);
  };

  if (TUNNEL_MODE === 'pinggy') {
    console.log('Starting Pinggy tunnel (TUNNEL=pinggy)...');
    tunnelProc = spawn(
      'ssh',
      ['-o', 'StrictHostKeyChecking=no', '-p', '443', `-R0:localhost:${PORT}`, 'a.pinggy.io'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } else if (TUNNEL_MODE === 'cloudflare') {
    console.log('Starting Cloudflare tunnel (TUNNEL=cloudflare)...');
    tunnelProc = spawn(
      'npx',
      ['--yes', 'cloudflared', 'tunnel', '--url', `http://localhost:${PORT}`],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
  } else {
    console.log('Starting Serveo tunnel (default; URLs like *.serveousercontent.com)...');
    console.log('Tip: set TUNNEL=cloudflare or TUNNEL=pinggy if you prefer alternative tunnels.\n');
    tunnelProc = spawn(
      'ssh',
      ['-o', 'StrictHostKeyChecking=no', '-R', `80:localhost:${PORT}`, 'serveo.net'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
  }

  tunnelProc.stdout.on('data', onTunnelChunk);
  tunnelProc.stderr.on('data', onTunnelChunk);

  tunnelProc.on('exit', () => {
    console.log('Tunnel closed.');
    child.kill('SIGINT');
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
