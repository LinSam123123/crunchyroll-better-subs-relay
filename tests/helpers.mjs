import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

export const source = p => readFileSync(new URL(`../extension/${p}`, import.meta.url), 'utf8');
export function context(extra = {}) {
  const ctx = vm.createContext({ URL, URLSearchParams, AbortSignal, AbortController, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, crypto: webcrypto, console, ...extra });
  ctx.self = ctx;
  return ctx;
}
export function load(ctx, p) { vm.runInContext(source(p), ctx, { filename: p }); }
export function relayContext() {
  const ctx = context();
  load(ctx, 'lib/relay.js'); load(ctx, 'lib/mt-utils.js'); load(ctx, 'lib/translation-review.js');
  return ctx;
}
export function json(value) { return JSON.parse(JSON.stringify(value)); }
export function background({ data = {}, fetcher, secure = true, allowed = true } = {}) {
  const listeners = [], connections = [];
  const local = { ...data }, session = {}, calls = [], accesses = [];
  let allowedValue = allowed;
  const event = () => ({ addListener() {} });
  function storage(values, name) {
    return {
      setAccessLevel: secure ? async value => { accesses.push([name, value]); } : undefined,
      async get(keys) {
        calls.push(`read:${name}`);
        if (keys === null) return { ...values };
        if (typeof keys === 'string') return { [keys]: values[keys] };
        if (Array.isArray(keys)) return Object.fromEntries(keys.map(k => [k, values[k]]));
        return { ...keys, ...Object.fromEntries(Object.keys(keys).filter(k => k in values).map(k => [k, values[k]])) };
      },
      async set(value) { Object.assign(values, structuredClone(value)); },
      async remove(key) { delete values[key]; },
    };
  }
  const ctx = context({
    setInterval, clearInterval,
    fetch: async (...args) => {
      calls.push(['fetch', ...args]);
      return fetcher ? fetcher(...args) : { ok: true, text: async () => JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: '{"items":[{"id":"0","text":"你好"}]}' } }],
      }) };
    },
    chrome: {
      runtime: { id: 'test-extension', getPlatformInfo: async () => ({}), getURL: p => `chrome-extension://test-extension/${p}`,
        onMessage: { addListener: f => listeners.push(f) }, onConnect: { addListener: f => connections.push(f) } },
      storage: { local: storage(local, 'local'), session: storage(session, 'session'), onChanged: event() },
      tabs: { query: async () => [], sendMessage: async () => {}, onRemoved: event() },
      permissions: { contains: async () => allowedValue, onRemoved: event() },
      commands: { onCommand: event() },
      action: { setBadgeText: async () => {} },
    },
  });
  load(ctx, JSON.parse(source('manifest.json')).background.service_worker);
  const popup = { id: 'test-extension', url: 'chrome-extension://test-extension/translation.html' };
  const content = { id: 'test-extension', url: 'https://www.crunchyroll.com/watch/ABC/title', frameId: 0, tab: { id: 1 } };
  async function send(type, payload, sender = popup) {
    return new Promise((resolve, reject) => {
      const handled = listeners.some(fn => fn({ type, payload }, sender, v => resolve(json(v))));
      if (!handled) reject(new Error('Unhandled message'));
    });
  }
  function connect(sender = content) {
    const handlers = [], disconnects = [], messages = [];
    let closed = false;
    const port = { name: 'MT_STREAM', sender,
      onMessage: { addListener: f => handlers.push(f) }, onDisconnect: { addListener: f => disconnects.push(f) },
      postMessage: msg => messages.push(json(msg)),
      disconnect: () => { closed = true; disconnects.forEach(f => f()); },
    };
    connections.forEach(f => f(port));
    return { messages, post: msg => handlers.forEach(f => f(msg)), disconnect: port.disconnect, get closed() { return closed; } };
  }
  return { ctx, local, session, calls, accesses, send, connect, popup, content, deny: () => { allowedValue = false; } };
}
export const config = {
  provider: 'relay', baseUrl: 'https://relay.example/v1', protocol: 'chat-completions',
  model: 'test-model', timeoutMs: 25000, batchSize: 10, maxChars: 3000,
};
export const savePayload = (overrides = {}) => ({
  config: { ...config }, apiKey: 'test-secret-only', source: 'en-US', target: 'zh-CN', enabled: true, ...overrides,
});
