importScripts("lib/protocol.js", "lib/settings-schema.js", "lib/relay.js", "lib/local-translator.js", "lib/relay-stream.js", "lib/mt-utils.js", "lib/progress-cache.js", "lib/work-lookup.js", "lib/work-profiles.js", "lib/work-organizer.js", "lib/translation-review.js", "lib/subtitle-parser.js", "lib/assrt.js", "lib/fflate.js", "lib/subdl.js", "lib/jimaku.js", "lib/episode-metadata.js", "lib/collection-match.js", "lib/search-names.js", "lib/subtitle-assist.js", "lib/external-cache.js", "lib/external-subs.js");
const { MSG } = self.CRSubFix.protocol;
const SETTINGS = self.CRSubFix.settings;
const RELAY = self.CRSubFix.relay;
const LOCAL = self.CRSubFix.localTranslator.broker(chrome.runtime);
const WORK = self.CRSubFix.workProfiles;
const LOOKUP = self.CRSubFix.workLookup;
const REVIEW = self.CRSubFix.translationReview;
const EXTERNAL = self.CRSubFix.externalSubs.create(chrome);
const externalCommands = {
  [MSG.EXTERNAL_GET]: p => EXTERNAL.get(p?.snapshot),
  [MSG.EXTERNAL_SEARCH]: p => EXTERNAL.search(p),
  [MSG.EXTERNAL_DETAIL]: p => EXTERNAL.details(p),
  [MSG.EXTERNAL_PREVIEW]: p => EXTERNAL.preview(p),
  [MSG.EXTERNAL_DOWNLOAD_OPEN]: p => EXTERNAL.openDownload(p),
  [MSG.EXTERNAL_SET_HTTP]: p => EXTERNAL.setHttpDownloads(p?.enabled),
  [MSG.EXTERNAL_FOLLOW_CLEAR]: p => EXTERNAL.clearFollow(p),
  [MSG.EXTERNAL_APPLY]: p => EXTERNAL.apply(p),
  [MSG.EXTERNAL_TIME]: p => EXTERNAL.captureTime(p),
  [MSG.EXTERNAL_SAVE_KEY]: p => EXTERNAL.saveKey(p?.key, p?.source),
  [MSG.EXTERNAL_CLEAR_KEY]: p => EXTERNAL.removeKey(p?.source),
  [MSG.EXTERNAL_QUOTA]: p => EXTERNAL.quota(p?.source),
  [MSG.EXTERNAL_NAMES]: p => EXTERNAL.names(p),
  [MSG.EXTERNAL_ASSIST_CONFIG]: () => assistConfig(),
  [MSG.EXTERNAL_ASSIST_SAVE]: p => saveAssistConfig(p),
  [MSG.EXTERNAL_ASSIST_CLEAR]: () => clearAssistConfig(),
  [MSG.EXTERNAL_ASSIST]: p => assistExternal(p),
};

// Register listeners synchronously, but never read secrets until access is restricted.
const ready = (async () => {
  if (!chrome.storage.local.setAccessLevel || !chrome.storage.session?.setAccessLevel) {
    throw new Error('SECURE_STORAGE_UNAVAILABLE');
  }
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
})();
ready.catch(() => {});
let configWrite = Promise.resolve();
const activeTabs = new Map();
let budgetWrite = Promise.resolve();
let progressWrite = Promise.resolve();
let lookupWrite = Promise.resolve(), lookupActive = 0;
let reviewWriting = false;
const safeError = e => /^(?:[A-Z][A-Z0-9_]*|HTTP_\d{3})$/.test(e?.message || '')
  ? e.message : (['AbortError', 'TimeoutError'].includes(e?.name) ? 'TIMEOUT_UNKNOWN' : 'NETWORK_UNKNOWN');
const ITEM_REASONS = new Set(['MISSING_TEXT', 'NOT_STRING', 'EMPTY_TEXT', 'TEXT_TOO_LONG', 'SANITIZED_EMPTY']);
function streamDetails(details) {
  if (!Number.isInteger(details?.missingCount) || details.missingCount < 0 || details.missingCount > 6000) return undefined;
  return { missingCount: details.missingCount, items: (Array.isArray(details.items) ? details.items : []).slice(0, 10)
    .filter(item => Number.isInteger(item?.index) && item.index >= 0 && item.index < 6000 && ITEM_REASONS.has(item.reason))
    .map(item => ({ index: item.index, reason: item.reason })) };
}

function trusted(sender) {
  return sender.id === chrome.runtime.id &&
    ['popup.html', 'translation.html', 'work.html', 'subtitles.html'].some(p => sender.url?.split('?')[0] === chrome.runtime.getURL(p));
}
function contentSender(sender) {
  if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0) return false;
  try { return new URL(sender.url).origin === 'https://www.crunchyroll.com'; } catch (_) { return false; }
}
async function readState() {
  await ready;
  return chrome.storage.local.get({ ...SETTINGS.defaults(), relayConfig: null, mtApiKey: '', mtWorkProfiles: null, mtCloudConfig: null });
}
function selectedConfig(s) {
  return RELAY.config(s.relayConfig || RELAY.DEFAULTS);
}
function isConfigured(s) {
  try { return selectedConfig(s).provider === 'local' || !!s.mtApiKey; } catch (_) { return false; }
}
function publicState(s) {
  const settings = {};
  for (const entry of SETTINGS.SCHEMA) settings[entry.key] = s[entry.key] ?? entry.default;
  settings.mtConcurrency = s.relayConfig?.concurrency === 1 ? 1 : 2;
  settings.mtTimeoutMs = s.relayConfig?.timeoutMs || 25000;
  settings.mtTranslationMode = s.relayConfig?.provider === 'relay' ? (s.relayConfig.translationMode || 'batch') : 'batch';
  return { settings, configured: isConfigured(s) };
}
async function notifySettings() {
  const payload = publicState(await readState());
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(t => chrome.tabs.sendMessage(t.id, { type: MSG.SETTINGS_CHANGED, payload }).catch(() => {})));
}
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local' && Object.keys(_changes).some(k => !k.startsWith('mtProgress:') && !k.startsWith('mtAudit:'))) notifySettings().catch(() => {});
});
chrome.permissions.onRemoved.addListener(() => notifySettings().catch(() => {}));

