import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const output = await mkdtemp(path.join(root, 'artifacts/local-browser-'));
const extension = path.join(root, 'extension');
const browser = await chromium.launchPersistentContext(path.join(output, 'profile'), {
  executablePath: process.env.BROWSER_EXECUTABLE_PATH || chromium.executablePath(),
  headless: process.env.LOCAL_HEADED !== '1', locale: 'en-US',
  ignoreDefaultArgs: ['--disable-extensions', '--disable-component-update', '--disable-background-networking'],
  args: [`--load-extension=${extension}`, `--disable-extensions-except=${extension}`],
  viewport: { width: 1100, height: 850 },
});
const errors = [], requests = [];
try {
  const ours = worker => worker.url().endsWith('/background-worker.js');
  const worker = browser.serviceWorkers().find(ours) || await browser.waitForEvent('serviceworker', { predicate: ours, timeout: 15000 });
  const url = `chrome-extension://${new URL(worker.url()).host}/translation.html`;
  const real = await browser.newPage(); await real.goto(url);
  const capability = await real.evaluate(async () => {
    if (!self.Translator) return { supported: false };
    const pairs = {};
    for (const targetLanguage of ['zh', 'zh-Hans', 'ja', 'es']) {
      try { pairs[targetLanguage] = await Translator.availability({ sourceLanguage: 'en', targetLanguage }); }
      catch (e) { pairs[targetLanguage] = e.name; }
    }
    return { supported: true, pairs };
  });
  console.log(JSON.stringify({ realCapability: capability }));
  if (process.env.LOCAL_LIVE === '1') {
    await real.waitForFunction(() => !document.getElementById('fields').disabled);
    await real.selectOption('#provider', 'local');
    await real.selectOption('#source', 'en-US');
    await real.selectOption('#target', 'zh-CN');
    await real.click('#save');
    await real.waitForFunction(() => !document.getElementById('localPrepare').disabled);
    await real.click('#localPrepare');
    try {
      await real.waitForFunction(() => /ready|unavailable|failed|does not provide/i.test(document.getElementById('localStatus').textContent), null, { timeout: 45000 });
      console.log(JSON.stringify({ realPreparation: await real.locator('#localStatus').textContent() }));
      if ((await real.locator('#localStatus').textContent()).includes('ready')) {
        await real.click('#test');
        await real.waitForFunction(() => !document.getElementById('sample').hidden || document.getElementById('status').dataset.error === 'true');
        console.log(JSON.stringify({ realSample: await real.locator('#sample').textContent(), status: await real.locator('#status').textContent() }));
        await real.evaluate(() => {
          const button = document.createElement('button');
          button.id = 'real-dialogue-test'; button.textContent = 'Test synthetic dialogue';
          button.addEventListener('click', async () => {
            const engine = CRSubFix.localTranslator.engine(self.Translator);
            try {
              await engine.prepare('en-US', 'zh-CN');
              const source = ["You've got to be kidding me.", "Don't get the wrong idea. I'm not doing this for you.",
                "We're even now.", "That was close.", "No way. You ate the whole thing?", "I tried to stop him, but I couldn't."];
              const start = performance.now();
              const translations = await engine.translate('en-US', 'zh-CN', source);
              self.realDialogues = { milliseconds: Math.round(performance.now() - start), source, translations };
            } catch (error) { self.realDialogues = { error: error.message }; }
            finally { engine.stop(); }
          });
          document.body.prepend(button);
        });
        await real.click('#real-dialogue-test');
        await real.waitForFunction(() => self.realDialogues, null, { timeout: 30000 });
        console.log(JSON.stringify({ realDialogues: await real.evaluate(() => self.realDialogues) }));
      }
    } catch (_) { console.log('Real model preparation did not complete within 45 seconds.'); }
    await real.click('#localStop').catch(() => {});
  }
  await real.close();
  browser.on('request', req => { if (/^https?:/.test(req.url())) requests.push(req.url()); });
  const page = await browser.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(() => {
    self.Translator = { create: async options => {
      if (!navigator.userActivation.isActive) throw new Error('User gesture missing');
      options.monitor({ addEventListener: (_, listener) => listener({ loaded: 1 }) });
      return { translate: async text => `Local: ${text}`, destroy() {} };
    } };
  });
  await page.goto(url);
  await page.waitForFunction(() => !document.getElementById('fields').disabled);
  await page.selectOption('#provider', 'local');
  await page.check('#enabled');
  await page.click('#save');
  await page.waitForFunction(() => !document.getElementById('localPrepare').disabled);
  assert.equal(await page.locator('#apiKey').isVisible(), false);
  await page.click('#localPrepare');
  await page.waitForFunction(() => document.getElementById('localStatus').textContent.includes('ready'));
  await page.click('#test');
  await page.waitForFunction(() => !document.getElementById('sample').hidden);
  assert.match(await page.locator('#sample').textContent(), /^Local: Hello/);
  await page.click('#localStop');
  await page.click('#test');
  await page.waitForFunction(() => document.getElementById('status').dataset.error === 'true');
  assert.match(await page.locator('#status').textContent(), /prepare local translation/i);
  await page.click('#localPrepare');
  await page.waitForFunction(() => document.getElementById('localStatus').textContent.includes('ready'));
  await page.selectOption('#target', 'ja-JP');
  assert.equal(await page.locator('#localPrepare').isDisabled(), true);
  await page.click('#save');
  await page.waitForFunction(() => !document.getElementById('localPrepare').disabled);
  for (const locale of ['en', 'zh-Hans', 'zh-Hant', 'ja']) {
    await page.selectOption('[data-ui-language]', locale);
    await page.waitForFunction(lang => document.documentElement.lang === lang, locale);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: path.join(output, `local-${locale}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []); assert.deepEqual(requests, []);
  console.log(JSON.stringify({ checks: ['no-key save', 'gesture-bound preparation', 'local test through worker', 'stop and retry', 'language change invalidation', 'four UI languages at 390px', 'zero remote requests'], output }));
} finally { await browser.close(); }
