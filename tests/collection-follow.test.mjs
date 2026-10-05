import test from 'node:test';
import assert from 'node:assert/strict';
import { background, context, load } from './helpers.mjs';

const KEY = 'a'.repeat(32);
const filename = ep => `Kono 2 - ${String(ep).padStart(2, '0')} (BD 1080p).TC-Group.ass`;
const text = '[Script Info]\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
  'Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,dialogue';
const response = value => new Response(typeof value === 'string' ? value : JSON.stringify(value));
test('episode label fallback requires an explicit consistent season and episode for the current watch', () => {
  const c = context();
  let guid = 'CURRENT';
  c.CRSubFix = { workProfiles: { detect: () => ({ guid, seriesId: 'SERIES' }), route: () => null } };
  load(c, 'lib/episode-metadata.js');
  const detect = (title, heading = '') => c.CRSubFix.episodeMetadata.detect({ title,
    querySelectorAll: selector => selector === 'main h1' ? [{ textContent: heading }] : [] }, 'https://www.crunchyroll.com/watch/CURRENT/title');
  assert.equal(detect('Show S2 E3').episode, 3);
  assert.equal(detect('Show S2:E3').season, 2);
  assert.equal(detect('Show 第2季第3集').episode, 3);
  assert.equal(detect('Show S2 E3', 'Show S2 E4').episode, null);
  assert.equal(detect('Show episode 3').episode, null);
  guid = '';
  assert.equal(detect('Show S2 E3').episode, null);
});

test('metadata wait accepts a late current-episode record and abandons navigation or an expired wait', async () => {
  const c = context(); load(c, 'lib/work-profiles.js'); load(c, 'lib/episode-metadata.js');
  const M = c.CRSubFix.episodeMetadata;
  let clock = 0, url = 'https://www.crunchyroll.com/watch/NEXT/title', records = [];
  const doc = { querySelectorAll: selector => selector.startsWith('script')
    ? records.map(v => ({ textContent: JSON.stringify(v) })) : [] };
  const record = { url, episodeNumber: 4, partOfSeason: { seasonNumber: 2 },
    partOfSeries: { url: '/series/SERIES/title', name: 'Show' } };
  const metadata = await M.wait(doc, () => url, 'NEXT', { now: () => clock, timeoutMs: 100,
    sleep: async ms => { clock += ms; records = [record]; }, intervalMs: 10 });
  assert.equal(metadata.episode, 4); assert.equal(clock, 10);
  records = []; clock = 0;
  assert.equal(await M.wait(doc, () => url, 'NEXT', { now: () => clock, timeoutMs: 100,
    sleep: async () => { url = 'https://www.crunchyroll.com/watch/OTHER/title'; }, intervalMs: 10 }), null);
  url = record.url; clock = 0;
  const expired = await M.wait(doc, () => url, 'NEXT', { now: () => clock, timeoutMs: 20,
    sleep: async ms => { clock += ms; }, intervalMs: 10 });
  assert.equal(expired.episode, null); assert.equal(clock, 20);
});

