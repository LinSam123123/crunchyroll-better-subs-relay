'use strict';
const { MSG } = self.CRSubFix.protocol;
const R = self.CRSubFix.relay;
const el = id => document.getElementById(id);
const errors = {
  INVALID_MODE: '翻译模式无效。',
  INVALID_GLOSSARY: '术语表应是 JSON 对象，键和值为非空文本；最多 200 项，每项不超过 200 字符。',
  STREAM_NOT_SUPPORTED: '接口未返回 SSE 流，请核对协议或切换分批模式。',
  STREAM_INVALID_JSONL: '模型未按逐条 JSON 格式返回字幕。已收到的完整条目会保留。',
  STREAM_FIRST_TIMEOUT: '等待首次文本输出超时；服务端可能已经计费。',
  STREAM_IDLE_TIMEOUT: '流式输出长时间没有新文本；已完成字幕会保留。',
  STREAM_TOTAL_TIMEOUT: '达到 15 分钟流式请求安全上限。',
  STREAM_PROVIDER_ERROR: '服务商返回流式错误。',
  STREAM_ITEMS_PENDING: '流式输出已结束，但部分条目无有效译文。完整字幕已保留；播放页 Retry 只请求缺失条目。',
  KEY_REQUIRED: '请输入 API Key。更换服务商或域名后需重新输入密钥。',
  INVALID_KEY: '密钥包含空白字符或过长，请检查。',
  MODEL_REQUIRED: '请填写有效的模型 ID。',
  INVALID_BASE_URL: 'Base URL 无效，不支持用户名、密码、查询参数或片段。',
  BASE_URL_NOT_ENDPOINT: 'Base URL 应是接口前缀，例如 /v1，不包含 /chat/completions 或 /responses。',
  HTTPS_REQUIRED: '远程服务必须使用 HTTPS；仅 localhost 和 127.0.0.1 支持 HTTP。',
  INVALID_LIMITS: '请求限制超出范围。',
  HOST_PERMISSION_REQUIRED: '尚未授权访问服务地址。请再次保存并允许授权。',
  PERMISSION_DENIED: '未授予网络权限，设置未保存。',
  SECURE_STORAGE_UNAVAILABLE: '无法隔离密钥存储，请更新浏览器。',
  TIMEOUT_UNKNOWN: '请求超时，服务端可能已经计费。请检查模型速度或减少批量条数。',
  NETWORK_UNKNOWN: '连接失败，可能已经计费。请检查地址、网络或重定向。',
  INVALID_RESPONSE: '返回格式不兼容，请核对模型和接口协议。',
  ID_MISMATCH: '模型返回的字幕条目不完整，请减少每批条数或更换模型。',
  ITEM_COUNT_MISMATCH: '模型返回的字幕条数不符。',
  DUPLICATE_ITEM_ID: '模型返回了重复的字幕编号。',
  INVALID_ITEM_ID: '模型返回了无效的字幕编号。',
  INVALID_ITEM_TEXT: '模型返回了空白或无效的译文。',
  INCOMPLETE_RESPONSE: '模型返回未完成，请减少每批条数。',
  CONFIG_CHANGED: '测试过程中配置已更改，请重新测试。',
  HTTP_401: '鉴权失败，请检查密钥。',
  HTTP_403: '服务拒绝访问，请检查权限或余额。',
  HTTP_404: '未找到接口或模型，请检查 Base URL、协议和模型 ID。',
  HTTP_429: '服务限流或额度不足，请稍后手动重试。',
  BUDGET_EXCEEDED: '达到每小时测试请求安全上限，请稍后再试。',
  BUSY: '后台正在处理其他请求，请稍后再试。',
};
const labels = { 'zh-CN': '简体中文', 'zh-TW': '繁体中文', 'en-US': '英语（美国）', 'en-GB': '英语（英国）',
  'ja-JP': '日语', 'ko-KR': '韩语', 'de-DE': '德语', 'es-419': '西班牙语（拉美）', 'es-ES': '西班牙语',
  'fr-FR': '法语', 'pt-BR': '葡萄牙语（巴西）', 'pt-PT': '葡萄牙语（葡萄牙）', 'it-IT': '意大利语', 'ru-RU': '俄语' };
