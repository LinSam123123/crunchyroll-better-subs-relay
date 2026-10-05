(function () {
  'use strict';
  const fail = code => { throw new Error(code); };
  const clean = (value, max = 300) => typeof value === 'string' ? value.slice(0, max).trim() : '';
  const displayText = (value, max = 300) => clean(value, max).replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>');
  const id = value => /^\d{1,12}$/.test(String(value)) ? String(value) : fail('ASSRT_INVALID_ID');
  const HOST = 'https://api.assrt.net';
  const ORIGINS = ['https://*.assrt.net/*'];
  const HTTP_ORIGINS = ['http://*.assrt.net/*'];
  const MAX_BYTES = 8 * 1024 * 1024;
  async function transport(stage, operation) {
    try { return await operation(); }
    catch (error) {
      if (/^ASSRT_[A-Z0-9_]+$/.test(error?.message || '')) throw error;
      fail(`ASSRT_${stage}_${['TimeoutError', 'AbortError'].includes(error?.name) ? 'TIMEOUT' : 'NETWORK'}`);
    }
  }
  function oversized(size) {
    const m = String(size ?? '').trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|KiB|MiB|GiB)?$/i);
    if (!m) return false;
    const unit = (m[2] || 'B').toUpperCase();
    const power = { B: 0, KB: 1, KIB: 1, MB: 2, MIB: 2, GB: 3, GIB: 3 }[unit];
    // Use the smaller decimal multiplier for ambiguous units, avoiding false rejection.
    return Number(m[1]) * (unit.includes('I') ? 1024 : 1000) ** power > MAX_BYTES;
  }
  function token(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9]{32}$/.test(value.trim())) fail('ASSRT_INVALID_KEY');
    return value.trim();
  }
  function query(value) {
    const q = clean(value, 201);
    if (q.length < 3 || q.length > 200) fail('ASSRT_INVALID_QUERY');
    return q;
  }
  async function readBytes(response, max) {
    const size = Number(response.headers?.get('content-length'));
    if (size > max) fail('ASSRT_FILE_TOO_LARGE');
    if (!response.body?.getReader) {
      const data = new Uint8Array(await response.arrayBuffer());
      if (data.length > max) fail('ASSRT_FILE_TOO_LARGE');
      return data;
    }
    const reader = response.body.getReader(), chunks = [];
    let total = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.length;
        if (total > max) fail('ASSRT_FILE_TOO_LARGE');
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const data = new Uint8Array(total);
    let pos = 0;
    for (const chunk of chunks) { data.set(chunk, pos); pos += chunk.length; }
    return data;
  }
  async function request(key, endpoint, params = {}, fetcher = fetch) {
    const url = new URL(HOST + '/v1/' + endpoint);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
    const headers = { Authorization: `Bearer ${token(key)}`, Accept: 'application/json' };
    const stage = endpoint === 'sub/detail' ? 'DETAIL' : endpoint === 'sub/search' ? 'SEARCH' : 'API';
    return transport(stage, async () => {
    const response = await fetcher(url.href, {
      headers,
      credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) fail(response.status === 429 ? 'ASSRT_RATE_LIMIT' : `ASSRT_HTTP_${response.status}`);
    const raw = new TextDecoder().decode(await readBytes(response, 2 * 1024 * 1024));
    let data;
    try { data = JSON.parse(raw); } catch (_) { fail('ASSRT_INVALID_RESPONSE'); }
    if (!data || data.status !== 0) {
      const code = Number(data?.status);
      if (code === 30900) fail('ASSRT_RATE_LIMIT');
      if ([1, 20001].includes(code)) fail('ASSRT_INVALID_KEY');
      if (code === 20900) fail('ASSRT_NOT_FOUND');
      if (code === 101) fail('ASSRT_INVALID_QUERY');
      fail('ASSRT_SERVICE_ERROR');
    }
    return data;
    });
  }
  const format = name => (String(name || '').match(/\.(ass|ssa|srt|vtt)(?:$|[?#])/i)?.[1] || '').toUpperCase();
  function language(value) {
    return clean(value?.lang?.desc, 100) || displayText(value?.m_lang, 100) || '未知';
  }
  function release(value) {
    const name = [value.native_name, value.videoname, value.filename, value.sub_name].join(' ');
    if (/\b(?:WEB(?:[- .]?DL|RIP)?|CR|AMZN|NETFLIX)\b/i.test(name)) return 'WEB（文件名推断）';
    if (/\b(?:BD(?:RIP)?|BLU[- .]?RAY)\b/i.test(name)) return 'BD（文件名推断）';
    return '版本未知';
  }
  function summary(value) {
    return {
      id: id(value.id ?? value.fileid), name: clean(value.native_name || value.title || value.filename || value.sub_name, 500),
      videoName: clean(value.videoname, 500), language: language(value),
      group: clean(value.release_site, 200), uploader: clean(value.producer?.uploader, 200),
      producer: clean(value.producer?.producer, 200) || displayText(value.m_contributor, 200),
      translationType: clean(value.producer?.source, 100) || displayText(value.m_source, 100),
      subtype: displayText(value.m_subtype, 100) || (/^\d+$/.test(String(value.subtype)) ? '' : clean(value.subtype, 100)),
      release: release(value), uploaded: clean(value.upload_time || value.uploadtime, 80),
      rating: Number.isFinite(value.vote_score) ? value.vote_score :
        (value.score != null && value.score !== '' && Number.isFinite(Number(value.score)) ? Number(value.score) : null),
      machine: value.vote_machine_translate === true || Number(value.vote_machine_translate) > 0 ||
        /机器|机翻|machine/i.test(value.producer?.source || value.m_source || ''),
      revision: clean(String(value.revision ?? ''), 50),
      files: Array.isArray(value.filelist) ? value.filelist.slice(0, 500).map(f => ({
        name: clean(f.f, 700), size: clean(String(f.s ?? ''), 60), format: format(f.f),
      })).filter(f => f.name) : [],
    };
  }
  async function search(key, q, pos = 0, fileMode = false, fetcher = fetch) {
    if (!Number.isInteger(pos) || pos < 0 || pos > 300) fail('ASSRT_INVALID_QUERY');
    const data = await request(key, 'sub/search', {
      q: query(q), pos, cnt: 15, ...(fileMode ? { is_file: 1, no_muxer: 1 } : {}),
    }, fetcher);
    const results = data.sub?.subs;
    if (data.sub?.result === 'succeed' && (results === null ||
        (results && !Array.isArray(results) && typeof results === 'object' && !Object.keys(results).length))) return [];
    if (!Array.isArray(results) || results.length > 15) fail('ASSRT_INVALID_RESPONSE');
    return results.map(summary);
  }
  async function detail(key, subId, fetcher = fetch) {
    const data = await request(key, 'sub/detail', { id: id(subId) }, fetcher);
    const value = data.sub?.subs?.find(s => String(s.id ?? s.fileid) === String(subId));
    if (!value) fail('ASSRT_INVALID_RESPONSE');
    return value;
  }
  function downloadUrl(raw, allowHttp = false) {
    let u;
    try { u = new URL(raw); } catch (_) { fail('ASSRT_DOWNLOAD_UNSAFE'); }
    if (!/^(?:file\d*|api)\.assrt\.net$/i.test(u.hostname) || u.username || u.password || u.port ||
        !['https:', 'http:'].includes(u.protocol)) fail('ASSRT_DOWNLOAD_UNSAFE');
    // Keep TLS by default. Only explicit consent permits the API's original HTTP file URL.
    if (u.protocol === 'http:' && allowHttp === true) {
      if (!/^file\d*\.assrt\.net$/i.test(u.hostname)) fail('ASSRT_DOWNLOAD_UNSAFE');
    } else u.protocol = 'https:';
    return u.href;
  }
  function files(value) {
    const list = Array.isArray(value.filelist) && value.filelist.length
      ? value.filelist.map(f => ({ name: clean(f.f, 700), size: clean(String(f.s ?? ''), 60), url: f.url }))
      : [{ name: clean(value.filename || value.sub_name, 700), size: clean(String(value.size ?? ''), 60), url: value.url }];
    return list.slice(0, 500).map(f => ({ ...f, format: format(f.name), oversized: oversized(f.size) })).filter(f => f.name);
  }
  function decode(bytes, encoding = 'auto') {
    if (!['auto', 'utf-8', 'gb18030', 'big5', 'shift_jis', 'utf-16le', 'utf-16be'].includes(encoding)) fail('ASSRT_INVALID_ENCODING');
    let selected = encoding;
    if (encoding === 'auto') {
      if (bytes[0] === 0xff && bytes[1] === 0xfe) selected = 'utf-16le';
      else if (bytes[0] === 0xfe && bytes[1] === 0xff) selected = 'utf-16be';
      else {
        try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' }; }
        catch (_) { selected = 'gb18030'; }
      }
    }
    try { return { text: new TextDecoder(selected, { fatal: true }).decode(bytes), encoding: selected }; }
    catch (_) { fail('ASSRT_DECODE_FAILED'); }
  }
  async function download(value, filename, encoding = 'auto', fetcher = fetch, allowHttp = false) {
    const matches = files(value).filter(f => f.name === filename);
    if (matches.length !== 1) fail('ASSRT_FILE_CHANGED');
    const file = matches[0];
    if (!file.format) fail('ASSRT_UNSUPPORTED_FILE');
    if (file.oversized) fail('ASSRT_FILE_TOO_LARGE');
    const url = downloadUrl(file.url, allowHttp);
    const errors = self.chrome?.webRequest?.onErrorOccurred;
    let netError = '', observing = false;
    const observe = details => {
      if (details.url === url && /^net::ERR_[A-Z0-9_]{1,100}$/.test(details.error || '')) netError = details.error.slice(5);
    };
    try {
      if (errors) { errors.addListener(observe, { urls: [new URL(url).origin + '/*'] }); observing = true; }
    } catch (_) { /* Network error observation is optional; fetch still works without it. */ }
    try {
      return await transport('DOWNLOAD', async () => {
        try {
          const response = await fetcher(url, {
            credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30000),
          });
          if (!response.ok) fail(`ASSRT_DOWNLOAD_HTTP_${response.status}`);
          const bytes = await readBytes(response, MAX_BYTES);
          // A HTML error page must not enter the subtitle parser as if it were a file.
          const result = decode(bytes, encoding);
          if (/^\s*(?:<!doctype html|<html|<head)/i.test(result.text)) fail('ASSRT_INVALID_FILE');
          return { name: file.name, format: file.format, bytes: bytes.length, ...result };
        } catch (error) {
          if (netError && !/^ASSRT_/.test(error?.message || '') && !['TimeoutError', 'AbortError'].includes(error?.name))
            fail(`ASSRT_DOWNLOAD_${netError}`);
          throw error;
        }
      });
    } finally { if (observing) errors.removeListener(observe); }
  }
  self.CRSubFix = self.CRSubFix || {};
  self.CRSubFix.assrt = { HOST, ORIGINS, HTTP_ORIGINS, MAX_BYTES, token, query, id, request, search, detail, summary, files,
    download, downloadUrl, decode, readBytes, format, oversized };
})();
