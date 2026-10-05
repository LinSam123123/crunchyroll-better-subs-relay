import test from 'node:test';
import assert from 'node:assert/strict';
import { context, load, json, background, savePayload } from './helpers.mjs';

function api() {
  const c = context();
  load(c, 'lib/work-lookup.js'); load(c, 'lib/work-profiles.js');
  return { L: c.CRSubFix.workLookup, W: c.CRSubFix.workProfiles };
}
const reply = value => ({ ok: true, text: async () => JSON.stringify(value) });
const person = (id = 101) => ({ id, name: '周防有希', summary: 'secret identity must not be returned',
  infobox: [{ key: '简体中文名', value: '周防有希' },
    { key: '别名', value: [{ k: '罗马字', v: 'Yuki Suou' }, { k: '昵称', v: 'Hidden identity' }] },
    { key: '关系', value: 'spoiler' }],
  images: { large: 'https://evil.example/track' },
});
const ref = { provider: 'bangumi', subjectId: 1, characterId: 101, fetchedAt: 1234 };
const subject = { id: 1, name: 'Academy', name_cn: '学园', date: '2024-01-01', platform: 'TV',
  summary: 'plot spoiler', images: { large: 'https://evil.example' } };
test('public search sends only an explicit title to a fixed destination, omits cookies, redirects and secrets', async () => {
  const { L } = api();
  const calls = [];
  const result = await L.search(' Academy ', async (url, init) => {
    calls.push({ url, init }); return reply({ data: [subject] });
  });
  assert.equal(calls[0].url, 'https://api.bgm.tv/v0/search/subjects?limit=8');
  assert.deepEqual(JSON.parse(calls[0].init.body), { keyword: 'Academy', filter: { type: [2], nsfw: false } });
  assert.equal(calls[0].init.headers.Authorization, undefined);
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(result.subjects[0].url, 'https://bgm.tv/subject/1');
  assert.ok(!JSON.stringify(result).includes('spoiler'));
  assert.ok(!JSON.stringify(result).includes('evil.example'));
});
test('search bounds input and rejects malformed or oversized responses without retry', async () => {
  const { L } = api();
  for (const value of ['', 'x'.repeat(201), {}, null]) await assert.rejects(L.search(value), /LOOKUP_INVALID_INPUT/);
  await assert.rejects(L.search('x', async () => reply({})), /LOOKUP_INVALID_RESPONSE/);
  await assert.rejects(L.search('x', async () => ({ ok: true, text: async () => 'x'.repeat(2000001) })), /LOOKUP_INVALID_RESPONSE/);
  let calls = 0;
  await assert.rejects(L.search('x', async () => { calls++; return { ok: false, status: 429 }; }), /LOOKUP_HTTP_429/);
  assert.equal(calls, 1);
  await assert.rejects(L.search('x', async () => { throw new Error('private provider detail'); }), /LOOKUP_NETWORK/);
});
test('character candidates whitelist names, exclude biography and hidden nickname, and cap parallelism', async () => {
  const { L } = api();
  let active = 0, peak = 0, count = 0;
  const result = await L.characters(1, 0, async url => {
    count++;
    if (url.endsWith('/1/characters')) return reply(Array.from({ length: 15 }, (_, i) => ({ id: 101 + i })));
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    return reply(person(Number(url.split('/').at(-1))));
  });
  assert.equal(result.characters.length, 12);
  assert.equal(result.nextOffset, 12);
  assert.equal(count, 13);
  assert.equal(peak, 3);
  assert.deepEqual(json(result.characters[0].aliases), ['周防有希', 'Yuki Suou']);
  for (const text of ['spoiler', 'identity', 'evil.example', '关系']) assert.ok(!JSON.stringify(result).includes(text));
  await assert.rejects(L.characters('https://evil.example', 0), /LOOKUP_INVALID_INPUT/);
  await assert.rejects(L.characters(1, 1), /LOOKUP_INVALID_INPUT/);
  await assert.rejects(L.characters(1, 300), /LOOKUP_INVALID_INPUT/);
});
test('partial character failures preserve successes and stop dispatching after rate limiting', async () => {
  const { L } = api();
  let calls = 0;
  const result = await L.characters(1, 0, async url => {
    calls++;
    if (url.endsWith('/1/characters')) return reply(Array.from({ length: 8 }, (_, i) => ({ id: 101 + i })));
    if (url.endsWith('/102')) return { ok: false, status: 429 };
    return reply(person(Number(url.split('/').at(-1))));
  });
  assert.equal(calls, 4);
  assert.equal(result.characters.length, 2);
  assert.equal(result.failedIds.length, 6);
});
test('whole-episode local matching covers late cues but does not guess romanization or hidden identities', () => {
  const { L } = api();
  const texts = [...Array(80).fill('Hello'), 'Yuki, come here.', 'NotYuki and Takeshi.'];
  assert.deepEqual(json(L.matches({ aliases: ['Yuki Suou'] }, texts)), [{ source: 'Yuki', fragment: true }]);
  assert.deepEqual(json(L.matches({ aliases: ['Kujou'] }, ['Kujo!'])), []);
  assert.deepEqual(json(L.matches({ aliases: ['Yuki'] }, ['NotYuki'])), []);
  assert.deepEqual(json(L.matches({ aliases: ['A+B'] }, ['A+B!'])), [{ source: 'A+B', fragment: false }]);
  assert.equal(L.corpus(Array(6001).fill('x'.repeat(2001))).join('').length, 100000);
});
test('merging keeps existing values by default, requires explicit replacement, and refuses ambiguous duplicates', () => {
  const { L } = api();
  const choices = [{ source: 'Yuki', target: '有希', provenance: ref }, { source: 'Kujo', target: '九条', provenance: ref }];
  const old = { Yuki: '小雪', Kuze: '久世' };
  const merged = L.merge(old, {}, choices);
  assert.deepEqual(json(merged.glossary), { ...old, Kujo: '九条' });
  assert.deepEqual(json(merged.conflicts), ['Yuki']);
  assert.deepEqual(old, { Yuki: '小雪', Kuze: '久世' });
  const replaced = L.merge(old, {}, choices, true);
  assert.equal(replaced.glossary.Yuki, '有希');
  assert.equal(replaced.sources.Yuki.characterId, 101);
  assert.throws(() => L.merge({}, {}, [choices[0], { ...choices[0], target: '其他' }]), /LOOKUP_DUPLICATE_TERM/);
  assert.throws(() => L.merge({}, {}, [{ ...choices[0], source: '' }]), /LOOKUP_EMPTY_TERM/);
});
test('sources are persisted as bounded IDs, drop when manually edited, and cannot carry URLs or secrets', () => {
  const { L, W } = api();
  const glossary = { Yuki: '有希' };
  const sources = { Yuki: { ...ref, target: '有希', apiKey: 'secret', url: 'https://evil.example' } };
  const p = W.profile({ title: 'Academy', glossary, glossarySources: sources });
  assert.deepEqual(json(p.glossarySources), { Yuki: { ...ref, target: '有希' } });
  assert.deepEqual(json(L.provenance(sources, { Yuki: '周防有希' })), {});
  assert.deepEqual(json(L.provenance(sources, {})), {});
  assert.throws(() => L.provenance({ Yuki: { ...sources.Yuki, characterId: 'bad' } }, glossary), /INVALID_WORK_PROFILE/);
  const special = JSON.parse('{"__proto__":"有希"}');
  const withProto = L.merge(special, {}, [{ source: '__proto__', target: '有希', provenance: ref }]);
  assert.ok(Object.hasOwn(withProto.sources, '__proto__'));
});
test('lookup is unavailable to website senders and requires explicit host permission even without any translation key', async () => {
  const a = background({ allowed: false });
  const input = { action: 'search', query: 'Academy' };
  assert.equal((await a.send('WORK_LOOKUP', input, a.content)).error, 'SENDER_NOT_ALLOWED');
  assert.equal((await a.send('WORK_LOOKUP', input)).error, 'LOOKUP_PERMISSION');
  assert.equal(a.calls.filter(Array.isArray).length, 0);
  const b = background({ fetcher: async () => reply({ data: [subject] }) });
  assert.equal((await b.send('WORK_LOOKUP', input)).ok, true);
  assert.equal(b.local.mtApiKey, undefined);
  assert.equal(b.local.mtWorkProfiles, undefined);
  assert.equal((await b.send('WORK_LOOKUP', { action: 'characters', subjectId: '../secrets' })).error, 'LOOKUP_INVALID_INPUT');
});
test('lookup caches bounded public results and does not spend relay budget or change profiles/configuration', async () => {
  const app = background({ fetcher: async () => reply({ data: [subject] }) });
  await app.send('MT_SAVE_CONFIG', savePayload());
  const before = structuredClone(app.local);
  const input = { action: 'search', query: 'Academy', subtitle: 'private cue', apiKey: 'forged' };
  const first = await app.send('WORK_LOOKUP', input), second = await app.send('WORK_LOOKUP', input);
  assert.equal(first.cached, false); assert.equal(second.cached, true);
  assert.equal(app.calls.filter(Array.isArray).length, 1);
  assert.deepEqual(app.local, before);
  assert.equal(app.session['relayBudget:1'], undefined);
  const fetchCall = app.calls.find(Array.isArray);
  assert.ok(!JSON.stringify(fetchCall).includes('private cue'));
  assert.ok(!JSON.stringify(fetchCall).includes('test-secret-only'));
  await app.send('WORK_LOOKUP', { ...input, refresh: true });
  assert.equal(app.calls.filter(Array.isArray).length, 2);
  for (let i = 0; i < 23; i++) await app.send('WORK_LOOKUP', { action: 'search', query: `Academy ${i}` });
  assert.equal(app.session.mtLookupCache.length, 20);
});
test('lookup failure never retries, corrupts a saved profile, or prevents normal translation', async () => {
  const app = background({ fetcher: async url => url.startsWith('https://api.bgm.tv')
    ? { ok: false, status: 503 }
    : reply({ choices: [{ message: { content: '{"items":[{"id":"0","text":"hello"}]}' } }] }) });
  await app.send('MT_SAVE_CONFIG', savePayload());
  const before = structuredClone(app.local);
  assert.equal((await app.send('WORK_LOOKUP', { action: 'search', query: 'Academy' })).error, 'LOOKUP_HTTP_503');
  assert.deepEqual(app.local, before);
  assert.equal(app.calls.filter(Array.isArray).length, 1);
  const result = await app.send('MT_TRANSLATE', { texts: ['Hello'], source: 'en-US', target: 'zh-CN',
    provider: 'relay', configTag: app.local.mtConfigTag }, app.content);
  assert.equal(result.ok, true);
});
test('lookup has independent bounded parallelism and session budget', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const app = background({ fetcher: async () => { await gate; return reply({ data: [] }); } });
  const first = app.send('WORK_LOOKUP', { action: 'search', query: 'A' });
  const second = app.send('WORK_LOOKUP', { action: 'search', query: 'B' });
  while (app.calls.filter(Array.isArray).length < 2) await new Promise(r => setTimeout(r, 1));
  assert.equal((await app.send('WORK_LOOKUP', { action: 'search', query: 'C' })).error, 'LOOKUP_BUSY');
  release();
  await Promise.all([first, second]);
  app.session.mtLookupBudget.requests = 180;
  assert.equal((await app.send('WORK_LOOKUP', { action: 'search', query: 'D' })).error, 'LOOKUP_BUDGET');
});
test('confirmed source metadata survives save and reload but is not exposed to the site or model', async () => {
  const requests = [];
  const profile = { key: 'p', revision: 'r', target: 'zh-CN', title: 'Academy', aliases: '', context: '', tone: '', glossary: {} };
  const app = background({ data: { mtWorkProfiles: { profiles: [profile], bindings: { 'series:S:zh-CN': 'p' } } },
    fetcher: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return reply({ choices: [{ message: { content: '{"items":[{"id":"0","text":"hello"}]}' } }] });
    } });
  await app.send('MT_SAVE_CONFIG', savePayload());
  const saved = await app.send('WORK_SAVE', { key: 'p', revision: 'r', enabled: true,
    profile: { ...profile, glossary: { Yuki: '有希' }, glossarySources: { Yuki: { ...ref, target: '有希' } } } });
  assert.equal(saved.ok, true);
  const record = saved.profiles[0];
  assert.equal(record.glossarySources.Yuki.provider, 'bangumi');
  assert.equal((await app.send('WORK_GET')).profiles[0].glossarySources.Yuki.subjectId, 1);
  assert.equal(requests.length, 0);
  const publicContext = await app.send('WORK_CONTEXT', { guid: 'ABC', workHint: { seriesId: 'S' } }, app.content);
  assert.ok(!JSON.stringify(publicContext).includes('bangumi'));
  const result = await app.send('MT_TRANSLATE', { texts: ['Yuki'], source: 'en-US', target: 'zh-CN',
    provider: 'relay', configTag: app.local.mtConfigTag, workHint: { seriesId: 'S' }, workToken: publicContext.token }, app.content);
  assert.equal(result.ok, true);
  assert.equal(JSON.parse(requests[0].messages[1].content).glossary.Yuki, '有希');
  assert.ok(!JSON.stringify(requests[0]).includes('characterId'));
});
test('refreshing provenance alone preserves translation revision while changing a term invalidates it', async () => {
  const { W } = api();
  let db;
  const storage = { get: async () => ({ mtWorkProfiles: db }), set: async value => { db = value.mtWorkProfiles; } };
  const profile = { title: 'Academy', glossary: { Yuki: '有希' } };
  const p = await W.save(storage, { profile, enabled: true }, null, 'zh-CN');
  const withSource = { ...profile, glossarySources: { Yuki: { ...ref, target: '有希' } } };
  const p2 = await W.save(storage, { key: p.key, revision: p.revision, profile: withSource }, null, 'zh-CN');
  assert.equal(p2.revision, p.revision);
  withSource.glossarySources.Yuki.fetchedAt++;
  const p3 = await W.save(storage, { key: p2.key, revision: p2.revision, profile: withSource }, null, 'zh-CN');
  assert.equal(p3.revision, p.revision);
  const changed = await W.save(storage, { key: p3.key, revision: p3.revision,
    profile: { ...withSource, glossary: { Yuki: '周防有希' } } }, null, 'zh-CN');
  assert.notEqual(changed.revision, p.revision);
  assert.equal(changed.glossarySources, undefined);
});
