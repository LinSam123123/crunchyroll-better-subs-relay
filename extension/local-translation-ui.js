(function () {
  'use strict';
  const L = self.CRSubFix.localTranslator;
  const engine = L.engine(self.Translator);
  let port = null, preparing = false, reconnect = null, preparationTimer = null;
  let prepareGeneration = 0;
  const jobs = new Map();
  let message = 'Save settings, then prepare the selected language pair.';
  function render() {
    el('localStatus').textContent = t(message);
    el('localPrepare').disabled = preparing || el('provider').value !== 'local' || savedState?.config.provider !== 'local';
    el('localStop').disabled = !preparing && !engine.pair;
  }
  function stop() {
    prepareGeneration++;
    clearTimeout(reconnect); clearTimeout(preparationTimer);
    for (const controller of jobs.values()) controller.abort();
    jobs.clear(); engine.stop();
    const old = port; port = null; old?.disconnect();
    preparing = false; el('localProgress').hidden = true;
    message = 'Local engine stopped. Completed subtitles are kept.'; render();
  }
  function connect() {
    if (!engine.pair) return;
    const active = chrome.runtime.connect({ name: L.PORT });
    port = active;
    active.onMessage.addListener(async request => {
      if (request?.type === 'replaced') { stop(); return; }
      if (request?.type === 'cancel') { jobs.get(request.id)?.abort(); return; }
      if (request?.type !== 'translate') return;
      const controller = new AbortController();
      jobs.set(request.id, controller);
      let response;
      try {
        const translations = await engine.translate(request.source, request.target, request.texts, controller.signal);
        response = { translations };
      } catch (error) {
        response = { error: /^LOCAL_[A-Z_]+$/.test(error.message) ? error.message : 'LOCAL_FAILED' };
      } finally { jobs.delete(request.id); }
      try { active.postMessage({ type: 'result', id: request.id, ...response }); } catch (_) {}
    });
    active.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (port !== active) return;
      port = null;
      // A worker may stop while idle. No polling or model re-download is needed.
      reconnect = setTimeout(connect, 500);
    });
    active.postMessage({ type: 'ready', pair: engine.pair });
  }
  el('localPrepare').addEventListener('click', async () => {
    if (busy || preparing || savedState?.config.provider !== 'local') return;
    stop(); preparing = true;
    const generation = prepareGeneration;
    message = 'Preparing local model. The first download may take several minutes.';
    el('localProgress').hidden = false; el('localProgress').value = 0; render();
    preparationTimer = setTimeout(stop, 300000);
    try {
      const source = savedState.source === 'ja-JP' ? 'en-US' : savedState.source || 'en-US';
      await engine.prepare(source, savedState.target, value => { el('localProgress').value = value; });
      if (generation !== prepareGeneration) return;
      connect();
      message = 'Local engine ready. Keep this tab open and return to the player to translate.';
    } catch (error) {
      if (generation !== prepareGeneration) return;
      message = self.CRSubFix.localErrors[error.message] || self.CRSubFix.localErrors.LOCAL_FAILED;
    } finally {
      if (generation !== prepareGeneration) return;
      clearTimeout(preparationTimer); preparing = false; el('localProgress').hidden = true; render();
    }
  });
  el('localStop').addEventListener('click', stop);
  el('settings').addEventListener('input', event => {
    if (event.target.closest('[data-ui-language]')) return;
    if (preparing || engine.pair) stop();
    el('localPrepare').disabled = true;
  });
  el('provider').addEventListener('change', () => {
    const cloud = savedState?.cloudConfig;
    if (cloud && el('provider').value === cloud.provider) {
      for (const id of ['baseUrl', 'protocol', 'model', 'batchSize', 'maxChars', 'concurrency', 'translationMode']) el(id).value = cloud[id];
      el('timeout').value = cloud.timeoutMs / 1000;
      el('glossary').value = JSON.stringify(cloud.glossary || {}, null, 2);
      providerVisibility();
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.mtConfigTag || changes.mtTarget || changes.mtSource || changes.mtEnabled?.newValue === false)) {
      if (preparing || engine.pair) stop();
    }
  });
  window.addEventListener('pagehide', stop);
  I.watch(() => { el('localStatus').textContent = t(message); providerVisibility(); });
  I.ready.then(() => { el('localStatus').textContent = t(message); });
})();
