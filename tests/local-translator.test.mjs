import test from 'node:test';
import assert from 'node:assert/strict';
import { context, load, background, savePayload } from './helpers.mjs';

function local() { const ctx = context(); load(ctx, 'lib/local-translator.js'); return ctx.CRSubFix.localTranslator; }
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
test('local language normalization keeps Chinese scripts separate', () => {
  const L = local();
  assert.equal(L.pair('en-US', 'zh-CN'), 'en:zh');
  assert.equal(L.pair('ja-JP', 'zh-TW'), 'ja:zh-Hant');
  assert.throws(() => L.language('auto'), /LOCAL_LANGUAGE/);
});
test('preparation starts create synchronously and preserves cue boundaries', async () => {
  let created = false, destroyed = false;
  const engine = local().engine({ create() { created = true; return Promise.resolve({
    translate: async text => `Translated: ${text}`, destroy() { destroyed = true; },
  }); } });
  const ready = engine.prepare('en-US', 'zh-CN');
  assert.equal(created, true); await ready;
  assert.deepEqual([...await engine.translate('en', 'zh', ['one', 'two'])], ['Translated: one', 'Translated: two']);
  await assert.rejects(engine.translate('en', 'ja', ['one']), /LOCAL_LANGUAGE/);
  engine.stop(); assert.equal(destroyed, true);
  await assert.rejects(engine.translate('en', 'zh', ['one']), /LOCAL_NOT_READY/);
});
test('unsupported, unavailable and cancelled downloads are explicit', async () => {
  await assert.rejects(local().engine().prepare('en', 'zh'), /LOCAL_UNSUPPORTED/);
  const unavailable = local().engine({ create: async () => { const e = new Error(); e.name = 'NotSupportedError'; throw e; } });
  await assert.rejects(unavailable.prepare('en', 'zh'), /LOCAL_UNAVAILABLE/);
  let finish, destroyed = false;
  const engine = local().engine({ create: () => new Promise(resolve => { finish = resolve; }) });
  const pending = engine.prepare('en', 'zh'); engine.stop();
  finish({ destroy() { destroyed = true; } });
  await assert.rejects(pending, /LOCAL_CANCELLED/); assert.equal(destroyed, true);
});
test('local settings require neither key nor host access and retain cloud credentials', async () => {
  const b = background();
  await b.send('MT_SAVE_CONFIG', savePayload());
  const key = b.local.mtApiKey;
  b.deny();
  const saved = await b.send('MT_SAVE_CONFIG', savePayload({ config: { provider: 'local' }, apiKey: '' }));
  assert.equal(saved.ok, true); assert.equal(saved.authorized, true);
  assert.equal(b.local.mtApiKey, key); assert.equal(b.local.mtCloudConfig.provider, 'relay');
  assert.equal(saved.config.batchSize, 1); assert.equal(saved.config.concurrency, 1);
  assert.equal((await b.send('MT_TEST')).error, 'LOCAL_NOT_READY');
  assert.equal(b.calls.some(c => Array.isArray(c) && c[0] === 'fetch'), false);
  assert.ok(!JSON.stringify(saved).includes(key));
});
test('local mode saves with no existing cloud configuration', async () => {
  const b = background({ allowed: false });
  assert.equal((await b.send('MT_SAVE_CONFIG', savePayload({ config: { provider: 'local' }, apiKey: '' }))).ok, true);
  assert.equal((await b.send('PUBLIC_SETTINGS')).configured, true);
});

test('returning from local restores the cloud key only for the original destination', async () => {
  const b = background();
  await b.send('MT_SAVE_CONFIG', savePayload());
  await b.send('MT_SAVE_CONFIG', savePayload({ config: { provider: 'local' }, apiKey: '' }));
  assert.equal((await b.send('MT_SAVE_CONFIG', savePayload({ apiKey: '' }))).ok, true);
  await b.send('MT_SAVE_CONFIG', savePayload({ config: { provider: 'local' }, apiKey: '' }));
  const other = savePayload({ apiKey: '' }); other.config.baseUrl = 'https://other.example/v1';
  assert.equal((await b.send('MT_SAVE_CONFIG', other)).error, 'KEY_REQUIRED');
  assert.equal(b.local.relayConfig.provider, 'local');
});
test('only the trusted settings page can provide local translations; disconnect rejects active work', async () => {
  const b = background();
  await b.send('MT_SAVE_CONFIG', savePayload({ config: { provider: 'local' }, apiKey: '' }));
  assert.equal(b.connect(b.content, 'MT_LOCAL_ENGINE').closed, true);
  const engine = b.connect(b.popup, 'MT_LOCAL_ENGINE');
  engine.post({ type: 'ready', pair: 'en:zh' });
  const pending = b.send('MT_TEST'); await tick();
  const request = engine.messages.find(m => m.type === 'translate');
  assert.ok(request); assert.deepEqual(request.texts, ['Hello. Thank you for waiting.']);
  engine.post({ type: 'result', id: request.id, translations: ['Test translation'] });
  assert.deepEqual((await pending).translations, ['Test translation']);
  const next = b.send('MT_TEST'); await tick(); engine.disconnect();
  assert.equal((await next).error, 'LOCAL_NOT_READY');
  assert.equal(b.calls.some(c => Array.isArray(c) && c[0] === 'fetch'), false);
});
test('local output rejects missing entries, and changing target requires a matching model', async () => {
  const b = background();
  await b.send('MT_SAVE_CONFIG', savePayload({ config: { provider: 'local' }, apiKey: '' }));
  const engine = b.connect(b.popup, 'MT_LOCAL_ENGINE'); engine.post({ type: 'ready', pair: 'en:zh' });
  const pending = b.send('MT_TEST'); await tick();
  engine.post({ type: 'result', id: engine.messages[0].id, translations: [] });
  assert.equal((await pending).error, 'LOCAL_INVALID_OUTPUT');
  await b.send('MT_SAVE_CONFIG', savePayload({ config: { provider: 'local' }, apiKey: '', target: 'ja-JP' }));
  assert.equal((await b.send('MT_TEST')).error, 'LOCAL_LANGUAGE');
});

test('a new prepared settings page revokes the old engine and settles in-flight work', async () => {
  const b = background();
  await b.send('MT_SAVE_CONFIG', savePayload({ config: { provider: 'local' }, apiKey: '' }));
  const old = b.connect(b.popup, 'MT_LOCAL_ENGINE'); old.post({ type: 'ready', pair: 'en:zh' });
  const pending = b.send('MT_TEST'); await tick();
  const next = b.connect({ ...b.popup, url: b.popup.url + '?target=zh-CN' }, 'MT_LOCAL_ENGINE');
  next.post({ type: 'ready', pair: 'en:zh' });
  assert.equal((await pending).error, 'LOCAL_NOT_READY');
  assert.equal(old.messages.at(-1).type, 'replaced');
  old.disconnect();
  const task = b.send('MT_TEST'); await tick();
  next.post({ type: 'result', id: next.messages.at(-1).id, translations: ['New engine result'] });
  assert.equal((await task).ok, true);
});
