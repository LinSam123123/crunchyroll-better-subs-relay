import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const run = await mkdtemp(path.join(root, 'artifacts/worker-upgrade-'));
const extension = path.join(run, 'extension');
await cp(path.join(root, 'extension'), extension, { recursive: true });
const manifestFile = path.join(extension, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
// The isolated old-entry fixture uses importScripts; no real user profile or keys.
await writeFile(manifestFile, JSON.stringify({ ...manifest, version: '2.7.0.31',
  version_name: 'Synthetic old worker fixture', background: { service_worker: 'background.js' } }));
let browser;
try {
  browser = await chromium.launchPersistentContext(path.join(run, 'profile'), {
    executablePath: process.env.BROWSER_EXECUTABLE_PATH || chromium.executablePath(), headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const oldWorker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker', { timeout: 15000 });
  assert.match(oldWorker.url(), /\/background\.js$/);
  const extensionId = new URL(oldWorker.url()).host;
  const saved = { uiLanguage: 'ja', mtApiKey: 'synthetic-upgrade-key-not-real',
    assrtApiKey: 'synthetic-source-key-not-real', relayConfig: { model: 'synthetic-model' },
    'mtProgress:synthetic': { completed: 2 } };
  await oldWorker.evaluate(value => chrome.storage.local.set(value), saved);
  await writeFile(manifestFile, JSON.stringify(manifest));
  const restarted = browser.waitForEvent('serviceworker', {
    predicate: worker => worker.url().endsWith('/background-worker.js'), timeout: 15000,
  });
  await oldWorker.evaluate(() => chrome.runtime.reload()).catch(error => {
    if (!/closed|destroyed/i.test(error.message)) throw error;
  });
  const worker = await restarted;
  assert.equal(new URL(worker.url()).host, extensionId);
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().version), manifest.version);
  assert.deepEqual(await worker.evaluate(keys => chrome.storage.local.get(keys), Object.keys(saved)), saved);
  assert.ok(await worker.evaluate(() => !!CRSubFix.protocol && !!CRSubFix.externalSubs));
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`chrome-extension://${extensionId}/translation.html`);
  await page.waitForFunction(() => !document.getElementById('fields').disabled);
  const reply = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'MT_GET_CONFIG' }));
  assert.equal(reply.ok, true);
  assert.equal(await page.evaluate(() => CRSubFix.i18n.getLanguage()), 'ja');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ workerUpgrade: true, sameExtensionId: true,
    savedSettingsKeysAndProgressPreserved: true, trustedMessages: true, errors,
    network: 'no real account or paid API' }, null, 2));
} finally { await browser?.close(); }
