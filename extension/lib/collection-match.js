(function () {
  'use strict';
  const special = name => /\b(?:OVA|OAD|SP|SPECIAL)(?=\d|\b)|\b(?:NCOP|NCED|OP|ED|PV)\b|特别|特別|总集|總集/i.test(name);
  function parse(name) {
    if (typeof name !== 'string' || name.length > 700 ||
        special(name)) return null;
    const patterns = [
      /\bS(\d{1,2})E(\d{1,3})(?!\d)/gi,
      /\b(?:episode|ep|e)[ ._-]*(\d{1,3})(?!\d)/gi,
      /第\s*(\d{1,3})\s*[集话話]/g,
      /[\[【](\d{1,3})[\]】]/g,
      /-\s*(\d{1,3})(?=[\s.(\[]|-JPN\b|$)/gi,
      /(?:^|[ ._])(\d{1,3})(?=\.(?:ass|ssa|srt|vtt)$)/gi,
    ];
    const episodeText = name.replace(/[「『][^」』]*[」』]/g, value => ' '.repeat(value.length));
    for (const pattern of patterns) {
      const matches = [...episodeText.matchAll(pattern)];
      if (!matches.length) continue;
      if (matches.length !== 1) return null;
      const m = matches[0], digits = m[2] || m[1], episode = Number(digits);
      if (!episode) return null;
      const at = m.index + m[0].lastIndexOf(digits);
      if (/^\s*[-~–]\s*(?:E)?\d{1,3}(?!\d)/i.test(name.slice(at + digits.length)) ||
          /(?:^|[ ._])\d{1,3}$/.test(name.slice(0, m.index))) return null;
      return describe(name, episode, m[2] ? Number(m[1]) : null, at, digits.length, !!m[2]);
    }
    // Some releases put a short episode number immediately before the group tag.
    const tagged = /(?:^|[ ._])(\d{1,2}|0\d{2})(?=\.[A-Za-z][A-Za-z0-9_-]*\.(?:ass|ssa|srt|vtt)$)/i.exec(name);
    if (tagged) {
      const at = tagged.index + tagged[0].lastIndexOf(tagged[1]);
      const prefix = name.slice(0, at);
      if (!Number(tagged[1]) || /(?:^|[ ._])\d{1,3}[ ._-]+$/.test(prefix)) return null;
      return describe(name, Number(tagged[1]), null, at, tagged[1].length, false);
    }
    return null;
  }
  const normalize = value => value.toLowerCase().replace(/\s+/g, ' ').trim();
  function traits(name) {
    const platforms = [...name.matchAll(/\b(?:netflix|amzn|amazon|at-x|crunchyroll|cr|bd(?:rip)?|blu-?ray|web(?:-?dl|rip)?|hdtv|dvd)\b/gi)]
      .map(m => m[0].toLowerCase()).sort();
    const language = name.match(/(?:[ ._-])(ja|jpn|jp|en|eng|zh(?:-[a-z]+)?|chs|cht|sc|tc)(?=[ ._[\]-]|\.(?:ass|ssa|srt|vtt)$)/gi) || [];
    return { format: name.match(/\.(ass|ssa|srt|vtt)$/i)?.[1].toLowerCase() || '',
      platforms: [...new Set(platforms)].join(','), language: language.map(normalize).join(','),
      accessibility: /(?:\[cc\]|\bcc\b)/i.test(name) ? 'cc' : /\bsdh\b/i.test(name) ? 'sdh' : '',
      revision: name.match(/\bv\d+\b/i)?.[0].toLowerCase() || '',
      group: name.match(/^\[([^\]]+)\]/)?.[1].toLowerCase() || '' };
  }
  function describe(name, episode, season, at, length, explicit) {
    const template = name.slice(0, at) + '{episode}' + name.slice(at + length);
    let suffix = name.slice(at + length).replace(/\s*\[[a-f\d]{8}\]/gi, '').replace(/\s*[「『][^」』]*[」』]\s*/g, ' ');
    // Episode titles vary, but platform, language, revision and format must not.
    const release = /(?:\bWEB(?:-?DL|Rip)?\b|\bBD(?:Rip)?\b|\bBlu-?ray\b|\bHDTV\b|\bDVD\b|\bNetflix\b|\bAMZN\b|\bAT-X\b)/i.exec(suffix);
    if (explicit && release) suffix = suffix.slice(release.index);
    else if (explicit && /^[-.]/.test(suffix)) {
      const language = suffix.match(/\.(?:ja|jpn|en|eng|zh(?:-[a-z]+)?|chs|cht)(?:\[cc\]|\.sdh)?\.(?:ass|ssa|srt|vtt)$/i);
      if (language) suffix = language[0];
    }
    const properties = traits(name);
    const signature = JSON.stringify([normalize(name.slice(0, at)), normalize(suffix), properties]);
    return { episode, season, template, signature, traits: properties };
  }
  function compatible(anchor, candidate) {
    if (special(candidate)) return false;
    const a = traits(anchor), b = traits(candidate);
    return !!a.format && Object.keys(a).every(k => a[k] === b[k]);
  }
  function groups(files) {
    const result = new Map();
    for (const file of files) {
      const parsed = parse(file.name), signature = parsed?.signature || `unknown:${file.fileId || file.name}`;
      if (!result.has(signature)) result.set(signature, { signature, label: file.name, traits: traits(file.name), files: [], episodes: [] });
      const group = result.get(signature);
      group.files.push({ ...file, episode: parsed?.episode ?? null, season: parsed?.season ?? null });
      if (parsed && !group.episodes.includes(parsed.episode)) group.episodes.push(parsed.episode);
    }
    return [...result.values()].map(g => ({ ...g, episodes: g.episodes.sort((a, b) => a - b) }));
  }
  function validateMap(files, rows, anchor, meta) {
    if (!Array.isArray(rows) || !rows.length || rows.length > 300 || !identity(meta)) throw new Error('FOLLOW_MAP_INVALID');
    const result = [], episodes = new Set();
    for (const row of rows) {
      const matching = files.filter(f => f.name === row.name && (f.fileId || '') === (row.fileId || ''));
      const file = matching[0], p = file && parse(file.name);
      if (matching.length !== 1 || !file.format || !compatible(anchor.name, file.name) ||
          !Number.isInteger(row.episode) || row.episode < 1 || row.episode > 9999 || episodes.has(row.episode) ||
          p && (p.episode !== row.episode || p.season !== null && p.season !== meta.season)) throw new Error('FOLLOW_MAP_INVALID');
      episodes.add(row.episode);
      result.push({ name: file.name, fileId: file.fileId || '', episode: row.episode, format: file.format });
    }
    if (!result.some(f => f.name === anchor.name && f.fileId === (anchor.fileId || '') && f.episode === meta.episode))
      throw new Error('FOLLOW_MAP_INVALID');
    return result;
  }
  function identity(meta) {
    return meta?.seriesId && Number.isInteger(meta.season) && meta.season > 0 &&
      Number.isInteger(meta.episode) && meta.episode > 0;
  }
  const key = meta => JSON.stringify([meta.seriesId, meta.season]);
  function select(files, rule, meta) {
    const mapped = rule.mapping?.filter(row => row.episode === meta.episode);
    if (Array.isArray(rule.mapping)) return files.filter(f => mapped.some(row => row.name === f.name &&
      row.fileId === (f.fileId || '') && row.format === f.format));
    const anchor = rule.label && parse(rule.label);
    const signature = rule.signature || (anchor?.template === rule.template ? anchor?.signature : null);
    return files.filter(f => {
      const value = parse(f.name);
      return f.format && value?.episode === meta.episode && (signature ? value.signature === signature : value.template === rule.template) &&
        (value.season === null || value.season === meta.season);
    });
  }
  self.CRSubFix = self.CRSubFix || {};
  self.CRSubFix.collectionMatch = { parse, identity, key, select, special, groups, traits, compatible, validateMap };
})();
