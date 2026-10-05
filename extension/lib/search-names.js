(function () {
  'use strict';
  const languages = { 'zh-CN': '中文简体', 'zh-TW': '中文繁体', en: '英文', ja: '日文', romaji: '罗马字', und: '未标语种' };
  const sources = { page: '当前官方页面', official: 'Crunchyroll 官方', jimaku: 'Jimaku 目录', conversion: '本地简繁转换', ai: 'AI 候选 · 待确认', manual: '手动名称' };
  function locale(value, url = '') {
    if (/^zh$/i.test(value || '')) {
      try { value = new URL(url, 'https://www.crunchyroll.com').pathname.split('/')[1]; } catch (_) {}
    }
    return /^zh-(?:cn|hans)$/i.test(value || '') ? 'zh-CN' : /^zh-(?:tw|hk|hant)$/i.test(value || '') ? 'zh-TW' :
      /^en(?:-|$)/i.test(value || '') ? 'en' : /^ja(?:-|$)/i.test(value || '') ? 'ja' : 'und';
  }
  const clean = value => typeof value === 'string' ? value.trim().slice(0, 200) : '';
  function merge(...lists) {
    const result = [], ranks = ['official', 'page', 'jimaku', 'manual', 'conversion', 'ai'];
    for (const value of lists.flat().slice(0, 300)) {
      if (!value || !clean(value.name) || !languages[value.language] || !sources[value.source]) continue;
      const row = { name: clean(value.name), language: value.language, source: value.source };
      if (value.confirmed === true) row.confirmed = true;
      if (['official', 'page'].includes(row.source)) {
        try { const u = new URL(value.url); if (u.origin === 'https://www.crunchyroll.com') row.url = u.href; } catch (_) {}
      }
      const existing = result.find(r => r.name === row.name && r.language === row.language);
      if (!existing) result.push(row);
      else if (ranks.indexOf(row.source) < ranks.indexOf(existing.source)) Object.assign(existing, row);
      else if (row.confirmed) existing.confirmed = true;
    }
    return result.sort((a, b) => ranks.indexOf(a.source) - ranks.indexOf(b.source)).slice(0, 40);
  }
  function base(meta, converters) {
    const language = locale(meta.pageLanguage), url = `https://www.crunchyroll.com/series/${meta.seriesId}`;
    const records = [{ name: meta.title, language, source: 'page', url },
      { name: meta.englishTitle, language: 'und', source: 'page', url },
      ...(meta.aliases || []).map(name => ({ name, language: 'und', source: 'page', url }))];
    if (converters && language !== 'ja' && !/[\u3041-\u30ff]/.test(meta.title || '') && /[\u3400-\u9fff]/.test(meta.title || '')) {
      records.push({ name: converters.simplified(meta.title), language: 'zh-CN', source: 'conversion' },
        { name: converters.traditional(converters.simplified(meta.title)), language: 'zh-TW', source: 'conversion' });
    }
    return merge(records);
  }
  function extract(doc, seriesId, url, expectedLanguage) {
    const W = self.CRSubFix.workProfiles, canonical = doc.querySelector('link[rel="canonical"]')?.href;
    const language = locale(doc.documentElement?.lang, canonical || url);
    if (expectedLanguage && language !== expectedLanguage) return [];
    if (W.route(url, 'series') !== seriesId) return [];
    if (canonical && W.route(canonical, 'series') !== seriesId) return [];
    const kind = doc.querySelector('meta[property="og:type"]')?.content;
    const heading = kind === 'video.tv_show' && canonical ? clean(doc.querySelector('h1')?.textContent) : '';
    const records = [];
    let visited = 0;
    function walk(node, depth = 0) {
      if (!node || typeof node !== 'object' || depth > 12 || ++visited > 1500) return;
      if (Array.isArray(node)) { node.forEach(n => walk(n, depth + 1)); return; }
      const type = [node['@type']].flat(), id = W.route(node.url || node['@id'], 'series');
      if (type.includes('TVSeries') && (!id || id === seriesId) && clean(node.name)) {
        const nodeLanguage = node.inLanguage ? locale([node.inLanguage].flat()[0]) : language;
        if (nodeLanguage === language && language !== 'und') {
          const name = heading || clean(node.name);
          if (heading || !/^Watch\s/i.test(name)) records.push({ name, language, source: 'official', url });
        }
      }
      Object.values(node).forEach(n => walk(n, depth + 1));
    }
    for (const script of [...doc.querySelectorAll('script[type="application/ld+json"]')].slice(0, 20)) {
      if (script.textContent.length > 250000) continue;
      try { walk(JSON.parse(script.textContent)); } catch (_) {}
    }
    // Only a series-specific Open Graph record may back an unstructured heading.
    if (!records.length && language !== 'und') {
      const title = clean(doc.querySelector('h1')?.textContent);
      if (title && kind === 'video.tv_show' && canonical && W.route(canonical, 'series') === seriesId) records.push({ name: title, language, source: 'official', url });
    }
    return merge(records);
  }
  async function readHTML(response) {
    if (!response.body?.getReader) {
      const html = await response.text();
      if (html.length > 4000000) throw new Error('OFFICIAL_PAGE_TOO_LARGE');
      return html;
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let size = 0, html = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return html + decoder.decode();
        size += value.byteLength;
        if (size > 4000000) {
          await reader.cancel();
          throw new Error('OFFICIAL_PAGE_TOO_LARGE');
        }
        html += decoder.decode(value, { stream: true });
      }
    } finally { reader.releaseLock(); }
  }
  async function official(meta, getUrl, fetcher = fetch, parser = html => new DOMParser().parseFromString(html, 'text/html')) {
    const W = self.CRSubFix.workProfiles, initial = getUrl();
    if (!meta.seriesId || W.route(initial, 'watch') !== meta.guid) throw new Error('EXTERNAL_CONTEXT_EXPIRED');
    const locales = [['en', 'en'], ['zh-cn', 'zh-CN'], ['zh-tw', 'zh-TW'], ['ja', 'ja']];
    const results = await Promise.all(locales.map(async ([path, language]) => {
      const url = `https://www.crunchyroll.com/${path}/series/${encodeURIComponent(meta.seriesId)}`;
      try {
        const r = await fetcher(url, { credentials: 'same-origin', redirect: 'follow', signal: AbortSignal.timeout(8000) });
        if (!r.ok || W.route(r.url || url, 'series') !== meta.seriesId || Number(r.headers?.get('content-length')) > 4000000) return { language, failed: true, records: [] };
        const html = await readHTML(r);
        const records = extract(parser(html), meta.seriesId, r.url || url, language);
        return { language, failed: !records.length, records };
      } catch (_) { return { language, failed: true, records: [] }; }
    }));
    if (W.route(getUrl(), 'watch') !== meta.guid) throw new Error('EXTERNAL_CONTEXT_EXPIRED');
    return { records: merge(...results.map(r => r.records)), unavailable: results.filter(r => r.failed).map(r => r.language) };
  }
  self.CRSubFix = self.CRSubFix || {};
  self.CRSubFix.searchNames = { languages, sources, locale, merge, base, extract, official };
})();
