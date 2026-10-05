import test from 'node:test';
import assert from 'node:assert/strict';
import { context, load, background, relayContext, config } from './helpers.mjs';

const KEY = 'synthetic-jimaku-key-only';
const title = { id: 123, name: 'Synthetic Academy', english_name: 'Synthetic Academy', japanese_name: 'Test',
  anilist_id: 1001, flags: { anime: true, external: false, unverified: false }, last_modified: '2026-10-04T00:00:00Z' };
const name = ep => `[Test] Academy S01E0${ep} (WEB).srt`;
const srt = '1\n00:00:02,000 --> 00:00:10,000\nこんにちは。これはテストです。\n';
const file = ep => ({ name: name(ep), size: 100, url: `https://jimaku.cc/entry/123/download/${encodeURIComponent(name(ep))}` });
const response = (v, status = 200, headers) => new Response(typeof v === 'string' ? v : JSON.stringify(v), { status, headers });
function adapter() { const c = context({ fetch: async () => { throw new Error('UNEXPECTED_NETWORK'); } }); load(c, 'lib/assrt.js'); load(c, 'lib/jimaku.js'); return c.CRSubFix.jimaku; }
async function setup({ files = [file(1), file(2)], fetcher } = {}) {
  let guid = 'ABC'; const calls = [], opened = [], applied = [];
  const app = background({ data: { jimakuApiKey: KEY, assrtApiKey: 'a'.repeat(32), subdlApiKey: 'synthetic-subdl-only' }, fetcher: async (url, init) => {
    calls.push({ url, init });
    if (fetcher) return fetcher(url, init);
    const u = new URL(url);
    if (u.pathname.endsWith('/search')) return response([title]);
    if (u.pathname.endsWith('/files')) return response(files);
    if (u.pathname === '/api/entries/123') return response(title);
    return response(srt);
  } });
  app.ctx.chrome.tabs.create = async value => { opened.push(value); return { id: 2 }; };
  app.ctx.chrome.tabs.sendMessage = async (_, msg) => {
    if (msg.type === 'WORK_PAGE_CHECK') return { guid, url: `https://www.crunchyroll.com/watch/${guid}/title` };
    if (msg.type === 'EXTERNAL_APPLY') { applied.push(msg.payload); return { ok: true }; }
  };
  const meta = { guid, seriesId: 'SERIES', title: title.name, season: 1, episode: 1 };
  await app.send('EXTERNAL_OPEN', { guid, metadata: meta }, app.content);
  const snapshot = new URL(opened[0].url).searchParams.get('snapshot');
  const send = (type, payload = {}, sender) => app.send(type, { snapshot, source: 'jimaku', ...payload }, sender);
  assert.equal((await send('EXTERNAL_SEARCH', { query: title.name, metadata: meta })).ok, true);
  return { app, meta, send, calls, opened, applied, navigate: g => { guid = g; } };
}
const preview = (w, ep = 1) => w.send('EXTERNAL_PREVIEW', { id: '123', filename: name(ep), fileId: name(ep) });

test('Jimaku uses official raw auth and client header; AniList id takes priority over fuzzy query', async () => {
  const J = adapter(); let seen, init;
  const values = await J.search(KEY, '', { anilistId: 1001 }, async (url, opts) => { seen = new URL(url); init = opts; return response([title]); });
  assert.equal(seen.href, 'https://jimaku.cc/api/entries/search?anime=true&anilist_id=1001');
  assert.equal(seen.searchParams.has('query'), false); assert.equal(init.headers.Authorization, KEY);
  assert.match(init.headers['X-Client-Id'], /BetterSubs/); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
  assert.equal(values[0].kind, 'directory'); assert.equal(values[0].anilistId, '1001');
  assert.ok(!JSON.stringify(values).includes(KEY));
  for (const key of ['', 'bad key', 'line\nbreak']) assert.throws(() => J.token(key), /JIMAKU_INVALID_KEY/);
  await assert.rejects(J.search(KEY, 'a'), /JIMAKU_INVALID_QUERY/);
  await assert.rejects(J.search(KEY, '', { anilistId: '0' }), /JIMAKU_INVALID_ID/);
});

