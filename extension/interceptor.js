/**
 * interceptor.js — runs in the MAIN world (page's own JS context).
 *
 * Features:
 * 1. JP-first parallel session fetch (avoids 420 on reload)
 * 2. DASH manifest VTT swap (automatic, native "English [CC]" track)
 * 3. "JP CC" overlay button with ASS typesetting support
 *    - Parses [Script Info], [V4+ Styles], and per-dialogue override tags
 *    - Positions signs using scaled \pos coordinates + alignment transforms
 *    - Fades via Web Animations API
 *    - Hides native subtitle tracks while active
 * 4. Auto-activate: enables JP CC automatically when video starts playing
 * 5. Subtitle size + sync offset read from data attributes (set by content.js)
 * 6. Status attributes on <html> for popup display and extension badge
 * 7. SPA navigation detection (pushState / popstate reset)
 * 8. Debounced MutationObserver
 * 9. sessionStorage subtitle text cache (survives off/on toggle)
 * 10. Subtitle duration validation: detects cross-linked wrong-title subtitle files
 *     by comparing subtitle end time against video duration.  When a mismatch is
 *     found, probes all available audio sessions for a valid replacement before
 *     falling back to an "unavailable" state with a clear menu indicator.
 *
 * Settings read from <html> data attributes (written by content.js):
 *   data-cr-sub-fix        "true"|"false"   — extension enabled
 *   data-cr-auto-activate  "true"|"false"   — auto-enable on play
 *   data-cr-sub-scale      float            — subtitle size multiplier
 *   data-cr-sub-offset     float            — sync offset in seconds
 *
 * Status attributes written here (read by content.js for popup/badge):
 *   data-cr-jp-status   "none"|"ready"|"active"|"reload"|"error"|"unavailable"
 *   data-cr-jp-active   "true"|"false"
 *
 * Architecture (see lib/*):
 *   lib/settings-schema.js   — DOM-attr ↔ chrome.storage settings schema
 *   lib/storage.js           — typed localStorage / sessionStorage facade
 *   lib/playback-api.js      — pure parsers for Crunchyroll's playback response
 *                              (subtitle URL matrix, EN pick, dub versions)
 *   lib/subtitle-parser.js   — ASS / WebVTT pure parsers + color utils
 *   lib/subtitle-catalog.js  — per-page registry of subtitle URLs and the
 *                              policy for picking the best URL for a locale
 *   lib/episode.js           — per-viewing Episode container: JP urls, cues,
 *                              remaster, validation, catalog, auth.  Driven by
 *                              SPA navigation; routes by guid so late-arriving
 *                              fetch responses for navigated-away viewings are
 *                              dropped via Episode's disposed-guard.  All cue
 *                              and URL state in this file lives behind ep.X.
 *   lib/overlay-ui.js        — toast and progress-HUD primitives
 */

