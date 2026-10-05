(function () {
  'use strict';
  const NS = typeof self !== 'undefined' ? self : globalThis;
  NS.CRSubFix = NS.CRSubFix || {};
  const supported = ['auto', 'zh-Hans', 'zh-Hant', 'en', 'ja'];
  const entries = new Map(), listeners = new Set(), texts = new WeakMap(), attributes = new WeakMap();
  const normalize = value => String(value).replace(/\s+/g, ' ').trim();
  const document = NS.document;
  const extensionPage = NS.location?.protocol === 'chrome-extension:';
  let preference = 'auto', language = resolve('auto');

  function resolve(value, languages = NS.navigator?.languages || [NS.navigator?.language || 'en']) {
    if (supported.includes(value) && value !== 'auto') return value;
    // The first browser preference wins; an unsupported preference falls back to English.
    const first = String(languages[0] || 'en').toLowerCase();
    if (/^zh(?:-|$)/.test(first)) return /(?:hant|tw|hk|mo)/.test(first) ? 'zh-Hant' : 'zh-Hans';
    if (/^ja(?:-|$)/.test(first)) return 'ja';
    return 'en';
  }
  function add(catalog) {
    for (const [source, values] of Object.entries(catalog || {})) {
      entries.set(normalize(source), { source, ...entries.get(normalize(source)), ...values });
    }
  }
  function t(source, params) {
    const entry = entries.get(normalize(source));
    const translated = entry ? (entry[language] || (language === 'zh-Hans' ? entry.source : entry.en) || entry.source) : String(source);
    return translated.replace(/\{([\w]+)\}/g, (match, name) =>
      params && Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match);
  }
  function ignored(element) {
    return !!element?.closest?.('script,style,textarea,input,pre,code,[contenteditable="true"],[data-i18n-ignore]');
  }
  function localize(root = document) {
    if (!root || !document?.createTreeWalker) return;
    const walker = document.createTreeWalker(root, 4);
    let node;
    while ((node = walker.nextNode())) {
      if (ignored(node.parentElement)) continue;
      const previous = texts.get(node);
      const source = previous && node.nodeValue === previous.rendered ? previous.source : node.nodeValue;
      if (!entries.has(normalize(source))) continue;
      const space = String(source).match(/^(\s*)[\s\S]*?(\s*)$/);
      const rendered = space[1] + t(normalize(source)) + space[2];
      texts.set(node, { source, rendered });
      if (node.nodeValue !== rendered) node.nodeValue = rendered;
    }
    const elements = [...(root.nodeType === 1 ? [root] : []), ...(root.querySelectorAll?.('*') || [])];
    for (const element of elements) {
      if (element.closest?.('[data-i18n-ignore],script,style,pre,code')) continue;
      const saved = attributes.get(element) || {};
      for (const name of ['title', 'placeholder', 'aria-label', 'alt']) {
        const current = element.getAttribute(name);
        if (current == null) continue;
        const source = saved[name]?.rendered === current ? saved[name].source : current;
        if (!entries.has(normalize(source))) continue;
        const rendered = t(source);
        saved[name] = { source, rendered };
        if (current !== rendered) element.setAttribute(name, rendered);
      }
      attributes.set(element, saved);
    }
    if (extensionPage && document.documentElement) document.documentElement.lang = language;
  }
  function syncControls() {
    if (!extensionPage) return;
    for (const select of document?.querySelectorAll?.('[data-ui-language]') || []) select.value = preference;
  }
  function setLanguage(value) {
    const next = supported.includes(value) ? value : 'auto';
    const resolved = resolve(next), changed = resolved !== language || next !== preference;
    preference = next; language = resolved;
    if (extensionPage) { localize(document); syncControls(); }
    if (changed) for (const callback of listeners) { try { callback(language); } catch (_) {} }
    return language;
  }
  async function saveLanguage(value) {
    if (!supported.includes(value)) throw new Error('INVALID_UI_LANGUAGE');
    if (!extensionPage || !NS.chrome?.storage?.local) throw new Error('UI_LANGUAGE_STORAGE_UNAVAILABLE');
    await NS.chrome.storage.local.set({ uiLanguage: value });
    return setLanguage(value);
  }
  function boot() {
    if (!document?.documentElement) return;
    if (extensionPage) {
      localize(document); syncControls();
      document.addEventListener('change', event => {
        if (!event.target?.matches?.('[data-ui-language]')) return;
        const select = event.target;
        select.disabled = true;
        saveLanguage(select.value).catch(() => syncControls()).finally(() => { select.disabled = false; });
      });
    } else if (NS.MutationObserver) {
      const refresh = () => setLanguage(document.documentElement.getAttribute('data-cr-ui-language') || 'auto');
      refresh();
      new NS.MutationObserver(refresh).observe(document.documentElement, { attributes: true, attributeFilter: ['data-cr-ui-language'] });
    }
  }
  const ready = (async () => {
    if (extensionPage && NS.chrome?.storage?.local) {
      try {
        const saved = await NS.chrome.storage.local.get('uiLanguage');
        setLanguage(saved?.uiLanguage || 'auto');
      } catch (_) {}
      NS.chrome.storage.onChanged?.addListener((changes, area) => {
        if (area === 'local' && changes.uiLanguage) setLanguage(changes.uiLanguage.newValue || 'auto');
      });
    }
    return language;
  })();
  NS.CRSubFix.i18n = { add, t, localize, ready, resolve, setLanguage, saveLanguage,
    getLanguage: () => language, getPreference: () => preference,
    watch(callback) { listeners.add(callback); return () => listeners.delete(callback); },
    catalog: () => Object.fromEntries(entries), supported: [...supported] };
  add({
    '界面语言': { en: 'Interface language', ja: '表示言語', 'zh-Hant': '介面語言' },
    '跟随浏览器': { en: 'Browser default', ja: 'ブラウザーに合わせる', 'zh-Hant': '跟隨瀏覽器' },
    '简体中文': { en: 'Simplified Chinese', ja: '中国語（簡体字）', 'zh-Hant': '簡體中文' },
    '繁体中文': { en: 'Traditional Chinese', ja: '中国語（繁体字）', 'zh-Hant': '繁體中文' },
    '保存': { en: 'Save', ja: '保存', 'zh-Hant': '儲存' },
    '取消': { en: 'Cancel', ja: 'キャンセル', 'zh-Hant': '取消' },
    '已保存。': { en: 'Saved.', ja: '保存しました。', 'zh-Hant': '已儲存。' },
    '加载中…': { en: 'Loading…', ja: '読み込み中…', 'zh-Hant': '載入中…' },
    '自动选择': { en: 'Automatic', ja: '自動選択', 'zh-Hant': '自動選擇' },
  });
  if (document) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { boot(); ready.then(() => extensionPage && localize(document)); }, { once: true });
    else { boot(); ready.then(() => extensionPage && localize(document)); }
  }
})();
