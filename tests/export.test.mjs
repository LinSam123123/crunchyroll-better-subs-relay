import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { context, load, source, json } from './helpers.mjs';

function exporter() {
  const ctx = context();
  load(ctx, 'lib/subtitle-export.js');
  return ctx.CRSubFix.subtitleExport;
}
const mt = { kind: 'mt', label: 'Chinese', mtSource: 'en-US', lang: 'zh-CN', incomplete: true };
const cues = [
  { start: 1.123, end: 3, text: '\u4f60\u597d\n\u4e16\u754c', srcText: 'Hello,\n"world"', translationStatus: 'translated' },
  { start: 4, end: 5, text: 'Wait!', srcText: 'Wait!', translationStatus: 'pending' },
  { start: 6, end: 7, text: 'OK', srcText: 'OK', translationStatus: 'translated' },
];

test('export pairs stored source with translation, marks pending, and keeps identical translations', () => {
  const api = exporter();
  const input = structuredClone(cues);
  const data = api.snapshot(mt, input, { episodeId: 'ep', title: 'Title', url: 'https://example.test/watch/ep' });
  assert.deepEqual(json(data.counts), { total: 3, translated: 2, pending: 1, unknown: 0, missing_source: 0 });
  assert.equal(data.rows[1].translated_text, null);
  assert.equal(data.rows[2].translated_text, 'OK');
  assert.equal(data.source_language, 'en-US');
  assert.equal(data.target_language, 'zh-CN');
  input[0].text = 'changed';
  assert.equal(data.rows[0].translated_text, cues[0].text, 'A download uses an immutable text snapshot');
  assert.equal(data.rows[0].correction, '');
  assert.equal(data.rows[0].notes, '');
});
test('JSON round-trips multiline Unicode and exact seconds with an allowlisted schema', () => {
  const api = exporter();
  const data = api.snapshot({ ...mt, apiKey: 'secret' }, cues);
  const output = api.serialize(data, 'json');
  assert.deepEqual(JSON.parse(output.text), json(data));
  assert.equal(JSON.parse(output.text).rows[0].start, 1.123);
  assert.ok(!output.text.includes('secret'));
  assert.match(output.type, /application\/json/);
});
test('CSV has UTF-8 BOM, quoted multiline fields, escaped quotes and correction columns', () => {
  const api = exporter();
  const csv = api.serialize(api.snapshot(mt, cues), 'csv').text;
  assert.ok(csv.startsWith('\uFEFF"index","start","end"'));
  assert.ok(csv.includes('"Hello,\n""world"""'));
  assert.ok(csv.includes('"\u4f60\u597d\n\u4e16\u754c"'));
  assert.ok(csv.includes('"00:00:01,123","00:00:03,000"'));
  assert.ok(csv.includes('"correction","notes"'));
  assert.ok(csv.includes('"pending","Wait!","","Wait!"'));
});
test('CSV treats formula-like cells as text, while JSON preserves the unmodified text', () => {
  const api = exporter();
  for (const text of ['=HYPERLINK("bad")', ' +1', '-1', '@SUM(A1)', '\t=1', '\r=1', '\ntext']) {
    const data = api.snapshot({ kind: 'native', label: 'Test', lang: 'en-US' }, [{ start: 0, end: 1, text }]);
    assert.ok(api.serialize(data, 'csv').text.includes('"\'' + text.replace(/"/g, '""') + '"'));
    assert.equal(JSON.parse(api.serialize(data, 'json').text).rows[0].source_text, text);
  }
});
test('SRT modes retain timing and multiline text, never export pending cues as translated', () => {
  const api = exporter();
  const data = api.snapshot(mt, cues);
  const bilingual = api.serialize(data, 'bilingual').text;
  assert.ok(bilingual.includes('\u4f60\u597d\n\u4e16\u754c\nHello,\n"world"'));
  assert.ok(bilingual.includes('2\n00:00:04,000 --> 00:00:05,000\nWait!'));
  assert.ok(!bilingual.includes('OK\nOK'));
  const target = api.serialize(data, 'target').text;
  assert.ok(!target.includes('Wait!'));
  assert.ok(target.includes('2\n00:00:06,000 --> 00:00:07,000\nOK'));
  const original = api.serialize(data, 'source').text;
  assert.ok(original.includes('Hello,\n"world"'));
  assert.ok(!original.includes('\u4f60\u597d'));
  assert.equal(api.timestamp(59.9999), '00:01:00,000');
  assert.equal(api.timestamp(-1), '00:00:00,000');
  assert.equal(api.timestamp(360001), '100:00:01,000');
});
test('legacy partial records remain unknown and missing originals are never guessed', () => {
  const api = exporter();
  const old = [{ start: 0, end: 1, text: 'possibly translated' }];
  const partial = api.snapshot(mt, old);
  assert.equal(partial.rows[0].status, 'unknown');
  assert.equal(partial.rows[0].source_text, null);
  assert.equal(partial.rows[0].translated_text, null);
  assert.equal(partial.rows[0].displayed_text, old[0].text);
  assert.equal(api.serialize(partial, 'target').text, '');
  const complete = api.snapshot({ ...mt, incomplete: false }, old);
  assert.equal(complete.rows[0].status, 'translated');
  assert.equal(complete.counts.missing_source, 1);
});
test('native tracks export original text only and file names cannot inject paths', () => {
  const api = exporter();
  const data = api.snapshot({ kind: 'native', label: '../CON:*?|"', lang: 'en-US' }, cues, { episodeId: '../ep\\1' });
  assert.equal(data.rows[0].status, 'source_only');
  assert.equal(data.rows[0].source_text, cues[0].text);
  assert.equal(data.rows[0].translated_text, null);
  assert.equal(data.target_language, '');
  assert.ok(!/[\\/:*?"<>|]/.test(api.filename(data, 'source.srt')));
  assert.throws(() => api.serialize(data, 'invalid'), /Invalid export format/);
});
test('player export uses stored pairs, applies sync and playback offset without mutating cues', () => {
  const ctx = context();
  load(ctx, 'lib/subtitle-export.js');
  const ep = { guid: 'ep', activeSource: () => 'en-US', originalCues: cues };
  let record = mt;
  Object.assign(ctx, {
    NS: ctx.CRSubFix, currentEp: () => ep, currentCustomSource: () => record,
    applyCustomSync: () => cues.map(c => ({ ...c, start: c.start + 2, end: c.end + 2 })),
    priOffset: () => 0.5, LOCALE_LABELS: {},
    document: { title: 'Episode title' },
    location: { origin: 'https://www.crunchyroll.com', pathname: '/watch/ep/name' },
  });
  const code = source('interceptor.js');
  vm.runInContext(code.slice(code.indexOf('  function exportSnapshot()'), code.indexOf('  function openExportPanel()')) +
    '\nself.snapshot = exportSnapshot;', ctx);
  assert.equal(ctx.snapshot().rows[0].start, 2.623);
  assert.equal(cues[0].start, 1.123);
  record = null;
  assert.equal(ctx.snapshot().source_language, 'en-US');
  assert.equal(ctx.snapshot().rows[0].start, 0.623);
  ep.originalCues = [];
  assert.equal(ctx.snapshot(), null);
  ep.disposed = true;
  assert.equal(ctx.snapshot(), null);
});