test('Jimaku errors are sanitized; fractional/reset rate headers produce bounded cooldown', async () => {
  const J = adapter();
  for (const status of [401, 403]) await assert.rejects(J.search(KEY, 'Academy', {}, async () => response({}, status)), /JIMAKU_AUTH_FAILED/);
  await assert.rejects(J.search(KEY, 'Academy', {}, async () => response({}, 429, { 'x-ratelimit-reset-after': '2.4' })), e => e.message === 'JIMAKU_RATE_LIMIT' && e.retryAfter === 3);
  await assert.rejects(J.search(KEY, 'Academy', {}, async () => response({}, 429, { 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 30) })), e => e.retryAfter >= 30 && e.retryAfter <= 31);
  await assert.rejects(J.search(KEY, 'Academy', {}, async () => { throw new DOMException(KEY, 'TimeoutError'); }), /^Error: JIMAKU_API_TIMEOUT$/);
  await assert.rejects(J.search(KEY, 'Academy', {}, async () => response({ error: KEY })), /^Error: JIMAKU_SERVICE_ERROR$/);
  await assert.rejects(J.search(KEY, 'Academy', {}, async () => response('not json')), /JIMAKU_INVALID_RESPONSE/);
});

test('Jimaku URL validation is directory/file-specific and download carries no credentials', async () => {
  const J = adapter(), raw = file(1);
  for (const url of ['http://jimaku.cc/entry/123/download/a.srt', 'https://evil.net/entry/123/download/a.srt',
    'https://jimaku.cc/entry/124/download/a.srt', 'https://u:p@jimaku.cc/entry/123/download/a.srt',
    'https://jimaku.cc/entry/123/download/a%2fb.srt', raw.url + '?key=x', raw.url + '#x'])
    assert.throws(() => J.downloadUrl(url, 123, name(1)), /JIMAKU_DOWNLOAD_UNSAFE/);
  let init;
  const value = { id: '123', files: [{ ...raw, format: 'srt', fileId: name(1), language: '未确定' }] };
  const r = await J.download(value, name(1), 'auto', async (_, opts) => { init = opts; return response(srt); });
  assert.equal(r.text, srt); assert.equal(init.headers, undefined); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
  await assert.rejects(J.download(value, name(1), 'auto', async () => response('<html>login</html>')), /JIMAKU_INVALID_FILE/);
  await assert.rejects(J.download({ ...value, files: [value.files[0], value.files[0]] }, name(1)), /JIMAKU_FILE_CHANGED/);
});

test('Jimaku preserves latest meaningful API rate when file server has no rate headers', async () => {
  const J = adapter();
  await J.search(KEY, 'Academy', {}, async () => response([title], 200, { 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '98' }));
  await J.download({ id: '123', files: [{ ...file(1), format: 'srt' }] }, name(1), 'auto', async () => response(srt));
  assert.equal(J.rate().remaining, 98); assert.equal(J.rate().limit, 100);
});

test('Jimaku inspects explicit filename languages and kana; Han-only text remains unknown', async () => {
  const J = adapter();
  const files = ['Academy E01.en.srt', 'Academy E01.chs.srt', 'Academy E01.srt', 'Academy E01.ja[cc].srt'].map(n => ({ name: n, size: 100, url: `/entry/123/download/${encodeURIComponent(n)}` }));
  const d = await J.detail(KEY, 123, async url => response(url.endsWith('/files') ? files : title));
  assert.deepEqual([...d.files.map(f => f.language)], ['英语', '简体中文', '未确定', '日语']);
  assert.equal(J.detectLanguage([{ text: 'こんにちは。これはテストです。' }], '未确定'), '日语（字符推断）');
  assert.equal(J.detectLanguage([{ text: '中文或者漢字' }], '未确定'), '未确定');
  assert.equal(J.detectLanguage([{ text: 'kana' }], '英语'), '英语');
  await assert.rejects(J.detail(KEY, 123, async () => response({ ...title, id: 124 })), /JIMAKU_TITLE_CHANGED/);
});

test('Jimaku independent local credentials require trusted sender and leave other sources unchanged', async () => {
  const app = background({ data: { assrtApiKey: 'a'.repeat(32), subdlApiKey: 'synthetic-subdl-only' } });
  assert.equal((await app.send('EXTERNAL_SAVE_KEY', { source: 'jimaku', key: KEY }, app.content)).error, 'SENDER_NOT_ALLOWED');
  const r = await app.send('EXTERNAL_SAVE_KEY', { source: 'jimaku', key: KEY });
  assert.equal(r.ok, true); assert.equal(r.jimaku.hasKey, true); assert.ok(!JSON.stringify(r).includes(KEY));
  await app.send('EXTERNAL_CLEAR_KEY', { source: 'jimaku' });
  assert.equal(app.local.jimakuApiKey, ''); assert.equal(app.local.assrtApiKey, 'a'.repeat(32)); assert.equal(app.local.subdlApiKey, 'synthetic-subdl-only');
});

