import test from 'node:test';
import assert from 'node:assert/strict';
import { context, load, background, config } from './helpers.mjs';

function engine() {
  const c = context();
  for (const f of ['work-profiles', 'collection-match', 'search-names', 'subtitle-assist']) load(c, `lib/${f}.js`);
  return c.CRSubFix;
}
const meta = { guid: 'ABC', title: '不時輕聲地以俄語遮羞的鄰座艾莉同學', pageLanguage: 'zh-TW', seriesId: 'SERIES', season: 1, episode: 4 };
const netflix = ep => `時々ボソッとロシア語でデレる隣のアーリャさん.S01E${String(ep).padStart(2, '0')}.${ep === 4 ? '溢れ出す想い' : 'それぞれの居場所'}.WEBRip.Netflix.ja[cc].srt`;
const atx = (ep, format = 'ass') => `Tokidoki Bosotto Russia-go de Dereru Tonari no Alya-san - ${String(ep).padStart(2, '0')} 「第${ep}話」 (AT-X 1280x720 x264 AAC).${format}`;
const ember = ep => `[EMBER] Alya Sometimes Hides Her Feelings in Russian S01E${String(ep).padStart(2, '0')}-Episode ${ep} [${ep === 4 ? '70B120D6' : 'ABCDEF12'}].ja.srt`;
const file = name => ({ name, fileId: name, format: name.endsWith('.srt') ? 'SRT' : 'ASS' });

