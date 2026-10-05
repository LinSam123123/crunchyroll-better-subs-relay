(function () {
  'use strict';
  const ORIGIN = 'https://api.bgm.tv';
  const PERMISSION = `${ORIGIN}/*`;
  const LIMIT = 12;
  const fail = code => { throw new Error(code); };
  const clean = (v, max = 200) => typeof v === 'string' ? v.trim().slice(0, max) : '';
  const validId = id => Number.isSafeInteger(id) && id > 0 && id < 100000000;
  const idOf = id => { if (!validId(id)) fail('LOOKUP_INVALID_INPUT'); return id; };
  const sourceUrl = (kind, id) => `https://bgm.tv/${kind}/${idOf(id)}`;
  function query(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 200) fail('LOOKUP_INVALID_INPUT');
    return value.trim();
  }
  async function request(path, body, fetcher = fetch) {
    try {
      const response = await fetcher(ORIGIN + path, {
        method: body ? 'POST' : 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json',
          'X-User-Agent': 'BetterSubsPrivateRelay/2.7.0.16' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) fail(`LOOKUP_HTTP_${response.status}`);
      if (Number(response.headers?.get('content-length')) > 2000000) fail('LOOKUP_INVALID_RESPONSE');
      // Bound streamed input before parsing; never render raw provider HTML.
      let raw = '';
      if (response.body?.getReader) {
        const reader = response.body.getReader(), decoder = new TextDecoder();
        let bytes = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > 2000000) { await reader.cancel(); fail('LOOKUP_INVALID_RESPONSE'); }
            raw += decoder.decode(value, { stream: true });
          }
          raw += decoder.decode();
        } finally { reader.releaseLock(); }
      } else raw = await response.text();
      if (raw.length > 2000000) fail('LOOKUP_INVALID_RESPONSE');
      try { return JSON.parse(raw); } catch (_) { fail('LOOKUP_INVALID_RESPONSE'); }
    } catch (e) {
      if (/^LOOKUP_/.test(e?.message || '')) throw e;
      fail(['AbortError', 'TimeoutError'].includes(e?.name) ? 'LOOKUP_TIMEOUT' : 'LOOKUP_NETWORK');
    }
  }
  function subject(value) {
    if (!validId(value?.id) || typeof value.name !== 'string') fail('LOOKUP_INVALID_RESPONSE');
    return { id: value.id, name: clean(value.name), nameCn: clean(value.name_cn),
      date: clean(value.date, 20), platform: clean(value.platform, 40), url: sourceUrl('subject', value.id) };
  }
  async function search(value, fetcher) {
    const result = await request('/v0/search/subjects?limit=8', {
      keyword: query(value), filter: { type: [2], nsfw: false },
    }, fetcher);
    if (!Array.isArray(result?.data)) fail('LOOKUP_INVALID_RESPONSE');
    return { subjects: result.data.slice(0, 8).map(subject), fetchedAt: Date.now() };
  }
  function character(data, expected) {
    if (data?.id !== expected || typeof data.name !== 'string') fail('LOOKUP_INVALID_RESPONSE');
    const info = Array.isArray(data.infobox) ? data.infobox : [];
    const nameCn = clean(info.find(row => row.key === '简体中文名')?.value);
    const aliases = [clean(data.name)];
    const values = info.find(row => row.key === '别名')?.value;
    if (Array.isArray(values)) {
      for (const value of values.slice(0, 30)) {
        // Nicknames may reveal an identity; only collect explicit orthographic names.
        if (['罗马字', '英文名', '日文名', '纯假名'].includes(value?.k)) aliases.push(clean(value.v));
      }
    }
    return { id: expected, name: clean(data.name), nameCn,
      aliases: [...new Set(aliases.filter(Boolean))], url: sourceUrl('character', expected) };
  }
  async function characters(subjectId, offset = 0, fetcher) {
    idOf(subjectId);
    if (!Number.isInteger(offset) || offset < 0 || offset > 288 || offset % LIMIT) fail('LOOKUP_INVALID_INPUT');
    const list = await request(`/v0/subjects/${subjectId}/characters`, null, fetcher);
    if (!Array.isArray(list) || list.length > 2000) fail('LOOKUP_INVALID_RESPONSE');
    const ids = [...new Set(list.filter(row => validId(row?.id)).map(row => row.id))].slice(0, 300);
    const batch = ids.slice(offset, offset + LIMIT);
    const rows = [], failedIds = [];
    // At most three public requests in flight, independently of translation workers.
    for (let i = 0; i < batch.length; i += 3) {
      const results = await Promise.all(batch.slice(i, i + 3).map(async id => {
        try { return { row: character(await request(`/v0/characters/${id}`, null, fetcher), id) }; }
        catch (e) { return { id, error: e.message }; }
      }));
      for (const result of results) {
        if (result.row) rows.push(result.row);
        else failedIds.push(result.id);
      }
      if (results.some(r => r.error === 'LOOKUP_HTTP_429')) {
        failedIds.push(...batch.slice(i + 3));
        break;
      }
    }
    return { subjectId, offset, characters: rows, failedIds, fetchedAt: Date.now(),
      nextOffset: offset + LIMIT < ids.length ? offset + LIMIT : null, total: ids.length };
  }
  function corpus(values) {
    if (!Array.isArray(values)) return [];
    let left = 100000;
    const result = [];
    for (const value of values.slice(0, 6000)) {
      if (typeof value !== 'string') continue;
      const item = value.trim().slice(0, Math.min(2000, left));
      if (item) { result.push(item); left -= item.length; }
      if (!left) break;
    }
    return result;
  }
  function matches(record, texts) {
    const haystack = corpus(texts).join('\n');
    const found = new Map();
    for (const alias of record.aliases) {
      const parts = /^[A-Za-z][A-Za-z '\u00c0-\u024f-]+$/.test(alias) ? alias.split(/\s+/) : [];
      for (const candidate of [alias, ...parts.filter(p => p.length >= 3)]) {
        const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu');
        if (regex.test(haystack)) found.set(candidate, { source: candidate, fragment: candidate !== alias });
      }
    }
    return [...found.values()].slice(0, 12);
  }
  function provenance(value, glossary) {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 100) {
      fail('INVALID_WORK_PROFILE');
    }
    const result = Object.create(null);
    for (const [key, row] of Object.entries(value)) {
      if (!Object.hasOwn(glossary, key) || row?.target !== glossary[key]) continue;
      if (!validId(row.subjectId) || !validId(row.characterId) || !Number.isSafeInteger(row.fetchedAt) ||
          row.fetchedAt < 0 || row.provider !== 'bangumi') fail('INVALID_WORK_PROFILE');
      result[key] = { provider: 'bangumi', subjectId: row.subjectId, characterId: row.characterId,
        target: row.target, fetchedAt: row.fetchedAt,
        ...(row.method === 'model-assisted' ? { method: 'model-assisted' } : {}) };
    }
    return result;
  }
  function merge(glossary, sources, choices, replace = false) {
    const entries = new Map(Object.entries(glossary)), refs = new Map(Object.entries(provenance(sources, glossary)));
    const seen = new Map(), conflicts = [];
    for (const item of choices) {
      const source = clean(item.source), target = clean(item.target);
      if (!source || !target) fail('LOOKUP_EMPTY_TERM');
      if (seen.has(source) && seen.get(source) !== target) fail('LOOKUP_DUPLICATE_TERM');
      seen.set(source, target);
      if (entries.has(source) && entries.get(source) !== target && !replace) { conflicts.push(source); continue; }
      if (item.provenance) refs.set(source, { ...item.provenance, target });
      else if (entries.get(source) !== target) refs.delete(source);
      entries.set(source, target);
    }
    if (entries.size > 100) fail('INVALID_WORK_PROFILE');
    const result = Object.fromEntries(entries);
    return { glossary: result, sources: provenance(Object.fromEntries(refs), result), conflicts };
  }
  self.CRSubFix = self.CRSubFix || {};
  self.CRSubFix.workLookup = { PERMISSION, query, search, characters, corpus, matches, provenance, merge, sourceUrl };
})();
