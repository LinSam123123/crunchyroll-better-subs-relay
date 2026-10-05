/**
 * lib/overlay-ui.js — transient overlay primitives shared across the
 * extension's status messaging.
 *
 * Replaces three near-duplicate toast functions and a HUD getter/updater/
 * fader trio that all hand-rolled the same parent-resolution dance.
 *
 * Exposes:
 *   CRSubFix.ui.showToast({ host, text, color, borderColor, fontWeight,
 *                          duration, zIndex })
 *
 *   CRSubFix.ui.makeProgressHud(host, { id?, zIndex? }) → HUD
 *     host may be an element or a resolver for fullscreen-safe placement.
 *     update(step, total, desc) — progress bar + step description
 *     html(content, fadeAfterMs?) — replace contents (caller composes HTML)
 *     fade()                    — fade out and remove
 *     error(text, retry?)        — persistent, text-only failure with actions
 *     reposition()              — move an existing HUD to its current host
 *
 *   CRSubFix.ui.escapeHtml(s)
 */
(function () {
  'use strict';

  const NS = (typeof self !== 'undefined' ? self : globalThis);
  // Shared visual tokens (lib/ui-theme.js, loaded earlier).  Fall back to the
  // prior literals if it's somehow absent, so toasts never break.
  const T = (NS.CRSubFix && NS.CRSubFix.uiTheme && NS.CRSubFix.uiTheme.tokens) || {};

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showToast({
    host, text,
    color       = 'rgba(255,255,255,0.72)',
    borderColor = 'rgba(255,255,255,0.13)',
    fontWeight  = '500',
    duration    = 2200,
    zIndex      = 10,
  }) {
    const target = host ?? document.body;
    if (!target) return;
    const isAbsolute = target !== document.body;
    if (isAbsolute && window.getComputedStyle(target).position === 'static') {
      target.style.position = 'relative';
    }
    const toast = document.createElement('div');
    toast.textContent = text;
    Object.assign(toast.style, {
      position:      isAbsolute ? 'absolute' : 'fixed',
      bottom:        isAbsolute ? '18%'      : '120px',
      left:          '50%',
      transform:     'translateX(-50%)',
      background:    'rgba(0,0,0,0.52)',
      color,
      fontSize:      '12px',
      fontWeight,
      padding:       '4px 14px',
      borderRadius:  '20px',
      border:        `1px solid ${borderColor}`,
      fontFamily:    T.font || 'sans-serif',
      pointerEvents: 'none',
      zIndex:        String(zIndex),
      opacity:       '1',
      transition:    'opacity 0.6s ease',
      whiteSpace:    'nowrap',
      letterSpacing: '0.3px',
    });
    target.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; }, duration);
    setTimeout(() => { toast.remove(); }, duration + 700);
  }

  const HUD_ID = 'cr-remaster-hud';
  const hudTimers = new WeakMap();

  function makeProgressHud(host, { id = HUD_ID, zIndex = 10 } = {}) {
    function resetTimers(h) {
      const timers = hudTimers.get(h);
      if (timers) { clearTimeout(timers.fade); clearTimeout(timers.remove); }
      const next = {};
      hudTimers.set(h, next);
      return next;
    }
    function place(h) {
      const target = typeof host === 'function' ? host() : host;
      if (!target) return;
      if (target !== document.body && getComputedStyle(target).position === 'static') {
        target.style.position = 'relative';
      }
      h.style.position = target === document.body ? 'fixed' : 'absolute';
      if (h.parentElement !== target) target.appendChild(h);
    }
    function el() {
      const target = typeof host === 'function' ? host() : host;
      if (!target) return null;
      let h = document.getElementById(id);
      if (h) {
        resetTimers(h);
        delete h.dataset.state;
        h.style.opacity = '1';
        h.style.pointerEvents = 'none';
        place(h);
        return h;
      }
      h = document.createElement('div');
      h.id = id;
      h.setAttribute('role', 'status');
      h.setAttribute('aria-live', 'polite');
      Object.assign(h.style, {
        position:      'absolute',
        top:           '10%',
        left:          '50%',
        transform:     'translateX(-50%)',
        background:    'rgba(0,0,0,0.72)',
        color:         'rgba(255,255,255,0.88)',
        fontSize:      '11px',
        fontFamily:    T.font || 'monospace, sans-serif',
        fontWeight:    '500',
        padding:       '6px 16px 8px',
        borderRadius:  '6px',
        border:        `1px solid ${T.panelEdge || 'rgba(255,255,255,0.12)'}`,
        pointerEvents: 'none',
        zIndex:        String(zIndex),
        opacity:       '1',
        transition:    'opacity 0.5s ease',
        whiteSpace:    'normal',
        overflowWrap:  'anywhere',
        boxSizing:     'border-box',
        letterSpacing: '0',
        lineHeight:    '1.5',
        width:         'min(460px, calc(100% - 32px))',
        textAlign:     'center',
      });
      resetTimers(h);
      place(h);
      return h;
    }

    function update(step, total, desc) {
      const h = el();
      if (!h) return;
      const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((step / total) * 100))) : 0;
      const accent = T.accent || '#ff6b35';
      h.innerHTML =
        `<div style="margin-bottom:5px;color:${accent};font-weight:700;letter-spacing:0.5px;">` +
          `${total > 0 ? `${step}/${total}` : '…'}  <span style="color:rgba(255,255,255,0.5);">│</span>  ${desc}` +
        `</div>` +
        `<div role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" style="height:3px;background:rgba(255,255,255,0.12);border-radius:1px;overflow:hidden;">` +
          `<div style="width:${pct}%;height:100%;background:${accent};border-radius:1px;transition:width 0.25s ease;"></div>` +
        `</div>`;
    }

    function html(content, fadeAfterMs) {
      const h = el();
      if (!h) return;
      h.innerHTML = content;
      if (fadeAfterMs > 0) hudTimers.get(h).fade = setTimeout(() => fadeElement(h), fadeAfterMs);
    }

    function fadeElement(h) {
      const timers = resetTimers(h);
      h.style.opacity = '0';
      timers.remove = setTimeout(() => h.remove(), 600);
    }
    function fade() {
      const h = document.getElementById(id);
      if (h) fadeElement(h);
    }
    function error(text, onRetry, retryLabel = 'Retry') {
      const h = el();
      if (!h) return;
      h.replaceChildren();
      h.style.pointerEvents = 'auto';
      h.dataset.state = 'error';
      const message = document.createElement('div');
      message.textContent = text;
      message.style.padding = '6px 0 10px';
      h.appendChild(message);
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:10px;justify-content:center';
      for (const [label, handler] of [
        [retryLabel, onRetry],
        ['Dismiss', fade],
      ]) {
        if (!handler) continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.style.cssText = 'padding:6px 14px;background:#303838;color:#fff;border:1px solid #91a4a0;border-radius:4px;cursor:pointer;font:inherit';
        button.addEventListener('click', event => { event.stopPropagation(); handler(); });
        actions.appendChild(button);
      }
      h.appendChild(actions);
    }
    function reposition() {
      const h = document.getElementById(id);
      if (h) place(h);
    }

    return { update, html, fade, error, reposition };
  }

  NS.CRSubFix = NS.CRSubFix || {};
  NS.CRSubFix.ui = { showToast, makeProgressHud, escapeHtml };
})();
