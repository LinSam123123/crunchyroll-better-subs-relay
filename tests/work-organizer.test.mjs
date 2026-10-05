import test from 'node:test';
import assert from 'node:assert/strict';
import { context, load, json, background, config, savePayload } from './helpers.mjs';

const subject = { id: 1, name: 'Academy', nameCn: '学园', date: '', platform: 'TV', url: 'https://bgm.tv/subject/1' };
const character = { id: 101, name: '久世政近', nameCn: '久世政近',
  aliases: ['Kuze Masachika'], fetchedAt: 12345 };
const reference = { subject, characters: [character] };
const profile = { title: 'Academy', aliases: '', context: '', tone: '', glossary: { Kuze: '久世' } };
const snapshot = { hint: { title: 'Academy' }, target: 'zh-CN', samples: ['Hello Kuze.'],
  corpus: [...Array(80).fill('Hello Kuze.'), 'Masachika, Kuze-kun and Sa-kun.'] };
const term = (patch = {}) => ({ source: 'Masachika', target: '政近', characterId: 101, status: 'suggested', note: 'Given name.', ...patch });
const draft = terms => ({ context: 'School classmates.', tone: 'Natural.', terms });
const envelope = (data, protocol) => ({ ok: true, text: async () => JSON.stringify(protocol === 'responses'
  ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(data) }] }] }
  : { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(data) } }] }) });
