(function () {
  'use strict';
  const text = (v, n = 200) => typeof v === 'string' ? v.trim().slice(0, n) : '';
  const number = v => /^\d{1,4}$/.test(String(v ?? '')) ? Number(v) : null;
  function detect(doc, url) {
    const W = self.CRSubFix.workProfiles;
    const hint = W.detect(doc, url), records = [];
    let visited = 0;
    function walk(node, depth = 0) {
      if (!node || typeof node !== 'object' || depth > 12 || ++visited > 1500) return;
      if (Array.isArray(node)) { node.forEach(n => walk(n, depth + 1)); return; }
      const episode = number(node.episodeNumber);
      if (episode > 0 && W.route(node.url || node['@id'] || node.mainEntityOfPage?.['@id'], 'watch') === hint.guid) {
        const series = node.partOfSeries || node.partOfSeason?.partOfSeries || {};
        const names = [series.alternateName].flat().filter(n => typeof n === 'string');
        records.push({ episode, season: number(node.partOfSeason?.seasonNumber),
          episodeTitle: text(node.name), englishTitle: names.find(n => /^[\x20-\x7e]+$/.test(n)) ||
            (/^[\x20-\x7e]+$/.test(series.name || '') ? text(series.name) : ''),
          aliases: names.slice(0, 6).map(n => text(n)).filter(Boolean) });
      }
      Object.values(node).forEach(n => walk(n, depth + 1));
    }
    for (const script of [...doc.querySelectorAll('script[type="application/ld+json"]')].slice(0, 20)) {
      if (script.textContent.length > 250000) continue;
      try { walk(JSON.parse(script.textContent)); } catch (_) {}
    }
    const identities = new Set(records.map(r => `${r.season}:${r.episode}`));
    let data = identities.size === 1 ? records[0] : {};
    if (!records.length && hint.guid) {
      const values = [doc.title, ...doc.querySelectorAll('main h1')].map(v => typeof v === 'string' ? v : v?.textContent || '');
      const labels = values.map(v => v.match(/\bS\s*(\d{1,2})\s*[-: ]*E\s*(\d{1,3})\b/i) ||
        v.match(/第\s*(\d{1,2})\s*季\s*第\s*(\d{1,3})\s*[集话話]/)).filter(Boolean);
      if (labels.length && new Set(labels.map(m => `${m[1]}:${m[2]}`)).size === 1)
        data = { season: Number(labels[0][1]), episode: Number(labels[0][2]) };
    }
    const pageLanguage = self.CRSubFix.searchNames?.locale(doc.documentElement?.lang, url) || text(doc.documentElement?.lang, 30);
    return { ...hint, ...data, pageLanguage, episode: data.episode ?? null, season: data.season ?? null };
  }
  function validate(value, guid) {
    const base = self.CRSubFix.workProfiles.hint(value, guid);
    return { ...base, pageLanguage: text(value?.pageLanguage, 30), englishTitle: text(value?.englishTitle), episodeTitle: text(value?.episodeTitle),
      episode: number(value?.episode), season: number(value?.season),
      aliases: Array.isArray(value?.aliases) ? value.aliases.slice(0, 6).map(v => text(v)).filter(Boolean) : [] };
  }
  function reconcile(current, saved) {
    if (!saved || saved.guid !== current.guid || current.seriesId && saved.seriesId && current.seriesId !== saved.seriesId) return current;
    const sameTitle = !current.title || current.title === saved.title;
    const baseline = saved.pageIdentity, stable = baseline && baseline.seriesId === current.seriesId && baseline.title === current.title;
    if (current.title && !current.seriesId && current.evidence === 'structured' && current.title !== saved.title && !stable) return current;
    return { ...saved, ...current, seriesId: current.seriesId || saved.seriesId || '', title: stable && saved.title || current.title || saved.title || '',
      englishTitle: stable && saved.englishTitle || current.englishTitle || (sameTitle ? saved.englishTitle : '') || '',
      episodeTitle: current.episodeTitle || saved.episodeTitle || '',
      season: stable && baseline.season === current.season ? saved.season ?? current.season : current.season ?? saved.season ?? null,
      episode: stable && baseline.episode === current.episode ? saved.episode ?? current.episode : current.episode ?? saved.episode ?? null,
      aliases: current.aliases?.length ? current.aliases : sameTitle ? saved.aliases || [] : [] };
  }
  const ready = value => !!value?.seriesId && value.season > 0 && value.episode > 0;
  async function wait(doc, getUrl, guid, { timeoutMs = 30000, intervalMs = 250,
    now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    const end = now() + timeoutMs;
    for (;;) {
      const url = getUrl();
      if (self.CRSubFix.workProfiles.route(url, 'watch') !== guid) return null;
      const metadata = detect(doc, url);
      if (ready(metadata) || now() >= end) return metadata;
      await sleep(intervalMs);
    }
  }
  self.CRSubFix.episodeMetadata = { detect, validate, reconcile, ready, wait };
})();
