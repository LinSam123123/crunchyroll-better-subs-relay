import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const dir = await mkdtemp(path.join(root, 'artifacts/playback-browser-'));
const extension = process.env.TEST_EXTENSION_DIR || path.join(root, 'extension');
const browser = await chromium.launchPersistentContext(path.join(dir, 'profile'), {
  executablePath: process.env.BROWSER_EXECUTABLE_PATH, headless: true,
  ignoreDefaultArgs: ['--disable-extensions'], locale: 'en-US',
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const requests = [], errors = [], checks = [];
let delayId = '';
let slowSubtitleStarted = false;
let finishSlowSubtitle;
const slowSubtitleFinished = new Promise(resolve => { finishSlowSubtitle = resolve; });
try {
  const worker = browser.serviceWorkers().find(w => w.url().endsWith('/background-worker.js')) ||
    await browser.waitForEvent('serviceworker', { predicate: w => w.url().endsWith('/background-worker.js') });
  await worker.evaluate(() => chrome.storage.local.set({ autoActivate: true, mtEnabled: false }));
  await browser.route('**/*', async route => {
    const url = new URL(route.request().url());
    const match = url.pathname.match(/\/playback\/v3\/([^/]+)\/web\/[^/]+\/play/);
    if (match) {
      const id = match[1]; requests.push(id);
      if (id === delayId) await new Promise(resolve => setTimeout(resolve, 300));
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        audioLocale: id === 'DUB' ? 'en-US' : 'ja-JP',
        // Intentionally omit versions for Japanese sessions.
        versions: id === 'DUB' ? [{ audio_locale: 'ja-JP', guid: 'JP' }] : [],
        subtitles: { 'en-US': `https://www.crunchyroll.com/fixture/${id}.vtt`,
          'de-DE': `https://www.crunchyroll.com/fixture/${id}-de.vtt` },
      }) });
    }
    if (url.pathname.startsWith('/fixture/')) {
      const slow = url.pathname === '/fixture/SLOW.vtt';
      if (slow) { slowSubtitleStarted = true; await new Promise(resolve => setTimeout(resolve, 1200)); }
      await route.fulfill({ contentType: 'text/vtt',
        body: `WEBVTT\n\n00:00:00.000 --> 00:00:10.000\nSynthetic ${path.basename(url.pathname)}\n\n00:23:50.000 --> 00:23:59.000\nEnd\n` });
      if (slow) finishSlowSubtitle();
      return;
    }
    if (route.request().isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><title>Playback fixture</title></head>
      <body><div id="player-container"><video></video></div><h1>Synthetic episode</h1>
      <script>
        const video = document.querySelector('video'); window.fixtureVideo = video;
        window.loadCalls = 0; window.playCalls = 0;
        video.load = () => { window.loadCalls++; };
        video.play = () => { window.playCalls++; return Promise.resolve(); };
        Object.defineProperties(video, { duration: { get: () => 1440 }, currentTime: { get: () => 3 },
          paused: { get: () => true }, readyState: { get: () => 4 }, videoWidth: { get: () => 1280 }, videoHeight: { get: () => 720 } });
        fetch(new Request('/playback/v3/FIRST/web/chrome/play', {headers:{Authorization:'fixture-token'}}))
          .then(r => r.json()).then(() => history.pushState({}, '', '/zh-tw/watch/FIRST/title'));
      </script></body></html>` });
    return route.fulfill({ status: 404, body: '{}' });
  });
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push(e.message));
  const documents = [];
  page.on('request', r => { if (r.isNavigationRequest()) documents.push(r.url()); });
  await page.goto('https://www.crunchyroll.com/zh-tw/series/SERIES/title');
  async function ready(id) {
    await page.waitForFunction(id => CRSubFix.episode.current()?.guid === id &&
      CRSubFix.episode.current().catalog.versions().some(v => v.locale === 'de-DE') &&
      document.documentElement.getAttribute('data-cr-jp-active') === 'true' &&
      document.querySelector('#cr-jp-cc-overlay')?.textContent.includes(`Synthetic ${id}.vtt`), id, { timeout: 15000 });
  }
  await ready('FIRST'); checks.push('Home/series prefetch before watch navigation populates and renders subtitles');
  assert.equal(requests.filter(id => id === 'FIRST').length, 1);
  checks.push('Japanese response without versions uses existing tracks without duplicate playback fetch');
  await page.evaluate(async () => {
    await fetch(new URL('/playback/v3/SECOND/web/edge/play', location.origin));
  });
  assert.equal(await page.evaluate(() => CRSubFix.episode.current().guid), 'FIRST');
  await page.evaluate(() => history.pushState({}, '', '/zh-tw/watch/SECOND/title'));
  await ready('SECOND'); checks.push('Next episode prefetched before route change does not poison the current episode');
  delayId = 'THIRD';
  await page.evaluate(() => {
    window.pendingPlayback = fetch('/playback/v3/THIRD/web/chrome/play');
    history.pushState({}, '', '/zh-tw/watch/THIRD/title');
  });
  await ready('THIRD'); checks.push('Response arriving after route change applies to the correct episode');
  delayId = 'OLD';
  await page.evaluate(() => {
    history.pushState({}, '', '/zh-tw/watch/OLD/title');
    window.oldPlayback = fetch('/playback/v3/OLD/web/chrome/play');
    history.pushState({}, '', '/zh-tw/watch/NEW/title');
    window.newPlayback = fetch('/playback/v3/NEW/web/chrome/play');
  });
  await ready('NEW');
  await page.evaluate(() => window.oldPlayback);
  assert.equal(await page.evaluate(() => CRSubFix.episode.current().jpGuid), 'NEW');
  checks.push('Late response for the departed episode cannot replace the new subtitles');
  await page.evaluate(() => {
    history.pushState({}, '', '/zh-tw/watch/SLOW/title');
    return fetch('/playback/v3/SLOW/web/chrome/play');
  });
  for (let i = 0; i < 100 && !slowSubtitleStarted; i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(slowSubtitleStarted);
  await page.evaluate(() => {
    history.pushState({}, '', '/zh-tw/watch/FAST/title');
    return fetch('/playback/v3/FAST/web/chrome/play');
  });
  await ready('FAST'); await slowSubtitleFinished;
  await page.waitForFunction(() => CRSubFix.episode.current().originalCues[0]?.text === 'Synthetic FAST.vtt');
  checks.push('An old subtitle download finishing during the new episode cannot overwrite its cues');
  await page.evaluate(() => {
    history.pushState({}, '', '/zh-tw/watch/DUB/title');
    return fetch(new Request('/playback/v3/DUB/web/chrome/play', { headers: { Authorization: 'fixture-token' } }));
  });
  await page.waitForFunction(() => CRSubFix.episode.current()?.jpGuid === 'JP' &&
    document.querySelector('#cr-jp-cc-overlay')?.textContent.includes('Synthetic JP.vtt'), null, { timeout: 15000 });
  assert.deepEqual(await page.evaluate(() => ({ sameVideo: window.fixtureVideo === document.querySelector('video'),
    loadCalls: window.loadCalls, playCalls: window.playCalls })), { sameVideo: true, loadCalls: 0, playCalls: 0 });
  assert.equal(documents.length, 1);
  checks.push('Dub bootstrap fetches Japanese subtitles without a document reload, video replacement, load or play');
  await worker.evaluate(() => chrome.storage.local.set({ autoActivate: false }));
  await page.waitForFunction(() => document.documentElement.getAttribute('data-cr-auto-activate') === 'false');
  await page.evaluate(() => {
    history.pushState({}, '', '/zh-tw/watch/MANUAL/title');
    return fetch('/playback/v3/MANUAL/web/chrome/play');
  });
  await page.waitForFunction(() => CRSubFix.episode.current()?.guid === 'MANUAL' &&
    document.documentElement.getAttribute('data-cr-jp-status') === 'ready');
  assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-cr-jp-active')), 'false');
  checks.push('Automatic activation disabled still exposes ready subtitles without enabling the overlay');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(dir, 'playback.png') });
  console.log(JSON.stringify({ checks, pageErrors: errors, documents: documents.length, requests, artifacts: dir }, null, 2));
} catch (error) {
  const page = browser.pages().at(-1);
  console.log(JSON.stringify(await page.evaluate(() => ({
    guid: CRSubFix.episode.current()?.guid, cues: CRSubFix.episode.current()?.originalCues,
    status: document.documentElement.getAttribute('data-cr-jp-status'),
    active: document.documentElement.getAttribute('data-cr-jp-active'),
    overlay: document.querySelector('#cr-jp-cc-overlay')?.textContent,
    trace: sessionStorage.getItem('crSubFix_trace'),
  })), null, 2));
  console.log(JSON.stringify({ errors, requests }));
  throw error;
} finally { await browser.close(); }