(function () {
  'use strict';

  // Diagnostic: surface any missing module so a silent bail is visible.
  const NS = self.CRSubFix;
  if (!NS) { console.warn('[CR Sub Fix] interceptor.js bail: self.CRSubFix is undefined'); return; }
  const _missing = ['settings','storage','parser','ui','createCatalog','episode','protocol','cueStyle','createCueRenderer','createSubSuppression','wrongTitle','remaster','createSourceMenu','playbackApi','signTrack','subSync','customSource','uiTheme','learning','mtUtils','subtitleExport'].filter(k => !NS[k]);
  if (_missing.length) {
    console.warn('[CR Sub Fix] interceptor.js bail: missing modules:', _missing, 'present:', Object.keys(NS));
    return;
  }
  // Wrap the rest of the IIFE so any throw is logged instead of silenced.
  try {

  const SETTINGS = NS.settings;
  const STORAGE  = NS.storage;
  const PARSER   = NS.parser;
  const UI       = NS.ui;
  const t = (source, params) => NS.i18n?.t(source, params) ?? source;
  const uiText = (el, source, params) => {
    if (NS.playerI18n) NS.playerI18n.text(el, source, params);
    else el.textContent = t(source, params);
  };
  const EP       = NS.episode;
  const PROTOCOL = NS.protocol;
  const CUE_STYLE = NS.cueStyle;
  const WRONG_TITLE = NS.wrongTitle;
  const REMASTER  = NS.remaster;
  const PLAYBACK  = NS.playbackApi;
  const SIGN_TRACK = NS.signTrack;
  const SUB_SYNC   = NS.subSync;
  const CUSTOM     = NS.customSource;
  const LEARN      = NS.learning;
  const THEME      = NS.uiTheme.tokens;
  const panelStyle = NS.uiTheme.panel;

  // Re-exports so existing call sites keep working unchanged.
  const { parseSubtitles, normalizeSubText, applyAlpha } = PARSER;
  const { escapeHtml } = UI;
  const { hexToRgba } = CUE_STYLE;
  const { buildAnchorMap, remasterCues, computeMedianDelta, estimateGlobalOffset, shiftCues, MIN_ANCHORS } = REMASTER;
  // Custom source: identity + record construction (lib/custom-source.js), the
  // timing model (lib/sub-sync.js), and the typeset-signs projection
  // (lib/sign-track.js).  This file keeps the DOM wiring, fetching, and the
  // apply path that thread these together.
  const { buildSignsAss, extractSignTexts, rebuildSignsAss, mergeSigns } = SIGN_TRACK;
  const applyCustomSync = SUB_SYNC.applySync;
  const { computeLinearSync } = SUB_SYNC;

  // Logging + diagnostics.  The sessionStorage *trace* records ALWAYS (silently)
  // — it backs the popup's "Report an issue" diagnostics and the crSubFixDebug
  // tools.  It's cheap: log lines only fire at navigation/activation events,
  // never per-frame, and ride a 400-entry ring buffer that survives SPA navs and
  // reloads (the devtools console gets wiped on each pushState).  The DEBUG flag
  // only adds live *console* output on top — OFF by default so the published
  // build stays quiet; genuine errors always print.  Toggle console verbosity at
  // runtime, no rebuild, from the page console:
  //     crSubFixDebug.on()    // verbose console (then reload)
  //     crSubFixDebug.dump()  // read the trace (always populated)
  //     crSubFixDebug.off()   // quiet console again (then reload)
  const DEBUG = (() => {
    try { return localStorage.getItem('crSubFix_debug') === '1'; } catch (_) { return false; }
  })();
  const TRACE_KEY = 'crSubFix_trace';
  const TRACE_MAX = 400;
  // Strip signed-URL query strings, emails, and long hex tokens.  Applied at trace
  // WRITE time so secrets never sit in sessionStorage (also reused for the report).
  const redactSensitive = (s) => String(s)
    .replace(/(https?:\/\/[^\s|?]+)\?[^\s|]*/gi, '$1?<redacted>')
    .replace(/[^\s@|]+@[^\s@|]+\.[^\s@|]+/g, '<email>')
    .replace(/\b[0-9a-f]{32,}\b/gi, '<id>');
  const traceMirror = (level, args) => {
    try {
      const arr  = JSON.parse(sessionStorage.getItem(TRACE_KEY) || '[]');
      const guid = (location.pathname.split('/')[2] || '?').slice(0, 9);
      arr.push(redactSensitive(`${Date.now()} ${guid} [${level}] ` + args.map(a => {
        try { return typeof a === 'string' ? a : JSON.stringify(a); }
        catch (_) { return String(a); }
      }).join(' ')));
      while (arr.length > TRACE_MAX) arr.shift();
      sessionStorage.setItem(TRACE_KEY, JSON.stringify(arr));
    } catch (_) {}
  };
  const log = {
    info:  (...a) => { if (DEBUG) console.info(LOG, ...a); traceMirror('I', a); },
    warn:  (...a) => { if (DEBUG) console.warn(LOG, ...a); traceMirror('W', a); },
    error: (...a) => { console.error(LOG, ...a); traceMirror('E', a); },
  };
  // Always-available diagnostic controls (work whether or not DEBUG is on) so a
  // user hitting a problem can capture a full trace without a rebuild.
  try {
    window.crSubFixDebug = {
      on:    () => { try { localStorage.setItem('crSubFix_debug', '1'); } catch (_) {} return 'CR Sub Fix verbose logging ON — reload to see it in the console.'; },
      off:   () => { try { localStorage.removeItem('crSubFix_debug'); } catch (_) {} return 'CR Sub Fix verbose logging OFF — reload to apply.'; },
      dump:  () => { try { return JSON.parse(sessionStorage.getItem(TRACE_KEY) || '[]').join('\n'); } catch (_) { return ''; } },
      clear: () => { try { sessionStorage.removeItem(TRACE_KEY); } catch (_) {} return 'CR Sub Fix trace cleared.'; },
      // Throws an uncaught error from our own code so the on-error report nudge
      // can be tested without waiting for a real bug (no-op unless a
      // REPORT_ENDPOINT is configured).
      testReport: () => { if (!DEBUG) return 'Run crSubFixDebug.on() then reload first.'; setTimeout(() => { throw new Error('Better Subs: test report (ignore) #' + Date.now()); }, 0); return 'Test error thrown — watch for the report nudge near the player.'; },
      // Tune machine-translation throughput live (no reload).  Keys: batch (cues
      // per request), pace (ms between batches), timeout (ms), ratewait (ms after
      // a 429), retries.  e.g. crSubFixDebug.mtTune({ batch: 15, pace: 6000 })
      mtTune: (o = {}) => {
        const map = { batch: 'crSubFix_mt_batch', pace: 'crSubFix_mt_pace', timeout: 'crSubFix_mt_timeout', ratewait: 'crSubFix_mt_ratewait', retries: 'crSubFix_mt_retries' };
        try { for (const [k, key] of Object.entries(map)) if (o[k] != null) localStorage.setItem(key, String(o[k])); } catch (_) {}
        const cur = {}; try { for (const [k, key] of Object.entries(map)) { const v = localStorage.getItem(key); if (v != null) cur[k] = +v; } } catch (_) {}
        return 'MT tuning = ' + JSON.stringify(cur) + ' — remove the track (✕) and re-translate to apply.';
      },
      mtTuneReset: () => { try { ['batch', 'pace', 'timeout', 'ratewait', 'retries'].forEach(k => localStorage.removeItem('crSubFix_mt_' + k)); } catch (_) {} return 'MT tuning reset to defaults.'; },
      // Positioning diagnostics: dumps the overlay box, the real <video> box, the
      // intrinsic size, the computed letterbox content box, and where each
      // positioned (\pos) sign actually landed vs where its coords map to.  Run
      // during a typeset scene: copy(crSubFixDebug.geom())
      geom: () => {
        try {
          const ov = document.getElementById(OVERLAY_ID);
          const v  = document.querySelector('video');
          if (!ov || !v) return 'no overlay/video (activate subtitles first)';
          const orect = ov.getBoundingClientRect();
          const vrect = v.getBoundingClientRect();
          const w = ov.offsetWidth, h = ov.offsetHeight;
          const vW = v.videoWidth, vH = v.videoHeight;
          // recompute the content box the renderer uses
          let box = { x: 0, y: 0, w, h };
          if (vW && vH && w && h) {
            const ea = w / h, va = vW / vH;
            if (Math.abs(ea - va) >= 0.01) {
              if (ea > va) { const cw = h * va; box = { x: (w - cw) / 2, y: 0, w: cw, h }; }
              else         { const ch = w / va; box = { x: 0, y: (h - ch) / 2, w, h: ch }; }
            }
          }
          const signs = Array.from(ov.querySelectorAll('[data-crpos]')).map((c) => {
            const r = c.getBoundingClientRect();
            const [px, py] = c.dataset.crpos.split(',').map(Number);
            const [rx, ry] = c.dataset.crres.split('x').map(Number);
            const expLeft = Math.round(box.x + px * (box.w / (rx || 640)));
            const expTop  = Math.round(box.y + py * (box.h / (ry || 360)));
            return {
              text: (c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 22),
              pos: c.dataset.crpos, res: c.dataset.crres, an: c.dataset.cran,
              styleLeftTop: `${c.style.left},${c.style.top}`,
              expWithinBox: `${expLeft},${expTop}`,
              renderedInOverlay: `${Math.round(r.left - orect.left)},${Math.round(r.top - orect.top)} (${Math.round(r.width)}x${Math.round(r.height)})`,
            };
          });
          return JSON.stringify({
            overlayBox:  `${Math.round(orect.width)}x${Math.round(orect.height)} @(${Math.round(orect.left)},${Math.round(orect.top)})`,
            videoBox:    `${Math.round(vrect.width)}x${Math.round(vrect.height)} @(${Math.round(vrect.left)},${Math.round(vrect.top)})`,
            overlayVsVideoOffset: `${Math.round(orect.left - vrect.left)},${Math.round(orect.top - vrect.top)}  size Δ ${Math.round(orect.width - vrect.width)}x${Math.round(orect.height - vrect.height)}`,
            intrinsic:   `${vW}x${vH}`,
            offsetWH:    `${w}x${h}`,
            contentBox:  `x${Math.round(box.x)} y${Math.round(box.y)} ${Math.round(box.w)}x${Math.round(box.h)}`,
            objectFit:   getComputedStyle(v).objectFit,
            signs,
          }, null, 1);
        } catch (e) { return 'geom error: ' + (e && e.message); }
      },
      // Dumps the ACTIVE subtitle file's [Script Info] (PlayRes), [V4+ Styles]
      // (so we see each style's Alignment), and sample \pos Dialogue lines (their
      // \an + \pos) — so we can tell whether the parser's res/alignment match
      // what the file actually says.  Run during a typeset scene.
      assInfo: () => {
        try {
          const ep = currentEp();
          let raw = ep?.activeSubUrl ? ep.getCachedRawText(ep.activeSubUrl) : null;
          if (!raw) {
            for (let i = 0; i < sessionStorage.length; i++) {
              const k = sessionStorage.key(i);
              if (k && k.startsWith('crSubFix_raw_')) {
                const v = sessionStorage.getItem(k);
                if (v && /\[Script Info\]|Dialogue:/.test(v)) { raw = v; break; }
              }
            }
          }
          if (!raw) return 'no cached subtitle text — activate a CR subtitle source first';
          const L = raw.replace(/\r/g, '').split('\n');
          const out = ['--- [Script Info] ---'];
          for (const l of L) if (/^(PlayResX|PlayResY|ScriptType|WrapStyle|ScaledBorderAndShadow|LayoutResX|LayoutResY)\s*:/i.test(l)) out.push(l.trim());
          out.push('--- [V4+ Styles] ---');
          let inS = false, n = 0;
          for (const l of L) {
            if (/^\[.*Styles\]/i.test(l)) { inS = true; continue; }
            if (/^\[/.test(l)) inS = false;
            if (inS && /^(Format|Style)\s*:/i.test(l) && n < 8) { out.push(l.trim()); n++; }
          }
          out.push('--- Dialogue with \\pos (samples) ---');
          let d = 0;
          for (const l of L) if (/^Dialogue:/i.test(l) && /\\pos/i.test(l) && d < 5) { out.push(l.trim().slice(0, 240)); d++; }
          return out.join('\n');
        } catch (e) { return 'assInfo error: ' + (e && e.message); }
      },
      // Tune the typeset-sign size factor (default 0.9) to match CR exactly.
      // e.g. crSubFixDebug.signScale(0.85).  Repaints immediately.
      signScale: (x) => {
        if (typeof x === 'number' && x > 0 && x <= 2) {
          try { localStorage.setItem('crSubFix_signscale', String(x)); } catch (_) {}
          try { renderer.invalidate(); onTimeUpdate(); } catch (_) {}
          return 'Sign scale = ' + x + ' (repainted; default 0.9).';
        }
        let cur = 0.9; try { const v = parseFloat(localStorage.getItem('crSubFix_signscale')); if (v) cur = v; } catch (_) {}
        return 'Sign scale = ' + cur + '. Set with crSubFixDebug.signScale(0.85) — range 0.1–2.';
      },
      // Tune the 3-D perspective distance (px) for \frx/\fry signs.  Smaller =
      // stronger foreshortening.  e.g. crSubFixDebug.persp(250).  Repaints.
      persp: (x) => {
        if (typeof x === 'number' && x > 0) {
          try { localStorage.setItem('crSubFix_persp', String(x)); } catch (_) {}
          try { renderer.invalidate(); onTimeUpdate(); } catch (_) {}
          return 'Perspective = ' + x + 'px (repainted; default ≈ video height).';
        }
        let cur = 'auto(≈video height)'; try { const v = parseFloat(localStorage.getItem('crSubFix_persp')); if (v) cur = v + 'px'; } catch (_) {}
        return 'Perspective = ' + cur + '. Set with crSubFixDebug.persp(1400) — bigger = flatter/subtler.';
      },
      // Opens the in-player Typeset-tuning slider panel (perspective / 3-D / skew
      // / rotation / size) for dialling the sign transforms in live.
      tune: () => { try { openTypesetTunePanel(); return 'Typeset tuning panel opened (drag the title to move it).'; } catch (e) { return 'tune error: ' + (e && e.message); } },
      // Toggle the real-libass (SubtitlesOctopus) sign renderer vs the CSS one.
      libass: (on) => {
        if (typeof on === 'boolean') {
          try { localStorage.setItem('crSubFix_libass', on ? '1' : '0'); } catch (_) {}
          try { renderer.invalidate(); pushSignLayer(); onTimeUpdate(); } catch (_) {}
          return 'libass signs = ' + on + (on ? '' : ' (CSS renderer handles signs).');
        }
        return 'libass signs = ' + isLibassSigns() + '. crSubFixDebug.libass(false) → CSS renderer; libass(true) → real libass.';
      },
      // Comprehensive dump (use copy(crSubFixDebug.signTags())): finds the ACTIVE
      // episode's cached file by its asset id and dumps ALL its \pos sign lines in
      // full, lists every cached file, and prints the parsed transform values for
      // the signs on screen (incl. \frx/\fry).  Reveals any transform we missed.
      signTags: () => {
        try {
          const ep = currentEp();
          const v  = (typeof videoEl !== 'undefined' && videoEl) || document.querySelector('video');
          if (!ep || !v) return 'no episode/video';
          const out = [];
          let url = ''; try { url = ep.activeSubUrl || ''; } catch (_) {}
          out.push('activeSub: ' + (url || '(null/custom)'));
          // asset id e.g. e00367570a00367606jajp — used to find the cached file
          const am = url.match(/\/([a-z0-9]{12,})\/\d+\/?(?:[^/]*)?$/i) || url.match(/([a-z0-9]{16,})/i);
          const asset = am ? am[1] : '';
          out.push('asset: ' + (asset || '(none)'));
          let off = 0; try { off = priOffset(); } catch (_) {}
          const active = (ep.cuesAt(v.currentTime, off) || []).filter((c) => c.pos);
          out.push('-- parsed signs on screen --');
          for (const c of active) out.push(`  "${(c.text || '').replace(/\s+/g, ' ').slice(0, 30)}" frz=${c.frz} frx=${c.frx} fry=${c.fry} fax=${c.fax} fay=${c.fay} fscx=${c.fscx} fscy=${c.fscy} an=${c.alignment} pos=${c.pos ? c.pos.x + ',' + c.pos.y : '-'}`);
          // collect every cached file
          const files = [];
          for (let i = 0; i < sessionStorage.length; i++) {
            const k = sessionStorage.key(i);
            if (k && k.startsWith('crSubFix_raw_')) { const t = sessionStorage.getItem(k); if (t) files.push({ key: k.slice('crSubFix_raw_'.length), text: t }); }
          }
          out.push(`-- ${files.length} cached files --`);
          for (const f of files) {
            const posN = (f.text.match(/^Dialogue:.*\\pos/gim) || []).length;
            const isAct = asset && f.key.indexOf(asset) >= 0;
            out.push(`${isAct ? '>>ACTIVE ' : '  '}${f.key.slice(0, 95)}  (${posN} \\pos)`);
          }
          // dump the ACTIVE file's \pos lines in full; else fall back to all files
          const act = files.filter((f) => asset && f.key.indexOf(asset) >= 0);
          const tgt = act.length ? act : files;
          out.push('-- \\pos lines ' + (act.length ? '(ACTIVE file, full)' : '(all files — active not cached)') + ' --');
          for (const f of tgt) {
            const lines = f.text.split('\n').filter((l) => /^Dialogue:/i.test(l) && /\\pos/i.test(l));
            for (const l of lines.slice(0, 60)) out.push('  ' + l.trim().slice(0, 300));
          }
          let s = out.join('\n');
          if (s.length > 16000) s = s.slice(0, 16000) + '\n…(trimmed at 16k)';
          return s;
        } catch (e) { return 'signTags error: ' + (e && e.message); }
      },
      get isOn() { return DEBUG; },
    };
  } catch (_) {}

  // One-time random token written to a <html> attribute that content.js reads
  // and echoes back inside its CR_SUB_TOGGLE postMessage, so we accept the
  // toggle only from a sender that knows the token.
  //
  // Threat model (intentionally modest): this runs in the MAIN world and writes
  // the token to the page DOM, so a determined page script *can* read the
  // attribute and forge the message — the token is NOT a hard security boundary.
  // It exists to reject accidental / unrelated postMessages of the same type,
  // and the guarded action (showing/hiding the subtitle overlay) is harmless,
  // so that is sufficient. Do not rely on this token to gate anything sensitive.
  const TOGGLE_TOKEN = Math.random().toString(36).slice(2);
  document.documentElement.setAttribute(PROTOCOL.ATTR.TOGGLE_TOKEN, TOGGLE_TOKEN);

  const PLAYBACK_RE    = /\/playback\/v3\/([^/]+)\/web\/chrome\/play/;
  const MANIFEST_RE    = /\/dash\/manifest\.mpd/;
  const LOG            = '[CR Sub Fix]';
  const BTN_ID           = 'cr-jp-cc-btn';
  const PROGRESS_ID      = 'cr-bsub-progress';
  // OVERLAY_ID is kept here because subSuppression's CSS selectors reference
  // it to exclude our own overlay from the visibility:hidden sweep.  The
  // renderer also uses the same literal — keep them in sync.
  const OVERLAY_ID       = 'cr-jp-cc-overlay';
  const LOCALE_PREF_KEY       = 'crSubFix_preferred_locale';
  const ANCHOR_TTL            = 30 * 24 * 60 * 60 * 1000; // 30 days
  // MIN_ANCHORS, buildAnchorMap, remasterCues, computeMedianDelta live in
  // lib/remaster.js — aliased near the top of this file.

  // Human-readable names for audio-locale codes (each dub = a subtitle source option)
  const LOCALE_LABELS = {
    'ja-JP': 'English (Japanese audio)', 'en-US': 'English',
    'en-GB': 'English (UK)',      'de-DE': 'Deutsch',
    'es-419':'Español (Lat)',     'es-ES': 'Español (España)',
    'ca-ES': 'Català',            'fr-FR': 'Français',
    'pt-BR': 'Português (BR)',    'pt-PT': 'Português (PT)',
    'it-IT': 'Italiano',          'ru-RU': 'Русский',
    'ar-ME': 'العربية',            'ar-SA': 'العربية (SA)',
    'zh-CN': '中文 (简)',           'zh-TW': '中文 (繁)',
    'zh-HK': '中文 (港)',
    'hi-IN': 'हिंदी',             'ko-KR': '한국어',
    'pl-PL': 'Polski',            'tr-TR': 'Türkçe',
    'nl-NL': 'Nederlands',        'fi-FI': 'Suomi',
    'sv-SE': 'Svenska',           'nb-NO': 'Norsk',
    'da-DK': 'Dansk',             'cs-CZ': 'Čeština',
    'ro-RO': 'Română',            'hu-HU': 'Magyar',
    'ms-MY': 'Bahasa Melayu',     'th-TH': 'ภาษาไทย',
    'id-ID': 'Bahasa Indonesia',  'vi-VN': 'Tiếng Việt',
    'te-IN': 'తెలుగు',            // seen live 2026-08 (Telugu dub sessions)
  };
  // Short 2-char labels shown on the toggle button while a source is active
  const LOCALE_SHORT = {
    'ja-JP':'JP','en-US':'EN','en-GB':'EN','de-DE':'DE',
    'es-419':'ES','es-ES':'ES','ca-ES':'CA',
    'fr-FR':'FR','pt-BR':'PT','pt-PT':'PT','it-IT':'IT',
    'ru-RU':'RU','ar-ME':'AR','ar-SA':'AR',
    'zh-CN':'ZH','zh-TW':'ZH','zh-HK':'ZH','hi-IN':'HI','ko-KR':'KO',
    'pl-PL':'PL','tr-TR':'TR','nl-NL':'NL','fi-FI':'FI',
    'sv-SE':'SV','nb-NO':'NO','da-DK':'DA','cs-CZ':'CS',
    'ro-RO':'RO','hu-HU':'HU','ms-MY':'MS','th-TH':'TH',
    'id-ID':'ID','vi-VN':'VI','te-IN':'TE',
  };

  const originalFetch = window.fetch.bind(window);

  // ── Page-chrome state ─────────────────────────────────────────────────────
  // Per-Episode state (subtitle URLs, cues + remaster, JP guid, auth, validation,
  // catalog) lives in lib/episode.js.  The renderer owns its own overlay element
  // and per-frame cue cache (lib/cue-renderer.js).  The vars below are about
  // the player widget on the page — they survive across episodes structurally.
  let videoEl            = null;
  let overlayActive      = false;
  let clickInProgress    = false;
  let buttonInControls   = false;
  let movedToControls    = false;

  // Queue-on-click latch.  When the user clicks JP CC before data is ready
  // (typical right after dub switch, when the new Episode has no playback
  // response yet), handleButtonClick sets this and parks the button in
  // 'loading' instead of failing.  The data-arrival paths
  // (maybePrefetch / playback intercept JP success) fire onJpDataReady
  // to complete the user's click the moment JP data lands.
  let pendingActivate    = false;

  // Timer that proactively resolves a stuck queue when Crunchyroll's player
  // never fires /playback/v3/ for the new dub.  Set when the click is
  // queued; cleared when data arrives or the Episode is torn down.
  let queueResolverTimer = null;
  const QUEUE_RESOLVE_MS = 2000;

  // Settle debounce for rapid dub switching.  Each SPA navigation resets this;
  // when switching pauses for SETTLE_MS, tryAutoActivate fires once more so the
  // dub the user actually landed on gets its JP subtitles, even if earlier
  // half-finished switches dropped their bootstrap.
  let settleTimer = null;
  let settleAttempts = 0;
  const SETTLE_MS  = 400;
  const SETTLE_MAX = 8;

  // Slug → { jpGuid, auth } memory for cross-dub recovery.  A dub switch routes
  // through a slug-less intermediate URL that disposes the episode holding the
  // resolved JP guid, so the same-nav carry can't survive it — this can.  See
  // handleNavigation.  Bounded (MRU on write, evict oldest) so a long browsing
  // session can't grow it without limit.
  const slugJpMemo = new Map();
  const SLUG_MEMO_MAX = 50;
  function rememberSlug(slug, data) {
    slugJpMemo.delete(slug);                 // re-insert at the most-recent end
    slugJpMemo.set(slug, data);
    while (slugJpMemo.size > SLUG_MEMO_MAX) slugJpMemo.delete(slugJpMemo.keys().next().value);
  }

  // Renderer instance — created once at module init, mounted/unmounted per
  // player.  getSubScale is read fresh per render so size-slider changes take
  // effect on the next frame without invalidation.
  const renderer = NS.createCueRenderer({
    getSubScale:       () => getSubScale(),
    getSubBottomFloor: () => getSubBottomFloor(),
  });

  // Source picker menu instance — created once.  Callbacks reach into the
  // page-chrome state and the Episode here, which keeps the module ignorant
  // of overlay activation / JP CC button / Source preference persistence.
  const sourceMenu = NS.createSourceMenu({
    getEpisode:      () => currentEp(),
    isOverlayActive: () => overlayActive,
    localeLabels:    LOCALE_LABELS,
    onSelectLocale:  (locale) => selectSource(locale),
    onSelectCustom:  (id)     => {
      selectSource(id);
      const ep = currentEp(), record = ep?.getCustomSource(id);
      if (record?.kind === 'external') rpc('external-active', { guid: ep.guid, id, lang: record.lang || '', sync: record.sync })
        .then(res => { if (!res.ok) showErrorToast('字幕已切换，但未能保存选择；请在外部字幕页重新加载。'); });
    },
    // Dual subtitles: pick / clear the secondary track (persisted across episodes).
    onSelectSecondary: (locale) => selectSecondary(locale),
    getSecondary:      ()       => getSecondaryPref(),
    // Learning mode: the guided "match the audio + your language" stack.  The
    // menu hands back the locale to use as the support ("native") track; we set
    // the audio-matched primary + that secondary (see applyLearningMode).
    onApplyLearning:   (locale) => applyLearningMode(locale),
    getLearningInfo:   ()       => learningInfo(),
    // Which track draws typeset signs (primary / secondary / both).
    onSetSignSource:   (mode)   => setSignSrcMode(mode),
    getSignSource:     ()       => getSignSrcMode(),
    // Whether the loaded secondary track actually has signs (else grey out the
    // Secondary/Both sign options — CR ships some locales dialogue-only).
    getSecondaryHasSigns: ()    => _secondaryHasSigns,
    // ▾ → "Show" submenu: per-layer visibility.  'official' is the inverse of
    // hideOfficialSubs (the switch reads "Crunchyroll's own subtitles", so on =
    // shown).  Writes go through saveSetting (chrome.storage, popup-synced).
    getLayer: (name) =>
      name === 'dialogue' ? !!isShowDialogue()
      : name === 'signs'  ? !!isShowSigns()
      : name === 'official' ? !isHideOfficialSubs()
      : true,
    onSetLayer: (name, on) => {
      if (name === 'dialogue')      saveSetting('showDialogue', !!on);
      else if (name === 'signs')    saveSetting('showSigns', !!on);
      else if (name === 'official') {
        saveSetting('hideOfficialSubs', !on);
        // Burned-in (hardsub) streams can only change on a fresh playback
        // load — hiding takes a reload; the DOM suppression layers handle
        // everything else live.
        if (!on && _hardsubStream) {
          showErrorToast(
            'This video has Crunchyroll subtitles burned in — reload to remove them.',
            () => setTimeout(() => location.reload(), 400),
            'Reload'
          );
        }
      }
    },
    onLoadFile:      ()       => promptLoadFile(),
    onExternalSubs:  ()       => openExternalSubs(),
    onRemoveCustom:  (id)     => removeCustomSource(id),
    onAdjustSync:    (id)     => openSyncPanel(id),
    // Per-track timing nudge — available whenever subtitles are showing.
    onAdjustTiming:  ()       => openTimingPanel(),
    getAdjustTimingAction: () => overlayActive ? { label: '⏱ Adjust timing…' } : null,
    onExport:        ()       => openExportPanel(),
    onWorkProfile:   ()       => openWorkProfile(),
    // One-click translate using the saved target/source (+ popup provider) — no
    // re-picking once you're comfortable with your choices.
    onTranslate:     ()       => translateToTarget(),
    getTranslateAction: () =>
      (!_translating && isMtEnabled() && isMtConfigured() && currentEp())
        ? { label: '🌐 Translate' } : null,
    // The gear opens the settings panel to change target/source (persisted).
    onMtSettings:    ()       => openTranslatePanel(),
    getMtSettingsAction: () =>
      (!_translating && isMtEnabled() && isMtConfigured() && currentEp())
        ? { label: '⚙ Translation settings…' } : null,
    onCancelTranslate: () => cancelTranslate(),
    getCancelAction: () => _translating ? { label: '⏹ Cancel translation' } : null,
    onClearMt: () => clearMtTracks(),
    // Always offered while MT is on (even with zero tracks) — a discoverable way
    // to drop all machine-translated tracks for this episode.
    getClearMtAction: () => (isMtEnabled() && isMtConfigured()) ? { label: '🗑 Clear machine translations' } : null,
    onTurnOff: () => {
      const ep = currentEp();
      if (ep) rpc('external-active', { guid: ep.guid, id: '' });
      setPendingActivate(false); // user explicitly said off — drop any queued click
      if (queueResolverTimer) { clearTimeout(queueResolverTimer); queueResolverTimer = null; }
      const btn = document.getElementById(BTN_ID);
      if (!overlayActive) {
        // Even if overlay was never on (queued click waiting), reset the
        // 'loading' indicator so the button doesn't lie about state.
        if (btn) setButtonState(btn, 'idle');
        return;
      }
      setOverlayActive(false);
      currentEp()?.setActiveSubUrl(null);
      stopSync();
      syncSubSuppression();   // keep CR subs hidden if "hide official" is on
      if (btn) setButtonState(btn, 'idle');
      setJpStatus(PROTOCOL.STATUS.READY);
    },
  });

  // Local availability check shared by tryAutoActivate and the menu module.
  // Returns true / null / false.
  function localeHasContent(locale) {
    const ep = currentEp();
    if (!ep) return false;
    if (isCustomId(locale)) return ep.getCustomSource(locale) ? true : false;
    if (locale === 'ja-JP') {
      if (ep.jpCaptionUrl || ep.jpSubtitleUrl) return true;
      return ep.jpGuid ? null : false;
    }
    return ep.catalog.availability(locale);
  }

  // ── Episode access ────────────────────────────────────────────────────────
  // Helpers that route through the current Episode (lib/episode.js).  Returns
  // the live episode or null when off /watch/.  Disposed Episodes — which exist
  // momentarily after SPA navigation while a stale fetch is still in flight —
  // silently absorb writes via Episode's internal disposed-guard.
  const getEpisodeGuid = () => window.location.pathname.match(/\/watch\/([^/]+)/)?.[1] ?? null;

  // Coarse, non-identifying platform string (OS family + Chrome major) — we
  // deliberately never put the full User-Agent (a fingerprinting surface) in a
  // report.  The episode guid is a public id; we drop the title slug.
  function coarsePlatform() {
    const ua = navigator.userAgent || '';
    let os = 'Unknown';
    if (/Windows NT/.test(ua)) os = 'Windows';
    else if (/Mac OS X/.test(ua)) os = 'macOS';
    else if (/CrOS/.test(ua)) os = 'ChromeOS';
    else if (/Android/.test(ua)) os = 'Android';
    else if (/Linux/.test(ua)) os = 'Linux';
    const m = ua.match(/(?:Chrome|Chromium)\/(\d+)/);
    return `${os} · Chrome ${m ? m[1] : '?'}`;
  }
  const currentEp      = () => EP.current();

  // storeSessionSubs is the most-called catalog op below; route through the
  // current Episode's catalog so the matrix lives with the right viewing.
  // ccLocales (optional) = which entries came from the session's `captions`
  // map — the provenance urlFor needs to serve a dub's own CC (see
  // lib/subtitle-catalog.js).
  const storeSessionSubs = (audioLocale, subs, ccLocales) => {
    const ep = currentEp();
    if (ep) ep.catalog.recordSession(audioLocale, subs, ccLocales);
  };

  // ── Wrong-title detection + recovery (lib/wrong-title.js) ────────────────
  // Detection rule, alternate-session probe, and background validation sweep
  // all live in the wrong-title module.  These wrappers thread in the live
  // videoEl, the fetcher functions (fetchAndParseSubs / fetchSubUrlForSource
  // — defined further down in this file), and the menu-row update callback
  // that has to know about open-menu DOM.

  const validateSubDuration = (cues) =>
    WRONG_TITLE.validate(cues, videoEl?.duration ?? NaN);

  const tryAlternateSession = (lang) => WRONG_TITLE.findReplacement({
    lang,
    ep:                    currentEp(),
    fetchAndParseSubs,
    fetchSubUrlForSource,
    getVideoDurationSec:   () => videoEl?.duration ?? NaN,
    log:                   (msg) => log.info(msg),
  });

  let bgValidatePending = false;
  async function backgroundValidateAll() {
    if (bgValidatePending) return;
    const ep = currentEp();
    if (!ep) return;
    if (!videoEl || !(videoEl.duration >= 60)) {
      if (videoEl) videoEl.addEventListener('loadedmetadata', backgroundValidateAll, { once: true });
      return;
    }
    bgValidatePending = true;
    try {
      await WRONG_TITLE.validateAll({
        ep,
        getVideoDurationSec: () => videoEl?.duration ?? NaN,
        fetchAndParseSubs,
        fetchSubUrlForSource,
        onValidated:         (locale, status) => sourceMenu.updateRow(locale, status),
        log: (msg, level) =>
          level === 'warn' ? log.warn(msg) : log.info(msg),
      });
    } finally {
      bgValidatePending = false;
    }
  }

  // ── Anchor map cache ──────────────────────────────────────────────────────
  // Stores a compact array of {srcTime, refTime} pairs per (episode × srcSession
  // × audioSession).  One map retimes ANY subtitle language for that combination.
  // The cache key is composed by Episode (lib/episode.js) so the episode guid
  // is always read from the live Episode rather than re-derived from the URL.

  function loadAnchorMap(srcSession, audioLocale) {
    const ep = currentEp();
    if (!ep) return null;
    const v = STORAGE.lsGet(ep.anchorMapKey(srcSession, audioLocale));
    if (!v || !Array.isArray(v.anchors) || v.anchors.length < MIN_ANCHORS) return null;
    return { anchors: v.anchors, quality: v.quality, bridge: v.bridge };
  }

  function saveAnchorMap(srcSession, audioLocale, anchors, quality, bridge) {
    const ep = currentEp();
    if (!ep) return;
    STORAGE.lsSet(ep.anchorMapKey(srcSession, audioLocale), { anchors, quality, bridge }, ANCHOR_TTL);
  }

  // Returns the best subtitle URL for the given locale given what's currently
  // playing.  Same-language vs cross-language priority lives in the catalog
  // (lib/subtitle-catalog.js) — see urlFor() there.
  const getSubtitleUrl = (subtitleLocale) => currentEp()?.catalog.urlFor(subtitleLocale) ?? null;

  // Strip CDN auth parameters from a subtitle URL so two URLs for the same file
  // compare equal even when auth tokens differ (same file, re-signed).
  // Handles both Crunchyroll HMAC and AWS CloudFront signed URL formats.
  function subUrlBase(url) {
    if (!url) return '';
    return url
      .replace(/[?&]Policy=[^&]*/i, '')      // CloudFront Policy
      .replace(/[?&]Signature=[^&]*/i, '')   // CloudFront Signature
      .replace(/[?&]Key-Pair-Id=[^&]*/i, '') // CloudFront Key-Pair-Id
      .replace(/[~?&]hmac=[^&]*/i, '')       // HMAC param
      .replace(/[?&]$/, '');                 // trailing ? or &
  }

  // ── Custom sources (uploaded files / machine translation) ─────────────────
  // A custom source is a non-CR subtitle track attached to the Episode (see
  // lib/episode.js's registry).  It rides the SAME apply path as a CR locale —
  // handleButtonClick branches on isCustomId(activeSource) and feeds the
  // record's cues (retimed by applyCustomSync = subSync.applySync) straight
  // into ep.setOriginalCues, skipping URL fetch.  Identity, the record shape,
  // and the timing model live in lib/custom-source.js + lib/sub-sync.js.
  const CUSTOM_LOCAL_ID = CUSTOM.LOCAL_ID;
  const isCustomId = CUSTOM.isCustomId;

  function currentCustomSource() {
    const ep = currentEp();
    const id = ep?.activeSource();
    return (ep && isCustomId(id)) ? ep.getCustomSource(id) : null;
  }
  async function openExternalSubs() {
    const ep = currentEp();
    if (!ep) return;
    const result = await rpc('external-open', { guid: ep.guid }, 10000);
    if (!result?.ok) showErrorToast('外部字幕页未能打开，请刷新播放页后重试。');
  }
  async function installExternal(payload, activate = true, revision = externalChoiceRevision) {
    const ep = currentEp();
    if (!ep || ep.disposed || ep.guid !== payload?.guid || getEpisodeGuid() !== payload.guid ||
        !/^custom:(?:(?:assrt|jimaku):\d+|subdl:[A-Za-z0-9_-]{1,100}):[a-f0-9]+$/.test(payload.id) || typeof payload.text !== 'string' ||
        payload.text.length > 8 * 1024 * 1024) throw new Error('EXTERNAL_INVALID_FILE');
    const record = CUSTOM.makeLocalSource(payload.filename, payload.text);
    if (!record || record.srcCues.length > 30000) throw new Error('EXTERNAL_INVALID_FILE');
    const providerLabel = { subdl: 'SubDL', jimaku: 'Jimaku', assrt: 'assrt' }[payload.provider] || 'assrt';
    Object.assign(record, { id: payload.id, kind: 'external', lang: payload.lang,
      sync: payload.sync, provider: providerLabel, label: record.label + ' · ' + providerLabel });
    ep.addCustomSource(record);
    sourceMenu.updateButtonVisibility();
    if (activate) {
      if (revision !== externalChoiceRevision) return;
      const button = document.getElementById(BTN_ID);
      if (button && ['reload', 'unavail'].includes(button.dataset.state)) setButtonState(button, 'idle');
      selectSource(record.id, true);
      // Wait for local player readiness, not another subtitle download.
      for (let i = 0; i < 200 && currentEp() === ep && revision === externalChoiceRevision &&
          ep.activeSource() === record.id && (!overlayActive || !videoEl?.isConnected); i++) {
        const btn = document.getElementById(BTN_ID);
        if (btn && videoEl?.isConnected && !clickInProgress) await handleButtonClick(btn);
        else await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (currentEp() !== ep || revision !== externalChoiceRevision || ep.activeSource() !== record.id) return;
      if (!overlayActive || !videoEl?.isConnected) throw new Error('EXTERNAL_APPLY_FAILED');
    }
  }
  let externalChoiceRevision = 0;
  const externalRestores = new WeakMap();
  async function restoreExternal(ep) {
    if (currentEp() !== ep || ep.disposed) return;
    let state = externalRestores.get(ep);
    if (!state) {
      state = { originalSource: ep.activeSource(), revision: externalChoiceRevision,
        request: rpc('external-restore', { guid: ep.guid }, 120000), installation: null, reported: false };
      externalRestores.set(ep, state);
    }
    if (state.installation) return state.installation;
    const { originalSource, revision } = state;
    state.installation = (async () => {
      const result = await state.request;
      if (currentEp() !== ep || revision !== externalChoiceRevision) return;
      if (result?.ok === false && !state.reported) {
        state.reported = true;
        showErrorToast('外部字幕恢复未完成，可在外部字幕页查看并重新加载。', openExternalSubs, '外部字幕');
      }
      if (result?.followError && result.followError !== 'FOLLOW_CANCELLED' && !state.reported) {
        state.reported = true;
        const reason = { FOLLOW_METADATA_REQUIRED: '季或集数未可靠识别', FOLLOW_NOT_FOUND: '合集缺少对应集或同版本文件',
          FOLLOW_AMBIGUOUS: '有多个对应文件', ASSRT_RATE_LIMIT: 'assrt 请求限速', SUBDL_RATE_LIMIT: 'SubDL 请求或下载限额' }[result.followError] || '下载或缓存失败';
        showErrorToast(t('字幕合集自动匹配未完成：{reason}。可在 Manage → 外部字幕中手动选择。', { reason }), openExternalSubs, '外部字幕');
      }
      if (result?.record) {
        if (overlayActive && ep.activeSource() === result.record.id) return;
        // Let an automatic native activation finish before replacing its cues.
        for (let i = 0; i < 100 && clickInProgress && currentEp() === ep && revision === externalChoiceRevision; i++)
          await new Promise(resolve => setTimeout(resolve, 100));
        if (!clickInProgress && currentEp() === ep && revision === externalChoiceRevision &&
            (ep.activeSource() === result.record.id || ep.activeSource() === originalSource || !isCustomId(ep.activeSource()))) {
          await installExternal(result.record, result.active !== false, revision);
        }
      }
    })().finally(() => { state.installation = null; });
    return state.installation;
  }
  function handleManualSubtitleClick(btn) {
    externalChoiceRevision++;
    const ep = currentEp();
    if (ep && currentCustomSource()?.kind !== 'external') rpc('external-active', { guid: ep.guid, id: '' }).catch(() => {});
    return handleButtonClick(btn);
  }
  window.addEventListener('message', event => {
    const d = event.data;
    if (event.source !== window || d?.type !== PROTOCOL.POST.EXTERNAL_APPLY || d.token !== TOGGLE_TOKEN) return;
    externalChoiceRevision++;
    const ep = currentEp();
    if (ep && ep.guid === d.payload?.guid) externalRestores.set(ep, {
      originalSource: ep.activeSource(), revision: externalChoiceRevision,
      request: Promise.resolve({ record: d.payload, active: true }), installation: null, reported: false,
    });
    installExternal(d.payload).then(() => {
      window.postMessage({ type: PROTOCOL.POST.EXTERNAL_ACK, id: d.id, token: TOGGLE_TOKEN, ok: true }, location.origin);
    }).catch(() => {
      window.postMessage({ type: PROTOCOL.POST.EXTERNAL_ACK, id: d.id, token: TOGGLE_TOKEN, ok: false }, location.origin);
    });
  });

  // Shared source-selection flow used by both the CR-locale menu rows and the
  // custom-source rows.  Persists only real locales to the cross-episode
  // preference — custom ids are per-episode and must not leak into it.
  // force=true re-applies even when the id is unchanged — needed when a custom
  // source's *content* changed under a stable id (e.g. re-uploading a file into
  // the single 'custom:local' slot while it's the active source).
  function selectSource(locale, force) {
    const cur = currentEp();
    if (!cur) return;
    if (!force && cur.activeSource() === locale && overlayActive) return;
    if (cur.getCustomSource(locale)?.kind !== 'external') {
      rpc('external-active', { guid: cur.guid, id: '' });
    }
    setPendingActivate(false); // explicit selection supersedes any queued click
    if (queueResolverTimer) { clearTimeout(queueResolverTimer); queueResolverTimer = null; }
    if (overlayActive) {
      setOverlayActive(false);
      stopSync();
    }
    cur.setActiveSource(locale);
    if (!isCustomId(locale)) {
      try { localStorage.setItem(LOCALE_PREF_KEY, locale); } catch (_) {}
    }
    cur.clearCues();
    renderer.invalidate();
    const btn = document.getElementById(BTN_ID);
    if (btn) handleButtonClick(btn).catch(() => {});
  }

  // ── Load a local subtitle file ────────────────────────────────────────────
  // Everything stays in the page (MAIN world): a hidden <input type=file> read
  // via File.text(), parsed by the shared parser, registered on the Episode,
  // then selected through the normal apply path.  No cross-world plumbing.
  let _fileInput = null;
  function promptLoadFile() {
    if (!currentEp()) return;
    if (!_fileInput) {
      _fileInput = document.createElement('input');
      _fileInput.type   = 'file';
      _fileInput.accept = '.ass,.ssa,.srt,.vtt,text/plain';
      _fileInput.style.display = 'none';
      document.documentElement.appendChild(_fileInput);
      _fileInput.addEventListener('change', () => {
        const file = _fileInput.files && _fileInput.files[0];
        _fileInput.value = '';  // allow re-picking the same file later
        if (file) ingestSubtitleFile(file).catch(err => {
          log.error('Subtitle file load failed:', err);
          showErrorToast('Could not read that subtitle file.');
        });
      });
    }
    _fileInput.click();
  }

  async function ingestSubtitleFile(file) {
    const ep = currentEp();
    if (!ep) return;
    let text;
    try { text = await file.text(); }
    catch (err) { showErrorToast('Could not read that subtitle file.'); return; }
    const record = CUSTOM.makeLocalSource(file.name, text);
    if (!record) {
      log.warn(`Uploaded file [${file.name}] parsed to 0 cues.`);
      showErrorToast('No subtitles found in that file.');
      return;
    }
    log.info(`Loaded local subtitle file [${file.name}] — ${record.srcCues.length} cues.`);
    ep.addCustomSource(record);
    sourceMenu.updateButtonVisibility();
    // force=true: re-uploading replaces the same 'custom:local' slot, so the id
    // may be unchanged while the cues changed — bypass selectSource's same-id
    // short-circuit to apply the new file's cues live.
    selectSource(CUSTOM_LOCAL_ID, true);
  }

  function removeCustomSource(id) {
    const ep = currentEp();
    if (!ep) return;
    const wasActive = ep.activeSource() === id;
    if (ep.getCustomSource(id)?.kind === 'external') {
      rpc('external-forget', { guid: ep.guid, id }).then(res => {
        if (!res.ok) showErrorToast('未能清除外部字幕选择，下次载入可能恢复。');
      });
    }
    ep.removeCustomSource(id);
    // If it was the second subtitle, drop that too — the band must not keep
    // rendering a deleted record, and the persisted pref would go phantom on
    // the next episode.
    if (getSecondaryPref() === id) selectSecondary('');
    if (wasActive) {
      if (overlayActive) { setOverlayActive(false); stopSync(); }
      ep.setActiveSource(null);
      ep.clearCues();
      renderer.invalidate();
      const btn = document.getElementById(BTN_ID);
      if (btn) setButtonState(btn, 'idle');
      setJpStatus(PROTOCOL.STATUS.READY);
      updateActiveInfo();
    }
    sourceMenu.updateButtonVisibility();
  }

  // Drop every machine-translated track on this Episode (uploads are left
  // alone).  Offered as a menu action even when there are none, so it's a
  // discoverable reset; reuses removeCustomSource so active-track deactivation
  // is handled.
  function clearMtTracks() {
    const ep = currentEp();
    if (!ep) return;
    cancelTranslate();
    translationHud?.destroy();
    translationHud = null;
    hideTranslateProgress();
    rpc('progress', { action: 'clear', guid: ep.guid, configTag: SETTINGS.read(html, 'mtConfigTag') })
      .then(res => { if (!res.ok) showErrorToast('Could not clear saved translation progress.'); });
    const mtIds = ep.listCustomSources().filter(s => s.kind === 'mt').map(s => s.id);
    for (const id of mtIds) removeCustomSource(id);
    clearMtPartials(ep.guid);  // also drop any in-progress/resumable partials
    UI.showToast({
      host: toastHost(),
      text: mtIds.length
        ? t('Cleared {count} machine translations', { count: mtIds.length })
        : t('No machine translations to clear'),
      duration: 2800,
    });
  }

  // Best-effort auto-sync: anchor an upload's cues against an available CR track
  // of the SAME language (text-matching only works within a language, and
  // normalizeSubText strips non-latin scripts — so this lands for latin-script
  // fansubs but not JP-on-JP, which falls back to manual two-point sync).  Runs
  // silently; only a success retimes the track and toasts.
  async function maybeAutoSyncCustom(record) {
    const ep = currentEp();
    if (!ep || ep.getCustomSource(record.id) !== record) return;
    if (record.sync && record.sync.mode && record.sync.mode !== 'none') return;

    // Anchoring matches on normalizeSubText, which strips non-latin scripts.
    // A Japanese (or other non-latin) upload yields no matchable lines, so skip
    // the reference fetches entirely and leave it to manual two-point sync —
    // this is the common "fill the missing JP track" case.
    const latinLines = record.srcCues.reduce(
      (n, c) => n + (normalizeSubText(c.text).length >= 8 ? 1 : 0), 0);
    if (latinLines < MIN_ANCHORS) return;

    const cands = [];
    const seen  = new Set();
    const push  = (lang, url) => { if (url && !seen.has(subUrlBase(url))) { seen.add(subUrlBase(url)); cands.push({ lang, url }); } };
    push('ja-JP', ep.jpCaptionUrl || ep.jpSubtitleUrl);
    const audio = ep.catalog.currentAudio();
    if (audio) push(audio, getSubtitleUrl(audio));
    push('en-US', getSubtitleUrl('en-US'));

    let best = null;
    for (const c of cands) {
      const refCues = await fetchAndParseSubs(c.url);
      if (!refCues.length) continue;
      const anchors = buildAnchorMap(record.srcCues, refCues);
      if (anchors.length >= MIN_ANCHORS && (!best || anchors.length > best.anchors.length)) {
        best = { anchors, lang: c.lang };
      }
    }
    if (!best) return;  // cross-language upload — manual sync only

    ep.setCustomSourceSync(record.id, { mode: 'anchors', anchors: best.anchors, bridge: best.lang });
    if (ep.activeSource() === record.id && overlayActive) {
      ep.setOriginalCues(applyCustomSync(ep.getCustomSource(record.id)));
      renderer.invalidate();
      onTimeUpdate();
    }
    const delta = computeMedianDelta(best.anchors);
    log.info(`Upload auto-synced via [${best.lang}] — ${best.anchors.length} anchors, median ${delta.toFixed(1)}s.`);
    UI.showToast({
      host: toastHost(),
      text: t('Auto-synced to video ({offset}s)', { offset: `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}` }),
      duration: 4000,
    });
  }

  let _openingWork = false;
  window.addEventListener('message', event => {
    const data = event.data, ep = currentEp();
    if (event.source !== window || data?.type !== PROTOCOL.POST.REVIEW_CHANGED ||
        data.token !== TOGGLE_TOKEN || !ep || ep.disposed || data.payload?.guid !== ep.guid) return;
    const p = data.payload;
    if (!Number.isInteger(p.index) || typeof p.text !== 'string' || !p.text.trim() || p.text.length > 30000) return;
    for (const record of ep.listCustomSources()) {
      if (record.reviewCacheKey !== p.key || !record.srcCues[p.index]) continue;
      mtProgressEpoch++;
      const updated = { ...record, srcCues: record.srcCues.map((cue, i) => i === p.index
        ? { ...cue, text: NS.mtUtils.plainText(p.text), translationStatus: 'translated' } : cue) };
      ep.addCustomSource(updated);
      if (ep.activeSource() === record.id && overlayActive) {
        ep.setOriginalCues(applyCustomSync(updated)); renderer.invalidate(); onTimeUpdate();
      }
    }
  });
  async function openWorkProfile() {
    const ep = currentEp();
    const notify = text => {
      try { UI.showToast({ host: toastHost(), text, duration: 6000, zIndex: 2147483647 }); }
      catch (_) { log.warn(text); }
    };
    if (!ep || ep.disposed) { notify('播放页尚未就绪，请稍后再打开作品资料。'); return; }
    if (_openingWork) { notify('作品资料正在打开或补载字幕，请查看新标签页。'); return; }
    _openingWork = true;
    try {
      notify('正在打开作品资料…');
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      let source = '';
      try { source = pickMtSourceLocale(ep, getMtTarget()); } catch (_) {}
      const customs = (ep.listCustomSources?.() || []).slice().reverse();
      const active = customs.find(r => r.id === ep.activeSource());
      const cached = source ? [active, ...customs].find(r => r?.kind === 'mt' &&
        r.mtSource === source && r.srcCues?.length && r.srcCues.every(c => typeof c.srcText === 'string')) : null;
      const cues = source && ep.activeSource() === source ? ep.originalCues || [] : cached?.srcCues || [];
      const capture = values => {
        const samples = values.slice(0, 80).map(c => String(c.srcText ?? c.text ?? '').slice(0, 500));
        let remaining = 100000;
        const corpus = [];
        for (const cue of values.slice(0, 6000)) {
          const text = String(cue.srcText ?? cue.text ?? '').slice(0, Math.min(2000, remaining));
          if (text) { corpus.push(text); remaining -= text.length; }
          if (!remaining) break;
        }
        return { samples, corpus };
      };
      const loading = !!source && !cues.length;
      const result = await rpc('work-open', { guid: ep.guid, ...capture(cues), loading }, 10000);
      if (!result?.ok) throw new Error(result?.error || 'BACKGROUND_UNAVAILABLE');
      if (loading && result.snapshot) {
        let fetched;
        try { fetched = await NS.mtUtils.withTimeout(fetchCuesForLocale(ep, source), 20000, 'SUBTITLE_FETCH_TIMEOUT'); }
        catch (_) { /* The editor is already open; failed acquisition must not block manual work. */ }
        if (ep.disposed || currentEp() !== ep) return;
        const updated = await rpc('work-update', { guid: ep.guid, snapshot: result.snapshot, ...capture(fetched?.cues || []) }, 5000);
        if (!updated?.ok) notify('资料页已打开，但字幕补载失败，请从播放页重新打开。');
      }
    } catch (e) {
      const code = /^[A-Z][A-Z0-9_]*$/.test(e?.message || '') ? e.message : 'BACKGROUND_UNAVAILABLE';
      log.warn(`Work editor open failed: ${code}`);
      notify(code === 'WORK_OPEN_FAILED' ? '无法创建作品资料标签页，请稍后重试。' :
        '扩展连接不可用，请刷新当前播放页后重试。');
    } finally { _openingWork = false; }
  }

  // Export only captured text. Never refetch and pair a changed source by index.
  const EXPORT_PANEL_ID = 'cr-bsub-export-panel';
  let _exportCleanup = null;
  function closeExportPanel() {
    _exportCleanup?.();
    _exportCleanup = null;
  }
  function exportSnapshot() {
    const ep = currentEp();
    if (!ep || ep.disposed) return null;
    let record = currentCustomSource();
    let cues;
    if (record) cues = applyCustomSync(record);
    else {
      const locale = ep.activeSource() || 'ja-JP';
      record = { kind: 'native', lang: locale, label: LOCALE_LABELS[locale] || locale };
      cues = ep.remasteredCues ?? ep.originalCues;
    }
    if (!cues?.length) return null;
    const offset = priOffset();
    return NS.subtitleExport.snapshot(record, cues.map(c => ({
      ...c, start: Math.max(0, c.start - offset), end: Math.max(0, c.end - offset),
    })), { episodeId: ep.guid, title: document.title, url: location.origin + location.pathname, offset });
  }
  function openExportPanel() {
    closeExportPanel();
    const data = exportSnapshot();
    if (!data) { showErrorToast('没有可导出的字幕，请先选择并加载字幕轨道。'); return; }
    const panel = document.createElement('div');
    panel.id = EXPORT_PANEL_ID;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'cr-bsub-export-title');
    Object.assign(panel.style, panelStyle({
      position: 'fixed', zIndex: '2147483647', boxSizing: 'border-box',
      width: '360px', maxWidth: 'calc(100vw - 24px)', maxHeight: 'calc(100vh - 24px)',
      overflowY: 'auto', padding: '16px', left: '50%', top: '50%',
      transform: 'translate(-50%, -50%)', fontSize: '13px', lineHeight: '1.5',
      overflowWrap: 'anywhere', letterSpacing: '0',
    }));
    const { counts } = data;
    const summary = () => [
      t('共 {count} 条', { count: counts.total }),
      data.target_language ? t('已译 {count} 条', { count: counts.translated }) : t('原文轨道'),
      counts.pending ? t('未译 {count} 条', { count: counts.pending }) : '',
      counts.unknown ? t('旧记录状态未知 {count} 条', { count: counts.unknown }) : '',
      counts.missing_source ? t('原文缺失 {count} 条', { count: counts.missing_source }) : '',
    ].filter(Boolean).join(' · ');
    panel.innerHTML =
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">' +
        '<strong id="cr-bsub-export-title" style="flex:1;font-size:15px">导出字幕</strong>' +
        '<span data-close></span></div>' +
      `<div data-i18n-ignore>${escapeHtml(data.track_label)}</div>` +
      `<div style="color:${THEME.textDim};margin:4px 0">${escapeHtml(data.source_language || t('未知语言'))}` +
        `${data.target_language ? ' → ' + escapeHtml(data.target_language) : ''}</div>` +
      '<div data-summary style="margin-bottom:14px"></div>' +
      '<label for="cr-bsub-export-format">文件格式</label>' +
      '<select id="cr-bsub-export-format" style="display:block;width:100%;min-width:0;box-sizing:border-box;' +
        'margin:6px 0 16px;padding:8px;background:#202022;color:#eee;border:1px solid #666;border-radius:4px;font:inherit"></select>' +
      '<div data-actions style="display:flex;justify-content:flex-end"></div>';
    panel._i18nRefresh = () => { panel.querySelector('[data-summary]').textContent = summary(); };
    panel._i18nRefresh();
    const select = panel.querySelector('select');
    const formats = [
      ['csv', '校对表格 CSV'],
      ['json', '完整记录 JSON'],
      ['bilingual', '双语 SRT（未译处保留原文）'],
      ['source', '原文 SRT'],
      ['target', '译文 SRT（仅已译条目）'],
    ];
    for (const [value, label] of formats) {
      const option = document.createElement('option');
      option.value = value; uiText(option, label);
      option.disabled = (value === 'source' && !data.rows.some(r => r.source_text)) ||
        (value === 'target' && !counts.translated) ||
        (value === 'bilingual' && !data.target_language);
      select.appendChild(option);
    }
    const close = syncBtn('×');
    NS.playerI18n?.attr(close, 'aria-label', '关闭导出');
    NS.playerI18n?.attr(close, 'title', '关闭导出');
    close.style.width = '30px'; close.style.height = '30px';
    close.addEventListener('click', closeExportPanel);
    panel.querySelector('[data-close]').appendChild(close);
    const download = syncBtn('下载', true);
    download.style.minHeight = '34px';
    panel.querySelector('[data-actions]').appendChild(download);
    download.addEventListener('click', () => {
      try {
        const file = NS.subtitleExport.serialize(data, select.value);
        if (!file.text) { showErrorToast('没有符合条件的字幕。'); return; }
        const url = URL.createObjectURL(new Blob([file.text], { type: file.type }));
        const a = document.createElement('a');
        a.href = url; a.download = NS.subtitleExport.filename(data, file.suffix);
        panel.appendChild(a);
        try { a.click(); } finally { a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000); }
      } catch (error) {
        log.warn('Export failed:', error);
        showErrorToast('字幕导出失败，请重试。');
      }
    });
    NS.i18n?.localize(panel.querySelector('#cr-bsub-export-title'));
    NS.i18n?.localize(panel.querySelector('label'));
    const mount = () => (document.fullscreenElement || document.body).appendChild(panel);
    const outside = e => { if (!panel.contains(e.target)) closeExportPanel(); };
    const keydown = e => {
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopImmediatePropagation(); closeExportPanel();
      } else if (e.key === 'Tab') {
        const controls = [close, select, download];
        const i = controls.indexOf(document.activeElement);
        e.preventDefault(); e.stopImmediatePropagation();
        controls[(i + (e.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
      }
    };
    _exportCleanup = () => {
      panel.remove();
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('fullscreenchange', mount);
      document.getElementById('cr-bsub-menu-btn')?.focus();
    };
    mount();
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('fullscreenchange', mount);
    select.focus();
  }

  // ── Two-point manual sync panel ───────────────────────────────────────────
  // For cross-language uploads (the common JP-fill case), text-anchoring can't
  // bridge languages, so the user aligns by hand: seek to where the first line
  // should appear and mark it, then the last line.  Two (rawTime → videoTime)
  // pairs define a linear map (scale + offset) that corrects both a constant
  // offset and a framerate/runtime stretch.  A ±0.1 s nudge fine-tunes after.
  const SYNC_PANEL_ID = 'cr-bsub-sync-panel';
  let _syncEscHandler = null;

  function closeSyncPanel() {
    document.getElementById(SYNC_PANEL_ID)?.remove();
    if (_syncEscHandler) { document.removeEventListener('keydown', _syncEscHandler); _syncEscHandler = null; }
  }

  function syncBtn(label, accent) {
    const b = document.createElement('button');
    uiText(b, label);
    Object.assign(b.style, {
      background: accent ? THEME.accent : 'transparent',
      color:      accent ? THEME.accentText : THEME.text,
      border:     `1px solid ${accent ? THEME.accent : THEME.panelEdge}`,
      borderRadius: '5px', padding: '4px 9px', fontSize: '12px',
      fontFamily: THEME.font, cursor: 'pointer', flexShrink: '0',
    });
    return b;
  }

  function openSyncPanel(id) {
    const ep = currentEp();
    if (!ep || !videoEl) return;
    const record = ep.getCustomSource(id);
    if (!record || !record.srcCues.length) return;
    closeSyncPanel();

    const src      = record.srcCues;
    const firstRaw = src[0].start;
    const lastRaw  = src[src.length - 1].start;

    // Seed marks from any existing linear sync so reopening reflects current state.
    let markA = null, markB = null;
    if (record.sync?.mode === 'linear' && isFinite(record.sync.scale)) {
      markA = firstRaw * record.sync.scale + record.sync.offset;
      markB = lastRaw  * record.sync.scale + record.sync.offset;
    }

    const fmtT    = t => t == null ? '—' : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
    const preview = s => { const t = (s || '').replace(/\s+/g, ' ').trim(); return t.length > 34 ? t.slice(0, 34) + '…' : t; };

    function reapply() {
      if (ep.activeSource() === record.id && overlayActive) {
        ep.setOriginalCues(applyCustomSync(ep.getCustomSource(record.id)));
        renderer.invalidate();
        onTimeUpdate();
      }
    }
    function applyLinear(scale, offset) {
      ep.setCustomSourceSync(record.id, { mode: 'linear', scale, offset });
      persistExternalSync();
      reapply();
    }
    function persistExternalSync() {
      if (record.kind !== 'external') return;
      rpc('external-sync', { guid: ep.guid, id: record.id, sync: ep.getCustomSource(record.id)?.sync })
        .then(res => { if (!res.ok) showErrorToast('当前同步已调整，但未能保存；请重新载入外部字幕页。'); });
    }
    function recompute() {
      const sync = computeLinearSync(markA, markB, firstRaw, lastRaw);
      if (sync) applyLinear(sync.scale, sync.offset);
      refresh();
    }
    function nudge(delta) {
      const cur    = ep.getCustomSource(record.id)?.sync;
      const scale  = cur?.mode === 'linear' && isFinite(cur.scale) ? cur.scale : 1;
      const offset = (cur?.mode === 'linear' ? cur.offset : 0) + delta;
      applyLinear(scale, offset);
      markA = firstRaw * scale + offset;
      markB = lastRaw  * scale + offset;
      refresh();
    }
    function reset() {
      ep.setCustomSourceSync(record.id, { mode: 'none' });
      persistExternalSync();
      markA = markB = null;
      reapply();
      refresh();
    }

    const panel = document.createElement('div');
    panel.id = SYNC_PANEL_ID;
    Object.assign(panel.style, panelStyle({
      position: 'absolute', zIndex: '2147483646', padding: '12px 14px', width: '320px',
      maxWidth: 'calc(100% - 16px)', maxHeight: '80vh', overflowY: 'auto', overflowWrap: 'anywhere',
    }));
    panel.innerHTML =
      `<div style="font-size:13px;font-weight:700;color:${THEME.accent};margin-bottom:2px;">Adjust sync</div>` +
      `<div style="font-size:11px;color:#9aa;line-height:1.4;margin-bottom:10px;">` +
        `Seek the video to where each line should appear, then mark it. Two points correct both offset and speed.</div>` +
      `<div style="font-size:11px;color:#888;margin:4px 0 2px;">First line<span data-i18n-ignore style="color:#bbb;"> · "${escapeHtml(preview(src[0].text))}"</span></div>` +
      `<div data-row="a" style="display:flex;align-items:center;gap:8px;margin-bottom:8px;"></div>` +
      `<div style="font-size:11px;color:#888;margin:4px 0 2px;">Last line<span data-i18n-ignore style="color:#bbb;"> · "${escapeHtml(preview(src[src.length - 1].text))}"</span></div>` +
      `<div data-row="b" style="display:flex;align-items:center;gap:8px;margin-bottom:10px;"></div>` +
      `<div data-row="nudge" style="display:flex;align-items:center;gap:8px;margin-bottom:10px;"></div>` +
      `<div data-row="foot" style="display:flex;align-items:center;gap:8px;justify-content:flex-end;"></div>`;

    const setA   = syncBtn('Mark now');
    const setB   = syncBtn('Mark now');
    const lblA   = document.createElement('span'); lblA.style.cssText = 'font-size:12px;color:#9ecbff;min-width:42px;';
    const lblB   = document.createElement('span'); lblB.style.cssText = 'font-size:12px;color:#9ecbff;min-width:42px;';
    const minus  = syncBtn('−0.1s');
    const plus   = syncBtn('+0.1s');
    const shiftL = document.createElement('span'); shiftL.style.cssText = 'font-size:11px;color:#888;';
    const resetB = syncBtn('Reset');
    const doneB  = syncBtn('Done', true);

    panel.querySelector('[data-row="a"]').append(setA, lblA);
    for (const row of panel.querySelectorAll('[data-row]')) row.style.flexWrap = 'wrap';
    panel.querySelector('[data-row="b"]').append(setB, lblB);
    panel.querySelector('[data-row="nudge"]').append(shiftL, minus, plus);
    panel.querySelector('[data-row="foot"]').append(resetB, doneB);
    NS.i18n?.localize(panel);

    function refresh() {
      lblA.textContent = fmtT(markA);
      lblB.textContent = fmtT(markB);
      const cur = ep.getCustomSource(record.id)?.sync;
      shiftL.textContent = cur?.mode === 'linear'
        ? t('shift {offset}s · {scale}×', { offset: `${cur.offset >= 0 ? '+' : ''}${cur.offset.toFixed(1)}`, scale: cur.scale.toFixed(3) })
        : t('no sync applied');
    }

    setA.addEventListener('click',  () => { markA = videoEl.currentTime; recompute(); });
    setB.addEventListener('click',  () => { markB = videoEl.currentTime; recompute(); });
    minus.addEventListener('click', () => nudge(-0.1));
    plus.addEventListener('click',  () => nudge(+0.1));
    resetB.addEventListener('click', reset);
    doneB.addEventListener('click', closeSyncPanel);
    refresh();
    panel._i18nRefresh = refresh;

    const mountTarget = document.fullscreenElement ?? videoEl.parentElement ?? document.body;
    if (mountTarget !== document.body && window.getComputedStyle(mountTarget).position === 'static') {
      mountTarget.style.position = 'relative';
    }
    mountTarget.appendChild(panel);
    panel.style.left = '50%';
    panel.style.bottom = '14%';
    panel.style.transform = 'translateX(-50%)';

    _syncEscHandler = (e) => { if (e.key === 'Escape') closeSyncPanel(); };
    setTimeout(() => document.addEventListener('keydown', _syncEscHandler), 0);
  }

  // ── Per-track timing panel (⏱ Adjust timing) ──────────────────────────────
  // Nudge the primary and/or secondary band independently — the fix for two
  // tracks that drift relative to each other (e.g. a remastered JP-source
  // primary vs a natively-timed CC secondary), which the single global offset
  // can't separate.  Edits the per-episode _timing deltas live.
  const TIMING_PANEL_ID = 'cr-bsub-timing-panel';
  let _timingEscHandler = null;
  function closeTimingPanel() {
    document.getElementById(TIMING_PANEL_ID)?.remove();
    if (_timingEscHandler) { document.removeEventListener('keydown', _timingEscHandler); _timingEscHandler = null; }
  }
  function openTimingPanel() {
    const ep = currentEp();
    if (!ep || !videoEl || !overlayActive) return;
    syncTimingForEp(ep);
    closeTimingPanel();

    let target = 'pri';                         // 'pri' | 'sec' | 'both'
    const hasSecondary = () => ep.secondaryCues.length > 0;
    if (!hasSecondary() && target === 'sec') target = 'pri';
    const clamp = (v) => Math.max(-30, Math.min(30, Math.round(v * 10) / 10));
    const fmt   = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}s`;

    function apply() {
      saveTimingDeltas();
      if (overlayActive) { renderer.invalidate(); onTimeUpdate(); }
      refresh();
    }
    function nudge(step) {
      if (target === 'pri' || target === 'both') _timing.pri = clamp(_timing.pri + step);
      if (target === 'sec' || target === 'both') _timing.sec = clamp(_timing.sec + step);
      apply();
    }
    function reset() {
      if (target === 'pri' || target === 'both') _timing.pri = 0;
      if (target === 'sec' || target === 'both') _timing.sec = 0;
      apply();
    }

    const panel = document.createElement('div');
    panel.id = TIMING_PANEL_ID;
    Object.assign(panel.style, panelStyle({
      position: 'absolute', zIndex: '2147483646', padding: '12px 14px', width: '300px',
      maxWidth: 'calc(100% - 16px)', maxHeight: '80vh', overflowY: 'auto', overflowWrap: 'anywhere',
    }));
    panel.innerHTML =
      `<div style="font-size:13px;font-weight:700;color:${THEME.accent};margin-bottom:2px;">Adjust timing</div>` +
      `<div style="font-size:11px;color:#9aa;line-height:1.4;margin-bottom:10px;">` +
        `Nudge a subtitle earlier or later to match the audio. Negative = show sooner.</div>` +
      `<div data-row="target" style="display:flex;gap:6px;margin-bottom:10px;"></div>` +
      `<div data-row="read" style="font-size:12px;color:#9ecbff;margin-bottom:8px;"></div>` +
      `<div data-row="nudge" style="display:flex;align-items:center;gap:8px;margin-bottom:10px;"></div>` +
      `<div data-row="foot" style="display:flex;align-items:center;gap:8px;justify-content:flex-end;"></div>`;

    const tgtPri  = syncBtn('Sub 1');
    const tgtSec  = syncBtn('Sub 2');
    const tgtBoth = syncBtn('Both');
    const readout = document.createElement('span');
    const minus   = syncBtn('−0.1s');
    const plus    = syncBtn('+0.1s');
    const hint    = document.createElement('span'); uiText(hint, 'hold ⇧ for 0.5s');
    hint.style.cssText = 'font-size:10px;color:#888;margin-left:auto;';
    const resetB  = syncBtn('Reset');
    const doneB   = syncBtn('Done', true);

    panel.querySelector('[data-row="target"]').append(tgtPri, tgtSec, tgtBoth);
    for (const row of panel.querySelectorAll('[data-row]')) row.style.flexWrap = 'wrap';
    panel.querySelector('[data-row="read"]').append(readout);
    panel.querySelector('[data-row="nudge"]').append(minus, plus, hint);
    panel.querySelector('[data-row="foot"]').append(resetB, doneB);
    NS.i18n?.localize(panel);

    function styleTargetBtn(btn, on, enabled) {
      btn.disabled = !enabled;
      btn.style.opacity = enabled ? '1' : '0.4';
      btn.style.cursor  = enabled ? 'pointer' : 'default';
      btn.style.background = on ? THEME.accent : 'transparent';
      btn.style.color      = on ? THEME.accentText : THEME.text;
      btn.style.borderColor = on ? THEME.accent : THEME.panelEdge;
    }
    function refresh() {
      const sec = hasSecondary();
      styleTargetBtn(tgtPri,  target === 'pri',  true);
      styleTargetBtn(tgtSec,  target === 'sec',  sec);
      styleTargetBtn(tgtBoth, target === 'both', sec);
      readout.innerHTML = sec
        ? `${escapeHtml(t('Sub 1'))} <b style="color:#fff;">${fmt(_timing.pri)}</b> &nbsp;·&nbsp; ${escapeHtml(t('Sub 2'))} <b style="color:#fff;">${fmt(_timing.sec)}</b>`
        : `${escapeHtml(t('Sub 1'))} <b style="color:#fff;">${fmt(_timing.pri)}</b>`;
    }

    const pick = (t) => () => { target = t; refresh(); };
    tgtPri.addEventListener('click',  pick('pri'));
    tgtSec.addEventListener('click',  () => { if (hasSecondary()) { target = 'sec'; refresh(); } });
    tgtBoth.addEventListener('click', () => { if (hasSecondary()) { target = 'both'; refresh(); } });
    minus.addEventListener('click', (e) => nudge(e.shiftKey ? -0.5 : -0.1));
    plus.addEventListener('click',  (e) => nudge(e.shiftKey ? +0.5 : +0.1));
    resetB.addEventListener('click', reset);
    doneB.addEventListener('click', closeTimingPanel);
    refresh();
    panel._i18nRefresh = refresh;

    const mountTarget = document.fullscreenElement ?? videoEl.parentElement ?? document.body;
    if (mountTarget !== document.body && window.getComputedStyle(mountTarget).position === 'static') {
      mountTarget.style.position = 'relative';
    }
    mountTarget.appendChild(panel);
    panel.style.left = '50%';
    panel.style.bottom = '14%';
    panel.style.transform = 'translateX(-50%)';

    _timingEscHandler = (e) => { if (e.key === 'Escape') closeTimingPanel(); };
    setTimeout(() => document.addEventListener('keydown', _timingEscHandler), 0);
  }

  NS.i18n?.watch(() => {
    for (const id of [SYNC_PANEL_ID, TIMING_PANEL_ID, TRANSLATE_PANEL_ID, TUNE_PANEL_ID]) {
      const panel = document.getElementById(id);
      if (panel) { NS.i18n.localize(panel); panel._i18nRefresh?.(); }
    }
    const exportPanel = document.getElementById('cr-bsub-export-panel');
    if (exportPanel) {
      NS.i18n.localize(exportPanel.querySelector('#cr-bsub-export-title'));
      NS.i18n.localize(exportPanel.querySelector('label'));
      exportPanel._i18nRefresh?.();
    }
    const button = document.getElementById('cr-jp-cc-btn');
    if (button) applyButtonState(button, button.dataset.state || 'idle');
  });

  // ── Machine translation (BYOK) ────────────────────────────────────────────
  // The MAIN world can't reach the service worker, so translation rides a
  // token-guarded RPC over postMessage: interceptor → content.js → SW → DeepL.
  // The user's key never enters this world; the SW attaches it.  A
  // translated track becomes a kind:'mt' custom source — its timing comes from
  // the source CR track (already on the current cut), so no sync is needed, and
  // persisting it via the registry means re-selecting later costs no quota.
  let _rpcSeq = 0;
  const _rpcPending = new Map();
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.type !== PROTOCOL.POST.RPC_RES) return;
    const finish = _rpcPending.get(d.id);
    if (finish) { if (!d.streamItem && !d.streamIssue) _rpcPending.delete(d.id); finish(d); }
  });
  function rpc(method, payload, timeoutMs = 30000) {
    if (method === 'external-active' || method === 'external-forget') externalChoiceRevision++;
    return new Promise((resolve) => {
      const id = ++_rpcSeq;
      let done = false;
      const finish = (d) => { if (done) return; done = true; clearTimeout(timer); resolve(d); };
      const timer = setTimeout(() => { _rpcPending.delete(id); finish({ ok: false, error: 'timeout' }); }, timeoutMs);
      _rpcPending.set(id, finish);
      window.postMessage({ type: PROTOCOL.POST.RPC_REQ, id, method, payload, token: TOGGLE_TOKEN }, window.location.origin);
    });
  }
  function rpcStream(payload, onItem, stopReason, timeoutMs, onIssue = () => {}) {
    return new Promise(resolve => {
      const id = ++_rpcSeq;
      let done = false, stopping = false, stopAt = 0, localError = null;
      const started = Date.now();
      let last = started;
      const post = (method, data) => window.postMessage({
        type: PROTOCOL.POST.RPC_REQ, id, method, payload: data, token: TOGGLE_TOKEN,
      }, window.location.origin);
      const finish = result => {
        if (done) return;
        done = true; clearInterval(timer); _rpcPending.delete(id);
        resolve(localError ? { ok: false, error: localError } : result);
      };
      const stop = reason => {
        if (stopping) return;
        stopping = true; stopAt = Date.now(); localError = reason;
        post('stream-stop', { reason });
      };
      const timer = setInterval(() => {
        try {
          const reason = stopReason();
          if (reason) stop(reason);
          // The worker owns token-idle timeouts; this bounds a broken bridge too.
          if (Date.now() - started > 16 * 60 * 1000 || Date.now() - last > Math.max(180000, timeoutMs + 30000)) {
            stop('STREAM_DISCONNECTED');
          }
        } catch (e) { stop(e.message); }
        if (stopping && Date.now() - stopAt > 10000) finish({ ok: false, error: localError });
      }, 250);
      _rpcPending.set(id, message => {
        last = Date.now();
        if (message.streamIssue) {
          try { onIssue(message); } catch (e) { stop(e.message); }
        } else if (message.streamItem) {
          try { onItem(message.index, message.text); } catch (e) { stop(e.message); }
        } else finish(message);
      });
      post('stream', payload);
    });
  }

  function mtErrorText(code) {
    const relayErrors = {
      STREAM_NOT_SUPPORTED: 'The provider did not return an SSE stream. Check the protocol or select batch mode. No automatic resend.',
      STREAM_INVALID_JSONL: 'The model returned an invalid streaming subtitle record. Saved subtitles are retained; retry requests only missing items.',
      STREAM_FIRST_TIMEOUT: 'No translated text arrived within the timeout. The provider may have charged for this request.',
      STREAM_IDLE_TIMEOUT: 'The stream stopped producing text. Complete subtitles are saved; retry only missing items.',
      STREAM_TOTAL_TIMEOUT: 'The stream reached the 15-minute safety limit. Complete subtitles are saved.',
      STREAM_DISCONNECTED: 'Streaming connection closed. Complete subtitles are saved; retry only missing items.',
      STREAM_PROVIDER_ERROR: 'The provider reported a streaming error. Complete subtitles are saved.',
      STREAM_INPUT_TOO_LARGE: 'This stream exceeds 6,000 items or 100,000 characters. Select batch mode.',
      STREAM_ITEMS_PENDING: 'The stream finished with invalid subtitle items. Other valid subtitles are saved. Retry requests only missing items; additional charges may apply.',
      WORK_CHANGED: 'The confirmed work profile changed. Saved translations are retained. Start a new translation explicitly to use the new profile.',
      REVIEW_CONTEXT_CHANGED: 'Saved request reference does not match this translation. No new provider request was sent.',
      INVALID_REVIEW_INPUT: 'Subtitle request metadata is invalid. Reload the extension and refresh the playback page.',
      REVIEW_SAVE_FAILED: 'Could not save the local request record. No new provider request was sent. Existing translations are retained.',
      REVIEW_TOO_LARGE: 'The local request record exceeds its size limit. No new provider request was sent.',
      SENDER_NOT_ALLOWED: 'The extension blocked this playback page. Reload the extension and refresh this page; this is not an API key error.',
      NO_EPISODE: 'No active episode. Refresh this playback page and retry.',
      SOURCE_TRACK_UNAVAILABLE: 'No usable source subtitle track. Choose an available source in Translation settings.',
      SOURCE_SUBTITLES_UNAVAILABLE: 'Could not read the source subtitles. Select a working source track and retry.',
      SUBTITLE_FETCH_TIMEOUT: 'Loading source subtitles timed out. Refresh the playback page and retry.',
      CLIENT_ERROR: 'The subtitle translation script failed. Reload the extension and refresh this playback page.',
      RESUME_CONTEXT_CHANGED: 'The episode or translation configuration changed. Resume was stopped to avoid retranslating from scratch.',
      CACHE_UNAVAILABLE: 'Could not read saved translation progress. No new translation requests were sent.',
      CACHE_SAVE_FAILED: 'Translation is retained in this page but extension storage failed. Do not refresh.',
      CONFIG_CHANGED: 'Translation settings changed. Start translation again.',
      KEY_REQUIRED: 'Add an API key in Translation settings.',
      HOST_PERMISSION_REQUIRED: 'Save and authorize the provider in Translation settings.',
      TRANSLATION_DISABLED: 'Machine translation is disabled.',
      BUDGET_EXCEEDED: 'Hourly safety limit reached for this tab (100,000 characters / 200 requests).',
      INVALID_BATCH: 'Subtitle batch exceeds the configured limits.',
      SUBTITLE_TOO_LONG: 'A subtitle exceeds the batch character limit. Increase it in Translation settings.',
      ID_MISMATCH: 'The model omitted or duplicated subtitle IDs. Try a smaller batch.',
      ITEM_COUNT_MISMATCH: 'The model returned the wrong number of subtitles.',
      DUPLICATE_ITEM_ID: 'The model returned a duplicate subtitle ID.',
      INVALID_ITEM_ID: 'The model returned an invalid subtitle ID.',
      INVALID_ITEM_TEXT: 'The model returned an empty or invalid subtitle translation.',
      INVALID_RESPONSE: 'The provider returned an incompatible response. Check protocol and model.',
      INCOMPLETE_RESPONSE: 'The model response was incomplete. Try a smaller batch.',
      TIMEOUT_UNKNOWN: 'Request timed out; it may have been billed. Retry manually when ready.',
      NETWORK_UNKNOWN: 'Connection failed; the request may have been billed. Retry manually when ready.',
      timeout: 'The reply was not received; the request may have been billed. Retry manually when ready.',
    };
    if (relayErrors[code]) return t(relayErrors[code]);
    if (/^HTTP_5\d\d$/.test(code || '')) return t('Upstream service failed; the request may have been billed. Retry manually when ready.');
    if (code === 'no-key')         return t('Add a translation API key in the extension popup.');
    if (code === 'timeout')        return t('Translation timed out — check your connection and try again.');
    if (/403|401/.test(code || '')) return t('Translation rejected — check your API key.');
    if (/429/.test(code || '')) {
      return /per day|\bday\b/i.test(code)
        ? t('Daily free quota reached — resets ~midnight Pacific. Switch to DeepL or try tomorrow.')
        : t('Rate limited — wait a minute and retry (free tiers are strict).');
    }
    if (/456/.test(code || ''))     return t('Translation quota reached for your key.');
    return t('Translation failed — see the popup to check your key.');
  }

  // Choose the best CR track to translate FROM: the user's pref, else English,
  // else the active dub, else JP, else anything — never the target itself.
  function pickMtSourceLocale(ep, target) {
    const usable = (loc) => loc && (loc === 'ja-JP' ? 'en-US' : loc) !== target && localeHasContent(loc) !== false;
    const pref = getMtSourcePref();
    if (usable(pref)) return pref;
    for (const loc of ['en-US', 'en-GB', ep.catalog.currentAudio(), 'ja-JP']) {
      if (usable(loc)) return loc;
    }
    for (const v of ep.catalog.versions()) if (usable(v.locale)) return v.locale;
    return null;
  }

  // Resolve a CR locale to render-ready cues, lazily fetching its session/URL the
  // same way the activation path does.
  async function fetchCuesForLocale(ep, locale) {
    // Resolve the signed subtitle URL.  forceFresh evicts the cached URL first —
    // same evict + refetch the activation path (loadSubtitleCues) uses — so a
    // stale (expired-signature) URL can be replaced with a freshly-signed one.
    const resolveUrl = async (forceFresh) => {
      if (locale === 'ja-JP') {
        // Evict under the SAME guid the fetch below will use — in the
        // dub-switch-carry state jpGuid is unset and only the persisted guid
        // map knows it; evicting only ep.jpGuid would leave the stale cached
        // URL in place and the refetch would cache-hit right back to it.
        const g = ep.jpGuid ?? ep.getMappedJpGuid?.();
        if (forceFresh) { if (g) ep.evictCachedJpData(g); ep.clearJpUrls(); }
        let url = forceFresh ? null : (ep.jpCaptionUrl || ep.jpSubtitleUrl);
        if (!url) {
          if (g && ep.authHeaders) {
            const d = await fetchAndCacheJpData(g, ep.authHeaders);
            url = d?.captionUrl || d?.subtitleUrl || null;
          }
        }
        return url;
      }
      const v = ep.catalog.versions().find(v => v.locale === locale);
      if (forceFresh) { ep.catalog.evictUrl(locale); if (v?.guid) ep.evictCachedSrcUrl(v.guid, locale); }
      let url = forceFresh ? null : getSubtitleUrl(locale);
      if (!url && v?.guid) {
        const r = await fetchSubUrlForSource(v.guid, locale, ep.authHeaders);
        url = r.url ?? getSubtitleUrl(locale);
      }
      return url;
    };

    let url = await resolveUrl(false);
    if (!url) return null;
    // Fetch the raw .ass directly and keep its text in-memory.  We can't read it
    // back from getCachedRawText: the sessionStorage raw-text cache is best-effort
    // and gets evicted when full (CR fills it with 100+ files), so the cached copy
    // is often null — which left the secondary SIGN layer empty (sec=0) even
    // though the cues parsed fine.  Used by the secondary sign layer + MT signs.
    let text = ep.getCachedRawText(url);
    if (!text) {
      let resp = await originalFetch(url).catch(() => null);
      if (!resp || !resp.ok) {
        // Cached URL's signature likely expired (CDN 403/410).  Evict, refetch a
        // fresh URL, and retry once — otherwise the stale URL stays cached and the
        // dual-sub/MT-source track never recovers until its TTL lapses.
        const fresh = await resolveUrl(true);
        if (!fresh || fresh === url) return null;
        url  = fresh;
        resp = await originalFetch(url).catch(() => null);
        if (!resp || !resp.ok) return null;
      }
      text = await resp.text();
      ep.setCachedRawText(url, text);  // best-effort; we keep `text` regardless
    }
    const cues = parseSubtitles(text, url);
    return cues.length ? { cues, rawText: text, url } : null;
  }

  // Partial-progress cache: every batch's translations are persisted keyed by
  // (guid, source, target, provider), so a transient rate-limit, a cancel, or a
  // tab close never re-spends quota on cues already done — a re-run RESUMES from
  // where it stopped.  This is what makes translation a reliable "click once and
  // it converges" operation instead of an all-or-nothing gamble.
  const MT_PARTIAL_TTL = 24 * 60 * 60 * 1000;
  let mtProgressEpoch = 0;
  const mtPartialKey = (guid, source, target, provider, tag, hash) =>
    `crSubFix_mtpart_${guid}_relay1_${source}_${target}_${provider}_${tag}_${hash}`;
  function clearMtPartials(guid) {
    mtProgressEpoch++;
    try {
      const pfx = `crSubFix_mtpart_${guid}_`;
      const hits = [];
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(pfx)) hits.push(k); }
      hits.forEach(k => STORAGE.lsDel(k));
    } catch (_) {}
  }

  let _translating     = false;
  let _translateCancel = false;
  let _translatePause = false;
  let translationHud = null;
  document.addEventListener('fullscreenchange', () => translationHud?.reposition());
  function cancelTranslate() { if (_translating) _translateCancel = true; }

  // opts = { target, provider, source } — explicit overrides from the Translate
  // panel; each falls back to the popup-configured default / auto source.
  async function translateToTarget(opts) {
    if (_translating) return;
    _translating = true;
    _translateCancel = false;
    _translatePause = false;
    const hud = translationHud || UI.makeTranslationStatus(toastHost, {
      getAnchor: () => { injectProgressBar(); return document.getElementById(PROGRESS_ID); },
      onPause: () => { _translatePause = true; },
    });
    translationHud = hud;
    hud.start(() => translateToTarget(opts));
    try {
      const retained = opts?.checkpoint?.out.filter(t => typeof t === 'string').length || 0;
      const describe = () => retained ? t('Resuming {count} retained subtitles…', { count: retained }) : t('Loading source subtitles…');
      hud.update(retained, opts?.checkpoint?.out.length || 0, describe(), describe);
      setTranslateProgress(retained, opts?.checkpoint?.out.length || 0);
      log.info('Machine translation requested.');
      await runTranslation(opts, hud);
    } catch (e) {
      const code = /^[A-Z][A-Z0-9_]*$/.test(e?.message || '') ? e.message : 'CLIENT_ERROR';
      // Exceptions before the first request must not vanish with the menu/HUD.
      log.error(`Machine translation stopped: ${code} (${e?.name || 'Error'}).`);
      const describe = () => `${mtErrorText(code)} [${code}]`;
      hud.error(describe(), () => translateToTarget(opts), 'Retry', describe);
    } finally {
      hud.finish({ paused: _translatePause || _translateCancel });
      _translating = false;
      _translateCancel = false;
      _translatePause = false;
      hideTranslateProgress();
    }
  }
  async function runTranslation(opts, hud) {
    const progress = (done, count, describe) => hud.update(done, count, describe(), describe);
    const ep = currentEp();
    if (!ep) throw new Error('NO_EPISODE');
    if (!isMtEnabled() || !isMtConfigured()) {
      throw new Error('TRANSLATION_DISABLED');
    }
    const target   = (opts && opts.target)   || getMtTarget();
    const provider = getMtProvider();
    const configTag = SETTINGS.read(html, 'mtConfigTag');
    const workEnabled = SETTINGS.read(html, 'mtWorkEnabled') === true && provider === 'relay';
    const workResult = workEnabled ? await rpc('work-context', { guid: ep.guid, target }) : { ok: true, token: '' };
    if (!workResult?.ok) throw new Error(workResult?.error || 'WORK_CHANGED');
    const workToken = workResult.token || '';
    const streaming = provider === 'relay' && SETTINGS.read(html, 'mtTranslationMode') === 'episode-stream';
    const checkpoint = opts?.checkpoint;
    if (checkpoint && (checkpoint.ep !== ep || checkpoint.configTag !== configTag ||
        (checkpoint.workToken || '') !== workToken || checkpoint.epoch !== mtProgressEpoch)) {
      throw new Error('RESUME_CONTEXT_CHANGED');
    }
    const tLabel   = mtLangLabel(target);
    const pLabel   = MT_PROVIDER_LABELS[provider] ?? provider;

    const source = (opts && opts.source) || pickMtSourceLocale(ep, target);
    if (!source) throw new Error('SOURCE_TRACK_UNAVAILABLE');
    const sLabel = LOCALE_LABELS[source] ?? source;

    if (!checkpoint) progress(0, 0, () => t('Loading {source} → {target}…', { source: sLabel, target: tLabel }));

    const fetched = checkpoint?.fetched ||
      await NS.mtUtils.withTimeout(fetchCuesForLocale(ep, source), 20000, 'SUBTITLE_FETCH_TIMEOUT');
    if (ep.disposed) { hud.fade(); return; }
    const cues       = fetched && fetched.cues;
    // fetched.rawText comes from the sessionStorage raw cache, which can miss
    // under quota pressure — fall back to the active source's in-memory raw
    // (translating FROM the active source is the common case anyway).
    const baseRawAss = checkpoint ? checkpoint.baseRawAss : (fetched && fetched.rawText) || _signRawAss;
    if (!cues || !cues.length) {
      throw new Error('SOURCE_SUBTITLES_UNAVAILABLE');
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const TUNE  = mtTuning(provider);
    if (opts?.batchSize) TUNE.batch = Math.min(TUNE.batch, opts.batchSize);
    const PACE  = provider === 'relay' ? 0 : TUNE.pace;
    const texts = cues.map(c => c.text);
    // Also translate the base track's typeset signs: extract their text and append
    // it to the batch so it rides the same retry/resume/quota path as dialogue.
    const signsBase = checkpoint ? checkpoint.signsBase : buildSignsAss(baseRawAss);
    const signParse = checkpoint ? checkpoint.signParse : signsBase ? extractSignTexts(signsBase) : null;
    const nDlg = texts.length;                                   // dialogue / signs split point
    if (signParse && signParse.texts.length) texts.push(...signParse.texts);
    const out   = new Array(texts.length);
    const hash = await self.CRSubFix.mtUtils.fingerprint(cues, workToken ? `${signsBase || ''}\nwork:${workToken}` : signsBase);
    const id = mtId(target, provider, configTag, source, hash);
    const stopped = () => {
      if (ep.disposed || _translateCancel) return true;
      if (!isMtEnabled()) throw new Error('TRANSLATION_DISABLED');
      if (SETTINGS.read(html, 'mtConfigTag') !== configTag) throw new Error('CONFIG_CHANGED');
      if ((SETTINGS.read(html, 'mtWorkEnabled') === true && provider === 'relay') !== workEnabled) throw new Error('WORK_CHANGED');
      return false;
    };
    if (stopped()) { hud.fade(); return; }

    // Resume any saved partial progress for this exact (guid,source,target,provider).
    const partKey = mtPartialKey(ep.guid, source, target, provider, configTag, hash);
    const cachePayload = { key: partKey, guid: ep.guid, configTag, total: texts.length, workToken, target };
    const stored = checkpoint && !streaming ? null : await rpc('progress', { ...cachePayload, action: 'get' });
    if ((!checkpoint || streaming) && !stored?.ok) throw new Error(stored?.error === 'WORK_CHANGED' ? 'WORK_CHANGED' : 'CACHE_UNAVAILABLE');
    const completedSource = ep.getCustomSource(id);
    if (completedSource && !completedSource.incomplete) {
      if (Array.isArray(stored?.values)) {
        ep.addCustomSource({ ...completedSource, reviewCacheKey: partKey,
          srcCues: completedSource.srcCues.map((cue, i) => typeof stored.values[i] === 'string'
            ? { ...cue, text: NS.mtUtils.plainText(stored.values[i]) } : cue) });
      }
      hud.fade(); selectSource(id); return;
    }
    const legacy = !checkpoint && !stored.values ? STORAGE.lsGet(partKey) : null;
    const saved = checkpoint?.out || stored?.values || legacy;
    let persisted = checkpoint ? checkpoint.persisted : !legacy;
    let resumed = 0;
    if (Array.isArray(saved) && saved.length === texts.length) {
      for (let i = 0; i < texts.length; i++) if (typeof saved[i] === 'string' && saved[i].trim()) {
        out[i] = self.CRSubFix.mtUtils.plainText(saved[i]); resumed++;
      }
    }
    // A disconnected page may have missed a cue the worker already committed.
    if (streaming && Array.isArray(stored?.values) && stored.values.length === texts.length) {
      stored.values.forEach((text, i) => {
        if (out[i] == null && typeof text === 'string' && text.trim()) {
          out[i] = NS.mtUtils.plainText(text); resumed++;
        }
      });
    }
    const todo = [];
    for (let i = 0; i < texts.length; i++) {
      if (!texts[i].trim()) { out[i] = texts[i]; resumed++; }
      else if (out[i] == null) todo.push(i);
    }
    let batches;
    try {
      if (streaming) batches = todo.length ? [todo.slice()] : [];
      else {
        const time = videoEl?.currentTime || 0;
        todo.sort((a, b) => NS.mtUtils.priority([a], cues, time) - NS.mtUtils.priority([b], cues, time));
        const first = Math.min(15, TUNE.batch);
        batches = [
          ...NS.mtUtils.batches(texts, todo.slice(0, first), first, TUNE.maxChars),
          ...NS.mtUtils.batches(texts, todo.slice(first), TUNE.batch, TUNE.maxChars),
        ];
        batches.forEach(indices => indices.sort((a, b) => a - b));
      }
    } catch (e) { hud.fade(); throw e; }

    log.info(`Translate cfg: provider=${provider} batch=${TUNE.batch} pace=${PACE}ms timeout=${TUNE.timeout}ms ` +
             `rateWait=${TUNE.rateWait}ms retries=${TUNE.retries} cues=${cues.length} signs=${signParse ? signParse.texts.length : 0} resumed=${resumed} todo=${todo.length}`);

    let done = resumed;
    const resume = { ep, configTag, workToken, fetched: { cues: cues.map(c => ({ ...c })), rawText: fetched.rawText },
      baseRawAss, signsBase, signParse, out, persisted, epoch: mtProgressEpoch };
    hud.setResume(() => translateToTarget({ target, provider, source, batchSize: TUNE.batch, checkpoint: resume }));
    const initialSource = ep.activeSource();
    let published = false;
    function publish() {
      if (stopped() || !done) return;
      const previous = ep.getCustomSource(id);
      const record = { ...CUSTOM.makeMtSource({
        id, target, source, label: `${tLabel} (${pLabel})${done < texts.length ? ` [${done}/${texts.length}]` : ''}`,
        srcCues: cues.map((c, k) => ({ ...c, text: out[k] ?? c.text, srcText: c.text,
          translationStatus: out[k] != null ? 'translated' : 'pending' })),
        signRawAss: signParse ? rebuildSignsAss(signParse, signParse.texts.map((text, i) => out[nDlg + i] ?? text)) : signsBase || null,
      }), incomplete: true, reviewCacheKey: partKey, sync: previous?.sync || { mode: 'none' } };
      ep.addCustomSource(record);
      sourceMenu.updateButtonVisibility();
      if (!published && ep.activeSource() === initialSource) selectSource(id);
      else if (ep.activeSource() === id && overlayActive) {
        ep.setOriginalCues(applyCustomSync(record));
        if (record.signRawAss !== previous?.signRawAss) setSignSource(record.signRawAss);
        renderer.invalidate();
        onTimeUpdate();
      }
      published = true;
    }
    function coverageLabel() {
      const until = NS.mtUtils.coverage(cues, out, videoEl?.currentTime || 0);
      return t('Ready through {time}', { time: `${Math.floor(until / 60)}:${String(Math.floor(until % 60)).padStart(2, '0')}` });
    }
    // Persist legacy/page-only results before new paid work, in bounded patches.
    if (!persisted && resumed) {
      const entries = out.flatMap((text, index) => typeof text === 'string' && text.trim() ? [{ index, text }] : []);
      persisted = true;
      for (let i = 0; i < entries.length; i += 50) {
        const res = await rpc('progress', { ...cachePayload, action: 'save', entries: entries.slice(i, i + 50) });
        if (!res?.ok) { persisted = false; break; }
      }
      resume.persisted = persisted;
    }
    publish();
    if (!persisted && resumed) {
      const describe = () => `${mtErrorText('CACHE_SAVE_FAILED')} (${done}/${texts.length} ${t('retained')}) [CACHE_SAVE_FAILED]`;
      hud.error(describe(),
        () => translateToTarget({ target, provider, source, batchSize: TUNE.batch, checkpoint: resume }), 'Retry', describe);
      return;
    }
    const progressLabel = () => streaming ? t('Episode stream; resumed {count}; 1 request', { count: resumed }) :
      t('Resumed {count}; batch <= {batch}; concurrency {concurrency}', { count: resumed, batch: TUNE.batch, concurrency: TUNE.concurrency || 1 });
    progress(done, texts.length, () => `${progressLabel()}; ${coverageLabel()}`);
    setTranslateProgress(done, texts.length);
    const runId = crypto.randomUUID();
    const started = Date.now();
    const metrics = [];
    NS.lastTranslationStats = { startedAt: new Date().toISOString(), batches: metrics, resumed, total: texts.length, batchSize: TUNE.batch };
    let failure, failureDetails, firstCueMs = null;
    try {
      if (streaming && todo.length) {
        const expected = new Set(todo);
        const issues = new Map();
        const issueLabel = () => issues.size ? '; ' + t('{count} invalid item(s) pending retry', { count: issues.size }) : '';
        const result = await rpcStream({
          items: todo.map(i => ({ id: String(i), text: texts[i] })),
          timings: todo.map(i => i < nDlg ? { start: cues[i].start, end: cues[i].end } : null),
          source, target, provider, configTag, workToken, requestId: runId, cache: cachePayload,
        }, (index, text) => {
          if (stopped()) return;
          if (!expected.has(index) || out[index] != null) throw new Error('INVALID_ITEM_ID');
          if (typeof text !== 'string' || !text.trim()) throw new Error('INVALID_ITEM_TEXT');
          out[index] = NS.mtUtils.plainText(text);
          if (firstCueMs === null) firstCueMs = Date.now() - started;
          done++;
          publish();
          setTranslateProgress(done, texts.length);
          progress(done, texts.length, () => `${t('Episode stream')}; ${coverageLabel()}${issueLabel()} (${Math.round((Date.now() - started) / 1000)}s)`);
        }, () => stopped() ? 'STREAM_CANCELLED' : _translatePause ? 'STREAM_PAUSED' : null, TUNE.timeout, issue => {
          if (stopped()) return;
          if (!expected.has(issue.index)) throw new Error('INVALID_ITEM_ID');
          if (issue.resolved) issues.delete(issue.index);
          else issues.set(issue.index, issue.reason);
          progress(done, texts.length, () => `${t('Episode stream')}; ${coverageLabel()}${issueLabel()}`);
        });
        failure = result.ok ? (done < texts.length ? 'INCOMPLETE_RESPONSE' : null) : result.error;
        failureDetails = result.details;
        metrics.push({ batch: 1, attempt: 0, items: todo.length, durationMs: Date.now() - started,
          firstIndex: todo[0], lastIndex: todo.at(-1), error: failure || null, streaming: true,
          details: failureDetails });
        if (failure === 'STREAM_PAUSED') failure = null;
      } else if (!streaming) {
      const result = await NS.mtUtils.runBatches(batches, {
        concurrency: TUNE.concurrency || 1, retries: TUNE.retries, rateWait: TUNE.rateWait,
        priority: indices => NS.mtUtils.priority(indices, cues, videoEl?.currentTime || 0),
        warmStart: !resumed,
        paused: () => _translatePause,
        pace: PACE, stopped, sleep,
        send: (idxs, batchId, attempt) => {
          progress(done, texts.length, () => attempt ? `${t('Retry {attempt} (1 request at a time)', { attempt })}; ${coverageLabel()}` :
            `${t('Translating {source}', { source: sLabel })}; ${coverageLabel()}; ${progressLabel()}`);
          return rpc('translate', { texts: idxs.map(i => texts[i]), source, target, provider, configTag, workToken,
            cache: cachePayload, indices: idxs, timings: idxs.map(i => i < nDlg ? { start: cues[i].start, end: cues[i].end } : null),
            requestId: `${runId}:${batchId}` }, TUNE.timeout);
        },
        accept: async (idxs, translations) => {
          const clean = translations.map(text => NS.mtUtils.plainText(text));
          if (clean.some(text => !text.trim())) throw new Error('INVALID_ITEM_TEXT');
          for (let j = 0; j < idxs.length; j++) out[idxs[j]] = clean[j];
          done += idxs.length;
          publish();
          setTranslateProgress(done, texts.length);
          progress(done, texts.length, () => `${coverageLabel()} (${Math.round((Date.now() - started) / 1000)}s)`);
          const savedBatch = await rpc('progress', { ...cachePayload, action: 'save',
            entries: idxs.map(index => ({ index, text: out[index] })) });
          if (!savedBatch?.ok) {
            persisted = false;
            resume.persisted = false;
            throw new Error('CACHE_SAVE_FAILED');
          }
        },
        report: metric => {
          const indices = batches[metric.batch - 1];
          const row = { ...metric, firstIndex: indices[0], lastIndex: indices.at(-1),
            chars: indices.reduce((n, i) => n + texts[i].length, 0) };
          metrics.push(row);
          log.info(`Translation batch: ${JSON.stringify(row)}`);
          if (NS.mtUtils.retryable(metric.error)) progress(done, texts.length, () => 'Rate limited or busy; reducing to 1 request and waiting…');
        },
      });
      failure = result.error;
      }
    } finally {
      const summary = { elapsedMs: Date.now() - started, requests: metrics.length,
        retries: metrics.filter(m => m.attempt > 0).length, resumed, completed: done, total: texts.length,
        batchSize: TUNE.batch, persisted, mode: streaming ? 'episode-stream' : 'batch', firstCueMs };
      NS.lastTranslationStats = { ...summary, batches: metrics };
      log.info(`Translation summary: ${JSON.stringify(summary)}`);
      if (_translateCancel || ep.disposed) hud.fade();
    }
    if (stopped()) return;
    if (failure) {
      const code = /^[A-Z][A-Z0-9_]*$/.test(failure) || failure === 'timeout' ? failure : 'NETWORK_UNKNOWN';
      const split = !streaming && NS.mtUtils.splittable(code) && TUNE.batch > 1;
      const batchSize = split ? Math.max(1, Math.floor(TUNE.batch / 2)) : TUNE.batch;
      const note = () => split ? ' ' + t('Retry with at most {count} items per batch; additional charges may apply.', { count: batchSize }) : '';
      const retention = () => t(persisted ? 'saved' : 'retained in this page only; do not refresh');
      const counts = metrics.find(m => m.error === code && m.counts)?.counts;
      const reasons = { MISSING_TEXT: 'missing text', NOT_STRING: 'non-text value', EMPTY_TEXT: 'empty text',
        TEXT_TOO_LONG: 'text too long', SANITIZED_EMPTY: 'empty after formatting cleanup' };
      const affected = streaming && Array.isArray(failureDetails?.items) ? failureDetails.items.slice(0, 3)
        .filter(item => Number.isInteger(item?.index) && item.index >= 0 && item.index < texts.length && reasons[item.reason])
        .map(item => item.index < nDlg
          ? t('subtitle #{index} at {time} ({reason})', { index: item.index + 1, time: `${Math.floor(cues[item.index].start / 60)}:${String(Math.floor(cues[item.index].start % 60)).padStart(2, '0')}`, reason: t(reasons[item.reason]) })
          : t('sign #{index} ({reason})', { index: item.index - nDlg + 1, reason: t(reasons[item.reason]) })) : [];
      const detail = (counts ? ' ' + t('Expected {expected}, received {received}.', counts) : '') +
        (affected.length ? ' ' + t('Pending: {items}.', { items: affected.join('; ') }) : '');
      const description = () => streaming && code === 'INCOMPLETE_RESPONSE'
        ? t('The episode stream ended early. Retry requests only missing items; additional charges may apply.')
        : mtErrorText(code);
      const mode = () => streaming ? t('episode stream') : t('batch <= {count}', { count: TUNE.batch });
      const describe = () => `${description()}${detail} (${done}/${texts.length} ${retention()}; ${t('resumed {count}', { count: resumed })}; ${mode()})${note()} [${code}]`;
      hud.error(describe(),
        () => translateToTarget({ target, provider, source, batchSize, checkpoint: resume }), split ? 'Retry smaller batches' : 'Retry', describe);
      return;
    }
    if (_translatePause && done < texts.length) return;

    // Complete — the durable result remains available after a page reload.
    const mtCues = cues.map((c, k) => ({ ...c, text: out[k] || c.text, srcText: c.text,
      translationStatus: 'translated' }));
    // Put the sign translations (the tail of `out`) back into the signs .ass; a
    // missing one keeps its source-language text.  null = base has no signs.
    const signRawAss = signParse ? rebuildSignsAss(signParse, out.slice(nDlg)) : (signsBase || null);
    ep.addCustomSource({ ...CUSTOM.makeMtSource({
      id, target, source,
      label: `${tLabel} (${pLabel})`,
      srcCues: mtCues,
      signRawAss,   // base track's typeset signs, translated to the target
    }), incomplete: false, reviewCacheKey: partKey, sync: ep.getCustomSource(id)?.sync || { mode: 'none' } });
    STORAGE.lsDel(partKey);
    sourceMenu.updateButtonVisibility();
    hud.fade();
    hideTranslateProgress();
    log.info(`Machine-translated ${cues.length} cues ${source} → ${target} (resumed ${resumed}).`);
    if (ep.activeSource() === id) {
      ep.setOriginalCues(applyCustomSync(ep.getCustomSource(id)));
      renderer.invalidate();
      onTimeUpdate();
    }
  }

  // ── In-player Translate panel ─────────────────────────────────────────────
  // Lets the user pick target + (per-episode) source + provider before kicking
  // off a translation.  The From list is built from THIS episode's valid CR
  // tracks, so it adapts automatically; 'Auto' picks the best (English).
  const TRANSLATE_PANEL_ID = 'cr-bsub-mt-panel';
  let _mtPanelEsc = null;
  function closeTranslatePanel() {
    document.getElementById(TRANSLATE_PANEL_ID)?.remove();
    if (_mtPanelEsc) { document.removeEventListener('keydown', _mtPanelEsc); _mtPanelEsc = null; }
  }
  function mtSelect() {
    const s = document.createElement('select');
    // color-scheme:dark makes the browser draw the native option-list popup dark
    // with light text — otherwise the popup is white and our light option text
    // is invisible on it.
    s.style.cssText = `width:100%;background:rgba(255,255,255,0.06);color:${THEME.text};border:1px solid ${THEME.panelEdge};` +
      `border-radius:5px;padding:5px 8px;font-size:12px;font-family:${THEME.font};cursor:pointer;outline:none;color-scheme:dark;`;
    return s;
  }
  function mtSetOptions(sel, opts, selected) {
    sel.innerHTML = '';
    for (const [val, label] of opts) {
      const o = document.createElement('option');
      o.value = val; uiText(o, label);
      // Explicit dark bg + light text per option.  color-scheme:dark on the
      // <select> styles the CLOSED control, but the native option-list popup is
      // drawn light on Windows — leaving our light option text invisible on white
      // (the "whited-out" dropdown).  Styling each option directly is honored by
      // Chrome's popup and fixes it regardless of platform.
      o.style.background = '#1a1a2e';
      o.style.color      = THEME.text;
      if (val === selected) o.selected = true;
      sel.appendChild(o);
    }
  }
  // Valid CR official tracks for this episode usable as a translation source.
  function validSourceOptions(ep, target) {
    const opts = [['', 'Auto (best available)']];
    for (const v of ep.catalog.versions()) {
      const loc = v.locale;
      if ((loc === 'ja-JP' ? 'en-US' : loc) === target || localeHasContent(loc) === false) continue;
      const val = ep.catalog.validation(loc);
      if (val === 'wrong-title' || val === 'no-subs') continue;
      opts.push([loc, LOCALE_LABELS[loc] ?? loc]);
    }
    return opts;
  }
  function openTranslatePanel() {
    const ep = currentEp();
    if (!ep || !videoEl) return;
    if (!isMtEnabled() || !isMtConfigured()) { showErrorToast('Set up and enable machine translation in the extension popup first.'); return; }
    if (_translating) { showErrorToast('A translation is already running.'); return; }
    closeTranslatePanel();

    const panel = document.createElement('div');
    panel.id = TRANSLATE_PANEL_ID;
    Object.assign(panel.style, panelStyle({
      position: 'absolute', zIndex: '2147483646', padding: '12px 14px', width: '300px',
      maxWidth: 'calc(100% - 16px)', maxHeight: '80vh', overflowY: 'auto', overflowWrap: 'anywhere',
    }));
    panel.innerHTML =
      `<div style="font-size:13px;font-weight:700;color:${THEME.accent};margin-bottom:10px;">🌐 Translation settings</div>` +
      `<div style="font-size:11px;color:#888;margin-bottom:3px;">Translate into</div>` +
      `<div data-row="to" style="margin-bottom:9px;"></div>` +
      `<div style="font-size:11px;color:#888;margin-bottom:3px;">From</div>` +
      `<div data-row="from" style="margin-bottom:6px;"></div>` +
      `<div data-row="prov" style="font-size:10px;color:#9ecbff;margin-bottom:6px;"></div>` +
      `<div style="font-size:10px;color:#777;line-height:1.4;margin-bottom:10px;">Saved automatically. English is usually the best source; machine output is an approximation.</div>` +
      `<div data-row="foot" style="display:flex;gap:8px;justify-content:flex-end;"></div>`;

    const toSel = mtSelect(), fromSel = mtSelect();
    let target = getMtTarget();
    mtSetOptions(toSel,   MT_TARGET_OPTIONS,              target);
    mtSetOptions(fromSel, validSourceOptions(ep, target), getMtSourcePref() || '');
    uiText(panel.querySelector('[data-row="prov"]'), 'Engine: {provider}', { provider: MT_PROVIDER_LABELS[getMtProvider()] ?? 'Relay' });
    // Persist on change so choices stick across episodes (no re-picking); rebuild
    // From when the target changes (can't translate a language into itself).
    toSel.addEventListener('change', () => {
      target = toSel.value;
      setMtPref('target', target);
      mtSetOptions(fromSel, validSourceOptions(ep, target), fromSel.value);
      setMtPref('source', fromSel.value);
    });
    fromSel.addEventListener('change', () => setMtPref('source', fromSel.value));

    panel.querySelector('[data-row="to"]').appendChild(toSel);
    panel.querySelector('[data-row="from"]').appendChild(fromSel);

    const cancelB = syncBtn('Done');
    const goB     = syncBtn('Translate', true);
    panel.querySelector('[data-row="foot"]').append(cancelB, goB);
    NS.i18n?.localize(panel);
    cancelB.addEventListener('click', closeTranslatePanel);
    goB.addEventListener('click', () => {
      setMtPref('target', toSel.value);
      setMtPref('source', fromSel.value);
      closeTranslatePanel();
      translateToTarget({ target: toSel.value, source: fromSel.value || null }).catch(() => {});
    });

    const mountTarget = document.fullscreenElement ?? videoEl.parentElement ?? document.body;
    if (mountTarget !== document.body && window.getComputedStyle(mountTarget).position === 'static') mountTarget.style.position = 'relative';
    mountTarget.appendChild(panel);
    panel.style.left = '50%'; panel.style.bottom = '14%'; panel.style.transform = 'translateX(-50%)';

    _mtPanelEsc = (e) => { if (e.key === 'Escape') closeTranslatePanel(); };
    setTimeout(() => document.addEventListener('keydown', _mtPanelEsc), 0);
  }

  // ── In-player typeset tuning panel ────────────────────────────────────────
  // Live sliders for the \pos-sign transform tuning (perspective / 3-D / skew /
  // rotation / size) so the right defaults can be dialled in visually.  Each
  // slider writes localStorage and forces an immediate repaint.  Opened via
  // crSubFixDebug.tune().
  const TUNE_PANEL_ID = 'cr-bsub-tune-panel';
  let _tuneTeardown = null;
  function closeTypesetTunePanel() {
    document.getElementById(TUNE_PANEL_ID)?.remove();
    if (_tuneTeardown) { _tuneTeardown(); _tuneTeardown = null; }
  }
  function tuneSlider(label, lsKey, min, max, step, def, suffix) {
    const row = document.createElement('div');
    row.style.cssText = 'margin-bottom:9px;';
    let cur = def;
    try { const v = parseFloat(localStorage.getItem(lsKey)); if (!isNaN(v)) cur = v; } catch (_) {}
    const head = document.createElement('div');
    head.style.cssText = 'display:flex;justify-content:space-between;font-size:11px;color:#bbb;margin-bottom:2px;';
    const lab = document.createElement('span'); uiText(lab, label);
    const val = document.createElement('span'); val.textContent = cur + suffix; val.style.color = THEME.accent;
    head.append(lab, val);
    const range = document.createElement('input');
    range.type = 'range'; range.min = min; range.max = max; range.step = step; range.value = cur;
    range.style.cssText = `width:100%;cursor:pointer;accent-color:${THEME.accent};`;
    range.addEventListener('input', () => {
      const v = parseFloat(range.value);
      val.textContent = v + suffix;
      try { localStorage.setItem(lsKey, String(v)); } catch (_) {}
      try { renderer.invalidate(); onTimeUpdate(); } catch (_) {}
    });
    row.append(head, range);
    return row;
  }
  function openTypesetTunePanel() {
    if (!videoEl) return;
    closeTypesetTunePanel();
    const panel = document.createElement('div');
    panel.id = TUNE_PANEL_ID;
    Object.assign(panel.style, panelStyle({
      position: 'absolute', zIndex: '2147483646', padding: '10px 13px', width: '270px',
    }));
    const title = document.createElement('div');
    title.style.cssText = `font-size:13px;font-weight:700;color:${THEME.accent};margin-bottom:9px;cursor:move;`;
    uiText(title, '🎚 Typeset tuning (signs) ⠿');
    panel.appendChild(title);
    panel.appendChild(tuneSlider('Perspective',  'crSubFix_persp',     300, 2200, 25,   1018, 'px'));
    panel.appendChild(tuneSlider('3-D strength',  'crSubFix_ts_3d',    0,   2,    0.05, 1,   '×'));
    panel.appendChild(tuneSlider('Skew',          'crSubFix_ts_skew',  0,   2,    0.05, 1,   '×'));
    panel.appendChild(tuneSlider('Rotation',      'crSubFix_ts_rot',   0,   2,    0.05, 1,   '×'));
    panel.appendChild(tuneSlider('Sign size',     'crSubFix_signscale', 0.5, 1.3, 0.02, 0.9, '×'));
    const note = document.createElement('div');
    note.style.cssText = 'font-size:10px;color:#777;line-height:1.4;margin:2px 0 8px;';
    uiText(note, '× = multiplier on the file’s value (1 = exact). Tell me the values you like and I’ll bake them in.');
    panel.appendChild(note);
    const foot = document.createElement('div');
    foot.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    const resetB = syncBtn('Reset'); const doneB = syncBtn('Done', true);
    foot.append(resetB, doneB);
    panel.appendChild(foot);
    resetB.addEventListener('click', () => {
      ['crSubFix_persp', 'crSubFix_ts_3d', 'crSubFix_ts_skew', 'crSubFix_ts_rot', 'crSubFix_signscale']
        .forEach((k) => { try { localStorage.removeItem(k); } catch (_) {} });
      try { renderer.invalidate(); onTimeUpdate(); } catch (_) {}
      openTypesetTunePanel();   // rebuild sliders at defaults
    });
    doneB.addEventListener('click', closeTypesetTunePanel);

    const mount = document.fullscreenElement ?? videoEl.parentElement ?? document.body;
    if (mount !== document.body && window.getComputedStyle(mount).position === 'static') mount.style.position = 'relative';
    mount.appendChild(panel);
    panel.style.left = '14px'; panel.style.top = '12%';

    // Drag by the title bar so it can be moved off the signs being tuned.
    let drag = null;
    const onDown = (e) => {
      const pr = (panel.offsetParent || document.body).getBoundingClientRect();
      const r = panel.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, pr };
      e.preventDefault();
    };
    const onMove = (e) => {
      if (!drag) return;
      panel.style.left = (e.clientX - drag.dx - drag.pr.left) + 'px';
      panel.style.top  = (e.clientY - drag.dy - drag.pr.top) + 'px';
    };
    const onUp = () => { drag = null; };
    const onEsc = (e) => { if (e.key === 'Escape') closeTypesetTunePanel(); };
    title.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    setTimeout(() => document.addEventListener('keydown', onEsc), 0);
    _tuneTeardown = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('keydown', onEsc);
    };
  }

  // ── Anchor map remaster ────────────────────────────────────────────────────
  //
  // Builds a sparse set of {srcTime, refTime} pairs by text-matching identical
  // subtitle cues from two sessions.  These pairs define a piecewise-linear
  // time-remapping curve: any cue timestamp from the source session can be
  // interpolated onto the audio session's timeline.
  //
  // Unlike a single constant offset, this handles multiple cut points, scene
  // insertions/removals, and gradual timing drift within a single file.
  //
  // The anchor map is keyed by (episode × srcSession × audioSession) so ONE
  // computation retimes every subtitle language for that session pair.

  // ── Subtitle text fetcher ─────────────────────────────────────────────────
  // Pure timing algorithms (buildAnchorMap, interpolateTime, remasterCues,
  // computeMedianDelta) live in lib/remaster.js.  This file keeps the fetcher
  // because it threads through the Episode raw-text cache.

  /**
   * Fetch a subtitle file, parse it, and return cues.  Reuses the Episode's
   * session cache so repeated fetches of the same URL hit memory.
   */
  async function fetchAndParseSubs(url) {
    if (!url) return [];
    const ep = currentEp();
    let text = ep?.getCachedRawText(url);
    if (!text) {
      try {
        const resp = await originalFetch(url);
        if (!resp.ok) return [];
        text = await resp.text();
        ep?.setCachedRawText(url, text);
      } catch (_) { return []; }
    }
    try { return parseSubtitles(text, url); } catch (_) { return []; }
  }

  // ── Remaster progress HUD ─────────────────────────────────────────────────
  // The DOM-level HUD primitive lives in lib/overlay-ui.js.  This file owns
  // the message-composition policy: which stats turn into which one-liner.

  let hudCtl = null;
  function ensureHud() {
    if (!hudCtl && renderer.element) hudCtl = UI.makeProgressHud(renderer.element);
    return hudCtl;
  }

  function updateProgress(step, total, desc) {
    ensureHud()?.update(step, total, desc);
  }

  function fadeOutHud() {
    hudCtl?.fade();
    hudCtl = null;
  }

  function showRemasterBadge(success, stats = {}) {
    const hud = ensureHud();
    if (!hud) return;

    if (stats.sameSession || stats.sameFile) {
      const detail = stats.sameSession
        ? `<span style="color:rgba(255,255,255,0.35);font-size:10px;"> — same session</span>`
        : `<span style="color:rgba(255,255,255,0.35);font-size:10px;"> — same video cut</span>`;
      hud.html(`<span style="color:#4caf50;">✓</span>  Subtitles already in sync${detail}`, 4000);
      return;
    }
    if (!success) {
      const reason = stats.reason ? `  <span style="color:rgba(255,255,255,0.4);font-size:10px;">${escapeHtml(String(stats.reason))}</span>` : '';
      hud.html(`<span style="color:#e55;">⚠</span>  Auto-sync unavailable${reason}`, 6000);
      return;
    }
    // Approximate constant-shift fallback (couldn't build a precise piecewise
    // map) — be honest that it's an estimate, not validated coverage.
    if (stats.approx) {
      const d = stats.medianDelta;
      const dStr = d != null ? `${d >= 0 ? '+' : ''}${d.toFixed(1)}s` : '';
      hud.html(
        `<div style="color:${THEME.accent};font-weight:700;">✓  ${escapeHtml(t('Subtitles shifted {offset}', { offset: dStr }))}</div>` +
        `<div style="color:rgba(255,255,255,0.45);font-size:10px;margin-top:2px;">` +
          escapeHtml(t('approximate — estimated from {count} matching lines', { count: stats.count })) +
        `</div>`,
        7000
      );
      return;
    }

    const cached     = stats.cached ? ' ' + t('· cached') : '';
    const deltaStr   = stats.medianDelta != null
      ? `${stats.medianDelta >= 0 ? '+' : ''}${stats.medianDelta.toFixed(1)}s · `
      : '';
    const bridgeStr  = stats.bridge ? ' ' + escapeHtml(t('via {language}', { language: String(stats.bridge) })) : '';
    hud.html(
      `<div style="color:${THEME.accent};font-weight:700;">✓  Auto-sync validated${bridgeStr}</div>` +
      `<div style="color:rgba(255,255,255,0.45);font-size:10px;margin-top:2px;">` +
        `${deltaStr}${escapeHtml(t('{count} anchors · {quality}% coverage', { count: stats.count, quality: stats.quality }))}${cached}` +
      `</div>`,
      7000
    );
  }

  // When the primary is a cross-session track (the JP-source translation on a
  // dub) that could NOT be exactly synced — remaster bailed, or fell back to an
  // approximate constant shift — and the dub carries its own natively-timed CC,
  // offer a one-tap switch to that CC for exact timing.  One nudge per episode.
  const _exactSyncOffered = new Set();
  function maybeOfferExactSync(appliedOffset) {
    const ep = currentEp();
    if (!ep) return;
    const audio = ep.catalog.currentAudio();
    if (!audio || audio === 'ja-JP') return;            // subs need no remaster
    if (ep.activeSource() === audio) return;            // already on the dub's own track
    if (!ep.catalog.captionSourced?.(audio, audio)) return;  // no native CC to offer
    if (_exactSyncOffered.has(ep.guid)) return;
    _exactSyncOffered.add(ep.guid);
    const label = LOCALE_LABELS[audio] ?? audio;
    const msg = appliedOffset
      ? t('Subtitles auto-shifted ~{offset}s to fit this dub.', { offset: Math.abs(appliedOffset).toFixed(1) })
      : t('These subtitles may be out of sync with this dub.');
    showErrorToast(`${msg} ${t('For exact timing:')}`, () => selectSource(audio), t('Use {language} (CC)', { language: t(label) }));
  }

  // ── Master remaster orchestrator ──────────────────────────────────────────
  /**
   * Remaster the current subtitle file to match the audio session's cut.
   *
   * Process:
   *   1. Identify which session the loaded subtitle came from.
   *   2. If same session as audio → no remaster needed.
   *   3. Check localStorage for a cached anchor map.
   *   4. If not cached: find bridging language, fetch both copies, build anchors.
   *   5. Apply anchor map to retime every cue individually (piecewise-linear).
   *   6. Save anchor map to localStorage (30-day TTL).
   *   7. Display progress HUD and completion badge.
   */
  async function runRemaster(cues, loadedUrl, subLang) {
    const ep = currentEp();
    if (!ep) return;
    const catalog     = ep.catalog;
    const audioLocale = catalog.currentAudio();
    if (!audioLocale || !cues.length) return;
    // Stale check: the originalCues array reference may have been replaced by a
    // newer parse (source switch).  If so, this remaster's input is no longer
    // current — bail before clobbering the new state.
    const isStale = () => cues !== ep.originalCues || ep.disposed;

    log.info(`Remaster: starting — audio=[${audioLocale}] sub=[${subLang ?? 'ja-JP'}] cues=${cues.length}`);
    log.info(`Remaster: catalog sessions = [${catalog.entries().map(([s]) => s).join(', ')}]`);
    for (const [sess, row] of catalog.entries()) {
      log.info(`  [${sess}] has: [${Object.keys(row).join(', ')}]`);
    }

    // ── 1. Identify source session ──────────────────────────────────────────
    const found = catalog.findSession(loadedUrl, subUrlBase);
    let srcSession = found?.session ?? null;
    let srcLang    = found?.lang ?? subLang ?? null;
    if (!srcSession) {
      const loadedBase = subUrlBase(loadedUrl);
      const jpBase = subUrlBase(ep.jpSubtitleUrl ?? '') || subUrlBase(ep.jpCaptionUrl ?? '');
      if (jpBase && loadedBase === jpBase) { srcSession = 'ja-JP'; }
      else { log.info('Remaster: source session not found in catalog — cannot sync'); return; }
    }
    log.info(`Remaster: srcSession=[${srcSession}] srcLang=[${srcLang}]`);

    // ── 2. Same session as audio → correct by definition ──────────────────
    if (srcSession === audioLocale) {
      log.info(`Remaster: same session (${srcSession}) — no adjustment`);
      ep.setRemasterForAudio(audioLocale);
      refreshButtonLabel();
      showRemasterBadge(true, { sameSession: true });
      return;
    }

    // ── 3. Check localStorage cache ────────────────────────────────────────
    const cached = loadAnchorMap(srcSession, audioLocale);
    if (cached) {
      log.info(`Remaster: cached anchor map (${cached.anchors.length} anchors, ${cached.quality}% cov)`);
      ep.setRemasteredCues(remasterCues(cues, cached.anchors), audioLocale);
      renderer.invalidate();
      onTimeUpdate();
      refreshButtonLabel();
      showRemasterBadge(true, {
        cached: true, quality: cached.quality,
        count:  cached.anchors.length, bridge: cached.bridge,
        medianDelta: computeMedianDelta(cached.anchors),
      });
      return;
    }

    // ── 4. Full async remaster ─────────────────────────────────────────────
    const sourceRow = catalog.rowFor(srcSession);
    const audioRow  = catalog.rowFor(audioLocale);

    updateProgress(1, 8, 'Detecting session mismatch');
    updateProgress(2, 8, 'Finding reference language');

    const bridge = catalog.findBridge(srcSession, audioLocale);
    log.info(`Remaster: bridge lang = [${bridge ?? 'none'}]  sourceRow=[${Object.keys(sourceRow).join(', ')}]  audioRow=[${Object.keys(audioRow).join(', ')}]`);
    if (!bridge) {
      showRemasterBadge(false, { reason: 'No shared language between sessions' });
      return;
    }

    const srcBridgeUrl = sourceRow[bridge];
    const refBridgeUrl = audioRow[bridge];

    if (subUrlBase(srcBridgeUrl) === subUrlBase(refBridgeUrl)) {
      log.info(`Remaster: bridge files identical → same timing, no adjustment`);
      ep.setRemasterForAudio(audioLocale);
      refreshButtonLabel();
      showRemasterBadge(true, { sameFile: true });
      return;
    }

    // escapeHtml: bridge is a locale key from the page's playback JSON and
    // updateProgress lands in innerHTML — same treatment as the badge stats.
    updateProgress(3, 8, escapeHtml(t('Fetching source ref ({language})', { language: String(bridge) })));
    const srcBridgeCues = (bridge === srcLang && cues.length)
      ? cues
      : await fetchAndParseSubs(srcBridgeUrl);
    if (isStale()) return;
    if (srcBridgeCues.length < 3) {
      showRemasterBadge(false, { reason: `Source reference unavailable (${bridge})` });
      return;
    }

    updateProgress(4, 8, escapeHtml(t('Fetching audio ref ({language})', { language: String(bridge) })));
    const refBridgeCues = await fetchAndParseSubs(refBridgeUrl);
    if (isStale()) return;

    // ── Sparse-reference fallback ─────────────────────────────────────────
    // Non-JP audio sessions only carry their own native-language subtitle as a
    // signs-only track (< 30 cues), so the bridge reference is always sparse.
    // If we can't get enough text-matching anchors but it looks like the
    // signs-only case, assume Crunchyroll's same-cut policy and accept.
    const isSparseRef = refBridgeCues.length < 30;

    updateProgress(5, 8, `Building timing anchors`);
    const anchorMap = buildAnchorMap(srcBridgeCues, refBridgeCues);

    if (anchorMap.length < MIN_ANCHORS) {
      if (isSparseRef && bridge === audioLocale) {
        log.info(`Remaster: sparse signs-only bridge (${refBridgeCues.length} cues) — assuming same timing`);
        ep.setRemasterForAudio(audioLocale);
        refreshButtonLabel();
        showRemasterBadge(true, { sameFile: true });
        return;
      }
      // Precise piecewise anchoring failed — but the two cuts may still differ
      // by a single constant shift (e.g. a dub whose CC is a different English
      // script than the JP-source sub, so lines rarely word-match, yet the dub
      // just adds a few seconds of lead-in).  Recover that one offset from a
      // coarse, outlier-robust match and shift the whole track rather than
      // showing it at raw (wrong) timing.
      const est = estimateGlobalOffset(srcBridgeCues, refBridgeCues);
      if (est && Math.abs(est.offset) >= 0.5) {
        ep.setRemasteredCues(shiftCues(cues, est.offset), audioLocale);
        renderer.invalidate();
        onTimeUpdate();
        refreshButtonLabel();
        showRemasterBadge(true, { approx: true, medianDelta: est.offset, count: est.samples });
        log.info(`Remaster: global-offset fallback · shift ${est.offset.toFixed(2)}s · ${est.samples} samples · ${Math.round(est.agreement * 100)}% agree · [${srcSession}→${audioLocale}] via ${bridge}`);
        maybeOfferExactSync(est.offset);
        return;
      }
      showRemasterBadge(false, { reason: `Too few anchors (${anchorMap.length}/${MIN_ANCHORS} required)` });
      maybeOfferExactSync(null);
      return;
    }

    updateProgress(6, 8, t('Retiming {count} cues', { count: cues.length }));
    const remastered = remasterCues(cues, anchorMap);

    updateProgress(7, 8, 'Validating coverage');
    const eligibleSrc = srcBridgeCues.filter(c => normalizeSubText(c.text).length >= 8).length;
    const coverage    = Math.min(100, Math.round(anchorMap.length / Math.max(eligibleSrc, 1) * 100));
    const medianDelta = computeMedianDelta(anchorMap);

    updateProgress(8, 8, 'Saving to local cache');
    saveAnchorMap(srcSession, audioLocale, anchorMap, coverage, bridge);

    ep.setRemasteredCues(remastered, audioLocale);
    renderer.invalidate();
    onTimeUpdate();
    refreshButtonLabel();

    showRemasterBadge(true, { quality: coverage, count: anchorMap.length, bridge, medianDelta });
    log.info(
      `Remaster: ${anchorMap.length} anchors · ${coverage}% cov · Δ${medianDelta.toFixed(2)}s · [${srcSession}→${audioLocale}] via ${bridge}`
    );
  }

  const allKnownSubtitleLocales = () => currentEp()?.catalog.allSubtitleLocales() ?? new Set();

  // ── Settings readers ──────────────────────────────────────────────────────
  // Thin per-key wrappers around SETTINGS.read so call sites stay readable.
  // Schema lives in lib/settings-schema.js.
  const html = document.documentElement;

  const isEnabled              = () => SETTINGS.read(html, 'enabled');
  const isAutoActivate         = () => SETTINGS.read(html, 'autoActivate');
  const isHideOfficialSubs     = () => SETTINGS.read(html, 'hideOfficialSubs');
  const getSubScale            = () => SETTINGS.read(html, 'subScale');
  const getSyncOffset          = () => SETTINGS.read(html, 'subOffset');
  const getSubBottomFloor      = () => SETTINGS.read(html, 'subBottomFloor');

  // ── Per-track manual timing nudge ──────────────────────────────────────────
  // The global `subOffset` setting shifts BOTH subtitle bands together — useless
  // when the primary and secondary drift relative to each other (e.g. a
  // remastered JP-source primary vs a natively-timed CC secondary).  These
  // deltas layer on top of subOffset, per band.  Timing drift is
  // episode-specific, so they persist per guid (like anchor maps), not as a
  // cross-episode setting.  Edited via the ⏱ Adjust-timing panel.
  let _timing     = { pri: 0, sec: 0 };
  let _timingGuid = null;
  const TIMING_TTL = 30 * 24 * 60 * 60 * 1000;
  const timingKey  = (guid) => 'crSubFix_timing_' + guid;
  function loadTimingDeltas(guid) {
    _timingGuid = guid;
    let v = null; try { v = STORAGE.lsGet(timingKey(guid)); } catch (_) {}
    _timing = { pri: (v && +v.pri) || 0, sec: (v && +v.sec) || 0 };
  }
  function saveTimingDeltas() {
    if (!_timingGuid) return;
    try {
      if (_timing.pri || _timing.sec) STORAGE.lsSet(timingKey(_timingGuid), { pri: _timing.pri, sec: _timing.sec }, TIMING_TTL);
      else STORAGE.lsDel(timingKey(_timingGuid));
    } catch (_) {}
  }
  // Reload the per-episode deltas when the active episode changes (cheap guard
  // in the render hot path).
  function syncTimingForEp(ep) {
    if (ep && _timingGuid !== ep.guid) loadTimingDeltas(ep.guid);
  }
  const priOffset = () => { let g = 0; try { g = getSyncOffset(); } catch (_) {} return g + _timing.pri; };
  const secOffset = () => { let g = 0; try { g = getSyncOffset(); } catch (_) {} return g + _timing.sec; };

  const isAutoPauseLine        = () => SETTINGS.read(html, 'autoPauseLine');
  const getSecondarySignGap    = () => SETTINGS.read(html, 'secondarySignGap');
  // Per-layer visibility ("Show on screen").  Default true; gate the primary
  // dialogue band (onTimeUpdate) and the typeset signs (pushSignLayer + the CSS
  // sign path) independently of the master overlay on/off.
  const isShowDialogue         = () => SETTINGS.read(html, 'showDialogue');
  const isShowSigns            = () => SETTINGS.read(html, 'showSigns');
  // Persist a single settings-schema key the player UI changed.  The MAIN world
  // can't write chrome.storage, so: (1) optimistically write the attr locally for
  // an instant re-render (the settings MutationObserver fires), then (2) post a
  // token-guarded SET_SETTING to content.js, which writes chrome.storage so the
  // change survives reload and the popup reflects it.  Re-assert the toggle token
  // first — CR's hydration can strip it, which would make content.js reject this.
  function saveSetting(key, value) {
    try { SETTINGS.write(html, key, value); } catch (_) {}
    try { html.setAttribute(PROTOCOL.ATTR.TOGGLE_TOKEN, TOGGLE_TOKEN); } catch (_) {}
    try { window.postMessage({ type: PROTOCOL.POST.SET_SETTING, token: TOGGLE_TOKEN, key, value }, window.location.origin); } catch (_) {}
  }
  // (The style-override values are read directly via SETTINGS.read in
  // captureStyleCtx(), so no per-key getter accessors are kept here.)
  // Target + source are chosen on the player (⚙ Translation settings) and
  // persisted to localStorage, so they stick across episodes without re-picking;
  // the popup schema value is only the first-run fallback.  (Provider + key stay
  // in the popup — Chrome only lets an extension PAGE request the host
  // permission, and a provider is paired with its key.)
  const getMtTarget = () => {
    try { const v = localStorage.getItem('crSubFix_mt_target'); if (v) return v; } catch (_) {}
    return SETTINGS.read(html, 'mtTarget') || 'zh-CN';
  };
  const getMtSourcePref = () => {
    try { const v = localStorage.getItem('crSubFix_mt_source'); if (v != null) return v; } catch (_) {}
    return SETTINGS.read(html, 'mtSource') || '';
  };
  const setMtPref = (key, val) => { try { localStorage.setItem('crSubFix_mt_' + key, val); } catch (_) {} };
  const isMtEnabled            = () => SETTINGS.read(html, 'mtEnabled');
  const isMtConfigured         = () => html.getAttribute(PROTOCOL.ATTR.MT_CONFIGURED) === 'true';
  // Display names for MT TARGET languages.  Deliberately NOT LOCALE_LABELS —
  // that maps 'ja-JP' to "English (Japanese source)" (the CR dub-context label),
  // which is nonsense for a translation target.  These are real language names.
  const MT_LANG_LABELS = {
    'ja-JP': 'Japanese',  'ko-KR': 'Korean',          'zh-CN': 'Chinese (Simplified)',
    'zh-TW': 'Chinese (Traditional)', 'en-US': 'English', 'de-DE': 'Deutsch',
    'es-419': 'Español (Lat)', 'es-ES': 'Español (España)', 'fr-FR': 'Français',
    'pt-BR': 'Português (BR)', 'it-IT': 'Italiano',    'ru-RU': 'Русский',
  };
  const mtLangLabel = (loc) => MT_LANG_LABELS[loc] ?? LOCALE_LABELS[loc] ?? loc;
  // Ordered target options for the in-player Translate panel.
  const MT_TARGET_OPTIONS = [
    ['ja-JP', 'Japanese'], ['ko-KR', 'Korean'], ['zh-CN', 'Chinese (Simplified)'],
    ['zh-TW', 'Chinese (Traditional)'], ['en-US', 'English'], ['de-DE', 'Deutsch'],
    ['es-419', 'Español (Lat)'], ['fr-FR', 'Français'], ['pt-BR', 'Português (BR)'],
    ['it-IT', 'Italiano'], ['ru-RU', 'Русский'],
  ];
  const getMtProvider = () => SETTINGS.read(html, 'mtProvider') || 'relay';
  const MT_PROVIDER_LABELS = { deepl: 'DeepL', relay: 'Custom Relay' };
  // MT tracks are keyed by target AND provider (provider is always 'deepl' now,
  // but the key shape is kept stable so existing saved tracks still resolve).
  const mtId = (target, provider, tag, source, hash) => `custom:mt:relay1:${target}:${provider}:${tag}:${source}:${hash}`;

  // Runtime-tunable throughput knobs so the sweet spot for each API can be found
  // empirically without a rebuild.  Override from the page console:
  //   crSubFixDebug.mtTune({ batch: 15, pace: 6000 })   // then re-translate
  //   crSubFixDebug.mtTuneReset()
  // Note the trade-off: a SMALLER batch means MORE requests (worse for per-minute
  // and per-day caps); a LARGER `pace` is slower but safer.  Defaults are
  // deliberately conservative.
  function mtTuning() {
    const num = (k, d) => {
      try { const v = parseInt(localStorage.getItem(k), 10); return (isFinite(v) && v >= 0) ? v : d; }
      catch (_) { return d; }
    };
    return {
      batch: Math.min(50, Math.max(1, SETTINGS.read(html, 'mtBatchSize') || 30)),
      concurrency: Math.min(2, Math.max(1, SETTINGS.read(html, 'mtConcurrency') || 2)),
      maxChars: Math.min(12000, Math.max(500, SETTINGS.read(html, 'mtMaxChars') || 3000)),
      pace:     num('crSubFix_mt_pace',     1200),             // ms between batches
      timeout: Math.min(120000, Math.max(5000, SETTINGS.read(html, 'mtTimeoutMs') || 25000)) + 15000,
      rateWait: num('crSubFix_mt_ratewait', 20000),            // ms to wait after a 429
      retries:  Math.max(1, num('crSubFix_mt_retries',  4)),
    };
  }

  // hexToRgba lives in lib/cue-style.js — aliased near the top of this file.

  // ── Status reporting ───────────────────────────────────────────────────────
  function setJpStatus(status) {
    html.setAttribute(PROTOCOL.ATTR.JP_STATUS, status);
    html.setAttribute(PROTOCOL.ATTR.JP_ACTIVE, status === PROTOCOL.STATUS.ACTIVE ? 'true' : 'false');
    updateActiveInfo();
  }

  // Write a JSON-encoded snapshot of "what's playing right now" so the
  // popup can show source / audio / remaster state under the status pill.
  // Called whenever any of those change.  Safe to over-call — same JSON
  // string just overwrites the attribute idempotently.
  let _lastActiveInfo = '';
  function updateActiveInfo() {
    const ep = currentEp();
    const info = {
      source:   ep?.activeSource()      ?? null,
      audio:    ep?.catalog.currentAudio() ?? null,
      // remasterForAudio matches currentAudio when remaster has produced
      // cues for the active session.  Anything else means we either
      // didn't need to remaster (same-session) or it failed / isn't done.
      remaster: ep?.remasterForAudio
        ? (ep.remasterForAudio === ep.catalog.currentAudio() ? 'synced' : 'pending')
        : null,
      overlay:  overlayActive ? 'on' : 'off',
    };
    const json = JSON.stringify(info);
    if (json === _lastActiveInfo) return;
    _lastActiveInfo = json;
    html.setAttribute(PROTOCOL.ATTR.ACTIVE_INFO, json);
  }

  setJpStatus(PROTOCOL.STATUS.NONE);
  updateActiveInfo();

  // ── Helpers ────────────────────────────────────────────────────────────────
  function extractAuthHeader(init) {
    const src = init?.headers;
    if (!src) return {};
    const get = k => src instanceof Headers ? src.get(k) : src[k];
    const auth = get('Authorization') || get('authorization');
    return auth ? { Authorization: auth } : {};
  }

  // Strip characters that could break a CSS font-family declaration.
  // Allows letters, digits, spaces, commas, hyphens, apostrophes, and periods —
  // everything a valid font stack needs, nothing a CSS injection attack needs.
  function sanitizeFontFamily(s) {
    if (!s) return '';
    return s.replace(/[^a-zA-Z0-9 ,'\-\.]/g, '').trim();
  }

  function debounce(fn, ms) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  // ── SPA navigation ────────────────────────────────────────────────────────
  // Episode lifecycle (lib/episode.js) drives the per-viewing reset.  Page-chrome
  // teardown (renderer overlay, button DOM, observers) lives here because the
  // Episode does not own DOM.  Disposed Episodes silently absorb any late writes
  // from in-flight fetches via Episode's internal disposed-guard.
  function teardownPageChrome() {
    translationHud?.destroy();
    translationHud = null;
    if (videoEl) videoEl.removeEventListener('play', tryAutoActivate);
    stopSync();
    // Reset hardsub detection with the episode — a stale true from the
    // outgoing episode would fire a false "burned-in subtitles" toast if the
    // next overlay activates before its playback JSON re-runs the watch.
    stopHardsubWatch();
    _hardsubStream = false;
    // Through the wrapper so content.js gets a SIGN_ASS clear — a bare write
    // leaves libass rendering the outgoing episode's typeset signs.
    setOverlayActive(false);
    clickInProgress  = false;
    videoEl          = null;
    buttonInControls = false;
    movedToControls  = false;
    subSuppression.deactivate();
    bgValidatePending = false;
    pendingActivate   = false;
    if (queueResolverTimer) { clearTimeout(queueResolverTimer); queueResolverTimer = null; }
    clearTimeout(settleTimer); settleTimer = null;
    sourceMenu.close();
    closeExportPanel();
    closeSyncPanel();
    closeTranslatePanel();
    closeTypesetTunePanel();
    closeTimingPanel();
    sourceMenu.removeButton();
    renderer.unmount();
    document.getElementById(BTN_ID)?.remove();
    document.getElementById(PROGRESS_ID)?.remove();
    if (_errorToast) { try { _errorToast.remove(); } catch (_) {} _errorToast = null; }
    hudCtl    = null;
    setJpStatus(PROTOCOL.STATUS.NONE);
  }

  let lastWatchPath = window.location.pathname;
  // Pulls the slug from /watch/<guid>/<slug>.  Used to detect dub switches:
  // every audio dub of the same episode has its own guid but the slug stays
  // the same.  Returns null if the path isn't a /watch/ URL.
  const getWatchSlug = (path) => path.match(/\/watch\/[^/]+\/([^?#/]+)/)?.[1] ?? null;

  function handleNavigation() {
    const newPath  = window.location.pathname;
    if (newPath === lastWatchPath) return;
    const oldPath  = lastWatchPath;
    const wasWatch = oldPath.includes('/watch/');
    const isWatch  = newPath.includes('/watch/');
    lastWatchPath  = newPath;
    if (!wasWatch && !isWatch) return;

    // Cross-dub recovery: if old and new URLs share the same slug, the user
    // just switched audio dub — the underlying episode is identical, and
    // critically the JP guid mapping carries over.  Snapshot it before the
    // old Episode is disposed, then plant it in the new Episode's storage so
    // the next captured auth fetch can trigger a JP prefetch even when
    // Crunchyroll's player doesn't refetch the playback endpoint (it often
    // doesn't on dub switch — it just swaps audio tracks in the loaded
    // DASH manifest, so our PLAYBACK_RE intercept never fires).
    const priorEp        = EP.current();
    // Adding/changing a slug for the same watch ID is not a new episode.
    if (priorEp && !priorEp.disposed && priorEp.guid === getEpisodeGuid()) return;
    const oldSlug        = getWatchSlug(oldPath);
    const newSlug        = getWatchSlug(newPath);
    // Same slug, different guid → audio-dub switch; the Japanese version (and so
    // the JP subtitle source) is shared across every dub of the episode.  Prefer
    // the prior Episode's resolved jpGuid, but fall back to its cached guid-map:
    // when switching FROM the JP dub, jpGuid is often never set (its caption
    // comes straight from the current session), yet the map still points at the
    // JP version — without this fallback the carry is skipped, the new dub's map
    // is never written, and auto-activate has no guid to bootstrap from.
    // Snapshot the prior Episode's JP guid + auth BEFORE it is disposed, then
    // remember it keyed by the episode SLUG.  This is the crux of cross-dub
    // recovery: Crunchyroll routes a dub switch through a TWO-STEP navigation
    // that drops the slug in between — /watch/<slug> → /watch/<newGuid> (no
    // slug) → /watch/<newGuid>/<slug>.  The same-nav carry (oldSlug === newSlug)
    // can NEVER fire across that, and the episode holding the resolved JP guid is
    // disposed on the slug-less hop, so the mapping was lost on every switch.  A
    // slug-keyed memory survives the intermediate hop; the session token is
    // shared across dubs, so the auth carries too.
    const priorJp = priorEp ? (priorEp.jpGuid ?? priorEp.getMappedJpGuid?.() ?? null) : null;
    const priorAuth = priorEp
      ? ((priorEp.capturedAuth && Object.keys(priorEp.capturedAuth).length) ? priorEp.capturedAuth
         : (priorEp.authHeaders && Object.keys(priorEp.authHeaders).length) ? priorEp.authHeaders
         : null)
      : null;
    if (oldSlug && (priorJp || priorAuth)) {
      const prev = slugJpMemo.get(oldSlug) || {};
      rememberSlug(oldSlug, { jpGuid: priorJp || prev.jpGuid || null, auth: priorAuth || prev.auth || null });
    }

    const carryJpGuid = (wasWatch && isWatch && oldSlug && oldSlug === newSlug) ? priorJp : null;

    log.info(`SPA nav ${oldSlug || '-'} → ${newSlug || '-'} | priorJpGuid=${priorEp?.jpGuid || '-'} priorMapped=${priorEp?.getMappedJpGuid?.() || '-'} priorAuth=${!!priorAuth} carry=${carryJpGuid || '-'} memo=${(newSlug && slugJpMemo.get(newSlug)?.jpGuid) || '-'}`);
    teardownPageChrome();
    EP.disposeCurrent();
    const guid = getEpisodeGuid();
    if (guid) {
      const ep = EP.start(guid);
      restoreExternal(ep).catch(() => {});
      // Plant the JP guid + auth: prefer the same-nav carry, else the slug memory
      // (which survives the slug-less intermediate hop the carry can't).  A stale
      // token just 401s and we fall back to the reload path.  setMappedJpGuid also
      // caches the guid→jp map, so once a dub is mapped this way it self-heals on
      // its next visit.
      const memo        = newSlug ? slugJpMemo.get(newSlug) : null;
      const plantJpGuid = carryJpGuid || memo?.jpGuid || null;
      const plantAuth   = priorAuth || memo?.auth || null;
      if (plantJpGuid) {
        ep.setMappedJpGuid(plantJpGuid);
        if (plantAuth) { ep.setCapturedAuth(plantAuth); ep.setAuthHeaders(plantAuth); }
        log.info(`Planting JP guid ${plantJpGuid}${plantAuth ? ' + auth' : ''}${carryJpGuid ? ' (carry)' : ' (slug memo)'} (slug=${newSlug || '-'}).`);
        // Prefetch now whenever we can actually fetch it (cached → no auth needed,
        // or we have auth for a live fetch).  Skipping when we have neither avoids
        // latching prefetchTriggered on a doomed attempt.
        if (ep.getCachedJpData?.(plantJpGuid) || plantAuth) {
          maybePrefetch().catch(() => {});
        }
      }
    }
    // Backstop for rapid switching: re-attempt auto-activate once the user
    // stops switching, so the dub they finally landed on always gets its subs.
    scheduleSettle();
  }

  // Bounded retry of auto-activate, reset on every navigation.  Once switching
  // has been quiet for SETTLE_MS it nudges tryAutoActivate (which self-heals
  // from the cached mapping or drives the live fetch), then keeps retrying every
  // SETTLE_MS until the overlay is up or SETTLE_MAX attempts are exhausted —
  // covering metadata-not-ready, in-flight-fetch, and cut-short-bootstrap races
  // from a faster subsequent switch.  Converges instead of giving up after one
  // shot.
  function scheduleSettle() {
    clearTimeout(settleTimer);
    settleAttempts = 0;
    settleTimer = setTimeout(settleTick, SETTLE_MS);
  }
  function settleTick() {
    settleTimer = null;
    if (overlayActive) return;                 // subs are up — done
    tryAutoActivate();
    if (overlayActive) return;
    if (++settleAttempts < SETTLE_MAX) {
      settleTimer = setTimeout(settleTick, SETTLE_MS);
    } else {
      // Genuinely couldn't load JP (no auth + no cache → needs a reload).  Clear
      // the 'loading' flash so the button doesn't sit spinning forever.
      const ep = currentEp();
      const btn = document.getElementById(BTN_ID);
      if (btn && btn.dataset.state === 'loading' &&
          (!ep || (!ep.jpCaptionUrl && !ep.jpSubtitleUrl))) {
        log.warn('Settle: JP subs did not load after retries — clearing loading state.');
        applyButtonState(btn, 'idle');
      }
    }
  }

  // Construct the initial Episode at script start so any code that runs before
  // the first SPA navigation (auto-activate, prefetch, fetch intercept) finds a
  // live Episode.  No-op if not on /watch/.
  {
    const initGuid = getEpisodeGuid();
    if (initGuid) {
      const ep = EP.start(initGuid);
      setTimeout(() => restoreExternal(ep).catch(() => {}), 250);
    }
  }

  const origPushState    = history.pushState.bind(history);
  const origReplaceState = history.replaceState.bind(history);
  history.pushState    = function (...a) { origPushState(...a);    handleNavigation(); };
  history.replaceState = function (...a) { origReplaceState(...a); handleNavigation(); };
  window.addEventListener('popstate', handleNavigation);

  // ── Keyboard shortcut relay (from content.js via postMessage) ──────────────
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (e.data?.type !== PROTOCOL.POST.CR_SUB_TOGGLE || e.data?.token !== TOGGLE_TOKEN) return;
    const btn = document.getElementById(BTN_ID);
    if (btn) handleManualSubtitleClick(btn).catch(() => {});
  });

  // ── In-player 'C' shortcut ────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
    if (e.key !== 'c' && e.key !== 'C') return;
    const tgt = e.target;
    if (tgt.isContentEditable ||
        tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.tagName === 'SELECT') return;
    if (!isEnabled()) return;
    const btn = document.getElementById(BTN_ID);
    if (btn && !clickInProgress) {
      e.preventDefault();
      handleManualSubtitleClick(btn).catch(() => {});
    }
  });

  // ── Study hotkeys (Alt+R replay, Alt+C copy) ──────────────────────────────
  // Alt-modified so they never clash with Crunchyroll's single-key player
  // shortcuts or the bare-'C' toggle above.  Only on a watch page with cues,
  // never while typing into a field.
  document.addEventListener('keydown', (e) => {
    if (e.repeat || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const k = e.key.toLowerCase();
    if (k !== 'r' && k !== 'c') return;
    const tgt = e.target;
    if (tgt && (tgt.isContentEditable ||
        tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.tagName === 'SELECT')) return;
    if (!isEnabled() || !currentEp() || !videoEl) return;
    e.preventDefault();
    if (k === 'r') replayLine();
    else          copyActiveLine();
  });

  // ── Live re-render on settings changes ────────────────────────────────────
  // content.js writes to the data-cr-* attributes; this observer invalidates
  // the renderer's cue cache so the next timeupdate re-renders at the new
  // style/size.
  new MutationObserver(() => {
    renderer.invalidate();
    invalidateStyleCtx();   // a data-cr-* attribute changed → rebuild the cached style context
    // Re-push the libass sign layer too, so sign-affecting settings (e.g. the
    // dual-sign gap in 'both' mode) take effect live; content.js dedupes an
    // unchanged .ass, so this is a no-op when nothing sign-relevant changed.
    pushSignLayer();
    if (overlayActive) onTimeUpdate();
    // If autoActivate just flipped on (or was always on but the attribute
    // hadn't been written yet when JP data first landed), give it another
    // shot now that the attribute reflects the real setting.
    tryAutoActivate();
    // Pick up live changes to "hide official subs" (and the master enable
    // toggle) without waiting for the overlay to be touched.
    syncSubSuppression();
  }).observe(html, { attributes: true, attributeFilter: SETTINGS.ATTRS });

  // Called from the playback / JP-first / prefetch success paths after JP
  // data lands.  Does two things:
  //   1. If the button got stuck in 'unavail' from an earlier dub-switch
  //      playback response that didn't list ja-JP (Crunchyroll API quirk),
  //      reset it to 'idle' — JP turned out to be available after all.
  //   2. If the user clicked JP CC while data was loading, fire the queued
  //      activation now.
  function onJpDataReady() {
    const ep = currentEp();
    if (!ep || ep.disposed) { setPendingActivate(false); return; }
    if (!ep.jpCaptionUrl && !ep.jpSubtitleUrl && !ep.jpGuid) return;

    if (queueResolverTimer) { clearTimeout(queueResolverTimer); queueResolverTimer = null; }

    const btn = document.getElementById(BTN_ID);
    if (btn && btn.dataset.state === 'unavail') {
      log.info('JP data arrived — clearing stuck `unavail` button state.');
      setButtonState(btn, 'idle');
      setJpStatus(PROTOCOL.STATUS.READY);
    }

    if (pendingActivate) {
      setPendingActivate(false);
      clickInProgress = false; // released so handleButtonClick can re-enter
      if (btn) {
        log.info('JP data ready — firing queued JP CC click.');
        handleButtonClick(btn).catch(() => {});
      }
    }
  }

  // Queue stuck because Crunchyroll never fired /playback/v3/ for the new
  // dub (a common case — the player swaps audio in the loaded DASH manifest
  // instead of refetching).  After QUEUE_RESOLVE_MS we self-trigger the
  // playback fetch with the current Episode's guid + captured auth.  Our
  // own fetch wrapper sees it (it's the same window.fetch), runs the
  // normal playback intercept logic, populates the catalog and JP data —
  // which fires onJpDataReady and resolves the queue.
  function scheduleQueueResolver() {
    if (queueResolverTimer) return;
    queueResolverTimer = setTimeout(async () => {
      queueResolverTimer = null;
      if (!pendingActivate) return;
      const ep = currentEp();
      if (!ep || ep.disposed) { setPendingActivate(false); return; }

      // authHeaders initializes to {} (never null), so `??` could never fall
      // through to capturedAuth — and an empty header set means the self-
      // triggered fetch went out unauthenticated and got a guaranteed 401.
      const hasKeys = (o) => !!o && Object.keys(o).length > 0;
      const auth = hasKeys(ep.authHeaders) ? ep.authHeaders
                 : hasKeys(ep.capturedAuth) ? ep.capturedAuth : null;
      if (!auth) {
        log.info('Queue resolver: no captured auth yet — staying queued.');
        scheduleQueueResolver();   // re-arm; auth usually lands within seconds
        return;
      }

      // If we already have a cached JP guid mapping, prefetch directly —
      // cheaper than a full playback request for the current dub.
      if (ep.getMappedJpGuid?.() && !ep.jpCaptionUrl) {
        log.info('Queue resolver: retrying JP prefetch with cached mapping.');
        maybePrefetch().catch(() => {});
        return;
      }

      // No cached JP mapping — self-trigger a playback fetch for the
      // current guid so the catalog gets the data Crunchyroll didn't fetch.
      if (!ep.guid) return;
      log.info(`Queue resolver: self-triggering playback fetch for ${ep.guid}.`);
      try {
        await window.fetch(
          `https://www.crunchyroll.com/playback/v3/${ep.guid}/web/chrome/play`,
          { credentials: 'include', headers: auth }
        );
      } catch (err) {
        log.warn('Queue resolver fetch error:', err);
      }
    }, QUEUE_RESOLVE_MS);
  }

  // ── Auto-activate ──────────────────────────────────────────────────────────
  function tryAutoActivate() {
    const ep = currentEp();
    if (!ep) return;
    if (!isAutoActivate() || !ep.shouldAutoActivate() || overlayActive || clickInProgress) {
      if (!overlayActive) log.info(`autoActivate bail: auto=${isAutoActivate()} should=${ep.shouldAutoActivate()} clicking=${clickInProgress}`);
      return;
    }
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    if (!ep.jpCaptionUrl && !ep.jpSubtitleUrl) {
      // No JP URLs loaded yet — but if a guid mapping exists (carried across a
      // dub switch, or cached from a prior visit) and we can actually fetch it
      // (cached → no auth needed, or we have captured auth for a live fetch),
      // drive the prefetch now.  This recovers dub switches whose JP fetch never
      // fired (e.g. the playback-vs-pushState ordering race) and, via the settle
      // retry + the released prefetch latch, keeps retrying until it lands —
      // instead of leaving the button idle until a manual reload.  maybePrefetch
      // self-gates and, on success, re-calls tryAutoActivate → which activates.
      const jpGuid = ep.getMappedJpGuid?.();
      const canFetch = !!(jpGuid && (ep.getCachedJpData?.(jpGuid) || ep.capturedAuth));
      log.info(`autoActivate: no JP urls — jpGuid=${jpGuid || '-'} cached=${!!(jpGuid && ep.getCachedJpData?.(jpGuid))} auth=${!!ep.capturedAuth} → ${canFetch ? 'prefetch' : 'WAIT (nothing to fetch)'}`);
      if (canFetch) {
        // Ready cue: show 'loading' so the user sees subs are coming.  Only from
        // idle so we never stomp a 'reload'/'unavail'/'error' message.
        if (btn.dataset.state === 'idle') setButtonState(btn, 'loading');
        maybePrefetch().catch(() => {});
      }
      return;
    }
    // Defer until video metadata is loaded so duration-based subtitle validation
    // has an accurate video length to compare against.
    if (videoEl && !(videoEl.duration >= 60)) {
      videoEl.addEventListener('loadedmetadata', tryAutoActivate, { once: true });
      return;
    }
    log.info(`Auto-activating (audio=${ep.catalog.currentAudio()}, source=${ep.activeSource()}).`);
    // Ready cue: show 'loading' before activating so the flash fires even when JP
    // is already loaded (the min-duration wrapper holds it briefly, then '✓').
    if (btn.dataset.state === 'idle') setButtonState(btn, 'loading');
    // Restore the last-used subtitle locale, but only if it is actually available
    // for this episode.  A saved locale from a different episode (e.g. ca-ES that
    // only some shows carry) must not be applied here — fall back to default JP.
    try {
      const saved = localStorage.getItem(LOCALE_PREF_KEY);
      if (saved && saved !== ep.activeSource()) {
        const avail = localeHasContent(saved);
        if (avail !== false) {          // true (ready) or null (fetchable) — proceed
          ep.setActiveSource(saved);
          ep.clearCues();
          renderer.invalidate();
        } else {
          localStorage.removeItem(LOCALE_PREF_KEY);
        }
      }
    } catch (_) {}
    // Mark only on actual activation success.  Marking optimistically before
    // the click resolved meant a failed/raced activation would still latch
    // autoActivatedFor — and subsequent dub switches would silently bail
    // because shouldAutoActivate() saw the stale latch.
    handleButtonClick(btn).then(() => {
      if (!ep.disposed && overlayActive) ep.markAutoActivated();
    }).catch(() => {});
  }

  // ── Pre-fetch JP data ──────────────────────────────────────────────────────
  // Build the Source-picker version list from the JP subtitle data we already
  // hold (the stored ja-JP session row), so the picker is populated even on a
  // DUB episode — whose live playback response never runs the full setVersions
  // block (it returns early without a ja-JP version), leaving its catalog empty
  // and the dropdown showing only the action rows.  Guarded: it never clobbers
  // a richer list already built from a live JP response (which carries the
  // audio-dub guids), so the live path always wins when it runs.
  function ensureVersionList(ep) {
    if (!ep || ep.disposed) return;
    if (ep.catalog.versions().length > 0) return;
    const locales = ep.catalog.allSubtitleLocales();
    if (!locales.size) return;
    const versions = [{ locale: 'ja-JP', guid: ep.jpGuid ?? null }];
    for (const loc of locales) {
      if (loc !== 'ja-JP') versions.push({ locale: loc, guid: null });
    }
    versions.sort((a, b) =>
      a.locale === 'ja-JP' ? -1 : b.locale === 'ja-JP' ? 1 : a.locale.localeCompare(b.locale));
    ep.catalog.setVersions(versions);
    sourceMenu.updateButtonVisibility();
    log.info(`Source picker (carried from JP data): ${versions.map(v => v.locale).join(', ')}`);
  }

  async function maybePrefetch() {
    const ep = currentEp();
    if (!ep) return;
    if (ep.prefetchTriggered || ep.jpCaptionUrl) return;
    const jpGuid = ep.getMappedJpGuid();
    if (!jpGuid) return;

    ep.markPrefetchTriggered();
    const auth = ep.capturedAuth ?? {};
    log.info(`Pre-fetching JP data (ep: ${ep.guid}, jp: ${jpGuid})`);
    let loaded = false;
    try {
      const jpData = await fetchAndCacheJpData(jpGuid, auth);
      if (ep.disposed) return;
      if (jpData?.jpRow) storeSessionSubs('ja-JP', jpData.jpRow);
      ensureVersionList(ep);  // populate the picker for this (possibly dub) episode
      if (jpData?.captionUrl || jpData?.subtitleUrl) {
        ep.setJpUrls(jpData.captionUrl ?? null, jpData.subtitleUrl ?? null);
        ep.setJpGuid(jpGuid);
        ep.setAuthHeaders(auth);
        setJpStatus(PROTOCOL.STATUS.READY);
        log.info('JP pre-loaded. Caption:', ep.jpCaptionUrl, '| Sub:', ep.jpSubtitleUrl);
        loaded = true;
        tryAutoActivate();
        onJpDataReady();
        backgroundValidateAll().catch(() => {});
      } else {
        log.warn('Pre-fetch: no EN URL — other subtitle languages may still be available.');
      }
    } catch (err) {
      log.warn('Pre-fetch error:', err);
    } finally {
      // Don't strand recovery: if this attempt didn't load JP (no auth yet, or a
      // transient failure on a rapid switch), release the latch so the settle
      // retry — or a later auth capture — can try again.
      if (!loaded && !ep.disposed) ep.clearPrefetchTriggered();
    }
  }

  // ── JP session fetch ───────────────────────────────────────────────────────
  async function releaseSession(jpGuid, token, authHeaders) {
    try {
      await originalFetch(
        `https://www.crunchyroll.com/playback/v1/token/${jpGuid}/${token}`,
        { method: 'DELETE', credentials: 'include', headers: authHeaders }
      );
      log.info('JP session released:', token);
    } catch (_) {}
  }

  async function fetchAndCacheJpData(jpGuid, authHeaders) {
    const ep = currentEp();
    const cached = ep?.getCachedJpData(jpGuid);
    if (cached && 'jpRow' in cached) {
      // If jpRow is empty but we have a subtitle URL, the cache was built before the
      // string-format URL fix. Invalidate once per session so the next visit re-fetches.
      const retryKey = 'crSubFix_jpRowRefreshed_' + jpGuid;
      if (Object.keys(cached.jpRow).length === 0 &&
          (cached.captionUrl || cached.subtitleUrl) &&
          !STORAGE.ssHas(retryKey)) {
        STORAGE.ssSet(retryKey, '1');
        ep?.evictCachedJpData(jpGuid);
        log.info(`Stale empty jpRow for ${jpGuid} — evicting cache for re-fetch.`);
        // Fall through to live fetch below
      } else {
        log.info('JP data from cache.');
        return cached;
      }
    }

    // Soft-fail contract (same as fetchSubUrlForSource): callers await this in
    // paths that must not reject — a thrown rejection would permanently stick
    // the button-click latch (clickInProgress) and the translate HUD.
    let data;
    try {
      const resp = await originalFetch(
        `https://www.crunchyroll.com/playback/v3/${jpGuid}/web/chrome/play`,
        { credentials: 'include', headers: authHeaders }
      );

      if (!resp.ok) {
        log.warn(`JP session fetch failed (${resp.status}).`);
        return { captionUrl: null, subtitleUrl: null, jpRow: {}, fetchFailed: true };
      }

      data = await resp.json();
    } catch (err) {
      log.warn('JP session fetch error:', err);
      return { captionUrl: null, subtitleUrl: null, jpRow: {}, fetchFailed: true };
    }
    if (data.token) releaseSession(jpGuid, data.token, authHeaders);

    const captionUrl  = PLAYBACK.pickEn(data.captions);
    const subtitleUrl = PLAYBACK.pickEn(data.subtitles);

    const jpRow = PLAYBACK.subtitleMap(data);

    log.info(`JP session subtitle locales [${Object.keys(jpRow).join(', ') || 'none'}]`);
    if (!captionUrl && !subtitleUrl)
      log.warn('JP session has no EN subtitle/caption track — other languages may still be available.');

    currentEp()?.setCachedJpData(jpGuid, captionUrl, subtitleUrl, jpRow);
    return { captionUrl, subtitleUrl, jpRow, fetchFailed: false };
  }

  // Lazily fetch the subtitle URL for a non-JP dub source.
  // Returns { url, fetchFailed, rateLimited }.
  async function fetchSubUrlForSource(guid, targetLocale, authHeaders) {
    const ep = currentEp();
    const cached = ep?.getCachedSrcUrl(guid, targetLocale);
    if (cached?.url) {
      log.info(`${targetLocale} sub URL from cache.`);
      return { url: cached.url, fetchFailed: false, rateLimited: false };
    }

    // A network/CORS error or a malformed JSON body would REJECT here.  Callers
    // (e.g. the wrong-title validation sweep) await this in a Promise.all and
    // rely on the documented { url, fetchFailed, rateLimited } shape, so a
    // throw would abort validation for every other locale.  Map any throw to a
    // soft fetchFailed instead.
    try {
      const resp = await originalFetch(
        `https://www.crunchyroll.com/playback/v3/${guid}/web/chrome/play`,
        { credentials: 'include', headers: authHeaders }
      );

      if (!resp.ok) {
        const rateLimited = resp.status === 429 || resp.status === 420;
        log.warn(`${targetLocale} session fetch failed (${resp.status}).`);
        return { url: null, fetchFailed: true, rateLimited };
      }

      const data = await resp.json();
      if (data.token) releaseSession(guid, data.token, authHeaders);

      const sessionSubs = PLAYBACK.subtitleMap(data);

      // Store the complete row in the catalog indexed by this session's audio locale.
      const sessionAudio = data.audioLocale ?? targetLocale;
      storeSessionSubs(sessionAudio, sessionSubs, PLAYBACK.captionLocales(data));
      log.info(`${sessionAudio} session subtitle locales [${Object.keys(sessionSubs).join(', ') || 'none'}]`);

      const url = sessionSubs[targetLocale] ?? null;
      if (url) currentEp()?.setCachedSrcUrl(guid, targetLocale, url);
      return { url, fetchFailed: false, rateLimited: false };
    } catch (e) {
      // A bare "Failed to fetch" during a background probe is benign and common
      // (ad blockers, a declined/rate-limited session, CORS) — log it at info so
      // it doesn't read as a warning; reserve warn for a genuinely unexpected
      // throw.  Either way the caller gets fetchFailed and the sweep continues.
      const benignNet = e instanceof TypeError && /failed to fetch/i.test((e && e.message) || '');
      (benignNet ? log.info : log.warn)(`${targetLocale} session fetch ${benignNet ? 'unavailable' : 'threw'}: ${e && e.message}`);
      return { url: null, fetchFailed: true, rateLimited: false };
    }
  }

  // ── DASH manifest swap ─────────────────────────────────────────────────────
  function swapVttInManifest(xml, jpCaptionUrl) {
    return xml.replace(
      /(<AdaptationSet[^>]*mimeType="text\/vtt"[^>]*>[\s\S]*?<BaseURL>)[^<]*([\s\S]*?<\/AdaptationSet>)/,
      (_, before, after) => `${before}${jpCaptionUrl}${after}`
    );
  }

  // "Hide official" path: remove every text/vtt AdaptationSet so Crunchyroll's
  // player has no subtitle track to fetch or render at all.  This is the only
  // reliable way to suppress CR's subs on the newer player, whose renderer lives
  // where our CSS/DOM suppression can't reach — our overlay becomes the sole
  // subtitle display.
  function blankVttInManifest(xml) {
    return xml.replace(
      /<AdaptationSet\b[^>]*mimeType="text\/vtt"[^>]*>[\s\S]*?<\/AdaptationSet>/g,
      ''
    );
  }

  // ── Subtitle parsing ──────────────────────────────────────────────────────
  // ASS / WebVTT parsers, color utils, and normalizeSubText all live in
  // lib/subtitle-parser.js — aliased near the top of this file.

  // ── Subtitle overlay ───────────────────────────────────────────────────────
  // Per-frame Cue render, overlay DOM lifecycle, and the cue-key cache live in
  // lib/cue-renderer.js.  This file owns the timeupdate dispatch and the style
  // context capture — both need access to settings + Episode, which the
  // renderer is deliberately ignorant of.

  // ── libass sign layer ──────────────────────────────────────────────────────
  // When enabled, \pos typeset signs are rendered by REAL libass (SubtitlesOctopus
  // in content.js) instead of our CSS overlay — so the 3-D typeset matches CR's
  // own server-side libass exactly.  We post a "signs-only" .ass (the active CR
  // source's raw file, filtered to \pos/\move Dialogue lines) across to content.js;
  // dialogue stays on the CSS renderer.  `_signRawAss` = the active source's raw
  // .ass — a CR locale's fetched file, an upload's own typeset signs, or an MT
  // record's translated signs (sign-less SRT/VTT uploads leave it null).
  let _signRawAss = null;
  // The secondary (dual-subtitle) track's raw .ass, so its typeset signs can be
  // shown instead of / alongside the primary's via the "Signs" selector.
  let _secondaryRawAss = null;
  // Whether that track actually carries \pos typeset signs — CR ships some
  // locales dialogue-only, in which case "Secondary"/"Both" have nothing to show.
  let _secondaryHasSigns = false;
  const isLibassSigns = () => { try { return localStorage.getItem('crSubFix_libass') !== '0'; } catch (_) { return true; } };

  // CJK detection (Hangul / Kana / CJK ideographs) — mirrors content.js.  libass
  // only has our bundled fonts, so CJK signs (e.g. machine-translated Simplified
  // Chinese) render as tofu boxes.  When the sign layer is CJK we keep libass
  // empty and draw the \pos signs on the CSS overlay instead, which uses the
  // viewer's system fonts (the same ones that already render CJK dialogue).
  const hasCJK = (s) => /[ᄀ-ᇿ　-ヿ㄰-鿿가-힯豈-﫿]/.test(s || '');
  let _signsViaCss = false;

  // Which track draws the typeset signs: 'primary' (default), 'secondary', or
  // 'both'.  Persisted cross-episode; only meaningful once a secondary track is
  // set.  'both' merges the two sign layers and CAN overlap where translated
  // signs share a \pos — an accepted tradeoff the user opts into.
  const SIGN_SRC_KEY = 'crSubFix_signsrc';
  const getSignSrcMode = () => { try { return localStorage.getItem(SIGN_SRC_KEY) || 'primary'; } catch (_) { return 'primary'; } };
  function setSignSrcMode(mode) {
    try { localStorage.setItem(SIGN_SRC_KEY, mode || 'primary'); } catch (_) {}
    pushSignLayer();
    renderer.invalidate();
    if (overlayActive) onTimeUpdate();
  }

  // buildSignsAss / extractSignTexts / rebuildSignsAss — the typeset-signs
  // projection of an .ass — live in lib/sign-track.js and are destructured at
  // the top of this file.

  // The signs .ass to push, per the selector.  'secondary'/'both' fall back to
  // the primary's signs when no secondary is loaded, so signs never vanish.
  // mergeSigns (dual signs) lives in lib/sign-track.js.
  function computeSignLayer() {
    const mode = getSignSrcMode();
    const pri = _signRawAss ? buildSignsAss(_signRawAss) : null;
    const sec = _secondaryRawAss ? buildSignsAss(_secondaryRawAss) : null;
    if (mode === 'secondary') return sec || pri;
    if (mode === 'both')      return mergeSigns(pri, sec, getSecondarySignGap());
    return pri;
  }

  function pushSignLayer() {
    let ass = null;
    _signsViaCss = false;
    try {
      // isShowSigns() gates the whole sign layer: when off, libass is cleared and
      // _signsViaCss stays false, so the CSS sign path (cssSignCues) draws nothing.
      if (isLibassSigns() && overlayActive && isShowSigns()) {
        const layer = computeSignLayer();
        // CJK sign layer → render on the CSS overlay (system fonts) instead of
        // libass (bundled fonts only).  Keep libass empty; onTimeUpdate draws
        // the \pos sign cues itself.
        if (layer && hasCJK(layer)) { _signsViaCss = true; ass = null; }
        else ass = layer;
      }
    } catch (_) {}
    // secHasSigns=false means the secondary locale's file is dialogue-only (no
    // \pos typeset) — common when CR typesets signs in the English track only.
    try { log.info(`Sign layer → ${ass ? ass.length + ' chars' : (_signsViaCss ? 'via CSS (CJK)' : 'cleared')} (libass=${isLibassSigns()} active=${overlayActive} mode=${getSignSrcMode()} pri=${_signRawAss ? _signRawAss.length : 0} sec=${_secondaryRawAss ? _secondaryRawAss.length : 0} secHasSigns=${_secondaryHasSigns} viaCss=${_signsViaCss})`); } catch (_) {}
    // Re-assert the toggle token on <html> first: CR's framework can strip our
    // custom data-* attribute during hydration, after which content.js reads a
    // null token and rejects every sign push.  Setting it right before the post
    // guarantees the isolated world sees a live, matching token.
    try { document.documentElement.setAttribute(PROTOCOL.ATTR.TOGGLE_TOKEN, TOGGLE_TOKEN); } catch (_) {}
    try { window.postMessage({ type: PROTOCOL.POST.SIGN_ASS, token: TOGGLE_TOKEN, ass }, window.location.origin); } catch (_) {}
  }
  function setSignSource(raw) { _signRawAss = raw || null; pushSignLayer(); }
  // Wrap overlayActive writes so the libass sign layer follows on/off (it shows
  // signs only while the overlay is active, and clears the moment it turns off).
  function setOverlayActive(v) { overlayActive = v; pushSignLayer(); if (v) maybeWarnHardsub(); }

  // ── Hardsub-stream detection ───────────────────────────────────────────────
  // The newer CR player ships subtitles BURNED INTO the video (a per-language
  // "hardsub" stream variant picked by the viewer's CR subtitle preference).
  // Burned pixels are the one thing subSuppression's DOM/CSS/TextTrack layers
  // can't touch, so a user with a CR subtitle language set sees CR's subs UNDER
  // ours.  The only remedy is the playback-JSON hardSubs strip (hide-official),
  // which applies on the next playback load — hence a reload.  Detection:
  // playback JSON gives the variant manifest URLs; a buffered PerformanceObserver
  // watches for the player fetching one (exact path match, query stripped).
  let _hardsubStream     = false;
  let _hardsubObs        = null;
  let _hardsubWarnedGuid = null;
  function stopHardsubWatch() {
    _hardsubObs?.disconnect();
    _hardsubObs = null;
  }
  function watchForHardsubStream(hardSubsMap) {
    _hardsubStream = false;
    // Always drop the previous episode's observer FIRST — even when this
    // episode declares no variants, the old observer's closure (old path set)
    // must not keep flagging streams for the new episode.
    stopHardsubWatch();
    const paths = Object.values(hardSubsMap ?? {})
      .map((v) => (typeof v === 'string' ? v : v?.url))
      .filter(Boolean)
      .map((u) => u.split('?')[0]);
    if (!paths.length) return;
    const set = new Set(paths);
    // Exact-path matches (from THIS episode's JSON) are safe against the whole
    // buffered history; the loose /hardsub/i fallback is only trusted for
    // entries fetched from now on — an old episode's hardsub segments in the
    // buffer must not flag the new episode's (possibly clean) stream.
    const t0 = performance.now();
    const test = (name, startTime) => {
      if (_hardsubStream) return;
      if (set.has(name.split('?')[0]) || (startTime >= t0 && /hardsub/i.test(name))) {
        _hardsubStream = true;
        stopHardsubWatch();  // verdict reached — no need to keep listening
        // The manifest fetch can land AFTER auto-activation — warn now, not
        // only at the next setOverlayActive(true).
        if (overlayActive) maybeWarnHardsub();
      }
    };
    try {
      performance.getEntriesByType('resource').forEach((e) => test(e.name, e.startTime));
      if (_hardsubStream) return;  // verdict from the buffer alone
      _hardsubObs = new PerformanceObserver((list) => list.getEntries().forEach((e) => test(e.name, e.startTime)));
      _hardsubObs.observe({ type: 'resource', buffered: true });
    } catch (_) {}
  }
  // Once per episode, when our overlay is up over a burned-in-subtitle stream:
  // offer the fix (turn on hide-official + reload) instead of silently drawing
  // a second subtitle band over Crunchyroll's.
  function maybeWarnHardsub() {
    const ep = currentEp();
    if (!ep || isHideOfficialSubs() || !_hardsubStream) return;
    if (_hardsubWarnedGuid === ep.guid) return;
    _hardsubWarnedGuid = ep.guid;
    showErrorToast(
      "Crunchyroll's subtitles are burned into this video stream.",
      () => { saveSetting('hideOfficialSubs', true); setTimeout(() => location.reload(), 400); },
      'Hide & reload'
    );
  }

  // Tracks whether a spoken (dialogue) line was on screen last tick, so study
  // auto-pause can fire exactly once on the showing→gap transition.
  let wasShowingLine = false;

  // ── Dual subtitles (secondary track) ──────────────────────────────────────
  // A second locale shown alongside the primary, chosen from the ▾ menu's
  // "Second subtitle" picker and persisted across episodes.  Tracks resolve via
  // the catalog's urlFor: usually the JP session row (same timeline as the
  // primary), or the dub's own CC for a same-language pick (natively timed to
  // the playing cut) — no remaster either way.
  const SECONDARY_PREF_KEY = 'crSubFix_secondary';
  const getSecondaryPref = () => { try { return localStorage.getItem(SECONDARY_PREF_KEY) || ''; } catch (_) { return ''; } };
  function setSecondaryPref(loc) {
    try { if (loc) localStorage.setItem(SECONDARY_PREF_KEY, loc); else localStorage.removeItem(SECONDARY_PREF_KEY); } catch (_) {}
  }
  // Lazily (re)load the secondary track when the pref, the Episode, or the
  // primary source changes.  Cheap no-op once in the desired state.  A secondary
  // that duplicates the active primary is dropped (no duplicate band) — both by
  // key (the default primary is normalized to 'ja-JP', matching the menu) and
  // by resolved URL, since a locale pick can resolve to the very file the
  // primary renders (e.g. same-language picks on a dub session without a CC).
  let _secState = { guid: null, want: null, primary: null };
  // Bounded-retry guard for the async secondary fetch.  _secState is committed
  // synchronously (so we never run two fetches for the same target at once), but
  // a transient empty/failed fetch must NOT strand the band empty forever — nor
  // fetch-storm.  On failure we allow a couple of retries on later ticks, then
  // give up; a success resets it.
  let _secFail = { key: null, tries: 0 };
  function setSecondaryRaw(raw) {
    _secondaryRawAss   = raw || null;
    _secondaryHasSigns = !!(_secondaryRawAss && buildSignsAss(_secondaryRawAss));
    pushSignLayer();
  }
  function maybeLoadSecondary(ep) {
    const want    = getSecondaryPref();
    // null = the default JP-session source — normalize so `want === primary`
    // catches a 'ja-JP' secondary against the default primary (the menu
    // normalizes the same way when it excludes the primary from the list).
    const primary = ep.activeSource() ?? 'ja-JP';
    if (_secState.guid === ep.guid && _secState.want === want && _secState.primary === primary) {
      // A committed duplicate-drop (dupBase) holds only while `want` still
      // resolves to the dropped file.  The catalog can grow under an unchanged
      // guid/want/primary key — a JP-first race or an in-place dub switch
      // records the dub's CC row later — and the band must load then.
      if (!_secState.dupBase) return;
      const nowUrl = want === 'ja-JP' ? (ep.jpCaptionUrl || ep.jpSubtitleUrl) : getSubtitleUrl(want);
      if (!nowUrl || subUrlBase(nowUrl) === _secState.dupBase) return;
      // fall through — `want` now resolves to a different file; re-evaluate
    }
    const prev = _secState;
    _secState = { guid: ep.guid, want, primary };
    if (!want || want === primary) { ep.setSecondaryCues([]); setSecondaryRaw(null); renderer.invalidate(); return; }
    // Custom sources (uploads / machine translations) are already in memory, so
    // load synchronously from the registry — no fetch, no extra MT quota spent.
    // Their signRawAss carries any signs (MT translates them; uploads keep theirs).
    if (isCustomId(want)) {
      const rec = ep.getCustomSource(want);
      ep.setSecondaryCues(rec ? applyCustomSync(rec) : []);
      setSecondaryRaw(rec?.signRawAss || null);
      renderer.invalidate();
      return;
    }
    // A pure primary-source change (same episode, same want) keeps the cues.
    if (prev.guid === ep.guid && prev.want === want && ep.secondaryCues.length) return;
    ep.setSecondaryCues([]);                          // clear stale while loading
    const reqKey = ep.guid + '|' + want;
    // Empty/failed fetch: re-open _secState so a later tick retries, but cap the
    // attempts so a dialogue-only/absent/404 locale converges instead of looping.
    const retryOrGiveUp = () => {
      if (_secFail.key === reqKey && _secFail.tries >= 2) return;   // give up — keep _secState committed
      _secFail = { key: reqKey, tries: (_secFail.key === reqKey ? _secFail.tries : 0) + 1 };
      _secState = { guid: null, want: null, primary: null };        // re-evaluate next tick
    };
    fetchCuesForLocale(ep, want).then((r) => {
      if (ep.disposed || currentEp() !== ep) return;
      if (getSecondaryPref() !== want) return;        // changed again mid-fetch
      // Primary may have been switched to `want` while the fetch was in
      // flight — committing would double every line, and the memo key would
      // then read as satisfied and never re-evaluate.
      if (want === (ep.activeSource() ?? 'ja-JP')) { ep.setSecondaryCues([]); setSecondaryRaw(null); renderer.invalidate(); return; }
      const cues = r?.cues ?? [];
      if (!cues.length) { ep.setSecondaryCues([]); setSecondaryRaw(null); retryOrGiveUp(); renderer.invalidate(); return; }
      // The pick resolved to the very file the primary is rendering — showing
      // it again would just double every line.  Drop it, but remember WHICH
      // file was dropped (dupBase): the memo check at the top of this function
      // re-opens the state the moment `want` resolves to a different file.
      // A successful fetch also wipes the failure budget.
      if (r.url && ep.activeSubUrl && subUrlBase(r.url) === subUrlBase(ep.activeSubUrl)) {
        _secFail = { key: null, tries: 0 };
        if (_secState.guid === ep.guid && _secState.want === want) {
          _secState = { ..._secState, dupBase: subUrlBase(r.url) };
        }
        ep.setSecondaryCues([]); setSecondaryRaw(null); renderer.invalidate();
        return;
      }
      _secFail = { key: null, tries: 0 };
      ep.setSecondaryCues(cues);
      setSecondaryRaw(r?.rawText || null);             // for the "Signs" selector
      renderer.invalidate();
      onTimeUpdate();
    }).catch(() => {
      if (ep.disposed) return;
      ep.setSecondaryCues([]); setSecondaryRaw(null);
      retryOrGiveUp();
    });
  }
  function selectSecondary(locale) {
    setSecondaryPref(locale || '');
    const ep = currentEp();
    if (!ep) return;
    _secState = { guid: null, want: null, primary: null };  // force re-evaluate
    _secFail  = { key: null, tries: 0 };                    // fresh attempts for an explicit pick
    maybeLoadSecondary(ep);
    renderer.invalidate();
    if (overlayActive) onTimeUpdate();
  }

  // ── Learning mode (audio-matched primary + your-language secondary) ─────────
  // The "watch & learn" study layout in one tap: the language being SPOKEN on
  // top (matched to the episode's audio), the viewer's own language stacked
  // beneath.  The primary is matched to the audio automatically; the support
  // ("native") language is picked once and persists across episodes.  The
  // audio-match / fallback decision is the pure planLearningMode() in
  // lib/subtitle-catalog.js; everything here is the DOM/Episode wiring.
  const NATIVE_PREF_KEY = 'crSubFix_native';
  const getNativePref = () => {
    try { const v = localStorage.getItem(NATIVE_PREF_KEY); if (v) return v; } catch (_) {}
    let ui = 'en-US';
    try { ui = navigator.language || 'en-US'; } catch (_) {}
    return LEARN.defaultNativeLocale(ui);
  };
  const setNativePref = (loc) => { try { if (loc) localStorage.setItem(NATIVE_PREF_KEY, loc); } catch (_) {} };

  // Label for an AUDIO locale.  LOCALE_LABELS maps ja-JP to "English (Japanese
  // source)" — right for the ja-JP SUBTITLE source row, but wrong as an audio
  // language name — so spell out Japanese audio explicitly.
  function audioLabel(loc) {
    if (loc === 'ja-JP') return 'Japanese';
    return LOCALE_LABELS[loc] ?? loc;
  }

  // What the "Learning mode" submenu shows: the episode's audio language and
  // whether a subtitle in that language exists on this episode (else the menu
  // tells the user it can't match the audio).
  // Subtitle availability for a locale on this episode (availability() is
  // false only when there's neither a URL nor a session guid to fetch one
  // from; ja-JP is owned by the JP-first fetch, mirroring the menu's
  // localeHasContent).
  function localeHasSub(ep, loc) {
    if (!ep || !loc) return false;
    if (loc === 'ja-JP') return !!(ep.jpCaptionUrl || ep.jpSubtitleUrl || ep.jpGuid);
    return ep.catalog.availability(loc) !== false;
  }

  function learningInfo() {
    const ep = currentEp();
    const audio = ep ? ep.catalog.currentAudio() : null;
    // Subtitle availability, not dub presence: versions() lists every audio
    // dub, so checking it was vacuously true for the playing dub and the
    // "can't match your audio" fallback could never render.
    const hasSub = !!(ep && audio && localeHasSub(ep, audio));
    const native = getNativePref();
    return {
      audioLocale: audio || '',
      audioLabel:  audio ? audioLabel(audio) : '',   // ja-JP audio = "Japanese", not the sub-row label
      audioHasSub: hasSub,
      native,
      // Whether the viewer's language is actually on THIS episode — so the CTA
      // doesn't promise a second band ("with Deutsch below") that can't load.
      nativeAvailable: !!(ep && native && localeHasSub(ep, native)),
    };
  }

  function applyLearningMode(nativeLocale) {
    const ep = currentEp();
    if (!ep) return;
    if (nativeLocale) setNativePref(nativeLocale);
    const native  = nativeLocale || getNativePref();
    const audio   = ep.catalog.currentAudio();
    // planLearningMode expects SUBTITLE locales; filter the version list down
    // to what's actually pickable so the audio-match promise is honest.
    const locales = ep.catalog.versions().map((v) => v.locale)
      .filter((l) => localeHasSub(ep, l));
    const plan    = LEARN.planLearningMode({ audioLocale: audio, locales, native });
    markLearnHintSeen();   // an explicit pick means the feature's been found
    // Set the primary first (it (re)activates the overlay), then the secondary,
    // so maybeLoadSecondary keys off the freshly-set primary.
    if (plan.primary) selectSource(plan.primary);
    selectSecondary(plan.secondary || '');
    if (plan.audioMatched) {
      log.info(`Learning mode: primary=[${plan.primary}] secondary=[${plan.secondary}] nativeAvail=${plan.nativeAvailable}.`);
      // Audio matched but the viewer's language isn't on this episode — the
      // stack degrades to the spoken-language sub alone; say so instead of
      // leaving them wondering where the second band went.
      if (!plan.nativeAvailable && native) {
        UI.showToast({ host: toastHost(), text: t("{native} isn't available on this episode — showing {audio} only", { native: t(LOCALE_LABELS[native] ?? native), audio: t(audioLabel(audio)) }), duration: 4000 });
      }
    } else {
      log.info(`Learning mode: no audio-matched sub (audio=[${audio || '?'}]) — primary=[${plan.primary}].`);
      if (audio && !locales.includes(audio)) {
        UI.showToast({ host: toastHost(), text: t('No {audio} subtitles for this episode — showing your language only', { audio: t(audioLabel(audio)) }), duration: 4000 });
      }
    }
  }

  // One-shot contextual onboarding.  When the audio is in a language the viewer
  // is plausibly learning (≠ their UI language) AND this episode has a matching
  // subtitle, nudge them toward the stacked study layout.  Shown at most once.
  const LEARN_HINT_KEY = 'crSubFix_seenLearnHint';
  function markLearnHintSeen() { try { localStorage.setItem(LEARN_HINT_KEY, '1'); } catch (_) {} }
  function maybeShowLearnHint() {
    if (!isEnabled()) return;
    try { if (localStorage.getItem(LEARN_HINT_KEY)) return; } catch (_) { return; }
    const ep = currentEp();
    const audio = ep && ep.catalog.currentAudio();
    if (!audio) return;
    const native = getNativePref();
    if (audio === native) return;                                       // no learning gap
    if (!ep.catalog.versions().some((v) => v.locale === audio)) return; // no audio-matched sub
    markLearnHintSeen();
    UI.showToast({
      host:     toastHost(),
      text:     t('Learning {audio}? Show {audio} + {native} subtitles together — ▾ menu › 📚 Learning mode', { audio: t(audioLabel(audio)), native: t(audioLabel(native)) }),
      duration: 8000,
    });
  }

  // Which \pos sign cues the CSS overlay should draw (when libass is off, or for
  // the CJK fallback), mirroring the "Signs" selector's primary/secondary/both.
  function cssSignCues(priCues, secCues) {
    if (!isShowSigns()) return [];   // signs hidden — draw none on the CSS overlay
    const mode = getSignSrcMode();
    const pri = priCues.filter((c) => c.pos);
    const sec = secCues.filter((c) => c.pos);
    if (mode === 'secondary') return sec.length ? sec : pri;
    if (mode === 'both') {
      // Lift the secondary signs above the primary so they don't overlap (the
      // "Both" sign-gap slider — % of video height, via the cue's PlayResY).
      const gap = getSecondarySignGap();
      const lifted = gap
        ? sec.map((c) => ({ ...c, pos: { x: c.pos.x, y: c.pos.y - (gap / 100) * (c.playResY || 360) } }))
        : sec;
      return pri.concat(lifted);
    }
    return pri;
  }

  function onTimeUpdate() {
    if (!overlayActive || !videoEl) return;
    const ep = currentEp();
    if (!ep) return;
    maybeLoadSecondary(ep);
    syncTimingForEp(ep);
    const offset  = priOffset();          // primary band (dialogue + signs)
    const secOff  = secOffset();          // secondary band, nudged independently
    const t = videoEl.currentTime;
    const priAll = ep.cuesAt(t, offset);
    const secAll = ep.secondaryCues.length ? ep.secondaryCuesAt(t, secOff) : [];
    // isShowDialogue() hides just the primary spoken-line band (signs + the
    // secondary track keep their own visibility).  With dialogue hidden there's
    // no line on screen, so study auto-pause below naturally won't fire.
    const dialogue = isShowDialogue() ? priAll.filter((c) => !c.pos) : [];

    // Study mode: pause the instant a dialogue line finishes.  We act only on
    // the showing→gap transition, and timeupdate stops firing once paused, so it
    // can't loop; on the transition we SKIP the empty render so the just-ended
    // line stays readable while paused.
    const showingLine = dialogue.length > 0;
    if (wasShowingLine && !showingLine && isAutoPauseLine() && !videoEl.paused) {
      wasShowingLine = false;
      videoEl.pause();
      return;  // leave the last line on screen
    }
    wasShowingLine = showingLine;

    // libass owns the \pos signs UNLESS they're routed to CSS (CJK fallback) or
    // libass is off — then the CSS overlay draws them (system fonts), per the
    // sign-source mode.
    const cssCues = (isLibassSigns() && !_signsViaCss)
      ? dialogue
      : dialogue.concat(cssSignCues(priAll, secAll));

    const secDialogue = secAll.filter((c) => !c.pos);
    renderer.render(cssCues, t + offset, captureStyleCtxs(), secDialogue.length ? secDialogue : null);
  }

  // ── Study hotkeys: replay / copy the line on screen ───────────────────────
  // Seek to the start of the most recent dialogue line — "wait, what did they
  // say?" and shadowing.  Repeated presses step back line-by-line: the 0.4 s
  // epsilon makes a press from mid-line jump to THIS line's start, then to the
  // previous one.  Compares in cue-time (videoTime + the display offset).
  function replayLine() {
    const ep = currentEp();
    if (!ep || !videoEl) return;
    const cues = ep.remasteredCues ?? ep.originalCues;
    if (!cues || !cues.length) return;
    syncTimingForEp(ep);
    const offset = priOffset();
    const now = videoEl.currentTime + offset;
    let target = cues[0].start;
    for (let i = cues.length - 1; i >= 0; i--) {
      if (cues[i].start < now - 0.4) { target = cues[i].start; break; }
    }
    try { videoEl.currentTime = Math.max(0, target - offset); } catch (_) {}
    if (videoEl.paused) videoEl.play().catch(() => {});
    wasShowingLine = false;  // re-arm study auto-pause for the replayed line
  }

  // Copy the dialogue currently on screen (dictionary lookup, study decks,
  // quoting a line).  Reads the live active cues; dialogue only, not signs.
  async function copyActiveLine() {
    const ep = currentEp();
    if (!ep || !videoEl) return;
    syncTimingForEp(ep);
    const offset = priOffset();
    const text = ep.cuesAt(videoEl.currentTime, offset)
      .filter((c) => !c.pos)
      .map((c) => c.text)
      .join('\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
    if (!text) { UI.showToast({ host: toastHost(), text: 'No subtitle line right now' }); return; }
    try {
      await navigator.clipboard.writeText(text);
      UI.showToast({ host: toastHost(), text: 'Copied subtitle line' });
    } catch (_) {
      UI.showToast({ host: toastHost(), text: 'Could not copy to clipboard' });
    }
  }

  // Race fix: the first paint after toggling JP CC on can land BEFORE
  // content.js's async chrome.storage.local.get → SETTINGS.writeAttrs
  // has populated the data-cr-* attributes.  When that happens,
  // captureStyleCtx reads schema defaults and the cue-key cache then
  // suppresses re-renders until the user moves a slider (which
  // triggers a fresh attribute write via the popup → content.js flow).
  //
  // Paint once now, then re-render a few times over the next ~half
  // second so any in-flight attribute writes land before the user
  // notices.  Each retry is cheap: invalidate + capture + render.
  let _catchupTimers = [];
  function paintWithSettingsCatchup() {
    // Cancel any in-flight catch-up first: rapid dub/source switches would
    // otherwise stack multiple 8-pass bursts, each forcing full repaints.
    _catchupTimers.forEach(clearTimeout);
    invalidateStyleCtx();   // this burst's whole point is to re-read late attribute writes
    onTimeUpdate();
    // Retries extended to 2.5s with more intermediate points — covers
    // slow cold-start storage roundtrips that the previous 500ms ceiling
    // could miss.  Each pass re-reads attributes (invalidateStyleCtx) so a
    // late write lands, then repaints the visible cues.
    _catchupTimers = [16, 80, 200, 400, 700, 1100, 1700, 2500].map(delay => setTimeout(() => {
      if (overlayActive) { renderer.invalidate(); invalidateStyleCtx(); onTimeUpdate(); }
    }, delay));
  }

  // Seeking into the MIDDLE of a line must show it immediately — timeupdate
  // alone can leave the band empty until the next cue boundary after a seek
  // (notably while paused, where timeupdate stops firing).  cuesAt() is
  // stateless, so one explicit repaint on 'seeked' is the whole fix.
  const onVideoSeeked = () => onTimeUpdate();
  // Paused → dialogue bands become text-selectable (flashcards, dictionary
  // lookups); playing → pointer-transparent again so subtitle clicks reach
  // Crunchyroll's pause layer.  See cue-renderer setSelectable.
  const onVideoPause = () => renderer.setSelectable(true);
  const onVideoPlay  = () => renderer.setSelectable(false);

  function startSync() {
    if (!videoEl) return;
    videoEl.addEventListener('timeupdate', onTimeUpdate);
    videoEl.addEventListener('seeked', onVideoSeeked);
    videoEl.addEventListener('pause',  onVideoPause);
    videoEl.addEventListener('play',   onVideoPlay);
    renderer.setSelectable(videoEl.paused);  // activated while already paused
    document.addEventListener('fullscreenchange', onFullscreenChange);
  }

  function stopSync() {
    if (videoEl) {
      videoEl.removeEventListener('timeupdate', onTimeUpdate);
      videoEl.removeEventListener('seeked', onVideoSeeked);
      videoEl.removeEventListener('pause',  onVideoPause);
      videoEl.removeEventListener('play',   onVideoPlay);
    }
    renderer.setSelectable(false);
    document.removeEventListener('fullscreenchange', onFullscreenChange);
    renderer.hide();
    // Clearing remaster state on stopSync forces a fresh anchor map calculation
    // on the next activation — preserves the existing behaviour where toggling
    // off and back on after a navigation can re-discover bridge timing.
    currentEp()?.clearRemaster();
  }

  function onFullscreenChange() {
    sourceMenu.close();
    closeSyncPanel();
    closeTranslatePanel();
    closeTypesetTunePanel();
    closeTimingPanel();
    const fsEl = document.fullscreenElement;
    renderer.reparentForFullscreen(fsEl);

    if (!buttonInControls) {
      const btn    = document.getElementById(BTN_ID);
      const btnTgt = fsEl ?? document.body ?? document.documentElement;
      if (btn && btn.parentElement !== btnTgt) btnTgt.appendChild(btn);
    }

    renderer.reposition();
  }

  // ── Toasts ────────────────────────────────────────────────────────────────
  // The DOM-level toast primitive lives in lib/overlay-ui.js.  These wrappers
  // just supply each toast's text, colour theme, and parent.

  const EN_LOCALES_SET = new Set(['ja-JP', 'en-US', 'en-GB', 'en']);
  function showLanguageToast(nativeLocale) {
    if (!nativeLocale || EN_LOCALES_SET.has(nativeLocale)) return;
    const label = LOCALE_LABELS[nativeLocale] ?? nativeLocale;
    UI.showToast({ host: renderer.element ?? document.body, text: t('{language} subtitles', { language: label }) });
  }

  function toastHost() {
    return document.fullscreenElement ?? renderer.element?.parentElement ?? videoEl?.parentElement ?? document.body;
  }

  function showRateLimitToast() {
    UI.showToast({
      host:        toastHost(),
      text:        'Rate limited — please try again in a moment',
      color:       'rgba(255,180,50,0.8)',
      borderColor: 'rgba(255,180,50,0.2)',
      fontWeight:  '400',
      duration:    2500,
      zIndex:      2147483641,
    });
  }

  function showNoSubsToast() {
    UI.showToast({
      host:        toastHost(),
      text:        'No subtitle track available for this source',
      color:       'rgba(255,255,255,0.55)',
      borderColor: 'rgba(255,255,255,0.1)',
      fontWeight:  '400',
      duration:    2200,
      zIndex:      2147483641,
    });
  }

  // Actionable error toast with a Retry button.  Used by handleButtonClick
  // when subtitle activation fails — the user can re-trigger the flow
  // without navigating to the button.  Auto-dismisses after 10 s.  Only
  // one toast at a time: dropping a fresh error replaces any pending one.
  let _errorToast = null;
  function showErrorToast(text, onRetry, actionLabel) {
    if (_errorToast) { try { _errorToast.remove(); } catch (_) {} _errorToast = null; }
    const host = toastHost();
    if (!host) return;
    if (host !== document.body && window.getComputedStyle(host).position === 'static') {
      host.style.position = 'relative';
    }
    const toast = document.createElement('div');
    Object.assign(toast.style, {
      position:      'absolute',
      bottom:        '12%',
      left:          '50%',
      transform:     'translateX(-50%)',
      background:    THEME.panelBg,
      color:         THEME.text,
      fontSize:      '12px',
      fontFamily:    THEME.font,
      fontWeight:    '500',
      padding:       '6px 8px 6px 14px',
      borderRadius:  '20px',
      border:        `1px solid ${THEME.panelEdge}`,
      zIndex:        '2147483641',
      display:       'flex',
      alignItems:    'center',
      gap:           '10px',
      pointerEvents: 'auto',
      opacity:       '1',
      transition:    'opacity 0.5s ease',
      letterSpacing: '0',
      maxWidth: 'calc(100% - 24px)',
      boxSizing: 'border-box',
      overflowWrap: 'anywhere',
      flexWrap: 'wrap',
    });
    const span = document.createElement('span');
    uiText(span, text);
    const btn = document.createElement('button');
    uiText(btn, actionLabel || 'Retry');
    Object.assign(btn.style, {
      background:   THEME.accent,
      color:        THEME.accentText,
      border:       '0',
      borderRadius: '12px',
      padding:      '3px 10px',
      fontSize:     '11px',
      fontWeight:   '700',
      fontFamily:   'inherit',
      cursor:       'pointer',
      letterSpacing: '0.4px',
    });
    const dismiss = () => {
      clearTimeout(timer);
      if (toast.parentElement) {
        toast.style.opacity = '0';
        setTimeout(() => { try { toast.remove(); } catch (_) {} }, 500);
      }
      if (_errorToast === toast) _errorToast = null;
    };
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      dismiss();
      try { onRetry?.(); } catch (_) {}
    });
    toast.appendChild(span);
    toast.appendChild(btn);
    host.appendChild(toast);
    _errorToast = toast;
    const timer = setTimeout(dismiss, 10000);
  }

  // ── Per-render style context ────────────────────────────────────────────────
  // Batches all data-attribute reads into one object per render call.  The
  // renderer treats this as opaque input — it doesn't know about SETTINGS,
  // hexToRgba, or sanitizeFontFamily.
  // Build a style context for one profile.  prefix '' = dialogue (the keys
  // above), prefix 'sign_' = the typeset-sign profile (sign_* keys).  Returns
  // {override:false} when that profile's override is off — for signs that means
  // "match original" (native ASS style); for dialogue it's the default outlined
  // rendering.
  function captureStyleCtx(prefix) {
    prefix = prefix || '';
    const read = (base) => SETTINGS.read(html, prefix + base);
    if (!read('styleOverride')) return { override: false };
    return {
      override: true,
      color:    hexToRgba(read('overrideTextColor'), read('overrideTextOpacity') / 100),
      font:     sanitizeFontFamily(read('overrideFontFamily')),
      bgBox:     read('overrideBgBox'),
      bgCss:     hexToRgba(read('overrideBgColor'), read('overrideBgOpacity') / 100),
      bgRadius:  read('overrideBgRadius'),
      bgPadX:    read('overrideBgPaddingX'),
      bgPadY:    read('overrideBgPaddingY'),
      bgGlass:   read('overrideBgGlass'),
      bgBlur:    read('overrideBgGlassBlur'),
      bgSat:     read('overrideBgGlassSat'),
      bgHue:     read('overrideBgGlassHue'),
      outline:  read('overrideOutlineColor'),
      bord:     read('overrideBord'),
      shad:     read('overrideShad'),
      soft:     read('overrideShadStyle') === 'soft',
      shadOp:   read('overrideShadOpacity') / 100,
    };
  }
  // Both profiles, threaded to the renderer each frame: dialogue cues use
  // .dialogue, \pos typeset signs use .signs.
  //
  // Memoized: captureStyleCtx does ~20 data-attribute reads/parses per profile,
  // but the result only changes when a data-cr-* attribute changes — which the
  // settings MutationObserver below already watches.  So build the context once
  // and hand back the SAME object until invalidateStyleCtx() is called, rather
  // than re-reading the DOM on every timeupdate (~4-10×/sec) BEFORE the
  // renderer's cue-key cache has even decided whether to repaint.  Returning a
  // stable reference also lets the renderer skip re-stringifying it (see its
  // ctxKey memo).
  let _styleCtxCache = null;
  const invalidateStyleCtx = () => { _styleCtxCache = null; };
  const captureStyleCtxs = () =>
    _styleCtxCache || (_styleCtxCache = { dialogue: captureStyleCtx(''), signs: captureStyleCtx('sign_') });

  // ── Native subtitle suppression ────────────────────────────────────────────
  // The four-layer strategy that hides Crunchyroll's own subtitle renderer while
  // our overlay is active lives in lib/sub-suppression.js.  Public surface:
  // activate(videoEl) / deactivate() / isActive().  OVERLAY_ID is injected so the
  // suppression selectors never hide our own overlay.
  const subSuppression = NS.createSubSuppression({ overlayId: OVERLAY_ID });

  // Native suppression is wanted in two independent cases: while our overlay is
  // showing (so Crunchyroll's own track doesn't render under ours), or whenever
  // the user has opted to always hide Crunchyroll's subtitles ("switch to None").
  // Reconcile both inputs through one helper so toggling either can't strand the
  // other — and bail on no-op transitions so rapid settings writes (slider
  // drags) don't churn the suppression teardown each frame.
  function syncSubSuppression() {
    const want = !!(videoEl && isEnabled() && (overlayActive || isHideOfficialSubs()));
    if (want === subSuppression.isActive()) return;
    if (want) subSuppression.activate(videoEl);
    else      subSuppression.deactivate();
  }

  // ── Button ─────────────────────────────────────────────────────────────────

  function getSourceShortLabel() {
    const loc = currentEp()?.activeSource() ?? 'ja-JP';
    if (isCustomId(loc)) {
      return currentCustomSource()?.kind === 'mt' ? 'MT' : 'FILE';
    }
    return LOCALE_SHORT[loc] ?? loc.slice(0, 2).toUpperCase();
  }

  // Enforce a brief, visible 'loading' → 'active' flash so a dub switch always
  // shows a "preparing → ready" cue, even when JP loads instantly from cache.
  // Any other state cancels a pending flash.  The deferred apply re-reads the
  // live button (it may have been re-injected) and only commits 'active' if the
  // overlay is actually on.
  const MIN_FLASH_MS = 400;
  let _flashAt = 0, _flashTimer = null;
  function setButtonState(btn, state) {
    if (_flashTimer) { clearTimeout(_flashTimer); _flashTimer = null; }
    if (state === 'loading') { _flashAt = Date.now(); applyButtonState(btn, 'loading'); return; }
    if (state === 'active' && _flashAt) {
      const remain = MIN_FLASH_MS - (Date.now() - _flashAt);
      if (remain > 0) {
        applyButtonState(btn, 'loading');
        _flashTimer = setTimeout(() => {
          _flashTimer = null; _flashAt = 0;
          const b = document.getElementById(BTN_ID);
          if (b && overlayActive) applyButtonState(b, 'active');
        }, remain);
        return;
      }
    }
    _flashAt = 0;
    applyButtonState(btn, state);
  }

  function applyButtonState(btn, state) {
    btn.dataset.state = state;
    const lbl = getSourceShortLabel();
    // Remaster sync status is exposed on the popup status detail line
    // ("Synced") so the button itself stays clean — just locale + ✓.
    // Borderless: idle sits quietly in the player's own text colour and only
    // lights up in our accent when active — so it reads as native chrome that
    // happens to be ours, not a boxed add-on.
    const S = {
      idle:    { text: 'B-SUB',      bg: 'transparent',     color: THEME.text     },
      loading: { text: `${lbl}…`,    bg: 'transparent',     color: THEME.textDim  },
      active:  { text: `${lbl} ✓`,   bg: THEME.accentTint,  color: THEME.accent   },
      error:   { text: 'B-SUB ✗',    bg: 'transparent',     color: THEME.danger   },
      reload:  { text: '↻ Reload',   bg: 'transparent',     color: THEME.info     },
      unavail: { text: 'No subs',    bg: 'transparent',     color: THEME.textMuted},
    };
    const s = S[state] ?? S.idle;
    btn.textContent      = t(s.text);
    btn.style.background = s.bg;
    btn.style.color      = s.color;
  }

  function refreshButtonLabel() {
    const btn = document.getElementById(BTN_ID);
    if (btn && btn.dataset.state === 'active') setButtonState(btn, 'active');
    // Remaster completion / source switch routes through here too.
    updateActiveInfo();
  }

  // ── Source picker menu ────────────────────────────────────────────────────
  // The picker button + dropdown live in lib/source-menu.js.  The instance is
  // created near the top of this file with onSelectLocale / onTurnOff
  // callbacks; everything DOM-side is owned by the module.

  /**
   * Subtitle pipeline: fetch → parse → duration-validate → maybe-replace.
   *
   * Takes a resolved subtitle URL and lang, returns either render-ready cues or
   * a structured failure outcome.  Side effects on the Episode (originalCues,
   * raw-text cache, validation status) happen behind this seam — the caller
   * doesn't need to know the cache key shape, the parse vs validate split, or
   * the replacement-probe procedure.
   *
   * onScanning(lang) is fired when a duration mismatch is detected and the
   * pipeline is about to scan alternate sessions for a working copy.  The HUD
   * uses this to tell the user the wait is intentional — the scan can take
   * several seconds.
   *
   * Outcomes:
   *   { ok: true,  cues, finalUrl, lang, replacedFrom? }
   *     cues are render-ready; finalUrl may differ from input when a
   *     replacement was found in another session (replacedFrom names it).
   *   { ok: false, kind: 'fetch-failed', lang, status }   // HTTP error
   *   { ok: false, kind: 'fetch-error',  lang, message }  // network throw
   *   { ok: false, kind: 'empty',        lang }           // parsed 0 cues
   *   { ok: false, kind: 'wrong-title',  lang }           // duration short, no replacement
   */
  async function loadSubtitleCues(url, lang, ep, onScanning) {
    let rawText = ep.getCachedRawText(url);
    if (rawText) {
      log.info('Subtitle text from session cache.');
    } else {
      let resp;
      try {
        resp = await originalFetch(url);
      } catch (err) {
        return { ok: false, kind: 'fetch-error', lang, message: String(err) };
      }
      if (!resp.ok) return { ok: false, kind: 'fetch-failed', lang, status: resp.status };
      rawText = await resp.text();
      ep.setCachedRawText(url, rawText);
    }

    let cues = parseSubtitles(rawText, url);
    ep.setOriginalCues(cues);
    setSignSource(rawText);  // hand the \pos typeset signs to libass (no-op for VTT / sign-less)
    const fmt = rawText.trimStart().startsWith('[Script Info]') ? 'ASS' : 'VTT';
    log.info(`Parsed ${cues.length} cues (${fmt}).`);

    if (cues.length === 0) return { ok: false, kind: 'empty', lang };

    const verdict = validateSubDuration(cues);
    if (verdict === 'short') {
      const subEnd = cues.reduce((m, c) => Math.max(m, c.end), 0);
      const gap    = Math.round(videoEl.duration - subEnd);
      log.warn(
        `Sub validation: [${lang}] ends ${gap}s before video ` +
        `(sub=${Math.round(subEnd)}s vid=${Math.round(videoEl.duration)}s) — likely wrong title.`
      );

      onScanning?.(lang);

      const replacement = await tryAlternateSession(lang);
      if (replacement) {
        const badUrl = url;
        cues = replacement.cues;
        url  = replacement.url;
        ep.setOriginalCues(cues);
        ep.setCachedRawText(url, ep.getCachedRawText(url) ?? '');
        ep.catalog.setValidation(lang, 'ok');
        // Point the catalog at the good copy too: otherwise the next playback
        // response computes urlFor() from the stale bad URL, sees it differ
        // from what's loaded, and the "Audio changed → reloading" block
        // bounces between the two on every playback refresh.
        ep.catalog.replaceUrl(lang, badUrl, url);
        log.info(
          `Sub validation: replaced [${lang}] with copy from [${replacement.fromSession}] session.`
        );
        return { ok: true, cues, finalUrl: url, lang, replacedFrom: replacement.fromSession };
      }
      ep.catalog.setValidation(lang, 'wrong-title');
      return { ok: false, kind: 'wrong-title', lang };
    }

    if (!ep.catalog.hasValidation(lang)) ep.catalog.setValidation(lang, 'ok');
    return { ok: true, cues, finalUrl: url, lang };
  }

  async function handleButtonClick(btn) {
    if (clickInProgress) return;

    if (btn.dataset.state === 'reload') {
      location.reload();
      return;
    }

    if (btn.dataset.state === 'unavail') return;

    const ep = currentEp();
    if (!ep) return;

    if (overlayActive) {
      if (currentCustomSource()?.kind === 'external') {
        rpc('external-active', { guid: ep.guid, id: '' });
      }
      setOverlayActive(false);
      ep.setActiveSubUrl(null);
      stopSync();
      syncSubSuppression();   // keep CR subs hidden if "hide official" is on
      setButtonState(btn, 'idle');
      setJpStatus(PROTOCOL.STATUS.READY);
      return;
    }

    if (ep.hasCues()) {
      setOverlayActive(true);
      syncSubSuppression();
      setButtonState(btn, 'active');
      setJpStatus(PROTOCOL.STATUS.ACTIVE);
      startSync();
      paintWithSettingsCatchup();
      return;
    }

    clickInProgress = true;
    setButtonState(btn, 'loading');

    // Determine subtitle URL for the active source.
    // activeSource null/'ja-JP' → use JP session (fetched separately).
    // Any other locale → look up via the catalog (already cached from a captured session — no extra API call).
    let subUrl;
    let fetchedNativeLocale = null;
    let srcFetchFailed      = false;
    const catalog   = ep.catalog;
    const srcLocale = ep.activeSource();

    // Custom source (uploaded file / machine translation): cues are already in
    // hand on the Episode — no URL fetch, no wrong-title probe.  Apply them
    // directly through the same activation tail the URL path uses below.
    if (isCustomId(srcLocale)) {
      const record = ep.getCustomSource(srcLocale);
      if (!record) {
        // Stale selection (e.g. the record was removed) — reset to default.
        ep.setActiveSource(null);
        ep.clearCues();
        renderer.invalidate();
        clickInProgress = false;
        handleButtonClick(btn).catch(() => {});
        return;
      }
      ep.setOriginalCues(applyCustomSync(record));
      // MT and uploaded ('local') Sources both carry their own typeset signs in
      // record.signRawAss; null clears libass for sign-less (SRT/VTT) sources.
      setSignSource(record.signRawAss || null);
      ep.setActiveSubUrl(null);
      setOverlayActive(true);
      syncSubSuppression();
      setButtonState(btn, 'active');
      setJpStatus(PROTOCOL.STATUS.ACTIVE);
      startSync();
      paintWithSettingsCatchup();
      updateActiveInfo();
      clickInProgress = false;
      // Uploaded files may need timing alignment; a machine-translated track
      // already carries its source CR track's (correct) timing, so skip it.
      if (record.kind === 'local') {
        maybeAutoSyncCustom(record).catch(err => log.warn('Auto-sync error:', err));
      }
      return;
    }

    if (srcLocale && srcLocale !== 'ja-JP') {
      subUrl = getSubtitleUrl(srcLocale);
      if (subUrl) {
        fetchedNativeLocale = srcLocale;
        const subBase = subUrlBase(subUrl);
        const fromRow = catalog.entries().find(
          ([, row]) => subUrlBase(row[srcLocale]) === subBase
        )?.[0] ?? 'unknown';
        log.info(`Source subtitle [${srcLocale}] from [${fromRow}] session.`);
      } else {
        // Not yet in any captured session — lazily fetch the audio dub's session.
        const v = catalog.versions().find(v => v.locale === srcLocale);
        if (v?.guid) {
          const result   = await fetchSubUrlForSource(v.guid, srcLocale, ep.authHeaders);
          subUrl         = result.url ?? getSubtitleUrl(srcLocale);
          fetchedNativeLocale = subUrl ? srcLocale : null;
          srcFetchFailed      = result.fetchFailed;
          if (result.rateLimited) {
            log.warn(`Rate limited fetching ${srcLocale} — please wait a moment.`);
            showRateLimitToast();
            setButtonState(btn, 'idle');
            setJpStatus(PROTOCOL.STATUS.READY);
            clickInProgress = false;
            return;
          }
        }
      }
    } else {
      subUrl = ep.jpCaptionUrl || ep.jpSubtitleUrl;
      // Fall back to a carried-forward JP guid mapping if this Episode never
      // got ep.jpGuid set directly (typical right after a dub switch where
      // Crunchyroll didn't refire /playback/v3/ for the new dub).
      const jpGuidForFetch = ep.jpGuid ?? ep.getMappedJpGuid?.();
      if (!subUrl && jpGuidForFetch && ep.authHeaders) {
        const jpData   = await fetchAndCacheJpData(jpGuidForFetch, ep.authHeaders);
        subUrl         = jpData?.captionUrl || jpData?.subtitleUrl || null;
        srcFetchFailed = jpData?.fetchFailed ?? false;
        if (subUrl) {
          ep.setJpUrls(jpData.captionUrl ?? null, jpData.subtitleUrl ?? null);
          if (!ep.jpGuid) ep.setJpGuid(jpGuidForFetch);
        }
      }
    }

    if (!subUrl) {
      if (srcFetchFailed) {
        log.warn('Subtitle session fetch failed — network error.');
        setButtonState(btn, 'error');
        setJpStatus(PROTOCOL.STATUS.ERROR);
        showErrorToast('Subtitle session failed to load.', () => handleButtonClick(btn).catch(() => {}));
      } else if (srcLocale && srcLocale !== 'ja-JP') {
        // Saved locale not available for this episode — clear the stale preference
        // and fall back to JP.
        log.info(`No subtitle track for [${srcLocale}] on this episode — falling back to JP subtitles.`);
        try { localStorage.removeItem(LOCALE_PREF_KEY); } catch (_) {}
        ep.setActiveSource(null);
        ep.clearCues();
        renderer.invalidate();
        clickInProgress = false;
        handleButtonClick(btn).catch(() => {});
        return;
      } else {
        // JP subtitles truly unavailable — check if any other session has subtitle data.
        let fallbackSession = null, fallbackSubLocale = null;
        for (const [sess, row] of catalog.entries()) {
          if (sess === 'ja-JP') continue;
          const first = Object.keys(row)[0];
          if (first) { fallbackSession = sess; fallbackSubLocale = first; break; }
        }
        if (fallbackSubLocale) {
          log.info(`No JP subs — auto-falling back to [${fallbackSubLocale}] from [${fallbackSession}] session.`);
          ep.setActiveSource(fallbackSubLocale);
          ep.clearCues();
          renderer.invalidate();
          clickInProgress = false;
          handleButtonClick(btn).catch(() => {});
          return;
        }
        // Distinguish "confirmed no JP" from "clicked too early".
        //
        // Confirmed unavail = catalog has playback entries (we've seen at
        // least one /playback/v3/ response) AND nothing about that data
        // suggests JP exists for this episode.  Queue otherwise — either
        // playback hasn't landed yet, or it has but we have JP signals
        // (cached mapping from a prior dub, an in-flight JP-first fetch,
        // etc.) that say JP will become available.
        const seenPlayback = catalog.entries().length > 0;
        const hasJpHint    = !!ep.jpCaptionUrl || !!ep.jpSubtitleUrl
                          || !!ep.jpGuid       || !!ep.getMappedJpGuid?.();
        if (hasJpHint || !seenPlayback) {
          // Queue the activation — leave the button in 'loading' as visual
          // feedback that we're waiting for data, and let onJpDataReady
          // re-fire this click when JP data lands.
          log.info('JP CC clicked before data — queued, will auto-activate when JP data arrives.');
          setPendingActivate(true);
          // setButtonState 'loading' was already done above; keep it.
          setJpStatus(PROTOCOL.STATUS.NONE);
          scheduleQueueResolver();
        } else {
          log.warn('No subtitle track for [ja-JP] — not available in any captured session.');
          setPendingActivate(false); // confirmed unavail — clear any queued click
          setButtonState(btn, 'unavail');
          setJpStatus(PROTOCOL.STATUS.UNAVAILABLE);
          showNoSubsToast();
        }
      }
      clickInProgress = false;
      return;
    }

    const lang = srcLocale ?? 'ja-JP';
    try {
      const result = await loadSubtitleCues(subUrl, lang, ep, () => {
        const hud = ensureHud();
        if (hud) {
          hud.html(
            `<span style="color:#ffc107;">⚠</span>  Subtitle mismatch detected` +
            `<span style="color:rgba(255,255,255,0.4);font-size:10px;"> — scanning sessions…</span>`
          );
        }
      });

      if (!result.ok) {
        if (result.kind === 'fetch-failed' || result.kind === 'fetch-error') {
          // Stale URL: evict caches AND release the prefetch latch so the settle
          // loop re-fetches a FRESH signed URL instead of spinning on "no JP urls".
          if (lang === 'ja-JP') {
            if (ep.jpGuid) ep.evictCachedJpData(ep.jpGuid);
            ep.clearJpUrls();
            ep.clearPrefetchTriggered();
          } else {
            catalog.evictUrl(srcLocale);
            const v = catalog.versions().find(v => v.locale === srcLocale);
            if (v?.guid) ep.evictCachedSrcUrl(v.guid, srcLocale);
          }
          const detail = result.kind === 'fetch-failed' ? `HTTP ${result.status}` : result.message;
          log.error(`Subtitle fetch failed: ${detail}`);
          setButtonState(btn, 'error');
          setJpStatus(PROTOCOL.STATUS.ERROR);
          showErrorToast('Subtitle fetch failed.', () => handleButtonClick(btn).catch(() => {}));
          return;
        }
        if (result.kind === 'empty') {
          log.error('Subtitle file parsed but contained no cues.');
          setButtonState(btn, 'error');
          setJpStatus(PROTOCOL.STATUS.ERROR);
          showErrorToast('Subtitle file was empty.', () => handleButtonClick(btn).catch(() => {}));
          return;
        }
        if (result.kind === 'wrong-title') {
          sourceMenu.updateRow(lang, 'wrong-title');
          const hud = ensureHud();
          if (hud) {
            hud.html(
              `<span style="color:#e55;">✗</span>  ${escapeHtml(t('[{language}] subtitle unavailable', { language: lang }))}` +
              `<span style="color:rgba(255,255,255,0.4);font-size:10px;">` +
              ` — appears to be from a different title</span>`,
              8000
            );
          }
          setButtonState(btn, 'error');
          setJpStatus(PROTOCOL.STATUS.ERROR);
          return;
        }
      }

      if (result.replacedFrom) {
        const hud = ensureHud();
        if (hud) {
          hud.html(
            `<span style="color:#4caf50;">✓</span>  Found valid subtitle` +
            `<span style="color:rgba(255,255,255,0.4);font-size:10px;">` +
            ` — [${escapeHtml(lang)}] sourced from ${escapeHtml(result.replacedFrom)} session</span>`,
            6000
          );
        }
      }

      ep.setActiveSubUrl(result.finalUrl);
      setOverlayActive(true);
      syncSubSuppression();
      setButtonState(btn, 'active');
      setJpStatus(PROTOCOL.STATUS.ACTIVE);
      startSync();
      paintWithSettingsCatchup();

      runRemaster(ep.originalCues, result.finalUrl, srcLocale).catch(err => {
        log.warn('Remaster error:', err);
        fadeOutHud();
      });

      showLanguageToast(fetchedNativeLocale);
    } catch (err) {
      log.error('Subtitle activation error:', err);
      setButtonState(btn, 'error');
      setJpStatus(PROTOCOL.STATUS.ERROR);
      showErrorToast('Subtitle activation failed.', () => handleButtonClick(btn).catch(() => {}));
    } finally {
      clickInProgress = false;
    }
  }

  // ── Button injection ───────────────────────────────────────────────────────
  function directChildOf(parent, el) {
    while (el && el.parentElement !== parent) el = el.parentElement;
    return el?.parentElement === parent ? el : null;
  }

  function findControlsRow() {
    // Search document-wide for the speed button — Crunchyroll's controls bar
    // lives in a sibling subtree to the video, so scoping to videoEl's ancestor
    // misses it. The /^\d+x$/ pattern is unique enough on an episode page.
    const speedBtn = Array.from(document.querySelectorAll('button'))
      .find(b => /^\d+(\.\d+)?x$/.test(b.textContent.trim()));
    if (!speedBtn) return null;
    let el = speedBtn.parentElement;
    while (el && el.tagName !== 'BODY') {
      const cs = window.getComputedStyle(el);
      if ((cs.display === 'flex' || cs.display === 'inline-flex')
          && el.querySelectorAll('button').length >= 2) {
        return { row: el, speedBtn };
      }
      el = el.parentElement;
    }
    return null;
  }

  function findSubtitleAudioBtn() {
    return Array.from(document.querySelectorAll('button')).find(b => {
      const label = (b.getAttribute('aria-label') || b.title || '').toLowerCase();
      return label.includes('subtitle') || label.includes('audio') || label.includes('caption');
    }) ?? null;
  }

  // Inject a stylesheet that adds:
  //   • Expanded transparent hit-area pseudo-elements (10px vertical,
  //     6px horizontal) so the small buttons aren't fiddly to click.
  //   • Keyframe animations for two button states:
  //     - data-hint     → a one-time orange pulse on a brand new install
  //                       so the user notices the button exists.
  //     - data-queued   → a slow opacity pulse while pendingActivate is
  //                       true, signalling "your click is queued".
  // Idempotent.
  function ensureButtonChromeStyles() {
    const styleId = 'cr-bsub-button-chrome';
    if (document.getElementById(styleId)) return;
    const s = document.createElement('style');
    s.id = styleId;
    s.textContent = `
      #${BTN_ID}, #cr-bsub-menu-btn { position: relative; }
      #${PROGRESS_ID}:hover { background: rgba(255,255,255,.12) !important; }
      #${PROGRESS_ID}:focus-visible { outline: 2px solid #ff853d; outline-offset: 2px; }
      #${BTN_ID}::before, #cr-bsub-menu-btn::before {
        content: ''; position: absolute; inset: -10px -6px;
      }
      @keyframes cr-bsub-hint-pulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(255,107,53,0.65); }
        50%      { box-shadow: 0 0 0 10px rgba(255,107,53,0); }
      }
      #${BTN_ID}[data-hint='1'] {
        animation: cr-bsub-hint-pulse 1.5s ease-in-out infinite;
      }
      @keyframes cr-bsub-queued-pulse {
        0%, 100% { opacity: 1; }
        50%      { opacity: 0.55; }
      }
      #${BTN_ID}[data-queued='1'] {
        animation: cr-bsub-queued-pulse 1.2s ease-in-out infinite;
      }
    `;
    document.head.appendChild(s);
  }

  // First-run hint: orange pulse on the JP CC button until the user clicks
  // it once or the timeout elapses.  Flag stored in localStorage so it only
  // shows on the first install (or after the user clears extension data).
  const HINT_SEEN_KEY = 'crSubFix_seenJpCcHint';
  const HINT_TIMEOUT_MS = 12000;
  function maybeShowFirstRunHint(btn) {
    try { if (localStorage.getItem(HINT_SEEN_KEY)) return; } catch (_) { return; }
    btn.dataset.hint = '1';
    const dismiss = () => {
      btn.removeAttribute('data-hint');
      btn.removeEventListener('click', dismiss);
      try { localStorage.setItem(HINT_SEEN_KEY, '1'); } catch (_) {}
    };
    btn.addEventListener('click', dismiss);
    setTimeout(dismiss, HINT_TIMEOUT_MS);
  }

  // Reflect pendingActivate as a data-queued attribute so the CSS pulse
  // animation kicks in / out automatically.
  function setQueuedPulse(on) {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    if (on) btn.dataset.queued = '1';
    else    btn.removeAttribute('data-queued');
  }

  // Centralised setter — keeps the DOM data-queued attribute aligned with
  // the pendingActivate flag, so the CSS pulse animation matches state
  // without needing to touch the button at every call-site.
  function setPendingActivate(on) {
    pendingActivate = on;
    setQueuedPulse(on);
  }

  // ── Inline progress bar (translation) ─────────────────────────────────────
  // Compact status/details button beside the subtitle toggle. In the normal
  // controls row it inherits the player's own visibility and idle fade.
  function injectProgressBar() {
    const btn = document.getElementById(BTN_ID);
    if (!btn || !btn.parentElement) return;
    const old = document.getElementById(PROGRESS_ID);
    if (old && old.parentElement === btn.parentElement && old.dataset.inControls === String(buttonInControls)) return;
    old?.remove();
    const bar = document.createElement('button');
    bar.id = PROGRESS_ID;
    bar.type = 'button';
    bar.dataset.inControls = String(buttonInControls);
    bar.setAttribute('aria-label', 'Translation progress');
    bar.setAttribute('aria-haspopup', 'dialog');
    bar.setAttribute('aria-expanded', 'false');
    Object.assign(bar.style, {
      display: 'none', width: '54px', height: '28px', position: 'relative',
      background: 'transparent', color: THEME.text, border: '0', borderRadius: '4px',
      font: '600 11px sans-serif', letterSpacing: '0', cursor: 'pointer', padding: '2px 4px 5px',
      overflow: 'hidden', alignSelf: 'center', flexShrink: '0', marginRight: '8px',
    });
    if (!buttonInControls) Object.assign(bar.style, { position: 'fixed', right: '20px', bottom: '126px',
      zIndex: '2147483647', background: THEME.panelBg });
    const label = document.createElement('span');
    label.dataset.label = '1';
    bar.appendChild(label);
    const fill = document.createElement('div');
    fill.dataset.fill = '1';
    Object.assign(fill.style, { position: 'absolute', left: '0', bottom: '0',
      width: '0%', height: '2px', background: THEME.accent, transition: 'width 0.3s ease' });
    bar.appendChild(fill);
    bar.addEventListener('click', event => { event.stopPropagation(); translationHud?.toggle(); });
    bar.addEventListener('dblclick', event => event.stopPropagation());
    btn.parentElement.insertBefore(bar, btn);
  }

  function setTranslateProgress(step, total) {
    let bar = document.getElementById(PROGRESS_ID);
    if (!bar) { injectProgressBar(); bar = document.getElementById(PROGRESS_ID); }
    if (!bar) return;
    bar.style.display = '';
    const pct  = total > 0 ? Math.max(0, Math.min(100, Math.round((step / total) * 100))) : 0;
    const fill = bar.querySelector('[data-fill]');
    if (fill) fill.style.width = pct + '%';
    translationHud?.refresh();
  }

  function hideTranslateProgress() {
    if (translationHud) { translationHud.refresh(); return; }
    const bar = document.getElementById(PROGRESS_ID);
    if (bar) {
      bar.style.display = 'none';
      const fill = bar.querySelector('[data-fill]');
      if (fill) fill.style.width = '0%';
    }
  }

  function injectButton() {
    if (document.getElementById(BTN_ID)) return;
    ensureButtonChromeStyles();

    const btn = document.createElement('button');
    btn.id    = BTN_ID;
    NS.playerI18n?.attr(btn, 'title', 'Toggle subtitles (C / Alt+J)');
    NS.playerI18n?.attr(btn, 'aria-label', 'Toggle subtitles (C / Alt+J)');

    const found = findControlsRow();

    if (found) {
      buttonInControls = true;
      Object.assign(btn.style, {
        background:    'transparent',
        color:         THEME.text,
        border:        '1px solid transparent',  // no box; reserve space so hover/active never shifts layout
        borderRadius:  '4px',
        padding:       '3px 7px',
        fontSize:      '12px',
        fontWeight:    '600',
        fontFamily:    THEME.font,               // adopt the player's typeface
        lineHeight:    '1',
        cursor:        'pointer',
        letterSpacing: '0.3px',
        userSelect:    'none',
        transition:    'background 0.15s, color 0.15s',
        alignSelf:     'center',
        flexShrink:    '0',
        marginRight:   '6px',
      });
      const subAudioBtn = findSubtitleAudioBtn();
      const refEl = (subAudioBtn && directChildOf(found.row, subAudioBtn))
                 ?? directChildOf(found.row, found.speedBtn);
      if (refEl) found.row.insertBefore(btn, refEl);
      else        found.row.appendChild(btn);
      log.info('JP CC button injected into controls bar.');
    } else {
      buttonInControls = false;
      // Fallback pill (no controls row found): keep a faint backing so it stays
      // legible floating over the video, but match the panel idiom + accent.
      Object.assign(btn.style, {
        position:      'fixed',
        bottom:        '90px',
        right:         '20px',
        zIndex:        '2147483647',
        background:    THEME.panelBg,
        color:         THEME.text,
        border:        `1px solid ${THEME.panelEdge}`,
        borderRadius:  '6px',
        padding:       '5px 10px',
        fontSize:      '12px',
        fontWeight:    '600',
        fontFamily:    THEME.font,
        lineHeight:    '1',
        cursor:        'pointer',
        letterSpacing: '0.3px',
        userSelect:    'none',
        boxShadow:     THEME.panelShadow,
        transition:    'background 0.15s, color 0.15s',
      });
      (document.body || document.documentElement).appendChild(btn);
      log.info('JP CC button injected (fixed fallback).');
    }

    setButtonState(btn, 'idle');
    btn.addEventListener('mouseenter', () => {
      if (!overlayActive) btn.style.background = THEME.rowHover;
    });
    btn.addEventListener('mouseleave', () => {
      if (!overlayActive) btn.style.background = buttonInControls
        ? 'transparent' : THEME.panelBg;
    });
    btn.addEventListener('click', e => { e.stopPropagation(); handleManualSubtitleClick(btn).catch(() => {}); });
    if (found) sourceMenu.injectButton(found, btn);
    maybeShowFirstRunHint(btn);
    translationHud?.refresh();
  }

  function setupPlayer(video) {
    if (videoEl === video) return;
    if (videoEl) videoEl.removeEventListener('play', tryAutoActivate);
    // Tear down any suppression bound to the outgoing video (overlay- or
    // "hide official"-driven) before we repoint videoEl at the new one.
    subSuppression.deactivate();
    setOverlayActive(false);   // wrapper → SIGN_ASS clear reaches content.js
    currentEp()?.clearCues();
    movedToControls = false;
    stopSync();
    videoEl   = video;
    renderer.mount(video);
    hudCtl    = null; // overlay was just (re)created — discard stale HUD ref
    injectButton();
    videoEl.addEventListener('play', tryAutoActivate);
    const ep = currentEp();
    if (ep) restoreExternal(ep).catch(() => {});
    tryAutoActivate();
    syncSubSuppression();   // start hiding CR subs immediately if "hide official" is on
    backgroundValidateAll().catch(() => {});
  }

  function watchForPlayer() {
    const check = debounce(() => {
      if (!isEnabled()) return;
      if (!getEpisodeGuid()) return;   // only active on /watch/ pages
      const video = document.querySelector('video');
      if (!video) return;
      setupPlayer(video);

      // When the same <video> element persists but Crunchyroll rebuilds its player
      // UI (quality change, stream restart, etc.), the injected button and overlay
      // are removed from the DOM while our state variables still think they exist.
      if (videoEl === video && !document.getElementById(BTN_ID)) {
        buttonInControls = false;
        movedToControls  = false;
        injectButton();
        renderer.mount(video);
        hudCtl    = null;
        const btn = document.getElementById(BTN_ID);
        if (btn) {
          if (overlayActive) {
            setButtonState(btn, 'active');
            renderer.show();
            onTimeUpdate();
          } else {
            const attr = document.documentElement.getAttribute(PROTOCOL.ATTR.JP_STATUS) ?? 'idle';
            setButtonState(btn, attr === PROTOCOL.STATUS.ACTIVE ? 'idle' : attr);
          }
        }
      }

      if (!buttonInControls && !movedToControls) {
        const existing = document.getElementById(BTN_ID);
        if (existing && findControlsRow()) {
          movedToControls = true;
          sourceMenu.close();
          existing.remove();
          sourceMenu.removeButton();
          injectButton();
        }
      }

      // Self-heal the ▾ picker's visibility every tick.  A dub switch re-injects
      // the button before the Episode is fully wired, and the only other reveal
      // is the JP-playback path — which never fires for a non-JP dub's transient
      // Episode.  Re-evaluating here (cheap: a getElementById + a style set, and
      // a no-op when the button is absent) guarantees it appears once currentEp()
      // is live, instead of staying stuck hidden until the next dub change.
      sourceMenu.updateButtonVisibility();
    }, 100);

    new MutationObserver(check).observe(document.body ?? document.documentElement, { childList: true, subtree: true });
    check();
  }

  // ── Main fetch intercept ───────────────────────────────────────────────────
  // Crunchyroll and co-installed extensions (ad blockers) fire many requests
  // through our wrapped fetch that get blocked or fail.  When the caller never
  // catches the rejection it surfaces as "Uncaught (in promise) TypeError:
  // Failed to fetch" — and because V8 attributes an unhandled fetch rejection to
  // where fetch was *called*, our wrapper frame gets blamed even though the
  // request and the missing .catch are entirely the caller's.  These are benign
  // network failures, not bugs.  Two layers keep them out of the console:
  //   1. passThrough() marks the promise handled for the common fire-and-forget
  //      caller (one that attaches no .then at all).
  //   2. a page-level unhandledrejection listener silences the exact "Failed to
  //      fetch" TypeError for callers that DO chain .then without .catch — whose
  //      derived promise we have no reference to.  preventDefault() only
  //      suppresses the console log; it does not alter any behaviour.
  // Only playback/manifest URLs are handled async, by intercept{Playback,Manifest}.
  // ── On-error reporting ─────────────────────────────────────────────────────
  // Dormant unless lib/config.js sets REPORT_ENDPOINT.  When OUR code throws,
  // show a one-click "send a report?" nudge near the player; the isolated world
  // (content.js) does the actual POST so Crunchyroll's page CSP can't block it.
  // Crunchyroll throws its own React hydration errors constantly, so we only act
  // on errors whose stack references our own extension URL.
  const REPORT_ENDPOINT = (NS.config && NS.config.REPORT_ENDPOINT) || '';
  const SELF_URL = (() => {
    try { const m = (new Error().stack || '').match(/chrome-extension:\/\/[a-p]{32}\//); return m ? m[0] : null; }
    catch (_) { return null; }
  })();
  const reportSeen = new Set();            // error fingerprints nudged this session
  let reportNudgeOpen = false;
  const isOurError = (s) => !!(SELF_URL && s && String(s).includes(SELF_URL));

  function maybeReport(message, stack) {
    if (!REPORT_ENDPOINT || !isEnabled()) return;
    const fp = String(message || stack || 'error').slice(0, 120);
    if (reportSeen.has(fp)) return;        // one nudge per unique error per session
    reportSeen.add(fp);
    // Record the error + our own top stack frames (extension URLs only — not
    // sensitive) into the trace so the report carries the where, not just the what.
    const frames = String(stack || '').split('\n').slice(0, 4).join(' ');
    log.error('Captured error:', message, frames ? '| ' + frames : '');
    showReportNudge(String(message || 'An error occurred'));
  }

  // Build the redacted report bundle in the MAIN world.  Everything's reachable
  // here (trace, DOM state, settings) except the extension version, which has no
  // chrome.runtime in MAIN — content.js stashes it in sessionStorage for us.
  function buildReportBundle(errMessage) {
    const el = document.documentElement;
    let version = '?';
    try { version = sessionStorage.getItem('crSubFix_version') || '?'; } catch (_) {}
    const lines = [
      `version : ${version}`,
      `error   : ${errMessage || '-'}`,
    ];
    // Respect the user's opt-out: with diagnostics off, send only version + the
    // error message — no page, activity, or settings.
    if (SETTINGS.read(el, 'includeDiagnostics') === false) {
      lines.push('(diagnostics off — page/activity/settings omitted by the user)');
      return lines.join('\n');
    }
    let activeInfo = {};
    try { const raw = el.getAttribute(PROTOCOL.ATTR.ACTIVE_INFO); if (raw) activeInfo = JSON.parse(raw); } catch (_) {}
    lines.push(
      `browser : ${coarsePlatform()}`,
      `episode : ${getEpisodeGuid() || '-'}`,
      `state   : jpStatus=${el.getAttribute(PROTOCOL.ATTR.JP_STATUS) || '-'} source=${activeInfo.source ?? '-'} audio=${activeInfo.audio ?? '-'}`,
      `settings: enabled=${SETTINGS.read(el, 'enabled')} auto=${SETTINGS.read(el, 'autoActivate')} hideOfficial=${SETTINGS.read(el, 'hideOfficialSubs')} styleOverride=${SETTINGS.read(el, 'styleOverride')}`,
      `mt      : configured=${el.getAttribute(PROTOCOL.ATTR.MT_CONFIGURED) || '-'} provider=${getMtProvider()} target=${getMtTarget()} source=${getMtSourcePref() || 'auto'}`,
      '--- recent activity (most recent last) ---',
    );
    // Keep the MOST RECENT trace that fits the budget (the Worker's embed holds
    // ~4000) — trimming from the front preserves the lines just before the error.
    const header = lines.join('\n');
    const redact = redactSensitive;   // trace is already redacted at write time; idempotent here
    let trace = [];
    try { trace = JSON.parse(sessionStorage.getItem(TRACE_KEY) || '[]'); } catch (_) {}
    let tail = trace.map(redact).join('\n');
    const room = 3800 - header.length;
    if (tail.length > room) tail = '…(older lines trimmed)\n' + tail.slice(-(room - 25));
    return header + '\n' + (tail || '(no trace)');
  }

  function showReportNudge(message) {
    if (reportNudgeOpen) return;
    reportNudgeOpen = true;
    const wrap = document.createElement('div');
    wrap.id = 'cr-sub-report-nudge';
    wrap.style.cssText =
      'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;' +
      'display:flex;align-items:center;gap:12px;max-width:92vw;' +
      `background:${THEME.panelBg};color:${THEME.text};` +
      `border:1px solid ${THEME.panelEdge};border-radius:10px;padding:11px 14px;` +
      // No font-family → inherit the player's typeface from <html>.
      `font-weight:500;font-size:13px;line-height:1.4;box-shadow:${THEME.panelShadow};`;
    const msg = document.createElement('span');
    uiText(msg, '⚠ Better Subs hit an error. Send a quick report?');
    const send = document.createElement('button');
    uiText(send, 'Send');
    const dismiss = document.createElement('button');
    uiText(dismiss, 'Dismiss');
    for (const b of [send, dismiss]) {
      b.type = 'button';
      b.style.cssText = `font-weight:600;font-size:12px;border-radius:6px;padding:5px 12px;cursor:pointer;border:1px solid ${THEME.panelEdge};background:rgba(255,255,255,0.06);color:${THEME.textDim};`;
    }
    send.style.color = THEME.accent; send.style.borderColor = THEME.accent;
    const host = () => document.fullscreenElement || document.documentElement;
    let done = false, keepAlive = null;
    const close = () => {
      if (keepAlive) { clearInterval(keepAlive); keepAlive = null; }
      wrap.remove(); reportNudgeOpen = false;
    };
    send.addEventListener('click', async () => {
      if (done) return; done = true;
      send.disabled = dismiss.disabled = true;
      uiText(msg, 'Sending…');
      let ok = false;
      try {
        const resp = await originalFetch(REPORT_ENDPOINT, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ text: buildReportBundle(message) }),
        });
        ok = resp.ok;
      } catch (_) { ok = false; }
      uiText(msg, ok ? '✓ Thanks — report sent.' : '✗ Could not send the report.');
      send.style.display = dismiss.style.display = 'none';
      setTimeout(close, 2600);
    });
    dismiss.addEventListener('click', close);
    wrap.append(msg, send, dismiss);
    host().appendChild(wrap);
    // Crunchyroll's React reconciliation detaches nodes added under <body>/the
    // player, so host on <html> and re-attach until the nudge is intentionally
    // closed — otherwise it vanishes before the user can click it.
    keepAlive = setInterval(() => {
      if (!reportNudgeOpen) { clearInterval(keepAlive); keepAlive = null; return; }
      if (!wrap.isConnected) host().appendChild(wrap);
    }, 500);
    setTimeout(() => { if (!done) close(); }, 15000);               // auto-dismiss if ignored
  }

  if (REPORT_ENDPOINT) {
    window.addEventListener('error', (e) => {
      const where = e.filename || (e.error && e.error.stack) || '';
      if (isOurError(where)) maybeReport(e.message || (e.error && e.error.message) || 'error', where);
    });
  }

  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    if (r instanceof TypeError && /failed to fetch/i.test(r.message || '')) {
      e.preventDefault();
      return;
    }
    const stack = (r && r.stack) || '';
    if (isOurError(stack)) maybeReport((r && r.message) || String(r), stack);
  });

  function passThrough(args) {
    const p = originalFetch(...args);
    p.catch(() => {});
    return p;
  }

  window.fetch = function (...args) {
    const input = args[0];
    const url   = typeof input === 'string' ? input
                : input instanceof Request  ? input.url : '';

    if (!isEnabled()) return passThrough(args);

    // Snapshot the Episode at request start; writes after dispose() are no-ops.
    // If we're not on /watch/, no Episode exists and we just pass through.
    const ep = currentEp();

    if (ep && !ep.capturedAuth) {
      const auth = extractAuthHeader(args[1] ?? {});
      if (Object.keys(auth).length) {
        ep.setCapturedAuth(auth);
        // If a prior dub's Episode carried a JP guid forward via SPA
        // navigation, we now have auth — proactively prefetch JP data.
        // Without this, dub switches where Crunchyroll doesn't refetch
        // /playback/v3/ would never load JP for the new Episode.
        // maybePrefetch is idempotent and self-gating.
        if (ep.getMappedJpGuid?.()) maybePrefetch().catch(() => {});
      }
    }

    if (PLAYBACK_RE.test(url) && ep) return interceptPlayback(args, url, ep);
    if (MANIFEST_RE.test(url))       return interceptManifest(args, ep);

    // Everything else passes straight through, untouched.
    return passThrough(args);
  };

  // ── Playback JSON intercept ──
  async function interceptPlayback(args, url, ep) {
    const response = await runPlaybackIntercept(args, url, ep);
    // The newer Crunchyroll player renders subtitles from this JSON's
    // captions/subtitles maps (not the DASH manifest text/vtt track), so when
    // "hide official" is on we empty those maps in the copy the player receives,
    // leaving it nothing to render.  Our own catalog/JP logic already read the
    // untouched data from a clone above, and JP/source subtitle data is fetched
    // via originalFetch (which bypasses this wrapper), so the player seeing an
    // empty list never starves the overlay.
    return isHideOfficialSubs() ? stripOfficialSubs(response) : response;
  }

  async function stripOfficialSubs(response) {
    try {
      const data = await response.clone().json();
      if (data && typeof data === 'object') {
        log.info('[hide-official] playback keys:', Object.keys(data).join(','),
                 '| hardSubs:', data.hardSubs ? Object.keys(data.hardSubs).join('/') : (data.hard_subs ? 'snake:' + Object.keys(data.hard_subs).join('/') : 'none'),
                 '| url:', (data.url || '').slice(0, 110));
        // Soft-sub maps (older player rendered from these).
        data.captions  = {};
        data.subtitles = {};
        // The newer player serves HARDSUBBED video — the subtitle is burned into
        // the picture, picked from this hardSubs map by the viewer's subtitle
        // preference.  Empty it so the player falls back to the raw top-level
        // stream URL and the burned-in text never appears.  Only when a raw url
        // exists, so we never strand the player with no stream.
        if (data.url && data.hardSubs)  data.hardSubs  = {};
        if (data.url && data.hardsubs)  data.hardsubs  = {};
        if (data.url && data.hard_subs) data.hard_subs = {};
      }
      const headers = {};
      response.headers.forEach((v, k) => { headers[k] = v; });
      return new Response(JSON.stringify(data), { status: response.status, statusText: response.statusText, headers });
    } catch (_) {
      return response;
    }
  }

  async function runPlaybackIntercept(args, url, ep) {
    const authHdrs = extractAuthHeader(args[1] ?? {});
    if (Object.keys(authHdrs).length) ep.setCapturedAuth(authHdrs);

    const cachedJpGuid = ep.getMappedJpGuid();
    if (cachedJpGuid && !ep.jpCaptionUrl) {
      log.info(`JP-first fetch (ep: ${ep.guid}, jp: ${cachedJpGuid})`);
      try {
        const jpData = await fetchAndCacheJpData(cachedJpGuid, authHdrs);
        if (ep.disposed) { /* navigation happened mid-fetch — drop */ }
        else {
          if (jpData?.jpRow) storeSessionSubs('ja-JP', jpData.jpRow);
          ensureVersionList(ep);  // populate the picker even if the full setVersions block is skipped
          if (jpData?.captionUrl || jpData?.subtitleUrl) {
            ep.setJpUrls(jpData.captionUrl ?? null, jpData.subtitleUrl ?? null);
            ep.setJpGuid(cachedJpGuid);
            ep.setAuthHeaders(authHdrs);
            setJpStatus(PROTOCOL.STATUS.READY);
            log.info('JP-first success. Caption:', ep.jpCaptionUrl, '| Sub:', ep.jpSubtitleUrl);
            tryAutoActivate();
            onJpDataReady();
            backgroundValidateAll().catch(() => {});
          } else {
            log.warn('JP-first: no EN URL — other subtitle languages may still be available.');
          }
        }
      } catch (err) {
        log.warn('JP-first error:', err);
      }
    }

    const response = await originalFetch(...args);

    // Bail if navigation disposed the Episode while waiting on the network.
    if (ep.disposed) return response;

    // Error responses (401/420/429/…) carry JSON error envelopes, not playback
    // data — parsing one would poison currentAudio (clearing a live remaster)
    // and read as "no ja-JP version".  The page gets the response either way.
    if (!response.ok) return response;

    try {
      const data = await response.clone().json();

      const watchingJP = data.audioLocale === 'ja-JP';
      ep.setCurrentAudio(data.audioLocale ?? null);
      const currentAudio = ep.catalog.currentAudio();
      updateActiveInfo();

      // Record this session's subtitle rows (with captions provenance) BEFORE
      // any early return below: a dub response whose `versions` omits ja-JP
      // (CR does this for some dub variants) still carries the dub's own
      // captions/subtitles — including the CC — and urlFor + the cross-dub
      // carry depend on the row being present.
      const sessionSubs = PLAYBACK.subtitleMap(data);
      storeSessionSubs(currentAudio, sessionSubs, PLAYBACK.captionLocales(data));
      // Watch whether the player picks a burned-in (hardsub) stream variant —
      // if it does and our overlay comes up, maybeWarnHardsub offers the fix.
      // burnedInLocale (new field, 2026-08) names the burned variant of the
      // served url directly — verified "" on clean streams; non-empty is
      // treated as burned. The URL observer stays as fallback for responses
      // that omit the field.
      if (typeof data.burnedInLocale === 'string' && data.burnedInLocale) {
        stopHardsubWatch();
        _hardsubStream = true;
        if (overlayActive) maybeWarnHardsub();
      } else {
        watchForHardsubStream(data.hardSubs ?? data.hardsubs ?? data.hard_subs);
      }
      log.info(`[${currentAudio}] session subtitle locales [${Object.keys(sessionSubs).join(', ') || 'none'}]`);

      const jpVersion = PLAYBACK.jpVersion(data);
      if (!jpVersion) {
        // Crunchyroll's API sometimes returns a versions list without
        // ja-JP for certain dub variants of an episode that DOES have JP.
        // If we already have JP data (loaded just above by the JP-first
        // fetch, or carried forward from a prior dub of the same episode),
        // don't overwrite that with 'unavail' — JP is still available.
        const haveJpHint = !!ep.jpCaptionUrl || !!ep.jpSubtitleUrl
                        || !!ep.jpGuid || !!ep.getMappedJpGuid?.();
        if (haveJpHint) {
          log.info('Dub response missing ja-JP — keeping prior JP data (cross-dub).');
        } else {
          log.info('No ja-JP version — skipping.');
          setJpStatus(PROTOCOL.STATUS.UNAVAILABLE);
          setPendingActivate(false); // queued click can't succeed — clear it
          const btn = document.getElementById(BTN_ID);
          if (btn) setButtonState(btn, 'unavail');
        }
        return response;
      }

      ep.setMappedJpGuid(jpVersion.guid);
      ep.setAuthHeaders(authHdrs);
      if (!ep.jpGuid) ep.setJpGuid(jpVersion.guid);

      // Race-condition fix: JP-first may have activated the overlay before this
      // audio session's subtitle URLs were stored.  Now that the audio row is
      // populated, re-run remaster so it can find the bridging language.
      if (overlayActive && ep.originalCues.length > 0 && ep.activeSubUrl &&
          (!ep.remasteredCues || ep.remasterForAudio !== currentAudio)) {
        ep.clearRemaster();
        renderer.invalidate();
        runRemaster(ep.originalCues, ep.activeSubUrl, ep.activeSource()).catch(() => {});
      }

      tryAutoActivate();
      onJpDataReady();
      backgroundValidateAll().catch(() => {});

      // Auto-reload active subs when the audio session changes and a better-timed
      // subtitle URL is now available for the active locale.
      const active = ep.activeSource();
      if (overlayActive && active && active !== 'ja-JP') {
        const betterUrl = getSubtitleUrl(active);
        if (betterUrl && subUrlBase(betterUrl) !== subUrlBase(ep.activeSubUrl)) {
          log.info(`Audio changed → reloading [${active}] subs for new session.`);
          const reloadBtn = document.getElementById(BTN_ID);
          if (reloadBtn) {
            setOverlayActive(false);
            ep.setActiveSubUrl(null);
            ep.clearCues();
            renderer.invalidate();
            stopSync();
            handleButtonClick(reloadBtn).catch(() => {});
          }
        }
      }

      // Build the source picker list — JP first, then the other audio dubs.
      const newVersions = [{ locale: 'ja-JP', guid: jpVersion.guid }];
      for (const v of PLAYBACK.audioVersions(data)) {
        if (v.locale !== 'ja-JP') newVersions.push(v);
      }
      // Add every subtitle locale that isn't already represented by an audio dub —
      // covers subtitle-only languages (no separate audio track) carried by the JP session.
      const versionLocales = new Set(newVersions.map(v => v.locale));
      for (const loc of allKnownSubtitleLocales()) {
        if (!versionLocales.has(loc)) { newVersions.push({ locale: loc, guid: null }); versionLocales.add(loc); }
      }
      newVersions.sort((a, b) => {
        if (a.locale === 'ja-JP') return -1;
        if (b.locale === 'ja-JP') return 1;
        return a.locale.localeCompare(b.locale);
      });
      ep.catalog.setVersions(newVersions);
      sourceMenu.updateButtonVisibility();
      log.info(`Source picker: ${newVersions.map(v => v.locale).join(', ')}`);
      maybeShowLearnHint();        // one-shot nudge toward the audio+native study stack

      // Auto-recover the button from a premature-click 'unavail' state.
      // The user clicked JP CC during the gap between dub-switch SPA
      // navigation and this playback response arriving, so the catalog
      // was empty at the time and we marked it unavailable.  Now that we
      // have data, return the button to 'idle' so a second click works.
      {
        const stuckBtn = document.getElementById(BTN_ID);
        if (stuckBtn && stuckBtn.dataset.state === 'unavail') {
          log.info('Catalog populated — clearing stuck `unavail` button state.');
          setButtonState(stuckBtn, 'idle');
          setJpStatus(PROTOCOL.STATUS.NONE);
        }
      }

      if (watchingJP) {
        if (!ep.jpCaptionUrl && !ep.jpSubtitleUrl && ep.jpGuid) {
          maybePrefetch();
        }
        return response;
      }

      log.info(`Found ja-JP version: ${jpVersion.guid}`);

      if (data.token) {
        const enGuid  = url.match(PLAYBACK_RE)[1];
        const enToken = data.token;
        // Episode handles deregistering any prior beforeunload handler before
        // registering this new one — quality changes and stream restarts
        // re-trigger this block, and stale handlers would fire multiple
        // DELETEs for outdated tokens on page unload.
        const handler = () => {
          originalFetch(
            `https://www.crunchyroll.com/playback/v1/token/${enGuid}/${enToken}`,
            { method: 'DELETE', credentials: 'include', headers: authHdrs, keepalive: true }
          ).catch(() => {});
        };
        ep.setEnSessionCleanup(handler);
        window.addEventListener('beforeunload', handler, { once: true });
        log.info('EN session cleanup registered.');
      }

      if (!ep.jpCaptionUrl && !ep.jpSubtitleUrl) {
        // JP guid just discovered — need a reload so the JP-first path can fetch
        // subtitle data with the correct auth on the next load.
        const reloadKey = 'crSubFix_reloaded_' + ep.guid;
        const btn       = document.getElementById(BTN_ID);
        if (!STORAGE.ssHas(reloadKey)) {
          log.info('JP guid cached — reloading for JP subs.');
          if (btn) setButtonState(btn, 'reload');
          // Set the guard BEFORE scheduling the reload. If setItem throws
          // (quota full / storage blocked), cancel the reload to avoid an
          // infinite reload loop.
          if (STORAGE.ssSet(reloadKey, '1')) {
            setTimeout(() => location.reload(), 600);
          } else {
            log.warn('sessionStorage unavailable — reload skipped.');
            if (btn) setButtonState(btn, 'idle');
          }
        } else {
          log.info('JP guid known — reload already done this session.');
          if (btn) setButtonState(btn, 'idle');
        }
      }
    } catch (err) {
      log.error('Playback interceptor error:', err);
    }

    return response;
  }

  // ── DASH manifest intercept ──
  async function interceptManifest(args, ep) {
    const response = await originalFetch(...args);
    const hideOfficial = isHideOfficialSubs();
    const jpCap = ep?.jpCaptionUrl;
    // Nothing to do unless we're hiding CR's subs or swapping in the JP caption.
    if (!hideOfficial && !jpCap) return response;
    try {
      const xml      = await response.clone().text();
      // Hide-official wins: strip CR's subtitle track entirely so its renderer
      // has nothing to show.  Otherwise swap CR's text/vtt to the JP caption so
      // CR's own renderer displays the replacement (the in-player path).
      const modified = hideOfficial ? blankVttInManifest(xml) : swapVttInManifest(xml, jpCap);
      if (modified === xml) {
        log.warn(hideOfficial ? 'Manifest: no text/vtt AdaptationSet to remove.' : 'Manifest swap: no text/vtt BaseURL found.');
        return response;
      }
      log.info(hideOfficial ? 'Manifest text/vtt track removed (hide official).' : 'Manifest text/vtt swapped to JP caption.');
      const headers = {};
      response.headers.forEach((v, k) => { headers[k] = v; });
      return new Response(modified, { status: response.status, statusText: response.statusText, headers });
    } catch (err) {
      log.error('Manifest interceptor error:', err);
      return response;
    }
  }

  watchForPlayer();
  log.info('Fetch interceptor + JP CC button installed.');
  } catch (err) {
    console.error('[CR Sub Fix] interceptor.js threw at module level:', err, err?.stack);
    // Best-effort persist to the trace (log may not be initialised if the throw
    // was early) so a later report still carries the load failure.
    try {
      const arr = JSON.parse(sessionStorage.getItem('crSubFix_trace') || '[]');
      arr.push(`${Date.now()} [E] module-level throw: ${err && err.message} | ` +
        String((err && err.stack) || '').split('\n').slice(0, 4).join(' '));
      while (arr.length > 400) arr.shift();
      sessionStorage.setItem('crSubFix_trace', JSON.stringify(arr));
    } catch (_) {}
  }
})();