test('changing Netflix episode titles preserves one release for all twelve episodes', () => {
  const C = engine().collectionMatch, files = Array.from({ length: 12 }, (_, i) => file(netflix(i + 1)));
  const groups = C.groups(files);
  assert.equal(groups.length, 1); assert.equal(groups[0].episodes.length, 12);
  for (let episode = 1; episode <= 12; episode++) assert.equal(C.select(files, { signature: groups[0].signature }, { season: 1, episode })[0].name, netflix(episode));
});
test('AT-X episode titles, EMBER hashes and compact JPN names are recognized without conflating releases', () => {
  const C = engine().collectionMatch;
  const files = [1, 2, 3].flatMap(ep => [file(atx(ep)), file(atx(ep, 'srt')), file(ember(ep)), file(`Roshidere-${String(ep).padStart(2, '0')}-JPN v1.ass`)]);
  const groups = C.groups(files);
  assert.equal(groups.length, 4); assert.ok(groups.every(g => g.episodes.length === 3));
  assert.equal(C.parse('Roshidere-12-JPN v1.ass').episode, 12);
});
test('platform, format, season, language, SDH and revision differences stay in separate groups', () => {
  const C = engine().collectionMatch;
  const names = [netflix(4), netflix(4).replace('Netflix', 'AMZN'), netflix(4).replace('.srt', '.ass'),
    netflix(4).replace('S01', 'S02'), netflix(4).replace('ja[cc]', 'en'), netflix(4).replace('ja[cc]', 'ja.sdh'),
    'Roshidere-04-JPN v1.ass', 'Roshidere-04-JPN v2.ass'];
  assert.equal(C.groups(names.map(file)).length, names.length);
  const anchor = file(netflix(4));
  for (const name of names.slice(1).filter(n => !n.includes('S02'))) assert.equal(C.compatible(anchor.name, name), false, name);
});
test('a confirmed map cannot invent files, change a known episode, repeat an episode or switch revisions', () => {
  const C = engine().collectionMatch, files = [4, 5].map(ep => file(netflix(ep))), anchor = files[0];
  const rows = files.map((f, i) => ({ ...f, episode: i + 4 }));
  assert.equal(C.validateMap(files, rows, anchor, meta).length, 2);
  for (const invalid of [[{ ...rows[0], name: 'invented.srt' }], [{ ...rows[0], episode: 5 }],
    [rows[0], { ...rows[1], episode: 4 }], [{ ...rows[0], fileId: 'missing' }]])
    assert.throws(() => C.validateMap(files, invalid, anchor, meta), /FOLLOW_MAP_INVALID/);
});
test('unparseable names can be mapped explicitly; maps only select the exact confirmed file', () => {
  const C = engine().collectionMatch, files = ['alpha.ja.srt', 'beta.ja.srt', 'gamma.ja.srt'].map(file);
  const rows = files.map((f, i) => ({ ...f, episode: i + 4 }));
  const mapping = C.validateMap(files, rows, files[0], meta);
  assert.equal(C.select(files, { mapping }, { episode: 5, season: 1 })[0].name, 'beta.ja.srt');
  assert.equal(C.select([file('replacement.ja.srt')], { mapping }, { episode: 5, season: 1 }).length, 0);
  const known = [4, 5].map(ep => file(netflix(ep)));
  const subset = C.validateMap(known, [{ ...known[0], episode: 4 }], known[0], meta);
  assert.equal(C.select(known, { mapping: subset, signature: C.parse(known[0].name).signature }, { episode: 5, season: 1 }).length, 0);
});
test('identical current-episode releases remain ambiguous, and special or multi-episode files never auto-follow', () => {
  const C = engine().collectionMatch, files = [file(netflix(5)), file(netflix(5))];
  assert.equal(C.select(files, { signature: C.parse(netflix(4)).signature }, { season: 1, episode: 5 }).length, 2);
  for (const n of ['Show S01E04-E05.ja.srt', 'Show - 04 OVA.ass', 'Show SP01.ass']) assert.equal(C.parse(n), null);
});
test('local OpenCC conversion is offline, does not turn Japanese titles into Chinese titles, and preserves provenance', () => {
  const c = context(); load(c, 'lib/opencc.js'); load(c, 'lib/search-names.js');
  const converters = { simplified: c.OpenCC.Converter({ from: 'tw', to: 'cn' }), traditional: c.OpenCC.Converter({ from: 'cn', to: 'tw' }) };
  const records = c.CRSubFix.searchNames.base(meta, converters);
  assert.equal(records.find(r => r.language === 'zh-CN').name, '不时轻声地以俄语遮羞的邻座艾莉同学');
  assert.equal(records.find(r => r.language === 'zh-CN').source, 'conversion');
  assert.equal(c.CRSubFix.searchNames.base({ ...meta, title: '時々ボソッとロシア語', pageLanguage: 'ja' }, converters).length, 1);
});
test('official names supersede AI guesses only for the same name/language; AI confirmation never becomes official', () => {
  const N = engine().searchNames;
  const rows = N.merge([{ name: 'Alya', language: 'en', source: 'ai' }], [{ name: 'Alya', language: 'en', source: 'official', url: 'https://www.crunchyroll.com/series/SERIES' }]);
  assert.equal(rows.length, 1); assert.equal(rows[0].source, 'official');
  const ai = N.merge([{ name: 'Guess', language: 'en', source: 'ai' }], [{ name: 'Guess', language: 'en', source: 'ai', confirmed: true }]);
  assert.equal(ai[0].source, 'ai'); assert.equal(ai[0].confirmed, true);
});
function doc(name, language = 'en', seriesId = 'SERIES', type = 'TVSeries') {
  return { documentElement: { lang: language }, querySelector: selector => selector.startsWith('link') ? { href: `https://www.crunchyroll.com/series/${seriesId}` } : null,
    querySelectorAll: () => [{ textContent: JSON.stringify({ '@type': type, url: `/series/${seriesId}`, name }) }] };
}
test('official extraction requires the exact series, correct locale and series-level evidence', () => {
  const N = engine().searchNames, url = 'https://www.crunchyroll.com/en/series/SERIES';
  assert.equal(N.extract(doc('Alya'), 'SERIES', url, 'en')[0].source, 'official');
  assert.equal(N.extract(doc('Wrong', 'en', 'OTHER'), 'SERIES', url, 'en').length, 0);
  assert.equal(N.extract(doc('English fallback'), 'SERIES', url, 'ja').length, 0);
  assert.equal(N.extract(doc('Episode name', 'en', 'SERIES', 'TVEpisode'), 'SERIES', url, 'en').length, 0);
});
test('real CR generic zh language and Watch-prefixed JSON-LD use the canonical locale and verified heading', () => {
  const N = engine().searchNames, name = meta.title;
  const document = { documentElement: { lang: 'zh' }, querySelector: selector =>
    selector.startsWith('link') ? { href: 'https://www.crunchyroll.com/zh-tw/series/SERIES/title' } :
    selector.startsWith('meta') ? { content: 'video.tv_show' } : { textContent: name },
    querySelectorAll: () => [{ textContent: JSON.stringify({ '@type': 'TVSeries', url: '/zh-tw/series/SERIES/title', name: `Watch ${name}` }) }] };
  const records = N.extract(document, 'SERIES', 'https://www.crunchyroll.com/zh-tw/series/SERIES/title', 'zh-TW');
  assert.equal(records.length, 1); assert.equal(records[0].name, name); assert.equal(records[0].language, 'zh-TW');
  assert.equal(N.extract(document, 'SERIES', 'https://www.crunchyroll.com/zh-tw/series/SERIES/title', 'zh-CN').length, 0);
});
test('official locale failures are isolated; only first-party session credentials are allowed and navigation discards results', async () => {
  const N = engine().searchNames; let url = 'https://www.crunchyroll.com/watch/ABC/title', count = 0;
  const fetcher = async (href, init) => {
    count++; assert.equal(init.credentials, 'same-origin'); assert.equal(init.headers, undefined);
    return { ok: true, url: href, headers: new Headers(), text: async () => href.includes('/en/') ? 'good' : 'bad' };
  };
  const result = await N.official(meta, () => url, fetcher, html => html === 'good' ? doc('Alya') : doc('English fallback'));
  assert.equal(count, 4); assert.equal(result.records.length, 1); assert.equal(result.unavailable.length, 3);
  await assert.rejects(() => N.official(meta, () => url, async (...args) => { const r = await fetcher(...args); url = 'https://www.crunchyroll.com/watch/OTHER/title'; return r; }, () => doc('Alya')), /EXTERNAL_CONTEXT_EXPIRED/);
});
test('AI title schema is bounded and never sets official provenance', () => {
  const A = engine().subtitleAssist;
  assert.equal(A.parseNames({ names: [{ name: 'Alya', language: 'en', source: 'official' }] })[0].source, 'ai');
  for (const data of [{ names: [{ name: '', language: 'en' }] }, { names: [{ name: 'x', language: 'xx' }] }, { names: Array(11).fill({ name: 'x', language: 'en' }) }])
    assert.throws(() => A.parseNames(data), /ASSIST_INVALID_RESPONSE/);
});