el('source').add(new Option('自动选择', ''));
for (const [code, label] of Object.entries(labels)) {
  el('source').add(new Option(code === 'ja-JP' ? '英语（日语音轨）' : label, code));
  el('target').add(new Option(label, code));
}
let busy = false;
let savedState = null;
function status(text, error = false) {
  el('status').textContent = text;
  el('status').dataset.error = String(error);
}
function failure(e) {
  const message = e.message === 'INCOMPLETE_RESPONSE' && el('translationMode').value === 'episode-stream'
    ? '流式输出未完整结束，请核对接口和模型的输出限制。不会自动重发请求。'
    : errors[e.message] || `操作失败：${/^[A-Z0-9_]+$/.test(e.message) ? e.message : '请重试'}`;
  status(message, true);
}
async function send(type, payload) {
  const res = await chrome.runtime.sendMessage({ type, payload });
  if (!res?.ok) throw new Error(res?.error || 'BACKGROUND_UNAVAILABLE');
  return res;
}
function providerVisibility() {
  const relay = el('provider').value === 'relay';
  el('relayFields').hidden = !relay;
  el('relayFields').disabled = !relay;
  el('translationMode').disabled = !relay;
  el('glossary').disabled = !relay;
  el('workEnabled').disabled = !relay;
  const stream = relay && el('translationMode').value === 'episode-stream';
  for (const id of ['batchSize', 'maxChars', 'concurrency']) el(id).disabled = stream;
  el('timeoutLabel').textContent = stream ? '首段／空闲超时（秒）' : '超时（秒）';
}
function fill(state) {
  savedState = state;
  const c = state.config;
  for (const id of ['provider', 'baseUrl', 'protocol', 'model', 'batchSize', 'maxChars']) el(id).value = c[id];
  el('concurrency').value = c.concurrency ?? 2;
  el('translationMode').value = c.translationMode || 'batch';
  el('glossary').value = Object.keys(c.glossary || {}).length ? JSON.stringify(c.glossary, null, 2) : '';
  el('timeout').value = c.timeoutMs / 1000;
  el('source').value = state.source;
  el('target').value = state.target;
  el('enabled').checked = state.enabled;
  el('workEnabled').checked = state.workEnabled === true;
  el('apiKey').value = '';
  el('apiKey').placeholder = state.hasKey ? '留空保留当前密钥' : '输入密钥';
  el('keyState').textContent = state.hasKey ? '已保存' : '未设置';
  el('test').disabled = !state.hasKey || !state.authorized;
  el('clear').disabled = !state.hasKey;
  providerVisibility();
}
function payload() {
  let glossary;
  try { glossary = JSON.parse(el('glossary').value.trim() || '{}'); }
  catch (_) { throw new Error('INVALID_GLOSSARY'); }
  return {
    config: R.config({
      provider: el('provider').value, baseUrl: el('baseUrl').value,
      protocol: el('protocol').value, model: el('model').value,
      timeoutMs: Number(el('timeout').value) * 1000,
      batchSize: Number(el('batchSize').value), maxChars: Number(el('maxChars').value),
      concurrency: Number(el('concurrency').value),
      translationMode: el('translationMode').value, glossary,
    }),
    apiKey: el('apiKey').value.trim(), enabled: el('enabled').checked, workEnabled: el('workEnabled').checked,
    target: el('target').value, source: el('source').value,
  };
}
function setBusy(value) {
  busy = value; el('fields').disabled = value;
  if (!value) providerVisibility();
}
el('provider').addEventListener('change', providerVisibility);
el('translationMode').addEventListener('change', providerVisibility);
el('settings').addEventListener('input', () => {
  el('test').disabled = true;
  el('sample').hidden = true;
  status('有未保存的更改');
});
el('settings').addEventListener('submit', async e => {
  e.preventDefault();
  if (busy) return;
  try {
    const p = payload();
    // Request permission in the click/submit gesture, before the first await.
    const origins = p.config.provider === 'relay'
      ? [R.originPattern(p.config.baseUrl)]
      : p.apiKey ? [R.originPattern(R.host(p.config, p.apiKey))]
        : ['https://api-free.deepl.com/*', 'https://api.deepl.com/*'];
    const permission = chrome.permissions.request({ origins });
    setBusy(true); status('正在保存…');
    if (!await permission) throw new Error('PERMISSION_DENIED');
    fill(await send(MSG.MT_SAVE_CONFIG, p));
    status('已保存。');
  } catch (err) { failure(err); }
  finally { setBusy(false); }
});
el('test').addEventListener('click', async () => {
  if (busy) return;
  setBusy(true); status('正在测试翻译…'); el('sample').hidden = true;
  try {
    const result = await send(MSG.MT_TEST);
    status('连接成功，字幕翻译格式校验通过。');
    el('sample').textContent = result.translations[0];
    el('sample').hidden = false;
  } catch (e) { failure(e); }
  finally { setBusy(false); }
});
el('clear').addEventListener('click', async () => {
  if (busy || !savedState?.hasKey) return;
  setBusy(true);
  try {
    await send(MSG.MT_CLEAR_KEY);
    fill(await send(MSG.MT_GET_CONFIG));
    el('sample').hidden = true;
    status('密钥已删除，翻译已关闭。');
  } catch (e) { failure(e); }
  finally { setBusy(false); }
});
send(MSG.MT_GET_CONFIG).then(state => {
  fill(state); el('fields').disabled = false;
  if (new URL(location.href).searchParams.get('target') === 'ja-JP') {
    el('target').value = 'ja-JP';
    status('日文目标已选，尚未保存或开始翻译。'); return;
  }
  status(state.hasKey ? (state.authorized ? '设置已载入。' : '服务地址需要重新授权。') : '尚未配置翻译服务。');
}).catch(failure);
