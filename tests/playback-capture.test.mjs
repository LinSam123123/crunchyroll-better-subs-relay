import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { context, load, source } from './helpers.mjs';

function fixture() {
  let ep = null, path = '', time = 0;
  const calls = [];
  const c = context();
  load(c, 'lib/playback-api.js'); load(c, 'lib/playback-capture.js');
  const box = c.CRSubFix.createPlaybackCapture({ current: () => ep, watchGuid: () => path,
    apply: (...args) => calls.push(args), now: () => time });
  return { box, calls, go(guid) { if (ep) ep.disposed = true;
    path = guid; ep = guid ? { guid, catalog: { versions: () => [] } } : null; return ep; },
    tick() { time += 120001; } };
}
const data = (id, label = id) => ({ audioLocale: 'ja-JP', subtitles: { 'en-US': `https://sub.example/${label}.vtt` },
  versions: [{ audio_locale: 'ja-JP', guid: id }] });

test('home-page prefetch is delivered only when its episode becomes current, once', () => {
  const f = fixture();
  f.box.receive(f.box.begin('A', {}), data('A'));
  assert.equal(f.calls.length, 0);
  f.go('A'); f.box.drain(); f.box.drain();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0].guid, 'A');
});
test('next-episode prefetch cannot overwrite the playing episode', () => {
  const f = fixture(); f.go('A');
  f.box.receive(f.box.begin('B', {}), data('B'));
  assert.equal(f.calls.length, 0);
  f.go('B'); f.box.drain(); assert.equal(f.calls[0][2], 'B');
});
test('response after route transition is delivered to the correct new episode', () => {
  const f = fixture(); f.go('A'); const req = f.box.begin('B', {});
  f.go('B'); f.box.receive(req, data('B')); assert.equal(f.calls[0][0].guid, 'B');
});
test('late old-viewing response and consumed cache cannot affect a revisit', () => {
  const f = fixture(); f.go('A'); const old = f.box.begin('A', {});
  f.box.receive(f.box.begin('A', {}), data('A'));
  f.go('B'); f.go('A'); f.box.receive(old, data('A')); f.box.drain();
  assert.equal(f.calls.length, 1);
});
test('out-of-order response cannot replace newer subtitle URLs', () => {
  const f = fixture(); const old = f.box.begin('A', {}), fresh = f.box.begin('A', {});
  f.box.receive(fresh, data('A', 'new')); f.box.receive(old, data('A', 'old'));
  f.go('A'); f.box.drain(); assert.match(f.calls[0][1].subtitles['en-US'], /new/);
});
test('prefetch cache is bounded and expires; invalid envelopes are ignored', () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) f.box.receive(f.box.begin(String(i), {}), data(String(i)));
  f.go('0'); f.box.drain(); assert.equal(f.calls.length, 0);
  f.go('4'); f.tick(); f.box.drain(); assert.equal(f.calls.length, 0);
  f.box.receive(f.box.begin('4', {}), { error: 'unauthorized' }); assert.equal(f.calls.length, 0);
});
test('explicit audio-version aliases can attach without matching an unrelated title', () => {
  const f = fixture(); f.go('DUB');
  f.box.receive(f.box.begin('JP', {}), { ...data('JP'), versions: [{ audio_locale: 'en-US', guid: 'DUB' }] });
  assert.equal(f.calls.length, 1);
  f.box.receive(f.box.begin('OTHER', {}), data('OTHER')); assert.equal(f.calls.length, 1);
});
test('fetch auth accepts Request and header arrays without losing explicit overrides', () => {
  const c = context({ Request, Headers });
  const text = source('interceptor.js'), start = text.indexOf('  function extractAuthHeader(');
  vm.runInContext(text.slice(start, text.indexOf('  // Strip characters', start)), c);
  const request = new Request('https://www.crunchyroll.com/', { headers: { Authorization: 'fixture-token' } });
  assert.equal(c.extractAuthHeader(undefined, request).Authorization, 'fixture-token');
  assert.equal(c.extractAuthHeader({ headers: [['AUTHORIZATION', 'fixture-new']] }, request).Authorization, 'fixture-new');
  assert.equal(c.extractAuthHeader({ headers: {} }, request).Authorization, undefined);
});
