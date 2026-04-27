function createPromptLab(deps) {
  const {
    app,
    axios,
    BOTS,
    variants,
    getBot,
    listBotIds,
    redisClient,
    isRedisEnabled,
    REDIS_KEY_PREFIX,
    GROK_URL,
    GROK_MODEL,
    GROK_API_KEY,
    assertViewMessagesAuth,
    wantsHtmlResponse,
    adminPageShell,
    escHtml,
    renderSubscriberCell,
    tokenQuerySuffix,
    tokenQueryFirst,
    loadConversation,
    listConversationIds,
    loadSubscriberMeta,
    withTimeAwareMessages
  } = deps;

  const fixtureMemStore = new Map();
  const draftMemStore = new Map();
  const activePromptMemStore = new Map();
  const abRunMemStore = new Map();

  const fixtureKey = (id) => `${REDIS_KEY_PREFIX}:promptlab:fixture:${id}`;
  const fixturesIndexKey = () => `${REDIS_KEY_PREFIX}:promptlab:fixtures`;
  const draftKey = (id) => `${REDIS_KEY_PREFIX}:promptlab:draft:${id}`;
  const draftsIndexKey = () => `${REDIS_KEY_PREFIX}:promptlab:drafts`;
  const activePromptKey = (botId) => `${REDIS_KEY_PREFIX}:promptlab:active:${botId}`;
  const abRunKey = (id) => `${REDIS_KEY_PREFIX}:promptlab:abrun:${id}`;
  const abRunsIndexKey = () => `${REDIS_KEY_PREFIX}:promptlab:abruns`;

  function nowIso() {
    return new Date().toISOString();
  }

  function makeId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function toCleanString(value) {
    return String(value == null ? '' : value).trim();
  }

  function parseJson(raw) {
    try {
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function htmlPageTitle(suffix) {
    return suffix ? `Prompt Lab - ${suffix}` : 'Prompt Lab';
  }

  function postAction(path) {
    return `${path}?format=html${tokenQuerySuffix()}`;
  }

  function redirectHtml(res, path) {
    return res.redirect(`${path}${path.includes('?') ? tokenQuerySuffix() : tokenQueryFirst()}`);
  }

  function promptSourceValue(source) {
    return `${source.type}:${source.id}`;
  }

  function formatPromptLabel(source) {
    if (source.type === 'bot') return `Production bot: ${source.name}`;
    if (source.type === 'variant') return `JS variant: ${source.name}`;
    if (source.type === 'draft') return `Draft: ${source.name}`;
    return source.name || source.id;
  }

  function promptSources(drafts) {
    const botSources = Object.values(BOTS).map((bot) => ({
      type: 'bot',
      id: bot.id,
      botId: bot.id,
      name: `${bot.displayName} current production`,
      body: bot.prompt
    }));
    const variantSources = Object.entries(variants || {}).map(([id, body]) => ({
      type: 'variant',
      id,
      botId: 'esma',
      name: id,
      body
    }));
    const draftSources = (drafts || []).map((draft) => ({
      type: 'draft',
      id: draft.id,
      botId: draft.botId || '',
      name: draft.name || draft.id,
      body: draft.body || ''
    }));
    return [...botSources, ...variantSources, ...draftSources];
  }

  async function readObject(key) {
    if (!isRedisEnabled()) return null;
    return parseJson(await redisClient.get(key));
  }

  async function saveFixture(fixture) {
    if (isRedisEnabled()) {
      await redisClient
        .multi()
        .set(fixtureKey(fixture.id), JSON.stringify(fixture))
        .sAdd(fixturesIndexKey(), fixture.id)
        .exec();
      return;
    }
    fixtureMemStore.set(fixture.id, fixture);
  }

  async function loadFixture(id) {
    if (isRedisEnabled()) return readObject(fixtureKey(id));
    return fixtureMemStore.get(id) || null;
  }

  async function listFixtures() {
    if (isRedisEnabled()) {
      const ids = await redisClient.sMembers(fixturesIndexKey());
      const rows = await Promise.all(ids.map(loadFixture));
      return rows.filter(Boolean).sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));
    }
    return [...fixtureMemStore.values()].sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));
  }

  async function saveDraft(draft) {
    if (isRedisEnabled()) {
      await redisClient
        .multi()
        .set(draftKey(draft.id), JSON.stringify(draft))
        .sAdd(draftsIndexKey(), draft.id)
        .exec();
      return;
    }
    draftMemStore.set(draft.id, draft);
  }

  async function loadDraft(id) {
    if (isRedisEnabled()) return readObject(draftKey(id));
    return draftMemStore.get(id) || null;
  }

  async function listDrafts() {
    if (isRedisEnabled()) {
      const ids = await redisClient.sMembers(draftsIndexKey());
      const rows = await Promise.all(ids.map(loadDraft));
      return rows.filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    }
    return [...draftMemStore.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  async function deleteDraft(id) {
    if (isRedisEnabled()) {
      await redisClient.multi().del(draftKey(id)).sRem(draftsIndexKey(), id).exec();
      return;
    }
    draftMemStore.delete(id);
  }

  async function saveAbRun(run) {
    if (isRedisEnabled()) {
      await redisClient
        .multi()
        .set(abRunKey(run.id), JSON.stringify(run))
        .sAdd(abRunsIndexKey(), run.id)
        .exec();
      return;
    }
    abRunMemStore.set(run.id, run);
  }

  async function getActivePrompt(botId) {
    const id = String(botId || '').toLowerCase();
    if (!id) return null;
    if (isRedisEnabled()) return readObject(activePromptKey(id));
    return activePromptMemStore.get(id) || null;
  }

  async function setActivePrompt(botId, draft) {
    const active = {
      botId,
      draftId: draft.id,
      name: draft.name,
      body: draft.body,
      promotedAt: nowIso()
    };
    if (isRedisEnabled()) {
      await redisClient.set(activePromptKey(botId), JSON.stringify(active));
      return active;
    }
    activePromptMemStore.set(botId, active);
    return active;
  }

  async function clearActivePrompt(botId) {
    if (isRedisEnabled()) {
      await redisClient.del(activePromptKey(botId));
      return;
    }
    activePromptMemStore.delete(botId);
  }

  async function getEffectivePrompt(botId) {
    const bot = getBot(botId);
    if (!bot) return null;
    const active = await getActivePrompt(bot.id);
    return active?.body || bot.prompt;
  }

  async function resolvePromptSource(value) {
    const [type, ...rest] = String(value || '').split(':');
    const id = rest.join(':');
    if (type === 'bot') {
      const bot = getBot(id);
      if (bot) return { type, id: bot.id, name: `${bot.displayName} current production`, body: bot.prompt, botId: bot.id };
    }
    if (type === 'variant' && variants?.[id]) {
      return { type, id, name: id, body: variants[id], botId: 'esma' };
    }
    if (type === 'draft') {
      const draft = await loadDraft(id);
      if (draft) return { type, id: draft.id, name: draft.name || draft.id, body: draft.body || '', botId: draft.botId || '' };
    }
    return null;
  }

  function nonSystemMessages(messages) {
    return (Array.isArray(messages) ? messages : []).filter((m) => m && m.role !== 'system');
  }

  function lastUserContext(messages) {
    const nonSys = nonSystemMessages(messages);
    let lastUserIdx = -1;
    for (let i = nonSys.length - 1; i >= 0; i--) {
      if (nonSys[i].role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx < 0) return [];
    return nonSys.slice(0, lastUserIdx + 1);
  }

  async function callGrokWithPrompt(promptBody, contextMessages, botId) {
    if (!GROK_API_KEY) throw new Error('GROK_API_KEY not configured');
    const bot = getBot(botId) || getBot('esma');
    const messages = [{ role: 'system', content: promptBody }, ...contextMessages];
    const payloadMessages = withTimeAwareMessages(messages, bot?.timezone);
    const res = await axios.post(
      GROK_URL,
      { model: GROK_MODEL, messages: payloadMessages, temperature: 0.8 },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GROK_API_KEY}`
        },
        timeout: 60000
      }
    );
    return res.data.choices[0].message.content;
  }

  async function runLastOnly(source, messages, botId) {
    const context = lastUserContext(messages);
    if (!context.length) throw new Error('Selected conversation has no user message to test.');
    const reply = await callGrokWithPrompt(source.body, context, botId);
    return [{ turn: 1, user: context[context.length - 1].content, reply, contextCount: context.length }];
  }

  async function runReplay(source, messages, botId) {
    const sourceMessages = nonSystemMessages(messages);
    const generatedContext = [];
    const turns = [];
    for (const msg of sourceMessages) {
      if (msg.role !== 'user') continue;
      generatedContext.push({ role: 'user', content: msg.content });
      const reply = await callGrokWithPrompt(source.body, generatedContext, botId);
      turns.push({ turn: turns.length + 1, user: msg.content, reply, contextCount: generatedContext.length });
      generatedContext.push({ role: 'assistant', content: reply });
    }
    if (!turns.length) throw new Error('Selected conversation has no user turns to replay.');
    return turns;
  }

  async function loadConversationSource(req) {
    const fixtureId = toCleanString(req.body.fixtureId || req.query.fixtureId);
    if (fixtureId) {
      const fixture = await loadFixture(fixtureId);
      if (!fixture) throw new Error(`Unknown fixture "${fixtureId}"`);
      return {
        kind: 'fixture',
        id: fixture.id,
        label: fixture.name || fixture.id,
        botId: fixture.botId,
        subscriberId: fixture.subscriberId,
        messages: fixture.messages || [],
        meta: fixture.meta || {}
      };
    }

    const botId = toCleanString(req.body.botId || req.query.botId);
    const subscriberId = toCleanString(req.body.subscriberId || req.query.subscriberId);
    if (!botId || !subscriberId) throw new Error('Select a fixture or live conversation.');
    const bot = getBot(botId);
    if (!bot) throw new Error(`Unknown bot "${botId}"`);
    const messages = await loadConversation(bot.id, subscriberId);
    if (!messages) throw new Error(`Unknown conversation "${bot.id}/${subscriberId}"`);
    const meta = await loadSubscriberMeta(bot.id, subscriberId);
    return {
      kind: 'live',
      id: `${bot.id}:${subscriberId}`,
      label: `${bot.displayName} / ${subscriberId}`,
      botId: bot.id,
      subscriberId,
      messages,
      meta
    };
  }

  async function collectLiveConversationOptions() {
    const rows = [];
    for (const botId of listBotIds()) {
      const bot = getBot(botId);
      const ids = await listConversationIds(botId);
      const tuples = await Promise.all(ids.map(async (id) => [id, await loadConversation(botId, id), await loadSubscriberMeta(botId, id)]));
      for (const [id, messages, meta] of tuples) {
        if (!Array.isArray(messages)) continue;
        const nonSys = messages.filter((m) => m.role !== 'system');
        const last = nonSys[nonSys.length - 1];
        rows.push({
          botId,
          subscriberId: id,
          label: `${bot?.displayName || botId} / ${subscriberDisplay(meta, id)} (${nonSys.length} msgs)`,
          preview: last?.content ? String(last.content).slice(0, 90) : ''
        });
      }
    }
    return rows;
  }

  function subscriberDisplay(meta, fallbackId) {
    if (meta?.firstName) return meta.firstName;
    if (meta?.igUsername) return `@${meta.igUsername}`;
    return fallbackId;
  }

  function renderPromptSelect(name, sources, selected) {
    const options = sources
      .map((source) => {
        const value = promptSourceValue(source);
        const sel = value === selected ? ' selected' : '';
        return `<option value="${escHtml(value)}"${sel}>${escHtml(formatPromptLabel(source))}</option>`;
      })
      .join('');
    return `<select name="${escHtml(name)}" required>${options}</select>`;
  }

  function renderRunColumn(title, source, result) {
    const turns = result.turns || [];
    const rows = turns
      .map((turn) => `
        <div class="card">
          <div class="muted">Turn ${turn.turn} · context messages: ${turn.contextCount}</div>
          <p><strong>User</strong></p>
          <pre>${escHtml(turn.user || '')}</pre>
          <p><strong>${escHtml(title)}</strong></p>
          <pre>${escHtml(turn.reply || '')}</pre>
        </div>`)
      .join('');
    return `<div class="card" style="flex:1 1 320px">
      <h2>${escHtml(title)}</h2>
      <p class="muted">${escHtml(formatPromptLabel(source))}</p>
      ${rows || '<p class="muted">No generated turns.</p>'}
    </div>`;
  }

  async function renderPromptLabHome(req, res) {
    const [drafts, fixtures] = await Promise.all([listDrafts(), listFixtures()]);
    const activeByBot = {};
    for (const botId of listBotIds()) {
      activeByBot[botId] = await getActivePrompt(botId);
    }

    if (!wantsHtmlResponse(req)) {
      return res.json({
        drafts,
        fixtures,
        active: activeByBot,
        variants: Object.keys(variants || {})
      });
    }

    const tokenQ = tokenQuerySuffix();
    const variantRows = Object.entries(variants || {})
      .map(([name, body]) => `<tr>
        <td><code>${escHtml(name)}</code></td>
        <td>${escHtml(String(body).slice(0, 160))}</td>
        <td>
          <form method="post" action="${postAction('/prompt-lab/drafts/clone')}" style="display:inline">
            <input type="hidden" name="sourceType" value="variant">
            <input type="hidden" name="sourceId" value="${escHtml(name)}">
            <button class="button" type="submit">Clone to draft</button>
          </form>
        </td>
      </tr>`)
      .join('');

    const botRows = Object.values(BOTS)
      .map((bot) => {
        const active = activeByBot[bot.id];
        return `<tr>
          <td><code>${escHtml(bot.id)}</code></td>
          <td>${escHtml(bot.displayName)}</td>
          <td>${active ? `<span class="ok">active override: ${escHtml(active.name || active.draftId)}</span>` : '<span class="muted">JS production prompt</span>'}</td>
          <td>
            <form method="post" action="${postAction('/prompt-lab/drafts/clone')}" style="display:inline">
              <input type="hidden" name="sourceType" value="bot">
              <input type="hidden" name="sourceId" value="${escHtml(bot.id)}">
              <button class="button" type="submit">Clone current</button>
            </form>
            <form method="post" action="${postAction('/prompt-lab/rollback')}" style="display:inline">
              <input type="hidden" name="botId" value="${escHtml(bot.id)}">
              <button class="button" type="submit">Rollback</button>
            </form>
          </td>
        </tr>`;
      })
      .join('');

    const draftRows = drafts
      .map((draft) => `<tr>
        <td><code>${escHtml(draft.id)}</code></td>
        <td>${escHtml(draft.name || '')}</td>
        <td><span class="pill">${escHtml(draft.botId || 'any')}</span></td>
        <td>${escHtml(draft.baseVariant || '')}</td>
        <td>${escHtml(draft.updatedAt || '')}</td>
        <td>${escHtml(String(draft.body || '').slice(0, 140))}</td>
        <td><a href="/prompt-lab/edit/${encodeURIComponent(draft.id)}?format=html${tokenQ}">edit</a></td>
      </tr>`)
      .join('');

    const fixtureRows = fixtures
      .slice(0, 8)
      .map((fixture) => `<tr>
        <td>${escHtml(fixture.name || fixture.id)}</td>
        <td><span class="pill">${escHtml(fixture.botId)}</span></td>
        <td>${renderSubscriberCell(fixture.meta, fixture.subscriberId)}</td>
        <td>${(fixture.messages || []).filter((m) => m.role !== 'system').length}</td>
        <td>${escHtml(fixture.capturedAt || '')}</td>
      </tr>`)
      .join('');

    const body = `
      <p class="muted">Simple flow: save a real conversation, make a prompt draft, then compare two prompts before touching production.</p>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:.75rem;margin:1rem 0">
        <div class="card">
          <h2>1. Save a conversation</h2>
          <p>Open any thread and click <strong>Save as test fixture</strong>. That locks a real chat for testing.</p>
          <a class="button" href="/conversations?format=html${tokenQ}">Open conversations</a>
        </div>
        <div class="card">
          <h2>2. Make a prompt draft</h2>
          <p>Start from the current production prompt, then edit it safely without changing live replies.</p>
          <form method="post" action="${postAction('/prompt-lab/drafts/clone')}">
            <input type="hidden" name="sourceType" value="bot">
            <select name="sourceId">${Object.values(BOTS).map((bot) => `<option value="${escHtml(bot.id)}">${escHtml(bot.displayName)} current prompt</option>`).join('')}</select>
            <button class="button" type="submit">Create draft from current prompt</button>
          </form>
        </div>
        <div class="card">
          <h2>3. Compare A/B</h2>
          <p>Pick one saved conversation and compare two prompts side-by-side.</p>
          <a class="button" href="/prompt-lab/ab?format=html${tokenQ}">Compare prompts</a>
        </div>
      </div>

      <details class="card">
        <summary><strong>Advanced: create a blank prompt draft</strong></summary>
        <form method="post" action="${postAction('/prompt-lab/drafts')}">
          <p><label>Name<br><input name="name" required style="width:100%"></label></p>
          <p><label>Bot<br><select name="botId">${listBotIds().map((id) => `<option value="${escHtml(id)}">${escHtml(id)}</option>`).join('')}</select></label></p>
          <p><label>Prompt body<br><textarea name="body" rows="10" style="width:100%" required></textarea></label></p>
          <button class="button" type="submit">Create draft</button>
        </form>
      </details>

      <h2>Bots / active prompt</h2>
      <table><thead><tr><th>Bot</th><th>Name</th><th>Active</th><th>Actions</th></tr></thead><tbody>${botRows}</tbody></table>

      <h2>Drafts</h2>
      <table><thead><tr><th>ID</th><th>Name</th><th>Bot</th><th>Base</th><th>Updated</th><th>Preview</th><th></th></tr></thead><tbody>${draftRows || '<tr><td colspan="7" class="muted">No drafts yet.</td></tr>'}</tbody></table>

      <h2>Recent fixtures</h2>
      <table><thead><tr><th>Name</th><th>Bot</th><th>User</th><th>Msgs</th><th>Captured</th></tr></thead><tbody>${fixtureRows || '<tr><td colspan="5" class="muted">No fixtures saved yet.</td></tr>'}</tbody></table>

      <details class="card">
        <summary><strong>Advanced: clone old JS variants</strong></summary>
        <table><thead><tr><th>Variant</th><th>Preview</th><th></th></tr></thead><tbody>${variantRows || '<tr><td colspan="3" class="muted">No variants.</td></tr>'}</tbody></table>
      </details>
    `;
    return res.type('html').send(adminPageShell(htmlPageTitle(), body));
  }

  app.get('/prompt-lab', async (req, res) => {
    if (!assertViewMessagesAuth(req, res)) return;
    try {
      await renderPromptLabHome(req, res);
    } catch (err) {
      console.error('❌ /prompt-lab error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/prompt-lab/fixtures', async (req, res) => {
    if (!assertViewMessagesAuth(req, res)) return;
    const fixtures = await listFixtures();
    if (!wantsHtmlResponse(req)) return res.json({ count: fixtures.length, fixtures });

    const tokenQ = tokenQuerySuffix();
    const rows = fixtures
      .map((fixture) => `<tr>
        <td>${escHtml(fixture.name || fixture.id)}</td>
        <td><code>${escHtml(fixture.id)}</code></td>
        <td><span class="pill">${escHtml(fixture.botId)}</span></td>
        <td>${renderSubscriberCell(fixture.meta, fixture.subscriberId)}</td>
        <td>${(fixture.messages || []).filter((m) => m.role !== 'system').length}</td>
        <td>${escHtml(fixture.capturedAt || '')}</td>
      </tr>`)
      .join('');
    const body = `
      <div class="actions">
        <a class="button" href="/prompt-lab?format=html${tokenQ}">Prompt Lab</a>
        <a class="button" href="/prompt-lab/ab?format=html${tokenQ}">A/B test</a>
        <a class="button" href="/prompt-lab/fixtures?format=json${tokenQ}">JSON</a>
      </div>
      <p class="muted">Fixtures are frozen snapshots of real conversations for repeatable prompt testing.</p>
      <table><thead><tr><th>Name</th><th>ID</th><th>Bot</th><th>User</th><th>Msgs</th><th>Captured</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="muted">No fixtures yet. Open a thread and click Save as test fixture.</td></tr>'}</tbody></table>
    `;
    res.type('html').send(adminPageShell(htmlPageTitle('Fixtures'), body));
  });

  app.post('/prompt-lab/fixtures/from-conversation', async (req, res) => {
    if (!assertViewMessagesAuth(req, res)) return;
    try {
      const botId = toCleanString(req.body.botId);
      const subscriberId = toCleanString(req.body.subscriberId);
      const bot = getBot(botId);
      if (!bot) return res.status(404).json({ error: 'Unknown bot id', botId });
      const messages = await loadConversation(bot.id, subscriberId);
      if (!messages) return res.status(404).json({ error: 'Unknown conversation', botId: bot.id, subscriberId });
      const meta = await loadSubscriberMeta(bot.id, subscriberId);
      const fixture = {
        id: makeId('fix'),
        name: toCleanString(req.body.name) || `${bot.displayName} ${subscriberDisplay(meta, subscriberId)} ${new Date().toLocaleDateString('en-GB')}`,
        botId: bot.id,
        subscriberId,
        capturedAt: nowIso(),
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        meta
      };
      await saveFixture(fixture);
      if (wantsHtmlResponse(req)) return redirectHtml(res, '/prompt-lab/fixtures?format=html');
      res.status(201).json({ status: 'ok', fixture });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/prompt-lab/drafts', async (req, res) => {
    if (!assertViewMessagesAuth(req, res)) return;
    const body = toCleanString(req.body.body);
    if (!body) return res.status(400).json({ error: 'Prompt body is required' });
    const draft = {
      id: makeId('draft'),
      name: toCleanString(req.body.name) || 'Untitled draft',
      botId: toCleanString(req.body.botId) || 'esma',
      body,
      baseVariant: toCleanString(req.body.baseVariant),
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    await saveDraft(draft);
    if (wantsHtmlResponse(req)) return redirectHtml(res, `/prompt-lab/edit/${encodeURIComponent(draft.id)}?format=html`);
    res.status(201).json({ status: 'ok', draft });
  });

  app.post('/prompt-lab/drafts/clone', async (req, res) => {
    if (!assertViewMessagesAuth(req, res)) return;
    const source = await resolvePromptSource(`${toCleanString(req.body.sourceType)}:${toCleanString(req.body.sourceId)}`);
    if (!source) return res.status(404).json({ error: 'Unknown prompt source' });
    const draft = {
      id: makeId('draft'),
      name: `${source.name} draft`,
      botId: source.botId || 'esma',
      body: source.body,
      baseVariant: source.type === 'variant' ? source.id : source.type,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    await saveDraft(draft);
    if (wantsHtmlResponse(req)) return redirectHtml(res, `/prompt-lab/edit/${encodeURIComponent(draft.id)}?format=html`);
    res.status(201).json({ status: 'ok', draft });
  });

  app.get('/prompt-lab/edit/:draftId', async (req, res) => {
    if (!assertViewMessagesAuth(req, res)) return;
    const draft = await loadDraft(req.params.draftId);
    if (!draft) return res.status(404).json({ error: 'Unknown draft', draftId: req.params.draftId });
    if (!wantsHtmlResponse(req)) return res.json({ draft });

    const tokenQ = tokenQuerySuffix();
    const body = `
      <div class="actions">
        <a class="button" href="/prompt-lab?format=html${tokenQ}">Prompt Lab</a>
        <a class="button" href="/prompt-lab/ab?format=html&promptA=draft:${encodeURIComponent(draft.id)}${tokenQ}">A/B test this</a>
      </div>
      <form method="post" action="${postAction(`/prompt-lab/drafts/${encodeURIComponent(draft.id)}`)}" class="card">
        <p><label>Name<br><input name="name" value="${escHtml(draft.name || '')}" required style="width:100%"></label></p>
        <p><label>Bot<br><select name="botId">${listBotIds().map((id) => `<option value="${escHtml(id)}"${id === draft.botId ? ' selected' : ''}>${escHtml(id)}</option>`).join('')}</select></label></p>
        <p><label>Base<br><input name="baseVariant" value="${escHtml(draft.baseVariant || '')}" style="width:100%"></label></p>
        <p><label>Prompt body<br><textarea name="body" rows="22" style="width:100%" required>${escHtml(draft.body || '')}</textarea></label></p>
        <button class="button" type="submit">Save draft</button>
      </form>
      <div class="actions">
        <form method="post" action="${postAction('/prompt-lab/promote')}" onsubmit="return confirm('Promote this draft for live replies?')">
          <input type="hidden" name="draftId" value="${escHtml(draft.id)}">
          <input type="hidden" name="botId" value="${escHtml(draft.botId || 'esma')}">
          <button class="button" type="submit">Promote to production</button>
        </form>
        <form method="post" action="${postAction(`/prompt-lab/drafts/${encodeURIComponent(draft.id)}/delete`)}" onsubmit="return confirm('Delete this draft?')">
          <button class="button" type="submit">Delete draft</button>
        </form>
      </div>
    `;
    res.type('html').send(adminPageShell(htmlPageTitle(`Edit ${draft.name || draft.id}`), body));
  });

  async function updateDraftHandler(req, res) {
    if (!assertViewMessagesAuth(req, res)) return;
    const draft = await loadDraft(req.params.draftId);
    if (!draft) return res.status(404).json({ error: 'Unknown draft', draftId: req.params.draftId });
    const body = toCleanString(req.body.body);
    if (!body) return res.status(400).json({ error: 'Prompt body is required' });
    const next = {
      ...draft,
      name: toCleanString(req.body.name) || draft.name,
      botId: toCleanString(req.body.botId) || draft.botId,
      baseVariant: toCleanString(req.body.baseVariant),
      body,
      updatedAt: nowIso()
    };
    await saveDraft(next);
    if (wantsHtmlResponse(req)) return redirectHtml(res, `/prompt-lab/edit/${encodeURIComponent(next.id)}?format=html`);
    res.json({ status: 'ok', draft: next });
  }

  app.put('/prompt-lab/drafts/:draftId', updateDraftHandler);
  app.post('/prompt-lab/drafts/:draftId', updateDraftHandler);

  async function deleteDraftHandler(req, res) {
    if (!assertViewMessagesAuth(req, res)) return;
    await deleteDraft(req.params.draftId);
    if (wantsHtmlResponse(req)) return redirectHtml(res, '/prompt-lab?format=html');
    res.json({ status: 'ok' });
  }

  app.delete('/prompt-lab/drafts/:draftId', deleteDraftHandler);
  app.post('/prompt-lab/drafts/:draftId/delete', deleteDraftHandler);

  app.get('/prompt-lab/ab', async (req, res) => {
    if (!assertViewMessagesAuth(req, res)) return;
    const [fixtures, drafts, liveOptions] = await Promise.all([listFixtures(), listDrafts(), collectLiveConversationOptions()]);
    const sources = promptSources(drafts);
    if (!wantsHtmlResponse(req)) {
      return res.json({ fixtures, live_conversations: liveOptions, prompt_sources: sources.map(({ body, ...rest }) => rest) });
    }

    const tokenQ = tokenQuerySuffix();
    const fixtureOptions = fixtures
      .map((fixture) => `<option value="${escHtml(fixture.id)}">${escHtml(fixture.name || fixture.id)} (${escHtml(fixture.botId)})</option>`)
      .join('');
    const liveOptionsHtml = liveOptions
      .map((row) => `<option value="${escHtml(`${row.botId}:${row.subscriberId}`)}">${escHtml(row.label)} - ${escHtml(row.preview)}</option>`)
      .join('');
    const body = `
      <div class="actions">
        <a class="button" href="/prompt-lab?format=html${tokenQ}">Prompt Lab</a>
        <a class="button" href="/prompt-lab/fixtures?format=html${tokenQ}">Fixtures</a>
      </div>
      <p class="muted">Pick one real conversation, then pick two prompts. The app will show what each prompt would reply.</p>
      <form method="post" action="${postAction('/prompt-lab/ab-test')}" class="card">
        <h2>1. Choose saved test conversation</h2>
        <p><label>Saved conversation<br><select name="fixtureId" style="width:100%"><option value="">-- choose saved conversation --</option>${fixtureOptions}</select></label></p>
        <details>
          <summary>Or use a live conversation directly</summary>
          <p><label>Live conversation<br><select name="liveConversation" style="width:100%"><option value="">-- no live conversation --</option>${liveOptionsHtml}</select></label></p>
          <p class="muted">Saved conversations are better because they do not change while you test.</p>
        </details>
        <h2>2. Choose prompts</h2>
        <p><label>Prompt A (usually current production)<br>${renderPromptSelect('promptA', sources, req.query.promptA)}</label></p>
        <p><label>Prompt B (your new draft)<br>${renderPromptSelect('promptB', sources, req.query.promptB)}</label></p>
        <h2>3. Choose test type</h2>
        <p><label>Test type<br><select name="mode"><option value="last">Quick test: only next reply</option><option value="replay">Deep test: replay every user message</option></select></label></p>
        <button class="button" type="submit">Compare prompts</button>
      </form>
    `;
    res.type('html').send(adminPageShell(htmlPageTitle('A/B Test'), body));
  });

  app.post('/prompt-lab/ab-test', async (req, res) => {
    if (!assertViewMessagesAuth(req, res)) return;
    try {
      if (req.body.liveConversation && !req.body.fixtureId) {
        const [botId, ...subscriberParts] = String(req.body.liveConversation).split(':');
        req.body.botId = botId;
        req.body.subscriberId = subscriberParts.join(':');
      }
      const [sourceA, sourceB, conversation] = await Promise.all([
        resolvePromptSource(req.body.promptA),
        resolvePromptSource(req.body.promptB),
        loadConversationSource(req)
      ]);
      if (!sourceA || !sourceB) return res.status(400).json({ error: 'Select two valid prompts.' });
      const mode = req.body.mode === 'replay' ? 'replay' : 'last';
      const runner = mode === 'replay' ? runReplay : runLastOnly;
      const [resultA, resultB] = await Promise.all([
        runner(sourceA, conversation.messages, conversation.botId),
        runner(sourceB, conversation.messages, conversation.botId)
      ]);
      const run = {
        id: makeId('abrun'),
        createdAt: nowIso(),
        mode,
        conversation: {
          kind: conversation.kind,
          id: conversation.id,
          label: conversation.label,
          botId: conversation.botId,
          subscriberId: conversation.subscriberId
        },
        promptA: { type: sourceA.type, id: sourceA.id, name: sourceA.name },
        promptB: { type: sourceB.type, id: sourceB.id, name: sourceB.name },
        resultA,
        resultB
      };
      await saveAbRun(run);

      if (!wantsHtmlResponse(req)) return res.json({ status: 'ok', run });

      const tokenQ = tokenQuerySuffix();
      const body = `
        <div class="actions">
          <a class="button" href="/prompt-lab/ab?format=html${tokenQ}">Run another</a>
          <a class="button" href="/prompt-lab?format=html${tokenQ}">Prompt Lab</a>
        </div>
        <div class="card">
          <p><strong>Conversation:</strong> ${escHtml(conversation.label)} <span class="pill">${escHtml(conversation.kind)}</span></p>
          <p><strong>Mode:</strong> ${escHtml(mode)} · <strong>Run:</strong> <code>${escHtml(run.id)}</code></p>
        </div>
        <div style="display:flex;gap:1rem;align-items:flex-start;flex-wrap:wrap">
          ${renderRunColumn('Prompt A', sourceA, { turns: resultA })}
          ${renderRunColumn('Prompt B', sourceB, { turns: resultB })}
        </div>
      `;
      res.type('html').send(adminPageShell(htmlPageTitle('A/B Result'), body));
    } catch (err) {
      console.error('❌ /prompt-lab/ab-test error:', err.response?.data || err.message);
      res.status(500).json({ error: err.message, detail: err.response?.data || null });
    }
  });

  app.post('/prompt-lab/promote', async (req, res) => {
    if (!assertViewMessagesAuth(req, res)) return;
    const draft = await loadDraft(toCleanString(req.body.draftId));
    if (!draft) return res.status(404).json({ error: 'Unknown draft' });
    const botId = toCleanString(req.body.botId) || draft.botId;
    const bot = getBot(botId);
    if (!bot) return res.status(404).json({ error: 'Unknown bot id', botId });
    const active = await setActivePrompt(bot.id, draft);
    if (wantsHtmlResponse(req)) return redirectHtml(res, '/prompt-lab?format=html');
    res.json({ status: 'ok', active });
  });

  app.post('/prompt-lab/rollback', async (req, res) => {
    if (!assertViewMessagesAuth(req, res)) return;
    const botId = toCleanString(req.body.botId);
    const bot = getBot(botId);
    if (!bot) return res.status(404).json({ error: 'Unknown bot id', botId });
    await clearActivePrompt(bot.id);
    if (wantsHtmlResponse(req)) return redirectHtml(res, '/prompt-lab?format=html');
    res.json({ status: 'ok', bot: bot.id, active: null });
  });

  return {
    getActivePrompt,
    getEffectivePrompt,
    listFixtures,
    listDrafts,
    loadDraft
  };
}

module.exports = { createPromptLab };
