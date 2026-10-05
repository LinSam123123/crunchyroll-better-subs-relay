import test from 'node:test';
import assert from 'node:assert/strict';
import { background, savePayload } from './helpers.mjs';

async function setup(options) {
  const app = background(options);
  await app.send('MT_SAVE_CONFIG', savePayload());
  app.progress = (action, overrides = {}, sender = app.content) => app.send('MT_PROGRESS', {
    action, guid: 'ABC', key: 'episode:key', total: 3, configTag: app.local.mtConfigTag, ...overrides,
  }, sender);
  return app;
}
test('parallel patches merge without lost writes and survive a fresh background context', async () => {
  const app = await setup();
  const results = await Promise.all([
    app.progress('save', { entries: [{ index: 0, text: 'one' }] }),
    app.progress('save', { entries: [{ index: 2, text: 'three' }] }),
  ]);
  assert.ok(results.every(r => r.ok));
  assert.deepEqual((await app.progress('get')).values, ['one', null, 'three']);
  const restored = background({ data: structuredClone(app.local) });
  const read = await restored.send('MT_PROGRESS', { action: 'get', guid: 'ABC', key: 'episode:key',
    total: 3, configTag: app.local.mtConfigTag }, restored.content);
  assert.deepEqual(read.values, ['one', null, 'three']);
  assert.ok(!JSON.stringify(read).includes('test-secret'));
});
test('cache rejects other pages, credentials keys, stale config and malformed patches', async () => {
  const app = await setup();
  for (const p of [
    { guid: 'OTHER' }, { configTag: 'stale' }, { total: 7000 },
    { entries: [{ index: 3, text: 'bad' }] }, { entries: [{ index: 0, text: '' }] },
    { entries: [{ index: 0, text: 'one' }, { index: 0, text: 'two' }] },
  ]) {
    assert.equal((await app.progress('save', { entries: [{ index: 0, text: 'ok' }], ...p })).ok, false);
  }
  assert.equal((await app.progress('get', {}, { ...app.content, frameId: 1 })).error, 'SENDER_NOT_ALLOWED');
  const secret = await app.progress('get', { key: 'mtApiKey' });
  assert.equal(secret.values, null);
  assert.equal(app.local.mtApiKey, 'test-secret-only');
});
test('expired entries are not restored; clear deletes progress without touching settings', async () => {
  const app = await setup();
  await app.progress('save', { entries: [{ index: 1, text: 'two' }] });
  app.local['mtProgress:episode:key'].expires = Date.now() - 1;
  assert.equal((await app.progress('get')).values, null);
  assert.equal((await app.progress('clear')).ok, true);
  assert.equal(app.local['mtProgress:episode:key'], undefined);
  assert.equal(app.local.mtApiKey, 'test-secret-only');
});
test('cache evicts oldest entries under entry count and byte bounds', async () => {
  const app = await setup();
  for (let i = 0; i < 10; i++) {
    assert.equal((await app.progress('save', { key: `entry:${i}`, entries: [{ index: 0, text: 'ok' }] })).ok, true);
  }
  assert.equal(Object.keys(app.local).filter(k => k.startsWith('mtProgress:')).length, 8);
  assert.equal((await app.progress('get', { key: 'entry:9' })).values[0], 'ok');
});
