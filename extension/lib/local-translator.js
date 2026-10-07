(function () {
  'use strict';
  const NS = self.CRSubFix = self.CRSubFix || {};
  const PORT = 'MT_LOCAL_ENGINE';
  function language(value) {
    if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(value || '')) throw new Error('LOCAL_LANGUAGE');
    if (/^zh/i.test(value)) return /Hant|TW|HK/i.test(value) ? 'zh-Hant' : 'zh';
    return value.split('-')[0];
  }
  const pair = (source, target) => `${language(source)}:${language(target)}`;
  function engine(api) {
    let session = null, current = '', controller = null, generation = 0;
    function stop() {
      generation++;
      controller?.abort(); controller = null;
      session?.destroy(); session = null; current = '';
    }
    async function prepare(source, target, progress = () => {}) {
      stop();
      if (!api) throw new Error('LOCAL_UNSUPPORTED');
      const id = generation;
      const options = { sourceLanguage: language(source), targetLanguage: language(target) };
      controller = new AbortController();
      // create() must start in the user's click gesture, before awaiting anything.
      const task = api.create({ ...options, signal: controller.signal,
        monitor(monitor) { monitor.addEventListener('downloadprogress', event => {
          if (id === generation) progress(Math.max(0, Math.min(1, event.total ? event.loaded / event.total : event.loaded)));
        }); } });
      try {
        const result = await task;
        if (id !== generation) { result.destroy(); throw new Error('LOCAL_CANCELLED'); }
        session = result; current = pair(source, target);
      } catch (error) {
        if (id !== generation || error.name === 'AbortError') throw new Error('LOCAL_CANCELLED');
        throw new Error(error.name === 'NotSupportedError' ? 'LOCAL_UNAVAILABLE' : 'LOCAL_DOWNLOAD_FAILED');
      }
    }
    async function translate(source, target, texts, signal) {
      if (!session) throw new Error('LOCAL_NOT_READY');
      if (current !== pair(source, target)) throw new Error('LOCAL_LANGUAGE');
      const result = [];
      for (const text of texts) {
        const translated = await session.translate(text, { signal });
        if (typeof translated !== 'string' || !translated.trim() || translated.length > 16000) throw new Error('LOCAL_INVALID_OUTPUT');
        result.push(translated);
      }
      return result;
    }
    return { prepare, translate, stop, get pair() { return current; } };
  }
  function broker(runtime) {
    let port = null, current = '';
    const pending = new Map();
    function attach(candidate) {
      if (candidate.name !== PORT) return false;
      if (candidate.sender?.id !== runtime.id || candidate.sender?.url?.split(/[?#]/)[0] !== runtime.getURL('translation.html')) {
        candidate.disconnect(); return true;
      }
      // Only one explicitly prepared settings page owns the local engine.
      candidate.onMessage.addListener(message => {
        if (message?.type === 'ready' && typeof message.pair === 'string' && /^[a-z-]+:[a-z-]+$/i.test(message.pair)) {
          if (port && port !== candidate) {
            for (const job of [...pending.values()]) job.reject(new Error('LOCAL_NOT_READY'));
            try { port.postMessage({ type: 'replaced' }); } catch (_) {}
          }
          port = candidate; current = message.pair; return;
        }
        if (candidate !== port || message?.type !== 'result') return;
        const job = pending.get(message.id);
        if (!job) return;
        if (message.error) job.reject(new Error(/^LOCAL_[A-Z_]+$/.test(message.error) ? message.error : 'LOCAL_FAILED'));
        else if (!Array.isArray(message.translations) || message.translations.length !== job.count ||
          message.translations.some(text => typeof text !== 'string' || !text.trim() || text.length > 16000)) job.reject(new Error('LOCAL_INVALID_OUTPUT'));
        else job.resolve(message.translations);
      });
      candidate.onDisconnect.addListener(() => {
        if (port !== candidate) return;
        port = null; current = '';
        for (const job of [...pending.values()]) job.reject(new Error('LOCAL_NOT_READY'));
      });
      return true;
    }
    function translate(texts, source, target, timeoutMs) {
      if (!port) return Promise.reject(new Error('LOCAL_NOT_READY'));
      if (current !== pair(source, target)) return Promise.reject(new Error('LOCAL_LANGUAGE'));
      if (pending.size) return Promise.reject(new Error('BUSY'));
      const id = crypto.randomUUID(), owner = port;
      return new Promise((resolve, reject) => {
        const settle = fn => value => { clearTimeout(timer); pending.delete(id); fn(value); };
        const timer = setTimeout(() => {
          try { owner.postMessage({ type: 'cancel', id }); } catch (_) {}
          pending.get(id)?.reject(new Error('LOCAL_TIMEOUT'));
        }, timeoutMs);
        pending.set(id, { count: texts.length, resolve: settle(resolve), reject: settle(reject) });
        try { owner.postMessage({ type: 'translate', id, texts, source, target }); }
        catch (_) { pending.get(id).reject(new Error('LOCAL_NOT_READY')); }
      });
    }
    return { attach, translate };
  }
  NS.localTranslator = { PORT, language, pair, engine, broker };
})();
