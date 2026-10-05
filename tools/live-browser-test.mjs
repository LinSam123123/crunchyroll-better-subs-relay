import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export function installLiveFetch({ base, credential, provider, captureRaw }, scope = globalThis) {
  const original = scope.fetch.bind(scope);
  scope.liveRequests = [];
  scope.liveResponses = [];
  scope.liveCaptures = [];
  scope.fetch = (url, init) => {
    if (url !== base + (provider === 'deepl' ? '/v2/translate' : '/chat/completions')) {
      return original(url, init);
    }
    const params = provider === 'deepl' ? new URLSearchParams(init.body) : null;
    const body = params ? null : JSON.parse(init.body);
    const index = scope.liveRequests.length;
    scope.liveRequests.push(params
      ? { source_lang: params.get('source_lang'), target_lang: params.get('target_lang'), text: params.getAll('text') }
      : { model: body.model, stream: body.stream, instructions: body.messages[0].content,
        input: JSON.parse(body.messages[1].content) });
    const headers = new Headers(init.headers);
    headers.set('Authorization', provider === 'deepl' ? `DeepL-Auth-Key ${credential}` : `Bearer ${credential}`);
    return original(url, { ...init, headers }).then(response => {
      if (!captureRaw || !response.ok) return response;
      if (provider === 'deepl') {
        scope.liveCaptures.push(response.clone().text().then(text => {
          if (text.length > 4000000) throw new Error('CAPTURE_TOO_LARGE');
          scope.liveResponses[index] = text;
        }));
        return response;
      }
      // Observe consumed chunks. A cloned body is aborted by the engine's normal stream cleanup.
      scope.liveResponses[index] = '';
      return {
        ok: response.ok, status: response.status, headers: response.headers,
        body: { getReader() {
          const reader = response.body.getReader(), decoder = new TextDecoder();
          return {
            async read() {
              const chunk = await reader.read();
              scope.liveResponses[index] += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
              if (scope.liveResponses[index].length > 4000000) throw new Error('CAPTURE_TOO_LARGE');
              return chunk;
            },
            cancel: reason => reader.cancel(reason),
          };
        } },
      };
    });
  };
}