test('Jimaku explicit selection, Japanese apply and offline recovery do not call translation provider', async () => {
  const w = await setup();
  assert.equal((await w.send('EXTERNAL_DETAIL', { id: 999 })).error, 'JIMAKU_SELECTION_EXPIRED');
  const d = await w.send('EXTERNAL_DETAIL', { id: 123 }); assert.equal(d.ok, true); assert.ok(!JSON.stringify(d).includes('download/'));
  const p = await preview(w); assert.equal(p.ok, true, JSON.stringify(p)); assert.equal(p.language, '日语（字符推断）');
  assert.equal((await w.send('EXTERNAL_APPLY', { key: p.key, lang: 'ja-JP', sync: { mode: 'none' } })).ok, true);
  assert.equal(w.applied[0].lang, 'ja-JP'); assert.equal(w.applied[0].provider, 'jimaku');
  const n = w.calls.length; await w.send('EXTERNAL_CLEAR_KEY');
  const r = await w.app.send('EXTERNAL_RESTORE', { guid: 'ABC' }, w.app.content);
  assert.equal(r.record.text, srt); assert.equal((await preview(w)).cached, true); assert.equal(w.calls.length, n);
  assert.ok(w.calls.every(c => new URL(c.url).origin === 'https://jimaku.cc'));
});

test('Jimaku follows same season/template, inherits offset and deduplicates concurrent restores', async () => {
  const w = await setup(), p = await preview(w);
  const a = await w.send('EXTERNAL_APPLY', { key: p.key, metadata: w.meta, lang: 'ja-JP', follow: true, inheritOffset: true,
    sync: { mode: 'linear', offset: -2, scale: 1.001 } });
  assert.equal(a.ok, true, JSON.stringify(a)); assert.equal(a.followRule.source, 'jimaku');
  w.navigate('NEXT'); const payload = { guid: 'NEXT', metadata: { ...w.meta, guid: 'NEXT', episode: 2 } };
  const [r1, r2] = await Promise.all([w.app.send('EXTERNAL_RESTORE', payload, w.app.content), w.app.send('EXTERNAL_RESTORE', payload, w.app.content)]);
  assert.deepEqual(r1, r2); assert.equal(r1.record.filename, name(2)); assert.equal(r1.record.lang, 'ja-JP');
  assert.deepEqual(r1.record.sync, { mode: 'linear', scale: 1, offset: -2 });
  assert.equal(w.calls.filter(c => decodeURIComponent(c.url).endsWith(name(2))).length, 1);
  const n = w.calls.length; await w.app.send('EXTERNAL_RESTORE', payload, w.app.content); assert.equal(w.calls.length, n);
});

test('Jimaku refuses wrong/special episodes and ambiguous follow without substituting another file', async () => {
  const w = await setup(), p = await preview(w, 2);
  assert.equal((await w.send('EXTERNAL_APPLY', { key: p.key, metadata: w.meta, lang: 'ja-JP', follow: true, sync: { mode: 'none' } })).error, 'FOLLOW_FILENAME_UNCLEAR');
  for (const alternate of ['Academy SP01.srt', 'Academy S02E01.srt']) {
    const x = await setup({ files: [{ ...file(1), name: alternate, url: `/entry/123/download/${encodeURIComponent(alternate)}` }] });
    const pp = await x.send('EXTERNAL_PREVIEW', { id: 123, filename: alternate });
    assert.equal((await x.send('EXTERNAL_APPLY', { key: pp.key, metadata: x.meta, lang: 'ja-JP', follow: true, sync: { mode: 'none' } })).error, 'FOLLOW_FILENAME_UNCLEAR');
  }
  const amb = await setup({ files: [file(1), file(2), file(2)] }), first = await preview(amb);
  await amb.send('EXTERNAL_APPLY', { key: first.key, metadata: amb.meta, lang: 'ja-JP', follow: true, sync: { mode: 'none' } });
  amb.navigate('NEXT'); const r = await amb.app.send('EXTERNAL_RESTORE', { guid: 'NEXT', metadata: { ...amb.meta, guid: 'NEXT', episode: 2 } }, amb.app.content);
  assert.equal(r.followError, 'FOLLOW_AMBIGUOUS'); assert.equal(r.record, null);
});

