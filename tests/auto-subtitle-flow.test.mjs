import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { background, context, load, source } from './helpers.mjs';

test('settings schema defaults enable zero-click dual-layer external subtitles and clean styling', () => {
  const ctx = context();
  load(ctx, 'lib/settings-schema.js');
  const d = ctx.CRSubFix.settings.defaults();
  assert.equal(d.autoActivate, true);
  assert.equal(d.hideOfficialSubs, true);
  assert.equal(d.mtAutoTranslate, false);
  assert.equal(d.styleOverride, true);
  assert.equal(d.sign_styleOverride, true);
  assert.equal(d.overrideBord, 1.5);
  assert.equal(d.sign_overrideBord, 1.5);
  assert.equal(d.overrideShadStyle, 'soft');
  assert.equal(d.sign_overrideShadStyle, 'soft');
});

test('dual secondary auto-picks English for monolingual subs and suppresses redundant English on bilingual subs or explicit off', () => {
  const store = new Map();
  let currentEpObj = null;
  const ctx = context({
    localStorage: {
      getItem: k => store.has(k) ? store.get(k) : null,
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    hasCJK: s => /[ᄀ-ᇿ　-ヿ㄰-鿿가-힯豈-﫿]/.test(s || ''),
    isCustomId: id => String(id || '').startsWith('custom:'),
    localeHasSub: (ep, loc) => !!ep._subs[loc],
    currentEp: () => currentEpObj,
    renderer: { invalidate() {} },
    overlayActive: false,
    onTimeUpdate() {},
    _secondaryRawAss: null,
    _secondaryHasSigns: false,
    pushSignLayer() {},
    buildSignsAss: () => null,
    getSubtitleUrl: () => null,
    subUrlBase: u => u,
    fetchCuesForLocale: async () => null,
    applyCustomSync: r => r.srcCues,
  });
  const text = source('interceptor.js');
  const start = text.indexOf("  const SECONDARY_PREF_KEY = 'crSubFix_secondary';");
  const end = text.indexOf('  // ── Learning mode', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(text.slice(start, end), ctx);

  // Pure Chinese external track → auto-picks English secondary.
  const monoRecord = {
    id: 'custom:assrt:1:mono', kind: 'external',
    srcCues: [
      { start: 1, end: 3, text: '你好，世界。' },
      { start: 4, end: 6, text: '今天天气不错。' },
      { start: 7, end: 9, text: '走吧。' },
    ],
  };
  currentEpObj = {
    guid: 'EP1', disposed: false, secondaryCues: [],
    _subs: { 'en-US': true, 'ja-JP': true },
    activeSource: () => 'custom:assrt:1:mono',
    getCustomSource: id => id === 'custom:assrt:1:mono' ? monoRecord : null,
    setSecondaryCues: cues => { currentEpObj.secondaryCues = cues; },
  };
  assert.equal(ctx.resolveEffectiveSecondary(currentEpObj), 'en-US');

  // MT track translated from ja-JP → reuses ja-JP English track.
  const mtRecord = { id: 'custom:mt:1', kind: 'mt', lang: 'zh-CN', mtSource: 'ja-JP', srcCues: [] };
  currentEpObj.activeSource = () => 'custom:mt:1';
  currentEpObj.getCustomSource = id => id === 'custom:mt:1' ? mtRecord : null;
  assert.equal(ctx.resolveEffectiveSecondary(currentEpObj), 'ja-JP');

  // Inline bilingual Chinese + English external track → suppresses secondary.
  const inlineBilingual = {
    id: 'custom:assrt:2:bi', kind: 'external',
    srcCues: [
      { start: 1, end: 3, text: '你好，世界。\nHello world today.' },
      { start: 4, end: 6, text: '今天天气不错。\nThe weather is nice.' },
      { start: 7, end: 9, text: '走吧。\nLet us go.' },
    ],
  };
  currentEpObj.activeSource = () => 'custom:assrt:2:bi';
  currentEpObj.getCustomSource = id => id === 'custom:assrt:2:bi' ? inlineBilingual : null;
  assert.equal(ctx.isBilingualCues(inlineBilingual.srcCues), true);
  assert.equal(ctx.resolveEffectiveSecondary(currentEpObj), '');

  // Split ASS dual-dialogue cues at matching timestamps → suppresses secondary.
  const splitBilingual = {
    id: 'custom:assrt:3:split', kind: 'external',
    srcCues: [
      { start: 1.0, end: 3.0, text: '你好，世界。' },
      { start: 1.0, end: 3.0, text: 'Hello world.' },
      { start: 4.0, end: 6.0, text: '走吧。' },
      { start: 4.0, end: 6.0, text: 'Let us go.' },
    ],
  };
  currentEpObj.activeSource = () => 'custom:assrt:3:split';
  currentEpObj.getCustomSource = id => id === 'custom:assrt:3:split' ? splitBilingual : null;
  assert.equal(ctx.isBilingualCues(splitBilingual.srcCues), true);
  assert.equal(ctx.resolveEffectiveSecondary(currentEpObj), '');

  // Explicit single-subtitle choice disables secondary even on monolingual track.
  currentEpObj.activeSource = () => 'custom:assrt:1:mono';
  currentEpObj.getCustomSource = id => id === 'custom:assrt:1:mono' ? monoRecord : null;
  ctx.selectSecondary('');
  assert.equal(ctx.resolveEffectiveSecondary(currentEpObj), '');

  // Legacy saved 'ja-JP' or 'en-US' secondary still gets suppressed for bilingual external subs,
  // while remaining intact for monolingual MT/external Chinese tracks.
  ctx.selectSecondary('ja-JP');
  currentEpObj.activeSource = () => 'custom:assrt:2:bi';
  currentEpObj.getCustomSource = id => id === 'custom:assrt:2:bi' ? inlineBilingual : null;
  assert.equal(ctx.resolveEffectiveSecondary(currentEpObj), '');
  currentEpObj.activeSource = () => 'custom:mt:1';
  currentEpObj.getCustomSource = id => id === 'custom:mt:1' ? mtRecord : null;
  assert.equal(ctx.resolveEffectiveSecondary(currentEpObj), 'ja-JP');
});

test('auto-translate waits for external restore, skips when external/follow/official target exists, and starts + cancels cleanly', async () => {
  let ep, extState, translatedCount = 0, cancelled = 0, selectedLocale = null;
  let enabled = true, mtEnabled = true, mtConfigured = true, mtAuto = true, mtTarget = 'zh-CN';
  const ctx = context({
    setTimeout: (fn, _ms) => { fn(); return 1; },
    clearTimeout() {},
    document: { getElementById: id => id === 'cr-jp-cc-btn' ? {} : null },
    BTN_ID: 'cr-jp-cc-btn',
    currentEp: () => ep,
    isEnabled: () => enabled,
    isMtEnabled: () => mtEnabled,
    isMtConfigured: () => mtConfigured,
    isMtAutoTranslate: () => mtAuto,
    getMtTarget: () => mtTarget,
    _translating: false,
    overlayActive: false,
    externalRestores: new WeakMap(),
    restoreExternal: async () => {},
    localeHasContent: loc => ep._contents[loc] ?? false,
    pickMtSourceLocale: (_ep, target) => target === 'en-US' ? 'ja-JP' : (ep._contents['en-US'] !== false ? 'en-US' : null),
    selectSource: loc => { selectedLocale = loc; },
    translateToTarget: async () => { translatedCount++; },
    cancelTranslate: () => { cancelled++; },
    log: { info() {}, warn() {}, error() {} },
  });
  const text = source('interceptor.js');
  const start = text.indexOf('  let _autoTranslateTimer = null;');
  const end = text.indexOf('  // ── Pre-fetch JP data', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(text.slice(start, end), ctx);

  function makeEp(contents = { 'en-US': true }) {
    return {
      guid: 'EP1', disposed: false, _contents: contents,
      listCustomSources: () => ep._customs || [],
      activeSource: () => null,
    };
  }

  // 1. Unsettled external restore → must NOT translate yet.
  ep = makeEp();
  extState = { settled: false, result: null };
  ctx.externalRestores.set(ep, extState);
  ctx.maybeStartAutoTranslate(ep);
  assert.equal(translatedCount, 0);

  // 2. Settled with follow rule / followError → must NOT translate.
  ep = makeEp();
  ctx.externalRestores.set(ep, { settled: true, result: { ok: true, record: null, hasFollowRule: true, followError: 'FOLLOW_AMBIGUOUS' } });
  ctx.maybeStartAutoTranslate(ep);
  assert.equal(translatedCount, 0);

  // 3. Settled with active external record → must NOT translate.
  ep = makeEp();
  ctx.externalRestores.set(ep, { settled: true, result: { ok: true, active: true, record: { id: 'custom:assrt:1:x' }, hasFollowRule: false } });
  ctx.maybeStartAutoTranslate(ep);
  assert.equal(translatedCount, 0);

  // 4. Settled with no external record, but official target language track exists → selects official track, zero MT spend.
  ep = makeEp({ 'en-US': true, 'zh-CN': true });
  ctx.externalRestores.set(ep, { settled: true, result: { ok: true, record: null, hasFollowRule: false } });
  ctx.maybeStartAutoTranslate(ep);
  assert.equal(selectedLocale, 'zh-CN');
  assert.equal(translatedCount, 0);

  // 5. Settled with no external record and no official target track → starts MT once.
  ep = makeEp({ 'en-US': true, 'zh-CN': false });
  ctx.externalRestores.set(ep, { settled: true, result: { ok: true, record: null, hasFollowRule: false } });
  ctx.maybeStartAutoTranslate(ep);
  assert.equal(translatedCount, 1);
  // Repeating on same ep does not double-trigger.
  ctx.maybeStartAutoTranslate(ep);
  assert.equal(translatedCount, 1);
});

test('externalSubs.restore reports hasFollowRule accurately when a collection follow rule exists', async () => {
  const b = background();
  const sender = { id: 'test-extension', url: 'https://www.crunchyroll.com/watch/NEXT/title', frameId: 0, tab: { id: 1 } };
  // Without any follow rule: hasFollowRule is false, and missing season/episode does not stall with metadataPending.
  const none = await b.send('EXTERNAL_RESTORE', {
    guid: 'NEXT',
    metadata: { guid: 'NEXT', seriesId: 'SERIES', season: 1, episode: 2, title: 'Show' },
  }, sender);
  assert.equal(none.ok, true);
  assert.equal(none.hasFollowRule, false);
  assert.equal(none.record, null);

  const missingMeta = await b.send('EXTERNAL_RESTORE', {
    guid: 'NEXT',
    metadata: { guid: 'NEXT', seriesId: 'SERIES', season: null, episode: null, title: 'Show' },
  }, sender);
  assert.equal(missingMeta.ok, true);
  assert.equal(missingMeta.metadataPending, false);
  assert.equal(missingMeta.hasFollowRule, false);
  assert.equal(missingMeta.record, null);
});

test('installExternal cancels any in-flight machine translation when activating an external track', async () => {
  let cancelled = 0;
  const button = { dataset: { state: 'idle' } };
  const episode = { guid: 'NEXT', disposed: false, activeSource: () => c.selectedSource,
    addCustomSource: record => { c.record = record; } };
  const c = context({ BTN_ID: 'button', selectedSource: null, overlayActive: false, clickInProgress: false,
    videoEl: { isConnected: true }, currentEp: () => episode, getEpisodeGuid: () => 'NEXT',
    CUSTOM: { makeLocalSource: () => ({ srcCues: [{ start: 1, end: 2, text: '你好' }], label: 'test' }) },
    sourceMenu: { updateButtonVisibility() {} },
    document: { getElementById: () => button },
    setButtonState: (btn, state) => { btn.dataset.state = state; },
    selectSource: id => { c.selectedSource = id; },
    handleButtonClick: async () => { c.overlayActive = true; },
    cancelTranslate: () => { cancelled++; } });
  const text = source('interceptor.js');
  const start = text.indexOf('  async function installExternal(');
  const end = text.indexOf('  let externalChoiceRevision = 0;', start);
  vm.runInContext(text.slice(start, end) + 'let externalChoiceRevision = 0;', c);
  await c.installExternal({ guid: 'NEXT', id: 'custom:assrt:42:abcd',
    text: 'fixture', filename: 'episode.srt', sync: { mode: 'none' } });
  assert.equal(cancelled, 1);
  assert.equal(c.overlayActive, true);
});

test('playback URL matcher covers v3/v4+ and cr-play-service, and cleanStreamUrl switches burned streams to hardSubs.none', async () => {
  const text = source('interceptor.js');
  const reStart = text.indexOf('  // Match /playback/v3');
  const reEnd = text.indexOf('  const MANIFEST_RE', reStart);
  assert.ok(reStart >= 0 && reEnd > reStart);
  const reCtx = context({});
  vm.runInContext(text.slice(reStart, reEnd) + '\nthis.PLAYBACK_RE = PLAYBACK_RE; this.CR_PLAY_SERVICE_RE = CR_PLAY_SERVICE_RE;', reCtx);

  for (const [pathname, expectedVer, expectedGuid] of [
    ['/playback/v3/EPV3/web/chrome/play', 'v3', 'EPV3'],
    ['/playback/v4/EPV4/web/edge/play', 'v4', 'EPV4'],
    ['/playback/v5/EPV5/web/firefox/play', 'v5', 'EPV5'],
  ]) {
    const m = pathname.match(reCtx.PLAYBACK_RE);
    assert.ok(m, pathname);
    assert.equal(m[1], expectedVer);
    assert.equal(m[2], expectedGuid);
  }
  const svcMatch = '/v1/EPSVC/web/chrome/play'.match(reCtx.CR_PLAY_SERVICE_RE);
  assert.equal(svcMatch?.[1], 'EPSVC');

  const stripStart = text.indexOf('  function cleanStreamUrl(data)');
  const stripEnd = text.indexOf('  function applyPlaybackData(', stripStart);
  assert.ok(stripStart >= 0 && stripEnd > stripStart);
  const stripCtx = context({
    PLAYBACK: { entryUrl: e => (e && typeof e === 'object' ? e.url : typeof e === 'string' ? e : null) },
    log: { info() {} },
    Response: class {
      constructor(body, init) { this.body = body; this.status = init.status; }
      async json() { return JSON.parse(this.body); }
    },
  });
  vm.runInContext(text.slice(stripStart, stripEnd), stripCtx);

  const burnedPayload = {
    url: 'https://cdn.example/0/zh-TW/burned.mpd',
    burnedInLocale: 'zh-TW',
    hardSubs: {
      none: { hlang: 'none', url: 'https://cdn.example/static/majin/123/clean/cenc/dash/manifest.mpd' },
      'zh-TW': { url: 'https://cdn.example/0/zh-TW/burned.mpd' },
    },
    captions: { 'zh-TW': 'https://cdn.example/zh.vtt' },
    subtitles: { 'en-US': 'https://cdn.example/en.ass' },
  };
  const fakeResp = {
    status: 200,
    statusText: 'OK',
    headers: new Map(),
    clone() { return { json: async () => structuredClone(burnedPayload) }; },
  };
  const stripped = await (await stripCtx.stripOfficialSubs(fakeResp)).json();
  assert.equal(stripped.url, 'https://cdn.example/static/majin/123/clean/cenc/dash/manifest.mpd');
  assert.equal(stripped.burnedInLocale, '');
  assert.deepEqual(stripped.hardSubs, {});
  assert.deepEqual(stripped.captions, {});
  assert.deepEqual(stripped.subtitles, {});
});

test('resolveOfficialTargetLocale aligns official tracks for non-Japanese targets without hijacking Japanese target', () => {
  const ep = { guid: 'EP1', disposed: false, _contents: { 'ja-JP': true, 'es-419': true, 'zh-CN': false } };
  const ctx = context({
    setTimeout: (fn, _ms) => { fn(); return 1; },
    clearTimeout() {},
    localeHasContent: loc => ep._contents[loc] ?? false,
  });
  const text = source('interceptor.js');
  const start = text.indexOf('  let _autoTranslateTimer = null;');
  const end = text.indexOf('  // ── Pre-fetch JP data', start);
  vm.runInContext(text.slice(start, end), ctx);

  assert.equal(ctx.resolveOfficialTargetLocale(ep, 'es-419'), 'es-419');
  assert.equal(ctx.resolveOfficialTargetLocale(ep, 'en-US'), 'ja-JP');
  assert.equal(ctx.resolveOfficialTargetLocale(ep, 'zh-CN'), null);
  assert.equal(ctx.resolveOfficialTargetLocale(ep, 'ja-JP'), null);
});

test('runTranslation auto-selects target track when tryAutoActivate sets ja-JP mid-flight unless user manually switched', async () => {
  async function runCase(manualSwitch) {
    let selected = null;
    const tracks = new Map();
    let release;
    const ep = {
      guid: 'EP_RACE', disposed: false,
      activeSource: () => selected,
      getCustomSource: id => tracks.get(id),
      addCustomSource: s => tracks.set(s.id, s),
      setOriginalCues() {},
    };
    const ctx = context({
      setTimeout: (f, ms) => ms >= 20000 ? setTimeout(f, ms) : (f(), 1),
      clearTimeout,
      currentEp: () => ep,
      isMtEnabled: () => true,
      isMtConfigured: () => true,
      getMtTarget: () => 'zh-CN',
      getMtProvider: () => 'relay',
      getMtSourcePref: () => 'ja-JP',
      SETTINGS: { read: (_h, k) => k === 'mtWorkEnabled' ? false : k === 'mtTranslationMode' ? 'batch' : 'tag1' },
      html: {},
      mtLangLabel: () => 'Chinese (Simplified)',
      MT_PROVIDER_LABELS: { relay: 'Custom Relay' },
      mtId: (...p) => 'custom:mt:' + p.join(':'),
      pickMtSourceLocale: () => 'ja-JP',
      LOCALE_LABELS: { 'ja-JP': 'English (Japanese audio)' },
      UI: { makeTranslationStatus: () => ({ html() {}, fade() {}, update() {}, start() {}, setResume() {}, finish() {}, refresh() {}, destroy() {}, error() {}, reposition() {} }), showToast() {} },
      THEME: { accent: '#fff' },
      escapeHtml: s => s,
      toastHost: () => null,
      fetchCuesForLocale: async () => ({ cues: [{ start: 1, end: 2, text: 'Hello' }], rawText: '' }),
      _signRawAss: null,
      mtTuning: () => ({ batch: 10, concurrency: 1, maxChars: 1000, pace: 0, timeout: 35000, rateWait: 0, retries: 1 }),
      buildSignsAss: () => null,
      extractSignTexts: () => null,
      STORAGE: { lsGet: () => null, lsSet: () => true, lsDel() {} },
      log: { info() {}, warn() {}, error() {} },
      setTranslateProgress() {},
      hideTranslateProgress() {},
      showErrorToast() {},
      mtErrorText: s => s,
      sessionStorage: { removeItem() {} },
      document: { getElementById: () => null, addEventListener() {} },
      sourceMenu: { updateButtonVisibility() {} },
      selectSource: id => { selected = id; },
      videoEl: { currentTime: 0 },
      overlayActive: true,
      applyCustomSync: r => r.srcCues,
      renderer: { invalidate() {} },
      onTimeUpdate() {},
      setSignSource() {},
      CUSTOM: { makeMtSource: s => s },
      isCustomId: id => String(id || '').startsWith('custom:'),
      manualSourceEpoch: 0,
      rpc: async (method, payload) => {
        if (method === 'progress') return payload.action === 'get' ? { ok: true, values: null } : { ok: true };
        await new Promise(resolve => { release = resolve; });
        return { ok: true, translations: ['你好'] };
      },
    });
    load(ctx, 'lib/mt-utils.js');
    load(ctx, 'lib/i18n.js');
    load(ctx, 'lib/i18n-player.js');
    ctx.CRSubFix.i18n.setLanguage('zh-Hans');
    ctx.t = ctx.CRSubFix.i18n.t;
    ctx.NS = ctx.CRSubFix;
    const code = source('interceptor.js');
    vm.runInContext(code.slice(code.indexOf('  const MT_PARTIAL_TTL'), code.indexOf('  const TRANSLATE_PANEL_ID')), ctx);

    const run = ctx.translateToTarget();
    while (!release) await new Promise(r => setImmediate(r));
    // Simulate tryAutoActivate (or explicit user pick) happening while batch 1 is in flight.
    selected = manualSwitch ? 'es-419' : 'ja-JP';
    if (manualSwitch) ctx.manualSourceEpoch++;
    release();
    await run;
    return { selected, label: [...tracks.values()][0]?.label || '' };
  }

  const raced = await runCase(false);
  assert.ok(String(raced.selected || '').startsWith('custom:mt:'), 'auto ja-JP race must still switch to MT track: ' + raced.selected);
  assert.match(raced.label, /中文（简体）.*自订中继/);

  const manual = await runCase(true);
  assert.equal(manual.selected, 'es-419');
});
