import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = path.join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const output = await mkdtemp(path.join(artifacts, 'i18n-browser-'));
const extension = path.join(root, 'extension');
let browser;
const checks = [], errors = [], requests = [], untranslated = {};
try {
  browser = await chromium.launchPersistentContext(path.join(output, 'profile'), {
    executablePath: process.env.BROWSER_EXECUTABLE_PATH || chromium.executablePath(), headless: true,
    ignoreDefaultArgs: ['--disable-extensions'], locale: 'ja-JP',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 1180, height: 900 },
  });
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  await worker.evaluate(() => chrome.storage.local.set({ mtTarget: 'zh-CN', mtSource: 'en-US' }));
  browser.on('request', request => {
    if (/^https?:/.test(request.url())) requests.push(request.url());
  });
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  for (const file of (process.env.I18N_PAGES || 'translation.html,subtitles.html,work.html,popup.html,help.html').split(',')) {
    await page.goto(`chrome-extension://${id}/${file}`);
    await page.evaluate(() => CRSubFix.i18n.ready);
    if (file === 'translation.html') {
      await page.waitForFunction(() => !document.getElementById('fields').disabled);
      await page.locator('#model').fill('unsaved-model');
      await page.locator('#glossary').fill('{"Source":"User translation"}');
    }
    untranslated[file] = await page.evaluate(async () => {
      const raw = await (await fetch(location.href)).text();
      const original = new DOMParser().parseFromString(raw, 'text/html');
      const walker = original.createTreeWalker(original, NodeFilter.SHOW_TEXT), catalog = CRSubFix.i18n.catalog();
      const missing = [];
      let node;
      while ((node = walker.nextNode())) {
        if (node.parentElement?.closest('script,style,textarea,pre,code,[data-i18n-ignore]')) continue;
        const text = node.nodeValue.replace(/\s+/g, ' ').trim();
        if (text && /[\p{L}]/u.test(text) && !catalog[text]) missing.push(text);
      }
      return [...new Set(missing)];
    });
    assert.equal(await page.evaluate(() => CRSubFix.i18n.getLanguage()), 'ja');
    checks.push(`${file}: browser default Japanese`);
    for (const language of ['en', 'zh-Hant', 'zh-Hans', 'ja']) {
      await worker.evaluate(value => chrome.storage.local.set({ uiLanguage: value }), language);
      await page.waitForFunction(value => document.documentElement.lang === value, language);
      if (file === 'translation.html') {
        assert.equal(await page.locator('#model').inputValue(), 'unsaved-model');
        assert.equal(await page.locator('#glossary').inputValue(), '{"Source":"User translation"}');
        assert.equal(await page.locator('#target').inputValue(), 'zh-CN');
      }
      const labels = await page.evaluate(() => [...document.querySelectorAll('h2,label,button,a')]
        .filter(e => e.offsetWidth && e.offsetHeight && !e.closest('[data-i18n-ignore]'))
        .map(e => e.textContent.trim()).join('\n'));
      if (language === 'en') assert.ok(/[a-z]{3}/i.test(labels), `${file}: English labels`);
      if (language === 'ja') assert.ok(/[ぁ-ゖァ-ヺ]/.test(labels), `${file}: Japanese labels`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${file}: desktop overflow`);
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('button')]
        .filter(e => e.offsetWidth && e.offsetHeight && e.scrollWidth > e.clientWidth + 2)
        .map(e => e.textContent.trim())), [], `${file}: clipped button text`);
      await page.screenshot({ path: path.join(output, `${file}-${language}-desktop.png`), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(output, `${file}-${language}-mobile.png`), fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${file}: mobile overflow`);
      await page.setViewportSize({ width: 1180, height: 900 });
      checks.push(`${file}: ${language} desktop/mobile`);
    }
    // Reset before the next page to exercise browser-default selection again.
    await worker.evaluate(() => chrome.storage.local.set({ uiLanguage: 'auto' }));
  }
  await page.goto(`chrome-extension://${id}/translation.html`);
  await page.evaluate(() => CRSubFix.i18n.ready);
  const selector = page.locator('[data-ui-language]');
  assert.equal(await selector.count(), 1);
  await selector.selectOption('en');
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  await page.reload();
  await page.waitForFunction(() => document.documentElement.lang === 'en');
  assert.equal(await page.locator('[data-ui-language]').inputValue(), 'en');
  const preserved = await worker.evaluate(() => chrome.storage.local.get(['mtTarget', 'mtSource', 'relayConfig', 'mtApiKey']));
  assert.deepEqual(preserved, { mtTarget: 'zh-CN', mtSource: 'en-US' });
  checks.push('selector persists across reload without changing translation settings');
  assert.deepEqual(requests, [], 'Interface localization must not call any remote API');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks, errors, untranslated, remoteRequests: requests.length, screenshots: output }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ untranslated, errors, screenshots: output }, null, 2));
  throw error;
} finally { await browser?.close(); }
