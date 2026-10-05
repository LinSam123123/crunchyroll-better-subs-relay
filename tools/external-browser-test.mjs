import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, writeFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { zipSync, strToU8 } from 'fflate';

const require = createRequire(import.meta.url);
async function uiText(page, source) {
  return page.getByText(await page.evaluate(text => CRSubFix.i18n.t(text), source), { exact: true });
}
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = path.join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const runDir = await mkdtemp(path.join(artifacts, 'external-browser-'));
const extension = path.join(runDir, 'extension');
await cp(path.join(root, 'extension'), extension, { recursive: true });
const manifestFile = path.join(extension, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
manifest.host_permissions = ['http://127.0.0.1/*', 'https://*.assrt.net/*', 'http://*.assrt.net/*', 'https://api.subdl.com/*', 'https://dl.subdl.com/*', 'https://jimaku.cc/*'];
await writeFile(manifestFile, JSON.stringify(manifest));
const token = 'a'.repeat(32), calls = [], checks = [];
const subdlToken = 'synthetic-subdl-only-key', subdlTitle = { sd_id: 666, name: 'Synthetic Academy', type: 'tv', year: 2026 };
const subdlFilename = ep => `Academy S01E0${ep}.srt`;
const subdlSrt = ep => `1\n00:00:02,000 --> 00:00:10,000\nSubDL 第${ep}集字幕\n`;
const subdlPack = { n_id: '42', url: '/subtitle/42.zip', release_name: 'Academy S01 WEB', full_season: true,
  season: 1, language: 'Chinese (Simplified)', author: 'SubDL 测试字幕组',
  unpack_files: [4, 5].map(ep => ({ file_n_id: `file${ep}`, name: subdlFilename(ep), language: 'ZH',
    season: 1, episode: ep, size: 100, format: 'srt', url: `/subtitle/42/file${ep}` })) };
const subdlZip = zipSync({ 'Academy S01E04.srt': strToU8(subdlSrt(4)), 'Academy S01E05.srt': strToU8(subdlSrt(5)), 'Readme.txt': strToU8('fixture') });
const jimakuToken = 'synthetic-jimaku-only-key';
const jimakuTitle = { id: 777, name: 'Synthetic Academy', english_name: 'Synthetic Academy', anilist_id: 1001,
  flags: { anime: true, external: false, unverified: false }, last_modified: '2026-10-04T00:00:00Z' };
const jimakuName = ep => `[Test] Academy S01E0${ep} (WEB).srt`;
const jimakuSrt = ep => `1\n00:00:02,000 --> 00:00:10,000\nこんにちは。これは第${ep}話のテスト字幕です。\n`;
const jimakuFiles = [5, 6].map(ep => ({ name: jimakuName(ep), size: 100,
  url: `https://jimaku.cc/entry/777/download/${encodeURIComponent(jimakuName(ep))}` }));
const alyaEnglish = 'Alya Sometimes Hides Her Feelings in Russian';
const alyaJapanese = '時々ボソッとロシア語でデレる隣のアーリャさん';
const alyaNetflix = ep => `${alyaJapanese}.S01E${String(ep).padStart(2, '0')}.第${ep}回の物語.WEBRip.Netflix.ja[cc].srt`;
const alyaAtx = (ep, ext) => `Tokidoki Bosotto Russia-go de Dereru Tonari no Alya-san - ${String(ep).padStart(2, '0')} 「第${ep}回の物語」 (AT-X 1280x720 x264 AAC).${ext}`;
const alyaEntry = { ...jimakuTitle, id: 5944, name: 'Tokidoki Bosotto Russia-go de Dereru Tonari no Alya-san',
  english_name: alyaEnglish, japanese_name: alyaJapanese, anilist_id: 162804 };
const alyaFileNames = Array.from({ length: 12 }, (_, i) => i + 1).flatMap(ep => [alyaNetflix(ep), alyaAtx(ep, 'ass'), alyaAtx(ep, 'srt'),
  `Roshidere-${String(ep).padStart(2, '0')}-JPN v1.ass`, `Roshidere-${String(ep).padStart(2, '0')}-JPN v2.ass`,
  `[EMBER] ${alyaEnglish} S01E${String(ep).padStart(2, '0')}-Episode ${ep} [${String(ep).padStart(8, '0')}].ja.srt`]);
alyaFileNames.push('alpha.ja.srt', 'beta.ja.srt');
const alyaFiles = alyaFileNames.map(name => ({ name, size: 100, url: `https://jimaku.cc/entry/5944/download/${encodeURIComponent(name)}` }));
let jimakuExtended = false;
const analysisToken = 'synthetic-analysis-only-key';
const srt = '1\n00:00:02,000 --> 00:00:05,000\n第一句话\n\n2\n00:00:20,000 --> 00:00:23,000\n第二句话\n';
let fileBody = srt;
const item = { id: 42, native_name: 'Synthetic Academy S01E02 WEB', filename: 'episode02.srt',
  lang: { desc: '简体中文' }, subtype: 'SRT', producer: { producer: '测试字幕组', uploader: '测试上传者', source: '原创翻译' },
  upload_time: '2026-10-03 20:00:00', vote_score: 3,
  filelist: [{ f: 'episode02.srt', s: 200, url: 'http://file0.assrt.net/file.srt?signed=temporary' }] };
let statusCode = 200;
const server = http.createServer(async (req, res) => {
  calls.push({ url: req.url, authorization: !!req.headers.authorization });
  res.statusCode = statusCode;
  if (statusCode !== 200) return res.end('{}');
  if (req.url === '/assist/v1/chat/completions') {
    assert.equal(req.headers.authorization, `Bearer ${analysisToken}`);
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(JSON.parse(body).messages[1].content);
    const result = input.task === 'search-name-candidates' ? { names: [{ name: 'Tokidoki Bosotto Russia-go de Dereru Tonari no Alya-san', language: 'romaji' }] } :
      { files: input.files.map(f => ({ id: f.id, episode: f.known_episode ?? (f.name === 'alpha.ja.srt' ? 4 : f.name === 'beta.ja.srt' ? 5 : null), same_release: true })) };
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] }));
  }
  if (req.url === '/subdl-archive') {
    assert.equal(req.headers.authorization, undefined);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', subdlZip.length);
    return res.end(Buffer.from(subdlZip));
  }
  if (req.url.startsWith('/jimaku-download/')) {
    assert.equal(req.headers.authorization, undefined);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    const name = decodeURIComponent(req.url), ep = name.match(/S01E(\d+)/)?.[1];
    return res.end(jimakuSrt(ep ? Number(ep) : name.includes('alpha.ja') ? 4 : name.includes('beta.ja') ? 5 : 5));
  }
  if (req.url.startsWith('/jimaku-api/')) {
    assert.equal(req.headers.authorization, jimakuToken);
    assert.match(req.headers['x-client-id'], /BetterSubs/);
    const u = new URL(req.url, 'http://localhost');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('x-ratelimit-limit', '100'); res.setHeader('x-ratelimit-remaining', '98');
    if (u.pathname.endsWith('/search') && u.searchParams.get('query') === 'Rate limited') {
      res.statusCode = 429; res.setHeader('x-ratelimit-reset-after', '1.5'); return res.end('{}');
    }
    if (u.pathname.endsWith('/search')) return res.end(JSON.stringify(u.searchParams.get('query') === 'Empty' ? [] : [jimakuExtended ? alyaEntry : jimakuTitle]));
    return res.end(JSON.stringify(u.pathname.includes('/5944') ? u.pathname.endsWith('/files') ? alyaFiles : alyaEntry : u.pathname.endsWith('/files') ? jimakuFiles : jimakuTitle));
  }
  if (req.url.startsWith('/subdl-download/')) {
    assert.equal(req.headers.authorization, undefined);
    res.setHeader('Content-Type', req.url.endsWith('.zip') ? 'application/zip' : 'text/plain; charset=utf-8');
    if (req.url.endsWith('zipOnly.zip')) {
      assert.ok(subdlZip.length > 100);
      res.setHeader('Content-Length', subdlZip.length);
      return res.end(Buffer.from(subdlZip));
    }
    return res.end(subdlSrt(req.url.endsWith('file5') ? 5 : 4));
  }
  if (req.url.startsWith('/subdl-api/')) {
    assert.equal(req.headers.authorization, `Bearer ${subdlToken}`);
    const u = new URL(req.url, 'http://localhost');
    res.setHeader('Content-Type', 'application/json');
    if (u.pathname.endsWith('/movies/search')) return res.end(JSON.stringify({ results: [subdlTitle] }));
    if (u.pathname.endsWith('/me')) return res.end(JSON.stringify({ usage: { search: { remaining: 1990 }, downloads: { remaining: 40 } } }));
    const packs = [subdlPack,
      { ...subdlPack, n_id: 'english', url: '/subtitle/english.zip', language: 'English', unpack_files: [] },
      { ...subdlPack, n_id: 'zipOnly', url: '/subtitle/zipOnly.zip', release_name: 'Academy S01 BD ZIP', unpack_files: [] }];
    const zh = u.searchParams.get('languages') === 'ZH,ZE,BG', page = Number(u.searchParams.get('page') || 1);
    const selected = zh ? packs.filter(p => p.language !== 'English') : page === 2 ? [packs[1]] : packs;
    const withKey = selected.map(p => ({ ...p, url: `${p.url}?api_key=${subdlToken}`,
      unpack_files: p.unpack_files.map(f => ({ ...f, url: `${f.url}?api_key=${subdlToken}` })) }));
    return res.end(JSON.stringify({ status: true, results: [subdlTitle], subtitles: withKey, currentPage: page, totalPages: zh ? 1 : 2 }));
  }
  if (req.url === '/native-file') {
    assert.equal(req.headers.authorization, undefined);
    res.setHeader('Content-Type', 'text/html');
    return res.end('<!doctype html><title>Native download probe</title>');
  }
  if (req.url.startsWith('/file')) { assert.equal(req.headers.authorization, undefined); return res.end(fileBody); }
  assert.equal(req.headers.authorization, `Bearer ${token}`);
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(req.url.includes('quota') ? { status: 0, user: { quota: 4 } } :
    { status: 0, sub: { subs: req.url.includes('search') && req.url.includes('Empty') ? [] : [item] } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser, externalPage;
try {
  browser = await chromium.launchPersistentContext(path.join(runDir, 'profile'), {
    executablePath: process.env.BROWSER_EXECUTABLE_PATH || chromium.executablePath(), headless: true,
    ignoreDefaultArgs: ['--disable-extensions'], locale: 'zh-CN',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 1180, height: 900 },
  });
  let worker = browser.serviceWorkers()[0];
  if (!worker) worker = await browser.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(() => {
    const Original = self.fflate.Unzip;
    self.__zipTrace = [];
    self.fflate.Unzip = class extends Original {
      constructor(callback) {
        super(file => { self.__zipTrace.push({ name: file.name, size: file.originalSize, compression: file.compression }); callback(file); });
      }
      push(data, final) {
        try { return super.push(data, final); }
        catch (e) { self.__zipTrace.push({ error: String(e?.message || 'unknown').slice(0, 150), code: e?.code }); throw e; }
      }
    };
  });
  await worker.evaluate(base => {
    const original = self.fetch.bind(self);
    self.fetch = (url, init) => {
      if (self.__assrtFault === 'detail' && String(url).includes('/sub/detail'))
        return Promise.reject(new DOMException('test timeout', 'TimeoutError'));
      if (self.__assrtFault === 'download' && new URL(url).hostname === 'file0.assrt.net')
        return Promise.reject(new TypeError('test connection failure'));
      if (new URL(url).hostname === 'file0.assrt.net') self.__fileProtocol = new URL(url).protocol;
      const mapped = typeof url === 'string' && url.startsWith('https://api.assrt.net/')
      ? `${base}/api/${url.slice('https://api.assrt.net/'.length)}`
      : typeof url === 'string' && url.startsWith('https://jimaku.cc/api/')
        ? `${base}/jimaku-api/${url.slice('https://jimaku.cc/api/'.length)}`
      : typeof url === 'string' && url.startsWith('https://jimaku.cc/entry/')
        ? `${base}/jimaku-download/${url.slice('https://jimaku.cc/entry/'.length)}`
      : typeof url === 'string' && url.startsWith('https://api.subdl.com/')
        ? `${base}/subdl-api/${url.slice('https://api.subdl.com/'.length)}`
      : typeof url === 'string' && url.startsWith('https://dl.subdl.com/')
        ? (url.endsWith('.zip') ? `${base}/subdl-archive` : `${base}/subdl-download/${url.slice('https://dl.subdl.com/'.length)}`)
      : typeof url === 'string' && /^https?:\/\/file0\.assrt\.net\//.test(url)
        ? `${base}/file` : url;
      return original(mapped, init).then(async response => {
        if (String(url).includes('zipOnly.zip')) {
          const bytes = new Uint8Array(await response.clone().arrayBuffer());
          self.__zipTrace.push({ length: bytes.length, magic: [...bytes.slice(0, 4)], status: response.status, type: response.type,
            contentLength: response.headers.get('content-length'), contentType: response.headers.get('content-type') });
        }
        return response;
      });
    };
  }, `http://127.0.0.1:${server.address().port}`);
  await worker.evaluate(() => chrome.storage.local.set({ externalSubCache: {
    searches: [], files: [], selections: {}, seriesOffsets: {}, identities: {},
  }, cacheMigrationMarker: 'keep' }));
  await worker.evaluate(() => {
    self.__externalRestoreTrace = [];
    chrome.runtime.onMessage.addListener((message, sender) => {
      if (['EXTERNAL_RESTORE', 'EXTERNAL_ACTIVE'].includes(message?.type)) self.__externalRestoreTrace.push({
        type: message.type, guid: message.payload?.guid, senderUrl: sender.url, tabUrl: sender.tab?.url,
      });
    });
  });
  const errors = [];
  browser.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const ld = { '@type': 'TVEpisode', url: '/watch/TEST/title', name: '第二集',
    episodeNumber: 2, partOfSeason: { seasonNumber: 1 },
    partOfSeries: { url: '/series/SERIES/title', name: '模拟学园', alternateName: 'Synthetic Academy' },
    potentialAction: { '@type': 'WatchAction', target: [{ url: '/watch/TEST/title' }, { url: '/watch/TEST/title' }] } };
  let delayedMetadata = false;
  let headingSeriesId = 'SERIES';
  const officialRequests = [];
  await browser.route('https://www.crunchyroll.com/**', async route => {
    const u = new URL(route.request().url());
    if (u.pathname.includes('/series/')) {
      officialRequests.push(u.pathname);
      const pathLanguage = u.pathname.split('/')[1], language = { en: 'en', 'zh-cn': 'zh-CN', 'zh-tw': 'zh-TW', ja: 'ja' }[pathLanguage];
      if (language === 'ja') return route.fulfill({ status: 403, body: 'Unavailable' });
      const name = language === 'en' ? alyaEnglish : language === 'zh-CN' ? '不时轻声地以俄语遮羞的邻座艾莉同学' : ld.partOfSeries.name;
      return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><link rel="canonical" href="https://www.crunchyroll.com/series/${headingSeriesId}">
        <script type="application/ld+json">${JSON.stringify({ '@type': 'TVSeries', url: `/series/${headingSeriesId}`, name })}</script></head><body><h1>${name}</h1></body></html>` });
    }
    return route.fulfill({
    contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8"><title>Offline player</title>
      <script type="application/ld+json">${JSON.stringify(delayedMetadata ? {} : ld)}</script></head>
      <body style="margin:0;background:#141414;color:white"><div id="player" style="position:relative;width:960px;height:540px">
      <video style="width:100%;height:100%"></video><div style="display:flex;position:absolute;bottom:0;right:0;height:44px;z-index:20">
      <button>1x</button><button aria-label="Subtitles">Subtitles</button></div></div>
      <div class="erc-current-media-info"><div class="current-media-header"><div class="current-media-parent-ref">
      <a class="show-title-link" href="/series/${headingSeriesId}/title">${ld.partOfSeries.name}</a></div></div></div>
      <script>window.__time=7.2;const video=document.querySelector('video');
      Object.defineProperty(video,'currentTime',{configurable:true,get:()=>window.__time,set:v=>window.__time=v});
      Object.defineProperty(video,'duration',{configurable:true,value:1800});
      Object.defineProperty(video,'videoWidth',{configurable:true,value:960});
      Object.defineProperty(video,'videoHeight',{configurable:true,value:540});
      ${delayedMetadata ? `
      setTimeout(()=>document.querySelector('script[type="application/ld+json"]').textContent=${JSON.stringify(JSON.stringify(ld))},1500);
      const startNative=setInterval(()=>{
        const ep=window.CRSubFix?.episode?.current?.();
        if(!ep||!document.getElementById('cr-jp-cc-btn'))return;
        clearInterval(startNative);
        const url='https://www.crunchyroll.com/native-fallback.vtt';
        ep.setCurrentAudio('ja-JP');ep.setJpUrls(url,null);
        ep.setCachedRawText(url,'WEBVTT\\n\\n00:00:02.000 --> 00:00:10.000\\nNative fallback subtitle\\n\\n00:29:50.000 --> 00:29:59.000\\nEnd\\n');
        document.documentElement.setAttribute('data-cr-auto-activate','true');
      },50);` : ''}
      </script></body></html>`,
    });
  });
  const watch = await browser.newPage();
  await watch.goto('https://www.crunchyroll.com/zh-tw/watch/TEST/title');
  await watch.locator('#cr-bsub-menu-btn').waitFor({ timeout: 15000 });
  await watch.waitForFunction(() => CRSubFix.episode.current()?.guid === 'TEST');
  // Isolated and MAIN worlds have separate JS wrappers; simulate native media
  // time in both without bypassing the real runtime captureTime message.
  const cdp = await browser.newCDPSession(watch), contexts = [];
  cdp.on('Runtime.executionContextCreated', ({ context }) => contexts.push(context));
  await cdp.send('Runtime.enable');
  const isolated = contexts.find(c => c.name.includes(extensionId) || c.origin === `chrome-extension://${extensionId}`);
  assert.ok(isolated);
  await cdp.send('Runtime.evaluate', { contextId: isolated.id,
    expression: "Object.defineProperty(document.querySelector('video'),'currentTime',{configurable:true,get:()=>Number(document.querySelector('video').getAttribute('data-test-time')||0)})" });
  await watch.locator('#cr-bsub-menu-btn').click();
  await (await uiText(watch, 'Manage')).click();
  const newPage = browser.waitForEvent('page');
  await watch.getByText('外部字幕…', { exact: true }).click();
  const page = await newPage.catch(async error => {
    const notice = await watch.evaluate(() => ({ text: document.body.innerText.slice(-1000),
      guid: CRSubFix.episode.current()?.guid }));
    throw new Error(`External page did not open: ${JSON.stringify(notice)}; page errors: ${JSON.stringify(errors)}; ${error.message}`);
  });
  externalPage = page;
  await page.waitForFunction(() => !document.getElementById('identity').disabled);
  assert.equal(await page.locator('#title').inputValue(), '模拟学园');
  assert.equal(await page.locator('#episode').inputValue(), '2');
  assert.equal(await page.locator('#englishTitle').inputValue(), 'Synthetic Academy');
  assert.equal(calls.length, 0);
  await page.locator('#search').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('配置'));
  assert.equal(calls.length, 0);
  checks.push('Menu opens independent page; metadata is current-episode scoped; no requests without token');
  await page.locator('#keyFile').setInputFiles({ name: 'key.txt', mimeType: 'text/plain', buffer: Buffer.from(`Token: ${token}`) });
  await page.waitForFunction(() => document.getElementById('key').value.length === 32);
  await page.locator('#saveKey').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('已保存在'));
  assert.equal(await page.locator('#key').inputValue(), '');
  await page.locator('#settings').evaluate(el => { el.open = true; });
  assert.equal(await page.locator('#httpDownload').isChecked(), false);
  await page.locator('#httpDownload').check();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('已允许旧服务器'));
  assert.equal((await worker.evaluate(() => chrome.storage.local.get('assrtHttpDownloads'))).assrtHttpDownloads, true);
  await page.locator('#search').click();
  await page.getByRole('button', { name: '查看文件', exact: true }).waitFor();
  assert.match(await page.locator('#results').textContent(), /测试字幕组/);
  await page.getByRole('button', { name: '查看文件', exact: true }).click();
  await page.waitForFunction(() => !document.getElementById('fileSection').hidden && !document.getElementById('preview').disabled);
  await worker.evaluate(() => { self.__assrtFault = 'detail'; });
  await page.locator('#preview').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('尚未开始下载'));
  assert.equal(await page.locator('#files').inputValue(), 'episode02.srt');
  await worker.evaluate(() => { self.__assrtFault = 'download'; });
  await page.locator('#preview').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('扩展无法连接'));
  assert.equal(await page.getByRole('button', { name: '查看文件', exact: true }).count(), 1);
  await worker.evaluate(async () => { self.__assrtFault = ''; await chrome.storage.local.remove('assrtRate'); });
  checks.push('Detail timeout and download connection failure are distinct; selection survives; explicit retry succeeds');
  await page.locator('#preview').click();
  await page.waitForFunction(() => !document.getElementById('previewSection').hidden);
  assert.equal(await page.locator('#cues tr').count(), 2);
  assert.equal(calls.filter(c => c.url.includes('/sub/detail')).length, 3);
  assert.equal(calls.at(-1).authorization, false);
  assert.equal(await worker.evaluate(() => self.__fileProtocol), 'http:');
  const cached = await worker.evaluate(() => self.CRSubFix.externalCache.create().get());
  assert.ok(!JSON.stringify(cached).includes('signed='));
  const migration = await worker.evaluate(() => chrome.storage.local.get(['externalSubCache', 'cacheMigrationMarker']));
  assert.equal(migration.externalSubCache, undefined);
  assert.equal(migration.cacheMigrationMarker, 'keep');
  checks.push('User selects result and file; preview refreshes detail, decodes UTF-8; cache has no signed URL');
  await page.locator('#httpDownload').uncheck();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('已关闭 HTTP'));
  checks.push('HTTP consent starts off, is explicitly persisted, applies only to original HTTP file URLs, and can be disabled');
  await watch.evaluate(() => { window.__time = 7; document.querySelector('video').setAttribute('data-test-time', '7'); });
  await page.locator('#cues tr').first().getByRole('button', { name: '标记 A', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('marks').textContent.includes('A：'));
  await watch.evaluate(() => { window.__time = 25; document.querySelector('video').setAttribute('data-test-time', '25'); });
  await page.locator('#cues tr').last().getByRole('button', { name: '标记 B', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('marks').textContent.includes('B：'));
  assert.equal(await page.locator('#scale').inputValue(), '1');
  assert.equal(await page.locator('#offset').inputValue(), '5');
  const selectedFileBeforeLanguage = await page.locator('#files').inputValue();
  const beforeLanguageRequests = calls.length;
  const subtitleCell = page.locator('#cues tr').last().locator('td').nth(3);
  const subtitleBefore = await subtitleCell.textContent();
  await subtitleCell.evaluate(node => { node.textContent = '保存'; });
  for (const language of ['en', 'ja', 'zh-Hant', 'zh-Hans']) {
    await worker.evaluate(value => chrome.storage.local.set({ uiLanguage: value }), language);
    await page.waitForFunction(value => document.documentElement.lang === value, language);
    assert.equal(await page.locator('#files').inputValue(), selectedFileBeforeLanguage);
    assert.equal(await page.locator('#offset').inputValue(), '5');
    assert.ok((await page.locator('#cues').textContent()).includes('第一句话'));
    assert.equal(await subtitleCell.textContent(), '保存', 'A subtitle matching a UI label must remain untouched');
  }
  await subtitleCell.evaluate((node, text) => { node.textContent = text; }, subtitleBefore);
  assert.equal(calls.length, beforeLanguageRequests, 'Language changes must not search, download or translate');
  checks.push('Changing all four UI languages preserves selected file, timing and preview without network calls');
  await page.locator('#remember').check();
  await watch.evaluate(() => { window.__time = 7.2; document.querySelector('video').dispatchEvent(new Event('timeupdate')); });
  await page.locator('#apply').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('已加载到'));
  await watch.getByText('第一句话', { exact: true }).waitFor();
  checks.push('Two chosen cues capture player time; loaded cue is visible in actual renderer');
  let countBefore = calls.length;
  await watch.locator('#cr-bsub-menu-btn').click();
  await (await uiText(watch, 'Manage')).click();
  await (await uiText(watch, '⚙ Adjust sync…')).click();
  await watch.getByText('+0.1s', { exact: true }).click();
  await page.waitForTimeout(150);
  assert.equal((await worker.evaluate(() => self.CRSubFix.externalCache.create().get())).selections.TEST.sync.offset, 5.1);
  await watch.reload();
  await watch.getByText('第一句话', { exact: true }).waitFor({ timeout: 12000 });
  assert.equal(calls.length, countBefore);
  assert.equal(await watch.evaluate(() => window.CRSubFix.episode.current().listCustomSources().filter(s => s.kind === 'external').length), 1);
  await page.reload();
  await page.waitForFunction(() => !document.getElementById('previewSection').hidden && !document.getElementById('identity').disabled);
  assert.equal(await page.locator('#offset').inputValue(), '5.1');
  assert.match(await page.locator('#previewInfo').textContent(), /本地缓存/);
  assert.equal(calls.length, countBefore);
  checks.push('100ms adjustment persisted; watch and external-page refresh restore from cache without network');
  await page.screenshot({ path: path.join(artifacts, 'external-subtitles-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(artifacts, 'external-subtitles-mobile.png'), fullPage: true });
  await watch.screenshot({ path: path.join(artifacts, 'external-subtitles-player.png') });
  checks.push('Desktop and narrow-page layouts fit; subtitle rendered in player screenshot');
  await page.locator('#settings').evaluate(el => { el.open = true; });
  await page.locator('#clearKey').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('已清除'));
  await page.locator('#apply').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('已加载到'));
  assert.equal(calls.length, countBefore);
  checks.push('Clearing token does not disable cached playback');
  await watch.locator('#cr-jp-cc-btn').click();
  await page.waitForTimeout(100);
  assert.equal((await worker.evaluate(() => self.CRSubFix.externalCache.create().get())).selections.TEST.active, false);
  await watch.reload();
  await watch.locator('#cr-bsub-menu-btn').waitFor();
  await watch.waitForTimeout(1200);
  assert.equal(await watch.getByText('第一句话', { exact: true }).count(), 0);
  const savedLabel = await watch.evaluate(() => window.CRSubFix.episode.current().listCustomSources().find(s => s.kind === 'external').label);
  await watch.locator('#cr-bsub-menu-btn').click();
  await watch.getByText(savedLabel, { exact: true }).click();
  await watch.getByText('第一句话', { exact: true }).waitFor();
  await page.waitForTimeout(100);
  assert.equal((await worker.evaluate(() => self.CRSubFix.externalCache.create().get())).selections.TEST.active, true);
  await watch.reload();
  await watch.getByText('第一句话', { exact: true }).waitFor({ timeout: 12000 });
  assert.equal(calls.length, countBefore);
  checks.push('Turning subtitles off remains off after refresh; explicit menu re-selection restores active state without network');
  const assTime = ticks => {
    const seconds = ticks / 10;
    return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;
  };
  fileBody = '[Script Info]\n;' + 'x'.repeat(4 * 1024 * 1024) + '\n[Events]\n' +
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n' +
    Array.from({ length: 12500 }, (_, i) => `Dialogue: 0,${assTime(i + 1)},${assTime(i + 2)},Default,,0,0,0,,large-line-${i}`).join('\n');
  let largeCount = 12500;
  const sourceIndex = process.argv.indexOf('--subtitle-file');
  if (sourceIndex !== -1) {
    const fixture = vm.createContext({ TextDecoder, Uint8Array, URL }); fixture.self = fixture;
    for (const name of ['assrt', 'subtitle-parser']) vm.runInContext(await readFile(path.join(root, `extension/lib/${name}.js`), 'utf8'), fixture);
    const data = new Uint8Array(await readFile(process.argv[sourceIndex + 1]));
    fileBody = fixture.CRSubFix.assrt.decode(data).text;
    largeCount = fixture.CRSubFix.parser.parseSubtitles(fileBody, 'large.ass').length;
    assert.ok(largeCount > 0 && largeCount <= 30000);
  }
  item.filelist = [{ f: 'large.ass', s: '5MB', url: 'https://file0.assrt.net/large.ass?signed=temporary' }];
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ assrtApiKey: 'a'.repeat(32) });
    await chrome.storage.local.remove('assrtRate');
  });
  await page.getByRole('button', { name: '查看文件', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('files').value === 'large.ass' && !document.getElementById('preview').disabled);
  await page.locator('#preview').click();
  await page.waitForFunction(count => document.getElementById('previewInfo').textContent.includes(String(count)) && !document.getElementById('apply').disabled, largeCount);
  await page.locator('#apply').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('已加载到'));
  await watch.waitForFunction(count => window.CRSubFix.episode.current().getCustomSource(window.CRSubFix.episode.current().activeSource()).srcCues.length === count, largeCount);
  countBefore = calls.length;
  await page.reload();
  await page.waitForFunction(count => document.getElementById('previewInfo').textContent.includes(String(count)) && !document.getElementById('identity').disabled, largeCount);
  await watch.reload();
  await watch.waitForFunction(count => {
    const ep = window.CRSubFix?.episode?.current();
    return ep?.getCustomSource(ep.activeSource())?.srcCues.length === count;
  }, largeCount);
  assert.equal(calls.length, countBefore);
  checks.push(`Large ASS with ${largeCount} displayable events downloads, previews, installs and restores from IndexedDB without network; legacy cache migrated`);
  await worker.evaluate(base => {
    const original = chrome.tabs.create.bind(chrome.tabs);
    chrome.tabs.create = args => {
      if (new URL(args.url).host === 'file0.assrt.net') {
        self.__nativeTarget = args.url;
        return original({ ...args, url: `${base}/native-file` });
      }
      if (new URL(args.url).host === 'dl.subdl.com') {
        self.__subdlTarget = args.url;
        return original({ ...args, url: `${base}/native-file` });
      }
      return original(args);
    };
  }, `http://127.0.0.1:${server.address().port}`);
  const downloadTab = browser.waitForEvent('page');
  await page.locator('#openDownload').click();
  const nativePage = await downloadTab;
  await nativePage.waitForLoadState();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('新标签页'));
  const nativeUrl = await worker.evaluate(() => self.__nativeTarget);
  assert.ok(nativeUrl);
  assert.equal(new URL(nativeUrl).host, 'file0.assrt.net');
  assert.ok(!nativeUrl.includes(token));
  assert.equal(new URL(nativePage.url()).pathname, '/native-file');
  await nativePage.close();
  countBefore = calls.length;
  checks.push('Explicit browser download action opens a freshly resolved HTTPS file URL without an API token');
  const taggedFilename = ep => `Boku dake ga Inai Machi 0${ep}.Kamigami-SC.ass`;
  const assHeader = '[Script Info]\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n';
  item.filelist = [2, 3, 4].map(ep => ({ f: taggedFilename(ep), s: 200, url: `https://file0.assrt.net/episode0${ep}.ass` }));
  fileBody = assHeader + 'Dialogue: 0,0:00:02.00,0:00:05.00,Default,,0,0,0,,第一句话\n' +
    'Dialogue: 0,0:00:20.00,0:00:23.00,Default,,0,0,0,,第二句话\n';
  await worker.evaluate(() => chrome.storage.local.remove('assrtRate'));
  await page.getByRole('button', { name: '查看文件', exact: true }).click();
  await page.waitForFunction(name => document.getElementById('files').value === name && !document.getElementById('preview').disabled, taggedFilename(2));
  await page.locator('#preview').click();
  await page.waitForFunction(() => document.getElementById('previewInfo').textContent.includes('2 条') && !document.getElementById('apply').disabled);
  await page.locator('#followCollection').check();
  await page.locator('#offset').fill('-2'); await page.locator('#scale').fill('1.25');
  await page.locator('#inheritOffset').check();
  await page.locator('#apply').click();
  await page.waitForFunction(() => document.getElementById('followInfo').textContent.includes('第 1 季'));
  fileBody = assHeader + 'Dialogue: 0,0:00:02.00,0:00:10.00,Default,,0,0,0,,自动第3集字幕\n';
  ld.url = '/watch/NEXT/title'; ld.episodeNumber = 3;
  ld.potentialAction.target = [{ url: ld.url }, { url: ld.url }];
  const beforeFollow = calls.length;
  await watch.evaluate(metadata => {
    document.querySelector('script[type="application/ld+json"]').textContent = '{}';
    history.pushState({}, '', '/zh-tw/watch/NEXT');
    setTimeout(() => history.replaceState({}, '', '/zh-tw/watch/NEXT/title'), 100);
    setTimeout(() => {
      document.querySelector('script[type="application/ld+json"]').textContent = JSON.stringify(metadata);
      const ep = window.CRSubFix.episode.current(), url = 'https://www.crunchyroll.com/native-fallback.vtt';
      ep.setCurrentAudio('ja-JP'); ep.setJpUrls(url, null);
      ep.setCachedRawText(url, 'WEBVTT\n\n00:00:02.000 --> 00:00:10.000\nNative fallback subtitle\n\n00:29:50.000 --> 00:29:59.000\nEnd\n');
      document.documentElement.setAttribute('data-cr-auto-activate', 'true');
    }, 7500);
  }, ld);
  await watch.waitForTimeout(6500);
  assert.equal(calls.length, beforeFollow, 'No provider requests before current-episode metadata is ready');
  await watch.waitForFunction(label => window.CRSubFix?.episode?.current()?.listCustomSources().some(s => s.kind === 'external' && s.label === label),
    taggedFilename(3).replace(/\.[^.]+$/, '').slice(0, 40) + ' · assrt');
  await watch.getByText('自动第3集字幕', { exact: true }).waitFor();
  assert.equal(calls.length - beforeFollow, 2);
  await watch.evaluate(() => {
    const old = document.querySelector('video'), video = document.createElement('video');
    video.style.cssText = old.style.cssText;
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => window.__time });
    Object.defineProperty(video, 'duration', { configurable: true, value: 1800 });
    Object.defineProperty(video, 'videoWidth', { configurable: true, value: 960 });
    Object.defineProperty(video, 'videoHeight', { configurable: true, value: 540 });
    old.replaceWith(video);
  });
  await watch.getByText('自动第3集字幕', { exact: true }).waitFor();
  assert.equal(calls.length - beforeFollow, 2, 'Replacing the player must not repeat provider calls');
  await watch.screenshot({ path: path.join(artifacts, 'collection-follow-spa-player.png'), fullPage: false });
  delayedMetadata = false;
  await watch.reload();
  await watch.getByText('自动第3集字幕', { exact: true }).waitFor();
  assert.equal(calls.length - beforeFollow, 2);
  checks.push('SPA next-episode slug normalization and 7.5s-late metadata follow tagged ASS without refresh; player replacement recovers from the same result; no duplicate downloads');
  const followPagePromise = browser.waitForEvent('page');
  await watch.locator('#cr-bsub-menu-btn').click(); await (await uiText(watch, 'Manage')).click();
  await watch.getByText('外部字幕…', { exact: true }).click();
  const followPage = await followPagePromise;
  await followPage.waitForFunction(() => !document.getElementById('previewSection').hidden);
  assert.equal(await followPage.locator('#offset').inputValue(), '-2');
  assert.equal(await followPage.locator('#scale').inputValue(), '1');
  assert.equal(await followPage.locator('#inheritOffset').isChecked(), true);
  assert.match(await followPage.locator('#seriesInfo').textContent(), /合集默认偏移：-2/);
  await followPage.locator('#previewSection').scrollIntoViewIfNeeded();
  await followPage.screenshot({ path: path.join(artifacts, 'collection-offset-desktop.png'), fullPage: true });
  await followPage.setViewportSize({ width: 420, height: 780 });
  assert.ok(await followPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await followPage.screenshot({ path: path.join(artifacts, 'collection-offset-mobile.png'), fullPage: true });
  checks.push('Explicit -2s collection offset reaches next-episode playback/cache/editor; scale resets to 1; checkbox persists and narrow layout fits');
  await followPage.locator('#stopFollow').click();
  await followPage.waitForFunction(() => document.getElementById('status').textContent.includes('已停止跟随'));
  ld.url = '/watch/FOURTH/title'; ld.episodeNumber = 4;
  ld.potentialAction.target = [{ url: ld.url }, { url: ld.url }];
  countBefore = calls.length;
  await watch.goto('https://www.crunchyroll.com/zh-tw/watch/FOURTH/title');
  await watch.locator('#cr-bsub-menu-btn').waitFor(); await watch.waitForTimeout(1500);
  assert.equal(calls.length, countBefore);
  assert.equal(await watch.evaluate(() => window.CRSubFix.episode.current().listCustomSources().length), 0);
  await followPage.close();
  checks.push('Trusted follow controls survive new-episode page open; stopping follow leaves current track and disables subsequent downloads');
  await watch.evaluate(() => history.pushState({}, '', '/zh-tw/watch/OTHER/other'));
  await page.locator('#apply').click();
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('切集'));
  assert.equal(await watch.evaluate(() => window.CRSubFix.episode.current().listCustomSources().length), 0);
  assert.equal(calls.length, countBefore);
  checks.push('Navigation rejects stale apply and never installs previous episode subtitle');
  await watch.goto('https://www.crunchyroll.com/zh-tw/watch/FOURTH/title');
  await watch.locator('#cr-bsub-menu-btn').waitFor();
  const subdlPagePromise = browser.waitForEvent('page');
  await watch.locator('#cr-bsub-menu-btn').click(); await (await uiText(watch, 'Manage')).click();
  await watch.getByText('外部字幕…', { exact: true }).click();
  const subdlPage = await subdlPagePromise; externalPage = subdlPage;
  await subdlPage.waitForFunction(() => !document.getElementById('identity').disabled);
  await subdlPage.locator('#source').selectOption('subdl');
  await subdlPage.locator('#query').fill('Synthetic Academy');
  const beforeKey = calls.length;
  await subdlPage.locator('#search').click();
  await subdlPage.waitForFunction(() => document.getElementById('status').textContent.includes('SubDL API Key'));
  assert.equal(calls.length, beforeKey);
  await subdlPage.locator('#subdlSettings').evaluate(el => { el.open = true; });
  await subdlPage.locator('#subdlKeyFile').setInputFiles({ name: 'subdl-key.txt', mimeType: 'text/plain', buffer: Buffer.from(subdlToken) });
  await subdlPage.waitForFunction(() => document.getElementById('subdlKey').value.length > 8);
  await subdlPage.locator('#subdlSaveKey').click();
  await subdlPage.waitForFunction(() => document.getElementById('status').textContent.includes('SubDL Key 已保存在'));
  assert.equal(await subdlPage.locator('#subdlKey').inputValue(), '');
  await subdlPage.locator('#search').click();
  await subdlPage.getByRole('button', { name: '查看字幕', exact: true }).click();
  await subdlPage.getByRole('button', { name: '查看文件', exact: true }).first().waitFor();
  assert.equal(await subdlPage.getByRole('button', { name: '查看文件', exact: true }).count(), 2);
  await subdlPage.locator('#subdlLanguage').selectOption('all');
  await subdlPage.waitForFunction(() => !document.getElementById('search').disabled && document.querySelectorAll('#results .candidate').length === 3);
  assert.equal(await subdlPage.getByRole('button', { name: '查看文件', exact: true }).count(), 3);
  await subdlPage.locator('#next').click();
  await subdlPage.waitForFunction(() => !document.getElementById('search').disabled && document.getElementById('resultInfo').textContent.includes('第 2 页'));
  assert.equal(await subdlPage.getByRole('button', { name: '查看文件', exact: true }).count(), 1);
  assert.equal(await subdlPage.locator('#next').isDisabled(), true);
  await subdlPage.locator('#previous').click();
  await subdlPage.waitForFunction(() => !document.getElementById('search').disabled && document.querySelectorAll('#results .candidate').length === 3);
  await subdlPage.locator('#subdlLanguage').selectOption('zh');
  await subdlPage.waitForFunction(() => !document.getElementById('search').disabled && document.querySelectorAll('#results .candidate').length === 2);
  await subdlPage.getByRole('button', { name: '查看文件', exact: true }).first().click();
  await subdlPage.waitForFunction(() => document.getElementById('files').value === 'Academy S01E04.srt');
  await subdlPage.locator('#preview').click();
  await subdlPage.waitForFunction(() => document.getElementById('previewInfo').textContent.includes('1 条') && !document.getElementById('apply').disabled);
  await subdlPage.locator('#offset').fill('-2');
  await subdlPage.locator('#followCollection').check(); await subdlPage.locator('#inheritOffset').check();
  await subdlPage.locator('#apply').click();
  await subdlPage.waitForFunction(() => document.getElementById('status').textContent.includes('已加载到'));
  await watch.getByText('SubDL 第4集字幕', { exact: true }).waitFor();
  assert.ok(await watch.evaluate(() => window.CRSubFix.episode.current().activeSource().startsWith('custom:subdl:42:')));
  await subdlPage.setViewportSize({ width: 1180, height: 900 });
  await subdlPage.screenshot({ path: path.join(artifacts, 'subdl-desktop.png'), fullPage: true });
  await subdlPage.setViewportSize({ width: 420, height: 780 });
  assert.ok(await subdlPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await subdlPage.screenshot({ path: path.join(artifacts, 'subdl-mobile.png'), fullPage: true });
  checks.push('SubDL independent key import, explicit title/pack/file selection, Chinese filtering, raw-file rendering and responsive layouts');
  ld.url = '/watch/FIFTH/title'; ld.episodeNumber = 5;
  ld.potentialAction.target = [{ url: ld.url }, { url: ld.url }];
  const beforeSubdlFollow = calls.length;
  await watch.evaluate(metadata => {
    document.querySelector('script[type="application/ld+json"]').textContent = JSON.stringify(metadata);
    history.pushState({}, '', '/zh-tw/watch/FIFTH/title');
  }, ld);
  await watch.getByText('SubDL 第5集字幕', { exact: true }).waitFor();
  assert.equal(calls.length - beforeSubdlFollow, 2);
  const subdlRecord = await worker.evaluate(() => self.CRSubFix.externalCache.create().get());
  assert.equal(subdlRecord.selections.FIFTH.sync.offset, -2);
  await watch.reload(); await watch.getByText('SubDL 第5集字幕', { exact: true }).waitFor();
  assert.equal(calls.length - beforeSubdlFollow, 2);
  await watch.screenshot({ path: path.join(artifacts, 'subdl-follow-player.png') });
  checks.push('SubDL SPA follows same pack and language with inherited offset; reload uses cache without provider calls');
  const fifthPagePromise = browser.waitForEvent('page');
  await watch.locator('#cr-bsub-menu-btn').click(); await (await uiText(watch, 'Manage')).click();
  await watch.getByText('外部字幕…', { exact: true }).click();
  const fifthPage = await fifthPagePromise; externalPage = fifthPage;
  await fifthPage.waitForFunction(() => !document.getElementById('previewSection').hidden);
  assert.equal(await fifthPage.locator('#source').inputValue(), 'subdl');
  assert.equal(await fifthPage.locator('#offset').inputValue(), '-2');
  await fifthPage.locator('#search').click();
  await fifthPage.getByRole('button', { name: '查看字幕', exact: true }).click();
  await fifthPage.getByRole('button', { name: '查看文件', exact: true }).last().click();
  await fifthPage.waitForFunction(() => document.getElementById('files').options.length === 2);
  await fifthPage.locator('#files').selectOption('Academy S01E05.srt');
  const beforeZipPreview = calls.length;
  await fifthPage.locator('#preview').click();
  await fifthPage.waitForFunction(() => document.getElementById('previewInfo').textContent.includes('1 条') && !document.getElementById('apply').disabled);
  assert.equal(calls.length - beforeZipPreview, 1, 'ZIP body from file listing is reused; only detail refresh runs');
  await fifthPage.locator('#offset').fill('-2'); await fifthPage.locator('#apply').click();
  await fifthPage.waitForFunction(() => document.getElementById('status').textContent.includes('已加载到'));
  await watch.getByText('SubDL 第5集字幕', { exact: true }).waitFor();
  const subdlDownloadTab = browser.waitForEvent('page');
  await fifthPage.getByRole('button', { name: '下载 ZIP', exact: true }).last().click();
  const subdlNativePage = await subdlDownloadTab;
  await subdlNativePage.waitForLoadState();
  await fifthPage.waitForFunction(() => document.getElementById('status').textContent.includes('原始 ZIP'));
  assert.equal(await worker.evaluate(() => self.__subdlTarget), 'https://dl.subdl.com/subtitle/zipOnly.zip');
  await subdlNativePage.close();
  await fifthPage.locator('#subdlSettings').evaluate(el => { el.open = true; });
  await fifthPage.locator('#subdlQuota').click();
  await fifthPage.waitForFunction(() => document.getElementById('status').textContent.includes('1990'));
  await fifthPage.locator('#subdlClearKey').click();
  await fifthPage.waitForFunction(() => document.getElementById('status').textContent.includes('已清除 SubDL Key'));
  const beforeOffline = calls.length;
  await fifthPage.reload(); await fifthPage.waitForFunction(() => !document.getElementById('previewSection').hidden);
  await watch.reload(); await watch.getByText('SubDL 第5集字幕', { exact: true }).waitFor();
  assert.equal(calls.length, beforeOffline);
  assert.equal((await worker.evaluate(() => chrome.storage.local.get('assrtApiKey'))).assrtApiKey, token);
  checks.push('SubDL ZIP expansion, selected episode rendering, quota UI and offline recovery after clearing only SubDL key');
  await fifthPage.locator('#source').selectOption('jimaku');
  await fifthPage.locator('#jimakuSettings').evaluate(el => { el.open = true; });
  await fifthPage.locator('#jimakuKeyFile').setInputFiles({ name: 'jimaku-key.txt', mimeType: 'text/plain', buffer: Buffer.from(jimakuToken) });
  await fifthPage.waitForFunction(() => document.getElementById('jimakuKey').value.length > 8);
  await fifthPage.locator('#jimakuSaveKey').click();
  await fifthPage.waitForFunction(() => document.getElementById('status').textContent.includes('Jimaku Key 已保存在'));
  assert.equal(await fifthPage.locator('#jimakuKey').inputValue(), '');
  await fifthPage.locator('#query').fill('Empty'); await fifthPage.locator('#search').click();
  await fifthPage.waitForFunction(() => document.getElementById('status').textContent.includes('未找到字幕'));
  const beforeMtDraft = calls.length;
  const oldMt = await worker.evaluate(() => chrome.storage.local.get(['mtConfig', 'mtTarget']));
  const mtDraftPromise = browser.waitForEvent('page');
  await fifthPage.getByRole('link', { name: '机翻成日文…' }).click();
  const mtDraft = await mtDraftPromise;
  await mtDraft.waitForFunction(() => !document.getElementById('fields').disabled);
  assert.equal(await mtDraft.locator('#target').inputValue(), 'ja-JP');
  assert.match(await mtDraft.locator('#status').textContent(), /尚未保存或开始翻译/);
  assert.deepEqual(await worker.evaluate(() => chrome.storage.local.get(['mtConfig', 'mtTarget'])), oldMt);
  assert.equal(calls.length, beforeMtDraft); await mtDraft.close();
  await fifthPage.locator('#query').fill('Rate limited'); await fifthPage.locator('#search').click();
  await fifthPage.waitForFunction(() => document.getElementById('status').textContent.includes('按 IP 限流'));
  await watch.getByText('SubDL 第5集字幕', { exact: true }).waitFor();
  const beforeCooldown = calls.length; await fifthPage.locator('#search').click();
  await fifthPage.waitForFunction(() => !document.getElementById('search').disabled);
  assert.equal(calls.length, beforeCooldown);
  await worker.evaluate(() => chrome.storage.local.remove('jimakuUntil'));
  checks.push('Jimaku empty search and 429 preserve the playing track; Japanese fallback opens existing MT settings as an unsaved draft without any provider call');
  await fifthPage.locator('#jimakuAnilist').fill('1001'); await fifthPage.locator('#query').fill('');
  await fifthPage.locator('#search').click();
  await fifthPage.getByRole('button', { name: '查看文件', exact: true }).click();
  await fifthPage.waitForFunction(() => document.getElementById('files').options.length === 2);
  await fifthPage.locator('#files').selectOption(jimakuName(5));
  await fifthPage.locator('#preview').click();
  await fifthPage.waitForFunction(() => document.getElementById('previewInfo').textContent.includes('1 条') && !document.getElementById('apply').disabled);
  assert.equal(await fifthPage.locator('#language').inputValue(), 'ja-JP');
  await fifthPage.locator('#offset').fill('-2'); await fifthPage.locator('#followCollection').check();
  await fifthPage.locator('#inheritOffset').check(); await fifthPage.locator('#apply').click();
  await fifthPage.waitForFunction(() => document.getElementById('status').textContent.includes('已加载到'));
  await watch.getByText('こんにちは。これは第5話のテスト字幕です。', { exact: true }).waitFor();
  await fifthPage.locator('#jimakuSettings').evaluate(el => { el.open = true; });
  await fifthPage.locator('#jimakuRate').click();
  await fifthPage.waitForFunction(() => document.getElementById('status').textContent.includes('98 / 100'));
  await fifthPage.setViewportSize({ width: 1180, height: 900 });
  await fifthPage.screenshot({ path: path.join(artifacts, 'jimaku-desktop.png'), fullPage: true });
  await fifthPage.setViewportSize({ width: 420, height: 780 });
  assert.ok(await fifthPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await fifthPage.screenshot({ path: path.join(artifacts, 'jimaku-mobile.png'), fullPage: true });
  checks.push('Jimaku raw-key import, AniList-first search, explicit directory/file selection, detected Japanese preview/rendering and desktop/mobile layouts');
  ld.url = '/watch/SIXTH/title'; ld.episodeNumber = 6;
  ld.potentialAction.target = [{ url: ld.url }, { url: ld.url }];
  const beforeJimakuFollow = calls.length;
  await watch.evaluate(metadata => {
    document.querySelector('script[type="application/ld+json"]').textContent = JSON.stringify(metadata);
    history.pushState({}, '', '/zh-tw/watch/SIXTH/title');
  }, ld);
  await watch.getByText('こんにちは。これは第6話のテスト字幕です。', { exact: true }).waitFor();
  assert.equal(calls.length - beforeJimakuFollow, 3);
  const jimakuCache = await worker.evaluate(() => self.CRSubFix.externalCache.create().get());
  assert.equal(jimakuCache.selections.SIXTH.sync.offset, -2); assert.equal(jimakuCache.selections.SIXTH.lang, 'ja-JP');
  await watch.screenshot({ path: path.join(artifacts, 'jimaku-follow-player.png') });
  await fifthPage.locator('#jimakuClearKey').click();
  await fifthPage.waitForFunction(() => document.getElementById('status').textContent.includes('已清除 Jimaku Key'));
  await watch.reload(); await watch.getByText('こんにちは。これは第6話のテスト字幕です。', { exact: true }).waitFor();
  assert.equal(calls.length - beforeJimakuFollow, 3);
  assert.equal((await worker.evaluate(() => chrome.storage.local.get('assrtApiKey'))).assrtApiKey, token);
  checks.push('Jimaku SPA next episode follows only the selected directory/template with -2s offset; clearing its key and reload preserve offline Japanese playback and other credentials');
  const alyaTitle = '不時輕聲地以俄語遮羞的鄰座艾莉同學';
  headingSeriesId = 'G1XHJV0XM';
  ld.url = '/watch/GX9UQEGM5/and-so-they-met'; ld.episodeNumber = 3;
  ld.partOfSeries = { name: alyaTitle }; ld.potentialAction.target = [{ url: ld.url }];
  await worker.evaluate(async () => {
    const cache = self.CRSubFix.externalCache.create(), db = await cache.get();
    db.identities.GX9UQEGM5 = { guid: 'GX9UQEGM5', seriesId: 'G1XHJV0XM', title: '', englishTitle: '', episode: null, season: null };
    for (const source of ['assrt', 'subdl', 'jimaku']) db.searches.push({ key: `legacy-${source}`, guid: 'GX9UQEGM5', source,
      query: source === 'jimaku' ? 'AniList:199111' : '碧蓝之海', anilistId: source === 'jimaku' ? '199111' : null,
      items: [], pos: 0, at: Date.now(), expires: Date.now() + 3600000 });
    await cache.set(db);
  });
  const beforeIdentityRefresh = calls.length;
  await watch.goto('https://www.crunchyroll.com/zh-tw/watch/GX9UQEGM5/and-so-they-met');
  await watch.locator('#cr-bsub-menu-btn').waitFor();
  const identityPagePromise = browser.waitForEvent('page');
  await watch.locator('#cr-bsub-menu-btn').click(); await (await uiText(watch, 'Manage')).click();
  await watch.getByText('外部字幕…', { exact: true }).click();
  const identityPage = await identityPagePromise; externalPage = identityPage;
  await identityPage.waitForFunction(() => !document.getElementById('identity').disabled);
  assert.equal(await identityPage.locator('#title').inputValue(), alyaTitle);
  assert.equal(await identityPage.locator('#season').inputValue(), '1'); assert.equal(await identityPage.locator('#episode').inputValue(), '3');
  assert.equal(await identityPage.locator('#query').inputValue(), '不时轻声地以俄语遮羞的邻座艾莉同学');
  assert.equal(await identityPage.locator('#jimakuAnilist').inputValue(), '');
  assert.equal(await identityPage.locator('#results .candidate').count(), 0);
  for (const source of ['jimaku', 'subdl', 'assrt']) {
    await identityPage.locator('#source').selectOption(source);
    assert.equal(await identityPage.locator('#query').inputValue(), source === 'assrt' ? '不时轻声地以俄语遮羞的邻座艾莉同学' : alyaTitle);
    assert.equal(await identityPage.locator('#results .candidate').count(), 0);
  }
  await identityPage.locator('#source').selectOption('jimaku');
  await identityPage.locator('#jimakuAnilist').fill('199111'); await identityPage.locator('#query').fill('Another');
  assert.equal(await identityPage.locator('#jimakuAnilist').inputValue(), '');
  assert.equal(calls.length, beforeIdentityRefresh, 'Metadata repair, source switch and editing do not make provider calls');
  await identityPage.locator('#source').selectOption('assrt');
  await identityPage.setViewportSize({ width: 1180, height: 900 });
  await identityPage.screenshot({ path: path.join(artifacts, 'identity-refresh-desktop.png'), fullPage: true });
  await identityPage.setViewportSize({ width: 420, height: 780 });
  assert.ok(await identityPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await identityPage.screenshot({ path: path.join(artifacts, 'identity-refresh-mobile.png'), fullPage: true });
  checks.push('Real-CR-shaped Alya metadata overrides blank legacy identity; Grand Blue queries/AniList caches never restore across sources; keyword edit clears stale AniList with no provider calls');
  const noAiBefore = calls.length;
  assert.equal(await identityPage.locator('#aiNames').isDisabled(), true);
  await identityPage.locator('#nameLanguage').selectOption('zh-CN');
  assert.match(await identityPage.locator('#nameCandidates').textContent(), /本地简繁转换/);
  await identityPage.locator('#useSearchName').click();
  await identityPage.waitForFunction(() => document.getElementById('status').textContent.includes('名称已选择'));
  assert.equal(await identityPage.locator('#query').inputValue(), '不时轻声地以俄语遮羞的邻座艾莉同学');
  assert.equal(calls.length, noAiBefore);
  await identityPage.locator('#officialNames').click();
  await identityPage.waitForFunction(() => document.getElementById('status').textContent.includes('官方名称查询完成'));
  assert.equal(officialRequests.length, 4);
  assert.match(await identityPage.locator('#status').textContent(), /日文暂未取得/);
  await identityPage.locator('#nameLanguage').selectOption('en');
  assert.match(await identityPage.locator('#nameCandidates').textContent(), /Crunchyroll 官方/);
  await identityPage.locator('#useSearchName').click();
  await identityPage.waitForFunction(() => document.getElementById('status').textContent.includes('名称已选择'));
  assert.equal(await identityPage.locator('#query').inputValue(), alyaEnglish);
  await identityPage.locator('#officialNames').click();
  await identityPage.waitForFunction(() => !document.getElementById('searchControls').disabled);
  assert.equal(officialRequests.length, 4); assert.equal(calls.length, noAiBefore);
  checks.push('Offline Simplified/Traditional name choices require no model; official locale query isolates Japanese failure, preserves provenance and caches successful records');
  await worker.evaluate(() => chrome.storage.local.set({ relayConfig: { provider: 'deepl' }, mtApiKey: 'synthetic:fx' }));
  await identityPage.reload();
  await identityPage.waitForFunction(() => !document.getElementById('identity').disabled);
  assert.equal(await identityPage.locator('#aiNames').isDisabled(), true);
  await identityPage.locator('#assistSettings').evaluate(el => { el.open = true; });
  await identityPage.locator('#assistBase').fill(`http://127.0.0.1:${server.address().port}/assist/v1`);
  await identityPage.locator('#assistModelInput').fill('synthetic-analysis');
  await identityPage.locator('#assistKeyFile').setInputFiles({ name: 'analysis.txt', mimeType: 'text/plain', buffer: Buffer.from(analysisToken) });
  await identityPage.waitForFunction(() => document.getElementById('assistKey').value.length > 0);
  await identityPage.locator('#assistSave').click();
  await identityPage.waitForFunction(() => document.getElementById('status').textContent.includes('独立分析 API 已保存'));
  assert.equal(await identityPage.locator('#assistKey').inputValue(), '');
  assert.equal((await worker.evaluate(() => chrome.storage.local.get('relayConfig'))).relayConfig.provider, 'deepl');
  const beforeAiName = calls.length;
  await identityPage.locator('#aiNames').click();
  await identityPage.waitForFunction(() => document.getElementById('status').textContent.includes('AI 名称候选已生成'));
  assert.equal(calls.length - beforeAiName, 1);
  await identityPage.locator('#nameLanguage').selectOption('romaji');
  assert.match(await identityPage.locator('#nameCandidates').textContent(), /AI 候选 · 待确认/);
  assert.notEqual(await identityPage.locator('#query').inputValue(), 'Tokidoki Bosotto Russia-go de Dereru Tonari no Alya-san');
  await identityPage.locator('#useSearchName').click();
  await identityPage.waitForFunction(() => document.getElementById('status').textContent.includes('名称已选择'));
  assert.match(await identityPage.locator('#nameCandidates').textContent(), /AI 候选 · 已确认/);
  checks.push('DeepL-only users retain base features; independent analysis TXT key import leaves DeepL intact; AI names spend only on click and remain candidates until chosen');
  jimakuExtended = true;
  await identityPage.locator('#source').selectOption('jimaku');
  await identityPage.locator('#jimakuSettings').evaluate(el => { el.open = true; });
  await identityPage.locator('#jimakuKey').fill(jimakuToken); await identityPage.locator('#jimakuSaveKey').click();
  await identityPage.waitForFunction(() => document.getElementById('status').textContent.includes('Jimaku Key 已保存在'));
  await identityPage.locator('#nameLanguage').selectOption('en'); await identityPage.locator('#useSearchName').click();
  await identityPage.waitForFunction(() => document.getElementById('status').textContent.includes('名称已选择'));
  await identityPage.locator('#search').click(); await identityPage.getByRole('button', { name: '查看文件', exact: true }).click();
  await identityPage.waitForFunction(() => document.getElementById('files').options.length === 12);
  assert.equal(await identityPage.locator('#files').inputValue(), alyaNetflix(3));
  assert.ok(await identityPage.locator('#versions option').count() >= 7);
  assert.ok([...await identityPage.locator('#files option').allTextContents()].every(t => /Netflix/.test(t) && /SRT/.test(t)));
  assert.match(await identityPage.locator('#groupInfo').textContent(), /1、2、3、4、5、6、7、8、9、10、11、12/);
  checks.push('Mixed Japanese directory groups Netflix, AT-X ASS/SRT, EMBER hashes and JPN v1/v2 independently; current episode is preselected within the visible version');
  await identityPage.locator('#aiFiles').click();
  await identityPage.waitForFunction(() => document.getElementById('status').textContent.includes('AI 集数候选已生成'));
  assert.equal(await identityPage.locator('#mappingRows tr').count(), 12);
  assert.equal((await worker.evaluate(() => self.CRSubFix.externalCache.create().get())).followRules['["G1XHJV0XM",1]'], undefined);
  await identityPage.locator('#confirmMap').click();
  await identityPage.waitForFunction(() => document.getElementById('mapInfo').textContent.includes('已确认 12 集'));
  await identityPage.locator('#preview').click();
  await identityPage.waitForFunction(() => !document.getElementById('previewSection').hidden);
  await identityPage.locator('#offset').fill('-1.2'); await identityPage.locator('#followCollection').check();
  await identityPage.locator('#inheritOffset').check(); await identityPage.locator('#apply').click();
  await identityPage.waitForFunction(() => document.getElementById('status').textContent.includes('已加载到'));
  await watch.getByText('こんにちは。これは第3話のテスト字幕です。', { exact: true }).waitFor();
  await identityPage.setViewportSize({ width: 1180, height: 900 });
  await identityPage.screenshot({ path: path.join(artifacts, 'subtitle-assist-desktop.png'), fullPage: true });
  await identityPage.setViewportSize({ width: 390, height: 844 });
  assert.ok(await identityPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await identityPage.screenshot({ path: path.join(artifacts, 'subtitle-assist-mobile.png'), fullPage: true });
  checks.push('AI filename analysis stays unsaved until explicit map confirmation and load; twelve-episode map and offset are saved; desktop/mobile UI fit');
  ld.url = '/watch/ALYAFOUR/title'; ld.episodeNumber = 4; ld.potentialAction.target = [{ url: ld.url }];
  const beforeAlyaFollow = calls.length;
  await watch.evaluate(data => { document.querySelector('script[type="application/ld+json"]').textContent = JSON.stringify(data); history.pushState({}, '', '/zh-tw/watch/ALYAFOUR/title'); }, ld);
  await watch.getByText('こんにちは。これは第4話のテスト字幕です。', { exact: true }).waitFor();
  const followed = await worker.evaluate(() => self.CRSubFix.externalCache.create().get());
  assert.equal(followed.selections.ALYAFOUR.sync.offset, -1.2);
  assert.equal(followed.files.find(f => f.key === followed.selections.ALYAFOUR.key).name, alyaNetflix(4));
  assert.equal(calls.length - beforeAlyaFollow, 3);
  const reopenPromise = browser.waitForEvent('page');
  await watch.locator('#cr-bsub-menu-btn').click(); await (await uiText(watch, 'Manage')).click();
  await watch.getByText('外部字幕…', { exact: true }).click();
  const reopened = await reopenPromise; externalPage = reopened;
  await reopened.waitForFunction(() => !document.getElementById('identity').disabled && !document.getElementById('previewSection').hidden);
  const beforeReload = calls.length;
  assert.equal(await reopened.locator('#files').inputValue(), alyaNetflix(4));
  assert.match(await reopened.locator('#mapInfo').textContent(), /已保存 12 集/);
  assert.equal(await reopened.locator('#query').inputValue(), alyaEnglish);
  await reopened.reload(); await reopened.waitForFunction(() => !document.getElementById('identity').disabled && !document.getElementById('previewSection').hidden);
  assert.equal(calls.length, beforeReload);
  checks.push('SPA episode 3 to 4 follows only confirmed Netflix files despite changed titles; -1.2s offset, search-name preference, full map and directory index survive reopening/reload without extra API calls');
  await worker.evaluate(async ({ title, english }) => {
    const cache = self.CRSubFix.externalCache.create(), db = await cache.get();
    for (const [source, query] of [['jimaku', english], ['assrt', title]]) db.searches.push({
      key: `current-source-${source}`, guid: 'ALYAFOUR', source, query, items: [], pos: 0,
      at: Date.now(), expires: Date.now() + 3600000, pageIdentity: { seriesId: 'G1XHJV0XM', title }
    });
    await cache.set(db);
  }, { title: alyaTitle, english: alyaEnglish });
  await reopened.reload();
  await reopened.waitForFunction(() => !document.getElementById('identity').disabled && !document.getElementById('previewSection').hidden);
  assert.equal(await reopened.locator('#source').inputValue(), 'jimaku');
  assert.equal(await reopened.locator('#query').inputValue(), alyaEnglish);
  assert.match(await reopened.locator('#resultInfo').textContent(), /^Jimaku/);
  assert.equal(calls.length, beforeReload);
  checks.push('Reopening with multiple current-episode source caches restores the active subtitle source query/results, not the most recently searched other source');
  assert.deepEqual(errors, []);
  await writeFile(path.join(artifacts, 'external-browser-result.json'), JSON.stringify({ checks, requests: calls.length, errors }, null, 2));
  console.log(JSON.stringify({ checks, requests: calls.length, errors }, null, 2));
} catch (error) {
  if (externalPage && !externalPage.isClosed()) {
    console.error(JSON.stringify({ status: await externalPage.locator('#status').textContent(), calls,
      restoreTrace: await browser.serviceWorkers()[0]?.evaluate(() => self.__externalRestoreTrace),
      zipTrace: await browser.serviceWorkers()[0]?.evaluate(() => self.__zipTrace) }));
    await externalPage.screenshot({ path: path.join(artifacts, 'external-browser-failure.png'), fullPage: true });
  }
  throw error;
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
