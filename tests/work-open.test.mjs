import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { context, load, source, json, background, savePayload } from './helpers.mjs';

function opener({ cues = [], records = [], active = 'ja-JP', fetcher = async () => ({ cues: [] }), respond } = {}) {
  const calls = [], notices = [];
  const ep = { guid: 'ABC', disposed: false, originalCues: cues,
    activeSource: () => active, listCustomSources: () => records };
  let current = ep;
  const ctx = context({
    currentEp: () => current, UI: { showToast: p => notices.push(p.text) }, toastHost: () => null,
    document: {}, log: { warn() {} }, pickMtSourceLocale: () => 'en-US', getMtTarget: () => 'zh-CN',
    fetchCuesForLocale: fetcher,
    rpc: async (method, payload, timeout) => {
      calls.push({ method, payload: json(payload), timeout });
      return respond ? respond(method, payload) : { ok: true, snapshot: 'snapshot-key' };
    },
  });
  load(ctx, 'lib/mt-utils.js');
  ctx.NS = ctx.CRSubFix;
  const code = source('interceptor.js');
  vm.runInContext('let _openingWork = false;\n' +
    code.slice(code.indexOf('  async function openWorkProfile()'), code.indexOf('  // Export only captured text.')) +
    '\nself.openWork = openWorkProfile;', ctx);
  return { ctx, ep, calls, notices, navigate: () => { current = null; ep.disposed = true; } };
}
test('work editor opens before a stalled subtitle fetch, then supplements its source snapshot', async () => {
  let release;
  const w = opener({ fetcher: () => new Promise(resolve => { release = resolve; }) });
  const pending = w.ctx.openWork();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal(w.calls[0].method, 'work-open');
  assert.equal(w.calls[0].payload.loading, true);
  assert.deepEqual(w.calls[0].payload.corpus, []);
  await w.ctx.openWork();
  assert.equal(w.calls.length, 1, 'Repeated click while opening cannot spawn another tab');
  release({ cues: [{ text: 'Yuki, hello.' }] });
  await pending;
  assert.equal(w.calls[1].method, 'work-update');
  assert.deepEqual(w.calls[1].payload.corpus, ['Yuki, hello.']);
});
test('active translated track supplies original source text without a subtitle network request', async () => {
  let fetches = 0;
  const w = opener({ active: 'current', records: [
    { id: 'old', kind: 'mt', mtSource: 'en-US', srcCues: [{ text: '旧译文', srcText: 'Old source' }] },
    { id: 'current', kind: 'mt', mtSource: 'en-US', srcCues: [{ text: '中文译文', srcText: 'Current source' }] },
    { id: 'newer-other', kind: 'mt', mtSource: 'en-US', srcCues: [{ text: '其他', srcText: 'Other source' }] },
  ], fetcher: async () => { fetches++; return null; } });
  await w.ctx.openWork();
  assert.equal(fetches, 0);
  assert.equal(w.calls.length, 1);
  assert.deepEqual(w.calls[0].payload.samples, ['Current source']);
  assert.equal(w.calls[0].payload.loading, false);
});
test('subtitle failure leaves the editor open with an unavailable snapshot; navigation discards stale fetches', async () => {
  const w = opener({ fetcher: async () => { throw new Error('subtitle failure'); } });
  await w.ctx.openWork();
  assert.deepEqual(w.calls.map(c => c.method), ['work-open', 'work-update']);
  assert.deepEqual(w.calls[1].payload.corpus, []);
  let release;
  const other = opener({ fetcher: () => new Promise(resolve => { release = resolve; }) });
  const pending = other.ctx.openWork();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  other.navigate(); release({ cues: [{ text: 'wrong episode' }] }); await pending;
  assert.equal(other.calls.length, 1);
});
test('failed opening and missing episode show feedback and do not leave the click locked', async () => {
  const w = opener({ respond: async () => ({ ok: false, error: 'BACKGROUND_UNAVAILABLE' }) });
  await w.ctx.openWork();
  assert.match(w.notices.at(-1), /刷新当前播放页/);
  await w.ctx.openWork();
  assert.equal(w.calls.length, 2);
  w.navigate();
  await w.ctx.openWork();
  assert.match(w.notices.at(-1), /尚未就绪/);
});
test('background source supplementation is scoped to tab/episode and cannot overwrite saved metadata', async () => {
  const app = background();
  await app.send('MT_SAVE_CONFIG', savePayload());
  app.ctx.chrome.tabs.create = async () => ({ id: 7 });
  app.ctx.chrome.tabs.sendMessage = async () => ({ guid: 'ABC' });
  const opened = await app.send('WORK_OPEN', { guid: 'ABC', loading: true, samples: [], corpus: [] }, app.content);
  assert.equal(opened.ok, true);
  const p = { snapshot: opened.snapshot, guid: 'ABC', samples: ['English'], corpus: ['English'],
    target: 'ja-JP', workHint: { title: 'forged' } };
  assert.equal((await app.send('WORK_GENERATE', { snapshot: opened.snapshot, title: 'Test' })).error, 'WORK_SUBTITLES_LOADING');
  assert.equal((await app.send('WORK_UPDATE', p, { ...app.content, tab: { id: 2 } })).error, 'WORK_CONTEXT_EXPIRED');
  assert.equal((await app.send('WORK_UPDATE', { ...p, guid: 'OTHER' }, app.content)).error, 'SENDER_NOT_ALLOWED');
  assert.equal((await app.send('WORK_SNAPSHOT_GET', { snapshot: opened.snapshot }, app.content)).error, 'SENDER_NOT_ALLOWED');
  assert.equal((await app.send('WORK_UPDATE', p, app.content)).ok, true);
  const result = await app.send('WORK_SNAPSHOT_GET', { snapshot: opened.snapshot });
  assert.equal(result.snapshot.subtitleState, 'ready');
  assert.equal(result.snapshot.target, 'zh-CN');
  assert.notEqual(result.snapshot.hint.title, 'forged');
  assert.deepEqual(result.snapshot.corpus, ['English']);
  assert.equal(app.calls.filter(c => Array.isArray(c) && c[0] === 'fetch').length, 0);
});
test('failed browser tab creation has an explicit error and removes the abandoned snapshot', async () => {
  const app = background();
  app.ctx.chrome.tabs.create = async () => { throw new Error('internal browser error'); };
  const result = await app.send('WORK_OPEN', { guid: 'ABC', samples: [] }, app.content);
  assert.equal(result.error, 'WORK_OPEN_FAILED');
  assert.ok(!Object.keys(app.session).some(k => k.startsWith('mtWorkSnapshot:')));
});
test('invalidated extension context reports bridge failure synchronously instead of leaving the click unanswered', () => {
  const replies = [];
  const ctx = context({ data: { method: 'work-open' }, payload: {},
    MSG: { WORK_OPEN: 'WORK_OPEN' }, reply: value => replies.push(json(value)),
    chrome: { runtime: { sendMessage: () => { throw new Error('Extension context invalidated.'); } } } });
  const code = source('content.js');
  const start = code.indexOf("    } else if (['work-open', 'work-context', 'work-update']");
  const end = code.indexOf("    } else {\n      reply({ ok: false, error: 'unknown-method'", start);
  assert.ok(start > 0 && end > start);
  vm.runInContext(code.slice(start, end).replace(/^    } else if/, 'if') + '\n}', ctx);
  assert.deepEqual(replies, [{ ok: false, error: 'BACKGROUND_UNAVAILABLE' }]);
});
