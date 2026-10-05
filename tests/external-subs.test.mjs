import test from 'node:test';
import assert from 'node:assert/strict';
import { context, load, json, background } from './helpers.mjs';

const KEY = 'a'.repeat(32);
const srt = '1\n00:00:02,000 --> 00:00:05,000\n第一句话\n\n2\n00:00:20,000 --> 00:00:23,000\n第二句话\n';
const subtitle = { id: 42, native_name: 'Synthetic Academy S01E02 WEB', filename: 'episode.srt',
  lang: { desc: '简体中文' }, subtype: 'SRT', producer: { producer: 'Test Group', uploader: 'Uploader', source: '原创翻译' },
  url: 'https://file0.assrt.net/episode.srt?secret=expired' };
const response = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
function adapter(extra = {}) { const c = context({ fetch: async () => { throw new Error('UNEXPECTED_NETWORK'); }, ...extra }); load(c, 'lib/assrt.js'); return c.CRSubFix.assrt; }
async function setup({ allowed = true, fetcher } = {}) {
  const network = [], applied = [], opened = [];
  let guid = 'ABC', ack = true;
  const app = background({ allowed, data: { assrtApiKey: KEY }, fetcher: async (url, init) => {
    network.push({ url, init });
    if (fetcher) return fetcher(url, init);
    if (url.includes('/sub/search')) return response({ status: 0, sub: { subs: [subtitle] } });
    if (url.includes('/sub/detail')) return response({ status: 0, sub: { subs: [subtitle] } });
    if (url.includes('/user/quota')) return response({ status: 0, user: { quota: 4 } });
    return response(srt);
  } });
  app.ctx.chrome.tabs.create = async p => { opened.push(p); return { id: 2 }; };
  app.ctx.chrome.tabs.sendMessage = async (tabId, msg) => {
    assert.equal(tabId, 1);
    if (msg.type === 'WORK_PAGE_CHECK') return { guid, url: `https://www.crunchyroll.com/watch/${guid}/title` };
    if (msg.type === 'EXTERNAL_TIME') return { guid, time: 10 };
    if (msg.type === 'EXTERNAL_APPLY') { applied.push(msg.payload); return { ok: ack }; }
  };
  const r = await app.send('EXTERNAL_OPEN', { guid: 'ABC', metadata: {
    guid: 'ABC', seriesId: 'SERIES', title: 'Synthetic Academy', episode: 2, season: 1,
  } }, app.content);
  assert.equal(r.ok, true, JSON.stringify(r));
  const snapshot = new URL(opened[0].url).searchParams.get('snapshot');
  const send = (type, payload = {}, sender) => app.send(type, { snapshot, ...payload }, sender);
  return { app, send, snapshot, network, applied, opened, navigate: value => { guid = value; }, rejectApply: () => { ack = false; } };
}
const preview = w => w.send('EXTERNAL_PREVIEW', { id: 42, filename: 'episode.srt', encoding: 'auto' });
const apply = (w, p, extra = {}) => w.send('EXTERNAL_APPLY', { key: p.key, lang: 'zh-CN',
  sync: { mode: 'linear', scale: 1, offset: -1 }, ...extra });

