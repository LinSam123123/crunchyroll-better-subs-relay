import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { context, load, source, json } from './helpers.mjs';

// Exercise the shipped orchestration functions against synthetic episode/network adapters.
function workflow(options = {}) {
  const cache = new Map(), tracks = new Map(), requests = [], errors = [], actions = [];
  const durable = options.durable || new Map();
  const state = { tag: 'config-a', enabled: true, cues: [
    { start: 1, end: 2, text: 'Hello' }, { start: 3, end: 4, text: 'World' },
  ], selected: null, workToken: options.work ? 'work:revision-a' : '' };
  const ep = { guid: 'episode', disposed: false, getCustomSource: id => tracks.get(id),
    addCustomSource: s => tracks.set(s.id, s), activeSource: () => state.selected,
    setOriginalCues: cues => { state.rendered = json(cues); } };
  const ctx = context({
    setTimeout: (f, ms) => ms >= 20000 ? setTimeout(f, ms) : (f(), 1),
    clearTimeout,
    currentEp: () => ep, isMtEnabled: () => state.enabled, isMtConfigured: () => true,
    getMtTarget: () => 'zh-CN', getMtProvider: () => 'relay', getMtSourcePref: () => 'en-US',
    SETTINGS: { read: (_html, key) => key === 'mtWorkEnabled' ? !!options.work :
      key === 'mtTranslationMode' ? (options.stream ? 'episode-stream' : 'batch') : state.tag },
    html: {}, mtLangLabel: l => l, MT_PROVIDER_LABELS: { relay: 'Relay' },
    mtId: (...parts) => parts.join(':'), pickMtSourceLocale: () => 'en-US', LOCALE_LABELS: {},
    UI: { makeTranslationStatus: () => ({ html() {}, fade() {}, update() {},
      start() {}, setResume: callback => { state.resume = callback; },
      finish: ({ paused }) => { state.paused = paused; }, refresh() {}, destroy() {},
      error: (text, retry, label) => { errors.push(text); actions.push({ retry, label }); }, reposition() {} }), showToast() {} },
    THEME: { accent: 'white' }, escapeHtml: t => t, toastHost: () => null,
    fetchCuesForLocale: async () => options.fetch ? options.fetch() : ({ cues: state.cues, rawText: '' }), _signRawAss: null,
    mtTuning: () => ({ batch: options.batch || 1, concurrency: options.concurrency || 1,
      maxChars: 500, pace: 0, timeout: 35000, rateWait: 0, retries: 2 }),
    buildSignsAss: () => null, extractSignTexts: () => null,
    STORAGE: { lsGet: k => cache.get(k), lsSet: (k, v) => {
      if (options.storageFails) return false;
      cache.set(k, json(v)); return true;
    }, lsDel: k => cache.delete(k) },
    log: { info() {}, warn() {}, error() {} }, setTranslateProgress() {}, hideTranslateProgress() {},
    showErrorToast: text => errors.push(text), mtErrorText: e => e,
    sessionStorage: { removeItem() {} }, document: { getElementById: () => null, addEventListener() {} },
    sourceMenu: { updateButtonVisibility() {} }, selectSource: id => { state.selected = id; },
    videoEl: { currentTime: options.time || 0 }, overlayActive: true,
    applyCustomSync: record => record.srcCues, renderer: { invalidate() {} },
    onTimeUpdate() {}, setSignSource() {},
    CUSTOM: { makeMtSource: s => s },
    rpcStream: async (p, accept, stopReason, _timeout, onIssue) => {
      requests.push(json(p));
      const commit = (index, text, deliver = true) => {
        const values = durable.get(p.cache.key) || Array(p.cache.total).fill(null);
        values[index] = text;
        durable.set(p.cache.key, json(values));
        if (deliver) accept(index, text);
      };
      if (options.stream) return options.stream(p, commit, stopReason, state, ep, onIssue);
      return { ok: false, error: 'TEST_UNEXPECTED_STREAM' };
    },
    rpc: async (_method, p) => {
      if (_method === 'work-context') return { ok: true, token: state.workToken };
      if (_method === 'progress') {
        if (options.cacheUnavailable) return { ok: false, error: 'CACHE_UNAVAILABLE' };
        if (p.action === 'get') return { ok: true, values: durable.get(p.key) || null };
        if (options.durableFails) return { ok: false, error: 'CACHE_UNAVAILABLE' };
        const values = durable.get(p.key) || Array(p.total).fill(null);
        for (const { index, text } of p.entries) values[index] = text;
        durable.set(p.key, json(values));
        return { ok: true };
      }
      requests.push(json(p));
      return options.rpc ? options.rpc(p, requests.length, state, ep)
        : { ok: true, translations: p.texts.map(t => `译文:${t}`) };
    },
  });
  load(ctx, 'lib/mt-utils.js');
  ctx.NS = ctx.CRSubFix;
  const code = source('interceptor.js');
  vm.runInContext(code.slice(code.indexOf('  const MT_PARTIAL_TTL'), code.indexOf('  const TRANSLATE_PANEL_ID')) +
    '\nself.run = translateToTarget; self.cancel = cancelTranslate; self.pause = () => { _translatePause = true; };', ctx);
  return { ctx, state, ep, requests, errors, actions, cache, tracks, durable };
}
test('translated cues preserve timestamps and order, repeat translation uses completed cache', async () => {
  const w = workflow();
  await w.ctx.run();
  assert.equal(w.requests.length, 2);
  assert.equal(w.tracks.size, 1);
  const track = [...w.tracks.values()][0];
  assert.deepEqual(json(track.srcCues), [
    { start: 1, end: 2, text: '译文:Hello', srcText: 'Hello', translationStatus: 'translated' },
    { start: 3, end: 4, text: '译文:World', srcText: 'World', translationStatus: 'translated' },
  ]);
  await w.ctx.run();
  assert.equal(w.requests.length, 2);
  assert.equal(w.cache.size, 0);
});
test('episode stream publishes complete cues before final result and resumes only missing stable ids', async () => {
  let fail = true;
  const w = workflow({ stream: async (p, commit) => {
    if (fail) {
      commit(+p.items[0].id, 'first');
      return { ok: false, error: 'INCOMPLETE_RESPONSE' };
    }
    for (const item of p.items) commit(+item.id, 'second');
    return { ok: true };
  } });
  await w.ctx.run();
  assert.equal(w.requests.length, 1);
  assert.deepEqual(w.requests[0].items.map(i => i.id), ['0', '1']);
  assert.equal([...w.tracks.values()][0].srcCues[0].text, 'first');
  assert.equal([...w.tracks.values()][0].incomplete, true);
  fail = false;
  await w.actions.at(-1).retry();
  assert.equal(w.requests.length, 2);
  assert.deepEqual(w.requests[1].items.map(i => i.id), ['1']);
  assert.deepEqual(json([...w.tracks.values()][0].srcCues.map(c => c.text)), ['first', 'second']);
});
test('stream resume reads worker commits missed by the page and does not spend again', async () => {
  const w = workflow({ stream: async (_p, commit) => {
    commit(0, 'first');
    commit(1, 'saved but not delivered', false);
    return { ok: false, error: 'STREAM_DISCONNECTED' };
  } });
  await w.ctx.run();
  await w.actions.at(-1).retry();
  assert.equal(w.requests.length, 1);
  assert.equal([...w.tracks.values()][0].incomplete, false);
  assert.equal([...w.tracks.values()][0].srcCues[1].text, 'saved but not delivered');
});
test('stream item issue preserves later cues and identifies only the pending subtitle for manual retry', async () => {
  let reject = true;
  const w = workflow({ stream: async (p, commit, _stop, _state, _ep, onIssue) => {
    if (reject) {
      onIssue({ index: 0, reason: 'EMPTY_TEXT', resolved: false });
      commit(1, 'later valid cue');
      return { ok: false, error: 'STREAM_ITEMS_PENDING',
        details: { missingCount: 1, items: [{ index: 0, reason: 'EMPTY_TEXT' }] } };
    }
    assert.deepEqual(json(p.items.map(i => i.id)), ['0']);
    commit(0, 'repaired cue');
    return { ok: true };
  } });
  await w.ctx.run();
  assert.equal(w.requests.length, 1);
  assert.match(w.errors[0], /subtitle #1 at 0:01 \(empty text\)/);
  assert.deepEqual(json([...w.tracks.values()][0].srcCues.map(c => c.translationStatus)), ['pending', 'translated']);
  reject = false;
  await w.actions.at(-1).retry();
  assert.equal(w.requests.length, 2);
  assert.deepEqual(json([...w.tracks.values()][0].srcCues.map(c => c.text)), ['repaired cue', 'later valid cue']);
  assert.equal([...w.tracks.values()][0].incomplete, false);
});
test('stream pause keeps completed cues, then resume requests only the remainder', async () => {
  let paused = false;
  const w = workflow({ stream: async (p, commit, stopReason) => {
    if (!paused) {
      commit(0, 'first');
      w.ctx.pause(); paused = true;
      assert.equal(stopReason(), 'STREAM_PAUSED');
      return { ok: false, error: 'STREAM_PAUSED' };
    }
    assert.deepEqual(json(p.items.map(i => i.id)), ['1']);
    commit(1, 'second');
    return { ok: true };
  } });
  await w.ctx.run();
  assert.equal(w.errors.length, 0);
  assert.equal(w.state.paused, true);
  await w.state.resume();
  assert.equal([...w.tracks.values()][0].incomplete, false);
});
test('same-length changed source and changed config do not reuse old translations', async () => {
  const w = workflow();
  await w.ctx.run();
  w.state.cues[0].text = 'Other';
  await w.ctx.run();
  assert.equal(w.requests.length, 4);
  w.state.tag = 'config-b';
  await w.ctx.run();
  assert.equal(w.requests.length, 6);
  assert.equal(w.tracks.size, 3);
});
test('confirmed work revision separates completed caches without deleting previous subtitles', async () => {
  const w = workflow({ work: true });
  await w.ctx.run();
  assert.equal(w.requests.length, 2);
  assert.ok(w.requests.every(p => p.workToken === 'work:revision-a'));
  await w.ctx.run();
  assert.equal(w.requests.length, 2);
  w.state.workToken = 'work:revision-b';
  await w.ctx.run();
  assert.equal(w.requests.length, 4);
  assert.equal(w.tracks.size, 2);
  assert.equal(w.durable.size, 2);
  assert.ok(w.requests.slice(2).every(p => p.workToken === 'work:revision-b'));
});
test('manual retry after work revision change stops before spending or mixing retained output', async () => {
  const w = workflow({ work: true, rpc: async (_p, n) => n === 1
    ? { ok: true, translations: ['first'] } : { ok: false, error: 'INCOMPLETE_RESPONSE' } });
  await w.ctx.run();
  assert.equal(w.requests.length, 2);
  w.state.workToken = 'work:revision-b';
  await w.actions.at(-1).retry();
  assert.equal(w.requests.length, 2);
  assert.match(w.errors.at(-1), /RESUME_CONTEXT_CHANGED/);
});
test('timeout stops without automatic retry; explicit retry resumes completed batches', async () => {
  let fail = true;
  const w = workflow({ rpc: async (p, n) => n === 2 && fail
    ? { ok: false, error: 'TIMEOUT_UNKNOWN' } : { ok: true, translations: p.texts.map(t => `译文:${t}`) } });
  await w.ctx.run();
  assert.equal(w.requests.length, 2);
  assert.equal(w.tracks.size, 1);
  assert.equal([...w.tracks.values()][0].incomplete, true);
  assert.deepEqual(json([...w.tracks.values()][0].srcCues.map(c => c.translationStatus)), ['translated', 'pending']);
  assert.equal(w.durable.size, 1);
  fail = false;
  await w.ctx.run();
  assert.equal(w.requests.length, 3);
  assert.deepEqual(w.requests[2].texts, ['World']);
  assert.equal(w.tracks.size, 1);
});
test('episode change or configuration change discards in-flight output', async () => {
  for (const change of [(state, ep) => { ep.disposed = true; }, state => { state.tag = 'new'; }]) {
    const w = workflow({ rpc: async (p, n, state, ep) => {
      change(state, ep); return { ok: true, translations: p.texts };
    } });
    await w.ctx.run();
    assert.equal(w.tracks.size, 0);
    assert.equal(w.requests.length, 1);
  }
});
test('parallel translate clicks only start one operation', async () => {
  let release;
  const w = workflow({ rpc: (p, n) => n === 1 ? new Promise(r => { release = r; })
    : { ok: true, translations: p.texts } });
  const first = w.ctx.run();
  while (!release) await new Promise(r => setImmediate(r));
  await w.ctx.run();
  assert.equal(w.requests.length, 1);
  release({ ok: true, translations: ['你好'] });
  await first;
  assert.equal(w.requests.length, 2);
});
test('manual cancellation stops new requests and never installs partial track', async () => {
  let w;
  w = workflow({ rpc: async p => { w.ctx.cancel(); return { ok: true, translations: p.texts }; } });
  await w.ctx.run();
  assert.equal(w.requests.length, 1);
  assert.equal(w.tracks.size, 0);
});
test('subtitle loading failure is persistent and does not send a paid request', async () => {
  const w = workflow({ fetch: async () => null });
  await w.ctx.run();
  assert.equal(w.requests.length, 0);
  assert.match(w.errors[0], /SOURCE_SUBTITLES_UNAVAILABLE/);
});
test('startup exception is reported rather than silently swallowed', async () => {
  const w = workflow({ fetch: async () => { throw new TypeError('fixture failure'); } });
  await w.ctx.run();
  assert.equal(w.requests.length, 0);
  assert.match(w.errors[0], /CLIENT_ERROR/);
});
test('parallel out-of-order responses preserve subtitle order and unique request ids', async () => {
  const releases = [];
  const w = workflow({ concurrency: 2, rpc: (p, n) => n === 1
    ? { ok: true, translations: p.texts.map(t => `译文:${t}`) } : new Promise(resolve => releases.push(() =>
    resolve({ ok: true, translations: p.texts.map(t => `译文:${t}`) }))) });
  w.state.cues.push({ start: 5, end: 6, text: 'Third' });
  const running = w.ctx.run();
  while (releases.length < 2) await new Promise(r => setImmediate(r));
  await w.ctx.run();
  assert.equal(w.requests.length, 3);
  assert.notEqual(w.requests[0].requestId, w.requests[1].requestId);
  releases[1]();
  await new Promise(r => setImmediate(r));
  assert.equal([...w.tracks.values()][0].incomplete, true);
  releases[0]();
  await running;
  assert.deepEqual(json([...w.tracks.values()][0].srcCues.map(c => c.text)), ['译文:Hello', '译文:World', '译文:Third']);
});
test('failure drains sibling request, saves its result, and explicit retry sends only missing work', async () => {
  let release;
  const w = workflow({ concurrency: 2, rpc: (p, n) => n === 2
    ? { ok: false, error: 'TIMEOUT_UNKNOWN' }
    : n === 3 ? new Promise(r => { release = r; }) : { ok: true, translations: p.texts } });
  w.state.cues.push({ start: 5, end: 6, text: 'Third' });
  const running = w.ctx.run();
  while (!release) await new Promise(r => setImmediate(r));
  assert.equal(w.errors.length, 0);
  release({ ok: true, translations: ['Third translated'] });
  await running;
  assert.equal(w.requests.length, 3);
  assert.equal([...w.tracks.values()][0].incomplete, true);
  await w.actions[0].retry();
  assert.equal(w.requests.length, 4);
  assert.deepEqual(w.requests[3].texts, ['World']);
  assert.equal(w.tracks.size, 1);
});
test('format failure offers explicit smaller-batch retry without resending completed batches', async () => {
  const w = workflow({ batch: 2, concurrency: 2, rpc: (p, n) => n === 1
    ? { ok: false, error: 'DUPLICATE_ITEM_ID' } : { ok: true, translations: p.texts } });
  await w.ctx.run();
  assert.equal(w.requests.length, 1);
  assert.equal(w.actions[0].label, 'Retry smaller batches');
  assert.match(w.errors[0], /additional charges/);
  await w.actions[0].retry();
  assert.equal(w.requests.length, 3);
  assert.ok(w.requests.slice(1).every(p => p.texts.length === 1));
  assert.equal(w.tracks.size, 1);
});
test('smaller retry retains progress despite storage failure and changing source fetch results', async () => {
  let fetches = 0;
  const cues = Array.from({ length: 6 }, (_, i) => ({ start: i, end: i + 1, text: `line-${i}` }));
  const w = workflow({ batch: 2, concurrency: 2, storageFails: true,
    fetch: () => { fetches++; return { cues, rawText: '' }; },
    rpc: (p, n) => n === 2 ? { ok: false, error: 'ITEM_COUNT_MISMATCH' } : { ok: true, translations: p.texts },
  });
  await w.ctx.run();
  assert.equal(w.cache.size, 0);
  assert.match(w.errors[0], /saved/);
  cues[0].text = 'changed-source';
  await w.actions[0].retry();
  assert.equal(fetches, 1);
  assert.equal(w.ctx.CRSubFix.lastTranslationStats.resumed, 4);
  assert.equal(w.ctx.CRSubFix.lastTranslationStats.batchSize, 1);
  assert.deepEqual(w.requests.slice(3).map(p => p.texts), [['line-2'], ['line-3']]);
  assert.equal(w.tracks.size, 1);
});
test('first batch is visible while next batch is pending, with source text fallback', async () => {
  let release;
  const w = workflow({ rpc: (p, n) => n === 2 ? new Promise(r => { release = r; })
    : { ok: true, translations: ['first translated'] } });
  const run = w.ctx.run();
  while (!release) await new Promise(r => setImmediate(r));
  const record = [...w.tracks.values()][0];
  assert.equal(record.incomplete, true);
  assert.deepEqual(json(record.srcCues.map(c => c.text)), ['first translated', 'World']);
  assert.equal(w.state.selected, record.id);
  release({ ok: true, translations: ['second translated'] });
  await run;
  assert.equal([...w.tracks.values()][0].incomplete, false);
});
test('refresh restores extension-stored results even when site storage is unavailable', async () => {
  const durable = new Map();
  const first = workflow({ durable, storageFails: true, rpc: (p, n) => n === 2
    ? { ok: false, error: 'TIMEOUT_UNKNOWN' } : { ok: true, translations: ['retained'] } });
  await first.ctx.run();
  const refreshed = workflow({ durable, storageFails: true });
  await refreshed.ctx.run();
  assert.equal(refreshed.requests.length, 1);
  assert.deepEqual(refreshed.requests[0].texts, ['World']);
  assert.equal(refreshed.ctx.CRSubFix.lastTranslationStats.resumed, 1);
});
test('failed extension cache read stops before paid work; failed write retains visible output', async () => {
  const blocked = workflow({ cacheUnavailable: true });
  await blocked.ctx.run();
  assert.equal(blocked.requests.length, 0);
  const options = { durableFails: true };
  const w = workflow(options);
  await w.ctx.run();
  assert.equal(w.requests.length, 1);
  assert.match(w.errors[0], /CACHE_SAVE_FAILED/);
  assert.equal([...w.tracks.values()][0].incomplete, true);
  options.durableFails = false;
  await w.actions[0].retry();
  assert.equal(w.requests.length, 2);
  assert.deepEqual(w.requests[1].texts, ['World']);
});
test('a seek reprioritizes unsent batches without duplicating completed work', async () => {
  let w;
  w = workflow({ rpc: (p, n) => {
    if (n === 1) w.ctx.videoEl.currentTime = 50;
    return { ok: true, translations: p.texts };
  } });
  w.state.cues = Array.from({ length: 6 }, (_, i) => ({ start: i * 10, end: i * 10 + 8, text: `cue-${i}` }));
  await w.ctx.run();
  assert.deepEqual(w.requests.map(p => p.texts[0]), ['cue-0', 'cue-5', 'cue-4', 'cue-3', 'cue-2', 'cue-1']);
});
test('progressive updates do not override a manual source switch', async () => {
  const w = workflow({ rpc: (p, n, state) => {
    if (n === 2) state.selected = 'native-track';
    return { ok: true, translations: p.texts };
  } });
  await w.ctx.run();
  assert.equal(w.state.selected, 'native-track');
  assert.equal([...w.tracks.values()][0].incomplete, false);
});
test('startup near the middle uses a small first batch and chronological context within each batch', async () => {
  const w = workflow({ batch: 30, time: 200 });
  w.state.cues = Array.from({ length: 60 }, (_, i) => ({ start: i * 10, end: i * 10 + 8, text: `cue-${i}` }));
  await w.ctx.run();
  assert.equal(w.requests[0].texts.length, 15);
  assert.equal(w.requests[0].texts[0], 'cue-20');
  for (const p of w.requests) {
    const indices = p.texts.map(t => Number(t.slice(4)));
    assert.deepEqual(indices, [...indices].sort((a, b) => a - b));
  }
});
test('pause drains and saves in-flight work; resume sends only pending subtitles', async () => {
  let release;
  const w = workflow({ rpc: (p, n) => n === 1 ? new Promise(r => { release = r; })
    : { ok: true, translations: p.texts } });
  const running = w.ctx.run();
  while (!release) await new Promise(r => setImmediate(r));
  w.ctx.pause();
  release({ ok: true, translations: ['saved before pause'] });
  await running;
  assert.equal(w.requests.length, 1);
  assert.equal(w.state.paused, true);
  assert.equal([...w.tracks.values()][0].srcCues[0].text, 'saved before pause');
  await w.state.resume();
  assert.equal(w.requests.length, 2);
  assert.deepEqual(w.requests[1].texts, ['World']);
  assert.equal([...w.tracks.values()][0].incomplete, false);
});
test('explicit retry fails closed when episode/config changes instead of starting from scratch', async () => {
  const w = workflow({ rpc: () => ({ ok: false, error: 'TIMEOUT_UNKNOWN' }) });
  await w.ctx.run();
  w.state.tag = 'changed-config';
  await w.actions[0].retry();
  assert.equal(w.requests.length, 1);
  assert.match(w.errors.at(-1), /RESUME_CONTEXT_CHANGED/);
});
test('requests carry actual subtitle indices and timing for audit, without changing cue ids or ordering', async () => {
  const w = workflow();
  await w.ctx.run();
  assert.deepEqual(w.requests.map(r => r.indices), [[0], [1]]);
  assert.deepEqual(w.requests[0].timings, [{ start: 1, end: 2 }]);
  assert.equal(w.requests[0].cache.total, 2);
  assert.equal([...w.tracks.values()][0].reviewCacheKey, w.requests[0].cache.key);
});
test('a completed in-memory track reloads local corrections from trusted cache without a paid request', async () => {
  const w = workflow();
  await w.ctx.run();
  const key = [...w.durable.keys()][0], before = w.requests.length;
  w.durable.get(key)[0] = '已在资料页修正';
  await w.ctx.run();
  assert.equal(w.requests.length, before);
  assert.equal([...w.tracks.values()][0].srcCues[0].text, '已在资料页修正');
});
