import test from 'node:test';
import assert from 'node:assert/strict';
import { relayContext, json } from './helpers.mjs';

const U = relayContext().CRSubFix.mtUtils;
const tick = () => new Promise(r => setImmediate(r));

test('two requests overlap; explicit rate limit drains group then retries sequentially with backoff', async () => {
  const releases = [], reports = [], delays = [], accepted = [];
  let active = 0, maximum = 0, downgraded = false;
  const run = U.runBatches([[0], [1], [2], [3]], {
    concurrency: 2, retries: 2, rateWait: 20, stopped: () => false,
    sleep: async ms => { delays.push(ms); },
    send: async (indices, id, attempt) => {
      active++;
      maximum = Math.max(maximum, active);
      if (downgraded) assert.equal(active, 1);
      if (id < 2 && !attempt) await new Promise(r => releases.push(r));
      active--;
      if (id === 0 && attempt < 2) return { ok: false, error: 'HTTP_429' };
      return { ok: true, translations: indices.map(String) };
    },
    accept: (indices, translations) => accepted.push([json(indices), json(translations)]),
    report: m => { reports.push(m); },
  });
  while (releases.length < 2) await tick();
  assert.equal(maximum, 2);
  releases[0]();
  await tick();
  assert.equal(reports.length, 1);
  downgraded = true;
  releases[1]();
  const result = await run;
  assert.equal(result.error, null);
  assert.equal(result.concurrency, 1);
  assert.deepEqual(delays, [20, 40]);
  assert.equal(accepted.length, 4);
  assert.equal(reports.length, 6);
});

test('fatal failure stops queued batches, preserves in-flight successes, never retries unknown outcome', async () => {
  const sent = [], accepted = [];
  const result = await U.runBatches([[0], [1], [2]], {
    concurrency: 2, stopped: () => false, sleep: async () => {},
    send: async (indices, id) => {
      sent.push(id);
      return id === 0 ? { ok: false, error: 'TIMEOUT_UNKNOWN' } : { ok: true, translations: ['ok'] };
    },
    accept: indices => accepted.push(...indices),
  });
  assert.equal(result.error, 'TIMEOUT_UNKNOWN');
  assert.deepEqual(sent, [0, 1]);
  assert.deepEqual(accepted, [1]);
});

test('cancellation discards both in-flight results and stops pending dispatch', async () => {
  let stopped = false;
  const releases = [], accepted = [];
  const run = U.runBatches([[0], [1], [2]], {
    concurrency: 2, stopped: () => stopped, sleep: async () => {},
    send: () => new Promise(r => releases.push(r)),
    accept: indices => accepted.push(...indices),
  });
  while (releases.length < 2) await tick();
  stopped = true;
  releases.forEach(r => r({ ok: true, translations: ['ok'] }));
  await run;
  assert.equal(releases.length, 2);
  assert.deepEqual(accepted, []);
});

test('bounded retries stop permanent rate limits', async () => {
  let calls = 0;
  const result = await U.runBatches([[0]], {
    concurrency: 2, retries: 2, stopped: () => false, sleep: async () => {},
    send: async () => { calls++; return { ok: false, error: 'HTTP_429' }; }, accept() {},
  });
  assert.equal(result.error, 'HTTP_429');
  assert.equal(calls, 3);
});

test('response errors distinguish count, duplicate ids, invalid ids and invalid text', () => {
  const R = relayContext().CRSubFix.relay;
  for (const [items, code] of [
    [[{ id: '0', text: 'ok' }], 'ITEM_COUNT_MISMATCH'],
    [[{ id: '0', text: 'ok' }, { id: '0', text: 'ok' }], 'DUPLICATE_ITEM_ID'],
    [[{ id: '0', text: 'ok' }, { id: '9', text: 'ok' }], 'INVALID_ITEM_ID'],
    [[{ id: '0', text: 'ok' }, { id: '1', text: '' }], 'INVALID_ITEM_TEXT'],
  ]) {
    assert.throws(() => R.parse(JSON.stringify({ items }), 2), new RegExp(code));
    assert.equal(U.splittable(code), true);
  }
  assert.equal(U.splittable('TIMEOUT_UNKNOWN'), false);
  assert.equal(U.splittable('HTTP_401'), false);
});
test('coverage stops at the first untranslated cue, including overlapping cues', () => {
  const cues = [{ start: 0, end: 10 }, { start: 5, end: 7 }, { start: 15, end: 20 }];
  assert.equal(U.coverage(cues, ['one', null, 'three'], 0), 5);
  assert.equal(U.coverage(cues, ['one', null, 'three'], 6), 6);
  assert.equal(U.coverage(cues, ['one', 'two', 'three'], 0), 20);
  assert.equal(U.priority([2], cues, 15), 0);
  assert.ok(U.priority([0], cues, 15) > U.priority([2], cues, 15));
});
