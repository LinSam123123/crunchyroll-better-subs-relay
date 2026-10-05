import test from 'node:test';
import assert from 'node:assert/strict';
import { context, load, config, json, background, savePayload } from './helpers.mjs';

function api() {
  const ctx = context();
  load(ctx, 'lib/relay.js'); load(ctx, 'lib/relay-stream.js');
  return ctx.CRSubFix.relayStream;
}
const items = [{ id: '0', text: 'Hello' }, { id: '3', text: 'World' }];
const translated = [{ id: '0', text: '\u4f60\u597d\n"World" {x}' }, { id: '3', text: '\u4e16\u754c' }];
const event = data => `data: ${JSON.stringify(data)}\r\n\r\n`;
const delta = content => event({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const end = event({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n';
function response(text, fragment = 7) {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(at, at += fragment));
    },
  }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}
test('SSE chat handles split UTF-8, CRLF, comments, empty chunks and JSON escaped newlines', async () => {
  const text = translated.map(i => JSON.stringify(i)).join('\n') + '\n';
  const frames = ': keepalive\r\n\r\n' + delta(text.slice(0, 12)) + delta(text.slice(12)) + end;
  const seen = [];
  let request;
  await api().translate(config, 'secret', items, 'en-US', 'zh-CN', (id, text) => seen.push([id, text]), {
    fetcher: async (url, init) => { request = { url, init }; return response(frames, 1); },
  });
  assert.deepEqual(seen, translated.map(i => [+i.id, i.text]));
  const body = JSON.parse(request.init.body);
  assert.equal(body.stream, true);
  assert.deepEqual(JSON.parse(body.messages[1].content).items.map(i => i.id), ['0', '3']);
  assert.equal(request.init.credentials, 'omit');
  assert.equal(request.init.redirect, 'error');
  assert.ok(!request.init.body.includes('secret'));
});
test('Responses uses output deltas, ignores reasoning and done text, accepts complete final JSONL without newline', async () => {
  const frames = event({ type: 'response.reasoning_text.delta', delta: 'not a subtitle' }) +
    event({ type: 'response.output_text.delta', delta: JSON.stringify(translated[0]) + '\n' }) +
    event({ type: 'response.output_text.done', text: JSON.stringify(translated[0]) }) +
    event({ type: 'response.output_text.delta', delta: JSON.stringify(translated[1]) }) +
    event({ type: 'response.completed', response: { status: 'completed' } });
  const seen = [];
  await api().translate({ ...config, protocol: 'responses' }, 'key', items, 'en-US', 'zh-CN',
    (id, text) => seen.push(id), { fetcher: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.store, false);
      assert.equal(body.stream, true);
      assert.match(body.instructions, /newline-delimited/);
      return response(frames);
    } });
  assert.deepEqual(seen, [0, 3]);
});
test('complete cues arrive before final response and unterminated lines are not published early', async () => {
  let controller;
  const output = [];
  const stream = new ReadableStream({ start(c) { controller = c; } });
  const run = api().translate(config, 'key', items, 'en-US', 'zh-CN', id => output.push(id), {
    fetcher: async () => new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }),
  });
  controller.enqueue(new TextEncoder().encode(delta(JSON.stringify(translated[0]))));
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(output, []);
  controller.enqueue(new TextEncoder().encode(delta('\n')));
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(output, [0]);
  controller.enqueue(new TextEncoder().encode(delta(JSON.stringify(translated[1]) + '\n') + end));
  // A terminal event need not wait for the relay to close its TCP connection.
  await run;
  assert.deepEqual(output, [0, 3]);
});
test('duplicate ids, invalid ids, invalid JSONL and EOF truncation remain fatal and preserve prior cues', async () => {
  for (const [bad, code] of [
    [JSON.stringify(translated[0]) + '\n', 'DUPLICATE_ITEM_ID'],
    ['{"id":"99","text":"bad"}\n', 'INVALID_ITEM_ID'],
    ['```json\n', 'STREAM_INVALID_JSONL'],
    ['{"id":"3","text":"unfinished', 'INCOMPLETE_RESPONSE'],
  ]) {
    const seen = [];
    await assert.rejects(api().translate(config, 'key', items, 'en-US', 'zh-CN', id => seen.push(id), {
      fetcher: async () => response(delta(JSON.stringify(translated[0]) + '\n') + delta(bad)),
    }), new RegExp(code));
    assert.deepEqual(seen, [0]);
  }
});
test('invalid text is quarantined; valid later cues survive and diagnostics contain no provider text', async () => {
  for (const [value, reason] of [
    [{}, 'MISSING_TEXT'],
    [{ text: null }, 'NOT_STRING'],
    [{ text: ['private provider text'] }, 'NOT_STRING'],
    [{ text: 17 }, 'NOT_STRING'],
    [{ text: ' \n\t' }, 'EMPTY_TEXT'],
    [{ text: 'private provider text'.repeat(1600) }, 'TEXT_TOO_LONG'],
  ]) {
    const seen = [], issues = [];
    const frames = delta(JSON.stringify({ id: '0', ...value }) + '\n') +
      delta(JSON.stringify(translated[1]) + '\n') + end;
    await assert.rejects(api().translate(config, 'key', items, 'en-US', 'zh-CN', id => seen.push(id), {
      onIssue: issue => issues.push(json(issue)),
      fetcher: async () => response(frames, 1024),
    }), error => {
      assert.equal(error.message, 'STREAM_ITEMS_PENDING');
      assert.deepEqual(json(error.details), { missingCount: 1, items: [{ index: 0, reason }] });
      assert.ok(!JSON.stringify(error.details).includes('private provider text'));
      return true;
    });
    assert.deepEqual(seen, [3]);
    assert.deepEqual(issues, [{ index: 0, reason, resolved: false }]);
  }
});
test('a corrected record for a previously rejected id is accepted once within the same stream', async () => {
  const seen = [], issues = [];
  const frames = delta('{"id":"0","text":null}\n') +
    delta(JSON.stringify(translated[1]) + '\n') + delta(JSON.stringify(translated[0]) + '\n') + end;
  await api().translate(config, 'key', items, 'en-US', 'zh-CN', id => seen.push(id), {
    onIssue: issue => issues.push(json(issue)), fetcher: async () => response(frames),
  });
  assert.deepEqual(seen, [3, 0]);
  assert.deepEqual(issues, [{ index: 0, reason: 'NOT_STRING', resolved: false }, { index: 0, resolved: true }]);
});
test('empty-after-sanitizing content stays pending instead of aborting later valid lines', async () => {
  const seen = [];
  const frames = delta('{"id":"0","text":"{\\\\an8}"}\n') +
    delta(JSON.stringify(translated[1]) + '\n') + end;
  await assert.rejects(api().translate(config, 'key', items, 'en-US', 'zh-CN', id => seen.push(id), {
    cleanText: text => text.replace(/\{[^}]*\}/g, ''),
    fetcher: async () => response(frames),
  }), error => {
    assert.equal(error.message, 'STREAM_ITEMS_PENDING');
    assert.deepEqual(json(error.details.items), [{ index: 0, reason: 'SANITIZED_EMPTY' }]);
    return true;
  });
  assert.deepEqual(seen, [3]);
});
test('provider errors, length limits, missing ids and non-SSE replies fail without fallback requests', async () => {
  for (const [frames, code] of [
    [event({ error: { message: 'secret provider body' } }), 'STREAM_PROVIDER_ERROR'],
    [event({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] }), 'INCOMPLETE_RESPONSE'],
    [end, 'INCOMPLETE_RESPONSE'],
  ]) {
    let calls = 0;
    await assert.rejects(api().translate(config, 'key', items, 'en-US', 'zh-CN', () => {}, {
      fetcher: async () => { calls++; return response(frames); },
    }), new RegExp(code));
    assert.equal(calls, 1);
  }
  await assert.rejects(api().translate(config, 'key', items, 'en-US', 'zh-CN', () => {}, {
    fetcher: async () => new Response('{"items":[]}', { headers: { 'Content-Type': 'application/json' } }),
  }), /STREAM_NOT_SUPPORTED/);
});
test('unresolved item diagnostics are bounded even when every item is invalid', async () => {
  const episode = Array.from({ length: 12 }, (_, i) => ({ id: String(i), text: `Source ${i}` }));
  const frames = episode.map(i => delta(JSON.stringify({ id: i.id, text: null }) + '\n')).join('') + end;
  await assert.rejects(api().translate(config, 'key', episode, 'en-US', 'zh-CN',
    () => assert.fail('Invalid items must not be accepted'), {
      fetcher: async () => response(frames),
    }), error => {
      assert.equal(error.message, 'STREAM_ITEMS_PENDING');
      assert.equal(error.details.missingCount, 12);
      assert.equal(error.details.items.length, 10);
      return true;
    });
});
test('first-text and idle deadlines stop hanging streams even if SSE comments arrive', async () => {
  for (const [prefix, code] of [
    [': ping\n\n', 'STREAM_FIRST_TIMEOUT'],
    [delta('{"id":'), 'STREAM_IDLE_TIMEOUT'],
  ]) {
    await assert.rejects(api().translate({ ...config, timeoutMs: 30 }, 'key', items, 'en-US', 'zh-CN', () => {}, {
      fetcher: async () => new Response(new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode(prefix)); },
      }), { headers: { 'Content-Type': 'text/event-stream' } }),
    }), new RegExp(code));
  }
});
test('explicit pause aborts a blocked reader without retransmitting', async () => {
  const controller = new AbortController();
  const run = api().translate(config, 'key', items, 'en-US', 'zh-CN', () => {}, {
    signal: controller.signal,
    fetcher: async () => new Response(new ReadableStream(), { headers: { 'Content-Type': 'text/event-stream' } }),
  });
  controller.abort(new Error('STREAM_PAUSED'));
  await assert.rejects(run, /STREAM_PAUSED/);
});
test('a 301-item episode bypasses batch limits without losing or repeating cues', async () => {
  const episode = Array.from({ length: 301 }, (_, i) => ({ id: String(i), text: `Subtitle ${i}` }));
  const frames = episode.map(i => delta(JSON.stringify({ id: i.id, text: `Translated ${i.id}` }) + '\n')).join('') + end;
  const seen = [];
  await api().translate({ ...config, batchSize: 15, maxChars: 500 }, 'key', episode, 'en-US', 'zh-CN',
    id => seen.push(id), { fetcher: async () => response(frames, 257) });
  assert.deepEqual(seen, Array.from({ length: 301 }, (_, i) => i));
});
test('stream limits, mode and glossary validation reject unbounded or malformed inputs', () => {
  const ctx = context(); load(ctx, 'lib/relay.js');
  const R = ctx.CRSubFix.relay;
  for (const glossary of [[], null, { A: 2 }, { A: '' }, { A: 'x'.repeat(201) }]) {
    if (glossary === null) continue;
    assert.throws(() => R.config({ ...config, glossary }), /INVALID_GLOSSARY/);
  }
  assert.throws(() => R.config({ ...config, translationMode: 'invalid' }), /INVALID_MODE/);
  assert.equal(R.config({ ...config, provider: 'deepl', translationMode: 'episode-stream' }).translationMode, 'batch');
  assert.deepEqual(json(R.config({ ...config, glossary: { Roxy: '\u6d1b\u742a\u5e0c' } }).glossary), { Roxy: '\u6d1b\u742a\u5e0c' });
  assert.throws(() => api().validate(Array(6001).fill(items[0])), /STREAM_INPUT_TOO_LARGE/);
  assert.throws(() => api().validate(Array.from({ length: 5 }, (_, n) => ({ id: String(n), text: 'x'.repeat(25000) }))), /STREAM_INPUT_TOO_LARGE/);
});