test('default metadata readiness window survives a slow SPA update beyond six seconds', async () => {
  const c = context(); load(c, 'lib/work-profiles.js'); load(c, 'lib/episode-metadata.js');
  const url = 'https://www.crunchyroll.com/watch/NEXT/title';
  let clock = 0;
  const record = { url, episodeNumber: 4, partOfSeason: { seasonNumber: 1 },
    partOfSeries: { url: '/series/SERIES/title', name: 'Show' } };
  const doc = { querySelectorAll: selector => selector.startsWith('script') && clock >= 7500
    ? [{ textContent: JSON.stringify(record) }] : [] };
  const meta = await c.CRSubFix.episodeMetadata.wait(doc, () => url, 'NEXT', {
    now: () => clock, sleep: async ms => { clock += ms; } });
  assert.equal(meta.episode, 4); assert.equal(clock, 7500);
});
async function setup(makeFilename = filename) {
  let guid = 'ABC', files = [1, 2, 3].map(ep => ({ f: makeFilename(ep), url: `https://file1.assrt.net/${ep}.ass` })), delayed;
  const calls = [], opened = [], applied = [];
  const app = background({ data: { assrtApiKey: KEY }, fetcher: async url => {
    calls.push(url);
    if (url.includes('/sub/detail')) return response({ status: 0, sub: { subs: [{ id: 42, filelist: files }] } });
    if (delayed) return new Promise(resolve => { delayed.resolve = () => resolve(response(text)); });
    return response(text);
  } });
  app.ctx.chrome.tabs.create = async value => { opened.push(value); return { id: 2 }; };
  app.ctx.chrome.tabs.sendMessage = async (_, msg) => {
    if (msg.type === 'WORK_PAGE_CHECK') return { guid, url: `https://www.crunchyroll.com/watch/${guid}/title` };
    if (msg.type === 'EXTERNAL_APPLY') { applied.push(msg.payload); return { ok: true }; }
  };
  const meta = { guid, seriesId: 'SERIES', season: 2, episode: 1, title: 'Kono' };
  await app.send('EXTERNAL_OPEN', { guid, metadata: meta }, app.content);
  const snapshot = new URL(opened[0].url).searchParams.get('snapshot');
  const preview = await app.send('EXTERNAL_PREVIEW', { snapshot, id: 42, filename: makeFilename(1) });
  const apply = p => app.send('EXTERNAL_APPLY', { snapshot, key: preview.key, lang: 'zh-TW', sync: { mode: 'none' }, metadata: meta, ...p });
  const next = (extra = {}) => {
    guid = extra.guid || 'NEXT';
    const metadata = { ...meta, guid, episode: 2, ...extra };
    const sender = { ...app.content, url: `https://www.crunchyroll.com/watch/${guid}/title` };
    return { metadata, sender, restore: () => app.send('EXTERNAL_RESTORE', { guid, metadata }, sender) };
  };
  return { app, snapshot, apply, next, calls, applied, files: value => { files = value; },
    delay: () => { delayed = {}; return delayed; }, navigate: value => { guid = value; } };
}

test('collection matching preserves language/release template and rejects specials, multi-episode and ambiguous names', () => {
  const c = context(); load(c, 'lib/collection-match.js'); const C = c.CRSubFix.collectionMatch;
  for (const name of [filename(3), '[Group] Show [03].zh-sc.ass', 'Show S02E03.ass', 'episode03.srt', 'Show 第03集.ass'])
    assert.equal(C.parse(name).episode, 3);
  for (const name of ['Show [01][02].ass', 'Show [01-12].ass', 'Show - 03 OVA.ass', 'Show SP01.ass', 'Show 1080p.ass'])
    assert.equal(C.parse(name), null);
  assert.notEqual(C.parse('[03].zh-sc.ass').template, C.parse('[03].zh-tc.ass').template);
});

const taggedFilename = ep => `Boku dake ga Inai Machi ${String(ep).padStart(2, '0')}.Kamigami-SC.ass`;

test('episode before group suffix is recognized without changing title, group or language', () => {
  const c = context(); load(c, 'lib/collection-match.js'); const C = c.CRSubFix.collectionMatch;
  for (let episode = 1; episode <= 12; episode++) {
    const parsed = C.parse(taggedFilename(episode));
    assert.equal(parsed.episode, episode);
    assert.equal(parsed.season, null);
    assert.equal(parsed.template, 'Boku dake ga Inai Machi {episode}.Kamigami-SC.ass');
  }
  assert.equal(C.parse('Show 001.Group.ass').episode, 1);
  assert.equal(C.parse('Show.02.Group.srt').episode, 2);
  const rule = { template: C.parse(taggedFilename(1)).template };
  const files = [taggedFilename(2), 'Boku dake ga Inai Machi 02.Kamigami-TC.ass',
    'Boku dake ga Inai Machi 02.Other-SC.ass', taggedFilename(3)].map(name => ({ name, format: 'ASS' }));
  assert.equal(C.select(files, rule, { season: 1, episode: 2 }).length, 1);
  assert.equal(C.select(files, rule, { season: 1, episode: 2 })[0].name, taggedFilename(2));
  for (const name of ['Show 00.Group.ass', 'Show 2020.Group.ass', 'Show 1080.WEB.ass',
    'Show 720.WEB.ass', 'Show 480.Group.ass', 'Show 23.976.Group.ass', 'Show 01-02.Group.ass',
    'Show 01 02.Group.ass', 'Show 01.02.Group.ass', 'Show 01.Group.txt', 'Show 01.Group.OVA.ass'])
    assert.equal(C.parse(name), null, name);
});