test('assrt searches send only bearer authorization, strict HTTPS and bounded queries', async () => {
  const A = adapter(), seen = [];
  const results = await A.search(KEY, 'Synthetic Academy', 15, true, async (url, init) => {
    seen.push({ url, init }); return response({ status: 0, sub: { subs: [subtitle] } });
  });
  const url = new URL(seen[0].url);
  assert.equal(url.origin, 'https://api.assrt.net');
  assert.equal(url.searchParams.get('token'), null);
  assert.equal(url.searchParams.get('cnt'), '15');
  assert.equal(url.searchParams.get('pos'), '15');
  assert.equal(url.searchParams.get('is_file'), '1');
  assert.equal(url.searchParams.get('no_muxer'), '1');
  assert.equal(url.searchParams.has('filelist'), false);
  assert.equal(seen[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(seen[0].init.credentials, 'omit');
  assert.equal(seen[0].init.redirect, 'error');
  assert.ok(!JSON.stringify(results).includes('expired'));
  assert.equal(results[0].group, '');
  assert.equal(results[0].producer, 'Test Group');
  for (const q of ['ab', 'x'.repeat(201), '', null]) assert.throws(() => A.query(q), /ASSRT_INVALID_QUERY/);
  assert.throws(() => A.token('invalid'), /ASSRT_INVALID_KEY/);
});
test('live search legacy fileid and display fields normalize without interpreting HTML or numeric subtype codes', async () => {
  const A = adapter();
  const item = { fileid: '801938', sub_name: 'Episode.WEB.zip', m_lang: '英&nbsp;简&nbsp;繁&nbsp;双语',
    m_source: '原创翻译', m_contributor: '制作：assrt.net 0day', uploadtime: '2026-10-03 05:03:58',
    score: '0', subtype: '2', m_subtype: 'SubRip (SRT)' };
  const r = await A.search(KEY, 'Academy', 0, false, async () => response({ status: 0, sub: { subs: [item] } }));
  assert.equal(r[0].id, '801938'); assert.equal(r[0].name, item.sub_name);
  assert.equal(r[0].language, '英 简 繁 双语'); assert.equal(r[0].uploaded, item.uploadtime);
  assert.equal(r[0].rating, 0); assert.equal(r[0].translationType, '原创翻译');
  assert.equal(r[0].subtype, 'SubRip (SRT)');
  assert.equal((await A.detail(KEY, '801938', async () => response({ status: 0, sub: { subs: [item] } }))).fileid, '801938');
});
test('HTTP 200 business errors are not success and empty assrt objects are empty results', async () => {
  const A = adapter();
  for (const [status, expected] of [[30900, 'ASSRT_RATE_LIMIT'], [1, 'ASSRT_INVALID_KEY'], [20900, 'ASSRT_NOT_FOUND'], [999, 'ASSRT_SERVICE_ERROR']]) {
    await assert.rejects(A.search(KEY, 'Academy', 0, false, async () => response({ status })), new RegExp(expected));
  }
  await assert.rejects(A.search(KEY, 'Academy', 0, false, async () => response({}, 429)), /ASSRT_RATE_LIMIT/);
  for (const subs of [[], {}, null]) {
    assert.deepEqual(json(await A.search(KEY, 'Academy', 0, false,
      async () => response({ status: 0, sub: { result: 'succeed', subs } }))), []);
  }
  await assert.rejects(A.search(KEY, 'Academy', 0, false, async () => response('{bad')), /ASSRT_INVALID_RESPONSE/);
});
test('downloads never forward bearer tokens and reject foreign URLs, credentials and ambiguous filenames', async () => {
  const A = adapter(), calls = [];
  const file = await A.download({ ...subtitle, url: 'http://file0.assrt.net/episode.srt' }, 'episode.srt', 'auto',
    async (url, init) => { calls.push({ url, init }); return response(srt); });
  assert.equal(calls[0].url, 'https://file0.assrt.net/episode.srt');
  assert.equal(calls[0].init.headers, undefined);
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(file.text, srt);
  for (const url of ['https://evil.net/file.srt', 'https://file0.assrt.net.evil.net/file.srt',
    'https://user:pass@file0.assrt.net/file.srt', 'https://file0.assrt.net:999/file.srt', 'file:///a.srt']) {
    assert.throws(() => A.downloadUrl(url), /ASSRT_DOWNLOAD_UNSAFE/);
  }
  await assert.rejects(A.download({ filelist: [{ f: 'a.srt' }, { f: 'a.srt' }] }, 'a.srt'), /ASSRT_FILE_CHANGED/);
  await assert.rejects(A.download({ filename: 'a.rar' }, 'a.rar'), /ASSRT_UNSUPPORTED_FILE/);
  await assert.rejects(A.download(subtitle, 'wrong.srt'), /ASSRT_FILE_CHANGED/);
});

test('HTTP file transport requires explicit consent, never downgrades HTTPS and never permits plaintext API URLs', async () => {
  const A = adapter(), seen = [];
  assert.equal(A.downloadUrl('https://file0.assrt.net/a.srt', true), 'https://file0.assrt.net/a.srt');
  assert.throws(() => A.downloadUrl('http://api.assrt.net/a.srt', true), /ASSRT_DOWNLOAD_UNSAFE/);
  const file = await A.download({ ...subtitle, url: 'http://file0.assrt.net/a.srt' }, 'episode.srt', 'auto', async (url, init) => {
    seen.push({ url, init }); return response(srt);
  }, true);
  assert.equal(file.text, srt);
  assert.equal(seen[0].url, 'http://file0.assrt.net/a.srt');
  assert.equal(seen[0].init.headers, undefined);
  assert.equal(seen[0].init.credentials, 'omit');
  assert.equal(seen[0].init.redirect, 'error');
  assert.throws(() => A.downloadUrl('http://evil.net/a.srt', true), /ASSRT_DOWNLOAD_UNSAFE/);
});

test('HTTP preference is trusted, default off, permission-gated and shared by preview and explicit open', async () => {
  const w = await setup({ fetcher: async url => url.includes('/sub/detail')
    ? response({ status: 0, sub: { subs: [{ ...subtitle, url: 'http://file0.assrt.net/a.srt' }] } }) : response(srt) });
  assert.equal((await w.send('EXTERNAL_GET')).httpDownloads, false);
  assert.equal((await w.send('EXTERNAL_SET_HTTP', { enabled: true }, w.app.content)).error, 'SENDER_NOT_ALLOWED');
  assert.equal((await w.send('EXTERNAL_SET_HTTP', { enabled: 'true' })).error, 'ASSRT_INVALID_CONFIG');
  w.app.ctx.chrome.permissions.contains = async ({ origins }) => !origins.some(o => o.startsWith('http:'));
  assert.equal((await w.send('EXTERNAL_SET_HTTP', { enabled: true })).error, 'ASSRT_HTTP_PERMISSION_REQUIRED');
  w.app.ctx.chrome.permissions.contains = async () => true;
  assert.equal((await w.send('EXTERNAL_SET_HTTP', { enabled: true })).httpDownloads, true);
  assert.equal((await preview(w)).ok, true);
  assert.equal(w.network.at(-1).url, 'http://file0.assrt.net/a.srt');
  assert.equal((await w.send('EXTERNAL_DOWNLOAD_OPEN', { id: 42, filename: 'episode.srt' })).ok, true);
  assert.equal(w.opened.at(-1).url, 'http://file0.assrt.net/a.srt');
  assert.equal((await w.send('EXTERNAL_SET_HTTP', { enabled: false })).httpDownloads, false);
  assert.equal((await w.send('EXTERNAL_DOWNLOAD_OPEN', { id: 42, filename: 'episode.srt' })).ok, true);
  assert.equal(w.opened.at(-1).url, 'https://file0.assrt.net/a.srt');
});
test('subtitle byte limit, HTML rejection and UTF-8/UTF-16/GB decoding prevent invalid previews', async () => {
  const A = adapter();
  assert.equal(A.decode(new TextEncoder().encode('字幕')).text, '字幕');
  assert.equal(A.decode(Uint8Array.from([255, 254, 0x2d, 0x4e])).text, '中');
  assert.equal(A.decode(Uint8Array.from([0xd6, 0xd0])).text, '中');
  assert.throws(() => A.decode(Uint8Array.from([255]), 'utf-8'), /ASSRT_DECODE_FAILED/);
  assert.throws(() => A.decode(new Uint8Array(), 'unsafe'), /ASSRT_INVALID_ENCODING/);
  await assert.rejects(A.download(subtitle, 'episode.srt', 'auto', async () => response('<html>Error</html>')), /ASSRT_INVALID_FILE/);
  await assert.rejects(A.readBytes({ headers: new Headers({ 'content-length': A.MAX_BYTES + 1 }) }, A.MAX_BYTES), /ASSRT_FILE_TOO_LARGE/);
});

test('assrt failures identify search, refreshed detail and download stages without exposing URLs', async () => {
  const A = adapter();
  const timeout = async () => { throw new DOMException('signed-url-and-token', 'TimeoutError'); };
  const network = async () => { throw new TypeError('signed-url-and-token'); };
  await assert.rejects(A.search(KEY, 'Academy', 0, false, timeout), /^Error: ASSRT_SEARCH_TIMEOUT$/);
  await assert.rejects(A.detail(KEY, 42, network), /^Error: ASSRT_DETAIL_NETWORK$/);
  await assert.rejects(A.request(KEY, 'user/quota', {}, timeout), /^Error: ASSRT_API_TIMEOUT$/);
  await assert.rejects(A.download(subtitle, 'episode.srt', 'auto', timeout), /^Error: ASSRT_DOWNLOAD_TIMEOUT$/);
  await assert.rejects(A.download(subtitle, 'episode.srt', 'auto', network), /^Error: ASSRT_DOWNLOAD_NETWORK$/);
  const brokenBody = async () => ({ ok: true, headers: new Headers(), arrayBuffer: timeout });
  await assert.rejects(A.download(subtitle, 'episode.srt', 'auto', brokenBody), /ASSRT_DOWNLOAD_TIMEOUT/);
  await assert.rejects(A.detail(KEY, 42, brokenBody), /ASSRT_DETAIL_TIMEOUT/);
});

test('known oversized files are marked and rejected before fetching but actual byte limit remains authoritative', async () => {
  const A = adapter();
  for (const size of ['9MB', '9 MiB', '9000000', '1GB']) assert.equal(A.oversized(size), true);
  for (const size of ['42KB', '4MB', '4 MiB', '8 MiB', '', 'unknown']) assert.equal(A.oversized(size), false);
  const large = { ...subtitle, size: '9MB' };
  assert.equal(A.files(large)[0].oversized, true);
  await assert.rejects(A.download(large, 'episode.srt', 'auto', async () => {
    assert.fail('oversized files must not be downloaded');
  }), /ASSRT_FILE_TOO_LARGE/);
  await assert.rejects(A.download({ ...subtitle, size: '42KB' }, 'episode.srt', 'auto', async () => ({
    ok: true, headers: new Headers({ 'content-length': A.MAX_BYTES + 1 }),
  })), /ASSRT_FILE_TOO_LARGE/);
});

test('download browser network errors are scoped to the requested file and listeners are always removed', async () => {
  let observe, removed = 0;
  const A = adapter({ chrome: { webRequest: { onErrorOccurred: {
    addListener: (handler, filter) => { observe = handler; assert.deepEqual(json(filter.urls), ['https://file0.assrt.net/*']); },
    removeListener: handler => { assert.equal(handler, observe); removed++; },
  } } } });
  await assert.rejects(A.download(subtitle, 'episode.srt', 'auto', async url => {
    await Promise.resolve();
    assert.equal(removed, 0);
    observe({ url, error: 'net::ERR_BLOCKED_BY_CLIENT' });
    throw new TypeError('Failed to fetch');
  }), /ASSRT_DOWNLOAD_ERR_BLOCKED_BY_CLIENT/);
  assert.equal(removed, 1);
  await assert.rejects(A.download(subtitle, 'episode.srt', 'auto', async () => {
    observe({ url: 'https://file0.assrt.net/other.srt', error: 'net::ERR_CERT_AUTHORITY_INVALID' });
    throw new TypeError('Failed to fetch');
  }), /ASSRT_DOWNLOAD_NETWORK/);
  assert.equal(removed, 2);
  await A.download(subtitle, 'episode.srt', 'auto', async () => response(srt));
  assert.equal(removed, 3);
});
test('metadata belongs to the current watch episode, distinguishes aliases and avoids recommended titles', () => {
  const c = context(); load(c, 'lib/relay.js'); load(c, 'lib/work-profiles.js'); load(c, 'lib/episode-metadata.js');
  const record = { url: '/watch/ABC/title', name: 'Episode title', episodeNumber: 2, partOfSeason: { seasonNumber: 1 },
    partOfSeries: { url: '/series/SERIES/title', name: '作品名', alternateName: ['Academy', 'Romaji'] } };
  const doc = records => ({ querySelectorAll: selector => selector.startsWith('script')
    ? records.map(v => ({ textContent: JSON.stringify(v) })) : [] });
  const M = c.CRSubFix.episodeMetadata;
  const found = M.detect(doc([record]), 'https://www.crunchyroll.com/watch/ABC/title');
  assert.equal(found.episode, 2); assert.equal(found.season, 1); assert.equal(found.englishTitle, 'Academy');
  assert.equal(found.seriesId, 'SERIES');
  assert.equal(M.detect(doc([record]), 'https://www.crunchyroll.com/watch/OTHER/title').episode, null);
  assert.equal(M.detect(doc([record, { ...record, episodeNumber: 3 }]), 'https://www.crunchyroll.com/watch/ABC/title').episode, null);
});

test('real watch JSON-LD action targets do not erase the TVEpisode season and episode', () => {
  const c = context(); load(c, 'lib/relay.js'); load(c, 'lib/work-profiles.js'); load(c, 'lib/episode-metadata.js');
  const url = 'https://www.crunchyroll.com/zh-tw/watch/GRK585376/peace-for-the-master-of-this-labyrinth';
  const record = { '@type': 'TVEpisode', url, name: 'Episode 3', episodeNumber: 3,
    partOfSeason: { seasonNumber: 2 }, partOfSeries: { url: '/series/GYE5K3GQR/title', name: 'KONOSUBA' },
    potentialAction: { '@type': 'WatchAction', target: [{ url }, { url }] } };
  const doc = values => ({ querySelectorAll: selector => selector.startsWith('script')
    ? values.map(v => ({ textContent: JSON.stringify(v) })) : [] });
  const M = c.CRSubFix.episodeMetadata;
  const found = M.detect(doc([record, { '@type': 'VideoObject', url }]), url);
  assert.equal(found.season, 2); assert.equal(found.episode, 3); assert.equal(found.seriesId, 'GYE5K3GQR');
  assert.equal(M.detect(doc([record, { ...record }]), url).episode, 3);
  assert.equal(M.detect(doc([record, { ...record, episodeNumber: 4 }]), url).episode, null);
  assert.equal(M.detect(doc([record]), 'https://www.crunchyroll.com/watch/OTHER/title').episode, null);
});
test('opening and reading external page need no network, and content cannot read key or operate providers', async () => {
  const w = await setup();
  const value = await w.send('EXTERNAL_GET');
  assert.equal(value.hasKey, true); assert.equal(w.network.length, 0);
  assert.ok(!JSON.stringify(value).includes(KEY));
  assert.match(w.opened[0].url, /subtitles.html/);
  for (const type of ['EXTERNAL_SEARCH', 'EXTERNAL_GET', 'EXTERNAL_DETAIL', 'EXTERNAL_PREVIEW', 'EXTERNAL_APPLY', 'EXTERNAL_QUOTA',
    'EXTERNAL_SAVE_KEY', 'EXTERNAL_CLEAR_KEY']) {
    assert.equal((await w.send(type, {}, w.app.content)).error, 'SENDER_NOT_ALLOWED');
  }
  assert.ok(w.app.accesses.every(([, setting]) => setting.accessLevel === 'TRUSTED_CONTEXTS'));
});
test('search cache avoids network and retains corrected identity without leaking URLs', async () => {
  const w = await setup();
  const p = { query: 'Academy', metadata: { title: 'Corrected Academy', season: 1, episode: 2 } };
  const first = await w.send('EXTERNAL_SEARCH', p);
  assert.equal(first.ok, true); assert.equal(first.cached, false);
  const second = await w.send('EXTERNAL_SEARCH', { ...p, metadata: { ...p.metadata, title: 'New Title' } });
  assert.equal(second.cached, true); assert.equal(w.network.length, 1);
  assert.equal((await w.send('EXTERNAL_GET')).metadata.title, 'New Title');
  assert.ok(!JSON.stringify(w.app.local.externalSubCache).includes('expired'));
  await w.send('EXTERNAL_SEARCH', { ...p, refresh: true });
  assert.equal(w.network.length, 2);
});
test('preview refreshes signed detail before download, caches decoded content and returns no direct URL', async () => {
  const w = await setup();
  const detail = await w.send('EXTERNAL_DETAIL', { id: 42 });
  assert.ok(!JSON.stringify(detail).includes('https://'));
  const p = await preview(w);
  assert.equal(p.ok, true, JSON.stringify(p)); assert.equal(p.count, 2);
  assert.equal(w.network.filter(r => r.url.includes('/sub/detail')).length, 2);
  assert.equal(w.network.length, 3);
  assert.ok(w.network.at(-1).init.headers === undefined);
  assert.equal((await preview(w)).cached, true); assert.equal(w.network.length, 3);
  assert.ok(!JSON.stringify(w.app.local.externalSubCache).includes('secret=expired'));
});
test('loading requires player acknowledgement and saved selection restores without any network', async () => {
  const w = await setup(), p = await preview(w);
  assert.equal((await apply(w, p, { rememberOffset: true })).ok, true);
  const r = await w.app.send('EXTERNAL_RESTORE', { guid: 'ABC' }, w.app.content);
  assert.equal(r.record.text, srt); assert.equal(r.record.sync.offset, -1);
  assert.equal(r.record.lang, 'zh-CN'); assert.equal(w.network.length, 2);
  assert.equal((await w.send('EXTERNAL_GET')).seriesOffset.offset, -1);
  assert.ok(!JSON.stringify(w.applied).includes(KEY));
  w.rejectApply();
  assert.equal((await apply(w, p, { sync: { mode: 'linear', scale: 1, offset: 2 } })).error, 'EXTERNAL_APPLY_FAILED');
  assert.equal(w.app.local.externalSubCache.selections.ABC.sync.offset, -1);
});
test('sync and removal are scoped to the actual selected file, then refresh no longer resurrects removal', async () => {
  const w = await setup(), p = await preview(w); await apply(w, p);
  const id = w.applied[0].id;
  assert.equal((await w.app.send('EXTERNAL_SYNC', { guid: 'ABC', id, sync: { mode: 'linear', scale: 1, offset: .1 } }, w.app.content)).ok, true);
  assert.equal((await w.app.send('EXTERNAL_RESTORE', { guid: 'ABC' }, w.app.content)).record.sync.offset, .1);
  assert.equal((await w.app.send('EXTERNAL_SYNC', { guid: 'ABC', id: 'custom:local', sync: { mode: 'none' } }, w.app.content)).error, 'EXTERNAL_FILE_EXPIRED');
  assert.equal((await w.app.send('EXTERNAL_FORGET', { guid: 'ABC', id }, w.app.content)).ok, true);
  assert.equal((await w.app.send('EXTERNAL_RESTORE', { guid: 'ABC' }, w.app.content)).record, null);
});
test('same series next episode does not inherit a selected file or silently apply a series offset', async () => {
  const w = await setup(), p = await preview(w); await apply(w, p, { rememberOffset: true });
  const nextSender = { ...w.app.content, url: 'https://www.crunchyroll.com/watch/NEXT/title' };
  w.navigate('NEXT');
  assert.equal((await w.app.send('EXTERNAL_RESTORE', { guid: 'NEXT' }, nextSender)).record, null);
  assert.equal((await w.app.send('EXTERNAL_RESTORE', { guid: 'ABC' }, nextSender)).error, 'EXTERNAL_CONTEXT_EXPIRED');
});
test('navigation and expired snapshot reject download/apply before network or changing playback', async () => {
  const w = await setup(); w.navigate('OTHER');
  assert.equal((await preview(w)).error, 'EXTERNAL_CONTEXT_EXPIRED');
  assert.equal(w.network.length, 0);
  w.navigate('ABC');
  w.app.session[`externalSnapshot:${w.snapshot}`].expires = 0;
  assert.equal((await w.send('EXTERNAL_GET')).error, 'EXTERNAL_CONTEXT_EXPIRED');
});
test('late search responses after a navigation are discarded and never cached', async () => {
  let complete;
  const w = await setup({ fetcher: async () => new Promise(resolve => { complete = resolve; }) });
  const pending = w.send('EXTERNAL_SEARCH', { query: 'Academy' });
  while (!complete) await new Promise(resolve => setTimeout(resolve, 1));
  w.navigate('OTHER'); complete(response({ status: 0, sub: { subs: [subtitle] } }));
  assert.equal((await pending).error, 'EXTERNAL_CONTEXT_EXPIRED');
  assert.equal(w.app.local.externalSubCache, undefined);
});
test('missing permissions or key prevents requests; clearing key leaves cached subtitles usable', async () => {
  const w = await setup(), p = await preview(w);
  await w.send('EXTERNAL_CLEAR_KEY');
  assert.equal((await w.send('EXTERNAL_SEARCH', { query: 'Academy' })).error, 'ASSRT_KEY_REQUIRED');
  assert.equal((await preview(w)).cached, true); assert.equal((await apply(w, p)).ok, true);
  assert.equal(w.network.length, 2);
  const denied = await setup({ allowed: false });
  assert.equal((await denied.send('EXTERNAL_SAVE_KEY', { key: KEY })).error, 'ASSRT_PERMISSION_REQUIRED');
  assert.equal((await denied.send('EXTERNAL_SEARCH', { query: 'Academy' })).error, 'ASSRT_PERMISSION_REQUIRED');
  assert.equal(denied.network.length, 0);
});
test('serialized rate budget permits at most five requests and persists across worker recreation', async () => {
  const w = await setup();
  const requests = await Promise.all(Array.from({ length: 6 }, (_, i) => w.send('EXTERNAL_SEARCH', { query: `Academy ${i}` })));
  assert.equal(requests.filter(r => r.ok).length, 5);
  assert.equal(requests[5].error, 'ASSRT_RATE_LIMIT'); assert.ok(requests[5].retryAfter <= 60);
  assert.equal(w.network.length, 5);
  const fresh = background({ data: w.app.local });
  assert.equal((await fresh.send('EXTERNAL_QUOTA')).error, 'ASSRT_RATE_LIMIT');
  assert.equal(fresh.calls.filter(r => Array.isArray(r)).length, 0);
});
test('429 cooldown and network errors never trigger automatic retries or expose provider bodies', async () => {
  const w = await setup({ fetcher: async () => response({ status: 30900, error: KEY }) });
  assert.equal((await w.send('EXTERNAL_SEARCH', { query: 'Academy' })).error, 'ASSRT_RATE_LIMIT');
  const r = await w.send('EXTERNAL_SEARCH', { query: 'Academy' });
  assert.equal(r.error, 'ASSRT_RATE_LIMIT'); assert.ok(r.retryAfter);
  assert.equal(w.network.length, 1); assert.ok(!JSON.stringify(r).includes(KEY));
});
test('invalid sync, language and foreign file IDs cannot load a track', async () => {
  const w = await setup(), p = await preview(w);
  for (const sync of [{ mode: 'linear', scale: -1, offset: 0 }, { mode: 'linear', scale: 1, offset: 9999 }, { mode: 'anchors' }]) {
    assert.equal((await apply(w, p, { sync })).error, 'EXTERNAL_INVALID_SYNC');
  }
  assert.equal((await apply(w, p, { lang: 'evil' })).error, 'INVALID_LANGUAGE');
  assert.equal((await apply(w, { key: 'foreign' })).error, 'EXTERNAL_FILE_EXPIRED');
  assert.equal(w.applied.length, 0);
});
test('late subtitle downloads after navigation never enter cache or replace current playback', async () => {
  let finish;
  const w = await setup({ fetcher: async url => url.includes('/sub/detail')
    ? response({ status: 0, sub: { subs: [subtitle] } }) : new Promise(resolve => { finish = resolve; }) });
  const pending = preview(w);
  while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
  w.navigate('NEXT'); finish(response(srt));
  assert.equal((await pending).error, 'EXTERNAL_CONTEXT_EXPIRED');
  assert.equal(w.app.local.externalSubCache, undefined);
  assert.equal(w.applied.length, 0);
});
test('invalid subtitle content does not cache or install an empty track', async () => {
  const w = await setup({ fetcher: async url => url.includes('/sub/detail')
    ? response({ status: 0, sub: { subs: [subtitle] } }) : response('not a subtitle') });
  assert.equal((await preview(w)).error, 'ASSRT_INVALID_FILE');
  assert.equal(w.app.local.externalSubCache, undefined);
  assert.equal(w.applied.length, 0);
});

test('external ASS preview skips zero-duration effects without changing cached raw ASS or rejecting valid dialogue', async () => {
  const text = '[Script Info]\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
    'Dialogue: 0,0:00:01.00,0:00:01.00,Default,,0,0,0,,zero-effect\n' +
    'Dialogue: 0,0:00:02.00,0:00:05.00,Default,,0,0,0,,valid-dialogue\n';
  const w = await setup({ fetcher: async url => url.includes('/sub/detail')
    ? response({ status: 0, sub: { subs: [{ ...subtitle, filename: 'episode.ass' }] } }) : response(text) });
  const p = await w.send('EXTERNAL_PREVIEW', { id: 42, filename: 'episode.ass' });
  assert.equal(p.ok, true);
  assert.equal(p.count, 1);
  assert.equal(p.cues[0].text, 'valid-dialogue');
  assert.equal(w.app.local.externalSubCache.files[0].text, text);
  assert.equal((await apply(w, p)).ok, true);
  assert.equal(w.applied[0].text, text);
});

test('browser download opens only an explicitly selected fresh safe URL and rejects website requests', async () => {
  const w = await setup();
  const payload = { id: 42, filename: 'episode.srt' };
  const r = await w.send('EXTERNAL_DOWNLOAD_OPEN', payload);
  assert.equal(r.ok, true);
  assert.equal(w.network.length, 1);
  assert.equal(w.opened.at(-1).url, subtitle.url);
  assert.ok(!JSON.stringify(r).includes('expired'));
  assert.equal((await w.send('EXTERNAL_DOWNLOAD_OPEN', payload, w.app.content)).error, 'SENDER_NOT_ALLOWED');
  assert.equal((await w.send('EXTERNAL_DOWNLOAD_OPEN', { ...payload, filename: 'other.srt' })).error, 'ASSRT_FILE_CHANGED');
  w.navigate('NEXT');
  assert.equal((await w.send('EXTERNAL_DOWNLOAD_OPEN', payload)).error, 'EXTERNAL_CONTEXT_EXPIRED');
  const unsafe = await setup({ fetcher: async () => response({ status: 0, sub: { subs: [{ ...subtitle, url: 'https://evil.net/file.srt' }] } }) });
  assert.equal((await unsafe.send('EXTERNAL_DOWNLOAD_OPEN', payload)).error, 'ASSRT_DOWNLOAD_UNSAFE');
  assert.equal(unsafe.opened.length, 1);
});

test('dedicated cache accepts large ASS, migrates legacy selection and keeps translation storage untouched', async () => {
  const w = await setup(), p = await preview(w); await apply(w, p);
  const text = '[Script Info]\n;' + 'x'.repeat(4 * 1024 * 1024) + '\n[Events]\n' +
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
    Array.from({ length: 12500 }, (_, i) => `Dialogue: 0,0:00:02.00,0:00:05.00,Default,,0,0,0,,line${i}`).join('\n');
  let stored;
  const cacheStore = { get: async () => structuredClone(stored), set: async value => { stored = structuredClone(value); } };
  w.app.local.mtApiKey = 'preserved';
  const service = w.app.ctx.CRSubFix.externalSubs.create(w.app.ctx.chrome, { cacheStore, fetcher: async url =>
    url.includes('/sub/detail') ? response({ status: 0, sub: { subs: [{ ...subtitle, filename: 'large.ass', size: '5MB' }] } }) : response(text) });
  // Reading the old selection must work before the first IndexedDB commit.
  assert.equal((await service.restore('ABC')).record.text, srt);
  const large = await service.preview({ snapshot: w.snapshot, id: 42, filename: 'large.ass' });
  assert.equal(large.count, 12500);
  assert.equal(w.app.local.externalSubCache, undefined);
  assert.equal(w.app.local.mtApiKey, 'preserved');
  assert.equal((await service.restore('ABC')).record.text, srt);
  assert.ok(stored.files.some(f => f.name === 'large.ass' && f.text === text));
});

test('failed dedicated cache commit retains the complete legacy cache and translation settings', async () => {
  const w = await setup(), p = await preview(w); await apply(w, p);
  const before = structuredClone(w.app.local.externalSubCache);
  const service = w.app.ctx.CRSubFix.externalSubs.create(w.app.ctx.chrome, {
    cacheStore: { get: async () => undefined, set: async () => { throw new Error('quota'); } },
  });
  await assert.rejects(service.setActive({ guid: 'ABC', id: '' }), /EXTERNAL_CACHE_SAVE_FAILED/);
  assert.deepEqual(w.app.local.externalSubCache, before);
});
test('invalid external tab sender and wrong opening GUID are rejected before storage reads or network', async () => {
  const w = await setup();
  assert.equal((await w.send('EXTERNAL_GET', {}, { ...w.app.popup, id: 'foreign' })).error, 'SENDER_NOT_ALLOWED');
  assert.equal((await w.app.send('EXTERNAL_OPEN', { guid: 'OTHER' }, w.app.content)).error, 'EXTERNAL_CONTEXT_EXPIRED');
  assert.equal((await w.app.send('EXTERNAL_RESTORE', { guid: 'ABC' }, { ...w.app.content, frameId: 1 })).error, 'SENDER_NOT_ALLOWED');
  assert.equal(w.network.length, 0);
});
test('file eviction forgets only evicted selections and does not corrupt translation configuration', async () => {
  const w = await setup(), p = await preview(w); await apply(w, p);
  const db = w.app.local.externalSubCache;
  db.files = Array.from({ length: 9 }, (_, i) => ({ ...db.files[0], key: `old-${i}` }));
  db.selections = { ABC: { key: 'old-0', sync: { mode: 'none' } }, OTHER: { key: 'old-8', sync: { mode: 'none' } } };
  w.app.local.mtApiKey = 'unrelated-relay-key';
  await w.send('EXTERNAL_SEARCH', { query: 'Academy' });
  assert.equal(w.app.local.externalSubCache.files.length, 8);
  assert.equal(w.app.local.externalSubCache.selections.ABC, undefined);
  assert.ok(w.app.local.externalSubCache.selections.OTHER);
  assert.equal(w.app.local.mtApiKey, 'unrelated-relay-key');
});
test('turning subtitles off retains selected file but does not auto activate it on refresh', async () => {
  const w = await setup(), p = await preview(w); await apply(w, p);
  assert.equal((await w.app.send('EXTERNAL_ACTIVE', { guid: 'ABC', id: '' }, w.app.content)).ok, true);
  const r = await w.app.send('EXTERNAL_RESTORE', { guid: 'ABC' }, w.app.content);
  assert.equal(r.active, false); assert.equal(r.record.text, srt);
  assert.equal((await w.send('EXTERNAL_GET')).selected.key, p.key);
  const selected = await w.app.send('EXTERNAL_ACTIVE', { guid: 'ABC', id: r.record.id,
    sync: { mode: 'linear', scale: 1, offset: 2 }, lang: 'zh-CN' }, w.app.content);
  assert.equal(selected.ok, true);
  assert.equal((await w.app.send('EXTERNAL_RESTORE', { guid: 'ABC' }, w.app.content)).active, true);
  assert.equal(w.network.length, 2);
});
test('website cannot activate an unapproved preview file through the local selection bridge', async () => {
  const w = await setup(), p = await preview(w);
  const id = `custom:assrt:42:${p.key.split(':').at(-1)}`;
  assert.equal((await w.app.send('EXTERNAL_ACTIVE', { guid: 'ABC', id, sync: { mode: 'none' }, lang: 'zh-CN' },
    w.app.content)).error, 'EXTERNAL_FILE_EXPIRED');
  assert.equal(w.app.local.externalSubCache.selections.ABC, undefined);
});
test('oversized external cache entries and storage failures preserve existing translation keys', async () => {
  const large = srt + ' '.repeat(600000);
  const w = await setup({ fetcher: async url => url.includes('/sub/detail')
    ? response({ status: 0, sub: { subs: [subtitle] } }) : response(large) });
  w.app.local.mtApiKey = 'relay-untouched';
  assert.equal((await preview(w)).error, 'EXTERNAL_CACHE_FULL');
  assert.equal(w.app.local.externalSubCache, undefined);
  assert.equal(w.app.local.mtApiKey, 'relay-untouched');
  const small = await setup();
  const originalSet = small.app.ctx.chrome.storage.local.set;
  small.app.ctx.chrome.storage.local.set = async value => {
    if ('externalSubCache' in value) throw new Error('QUOTA_BYTES');
    return originalSet(value);
  };
  assert.equal((await preview(small)).error, 'EXTERNAL_CACHE_SAVE_FAILED');
  assert.equal(small.app.local.externalSubCache, undefined);
});
test('re-downloading an identical file preserves prior approval for menu selection', async () => {
  const w = await setup(), p = await preview(w); await apply(w, p);
  await w.send('EXTERNAL_PREVIEW', { id: 42, filename: 'episode.srt', encoding: 'auto', refresh: true });
  assert.equal(w.app.local.externalSubCache.files[0].approved, true);
});
