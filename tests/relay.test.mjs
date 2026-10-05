import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { relayContext, config, json, source } from './helpers.mjs';

const ctx = relayContext();
const R = ctx.CRSubFix.relay;
const U = ctx.CRSubFix.mtUtils;
test('normalizes base prefix, rejects unsafe and endpoint URLs', () => {
  assert.equal(R.baseUrl('https://relay.example/v1///'), config.baseUrl);
  assert.equal(R.baseUrl('http://127.0.0.1:9999/v1'), 'http://127.0.0.1:9999/v1');
  for (const url of ['http://remote.example/v1', 'javascript:alert(1)', 'https://user:pass@relay.example',
    'https://relay.example/v1?q=key', 'https://relay.example/v1#key', 'https://relay.example/v1/responses',
    'https://relay.example/v1/chat/completions']) assert.throws(() => R.baseUrl(url));
  assert.equal(R.originPattern('http://localhost:9123/v1'), 'http://localhost/*');
});
test('rejects invalid limits and model', () => {
  for (const patch of [{ batchSize: 0 }, { batchSize: 51 }, { maxChars: 12001 }, { timeoutMs: 120001 },
    { model: '' }, { protocol: 'other' }, { provider: 'other' }]) assert.throws(() => R.config({ ...config, ...patch }));
});
test('slow-provider timeout supports 60 and 120 seconds', () => {
  for (const timeoutMs of [60000, 120000]) assert.equal(R.config({ ...config, timeoutMs }).timeoutMs, timeoutMs);
});
test('chat and Responses carry stable ids, explicit Simplified Chinese and no storage in Responses', () => {
  const chat = R.body(config, ['one', 'two'], 'en-US', 'zh-CN');
  assert.equal(chat.stream, false);
  const payload = JSON.parse(chat.messages[1].content);
  assert.deepEqual(payload.items.map(t => t.id), ['0', '1']);
  assert.match(payload.target_language, /Simplified Chinese/);
  const responses = R.body({ ...config, protocol: 'responses' }, ['one'], '', 'zh-CN');
  assert.equal(responses.store, false);
  assert.equal(responses.model, config.model);
  assert.ok(responses.instructions);
});
test('parses JSON/fenced JSON and reorders by id without relying on order', () => {
  assert.deepEqual(json(R.parse('```json\n{"items":[{"id":"1","text":"二"},{"id":"0","text":"一"}]}\n```', 2)), ['一', '二']);
});
test('refuses duplicate, missing, extra, blank, non-string and malformed items', () => {
  for (const value of [
    '{"items":[{"id":"0","text":"a"},{"id":"0","text":"b"}]}',
    '{"items":[{"id":"0","text":"a"}]}',
    '{"items":[{"id":"0","text":"a"},{"id":"2","text":"b"}]}',
    '{"items":[{"id":0,"text":"a"},{"id":"1","text":"b"}]}',
    '{"items":[{"id":"0","text":""},{"id":"1","text":"b"}]}',
    '{"items":[{"id":"0","text":null},{"id":"1","text":"b"}]}',
    'Here is your answer: {"items":[]}',
  ]) assert.throws(() => R.parse(value, 2));
});
test('Responses output extraction ignores reasoning and rejects truncation', () => {
  assert.equal(R.extract({ status: 'completed', output: [
    { type: 'reasoning', content: [{ type: 'output_text', text: 'private' }] },
    { type: 'message', content: [{ type: 'output_text', text: '{"items":[]}' }] },
  ] }, 'responses'), '{"items":[]}');
  assert.throws(() => R.extract({ status: 'incomplete' }, 'responses'));
  assert.throws(() => R.extract({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }, 'chat-completions'));
});
test('relay sends to correct endpoint with isolated headers, no redirects/cookies', async () => {
  let called;
  const result = await R.translate(config, 'private-key', ['hello'], 'en-US', 'zh-CN', async (url, init) => {
    called = { url, init };
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '{"items":[{"id":"0","text":"你好"}]}' } }] }) };
  });
  assert.equal(called.url, config.baseUrl + '/chat/completions');
  assert.equal(called.init.headers.Authorization, 'Bearer private-key');
  assert.equal(called.init.redirect, 'error');
  assert.equal(called.init.credentials, 'omit');
  assert.ok(!called.init.body.includes('private-key'));
  assert.deepEqual(json(result), ['你好']);
});
test('Responses request and parsed output roundtrip', async () => {
  await R.translate({ ...config, protocol: 'responses' }, 'key', ['hello'], 'en-US', 'zh-CN', async (url, init) => {
    assert.match(url, /\/responses$/);
    assert.equal(JSON.parse(init.body).store, false);
    return { ok: true, text: async () => JSON.stringify({ status: 'completed',
      output: [{ type: 'message', content: [{ type: 'output_text', text: '{"items":[{"id":"0","text":"你好"}]}' }] }] }) };
  });
});
test('DeepL preserves compatibility and distinguishes simplified/traditional', async () => {
  for (const [target, code] of [['zh-CN', 'ZH-HANS'], ['zh-TW', 'ZH-HANT']]) {
    await R.translate({ ...config, provider: 'deepl' }, 'secret:fx', ['hello'], 'en-US', target, async (url, init) => {
      assert.equal(url, 'https://api-free.deepl.com/v2/translate');
      assert.equal(new URLSearchParams(init.body).get('target_lang'), code);
      return { ok: true, text: async () => '{"translations":[{"text":"你好"}]}' };
    });
  }
});
test('HTTP errors do not include provider bodies and are not silently retried', async () => {
  let calls = 0;
  await assert.rejects(R.translate(config, 'key', ['hello'], 'en-US', 'zh-CN', async () => {
    calls++; return { ok: false, status: 401, text: async () => 'secret-leak' };
  }), /HTTP_401/);
  assert.equal(calls, 1);
});
test('batch validation rejects excessive characters, blank items and excessive count', () => {
  for (const texts of [[], [' '], [7], Array(11).fill('a'), ['a'.repeat(3001)]]) {
    assert.throws(() => R.validateTexts(texts, config));
  }
});
test('batches respect both item and character limits, preserve index order', () => {
  assert.deepEqual(json(U.batches(['aaa', 'bb', 'cccc', 'd'], [0, 1, 2, 3], 2, 5)), [[0, 1], [2, 3]]);
  assert.throws(() => U.batches(['too long'], [0], 2, 3), /SUBTITLE_TOO_LONG/);
});
test('fingerprint changes with source text, timing and signs', async () => {
  const a = [{ start: 0, end: 1, text: 'hello' }];
  const hash = await U.fingerprint(a, '');
  assert.equal(hash, await U.fingerprint(a, ''));
  for (const [cues, signs] of [[[{ ...a[0], text: 'other' }], ''], [[{ ...a[0], end: 2 }], ''], [a, 'sign']]) {
    assert.notEqual(hash, await U.fingerprint(cues, signs));
  }
});
test('translations cannot introduce ASS tags; newlines remain usable', () => {
  assert.equal(U.plainText('{\\pos(0,0)}你好\\N世界\r\n!'), '你好\n世界\n!');
  assert.ok(!U.plainText('\\p1 abc {x}').includes('\\'));
});
test('only pre-dispatch busy / explicit rate-limit failures can auto retry', () => {
  assert.equal(U.retryable('HTTP_429'), true);
  assert.equal(U.retryable('BUSY'), true);
  for (const e of ['TIMEOUT_UNKNOWN', 'NETWORK_UNKNOWN', 'timeout', 'HTTP_502', 'ID_MISMATCH']) {
    assert.equal(U.retryable(e), false);
  }
});
test('private manifest has independent identity and both scripting worlds', () => {
  const m = JSON.parse(source('manifest.json'));
  assert.equal(m.key, undefined); assert.equal(m.update_url, undefined);
  assert.equal(m.options_page, 'translation.html');
  assert.equal(m.content_scripts.length, 2);
  assert.equal(m.content_scripts[0].world, 'MAIN');
  assert.ok(m.content_scripts[0].js.includes('lib/mt-utils.js'));
  assert.ok(m.content_scripts[1].js.includes('lib/iso-bundle.js'));
});
test('content script never accesses extension storage or relay configuration', () => {
  const content = source('content.js');
  assert.doesNotMatch(content, /chrome\.storage\.(local|session|onChanged)\./);
  assert.doesNotMatch(content, /mtApiKey|relayConfig/);
  const schema = source('lib/settings-schema.js');
  assert.doesNotMatch(schema, /key:\s*'(?:mtApiKey|relayConfig|baseUrl|model)'/);
});
test('private build does not auto resume potentially billed requests or report upstream', () => {
  assert.doesNotMatch(source('interceptor.js'), /maybeAutoResumeTranslate|autoReloadIfBridgeDead/);
  assert.match(source('lib/config.js'), /REPORT_ENDPOINT:\s*''/);
});
test('subtitle acquisition, rendering and synchronization retain upstream bytes', () => {
  const baseline = JSON.parse(readFileSync(new URL('../upstream-files.json', import.meta.url), 'utf8'));
  for (const p of ['lib/playback-api.js', 'lib/cue-renderer.js',
    // ASS zero-duration compatibility is intentionally patched and covered by parser tests.
    // source-menu.js intentionally adds export access for captured native tracks.
    'lib/sub-sync.js', 'lib/episode.js', 'lib/sign-track.js',
    'lib/octopus/subtitles-octopus.js', 'lib/octopus/subtitles-octopus-worker.wasm']) {
    const bytes = readFileSync(new URL(`../extension/${p}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), baseline.files[p], p);
  }
});

test('ASS parser differs from upstream only by the zero-duration compatibility guard', () => {
  const baseline = JSON.parse(readFileSync(new URL('../upstream-files.json', import.meta.url), 'utf8'));
  const original = source('lib/subtitle-parser.js').replace(
    /          \/\/ Zero-duration ASS effects never display; they must not invalidate the whole track\.\r?\n          if \(Number\.isFinite\(start\) && start === end\) continue;\r?\n/, '');
  assert.equal(createHash('sha256').update(original).digest('hex'), baseline.files['lib/subtitle-parser.js']);
});
