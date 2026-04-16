require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const GROK_API_KEY = process.env.GROK_API_KEY;
const MANYCHAT_TOKEN = process.env.MANYCHAT_TOKEN;

const GROK_URL = 'https://api.x.ai/v1/chat/completions';
// xAI model id (see https://docs.x.ai/docs/models — override with GROK_MODEL in .env)
const GROK_MODEL = process.env.GROK_MODEL || 'grok-4';
const MANYCHAT_URL = 'https://api.manychat.com/fb/sending/sendContent';

// Max message pairs kept per user (system prompt excluded)
const MAX_HISTORY = 20;

// ── In-memory conversation store (Map: subscriberId → messages[]) ───────────
const conversations = new Map();

// Grok persona — ležeran, prijateljski, srpski/engleski mix, emoji, humor
const SYSTEM_PROMPT = [
  'Ti si super opušten i duhovit AI asistent. 😎',
  'Pričaš mešavinom srpskog i engleskog — kako ti dođe.',
  'Koristiš emoji kad se uklopi, ali ne preteruješ.',
  'Odgovori su ti kratki, konkretni i prijateljski.',
  'Ako nešto ne znaš, kažeš to iskreno uz fazon.',
  'Nikad ne zvučiš kao robot — uvek kao drugar koji pomaže. 🤙'
].join(' ');

// ── Helpers ──────────────────────────────────────────────────────────────────

// Get or create conversation history for a subscriber
function getHistory(subscriberId) {
  if (!conversations.has(subscriberId)) {
    conversations.set(subscriberId, [
      { role: 'system', content: SYSTEM_PROMPT }
    ]);
  }
  return conversations.get(subscriberId);
}

// Trim history so it doesn't grow forever (keep system + last N messages)
function trimHistory(messages) {
  const nonSystem = messages.slice(1);
  if (nonSystem.length > MAX_HISTORY) {
    const trimmed = nonSystem.slice(nonSystem.length - MAX_HISTORY);
    messages.length = 0;
    messages.push({ role: 'system', content: SYSTEM_PROMPT }, ...trimmed);
  }
}

// Pull subscriber id + last user text from ManyChat / Instagram payload shapes
function extractWebhookFields(body) {
  const sub = body.subscriber || {};
  const subscriberId =
    body.subscriber_id ??
    sub.id ??
    sub.subscriber_id ??
    body.id ??
    body.user_id;

  const userText =
    body.last_input_text ??
    sub.last_input_text ??
    body.text ??
    sub.text ??
    (typeof body.message === 'string' ? body.message : body.message?.text) ??
    (typeof sub.message === 'string' ? sub.message : sub.message?.text) ??
    body.custom_fields?.last_input_text ??
    sub.custom_fields?.last_input_text;

  return {
    subscriberId: subscriberId != null ? String(subscriberId) : undefined,
    userText: userText != null ? String(userText).trim() : undefined
  };
}

// ── POST /webhook — ManyChat External Request handler ────────────────────────
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('📩 Incoming webhook:', JSON.stringify(body).slice(0, 500));

    const { subscriberId, userText } = extractWebhookFields(body);

    // ManyChat treats non-2xx as failure — return 200 + skip so flows don't break
    if (!subscriberId || !userText) {
      const reason = !subscriberId
        ? 'missing_subscriber_id'
        : 'missing_message_text';
      console.warn('⚠️  Skipping (no Grok / no send):', { reason, subscriberId, userText });
      return res.status(200).json({
        status: 'skipped',
        reply: '',
        reason
      });
    }

    console.log(`👤 [${subscriberId}] User says: "${userText}"`);

    // ── 1. Build conversation history ────────────────────────────────────
    const messages = getHistory(subscriberId);
    messages.push({ role: 'user', content: userText });

    // ── 2. Call Grok xAI API ─────────────────────────────────────────────
    const grokResponse = await axios.post(
      GROK_URL,
      {
        model: GROK_MODEL,
        messages,
        temperature: 0.8
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GROK_API_KEY}`
        }
      }
    );

    const reply = grokResponse.data.choices[0].message.content;
    console.log(`🤖 [${subscriberId}] Grok says: "${reply}"`);

    // Save assistant reply and trim if needed
    messages.push({ role: 'assistant', content: reply });
    trimHistory(messages);

    // ── 3. Send reply back to ManyChat ───────────────────────────────────
    const mcPayload = {
      subscriber_id: subscriberId,
      data: {
        version: 'v2',
        content: {
          messages: [{ type: 'text', text: reply }]
        }
      },
      message_tag: 'ACCOUNT_UPDATE'
    };

    const mcResponse = await axios.post(MANYCHAT_URL, mcPayload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${MANYCHAT_TOKEN}`
      }
    });

    console.log(`✅ [${subscriberId}] ManyChat send status:`, mcResponse.data);

    // Return the reply so ManyChat flow can also use it via {{response}}
    return res.json({ status: 'ok', reply });

  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('❌ Webhook error:', detail);
    return res.status(500).json({ error: 'Internal server error', detail });
  }
});

// ── GET / — health check ─────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.send('ManyChat + Grok webhook running 🚀');
});

// ── Global error handler ─────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('💥 Unhandled error:', err.message);
  res.status(500).json({ error: 'Something broke' });
});

// ── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🟢 Webhook server running on http://localhost:${PORT}`);
  console.log(`   POST /webhook  ← ManyChat External Request`);
  console.log(`   GET  /         ← Health check`);
  console.log(`   Tip: npm run dev:public  → HTTPS tunnel URL for ManyChat\n`);
});