async function getConfig() {
  const s = await readState();
  const cfg = s.relayConfig || { ...RELAY.DEFAULTS };
  let authorized = false;
  if (cfg.provider === 'local') authorized = true;
  else if (isConfigured(s)) authorized = await chrome.permissions.contains({ origins: [RELAY.originPattern(RELAY.host(cfg, s.mtApiKey))] });
  return { ok: true, config: cfg, cloudConfig: s.mtCloudConfig, hasKey: !!s.mtApiKey, authorized,
    enabled: s.mtEnabled, target: s.mtTarget, source: s.mtSource, workEnabled: s.mtWorkEnabled };
}
async function assistConfig() {
  const s = await chrome.storage.local.get({ subtitleAssistConfig: null, subtitleAssistKey: '', relayConfig: null, mtApiKey: '' });
  const independent = s.subtitleAssistConfig && !!s.subtitleAssistKey;
  const cfg = independent ? s.subtitleAssistConfig : s.relayConfig;
  const supported = cfg?.provider === 'relay' && !!(independent ? s.subtitleAssistKey : s.mtApiKey);
  const authorized = supported && await chrome.permissions.contains({ origins: [RELAY.originPattern(cfg.baseUrl)] });
  return { ok: true, independent: !!independent, available: !!supported && authorized,
    config: independent ? cfg : null, model: supported ? cfg.model : '', reason: !supported ? 'ASSIST_NOT_CONFIGURED' : !authorized ? 'HOST_PERMISSION_REQUIRED' : '' };
}
async function saveAssistConfig(payload) {
  const cfg = RELAY.config({ ...payload?.config, provider: 'relay' });
  const s = await chrome.storage.local.get({ subtitleAssistConfig: null, subtitleAssistKey: '' });
  const fresh = typeof payload?.apiKey === 'string' ? payload.apiKey.trim() : '';
  if (fresh.length > 4096 || /\s/.test(fresh)) throw new Error('INVALID_KEY');
  const same = s.subtitleAssistConfig && new URL(s.subtitleAssistConfig.baseUrl).origin === new URL(cfg.baseUrl).origin;
  const key = fresh || (same ? s.subtitleAssistKey : '');
  if (!key) throw new Error('KEY_REQUIRED');
  if (!await chrome.permissions.contains({ origins: [RELAY.originPattern(cfg.baseUrl)] })) throw new Error('HOST_PERMISSION_REQUIRED');
  await chrome.storage.local.set({ subtitleAssistConfig: cfg, subtitleAssistKey: key });
  return assistConfig();
}
async function clearAssistConfig() {
  await chrome.storage.local.remove('subtitleAssistConfig');
  await chrome.storage.local.remove('subtitleAssistKey');
  return assistConfig();
}
const assistActive = new Set();
async function assistExternal(payload) {
  const ctx = await EXTERNAL.context(payload?.snapshot), A = self.CRSubFix.subtitleAssist;
  if (!['names', 'files'].includes(payload?.action)) throw new Error('ASSIST_INVALID_INPUT');
  const s = await chrome.storage.local.get({ subtitleAssistConfig: null, subtitleAssistKey: '', relayConfig: null, mtApiKey: '' });
  const independent = s.subtitleAssistConfig && !!s.subtitleAssistKey;
  const cfg = independent ? s.subtitleAssistConfig : s.relayConfig, key = independent ? s.subtitleAssistKey : s.mtApiKey;
  if (!cfg || cfg.provider !== 'relay' || !key) throw new Error('ASSIST_NOT_CONFIGURED');
  const checked = RELAY.config(cfg);
  if (!await chrome.permissions.contains({ origins: [RELAY.originPattern(checked.baseUrl)] })) throw new Error('HOST_PERMISSION_REQUIRED');
  if (assistActive.has(ctx.tabId) || assistActive.size >= 2) throw new Error('BUSY');
  const data = payload.action === 'names' ? await EXTERNAL.get(payload.snapshot) : await EXTERNAL.collection(payload);
  const anchor = payload.action === 'files' ? data.files.find(f => f.name === payload.filename && (f.fileId || '') === (payload.fileId || '')) : null;
  if (payload.action === 'files' && !anchor) throw new Error('ASSIST_FILES_EXPIRED');
  const metadata = self.CRSubFix.episodeMetadata.validate({ ...(data.metadata || ctx.meta), ...payload.metadata,
    guid: ctx.meta.guid, seriesId: ctx.meta.seriesId }, ctx.meta.guid);
  const input = payload.action === 'names' ? A.prepareNames(metadata, self.CRSubFix.searchNames.merge(data.nameState.records,
    self.CRSubFix.searchNames.base(metadata))) : A.prepareFiles(metadata, data.files, anchor);
  if (assistActive.has(ctx.tabId) || assistActive.size >= 2) throw new Error('BUSY');
  assistActive.add(ctx.tabId);
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  try {
    const reservation = budgetWrite.then(() => reserveBudget(ctx.tabId, JSON.stringify(input).length));
    budgetWrite = reservation.catch(() => {}); await reservation;
    const raw = await WORK.requestDraft(checked, key, input, A.instructions);
    await EXTERNAL.context(payload.snapshot);
    const current = await chrome.storage.local.get({ subtitleAssistConfig: null, subtitleAssistKey: '', relayConfig: null, mtApiKey: '' });
    if (JSON.stringify(current) !== JSON.stringify(s)) throw new Error('CONFIG_CHANGED');
    if (payload.action === 'names') return EXTERNAL.names(payload, A.parseNames(raw));
    return { ok: true, suggestions: A.parseFiles(raw, input) };
  } finally { clearInterval(keepAlive); assistActive.delete(ctx.tabId); }
}
async function saveConfig(payload) {
  const cfg = RELAY.config(payload?.config);
  if (!RELAY.LANGUAGES[payload.target] ||
    (payload.source !== '' && !RELAY.LANGUAGES[payload.source])) throw new Error('INVALID_LANGUAGE');
  const s = await readState();
  const newKey = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : '';
  if (newKey.length > 4096 || /\s/.test(newKey)) throw new Error('INVALID_KEY');
  const local = cfg.provider === 'local';
  const old = s.relayConfig?.provider === 'local' ? s.mtCloudConfig : s.relayConfig;
  // A key saved for one destination must never silently follow a changed host/provider.
  const sameDestination = !local && old && old.provider === cfg.provider &&
    (cfg.provider === 'deepl' || new URL(old.baseUrl).origin === new URL(cfg.baseUrl).origin);
  const key = local ? s.mtApiKey : newKey || (sameDestination ? s.mtApiKey : '');
  if (!local && !key) throw new Error('KEY_REQUIRED');
  if (!local && !await chrome.permissions.contains({ origins: [RELAY.originPattern(RELAY.host(cfg, key))] })) {
    throw new Error('HOST_PERMISSION_REQUIRED');
  }
  const identity = value => JSON.stringify([
    ...['provider', 'baseUrl', 'protocol', 'model'].map(k => value?.[k]), value?.glossary || {},
  ]);
  const changed = identity(s.relayConfig) !== identity(cfg) || (!local && !!newKey);
  await chrome.storage.local.set({
    relayConfig: cfg, mtCloudConfig: local ? old : cfg, mtApiKey: key, mtProvider: cfg.provider, mtEnabled: payload.enabled === true,
    mtTarget: payload.target, mtSource: payload.source, mtBatchSize: cfg.batchSize, mtMaxChars: cfg.maxChars,
    mtConcurrency: cfg.concurrency, mtTimeoutMs: cfg.timeoutMs,
    mtTranslationMode: cfg.translationMode,
    mtWorkEnabled: payload.workEnabled === undefined ? s.mtWorkEnabled : payload.workEnabled === true,
    mtConfigTag: changed || !s.mtConfigTag ? crypto.randomUUID() : s.mtConfigTag,
  });
  return getConfig();
}
async function setPublicSetting(payload) {
  const entry = SETTINGS.SCHEMA.find(e => e.key === payload?.key);
  if (!entry || ['mtEnabled', 'mtProvider', 'mtConfigTag', 'mtBatchSize', 'mtMaxChars', 'mtConcurrency', 'mtTimeoutMs', 'mtTranslationMode', 'mtWorkEnabled'].includes(entry.key)) {
    throw new Error('SETTING_NOT_ALLOWED');
  }
  const value = payload.value;
  if ((entry.type === 'bool' && typeof value !== 'boolean') ||
    (['int', 'float'].includes(entry.type) && (!Number.isFinite(value) || Math.abs(value) > 10000)) ||
    (entry.type === 'string' && (typeof value !== 'string' || value.length > 500))) throw new Error('INVALID_SETTING');
  if (entry.key === 'mtTarget' && !RELAY.LANGUAGES[value]) throw new Error('INVALID_LANGUAGE');
  if (entry.key === 'mtSource' && value !== '' && !RELAY.LANGUAGES[value]) throw new Error('INVALID_LANGUAGE');
  if (entry.key === 'uiLanguage' && !['auto', 'zh-Hans', 'zh-Hant', 'en', 'ja'].includes(value)) throw new Error('INVALID_UI_LANGUAGE');
  await chrome.storage.local.set({ [entry.key]: value });
  return { ok: true };
}
async function reserveBudget(tabId, chars) {
  const key = `relayBudget:${tabId}`;
  const saved = (await chrome.storage.session.get(key))[key];
  const now = Date.now();
  const budget = saved && now - saved.started < 3600000 ? saved : { started: now, chars: 0, requests: 0 };
  if (budget.chars + chars > 100000 || budget.requests >= 200) throw new Error('BUDGET_EXCEEDED');
  await chrome.storage.session.set({ [key]: { ...budget, chars: budget.chars + chars, requests: budget.requests + 1 } });
}
function episodeGuid(sender) { return WORK.route(sender.url, 'watch'); }
async function currentExternalSender(sender, payload) {
  let current;
  try {
    current = await self.CRSubFix.mtUtils.withTimeout(chrome.tabs.sendMessage(sender.tab.id,
      { type: MSG.WORK_PAGE_CHECK }, { frameId: 0 }), 3000, 'EXTERNAL_CONTEXT_EXPIRED');
  } catch (_) {}
  // MessageSender.url is the original document URL on a history-based SPA hop.
  const guid = WORK.route(current?.url, 'watch');
  if (!guid || guid !== current?.guid || guid !== payload?.guid) throw new Error('EXTERNAL_CONTEXT_EXPIRED');
  return { ...sender, url: current.url };
}
async function workFor(s, payload, sender, check = true) {
  let record = null;
  if (s.mtWorkEnabled && s.mtProvider === 'relay') {
    const h = WORK.hint(payload?.workHint, episodeGuid(sender));
    record = WORK.resolve(s.mtWorkProfiles || { profiles: [], bindings: {} }, h, payload?.target || s.mtTarget);
  }
  const token = WORK.token(record);
  if (check && (payload?.workToken || '') !== token) throw new Error('WORK_CHANGED');
  return { record, token };
}
async function workSnapshot(key, required = false) {
  if (!key && !required) return null;
  if (typeof key !== 'string' || !/^[a-f0-9-]{36}$/.test(key)) throw new Error('WORK_CONTEXT_EXPIRED');
  const value = (await chrome.storage.session.get(`mtWorkSnapshot:${key}`))[`mtWorkSnapshot:${key}`];
  if (!value || value.expires <= Date.now()) throw new Error('WORK_CONTEXT_EXPIRED');
  let current;
  try {
    current = await self.CRSubFix.mtUtils.withTimeout(
      chrome.tabs.sendMessage(value.tabId, { type: MSG.WORK_PAGE_CHECK }, { frameId: 0 }), 3000, 'WORK_CONTEXT_EXPIRED');
  } catch (_) {}
  if (current?.guid !== value.hint.guid) throw new Error('WORK_CONTEXT_EXPIRED');
  return value;
}
async function openWork(payload, sender) {
  const guid = episodeGuid(sender);
  if (!guid || guid !== payload?.guid) throw new Error('SENDER_NOT_ALLOWED');
  const state = await readState();
  const key = crypto.randomUUID();
  const value = { tabId: sender.tab.id, hint: WORK.hint(payload.workHint, guid),
    samples: WORK.samples(payload.samples), corpus: LOOKUP.corpus(payload.corpus || payload.samples),
    subtitleState: payload.loading === true ? 'loading' : (payload.corpus?.length || payload.samples?.length) ? 'ready' : 'unavailable',
    target: state.mtTarget, expires: Date.now() + 60 * 60 * 1000 };
  const all = await chrome.storage.session.get(null);
  const old = Object.entries(all).filter(([k]) => k.startsWith('mtWorkSnapshot:')).sort((a, b) => a[1].expires - b[1].expires);
  while (old.length && (old[0][1].expires <= Date.now() || old.length >= 10)) {
    await chrome.storage.session.remove(old.shift()[0]);
  }
  await chrome.storage.session.set({ [`mtWorkSnapshot:${key}`]: value });
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`work.html?snapshot=${key}`), active: true });
  } catch (_) {
    await chrome.storage.session.remove(`mtWorkSnapshot:${key}`).catch(() => {});
    throw new Error('WORK_OPEN_FAILED');
  }
  return { ok: true, snapshot: key };
}
async function updateWorkSnapshot(payload, sender) {
  const guid = episodeGuid(sender), key = payload?.snapshot;
  if (!guid || guid !== payload?.guid || typeof key !== 'string' || !/^[a-f0-9-]{36}$/.test(key)) {
    throw new Error('SENDER_NOT_ALLOWED');
  }
  const storageKey = `mtWorkSnapshot:${key}`;
  const value = (await chrome.storage.session.get(storageKey))[storageKey];
  if (!value || value.expires <= Date.now() || value.hint.guid !== guid || value.tabId !== sender.tab.id) {
    throw new Error('WORK_CONTEXT_EXPIRED');
  }
  const samples = WORK.samples(payload.samples), corpus = LOOKUP.corpus(payload.corpus || payload.samples);
  // Only source samples can be supplemented; identity, target and saved profiles stay immutable.
  await chrome.storage.session.set({ [storageKey]: { ...value, samples, corpus,
    subtitleState: corpus.length ? 'ready' : 'unavailable' } });
  return { ok: true };
}
async function getWorks(payload) {
  const snapshot = await workSnapshot(payload?.snapshot);
  const s = await readState();
  const db = await WORK.read(chrome.storage.local);
  return { ok: true, snapshot, profiles: db.profiles, enabled: s.mtWorkEnabled,
    selected: snapshot ? WORK.resolve(db, snapshot.hint, snapshot.target)?.key || '' : '',
    model: s.relayConfig?.model || '', target: snapshot?.target || s.mtTarget,
    canGenerate: !!snapshot && isConfigured(s) && s.mtProvider === 'relay',
    globalGlossary: s.relayConfig?.provider === 'relay' ? s.relayConfig.glossary || {} : {} };
}
async function getReview(payload) {
  const snapshot = await workSnapshot(payload?.snapshot, true);
  return { ok: true, runs: await REVIEW.list(chrome.storage.local, snapshot.hint.guid) };
}
async function saveReview(payload) {
  if (reviewWriting || [...activeTabs.values()].some(v => v.size)) throw new Error('BUSY');
  reviewWriting = true;
  try {
    const snapshot = await workSnapshot(payload?.snapshot, true);
    const run = (await REVIEW.list(chrome.storage.local, snapshot.hint.guid)).find(r => r.key === payload.key);
    if (!run?.cached) throw new Error('REVIEW_CACHE_EXPIRED');
    if (!run.complete) throw new Error('REVIEW_INCOMPLETE');
    const entry = run.entries.find(e => e.index === payload.index);
    if (!entry || !entry.timing) throw new Error('INVALID_REVIEW_INPUT');
    if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 30000 ||
        self.CRSubFix.mtUtils.plainText(payload.text) !== payload.text) throw new Error('INVALID_REVIEW_INPUT');
    const write = progressWrite.then(() => self.CRSubFix.progressCache.handle(chrome.storage.local, 'correct', {
      key: run.key, guid: run.guid, configTag: run.configTag, total: run.total,
      entries: [{ index: payload.index, text: payload.text, previous: payload.previous }],
    }));
    progressWrite = write.catch(() => {});
    await write;
    const tabs = await chrome.tabs.query({}).catch(() => []);
    await Promise.all(tabs.map(t => chrome.tabs.sendMessage(t.id, { type: MSG.WORK_REVIEW_CHANGED,
      payload: { guid: run.guid, key: run.key, index: payload.index, text: payload.text } }).catch(() => {})));
    return { ok: true, runs: await REVIEW.list(chrome.storage.local, snapshot.hint.guid) };
  } finally { reviewWriting = false; }
}
async function recordRequest(payload, cfg, record, enabled, sender, streaming) {
  if (cfg.provider !== 'relay' || !payload.cache) return;
  const cache = { ...payload.cache, target: payload.target, workToken: payload.workToken || '' };
  if (cache.guid !== episodeGuid(sender) || cache.configTag !== payload.configTag ||
      (payload.cache.target && payload.cache.target !== payload.target) ||
      (payload.cache.workToken && payload.cache.workToken !== payload.workToken)) throw new Error('INVALID_CACHE_REQUEST');
  const inputs = streaming ? payload.items.map(i => ({ index: +i.id, text: i.text })) :
    payload.texts.map((text, i) => ({ index: payload.indices?.[i], text }));
  if (!streaming && (!Array.isArray(payload.indices) || payload.indices.length !== payload.texts.length)) {
    throw new Error('INVALID_REVIEW_INPUT');
  }
  for (const [i, input] of inputs.entries()) {
    const timing = payload.timings?.[i];
    input.timing = timing && Number.isFinite(timing.start) && Number.isFinite(timing.end) &&
      timing.start >= 0 && timing.end > timing.start && timing.end < 86400
      ? { start: timing.start, end: timing.end } : null;
    input.sourceLanguage = payload.source === 'ja-JP' ? 'en-US' : payload.source;
  }
  const write = progressWrite.then(async () => {
    try {
      await self.CRSubFix.progressCache.handle(chrome.storage.local, 'get', cache);
      await REVIEW.record(chrome.storage.local, cache, inputs, {
        ...REVIEW.effective(cfg, record, enabled), source: payload.source, target: payload.target,
        mode: streaming ? 'episode-stream' : 'batch',
      });
    } catch (e) {
      if (/^(?:INVALID_|REVIEW_)/.test(e.message)) throw e;
      throw new Error('REVIEW_SAVE_FAILED');
    }
  });
  progressWrite = write.catch(() => {});
  await write;
}
async function lookupReference(payload) {
  if (!Number.isSafeInteger(payload.subjectId) || !Array.isArray(payload.characterIds) ||
      !payload.characterIds.length || payload.characterIds.length > 60 ||
      payload.characterIds.some(id => !Number.isSafeInteger(id))) throw new Error('LOOKUP_EVIDENCE_EXPIRED');
  const cache = ((await chrome.storage.session.get('mtLookupCache')).mtLookupCache || [])
    .filter(row => Date.now() - row.result.fetchedAt < 86400000);
  const subject = cache.flatMap(row => row.result.subjects || []).find(s => s.id === payload.subjectId);
  const characters = new Map();
  for (const row of cache) {
    if (row.result.subjectId !== payload.subjectId) continue;
    for (const c of row.result.characters || []) characters.set(c.id, { ...c, fetchedAt: row.result.fetchedAt });
  }
  if (!subject || payload.characterIds.some(id => !characters.has(id))) throw new Error('LOOKUP_EVIDENCE_EXPIRED');
  return { subject, characters: [...new Set(payload.characterIds)].map(id => characters.get(id)) };
}
async function generateWork(payload, organize = false) {
  const snapshot = await workSnapshot(payload?.snapshot, true);
  if (snapshot.subtitleState === 'loading') throw new Error('WORK_SUBTITLES_LOADING');
  const s = await readState(), cfg = selectedConfig(s), tabId = snapshot.tabId;
  if (cfg.provider !== 'relay') throw new Error('STREAM_RELAY_ONLY');
  if (!s.mtApiKey) throw new Error('KEY_REQUIRED');
  if (!await chrome.permissions.contains({ origins: [RELAY.originPattern(cfg.baseUrl)] })) throw new Error('HOST_PERMISSION_REQUIRED');
  const reference = organize ? await lookupReference(payload) : null;
  const input = organize ? self.CRSubFix.workOrganizer.prepare(snapshot, payload.profile, reference) : null;
  if (activeTabs.get(tabId)?.size || [...activeTabs.values()].reduce((n, v) => n + v.size, 0) >= 4) throw new Error('BUSY');
  const active = new Set(['work-draft']);
  activeTabs.set(tabId, active);
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  try {
    if (!organize && (typeof payload.title !== 'string' || payload.title.length > 200)) throw new Error('INVALID_WORK_PROFILE');
    const reservation = budgetWrite.then(() => reserveBudget(tabId,
      organize ? JSON.stringify(input).length : snapshot.samples.join('').length + payload.title.length));
    budgetWrite = reservation.catch(() => {});
    await reservation;
    const draft = organize
      ? await self.CRSubFix.workOrganizer.generate(cfg, s.mtApiKey, input, reference)
      : await WORK.generate(cfg, s.mtApiKey, snapshot, payload.title);
    if ((await readState()).mtConfigTag !== s.mtConfigTag) throw new Error('CONFIG_CHANGED');
    await workSnapshot(payload.snapshot, true);
    return { ok: true, draft };
  } finally {
    clearInterval(keepAlive);
    active.delete('work-draft');
    if (activeTabs.get(tabId) === active && !active.size) activeTabs.delete(tabId);
  }
}
async function lookupWork(payload) {
  if (!['search', 'characters'].includes(payload?.action)) throw new Error('LOOKUP_INVALID_INPUT');
  const search = payload.action === 'search';
  const query = search ? LOOKUP.query(payload.query) : '';
  const { subjectId, offset = 0 } = payload;
  if (!search && (!Number.isSafeInteger(subjectId) || subjectId <= 0 || subjectId >= 100000000 ||
      !Number.isInteger(offset) || offset < 0 || offset > 288 || offset % 12)) throw new Error('LOOKUP_INVALID_INPUT');
  if (!await chrome.permissions.contains({ origins: [LOOKUP.PERMISSION] })) throw new Error('LOOKUP_PERMISSION');
  const key = search ? `search:${query}` : `characters:${subjectId}:${offset}`;
  const cached = (await chrome.storage.session.get('mtLookupCache')).mtLookupCache || [];
  const hit = cached.find(row => row.key === key && !row.result.failedIds?.length &&
    Date.now() - row.result.fetchedAt < 86400000);
  if (hit && payload.refresh !== true) return { ok: true, ...hit.result, cached: true };
  if (lookupActive >= 2) throw new Error('LOOKUP_BUSY');
  lookupActive++;
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  try {
    const reserve = lookupWrite.then(async () => {
      const old = (await chrome.storage.session.get('mtLookupBudget')).mtLookupBudget;
      const budget = old && Date.now() - old.started < 3600000 ? old : { started: Date.now(), requests: 0 };
      const cost = search ? 1 : 13;
      if (budget.requests + cost > 180) throw new Error('LOOKUP_BUDGET');
      await chrome.storage.session.set({ mtLookupBudget: { ...budget, requests: budget.requests + cost } });
    });
    lookupWrite = reserve.catch(() => {});
    await reserve;
    const result = search ? await LOOKUP.search(query) : await LOOKUP.characters(subjectId, offset);
    // Partial pages retain evidence for model review, but never count as cache hits.
    {
      const write = lookupWrite.then(async () => {
        const rows = (await chrome.storage.session.get('mtLookupCache')).mtLookupCache || [];
        await chrome.storage.session.set({ mtLookupCache: rows.filter(row => row.key !== key &&
          Date.now() - row.result.fetchedAt < 86400000).slice(-19).concat({ key, result }) });
      });
      lookupWrite = write.catch(() => {});
      await write;
    }
    return { ok: true, ...result, cached: false };
  } finally { clearInterval(keepAlive); lookupActive--; }
}
async function handleTranslate(payload, sender, test = false, stream = null) {
  if (reviewWriting) throw new Error('BUSY');
  const tabId = test ? 'test' : sender.tab.id;
  const s = await readState();
  if (reviewWriting) throw new Error('BUSY');
  const cfg = selectedConfig(s);
  const requests = activeTabs.get(tabId) || new Set();
  const requestId = typeof payload?.requestId === 'string' && payload.requestId.length <= 100
    ? payload.requestId : 'legacy';
  const total = [...activeTabs.values()].reduce((n, set) => n + set.size, 0);
  if (requests.has('work-draft') || requests.has(requestId) ||
      requests.size >= (test || stream ? 1 : cfg.concurrency) || total >= 4) throw new Error('BUSY');
  requests.add(requestId);
  activeTabs.set(tabId, requests);
  // Keep only an active, bounded network operation alive; never idle indefinitely.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  try {
    if (!test && (!s.mtEnabled || !s.enabled)) throw new Error('TRANSLATION_DISABLED');
    if (cfg.provider !== 'local' && !s.mtApiKey) throw new Error('KEY_REQUIRED');
    if (!test && payload?.configTag !== s.mtConfigTag) throw new Error('CONFIG_CHANGED');
    if (!test && payload?.provider !== cfg.provider) throw new Error('CONFIG_CHANGED');
    let record = null;
    if (!test) {
      ({ record } = await workFor(s, payload, sender));
      if (record) {
        cfg.workContext = { title: record.title, aliases: record.aliases, context: record.context, tone: record.tone };
        cfg.glossary = { ...cfg.glossary, ...record.glossary };
      }
    }
    const texts = test ? ['Hello. Thank you for waiting.'] : payload?.texts;
    const target = test ? s.mtTarget : payload?.target;
    const sourceTrack = test ? 'en-US' : payload?.source;
    if (typeof sourceTrack !== 'string' || sourceTrack.length > 30 || !/^[a-zA-Z-]*$/.test(sourceTrack)) throw new Error('INVALID_LANGUAGE');
    // The private ja-JP source slot contains English picked from the Japanese-audio session.
    const source = sourceTrack === 'ja-JP' ? 'en-US' : sourceTrack;
    const streaming = !!stream || (test && cfg.translationMode === 'episode-stream');
    let items;
    if (streaming) {
      if (cfg.provider !== 'relay' || cfg.translationMode !== 'episode-stream') throw new Error('CONFIG_CHANGED');
      items = test ? [{ id: '0', text: texts[0] }] : payload?.items;
      self.CRSubFix.relayStream.validate(items);
      if (!test) {
        const p = payload.cache;
        const guid = new URL(sender.url).pathname.match(/\/watch\/([^/]+)/)?.[1];
        if (!p || p.guid !== guid || p.configTag !== s.mtConfigTag || items.some(i => +i.id >= p.total)) {
          throw new Error('INVALID_CACHE_REQUEST');
        }
        await self.CRSubFix.progressCache.handle(chrome.storage.local, 'get', p);
      }
    } else RELAY.validateTexts(texts, cfg);
    if (!RELAY.LANGUAGES[target]) throw new Error('INVALID_TARGET');
    if (cfg.provider !== 'local' && !await chrome.permissions.contains({ origins: [RELAY.originPattern(RELAY.host(cfg, s.mtApiKey))] })) {
      throw new Error('HOST_PERMISSION_REQUIRED');
    }
    // Parallel batches must not read and overwrite the same budget snapshot.
    if (cfg.provider !== 'local') {
      const reservation = budgetWrite.then(() => reserveBudget(tabId,
        (streaming ? items.map(i => i.text) : texts).reduce((n, t) => n + t.length, 0)));
      budgetWrite = reservation.catch(() => {});
      await reservation;
    }
    if (!test) await recordRequest(payload, cfg, record, s.mtWorkEnabled, sender, streaming);
    let translations;
    if (streaming) {
      translations = [];
      await self.CRSubFix.relayStream.translate(cfg, s.mtApiKey, items, source, target, async (index, text) => {
        const latest = await readState();
        if (latest.mtConfigTag !== s.mtConfigTag || (!test && (!latest.mtEnabled || !latest.enabled))) throw new Error('CONFIG_CHANGED');
        if (!test) await workFor(latest, payload, sender);
        if (test) { translations[index] = text; return; }
        // Save in the trusted world before exposing a complete cue to the page.
        const write = progressWrite.then(async () => {
          try {
            return await self.CRSubFix.progressCache.handle(chrome.storage.local, 'save', {
              ...payload.cache, entries: [{ index, text }],
            });
          } catch (_) { throw new Error('CACHE_SAVE_FAILED'); }
        });
        progressWrite = write.catch(() => {});
        await write;
        stream.onItem(index, text);
      }, { signal: stream?.signal, cleanText: self.CRSubFix.mtUtils.plainText,
        onIssue: issue => stream?.onIssue?.(issue) });
    } else translations = cfg.provider === 'local'
      ? await LOCAL.translate(texts, source, target, cfg.timeoutMs)
      : await RELAY.translate(cfg, s.mtApiKey, texts, source, target);
    const latest = await readState();
    if (latest.mtConfigTag !== s.mtConfigTag || (!test && !latest.mtEnabled)) throw new Error('CONFIG_CHANGED');
    if (!test) await workFor(latest, payload, sender);
    return { ok: true, translations };
  } finally {
    clearInterval(keepAlive);
    requests.delete(requestId);
    if (!requests.size) activeTabs.delete(tabId);
  }
}

