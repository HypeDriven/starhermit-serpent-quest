// UI module: semantic HTML shell over the canvas. Owns screens, HUD, rails,
// drawers/sheets, focus management, live announcements, captions, settings
// forms, help cards, results, and the accessible board mirror.
// Knows nothing about rules internals; speaks in view models + onAction events.

import { THEMES } from './content.js';
import { PRESETS, CATEGORIES, presetTier, describe, choosePreset, normalizePreset } from './gfx.js';
import { gfxStrings, fmt } from './gfx-strings.js';
import { shText } from './sh-strings.js';
import { T, N, pname } from './i18n.js';

const $ = (sel) => document.querySelector(sel);

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'disabled') node.disabled = !!v;
    else if (k === 'hidden') node.hidden = !!v;
    else if (k.startsWith('aria') || k === 'role' || k === 'tabindex' || k === 'type' || k === 'for' || k === 'id' || k === 'value' || k === 'min' || k === 'max' || k === 'step' || k === 'selected' || k === 'checked') {
      if (k === 'checked') node.checked = !!v;
      else node.setAttribute(k === 'for' ? 'for' : k, v);
    } else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function createUI({ onAction }) {
  const screensRoot = $('#screens');
  const hud = $('#hud');
  let activeScreen = null;
  let focusReturn = null;
  let toastTimer = 0;
  let captionTimer = 0;
  let currentSettings = null;
  let graphicsInfo = () => null;  // provided by main (renderer.graphicsInfo)
  let refreshGraphicsCard = null; // set while the Settings screen is open
  let settingsRelabel = null;     // set while the Settings screen is open

  // -------------------------------------------------------------------------
  // Screen manager with focus restoration
  // -------------------------------------------------------------------------

  const topbar = document.getElementById('topbar');
  const syncTopbarInset = () => {
    // visual px → layout px of the zoomed #screens layer (large screens)
    const h = topbar && !topbar.hidden ? topbar.getBoundingClientRect().height / (window.UIScale?.value || 1) : 0;
    screensRoot.style.setProperty('--topbar-h', `${Math.round(h)}px`);
  };
  if (topbar && typeof ResizeObserver === 'function') new ResizeObserver(syncTopbarInset).observe(topbar);
  window.addEventListener('resize', syncTopbarInset);

  function showScreen(name, vm = {}) {
    syncTopbarInset();
    screensRoot.innerHTML = '';
    activeScreen = name;
    if (!name) {
      if (focusReturn) { focusReturn.focus({ preventScroll: true }); focusReturn = null; }
      return;
    }
    focusReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const section = el('section', { class: 'screen active', role: 'dialog', 'aria-label': vm.title || name, id: 'screen-' + name });
    const inner = el('div', { class: 'screen-inner' + (vm.wide ? ' wide' : '') });
    section.append(inner);
    screensRoot.append(section);
    const builder = SCREEN_BUILDERS[name];
    if (builder) builder(inner, vm);
    const first = section.querySelector(vm.autofocus ? `[data-autofocus="${vm.autofocus}"]` : FOCUSABLE);
    (first || section).focus?.({ preventScroll: true });
    section.tabIndex = -1;
    if (!first) section.focus({ preventScroll: true });
  }

  function closeScreen() {
    showScreen(null);
    onAction('close-screen');
  }

  // -------------------------------------------------------------------------
  // HUD + rails
  // -------------------------------------------------------------------------

  function setHudVisible(v) {
    hud.hidden = !v;
    $('#action-tray').hidden = !v;
  }

  function goalLabel(g) {
    const names = { food: N('Berries eaten'), length: N('Serpent length'), rivals: N('Rivals defeated'), survive: N('Ticks survived'), score: N('Score'), lesson: N('Lesson progress') };
    return names[g.kind] ? T(names[g.kind]) : g.kind;
  }

  function updateHUD(vm) {
    // vm: { goals, score, tick, movesLeft, timeLeft, modeLabel, canUndo, canHint }
    const obj = $('#hud-objective');
    obj.innerHTML = '';
    if (vm.modeLabel) obj.append(el('div', { class: 'muted', text: vm.modeLabel }));
    for (const g of vm.goals || []) {
      obj.append(el('div', {
        class: g.done ? 'obj-done' : '',
        text: `${goalLabel(g)}: ${Math.min(g.progress, g.count)} / ${g.count}${g.done ? ' ✓' : ''}`,
      }));
    }
    if (vm.movesLeft != null) obj.append(el('div', { text: T('Moves left: {n}', { n: vm.movesLeft }) }));
    if (vm.timeLeft != null) obj.append(el('div', { text: T('Time left: {n}', { n: vm.timeLeft }) }));
    $('#hud-score').textContent = String(vm.score ?? 0);

    const undoBtn = $('#tray-btn-undo');
    if (undoBtn) undoBtn.disabled = !vm.canUndo;
    const hintBtn = $('#tray-btn-hint');
    if (hintBtn) hintBtn.disabled = !vm.canHint;
  }

  function updateRails(vm) {
    // Left: objective + progression. Right: score components + status.
    const left = $('#rail-left');
    const right = $('#rail-right');
    left.innerHTML = '';
    right.innerHTML = '';
    if (!vm) return;
    left.append(el('div', { class: 'rail-card' },
      el('h2', { text: vm.title || T('Objective') }),
      el('ul', {}, (vm.goals || []).map((g) =>
        el('li', { text: `${goalLabel(g)} — ${Math.min(g.progress, g.count)}/${g.count}${g.done ? ' ✓' : ''}` }))),
      vm.parText ? el('p', { text: vm.parText }) : null,
    ));
    if (vm.progressionText) {
      left.append(el('div', { class: 'rail-card' }, el('h3', { text: T('Journey') }), el('p', { text: vm.progressionText })));
    }
    right.append(el('div', { class: 'rail-card' },
      el('h3', { text: T('Score') }),
      el('ul', {}, Object.entries(vm.scoreParts || {}).map(([k, v]) => el('li', { text: `${k}: ${v}` }))),
    ));
    if (vm.statusText) {
      right.append(el('div', { class: 'rail-card' }, el('h3', { text: T('Status') }), el('p', { text: vm.statusText })));
    }
  }

  // Drawer versions of the rails for compact layouts.
  function openDrawer(side) {
    const rail = side === 'left' ? $('#rail-left') : $('#rail-right');
    const scrim = el('div', { class: 'sheet-scrim' });
    const sheet = el('div', { class: 'sheet ' + side, role: 'dialog', 'aria-label': T(side === 'left' ? 'Objective' : 'Status') });
    sheet.innerHTML = rail.innerHTML;
    const close = () => { scrim.remove(); sheet.remove(); document.removeEventListener('keydown', onKey); };
    function onKey(e) { if (e.key === 'Escape') close(); }
    scrim.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.append(scrim, sheet);
    const btn = sheet.querySelector(FOCUSABLE);
    (btn || sheet).focus?.({ preventScroll: true });
  }

  // -------------------------------------------------------------------------
  // Action tray, drawer buttons
  // -------------------------------------------------------------------------

  // aria-labels carry data-i18n-aria so a language change relabels them in place.
  function buildTray() {
    const tray = $('#action-tray');
    const left = $('#tray-left');
    const right = $('#tray-right');
    left.innerHTML = '';
    right.innerHTML = '';
    const dpad = el('div', { class: 'dpad', role: 'group', 'aria-label': T('Steering'), 'data-i18n-aria': 'Steering' });
    for (const [dir, glyph, label] of [['up', '▲', N('Steer up')], ['left', '◀', N('Steer left')], ['right', '▶', N('Steer right')], ['down', '▼', N('Steer down')]]) {
      dpad.append(el('button', {
        class: 'tray-btn', type: 'button', 'data-dir': dir, 'aria-label': T(label), 'data-i18n-aria': label,
        onclick: () => onAction('steer', { dir }),
      }, glyph));
    }
    left.append(dpad);
    right.append(
      el('button', { class: 'tray-btn', id: 'tray-btn-hint', type: 'button', 'aria-label': T('Hint'), 'data-i18n-aria': 'Hint', onclick: () => onAction('hint') }, '💡'),
      el('button', { class: 'tray-btn', id: 'tray-btn-undo', type: 'button', 'aria-label': T('Undo'), 'data-i18n-aria': 'Undo', onclick: () => onAction('undo') }, '↩'),
      el('button', { class: 'tray-btn', type: 'button', 'aria-label': T('Pause'), 'data-i18n-aria': 'Pause', onclick: () => onAction('pause') }, '❚❚'),
    );

    const wrap = $('#canvas-wrap');
    if (!$('#drawer-left-btn')) {
      const l = el('button', { class: 'icon-btn drawer-btns', id: 'drawer-left-btn', type: 'button', 'aria-label': T('Open objective panel'), 'data-i18n-aria': 'Open objective panel', onclick: () => openDrawer('left') }, '🎯');
      const r = el('button', { class: 'icon-btn drawer-btns', id: 'drawer-right-btn', type: 'button', 'aria-label': T('Open status panel'), 'data-i18n-aria': 'Open status panel', onclick: () => openDrawer('right') }, '📊');
      wrap.append(l, r);
    }
  }

  // -------------------------------------------------------------------------
  // Transient feedback
  // -------------------------------------------------------------------------

  function announce(msg, assertive = false) {
    const region = assertive ? $('#live-assertive') : $('#live-polite');
    region.textContent = '';
    requestAnimationFrame(() => { region.textContent = msg; });
  }

  function toast(msg, kind = '') {
    const t = $('#toast');
    // Over a menu screen (or with the HUD hidden, e.g. the title's invite link) the HUD toast
    // would be hidden or covered: float it above the screens instead.
    const floating = $('#hud').hidden || !!document.querySelector('#screens .screen.active');
    if (floating && t.parentElement !== document.body) document.body.append(t);
    else if (!floating && t.parentElement === document.body) $('#hud').append(t);
    t.textContent = msg;
    t.className = (kind + (floating ? ' floating' : '')).trim();
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
    if (kind === 'warn') announce(msg, true);
  }

  function caption(text) {
    const c = $('#caption');
    if (!text || (currentSettings && currentSettings.captions === false)) { c.hidden = true; return; }
    c.textContent = text;
    c.hidden = false;
    clearTimeout(captionTimer);
    captionTimer = setTimeout(() => { c.hidden = true; }, 2200);
  }

  function countdown(value) {
    const c = $('#countdown');
    if (value == null) { c.hidden = true; return; }
    c.hidden = false;
    c.textContent = value > 0 ? String(value) : T('Go!');
    c.classList.remove('pop');
    void c.offsetWidth; // restart animation
    c.classList.add('pop');
    if (value > 0) announce(String(value));
  }

  // -------------------------------------------------------------------------
  // Pause overlay
  // -------------------------------------------------------------------------

  let pauseVm = null; // open pause card's view model (summary may be a thunk), for relabeling
  function showPause(open, vm = {}, refocus = true) {
    let overlay = $('#pause-overlay');
    if (!overlay) {
      overlay = el('div', { id: 'pause-overlay' });
      $('#canvas-wrap').append(overlay);
    }
    overlay.innerHTML = '';
    overlay.classList.toggle('active', open);
    pauseVm = open ? vm : null;
    if (!open) return;
    const summary = typeof vm.summary === 'function' ? vm.summary() : vm.summary;
    const card = el('div', { class: 'card pause-card', role: 'dialog', 'aria-label': T('Paused') },
      el('h2', { text: T('Paused') }),
      summary ? el('p', { class: 'muted', text: summary }) : null,
      el('button', { class: 'btn primary', type: 'button', onclick: () => onAction('resume') }, T('Resume')),
      el('button', { class: 'btn', type: 'button', onclick: () => onAction('restart') }, T('Restart round')),
      el('button', { class: 'btn', type: 'button', onclick: () => onAction('nav-settings') }, T('Settings')),
      el('button', { class: 'btn', type: 'button', onclick: () => onAction('nav-help') }, T('Help')),
      el('button', { class: 'btn danger', type: 'button', onclick: () => onAction('quit') }, T('Leave round')),
    );
    overlay.append(card);
    if (refocus) card.querySelector('button').focus({ preventScroll: true });
  }

  // -------------------------------------------------------------------------
  // Graphics section: preset, render scale, per-effect overrides, adaptive
  // resolution, frame-rate readout, GPU/cost summary. Localized via
  // gfx-strings.js (game language). Only the inner box is rebuilt on every
  // change (so the "From preset (…)" labels follow the chosen preset); the
  // shared Language / Sound / Report sections that game-options.js mounts in
  // the card ([data-options-graphics]) after it stay put.
  // -------------------------------------------------------------------------

  function graphicsCard(s, emit) {
    const card = el('div', { class: 'card gfx-card', id: 'gfx-card', role: 'group', 'aria-labelledby': 'gfx-title', 'data-options-graphics': '' });
    const box = el('div', { class: 'gfx-box' });
    card.append(box);

    const render = () => {
      const L = gfxStrings();
      const focusId = document.activeElement && box.contains(document.activeElement) ? document.activeElement.id : null;
      s.quality = normalizePreset(s.quality);
      if (!s.graphics || typeof s.graphics !== 'object') s.graphics = {};
      const g = s.graphics;
      const info = graphicsInfo();
      const detected = info ? info.detected : 'balanced';
      const effective = s.quality === 'auto' ? detected : s.quality;
      const tierName = (t) => L.tier[t] || t;
      const changed = () => { emit(); render(); };

      box.innerHTML = '';
      const card = box; // everything below renders into the inner box
      card.append(el('h2', { id: 'gfx-title', text: L.title }));

      // Quality preset (choosing one clears overrides).
      const presetSel = el('select', {
        id: 'set-gfx-preset', 'data-gfx': 'preset',
        onchange: (e) => {
          const v = e.target.value;
          const next = choosePreset(g, v);
          delete next.preset;
          s.graphics = next;
          s.quality = v;
          changed();
        },
      }, [['auto', fmt(L.auto, { tier: tierName(detected) })], ...PRESETS.map((p) => [p, tierName(p)])].map(([v, l]) => {
        const o = el('option', { value: v, text: l });
        if (s.quality === v) o.selected = true;
        return o;
      }));
      card.append(el('div', { class: 'field' }, el('label', { for: 'set-gfx-preset', text: L.quality }), presetSel));

      // Render scale 50–200 %.
      const pct = Math.round((Number(g.render_scale) || 1) * 100);
      const out = el('output', { id: 'gfx-scale-value', for: 'set-gfx-scale', text: pct + '%' });
      card.append(el('div', { class: 'field' },
        el('div', { class: 'gfx-scale-row' }, el('label', { for: 'set-gfx-scale', text: L.renderScale }), out),
        el('input', {
          type: 'range', id: 'set-gfx-scale', 'data-gfx': 'render_scale', min: 50, max: 200, step: 5, value: pct,
          'aria-valuetext': pct + '%',
          oninput: (e) => { out.textContent = e.target.value + '%'; e.target.setAttribute('aria-valuetext', e.target.value + '%'); },
          onchange: (e) => { g.render_scale = Number(e.target.value) / 100; changed(); },
        })));

      // One select per category.
      const grid = el('div', { class: 'gfx-grid' });
      for (const [cat, tiers] of Object.entries(CATEGORIES)) {
        const sel = el('select', {
          id: 'set-gfx-' + cat, 'data-gfx-cat': cat,
          onchange: (e) => {
            if (e.target.value === 'preset') delete g[cat]; else g[cat] = e.target.value;
            changed();
          },
        }, [['preset', fmt(L.fromPreset, { tier: tierName(presetTier(effective, cat)) })], ...tiers.map((t) => [t, tierName(t)])].map(([v, l]) => {
          const o = el('option', { value: v, text: l });
          if ((g[cat] || 'preset') === v) o.selected = true;
          return o;
        }));
        grid.append(el('div', { class: 'field' }, el('label', { for: 'set-gfx-' + cat, text: L.cat[cat] }), sel));
      }
      card.append(grid);

      const toggle = (id, key, label, hint, value) => el('div', { class: 'switch-row' },
        el('div', {}, el('label', { for: id, text: label }), hint ? el('p', { class: 'hint', text: hint }) : null),
        el('input', {
          type: 'checkbox', class: 'switch', id, 'data-gfx': key, checked: value,
          onchange: (e) => { g[key] = e.target.checked; changed(); },
        }));
      card.append(
        toggle('set-gfx-adaptive', 'adaptive', L.adaptive, L.adaptiveHint, g.adaptive !== false),
        toggle('set-gfx-fps', 'show_fps', L.showFps, null, !!g.show_fps));

      card.append(el('div', { class: 'field' },
        el('label', { for: 'set-cameraView', text: L.camera }),
        el('select', { id: 'set-cameraView', onchange: (e) => { s.cameraView = e.target.value; emit(); } },
          [['default', L.cameraDefault], ['top', L.cameraTop]].map(([v, l]) => {
            const o = el('option', { value: v, text: l });
            if (s.cameraView === v) o.selected = true;
            return o;
          }))));

      const summary = info
        ? [info.gpu || L.sum.gpu, info.level != null ? L.sum.level.replace('{n}', info.level) : null, describe(info.resolved, info.pixels, L.sum)].filter(Boolean).join(' · ')
        : '';
      card.append(el('p', { class: 'hint gfx-summary', id: 'gfx-summary', 'data-gfx-preset': info ? info.resolved.preset : '', text: summary }));
      if (info && info.postFailed) card.append(el('p', { class: 'hint gfx-warn', id: 'gfx-post-note', role: 'status', text: L.postFailed }));
      card.append(el('p', { class: 'hint', text: L.note }));

      if (focusId) { const f = card.querySelector('#' + CSS.escape(focusId)); if (f) f.focus({ preventScroll: true }); }
    };
    render();
    refreshGraphicsCard = () => { if (card.isConnected) render(); else refreshGraphicsCard = null; };
    return card;
  }

  // -------------------------------------------------------------------------
  // Settings application (CSS-level) + form
  // -------------------------------------------------------------------------

  function applySettings(s) {
    currentSettings = s;
    const b = document.body;
    b.classList.toggle('large-text', !!s.largeText);
    b.classList.toggle('high-contrast', !!s.highContrast);
    b.classList.toggle('reduced-motion', !!s.reducedMotion);
    b.classList.toggle('left-handed', !!s.leftHanded);
    for (const p of ['deuteranopia', 'protanopia', 'tritanopia']) {
      b.classList.toggle('palette-' + p, s.colorPalette === p);
    }
  }

  function settingsForm(inner, s) {
    const grid = el('div', { class: 'form-grid' });
    const emit = () => onAction('settings-changed', { settings: s });

    const slider = (key, label) => el('div', { class: 'field' },
      el('label', { for: 'set-' + key, text: label }),
      el('input', {
        type: 'range', id: 'set-' + key, min: 0, max: 1, step: 0.05, value: s[key],
        oninput: (e) => { s[key] = parseFloat(e.target.value); emit(); },
      }));

    const toggle = (key, label, hint) => el('div', { class: 'switch-row' },
      el('div', {}, el('label', { for: 'set-' + key, text: label }), hint ? el('p', { class: 'hint', text: hint }) : null),
      el('input', {
        type: 'checkbox', class: 'switch', id: 'set-' + key, checked: !!s[key],
        onchange: (e) => { s[key] = e.target.checked; emit(); },
      }));

    const select = (key, label, options, hint) => el('div', { class: 'field' },
      el('label', { for: 'set-' + key, text: label }),
      el('select', {
        id: 'set-' + key,
        onchange: (e) => { s[key] = e.target.value; emit(); },
      }, options.map(([v, l]) => {
        const o = el('option', { value: v, text: l });
        if (s[key] === v) o.selected = true;
        return o;
      })),
      hint ? el('p', { class: 'hint', text: hint }) : null);

    const BIND_LABELS = {
      up: N('Up'), down: N('Down'), left: N('Left'), right: N('Right'), pause: N('Pause'), confirm: N('Confirm'),
      cancel: N('Cancel'), undo: N('Undo'), hint: N('Hint'), cameraReset: N('Camera reset'),
    };
    // The audio, accessibility and bindings cards are rebuilt on a language
    // change; the graphics card only redraws its inner box (shared sections stay).
    const cards = {
      audio: () => el('div', { class: 'card', 'data-card': 'audio' }, el('h2', { text: T('Audio') }),
        slider('music', T('Music')), slider('sfx', T('Effects')), slider('ambience', T('Ambience')), slider('voice', T('Voice cues')),
        toggle('muted', T('Mute all audio'))),
      access: () => el('div', { class: 'card', 'data-card': 'access' }, el('h2', { text: T('Accessibility') }),
        toggle('reducedMotion', T('Reduced motion'), T('Removes camera swoops, shake, and rapid particles.')),
        toggle('highContrast', T('High contrast')),
        toggle('largeText', T('Larger text')),
        select('colorPalette', T('Color palette'), [['standard', T('Standard')], ['deuteranopia', T('Deuteranopia-safe')], ['protanopia', T('Protanopia-safe')], ['tritanopia', T('Tritanopia-safe')]]),
        toggle('leftHanded', T('Left-handed controls')),
        toggle('haptics', T('Haptics (vibration)')),
        toggle('captions', T('Sound captions'), T('Text cues for meaningful audio.')),
        toggle('timingAssist', T('Timing assistance'), T('Slightly slower serpent. Rounds become unranked.'))),
      bindings: () => el('div', { class: 'card', 'data-card': 'bindings' }, el('h2', { text: T('Keyboard bindings') }),
        ...Object.entries(s.bindings).map(([action, keys]) =>
          el('div', { class: 'bind-row' },
            el('span', { text: BIND_LABELS[action] ? T(BIND_LABELS[action]) : action[0].toUpperCase() + action.slice(1) }),
            el('span', { class: 'bind-keys' },
              keys.map((k) => el('kbd', { text: k.replace('Arrow', '') })),
              el('button', {
                class: 'btn small ghost', type: 'button',
                onclick: (e) => {
                  e.target.textContent = T('press key…');
                  const handler = (ev) => {
                    ev.preventDefault();
                    document.removeEventListener('keydown', handler, true);
                    onAction('rebind', { action, key: ev.code });
                  };
                  document.addEventListener('keydown', handler, true);
                },
              }, T('Rebind')))))),
    };
    const nodes = { audio: cards.audio(), access: cards.access(), bindings: cards.bindings() };
    grid.append(nodes.audio, graphicsCard(s, emit), nodes.access, nodes.bindings);
    inner.append(grid);
    return () => {
      for (const k of Object.keys(nodes)) { const n = cards[k](); nodes[k].replaceWith(n); nodes[k] = n; }
      if (refreshGraphicsCard) refreshGraphicsCard();
    };
  }

  // -------------------------------------------------------------------------
  // Screen builders
  // -------------------------------------------------------------------------

  const SCREEN_BUILDERS = {
    title(inner, vm) {
      inner.append(
        el('h1', { text: 'Serpent Quest' }),
        el('p', { class: 'subtitle', text: T('Steer. Grow. Outwit the garden.') }),
      );
      if (vm.snapshot) {
        inner.append(el('div', { class: 'card' },
          el('h2', { text: T('Interrupted round found') }),
          el('p', { class: 'muted', text: vm.snapshot.label }),
          el('div', { class: 'btn-row' },
            el('button', { class: 'btn primary', 'data-autofocus': '1', type: 'button', onclick: () => onAction('resume-snapshot') }, T('Resume round')),
            el('button', { class: 'btn ghost', type: 'button', onclick: () => onAction('discard-snapshot') }, T('Discard')))));
      }
      inner.append(
        el('div', { class: 'menu-stack' },
          el('button', { class: 'btn primary', type: 'button', 'data-autofocus': vm.snapshot ? null : '1', onclick: () => onAction('quick-play') }, T('▶ Play')),
          el('button', { class: 'btn', type: 'button', onclick: () => onAction('nav-modes') }, T('Modes')),
          el('button', { class: 'btn', type: 'button', onclick: () => onAction('daily-play') }, vm.dailyLabel || T('Daily challenge')),
          el('button', { class: 'btn', type: 'button', onclick: () => onAction('nav-progression') }, T('Journey & achievements')),
          el('button', { class: 'btn', type: 'button', onclick: () => onAction('nav-boards') }, T('Leaderboards')),
          vm.signedIn ? el('button', { class: 'btn ghost', type: 'button', id: 'btn-invite', onclick: () => onAction('invite') }, shText('invite')) : null,
          vm.canSignIn && !vm.signedIn ? el('button', { class: 'btn ghost', type: 'button', id: 'btn-signin', onclick: () => onAction('sign-in') }, shText('signIn')) : null,
        ),
        el('p', { class: 'muted', text: vm.progressText || '' }),
      );
    },

    modes(inner) {
      inner.append(el('h1', { text: T('Choose a mode') }));
      const modes = [
        ['learn', T('Learn'), T('Interactive lessons — one rule at a time.')],
        ['journey', T('Journey'), T('A 42-stage authored path with mastery gates.')],
        ['daily', T('Daily'), T('One shared garden per UTC day. Ranked.')],
        ['practice', T('Practice'), T('Your pace: difficulty, undo, unranked.')],
        ['challenge', T('Challenge'), T('Constrained goals: move limits, speed, mazes.')],
        ['chase', T('Score chase'), T('One long run. Highest score wins.')],
      ];
      inner.append(el('div', { class: 'grid-list' }, modes.map(([id, name, desc]) =>
        el('button', {
          class: 'mode-card', type: 'button',
          onclick: () => onAction('mode-' + id),
        },
          el('span', { class: 'mode-name', text: name }),
          el('span', { class: 'mode-desc', text: desc })))));
      inner.append(backRow());
    },

    journey(inner, vm) {
      inner.append(el('h1', { text: T('Journey') }), el('p', { class: 'subtitle', text: vm.summary || '' }));
      const list = el('div', { class: 'menu-stack' });
      for (const st of vm.stages) {
        list.append(el('button', {
          class: 'stage-row' + (st.locked ? ' locked' : ''), type: 'button', disabled: st.locked,
          onclick: () => onAction('select-stage', { id: st.id }),
        },
          el('span', { class: 'stage-num', text: String(st.index) }),
          el('span', { class: 'stage-name', text: st.name }),
          st.mastery ? el('span', { class: 'tag mastery', text: T('Mastery') }) : null,
          st.won ? el('span', { class: 'tag done', text: T('Cleared') }) : null,
          el('span', { class: 'stage-best', text: st.bestScore ? T('Best {score}', { score: st.bestScore }) : '' })));
      }
      inner.append(list, backRow());
    },

    learn(inner, vm) {
      inner.append(el('h1', { text: T('Learn') }), el('p', { class: 'subtitle', text: T('Each lesson unlocks by doing, not reading.') }));
      const list = el('div', { class: 'menu-stack' });
      vm.tutorials.forEach((t, i) => {
        const locked = i > 0 && !vm.tutorials[i - 1].done;
        list.append(el('button', {
          class: 'stage-row' + (locked ? ' locked' : ''), type: 'button', disabled: locked,
          onclick: () => onAction('select-tutorial', { id: t.id }),
        },
          el('span', { class: 'stage-name', text: t.name }),
          t.done ? el('span', { class: 'tag done', text: T('Done') }) : null));
      });
      inner.append(list, backRow());
    },

    challenges(inner, vm) {
      inner.append(el('h1', { text: T('Challenges') }));
      inner.append(el('div', { class: 'grid-list' }, vm.challenges.map((c) =>
        el('button', { class: 'mode-card', type: 'button', onclick: () => onAction('select-challenge', { id: c.id }) },
          el('span', { class: 'mode-name', text: c.name }),
          el('span', { class: 'mode-desc', text: c.desc }),
          c.best ? el('span', { class: 'tag done', text: T('Best {score}', { score: c.best }) }) : null))));
      inner.append(backRow());
    },

    setup(inner, vm) {
      inner.append(el('h1', { text: vm.title }), el('p', { class: 'subtitle', text: vm.subtitle || '' }));
      const facts = el('div', { class: 'card' },
        el('h2', { text: T('Round rules') }),
        el('ul', {}, vm.facts.map((f) => el('li', { text: f }))),
        el('p', {},
          el('span', { class: 'tag ' + (vm.ranked ? 'ranked' : 'unranked'), text: T(vm.ranked ? 'Ranked' : 'Unranked') }),
          el('span', { class: 'tag', text: T('1 player') }),
          el('span', { class: 'tag', text: vm.durationText }),
          vm.assistsText ? el('span', { class: 'tag', text: vm.assistsText }) : null));
      inner.append(facts);
      if (vm.controls) {
        const card = el('div', { class: 'card' }, el('h2', { text: T('How to steer') }),
          el('ul', {}, vm.controls.map((f) => el('li', { text: f }))));
        if (vm.suggestLearn) {
          card.append(el('p', { class: 'muted' }, T('First time?') + ' ',
            el('button', { class: 'btn small', type: 'button', onclick: () => onAction('mode-learn') }, T('Try the Learn lessons'))));
        }
        inner.append(card);
      }
      if (vm.options) {
        const card = el('div', { class: 'card' }, el('h2', { text: T('Options') }));
        for (const opt of vm.options) {
          card.append(el('div', { class: 'field' },
            el('label', { for: 'opt-' + opt.key, text: opt.label }),
            el('select', {
              id: 'opt-' + opt.key,
              onchange: (e) => onAction('setup-option', { key: opt.key, value: e.target.value }),
            }, opt.choices.map(([v, l]) => {
              const o = el('option', { value: v, text: l });
              if (String(opt.value) === String(v)) o.selected = true;
              return o;
            }))));
        }
        inner.append(card);
      }
      inner.append(el('div', { class: 'btn-row' },
        el('button', { class: 'btn primary', type: 'button', 'data-autofocus': '1', onclick: () => onAction('start-setup') }, T('Start round')),
        backButton()));
    },

    results(inner, vm) {
      inner.append(el('h1', { class: 'result-headline ' + (vm.won ? 'won' : 'lost'), text: vm.headline }));
      inner.append(el('p', { class: 'subtitle', text: vm.reasonText }));
      const rows = [
        [T('Food'), vm.score.food], [T('Growth'), vm.score.growth], [T('Rivals defeated'), vm.score.rivals],
        [T('Survival'), vm.score.survival], [T('Objectives'), vm.score.objective],
      ];
      inner.append(el('div', { class: 'card' },
        el('h2', { text: T('Score breakdown') }),
        el('table', { class: 'score-table' },
          rows.map(([k, v]) => el('tr', {}, el('td', { text: k }), el('td', { text: String(v) }))),
          el('tr', { class: 'total' }, el('td', { text: T('Total') }), el('td', { text: String(vm.score.total) }))),
        el('p', { class: 'muted', text: vm.metaText })));
      if (vm.achievements?.length) {
        inner.append(el('div', { class: 'card' }, el('h2', { text: T('Achievements unlocked') }),
          el('ul', {}, vm.achievements.map((a) => el('li', { text: a })))));
      }
      if (vm.comparison) {
        inner.append(el('div', { class: 'card' }, el('h2', { text: T('Comparison') }),
          el('p', { text: vm.comparison })));
      }
      if (vm.leaderboard) inner.append(el('p', { id: 'results-lb', 'aria-live': 'polite', text: vm.leaderboard }));
      if (vm.progressText) inner.append(el('p', { class: 'muted', text: vm.progressText }));
      inner.append(el('div', { class: 'btn-row' },
        el('button', { class: 'btn primary', type: 'button', 'data-autofocus': '1', onclick: () => onAction(vm.nextAction) }, vm.nextLabel),
        vm.nextAction !== 'restart'
          ? el('button', { class: 'btn', type: 'button', onclick: () => onAction('restart') }, T('Retry'))
          : null,
        vm.canReplay ? el('button', { class: 'btn', type: 'button', onclick: () => onAction('watch-replay') }, T('Watch replay')) : null,
        el('button', { class: 'btn ghost', type: 'button', onclick: () => onAction('quit') }, T('Leave'))));
    },

    help(inner, vm) {
      inner.append(el('h1', { text: T('How to play') }));
      const b = vm.bindings;
      const keys = (a) => (b[a] || []).map((k) => k.replace('Arrow', '')).join(' / ');
      const cards = [
        ['🐍', T('Steering'), T('Turn with {up}, {left}, {down}, {right}, swipe, the on-screen pad, or tap a tile. The serpent always moves forward.', { up: keys('up'), left: keys('left'), down: keys('down'), right: keys('right') })],
        ['🍓', T('Food'), T('Berries grow your serpent and add score. Golden berries are worth far more and grow two segments.')],
        ['🪨', T('Hazards'), T('Walls, rocks, hedges, and your own body end the round. Plan ahead — you cannot reverse.')],
        ['🟡', T('Small rivals'), T('Golden rivals are prey: catch any part of one with your head to defeat it for a big bonus.')],
        ['🟤', T('Big rivals'), T('Dark plated rivals hunt you. Any contact is fatal. They telegraph by shape: spikes mean danger.')],
        ['🎯', T('Objectives'), T('Each round lists its goals. Complete all of them to win; finishing under par earns bonus points.')],
        ['↩', T('Undo & hints'), T('Undo ({undo}) and hints ({hint}) are available in Practice. Pause with {pause}.', { undo: keys('undo'), hint: keys('hint'), pause: keys('pause') })],
        ['🏆', T('Scoring'), T('Score = food + growth + rival defeats + survival + objectives. Ties break on completion, then fewer invalid moves, then faster time.')],
      ];
      inner.append(el('div', { class: 'help-cards' }, cards.map(([g, t, d]) =>
        el('div', { class: 'help-card' }, el('div', { class: 'help-glyph', 'aria-hidden': 'true', text: g }),
          el('h3', { text: t }), el('p', { text: d })))));
      inner.append(backRow());
    },

    settings(inner, vm) {
      const h1 = el('h1', { text: T('Settings') });
      inner.append(h1);
      const relabelForm = settingsForm(inner, vm.settings);
      const replay = el('button', { class: 'btn', type: 'button', onclick: () => onAction('replay-tutorials') }, T('Replay tutorials'));
      const back = backButton();
      inner.append(el('div', { class: 'btn-row' }, replay, back));
      // Language change: relabel in place (keeps focus and the shared sections).
      settingsRelabel = () => {
        h1.textContent = T('Settings');
        relabelForm();
        replay.textContent = T('Replay tutorials');
        back.textContent = T('← Back');
      };
    },

    progression(inner, vm) {
      inner.append(el('h1', { text: T('Progression') }));
      inner.append(el('div', { class: 'card' },
        el('h2', { text: T('Journey') }),
        el('p', { text: vm.journeyText }),
        el('p', { class: 'muted', text: vm.masteryText })));
      inner.append(el('div', { class: 'card' },
        el('h2', { text: T('Achievements') }),
        el('ul', {}, vm.achievements.map((a) =>
          el('li', {}, `${a.unlocked ? '🏅' : '🔒'} ${T(a.name)} — ${T(a.desc)}`)))));
      inner.append(el('div', { class: 'card' },
        el('h2', { text: T('Cosmetics') }),
        el('p', { class: 'muted', text: T('Cosmetics change looks only — never hitboxes, timing, or power.') }),
        el('div', { class: 'btn-row' }, vm.cosmetics.map((c) =>
          el('button', {
            class: 'btn small' + (c.equipped ? ' primary' : ''), type: 'button', disabled: !c.unlocked,
            onclick: () => onAction('equip-cosmetic', { id: c.id }),
          }, c.unlocked ? T(c.name) : T('{name} ({cost} mastery)', { name: T(c.name), cost: c.cost }))))));
      inner.append(el('div', { class: 'btn-row' },
        el('button', { class: 'btn', type: 'button', onclick: () => onAction('nav-journey') }, T('Open journey map')),
        backButton()));
    },

    profile(inner, vm) {
      inner.append(el('h1', { text: T('Profile') }));
      const p = { ...vm.profile };
      const card = el('div', { class: 'card' });
      if (vm.readOnly) {
        // Hosted: the display name is the account nickname (read-only here).
        card.append(
          el('div', { class: 'field' },
            el('label', { text: T('Display name') }),
            el('p', { text: pname(p.displayName) })),
          el('p', { class: 'muted', text: vm.accountText }),
        );
      } else {
        card.append(
          el('div', { class: 'field' },
            el('label', { for: 'prof-name', text: T('Display name') }),
            el('input', { type: 'text', id: 'prof-name', value: pname(p.displayName), maxlength: 24, oninput: (e) => { p.displayName = e.target.value; } })),
          el('p', { class: 'muted', text: vm.accountText }),
          el('div', { class: 'btn-row' },
            el('button', { class: 'btn primary', type: 'button', onclick: () => onAction('profile-save', { profile: p }) }, T('Save'))),
        );
      }
      if (vm.syncText) card.append(el('p', { class: 'muted', text: vm.syncText }));
      inner.append(card, backRow());
    },

    boards(inner, vm) {
      inner.append(el('h1', { text: T('Leaderboards') }));
      const tabs = el('div', { class: 'tabs', role: 'tablist' });
      const listWrap = el('div', {});
      const renderList = (board) => {
        listWrap.innerHTML = '';
        if (board.casual) listWrap.append(el('p', { class: 'muted', text: T('Casual board — offline scores are not server-validated.') }));
        if (!board.entries.length) listWrap.append(el('p', { class: 'muted', text: T('No scores yet. Be the first!') }));
        listWrap.append(el('div', { class: 'board-list' }, board.entries.map((e, i) => {
          const meta = [e.ruleset, e.seed != null ? T('seed {seed}', { seed: e.seed }) : null].filter(Boolean).join(' · ');
          return el('div', { class: 'board-row' + (e.me ? ' me' : '') },
            el('span', { text: '#' + (i + 1) }),
            el('span', {}, pname(e.name), meta ? el('span', { class: 'muted', text: ' · ' + meta }) : null),
            el('span', { text: String(e.score) }),
            el('span', { class: 'muted', text: e.when || '' }));
        })));
      };
      vm.boards.forEach((b, i) => {
        tabs.append(el('button', {
          role: 'tab', 'aria-selected': i === 0 ? 'true' : 'false', type: 'button',
          onclick: (e) => {
            tabs.querySelectorAll('[role="tab"]').forEach((t) => t.setAttribute('aria-selected', 'false'));
            e.target.setAttribute('aria-selected', 'true');
            renderList(b);
          },
        }, b.name));
      });
      inner.append(tabs, listWrap, backRow());
      if (vm.boards.length) renderList(vm.boards[0]);
    },
  };

  function backButton() {
    return el('button', { class: 'btn ghost', type: 'button', onclick: () => onAction('back') }, T('← Back'));
  }
  function backRow() {
    return el('div', { class: 'btn-row' }, backButton());
  }

  // -------------------------------------------------------------------------
  // Accessible board mirror — concise navigable model, not decoration dump.
  // -------------------------------------------------------------------------

  const DIR_NAMES = { up: N('up'), down: N('down'), left: N('left'), right: N('right') };
  let mirrorTimer = 0;
  function mirror(state) {
    const now = performance.now();
    if (now - mirrorTimer < 1000) return; // throttle announcements
    mirrorTimer = now;
    if (!state) return;
    const head = state.snake.body[0];
    const food = state.food.map((f) => T(f.kind === 'golden' ? N('golden berry at column {x}, row {y}') : N('berry at column {x}, row {y}'), { x: f.x + 1, y: f.y + 1 })).join('; ');
    const threats = state.rivals.filter((r) => r.alive && r.tier === 'big')
      .map((r) => T('hunter at column {x}, row {y}', { x: r.body[0].x + 1, y: r.body[0].y + 1 })).join('; ');
    $('#board-mirror').textContent =
      T('Arena {w} by {h}. Serpent length {len}, heading {dir}, head at column {x}, row {y}.', {
        w: state.grid.w, h: state.grid.h, len: state.snake.body.length, dir: T(DIR_NAMES[state.snake.dir] || state.snake.dir), x: head.x + 1, y: head.y + 1,
      }) + ' ' + T('Food: {list}.', { list: food || T('none') }) + ' ' + (threats ? T('Threats: {list}', { list: threats }) : T('No hunters.'));
  }

  let avatarUrl = null; // account avatar (StarHermit), shown in the profile chip
  function setAvatar(url) {
    avatarUrl = url;
    $('#chip-avatar').style.background = `center / cover no-repeat url("${url}")`;
  }

  function updateTopbar(vm) {
    $('#chip-name').textContent = pname(vm.profileName);
    $('#chip-avatar').style.background = avatarUrl ? `center / cover no-repeat url("${avatarUrl}")` : (vm.avatarColor || 'var(--accent)');
    $('#chip-daily').textContent = vm.dailyText;
  }

  function wireStatic(settings) {
    buildTray();
    $('#btn-help-top').addEventListener('click', () => onAction('nav-help'));
    $('#btn-settings-top').addEventListener('click', () => onAction('nav-settings'));
    $('#chip-profile').addEventListener('click', () => onAction('nav-profile'));
    $('#chip-daily').addEventListener('click', () => onAction('daily-play'));
    applySettings(settings);
  }

  /** Language change: relabel what the UI owns (open pause card, settings in place). */
  function relabel() {
    if (pauseVm && $('#pause-overlay')?.classList.contains('active')) showPause(true, pauseVm, false);
    if (activeScreen === 'settings' && settingsRelabel) settingsRelabel();
  }

  return {
    relabel,
    setAvatar,
    showScreen, closeScreen, get activeScreen() { return activeScreen; },
    setHudVisible, updateHUD, updateRails,
    announce, toast, caption, countdown,
    showPause, applySettings, mirror, updateTopbar,
    wireStatic,
    setGraphicsInfo(fn) { graphicsInfo = fn || (() => null); },
    refreshGraphics() { if (refreshGraphicsCard) refreshGraphicsCard(); },
    setLoading(progress, label) {
      $('#loading-bar').value = progress;
      if (label) $('#loading-label').textContent = label;
    },
    finishLoading() { $('#loading').hidden = true; },
    showCompat() { $('#loading').hidden = true; $('#compat').hidden = false; },
    showChrome(v) { $('#topbar').hidden = !v; $('#stage').hidden = !v; },
    THEMES,
  };
}
