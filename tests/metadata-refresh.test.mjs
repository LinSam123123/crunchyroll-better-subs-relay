import test from 'node:test';
import assert from 'node:assert/strict';
import { context, load, background, json } from './helpers.mjs';

const title = '不時輕聲地以俄語遮羞的鄰座艾莉同學';
const guid = 'GX9UQEGM5', seriesId = 'G1XHJV0XM';
const metadata = { guid, seriesId, title, englishTitle: '', episode: 3, season: 1, evidence: 'heading', aliases: [] };
const episode = { '@type': 'TVEpisode', url: `/zh-tw/watch/${guid}/and-so-they-met`, name: `${title} | E3`,
  episodeNumber: 3, partOfSeason: { seasonNumber: 1 }, partOfSeries: { name: title } };
function api() { const c = context(); load(c, 'lib/work-profiles.js'); load(c, 'lib/episode-metadata.js'); return c.CRSubFix.episodeMetadata; }
function doc(record = episode, linkTitle = title) {
  return { title, querySelectorAll: selector => selector.startsWith('script') ? [{ textContent: JSON.stringify(record) }] :
    selector.includes('.erc-current-media-info') ? [{ href: `/zh-tw/series/${seriesId}/alya`, textContent: linkTitle }] : [] };
}
test('current CR structure without a series URL still identifies title, scoped series link and episode', () => {
  const M = api(), value = M.detect(doc(), `https://www.crunchyroll.com/zh-tw/watch/${guid}/and-so-they-met`);
  assert.equal(value.title, title); assert.equal(value.seriesId, seriesId); assert.equal(value.episode, 3); assert.equal(value.season, 1);
  const unknown = M.detect(doc(episode, 'Grand Blue'), `https://www.crunchyroll.com/watch/${guid}`);
  assert.equal(unknown.title, title); assert.equal(unknown.seriesId, '');
});
test('current structured title is retained without a heading; unrelated episode data does not leak into it', () => {
  const M = api();
  const noLink = { querySelectorAll: s => s.startsWith('script') ? [{ textContent: JSON.stringify(episode) }] : [] };
  const current = M.detect(noLink, `https://www.crunchyroll.com/watch/${guid}`);
  assert.equal(current.title, title); assert.equal(current.seriesId, ''); assert.equal(current.episode, 3);
  const unrelated = M.detect(noLink, 'https://www.crunchyroll.com/watch/OTHER');
  assert.equal(unrelated.title, ''); assert.equal(unrelated.seriesId, ''); assert.equal(unrelated.episode, null);
});
test('fresh identity repairs blank legacy records and rejects a different series or unverifiable stale title', () => {
  const M = api(), saved = { ...metadata, title: '', englishTitle: 'Grand Blue', season: null, episode: null };
  const value = M.reconcile(metadata, saved);
  assert.equal(value.title, title); assert.equal(value.englishTitle, ''); assert.equal(value.episode, 3);
  assert.deepEqual(json(M.reconcile(metadata, { ...saved, seriesId: 'OLD_SERIES' })), metadata);
  assert.equal(M.reconcile({ ...metadata, seriesId: '', evidence: 'structured' }, { ...saved, title: 'Grand Blue', seriesId: 'GRAND' }).seriesId, '');
});
test('same-page baseline preserves explicit manual corrections but not changes of actual episode identity', () => {
  const M = api(), saved = { ...metadata, title: '我的校正番名', englishTitle: 'Corrected name', season: 2, episode: 15,
    pageIdentity: { seriesId, title, season: 1, episode: 3 } };
  const value = M.reconcile(metadata, saved);
  assert.equal(value.title, saved.title); assert.equal(value.season, 2); assert.equal(value.episode, 15);
  const changed = M.reconcile({ ...metadata, episode: 4 }, saved);
  assert.equal(changed.episode, 4);
});

async function setup(saved = { ...metadata, title: '', englishTitle: '', season: null, episode: null }) {
  const wrong = source => ({ key: `${source}-old-search`, guid, source, query: '碧蓝之海',
    items: [], pos: 0, at: Date.now(), expires: Date.now() + 3600000 });
  const db = { identities: { [guid]: saved }, searches: ['assrt', 'subdl', 'jimaku'].map(wrong), files: [],
    selections: {}, seriesOffsets: {}, followRules: {} };
  const app = background({ data: { externalSubCache: db }, fetcher: async () => { throw new Error('UNEXPECTED_NETWORK'); } });
  const opened = []; let current = metadata;
  app.ctx.chrome.tabs.create = async p => { opened.push(p); return { id: 2 }; };
  app.ctx.chrome.tabs.sendMessage = async (_, message) => message.type === 'WORK_PAGE_CHECK' ?
    { guid, url: `https://www.crunchyroll.com/watch/${guid}/title`, metadata: current } : undefined;
  const sender = { ...app.content, url: `https://www.crunchyroll.com/watch/${guid}/title` };
  await app.send('EXTERNAL_OPEN', { guid, metadata: { ...metadata, title: '', episode: null, season: null } }, sender);
  const snapshot = new URL(opened[0].url).searchParams.get('snapshot');
  return { app, snapshot, db, setCurrent: v => { current = v; }, get: () => app.send('EXTERNAL_GET', { snapshot }) };
}
test('open-before-metadata snapshot refreshes from current content and quarantines old searches without deleting files', async () => {
  const w = await setup();
  w.app.local.externalSubCache.files.push({ key: 'keep-file', guid: 'PREVIOUS', text: 'previous subtitle' });
  const result = await w.get();
  assert.equal(result.ok, true); assert.equal(result.metadata.title, title); assert.equal(result.metadata.episode, 3);
  assert.equal(result.cachedSearches.length, 0); assert.ok(w.app.local.externalSubCache.searches.every(s => s.staleIdentity));
  assert.equal(w.app.local.externalSubCache.files[0].text, 'previous subtitle');
  // A later search/save cannot revive a quarantined legacy query from another source.
  w.app.local.externalSubCache.identities[guid] = metadata;
  assert.equal((await w.get()).cachedSearches.length, 0);
  assert.equal(w.app.calls.filter(c => Array.isArray(c) && c[0] === 'fetch').length, 0);
});
test('new page-scoped searches restore only for their real work and ignore old AniList cache from another series', async () => {
  const w = await setup(metadata);
  w.app.local.externalSubCache.searches = [
    { ...w.db.searches[0], pageIdentity: { seriesId, title }, query: 'Alya' },
    { ...w.db.searches[2], pageIdentity: { seriesId: 'GRAND', title: 'Grand Blue' }, query: 'AniList:199111', anilistId: '199111' },
  ];
  const result = await w.get();
  assert.equal(result.cachedSearches.length, 1); assert.equal(result.cachedSearches[0].query, 'Alya');
});
test('reliably identified other series never inherits a previous series follow rule', async () => {
  const w = await setup({ ...metadata, title: 'Grand Blue', seriesId: 'GRAND', episode: 1 });
  w.app.local.externalSubCache.followRules = { 'GRAND:1': { seriesId: 'GRAND', season: 1, subId: '42', source: 'assrt' } };
  const r = await w.app.send('EXTERNAL_RESTORE', { guid, metadata },
    { ...w.app.content, url: `https://www.crunchyroll.com/watch/${guid}/title` });
  assert.equal(r.ok, true); assert.equal(r.record, null); assert.equal(w.app.calls.filter(c => Array.isArray(c) && c[0] === 'fetch').length, 0);
  assert.equal((await w.get()).followRule, null);
});
