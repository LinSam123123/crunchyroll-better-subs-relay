(function () {
  'use strict';
  const NS = self.CRSubFix;
  const PANEL_ID = 'cr-bsub-translation-hud';
  const NOTICE_ID = 'cr-bsub-translation-notice';
  function makeTranslationStatus(host, { getAnchor, onPause }) {
    let state = 'idle', step = 0, total = 0, description = '', failure = '';
    let resume = null, retry = null, retryLabel = 'Retry';
    let panel = null, fields = null, notice = null, noticeTimer = null, monitor = null, destroyed = false;
    const titles = { idle: 'Translation', running: 'Translating', pausing: 'Finishing current requests',
      paused: 'Translation paused', error: 'Translation stopped', complete: 'Translation complete' };
    const pct = () => state === 'complete' ? 100 :
      total > 0 ? Math.min(100, Math.max(0, Math.round(step * 100 / total))) : 0;
    function visible(anchor) {
      if (!anchor?.isConnected || !anchor.getClientRects().length) return false;
      const rect = anchor.getBoundingClientRect();
      const player = host()?.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.top >= innerHeight || rect.right <= 0 || rect.left >= innerWidth ||
          (player && (rect.bottom <= player.top || rect.top >= player.bottom))) return false;
      for (let el = anchor; el; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) return false;
      }
      return true;
    }
    function place(el) {
      const target = host();
      if (!target) return;
      if (target !== document.body && getComputedStyle(target).position === 'static') target.style.position = 'relative';
      if (el.parentElement !== target) target.appendChild(el);
      const fixed = target === document.body;
      const box = fixed ? { left: 0, top: 0, width: innerWidth, height: innerHeight } : target.getBoundingClientRect();
      const anchor = getAnchor()?.getBoundingClientRect();
      el.style.position = fixed ? 'fixed' : 'absolute';
      el.style.width = `${Math.max(0, Math.min(el === notice ? 280 : 360, box.width - 16))}px`;
      el.style.maxHeight = `${Math.max(0, box.height - 16)}px`;
      const width = el.offsetWidth, height = el.offsetHeight;
      const left = (anchor?.right ?? box.left + box.width - 8) - box.left - width;
      const top = (anchor?.top ?? box.top + box.height - 72) - box.top - height - 10;
      el.style.left = `${Math.max(8, Math.min(left, box.width - width - 8))}px`;
      el.style.top = `${Math.max(8, Math.min(top, box.height - height - 8))}px`;
    }
    function surface(id) {
      const el = document.createElement('div');
      el.id = id;
      el.style.cssText = 'z-index:2147483645;box-sizing:border-box;background:rgba(22,25,25,.97);color:#edf1f0;border:1px solid #53605d;border-radius:6px;padding:12px;font:13px/1.5 sans-serif;letter-spacing:0;overflow-wrap:anywhere;overflow:auto;pointer-events:auto;box-shadow:0 4px 18px #0006';
      for (const event of ['click', 'dblclick', 'pointerdown']) el.addEventListener(event, e => e.stopPropagation());
      return el;
    }
    function button(text, title, handler) {
      const el = document.createElement('button');
      el.type = 'button';
      el.textContent = text;
      el.title = title;
      el.setAttribute('aria-label', title);
      el.style.cssText = 'min-height:32px;min-width:32px;padding:4px 10px;border:1px solid #697873;border-radius:4px;background:#29322f;color:#f3f5f4;font:inherit;cursor:pointer;letter-spacing:0';
      el.addEventListener('click', handler);
      return el;
    }
    function clearNotice() {
      clearTimeout(noticeTimer);
      noticeTimer = null;
      notice?.remove();
      notice = null;
    }
    function outside(event) {
      if (!panel?.contains(event.target) && !getAnchor()?.contains(event.target)) close();
    }
    function escape(event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
    function close(focus = false) {
      panel?.remove();
      panel = null;
      fields = null;
      clearInterval(monitor);
      monitor = null;
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
      const anchor = getAnchor();
      anchor?.setAttribute('aria-expanded', 'false');
      if (focus) anchor?.focus();
    }
    function refresh() {
      if (destroyed) return;
      const anchor = getAnchor();
      if (anchor) {
        anchor.style.display = state === 'idle' ? 'none' : '';
        anchor.dataset.state = state;
        anchor.title = `${titles[state]}${total ? `: ${step}/${total}` : ''}`;
        anchor.setAttribute('aria-label', `Translation progress: ${anchor.title}`);
        anchor.setAttribute('aria-expanded', String(!!panel));
        anchor.setAttribute('aria-controls', PANEL_ID);
        const label = anchor.querySelector('[data-label]');
        if (label) label.textContent = state === 'error' ? '!' : state === 'paused' ? '\u23f8' :
          state === 'complete' ? '\u2713' : total ? `${pct()}%` : '\u2026';
        const fill = anchor.querySelector('[data-fill]');
        if (fill) {
          fill.style.width = `${pct()}%`;
          fill.style.background = state === 'error' ? '#ffc16a' : '#ff853d';
        }
        anchor.style.color = state === 'error' ? '#ffc16a' : '#edf1f0';
      }
      if (!panel) return;
      panel.dataset.state = state;
      fields.title.textContent = titles[state];
      fields.count.textContent = total ? `${step} / ${total}` :
        state === 'running' ? 'Loading subtitles' : state === 'complete' ? 'Complete' : '0';
      fields.progress.value = pct();
      fields.detail.textContent = state === 'error' ? failure : description;
      fields.detail.style.color = state === 'error' ? '#ffc16a' : '#b7c5bf';
      const label = state === 'error' ? retryLabel : state === 'paused' ? 'Resume translation' :
        state === 'pausing' ? 'Finishing current requests' : 'Pause translation';
      fields.action.textContent = label;
      fields.action.title = label;
      fields.action.setAttribute('aria-label', label);
      fields.action.hidden = state === 'complete' || state === 'idle' || (state === 'error' && !retry);
      fields.action.disabled = state === 'pausing';
      place(panel);
    }
    function open() {
      if (destroyed || state === 'idle') return;
      clearNotice();
      if (panel) return close(true);
      panel = surface(PANEL_ID);
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'Translation details');
      const header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px';
      const title = document.createElement('strong');
      const dismiss = button('\u00d7', 'Close translation details', () => close(true));
      header.append(title, dismiss);
      const count = document.createElement('div');
      count.style.margin = '8px 0 4px';
      const progress = document.createElement('progress');
      progress.max = 100;
      progress.setAttribute('aria-label', 'Translated subtitles');
      progress.style.cssText = 'width:100%;height:6px;accent-color:#ff853d';
      const detail = document.createElement('p');
      detail.style.cssText = 'white-space:pre-wrap;margin:10px 0;line-height:1.5';
      const action = button('', '', () => {
        if (state === 'running') {
          state = 'pausing';
          onPause();
          refresh();
        } else if (state === 'error' || state === 'paused') {
          const callback = state === 'error' ? retry : resume;
          close();
          callback?.();
        }
      });
      panel.append(header, count, progress, detail, action);
      fields = { title, count, progress, detail, action };
      refresh();
      dismiss.focus({ preventScroll: true });
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', escape, true);
      monitor = setInterval(() => {
        if (!visible(getAnchor())) close();
        else if (panel) place(panel);
      }, 200);
    }
    function start(onResume) {
      clearNotice();
      state = 'running';
      step = total = 0;
      failure = description = '';
      resume = onResume;
      retry = null;
      refresh();
    }
    function error(text, onRetry, label = 'Retry') {
      if (destroyed) return;
      state = 'error';
      failure = text;
      retry = onRetry;
      retryLabel = label;
      clearNotice();
      refresh();
      if (panel) return;
      notice = surface(NOTICE_ID);
      notice.setAttribute('role', 'status');
      const code = text.match(/\[([A-Z0-9_]+)\]\s*$/)?.[1];
      notice.textContent = `Translation stopped${code ? `: ${code}` : ''}`;
      place(notice);
      noticeTimer = setTimeout(clearNotice, 3000);
    }
    return {
      start, error, refresh, toggle: open, setResume: callback => { resume = callback; },
      update: (done, count, desc) => {
        if (destroyed) return;
        step = done; total = count; description = desc;
        refresh();
      },
      fade: () => close(),
      finish: ({ paused = false } = {}) => {
        if (destroyed || state === 'error') return;
        state = paused && (!total || step < total) ? 'paused' : 'complete';
        if (state === 'complete' && !total) description = 'Cached translation is ready.';
        refresh();
      },
      reposition: () => { if (panel) place(panel); if (notice) place(notice); },
      destroy: () => { close(); clearNotice(); destroyed = true; },
    };
  }
  NS.ui.makeTranslationStatus = makeTranslationStatus;
})();
