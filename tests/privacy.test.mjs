import test from 'node:test';
import assert from 'node:assert/strict';
import { allowed, inspect } from '../tools/privacy-scan.mjs';

test('publication allowlist rejects private inputs, history and reports', () => {
  for (const filename of ['reports/result.md', '.env', 'tools/key.txt', 'tests/subtitle.csv', 'extension/file.srt', 'extension/_metadata/a', 'extension/.git/config'])
    assert.equal(allowed(filename), false, filename);
  for (const filename of ['README.ja.md', 'extension/background.js', 'tests/relay.test.mjs', '.github/workflows/ci.yml'])
    assert.equal(allowed(filename), true, filename);
});
test('secret scanner returns categories only and scans exact secrets in binary', () => {
  const key = ['s', 'k', '-'].join('') + 'X'.repeat(32);
  assert.deepEqual(inspect(Buffer.from(key)), ['relay-key']);
  const token = ['gh', 'p_'].join('') + 'Y'.repeat(40);
  assert.deepEqual(inspect(Buffer.from(token)), ['github-token']);
  const secret = Buffer.from([0, 1, 2, 3]);
  assert.deepEqual(inspect(Buffer.concat([Buffer.from('binary'), secret]), [secret]), ['known-secret']);
  assert.deepEqual(inspect(Buffer.from('https://relay.example/v1')), []);
});