function api() {
  const c = context();
  for (const p of ['lib/relay.js', 'lib/work-lookup.js', 'lib/work-profiles.js', 'lib/work-organizer.js']) load(c, p);
  return { O: c.CRSubFix.workOrganizer, W: c.CRSubFix.workProfiles, L: c.CRSubFix.workLookup };
}
test('organizer includes late subtitle evidence and public names in data, not instructions, for both protocols', async () => {
  const { O } = api();
  const input = O.prepare(snapshot, profile, reference);
  assert.equal(input.early_subtitles.length, 1);
  assert.ok(input.episode_subtitles.at(-1).includes('Sa-kun'));
  for (const protocol of ['chat-completions', 'responses']) {
    let request;
    const result = await O.generate({ ...config, protocol }, 'secret', input, reference, async (_url, init) => {
      request = JSON.parse(init.body);
      assert.equal(init.headers.Authorization, 'Bearer secret');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.redirect, 'error');
      return envelope(draft([term()]), protocol);
    });
    const sent = JSON.parse(request.input || request.messages[1].content);
    assert.equal(sent.public_reference.characters[0].id, 101);
    assert.equal(sent.current_draft.glossary.Kuze, '久世');
    assert.ok(!(request.instructions || request.messages[0].content).includes('久世政近'));
    assert.equal(request.stream, false);
    assert.equal(result.terms[0].provenance.method, 'model-assisted');
  }
});
test('surname, given name and honorific expanded to a full name are quarantined despite model confidence', () => {
  const { O } = api(), input = O.prepare(snapshot, profile, reference);
  for (const source of ['Kuze', 'Masachika', 'Kuze-kun']) {
    const result = O.parse(draft([term({ source, target: '久世政近' })]), input, reference);
    assert.equal(result.terms[0].status, 'uncertain');
    assert.match(result.terms[0].note, /姓名片段/);
  }
});
test('invented source, unsupported character and competing mappings cannot become default accepted candidates', () => {
  const { O } = api(), input = O.prepare(snapshot, profile, reference);
  assert.equal(O.parse(draft([term({ source: 'Nonexistent' })]), input, reference).terms[0].status, 'uncertain');
  assert.equal(O.parse(draft([term({ characterId: null })]), input, reference).terms[0].status, 'uncertain');
  assert.equal(O.parse(draft([term({ characterId: null })]), input, reference).terms[0].provenance, null);
  assert.throws(() => O.parse(draft([term({ characterId: 999 })]), input, reference), /INVALID_WORK_PROFILE/);
  const competing = O.parse(draft([term(), term({ target: '其他' })]), input, reference);
  assert.ok(competing.terms.every(t => t.status === 'uncertain'));
  for (const patch of [{ status: 'verified' }, { source: '' }, { note: 'x'.repeat(201) }]) {
    assert.throws(() => O.parse(draft([term(patch)]), input, reference), /INVALID_WORK_PROFILE/);
  }
});
test('affectionate honorifics frozen into social roles are quarantined for review', () => {
  const { O } = api();
  const input = O.prepare({ ...snapshot, corpus: ['Kuze-chan, hello.'] }, profile, reference);
  const result = O.parse(draft([term({ source: 'Kuze-chan', target: '久世同学' })]), input, reference);
  assert.equal(result.terms[0].status, 'uncertain');
  assert.match(result.terms[0].note, /亲昵称谓/);
});
test('model context, term counts and subtitle transmission remain bounded', () => {
  const { O } = api();
  const input = O.prepare({ ...snapshot, corpus: Array(1000).fill('x'.repeat(500)) }, profile, reference);
  assert.ok(input.episode_subtitles.join('').length <= 40000);
  assert.throws(() => O.prepare({ ...snapshot, target: 'de-DE' }, profile, reference), /ORGANIZE_LANGUAGE/);
  assert.throws(() => O.parse(draft(Array(81).fill(term())), input, reference), /INVALID_WORK_PROFILE/);
  assert.throws(() => O.parse({ ...draft([]), context: 'x'.repeat(1501) }, input, reference), /INVALID_WORK_PROFILE/);
});
async function setup(protocol = 'chat-completions', responder) {
  const calls = [];
  const app = background({ fetcher: async (url, init) => {
    calls.push({ url, init });
    if (responder) return responder(url, init);
    return envelope(draft([term()]), protocol);
  } });
  await app.send('MT_SAVE_CONFIG', savePayload({ config: { ...config, protocol } }));
  let guid = 'ABC', opened;
  app.ctx.chrome.tabs.create = async value => { opened = value.url; };
  app.ctx.chrome.tabs.sendMessage = async (_id, msg) => msg.type === 'WORK_PAGE_CHECK' ? { guid } : undefined;
  await app.send('WORK_OPEN', { guid: 'ABC', workHint: { title: 'Academy', seriesId: 'S' },
    samples: snapshot.samples, corpus: snapshot.corpus }, app.content);
  const key = new URL(opened).searchParams.get('snapshot');
  app.session.mtLookupCache = [
    { key: 'search:Academy', result: { subjects: [subject], fetchedAt: Date.now() } },
    { key: 'characters:1:0', result: { subjectId: 1, characters: [character], fetchedAt: Date.now() } },
  ];
  const payload = { snapshot: key, subjectId: 1, characterIds: [101], profile };
  return { app, payload, calls, navigate: () => { guid = 'OTHER'; } };
}
test('background organizes from trusted cached evidence, returns preview only, and does not save or translate', async () => {
  const { app, payload, calls } = await setup();
  const result = await app.send('WORK_ORGANIZE', { ...payload,
    reference: { subject: 'forged', characters: [{ id: 999 }] }, apiKey: 'forged' });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  const sent = JSON.parse(JSON.parse(calls[0].init.body).messages[1].content);
  assert.equal(sent.public_reference.subject.id, 1);
  assert.equal(sent.public_reference.characters[0].id, 101);
  assert.ok(!JSON.stringify(sent).includes('forged'));
  assert.equal(app.local.mtWorkProfiles, undefined);
  assert.ok(app.session['relayBudget:1'].chars >= JSON.stringify(sent).length);
  assert.equal((await app.send('WORK_CONTEXT', { guid: 'ABC', workHint: { seriesId: 'S' } }, app.content)).token, '');
});
test('website cannot organize and missing, mismatched or expired public evidence fails before any paid call', async () => {
  const { app, payload, calls } = await setup();
  assert.equal((await app.send('WORK_ORGANIZE', payload, app.content)).error, 'SENDER_NOT_ALLOWED');
  for (const extra of [{ subjectId: 2 }, { characterIds: [999] }, { characterIds: [] }]) {
    assert.equal((await app.send('WORK_ORGANIZE', { ...payload, ...extra })).error, 'LOOKUP_EVIDENCE_EXPIRED');
  }
  app.session.mtLookupCache.forEach(row => { row.result.fetchedAt = 1; });
  assert.equal((await app.send('WORK_ORGANIZE', payload)).error, 'LOOKUP_EVIDENCE_EXPIRED');
  assert.equal(calls.length, 0);
});
test('page navigation, missing permissions and request budget prevent organizer spending', async () => {
  const w = await setup();
  w.app.session['relayBudget:1'] = { started: Date.now(), chars: 100000, requests: 10 };
  assert.equal((await w.app.send('WORK_ORGANIZE', w.payload)).error, 'BUDGET_EXCEEDED');
  w.app.deny();
  assert.equal((await w.app.send('WORK_ORGANIZE', w.payload)).error, 'HOST_PERMISSION_REQUIRED');
  w.navigate();
  assert.equal((await w.app.send('WORK_ORGANIZE', w.payload)).error, 'WORK_CONTEXT_EXPIRED');
  assert.equal(w.calls.length, 0);
});
test('organizer failure never retries and in-flight provider changes invalidate results', async () => {
  for (const response of [{ ok: false, status: 429 }, envelope({ bad: 'schema' })]) {
    const w = await setup('chat-completions', async () => response);
    const result = await w.app.send('WORK_ORGANIZE', w.payload);
    assert.equal(result.ok, false);
    assert.equal(w.calls.length, 1);
    assert.equal(w.app.local.mtWorkProfiles, undefined);
  }
  let release;
  const w = await setup('responses', () => new Promise(resolve => { release = resolve; }));
  const pending = w.app.send('WORK_ORGANIZE', w.payload);
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal((await w.app.send('WORK_ORGANIZE', w.payload)).error, 'BUSY');
  w.app.local.mtConfigTag = 'changed';
  release(envelope(draft([term()]), 'responses'));
  assert.equal((await pending).error, 'CONFIG_CHANGED');
});
test('empty profile requires explicit acknowledgement, while background-only and terminology-only profiles remain valid', async () => {
  const { W } = api();
  let db;
  const storage = { get: async () => ({ mtWorkProfiles: db }), set: async value => { db = value.mtWorkProfiles; } };
  await assert.rejects(W.save(storage, { profile: { title: 'Only title' } }, null, 'zh-CN'), /EMPTY_WORK_PROFILE/);
  assert.equal(db, undefined);
  const saved = await W.save(storage, { profile: { title: 'Only title' }, allowEmpty: true }, null, 'zh-CN');
  assert.equal(Object.keys(saved.glossary).length, 0);
  assert.ok(await W.save(storage, { profile: { title: 'Background', context: 'School.' } }, null, 'zh-CN'));
  assert.ok(await W.save(storage, { profile }, null, 'zh-CN'));
});
test('model-assisted source annotation persists without pretending to be an exact website quote', () => {
  const { L, O } = api(), input = O.prepare(snapshot, profile, reference);
  const result = O.parse(draft([term()]), input, reference);
  const merged = L.merge(profile.glossary, {}, result.terms);
  assert.equal(merged.glossary.Masachika, '政近');
  assert.equal(merged.sources.Masachika.method, 'model-assisted');
  const unsupported = L.merge({}, {}, [term({ source: 'Sa-kun', target: '阿真', characterId: null })]);
  assert.deepEqual(json(unsupported.sources), {});
});
