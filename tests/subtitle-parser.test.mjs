import test from 'node:test';
import assert from 'node:assert/strict';
import { context, load } from './helpers.mjs';

function parser() { const c = context(); load(c, 'lib/subtitle-parser.js'); return c.CRSubFix.parser; }
const header = '[Script Info]\nScriptType: v4.00+\n[Events]\n' +
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';

test('ASS zero-duration effects are skipped while positive short dialogue and overrides survive', () => {
  const p = parser();
  const text = header + [
    'Dialogue: 0,0:01:11.96,0:01:11.96,Default,,0,0,0,,{\\an8}zero-effect',
    'Dialogue: 0,0:01:12.00,0:01:12.01,Default,,0,0,0,,{\\an8}short-valid',
    'Dialogue: 0,0:01:13.00,0:01:16.00,Default,,0,0,0,,normal-dialogue',
  ].join('\n');
  const cues = p.parseSubtitles(text, 'test.ass');
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'short-valid');
  assert.equal(cues[0].alignment, 8);
  assert.ok(cues[0].end > cues[0].start);
  assert.equal(cues[1].text, 'normal-dialogue');
  assert.ok(text.includes('zero-effect'));
});

test('an ASS containing only zero-duration events remains non-displayable', () => {
  assert.equal(parser().parseSubtitles(header +
    'Dialogue: 0,0:00:01.00,0:00:01.00,Default,,0,0,0,,zero', 'test.ass').length, 0);
});
