import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function loadEngine() {
  const ctx = vm.createContext({ self: {}, URL, URLSearchParams, AbortSignal, AbortController,
    TextEncoder, TextDecoder, setTimeout, clearTimeout, fetch, crypto: globalThis.crypto });
  for (const name of ['relay', 'relay-stream', 'translation-review']) {
    const file = new URL(`../extension/lib/${name}.js`, import.meta.url);
    vm.runInContext(await readFile(file, 'utf8'), ctx, { filename: fileURLToPath(file) });
  }
  return ctx.self.CRSubFix;
}

// Credentials are supplied in memory. Only allowlisted translation data is returned.
export async function runLiveStream({ engine, name, cfg, key, rows, source = 'en-US', onProgress = () => {}, fetcher = fetch }) {
  if (!key || !rows.length || rows.length > 150) throw new Error('INVALID_LIVE_TEST');
  const started = Date.now();
  const result = { name, model: cfg.model, source, count: rows.length, received: 0,
    status: 'running', outputs: {}, firstMs: null, elapsedMs: null, usage: null, trace: null };
  let eventText = '', providerText = '';
  const capture = value => {
    eventText += value;
    let cut;
    while ((cut = eventText.indexOf('\n')) >= 0) {
      const line = eventText.slice(0, cut).trim(); eventText = eventText.slice(cut + 1);
      if (!line.startsWith('data:')) continue;
      try {
        const frame = JSON.parse(line.slice(5).trim());
        const delta = frame.delta || frame.choices?.[0]?.delta?.content || '';
        if (typeof delta === 'string') providerText = (providerText + delta).slice(-100000);
        if (frame.usage) result.usage = frame.usage;
        else if (frame.response?.usage) result.usage = frame.response.usage;
        if (typeof frame.model === 'string') result.responseModel = frame.model.slice(0, 200);
      } catch { /* SSE terminators and optional metadata are not translation records. */ }
    }
    if (eventText.length > 1000000) eventText = '';
  };
  try {
    await engine.relayStream.translate(cfg, key,
      rows.map(row => ({ id: String(Number(row.index) - 1), text: row.source_text })), source, 'zh-CN',
      (index, text) => {
        result.firstMs ??= Date.now() - started;
        result.outputs[index + 1] = text; result.received++;
        onProgress({ received: result.received, count: result.count });
      }, {
        fetcher: async (url, init) => {
          const body = JSON.parse(init.body);
          result.trace = { model: body.model, stream: body.stream,
            input: JSON.parse(body.input || body.messages[1].content),
            instructions: body.instructions || body.messages[0].content };
          const response = await fetcher(url, init);
          result.http = response.status;
          if (!response.ok || !response.body) return response;
          const decoder = new TextDecoder();
          return { ok: response.ok, status: response.status, headers: response.headers, body: {
            getReader() {
              const reader = response.body.getReader();
              return {
                async read() {
                  const chunk = await reader.read();
                  capture(chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true }));
                  return chunk;
                },
                cancel: () => reader.cancel(),
              };
            },
          } };
        },
      });
    result.status = 'completed';
  } catch (e) {
    result.status = 'failed';
    result.error = /^[A-Z][A-Z0-9_]*$/.test(e.message) ? e.message : 'NETWORK_ERROR';
    result.errorType = e.name;
    result.failureReason = String(e?.message || e).replace(/sk-[a-zA-Z0-9]+/g, '[redacted]').slice(0, 200);
    result.missingCount = e.details?.missingCount;
    result.items = e.details?.items;
    result.failureTail = providerText.slice(-1000);
  }
  result.elapsedMs = Date.now() - started;
  return result;
}