chrome.runtime.onConnect.addListener(port => {
  if (LOCAL.attach(port)) return;
  if (port.name !== MSG.MT_STREAM) return;
  const sender = port.sender;
  if (!contentSender(sender) || !/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?watch\/[^/]+(?:\/|$)/i.test(new URL(sender.url).pathname)) { port.disconnect(); return; }
  const controller = new AbortController();
  let started = false, closed = false;
  const post = data => { if (!closed) port.postMessage(data); };
  port.onDisconnect.addListener(() => {
    closed = true;
    controller.abort(new Error('STREAM_CANCELLED'));
  });
  port.onMessage.addListener(message => {
    if (message?.type === 'stop') {
      controller.abort(new Error(message.reason === 'STREAM_PAUSED' ? 'STREAM_PAUSED' : 'STREAM_CANCELLED'));
      return;
    }
    if (message?.type !== 'start' || started) return;
    started = true;
    handleTranslate(message.payload, sender, false, {
      signal: controller.signal,
      onItem: (index, text) => post({ type: 'item', index, text }),
      onIssue: issue => post({ type: 'issue', ...issue }),
    }).then(() => post({ type: 'done', ok: true }))
      .catch(error => post({ type: 'done', ok: false, error: safeError(error), details: streamDetails(error.details) }));
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  const isTrusted = trusted(sender);
  const isContent = contentSender(sender);
  const known = [MSG.PUBLIC_SETTINGS, MSG.SET_PUBLIC_SETTING, MSG.SET_BADGE, MSG.MT_TRANSLATE,
    MSG.MT_GET_CONFIG, MSG.MT_SAVE_CONFIG, MSG.MT_CLEAR_KEY, MSG.MT_TEST, MSG.MT_PROGRESS,
    MSG.WORK_OPEN, MSG.WORK_CONTEXT, MSG.WORK_GET, MSG.WORK_SAVE, MSG.WORK_DELETE, MSG.WORK_GENERATE, MSG.WORK_LOOKUP, MSG.WORK_ORGANIZE,
    MSG.WORK_REVIEW_GET, MSG.WORK_REVIEW_SAVE, MSG.WORK_UPDATE, MSG.WORK_SNAPSHOT_GET,
    MSG.EXTERNAL_OPEN, MSG.EXTERNAL_RESTORE, MSG.EXTERNAL_SYNC, MSG.EXTERNAL_ACTIVE, MSG.EXTERNAL_FORGET, ...Object.keys(externalCommands)];
  if (!known.includes(msg.type)) return;
  (async () => {
    await ready;
    if (!isTrusted && !isContent) throw new Error('SENDER_NOT_ALLOWED');
    if (isContent && msg.type === MSG.EXTERNAL_OPEN) return EXTERNAL.open(msg.payload, await currentExternalSender(sender, msg.payload));
    if (isContent && [MSG.EXTERNAL_RESTORE, MSG.EXTERNAL_SYNC, MSG.EXTERNAL_ACTIVE, MSG.EXTERNAL_FORGET].includes(msg.type)) {
      const current = await currentExternalSender(sender, msg.payload), guid = episodeGuid(current);
      if (msg.type === MSG.EXTERNAL_RESTORE) return EXTERNAL.restore(guid, msg.payload.metadata, current);
      if (msg.type === MSG.EXTERNAL_FORGET) return EXTERNAL.forget(msg.payload);
      if (msg.type === MSG.EXTERNAL_ACTIVE) return EXTERNAL.setActive(msg.payload);
      return EXTERNAL.updateSync(msg.payload);
    }
    if (isContent && msg.type === MSG.WORK_OPEN) return openWork(msg.payload, sender);
    if (isContent && msg.type === MSG.WORK_UPDATE) return updateWorkSnapshot(msg.payload, sender);
    if (isContent && msg.type === MSG.WORK_CONTEXT) {
      if (!episodeGuid(sender) || msg.payload?.guid !== episodeGuid(sender)) throw new Error('SENDER_NOT_ALLOWED');
      const { token, record } = await workFor(await readState(), msg.payload, sender, false);
      return { ok: true, token, title: record?.title || '' };
    }
    if (msg.type === MSG.MT_PROGRESS && isContent) {
      const p = msg.payload;
      if (!['get', 'save', 'clear'].includes(p?.action)) throw new Error('INVALID_CACHE_REQUEST');
      const guid = new URL(sender.url).pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?watch\/([^/]+)/i)?.[1];
      if (!guid || guid !== p?.guid) throw new Error('SENDER_NOT_ALLOWED');
      const run = progressWrite.then(async () => {
        const state = await readState();
        if (p.configTag !== state.mtConfigTag) throw new Error('CONFIG_CHANGED');
        if (p.action !== 'clear') await workFor(state, p, sender);
        return self.CRSubFix.progressCache.handle(chrome.storage.local, p.action, p);
      });
      progressWrite = run.catch(() => {});
      return run;
    }
    if (msg.type === MSG.PUBLIC_SETTINGS) return { ok: true, ...publicState(await readState()) };
    if (msg.type === MSG.SET_PUBLIC_SETTING && isContent) return setPublicSetting(msg.payload);
    if (msg.type === MSG.SET_BADGE && isContent) {
      await chrome.action.setBadgeText({ text: msg.active ? 'ON' : '', tabId: sender.tab.id });
      return { ok: true };
    }
    if (msg.type === MSG.MT_TRANSLATE && isContent &&
        /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?watch\/[^/]+(?:\/|$)/i.test(new URL(sender.url).pathname)) {
      return handleTranslate(msg.payload, sender);
    }
    if (!isTrusted) throw new Error('SENDER_NOT_ALLOWED');
    if (externalCommands[msg.type]) return externalCommands[msg.type](msg.payload);
    if (msg.type === MSG.WORK_SNAPSHOT_GET) return { ok: true, snapshot: await workSnapshot(msg.payload?.snapshot, true) };
    if (msg.type === MSG.WORK_REVIEW_GET) return getReview(msg.payload);
    if (msg.type === MSG.WORK_REVIEW_SAVE) return saveReview(msg.payload);
    if (msg.type === MSG.WORK_GET) return getWorks(msg.payload);
    if (msg.type === MSG.WORK_GENERATE) return generateWork(msg.payload);
    if (msg.type === MSG.WORK_ORGANIZE) return generateWork(msg.payload, true);
    if (msg.type === MSG.WORK_LOOKUP) return lookupWork(msg.payload);
    if (msg.type === MSG.WORK_SAVE || msg.type === MSG.WORK_DELETE) {
      const run = configWrite.then(async () => {
        if (msg.type === MSG.WORK_DELETE) await WORK.remove(chrome.storage.local, msg.payload?.key, msg.payload?.revision);
        else {
          const snapshot = await workSnapshot(msg.payload?.snapshot);
          if (!snapshot && !msg.payload?.key) throw new Error('WORK_CONTEXT_EXPIRED');
          const s = await readState();
          const old = (await WORK.read(chrome.storage.local)).profiles.find(p => p.key === msg.payload?.key);
          await WORK.save(chrome.storage.local, msg.payload, snapshot, snapshot?.target || old?.target || s.mtTarget);
        }
        return getWorks({ snapshot: msg.payload?.snapshot });
      });
      configWrite = run.catch(() => {});
      return run;
    }
    if (msg.type === MSG.MT_GET_CONFIG) return getConfig();
    if (msg.type === MSG.MT_SAVE_CONFIG) {
      const run = configWrite.then(() => saveConfig(msg.payload));
      configWrite = run.catch(() => {});
      return run;
    }
    if (msg.type === MSG.MT_CLEAR_KEY) {
      const run = configWrite.then(async () => {
        await chrome.storage.local.set({ mtApiKey: '', mtEnabled: false, mtConfigTag: crypto.randomUUID() });
        return { ok: true };
      });
      configWrite = run.catch(() => {});
      return run;
    }
    if (msg.type === MSG.MT_TEST) return handleTranslate(null, sender, true);
    throw new Error('MESSAGE_NOT_ALLOWED');
  })().then(sendResponse).catch(e => {
    const result = { ok: false, error: safeError(e) };
    if (Number.isFinite(e.retryAfter)) result.retryAfter = Math.max(1, Math.min(3600, Math.ceil(e.retryAfter)));
    if (result.error === 'ITEM_COUNT_MISMATCH' && Number.isInteger(e.counts?.expected) &&
        Number.isInteger(e.counts?.received)) {
      result.counts = { expected: e.counts.expected, received: e.counts.received };
    }
    sendResponse(result);
  });
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  ready.then(() => chrome.storage.session.remove(`relayBudget:${tabId}`)).catch(() => {});
});
chrome.commands.onCommand.addListener(async command => {
  if (command !== 'toggle-jp-cc') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: MSG.TOGGLE_JP_CC }).catch(() => {});
});
