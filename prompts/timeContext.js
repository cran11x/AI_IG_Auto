/**
 * Appends current local time so Grok does not mention breakfast at night, etc.
 *
 * Per-bot timezone:
 *   getTimeContextSuffix(tz)            // tz iz bot configa (BOTS[botId].timezone)
 *   withTimeAwareMessages(messages, tz)
 *
 * Bez argumenta čuva se stara default-na vrijednost iz ESMA_TIMEZONE / Europe/London
 * kako stari pozivi (npr. iz prompt-tester.js) nastavljaju raditi.
 */

const DEFAULT_TZ = process.env.ESMA_TIMEZONE || 'Europe/London';

function getTimeContextSuffix(tz) {
  const zone = tz || DEFAULT_TZ;
  let formatted;
  try {
    formatted = new Date().toLocaleString('en-GB', {
      timeZone: zone,
      weekday: 'long',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  } catch {
    return '';
  }
  return [
    `TIME_CONTEXT: Your local time is ${formatted} (${zone}).`,
    'Use this for natural small talk: morning vs afternoon vs evening vs night.',
    'Do not mention breakfast, "just woke up", morning commute, or early-day routines when it is clearly evening or night.',
    'Do not say "good morning" late at night; do not push late-night / bed vibes in the morning unless he clearly leads there.',
    'If his message already names a time (e.g. shower before work), follow his story — still stay consistent with TIME_CONTEXT for your own side comments.'
  ].join(' ');
}

/**
 * Shallow clone messages and append time context to the first system message (or prepend one).
 * Does not mutate the original array or message objects' content in place for [0] when cloning.
 */
function withTimeAwareMessages(messages, tz) {
  const suffix = getTimeContextSuffix(tz);
  if (!suffix || !Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  const out = messages.map((m) => ({ ...m }));
  if (out[0].role === 'system') {
    out[0] = { ...out[0], content: `${out[0].content}\n\n${suffix}` };
  } else {
    out.unshift({ role: 'system', content: suffix });
  }
  return out;
}

module.exports = { getTimeContextSuffix, withTimeAwareMessages, DEFAULT_TZ };
