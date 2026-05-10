/**
 * Build tracked pitch URLs and rewrite Grok replies so clicks can be logged.
 */

function normalizeBaseUrl(publicBaseUrl) {
  const s = String(publicBaseUrl || '').trim().replace(/\/$/, '');
  return s || '';
}

/**
 * @param {string} publicBaseUrl
 * @param {string} botId
 * @param {string} subscriberId
 * @param {string} pitchId
 */
function buildPitchTrackingUrl(publicBaseUrl, botId, subscriberId, pitchId) {
  const base = normalizeBaseUrl(publicBaseUrl);
  if (!base) return '';
  return `${base}/r/${encodeURIComponent(botId)}/${encodeURIComponent(subscriberId)}/${encodeURIComponent(pitchId)}`;
}

function makePitchId() {
  return `pitch_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * @param {{ reply: string, bot: { id: string, exclusiveLink?: string|null }, subscriberId: string, publicBaseUrl: string }}
 * @returns {{ content: string, pitchMeta: object|null }}
 */
function applyPitchTrackingToReply({ reply, bot, subscriberId, publicBaseUrl }) {
  const original = String(reply ?? '');
  const base = normalizeBaseUrl(publicBaseUrl);
  const dest = bot?.exclusiveLink ? String(bot.exclusiveLink).trim() : '';

  const hasPlaceholder = /\{?CURRENT_EXCLUSIVE_LINK\}?/.test(original);
  const hasDestUrl = !!(dest && original.includes(dest));

  if (!hasPlaceholder && !hasDestUrl) {
    return { content: original, pitchMeta: null };
  }

  // Placeholder but no configured destination: strip token so we do not send broken text.
  if (hasPlaceholder && !dest) {
    const stripped = original
      .replace(/\{CURRENT_EXCLUSIVE_LINK\}/g, '')
      .replace(/CURRENT_EXCLUSIVE_LINK/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return { content: stripped || original, pitchMeta: null };
  }

  // Tracking requires public base + destination.
  const canTrack = !!(base && dest);
  if (!canTrack) {
    if (hasPlaceholder && dest) {
      const withDest = original
        .replace(/\{CURRENT_EXCLUSIVE_LINK\}/g, dest)
        .replace(/CURRENT_EXCLUSIVE_LINK/g, dest);
      return { content: withDest, pitchMeta: null };
    }
    return { content: original, pitchMeta: null };
  }

  const pitchId = makePitchId();
  const trackingUrl = buildPitchTrackingUrl(base, bot.id, subscriberId, pitchId);
  if (!trackingUrl) {
    const withDest = original
      .replace(/\{CURRENT_EXCLUSIVE_LINK\}/g, dest)
      .replace(/CURRENT_EXCLUSIVE_LINK/g, dest);
    return { content: withDest, pitchMeta: null };
  }

  let content = original;
  content = content.replace(/\{CURRENT_EXCLUSIVE_LINK\}/g, trackingUrl);
  content = content.replace(/CURRENT_EXCLUSIVE_LINK/g, trackingUrl);
  if (dest && content.includes(dest)) {
    content = content.split(dest).join(trackingUrl);
  }

  return {
    content,
    pitchMeta: {
      pitchId,
      pitchedAt: new Date().toISOString(),
      originalText: original,
      trackingUrl,
      destinationUrl: dest
    }
  };
}

module.exports = {
  normalizeBaseUrl,
  buildPitchTrackingUrl,
  makePitchId,
  applyPitchTrackingToReply
};
