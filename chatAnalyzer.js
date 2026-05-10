const crypto = require('crypto');

/**
 * @param {import('express').Application} app
 * @param {object} deps
 */
function createChatAnalyzer(deps) {
  const {
    app,
    getBot,
    listBotIds,
    redisClient,
    isRedisEnabled,
    REDIS_KEY_PREFIX,
    assertViewMessagesAuth,
    wantsHtmlResponse,
    adminPageShell,
    escHtml,
    renderSubscriberCell,
    tokenQuerySuffix,
    tokenQueryFirst,
    VIEW_MESSAGES_TOKEN,
    loadConversation,
    listConversationIds,
    loadSubscriberMeta,
    listPitchClickEvents,
    callGrokWithPrompt,
    createDraftFromAnalyzer,
    getEffectivePromptBody,
    PUBLIC_BASE_URL,
    GROK_API_KEY
  } = deps;

  const reportKey = (botId, subscriberId) =>
    `${REDIS_KEY_PREFIX}:analyzer:report:${botId}:${subscriberId}`;
  const reportsIndexKey = () => `${REDIS_KEY_PREFIX}:analyzer:reports`;
  const insightsKey = () => `${REDIS_KEY_PREFIX}:analyzer:insights:latest`;

  /** @type {Map<string, object>} */
  const reportMemStore = new Map();
  /** @type {Set<string>} */
  const reportsIndexMem = new Set();
  let insightsMem = null;

  function nowIso() {
    return new Date().toISOString();
  }

  function toCleanString(v) {
    return String(v == null ? '' : v).trim();
  }

  function parseJson(raw) {
    try {
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  async function readRedisJson(key) {
    if (!isRedisEnabled()) return null;
    const raw = await redisClient.get(key);
    return parseJson(raw);
  }

  async function writeRedisJson(key, obj) {
    if (!isRedisEnabled()) return;
    await redisClient.set(key, JSON.stringify(obj));
  }

  async function saveReportIndex(botId, subscriberId) {
    const id = `${botId}:${subscriberId}`;
    if (isRedisEnabled()) {
      await redisClient.sAdd(reportsIndexKey(), id);
      return;
    }
    reportsIndexMem.add(id);
  }

  async function loadReport(botId, subscriberId) {
    if (isRedisEnabled()) return readRedisJson(reportKey(botId, subscriberId));
    return reportMemStore.get(`${botId}:${subscriberId}`) || null;
  }

  async function saveReport(report) {
    const { botId, subscriberId } = report;
    const key = reportKey(botId, subscriberId);
    if (isRedisEnabled()) {
      await writeRedisJson(key, report);
      await saveReportIndex(botId, subscriberId);
      return;
    }
    reportMemStore.set(`${botId}:${subscriberId}`, report);
    reportsIndexMem.add(`${botId}:${subscriberId}`);
  }

  function nonSystemMessages(messages) {
    return (Array.isArray(messages) ? messages : []).filter((m) => m && m.role !== 'system');
  }

  function transcriptHash(messages) {
    const nonSys = nonSystemMessages(messages);
    const slim = nonSys.map((m) => ({
      role: m.role,
      c: String(m.content || '').slice(0, 8000),
      t: m.createdAt || ''
    }));
    const h = crypto.createHash('sha256');
    h.update(JSON.stringify(slim));
    return h.digest('hex').slice(0, 48);
  }

  function extractPitchIdFromContent(text, botId) {
    const s = String(text || '');
    const m = s.match(/\/r\/[^/]+\/[^/]+\/(pitch_[a-zA-Z0-9_]+)/);
    return m ? m[1] : null;
  }

  const HEAT_PATTERNS = [
    /goddess/i,
    /daddy\b/i,
    /beautiful\b/i,
    /pretty\b/i,
    /\bhot\b/i,
    /sexy\b/i,
    /gorgeous\b/i,
    /poetry|poem\b/i,
    /\bhorny\b/i,
    /\bpics?\b/i,
    /spicier\b/i,
    /more.+photo|send.+pic|nude\b/i,
    /peach\b/i,
    /\bwow\b|\bomg\b|\b😍🔥💦😈🥵/
  ];

  function userHeatScore(userTexts) {
    let score = 0;
    for (const txt of userTexts) {
      const t = String(txt || '');
      for (const p of HEAT_PATTERNS) {
        if (p.test(t)) score += 1;
      }
    }
    return score;
  }

  /** @returns {object} */
  function computeDeterministic(bot, messages) {
    const botObj = bot;
    const nonSys = nonSystemMessages(messages);
    let pitchIdx = -1;
    /** @type {object|null} */
    let pitchFromMeta = null;
    let detectedPitchContent = '';

    for (let i = 0; i < nonSys.length; i++) {
      const m = nonSys[i];
      if (m.role !== 'assistant') continue;
      const pid = m.pitch?.pitchId || extractPitchIdFromContent(m.content, botObj.id);
      const mentionsDest =
        !!(botObj.exclusiveLink && String(m.content || '').includes(String(botObj.exclusiveLink)));
      const hasPlaceholder =
        /\{?CURRENT_EXCLUSIVE_LINK\}?/.test(String(m.content || '')) && !mentionsDest && !pid;
      if (m.pitch?.pitchId || pid || mentionsDest || hasPlaceholder) {
        pitchIdx = i;
        pitchFromMeta = m.pitch || (pid ? { pitchId: pid } : null);
        detectedPitchContent = String(m.content || '');
        break;
      }
    }

    const messagesBeforePitch = pitchIdx <= 0 ? nonSys.length : pitchIdx;
    const userMsgsBeforePitch =
      pitchIdx < 0 ? nonSys.filter((x) => x.role === 'user').length : nonSys.slice(0, pitchIdx).filter((x) => x.role === 'user').length;
    const pitchTooEarly = pitchIdx >= 0 && messagesBeforePitch < 8;

    const lastUserBefore =
      pitchIdx < 0 ? [] : nonSys.slice(0, pitchIdx).filter((x) => x.role === 'user').slice(-4);
    const heat = userHeatScore(lastUserBefore.map((u) => u.content));

    let postPitchUser = null;
    if (pitchIdx >= 0) {
      for (let j = pitchIdx + 1; j < nonSys.length; j++) {
        if (nonSys[j].role === 'user') {
          postPitchUser = nonSys[j];
          break;
        }
      }
    }

    const pitchIdResolved = pitchFromMeta?.pitchId || (pitchIdx >= 0 ? extractPitchIdFromContent(detectedPitchContent, botObj.id) : null);

    return {
      totalTurns: nonSys.length,
      userTurns: nonSys.filter((x) => x.role === 'user').length,
      assistantTurns: nonSys.filter((x) => x.role === 'assistant').length,
      pitched: pitchIdx >= 0,
      pitchIdx,
      pitchId: pitchIdResolved || null,
      messagesBeforePitch: pitchIdx >= 0 ? pitchIdx : null,
      userMsgsBeforePitch: pitchIdx >= 0 ? userMsgsBeforePitch : null,
      pitchTooEarly,
      userHeatBeforePitch: heat,
      pitchPreview: detectedPitchContent ? detectedPitchContent.slice(0, 280) : null,
      postPitchSnippet: postPitchUser ? String(postPitchUser.content || '').slice(0, 200) : null,
      postPitchLength: postPitchUser ? String(postPitchUser.content || '').length : 0
    };
  }

  async function computeDeterministicWithSubscriber(bot, subscriberId, messages) {
    const base = computeDeterministic(bot, messages);
    const clicks = base.pitchId ? await listPitchClickEvents(bot.id, subscriberId) : [];
    const clickForPitch = base.pitchId
      ? clicks.find((c) => c && c.pitchId === base.pitchId)
      : null;
    const pitchMsg = nonSys.find((m) => m.role === 'assistant' && (m.pitch?.pitchId === base.pitchId || extractPitchIdFromContent(m.content, bot.id) === base.pitchId));
    const pitchAt = pitchMsg?.createdAt ? Date.parse(pitchMsg.createdAt) : null;
    const clickAt = clickForPitch?.ts ? Date.parse(clickForPitch.ts) : null;
    let clickedAfterMs = null;
    if (pitchAt && clickAt && Number.isFinite(pitchAt) && Number.isFinite(clickAt)) {
      clickedAfterMs = Math.max(0, clickAt - pitchAt);
    }
    return {
      ...base,
      clicked: !!clickForPitch,
      clickAt: clickForPitch?.ts || null,
      clickedAfterMs
    };
  }

  const JUDGE_SYSTEM = [
    'You are an objective coach reviewing an Instagram DM between a female creator persona (assistant) and a male user.',
    'Return ONLY valid JSON (no markdown) with keys: buildup (0-10), timing (0-10), pitch_line (0-10), reaction (0-10), summary (string, max 400 chars), top_fixes (array of 2-5 short strings, concrete prompt edits).',
    'Scoring: buildup = flirting/tension before any paid pitch; timing = was the pitch too early/late; pitch_line = natural vs salesy; reaction = user engagement after the pitch (or silence/negative).',
    'If there was no clear paid/exclusive pitch, set pitch_line and reaction to null and explain in summary.'
  ].join(' ');

  function safeParseJudgeJson(text) {
    const s = String(text || '').trim();
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  async function runJudge(bot, messages) {
    if (!GROK_API_KEY) return null;
    const lines = nonSystemMessages(messages)
      .map((m) => `${m.role}: ${String(m.content || '').slice(0, 2000)}`)
      .join('\n');
    const userMsg = { role: 'user', content: `Transcript:\n${lines}\n\nReturn JSON scores only.` };
    const raw = await callGrokWithPrompt(JUDGE_SYSTEM, [userMsg], bot.id);
    return safeParseJudgeJson(raw);
  }

  function blendScore(deterministic, judge) {
    let score = 0;
    const wClick = 40;
    const wReact = 15;
    const wBuild = 15;
    const wTime = 15;
    const wPitch = 15;
    if (deterministic.clicked) score += wClick;
    if (judge && typeof judge.reaction === 'number') score += (judge.reaction / 10) * wReact;
    if (judge && typeof judge.buildup === 'number') score += (judge.buildup / 10) * wBuild;
    if (judge && typeof judge.timing === 'number') score += (judge.timing / 10) * wTime;
    if (judge && typeof judge.pitch_line === 'number') score += (judge.pitch_line / 10) * wPitch;
    if (!deterministic.pitched) score = Math.min(score, 25);
    if (deterministic.pitchTooEarly) score -= 10;
    return Math.max(0, Math.min(100, Math.round(score)));
  }

  async function buildOrLoadReport(botId, subscriberId, { forceJudge = false } = {}) {
    const bot = getBot(botId);
    if (!bot) throw new Error(`Unknown bot "${botId}"`);
    const messages = await loadConversation(bot.id, subscriberId);
    if (!Array.isArray(messages)) throw new Error(`Unknown conversation "${bot.id}/${subscriberId}"`);

    const hash = transcriptHash(messages);
    const deterministic = await computeDeterministicWithSubscriber(bot, subscriberId, messages);
    deterministic.subscriberId = subscriberId;

    const prev = await loadReport(bot.id, subscriberId);
    let judge = prev?.judge || null;

    const judgeFresh =
      forceJudge ||
      !prev ||
      prev.transcriptHash !== hash ||
      !judge ||
      judge.__error;

    if (judgeFresh && GROK_API_KEY) {
      try {
        judge = await runJudge(bot, messages);
        if (!judge) judge = { summary: 'Judge returned empty', top_fixes: [] };
      } catch (err) {
        judge = {
          summary: String(err.message || err),
          top_fixes: [],
          __error: true
        };
      }
    }

    const score = blendScore(deterministic, judge);
    const report = {
      version: 1,
      botId: bot.id,
      subscriberId,
      transcriptHash: hash,
      computedAt: nowIso(),
      deterministic,
      judge,
      score,
      publicBaseUrlConfigured: !!String(PUBLIC_BASE_URL || '').trim()
    };

    await saveReport(report);
    return report;
  }

  function postAction(path) {
    return `${path}?format=html${tokenQuerySuffix()}`;
  }

  function redirectHtml(res, path) {
    const qs = path.includes('?') ? tokenQuerySuffix() : VIEW_MESSAGES_TOKEN ? tokenQueryFirst() : '';
    return res.redirect(`${path}${qs}`);
  }

  /** @returns {Promise<object[]>} */
  async function scanAllConversationRows(filterBotId) {
    const botsToList = filterBotId
      ? (getBot(filterBotId) ? [filterBotId.toLowerCase()] : [])
      : listBotIds();
    const rows = [];
    for (const bid of botsToList) {
      const bot = getBot(bid);
      if (!bot) continue;
      const ids = await listConversationIds(bid);
      for (const subscriberId of ids) {
        const [msgs, meta, report] = await Promise.all([
          loadConversation(bid, subscriberId),
          loadSubscriberMeta(bid, subscriberId),
          loadReport(bid, subscriberId)
        ]);
        if (!Array.isArray(msgs)) continue;
        const nonSys = nonSystemMessages(msgs);
        const last = nonSys[nonSys.length - 1];
        let effective = report;
        if (!effective) {
          try {
            const det = await computeDeterministicWithSubscriber(bot, subscriberId, msgs);
            effective = {
              score: blendScore(det, null),
              deterministic: det
            };
          } catch {
            effective = { score: 0, deterministic: { pitched: false } };
          }
        }
        rows.push({
          bot: bid,
          subscriber_id: subscriberId,
          meta,
          message_count: nonSys.length,
          last_role: last?.role || '',
          last_preview: last?.content ? String(last.content).slice(0, 120) : '',
          score: effective.score ?? 0,
          pitched: !!effective.deterministic?.pitched,
          clicked: !!effective.deterministic?.clicked,
          heat: effective.deterministic?.userHeatBeforePitch ?? 0
        });
      }
    }
    return rows;
  }

  async function computeAggregateInsights() {
    const rows = await scanAllConversationRows(null);
    const pitched = rows.filter((r) => r.pitched);
    const clicked = rows.filter((r) => r.clicked);
    const ctr = pitched.length ? clicked.length / pitched.length : 0;

    const bandCounts = { lt8: 0, gte8: 0, unknown: 0 };
    const bandWins = { lt8: 0, gte8: 0, unknown: 0 };
    const hourCounts = {};
    const hourWins = {};

    const fixCounts = {};
    const pitchSnippets = {};

    for (const r of rows) {
      const rep = await loadReport(r.bot, r.subscriber_id);
      if (!rep?.deterministic?.pitched) continue;
      const mbp = rep.deterministic.messagesBeforePitch;
      const band = mbp == null ? 'unknown' : mbp < 8 ? 'lt8' : 'gte8';
      bandCounts[band] += 1;
      if (rep.deterministic.clicked) bandWins[band] += 1;

      const pv = rep.deterministic.pitchPreview || '';
      const key = pv.slice(0, 80) || '(empty)';
      if (!pitchSnippets[key]) pitchSnippets[key] = { n: 0, clicks: 0 };
      pitchSnippets[key].n += 1;
      if (rep.deterministic.clicked) pitchSnippets[key].clicks += 1;

      const fixes = Array.isArray(rep.judge?.top_fixes) ? rep.judge.top_fixes : [];
      for (const f of fixes) {
        const k = String(f || '').slice(0, 120);
        if (!k) continue;
        fixCounts[k] = (fixCounts[k] || 0) + 1;
      }

      const msgs = await loadConversation(r.bot, r.subscriber_id);
      if (Array.isArray(msgs)) {
        const nonSys = nonSystemMessages(msgs);
        const pitchMsg = nonSys.find(
          (m) =>
            m.role === 'assistant' &&
            (m.pitch?.pitchId || extractPitchIdFromContent(m.content, r.bot))
        );
        if (pitchMsg?.createdAt) {
          const bot = getBot(r.bot);
          const tz = bot?.timezone || 'UTC';
          let hour = 'unknown';
          try {
            hour = new Date(pitchMsg.createdAt).toLocaleString('en-GB', {
              timeZone: tz,
              hour: '2-digit',
              hour12: false
            });
          } catch {
            hour = 'unknown';
          }
          hourCounts[hour] = (hourCounts[hour] || 0) + 1;
          if (rep.deterministic.clicked) hourWins[hour] = (hourWins[hour] || 0) + 1;
        }
      }
    }

    const topFixes = Object.entries(fixCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([text, count]) => ({ text, count }));

    const pitchPerformance = Object.entries(pitchSnippets)
      .map(([snippet, v]) => ({
        snippet,
        n: v.n,
        clicks: v.clicks,
        rate: v.n ? v.clicks / v.n : 0
      }))
      .filter((x) => x.n >= 1)
      .sort((a, b) => b.rate - a.rate || b.n - a.n)
      .slice(0, 12);

    const bandInsight = {
      earlyPitchCount: bandCounts.lt8,
      latePitchCount: bandCounts.gte8,
      earlyClickRate: bandCounts.lt8 ? bandWins.lt8 / bandCounts.lt8 : 0,
      lateClickRate: bandCounts.gte8 ? bandWins.gte8 / bandCounts.gte8 : 0
    };

    const hours = Object.keys(hourCounts);
    const bestHour = hours
      .map((h) => ({
        hour: h,
        n: hourCounts[h],
        rate: hourCounts[h] ? (hourWins[h] || 0) / hourCounts[h] : 0
      }))
      .filter((x) => x.n >= 2)
      .sort((a, b) => b.rate - a.rate || b.n - a.n)[0] || null;

    const snapshot = {
      updatedAt: nowIso(),
      conversationCount: rows.length,
      pitchedCount: pitched.length,
      clickedCount: clicked.length,
      ctr,
      topFixes,
      pitchPerformance,
      bandInsight,
      bestHour
    };

    if (isRedisEnabled()) {
      await redisClient.set(insightsKey(), JSON.stringify(snapshot));
    } else {
      insightsMem = snapshot;
    }
    return snapshot;
  }

  async function loadInsightsSnapshot() {
    if (isRedisEnabled()) return parseJson(await redisClient.get(insightsKey()));
    return insightsMem;
  }

  app.get('/analyzer', async (req, res) => {
    if (!assertViewMessagesAuth(req, res)) return;
    try {
      const rows = await scanAllConversationRows(null);
      const pitched = rows.filter((r) => r.pitched);
      const clicked = rows.filter((r) => r.clicked);
      const ctr = pitched.length ? clicked.length / pitched.length : 0;

      if (!wantsHtmlResponse(req)) {
        return res.json({
          conversation_count: rows.length,
          pitched_count: pitched.length,
          clicked_count: clicked.length,
          ctr,
          public_base_url_configured: !!String(PUBLIC_BASE_URL || '').trim()
        });
      }

      const tokenQ = tokenQuerySuffix();
      const body = `
        <p class="muted">LLM-judged scores + real link clicks (when <code>PUBLIC_BASE_URL</code> and <code>*_EXCLUSIVE_LINK</code> are set). Open a thread for full verdict and regrade.</p>
        <div class="card stack">
          <p><strong>Conversations:</strong> ${escHtml(String(rows.length))}</p>
          <p><strong>Pitched:</strong> ${escHtml(String(pitched.length))} · <strong>Clicks:</strong> ${escHtml(String(clicked.length))} · <strong>CTR:</strong> ${escHtml((ctr * 100).toFixed(1))}%</p>
          <p><strong>Tracking URL base:</strong> ${PUBLIC_BASE_URL ? `<span class="ok">${escHtml(PUBLIC_BASE_URL)}</span>` : '<span class="bad">PUBLIC_BASE_URL not set</span>'}</p>
        </div>
        <div class="actions">
          <a class="button" href="/analyzer/conversations?format=html${tokenQ}">All conversations</a>
          <a class="button" href="/analyzer/insights?format=html${tokenQ}">Insights</a>
          <a class="button" href="/prompt-lab?format=html${tokenQ}">Prompt Lab</a>
        </div>
      `;
      res.type('html').send(adminPageShell('Chat & Pitch Analyzer', body));
    } catch (err) {
      console.error('❌ /analyzer error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/analyzer/conversations', async (req, res) => {
    if (!assertViewMessagesAuth(req, res)) return;
    try {
      const sort = String(req.query.sort || 'score');
      const filterBot = req.query.bot ? String(req.query.bot).toLowerCase() : null;
      let rows = await scanAllConversationRows(filterBot);
      if (sort === 'clicked') rows.sort((a, b) => Number(b.clicked) - Number(a.clicked) || b.score - a.score);
      else if (sort === 'pitch') rows.sort((a, b) => Number(b.pitched) - Number(a.pitched) || b.score - a.score);
      else rows.sort((a, b) => b.score - a.score);

      if (!wantsHtmlResponse(req)) {
        return res.json({ count: rows.length, sort, bot_filter: filterBot, conversations: rows });
      }

      const tokenQ = tokenQuerySuffix();
      const trs = rows
        .map((r) => {
          const href = `/analyzer/conversation/${encodeURIComponent(r.bot)}/${encodeURIComponent(r.subscriber_id)}?format=html${tokenQ}`;
          return `<tr>
            <td><span class="pill">${escHtml(r.bot)}</span></td>
            <td>${renderSubscriberCell(r.meta, r.subscriber_id)}</td>
            <td>${escHtml(String(r.message_count))}</td>
            <td>${escHtml(String(r.score))}</td>
            <td>${r.pitched ? '<span class="ok">yes</span>' : '<span class="muted">no</span>'}</td>
            <td>${r.clicked ? '<span class="ok">yes</span>' : '<span class="muted">no</span>'}</td>
            <td>${escHtml(String(r.heat))}</td>
            <td><a href="${href}">analyze</a> · <a href="/messages/${encodeURIComponent(r.bot)}/${encodeURIComponent(r.subscriber_id)}?format=html${tokenQ}">thread</a></td>
          </tr>`;
        })
        .join('');

      const sortLinks = (label, key) =>
        `<a href="/analyzer/conversations?format=html&sort=${encodeURIComponent(key)}${filterBot ? `&bot=${encodeURIComponent(filterBot)}` : ''}${tokenQ}">${escHtml(label)}</a>`;

      const body = `
        <div class="actions">
          <a class="button" href="/analyzer?format=html${tokenQ}">Analyzer home</a>
          <a class="button" href="/analyzer/insights?format=html${tokenQ}">Insights</a>
        </div>
        <p class="muted">Sort: ${sortLinks('score', 'score')} · ${sortLinks('pitched', 'pitch')} · ${sortLinks('clicked', 'clicked')}</p>
        <table><thead><tr><th>Bot</th><th>User</th><th>Msgs</th><th>Score</th><th>Pitch</th><th>Click</th><th>Heat</th><th></th></tr></thead>
        <tbody>${trs || '<tr><td colspan="8" class="muted">No conversations.</td></tr>'}</tbody></table>
      `;
      res.type('html').send(adminPageShell('Analyzer — Conversations', body));
    } catch (err) {
      console.error('❌ /analyzer/conversations error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/analyzer/conversation/:botId/:subscriberId', async (req, res) => {
    if (!assertViewMessagesAuth(req, res)) return;
    try {
      const botId = String(req.params.botId || '').toLowerCase();
      const subscriberId = String(req.params.subscriberId || '').trim();
      const force = String(req.query.force || '') === '1';
      const report = await buildOrLoadReport(botId, subscriberId, { forceJudge: force });

      if (!wantsHtmlResponse(req)) {
        return res.json({ report });
      }

      const tokenQ = tokenQuerySuffix();
      const bot = getBot(report.botId);
      const meta = await loadSubscriberMeta(report.botId, subscriberId);
      const messages = await loadConversation(report.botId, subscriberId);
      const nonSys = nonSystemMessages(messages || []);
      const bubbles = nonSys
        .slice(-24)
        .map((m) => {
          const pitchBadge =
            m.pitch?.pitchId || extractPitchIdFromContent(m.content, report.botId)
              ? ' <span class="pill">pitch</span>'
              : '';
          return `<div class="bubble ${escHtml(m.role)}"><strong>${escHtml(m.role)}</strong>${pitchBadge}<pre>${escHtml(String(m.content || ''))}</pre></div>`;
        })
        .join('');

      const d = report.deterministic || {};
      const j = report.judge || {};
      const body = `
        <div class="actions">
          <a class="button" href="/analyzer/conversations?format=html${tokenQ}">Back</a>
          <a class="button" href="/prompt-lab/test?format=html&botId=${encodeURIComponent(report.botId)}&subscriberId=${encodeURIComponent(subscriberId)}${tokenQ}">Open in Prompt Lab</a>
          <form method="post" action="${postAction(`/analyzer/regrade/${encodeURIComponent(report.botId)}/${encodeURIComponent(subscriberId)}`)}" style="display:inline">
            <button class="button" type="submit">Regrade judge</button>
          </form>
          <form method="post" action="${postAction(`/analyzer/suggest-prompt/${encodeURIComponent(report.botId)}`)}" style="display:inline">
            <input type="hidden" name="subscriberId" value="${escHtml(subscriberId)}">
            <button class="button" type="submit">Suggest prompt patch (this chat)</button>
          </form>
        </div>
        <div class="card">
          ${renderSubscriberCell(meta, subscriberId)}
          <p><strong>Bot:</strong> ${escHtml(bot?.displayName || report.botId)} · <strong>Score:</strong> ${escHtml(String(report.score))}</p>
          <p><strong>Pitched:</strong> ${d.pitched ? 'yes' : 'no'} · <strong>Clicked:</strong> ${d.clicked ? 'yes' : 'no'} · <strong>Heat (pre-pitch):</strong> ${escHtml(String(d.userHeatBeforePitch ?? ''))}</p>
          <p><strong>Messages before pitch:</strong> ${escHtml(String(d.messagesBeforePitch ?? '—'))} · <strong>Too early (&lt;8):</strong> ${d.pitchTooEarly ? '<span class="bad">yes</span>' : 'no'}</p>
          <p><strong>Judge:</strong> buildup ${escHtml(String(j.buildup ?? '—'))}, timing ${escHtml(String(j.timing ?? '—'))}, pitch_line ${escHtml(String(j.pitch_line ?? '—'))}, reaction ${escHtml(String(j.reaction ?? '—'))}</p>
          <p>${escHtml(j.summary || '')}</p>
          <p><strong>Top fixes:</strong></p>
          <ul>${(Array.isArray(j.top_fixes) ? j.top_fixes : []).map((x) => `<li>${escHtml(String(x))}</li>`).join('') || '<li class="muted">—</li>'}</ul>
        </div>
        <div class="thread">${bubbles || '<p class="muted">No messages.</p>'}</div>
      `;
      res.type('html').send(adminPageShell('Analyzer — Conversation', body));
    } catch (err) {
      console.error('❌ /analyzer/conversation error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/analyzer/regrade/:botId/:subscriberId', async (req, res) => {
    if (!assertViewMessagesAuth(req, res)) return;
    try {
      const botId = String(req.params.botId || '').toLowerCase();
      const subscriberId = String(req.params.subscriberId || '').trim();
      await buildOrLoadReport(botId, subscriberId, { forceJudge: true });
      if (wantsHtmlResponse(req)) {
        return redirectHtml(res, `/analyzer/conversation/${encodeURIComponent(botId)}/${encodeURIComponent(subscriberId)}?format=html`);
      }
      res.json({ status: 'ok' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/analyzer/insights', async (req, res) => {
    if (!assertViewMessagesAuth(req, res)) return;
    try {
      const refresh = String(req.query.refresh || '') === '1';
      let snap = refresh ? null : await loadInsightsSnapshot();
      if (!snap || refresh) snap = await computeAggregateInsights();

      if (!wantsHtmlResponse(req)) {
        return res.json(snap);
      }

      const tokenQ = tokenQuerySuffix();
      const fixes = (snap.topFixes || [])
        .map((f) => `<tr><td>${escHtml(f.text)}</td><td>${escHtml(String(f.count))}</td></tr>`)
        .join('');
      const pitches = (snap.pitchPerformance || [])
        .map(
          (p) =>
            `<tr><td><pre>${escHtml(p.snippet)}</pre></td><td>${escHtml(String(p.n))}</td><td>${escHtml(String(p.clicks))}</td><td>${escHtml((p.rate * 100).toFixed(0))}%</td></tr>`
        )
        .join('');
      const bi = snap.bandInsight || {};
      const bh = snap.bestHour;

      const body = `
        <div class="actions">
          <a class="button" href="/analyzer?format=html${tokenQ}">Analyzer home</a>
          <a class="button" href="/analyzer/insights?format=html&refresh=1${tokenQ}">Refresh insights</a>
        </div>
        <div class="card">
          <p><strong>Conversations:</strong> ${escHtml(String(snap.conversationCount))} · <strong>Pitched:</strong> ${escHtml(String(snap.pitchedCount))} · <strong>Clicks:</strong> ${escHtml(String(snap.clickedCount))} · <strong>CTR:</strong> ${escHtml((snap.ctr * 100).toFixed(1))}%</p>
          <p><strong>Early pitch (&lt;8 msgs):</strong> ${escHtml(String(bi.earlyPitchCount || 0))}, click rate ${escHtml(((bi.earlyClickRate || 0) * 100).toFixed(0))}%</p>
          <p><strong>Later pitch (≥8 msgs):</strong> ${escHtml(String(bi.latePitchCount || 0))}, click rate ${escHtml(((bi.lateClickRate || 0) * 100).toFixed(0))}%</p>
          <p><strong>Best hour (≥2 pitches):</strong> ${bh ? escHtml(`${bh.hour} local · n=${bh.n} · CTR ${(bh.rate * 100).toFixed(0)}%`) : '<span class="muted">not enough data</span>'}</p>
        </div>
        <h2>Top recurring fixes (from cached judge reports)</h2>
        <table><thead><tr><th>Fix</th><th>Count</th></tr></thead><tbody>${fixes || '<tr><td colspan="2" class="muted">Run per-conversation analysis first.</td></tr>'}</tbody></table>
        <h2>Pitch snippets by click rate</h2>
        <table><thead><tr><th>Snippet</th><th>n</th><th>Clicks</th><th>CTR</th></tr></thead><tbody>${pitches || '<tr><td colspan="4" class="muted">—</td></tr>'}</tbody></table>
      `;
      res.type('html').send(adminPageShell('Analyzer — Insights', body));
    } catch (err) {
      console.error('❌ /analyzer/insights error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/analyzer/suggest-prompt/:botId', async (req, res) => {
    if (!assertViewMessagesAuth(req, res)) return;
    try {
      if (!GROK_API_KEY) return res.status(500).json({ error: 'GROK_API_KEY not configured' });

      const botId = String(req.params.botId || '').toLowerCase();
      const bot = getBot(botId);
      if (!bot) return res.status(404).json({ error: 'Unknown bot', botId });

      const subscriberId = toCleanString(req.body.subscriberId);
      await computeAggregateInsights();
      const insights = await loadInsightsSnapshot();

      const currentPrompt = await getEffectivePromptBody(bot);

      /** @type {object[]} */
      const winSnippets = (insights?.pitchPerformance || []).filter((x) => x.clicks > 0).slice(0, 5);
      /** @type {object[]} */
      const loseSnippets = (insights?.pitchPerformance || [])
        .filter((x) => x.n >= 1 && x.clicks === 0)
        .sort((a, b) => b.n - a.n)
        .slice(0, 5);
      const topFixLines = (insights?.topFixes || []).slice(0, 8).map((x) => x.text);

      let thisTranscript = '';
      if (subscriberId) {
        const msgs = await loadConversation(bot.id, subscriberId);
        if (Array.isArray(msgs)) {
          thisTranscript = nonSystemMessages(msgs)
            .map((m) => `${m.role}: ${String(m.content || '').slice(0, 1500)}`)
            .join('\n');
        }
      }

      const judgeSystem = [
        'You improve a system prompt for an Instagram DM persona bot.',
        'Return ONLY valid JSON with keys: body (full new system prompt text), changelog (short bullet list of what you changed).',
        'Keep the same persona intent; make minimal edits that address: top_fixes list, weak pitch patterns, timing of exclusive link, and natural tone.',
        'Preserve any instruction that says to use CURRENT_EXCLUSIVE_LINK literally if present.',
        'Do not mention internal analytics; write instructions the model will follow.',
        `Current prompt:\n${currentPrompt}`
      ].join('\n');

      const userPayload = [
        `Winning pitch patterns (snippet, n, clicks): ${JSON.stringify(winSnippets)}`,
        `Losing pitch patterns (snippet, n, no clicks): ${JSON.stringify(loseSnippets)}`,
        `Aggregated fixes to address: ${JSON.stringify(topFixLines)}`,
        thisTranscript ? `Focus thread transcript:\n${thisTranscript}` : 'No single thread supplied.'
      ].join('\n\n');

      const raw = await callGrokWithPrompt(judgeSystem, [{ role: 'user', content: userPayload }], bot.id);
      const parsed = safeParseJudgeJson(raw);
      const newBody = parsed?.body ? String(parsed.body) : '';

      if (!newBody.trim()) {
        return res.status(500).json({ error: 'Model did not return a valid body field', raw: String(raw).slice(0, 500) });
      }

      const draft = await createDraftFromAnalyzer({
        name: `${bot.displayName} — analyzer suggestion`,
        botId: bot.id,
        body: newBody
      });

      if (wantsHtmlResponse(req)) {
        return redirectHtml(res, `/prompt-lab/edit/${encodeURIComponent(draft.id)}?format=html`);
      }
      res.json({ status: 'ok', draft, changelog: parsed?.changelog || null });
    } catch (err) {
      console.error('❌ /analyzer/suggest-prompt error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return {};
}

module.exports = { createChatAnalyzer };