test('oversized streamed official pages are cancelled before parsing and do not erase existing candidates', async () => {
  const N = engine().searchNames; let cancelled = 0, parsed = 0;
  const fetcher = async href => ({ ok: true, url: href, headers: new Headers(), body: {
    getReader: () => ({ read: async () => ({ done: false, value: new Uint8Array(4000001) }),
      cancel: async () => { cancelled++; }, releaseLock: () => {} }) } });
  const result = await N.official(meta, () => 'https://www.crunchyroll.com/watch/ABC', fetcher, () => { parsed++; return doc('Alya'); });
  assert.equal(cancelled, 4); assert.equal(parsed, 0); assert.equal(result.records.length, 0); assert.equal(result.unavailable.length, 4);
});
test('AI file schema allows unknown episodes but rejects invented IDs, duplicate IDs and contradictions', () => {
  const A = engine().subtitleAssist, files = [file(netflix(4)), file(netflix(5)), file(atx(5))];
  const input = A.prepareFiles(meta, files, files[0]);
  assert.equal(input.files.length, 2); assert.equal(input.files[0].name, files[0].name);
  assert.equal(A.parseFiles({ files: [{ id: '0', episode: 5, same_release: true }] }, input)[0].selected, false);
  for (const rows of [[{ id: 'invented', episode: 5, same_release: true }],
    [{ id: '0', episode: 4, same_release: true }, { id: '0', episode: 4, same_release: true }]])
    assert.throws(() => A.parseFiles({ files: rows }, input), /ASSIST_INVALID_RESPONSE/);
});