async function waitUntil(fn) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error('test timed out');
}
async function setup(fetcher) {
  const app = background({ fetcher });
  await app.send('MT_SAVE_CONFIG', savePayload({ config: { ...config, translationMode: 'episode-stream' } }));
  const cache = { key: 'episode:stream', guid: 'ABC', configTag: app.local.mtConfigTag, total: 4 };
  const payload = { items, source: 'en-US', target: 'zh-CN', provider: 'relay',
    configTag: app.local.mtConfigTag, requestId: 'stream-1', cache };
  return { app, payload };
}
test('trusted worker saves each streamed cue before delivery; no key or provider body crosses port', async () => {
  const { app, payload } = await setup(async () => response(translated.map(i => delta(JSON.stringify(i) + '\n')).join('') + end));
  const port = app.connect();
  port.post({ type: 'start', payload });
  await waitUntil(() => port.messages.some(m => m.type === 'done'));
  assert.equal(port.messages.at(-1).ok, true);
  assert.equal(port.messages.filter(m => m.type === 'item').length, 2);
  assert.equal(app.local['mtProgress:episode:stream'].values[0], '\u4f60\u597d\n"World" ');
  assert.ok(!JSON.stringify(port.messages).includes('test-secret'));
});
test('partial stream failure preserves durable cues and does not retry; new request can contain only missing ids', async () => {
  let requests = 0;
  const { app, payload } = await setup(async (_url, init) => {
    requests++;
    const inputs = JSON.parse(JSON.parse(init.body).messages[1].content).items;
    if (requests === 1) return response(delta(JSON.stringify(translated[0]) + '\n'));
    assert.deepEqual(inputs.map(i => i.id), ['3']);
    return response(delta(JSON.stringify(translated[1]) + '\n') + end);
  });
  const first = app.connect(); first.post({ type: 'start', payload });
  await waitUntil(() => first.messages.some(m => m.type === 'done'));
  assert.equal(first.messages.at(-1).error, 'INCOMPLETE_RESPONSE');
  assert.equal(requests, 1);
  const second = app.connect();
  second.post({ type: 'start', payload: { ...payload, items: [items[1]], requestId: 'stream-2' } });
  await waitUntil(() => second.messages.some(m => m.type === 'done'));
  assert.equal(second.messages.at(-1).ok, true, JSON.stringify(second.messages));
  assert.equal(app.local['mtProgress:episode:stream'].values[3], '\u4e16\u754c');
});
test('446-item worker stream with invalid item 64 saves other 445 and retries just the hole', async () => {
  let requests = 0;
  const episode = Array.from({ length: 446 }, (_, i) => ({ id: String(i), text: `Source ${i}` }));
  const { app, payload } = await setup(async (_url, init) => {
    requests++;
    const input = JSON.parse(JSON.parse(init.body).messages[1].content).items;
    if (requests === 2) assert.deepEqual(input.map(i => i.id), ['63']);
    return response(input.map(i => delta(JSON.stringify({
      id: i.id, text: requests === 1 && i.id === '63' ? '' : `Translated ${i.id}`,
    }) + '\n')).join('') + end, 4096);
  });
  const request = { ...payload, items: episode, cache: { ...payload.cache, total: 446 } };
  const port = app.connect();
  port.post({ type: 'start', payload: request });
  await waitUntil(() => port.messages.some(m => m.type === 'done'));
  assert.equal(requests, 1);
  assert.equal(port.messages.at(-1).error, 'STREAM_ITEMS_PENDING');
  assert.deepEqual(port.messages.at(-1).details, { missingCount: 1, items: [{ index: 63, reason: 'EMPTY_TEXT' }] });
  assert.equal(port.messages.filter(m => m.type === 'item').length, 445);
  const values = app.local['mtProgress:episode:stream'].values;
  assert.equal(values[63], null);
  assert.equal(values[445], 'Translated 445');
  const retry = app.connect();
  retry.post({ type: 'start', payload: { ...request, requestId: 'repair-1', items: [episode[63]] } });
  await waitUntil(() => retry.messages.some(m => m.type === 'done'));
  assert.equal(retry.messages.at(-1).ok, true);
  assert.equal(app.local['mtProgress:episode:stream'].values[63], 'Translated 63');
  assert.equal(requests, 2);
});
test('worker quarantines formatting-only text and persists neither blank text nor an original fallback', async () => {
  const frames = delta('{"id":"0","text":"{\\\\an8}"}\n') + delta(JSON.stringify(translated[1]) + '\n') + end;
  const { app, payload } = await setup(async () => response(frames));
  const port = app.connect();
  port.post({ type: 'start', payload });
  await waitUntil(() => port.messages.some(m => m.type === 'done'));
  assert.equal(port.messages.at(-1).error, 'STREAM_ITEMS_PENDING');
  assert.equal(port.messages.at(-1).details.items[0].reason, 'SANITIZED_EMPTY');
  assert.equal(app.local['mtProgress:episode:stream'].values[0], null);
  assert.equal(port.messages.filter(m => m.type === 'item').length, 1);
});
test('storage failure after an invalid item remains fatal and cannot be reported as a successful cue', async () => {
  const frames = delta('{"id":"0","text":null}\n') +
    delta(JSON.stringify(translated[1]) + '\n') + end;
  const { app, payload } = await setup(async () => response(frames));
  const originalSet = app.ctx.chrome.storage.local.set;
  app.ctx.chrome.storage.local.set = async value => {
    if (Object.keys(value).some(k => k.startsWith('mtProgress:'))) throw new Error('private storage details');
    return originalSet(value);
  };
  const port = app.connect();
  port.post({ type: 'start', payload });
  await waitUntil(() => port.messages.some(m => m.type === 'done'));
  assert.equal(port.messages.at(-1).error, 'CACHE_SAVE_FAILED');
  assert.equal(port.messages.at(-1).details.missingCount, 2);
  assert.equal(port.messages.filter(m => m.type === 'item').length, 0);
  assert.ok(!JSON.stringify(port.messages).includes('private storage details'));
});
test('stream ports reject wrong pages and episode cache before contacting a provider', async () => {
  let calls = 0;
  const { app, payload } = await setup(async () => { calls++; return response(end); });
  assert.equal(app.connect(app.popup).closed, true);
  assert.equal(app.connect({ ...app.content, frameId: 1 }).closed, true);
  assert.equal(app.connect({ ...app.content, url: 'https://www.crunchyroll.com/other/watch/ABC' }).closed, true);
  const port = app.connect();
  port.post({ type: 'start', payload: { ...payload, cache: { ...payload.cache, guid: 'other' } } });
  await waitUntil(() => port.messages.some(m => m.type === 'done'));
  assert.equal(port.messages.at(-1).error, 'INVALID_CACHE_REQUEST');
  assert.equal(calls, 0);
});
test('mode changes retain cache identity, glossary changes invalidate it, and secrets stay private', async () => {
  const { app } = await setup(async () => response(end));
  const tag = app.local.mtConfigTag;
  const old = { ...app.local.relayConfig, translationMode: 'batch' };
  await app.send('MT_SAVE_CONFIG', savePayload({ config: old, apiKey: '' }));
  assert.equal(app.local.mtConfigTag, tag);
  await app.send('MT_SAVE_CONFIG', savePayload({ config: { ...old, glossary: { Name: 'Term' } }, apiKey: '' }));
  assert.notEqual(app.local.mtConfigTag, tag);
  const pub = await app.send('PUBLIC_SETTINGS', null, app.content);
  assert.equal(pub.settings.mtTranslationMode, 'batch');
  assert.ok(!JSON.stringify(pub).includes('Term'));
  assert.equal((await app.send('SET_PUBLIC_SETTING', { key: 'mtTranslationMode', value: 'episode-stream' }, app.content)).error, 'SETTING_NOT_ALLOWED');
});