test('Kamigami-style ASS can opt in and follow episode 01 to 02, preserving offset and offline restoration', async () => {
  const w = await setup(taggedFilename);
  const applied = await w.apply({ follow: true, inheritOffset: true,
    sync: { mode: 'linear', scale: 1, offset: -2 } });
  assert.equal(applied.ok, true);
  const before = w.calls.length, next = w.next();
  const restored = await next.restore();
  assert.equal(restored.record.filename, taggedFilename(2));
  assert.deepEqual(restored.record.sync, { mode: 'linear', scale: 1, offset: -2 });
  assert.equal(restored.record.text, text);
  assert.equal(w.calls.length - before, 2);
  assert.equal((await next.restore()).record.filename, taggedFilename(2));
  assert.equal(w.calls.length - before, 2);
});

test('tagged filenames still reject selection of a different episode before installing', async () => {
  const w = await setup(taggedFilename);
  assert.equal((await w.apply({ follow: true, metadata: { seriesId: 'SERIES', season: 2, episode: 2 } })).error,
    'FOLLOW_FILENAME_UNCLEAR');
  assert.equal(w.applied.length, 0);
});

test('opt-in follows next episode with one detail call, persists raw ASS and restores without network', async () => {
  const w = await setup(); assert.equal((await w.apply({ follow: true })).ok, true);
  const next = w.next(); const before = w.calls.length;
  const [r, duplicate] = await Promise.all([next.restore(), next.restore()]);
  assert.equal(r.record.filename, filename(2)); assert.equal(duplicate.record.filename, filename(2));
  assert.equal(r.record.lang, 'zh-TW'); assert.equal(r.record.sync.mode, 'none');
  assert.equal(r.record.text, text); assert.equal(w.calls.length - before, 2);
  const stored = await next.restore(); assert.equal(stored.record.filename, filename(2));
  assert.equal(w.calls.length - before, 2);
  const alias = w.next({ guid: 'ALIAS' });
  assert.equal((await alias.restore()).record.filename, filename(2));
  assert.equal(w.calls.length - before, 2);
});

test('SPA follow/open/sync accepts a stale document sender URL only after current-page confirmation', async () => {
  const w = await setup(); await w.apply({ follow: true });
  const next = w.next(), before = w.calls.length;
  const sender = { ...next.sender, url: w.app.content.url };
  const restored = await w.app.send('EXTERNAL_RESTORE', { guid: 'NEXT', metadata: next.metadata }, sender);
  assert.equal(restored.record.filename, filename(2));
  assert.equal(w.calls.length - before, 2);
  assert.equal((await w.app.send('EXTERNAL_OPEN', { guid: 'NEXT', metadata: next.metadata }, sender)).ok, true);
  assert.equal((await w.app.send('EXTERNAL_SYNC', { guid: 'NEXT', id: restored.record.id,
    sync: { mode: 'linear', scale: 1, offset: -1 } }, sender)).ok, true);
  assert.equal((await w.app.send('EXTERNAL_ACTIVE', { guid: 'NEXT', id: '' }, sender)).ok, true);
  assert.equal((await next.restore()).active, false);
});