export async function runLiveBrowser({ chromium, executablePath, baseUrl, key, model, rows, glossary, workContext,
  provider = 'relay', captureRaw = false }) {
  assert.ok(rows.length > 0 && rows.length <= 150);
  assert.ok(['relay', 'deepl'].includes(provider));
  const host = provider === 'deepl'
    ? (key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com') : baseUrl;
  const artifacts = path.join(root, 'artifacts');
  await mkdir(artifacts, { recursive: true });
  const runDir = await mkdtemp(path.join(artifacts, 'live-browser-'));
  const extension = path.join(runDir, 'extension');
  await cp(path.join(root, 'extension'), extension, { recursive: true });
  const manifestPath = path.join(extension, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.host_permissions = [`${new URL(host).origin}/*`];
  await writeFile(manifestPath, JSON.stringify(manifest));
  const browser = await chromium.launchPersistentContext(path.join(runDir, 'profile'), {
    executablePath, headless: true, ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 1180, height: 900 },
  });
  const result = { model, provider, count: rows.length, requests: [], checks: [], screenshot: '', status: 'running' };
  try {
    result.stage = 'worker-start';
    let worker = browser.serviceWorkers()[0];
    worker ||= await browser.waitForEvent('serviceworker', { timeout: 15000 });
    const extensionId = new URL(worker.url()).host;
    // The real credential exists only in the trusted worker's memory, never its on-disk storage.
    await worker.evaluate(installLiveFetch, { base: host, credential: key, provider, captureRaw });
    const settings = await browser.newPage();
    result.stage = 'settings-save';
    await settings.goto(`chrome-extension://${extensionId}/translation.html`);
    await settings.waitForFunction(() => !document.getElementById('fields').disabled);
    if (provider === 'relay') {
      await settings.locator('#baseUrl').fill(baseUrl);
      await settings.locator('#model').fill(model);
    }
    await settings.locator('#provider').selectOption(provider);
    await settings.locator('#apiKey').fill('live-test-memory-only-placeholder' + (key.endsWith(':fx') ? ':fx' : ''));
    await settings.locator('#source').selectOption('ja-JP');
    if (provider === 'relay') await settings.locator('#translationMode').selectOption('episode-stream');
    if (provider === 'deepl') {
      await settings.locator('#batchSize').fill('30');
      await settings.locator('#maxChars').fill('12000');
      await settings.locator('#concurrency').selectOption('1');
    }
    await settings.locator('#timeout').fill('120');
    await settings.locator('#enabled').check();
    await settings.locator('#save').click();
    await settings.waitForFunction(() => document.getElementById('status').textContent === '已保存。');
    const vtt = 'WEBVTT\n\n' + rows.map(row =>
      `${row.start.replace(',', '.')} --> ${row.end.replace(',', '.')}\n${row.source_text}`).join('\n\n') + '\n';
    const subtitleUrl = 'https://www.crunchyroll.com/live-test.vtt';
    await browser.route('https://www.crunchyroll.com/**', route => route.fulfill({
      contentType: route.request().url() === subtitleUrl ? 'text/vtt' : 'text/html',
      body: route.request().url() === subtitleUrl ? vtt :
        '<!doctype html><html><head><title>Isolated subtitle test</title></head><body style="margin:0;background:#141414;color:white"><div id="player" style="position:relative;width:960px;height:540px"><video style="width:100%;height:100%"></video><div style="display:flex;position:absolute;bottom:0;right:0;gap:18px;height:44px;z-index:20"><button>1x</button><button aria-label="Subtitles">Subtitles</button></div></div></body></html>',
    }));
    const watch = await browser.newPage();
    result.stage = 'source-load';
    await watch.goto('https://www.crunchyroll.com/watch/LIVETEST/offline');
    await watch.waitForFunction(() => !!window.CRSubFix?.episode?.current());
    const parts = rows[0].start.replace(',', '.').split(':').map(Number);
    const initialTime = parts[0] * 3600 + parts[1] * 60 + parts[2] + 0.1;
    await watch.evaluate(({ url, time }) => {
      const ep = window.CRSubFix.episode.current();
      ep.setJpUrls(url, null);
      ep.catalog.recordSession('ja-JP', { 'en-US': url });
      ep.catalog.setVersions([{ locale: 'en-US', guid: 'LIVETEST' }]);
      ep.setCurrentAudio('ja-JP');
      const video = document.querySelector('video');
      Object.defineProperty(video, 'duration', { configurable: true, value: 1500 });
      Object.defineProperty(video, 'videoWidth', { configurable: true, value: 960 });
      Object.defineProperty(video, 'videoHeight', { configurable: true, value: 540 });
      Object.defineProperty(video, 'currentTime', { configurable: true, value: time, writable: true });
      video.dispatchEvent(new Event('loadedmetadata'));
    }, { url: subtitleUrl, time: initialTime });
    await watch.locator('#cr-bsub-menu-btn').click();
    result.stage = 'work-save';
    await watch.getByText('Manage', { exact: true }).click();
    const opened = browser.waitForEvent('page');
    await watch.getByText('作品资料…', { exact: true }).click();
    const work = await opened;
    work.on('dialog', dialog => dialog.accept());
    await work.waitForLoadState();
    await work.waitForFunction(() => !document.getElementById('fields').disabled);
    for (const name of ['title', 'aliases', 'context', 'tone']) {
      await work.locator(`#${name}`).fill(workContext[name] || '');
    }
    await work.locator('#glossary').fill(JSON.stringify(glossary));
    await work.locator('#enabled').check();
    await work.locator('#save').click();
    await work.waitForFunction(() => document.getElementById('status').textContent.includes('资料已确认并保存'));
    await watch.waitForFunction(() => document.documentElement.getAttribute('data-cr-mt-work-enabled') === 'true');
    const translate = async () => {
      await watch.locator('#cr-bsub-menu-btn').click();
      await watch.getByText('Manage', { exact: true }).click();
      await watch.getByText('🌐 Translate', { exact: true }).click();
    };
    const started = Date.now();
    result.stage = 'first-visible-subtitle';
    await translate();
    await watch.waitForFunction(() => {
      const track = window.CRSubFix.episode.current().listCustomSources().find(value => value.kind === 'mt');
      const cue = track?.srcCues[0];
      const overlay = document.getElementById('cr-jp-cc-overlay');
      return cue?.translationStatus === 'translated' && overlay?.textContent.includes(cue.text);
    },
    null, { timeout: 120000 });
    result.firstVisibleMs = Date.now() - started;
    result.checks.push('A translated cue was visible in the player overlay');
    assert.ok(await watch.locator('#cr-jp-cc-overlay').isVisible());
    assert.equal(await watch.locator('#cr-bsub-translation-hud').count(), 0);
    await watch.waitForFunction(() => ['complete', 'error'].includes(document.getElementById('cr-bsub-progress')?.dataset.state),
      null, { timeout: 180000 });
    result.stage = 'request-snapshot';
    result.elapsedMs = Date.now() - started;
    const state = await watch.locator('#cr-bsub-progress').getAttribute('data-state');
    result.requests = await worker.evaluate(() => self.liveRequests);
    if (provider === 'relay') {
      assert.equal(result.requests.length, 1);
      assert.equal(result.requests[0].input.source_language, 'English');
      assert.equal(result.requests[0].input.glossary.Yuki, glossary.Yuki);
      assert.equal(result.requests[0].input.work_context.title, workContext.title);
      result.checks.push('Saved profile and exact glossary reached the real API; ja-JP source slot sent English');
    } else {
      assert.ok(result.requests.length > 0);
      assert.ok(result.requests.every(request => request.source_lang === 'EN' && request.target_lang === 'ZH-HANS'));
      result.checks.push('DeepL requests sent English and simplified Chinese without relay dialogue instructions');
    }
    result.track = await watch.evaluate(() => {
      const ep = window.CRSubFix.episode.current();
      const track = ep.listCustomSources().filter(value => value.kind === 'mt').at(-1);
      return { incomplete: track.incomplete, cues: track.srcCues.map(cue =>
        ({ start: cue.start, end: cue.end, source: cue.srcText, text: cue.text, status: cue.translationStatus })) };
    });
    assert.equal(result.track.cues.length, rows.length);
    result.completed = result.track.cues.filter(cue => cue.status === 'translated').length;
    if (captureRaw) {
      result.stage = 'raw-output-comparison';
      await worker.evaluate(() => Promise.all(self.liveCaptures));
      const responses = await worker.evaluate(() => self.liveResponses);
      const raw = new Map();
      let offset = 0;
      result.rawParseErrors = 0;
      for (const [i, value] of responses.entries()) {
        if (provider === 'deepl') {
          const texts = result.requests[i].text;
          assert.deepEqual(texts, result.track.cues.slice(offset, offset + texts.length).map(cue => cue.source));
          JSON.parse(value).translations.forEach((translation, j) => raw.set(offset + j, translation.text));
          offset += texts.length;
        } else {
          const text = value.split(/\r?\n/).filter(line => line.startsWith('data:')).flatMap(line => {
            try { return [JSON.parse(line.slice(5)).choices?.[0]?.delta?.content || '']; } catch { return []; }
          }).join('');
          for (const line of text.trim().split('\n')) {
            try {
              const item = JSON.parse(line);
              if (typeof item.text !== 'string') { result.rawParseErrors++; continue; }
              raw.set(Number(item.id), item.text);
            } catch { result.rawParseErrors++; }
          }
        }
      }
      result.rawComparisons = result.track.cues.map((cue, index) =>
        ({ source: cue.source, raw: raw.get(index), saved: cue.text, identical: raw.get(index) === cue.text }));
      result.rawIdentical = result.rawComparisons.filter(cue => cue.identical).length;
      result.checks.push('Provider raw output was compared with every stored and rendered subtitle');
    }
    if (state !== 'complete') {
      result.status = 'provider-error';
      result.checks.push('Provider failure preserved completed cues; no automatic retry');
      return result;
    }
    assert.equal(result.completed, rows.length);
    const previousRequests = result.requests.length;
    result.stage = 'cache-reuse';
    await translate();
    await watch.waitForFunction(() => document.getElementById('cr-bsub-progress')?.dataset.state === 'complete');
    assert.equal(await worker.evaluate(() => self.liveRequests.length), previousRequests);
    result.checks.push('Repeated Translate reused completed cache without a second paid request');
    if (provider === 'relay') {
      await work.locator('#review-refresh').click();
      await work.waitForFunction(() => document.getElementById('review-status').textContent.includes('实际提交请求'));
      await work.locator('#review-filter').selectOption('all');
      assert.match(await work.locator('.review-row').first().textContent(), /本次输入语言：en-US/);
      result.checks.push('Trusted request review reported actual input language');
    }
    result.screenshot = path.join(artifacts, captureRaw ? `ablation-player-${provider}-${model}.png` : 'live-api-player.png');
    await watch.screenshot({ path: result.screenshot });
    result.status = 'completed';
    return result;
  } catch (error) {
    result.status = 'failed';
    result.errorType = error.name;
    result.error = /^[A-Z][A-Z0-9_]*$/.test(error.message) ? error.message : 'BROWSER_CHECK_FAILED';
    result.errorDescription = String(error.message).replaceAll(key, '[redacted]').slice(0, 800);
    return result;
  } finally {
    await browser.close();
  }
}
