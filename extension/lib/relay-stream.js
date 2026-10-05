(function () {
  'use strict';
  const NS = self.CRSubFix;
  const fail = code => { throw new Error(code); };
  const MAX_TOTAL_MS = 15 * 60 * 1000;
  function validate(items) {
    if (!Array.isArray(items) || !items.length || items.length > 6000) fail('STREAM_INPUT_TOO_LARGE');
    const ids = new Set();
    let chars = 0;
    for (const item of items) {
      if (!item || typeof item.id !== 'string' || !/^(0|[1-9]\d{0,3})$/.test(item.id) ||
          +item.id >= 6000 || ids.has(item.id)) fail('INVALID_ITEM_ID');
      if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > 30000) fail('INVALID_ITEM_TEXT');
      chars += item.text.length;
      ids.add(item.id);
    }
    if (chars > 100000) fail('STREAM_INPUT_TOO_LARGE');
    return ids;
  }
  function body(cfg, items, source, target) {
    const request = NS.relay.body(cfg, [], source, target);
    const instructions = NS.relay.DIALOGUE_RULES + NS.relay.targetRules(target) +
      ' Use the supplied glossary consistently. Input items belong to one episode; read them together for context. ' +
      'Output only newline-delimited JSON (JSONL), one compact object per line: {"id":"input id","text":"translation"}. ' +
      'Escape newlines within text as \\n. No markdown, arrays, wrappers, or commentary. ' +
      'Return each requested id exactly once, in the supplied order. Never output context or invent missing ids. ' +
      'Every text must be a nonempty string. Translate repeated captions independently; never replace them with null or an empty string. ' +
      'Keep symbols or names unchanged when no translation is needed; do not output formatting tags alone.';
    const input = JSON.stringify({ source_language: NS.relay.LANGUAGES[source] || source,
      target_language: NS.relay.LANGUAGES[target] || target, glossary: cfg.glossary || {},
      ...(cfg.workContext ? { work_context: cfg.workContext } : {}), items: NS.relay.annotate(cfg, items) });
    if (cfg.protocol === 'responses') { request.instructions = instructions; request.input = input; }
    else request.messages = [{ role: 'system', content: instructions }, { role: 'user', content: input }];
    request.stream = true;
    return request;
  }
  async function translate(cfg, key, items, source, target, onItem, options = {}) {
    const expected = validate(items);
    if (cfg.provider !== 'relay') fail('STREAM_RELAY_ONLY');
    if (!NS.relay.LANGUAGES[target]) fail('INVALID_TARGET');
    const controller = new AbortController();
    const abort = code => { if (!controller.signal.aborted) controller.abort(new Error(code)); };
    const externalAbort = () => abort(options.signal?.reason?.message || 'STREAM_CANCELLED');
    options.signal?.addEventListener('abort', externalAbort, { once: true });
    if (options.signal?.aborted) externalAbort();
    let first = true, idleTimer, reader;
    const idle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => abort(first ? 'STREAM_FIRST_TIMEOUT' : 'STREAM_IDLE_TIMEOUT'), cfg.timeoutMs);
    };
    const totalTimer = setTimeout(() => abort('STREAM_TOTAL_TIMEOUT'), MAX_TOTAL_MS);
    let rejectAborted;
    const aborted = new Promise((_, reject) => { rejectAborted = reject; });
    aborted.catch(() => {});
    const onAbort = () => rejectAborted(controller.signal.reason);
    controller.signal.addEventListener('abort', onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
    idle();
    let pending = '', line = '', eventData = [], bytes = 0, terminal = false;
    const seen = new Set(), rejected = new Map();
    const details = () => ({
      missingCount: expected.size - seen.size,
      items: [...rejected].slice(0, 10).map(([id, reason]) => ({ index: Number(id), reason })),
    });
    function rejectItem(id, reason) {
      if (rejected.get(id) === reason) return;
      rejected.set(id, reason);
      options.onIssue?.({ index: Number(id), reason, resolved: false });
    }
    async function acceptLine(value) {
      if (!value.trim()) return;
      let item;
      try { item = JSON.parse(value); } catch (_) { fail('STREAM_INVALID_JSONL'); }
      if (!item || typeof item.id !== 'string' || !expected.has(item.id)) fail('INVALID_ITEM_ID');
      if (seen.has(item.id)) fail('DUPLICATE_ITEM_ID');
      let reason;
      if (!Object.prototype.hasOwnProperty.call(item, 'text')) reason = 'MISSING_TEXT';
      else if (typeof item.text !== 'string') reason = 'NOT_STRING';
      else if (!item.text.trim()) reason = 'EMPTY_TEXT';
      else if (item.text.length > 30000) reason = 'TEXT_TOO_LONG';
      if (reason) { rejectItem(item.id, reason); return; }
      const text = options.cleanText ? options.cleanText(item.text) : item.text;
      if (typeof text !== 'string' || !text.trim()) { rejectItem(item.id, 'SANITIZED_EMPTY'); return; }
      await onItem(Number(item.id), text);
      seen.add(item.id);
      if (rejected.delete(item.id)) options.onIssue?.({ index: Number(item.id), resolved: true });
    }
    async function textDelta(text) {
      if (!text) return;
      if (terminal || typeof text !== 'string') fail('INVALID_RESPONSE');
      first = false; idle();
      pending += text;
      let cut;
      while ((cut = pending.indexOf('\n')) >= 0) {
        const value = pending.slice(0, cut);
        pending = pending.slice(cut + 1);
        await acceptLine(value);
      }
      if (pending.length > 150000) fail('INVALID_RESPONSE');
    }
    async function event() {
      if (!eventData.length) return;
      const data = eventData.join('\n');
      eventData = [];
      if (data === '[DONE]') {
        if (cfg.protocol === 'chat-completions') {
          if (!terminal) fail('INCOMPLETE_RESPONSE');
          return;
        }
        return;
      }
      let payload;
      try { payload = JSON.parse(data); } catch (_) { fail('INVALID_RESPONSE'); }
      if (payload.error || payload.type === 'error' || payload.type === 'response.failed') fail('STREAM_PROVIDER_ERROR');
      if (cfg.protocol === 'responses') {
        if (payload.type === 'response.output_text.delta') await textDelta(payload.delta);
        else if (payload.type === 'response.refusal.delta') fail('INVALID_RESPONSE');
        else if (payload.type === 'response.incomplete') fail('INCOMPLETE_RESPONSE');
        else if (payload.type === 'response.completed') {
          if (payload.response?.status && payload.response.status !== 'completed') fail('INCOMPLETE_RESPONSE');
          await acceptLine(pending); pending = ''; terminal = true;
        }
      } else {
        const choice = payload.choices?.find(c => c.index === 0) ?? payload.choices?.[0];
        if (choice?.delta?.refusal) fail('INVALID_RESPONSE');
        await textDelta(choice?.delta?.content);
        if (choice?.finish_reason) {
          if (choice.finish_reason !== 'stop') fail('INCOMPLETE_RESPONSE');
          await acceptLine(pending); pending = ''; terminal = true;
        }
      }
    }
    async function sseLine(value) {
      if (!value) await event();
      else if (value.startsWith('data:')) eventData.push(value.slice(5).replace(/^ /, ''));
      if (eventData.reduce((n, s) => n + s.length, 0) > 1000000) fail('INVALID_RESPONSE');
    }
    try {
      const response = await Promise.race([(options.fetcher || fetch)(
        cfg.baseUrl + (cfg.protocol === 'responses' ? '/responses' : '/chat/completions'), {
          method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify(body(cfg, items, source, target)), credentials: 'omit', redirect: 'error', signal: controller.signal,
        }), aborted]);
      if (!response.ok) fail(`HTTP_${response.status}`);
      if (!response.headers?.get('content-type')?.toLowerCase().includes('text/event-stream') || !response.body) {
        fail('STREAM_NOT_SUPPORTED');
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let skipLF = false;
      async function consume(text) {
        for (const char of text) {
          if (skipLF) { skipLF = false; if (char === '\n') continue; }
          if (char === '\r' || char === '\n') {
            await sseLine(line); line = ''; skipLF = char === '\r';
          } else {
            line += char;
            if (line.length > 1000000) fail('INVALID_RESPONSE');
          }
        }
      }
      while (true) {
        const chunk = await Promise.race([reader.read(), aborted]);
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 8 * 1024 * 1024) fail('INVALID_RESPONSE');
        await consume(decoder.decode(chunk.value, { stream: true }));
        if (terminal) break;
      }
      if (!terminal) {
        await consume(decoder.decode());
        if (line) await sseLine(line);
        await event();
      }
      if (!terminal || pending.trim()) fail('INCOMPLETE_RESPONSE');
      if (seen.size !== expected.size) fail(rejected.size ? 'STREAM_ITEMS_PENDING' : 'INCOMPLETE_RESPONSE');
      return { count: seen.size };
    } catch (error) {
      const failure = controller.signal.aborted ? controller.signal.reason : error;
      failure.details = details();
      throw failure;
    } finally {
      clearTimeout(idleTimer); clearTimeout(totalTimer);
      options.signal?.removeEventListener('abort', externalAbort);
      controller.signal.removeEventListener('abort', onAbort);
      controller.abort();
      reader?.cancel().catch(() => {});
    }
  }
  NS.relayStream = { validate, body, translate };
})();