async function appSetup(data = {}, fetcher) {
  let current = { ...meta }; const app = background({ data, fetcher });
  app.ctx.chrome.tabs.create = async value => { app.opened = value.url; };
  app.ctx.chrome.tabs.sendMessage = async (_, msg) => msg.type === 'WORK_PAGE_CHECK' ?
    { guid: current.guid, url: `https://www.crunchyroll.com/watch/${current.guid}/title`, metadata: current } :
    msg.type === 'EXTERNAL_OFFICIAL_NAMES' ? { ok: true, records: [{ name: 'Alya', language: 'en', source: 'official', url: `https://www.crunchyroll.com/en/series/${current.seriesId}` }], unavailable: ['ja'] } : { ok: true };
  await app.send('EXTERNAL_OPEN', { guid: 'ABC', metadata: meta }, app.content);
  const snapshot = new URL(app.opened).searchParams.get('snapshot');
  return { app, snapshot, navigate: value => { current = value; }, send: (type, payload = {}) => app.send(type, { snapshot, ...payload }) };
}
test('opening and local name selection require no AI; no API and DeepL-only gracefully reject optional analysis', async () => {
  for (const data of [{}, { relayConfig: { provider: 'deepl' }, mtApiKey: 'synthetic:fx' }]) {
    const w = await appSetup(data);
    assert.equal((await w.send('EXTERNAL_ASSIST_CONFIG')).available, false);
    assert.equal((await w.send('EXTERNAL_NAMES', { action: 'select', name: 'Alya', language: 'en' })).ok, true);
    assert.equal((await w.send('EXTERNAL_ASSIST', { action: 'names' })).error, 'ASSIST_NOT_CONFIGURED');
    assert.equal(w.app.calls.filter(c => Array.isArray(c) && c[0] === 'fetch').length, 0);
  }
});
test('independent analysis API leaves DeepL translation intact, keeps secrets private and requires a new key for a different host', async () => {
  const w = await appSetup({ relayConfig: { provider: 'deepl' }, mtApiKey: 'synthetic:fx' });
  const saved = await w.send('EXTERNAL_ASSIST_SAVE', { config, apiKey: 'synthetic-analysis-secret' });
  assert.equal(saved.independent, true); assert.equal(saved.available, true);
  assert.ok(!JSON.stringify(saved).includes('synthetic-analysis-secret'));
  assert.equal(w.app.local.mtApiKey, 'synthetic:fx'); assert.equal(w.app.local.relayConfig.provider, 'deepl');
  assert.equal((await w.send('EXTERNAL_ASSIST_SAVE', { config: { ...config, baseUrl: 'https://other.example/v1' } })).error, 'KEY_REQUIRED');
  await w.send('EXTERNAL_ASSIST_CLEAR'); assert.equal(w.app.local.mtApiKey, 'synthetic:fx');
});
test('official query caches successful results separately from names chosen for different sources and seasons', async () => {
  const w = await appSetup(); let requests = 0;
  const original = w.app.ctx.chrome.tabs.sendMessage;
  w.app.ctx.chrome.tabs.sendMessage = async (...args) => { if (args[1].type === 'EXTERNAL_OFFICIAL_NAMES') requests++; return original(...args); };
  assert.equal((await w.send('EXTERNAL_NAMES', { action: 'official' })).ok, true);
  assert.equal((await w.send('EXTERNAL_NAMES', { action: 'official' })).cached, true); assert.equal(requests, 1);
  await w.send('EXTERNAL_NAMES', { action: 'select', source: 'jimaku', name: 'Alya', language: 'en' });
  assert.equal((await w.send('EXTERNAL_GET')).nameState.choices.jimaku.name, 'Alya');
  w.navigate({ ...meta, season: 2 }); assert.equal((await w.send('EXTERNAL_GET')).nameState.records.length, 0);
});
test('optional AI title analysis is explicit, one request, scoped, and confirmation retains AI provenance', async () => {
  let requests = 0;
  const w = await appSetup({ relayConfig: config, mtApiKey: 'synthetic-key' }, async (_, init) => {
    requests++; const body = JSON.parse(init.body); assert.equal(body.stream, false);
    assert.equal(JSON.parse(body.messages[1].content).task, 'search-name-candidates');
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"names":[{"name":"Alya","language":"en"}]}' } }] }));
  });
  assert.equal(requests, 0);
  assert.equal((await w.send('EXTERNAL_ASSIST', { action: 'names' })).nameState.records[0].source, 'ai');
  assert.equal(requests, 1);
  const selected = await w.send('EXTERNAL_NAMES', { action: 'select', name: 'Alya', language: 'en' });
  assert.equal(selected.nameState.records[0].source, 'ai'); assert.equal(selected.nameState.records[0].confirmed, true);
});

