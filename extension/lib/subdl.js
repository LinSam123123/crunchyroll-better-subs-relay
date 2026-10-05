(function () {
  'use strict';
  const fail = code => { throw new Error(code); };
  const A = self.CRSubFix.assrt;
  const ORIGINS = ['https://api.subdl.com/*', 'https://dl.subdl.com/*'];
  const clean = (v, n = 300) => typeof v === 'string' ? v.trim().slice(0, n) : '';
  const id = v => /^[A-Za-z0-9_-]{1,100}$/.test(String(v)) ? String(v) : fail('SUBDL_INVALID_ID');
  const titleId = v => /^(?:sd)?\d{1,12}$/.test(String(v)) ? String(v).replace(/^sd/, '') : fail('SUBDL_INVALID_ID');
  function token(v) {
    if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{8,200}$/.test(v.trim())) fail('SUBDL_INVALID_KEY');
    return v.trim();
  }
  function query(v) {
    const q = clean(v, 201);
    if (q.length < 2 || q.length > 200) fail('SUBDL_INVALID_QUERY');
    return q;
  }
  async function transport(stage, operation) {
    try { return await operation(); }
    catch (e) {
      if (/^SUBDL_[A-Z0-9_]+$/.test(e?.message || '')) throw e;
      if (/^ASSRT_/.test(e?.message || '')) fail(e.message.replace(/^ASSRT_/, 'SUBDL_'));
      fail(`SUBDL_${stage}_${['TimeoutError', 'AbortError'].includes(e?.name) ? 'TIMEOUT' : 'NETWORK'}`);
    }
  }
  async function request(key, endpoint, params = {}, fetcher = fetch) {
    const url = new URL('https://api.subdl.com/api/v2/' + endpoint);
    Object.entries(params).filter(([, v]) => v != null && v !== '').forEach(([k, v]) => url.searchParams.set(k, String(v)));
    return transport('API', async () => {
      const r = await fetcher(url.href, { headers: { Authorization: `Bearer ${token(key)}`, Accept: 'application/json' },
        credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30000) });
      if (r.status === 429) {
        const e = new Error('SUBDL_RATE_LIMIT');
        const reset = Number(r.headers?.get('x-ratelimit-reset'));
        e.retryAfter = Math.min(86400, Math.max(1, Number(r.headers?.get('retry-after')) ||
          (reset > Date.now() / 1000 ? Math.ceil(reset - Date.now() / 1000) : 60)));
        throw e;
      }
      if (!r.ok) fail([401, 403].includes(r.status) ? 'SUBDL_AUTH_FAILED' : `SUBDL_HTTP_${r.status}`);
      let data;
      try { data = JSON.parse(new TextDecoder().decode(await A.readBytes(r, 4 * 1024 * 1024))); }
      catch (e) { if (/^ASSRT_/.test(e.message)) throw e; fail('SUBDL_INVALID_RESPONSE'); }
      if (!data || data.error || data.status === false) fail('SUBDL_SERVICE_ERROR');
      return data;
    });
  }
  function downloadUrl(raw) {
    let u;
    try { u = new URL(raw, 'https://dl.subdl.com'); } catch (_) { fail('SUBDL_DOWNLOAD_UNSAFE'); }
    if (u.origin !== 'https://dl.subdl.com' || u.username || u.password || u.hash ||
        !/^\/subtitle\/[A-Za-z0-9_-]+(?:\.zip|\/[A-Za-z0-9_-]+)?$/.test(u.pathname) ||
        [...u.searchParams.keys()].some(k => k !== 'api_key'))
      fail('SUBDL_DOWNLOAD_UNSAFE');
    // v2 adds a credential to otherwise public links; never persist or forward it.
    u.search = '';
    return u.href;
  }
  function numeric(v) { return Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) < 10000 ? Number(v) : null; }
  function language(v) {
    const s = clean(v, 100), k = s.toLowerCase().replace(/[ _()-]/g, '');
    if (['zh', 'ze', 'bg', 'chinese', 'chinesebgcode'].includes(k)) return '中文（简繁未标明）';
    if (['zhcn', 'chs', 'chinesesimplified', 'simplifiedchinese'].includes(k)) return '简体中文';
    if (['zhtw', 'cht', 'chinesebig5', 'chinesetraditional', 'traditionalchinese'].includes(k)) return '繁体中文';
    if (['en', 'english'].includes(k)) return '英语';
    if (['ja', 'jp', 'japanese'].includes(k)) return '日语';
    return s || '未知';
  }
  function matchesLanguage(value, filter) {
    if (!filter || filter === 'all') return true;
    const lang = language(value);
    return filter === 'zh' ? /中文|chinese/i.test(lang) : filter === 'en' ? lang === '英语' :
      filter === 'ja' ? lang === '日语' : false;
  }
  function packId(v) {
    return id(v.n_id ?? v.nId ?? v.id ?? String(v.url || '').match(/\/subtitle\/([A-Za-z0-9_-]+)(?:\.zip|\/|$)/)?.[1]);
  }
  function files(value) {
    return (Array.isArray(value.filelist) ? value.filelist : Array.isArray(value.unpack_files) ? value.unpack_files : [])
      .slice(0, 500).map(f => ({ name: clean(f.name, 700), format: A.format(f.name), size: String(f.size ?? ''),
        fileId: f.file_n_id == null ? '' : id(f.file_n_id), season: numeric(f.season), episode: numeric(f.episode),
        language: language(f.language), oversized: A.oversized(f.size), ...(f.url ? { url: downloadUrl(f.url) } : {}) }))
      .filter(f => f.name && f.format);
  }
  function summary(v, title) {
    const name = clean(v.release_name || v.name, 500), lang = language(v.language || v.lang);
    return { id: packId(v), source: 'subdl', kind: 'subtitle', sdId: titleId(title.sd_id),
      title: clean(title.name, 200), year: numeric(title.year), name: name || '字幕', language: lang,
      group: '', producer: '', uploader: clean(v.author || v.uploader, 200),
      release: A.release ? A.release({ filename: name }) : (/\bBD|BluRay/i.test(name) ? 'BD（文件名推断）' : /\bWEB/i.test(name) ? 'WEB（文件名推断）' : '版本未知'),
      uploaded: clean(v.upload_date || v.uploaded || v.created_at, 80), rating: Number.isFinite(v.rating) ? v.rating : null,
      subtype: '', machine: v.machine_translated === true || /machine|机翻/i.test(v.comment || ''),
      translationType: clean(v.comment, 500), season: numeric(v.season), episode: numeric(v.episode),
      fullSeason: v.full_season === true || Number(v.episode_end) > Number(v.episode_from),
      archiveUrl: v.url ? downloadUrl(v.url) : '', files: files(v).map(f => ({ ...f, language: f.language === '未知' ? lang : f.language })) };
  }
  async function search(key, q, fetcher = fetch) {
    const data = await request(key, 'movies/search', { q: query(q), type: 'tv', limit: 30 }, fetcher);
    if (!Array.isArray(data.results) || data.results.length > 30) fail('SUBDL_INVALID_RESPONSE');
    return data.results.map(v => ({ id: titleId(v.sd_id), sdId: titleId(v.sd_id), kind: 'title', source: 'subdl',
      name: clean(v.name, 500), originalName: clean(v.original_name, 200), year: numeric(v.year),
      imdbId: clean(v.imdb_id, 30), count: Number.isFinite(v.subtitles_count) ? v.subtitles_count : null,
      language: '', group: '', uploader: '', release: '', uploaded: '', rating: null, files: [] }));
  }
  async function subtitles(key, sdId, meta, fetcher = fetch) {
    const languages = { all: '', zh: 'ZH,ZE,BG', en: 'EN', ja: 'JA' };
    const filter = meta.searchLanguage || 'all', page = meta.searchPage ?? 1;
    if (!(filter in languages) || !Number.isInteger(page) || page < 1 || page > 10000) fail('SUBDL_INVALID_QUERY');
    const data = await request(key, 'subtitles/search', { sd_id: titleId(sdId), type: 'tv',
      season: numeric(meta.season), languages: languages[filter], page, unpack: 1, subs_per_page: 30 }, fetcher);
    if (!Array.isArray(data.results) || !Array.isArray(data.subtitles) || data.subtitles.length > 500) fail('SUBDL_INVALID_RESPONSE');
    const title = data.results.find(v => titleId(v.sd_id) === titleId(sdId));
    if (!title) { if (!data.subtitles.length) return []; fail('SUBDL_TITLE_CHANGED'); }
    const items = data.subtitles.map(v => ({ ...summary(v, title), searchPage: page, searchLanguage: filter }));
    items.hasMore = Number.isInteger(data.totalPages) && data.totalPages > page;
    return items;
  }
  async function detail(key, descriptor, fetcher = fetch) {
    const items = await subtitles(key, descriptor.sdId, { season: descriptor.season,
      searchPage: descriptor.searchPage, searchLanguage: descriptor.searchLanguage }, fetcher);
    const matches = items.filter(v => v.id === descriptor.id);
    if (matches.length !== 1) fail('SUBDL_FILE_CHANGED');
    return matches[0];
  }
  const archives = new Map();
  function scanZip(data, selected = '') {
    const entries = [], unzip = new self.fflate.Unzip(file => {
      if (entries.length >= 500) fail('SUBDL_ARCHIVE_TOO_LARGE');
      const entry = { name: file.name, format: A.format(file.name), size: file.originalSize, fileId: '' };
      if (file.originalSize > A.MAX_BYTES) entry.oversized = true;
      entries.push(entry);
      if (/\\|(^|\/)\.\.(\/|$)|^\//.test(entry.name) || entry.name.length > 700) fail('SUBDL_INVALID_ARCHIVE');
      if (!entry.format || entry.oversized || entry.name !== selected) return;
      const chunks = []; let size = 0;
      file.ondata = (e, part, final) => {
        if (e) fail('SUBDL_INVALID_ARCHIVE');
        size += part.length;
        if (size > A.MAX_BYTES) { file.terminate(); fail('SUBDL_ARCHIVE_TOO_LARGE'); }
        chunks.push(part);
        if (final) {
          entry.bytes = new Uint8Array(size);
          let at = 0; for (const part of chunks) { entry.bytes.set(part, at); at += part.length; }
        }
      };
      file.start();
    });
    unzip.register(self.fflate.UnzipInflate);
    try { for (let at = 0; at < data.length; at += 4096) unzip.push(data.subarray(at, at + 4096), at + 4096 >= data.length); }
    catch (e) { if (/^SUBDL_/.test(e.message)) throw e; fail('SUBDL_INVALID_ARCHIVE'); }
    const files = entries.filter(v => v.format);
    if (!files.length || selected && files.some(f => f.name === selected && !f.oversized && !f.bytes)) fail('SUBDL_INVALID_ARCHIVE');
    return files;
  }
  async function archive(value, fetcher, selected = '') {
    const url = downloadUrl(value.archiveUrl);
    if (!url.endsWith('.zip')) fail('SUBDL_UNSUPPORTED_FILE');
    const cached = archives.get(url);
    if (cached && cached.expires > Date.now()) return selected ? scanZip(cached.data, selected) : cached.files;
    const data = await downloadBytes(url, fetcher, 16 * 1024 * 1024);
    // Listing only reads ZIP metadata; inflate the explicitly selected episode, not the whole season.
    const files = scanZip(data);
    archives.clear(); archives.set(url, { data, files, expires: Date.now() + 120000 });
    return selected ? scanZip(data, selected) : files;
  }
  async function downloadBytes(url, fetcher, limit = A.MAX_BYTES) {
    return transport('DOWNLOAD', async () => {
      const r = await fetcher(downloadUrl(url), { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(45000) });
      if (!r.ok) fail(r.status === 429 ? 'SUBDL_RATE_LIMIT' : `SUBDL_DOWNLOAD_HTTP_${r.status}`);
      return A.readBytes(r, limit);
    });
  }
  async function expand(value, fetcher = fetch) {
    if (value.files.length) return value;
    const expanded = await archive(value, fetcher);
    return { ...value, files: expanded.map(({ bytes: _bytes, ...f }) => ({ ...f, size: String(f.size ?? ''), language: value.language })) };
  }
  async function download(value, filename, encoding = 'auto', fetcher = fetch, fileId = '') {
    const list = value.files.length ? value.files : (await expand(value, fetcher)).files;
    const matches = list.filter(f => f.name === filename && (!fileId || f.fileId === fileId));
    if (matches.length !== 1) fail('SUBDL_FILE_CHANGED');
    const file = matches[0];
    if (file.oversized) fail('SUBDL_FILE_TOO_LARGE');
    const bytes = file.url ? await downloadBytes(file.url, fetcher) :
      (await archive(value, fetcher, filename)).find(f => f.name === filename)?.bytes;
    if (!bytes) fail('SUBDL_FILE_CHANGED');
    const decoded = await transport('DOWNLOAD', async () => A.decode(bytes, encoding));
    if (/^\s*(?:<!doctype html|<html|<head)/i.test(decoded.text)) fail('SUBDL_INVALID_FILE');
    return { name: file.name, format: file.format, bytes: bytes.length, ...decoded,
      fileId: file.fileId || '', language: file.language || value.language, season: file.season, episode: file.episode };
  }
  self.CRSubFix.subdl = { ORIGINS, token, query, id, titleId, request, search, subtitles, detail, files: v => v.files,
    summary: v => v, download, expand, downloadUrl, language, matchesLanguage };
})();
