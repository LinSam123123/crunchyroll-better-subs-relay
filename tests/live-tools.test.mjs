import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEngine, runLiveStream } from '../tools/live-quality-test.mjs';
import { config } from './helpers.mjs';

test('live quality harness captures real parser results and metadata without retaining credentials', async () => {
  const engine = await loadEngine();
  const content = '{"id":"0","text":"你好。"}\n';
  const sse = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n` +
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":42}}\n\n';
  const result = await runLiveStream({ engine, name: 'offline-harness', cfg: config, key: 'not-a-real-secret',
    rows: [{ index: '1', source_text: 'Hello.' }], fetcher: async () => new Response(sse, {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    }) });
  assert.equal(result.status, 'completed');
  assert.equal(result.outputs[1], '你好。');
  assert.equal(result.usage.total_tokens, 42);
  assert.equal(result.trace.input.source_language, 'English');
  assert.ok(!JSON.stringify(result).includes('not-a-real-secret'));
  assert.ok(!JSON.stringify(result).includes(config.baseUrl));
});
test('live harness keeps partial output and reports malformed model output without an automatic retry', async () => {
  const engine = await loadEngine();
  let calls = 0;
  const content = '{"id":"0","text":"你好。"}\nnot-json\n';
  const result = await runLiveStream({ engine, name: 'bad-record', cfg: config, key: 'not-a-real-secret',
    rows: [{ index: '1', source_text: 'Hello.' }, { index: '2', source_text: 'Goodbye.' }],
    fetcher: async () => {
      calls++;
      return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
      });
    } });
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'STREAM_INVALID_JSONL');
  assert.equal(result.received, 1);
  assert.equal(result.outputs[1], '你好。');
  assert.equal(calls, 1);
});
