import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { zipSync, strToU8 } from 'fflate';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const profile = await mkdtemp(fileURLToPath(new URL('../artifacts/zip-worker-', import.meta.url)));
const browser = await chromium.launchPersistentContext(profile, { executablePath: process.env.BROWSER_EXECUTABLE_PATH, headless: true,
  ignoreDefaultArgs: ['--disable-extensions'], args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
try {
  let page = browser.serviceWorkers()[0];
  if (!page) page = await browser.waitForEvent('serviceworker', { timeout: 15000 });
  const bytes = [...zipSync({ 'Show S01E01.srt': strToU8('1\n00:00:01,000 --> 00:00:05,000\n中文\n') })];
  const result = await page.evaluate(async bytes => {
    const trace = [], Original = self.fflate.Unzip;
    self.fflate.Unzip = class extends Original {
      constructor(callback) { super(f => { trace.push({ name: f.name, size: f.originalSize, compression: f.compression }); callback(f); }); }
      push(data, final) { try { return super.push(data, final); } catch (e) { trace.push({ error: e.message, stack: e.stack }); throw e; } }
    };
    try {
      const value = await self.CRSubFix.subdl.expand({ archiveUrl: '/subtitle/probe.zip', files: [], language: '简体中文' },
        async () => new Response(new Uint8Array(bytes)));
      return { ok: true, files: value.files, trace };
    } catch (e) { return { ok: false, error: e.message, trace }; }
  }, bytes);
  console.log(JSON.stringify(result, null, 2)); assert.equal(result.ok, true);
} finally { await browser.close(); }
