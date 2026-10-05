import test from 'node:test';
import assert from 'node:assert/strict';
import { context, load, json, background, config, savePayload } from './helpers.mjs';

function api() {
  const c = context();
  load(c, 'lib/relay.js'); load(c, 'lib/work-profiles.js');
  return c.CRSubFix.workProfiles;
}
const profile = { title: 'Synthetic Academy', aliases: 'Academy', context: 'School classmates.',
  tone: 'Natural dialogue; do not add jokes.', glossary: { Kujo: '九条', Kuze: '久世' } };
const hints = { seriesId: 'SERIES1', title: profile.title, evidence: 'structured' };
const seriesUrl = 'https://www.crunchyroll.com/series/SERIES1/academy';
const envelope = (text, protocol) => ({ ok: true, text: async () => JSON.stringify(protocol === 'responses'
  ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }
  : { choices: [{ finish_reason: 'stop', message: { content: text } }] }) });
function doc(nodes = [], links = []) {
  return { querySelectorAll: selector => selector.startsWith('script')
    ? nodes.map(n => ({ textContent: typeof n === 'string' ? n : JSON.stringify(n) })) : links };
}
test('work detection requires same-site routes and current episode evidence; recommendations are not guessed', () => {
  const W = api();
  assert.equal(W.route('https://evil.example/series/ABC', 'series'), '');
  assert.equal(W.route('https://www.crunchyroll.com.evil.example/series/ABC', 'series'), '');
  assert.equal(W.route('/zh-tw/series/ABC/title', 'series'), 'ABC');
  const episode = { '@type': 'TVEpisode', url: '/zh-tw/watch/ABC/title',
    partOfSeries: { url: seriesUrl, name: profile.title } };
  assert.deepEqual(json(W.detect(doc([episode]), 'https://www.crunchyroll.com/watch/ABC/title')),
    { guid: 'ABC', ...hints });
  assert.equal(W.detect(doc([episode]), 'https://www.crunchyroll.com/watch/OTHER/title').seriesId, '');
  assert.equal(W.detect(doc(['{broken'], []), 'https://www.crunchyroll.com/watch/ABC/title').seriesId, '');
  const links = [{ href: seriesUrl, textContent: 'Academy' }, { href: '/series/OTHER/x', textContent: 'Other' }];
  assert.equal(W.detect(doc([], links), 'https://www.crunchyroll.com/watch/ABC/title').seriesId, '');
  assert.equal(W.detect(doc([], links.slice(0, 1)), 'https://www.crunchyroll.com/watch/ABC/title').evidence, 'heading');
});
test('profiles and samples are bounded, schema-allowlisted, and cannot carry provider configuration', () => {
  const W = api();
  const clean = W.profile({ ...profile, apiKey: 'private', baseUrl: 'evil', key: 'forged' });
  assert.deepEqual(json(clean), profile);
  for (const patch of [{ title: '' }, { context: 'x'.repeat(1501) }, { glossary: [] },
    { glossary: { A: null } }, { glossary: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [i, 'value'])) }]) {
    assert.throws(() => W.profile({ ...profile, ...patch }), /INVALID_WORK_PROFILE/);
  }
  const samples = W.samples(Array(100).fill('x'.repeat(1000)));
  assert.equal(samples.join('').length, 8000);
  assert.ok(samples.length <= 80);
});
async function setup(protocol = 'chat-completions', customFetcher) {
  const network = [];
  const app = background({ fetcher: async (url, init) => {
    const body = JSON.parse(init.body), input = JSON.parse(body.input || body.messages[1].content);
    network.push({ url, body, input });
    if (customFetcher) return customFetcher(url, init, input);
    return envelope(JSON.stringify(input.task === 'anime-profile' ? profile
      : { items: input.items.map(i => ({ id: i.id, text: 'Translated' })) }), protocol);
  } });
  await app.send('MT_SAVE_CONFIG', savePayload({ config: { ...config, protocol, glossary: { Kujo: 'wrong', Hello: '你好' } } }));
  const opened = [];
  let currentGuid = 'ABC';
  app.ctx.chrome.tabs.create = async p => { opened.push(p); return { id: 7 }; };
  app.ctx.chrome.tabs.sendMessage = async (_id, msg) => msg.type === 'WORK_PAGE_CHECK' ? { guid: currentGuid } : undefined;
  const result = await app.send('WORK_OPEN', { guid: 'ABC', workHint: hints, samples: ['Hello Kujo', 'Hello Kuze'] }, app.content);
  assert.equal(result.ok, true);
  const snapshot = new URL(opened[0].url).searchParams.get('snapshot');
  return { app, snapshot, network, changePage: id => { currentGuid = id; } };
}
const save = (w, extra = {}) => w.app.send('WORK_SAVE', {
  snapshot: w.snapshot, profile, seriesUrl, enabled: true, ...extra,
});
const request = (w, token = '', extra = {}) => ({
  texts: ['Hello'], source: 'en-US', target: 'zh-CN', provider: 'relay',
  configTag: w.app.local.mtConfigTag, workHint: hints, workToken: token, ...extra,
});
test('opening, reading and saving work profiles never call provider; drafts are not applied before confirmation', async () => {
  const w = await setup();
  assert.equal(w.network.length, 0);
  assert.equal((await w.app.send('WORK_GET', { snapshot: w.snapshot })).selected, '');
  const draft = await w.app.send('WORK_GENERATE', { snapshot: w.snapshot, title: profile.title });
  assert.deepEqual(draft.draft, profile);
  assert.equal(w.network.length, 1);
  assert.equal(w.network[0].body.stream, false);
  assert.equal(w.app.local.mtWorkProfiles, undefined);
  assert.equal((await w.app.send('WORK_CONTEXT', { guid: 'ABC', workHint: hints }, w.app.content)).token, '');
  const saved = await save(w);
  assert.equal(saved.profiles.length, 1);
  assert.equal(w.network.length, 1);
  const result = await w.app.send('WORK_CONTEXT', { guid: 'ABC', workHint: hints }, w.app.content);
  assert.ok(result.token);
  assert.ok(!JSON.stringify(result).includes('classmates'));
});
test('confirmed profile is injected only in background, merges glossary, reuses across episodes but not works or languages', async () => {
  const w = await setup();
  const saved = await save(w);
  const resolved = await w.app.send('WORK_CONTEXT', { guid: 'ABC', workHint: hints }, w.app.content);
  const result = await w.app.send('MT_TRANSLATE', request(w, resolved.token), w.app.content);
  assert.equal(result.ok, true);
  assert.equal(w.network[0].input.glossary.Kujo, '九条');
  assert.equal(w.network[0].input.glossary.Hello, '你好');
  assert.equal(w.network[0].input.work_context.title, profile.title);
  assert.ok(!JSON.stringify(w.network[0].input).includes(saved.profiles[0].key));
  const next = { ...w.app.content, url: 'https://www.crunchyroll.com/watch/NEXT/x' };
  assert.equal((await w.app.send('WORK_CONTEXT', { guid: 'NEXT', workHint: hints }, next)).token, resolved.token);
  assert.equal((await w.app.send('WORK_CONTEXT', { guid: 'NEXT', workHint: { seriesId: 'OTHER' } }, next)).token, '');
  assert.equal((await w.app.send('WORK_CONTEXT', { guid: 'NEXT', workHint: hints, target: 'de-DE' }, next)).token, '');
});
test('manual unknown identity is episode-bound, never automatically reused by matching title alone', async () => {
  const w = await setup();
  await save(w, { seriesUrl: '' });
  const next = { ...w.app.content, url: 'https://www.crunchyroll.com/watch/NEXT/x' };
  assert.equal((await w.app.send('WORK_CONTEXT', { guid: 'NEXT', workHint: hints }, next)).token, '');
  assert.ok((await w.app.send('WORK_CONTEXT', { guid: 'ABC', workHint: {} }, w.app.content)).token);
});
test('profile edits invalidate only their token, reject stale requests and writes, but no-op saves preserve identity', async () => {
  const w = await setup();
  let result = await save(w);
  let p = result.profiles[0];
  const tag = w.app.local.mtConfigTag;
  const oldToken = `${p.key}:${p.revision}`;
  result = await save(w, { key: p.key, revision: p.revision });
  assert.equal(result.profiles[0].revision, p.revision);
  result = await save(w, { key: p.key, revision: p.revision, profile: { ...profile, tone: 'Restrained.' } });
  assert.notEqual(result.profiles[0].revision, p.revision);
  assert.equal(w.app.local.mtConfigTag, tag);
  assert.equal((await w.app.send('MT_TRANSLATE', request(w, oldToken), w.app.content)).error, 'WORK_CHANGED');
  assert.equal((await save(w, { key: p.key, revision: p.revision })).error, 'WORK_CHANGED');
  const cache = { guid: 'ABC', key: 'test', total: 1, configTag: tag, workToken: oldToken, workHint: hints,
    action: 'save', entries: [{ index: 0, text: 'old' }] };
  assert.equal((await w.app.send('MT_PROGRESS', cache, w.app.content)).error, 'WORK_CHANGED');
  assert.equal(w.network.length, 0);
});
test('site page cannot generate, read full profiles, save/delete or turn on work assistance', async () => {
  const w = await setup();
  for (const type of ['WORK_GET', 'WORK_GENERATE', 'WORK_SAVE', 'WORK_DELETE']) {
    assert.equal((await w.app.send(type, { snapshot: w.snapshot }, w.app.content)).error, 'SENDER_NOT_ALLOWED');
  }
  assert.equal((await w.app.send('SET_PUBLIC_SETTING', { key: 'mtWorkEnabled', value: true }, w.app.content)).error, 'SETTING_NOT_ALLOWED');
  assert.equal((await w.app.send('WORK_CONTEXT', { guid: 'OTHER', workHint: hints }, w.app.content)).error, 'SENDER_NOT_ALLOWED');
  assert.equal(w.network.length, 0);
  const pub = await w.app.send('PUBLIC_SETTINGS', null, w.app.content);
  assert.ok(!JSON.stringify(pub).includes(profile.title));
});
test('navigation invalidates generation and confirmation snapshots before paid requests or saves', async () => {
  const w = await setup();
  w.changePage('OTHER');
  assert.equal((await w.app.send('WORK_GENERATE', { snapshot: w.snapshot, title: profile.title })).error, 'WORK_CONTEXT_EXPIRED');
  assert.equal((await save(w)).error, 'WORK_CONTEXT_EXPIRED');
  assert.equal(w.network.length, 0);
  assert.equal(w.app.local.mtWorkProfiles, undefined);
});
test('Responses draft protocol, provider failures and malformed drafts never silently retry or save', async () => {
  const responses = await setup('responses');
  assert.equal((await responses.app.send('WORK_GENERATE', { snapshot: responses.snapshot, title: profile.title })).ok, true);
  assert.equal(responses.network[0].body.store, false);
  for (const [reply, error] of [
    [{ ok: false, status: 429 }, 'HTTP_429'],
    [envelope('not json'), 'INVALID_WORK_PROFILE'],
    [envelope(JSON.stringify({ ...profile, title: '' })), 'WORK_NOT_IDENTIFIED'],
  ]) {
    const w = await setup('chat-completions', async () => reply);
    assert.equal((await w.app.send('WORK_GENERATE', { snapshot: w.snapshot, title: '' })).error, error);
    assert.equal(w.network.length, 1);
    assert.equal(w.app.local.mtWorkProfiles, undefined);
  }
});
test('disabling assistance removes context without deleting profiles; deleting removes bindings without spending', async () => {
  const w = await setup();
  const saved = await save(w);
  const p = saved.profiles[0];
  await save(w, { key: p.key, revision: p.revision, enabled: false });
  assert.equal((await w.app.send('WORK_CONTEXT', { guid: 'ABC', workHint: hints }, w.app.content)).token, '');
  assert.equal((await w.app.send('MT_TRANSLATE', request(w), w.app.content)).ok, true);
  assert.equal(w.network[0].input.work_context, undefined);
  assert.equal(w.app.local.mtWorkProfiles.profiles.length, 1);
  const removed = await w.app.send('WORK_DELETE', { key: p.key, revision: p.revision });
  assert.equal(removed.profiles.length, 0);
  assert.deepEqual(w.app.local.mtWorkProfiles.bindings, {});
  assert.equal(w.network.length, 1);
});
test('profile changed during a batch rejects old in-flight output instead of mixing revisions', async () => {
  let change;
  const w = await setup('chat-completions', async (_url, _init, input) => {
    change();
    return envelope(JSON.stringify({ items: input.items.map(i => ({ id: i.id, text: 'Old profile output' })) }));
  });
  const saved = await save(w);
  const p = saved.profiles[0];
  change = () => { w.app.local.mtWorkProfiles.profiles[0].revision = 'new-revision'; };
  const result = await w.app.send('MT_TRANSLATE', request(w, `${p.key}:${p.revision}`), w.app.content);
  assert.equal(result.error, 'WORK_CHANGED');
  assert.equal(result.translations, undefined);
  assert.equal(w.network.length, 1);
});
test('both translation protocols carry context in data, not instructions, for batch and stream', () => {
  const ctx = context();
  load(ctx, 'lib/relay.js'); load(ctx, 'lib/relay-stream.js');
  for (const protocol of ['chat-completions', 'responses']) {
    for (const streaming of [false, true]) {
      const cfg = { ...config, protocol, workContext: profile };
      const body = streaming
        ? ctx.CRSubFix.relayStream.body(cfg, [{ id: '0', text: 'Hello' }], 'en-US', 'zh-CN')
        : ctx.CRSubFix.relay.body(cfg, ['Hello'], 'en-US', 'zh-CN');
      const input = JSON.parse(body.input || body.messages[1].content);
      assert.deepEqual(input.work_context, profile);
      assert.ok(!(body.instructions || body.messages[0].content).includes(profile.title));
    }
  }
});
test('pending generation excludes translation and duplicate generation on the same tab', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const w = await setup('chat-completions', async () => {
    await gate;
    return envelope(JSON.stringify(profile));
  });
  const running = w.app.send('WORK_GENERATE', { snapshot: w.snapshot, title: profile.title });
  while (!w.network.length) await new Promise(r => setTimeout(r, 1));
  assert.equal((await w.app.send('MT_TRANSLATE', request(w), w.app.content)).error, 'BUSY');
  assert.equal((await w.app.send('WORK_GENERATE', { snapshot: w.snapshot, title: profile.title })).error, 'BUSY');
  assert.equal(w.network.length, 1);
  release();
  assert.equal((await running).ok, true);
});
test('correcting current series association removes the old mapping rather than leaking context to that series', async () => {
  const w = await setup();
  const saved = await save(w), p = saved.profiles[0];
  await save(w, { key: p.key, revision: p.revision, seriesUrl: 'https://www.crunchyroll.com/series/CORRECTED/title' });
  const next = { ...w.app.content, url: 'https://www.crunchyroll.com/watch/NEXT/x' };
  assert.equal((await w.app.send('WORK_CONTEXT', { guid: 'NEXT', workHint: hints }, next)).token, '');
  const correct = await w.app.send('WORK_CONTEXT', { guid: 'NEXT', workHint: { seriesId: 'CORRECTED' } }, next);
  assert.equal(correct.token, `${p.key}:${p.revision}`);
});
