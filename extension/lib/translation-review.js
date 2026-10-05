(function () {
  'use strict';
  const PREFIX = 'mtAudit:';
  const VERSION = 'dialogue-16';
  const fail = code => { throw new Error(code); };
  const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length;
  const canonical = value => value && typeof value === 'object'
    ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
    : value;
  function identity(info) {
    const { mode, rules, ...content } = info;
    return JSON.stringify(canonical(content));
  }
  const word = c => !!c && /[\p{L}\p{N}_]/u.test(c);
  function spans(text, source) {
    const result = [];
    if (!source) return result;
    let from = 0, pos;
    while ((pos = text.indexOf(source, from)) !== -1) {
      const end = pos + source.length;
      if ((!word(source[0]) || !word(text[pos - 1])) &&
          (!word(source.at(-1)) || !word(text[end]))) result.push({ start: pos, end });
      from = end;
    }
    return result;
  }
  function terms(text, glossary) {
    const occupied = [], found = [];
    for (const [source, target] of Object.entries(glossary).sort((a, b) => b[0].length - a[0].length)) {
      const hits = spans(text, source).filter(hit => !occupied.some(o => hit.start < o.end && hit.end > o.start));
      if (hits.length) { found.push({ source, target }); occupied.push(...hits); }
    }
    return found;
  }
  function isKinshipAddress(source) {
    return /^(?:(?:o?nii|o?nee)-(?:san|chan|sama)|o?(?:tou|kaa|jii|baa)-(?:san|chan|sama))$/i.test(source);
  }
  const STOP = new Set(('I A An The This That These Those He She It We You They His Her My Our Your Their ' +
    'Me Us Him Them Its Yes No Not Oh Ah Hey Hello Hi Huh Hmm Hooray Whoa Ow What When Where Why How ' +
    'Who Which Whose If But And Or So For To In On At Of As By From With Without Is Are Was Were Be ' +
    'Been Being Do Does Did Have Has Had Will Would Can Could Should Shall Must May Might Please ' +
    'Thank Thanks Sorry Okay OK Sure Well Right Wait Come Go Now Then There Here All Just Really ' +
    'Listen Look Let See Tell Stop Don Really Very Great Good Morning Night Excuse Help Fine ' +
    'Back After Before Even Any Every Everyone Everything Something Nothing Someone Anybody ' +
    'Want Got Get Give Take Make Nice Too Also Still Because Since Only Never Always Already ' +
    'Episode Years Ago School Class Festival Best Award Category Science Math Student Council ' +
    'Office Russian Japan Japanese English Chinese P E Yeah Nope Bye Gosh Crap Man Better').split(/\s+/));
  function coverage(corpus, glossary) {
    const candidates = new Map();
    const texts = (Array.isArray(corpus) ? corpus : []).slice(0, 6000).filter(t => typeof t === 'string').map(t => t.slice(0, 2000));
    for (const [index, text] of texts.entries()) {
      for (const match of text.matchAll(/\b[A-Z][a-zA-Z]{1,30}(?:-(?:san|kun|chan|sama|senpai|sensei|nyan))?\b/g)) {
        const source = match[0];
        if (STOP.has(source) || isKinshipAddress(source)) continue;
        const item = candidates.get(source) || { source, indices: [], sample: text.slice(0, 300) };
        if (!item.indices.includes(index)) item.indices.push(index);
        candidates.set(source, item);
      }
    }
    const rows = [...candidates.values()].filter(c => c.indices.length >= 2 || c.source.includes('-'));
    for (const source of Object.keys(glossary)) {
      const indices = texts.flatMap((text, i) => spans(text, source).length ? [i] : []);
      if (!indices.length) continue;
      const old = rows.find(r => r.source === source);
      if (!old) rows.push({ source, indices, sample: texts[indices[0]].slice(0, 300) });
    }
    return rows.map(row => {
      const base = row.source.replace(/-(?:san|kun|chan|sama|senpai|sensei|nyan)$/i, '');
      const key = Object.hasOwn(glossary, row.source) ? row.source : Object.hasOwn(glossary, base) ? base : '';
      return { ...row, count: row.indices.length, target: key ? glossary[key] : '', key };
    }).sort((a, b) => Number(!!a.key) - Number(!!b.key) || b.count - a.count || a.source.localeCompare(b.source)).slice(0, 120);
  }
  function glossaryRisks(glossary) {
    return Object.entries(glossary).filter(([source, target]) =>
      /-chan$/i.test(source) && /同学|小姐/.test(target) ||
      /-san$/i.test(source) && /先生|小姐/.test(target))
      .map(([source, target]) => ({ source, target }));
  }
  function issues(source, target, glossary, unmapped = []) {
    if (typeof target !== 'string' || !target.trim()) return [];
    const result = terms(source, glossary).filter(t => !target.includes(t.target))
      .map(t => `译名待核对：${t.source} → ${t.target}`);
    if (/-chan\b/.test(source) && /同学|小姐/.test(target)) result.push('称谓待核对：-chan 与同学/小姐');
    if (/-san\b/.test(source) && /先生|小姐|同学/.test(target)) result.push('称谓待核对：-san 的社交身份需结合场景');
    for (const name of unmapped.filter(name => spans(source, name).length && !target.includes(name)).slice(0, 3)) {
      result.push(`专名候选缺少确认译名：${name}（可能误报）`);
    }
    return result;
  }
  function effective(cfg, record, enabled) {
    return { provider: cfg.provider, protocol: cfg.protocol, model: cfg.model, rules: VERSION,
      workEnabled: enabled === true, profile: record ? {
        key: record.key, revision: record.revision, title: record.title, aliases: record.aliases,
        context: record.context, tone: record.tone,
      } : null, glossary: { ...cfg.glossary }, origins: Object.fromEntries(Object.keys(cfg.glossary).map(k =>
        [k, record && Object.hasOwn(record.glossary, k) ? 'work' : 'global'])) };
  }
  async function record(storage, cache, inputs, info) {
    const key = PREFIX + cache.key;
    const old = (await storage.get(key))[key];
    if (old && (old.guid !== cache.guid || old.configTag !== cache.configTag || old.total !== cache.total ||
        old.workToken !== (cache.workToken || '') || identity(old.info) !== identity(info))) {
      fail('REVIEW_CONTEXT_CHANGED');
    }
    const row = old ? { ...old, inputs: old.inputs.slice() } : { key: cache.key, guid: cache.guid, configTag: cache.configTag, workToken: cache.workToken || '',
      target: cache.target, total: cache.total, info, inputs: Array(cache.total).fill(null), requests: 0, created: Date.now() };
    const seen = new Set();
    for (const input of inputs) {
      if (!Number.isInteger(input.index) || input.index < 0 || input.index >= cache.total || seen.has(input.index) ||
          typeof input.text !== 'string' || input.text.length > 100000 ||
          (row.inputs[input.index] && row.inputs[input.index].text !== input.text)) fail('INVALID_REVIEW_INPUT');
      seen.add(input.index);
      row.inputs[input.index] = { ...input, mode: info.mode, rules: info.rules };
    }
    row.modes = [...new Set([...(old?.modes || []), info.mode])];
    row.ruleVersions = [...new Set([...(old?.ruleVersions || []), info.rules])].slice(-16);
    row.requests++;
    row.updated = Date.now();
    row.expires = row.updated + 86400000;
    if (bytes(row) > 1024 * 1024) fail('REVIEW_TOO_LARGE');
    const all = await storage.get(null), others = [];
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith(PREFIX) || k === key) continue;
      if (v.expires <= Date.now() || !all['mtProgress:' + v.key]) await storage.remove(k);
      else others.push({ key: k, updated: v.updated, size: bytes(v) });
    }
    others.sort((a, b) => a.updated - b.updated);
    let size = bytes(row) + others.reduce((sum, v) => sum + v.size, 0);
    while (others.length >= 8 || size > 4 * 1024 * 1024) {
      const victim = others.shift(); size -= victim.size; await storage.remove(victim.key);
    }
    await storage.set({ [key]: row });
  }
  async function list(storage, guid) {
    const all = await storage.get(null);
    return Object.entries(all).filter(([k, v]) => k.startsWith(PREFIX) && v.guid === guid && v.expires > Date.now())
      .map(([, row]) => {
        const saved = all['mtProgress:' + row.key];
        const valid = saved?.expires > Date.now() && saved.guid === guid &&
          saved.configTag === row.configTag && saved.total === row.total;
        const values = valid ? saved.values : [];
        const unmapped = coverage(row.inputs.map(input => input?.text || ''), row.info.glossary)
          .filter(candidate => !candidate.key).map(candidate => candidate.source);
        const entries = row.inputs.filter(Boolean).map(input => ({
          ...input, translated: values[input.index] ?? null,
          corrected: valid && (saved.corrections || []).includes(input.index),
          issues: issues(input.text, values[input.index], row.info.glossary, unmapped),
        }));
        return { ...row, inputs: undefined, entries, cached: valid,
          completed: values.filter(t => typeof t === 'string' && t.trim()).length,
          complete: valid && values.length === row.total && values.every(t => typeof t === 'string' && t.trim()) };
      }).sort((a, b) => b.updated - a.updated);
  }
  self.CRSubFix = self.CRSubFix || {};
  self.CRSubFix.translationReview = { VERSION, spans, terms, isKinshipAddress, coverage, glossaryRisks, issues, effective, record, list };
})();