test('AI analysis honors explicitly corrected work metadata without trusting another series identity', async () => {
  const w = await appSetup({ relayConfig: config, mtApiKey: 'synthetic-key' }, async (_, init) => {
    const input = JSON.parse(JSON.parse(init.body).messages[1].content);
    assert.equal(input.title, 'Corrected localized title'); assert.equal(input.season, 2);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"names":[]}' } }] }));
  });
  const result = await w.send('EXTERNAL_ASSIST', { action: 'names', metadata: { title: 'Corrected localized title', season: 2, seriesId: 'OTHER' } });
  assert.equal(result.ok, true);
  assert.ok(Object.keys(w.app.local.externalSubCache.nameProfiles).every(key => !key.includes('OTHER')));
});
test('website cannot invoke analysis or read independent settings, and expired snapshots spend nothing', async () => {
  const w = await appSetup({ relayConfig: config, mtApiKey: 'synthetic-key' });
  for (const type of ['EXTERNAL_ASSIST', 'EXTERNAL_ASSIST_CONFIG', 'EXTERNAL_ASSIST_SAVE', 'EXTERNAL_NAMES'])
    assert.equal((await w.app.send(type, { snapshot: w.snapshot, action: 'names' }, w.app.content)).error, 'SENDER_NOT_ALLOWED');
  w.navigate({ ...meta, guid: 'OTHER' });
  assert.equal((await w.send('EXTERNAL_ASSIST', { action: 'names' })).error, 'EXTERNAL_CONTEXT_EXPIRED');
  assert.equal(w.app.calls.filter(c => Array.isArray(c) && c[0] === 'fetch').length, 0);
});
test('AI failure or navigation never retries or installs subtitle mappings', async () => {
  let requests = 0, finish;
  const w = await appSetup({ relayConfig: config, mtApiKey: 'synthetic-key' }, () => { requests++; return new Promise(resolve => { finish = resolve; }); });
  const task = w.send('EXTERNAL_ASSIST', { action: 'names' });
  while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal((await w.send('EXTERNAL_ASSIST', { action: 'names' })).error, 'BUSY');
  w.navigate({ ...meta, guid: 'OTHER' });
  finish(new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"names":[{"name":"Alya","language":"en"}]}' } }] })));
  assert.equal((await task).error, 'EXTERNAL_CONTEXT_EXPIRED'); assert.equal(requests, 1);
  assert.equal(w.app.local.externalSubCache, undefined);
});
test('confirmed opaque-name mapping follows the next episode, preserves offset and restores the directory index without network', async () => {
  const files = ['alpha.ja.srt', 'beta.ja.srt'].map(name => ({ f: name, url: `https://file1.assrt.net/${name}` }));
  let requests = 0;
  const w = await appSetup({ assrtApiKey: 'a'.repeat(32) }, async url => {
    requests++;
    return new Response(url.includes('/sub/detail') ? JSON.stringify({ status: 0, sub: { subs: [{ id: 42, filelist: files }] } }) :
      '1\n00:00:01,000 --> 00:00:04,000\nこんにちは\n');
  });
  const detail = await w.send('EXTERNAL_DETAIL', { id: 42 });
  const preview = await w.send('EXTERNAL_PREVIEW', { id: 42, filename: files[0].f });
  const mapping = detail.files.map((f, i) => ({ name: f.name, fileId: f.fileId || '', episode: i + 4 }));
  const applied = await w.send('EXTERNAL_APPLY', { key: preview.key, follow: true, inheritOffset: true, lang: 'ja-JP',
    sync: { mode: 'linear', scale: 1, offset: -1.2 }, metadata: meta, collectionMap: mapping });
  assert.equal(applied.ok, true); assert.equal(applied.followRule.mapping.length, 2);
  const next = { ...meta, guid: 'NEXT', episode: 5 }; w.navigate(next);
  const restore = await w.app.send('EXTERNAL_RESTORE', { guid: next.guid, metadata: next }, w.app.content);
  assert.equal(restore.record.filename, 'beta.ja.srt'); assert.equal(restore.record.sync.offset, -1.2);
  await w.app.send('EXTERNAL_OPEN', { guid: next.guid, metadata: next }, w.app.content);
  const snapshot = new URL(w.app.opened).searchParams.get('snapshot'), before = requests;
  const loaded = await w.app.send('EXTERNAL_GET', { snapshot });
  assert.equal(loaded.collectionFiles.length, 2); assert.equal(loaded.followRule.mapping.length, 2);
  assert.equal(requests, before);
  assert.equal((await w.app.send('EXTERNAL_APPLY', { snapshot, key: loaded.selected.key, follow: true, lang: 'ja-JP',
    sync: loaded.selected.sync, metadata: next, collectionMap: mapping })).ok, true);
});
test('file analysis uses only the current confirmed directory, returns suggestions and never enables following itself', async () => {
  let paid = 0;
  const w = await appSetup({ relayConfig: config, mtApiKey: 'synthetic-key', assrtApiKey: 'a'.repeat(32) }, async (url, init) => {
    if (url.includes('/sub/detail')) return new Response(JSON.stringify({ status: 0, sub: { subs: [{ id: 42,
      filelist: [4, 5].map(ep => ({ f: netflix(ep), url: `https://file1.assrt.net/${ep}.srt` })) }] } }));
    paid++; const input = JSON.parse(JSON.parse(init.body).messages[1].content);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ files:
      input.files.map(f => ({ id: f.id, episode: f.known_episode, same_release: true })) }) } }] }));
  });
  assert.equal((await w.send('EXTERNAL_ASSIST', { action: 'files', id: 42, filename: netflix(4) })).error, 'ASSIST_FILES_EXPIRED');
  await w.send('EXTERNAL_DETAIL', { id: 42 });
  const result = await w.send('EXTERNAL_ASSIST', { action: 'files', id: 42, filename: netflix(4) });
  assert.equal(result.suggestions.length, 2); assert.equal(paid, 1);
  assert.deepEqual(w.app.local.externalSubCache.followRules, {});
});
