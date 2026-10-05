'use strict';
const { MSG } = self.CRSubFix.protocol;
const W = self.CRSubFix.workProfiles;
const { t } = self.CRSubFix.i18n;
const { bind } = self.CRSubFix.workI18n;
const el = id => document.getElementById(id);
const snapshotKey = new URL(location.href).searchParams.get('snapshot') || '';
let state, selected = null, dirty = false, busy = false;
let sampleTimer = null, samplePolls = 0, sampleStopped = false;
const messages = {
  WORK_CONTEXT_EXPIRED: () => t('播放页已切换、关闭或资料入口已过期。请从当前播放页重新打开作品资料。'),
  WORK_SUBTITLES_LOADING: () => t('本集字幕仍在补载，尚未调用 API，请等待字幕状态更新。'),
  WORK_NOT_IDENTIFIED: () => t('模型未能识别作品。请填写作品名后再决定是否重新生成，也可以手动保存资料。'),
  INVALID_WORK_PROFILE: () => t('资料格式无效。请检查长度及术语表；术语表最多 100 项，键和值均须为非空文本。'),
  INVALID_SERIES_URL: () => t('系列链接无效，需要 crunchyroll.com 的 /series/ 链接。'),
  WORK_CHANGED: () => t('资料已在其他窗口修改或删除。请刷新后重新核对。'),
  WORK_PROFILE_LIMIT: () => t('最多保存 40 份资料。请先删除不再使用的资料。'),
  WORK_BINDING_LIMIT: () => t('作品关联数量已达上限，请删除不再使用的资料。'),
  EMPTY_WORK_PROFILE: () => t('资料只有作品名，没有背景、风格或术语。请先整理资料，或明确确认只保存作品名。'),
  LOOKUP_EVIDENCE_EXPIRED: () => t('联网资料已过期或不完整。请重新查询并选择作品，再调用模型整理。'),
  ORGANIZE_LANGUAGE: () => t('联网资料整理目前只支持简体中文。'),
  ORGANIZE_TOO_LARGE: () => t('联网名称资料过长，请重新选择作品，只加载需要的角色页。'),
  KEY_REQUIRED: () => t('尚未配置 API Key，请先完成翻译设置。'),
  STREAM_RELAY_ONLY: () => t('生成候选资料需要自选中转 API，不支持 DeepL。'),
  HOST_PERMISSION_REQUIRED: () => t('服务地址未授权，请在翻译设置中重新保存并授权。'),
  BUSY: () => t('此播放页正在翻译或生成资料，请等待完成后再试。'),
  BUDGET_EXCEEDED: () => t('达到本播放页的每小时请求或字符上限。'),
  HTTP_401: () => t('接口鉴权失败，请检查翻译设置。'),
  HTTP_403: () => t('服务拒绝访问，请检查权限或额度。'),
  HTTP_429: () => t('服务限流或额度不足，不会自动重试。'),
  CONFIG_CHANGED: () => t('请求期间翻译配置已变更，请重新核对。'),
  INCOMPLETE_RESPONSE: () => t('模型未完整返回资料，已有确认资料未改变。'),
  TIMEOUT_UNKNOWN: () => t('请求超时，服务端可能已经计费，不会自动重试。'),
  NETWORK_UNKNOWN: () => t('网络请求失败，服务端可能已经计费，不会自动重试。'),
  REVIEW_CACHE_EXPIRED: () => t('译文缓存已过期或被清除，未修改字幕。'),
  REVIEW_INCOMPLETE: () => t('本集翻译尚未完成。请完成后再手动修正，避免覆盖正在返回的字幕。'),
  REVIEW_TEXT_CHANGED: () => t('这条译文已在其他窗口修改。请刷新本地记录后重新核对。'),
  REVIEW_CONTEXT_CHANGED: () => t('这份缓存的请求资料不一致，未继续调用 API。'),
  INVALID_REVIEW_INPUT: () => t('修正内容或字幕编号无效，请使用非空纯文本。'),
};
function status(message, error = false) {
  bind(el('status'), message);
  el('status').dataset.error = String(error);
}
function failure(e) { status(messages[e.message] || (() => t('操作未完成，已保存的资料未被草稿替换。')), true); }
function profileDraft() {
  let glossary;
  try { glossary = JSON.parse(el('glossary').value || '{}'); } catch (_) { throw new Error('INVALID_WORK_PROFILE'); }
  return W.profile({ title: el('title').value, aliases: el('aliases').value,
    context: el('context').value, tone: el('tone').value, glossary, glossarySources: lookupEditor.sources() });
}
function updateSummary() {
  try {
    const glossary = JSON.parse(el('glossary').value || '{}');
    const count = Object.keys(glossary).length;
    bind(el('save-summary'), () => t('{state}：{count} 项术语 · 背景{context} · 风格{tone}', {
      state: dirty ? t('待保存') : t('当前资料'), count,
      context: el('context').value.trim() ? t('已填写') : t('为空'),
      tone: el('tone').value.trim() ? t('已填写') : t('为空'),
    }));
  } catch (_) { bind(el('save-summary'), () => t('术语表 JSON 格式无效，无法保存。')); }
}
function markDirty() { dirty = true; bind(el('state'), () => t('有未保存的修改')); updateSummary(); }
async function send(type, payload = {}) {
  const result = await chrome.runtime.sendMessage({ type, payload: { ...payload, snapshot: snapshotKey } });
  if (!result?.ok) throw new Error(result?.error || 'BACKGROUND_UNAVAILABLE');
  return result;
}
function controls() {
  el('fields').disabled = busy;
  el('generate').disabled = busy || !state?.canGenerate || state?.snapshot?.subtitleState === 'loading';
  el('delete').disabled = busy || !selected;
  el('save').disabled = busy || (!state?.snapshot && !selected);
  el('series-url').disabled = !state?.snapshot;
  lookupEditor.controls();
  reviewEditor.controls();
}
function fillProfile(value, preserveLookup = false) {
  for (const k of ['title', 'aliases', 'context', 'tone']) el(k).value = value?.[k] || '';
  el('glossary').value = JSON.stringify(value?.glossary || {}, null, 2);
  if (preserveLookup) lookupEditor.saved(value);
  else lookupEditor.reset(value);
}
function select(key, preserveLookup = false) {
  selected = state.profiles.find(p => p.key === key) || null;
  fillProfile(selected || { title: state.snapshot?.hint.title || '' }, preserveLookup);
  el('profiles').value = selected?.key || '';
  const savedCount = selected && Object.keys(selected.glossary).length;
  bind(el('state'), () => selected ? t('已保存 · {count} 项术语', { count: savedCount }) : t('未保存'));
  el('target').textContent = selected?.target || state.target;
  el('draft-warning').hidden = true;
  dirty = false;
  updateSummary();
  controls();
}
function render(result, key = result.selected, preserveLookup = false) {
  state = result;
  const h = result.snapshot?.hint;
  bind(el('detected'), () => h?.title
    ? t('{title}（{evidence}，待核对）', { title: h.title,
      evidence: h.evidence === 'structured' ? t('页面结构化数据') : t('页面标题链接') })
    : h?.seriesId ? t('系列 {id}（待核对）', { id: h.seriesId }) : t('未可靠识别'));
  sampleCount();
  el('model').textContent = result.model;
  el('enabled').checked = result.enabled;
  el('series-url').value = h?.seriesId ? `https://www.crunchyroll.com/series/${h.seriesId}` : '';
  bind(el('scope'), () => h?.seriesId ? t('确认后按系列复用。') :
    result.snapshot ? t('未确认系列链接时，仅关联当前集。') : t('未关联播放页。'));
  el('profiles').replaceChildren(bind(new Option('', ''), () => t('新建资料')));
  for (const p of result.profiles.filter(p => !result.snapshot || p.target === result.target)) {
    const option = new Option(`${p.title} · ${p.target}`, p.key);
    option.setAttribute('data-i18n-ignore', '');
    el('profiles').add(option);
  }
  select(key, preserveLookup);
  watchSamples();
}
function sampleCount() {
  const snapshot = state?.snapshot;
  bind(el('sample-count'), () => !snapshot ? t('未关联播放页') :
    snapshot.subtitleState === 'loading' ? (sampleStopped ? t('字幕补载未完成，请从播放页重新打开；仍可手动编辑。') : t('正在补载本集字幕…')) :
    t('背景样本 {samples} 条 / 本地匹配 {corpus} 条', {
      samples: snapshot.samples.length, corpus: (snapshot.corpus || snapshot.samples).length,
    }) + (snapshot.subtitleState === 'unavailable' ? t('（未取得字幕；可手动编辑，或从播放页重新打开）') : ''));
}
function watchSamples() {
  clearTimeout(sampleTimer);
  if (sampleStopped || state?.snapshot?.subtitleState !== 'loading') return;
  sampleTimer = setTimeout(async () => {
    try {
      const result = await send(MSG.WORK_SNAPSHOT_GET);
      state.snapshot = result.snapshot;
      if (++samplePolls >= 20 && state.snapshot.subtitleState === 'loading') sampleStopped = true;
      sampleCount(); controls(); watchSamples();
    } catch (e) {
      sampleStopped = true;
      sampleCount(); controls(); failure(e);
    }
  }, 1500);
}
el('profiles').addEventListener('change', () => {
  const key = el('profiles').value;
  if (dirty && !confirm(t('放弃尚未保存的修改？'))) { el('profiles').value = selected?.key || ''; return; }
  select(key);
  const saved = !!selected;
  status(() => saved ? t('已载入确认资料。') : t('新建草稿，尚未参与翻译。'));
});
el('work-form').addEventListener('input', e => {
  if (e.target.id === 'profiles' || e.target.closest('#lookup-section')) return;
  markDirty();
});
el('series-url').addEventListener('input', () => {
  bind(el('scope'), () => W.route(el('series-url').value, 'series') ? t('确认后按系列复用。') : t('未确认系列链接时，仅关联当前集。'));
});
window.addEventListener('beforeunload', e => {
  if (dirty || busy || lookupEditor.hasPending() || reviewEditor.hasPending()) { e.preventDefault(); e.returnValue = ''; }
});
el('generate').addEventListener('click', async () => {
  if (busy || !state.canGenerate || state.snapshot?.subtitleState === 'loading') return;
  if (lookupEditor.hasSelection()) { await lookupEditor.organize(); return; }
  if (!confirm(t('将向当前中转模型 {model} 发送作品线索和开头字幕，生成一份候选资料，可能计费。当前编辑内容将被草稿替换，但已保存资料不变。继续？', { model: state.model }))) return;
  busy = true; controls(); status(() => t('正在生成候选资料…'));
  try {
    const result = await send(MSG.WORK_GENERATE, { title: el('title').value });
    fillProfile(result.draft);
    dirty = true;
    el('draft-warning').hidden = false;
    bind(el('state'), () => t('候选草稿'));
    updateSummary();
    status(() => t('候选资料已返回，尚未确认。'));
  } catch (e) { failure(e); }
  finally { busy = false; controls(); }
});
el('work-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (busy) return;
  try {
    const profile = profileDraft();
    if (!lookupEditor.beforeSave(profile)) return;
    const empty = !profile.context && !profile.tone && !Object.keys(profile.glossary).length;
    if (empty && !confirm(t('当前只有作品名，背景、对白风格和术语表全部为空。保存不会自动查询、生成或采用候选。仍然只保存作品名？'))) return;
    const seriesUrl = el('series-url').value.trim();
    if (seriesUrl && !W.route(seriesUrl, 'series')) throw new Error('INVALID_SERIES_URL');
    if (!confirm(t('确认作品名、人名、关系及无剧透内容均已核对？{binding}修改会影响使用此资料的后续翻译，但不会自动重译或调用 API。', {
      binding: state.snapshot ? t('当前播放作品将关联到这份资料。') : '',
    }))) return;
    busy = true; controls(); status(() => t('正在保存资料…'));
    const result = await send(MSG.WORK_SAVE, { key: selected?.key, revision: selected?.revision,
      profile, seriesUrl, enabled: el('enabled').checked, allowEmpty: empty });
    dirty = false;
    render(result, result.selected || selected?.key, true);
    status(() => t('资料已确认并保存：{count} 项术语。', { count: Object.keys(profile.glossary).length }) +
      (result.enabled ? t('未发起翻译请求。') : t('作品资料辅助翻译当前关闭。')) +
      (empty ? t('当前仅保存了作品名。') : ''));
  } catch (e) { failure(e); }
  finally { busy = false; controls(); }
});
el('delete').addEventListener('click', async () => {
  if (busy || !selected || !confirm(t('删除“{title}”及其作品关联？已翻译字幕保留。', { title: selected.title }))) return;
  busy = true; controls(); status(() => t('正在删除资料…'));
  try {
    const result = await send(MSG.WORK_DELETE, { key: selected.key, revision: selected.revision });
    dirty = false; render(result); status(() => t('资料已删除，未发起翻译请求。'));
  } catch (e) { failure(e); }
  finally { busy = false; controls(); }
});
const lookupEditor = self.CRSubFix.workLookupUI({
  el, state: () => state, busy: () => busy,
  setBusy: value => { busy = value; controls(); },
  send: payload => send(MSG.WORK_LOOKUP, payload),
  organize: payload => send(MSG.WORK_ORGANIZE, payload),
  profile: profileDraft, errorText: e => messages[e.message],
  warning: message => status(message, true), dirty: markDirty,
});
const reviewEditor = self.CRSubFix.workReviewUI({
  el, state: () => state, busy: () => busy, profile: profileDraft, dirty: markDirty, failure,
  load: () => send(MSG.WORK_REVIEW_GET), save: payload => send(MSG.WORK_REVIEW_SAVE, payload),
  errorText: e => messages[e.message] || (() => t('读取或保存本地核对记录失败，未调用翻译接口。')),
});
self.CRSubFix.i18n.ready.then(() => {
  self.CRSubFix.i18n.localize(document);
  return send(MSG.WORK_GET);
}).then(result => {
  render(result);
  status(() => result.snapshot ? t('作品线索已载入，尚未调用 API。') : t('已载入保存的资料。'));
  if (result.snapshot) reviewEditor.refresh();
}).catch(failure);