test('current-page confirmation rejects previous episodes, foreign URLs and missing replies before provider calls', async () => {
  const w = await setup(); await w.apply({ follow: true }); w.next();
  const before = w.calls.length;
  assert.equal((await w.app.send('EXTERNAL_RESTORE', { guid: 'ABC', metadata: {} }, w.app.content)).error,
    'EXTERNAL_CONTEXT_EXPIRED');
  for (const reply of [undefined, { guid: 'NEXT', url: 'https://evil.example/watch/NEXT/title' },
    { guid: 'ABC', url: 'https://www.crunchyroll.com/watch/NEXT/title' }]) {
    w.app.ctx.chrome.tabs.sendMessage = async () => reply;
    assert.equal((await w.app.send('EXTERNAL_RESTORE', { guid: 'NEXT', metadata: {} }, w.app.content)).error,
      'EXTERNAL_CONTEXT_EXPIRED');
  }
  assert.equal(w.calls.length, before);
});

test('missing metadata makes no provider attempt and reliable late metadata can still follow', async () => {
  const w = await setup(); await w.apply({ follow: true });
  const before = w.calls.length;
  const pending = await w.next({ episode: null }).restore();
  assert.equal(pending.metadataPending, true); assert.equal(w.calls.length, before);
  const restored = await w.next().restore();
  assert.equal(restored.record.filename, filename(2)); assert.equal(w.calls.length - before, 2);
});

test('explicit collection offset follows new episodes but never inherits scale or replaces an episode correction', async () => {
  const w = await setup();
  const applied = await w.apply({ follow: true, inheritOffset: true, sync: { mode: 'linear', scale: 1.25, offset: -2 } });
  assert.equal(applied.followRule.offset, -2);
  const next = w.next(); const restored = await next.restore();
  assert.deepEqual(restored.record.sync, { mode: 'linear', scale: 1, offset: -2 });
  assert.deepEqual((await next.restore()).record.sync, restored.record.sync);
  await w.app.send('EXTERNAL_SYNC', { guid: 'NEXT', id: restored.record.id,
    sync: { mode: 'linear', scale: 1.01, offset: -1.5 } }, next.sender);
  const third = w.next({ guid: 'THIRD', episode: 3 });
  assert.deepEqual((await third.restore()).record.sync, { mode: 'linear', scale: 1, offset: -2 });
  const corrected = w.next({ guid: 'NEXT', episode: 2 });
  assert.deepEqual((await corrected.restore()).record.sync, { mode: 'linear', scale: 1.01, offset: -1.5 });
});

test('legacy remembered series offset remains a suggestion without explicit collection offset opt-in', async () => {
  const w = await setup();
  await w.apply({ follow: true, rememberOffset: true, sync: { mode: 'linear', scale: 1, offset: -2 } });
  assert.equal(w.app.local.externalSubCache.seriesOffsets.SERIES.offset, -2);
  assert.deepEqual((await w.next().restore()).record.sync, { mode: 'none' });
});

test('disabling inherited offset clears only the default for future episodes, not existing selections', async () => {
  const w = await setup();
  await w.apply({ follow: true, inheritOffset: true, sync: { mode: 'linear', scale: 1, offset: -2 } });
  await w.next().restore();
  w.navigate('ABC'); const updated = await w.apply({ follow: true, inheritOffset: false });
  assert.equal(updated.followRule.offset, null);
  assert.deepEqual((await w.next({ guid: 'THIRD', episode: 3 }).restore()).record.sync, { mode: 'none' });
  assert.equal((await w.next().restore()).record.sync.offset, -2);
});

test('zero offset opt-in is persisted and corrupt collection offsets fail before a provider request', async () => {
  const w = await setup();
  assert.equal((await w.apply({ follow: true, inheritOffset: true })).followRule.offset, 0);
  assert.deepEqual((await w.next().restore()).record.sync, { mode: 'none' });
  w.app.local.externalSubCache.followRules[JSON.stringify(['SERIES', 2])].offset = 4000;
  const before = w.calls.length;
  assert.equal((await w.next({ guid: 'THIRD', episode: 3 }).restore()).followError, 'EXTERNAL_INVALID_SYNC');
  assert.equal(w.calls.length, before);
});

