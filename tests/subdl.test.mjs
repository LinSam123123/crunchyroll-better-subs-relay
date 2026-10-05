import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { context, load, background, json } from './helpers.mjs';

const KEY = 'synthetic-subdl-key-only';
const title = { sd_id: 'sd123', type: 'tv', name: 'Synthetic Academy', original_name: 'Academy', year: 2026 };
const srt = '1\n00:00:02,000 --> 00:00:06,000\n第一句\n';
const pack = { n_id: 'pack1', url: '/subtitle/pack1.zip', release_name: 'Academy S01 WEB',
  season: 1, language: 'Chinese (Simplified)', full_season: true, author: 'Test Group',
  unpack_files: [1, 2, 3].map(ep => ({ file_n_id: `file${ep}`, name: `Academy S01E0${ep}.srt`,
    language: 'ZH', season: 1, episode: ep, format: 'srt', size: 100, url: `/subtitle/pack1/file${ep}` })) };
const response = (v, status = 200, headers) => new Response(typeof v === 'string' || v instanceof Uint8Array ? v : JSON.stringify(v), { status, headers });
function adapter() { const c = context({ fetch: async () => { throw new Error('UNEXPECTED_NETWORK'); } }); load(c, 'lib/assrt.js'); load(c, 'lib/fflate.js'); load(c, 'lib/subdl.js'); return c.CRSubFix.subdl; }
async function setup({ rawPack = pack, fetcher } = {}) {
  let guid = 'ABC'; const calls = [], applied = [], opened = [];
  const app = background({ data: { assrtApiKey: 'a'.repeat(32), subdlApiKey: KEY }, fetcher: async (url, init) => {
    calls.push({ url, init });
    if (fetcher) return fetcher(url, init);
    if (url.includes('/movies/search')) return response({ results: [title] });
    if (url.includes('/subtitles/search')) return response({ status: true, results: [title], subtitles: [rawPack] });
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
  const send = (type, payload = {}, sender) => app.send(type, { snapshot, source: 'subdl', ...payload }, sender);
  const search = await send('EXTERNAL_SEARCH', { query: title.name, metadata: meta });
  assert.equal(search.ok, true, JSON.stringify(search));
  const titles = await send('EXTERNAL_DETAIL', { id: '123', kind: 'title', metadata: meta });
  assert.equal(titles.ok, true, JSON.stringify(titles));
  return { app, meta, send, snapshot, calls, applied, titles, opened, navigate: g => { guid = g; } };
}
const preview = (w, ep = 1) => w.send('EXTERNAL_PREVIEW', { id: 'pack1', filename: `Academy S01E0${ep}.srt`, fileId: `file${ep}` });

test('SubDL v2 title search uses only bearer header, bounds results and never returns credentials', async () => {
  const D = adapter(), calls = [];
  const r = await D.search(KEY, 'Academy', async (url, init) => { calls.push({ url, init }); return response({ results: [title] }); });
  const u = new URL(calls[0].url);
  assert.equal(u.origin, 'https://api.subdl.com'); assert.equal(u.pathname, '/api/v2/movies/search');
  assert.equal(u.searchParams.get('type'), 'tv'); assert.equal(u.searchParams.get('q'), 'Academy');
  assert.equal(u.searchParams.has('api_key'), false); assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].init.redirect, 'error'); assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(r[0].kind, 'title'); assert.equal(r[0].id, '123'); assert.ok(!JSON.stringify(r).includes(KEY));
  for (const key of ['', 'bad key', 'https://user:key@evil']) assert.throws(() => D.token(key), /SUBDL_INVALID_KEY/);
  for (const q of ['', 'a', 'x'.repeat(201)]) assert.throws(() => D.query(q), /SUBDL_INVALID_QUERY/);
});
test('SubDL title confirmation scopes subtitles to exact id and preserves structured single files', async () => {
  const D = adapter(); let seen;
  const r = await D.subtitles(KEY, '123', { season: 1 }, async url => { seen = new URL(url); return response({ results: [title], subtitles: [pack] }); });
  assert.equal(seen.searchParams.get('sd_id'), '123'); assert.equal(seen.searchParams.get('season'), '1');
  assert.equal(seen.searchParams.get('unpack'), '1'); assert.equal(seen.searchParams.has('full_season'), false);
  assert.equal(r[0].id, 'pack1'); assert.equal(r[0].files[1].episode, 2); assert.equal(r[0].files[1].fileId, 'file2');
  assert.equal(r[0].language, '简体中文'); assert.equal(r[0].uploader, 'Test Group');
  assert.ok(D.matchesLanguage('Chinese (Traditional)', 'zh')); assert.ok(!D.matchesLanguage('English', 'zh'));
  await assert.rejects(D.subtitles(KEY, 999, {}, async () => response({ results: [title], subtitles: [pack] })), /SUBDL_TITLE_CHANGED/);
});
test('SubDL HTTP, business and timeout errors are sanitized and retain rate-limit retry-after', async () => {
  const D = adapter();
  for (const status of [401, 403]) await assert.rejects(D.search(KEY, 'Academy', async () => response({}, status)), /SUBDL_AUTH_FAILED/);
  await assert.rejects(D.search(KEY, 'Academy', async () => response({}, 429, { 'retry-after': '75' })), e => e.message === 'SUBDL_RATE_LIMIT' && e.retryAfter === 75);
  await assert.rejects(D.search(KEY, 'Academy', async () => { throw new DOMException(KEY, 'TimeoutError'); }), /^Error: SUBDL_API_TIMEOUT$/);
  await assert.rejects(D.search(KEY, 'Academy', async () => response({ status: false, error: KEY })), /^Error: SUBDL_SERVICE_ERROR$/);
});

test('SubDL v2 credential-bearing response links are stripped before caching, exposing or downloading', async () => {
  const rawPack = { ...pack, url: `${pack.url}?api_key=${KEY}`, unpack_files: pack.unpack_files.map(f =>
    ({ ...f, url: `${f.url}?api_key=${KEY}` })) };
  const w = await setup({ rawPack });
  assert.equal((await preview(w)).ok, true);
  assert.ok(!JSON.stringify(w.titles).includes(KEY));
  const cached = JSON.stringify(w.app.local);
  // The credential setting is expected; provider caches and outgoing downloads are not.
  assert.ok(!cached.includes('api_key='));
  const download = w.calls.find(c => new URL(c.url).origin === 'https://dl.subdl.com');
  assert.ok(download); assert.equal(new URL(download.url).search, ''); assert.equal(download.init.headers, undefined);
});

test('SubDL service-side language filtering and pagination have separate cache identities and exact-pack refresh', async () => {
  const calls = [];
  const w = await setup({ fetcher: async (url, init) => {
    const u = new URL(url); calls.push(u);
    if (u.pathname.endsWith('/movies/search')) return response({ results: [title] });
    if (u.pathname.endsWith('/subtitles/search')) {
      const page = Number(u.searchParams.get('page') || 1);
      return response({ results: [title], subtitles: [{ ...pack, n_id: `page${page}` }], totalPages: 2, currentPage: page });
    }
    return response(srt);
  } });
  const list = await w.send('EXTERNAL_DETAIL', { id: '123', kind: 'title', searchLanguage: 'zh', searchPage: 2 });
  assert.equal(list.ok, true); assert.equal(list.pos, 30); assert.equal(list.hasMore, false);
  assert.equal(calls.at(-1).searchParams.get('languages'), 'ZH,ZE,BG');
  const before = calls.length;
  assert.equal((await w.send('EXTERNAL_DETAIL', { id: '123', kind: 'title', searchLanguage: 'zh', searchPage: 2 })).cached, true);
  assert.equal(calls.length, before);
  const detail = await w.send('EXTERNAL_DETAIL', { id: 'page2' });
  assert.equal(detail.ok, true); assert.equal(calls.at(-1).searchParams.get('page'), '2');
  assert.equal(calls.at(-1).searchParams.get('languages'), 'ZH,ZE,BG');
  const p = await w.send('EXTERNAL_PREVIEW', { id: 'page2', filename: 'Academy S01E01.srt', fileId: 'file1' });
  assert.equal(p.ok, true, JSON.stringify(p));
  const a = await w.send('EXTERNAL_APPLY', { key: p.key, sync: { mode: 'none' }, lang: 'zh-CN', metadata: w.meta, follow: true });
  assert.equal(a.ok, true); assert.equal(a.followRule.searchPage, 2); assert.equal(a.followRule.searchLanguage, 'zh');
  assert.equal((await w.send('EXTERNAL_DETAIL', { id: '123', kind: 'title', searchLanguage: 'evil' })).error, 'SUBDL_INVALID_QUERY');
  w.navigate('DEF');
  const r = await w.app.send('EXTERNAL_RESTORE', { guid: 'DEF', metadata: { ...w.meta, guid: 'DEF', episode: 2 } }, w.app.content);
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.record?.filename, 'Academy S01E02.srt');
  const refreshed = calls.filter(c => c.pathname.endsWith('/subtitles/search')).at(-1);
  assert.equal(refreshed.searchParams.get('page'), '2'); assert.equal(refreshed.searchParams.get('languages'), 'ZH,ZE,BG');
});
test('SubDL raw downloads reject unsafe hosts/redirects, do not forward keys and preserve decoded ASS/SRT', async () => {
  const D = adapter(), [v] = await D.subtitles(KEY, 123, {}, async () => response({ results: [title], subtitles: [pack] }));
  for (const u of ['http://dl.subdl.com/subtitle/x.zip', 'https://evil.net/subtitle/x.zip',
    'https://dl.subdl.com.evil.net/subtitle/x.zip', 'https://a:b@dl.subdl.com/subtitle/x.zip',
    '/subtitle/../other/x', '/subtitle/x.zip?api_key=secret&next=evil', '/subtitle/x/file#bad']) assert.throws(() => D.downloadUrl(u), /SUBDL_DOWNLOAD_UNSAFE/);
  assert.equal(D.downloadUrl('/subtitle/x.zip?api_key=secret'), 'https://dl.subdl.com/subtitle/x.zip');
  let init;
  const r = await D.download(v, 'Academy S01E01.srt', 'auto', async (_, opts) => { init = opts; return response(srt); }, 'file1');
  assert.equal(r.text, srt); assert.equal(r.episode, 1); assert.equal(init.headers, undefined);
  assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
  await assert.rejects(D.download(v, 'Academy S01E01.srt', 'auto', async () => response('<html>bad</html>')), /SUBDL_INVALID_FILE/);
});
test('SubDL ZIP fallback lists files and uses bounded fflate extraction without repeated downloads', async () => {
  const D = adapter(); let requests = 0;
  const raw = { ...pack, unpack_files: [] };
  const [v] = await D.subtitles(KEY, 123, {}, async () => response({ results: [title], subtitles: [raw] }));
  const zip = zipSync({ 'Academy S01E01.srt': strToU8(srt), 'Academy S01E02.srt': strToU8(srt), 'Readme.txt': strToU8('ignored') });
  const fetcher = async () => { requests++; return response(zip); };
  const expanded = await D.expand(v, fetcher);
  assert.equal(expanded.files.length, 2);
  const r = await D.download(expanded, 'Academy S01E02.srt', 'auto', fetcher);
  assert.equal(r.text, srt); assert.equal(requests, 1);
});
test('SubDL malformed ZIP, duplicate names and dangerous extraction paths fail closed', async () => {
  const D = adapter(), [v] = await D.subtitles(KEY, 123, {}, async () => response({ results: [title], subtitles: [{ ...pack, unpack_files: [] }] }));
  await assert.rejects(D.expand(v, async () => response('not a ZIP')), /SUBDL_INVALID_ARCHIVE/);
  const zip = zipSync({ '../evil.srt': strToU8(srt) });
  await assert.rejects(D.expand(v, async () => response(zip)), /SUBDL_INVALID_ARCHIVE/);
  await assert.rejects(D.download({ ...v, files: [{ name: 'a.srt' }, { name: 'a.srt' }] }, 'a.srt'), /SUBDL_FILE_CHANGED/);
});
test('SubDL oversized archive member is visible but refused before parsing', async () => {
  const D = adapter(), [v] = await D.subtitles(KEY, 123, {}, async () => response({ results: [title], subtitles: [{ ...pack, unpack_files: [] }] }));
  const zip = zipSync({ 'big.srt': new Uint8Array(8 * 1024 * 1024 + 1), 'small.srt': strToU8(srt) });
  const expanded = await D.expand(v, async () => response(zip));
  assert.equal(expanded.files.find(f => f.name === 'big.srt').oversized, true);
  await assert.rejects(D.download(expanded, 'big.srt'), /SUBDL_FILE_TOO_LARGE/);
});
test('SubDL credentials are independently saved, local-only, trusted and source-allowlisted', async () => {
  const app = background({ data: { assrtApiKey: 'a'.repeat(32) } });
  assert.equal((await app.send('EXTERNAL_SAVE_KEY', { source: 'subdl', key: KEY }, app.content)).error, 'SENDER_NOT_ALLOWED');
  assert.equal((await app.send('EXTERNAL_SAVE_KEY', { source: 'evil', key: KEY })).error, 'EXTERNAL_INVALID_SOURCE');
  assert.equal((await app.send('EXTERNAL_SAVE_KEY', { source: 'subdl', key: KEY })).ok, true);
  assert.equal(app.local.assrtApiKey, 'a'.repeat(32)); assert.equal(app.local.subdlApiKey, KEY);
  assert.ok(!JSON.stringify(await app.send('EXTERNAL_SAVE_KEY', { source: 'subdl', key: KEY })).includes(KEY));
  await app.send('EXTERNAL_CLEAR_KEY', { source: 'subdl' }); assert.equal(app.local.assrtApiKey, 'a'.repeat(32));
});
test('SubDL title selection, raw preview, apply and offline reload stay source-specific', async () => {
  const w = await setup();
  assert.ok(!JSON.stringify(w.titles).includes('https://dl.subdl.com'));
  const detail = await w.send('EXTERNAL_DETAIL', { id: 'pack1' }); assert.equal(detail.files.length, 3);
  const p = await preview(w); assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.source, 'subdl'); assert.ok(p.key.includes(':subdl:pack1:'));
  assert.equal((await w.send('EXTERNAL_APPLY', { key: p.key, lang: 'zh-CN', sync: { mode: 'none' } })).ok, true);
  assert.equal(w.applied[0].provider, 'subdl'); assert.ok(w.applied[0].id.startsWith('custom:subdl:pack1:'));
  const before = w.calls.length;
  await w.send('EXTERNAL_CLEAR_KEY');
  const restored = await w.app.send('EXTERNAL_RESTORE', { guid: 'ABC' }, w.app.content);
  assert.equal(restored.record.text, srt); assert.equal(w.calls.length, before);
  assert.equal((await preview(w)).cached, true);
  assert.equal((await w.send('EXTERNAL_PREVIEW', { source: 'assrt', id: 'pack1', filename: 'Academy S01E01.srt' })).error, 'ASSRT_INVALID_ID');
});
test('SubDL collection follows only same pack and language, preserves offset and deduplicates next episode', async () => {
  const w = await setup(), p = await preview(w);
  const a = await w.send('EXTERNAL_APPLY', { key: p.key, metadata: w.meta, lang: 'zh-CN',
    sync: { mode: 'linear', scale: 1.001, offset: -2 }, follow: true, inheritOffset: true });
  assert.equal(a.ok, true, JSON.stringify(a)); assert.equal(a.followRule.source, 'subdl');
  w.navigate('NEXT');
  const payload = { guid: 'NEXT', metadata: { ...w.meta, guid: 'NEXT', episode: 2 } };
  const [r1, r2] = await Promise.all([w.app.send('EXTERNAL_RESTORE', payload, w.app.content), w.app.send('EXTERNAL_RESTORE', payload, w.app.content)]);
  assert.equal(r1.record.provider, 'subdl'); assert.equal(r1.record.filename, 'Academy S01E02.srt');
  assert.deepEqual(r1.record.sync, { mode: 'linear', scale: 1, offset: -2 }); assert.deepEqual(r1, r2);
  assert.equal(w.calls.filter(c => c.url.endsWith('/pack1/file2')).length, 1);
  assert.equal(w.calls.filter(c => c.url.includes('assrt')).length, 0);
  const n = w.calls.length; await w.app.send('EXTERNAL_RESTORE', payload, w.app.content); assert.equal(w.calls.length, n);
});
test('SubDL unrecognized filenames can follow confirmed structured episode metadata, but conflicts fail', async () => {
  const raw = { ...pack, unpack_files: pack.unpack_files.map(f => ({ ...f, name: `Scene${f.file_n_id}.srt` })) };
  const w = await setup({ rawPack: raw });
  const p = await w.send('EXTERNAL_PREVIEW', { id: 'pack1', filename: 'Scenefile1.srt', fileId: 'file1' });
  const a = await w.send('EXTERNAL_APPLY', { key: p.key, metadata: w.meta, follow: true, sync: { mode: 'none' }, lang: 'zh-CN' });
  assert.equal(a.ok, true, JSON.stringify(a)); assert.equal(a.followRule.structured, true);
  w.navigate('NEXT');
  const r = await w.app.send('EXTERNAL_RESTORE', { guid: 'NEXT', metadata: { ...w.meta, guid: 'NEXT', episode: 2 } }, w.app.content);
  assert.equal(r.record.filename, 'Scenefile2.srt');
  const wrong = await setup(); const wrongPreview = await preview(wrong, 2);
  assert.equal((await wrong.send('EXTERNAL_APPLY', { key: wrongPreview.key, metadata: wrong.meta, follow: true,
    sync: { mode: 'none' }, lang: 'zh-CN' })).error, 'FOLLOW_FILENAME_UNCLEAR');
});
test('SubDL has independent cooldown and preserves assrt/cache when its API fails', async () => {
  const w = await setup();
  const n = w.calls.length; w.app.deny();
  assert.equal((await preview(w)).error, 'SUBDL_PERMISSION_REQUIRED'); assert.equal(w.calls.length, n);
  const app = background({ data: { subdlApiKey: KEY }, fetcher: async () => response({}, 429, { 'retry-after': '90' }) });
  const r = await app.send('EXTERNAL_QUOTA', { source: 'subdl' }); assert.equal(r.error, 'SUBDL_RATE_LIMIT'); assert.equal(r.retryAfter, 90);
  assert.equal((await app.send('EXTERNAL_QUOTA', { source: 'subdl' })).error, 'SUBDL_RATE_LIMIT');
  assert.equal(app.calls.filter(c => Array.isArray(c) && c[0] === 'fetch').length, 1);
});
test('SubDL structured metadata never overrides an explicit wrong season or special filename', async () => {
  for (const name of ['Academy S02E01.srt', 'Academy SP01.srt', 'Academy OVA.srt']) {
    const raw = { ...pack, unpack_files: [{ ...pack.unpack_files[0], name }] };
    const w = await setup({ rawPack: raw });
    const p = await w.send('EXTERNAL_PREVIEW', { id: 'pack1', filename: name, fileId: 'file1' });
    assert.equal(p.ok, true);
    assert.equal((await w.send('EXTERNAL_APPLY', { key: p.key, metadata: w.meta, follow: true,
      lang: 'zh-CN', sync: { mode: 'none' } })).error, 'FOLLOW_FILENAME_UNCLEAR');
    assert.equal((await w.send('EXTERNAL_APPLY', { key: p.key, metadata: w.meta, follow: false,
      lang: 'zh-CN', sync: { mode: 'none' } })).ok, true);
  }
});
test('identical SubDL file bodies retain separate per-file cache identities', async () => {
  const w = await setup(); const a = await preview(w, 1), b = await preview(w, 2);
  assert.notEqual(a.key, b.key); assert.equal(w.app.local.externalSubCache.files.length, 2);
});
test('SubDL cached title and subtitle searches avoid API calls, explicit refresh refetches', async () => {
  const w = await setup(); const n = w.calls.length;
  const r = await w.send('EXTERNAL_DETAIL', { id: '123', kind: 'title', metadata: w.meta });
  assert.equal(r.cached, true); assert.equal(w.calls.length, n);
  await w.send('EXTERNAL_SEARCH', { query: title.name, metadata: w.meta }); assert.equal(w.calls.length, n);
  await w.send('EXTERNAL_DETAIL', { id: '123', kind: 'title', metadata: w.meta, refresh: true }); assert.equal(w.calls.length, n + 1);
});
test('explicit raw ZIP browser download works without extracting the archive or forwarding a key', async () => {
  const w = await setup({ rawPack: { ...pack, unpack_files: [] } });
  const before = w.calls.length;
  const r = await w.send('EXTERNAL_DOWNLOAD_OPEN', { id: 'pack1', archive: true });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(w.calls.length - before, 1);
  assert.equal(w.opened.at(-1).url, 'https://dl.subdl.com/subtitle/pack1.zip');
  assert.ok(!w.opened.at(-1).url.includes(KEY));
});
test('ZIP listing does not inflate a whole season and preview inflates only the selected member', async () => {
  const c = context({ fetch: async () => { throw new Error('UNEXPECTED_NETWORK'); } });
  load(c, 'lib/assrt.js'); load(c, 'lib/fflate.js'); load(c, 'lib/subdl.js');
  let inflated = 0; const Original = c.fflate.UnzipInflate;
  c.fflate.UnzipInflate = class extends Original { constructor(...args) { super(...args); inflated++; } };
  const D = c.CRSubFix.subdl, [v] = await D.subtitles(KEY, 123, {}, async () => response({ results: [title], subtitles: [{ ...pack, unpack_files: [] }] }));
  const zip = zipSync({ 'large.srt': new Uint8Array(8 * 1024 * 1024), 'selected.srt': strToU8(srt) });
  const expanded = await D.expand(v, async () => response(zip));
  assert.equal(inflated, 0);
  assert.equal((await D.download(expanded, 'selected.srt')).text, srt);
  assert.equal(inflated, 1);
});
