(function () {
  'use strict';
  const A = self.CRSubFix.assrt, fail = code => { throw new Error(code); };
  const ORIGINS = ['https://jimaku.cc/*'];
  const clean = (v, n = 200) => typeof v === 'string' ? v.trim().slice(0, n) : '';
  const id = v => /^[1-9]\d{0,11}$/.test(String(v)) ? String(v) : fail('JIMAKU_INVALID_ID');
  function token(v) {
    if (typeof v !== 'string' || !/^[\x21-\x7e]{8,512}$/.test(v.trim())) fail('JIMAKU_INVALID_KEY');
    return v.trim();
  }
  function query(v) {
    if (typeof v !== 'string' || v.trim().length < 2 || v.trim().length > 200) fail('JIMAKU_INVALID_QUERY');
    return v.trim();
  }
  let rate = null;
  function responseRate(r) {
    const number = key => {
      const raw = r.headers?.get(key), n = Number(raw);
      return raw !== null && raw !== undefined && raw !== '' && Number.isFinite(n) && n >= 0 ? n : null;
    };
    return { limit: number('x-ratelimit-limit'), remaining: number('x-ratelimit-remaining'),
      reset: number('x-ratelimit-reset'), resetAfter: number('x-ratelimit-reset-after'), at: Date.now() };
  }
  function status(r, stage) {
    const current = responseRate(r);
    if (['limit', 'remaining', 'reset', 'resetAfter'].some(key => current[key] !== null)) rate = current;
    if (r.status === 429) {
      const e = new Error('JIMAKU_RATE_LIMIT');
      e.retryAfter = Math.min(86400, Math.max(1, Math.ceil(current.resetAfter ||
        Number(r.headers?.get('retry-after')) || (current.reset > Date.now() / 1000 ? current.reset - Date.now() / 1000 : 60))));
      throw e;
    }
    if (!r.ok) fail(stage === 'API' && [401, 403].includes(r.status) ? 'JIMAKU_AUTH_FAILED' :
      r.status === 404 ? 'JIMAKU_NOT_FOUND' : `JIMAKU_${stage}_HTTP_${r.status}`);
  }
  async function transport(stage, fn) {
    try { return await fn(); } catch (e) {
      if (/^JIMAKU_[A-Z0-9_]+$/.test(e?.message || '')) throw e;
      if (/^ASSRT_/.test(e?.message || '')) fail(e.message.replace(/^ASSRT_/, 'JIMAKU_'));
      fail(`JIMAKU_${stage}_${['AbortError', 'TimeoutError'].includes(e?.name) ? 'TIMEOUT' : 'NETWORK'}`);
    }
  }
  async function request(key, endpoint, params = {}, fetcher = fetch) {
    if (!/^(?:entries\/search|entries\/[1-9]\d{0,11}(?:\/files)?)$/.test(endpoint)) fail('JIMAKU_INVALID_QUERY');
    const url = new URL('https://jimaku.cc/api/' + endpoint);
    Object.entries(params).filter(([, v]) => v != null && v !== '').forEach(([k, v]) => url.searchParams.set(k, String(v)));
    return transport('API', async () => {
      const r = await fetcher(url.href, { headers: { Authorization: token(key), Accept: 'application/json',
        'X-Client-Id': 'BetterSubsPrivateRelay/2.7.0.29' }, credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30000) });
      status(r, 'API');
      let data;
      try { data = JSON.parse(new TextDecoder().decode(await A.readBytes(r, 4 * 1024 * 1024))); }
      catch (e) { if (/^ASSRT_/.test(e.message)) throw e; fail('JIMAKU_INVALID_RESPONSE'); }
      if (!data || data.error) fail('JIMAKU_SERVICE_ERROR');
      return data;
    });
  }
  function downloadUrl(raw, entryId, name) {
    let u, decoded;
    try {
      u = new URL(raw, 'https://jimaku.cc');
      decoded = decodeURIComponent(u.pathname);
    } catch (_) { fail('JIMAKU_DOWNLOAD_UNSAFE'); }
    const prefix = `/entry/${id(entryId)}/download/`, filename = decoded.slice(prefix.length);
    if (u.origin !== 'https://jimaku.cc' || u.username || u.password || u.search || u.hash ||
      !decoded.startsWith(prefix) || !filename || filename.length > 700 || /[\\/\x00-\x1f\x7f]/.test(filename) ||
      filename === '.' || filename === '..' || name != null && filename !== name) fail('JIMAKU_DOWNLOAD_UNSAFE');
    return u.href;
  }
  function entry(v) {
    if (!v || typeof v.name !== 'string' || !v.name.trim() || typeof v.flags !== 'object' || !v.flags) fail('JIMAKU_INVALID_RESPONSE');
    return { id: id(v.id), source: 'jimaku', kind: 'directory', name: clean(v.english_name || v.name, 500),
      originalName: clean(v.japanese_name), englishName: clean(v.english_name), romajiName: clean(v.name), anilistId: v.anilist_id == null ? null : id(v.anilist_id),
      language: '日语（文件待核对）', group: '', uploader: '', release: '', uploaded: clean(v.last_modified, 80), rating: null,
      translationType: v.flags.unverified ? '目录未经站方核验' : '', external: v.flags.external === true, files: [] };
  }
  async function search(key, q, options = {}, fetcher = fetch) {
    const params = options.anilistId ? { anime: true, anilist_id: id(options.anilistId) } : { anime: true, query: query(q) };
    const data = await request(key, 'entries/search', params, fetcher);
    if (!Array.isArray(data) || data.length > 500) fail('JIMAKU_INVALID_RESPONSE');
    return data.map(entry);
  }
  function file(v, entryId) {
    if (!v || typeof v.name !== 'string' || !v.name || v.name.length > 700 || /[\\/\x00-\x1f\x7f]/.test(v.name) ||
      !Number.isSafeInteger(v.size) || v.size < 0) fail('JIMAKU_INVALID_RESPONSE');
    const name = v.name, format = A.format(name);
    const marked = /(?:^|[ ._\[(-])(en|eng|english|ja|jp|jpn|japanese|chs|cht|zh-cn|zh-tw)(?=[ ._\[\])\-]|$)/i.exec(name)?.[1]?.toLowerCase();
    const language = ['en', 'eng', 'english'].includes(marked) ? '英语' : ['ja', 'jp', 'jpn', 'japanese'].includes(marked) ? '日语' :
      ['chs', 'zh-cn'].includes(marked) ? '简体中文' : ['cht', 'zh-tw'].includes(marked) ? '繁体中文' : '未确定';
    return { name, format, size: String(v.size), fileId: name, language,
      uploaded: clean(v.last_modified, 80), oversized: A.oversized(v.size), url: downloadUrl(v.url, entryId, name) };
  }
  async function detail(key, entryId, fetcher = fetch) {
    entryId = id(entryId);
    const value = entry(await request(key, `entries/${entryId}`, {}, fetcher));
    if (value.id !== entryId) fail('JIMAKU_TITLE_CHANGED');
    const list = await request(key, `entries/${entryId}/files`, {}, fetcher);
    if (!Array.isArray(list) || list.length > 1000) fail('JIMAKU_INVALID_RESPONSE');
    return { ...value, files: list.map(v => file(v, entryId)) };
  }
  async function download(value, filename, encoding = 'auto', fetcher = fetch, fileId = '') {
    const matches = value.files.filter(f => f.name === filename && (!fileId || f.fileId === fileId));
    if (matches.length !== 1) fail('JIMAKU_FILE_CHANGED');
    const f = matches[0];
    if (!f.format) fail('JIMAKU_UNSUPPORTED_FILE');
    if (f.oversized) fail('JIMAKU_FILE_TOO_LARGE');
    return transport('DOWNLOAD', async () => {
      const r = await fetcher(downloadUrl(f.url, value.id, filename), { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(45000) });
      status(r, 'DOWNLOAD');
      const bytes = await A.readBytes(r, A.MAX_BYTES), decoded = A.decode(bytes, encoding);
      if (/^\s*(?:<!doctype html|<html|<head)/i.test(decoded.text)) fail('JIMAKU_INVALID_FILE');
      return { name: f.name, format: f.format, fileId: f.fileId, language: f.language, bytes: bytes.length, ...decoded };
    });
  }
  function detectLanguage(cues, hint) {
    if (hint !== '未确定') return hint;
    const text = cues.slice(0, 1000).map(c => c.text).filter(Boolean);
    const kana = text.filter(t => /[\u3041-\u309f\u30a1-\u30ff]/.test(t));
    const count = kana.reduce((n, t) => n + (t.match(/[\u3041-\u309f\u30a1-\u30ff]/g) || []).length, 0);
    return count >= 12 && kana.length >= text.length * 0.25 ? '日语（字符推断）' : '未确定';
  }
  self.CRSubFix.jimaku = { ORIGINS, id, token, query, request, search, detail, download, downloadUrl,
    summary: v => v, files: v => v.files, rate: () => rate, detectLanguage };
})();
