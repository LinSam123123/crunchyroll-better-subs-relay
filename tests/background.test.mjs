import test from 'node:test';
import assert from 'node:assert/strict';
import { background, config, savePayload } from './helpers.mjs';

async function configured(options = {}) {
  const app = background(options);
  assert.equal((await app.send('MT_SAVE_CONFIG', savePayload())).ok, true);
  app.request = () => ({ texts: ['Hello'], source: 'en-US', target: 'zh-CN',
    provider: 'relay', configTag: app.local.mtConfigTag });
  return app;
}
test('storage restrictions precede secrets; failure closes off reading and saving', async () => {
  const app = background();
  await app.send('MT_GET_CONFIG');
  assert.deepEqual(app.accesses.map(a => a[0]), ['local', 'session']);
  const failed = background({ secure: false });
  assert.equal((await failed.send('MT_GET_CONFIG')).error, 'SECURE_STORAGE_UNAVAILABLE');
  assert.equal(failed.calls.length, 0);
});
test('saving config never returns key, public settings exclude key/url/model', async () => {
  const app = await configured();
  const status = await app.send('MT_GET_CONFIG');
  assert.equal(status.hasKey, true);
  assert.ok(!JSON.stringify(status).includes('test-secret-only'));
  const published = await app.send('PUBLIC_SETTINGS', undefined, app.content);
  assert.equal(published.settings.mtTarget, 'zh-CN');
  for (const secret of ['test-secret-only', 'relay.example', 'test-model']) {
    assert.ok(!JSON.stringify(published).includes(secret));
  }
});
test('page cannot get/save/test config or enable translation through settings bridge', async () => {
  const app = await configured();
  for (const type of ['MT_GET_CONFIG', 'MT_SAVE_CONFIG', 'MT_TEST', 'MT_CLEAR_KEY']) {
    assert.equal((await app.send(type, savePayload(), app.content)).error, 'SENDER_NOT_ALLOWED');
  }
  for (const key of ['mtApiKey', 'relayConfig', 'mtProvider', 'mtEnabled', 'mtConfigTag', 'mtMaxChars', 'mtConcurrency', 'mtTimeoutMs']) {
    assert.equal((await app.send('SET_PUBLIC_SETTING', { key, value: true }, app.content)).error, 'SETTING_NOT_ALLOWED');
  }
  assert.equal((await app.send('SET_PUBLIC_SETTING', { key: 'showSigns', value: false }, app.content)).ok, true);
});
test('foreign senders and wrong origin/subframe are rejected', async () => {
  const app = await configured();
  for (const patch of [{ id: 'other' }, { frameId: 1 }, { url: 'https://evil.example/watch/a' },
    { url: 'https://www.crunchyroll.com.evil.example/watch/a' }]) {
    assert.equal((await app.send('MT_TRANSLATE', app.request(), { ...app.content, ...patch })).error, 'SENDER_NOT_ALLOWED');
  }
  assert.equal((await app.send('MT_TRANSLATE', app.request(), { ...app.content, url: 'https://www.crunchyroll.com/' })).error, 'SENDER_NOT_ALLOWED');
});
test('localized playback paths allow translation while non-playback paths remain blocked', async () => {
  const app = await configured();
  for (const path of ['/zh-tw/watch/GE00378265JAJP/homecoming', '/en-us/watch/ABC/title',
    '/zh-cn/watch/ABC/title', '/de/watch/ABC/title', '/watch/ABC/title']) {
    const result = await app.send('MT_TRANSLATE', app.request(), {
      ...app.content, url: `https://www.crunchyroll.com${path}`,
    });
    assert.equal(result.ok, true, path);
  }
  const before = app.calls.filter(c => Array.isArray(c) && c[0] === 'fetch').length;
  for (const path of ['/', '/zh-tw/', '/zh-tw/watch/', '/zh-tw/series/ABC',
    '/anything/watch/ABC', '/foo/zh-tw/watch/ABC', '/zh-tw/watchlist/ABC']) {
    const result = await app.send('MT_TRANSLATE', app.request(), {
      ...app.content, url: `https://www.crunchyroll.com${path}`,
    });
    assert.equal(result.error, 'SENDER_NOT_ALLOWED', path);
  }
  assert.equal(app.calls.filter(c => Array.isArray(c) && c[0] === 'fetch').length, before);
});
test('changing host/provider requires explicit new key and permission', async () => {
  const app = await configured();
  assert.equal((await app.send('MT_SAVE_CONFIG', savePayload({
    config: { ...config, baseUrl: 'https://another.example/v1' }, apiKey: '',
  }))).error, 'KEY_REQUIRED');
  assert.equal((await app.send('MT_SAVE_CONFIG', savePayload({
    config: { ...config, provider: 'deepl' }, apiKey: '',
  }))).error, 'KEY_REQUIRED');
  app.deny();
  assert.equal((await app.send('MT_SAVE_CONFIG', savePayload())).error, 'HOST_PERMISSION_REQUIRED');
});
test('unchanged save retains cache identity; changing model invalidates it', async () => {
  const app = await configured();
  const tag = app.local.mtConfigTag;
  await app.send('MT_SAVE_CONFIG', savePayload({ apiKey: '' }));
  assert.equal(app.local.mtConfigTag, tag);
  await app.send('MT_SAVE_CONFIG', savePayload({ config: { ...config, model: 'other' }, apiKey: '' }));
  assert.notEqual(app.local.mtConfigTag, tag);
  assert.equal((await app.send('MT_TRANSLATE', { ...app.request(), configTag: tag }, app.content)).error, 'CONFIG_CHANGED');
});
test('translation uses stored host/key, not page supplied connection parameters', async () => {
  const app = await configured();
  const result = await app.send('MT_TRANSLATE', { ...app.request(), baseUrl: 'https://evil.example', apiKey: 'evil' }, app.content);
  assert.deepEqual(result.translations, ['你好']);
  const call = app.calls.find(c => Array.isArray(c) && c[0] === 'fetch');
  assert.equal(call[1], config.baseUrl + '/chat/completions');
  assert.equal(call[2].headers.Authorization, 'Bearer test-secret-only');
});
test('disabled translation, removed key, revoked permission prevent network calls', async () => {
  const app = await configured();
  app.local.mtEnabled = false;
  assert.equal((await app.send('MT_TRANSLATE', app.request(), app.content)).error, 'TRANSLATION_DISABLED');
  app.local.mtEnabled = true; app.deny();
  assert.equal((await app.send('MT_TRANSLATE', app.request(), app.content)).error, 'HOST_PERMISSION_REQUIRED');
  await app.send('MT_CLEAR_KEY');
  assert.equal(app.local.mtApiKey, '');
  assert.equal(app.local.mtEnabled, false);
  assert.ok(!app.calls.some(Array.isArray));
});
test('per-tab concurrency prevents duplicate in-flight requests', async () => {
  let release;
  const app = await configured({ fetcher: () => new Promise(resolve => { release = resolve; }) });
  const first = app.send('MT_TRANSLATE', app.request(), app.content);
  while (!release) await new Promise(r => setImmediate(r));
  assert.equal((await app.send('MT_TRANSLATE', app.request(), app.content)).error, 'BUSY');
  release({ ok: true, text: async () => '{"choices":[{"message":{"content":"{\\"items\\":[{\\"id\\":\\"0\\",\\"text\\":\\"ok\\"}]}"}}]}' });
  assert.equal((await first).ok, true);
});
test('request budgeting survives worker state and blocks excess', async () => {
  const app = await configured();
  app.session['relayBudget:1'] = { started: Date.now(), requests: 200, chars: 0 };
  assert.equal((await app.send('MT_TRANSLATE', app.request(), app.content)).error, 'BUDGET_EXCEEDED');
  app.session['relayBudget:1'] = { started: Date.now(), requests: 0, chars: 99999 };
  assert.equal((await app.send('MT_TRANSLATE', app.request(), app.content)).error, 'BUDGET_EXCEEDED');
});
test('in-flight configuration changes discard the old result', async () => {
  let release;
  const app = await configured({ fetcher: () => new Promise(resolve => { release = resolve; }) });
  const running = app.send('MT_TRANSLATE', app.request(), app.content);
  while (!release) await new Promise(r => setImmediate(r));
  await app.send('MT_CLEAR_KEY');
  release({ ok: true, text: async () => '{"choices":[{"message":{"content":"{\\"items\\":[{\\"id\\":\\"0\\",\\"text\\":\\"ok\\"}]}"}}]}' });
  assert.equal((await running).error, 'CONFIG_CHANGED');
});
test('network errors are sanitized, bounded to one attempt', async () => {
  const app = await configured({ fetcher: async () => { throw new Error('leaked bearer private-key'); } });
  const response = await app.send('MT_TRANSLATE', app.request(), app.content);
  assert.deepEqual(response, { ok: false, error: 'NETWORK_UNKNOWN' });
  assert.equal(app.calls.filter(Array.isArray).length, 1);
});
test('parallel background requests enforce per-tab/global limits, deduplicate ids, and count budgets atomically', async () => {
  const releases = [];
  const app = await configured({ fetcher: () => new Promise(r => releases.push(r)) });
  const send = (tab, id) => app.send('MT_TRANSLATE', { ...app.request(), requestId: id },
    { ...app.content, tab: { id: tab } });
  const running = [send(1, 'a'), send(1, 'b'), send(2, 'c'), send(2, 'd')];
  while (releases.length < 4) await new Promise(r => setImmediate(r));
  assert.equal((await send(1, 'a')).error, 'BUSY');
  assert.equal((await send(1, 'e')).error, 'BUSY');
  assert.equal((await send(3, 'f')).error, 'BUSY');
  assert.equal(app.session['relayBudget:1'].requests, 2);
  assert.equal(app.session['relayBudget:1'].chars, 10);
  releases.forEach(r => r({ ok: true, text: async () => JSON.stringify({
    choices: [{ message: { content: '{"items":[{"id":"0","text":"ok"}]}' } }],
  }) }));
  assert.ok((await Promise.all(running)).every(r => r.ok));
});
test('two parallel requests cannot both spend the last budget slot', async () => {
  const app = await configured();
  app.session['relayBudget:1'] = { started: Date.now(), requests: 199, chars: 0 };
  const results = await Promise.all(['a', 'b'].map(requestId =>
    app.send('MT_TRANSLATE', { ...app.request(), requestId }, app.content)));
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results.filter(r => r.error === 'BUDGET_EXCEEDED').length, 1);
  assert.equal(app.session['relayBudget:1'].requests, 200);
});
test('saved concurrency one is enforced by the background', async () => {
  let release;
  const app = await configured({ fetcher: () => new Promise(r => { release = r; }) });
  await app.send('MT_SAVE_CONFIG', savePayload({ config: { ...config, concurrency: 1 }, apiKey: '' }));
  const first = app.send('MT_TRANSLATE', { ...app.request(), requestId: 'a' }, app.content);
  while (!release) await new Promise(r => setImmediate(r));
  assert.equal((await app.send('MT_TRANSLATE', { ...app.request(), requestId: 'b' }, app.content)).error, 'BUSY');
  release({ ok: false, status: 401 });
  await first;
});
test('unconfigured public settings and old saved configurations default to two requests', async () => {
  const fresh = background();
  const first = await fresh.send('PUBLIC_SETTINGS', undefined, fresh.content);
  assert.equal(first.ok, true);
  assert.equal(first.configured, false);
  assert.equal(first.settings.mtConcurrency, 2);
  const app = await configured();
  delete app.local.relayConfig.concurrency;
  const result = await app.send('PUBLIC_SETTINGS', undefined, app.content);
  assert.equal(result.settings.mtConcurrency, 2);
});
test('tuning timeout/batch/concurrency preserves translation identity and publishes timeout', async () => {
  const app = await configured();
  const tag = app.local.mtConfigTag;
  await app.send('MT_SAVE_CONFIG', savePayload({
    config: { ...config, timeoutMs: 60000, batchSize: 15, concurrency: 1 }, apiKey: '',
  }));
  assert.equal(app.local.mtConfigTag, tag);
  const result = await app.send('PUBLIC_SETTINGS', undefined, app.content);
  assert.equal(result.settings.mtTimeoutMs, 60000);
});
test('count mismatch reports only numeric expected/received counts', async () => {
  const app = await configured({ fetcher: async () => ({ ok: true, text: async () =>
    JSON.stringify({ choices: [{ message: { content: '{"items":[]}' } }] }) }) });
  const result = await app.send('MT_TRANSLATE', app.request(), app.content);
  assert.deepEqual(result, { ok: false, error: 'ITEM_COUNT_MISMATCH', counts: { expected: 1, received: 0 } });
});