test('an incomplete saved identity does not shadow reliable current-page metadata', async () => {
  const w = await setup(); await w.apply({ follow: true });
  w.app.local.externalSubCache.identities.NEXT = { guid: 'NEXT', seriesId: 'SERIES', season: null, episode: null };
  const restored = await w.next().restore();
  assert.equal(restored.record.filename, filename(2));
});

test('no opt-in, another series/season, unknown episode and disabled rule never auto-download', async () => {
  const w = await setup(); await w.apply({});
  assert.equal((await w.next().restore()).record, null);
  assert.equal(w.calls.length, 2);
  w.navigate('ABC'); await w.apply({ follow: true });
  assert.equal((await w.next({ seriesId: 'OTHER' }).restore()).record, null);
  assert.equal((await w.next({ season: 3 }).restore()).record, null);
  assert.equal((await w.next({ episode: null }).restore()).followError, 'FOLLOW_METADATA_REQUIRED');
  assert.equal(w.calls.length, 2);
  w.navigate('ABC'); await w.app.send('EXTERNAL_FOLLOW_CLEAR', { snapshot: w.snapshot });
  assert.equal((await w.next().restore()).record, null);
  assert.equal(w.calls.length, 2);
});

test('wrong selected episode fails before installation; website cannot enable or clear follow', async () => {
  const w = await setup();
  assert.equal((await w.apply({ follow: true, metadata: { seriesId: 'SERIES', season: 2, episode: 3 } })).error, 'FOLLOW_FILENAME_UNCLEAR');
  assert.equal(w.applied.length, 0);
  assert.equal((await w.app.send('EXTERNAL_FOLLOW_CLEAR', { snapshot: w.snapshot }, w.app.content)).error, 'SENDER_NOT_ALLOWED');
});

test('missing and duplicate candidates are visible failures without repeated automatic requests', async () => {
  for (const duplicates of [false, true]) {
    const w = await setup(); await w.apply({ follow: true });
    w.files(duplicates ? [1, 2].map(() => ({ f: filename(2), url: 'https://file1.assrt.net/2.ass' })) : []);
    const next = w.next();
    const r = await next.restore(); assert.equal(r.followError, duplicates ? 'FOLLOW_AMBIGUOUS' : 'FOLLOW_NOT_FOUND');
    assert.equal(r.record, null);
    await next.restore(); assert.equal(w.calls.length, 3);
  }
});

test('manual off and disabling follow during download prevent automatic approval and selection', async () => {
  for (const stop of ['off', 'rule']) {
    const w = await setup(); await w.apply({ follow: true });
    const delay = w.delay(), next = w.next(); const pending = next.restore();
    while (!delay.resolve) await new Promise(resolve => setTimeout(resolve, 1));
    if (stop === 'off') await w.app.send('EXTERNAL_ACTIVE', { guid: 'NEXT', id: '' }, next.sender);
    else { w.navigate('ABC'); await w.app.send('EXTERNAL_FOLLOW_CLEAR', { snapshot: w.snapshot }); w.navigate('NEXT'); }
    delay.resolve(); const r = await pending;
    assert.equal(r.followError, 'FOLLOW_CANCELLED'); assert.equal(r.record, null);
    assert.ok(!w.app.local.externalSubCache.files.some(f => f.guid === 'NEXT' && f.approved));
  }
});

test('navigation during automatic download never approves the old episode', async () => {
  const w = await setup(); await w.apply({ follow: true }); const delay = w.delay(), next = w.next();
  const pending = next.restore(); while (!delay.resolve) await new Promise(resolve => setTimeout(resolve, 1));
  w.navigate('OTHER'); delay.resolve();
  assert.equal((await pending).followError, 'EXTERNAL_CONTEXT_EXPIRED');
  assert.ok(!w.app.local.externalSubCache.files.some(f => f.guid === 'NEXT'));
});
