import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { bundleWorker, workerEntry } from '../tools/worker-bundle.mjs';
import { background, context, load, source } from './helpers.mjs';

test('production worker is self-contained and built from the current source modules', async () => {
  const manifest = JSON.parse(source('manifest.json'));
  assert.equal(manifest.background.service_worker, 'background-worker.js');
  const built = await bundleWorker(source('background.js'), async p => source(p));
  assert.equal(source(manifest.background.service_worker), built);
  assert.doesNotMatch(built, /\bimportScripts\s*\(/);
  const bg = background();
  assert.equal(bg.ctx.importScripts, undefined);
  for (const name of ['protocol', 'settings', 'relay', 'relayStream', 'externalSubs'])
    assert.ok(bg.ctx.CRSubFix[name], name);
  assert.equal((await bg.send(bg.ctx.CRSubFix.protocol.MSG.MT_GET_CONFIG)).ok, true);
});

test('worker bundling preserves dependency order and script boundaries', async () => {
  const built = await bundleWorker('importScripts("lib/one.js", "lib/two.js");\nself.result = self.values.join(",");',
    async name => name === 'lib/one.js' ? '(function(){self.values = ["one"]})()' :
      '(function(){self.values.push("two")})()');
  const ctx = { self: {} };
  vm.runInNewContext(built, ctx);
  assert.equal(ctx.self.result, 'one,two');
});

test('worker dependencies must be unique local literal paths', () => {
  for (const paths of [[], ['https://example.com/a.js'], ['../a.js'], ['lib/../a.js'],
    ['lib/one.js', 'lib/one.js'], [1]])
    assert.throws(() => workerEntry(`importScripts(${paths.map(p => JSON.stringify(p)).join(', ')});\n`));
  assert.throws(() => workerEntry('importScripts(getPath());\n'));
  assert.throws(() => workerEntry('self.x = 1;\nimportScripts("lib/one.js");\n'));
});

test('background sender validation follows the manifest without admitting other extension pages', () => {
  const ctx = context();
  load(ctx, 'lib/protocol.js');
  const check = ctx.CRSubFix.protocol.isBackgroundSender;
  const runtime = { id: 'test-extension', getURL: p => `chrome-extension://test-extension/${p}`,
    getManifest: () => JSON.parse(source('manifest.json')) };
  assert.equal(check(runtime, { id: runtime.id, url: runtime.getURL('background-worker.js') }), true);
  for (const sender of [undefined, { id: 'foreign-extension', url: runtime.getURL('background-worker.js') },
    { id: runtime.id, url: runtime.getURL('background.js') },
    { id: runtime.id, url: runtime.getURL('translation.html') },
    { id: runtime.id, url: 'https://www.crunchyroll.com/' }])
    assert.equal(check(runtime, sender), false);
  assert.equal(check({ ...runtime, getManifest: () => ({}) }, { id: runtime.id }), false);
});