test('Jimaku cache identities isolate AniList/name and file names, refresh is explicit', async () => {
  const w = await setup(), n = w.calls.length;
  assert.equal((await w.send('EXTERNAL_SEARCH', { query: title.name })).cached, true); assert.equal(w.calls.length, n);
  assert.equal((await w.send('EXTERNAL_SEARCH', { query: '', anilistId: 1001 })).cached, false);
  const a = await preview(w, 1), b = await preview(w, 2); assert.notEqual(a.key, b.key);
  await w.send('EXTERNAL_SEARCH', { query: title.name, refresh: true }); assert.equal(w.calls.at(-1).init.headers.Authorization, KEY);
});

test('Jimaku empty/429/permission/navigation failures preserve other settings without auto MT', async () => {
  const w = await setup({ fetcher: async () => response([]) });
  assert.equal(w.calls.length, 1); assert.equal(w.app.local.assrtApiKey, 'a'.repeat(32));
  w.navigate('NEXT'); assert.equal((await w.send('EXTERNAL_SEARCH', { query: 'Other' })).error, 'EXTERNAL_CONTEXT_EXPIRED');
  assert.equal(w.calls.length, 1);
  const rate = await setup({ fetcher: async url => new URL(url).searchParams.get('query') === title.name ? response([]) : response({}, 429, { 'x-ratelimit-reset-after': '90' }) });
  const r = await rate.send('EXTERNAL_SEARCH', { query: 'Other' }); assert.equal(r.error, 'JIMAKU_RATE_LIMIT'); assert.equal(r.retryAfter, 90);
  const n = rate.calls.length; await rate.send('EXTERNAL_SEARCH', { query: 'Other2' }); assert.equal(rate.calls.length, n);
  rate.app.deny(); assert.equal((await rate.send('EXTERNAL_SEARCH', { query: 'Other3' })).error, 'JIMAKU_PERMISSION_REQUIRED');
  assert.ok(rate.calls.every(c => new URL(c.url).origin === 'https://jimaku.cc'));
});

test('Jimaku ZIP fallback is explicit browser download, never an automatic load or auth forwarding', async () => {
  const zip = { name: 'Academy.zip', size: 999, url: '/entry/123/download/Academy.zip' };
  const w = await setup({ files: [zip] });
  assert.equal((await w.send('EXTERNAL_PREVIEW', { id: 123, filename: zip.name })).error, 'JIMAKU_UNSUPPORTED_FILE');
  assert.equal((await w.send('EXTERNAL_DOWNLOAD_OPEN', { id: 123, filename: zip.name })).ok, true);
  assert.equal(w.opened.at(-1).url, 'https://jimaku.cc/entry/123/download/Academy.zip');
  assert.ok(w.calls.every(c => new URL(c.url).pathname.startsWith('/api/')));
});

test('Japanese batch and streaming prompts use the same provider/target and idiomatic rules', () => {
  const c = relayContext(); load(c, 'lib/relay-stream.js');
  for (const protocol of ['chat-completions', 'responses']) {
    const cfg = { ...config, protocol }, items = [{ id: '0', text: 'Welcome home.' }];
    const batch = c.CRSubFix.relay.body(cfg, items.map(i => i.text), 'en-US', 'ja-JP');
    const stream = c.CRSubFix.relayStream.body(cfg, items, 'en-US', 'ja-JP');
    for (const body of [batch, stream]) {
      const rules = body.instructions || body.messages[0].content;
      assert.match(rules, /idiomatic spoken Japanese/); assert.match(rules, /do not invent kanji/);
      const input = JSON.parse(body.input || body.messages[1].content); assert.equal(input.target_language, 'Japanese');
      assert.equal(body.model, config.model);
    }
    assert.equal(stream.stream, true);
    const chinese = c.CRSubFix.relay.body(cfg, items.map(i => i.text), 'en-US', 'zh-CN');
    assert.doesNotMatch(chinese.instructions || chinese.messages[0].content, /idiomatic spoken Japanese/);
  }
});
