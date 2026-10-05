import test from 'node:test';
import assert from 'node:assert/strict';
import { context, load, json, background, config, savePayload } from './helpers.mjs';

function review() {
  const ctx = context();
  load(ctx, 'lib/translation-review.js');
  return ctx.CRSubFix.translationReview;
}
test('coverage proposes repeated names and honorifics, without guessing Chinese names or treating full names as bare-name coverage', () => {
  const R = review();
  const rows = json(R.coverage(['Hello, Yuki.', 'Yuki can help. Hikaru is here.', 'Hi, Hikaru.',
    'Welcome home, Alya-chan!', 'Masha-san, hello.', 'Kuze, look.', 'Hey Kuze.'], {
    'Kuze Masachika': '久世政近', Alya: '艾莉', Masha: '玛莎',
  }));
  assert.equal(rows.find(r => r.source === 'Yuki').target, '');
  assert.equal(rows.find(r => r.source === 'Hikaru').count, 2);
  assert.equal(rows.find(r => r.source === 'Kuze').key, '');
  assert.equal(rows.find(r => r.source === 'Alya-chan').target, '艾莉');
  assert.equal(rows.find(r => r.source === 'Masha-san').key, 'Masha');
  assert.ok(!rows.some(r => ['Hello', 'Hi', 'Welcome'].includes(r.source)));
  assert.ok(R.coverage(Array(6001).fill('Hello.'), {}).length === 0);
});
test('terminology checks respect Unicode boundaries and longest matching name, and are warnings only', () => {
  const R = review(), glossary = { Yuki: '有希', Kuze: '久世', 'Kuze Masachika': '久世政近', Alya: '艾莉' };
  assert.deepEqual(json(R.issues('Yukiko and xYuki.', '测试', glossary)), []);
  assert.deepEqual(json(R.issues('Kuze Masachika.', '久世政近。', glossary)), []);
  assert.deepEqual(json(R.terms('Kuze Masachika. Kuze!', glossary)), [
    { source: 'Kuze Masachika', target: '久世政近' }, { source: 'Kuze', target: '久世' },
  ]);
  assert.match(R.issues('Yuki can help.', '雪能帮忙。', glossary)[0], /有希/);
  assert.match(R.issues('Alya-chan!', '艾莉同学！', glossary)[0], /称谓/);
  assert.deepEqual(json(R.issues('Yuki.', null, glossary)), []);
  assert.deepEqual(json(R.issues('Yuki.', '有希。', glossary)), []);
});
async function setup({ enabled = true, protocol = 'chat-completions', responder } = {}) {
  const app = background({ fetcher: responder });
  await app.send('MT_SAVE_CONFIG', savePayload({ config: { ...config, protocol, glossary: { Yuki: '错误全局', Other: '其他' } } }));
  let opened, guid = 'ABC';
  app.ctx.chrome.tabs.create = async value => { opened = value.url; };
  const updates = [];
  app.ctx.chrome.tabs.query = async () => [{ id: 1 }];
  app.ctx.chrome.tabs.sendMessage = async (_tab, msg) => {
    if (msg.type === 'WORK_PAGE_CHECK') return { guid };
    updates.push(msg);
  };
  await app.send('WORK_OPEN', { guid, workHint: { title: 'Academy', seriesId: 'SERIES' },
    corpus: ['Yuki is here.', 'Alya-chan, hello.'], samples: ['Yuki is here.'] }, app.content);
  const snapshot = new URL(opened).searchParams.get('snapshot');
  await app.send('WORK_SAVE', { snapshot, enabled, seriesUrl: 'https://www.crunchyroll.com/series/SERIES/x',
    profile: { title: '学园', aliases: 'Academy', context: '开头资料', tone: '自然', glossary: { Yuki: '有希', Alya: '艾莉' } } });
  const work = await app.send('WORK_CONTEXT', { guid, target: 'zh-CN' }, app.content);
  const cache = { key: 'audit-test', guid, configTag: app.local.mtConfigTag, total: 2, target: 'zh-CN', workToken: work.token };
  const payload = { source: 'en-US', target: 'zh-CN', provider: 'relay', configTag: cache.configTag,
    workToken: work.token, texts: ['Yuki is here.'], indices: [0], timings: [{ start: 1, end: 3 }], cache };
  return { app, snapshot, payload, cache, updates, navigate: () => { guid = 'OTHER'; } };
}
test('batch audit stores the effective model input, exact profile revision and glossary precedence but no secrets or endpoint', async () => {
  for (const protocol of ['chat-completions', 'responses']) {
    let sent;
    const { app, snapshot, payload } = await setup({ protocol, responder: async (_url, init) => {
      const request = JSON.parse(init.body);
      sent = JSON.parse(request.input || request.messages[1].content);
      const text = '{"items":[{"id":"0","text":"雪来了。"}]}';
      return { ok: true, text: async () => JSON.stringify(protocol === 'responses'
        ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }
        : { choices: [{ finish_reason: 'stop', message: { content: text } }] }) };
    } });
    const result = await app.send('MT_TRANSLATE', payload, app.content);
    assert.equal(result.ok, true);
    const { runs } = await app.send('WORK_REVIEW_GET', { snapshot });
    assert.equal(runs.length, 1);
    assert.deepEqual(runs[0].info.glossary, sent.glossary);
    assert.equal(runs[0].info.glossary.Yuki, '有希');
    assert.equal(runs[0].info.origins.Yuki, 'work');
    assert.equal(runs[0].info.origins.Other, 'global');
    assert.equal(runs[0].info.profile.revision, app.local.mtWorkProfiles.profiles[0].revision);
    assert.equal(runs[0].entries[0].text, payload.texts[0]);
    assert.equal(runs[0].entries[0].timing.start, 1);
    assert.ok(!JSON.stringify(runs).includes('test-secret'));
    assert.ok(!JSON.stringify(runs).includes('relay.example'));
    // Changing the current profile cannot rewrite the historical request.
    app.local.mtWorkProfiles.profiles[0].glossary.Yuki = '另一个译名';
    assert.equal((await app.send('WORK_REVIEW_GET', { snapshot })).runs[0].info.glossary.Yuki, '有希');
  }
});
test('disabled work assistance is recorded accurately, and drafts/settings reads never masquerade as requests', async () => {
  const { app, snapshot, payload } = await setup({ enabled: false });
  assert.deepEqual((await app.send('WORK_REVIEW_GET', { snapshot })).runs, []);
  await app.send('MT_TRANSLATE', payload, app.content);
  const run = (await app.send('WORK_REVIEW_GET', { snapshot })).runs[0];
  assert.equal(run.info.profile, null);
  assert.equal(run.info.workEnabled, false);
  assert.equal(run.info.glossary.Yuki, '错误全局');
});
test('audit records survive missing metadata on legacy streams and preserve actual requested ids across retries', async () => {
  const { app, payload, snapshot, cache } = await setup();
  await app.send('MT_TRANSLATE', payload, app.content);
  await app.send('MT_TRANSLATE', { ...payload, texts: ['Alya-chan, hello.'], indices: [1], timings: [{ start: 4, end: 5 }] }, app.content);
  const run = (await app.send('WORK_REVIEW_GET', { snapshot })).runs[0];
  assert.equal(run.requests, 2);
  assert.deepEqual(run.entries.map(e => e.index), [0, 1]);
  const denied = await app.send('MT_TRANSLATE', { ...payload, texts: ['Changed source'] }, app.content);
  assert.equal(denied.error, 'INVALID_REVIEW_INPUT');
  assert.equal(app.calls.filter(c => Array.isArray(c) && c[0] === 'fetch').length, 2);
  assert.equal(cache.total, 2);
});
test('trusted correction edits only a completed cached cue, uses compare-and-swap, survives stale saves and makes no paid request', async () => {
  const { app, snapshot, payload, cache, updates } = await setup();
  await app.send('MT_TRANSLATE', payload, app.content);
  await app.send('MT_TRANSLATE', { ...payload, indices: [1], texts: ['Alya-chan, hello.'], timings: [{ start: 4, end: 5 }] }, app.content);
  await app.send('MT_PROGRESS', { ...cache, action: 'save', entries: [{ index: 0, text: '雪来了。' }, { index: 1, text: '艾莉同学，你好。' }] }, app.content);
  const before = app.calls.filter(c => Array.isArray(c) && c[0] === 'fetch').length;
  const correct = { snapshot, key: cache.key, index: 0, previous: '雪来了。', text: '有希来了。' };
  assert.equal((await app.send('WORK_REVIEW_SAVE', correct)).ok, true);
  assert.equal((await app.send('WORK_REVIEW_SAVE', correct)).error, 'REVIEW_TEXT_CHANGED');
  await app.send('MT_PROGRESS', { ...cache, action: 'save', entries: [{ index: 0, text: '雪来了。' }] }, app.content);
  const row = (await app.send('WORK_REVIEW_GET', { snapshot })).runs[0].entries[0];
  assert.equal(row.translated, '有希来了。');
  assert.equal(row.corrected, true);
  assert.equal(row.issues.length, 0);
  assert.ok(updates.some(m => m.type === 'WORK_REVIEW_CHANGED' && m.payload.text === '有希来了。'));
  assert.equal(app.calls.filter(c => Array.isArray(c) && c[0] === 'fetch').length, before);
  assert.equal(app.local.mtWorkProfiles.profiles[0].glossary.Yuki, '有希');
});
test('website cannot read audit or correct cached subtitles; stale snapshots, pending cues and expired caches are refused', async () => {
  const { app, snapshot, payload, cache, navigate } = await setup();
  await app.send('MT_TRANSLATE', payload, app.content);
  const correct = { snapshot, key: cache.key, index: 0, previous: '旧', text: '新' };
  assert.equal((await app.send('WORK_REVIEW_GET', { snapshot }, app.content)).error, 'SENDER_NOT_ALLOWED');
  assert.equal((await app.send('WORK_REVIEW_SAVE', correct, app.content)).error, 'SENDER_NOT_ALLOWED');
  assert.equal((await app.send('MT_PROGRESS', { ...cache, action: 'correct', entries: [] }, app.content)).error, 'INVALID_CACHE_REQUEST');
  assert.equal((await app.send('WORK_REVIEW_SAVE', correct)).error, 'REVIEW_CACHE_EXPIRED');
  await app.send('MT_PROGRESS', { ...cache, action: 'save', entries: [{ index: 0, text: '旧' }] }, app.content);
  assert.equal((await app.send('WORK_REVIEW_SAVE', correct)).error, 'REVIEW_INCOMPLETE');
  app.local['mtProgress:' + cache.key].expires = 0;
  assert.equal((await app.send('WORK_REVIEW_SAVE', correct)).error, 'REVIEW_CACHE_EXPIRED');
  navigate();
  assert.equal((await app.send('WORK_REVIEW_GET', { snapshot })).error, 'WORK_CONTEXT_EXPIRED');
});
test('invalid audit indices and storage failure stop before spending on the provider', async () => {
  const { app, payload } = await setup();
  for (const indices of [[-1], [2], ['0'], [], [0, 0]]) {
    assert.equal((await app.send('MT_TRANSLATE', { ...payload, indices }, app.content)).error, 'INVALID_REVIEW_INPUT');
  }
  app.ctx.chrome.storage.local.set = async () => { throw new Error('private quota message'); };
  assert.equal((await app.send('MT_TRANSLATE', payload, app.content)).error, 'REVIEW_SAVE_FAILED');
  assert.equal(app.calls.filter(c => Array.isArray(c) && c[0] === 'fetch').length, 0);
});
test('request audit has bounded retention and cannot restore an evicted translation', async () => {
  const { app, payload, snapshot } = await setup();
  for (let i = 0; i < 12; i++) {
    const cache = { ...payload.cache, key: `bounded-${i}` };
    await app.send('MT_TRANSLATE', { ...payload, cache }, app.content);
    await app.send('MT_PROGRESS', { ...cache, action: 'save', entries: [{ index: 0, text: '有希来了' }] }, app.content);
  }
  const keys = Object.keys(app.local).filter(k => k.startsWith('mtAudit:'));
  assert.ok(keys.length <= 8);
  const runs = (await app.send('WORK_REVIEW_GET', { snapshot })).runs;
  const latest = runs[0];
  delete app.local['mtProgress:' + latest.key];
  const after = (await app.send('WORK_REVIEW_GET', { snapshot })).runs.find(r => r.key === latest.key);
  assert.equal(after.cached, false);
  assert.equal(after.complete, false);
  assert.equal(after.entries[0].translated, null);
});
test('storage key reordering and switching batch/stream mode cannot interrupt paid-cache resumption', async () => {
  const { app, payload, snapshot } = await setup();
  await app.send('MT_TRANSLATE', payload, app.content);
  const audit = app.local['mtAudit:' + payload.cache.key];
  const reorder = value => value && typeof value === 'object'
    ? Array.isArray(value) ? value.map(reorder) : Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reorder(v)]))
    : value;
  audit.info = reorder(audit.info);
  assert.equal((await app.send('MT_TRANSLATE', { ...payload, indices: [1], texts: ['Alya-chan, hello.'] }, app.content)).ok, true);
  const R = app.ctx.CRSubFix.translationReview;
  await R.record(app.ctx.chrome.storage.local, payload.cache, [{ index: 1, text: 'Alya-chan, hello.', timing: null }],
    { ...audit.info, mode: 'episode-stream', rules: 'future-rule' });
  const run = (await app.send('WORK_REVIEW_GET', { snapshot })).runs[0];
  assert.deepEqual(run.modes, ['batch', 'episode-stream']);
  assert.deepEqual(run.ruleVersions, [R.VERSION, 'future-rule']);
  assert.equal(run.entries[0].rules, R.VERSION);
  assert.equal(run.entries[1].rules, 'future-rule');
});
test('dialogue rules cover names, honorifics, pronouns and permission without adding episode-specific hardcoded names', () => {
  const ctx = context();
  load(ctx, 'lib/relay.js');
  const body = ctx.CRSubFix.relay.body({ ...config, glossary: {} }, ['Hello.'], 'en-US', 'zh-CN');
  const instructions = body.messages[0].content;
  assert.match(instructions, /-chan is an affectionate address/);
  assert.match(instructions, /retain the source spelling/);
  assert.match(instructions, /permission granted versus an application/);
  assert.match(instructions, /name_hints are lexical constraints/);
  assert.match(instructions, /Unmapped phonetic nicknames/);
  assert.ok(!instructions.includes('有希'));
});
test('fixed honorific risks are visible, but ordinary names and explicit school roles remain user choices', () => {
  const R = review();
  assert.deepEqual(json(R.glossaryRisks({ 'A-chan': '甲同学', 'B-san': '乙小姐', A: '甲', 'C-kun': '丙同学' })), [
    { source: 'A-chan', target: '甲同学' }, { source: 'B-san', target: '乙小姐' },
  ]);
  assert.deepEqual(json(R.issues('Yuki.', '雪花。', {}, ['Yuki'])), ['专名候选缺少确认译名：Yuki（可能误报）']);
  assert.deepEqual(json(R.issues('Yuki.', 'Yuki。', {}, ['Yuki'])), []);
});
test('batch and stream annotate exact longest terms and unknown phonetic nicknames without inventing identities', () => {
  const ctx = context();
  for (const name of ['relay', 'relay-stream', 'translation-review']) load(ctx, `lib/${name}.js`);
  const cfg = { ...config, glossary: { 'Kuze Masachika': '久世政近', Alya: '艾莉' } };
  const texts = ['Kuze Masachika and Alya-chan.', 'Sa-kun was there.', 'Yukiko is not xAlya.'];
  const batch = JSON.parse(ctx.CRSubFix.relay.body(cfg, texts, 'en-US', 'zh-CN').messages[1].content);
  const stream = JSON.parse(ctx.CRSubFix.relayStream.body(cfg, texts.map((text, i) => ({ id: String(i), text })),
    'en-US', 'zh-CN').messages[1].content);
  assert.deepEqual(json(batch.items), json(stream.items));
  assert.deepEqual(json(batch.items[0].name_hints), [
    { source: 'Kuze Masachika', target: '久世政近', confirmed: true },
    { source: 'Alya', target: '艾莉', confirmed: true },
  ]);
  assert.deepEqual(json(batch.items[1].name_hints), [{ source: 'Sa-kun', target: 'Sa-kun', confirmed: false }]);
  assert.equal(batch.items[2].name_hints, undefined);
});
test('name hints stay bounded and never change source text or subtitle ids', () => {
  const ctx = context();
  for (const name of ['relay', 'translation-review']) load(ctx, `lib/${name}.js`);
  const glossary = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`Name${i}`, '译'.repeat(50)]));
  const text = Object.keys(glossary).join(' ');
  const input = Array.from({ length: 6000 }, (_, i) => ({ id: String(i), text }));
  const output = ctx.CRSubFix.relay.annotate({ glossary }, input);
  assert.equal(output.length, input.length);
  assert.ok(output.every((row, i) => row.id === input[i].id && row.text === input[i].text && (row.name_hints?.length || 0) <= 8));
  assert.ok(output.flatMap(row => row.name_hints || []).reduce((sum, hint) => sum + JSON.stringify(hint).length, 0) <= 32000);
  assert.ok(input.every(row => !row.name_hints));
});
test('ordinary romanized family addresses are not treated as unknown character names', () => {
  const ctx = context();
  for (const name of ['relay', 'relay-stream', 'translation-review']) load(ctx, `lib/${name}.js`);
  const R = ctx.CRSubFix.translationReview;
  for (const source of ['Nii-sama', 'Onii-chan', 'Nee-san', 'Onee-sama', 'Otou-san', 'Okaa-san', 'Ojii-san', 'Obaa-chan']) {
    assert.equal(R.isKinshipAddress(source), true);
  }
  for (const source of ['Sa-kun', 'Alisa-san', 'Niiya-san', 'Oneesan', 'xNii-sama', 'Nii-sama-san']) {
    assert.equal(R.isKinshipAddress(source), false);
  }
  const texts = ["I'm sorry, Nii-sama.", 'Onii-chan! Onee-san!', 'Sa-kun, hello.'];
  const cfg = { ...config, glossary: {} };
  const batch = JSON.parse(ctx.CRSubFix.relay.body(cfg, texts, 'en-US', 'zh-CN').messages[1].content);
  const stream = JSON.parse(ctx.CRSubFix.relayStream.body(cfg, texts.map((text, i) => ({ id: String(i), text })),
    'en-US', 'zh-CN').messages[1].content);
  assert.deepEqual(json(batch.items), json(stream.items));
  assert.equal(batch.items[0].name_hints, undefined);
  assert.equal(batch.items[1].name_hints, undefined);
  assert.deepEqual(json(batch.items[2].name_hints), [{ source: 'Sa-kun', target: 'Sa-kun', confirmed: false }]);
  assert.deepEqual(json(R.coverage(texts.slice(0, 2), {})), []);
  assert.match(ctx.CRSubFix.relay.DIALOGUE_RULES, /family terms, not personal names/);
});
test('explicit glossary entries for family addresses still override default handling', () => {
  const ctx = context();
  for (const name of ['relay', 'translation-review']) load(ctx, `lib/${name}.js`);
  const glossary = { 'Nii-sama': '哥哥大人' };
  const items = ctx.CRSubFix.relay.annotate({ glossary }, [{ id: '0', text: "I'm sorry, Nii-sama." }]);
  assert.deepEqual(json(items[0].name_hints), [{ source: 'Nii-sama', target: '哥哥大人', confirmed: true }]);
  assert.equal(ctx.CRSubFix.translationReview.coverage(["I'm sorry, Nii-sama."], glossary)[0].target, '哥哥大人');
});
test('Japanese-audio source slot sends English as the actual input language without changing track/cache identity', async () => {
  let sent;
  const { app, snapshot, payload } = await setup({ responder: async (_url, init) => {
    sent = JSON.parse(JSON.parse(init.body).messages[1].content);
    return { ok: true, text: async () => JSON.stringify({ choices: [
      { finish_reason: 'stop', message: { content: '{"items":[{"id":"0","text":"有希来了。"}]}' } },
    ] }) };
  } });
  assert.equal((await app.send('MT_TRANSLATE', { ...payload, source: 'ja-JP' }, app.content)).ok, true);
  assert.equal(sent.source_language, 'English');
  const run = (await app.send('WORK_REVIEW_GET', { snapshot })).runs[0];
  assert.equal(run.info.source, 'ja-JP');
  assert.equal(run.key, payload.cache.key);
  assert.equal(run.entries[0].sourceLanguage, 'en-US');
});
