import test from 'node:test';
import assert from 'node:assert/strict';
import { loadEngine } from '../tools/live-quality-test.mjs';
import { requestFor, rawCollector, runDirectRelay, runDirectDeepL } from '../tools/translation-ablation.mjs';
import { installLiveFetch } from '../tools/live-browser-test.mjs';

const rows = [{ index: '19', source_text: 'Hello.' }, { index: '30', source_text: 'Goodbye.' }];
const cfg = { provider: 'relay', protocol: 'chat-completions', model: 'test',
  glossary: { Yuki: '有希' }, workContext: { title: 'Example' } };
test('ablation keeps stable IDs and output contract while independently varying reference and dialogue constraints', async () => {
  const engine = await loadEngine();
  const requests = ['minimal', 'reference', 'full'].map(variant => requestFor({ engine, cfg, rows, variant }));
  const inputs = requests.map(request => JSON.parse(request.messages[1].content));
  assert.deepEqual(inputs[0].items, inputs[1].items);
  assert.equal(inputs[0].glossary, undefined);
  assert.deepEqual(inputs[1].glossary, cfg.glossary);
  assert.deepEqual(inputs[1].work_context, cfg.workContext);
  assert.equal(requests[0].messages[0].content, requests[1].messages[0].content);
  assert.ok(!requests[0].messages[0].content.includes('name_hints'));
  assert.ok(requests[2].messages[0].content.includes('name_hints'));
  assert.deepEqual(JSON.parse(JSON.stringify(requests[2])), JSON.parse(JSON.stringify(engine.relayStream.body(cfg,
    rows.map(row => ({ id: String(Number(row.index) - 1), text: row.source_text })), 'en-US', 'zh-CN'))));
});
const frame = value => `data: ${JSON.stringify(value)}\r\n\r\n`;
const sse = frame({ choices: [{ delta: { content: '{"id":"18","text":"你好。"}\n' } }] }) +
  frame({ choices: [{ delta: { content: '{"id":"29","text":"再见。"}' }, finish_reason: 'stop' }],
    usage: { total_tokens: 10 }, model: 'test' }) + 'data: [DONE]\r\n\r\n';
test('independent raw collector tolerates arbitrary SSE chunk boundaries and keeps raw translations', () => {
  const collector = rawCollector(rows);
  for (const char of sse) collector.push(char);
  assert.deepEqual(collector.finish().outputs, { 19: '你好。', 30: '再见。' });
});
test('direct relay stores key-free request and output and never automatically retries malformed output', async () => {
  const engine = await loadEngine();
  let calls = 0;
  const result = await runDirectRelay({ name: 'offline', body: requestFor({ engine, cfg, rows, variant: 'minimal' }),
    rows, key: 'test-private-secret', baseUrl: 'https://example.test/v1',
    fetcher: async () => { calls++; return new Response(sse, { headers: { 'content-type': 'text/event-stream' } }); } });
  assert.equal(result.status, 'completed'); assert.equal(calls, 1);
  assert.ok(!JSON.stringify(result).includes('test-private-secret'));
  const bad = rawCollector(rows);
  assert.throws(() => bad.push(frame({ choices: [{ delta: {
    content: '{"id":"18","text":"你好。"}\n{"id":"18","text":"重复"}\n',
  } }] })), /RAW_INVALID_ID/);
});
test('direct DeepL preserves matching batch partitions without exposing credentials', async () => {
  let calls = 0;
  const result = await runDirectDeepL({ name: 'offline-deepl', rows, batches: rows.map(row => [row]),
    key: 'test-private-secret', host: 'https://example.test',
    fetcher: async (_url, init) => {
      const params = new URLSearchParams(init.body);
      assert.equal(params.get('source_lang'), 'EN'); assert.equal(params.get('target_lang'), 'ZH-HANS');
      calls++; return Response.json({ translations: [{ text: calls === 1 ? '你好。' : '再见。' }] });
    } });
  assert.equal(result.status, 'completed'); assert.equal(calls, 2);
  assert.deepEqual(result.outputs, { 19: '你好。', 30: '再见。' });
  assert.ok(!JSON.stringify(result).includes('test-private-secret'));
});
test('raw browser observation survives the engine abort after a terminal SSE frame', async () => {
  const controller = new AbortController();
  const bytes = new TextEncoder().encode(sse);
  const scope = { fetch: async (_url, init) => new Response(new ReadableStream({
    start(stream) {
      stream.enqueue(bytes);
      init.signal.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')));
    },
  }), { headers: { 'content-type': 'text/event-stream' } }) };
  installLiveFetch({ base: 'https://example.test/v1', credential: 'test-private-secret',
    provider: 'relay', captureRaw: true }, scope);
  const response = await scope.fetch('https://example.test/v1/chat/completions', {
    signal: controller.signal, body: JSON.stringify({ model: 'test', stream: true,
      messages: [{ content: 'Instructions' }, { content: '{"items":[]}' }] }),
  });
  const reader = response.body.getReader();
  assert.deepEqual((await reader.read()).value, bytes);
  controller.abort();
  await reader.cancel().catch(() => {});
  await Promise.all(scope.liveCaptures);
  assert.equal(scope.liveResponses[0], sse);
  assert.ok(!JSON.stringify(scope.liveRequests).includes('test-private-secret'));
});
test('direct DeepL records safe certificate failure codes without printing provider errors or secrets', async () => {
  const result = await runDirectDeepL({ name: 'offline-certificate', rows, batches: [rows],
    key: 'test-private-secret', host: 'https://example.test', fetcher: async () => {
      throw new TypeError('test-private-secret', { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } });
    } });
  assert.equal(result.status, 'failed');
  assert.equal(result.causeCode, 'SELF_SIGNED_CERT_IN_CHAIN');
  assert.ok(!JSON.stringify(result).includes('test-private-secret'));
});
