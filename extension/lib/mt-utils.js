(function () {
  'use strict';
  async function fingerprint(cues, signs) {
    const bytes = new TextEncoder().encode(JSON.stringify([
      cues.map(c => [c.start, c.end, c.text]), signs || '',
    ]));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
  }
  function batches(texts, todo, count, maxChars) {
    const result = [];
    let batch = [], chars = 0;
    for (const i of todo) {
      if (texts[i].length > maxChars) throw new Error('SUBTITLE_TOO_LONG');
      if (batch.length && (batch.length >= count || chars + texts[i].length > maxChars)) {
        result.push(batch); batch = []; chars = 0;
      }
      batch.push(i); chars += texts[i].length;
    }
    if (batch.length) result.push(batch);
    return result;
  }
  // The source ASS owns formatting; translated text must not inject override tags.
  function plainText(text) {
    return text.replace(/\{[^}]*\}/g, '').replace(/[{}]/g, '')
      .replace(/\\[Nn]/g, '\n').replace(/\\/g, '\uFF3C').replace(/\r\n?/g, '\n');
  }
  function retryable(error) { return error === 'HTTP_429' || error === 'BUSY'; }
  function splittable(error) {
    return ['INVALID_RESPONSE', 'INCOMPLETE_RESPONSE', 'ID_MISMATCH', 'ITEM_COUNT_MISMATCH',
      'INVALID_ITEM_ID', 'DUPLICATE_ITEM_ID', 'INVALID_ITEM_TEXT'].includes(error);
  }
  function priority(indices, cues, time) {
    return Math.min(...indices.map(i => {
      const cue = cues[i];
      if (!cue) return 2e9 + i;
      if (cue.end >= time) return Math.max(0, cue.start - time);
      return 1e9 + time - cue.end;
    }));
  }
  function coverage(cues, values, time) {
    const remaining = cues.map((cue, index) => ({ ...cue, index }))
      .filter(cue => cue.end >= time).sort((a, b) => a.start - b.start);
    let until = time;
    for (const cue of remaining) {
      if (values[cue.index] == null) return Math.max(time, Math.min(until, cue.start));
      until = Math.max(until, cue.end);
    }
    return until;
  }
  // Drain each in-flight group before reporting failure or lowering concurrency.
  async function runBatches(batches, { concurrency = 1, retries = 2, rateWait = 20000, pace = 0,
    stopped, send, accept, report = () => {}, sleep, priority: rank = () => 0, warmStart = false,
    paused = () => false }) {
    const pending = batches.map((indices, id) => ({ indices, id, attempt: 0 }));
    let limit = Math.min(2, Math.max(1, concurrency)), error = null;
    let cooldown = 0;
    while (pending.length && !error && !stopped() && !paused()) {
      if (cooldown || pace) await sleep(Math.max(cooldown, pace));
      cooldown = 0;
      if (stopped() || paused()) break;
      pending.sort((a, b) => (b.attempt > 0) - (a.attempt > 0) || rank(a.indices) - rank(b.indices) || a.id - b.id);
      const group = pending.splice(0, warmStart ? 1 : limit);
      warmStart = false;
      const results = await Promise.all(group.map(async job => {
        const started = Date.now();
        let res;
        try {
          res = await send(job.indices, job.id, job.attempt);
          if (res.ok && (!Array.isArray(res.translations) || res.translations.length !== job.indices.length)) {
            res = { ok: false, error: 'ITEM_COUNT_MISMATCH' };
          }
          if (res.ok && !stopped()) await accept(job.indices, res.translations);
        } catch (e) {
          res = { ok: false, error: /^[A-Z][A-Z0-9_]*$/.test(e?.message || '') ? e.message : 'CLIENT_ERROR' };
        }
        report({ batch: job.id + 1, items: job.indices.length, attempt: job.attempt,
          durationMs: Date.now() - started, error: res.ok ? null : res.error, counts: res.counts });
        return { job, res };
      }));
      for (const { job, res } of results) {
        if (res.ok) continue;
        if (retryable(res.error) && job.attempt < retries) {
          limit = 1;
          cooldown = Math.max(cooldown, Math.min(60000, rateWait * (2 ** job.attempt)));
          pending.unshift({ ...job, attempt: job.attempt + 1 });
        } else {
          error = error || res.error || 'NETWORK_UNKNOWN';
        }
      }
    }
    return { error, concurrency: limit };
  }
  async function withTimeout(promise, ms, code) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), ms); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  self.CRSubFix = self.CRSubFix || {};
  self.CRSubFix.mtUtils = { fingerprint, batches, plainText, retryable, splittable, priority, coverage, runBatches, withTimeout };
})();
