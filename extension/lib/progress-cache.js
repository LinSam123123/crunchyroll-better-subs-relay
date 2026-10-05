(function () {
  'use strict';
  const PREFIX = 'mtProgress:';
  const TTL = 24 * 60 * 60 * 1000;
  const MAX_BYTES = 4 * 1024 * 1024;
  const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
  function validate(p) {
    if (!p || !/^[A-Za-z0-9_-]{1,80}$/.test(p.guid || '') ||
        !/^[A-Za-z0-9_:.-]{1,512}$/.test(p.key || '') ||
        !Number.isInteger(p.total) || p.total < 1 || p.total > 6000) throw new Error('INVALID_CACHE_REQUEST');
  }
  async function handle(storage, method, p) {
    if (method === 'clear') {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(p?.guid || '')) throw new Error('INVALID_CACHE_REQUEST');
      const all = await storage.get(null);
      for (const [key, value] of Object.entries(all)) {
        if (key.startsWith(PREFIX) && value?.guid === p.guid) await storage.remove(key);
      }
      return { ok: true };
    }
    validate(p);
    const key = PREFIX + p.key;
    const old = (await storage.get(key))[key];
    if (old && old.guid !== p.guid) throw new Error('INVALID_CACHE_REQUEST');
    const usable = old && old.guid === p.guid && old.configTag === p.configTag &&
      old.total === p.total && old.expires > Date.now() && Array.isArray(old.values) && old.values.length === p.total;
    if (method === 'get') return { ok: true, values: usable ? old.values : null };
    if (!['save', 'correct'].includes(method) || !Array.isArray(p.entries) || p.entries.length > 50 || !p.entries.length) {
      throw new Error('INVALID_CACHE_REQUEST');
    }
    if (method === 'correct' && !usable) throw new Error('REVIEW_CACHE_EXPIRED');
    const values = usable ? old.values.slice() : Array(p.total).fill(null);
    const corrections = new Set(usable ? old.corrections || [] : []);
    const seen = new Set();
    for (const entry of p.entries) {
      if (!entry || !Number.isInteger(entry.index) || entry.index < 0 || entry.index >= p.total ||
          seen.has(entry.index) || typeof entry.text !== 'string' || !entry.text.trim() || entry.text.length > 30000) {
        throw new Error('INVALID_CACHE_REQUEST');
      }
      seen.add(entry.index);
      if (method === 'correct') {
        if (!values[entry.index] || values[entry.index] !== entry.previous) throw new Error('REVIEW_TEXT_CHANGED');
        corrections.add(entry.index);
        values[entry.index] = entry.text;
      } else if (!corrections.has(entry.index)) values[entry.index] = entry.text;
    }
    const value = { guid: p.guid, configTag: p.configTag, total: p.total, values,
      ...(corrections.size ? { corrections: [...corrections] } : {}),
      updated: Date.now(), expires: Date.now() + TTL };
    const size = bytes(value);
    if (size > 1024 * 1024) throw new Error('CACHE_ENTRY_TOO_LARGE');
    const all = await storage.get(null);
    const others = [];
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith(PREFIX) || k === key) continue;
      if (!v || v.expires <= Date.now()) await storage.remove(k);
      else others.push({ key: k, updated: v.updated || 0, size: bytes(v) });
    }
    let used = size + others.reduce((n, v) => n + v.size, 0);
    others.sort((a, b) => a.updated - b.updated);
    while (used > MAX_BYTES || others.length >= 8) {
      const victim = others.shift();
      used -= victim.size;
      await storage.remove(victim.key);
    }
    await storage.set({ [key]: value });
    return { ok: true };
  }
  self.CRSubFix.progressCache = { handle };
})();
