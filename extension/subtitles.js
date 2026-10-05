(function () {
  'use strict';
  const { MSG } = self.CRSubFix.protocol;
  const el = id => document.getElementById(id);
  const I = self.CRSubFix.i18n, t = (source, params) => I.t(source, params);
  const labels = new Map();
  // Refresh labels in place so language changes never rebuild editable UI state.
  function ui(node, render, property = 'textContent') {
    node.setAttribute('data-i18n-ignore', '');
    if (!labels.has(node)) labels.set(node, new Map());
    labels.get(node).set(property, render);
    node[property] = render();
  }
  function refreshLabels() {
    for (const [node, properties] of labels) {
      if (!node.isConnected) { labels.delete(node); continue; }
      for (const [property, render] of properties) node[property] = render();
    }
  }
  const snapshot = new URL(location.href).searchParams.get('snapshot');
  I.localize(document);
  ui(el('selectedTitle'), () => t('文件'));
  ui(el('previewTitle'), () => t('字幕预览'));
  ui(el('status'), () => t('正在读取播放页…'));
  I.watch(() => { I.localize(document); refreshLabels(); });
  I.ready.then(() => { I.localize(document); refreshLabels(); });
  const errors = {
    ASSIST_NOT_CONFIGURED: '尚未配置可用分析 API；可使用本地识别，或在可选 AI 分析设置中配置中转 API。',
    ASSIST_FILES_EXPIRED: '文件列表已过期，请重新选择字幕目录后分析。', ASSIST_TOO_LARGE: '文件名列表过大，请缩小候选后分析。',
    ASSIST_INVALID_RESPONSE: '模型返回的分析结果无效，未应用；已有字幕和跟随设置保留。',
    ASSIST_INVALID_INPUT: '分析输入无效，请重新选择。', FOLLOW_MAP_INVALID: '集数对应有冲突，或混入不同版本；请核对集数、格式和所选文件。',
    OFFICIAL_NAMES_UNAVAILABLE: '暂未获取官方名称，当前名称和已有候选保留。',
    HOST_PERMISSION_REQUIRED: '尚未授权分析 API 地址，请保存并授权。', KEY_REQUIRED: '请填写完整 API Key。',
    INVALID_KEY: 'Key 文件或格式无效。', INVALID_BASE_URL: 'API 地址无效。', HTTPS_REQUIRED: 'API 地址需要 HTTPS。',
    MODEL_REQUIRED: '请填写模型名称。', CONFIG_CHANGED: 'API 配置已变化，本次分析未应用。', BUSY: '当前分析或翻译忙碌，请稍后重试。',
    JIMAKU_KEY_REQUIRED: '请先配置 Jimaku API Key。', JIMAKU_INVALID_KEY: 'Jimaku Key 格式无效，请复制完整 Key 或导入 TXT。',
    JIMAKU_PERMISSION_REQUIRED: '尚未授权 Jimaku 网络访问，请保存并授权。', JIMAKU_AUTH_FAILED: 'Jimaku 鉴权失败，请核对 Key。',
    JIMAKU_INVALID_QUERY: 'Jimaku 关键词需 2 至 200 个字符，或填写有效 AniList ID。', JIMAKU_INVALID_ID: 'Jimaku / AniList ID 无效。',
    JIMAKU_INVALID_RESPONSE: 'Jimaku 返回数据异常，已有字幕保留。', JIMAKU_SERVICE_ERROR: 'Jimaku 返回业务错误，未自动重试。',
    JIMAKU_RATE_LIMIT: 'Jimaku 按 IP 限流，请稍后手动重试；其他源与缓存不受影响。', JIMAKU_NOT_FOUND: 'Jimaku 条目或文件已删除，请重新搜索。',
    JIMAKU_API_TIMEOUT: 'Jimaku 接口超时，已有结果保留。', JIMAKU_API_NETWORK: 'Jimaku 接口连接失败，未自动重试。',
    JIMAKU_DOWNLOAD_TIMEOUT: 'Jimaku 下载超时，可稍后重新预览。', JIMAKU_DOWNLOAD_NETWORK: 'Jimaku 文件服务器连接失败。',
    JIMAKU_DOWNLOAD_UNSAFE: '文件链接不属于所选 Jimaku 目录的安全 HTTPS 地址，已阻止下载。',
    JIMAKU_FILE_CHANGED: 'Jimaku 文件已变化或存在重名，请重新选择。', JIMAKU_SELECTION_EXPIRED: '请重新搜索并确认 Jimaku 目录。',
    JIMAKU_TITLE_CHANGED: 'Jimaku 返回目录 ID 与选择不一致，已停止加载。',
    JIMAKU_UNSUPPORTED_FILE: '仅独立 ASS/SRT/SSA/VTT 可在线加载；ZIP 可在浏览器下载、解压后本地上传。',
    JIMAKU_FILE_TOO_LARGE: 'Jimaku 文件超过 8 MiB 在线加载上限，可下载后本地上传。',
    JIMAKU_INVALID_FILE: 'Jimaku 文件没有有效字幕，请核对编码。', JIMAKU_DECODE_FAILED: 'Jimaku 字幕解码失败，请更换编码。',
    EXTERNAL_INVALID_SOURCE: '字幕源无效，请重新打开外部字幕页。',
    SUBDL_KEY_REQUIRED: '请先配置 SubDL API Key。', SUBDL_INVALID_KEY: 'SubDL Key 格式无效，请从 API 页面复制或导入。',
    SUBDL_PERMISSION_REQUIRED: '尚未授权 SubDL 网络访问，请在 SubDL 连接设置中保存并授权。',
    SUBDL_AUTH_FAILED: 'SubDL 鉴权失败，请核对 API Key。', SUBDL_INVALID_QUERY: 'SubDL 关键词应为 2 至 200 个字符。',
    SUBDL_RATE_LIMIT: 'SubDL 请求或下载额度已受限，请稍后手动重试。assrt 和缓存播放不受影响。',
    SUBDL_SERVICE_ERROR: 'SubDL 返回业务错误，未自动重试。', SUBDL_INVALID_RESPONSE: 'SubDL 返回数据格式异常，未自动重试。',
    SUBDL_HTTP_502: 'SubDL 暂时不可用（HTTP 502），可切换 assrt。', SUBDL_HTTP_503: 'SubDL 暂时不可用（HTTP 503），可切换 assrt。',
    SUBDL_API_TIMEOUT: 'SubDL 接口超时，已有结果和字幕保留，请稍后手动重试。',
    SUBDL_API_NETWORK: 'SubDL 接口连接失败，可切换 assrt；未自动重试。',
    SUBDL_DOWNLOAD_TIMEOUT: 'SubDL 下载超时，请稍后再次下载预览。', SUBDL_DOWNLOAD_NETWORK: 'SubDL 文件服务器连接失败，可在浏览器中打开文件检查。',
    SUBDL_DOWNLOAD_UNSAFE: '下载链接不属于允许的 SubDL HTTPS 字幕地址。', SUBDL_DOWNLOAD_HTTP_403: 'SubDL 拒绝文件下载，请重新搜索或换一个候选。',
    SUBDL_FILE_CHANGED: 'SubDL 文件列表已变化或文件名重复，请重新选择候选。', SUBDL_SELECTION_EXPIRED: 'SubDL 候选尚未确认或已过期，请重新搜索作品并选择。',
    SUBDL_TITLE_CHANGED: 'SubDL 返回的作品 ID 与所选作品不一致，已停止加载。',
    SUBDL_UNSUPPORTED_FILE: 'SubDL 未提供可加载的独立字幕或 ZIP 包，可下载后本地上传。',
    SUBDL_FILE_TOO_LARGE: 'SubDL 单文件超过在线加载上限。请换较小文件，或下载后本地上传。',
    SUBDL_INVALID_FILE: 'SubDL 文件中没有有效字幕，请核对编码或更换候选。', SUBDL_DECODE_FAILED: '字幕解码失败，请更换编码。',
    SUBDL_INVALID_ARCHIVE: 'SubDL ZIP 包无效或包含不安全路径，已停止解压。', SUBDL_ARCHIVE_TOO_LARGE: 'SubDL ZIP 包展开后超出安全上限，请下载后选择单集本地上传。',
    FOLLOW_METADATA_REQUIRED: '请先填写可靠的季和当前集数，作品系列 ID 也必须已识别。',
    FOLLOW_FILENAME_UNCLEAR: '所选文件集数与当前集不一致，或命名无法安全匹配。请核对后加载；特别篇需手动选择。',
    ASSRT_KEY_REQUIRED: '请先配置 assrt Token。', ASSRT_INVALID_KEY: 'Token 无效，应是 32 位字母或数字。',
    ASSRT_PERMISSION_REQUIRED: '尚未授权 assrt 网络访问，请在连接设置中保存并授权。',
    ASSRT_HTTP_PERMISSION_REQUIRED: '旧服务器 HTTP 下载尚未授权，请在连接设置中重新勾选并授权。',
    ASSRT_INVALID_QUERY: '关键词应为 3 至 200 个字符。', ASSRT_SERVICE_ERROR: 'assrt 返回业务错误，未自动重试。',
    ASSRT_INVALID_RESPONSE: 'assrt 响应格式异常，未自动重试。', ASSRT_RATE_LIMIT: '请求过于频繁，请稍后手动重试。',
    ASSRT_NOT_FOUND: '字幕条目不存在或已删除，请重新搜索。',
    ASSRT_HTTP_401: 'assrt 鉴权失败，请核对 Token。', ASSRT_HTTP_403: 'assrt 拒绝访问，请核对账号权限。',
    ASSRT_HTTP_502: 'assrt 暂时不可用（HTTP 502），请稍后手动重试。已下载字幕不受影响。',
    ASSRT_HTTP_503: 'assrt 暂时不可用（HTTP 503），请稍后手动重试。已下载字幕不受影响。',
    ASSRT_DOWNLOAD_HTTP_403: '下载链接已过期或服务拒绝访问，请重新下载预览。',
    ASSRT_DOWNLOAD_UNSAFE: '下载链接不在允许的 assrt HTTPS 域名内。',
    ASSRT_FILE_CHANGED: '文件列表已变化或存在重名，请重新选择候选。',
    ASSRT_UNSUPPORTED_FILE: '此文件不是独立 ASS/SRT/SSA/VTT 字幕。可下载后解压并使用播放器本地上传。',
    ASSRT_INVALID_FILE: '没有找到有效字幕，可能不是字幕文件或编码错误。',
    ASSRT_DECODE_FAILED: '无法解码，请更换编码后再次预览。',
    ASSRT_FILE_TOO_LARGE: '所选文件超过 8 MiB 在线加载上限（不是网络超时）。可在浏览器中打开文件，或换同集较小的字幕版本。',
    ASSRT_DETAIL_TIMEOUT: '获取最新文件详情超时，尚未开始下载。请稍后再次点击下载并预览，无需重新搜索。',
    ASSRT_DETAIL_NETWORK: '获取最新文件详情连接失败，尚未开始下载。请检查 assrt 网络连接后再次点击下载并预览。',
    ASSRT_SEARCH_TIMEOUT: 'assrt 搜索超时，未自动重试。已有搜索结果和字幕未清除，请稍后重试。',
    ASSRT_SEARCH_NETWORK: 'assrt 搜索连接失败，未自动重试。请检查网络后重试。',
    ASSRT_API_TIMEOUT: 'assrt 接口请求超时，请稍后重试。',
    ASSRT_API_NETWORK: 'assrt 接口连接失败，请检查网络后重试。',
    ASSRT_DOWNLOAD_TIMEOUT: '详情已获取，但字幕文件下载超时。请稍后再次点击下载并预览，将重新获取有效链接。',
    ASSRT_DOWNLOAD_NETWORK: '详情已获取，但扩展无法连接 assrt 文件服务器。请点击“在浏览器中打开文件”检查浏览器的具体错误；此错误与文件大小限制无关。',
    EXTERNAL_CONTEXT_EXPIRED: '原播放页已关闭、切集或会话过期，请从当前播放页重新打开外部字幕。',
    EXTERNAL_FILE_EXPIRED: '缓存文件已过期，请重新下载并预览。',
    EXTERNAL_CACHE_FULL: '字幕无法放入有限缓存，可改用播放器本地上传。',
    EXTERNAL_CACHE_SAVE_FAILED: '本地缓存保存失败或空间不足；现有译文未清理，可改用播放器本地上传。',
    EXTERNAL_TIME_UNAVAILABLE: '当前播放页还没有可用的视频时间。',
    EXTERNAL_APPLY_FAILED: '字幕未能加载到播放器，请刷新播放页后重新打开外部字幕。',
    EXTERNAL_INVALID_SYNC: '同步参数无效：倍率需为 0.5 至 2，偏移需在 ±3600 秒内。',
    PERMISSION_DENIED: '未授予网络权限，Token 未保存。',
    NETWORK_UNKNOWN: '网络连接失败，未自动重试。', TIMEOUT_UNKNOWN: '请求超时，未自动重试。',
  };
  let metadata = {}, busy = false, expired = false, result = null, chosen = null, preview = null;
  let seriesOffset = null, marks = {}, cuePage = 0;
  let followRule = null;
  let titleResults = null, cachedSearches = [];
  const sourceOf = item => item?.source || 'assrt';
  const sourceLabel = source => ({ assrt: 'assrt', subdl: 'SubDL', jimaku: 'Jimaku' })[source] || source;
  const fileId = () => el('files').selectedOptions[0]?.dataset.fileId || '';
  const assist = self.CRSubFix.subtitleAssistUI.init({ el, send, run, status, metadata: currentMetadata,
    chosen: () => chosen, fileId, invalidatePreview: () => { preview = null; el('previewSection').hidden = true; } });
  function showFollow(rule) {
    followRule = rule;
    ui(el('followInfo'), () => rule ? t('已跟随 {source} 合集 {id} · 第 {season} 季', { source: sourceLabel(sourceOf(rule)), id: rule.subId, season: rule.season }) +
      (Number.isFinite(rule.offset) ? t(' · 后续集偏移 {offset} 秒', { offset: rule.offset }) : '') : '');
    el('viewFollow').hidden = el('stopFollow').hidden = !rule;
    el('followCollection').checked = !!rule;
    el('inheritOffset').checked = Number.isFinite(rule?.offset);
    showSeriesOffset();
  }
  function showSeriesOffset() {
    ui(el('seriesInfo'), () => Number.isFinite(followRule?.offset)
      ? t('合集默认偏移：{offset} 秒', { offset: followRule.offset })
      : seriesOffset ? t('系列偏移建议：{offset} 秒（未自动应用）', { offset: seriesOffset.offset.toFixed(1) }) : t('暂无系列偏移建议'));
    el('useSeries').hidden = !seriesOffset;
  }
  function status(text, error = false) { ui(el('status'), typeof text === 'function' ? text : () => t(text)); el('status').dataset.error = String(error); }
  async function send(type, payload = {}) {
    const value = await chrome.runtime.sendMessage({ type, payload: { snapshot, source: el('source').value, ...payload } });
    if (!value?.ok) {
      const error = new Error(value?.error || 'BACKGROUND_UNAVAILABLE');
      error.retryAfter = value?.retryAfter;
      throw error;
    }
    return value;
  }
  function failure(error) {
    if (error.message === 'EXTERNAL_CONTEXT_EXPIRED') expired = true;
    const net = error.message.match(/^ASSRT_DOWNLOAD_(ERR_[A-Z0-9_]{1,100})$/)?.[1];
    status(() => {
      const reason = net === 'ERR_BLOCKED_BY_CLIENT' ? t('可能被广告拦截或安全扩展阻止') :
        /ERR_CERT_|ERR_SSL_/.test(net) ? t('TLS 或证书验证失败，请勿关闭证书校验') :
        net === 'ERR_NAME_NOT_RESOLVED' ? t('下载域名解析失败') :
        /ERR_(CONNECTION|TIMED_OUT|NETWORK)/.test(net) ? t('下载服务器连接异常') : t('浏览器拒绝了下载请求');
      const known = t(errors[error.message] || error.message);
      const message = net ? t('字幕下载失败（{code}）：{reason}。可点击“在浏览器中打开文件”进一步检查。', { code: net, reason }) :
        (errors[error.message] || Object.values(errors).includes(error.message) || known !== error.message) ? known : t('操作失败：{reason}', { reason: /^[A-Z0-9_]+$/.test(error.message) ? error.message : t('网络异常') });
      return message + (error.retryAfter ? t(' 约 {n} 秒后可重试。', { n: error.retryAfter }) : '');
    }, true);
  }
  function controls() {
    refreshLabels();
    assist.controls();
    el('followCollection').disabled = busy || expired;
    el('inheritOffset').disabled = busy || expired || !el('followCollection').checked;
    el('httpDownload').disabled = busy || expired;
    el('identity').disabled = busy || expired;
    el('searchControls').disabled = busy || expired;
    document.querySelectorAll('#settings button, #subdlSettings button, #jimakuSettings button, #assistSettings button, #fileSection button, #previewSection button, #results button')
      .forEach(b => { b.disabled = busy || expired; });
    if (!busy && !expired) assist.controls();
    el('previous').disabled = busy || expired || !result || result.pos === 0;
    el('next').disabled = busy || expired || !result || result.hasMore === false ||
      result.source !== 'subdl' && result.items.length < 15;
    el('cuePrevious').disabled = busy || expired || cuePage === 0;
    el('cueNext').disabled = busy || expired || (cuePage + 1) * 50 >= filteredCues().length;
  }
  async function run(task) {
    if (busy || expired) return;
    busy = true; controls();
    try { await task(); } catch (error) { failure(error); }
    finally { busy = false; controls(); }
  }
  function config(value) {
    el('httpDownload').checked = value.httpDownloads === true;
    ui(el('connection'), () => t(value.hasKey ? (value.authorized ? '· 已配置' : '· 需授权') : '· 未配置'));
    if (!value.hasKey || !value.authorized) el('settings').open = true;
    ui(el('subdlConnection'), () => t(value.subdl?.hasKey ? (value.subdl.authorized ? '· 已配置' : '· 需授权') : '· 未配置'));
    if (el('source').value === 'subdl' && (!value.subdl?.hasKey || !value.subdl.authorized)) el('subdlSettings').open = true;
    ui(el('jimakuConnection'), () => t(value.jimaku?.hasKey ? (value.jimaku.authorized ? '· 已配置' : '· 需授权') : '· 未配置'));
    if (el('source').value === 'jimaku' && (!value.jimaku?.hasKey || !value.jimaku.authorized)) el('jimakuSettings').open = true;
  }
  function sourceControls() {
    const subdl = el('source').value === 'subdl', jimaku = el('source').value === 'jimaku';
    el('fileModeLabel').hidden = subdl || jimaku; el('subdlLanguageLabel').hidden = !subdl;
    el('jimakuAnilistLabel').hidden = el('jimakuFallback').hidden = !jimaku;
    el('query').minLength = subdl || jimaku ? 2 : 3;
    el('query').required = !jimaku || !el('jimakuAnilist').value;
    el('backTitles').hidden = !subdl || !titleResults || !result?.subtitleList;
  }
  function currentMetadata() {
    return { ...metadata, title: el('title').value.trim(), englishTitle: el('englishTitle').value.trim(),
      season: el('season').value, episode: el('episode').value };
  }
  function keywords() {
    const m = currentMetadata();
    const names = [...new Set([m.englishTitle, m.title, ...(m.aliases || [])].filter(Boolean))];
    const suffix = m.episode ? ` ${m.season ? `S${String(m.season).padStart(2, '0')}` : ''}E${String(m.episode).padStart(2, '0')}` : '';
    el('keywords').replaceChildren(...names.flatMap(name => [name + suffix, name]).filter((v, i, a) => a.indexOf(v) === i)
      .map(v => new Option(v, v)));
  }
  function fillIdentity(value) {
    metadata = value;
    for (const key of ['title', 'englishTitle', 'season', 'episode']) el(key).value = value[key] ?? '';
    ui(el('episodeInfo'), () => [value.episodeTitle, t('播放 ID：{id}', { id: value.guid }),
      value.seriesId ? t('系列 ID：{id}', { id: value.seriesId }) : t('未识别系列 ID'), value.episode == null ? t('集数未识别') : ''].filter(Boolean).join(' · '));
    keywords();
    assist.names(value);
    el('query').value = assist.defaultQuery();
  }
  function restoreSearch(value) {
    el('jimakuAnilist').value = value.source === 'jimaku' ? value.anilistId || '' : '';
    el('query').value = value.anilistId ? metadata.englishTitle || metadata.title || '' : value.query;
    el('fileMode').checked = value.fileMode;
    renderResults({ ...value, cached: true });
  }
  function renderResults(value) {
    result = value;
    if (value.source === 'subdl' && value.subtitleList && value.searchLanguage) el('subdlLanguage').value = value.searchLanguage;
    sourceControls();
    const items = value.source === 'subdl' && value.subtitleList ? value.items.filter(item =>
      el('subdlLanguage').value === 'all' || el('subdlLanguage').value === 'zh' && /中文|chinese/i.test(item.language) ||
      el('subdlLanguage').value === 'en' && /英语|english/i.test(item.language) || el('subdlLanguage').value === 'ja' && /日语|japanese/i.test(item.language)) : value.items;
    el('results').replaceChildren();
    ui(el('resultInfo'), () => t('{source} · {query} · {n} 项{page} · {cache} · {time}', {
      source: sourceLabel(sourceOf(value)), query: value.query, n: items.length,
      page: value.subtitleList ? t(' / 第 {n} 页', { n: value.searchPage || 1 }) : '',
      cache: t(value.cached ? '缓存' : '联网'), time: new Date(value.at).toLocaleString(document.documentElement.lang) }));
    if (!items.length) {
      const p = document.createElement('p'); p.className = 'muted'; ui(p, () => t(value.items.length ? '当前返回的候选没有所选语言。' : '没有候选结果。'));
      el('results').append(p);
    }
    for (const item of items) {
      const row = document.createElement('article'); row.className = 'candidate';
      if (chosen?.id === item.id && sourceOf(chosen) === sourceOf(item)) row.classList.add('selected');
      const text = document.createElement('div'), title = document.createElement('strong'), info = document.createElement('p');
      ui(title, () => item.name || item.videoName || t('字幕 {id}', { id: item.id }));
      info.className = 'muted';
      ui(info, () => item.kind === 'title' || item.kind === 'directory' ? [item.originalName, item.romajiName, item.year, item.imdbId,
        item.anilistId ? `AniList ${item.anilistId}` : '', item.uploaded, item.language, item.translationType,
        item.count == null ? '' : t('{n} 份字幕', { n: item.count })].filter(Boolean).join(' · ') : [sourceLabel(sourceOf(item)), item.title || '',
        item.season ? t('第 {n} 季', { n: item.season }) : '', item.fullSeason ? t('整季合集') : item.episode ? t('第 {n} 集', { n: item.episode }) : '',
        item.language, item.group || item.producer || t('字幕组未提供'), item.uploader || t('上传者未提供'),
        item.subtype || [...new Set(item.files.map(f => f.format).filter(Boolean))].join('/') || t('格式未提供'),
        item.release, item.uploaded || t('上传时间未提供'), item.rating == null ? t('评分未提供') : t('评分 {n}', { n: item.rating }),
        item.translationType].filter(Boolean).join(' · '));
      text.append(title, info);
      if (item.machine) { const p = document.createElement('p'); p.className = 'warning'; ui(p, () => t('机器翻译标记')); text.append(p); }
      const b = document.createElement('button'); b.type = 'button'; ui(b, () => t(item.kind === 'title' ? '查看字幕' : '查看文件'));
      b.addEventListener('click', () => run(() => choose(item)));
      const actions = document.createElement('div'); actions.className = 'row'; actions.append(b);
      if (item.source === 'subdl' && item.kind === 'subtitle') {
        const download = document.createElement('button'); download.type = 'button'; ui(download, () => t('下载 ZIP'));
        ui(download, () => t('在浏览器中下载原始合集'), 'title');
        download.addEventListener('click', () => run(async () => {
          await send(MSG.EXTERNAL_DOWNLOAD_OPEN, { source: 'subdl', id: item.id, archive: true });
          status(() => t('已在浏览器中打开原始 ZIP 下载链接。'));
        }));
        actions.append(download);
      }
      row.append(text, actions); el('results').append(row);
    }
    if (value.source === 'subdl' && value.hasMore) {
      const p = document.createElement('p'); p.className = 'muted'; ui(p, () => t('还有下一页字幕候选。')); el('results').append(p);
    }
    controls();
  }
  async function search(pos = 0, refresh = false, listing = false) {
    if (listing && result?.source === 'subdl' && result.subtitleList) return choose({ kind: 'title', source: 'subdl',
      id: result.titleId, name: result.query }, Math.floor(pos / 30) + 1, refresh);
    status(() => t('正在搜索候选…'));
    const value = await send(MSG.EXTERNAL_SEARCH, { metadata: currentMetadata(), query: el('query').value,
      pos, refresh, fileMode: el('fileMode').checked, anilistId: el('source').value === 'jimaku' ? el('jimakuAnilist').value : null });
    renderResults(value);
    if (value.source === 'subdl') titleResults = value;
    sourceControls();
    status(() => t(value.items.length ? '请选择字幕候选和当前集文件。' : '未找到字幕，可换用英文名、罗马字或去掉季集号。'));
  }
  async function choose(item, searchPage = 1, refresh = false) {
    status(() => t('正在读取文件列表…'));
    const source = sourceOf(item);
    const value = await send(MSG.EXTERNAL_DETAIL, { id: item.id, source, kind: item.kind, metadata: currentMetadata(),
      searchPage, searchLanguage: el('subdlLanguage').value, refresh });
    if (value.items) {
      chosen = null; preview = null; el('fileSection').hidden = el('previewSection').hidden = true;
      renderResults({ ...value, source: 'subdl', query: item.name || el('query').value, pos: value.pos || 0,
        at: value.at || Date.now(), cached: value.cached === true, subtitleList: true });
      status(() => t(value.items.length ? '请选择字幕版本。' : '该作品与当前季没有返回字幕候选。')); return;
    }
    chosen = value.item; preview = null; el('previewSection').hidden = true;
    chosen.source = source;
    ui(el('selectedTitle'), () => value.item.name || t('字幕文件'));
    if (value.nameState) assist.names(currentMetadata(), value.nameState);
    assist.setFiles(value.files, followRule);
    const first = value.files.find(f => f.format);
    el('fileSection').hidden = false;
    if (result) renderResults(result);
    status(() => t(first ? '请核对文件名中的集数、语言和 WEB/BD 版本，再下载预览。' : '没有独立字幕文件，请下载解压后使用播放器本地上传。'));
  }
  function formatTime(seconds) {
    const sign = seconds < 0 ? '-' : '';
    const ms = Math.round(Math.abs(seconds) * 1000);
    return `${sign}${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  }
  function timing() {
    const offset = Number(el('offset').value), scale = Number(el('scale').value);
    if (!el('offset').value || !el('scale').value || !Number.isFinite(offset) || Math.abs(offset) > 3600 ||
        !Number.isFinite(scale) || scale < .5 || scale > 2) throw new Error('EXTERNAL_INVALID_SYNC');
    return scale === 1 && offset === 0 ? { mode: 'none' } : { mode: 'linear', scale, offset };
  }
  function setTiming(sync) {
    el('offset').value = sync?.mode === 'linear' ? String(Math.round(sync.offset * 1000) / 1000) : '0';
    el('scale').value = sync?.mode === 'linear' ? String(sync.scale) : '1';
  }
  const filteredCues = () => (preview?.cues || []).map((cue, index) => ({ ...cue, index }))
    .filter(c => c.text.toLowerCase().includes(el('filter').value.toLowerCase()));
  function renderCues() {
    if (!preview) return;
    const rows = filteredCues();
    cuePage = Math.min(cuePage, Math.max(0, Math.ceil(rows.length / 50) - 1));
    let sync; try { sync = timing(); } catch (_) { return; }
    el('cues').replaceChildren();
    for (const cue of rows.slice(cuePage * 50, cuePage * 50 + 50)) {
      const tr = document.createElement('tr');
      for (const text of [String(cue.index + 1), formatTime(cue.start),
        formatTime(cue.start * (sync.scale || 1) + (sync.offset || 0)), cue.text]) {
        const td = document.createElement('td'); td.setAttribute('data-i18n-ignore', ''); td.textContent = text; tr.append(td);
      }
      const td = document.createElement('td'), buttons = document.createElement('div'); buttons.className = 'mark-buttons';
      for (const letter of ['A', 'B']) {
        const b = document.createElement('button'); b.type = 'button';
        ui(b, () => t(marks[letter]?.index === cue.index ? '已标 {point}' : '标记 {point}', { point: letter }));
        ui(b, () => t('将本条起始时间标记为播放页当前时间 {point}', { point: letter }), 'title');
        b.addEventListener('click', () => run(() => mark(letter, cue))); buttons.append(b);
      }
      td.append(buttons); tr.append(td); el('cues').append(tr);
    }
    ui(el('cueInfo'), () => t('{n} 条 · 第 {page} / {pages} 页', { n: rows.length, page: cuePage + 1, pages: Math.max(1, Math.ceil(rows.length / 50)) }));
    controls();
  }
  async function mark(letter, cue) {
    const value = await send(MSG.EXTERNAL_TIME);
    const next = { ...marks, [letter]: { index: cue.index, raw: cue.start, time: value.time } };
    let sync;
    if (next.A && next.B) {
      if (Math.abs(next.B.raw - next.A.raw) < 1) throw new Error('EXTERNAL_INVALID_SYNC');
      const scale = (next.B.time - next.A.time) / (next.B.raw - next.A.raw);
      sync = { mode: 'linear', scale, offset: next.A.time - next.A.raw * scale };
    } else {
      const point = next[letter]; sync = { mode: 'linear', scale: 1, offset: point.time - point.raw };
    }
    if (sync.scale < .5 || sync.scale > 2 || Math.abs(sync.offset) > 3600) throw new Error('EXTERNAL_INVALID_SYNC');
    marks = next; setTiming(sync); markInfo(); renderCues();
    status(() => t('同步点已更新，尚未加载到播放器。'));
  }
  function markInfo() {
    ui(el('marks'), () => Object.entries(marks).map(([k, v]) =>
      t('{point}：第 {n} 条 {raw} → {time}', { point: k, n: v.index + 1, raw: formatTime(v.raw), time: formatTime(v.time) })).join(' · ') || t('未标记同步点'));
  }
  function showPreview(value, lang) {
    preview = value; marks = {}; cuePage = 0; el('filter').value = '';
    setTiming(value.sync); markInfo();
    ui(el('previewTitle'), () => value.name);
    ui(el('previewInfo'), () => t('{n} 条 · {encoding} · {bytes} 字节 · {cache}', { n: value.count, encoding: value.encoding, bytes: value.bytes, cache: t(value.cached ? '本地缓存' : '已下载') }));
    const detected = [
      /简|simplified|chs/i.test(value.language) ? 'zh-CN' : '',
      /繁|traditional|big5|cht/i.test(value.language) ? 'zh-TW' : '',
      /日|jap/i.test(value.language) ? 'ja-JP' : '',
      /英|eng/i.test(value.language) ? 'en-US' : '',
    ].filter(Boolean);
    el('language').value = lang !== undefined ? lang : detected.length === 1 ? detected[0] : '';
    el('previewSection').hidden = false; renderCues();
  }
  el('searchForm').addEventListener('submit', event => { event.preventDefault(); run(() => search()); });
  el('refresh').addEventListener('click', () => run(() => search(result?.query === el('query').value ? result.pos : 0, true,
    result?.subtitleList === true && result.query === el('query').value)));
  el('previous').addEventListener('click', () => run(() => search(Math.max(0, result.pos - (result.subtitleList ? 30 : 15)), false, true)));
  el('next').addEventListener('click', () => run(() => search(result.pos + (result.subtitleList ? 30 : 15), false, true)));
  el('source').addEventListener('change', () => {
    chosen = preview = result = titleResults = null; el('fileSection').hidden = el('previewSection').hidden = true;
    el('results').replaceChildren(); ui(el('resultInfo'), () => t('尚未搜索')); sourceControls();
    el('jimakuAnilist').value = '';
    el('query').value = assist.defaultQuery();
    const saved = cachedSearches.filter(v => sourceOf(v) === el('source').value).at(-1);
    if (saved) restoreSearch(saved);
    sourceControls();
    const source = sourceLabel(el('source').value);
    status(() => t('已切换到 {source}。', { source })); controls();
  });
  el('subdlLanguage').addEventListener('change', () => {
    if (result?.source === 'subdl' && result.subtitleList) run(() => search(0, false, true));
    else if (result) renderResults(result);
  });
  el('backTitles').addEventListener('click', () => { if (titleResults) renderResults(titleResults); });
  el('jimakuAnilist').addEventListener('input', sourceControls);
  el('query').addEventListener('input', () => {
    if (el('query').value.trim()) el('jimakuAnilist').value = '';
    sourceControls();
  });
  for (const id of ['title', 'englishTitle', 'season', 'episode']) el(id).addEventListener('change', () => { keywords(); assist.names(currentMetadata()); });
  el('saveKey').addEventListener('click', () => {
    if (!/^[A-Za-z0-9]{32}$/.test(el('key').value.trim())) { failure(new Error('ASSRT_INVALID_KEY')); return; }
    // Request permission directly in the user gesture, before any awaited work.
    const grant = chrome.permissions.request({ origins: ['https://*.assrt.net/*'] });
    run(async () => {
      if (!await grant) throw new Error('PERMISSION_DENIED');
      config(await send(MSG.EXTERNAL_SAVE_KEY, { source: 'assrt', key: el('key').value.trim() }));
      el('key').value = ''; el('settings').open = false; status(() => t('Token 已保存在本机扩展设置中。'));
    });
  });
  el('clearKey').addEventListener('click', () => run(async () => {
    config(await send(MSG.EXTERNAL_CLEAR_KEY, { source: 'assrt' })); el('key').value = ''; status(() => t('已清除 Token，已下载字幕缓存保留。'));
  }));
  el('keyFile').addEventListener('change', () => run(async () => {
    const file = el('keyFile').files[0]; el('keyFile').value = '';
    if (!file || file.size > 16384) throw new Error('ASSRT_INVALID_KEY');
    const values = [...(await file.text()).matchAll(/(?<![A-Za-z0-9])[A-Za-z0-9]{32}(?![A-Za-z0-9])/g)];
    if (values.length !== 1) throw new Error('ASSRT_INVALID_KEY');
    el('key').value = values[0][0]; status(() => t('已读取 Token，尚未保存。'));
  }));
  el('quota').addEventListener('click', () => run(async () => {
    const v = await send(MSG.EXTERNAL_QUOTA, { source: 'assrt' });
    status(() => t('当前剩余请求额度：{n}。', { n: v.quota ?? t('服务未提供') }));
  }));
  el('subdlSaveKey').addEventListener('click', () => {
    const key = el('subdlKey').value.trim();
    if (!/^[A-Za-z0-9_-]{8,200}$/.test(key)) { failure(new Error('SUBDL_INVALID_KEY')); return; }
    const grant = chrome.permissions.request({ origins: ['https://api.subdl.com/*', 'https://dl.subdl.com/*'] });
    run(async () => {
      if (!await grant) throw new Error('PERMISSION_DENIED');
      config(await send(MSG.EXTERNAL_SAVE_KEY, { source: 'subdl', key })); el('subdlKey').value = '';
      el('subdlSettings').open = false; status(() => t('SubDL Key 已保存在本机扩展设置中。'));
    });
  });
  el('subdlClearKey').addEventListener('click', () => run(async () => {
    config(await send(MSG.EXTERNAL_CLEAR_KEY, { source: 'subdl' })); el('subdlKey').value = ''; status(() => t('已清除 SubDL Key，字幕缓存与 assrt 设置保留。'));
  }));
  el('subdlKeyFile').addEventListener('change', () => run(async () => {
    const file = el('subdlKeyFile').files[0]; el('subdlKeyFile').value = '';
    if (!file || file.size > 16384) throw new Error('SUBDL_INVALID_KEY');
    const key = (await file.text()).trim();
    if (!/^[A-Za-z0-9_-]{8,200}$/.test(key)) throw new Error('SUBDL_INVALID_KEY');
    el('subdlKey').value = key; status(() => t('已读取 SubDL Key，尚未保存。'));
  }));
  el('subdlQuota').addEventListener('click', () => run(async () => {
    const v = await send(MSG.EXTERNAL_QUOTA, { source: 'subdl' });
    status(() => t('SubDL 剩余搜索：{searches}；剩余下载：{downloads}。', { searches: v.searches ?? t('服务未提供'), downloads: v.downloads ?? t('服务未提供') }));
  }));
  el('jimakuSaveKey').addEventListener('click', () => {
    const key = el('jimakuKey').value.trim();
    if (!/^[\x21-\x7e]{8,512}$/.test(key)) { failure(new Error('JIMAKU_INVALID_KEY')); return; }
    const grant = chrome.permissions.request({ origins: ['https://jimaku.cc/*'] });
    run(async () => {
      if (!await grant) throw new Error('PERMISSION_DENIED');
      config(await send(MSG.EXTERNAL_SAVE_KEY, { source: 'jimaku', key })); el('jimakuKey').value = '';
      el('jimakuSettings').open = false; status(() => t('Jimaku Key 已保存在本机扩展设置中。'));
    });
  });
  el('jimakuClearKey').addEventListener('click', () => run(async () => {
    config(await send(MSG.EXTERNAL_CLEAR_KEY, { source: 'jimaku' })); el('jimakuKey').value = '';
    status(() => t('已清除 Jimaku Key，其他源设置和字幕缓存保留。'));
  }));
  el('jimakuKeyFile').addEventListener('change', () => run(async () => {
    const file = el('jimakuKeyFile').files[0]; el('jimakuKeyFile').value = '';
    if (!file || file.size > 16384) throw new Error('JIMAKU_INVALID_KEY');
    const key = (await file.text()).trim();
    if (!/^[\x21-\x7e]{8,512}$/.test(key)) throw new Error('JIMAKU_INVALID_KEY');
    el('jimakuKey').value = key; status(() => t('已读取 Jimaku Key，尚未保存。'));
  }));
  el('jimakuRate').addEventListener('click', () => run(async () => {
    const { rate } = await send(MSG.EXTERNAL_QUOTA, { source: 'jimaku' });
    status(() => rate ? t('最近请求限额：{remaining} / {limit} · {time}（非每日下载额度）。', { remaining: rate.remaining ?? t('未提供'), limit: rate.limit ?? t('未提供'), time: new Date(rate.at).toLocaleString(document.documentElement.lang) }) : t('尚无 Jimaku 请求限额记录。'));
  }));
  el('preview').addEventListener('click', () => run(async () => {
    status(() => t('正在下载并解析字幕…'));
    showPreview(await send(MSG.EXTERNAL_PREVIEW, { source: sourceOf(chosen), id: chosen.id, fileId: fileId(), filename: el('files').value, encoding: el('encoding').value, refresh: true }));
    status(() => t('预览已就绪，尚未加载到播放器。'));
  }));
  el('openDownload').addEventListener('click', () => run(async () => {
    if (!chosen) return;
    status(() => t('正在获取新的文件下载链接…'));
    await send(MSG.EXTERNAL_DOWNLOAD_OPEN, { source: sourceOf(chosen), id: chosen.id, fileId: fileId(), filename: el('files').value });
    status(() => t('已在新标签页打开文件。下载成功后可通过播放器 Manage → Load subtitle file… 加载。'));
  }));
  el('httpDownload').addEventListener('change', () => {
    const enabled = el('httpDownload').checked;
    const grant = enabled ? chrome.permissions.request({ origins: ['http://*.assrt.net/*'] }) : Promise.resolve(true);
    run(async () => {
      try {
        if (!await grant) throw new Error('ASSRT_HTTP_PERMISSION_REQUIRED');
        config(await send(MSG.EXTERNAL_SET_HTTP, { enabled }));
        status(() => t(enabled ? '已允许旧服务器 HTTP 字幕下载：传输未加密，字幕可能被篡改。API Token 仍仅通过 HTTPS 发送。' : '已关闭 HTTP 字幕下载。'));
      } catch (error) { el('httpDownload').checked = !enabled; throw error; }
    });
  });
  for (const id of ['files', 'encoding']) el(id).addEventListener('change', () => {
    preview = null; el('previewSection').hidden = true;
    if (id === 'files') assist.fileChanged();
  });
  for (const [id, delta] of [['minus', -.1], ['plus', .1]]) el(id).addEventListener('click', () => {
    try { const t = timing(); setTiming({ mode: 'linear', scale: t.scale || 1, offset: Math.round(((t.offset || 0) + delta) * 10) / 10 }); renderCues(); }
    catch (error) { failure(error); }
  });
  el('reset').addEventListener('click', () => { setTiming({ mode: 'none' }); marks = {}; markInfo(); renderCues(); });
  el('clearMarks').addEventListener('click', () => { marks = {}; markInfo(); renderCues(); });
  for (const id of ['offset', 'scale']) el(id).addEventListener('change', renderCues);
  el('filter').addEventListener('input', () => { cuePage = 0; renderCues(); });
  el('cuePrevious').addEventListener('click', () => { cuePage--; renderCues(); });
  el('cueNext').addEventListener('click', () => { cuePage++; renderCues(); });
  el('useSeries').addEventListener('click', () => { setTiming({ mode: 'linear', scale: 1, offset: seriesOffset.offset }); renderCues(); });
  el('apply').addEventListener('click', () => run(async () => {
    status(() => t('正在加载字幕到播放器…'));
    const currentTiming = timing();
    const value = await send(MSG.EXTERNAL_APPLY, { key: preview.key, sync: currentTiming, lang: el('language').value,
      rememberOffset: el('remember').checked, metadata: currentMetadata(), follow: el('followCollection').checked,
      inheritOffset: el('inheritOffset').checked, collectionMap: assist.collectionMap() });
    if (el('remember').checked) seriesOffset = { offset: currentTiming.mode === 'linear' ? currentTiming.offset : 0 };
    if (value.followRule) showFollow(value.followRule);
    showSeriesOffset();
    status(() => t('已加载到当前播放页，文件选择和同步已保存。'));
  }));
  el('viewFollow').addEventListener('click', () => run(() => choose({ id: followRule.subId, source: sourceOf(followRule) })));
  async function stopFollow() {
    await send(MSG.EXTERNAL_FOLLOW_CLEAR, { metadata: currentMetadata(), season: followRule?.season });
    showFollow(null); status(() => t('已停止跟随，当前字幕保留。'));
  }
  el('stopFollow').addEventListener('click', () => run(stopFollow));
  el('followCollection').addEventListener('change', () => {
    if (!el('followCollection').checked) el('inheritOffset').checked = false;
    if (!el('followCollection').checked && followRule) run(stopFollow);
    controls();
  });
  (async () => {
    busy = true; controls();
    try {
      await I.ready;
      const value = await send(MSG.EXTERNAL_GET);
      cachedSearches = value.cachedSearches;
      titleResults = value.cachedSearches.filter(v => v.source === 'subdl' && !v.subtitleList).at(-1) || null;
      config(value); fillIdentity(value.metadata); seriesOffset = value.seriesOffset;
      assist.names(value.metadata, value.nameState);
      el('query').value = assist.defaultQuery();
      assist.config(await send(MSG.EXTERNAL_ASSIST_CONFIG));
      showFollow(value.followRule);
      el('remember').disabled = !metadata.seriesId;
      const last = value.cachedSearches.filter(search => !value.selected || sourceOf(search) === sourceOf(value.selected)).at(-1);
      if (last) {
        el('source').value = sourceOf(last);
        restoreSearch(last);
      }
      if (value.selected) {
        const selected = value.selected;
        chosen = { id: selected.subId, name: selected.filename, source: sourceOf(selected) };
        el('source').value = sourceOf(selected); sourceControls();
        if (!last) el('query').value = assist.defaultQuery();
        ui(el('selectedTitle'), () => selected.filename);
        assist.setFiles(value.collectionFiles?.length ? value.collectionFiles : [{ name: selected.filename,
          fileId: selected.fileId || '', format: selected.filename.match(/\.(ass|ssa|srt|vtt)$/i)?.[1].toUpperCase() || '' }],
          value.followRule, { name: selected.filename, fileId: selected.fileId || '' });
        el('encoding').value = selected.requestedEncoding || 'auto';
        el('fileSection').hidden = false;
        showPreview(await send(MSG.EXTERNAL_PREVIEW, { source: sourceOf(selected), id: selected.subId, fileId: selected.fileId, filename: selected.filename, encoding: selected.requestedEncoding }), selected.lang);
      }
      status(() => t(value.selected ? '已载入本集所选字幕缓存。' : '请核对作品与集数，再搜索字幕。'));
    } catch (error) { failure(error); }
    finally { busy = false; controls(); }
  })();
})();
