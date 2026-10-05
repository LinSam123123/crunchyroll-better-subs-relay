import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { context, source } from './helpers.mjs';

function setup() {
  let finish;
  const installed = [], messages = [];
  const episode = { guid: 'NEXT', activeSource: () => c.selectedSource };
  const c = context({ selectedSource: null, clickInProgress: false, overlayActive: false,
    currentEp: () => c.episode, currentCustomSource: () => null,
    isCustomId: id => String(id || '').startsWith('custom:'),
    handleButtonClick: async () => {}, showErrorToast: () => {},
    installExternal: async (record, active) => installed.push({ record, active }),
    rpc: async (method, payload) => {
      messages.push({ method, payload });
      if (method === 'external-restore') return new Promise(resolve => { finish = resolve; });
      return { ok: true };
    } });
  c.episode = episode;
  const text = source('interceptor.js');
  const start = text.indexOf('  let externalChoiceRevision = 0;');
  const end = text.indexOf("  window.addEventListener('message'", start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(text.slice(start, end), c);
  return { c, installed, messages, start: () => c.restoreExternal(episode),
    finish: active => finish({ record: { guid: 'NEXT', id: 'custom:assrt:42:test' }, active }),
    manual: () => c.handleManualSubtitleClick({}) };
}

test('external restore replaces an automatically activated native fallback, including a changed native locale', async () => {
  const w = setup(); const task = w.start();
  w.c.selectedSource = 'en-US'; w.c.overlayActive = true;
  w.finish(true); await task;
  assert.equal(w.installed.length, 1); assert.equal(w.installed[0].active, true);
});

test('external restore waits for a native activation to drain before installing external cues', async () => {
  const w = setup(); const task = w.start();
  w.c.clickInProgress = true;
  w.c.setTimeout = resolve => { w.c.clickInProgress = false; queueMicrotask(resolve); };
  w.finish(true); await task;
  assert.equal(w.installed.length, 1);
});

test('manual native toggle or navigation cancels a late external restore', async () => {
  for (const manual of [true, false]) {
    const w = setup(); const task = w.start();
    if (manual) await w.manual(); else w.c.episode = { guid: 'OTHER' };
    w.finish(true); await task;
    assert.equal(w.installed.length, 0);
    if (manual) assert.ok(w.messages.some(m => m.method === 'external-active' && m.payload.id === ''));
  }
});

test('an inactive cached external file is registered without activating it or replacing a custom track', async () => {
  const w = setup(); const task = w.start(); w.c.overlayActive = true;
  w.finish(false); await task;
  assert.equal(w.installed.length, 1); assert.equal(w.installed[0].active, false);
  const other = setup(); const next = other.start(); other.c.selectedSource = 'custom:local';
  other.finish(true); await next;
  assert.equal(other.installed.length, 0);
});

test('concurrent player readiness signals share one restore request and one installation', async () => {
  const w = setup(); const first = w.start(), second = w.start();
  w.finish(true); await Promise.all([first, second]);
  assert.equal(w.messages.filter(m => m.method === 'external-restore').length, 1);
  assert.equal(w.installed.length, 1);
});

test('player replacement reuses the resolved external record without another restore request', async () => {
  const w = setup(); const first = w.start(); w.finish(true); await first;
  w.c.selectedSource = 'custom:assrt:42:test'; w.c.overlayActive = false;
  await w.start();
  assert.equal(w.installed.length, 2);
  assert.equal(w.messages.filter(m => m.method === 'external-restore').length, 1);
  w.c.overlayActive = true;
  await w.start();
  assert.equal(w.installed.length, 2);
});

test('manual off still cancels the cached restore on a later player replacement', async () => {
  const w = setup(); const first = w.start(); w.finish(true); await first;
  await w.manual(); w.c.overlayActive = false;
  await w.start();
  assert.equal(w.installed.length, 1);
  assert.equal(w.messages.filter(m => m.method === 'external-restore').length, 1);
});

test('normalizing the slug of the same watch ID preserves the Episode and player state', () => {
  const episode = { guid: 'NEXT', disposed: false };
  let teardowns = 0;
  const c = context({ window: { location: { pathname: '/zh-tw/watch/NEXT/title' } },
    lastWatchPath: '/zh-tw/watch/NEXT', EP: { current: () => episode },
    getEpisodeGuid: () => 'NEXT', teardownPageChrome: () => { teardowns++; } });
  const text = source('interceptor.js');
  const start = text.indexOf('  function handleNavigation() {');
  const end = text.indexOf('  // Bounded retry of auto-activate', start);
  vm.runInContext(text.slice(start, end), c);
  c.handleNavigation();
  assert.equal(teardowns, 0);
  assert.equal(c.lastWatchPath, '/zh-tw/watch/NEXT/title');
});

function installationSetup({ readyAfter = 0, buttonState = 'idle', cancel = false } = {}) {
  let ticks = 0, clicks = 0;
  const button = { dataset: { state: buttonState } };
  const episode = { guid: 'NEXT', disposed: false, activeSource: () => c.selectedSource,
    addCustomSource: record => { c.record = record; } };
  const c = context({ BTN_ID: 'button', selectedSource: null, overlayActive: false, clickInProgress: false,
    videoEl: { isConnected: readyAfter === 0 }, currentEp: () => episode, getEpisodeGuid: () => 'NEXT',
    CUSTOM: { makeLocalSource: () => ({ srcCues: [{ start: 1, end: 2, text: 'test' }], label: 'test' }) },
    sourceMenu: { updateButtonVisibility() {} },
    document: { getElementById: () => ticks >= readyAfter ? button : null },
    setButtonState: (btn, state) => { btn.dataset.state = state; },
    selectSource: id => { c.selectedSource = id; },
    handleButtonClick: async () => { clicks++; c.overlayActive = true; },
    setTimeout: resolve => {
      ticks++;
      if (cancel) vm.runInContext('externalChoiceRevision++', c);
      if (ticks >= readyAfter) c.videoEl.isConnected = true;
      queueMicrotask(resolve);
    } });
  const text = source('interceptor.js');
  const start = text.indexOf('  async function installExternal(');
  const end = text.indexOf('  let externalChoiceRevision = 0;', start);
  vm.runInContext(text.slice(start, end) + 'let externalChoiceRevision = 0;', c);
  return { c, button, clicks: () => clicks, ticks: () => ticks,
    install: () => c.installExternal({ guid: 'NEXT', id: 'custom:assrt:42:abcd',
      text: 'fixture', filename: 'episode.srt', sync: { mode: 'none' } }) };
}

test('external activation waits beyond four seconds for the player without downloading again', async () => {
  const w = installationSetup({ readyAfter: 60 });
  await w.install();
  assert.equal(w.ticks(), 60); assert.equal(w.clicks(), 1); assert.equal(w.c.overlayActive, true);
});

test('manual choice during local readiness wait cancels external activation', async () => {
  const w = installationSetup({ readyAfter: 60, cancel: true });
  await w.install();
  assert.equal(w.clicks(), 0); assert.equal(w.c.overlayActive, false);
});

test('native unavailable/reload button states do not block an already downloaded external file', async () => {
  for (const state of ['unavail', 'reload']) {
    const w = installationSetup({ buttonState: state }); await w.install();
    assert.equal(w.button.dataset.state, 'idle'); assert.equal(w.clicks(), 1);
  }
});
