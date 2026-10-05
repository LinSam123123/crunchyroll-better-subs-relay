import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
async function uiText(page, source) {
  return page.getByText(await page.evaluate(text => CRSubFix.i18n.t(text), source), { exact: true });
}
async function uiRole(page, role, source) {
  return page.getByRole(role, { name: await page.evaluate(text => CRSubFix.i18n.t(text), source), exact: true });
}
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = path.join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const runDir = await mkdtemp(path.join(artifacts, 'browser-'));
const extension = path.join(runDir, 'extension');
await cp(path.join(root, 'extension'), extension, { recursive: true });
const manifestFile = path.join(extension, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
// Only the generated test fixture pre-authorizes localhost; production remains opt-in.
manifest.host_permissions = ['http://127.0.0.1/*', 'https://api.bgm.tv/*'];
await writeFile(manifestFile, JSON.stringify(manifest));
const requests = [];
const lookupRequests = [];
let lookupStatus = 200;
let statusCode = 200;
let responseDelay = 0;
let failText = '';
let streamFailAfter = 0;
let streamDelay = 400;
let streamInvalidId = null;
let activeRequests = 0, peakRequests = 0;
const server = http.createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (req.url.startsWith('/lookup/')) {
    lookupRequests.push({ url: req.url, headers: req.headers, body: raw ? JSON.parse(raw) : null });
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = lookupStatus;
    if (lookupStatus !== 200) return res.end('{"error":"lookup fixture"}');
    if (req.url.includes('/search/subjects')) return res.end(JSON.stringify({ data: [
      { id: 1, name: 'Mock Academy', name_cn: '模拟学园', date: '2024-01-01', platform: 'TV', summary: 'DO NOT INCLUDE PLOT' },
    ] }));
    if (req.url.includes('/subjects/')) return res.end(JSON.stringify([{ id: 101 }, { id: 102 }, { id: 103 }]));
    const id = Number(req.url.split('/').at(-1));
    const name = id === 101 ? '九条' : id === 102 ? '周防有希' : '久世政近';
    return res.end(JSON.stringify({ id, name, summary: 'DO NOT INCLUDE HIDDEN IDENTITY', infobox: [
      { key: '简体中文名', value: name },
      { key: '别名', value: [{ k: '罗马字', v: id === 101 ? 'Kujo' : id === 102 ? 'Yuki Suou' : 'Kuze Masachika' }] },
    ] }));
  }
  const body = JSON.parse(raw);
  requests.push({ url: req.url, body });
  activeRequests++;
  peakRequests = Math.max(peakRequests, activeRequests);
  res.once('close', () => { activeRequests--; });
  if (responseDelay) await new Promise(resolve => setTimeout(resolve, responseDelay));
  res.setHeader('Content-Type', 'application/json');
  res.statusCode = statusCode;
  if (statusCode !== 200) return res.end('{"error":"test"}');
  const payload = JSON.parse(req.url.endsWith('/responses') ? body.input : body.messages[1].content);
  if (payload.task === 'anime-reference-organize') {
    const text = JSON.stringify({ context: '仅根据开头字幕整理的同学关系。', tone: '轻松自然，依场景调整。',
      terms: [
        { source: 'Kujo', target: '九条', characterId: 101, status: 'suggested', note: 'Surname.' },
        { source: 'Yuki', target: '有希', characterId: 102, status: 'suggested', note: 'Given name.' },
        { source: 'Kuze', target: '久世政近', characterId: 103, status: 'suggested', note: 'Deliberate invalid expansion fixture.' },
      ] });
    return res.end(JSON.stringify(req.url.endsWith('/responses')
      ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }
      : { choices: [{ finish_reason: 'stop', message: { content: text } }] }));
  }
  if (payload.task === 'anime-profile') {
    const text = JSON.stringify({ title: '模拟学园', aliases: 'Mock Academy',
      context: '两名同学使用不同姓氏，不要混淆。', tone: '自然口语，不添加笑话。',
      glossary: { Kujo: '九条', Kuze: '久世' } });
    res.end(JSON.stringify(req.url.endsWith('/responses')
      ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }
      : { choices: [{ finish_reason: 'stop', message: { content: text } }] }));
    return;
  }
  if (body.stream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.flushHeaders();
    for (let i = 0; i < payload.items.length; i++) {
      await new Promise(resolve => setTimeout(resolve, streamDelay));
      if (res.destroyed) return;
      const item = payload.items[i];
      const line = JSON.stringify({ id: item.id, text: item.id === streamInvalidId ? '' :
        payload.target_language === 'Japanese' ? `こんにちは。${item.text}` : `你好，${item.text}` }) + '\n';
      const frame = req.url.endsWith('/responses')
        ? { type: 'response.output_text.delta', delta: line }
        : { choices: [{ index: 0, delta: { content: line } }] };
      const bytes = Buffer.from(`data: ${JSON.stringify(frame)}\r\n\r\n`);
      res.write(bytes.subarray(0, 17));
      res.write(bytes.subarray(17));
      if (streamFailAfter && i + 1 >= streamFailAfter) { res.end(); return; }
    }
    res.end(req.url.endsWith('/responses')
      ? 'data: {"type":"response.completed","response":{"status":"completed"}}\n\n'
      : 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    return;
  }
  if (failText && payload.items.some(item => item.text === failText)) {
    res.statusCode = 401;
    return res.end('{"error":"test"}');
  }
  const text = JSON.stringify({ items: payload.items.map(item => ({ id: item.id, text: `你好，${item.text}` })).reverse() });
  res.end(JSON.stringify(req.url.endsWith('/responses')
    ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }
    : { choices: [{ finish_reason: 'stop', message: { content: text } }] }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
let browser;
try {
  browser = await chromium.launchPersistentContext(path.join(runDir, 'profile'), {
    executablePath: process.env.BROWSER_EXECUTABLE_PATH || chromium.executablePath(), headless: true,
    ignoreDefaultArgs: ['--disable-extensions'], locale: 'zh-CN',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 1180, height: 1000 },
  });
  let worker = browser.serviceWorkers()[0];
  if (!worker) worker = await browser.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  // Keep production fixed-origin validation, but route worker fetches to our local fixture.
  await worker.evaluate(base => {
    const original = self.fetch.bind(self);
    self.fetch = (url, init) => original(typeof url === 'string' && url.startsWith('https://api.bgm.tv/')
      ? `${base}/lookup/${url.slice('https://api.bgm.tv/'.length)}` : url, init);
  }, `http://127.0.0.1:${server.address().port}`);
  const errors = [];
  browser.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extensionId}/translation.html`);
  await page.waitForFunction(() => !document.getElementById('fields').disabled);
  await page.locator('#baseUrl').fill(baseUrl);
  await page.locator('#model').fill('mock-subtitle-model');
  await page.locator('#apiKey').fill('test-key-not-real');
  await page.locator('#enabled').check();
  await page.locator('#save').click();
  await page.waitForFunction(() => document.getElementById('status').textContent === '已保存。');
  assert.equal(await page.locator('#apiKey').inputValue(), '');
  await page.locator('#test').click();
  await page.waitForFunction(() => !document.getElementById('sample').hidden);
  assert.match(await page.locator('#sample').textContent(), /你好/);
  await page.screenshot({ path: path.join(artifacts, 'translation-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(artifacts, 'translation-mobile.png'), fullPage: true });
  await page.locator('#protocol').selectOption('responses');
  assert.equal(await page.locator('#test').isDisabled(), true);
  await page.locator('#save').click();
  await page.waitForFunction(() => document.getElementById('status').textContent === '已保存。');
  await page.locator('#test').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('连接成功'));
  assert.equal(requests.at(-1).url, '/v1/responses');
  statusCode = 401;
  await page.locator('#test').click();
  await page.waitForFunction(() => document.getElementById('status').dataset.error === 'true');
  assert.match(await page.locator('#status').textContent(), /鉴权失败/);
  statusCode = 200;
  await page.locator('#batchSize').fill('2');
  await page.locator('#concurrency').selectOption('2');
  await page.locator('#save').click();
  await page.waitForFunction(() => document.getElementById('status').textContent === '已保存。');
  await browser.route('https://www.crunchyroll.com/**', route => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><html><head><title>Offline Crunchyroll fixture</title></head><body style="margin:0;background:#141414;color:white"><div id="player" style="position:relative;width:960px;height:540px"><video style="width:100%;height:100%"></video><div style="display:flex;position:absolute;bottom:0;right:0;gap:18px;height:44px;z-index:20"><button>1x</button><button aria-label="Subtitles">Subtitles</button><button id="fullscreen" onclick="document.getElementById(\'player\').requestFullscreen()">Fullscreen</button></div></div></body></html>',
  }));
  const watch = await browser.newPage();
  async function openExport() {
    await watch.locator('#cr-bsub-menu-btn').click();
    await (await uiText(watch, 'Manage')).click();
    await (await uiText(watch, '⬇ Export subtitles…')).click();
    await watch.getByRole('dialog', { name: '导出字幕' }).waitFor();
  }
  async function exportFile(format) {
    await watch.locator('#cr-bsub-export-format').selectOption(format);
    const pending = watch.waitForEvent('download');
    await watch.getByRole('button', { name: '下载', exact: true }).click();
    const download = await pending;
    assert.equal(await download.failure(), null);
    return { text: await readFile(await download.path(), 'utf8'), name: download.suggestedFilename() };
  }
  await watch.goto('https://www.crunchyroll.com/zh-tw/watch/TEST/offline');
  await watch.waitForFunction(() => document.documentElement.getAttribute('data-cr-mt-configured') === 'true');
  const translated = await watch.evaluate(async () => {
    const { POST } = window.CRSubFix.protocol;
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve({ error: 'fixture timeout' }), 5000);
      const handler = e => {
        if (e.data?.type !== POST.RPC_RES || e.data.id !== 9876) return;
        clearTimeout(timer); removeEventListener('message', handler); resolve(e.data);
      };
      addEventListener('message', handler);
      postMessage({
        type: POST.RPC_REQ, id: 9876, method: 'translate',
        token: document.documentElement.getAttribute('data-cr-toggle-token'),
        payload: { texts: ['First', 'Second'], source: 'en-US', target: 'zh-CN', provider: 'relay',
          configTag: document.documentElement.getAttribute('data-cr-mt-config-tag') },
      }, location.origin);
    });
  });
  assert.equal(translated.ok, true, JSON.stringify(translated));
  assert.deepEqual(translated.translations, ['你好，First', '你好，Second']);
  await page.locator('#batchSize').fill('1');
  await page.locator('#save').click();
  await page.waitForFunction(() => document.getElementById('status').textContent === '已保存。');
  await watch.waitForFunction(() => document.documentElement.getAttribute('data-cr-mt-batch-size') === '1');
  assert.ok(!(await watch.content()).includes('test-key-not-real'));
  // Verify content-script storage is actually denied by Chrome, not just hidden in our UI.
  const cdp = await browser.newCDPSession(watch);
  const contexts = [];
  cdp.on('Runtime.executionContextCreated', ({ context }) => contexts.push(context));
  await cdp.send('Runtime.enable');
  const isolated = contexts.find(c => c.name.includes(extensionId) || c.origin === `chrome-extension://${extensionId}`);
  assert.ok(isolated, 'Extension isolated world must exist: ' + JSON.stringify(contexts));
  const denied = await cdp.send('Runtime.evaluate', {
    contextId: isolated.id, awaitPromise: true, returnByValue: true,
    expression: "chrome.storage.local.get('mtApiKey').then(() => 'LEAK', () => 'DENIED')",
  });
  assert.equal(denied.result.value, 'DENIED');
  // Seed only the captured subtitle catalog; use the actual menu, file parser,
  // translation orchestration, message bridge and renderer from here onward.
  const sourceVtt = 'WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nFirst subtitle.\n\n00:00:10.000 --> 00:00:20.000\nSecond subtitle.\n\n00:00:20.000 --> 00:00:30.000\nThird subtitle.\n\n00:00:30.000 --> 00:00:40.000\nFourth subtitle.\n';
  await browser.route('**/offline-test.vtt', async route => {
    await new Promise(resolve => setTimeout(resolve, 1200));
    await route.fulfill({ contentType: 'text/vtt', body: sourceVtt });
  });
  const seedPlayer = (subtitleUrl = 'https://www.crunchyroll.com/offline-test.vtt') => watch.evaluate(url => {
    const ep = window.CRSubFix.episode.current();
    ep.catalog.recordSession('ja-JP', { 'en-US': url });
    ep.catalog.setVersions([{ locale: 'en-US', guid: 'TEST' }]);
    ep.setCurrentAudio('ja-JP');
    ep.catalog.setValidation('en-US', 'ok');
    const v = document.querySelector('video');
    Object.defineProperty(v, 'duration', { configurable: true, value: 40 });
    Object.defineProperty(v, 'videoWidth', { configurable: true, value: 960 });
    Object.defineProperty(v, 'videoHeight', { configurable: true, value: 540 });
    v.dispatchEvent(new Event('loadedmetadata'));
  }, subtitleUrl);
  await seedPlayer();
  responseDelay = 1200;
  peakRequests = 0;
  await watch.locator('#cr-bsub-menu-btn').click();
  await (await uiText(watch, 'Manage')).click();
  // Reproduce a remaster HUD's delayed fade racing with a new translation.
  await watch.evaluate(() => window.CRSubFix.ui.makeProgressHud(document.getElementById('player')).html('Sync finished', 100));
  const beforeTranslation = requests.length;
  await (await uiText(watch, '🌐 Translate')).click();
  try {
    await watch.locator('#cr-bsub-progress').waitFor({ state: 'visible', timeout: 500 });
    assert.equal(await watch.locator('#cr-bsub-translation-hud').count(), 0);
    assert.equal(await watch.locator('#cr-bsub-progress').evaluate(e => e.style.display), '');
    await watch.waitForFunction(() => !document.getElementById('cr-remaster-hud'));
    await watch.locator('#fullscreen').click();
    // Open details only on request; pause waits for the already dispatched batch.
    while (requests.length === beforeTranslation) await new Promise(r => setTimeout(r, 30));
    await watch.locator('#cr-bsub-progress').click();
    await (await uiRole(watch, 'button', 'Pause translation')).click();
    await watch.waitForFunction(() => document.getElementById('cr-bsub-progress').dataset.state === 'paused');
    assert.equal(requests.length, beforeTranslation + 1);
    await watch.screenshot({ path: path.join(artifacts, 'translation-details.png') });
    await watch.keyboard.press('Escape');
    assert.equal(await watch.locator('#cr-bsub-translation-hud').count(), 0);
    assert.equal(await watch.evaluate(() => document.activeElement.id), 'cr-bsub-progress');
    const beforeExport = requests.length;
    await openExport();
    assert.equal(await watch.evaluate(() => document.fullscreenElement.contains(document.getElementById('cr-bsub-export-panel'))), true);
    const partialExport = JSON.parse((await exportFile('json')).text);
    assert.deepEqual(partialExport.counts, { total: 4, translated: 1, pending: 3, unknown: 0, missing_source: 0 });
    assert.equal(partialExport.rows[1].source_text, 'Second subtitle.');
    assert.equal(partialExport.rows[1].translated_text, null);
    await watch.screenshot({ path: path.join(artifacts, 'export-fullscreen.png') });
    await watch.keyboard.press('Escape');
    await watch.locator('#cr-bsub-export-panel').waitFor({ state: 'detached' });
    assert.equal(requests.length, beforeExport, 'Export must not request translation');
    await watch.locator('#cr-bsub-progress').click();
    await watch.locator('#cr-bsub-progress').evaluate(el => { el.parentElement.style.opacity = '0'; });
    await watch.locator('#cr-bsub-translation-hud').waitFor({ state: 'detached' });
    await watch.locator('#cr-bsub-progress').evaluate(el => { el.parentElement.style.opacity = ''; });
    await watch.locator('#cr-bsub-progress').click();
    await (await uiRole(watch, 'button', 'Resume translation')).click();
    assert.equal(await watch.locator('#cr-bsub-translation-hud').count(), 0);
    await watch.screenshot({ path: path.join(artifacts, 'player-translating.png') });
    await watch.waitForFunction(() => window.CRSubFix.episode.current().listCustomSources().some(s => s.kind === 'mt'), null, { timeout: 10000 });
    await watch.waitForFunction(() => document.body.innerText.includes('你好，First subtitle.'));
    assert.equal(await watch.evaluate(() => window.CRSubFix.episode.current().listCustomSources().find(s => s.kind === 'mt').incomplete), true);
    const pendingText = await watch.evaluate(() => window.CRSubFix.episode.current().listCustomSources().find(s => s.kind === 'mt').srcCues[3].text);
    assert.equal(pendingText, 'Fourth subtitle.');
    await watch.screenshot({ path: path.join(artifacts, 'player-progressive.png') });
    await watch.waitForFunction(() => window.CRSubFix.episode.current().listCustomSources().some(s => s.kind === 'mt' && !s.incomplete), null, { timeout: 15000 });
    assert.ok(requests.length > beforeTranslation);
    assert.equal(peakRequests, 2, 'Two real worker requests must overlap at the mock provider');
    const stats = await watch.evaluate(() => window.CRSubFix.lastTranslationStats);
    assert.equal(stats.requests, 3);
    assert.equal(stats.resumed, 1);
    assert.equal(stats.completed, 4);
    assert.equal(stats.retries, 0);
    assert.ok(stats.batches.every(b => b.durationMs >= 1000 && b.chars > 0));
    await watch.waitForFunction(() => document.documentElement.getAttribute('data-cr-jp-active') === 'true');
    assert.ok(await watch.evaluate(() => document.body.innerText.includes('你好，First subtitle.')));
    await watch.screenshot({ path: path.join(artifacts, 'player-translated.png') });
    await watch.evaluate(() => document.exitFullscreen());
    const beforeCompletedExport = requests.length;
    await openExport();
    const completeExport = JSON.parse((await exportFile('json')).text);
    assert.equal(completeExport.counts.translated, 4);
    assert.equal(completeExport.source_language, 'en-US');
    assert.equal(completeExport.target_language, 'zh-CN');
    assert.equal(completeExport.rows[0].translated_text, '你好，First subtitle.');
    const csv = await exportFile('csv');
    assert.ok(csv.text.startsWith('\uFEFF'));
    assert.ok(csv.name.endsWith('proofreading.csv'));
    assert.ok(csv.text.includes('"First subtitle.","你好，First subtitle."'));
    const bilingual = await exportFile('bilingual');
    assert.ok(bilingual.text.includes('你好，First subtitle.\nFirst subtitle.'));
    const original = await exportFile('source');
    assert.ok(original.text.includes('First subtitle.'));
    assert.ok(!original.text.includes('你好'));
    const target = await exportFile('target');
    assert.ok(target.text.includes('你好，Fourth subtitle.'));
    await watch.locator('#cr-bsub-export-format').selectOption('csv');
    await watch.screenshot({ path: path.join(artifacts, 'export-desktop.png') });
    await watch.setViewportSize({ width: 390, height: 844 });
    assert.ok(await watch.locator('#cr-bsub-export-panel').evaluate(el => {
      const box = el.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight &&
        el.scrollWidth <= el.clientWidth;
    }));
    await watch.screenshot({ path: path.join(artifacts, 'export-mobile.png') });
    await watch.getByRole('button', { name: '关闭导出', exact: true }).click();
    await watch.setViewportSize({ width: 1180, height: 1000 });
    assert.equal(requests.length, beforeCompletedExport);
  } catch (e) {
    console.error(await watch.evaluate(() => ({
      text: document.body.innerText, trace: window.crSubFixDebug?.dump(),
      modules: Object.keys(window.CRSubFix), requests: document.documentElement.outerHTML.slice(0, 2000),
    })));
    throw e;
  }
  responseDelay = 0;
  // Clearing the mock site's storage must not erase extension-owned progress.
  await watch.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  const beforeRestore = requests.length;
  await watch.reload();
  await watch.waitForFunction(() => document.documentElement.getAttribute('data-cr-mt-configured') === 'true');
  await seedPlayer();
  await watch.locator('#cr-bsub-menu-btn').click();
  await (await uiText(watch, 'Manage')).click();
  await (await uiText(watch, '🌐 Translate')).click();
  await watch.waitForFunction(() => window.CRSubFix.lastTranslationStats?.completed === 4);
  assert.equal(requests.length, beforeRestore);
  assert.equal(await watch.evaluate(() => window.CRSubFix.lastTranslationStats.resumed), 4);
  // A later failed batch keeps already translated subtitles visible.
  await watch.evaluate(text => {
    const ep = window.CRSubFix.episode.current();
    ep.setCachedRawText('https://www.crunchyroll.com/offline-test.vtt', text.replace('First subtitle.', 'Changed subtitle.'));
  }, sourceVtt);
  failText = 'Second subtitle.';
  await watch.locator('#cr-bsub-menu-btn').click();
  await (await uiText(watch, 'Manage')).click();
  await (await uiText(watch, '🌐 Translate')).click();
  await watch.locator('#cr-bsub-progress[data-state="error"]').waitFor();
  await watch.locator('#cr-bsub-translation-notice').waitFor();
  assert.equal(await watch.locator('#cr-bsub-translation-hud').count(), 0);
  await watch.locator('#cr-bsub-translation-notice').waitFor({ state: 'detached', timeout: 5000 });
  assert.equal(await watch.locator('#cr-bsub-progress').textContent(), '!');
  await watch.locator('#cr-bsub-progress').click();
  await watch.locator('#cr-bsub-translation-hud[data-state="error"]').waitFor();
  assert.match(await watch.locator('#cr-bsub-translation-hud').textContent(), /HTTP_401/);
  assert.ok(await watch.evaluate(() => document.body.innerText.includes('你好，Changed subtitle.')));
  await watch.screenshot({ path: path.join(artifacts, 'player-error.png') });
  await watch.setViewportSize({ width: 390, height: 844 });
  await watch.evaluate(() => {
    Object.assign(document.getElementById('player').style, { width: '100%', height: '219px' });
    document.getElementById('cr-bsub-progress').parentElement.style.gap = '4px';
  });
  if (!await watch.locator('#cr-bsub-translation-hud').count()) await watch.locator('#cr-bsub-progress').click();
  await watch.waitForFunction(() => {
    const box = document.getElementById('cr-bsub-translation-hud')?.getBoundingClientRect();
    return box && box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;
  });
  await watch.screenshot({ path: path.join(artifacts, 'translation-details-mobile.png') });
  await watch.setViewportSize({ width: 1180, height: 1000 });
  await watch.evaluate(() => {
    Object.assign(document.getElementById('player').style, { width: '960px', height: '540px' });
    document.getElementById('cr-bsub-progress').parentElement.style.gap = '18px';
  });
  await watch.locator('#player').click({ position: { x: 900, y: 10 } });
  assert.equal(await watch.locator('#cr-bsub-translation-hud').count(), 0);
  await watch.locator('#cr-bsub-progress').click();
  failText = '';
  await watch.locator('#cr-bsub-translation-hud').getByRole('button', { name: await watch.evaluate(text => CRSubFix.i18n.t(text), 'Retry'), exact: true }).click();
  await watch.waitForFunction(() => window.CRSubFix.episode.current().listCustomSources().filter(s => s.kind === 'mt' && !s.incomplete).length === 2);
  // A captured native track can be exported without generating a translation.
  await watch.evaluate(() => {
    const ep = window.CRSubFix.episode.current();
    ep.setActiveSource('en-US');
    ep.setOriginalCues([{ start: 0, end: 2, text: 'Native original.' }]);
  });
  const beforeNativeExport = requests.length;
  await openExport();
  const nativeExport = JSON.parse((await exportFile('json')).text);
  assert.equal(nativeExport.rows[0].status, 'source_only');
  assert.equal(nativeExport.rows[0].source_text, 'Native original.');
  assert.equal(nativeExport.target_language, '');
  assert.equal(await watch.locator('#cr-bsub-export-format option[value="target"]').isDisabled(), true);
  await watch.locator('#player').click({ position: { x: 900, y: 10 } });
  await watch.locator('#cr-bsub-export-panel').waitFor({ state: 'detached' });
  assert.equal(requests.length, beforeNativeExport);
  // Actual SSE through worker -> isolated world -> player, with real downloads.
  await page.locator('#translationMode').selectOption('episode-stream');
  await page.locator('#glossary').fill('{"First":"第一","Invalid-item":"无效条目"}');
  await page.locator('#timeout').fill('60');
  await page.locator('#save').click();
  await page.waitForFunction(() => document.getElementById('status').textContent === '已保存。');
  assert.equal(await page.locator('#batchSize').isDisabled(), true);
  await page.screenshot({ path: path.join(artifacts, 'stream-settings-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1180, height: 1000 });
  await page.screenshot({ path: path.join(artifacts, 'stream-settings-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await watch.waitForFunction(() => document.documentElement.getAttribute('data-cr-mt-mode') === 'episode-stream');
  const runStream = async () => {
    await watch.locator('#cr-bsub-menu-btn').click();
    await (await uiText(watch, 'Manage')).click();
    await (await uiText(watch, '🌐 Translate')).click();
  };
  const beforeStream = requests.length;
  streamFailAfter = 2;
  await runStream();
  await watch.waitForFunction(() => window.CRSubFix.episode.current().listCustomSources()
    .some(s => s.kind === 'mt' && s.incomplete && s.srcCues[0].translationStatus === 'translated'));
  assert.equal(requests.at(-1).body.stream, true);
  assert.equal(requests.at(-1).url, '/v1/responses');
  assert.equal(JSON.parse(requests.at(-1).body.input).items.length, 4);
  assert.deepEqual(JSON.parse(requests.at(-1).body.input).glossary, { First: '第一', 'Invalid-item': '无效条目' });
  await watch.waitForFunction(() => document.getElementById('cr-bsub-progress').dataset.state === 'error');
  assert.equal(requests.length, beforeStream + 1, 'A partial EOF must not automatically resend');
  await watch.locator('#cr-bsub-progress').click();
  assert.match(await watch.locator('#cr-bsub-translation-hud').textContent(), /INCOMPLETE_RESPONSE/);
  await watch.screenshot({ path: path.join(artifacts, 'stream-interrupted.png') });
  await watch.keyboard.press('Escape');
  await openExport();
  const streamPartial = JSON.parse((await exportFile('json')).text);
  assert.equal(streamPartial.counts.translated, 2);
  assert.equal(streamPartial.counts.pending, 2);
  await watch.keyboard.press('Escape');
  // Reload must restore even after deleting the site's storage, not just memory.
  await watch.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await watch.reload();
  await watch.waitForFunction(() => document.documentElement.getAttribute('data-cr-mt-mode') === 'episode-stream');
  await seedPlayer();
  // Keep the exact source used before reload.
  await watch.evaluate(text => window.CRSubFix.episode.current()
    .setCachedRawText('https://www.crunchyroll.com/offline-test.vtt', text.replace('First subtitle.', 'Changed subtitle.')), sourceVtt);
  streamFailAfter = 0;
  await runStream();
  await watch.waitForFunction(() => document.getElementById('cr-bsub-progress').dataset.state === 'complete');
  assert.equal(requests.length, beforeStream + 2);
  assert.deepEqual(JSON.parse(requests.at(-1).body.input).items.map(i => i.id), ['2', '3']);
  assert.equal(await watch.evaluate(() => window.CRSubFix.lastTranslationStats.resumed), 2);
  // Test Chat Completions streaming, user pause, and explicit resume.
  await page.locator('#protocol').selectOption('chat-completions');
  await page.locator('#save').click();
  await page.waitForFunction(() => document.getElementById('status').textContent === '已保存。');
  const beforeChatStream = requests.length;
  streamDelay = 1400;
  await runStream();
  while (requests.length === beforeChatStream) await new Promise(r => setTimeout(r, 20));
  await watch.waitForFunction(() => window.CRSubFix.episode.current().listCustomSources()
    .some(s => s.incomplete && s.srcCues[0].translationStatus === 'translated'));
  await watch.locator('#cr-bsub-progress').click();
  await (await uiRole(watch, 'button', 'Pause translation')).click();
  await watch.waitForFunction(() => document.getElementById('cr-bsub-progress').dataset.state === 'paused');
  assert.equal(requests.length, beforeChatStream + 1);
  if (!await watch.locator('#cr-bsub-translation-hud').count()) await watch.locator('#cr-bsub-progress').click();
  await (await uiRole(watch, 'button', 'Resume translation')).click();
  await watch.waitForFunction(() => document.getElementById('cr-bsub-progress').dataset.state === 'complete', null, { timeout: 15000 });
  assert.equal(requests.length, beforeChatStream + 2);
  assert.equal(requests.at(-1).url, '/v1/chat/completions');
  const resumedIds = JSON.parse(requests.at(-1).body.messages[1].content).items.map(i => i.id);
  assert.ok(!resumedIds.includes('0'));
  await watch.screenshot({ path: path.join(artifacts, 'stream-completed.png') });
  streamDelay = 0;
  // Invalid text must not terminate the bridge or discard later valid records.
  await watch.evaluate(text => window.CRSubFix.episode.current()
    .setCachedRawText('https://www.crunchyroll.com/offline-test.vtt',
      text.replace('First subtitle.', 'Invalid-item fixture.')), sourceVtt);
  const beforeInvalidStream = requests.length;
  streamInvalidId = '1';
  await runStream();
  await watch.locator('#cr-bsub-progress[data-state="error"]').waitFor();
  assert.equal(requests.length, beforeInvalidStream + 1, 'Invalid text must not trigger automatic requests');
  assert.equal(await watch.evaluate(() => window.CRSubFix.lastTranslationStats.completed), 3);
  await watch.locator('#cr-bsub-progress').click();
  const invalidDetails = await watch.locator('#cr-bsub-translation-hud').textContent();
  assert.match(invalidDetails, /STREAM_ITEMS_PENDING/);
  assert.ok(invalidDetails.includes(await watch.evaluate(() => CRSubFix.i18n.t(
    'subtitle #{index} at {time} ({reason})', { index: 2, time: '0:10', reason: CRSubFix.i18n.t('empty text') }))));
  await watch.screenshot({ path: path.join(artifacts, 'stream-invalid-item.png') });
  await watch.keyboard.press('Escape');
  await openExport();
  const invalidExport = JSON.parse((await exportFile('json')).text);
  assert.equal(invalidExport.counts.translated, 3);
  assert.equal(invalidExport.counts.pending, 1);
  assert.deepEqual(invalidExport.rows.map(r => r.status), ['translated', 'pending', 'translated', 'translated']);
  assert.equal(invalidExport.rows[1].translated_text, null);
  await watch.keyboard.press('Escape');
  await watch.locator('#cr-bsub-progress').click();
  streamInvalidId = null;
  await (await uiRole(watch, 'button', 'Retry')).click();
  await watch.locator('#cr-bsub-progress[data-state="complete"]').waitFor();
  assert.equal(requests.length, beforeInvalidStream + 2);
  assert.deepEqual(JSON.parse(requests.at(-1).body.messages[1].content).items.map(i => i.id), ['1']);
  assert.equal(await watch.evaluate(() => window.CRSubFix.lastTranslationStats.resumed), 3);
  // Trusted work editor: metadata detection, paid draft only on explicit click,
  // confirmation, per-work injection, profile revision, and cross-episode reuse.
  const metadata = (guid, seriesId) => watch.evaluate(({ guid, seriesId }) => {
    document.getElementById('fixture-metadata')?.remove();
    const script = document.createElement('script');
    script.id = 'fixture-metadata';
    script.type = 'application/ld+json';
    script.textContent = JSON.stringify({ '@type': 'TVEpisode',
      url: `https://www.crunchyroll.com/watch/${guid}/offline`,
      partOfSeries: { '@type': 'TVSeries', name: 'Mock Academy',
        url: `https://www.crunchyroll.com/series/${seriesId}/mock` } });
    document.head.appendChild(script);
  }, { guid, seriesId });
  await metadata('TEST', 'MOCKSERIES');
  const beforeWork = requests.length;
  const workOpened = browser.waitForEvent('page');
  await watch.locator('#cr-bsub-menu-btn').click();
  await (await uiText(watch, 'Manage')).click();
  await watch.getByText('作品资料…', { exact: true }).click();
  const work = await workOpened;
  await work.waitForLoadState();
  work.on('dialog', dialog => dialog.accept());
  await work.waitForFunction(() => !document.getElementById('fields').disabled);
  assert.match(await work.locator('#detected').textContent(), /Mock Academy/);
  assert.equal(await work.locator('#series-url').inputValue(), 'https://www.crunchyroll.com/series/MOCKSERIES');
  assert.equal(requests.length, beforeWork);
  await work.locator('#generate').click();
  await work.locator('#draft-warning').waitFor({ state: 'visible' });
  assert.equal(requests.length, beforeWork + 1);
  assert.equal(JSON.parse(requests.at(-1).body.messages[1].content).task, 'anime-profile');
  assert.equal(await work.locator('#title').inputValue(), '模拟学园');
  await runStream();
  await watch.locator('#cr-bsub-progress[data-state="complete"]').waitFor();
  assert.equal(requests.length, beforeWork + 1, 'Unconfirmed draft cannot change translation cache or spend');
  await work.locator('#enabled').check();
  await work.locator('#save').click();
  await work.waitForFunction(() => document.getElementById('status').textContent.includes('资料已确认并保存'));
  await watch.waitForFunction(() => document.documentElement.getAttribute('data-cr-mt-work-enabled') === 'true');
  assert.equal(requests.length, beforeWork + 1);
  assert.equal(await work.locator('#state').textContent(), '已保存 · 2 项术语');
  const beforeGlossaryEditing = requests.length;
  await work.locator('#glossary').fill('{"Kujo":"九条","Kuze":"久世","Alya":"艾莉","Alya-chan":"艾莉同学"}');
  await work.locator('#glossary-editor summary').click();
  const fixedHonorific = work.locator('.glossary-entry').filter({ hasText: 'Alya-chan' });
  assert.match(await fixedHonorific.textContent(), /称谓固定/);
  await fixedHonorific.getByRole('button', { name: '删除', exact: true }).click();
  assert.equal(JSON.parse(await work.locator('#glossary').inputValue())['Alya-chan'], undefined);
  assert.equal(JSON.parse(await work.locator('#glossary').inputValue()).Alya, '艾莉');
  assert.match(await work.locator('#glossary-status').textContent(), /尚未保存/);
  const bareName = work.locator('.glossary-entry').filter({ hasText: /^Alya/ });
  await bareName.locator('input').fill('艾莉（测试）');
  const unsavedTerms = await work.locator('#glossary').inputValue();
  for (const language of ['en', 'ja', 'zh-Hant', 'zh-Hans']) {
    await worker.evaluate(value => chrome.storage.local.set({ uiLanguage: value }), language);
    await work.waitForFunction(value => document.documentElement.lang === value, language);
    assert.equal(await work.locator('#glossary').inputValue(), unsavedTerms);
    assert.equal(await bareName.locator('input').inputValue(), '艾莉（测试）');
    assert.equal(requests.length, beforeGlossaryEditing, 'UI language changes must not call model');
  }
  await bareName.getByRole('button', { name: '应用', exact: true }).click();
  assert.equal(JSON.parse(await work.locator('#glossary').inputValue()).Alya, '艾莉（测试）');
  assert.equal(requests.length, beforeGlossaryEditing);
  await work.screenshot({ path: path.join(artifacts, 'glossary-editor-desktop.png'), fullPage: true });
  await work.setViewportSize({ width: 390, height: 844 });
  assert.ok(await work.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await work.screenshot({ path: path.join(artifacts, 'glossary-editor-mobile.png'), fullPage: true });
  await work.setViewportSize({ width: 1180, height: 1000 });
  await work.locator('#glossary-editor summary').click();
  // Explicit public lookup, conflict protection, editable aliases, saved sources.
  await work.locator('#glossary').fill('{"Kujo":"久条","Kuze":"久世"}');
  await work.locator('#lookup-search').click();
  await work.getByRole('button', { name: '选择此作品', exact: true }).waitFor();
  assert.equal(lookupRequests.length, 1);
  assert.equal(lookupRequests[0].headers.authorization, undefined);
  assert.deepEqual(lookupRequests[0].body, { keyword: '模拟学园', filter: { type: [2], nsfw: false } });
  await work.getByRole('button', { name: '选择此作品', exact: true }).click();
  await work.waitForFunction(() => !document.getElementById('fields').disabled);
  assert.equal(lookupRequests.length, 5);
  assert.equal(requests.length, beforeWork + 1, 'Public lookup never calls the relay');
  const previousContext = await work.locator('#context').inputValue();
  const previousTone = await work.locator('#tone').inputValue();
  await work.locator('#glossary').fill('{}');
  await work.locator('#context').fill('');
  await work.locator('#tone').fill('');
  await work.locator('#save').click();
  assert.match(await work.locator('#status').textContent(), /不能直接保存成空资料/);
  assert.ok(await work.locator('#lookup-terms').isVisible(), 'Blocked save must not discard lookup candidates');
  assert.equal(requests.length, beforeWork + 1);
  await work.locator('#glossary').fill('{"Kujo":"久条","Kuze":"久世"}');
  await work.locator('#context').fill(previousContext);
  await work.locator('#tone').fill(previousTone);
  const kujoRow = work.locator('.lookup-row').first();
  assert.equal(await kujoRow.locator('input[aria-label="字幕原文"]').inputValue(), 'Kujo');
  await kujoRow.locator('input[type="checkbox"]').check();
  await work.locator('#save').click();
  assert.match(await work.locator('#status').textContent(), /候选尚未合并/);
  await work.locator('#lookup-merge').click();
  assert.equal(JSON.parse(await work.locator('#glossary').inputValue()).Kujo, '久条');
  assert.match(await work.locator('#lookup-status').textContent(), /保留 1 项冲突/);
  await work.locator('#lookup-replace').check();
  await kujoRow.locator('input[type="checkbox"]').check();
  await work.locator('#lookup-merge').click();
  assert.equal(JSON.parse(await work.locator('#glossary').inputValue()).Kujo, '九条');
  await work.locator('#lookup-matched').uncheck();
  const yukiRow = work.locator('.lookup-row').nth(1);
  await yukiRow.locator('input[aria-label="字幕原文"]').fill('Yuki');
  await yukiRow.locator('input[aria-label="中文译名"]').fill('有希');
  await yukiRow.locator('input[type="checkbox"]').check();
  await work.locator('#lookup-merge').click();
  assert.equal(JSON.parse(await work.locator('#glossary').inputValue()).Yuki, '有希');
  await work.screenshot({ path: path.join(artifacts, 'lookup-desktop.png'), fullPage: true });
  await work.setViewportSize({ width: 390, height: 844 });
  assert.ok(await work.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await work.screenshot({ path: path.join(artifacts, 'lookup-mobile.png'), fullPage: true });
  await work.setViewportSize({ width: 1180, height: 1000 });
  await work.locator('#save').click();
  await work.waitForFunction(() => document.getElementById('state').textContent === '已保存 · 3 项术语');
  assert.ok(await work.locator('#lookup-terms').isVisible(), 'Saving keeps visible candidate list');
  assert.match(await work.locator('#lookup-status').textContent(), /已保存 3 项术语/);
  assert.equal(requests.length, beforeWork + 1);
  await work.reload();
  await work.waitForFunction(() => !document.getElementById('fields').disabled);
  assert.equal(JSON.parse(await work.locator('#glossary').inputValue()).Yuki, '有希');
  await work.locator('#term-sources summary').click();
  assert.match(await work.locator('#term-source-list').textContent(), /Yuki → 有希/);
  assert.equal(lookupRequests.length, 5, 'Reloading confirmed profiles never searches again');
  assert.match(await work.locator('#lookup-status').textContent(), /已载入 3 项术语/);
  await work.locator('#lookup-search').click();
  await work.getByRole('button', { name: '选择此作品', exact: true }).waitFor();
  assert.equal(lookupRequests.length, 5, 'Explicit repeat search uses bounded cache');
  lookupStatus = 503;
  await work.locator('#lookup-query').fill('Network failure fixture');
  await work.locator('#lookup-search').click();
  await work.waitForFunction(() => document.getElementById('lookup-status').dataset.error === 'true');
  assert.equal(JSON.parse(await work.locator('#glossary').inputValue()).Yuki, '有希');
  assert.equal(requests.length, beforeWork + 1);
  lookupStatus = 200;
  // The original generator now consumes selected online evidence too.
  await work.getByRole('button', { name: '选择此作品', exact: true }).click();
  await work.waitForFunction(() => !document.getElementById('fields').disabled);
  const beforeOrganize = requests.length;
  const draftBeforeOrganize = await work.locator('#glossary').inputValue();
  await work.locator('#context').fill('');
  await work.locator('#generate').click();
  await work.locator('#organized-reference').waitFor({ state: 'visible' });
  assert.equal(requests.length, beforeOrganize + 1);
  const organizeInput = JSON.parse(requests.at(-1).body.messages[1].content);
  assert.equal(organizeInput.task, 'anime-reference-organize');
  assert.equal(organizeInput.public_reference.characters.length, 3);
  assert.equal(organizeInput.episode_subtitles.length, 4);
  assert.equal(await work.locator('#glossary').inputValue(), draftBeforeOrganize);
  assert.equal(await work.locator('.lookup-row').nth(2).locator('input[type="checkbox"]').isChecked(), false);
  assert.match(await work.locator('.lookup-row').nth(2).textContent(), /姓名片段被扩写为全名/);
  await work.locator('#save').click();
  assert.match(await work.locator('#status').textContent(), /候选尚未合并/);
  await work.screenshot({ path: path.join(artifacts, 'organize-desktop.png'), fullPage: true });
  await work.setViewportSize({ width: 390, height: 844 });
  assert.ok(await work.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await work.screenshot({ path: path.join(artifacts, 'organize-mobile.png'), fullPage: true });
  await work.setViewportSize({ width: 1180, height: 1000 });
  await work.locator('#lookup-merge').click();
  assert.equal(JSON.parse(await work.locator('#glossary').inputValue()).Kuze, '久世');
  assert.equal(await work.locator('#context').inputValue(), '仅根据开头字幕整理的同学关系。');
  assert.equal(await work.locator('#tone').inputValue(), previousTone, 'Existing tone is not silently replaced');
  await work.locator('#save').click();
  await work.waitForFunction(() => document.getElementById('state').textContent === '已保存 · 3 项术语');
  assert.match(await work.locator('#term-source-list').textContent(), /模型整理参考/);
  assert.equal(requests.length, beforeOrganize + 1, 'Merge and save cannot automatically translate or regenerate');
  const beforeConfirmedStream = requests.length;
  await work.screenshot({ path: path.join(artifacts, 'work-desktop.png'), fullPage: true });
  await work.setViewportSize({ width: 390, height: 844 });
  assert.ok(await work.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await work.screenshot({ path: path.join(artifacts, 'work-mobile.png'), fullPage: true });
  assert.ok(!(await watch.content()).includes('两名同学使用不同姓氏'));
  await runStream();
  await watch.locator('#cr-bsub-progress[data-state="complete"]').waitFor();
  assert.equal(requests.length, beforeConfirmedStream + 1);
  let workInput = JSON.parse(requests.at(-1).body.messages[1].content);
  assert.equal(workInput.work_context.title, '模拟学园');
  assert.equal(workInput.glossary.Kujo, '九条');
  assert.equal(workInput.glossary.Yuki, '有希');
  assert.equal(workInput.glossarySources, undefined);
  assert.equal(workInput.source_language, 'English', 'Japanese-audio source slot contains English subtitles');
  // Inspect a real request snapshot and correct one cached cue without another provider request.
  await work.locator('#review-refresh').click();
  await work.waitForFunction(() => document.getElementById('review-status').textContent.includes('实际提交请求'));
  await work.locator('#review-runs').selectOption({ index: 0 });
  await work.locator('#review-details summary').click();
  assert.match(await work.locator('#review-profile').textContent(), /模拟学园/);
  assert.equal(JSON.parse(await work.locator('#review-glossary').textContent()).Yuki, '有希');
  assert.equal(JSON.parse(await work.locator('#review-glossary').textContent()).First, '第一');
  assert.match(await work.locator('#review-origins').textContent(), /First：全局词表/);
  await work.locator('#coverage-section summary').click();
  await work.locator('#coverage-check').click();
  assert.match(await work.locator('#coverage-summary').textContent(), /草稿检查/);
  assert.match(await work.locator('#coverage-rows').textContent(), /Invalid-item/);
  assert.equal(requests.length, beforeConfirmedStream + 1, 'Review and coverage checks never spend');
  assert.equal(await work.locator('.review-row').count(), 1, 'Mock output violates the Invalid-item glossary mapping');
  const correctedRow = work.locator('.review-row').first();
  await correctedRow.locator('textarea').fill('无效条目，本地校正。');
  await correctedRow.getByRole('button', { name: '保存本条修正' }).click();
  await work.waitForFunction(() => document.getElementById('review-status').textContent.includes('本条已保存'));
  await watch.waitForFunction(() => window.CRSubFix.episode.current().originalCues[0]?.text === '无效条目，本地校正。');
  const reviewExportBefore = requests.length;
  await openExport();
  const correctedExport = JSON.parse((await exportFile('json')).text);
  assert.equal(correctedExport.rows[0].translated_text, '无效条目，本地校正。');
  assert.equal(correctedExport.rows[0].source_text, 'Invalid-item fixture.');
  await watch.keyboard.press('Escape');
  assert.equal(requests.length, reviewExportBefore);
  await work.locator('#review-filter').selectOption('corrected');
  assert.equal(await work.locator('.review-row').count(), 1);
  await work.setViewportSize({ width: 1180, height: 1000 });
  await work.locator('#review-section').scrollIntoViewIfNeeded();
  await work.screenshot({ path: path.join(artifacts, 'review-desktop.png') });
  await work.setViewportSize({ width: 390, height: 844 });
  await work.locator('#review-section').scrollIntoViewIfNeeded();
  assert.ok(await work.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await work.screenshot({ path: path.join(artifacts, 'review-mobile.png') });
  await work.reload();
  await work.waitForFunction(() => document.getElementById('review-status').textContent.includes('实际提交请求'));
  await work.locator('#review-filter').selectOption('corrected');
  assert.equal(await work.locator('.review-row textarea').inputValue(), '无效条目，本地校正。');
  await runStream();
  await watch.locator('#cr-bsub-progress[data-state="complete"]').waitFor();
  assert.equal(requests.length, reviewExportBefore, 'Reusing a corrected completed track cannot translate again');
  assert.equal(await watch.evaluate(() => window.CRSubFix.episode.current().originalCues[0].text), '无效条目，本地校正。');
  await work.locator('#tone').fill('克制自然，不添加人物身份。');
  await work.locator('#save').click();
  await work.waitForFunction(() => document.getElementById('status').textContent.includes('资料已确认并保存'));
  assert.equal(requests.length, beforeConfirmedStream + 1, 'Profile edit must not automatically retranslate');
  await runStream();
  await watch.locator('#cr-bsub-progress[data-state="complete"]').waitFor();
  assert.equal(requests.length, beforeConfirmedStream + 2);
  workInput = JSON.parse(requests.at(-1).body.messages[1].content);
  assert.equal(workInput.work_context.tone, '克制自然，不添加人物身份。');
  assert.equal(workInput.items.length, 4, 'A new profile revision must not mix old completed cache');
  await watch.goto('https://www.crunchyroll.com/watch/NEXT/offline');
  await watch.waitForFunction(() => document.documentElement.getAttribute('data-cr-mt-work-enabled') === 'true');
  await seedPlayer();
  await metadata('NEXT', 'MOCKSERIES');
  await runStream();
  await watch.locator('#cr-bsub-progress[data-state="complete"]').waitFor();
  assert.equal(requests.length, beforeConfirmedStream + 3, 'Next episode reuses confirmed profile without another generation');
  assert.equal(JSON.parse(requests.at(-1).body.messages[1].content).work_context.title, '模拟学园');
  await watch.goto('https://www.crunchyroll.com/watch/OTHER/offline');
  await watch.waitForFunction(() => document.documentElement.getAttribute('data-cr-mt-work-enabled') === 'true');
  await seedPlayer();
  await metadata('OTHER', 'OTHERSERIES');
  await runStream();
  await watch.locator('#cr-bsub-progress[data-state="complete"]').waitFor();
  assert.equal(requests.length, beforeConfirmedStream + 4);
  assert.equal(JSON.parse(requests.at(-1).body.messages[1].content).work_context, undefined);
  await work.close();
  // A slow subtitle origin must not delay the editor tab or overwrite typing once samples arrive.
  let releaseSlow;
  const slowSource = new Promise(resolve => { releaseSlow = resolve; });
  await browser.route('**/slow-test.vtt', async route => {
    await slowSource;
    await route.fulfill({ contentType: 'text/vtt', body: sourceVtt });
  });
  await watch.goto('https://www.crunchyroll.com/watch/SLOW/offline');
  await watch.waitForFunction(() => document.documentElement.getAttribute('data-cr-mt-configured') === 'true');
  await seedPlayer('https://www.crunchyroll.com/slow-test.vtt');
  await metadata('SLOW', 'SLOWSERIES');
  const beforeSlowOpen = requests.length;
  await watch.locator('#cr-bsub-menu-btn').click();
  await (await uiText(watch, 'Manage')).click();
  const slowOpened = browser.waitForEvent('page', { timeout: 4000 });
  await watch.getByText('作品资料…', { exact: true }).click();
  const slowWork = await slowOpened;
  slowWork.on('dialog', dialog => dialog.accept());
  await slowWork.waitForLoadState();
  await slowWork.waitForFunction(() => !document.getElementById('fields').disabled);
  assert.match(await slowWork.locator('#sample-count').textContent(), /正在补载/);
  assert.equal(await slowWork.locator('#generate').isDisabled(), true);
  await slowWork.locator('#title').fill('保留用户正在编辑的作品名');
  await new Promise(resolve => setTimeout(resolve, 8000));
  releaseSlow();
  await slowWork.waitForFunction(() => document.getElementById('sample-count').textContent.includes('本地匹配 4 条'), null, { timeout: 20000 });
  assert.equal(await slowWork.locator('#title').inputValue(), '保留用户正在编辑的作品名');
  assert.equal(await slowWork.locator('#generate').isDisabled(), false);
  assert.equal(requests.length, beforeSlowOpen, 'Opening and loading source samples cannot call the relay');
  await slowWork.screenshot({ path: path.join(artifacts, 'work-open-after-load.png'), fullPage: true });
  await slowWork.close();
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('fields').disabled);
  // Exercise a real MV3 fetch that exceeds the previous 25-second timeout.
  await page.locator('#timeout').fill('60');
  await page.locator('#save').click();
  await page.waitForFunction(() => document.getElementById('status').textContent === '已保存。');
  await watch.waitForFunction(() => document.documentElement.getAttribute('data-cr-mt-timeout-ms') === '60000');
  responseDelay = 32000;
  await page.locator('#test').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('连接成功'), null, { timeout: 45000 });
  responseDelay = 0;
  await page.locator('#target').selectOption('ja-JP');
  await page.locator('#source').selectOption('ja-JP');
  await page.locator('#glossary').fill('{}');
  await page.locator('#save').click();
  await page.waitForFunction(() => document.getElementById('status').textContent === '已保存。');
  await watch.goto('https://www.crunchyroll.com/watch/JAPANESE/offline');
  await watch.waitForFunction(() => document.documentElement.getAttribute('data-cr-mt-target') === 'ja-JP');
  await seedPlayer();
  await watch.evaluate(text => {
    const ep = window.CRSubFix.episode.current(), url = 'https://www.crunchyroll.com/offline-test.vtt';
    ep.setJpUrls(url, null); ep.setCachedRawText(url, text);
    ep.catalog.setVersions([{ locale: 'ja-JP', guid: 'JAPANESE' }]);
  }, sourceVtt);
  const beforeJapanese = requests.length;
  await runStream();
  await watch.locator('#cr-bsub-progress[data-state="complete"]').waitFor();
  assert.equal(requests.length, beforeJapanese + 1);
  const japaneseBody = requests.at(-1).body;
  const japaneseInput = JSON.parse(japaneseBody.input || japaneseBody.messages[1].content);
  assert.equal(japaneseInput.source_language, 'English'); assert.equal(japaneseInput.target_language, 'Japanese');
  assert.match(japaneseBody.instructions || japaneseBody.messages[0].content, /idiomatic spoken Japanese/);
  await watch.getByText('こんにちは。First subtitle.', { exact: true }).waitFor();
  assert.ok(await watch.evaluate(() => window.CRSubFix.episode.current().listCustomSources().some(s => s.kind === 'mt' && s.lang === 'ja-JP')));
  await watch.screenshot({ path: path.join(artifacts, 'japanese-mt-player.png') });
  await page.locator('#clear').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('密钥已删除'));
  await watch.waitForFunction(() => document.documentElement.getAttribute('data-cr-mt-configured') === 'false');
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator('#sec-mt').evaluate(el => { el.open = true; });
  await popup.locator('#sec-mt').scrollIntoViewIfNeeded();
  await popup.screenshot({ path: path.join(artifacts, 'popup.png'), fullPage: true });
  assert.deepEqual(errors, []);
  const summary = { extensionId, checks: [
    'real MV3 worker and options page', 'settings save/key clearing', 'Chat Completions and Responses',
    '401 error UI', 'desktop/mobile layout', 'MAIN-to-isolated-to-worker translation',
    'real Chrome storage access denial', 'settings broadcasts', 'original popup loading',
    'actual Manage/Translate click and visible translated subtitles',
    'immediate loading progress and isolation from remaster fade', 'fullscreen progress',
    'persistent first-batch failure and Retry button',
    'two overlapping provider requests and batch timing diagnostics',
    '32-second real MV3 fetch with a 60-second configured timeout',
    'partial subtitles render before completion with source-text fallback',
    'clearing site storage and reloading restores extension cache without provider calls',
    'later-batch failure retains visible translations',
    'no automatic progress panel, explicit details, Escape and controls-autohide dismissal',
    'pause drains paid requests; resume skips completed cues',
    'error notice expires after three seconds but warning and retry remain available',
    'details stay within mobile viewport and close on outside click',
    'real JSON/CSV/source/target/bilingual downloads with no provider requests',
    'partial export has explicit pending status and blank untranslated targets',
    'native source export, fullscreen export, mobile dialog and Escape/outside dismissal',
    'real Responses and Chat Completions SSE produce progressive saved subtitles',
    'SSE partial EOF preserves exports; reload restores only missing ids without automatic resend',
    'stream pause aborts request and explicit resume skips completed ids',
    'invalid stream item stays pending while later items save; diagnostics and export identify it; Retry sends only that id',
    'work metadata detection and trusted editor; explicit draft generation does not activate before confirmation',
    'confirmed work glossary enters stream; profile edits invalidate cache only on explicit translation',
    'same-series next episode reuses profile without generation; different series gets no context; editor fits mobile',
    'public Bangumi mock lookup has no relay calls or authorization; names only, explicit selection and conflict replacement',
    'editable source/target aliases merge into drafts, source records survive reload, repeated search uses cache, network failures preserve profiles',
    'empty queried profile and unmerged selection cannot silently save; saved counts and candidate list remain visible',
    'online evidence reaches model organizer; preview is isolated; full-name expansion is unchecked; existing tone and glossary survive; sources labeled model-assisted',
    'actual request audit and glossary origins, local coverage, conflict warnings, single-cue correction updates playback/export and survives reload without paid requests',
    'work editor opens before an eight-second subtitle fetch; background sample arrival preserves draft edits and never calls the relay',
    'Japanese MT reuses the existing SSE engine; legacy Japanese-audio slot is correctly treated as English source and renders Japanese target',
  ], network: 'localhost mock only; no real account or paid API', screenshots: [
    'translation-desktop.png', 'translation-mobile.png', 'popup.png',
    'player-translating.png', 'player-translated.png', 'player-error.png', 'player-progressive.png', 'translation-details.png',
    'translation-details-mobile.png', 'export-fullscreen.png', 'export-desktop.png', 'export-mobile.png',
    'stream-settings-mobile.png', 'stream-settings-desktop.png', 'stream-interrupted.png', 'stream-completed.png',
    'stream-invalid-item.png',
    'work-desktop.png', 'work-mobile.png',
    'lookup-desktop.png', 'lookup-mobile.png',
    'organize-desktop.png', 'organize-mobile.png',
    'review-desktop.png', 'review-mobile.png',
    'work-open-after-load.png',
    'japanese-mt-player.png',
  ] };
  await writeFile(path.join(artifacts, 'browser-results.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
