// UI module: semantic HTML shell over the canvas. Owns screens, HUD, rails,
// drawers/sheets, focus management, live announcements, captions, settings
// forms, help cards, results, and the accessible board mirror.
// Knows nothing about rules internals; speaks in view models + onAction events.

import { THEMES } from './content.js';
import { PRESETS, CATEGORIES, presetTier, describe, choosePreset, normalizePreset } from './gfx.js';
import { gfxStrings, fmt } from './gfx-strings.js';

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

  // -------------------------------------------------------------------------
  // Screen manager with focus restoration
  // -------------------------------------------------------------------------

  const topbar = document.getElementById('topbar');
  const syncTopbarInset = () => {
    const h = topbar && !topbar.hidden ? topbar.getBoundingClientRect().height : 0;
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
    const names = { food: 'Berries eaten', length: 'Serpent length', rivals: 'Rivals defeated', survive: 'Ticks survived', score: 'Score', lesson: 'Lesson progress' };
    return names[g.kind] || g.kind;
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
    if (vm.movesLeft != null) obj.append(el('div', { text: `Moves left: ${vm.movesLeft}` }));
    if (vm.timeLeft != null) obj.append(el('div', { text: `Time left: ${vm.timeLeft}` }));
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
      el('h2', { text: vm.title || 'Objective' }),
      el('ul', {}, (vm.goals || []).map((g) =>
        el('li', { text: `${goalLabel(g)} — ${Math.min(g.progress, g.count)}/${g.count}${g.done ? ' ✓' : ''}` }))),
      vm.parText ? el('p', { text: vm.parText }) : null,
    ));
    if (vm.progressionText) {
      left.append(el('div', { class: 'rail-card' }, el('h3', { text: 'Journey' }), el('p', { text: vm.progressionText })));
    }
    right.append(el('div', { class: 'rail-card' },
      el('h3', { text: 'Score' }),
      el('ul', {}, Object.entries(vm.scoreParts || {}).map(([k, v]) => el('li', { text: `${k}: ${v}` }))),
    ));
    if (vm.statusText) {
      right.append(el('div', { class: 'rail-card' }, el('h3', { text: 'Status' }), el('p', { text: vm.statusText })));
    }
  }

  // Drawer versions of the rails for compact layouts.
  function openDrawer(side) {
    const rail = side === 'left' ? $('#rail-left') : $('#rail-right');
    const scrim = el('div', { class: 'sheet-scrim' });
    const sheet = el('div', { class: 'sheet ' + side, role: 'dialog', 'aria-label': side === 'left' ? 'Objective' : 'Status' });
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

  function buildTray() {
    const tray = $('#action-tray');
    const left = $('#tray-left');
    const right = $('#tray-right');
    left.innerHTML = '';
    right.innerHTML = '';
    const dpad = el('div', { class: 'dpad', role: 'group', 'aria-label': 'Steering' });
    for (const [dir, glyph, label] of [['up', '▲', 'Steer up'], ['left', '◀', 'Steer left'], ['right', '▶', 'Steer right'], ['down', '▼', 'Steer down']]) {
      dpad.append(el('button', {
        class: 'tray-btn', type: 'button', 'data-dir': dir, 'aria-label': label,
        onclick: () => onAction('steer', { dir }),
      }, glyph));
    }
    left.append(dpad);
    right.append(
      el('button', { class: 'tray-btn', id: 'tray-btn-hint', type: 'button', 'aria-label': 'Hint', onclick: () => onAction('hint') }, '💡'),
      el('button', { class: 'tray-btn', id: 'tray-btn-undo', type: 'button', 'aria-label': 'Undo', onclick: () => onAction('undo') }, '↩'),
      el('button', { class: 'tray-btn', type: 'button', 'aria-label': 'Pause', onclick: () => onAction('pause') }, '❚❚'),
    );

    const wrap = $('#canvas-wrap');
    if (!$('#drawer-left-btn')) {
      const l = el('button', { class: 'icon-btn drawer-btns', id: 'drawer-left-btn', type: 'button', 'aria-label': 'Open objective panel', onclick: () => openDrawer('left') }, '🎯');
      const r = el('button', { class: 'icon-btn drawer-btns', id: 'drawer-right-btn', type: 'button', 'aria-label': 'Open status panel', onclick: () => openDrawer('right') }, '📊');
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
    t.textContent = msg;
    t.className = kind;
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
    c.textContent = value > 0 ? String(value) : 'Go!';
    c.classList.remove('pop');
    void c.offsetWidth; // restart animation
    c.classList.add('pop');
    if (value > 0) announce(String(value));
  }

  // -------------------------------------------------------------------------
  // Pause overlay
  // -------------------------------------------------------------------------

  function showPause(open, vm = {}) {
    let overlay = $('#pause-overlay');
    if (!overlay) {
      overlay = el('div', { id: 'pause-overlay' });
      $('#canvas-wrap').append(overlay);
    }
    overlay.innerHTML = '';
    overlay.classList.toggle('active', open);
    if (!open) return;
    const card = el('div', { class: 'card pause-card', role: 'dialog', 'aria-label': 'Paused' },
      el('h2', { text: 'Paused' }),
      vm.summary ? el('p', { class: 'muted', text: vm.summary }) : null,
      el('button', { class: 'btn primary', type: 'button', onclick: () => onAction('resume') }, 'Resume'),
      el('button', { class: 'btn', type: 'button', onclick: () => onAction('restart') }, 'Restart round'),
      el('button', { class: 'btn', type: 'button', onclick: () => onAction('nav-settings') }, 'Settings'),
      el('button', { class: 'btn', type: 'button', onclick: () => onAction('nav-help') }, 'Help'),
      el('button', { class: 'btn danger', type: 'button', onclick: () => onAction('quit') }, 'Leave round'),
    );
    overlay.append(card);
    card.querySelector('button').focus({ preventScroll: true });
  }

  // -------------------------------------------------------------------------
  // Graphics section: preset, render scale, per-effect overrides, adaptive
  // resolution, frame-rate readout, GPU/cost summary. Localized via
  // gfx-strings.js (browser language). Rebuilt in place on every change so
  // the "From preset (…)" labels follow the chosen preset.
  // -------------------------------------------------------------------------

  function graphicsCard(s, emit) {
    const L = gfxStrings(typeof navigator !== 'undefined' ? navigator.language : 'en-US');
    const card = el('div', { class: 'card gfx-card', id: 'gfx-card', role: 'group', 'aria-labelledby': 'gfx-title' });

    const render = () => {
      const focusId = document.activeElement && card.contains(document.activeElement) ? document.activeElement.id : null;
      s.quality = normalizePreset(s.quality);
      if (!s.graphics || typeof s.graphics !== 'object') s.graphics = {};
      const g = s.graphics;
      const info = graphicsInfo();
      const detected = info ? info.detected : 'balanced';
      const effective = s.quality === 'auto' ? detected : s.quality;
      const tierName = (t) => L.tier[t] || t;
      const changed = () => { emit(); render(); };

      card.innerHTML = '';
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
        ? `${info.gpu || L.sum.gpu} · ${describe(info.resolved, info.pixels, L.sum)}`
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

    grid.append(
      el('div', { class: 'card' }, el('h2', { text: 'Audio' }),
        slider('music', 'Music'), slider('sfx', 'Effects'), slider('ambience', 'Ambience'), slider('voice', 'Voice cues'),
        toggle('muted', 'Mute all audio')),
      graphicsCard(s, emit),
      el('div', { class: 'card' }, el('h2', { text: 'Accessibility' }),
        toggle('reducedMotion', 'Reduced motion', 'Removes camera swoops, shake, and rapid particles.'),
        toggle('highContrast', 'High contrast'),
        toggle('largeText', 'Larger text'),
        select('colorPalette', 'Color palette', [['standard', 'Standard'], ['deuteranopia', 'Deuteranopia-safe'], ['protanopia', 'Protanopia-safe'], ['tritanopia', 'Tritanopia-safe']]),
        toggle('leftHanded', 'Left-handed controls'),
        toggle('haptics', 'Haptics (vibration)'),
        toggle('captions', 'Sound captions', 'Text cues for meaningful audio.'),
        toggle('timingAssist', 'Timing assistance', 'Slightly slower serpent. Rounds become unranked.'),
        toggle('telemetryConsent', 'Anonymous usage statistics', 'Start, tutorial, round-end, and error events only.')),
      el('div', { class: 'card' }, el('h2', { text: 'Keyboard bindings' }),
        ...Object.entries(s.bindings).map(([action, keys]) =>
          el('div', { class: 'bind-row' },
            el('span', { text: action[0].toUpperCase() + action.slice(1) }),
            el('span', { class: 'bind-keys' },
              keys.map((k) => el('kbd', { text: k.replace('Arrow', '') })),
              el('button', {
                class: 'btn small ghost', type: 'button',
                onclick: (e) => {
                  e.target.textContent = 'press key…';
                  const handler = (ev) => {
                    ev.preventDefault();
                    document.removeEventListener('keydown', handler, true);
                    onAction('rebind', { action, key: ev.code });
                  };
                  document.addEventListener('keydown', handler, true);
                },
              }, 'Rebind'))))),
    );
    inner.append(grid);
  }

  // -------------------------------------------------------------------------
  // Screen builders
  // -------------------------------------------------------------------------

  const SCREEN_BUILDERS = {
    title(inner, vm) {
      inner.append(
        el('h1', { text: 'Serpent Quest' }),
        el('p', { class: 'subtitle', text: 'Steer. Grow. Outwit the garden.' }),
      );
      if (vm.snapshot) {
        inner.append(el('div', { class: 'card' },
          el('h2', { text: 'Interrupted round found' }),
          el('p', { class: 'muted', text: vm.snapshot.label }),
          el('div', { class: 'btn-row' },
            el('button', { class: 'btn primary', 'data-autofocus': '1', type: 'button', onclick: () => onAction('resume-snapshot') }, 'Resume round'),
            el('button', { class: 'btn ghost', type: 'button', onclick: () => onAction('discard-snapshot') }, 'Discard'))));
      }
      inner.append(
        el('div', { class: 'menu-stack' },
          el('button', { class: 'btn primary', type: 'button', 'data-autofocus': vm.snapshot ? null : '1', onclick: () => onAction('quick-play') }, '▶ Play'),
          el('button', { class: 'btn', type: 'button', onclick: () => onAction('nav-modes') }, 'Modes'),
          el('button', { class: 'btn', type: 'button', onclick: () => onAction('daily-play') }, vm.dailyLabel || 'Daily challenge'),
          el('button', { class: 'btn', type: 'button', onclick: () => onAction('nav-progression') }, 'Journey & achievements'),
          el('button', { class: 'btn', type: 'button', onclick: () => onAction('nav-boards') }, 'Leaderboards'),
        ),
        el('p', { class: 'muted', text: vm.progressText || '' }),
      );
    },

    modes(inner) {
      inner.append(el('h1', { text: 'Choose a mode' }));
      const modes = [
        ['learn', 'Learn', 'Interactive lessons — one rule at a time.'],
        ['journey', 'Journey', 'A 42-stage authored path with mastery gates.'],
        ['daily', 'Daily', 'One shared garden per UTC day. Ranked.'],
        ['practice', 'Practice', 'Your pace: difficulty, undo, unranked.'],
        ['challenge', 'Challenge', 'Constrained goals: move limits, speed, mazes.'],
        ['chase', 'Score chase', 'One long run. Highest score wins.'],
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
      inner.append(el('h1', { text: 'Journey' }), el('p', { class: 'subtitle', text: vm.summary || '' }));
      const list = el('div', { class: 'menu-stack' });
      for (const st of vm.stages) {
        list.append(el('button', {
          class: 'stage-row' + (st.locked ? ' locked' : ''), type: 'button', disabled: st.locked,
          onclick: () => onAction('select-stage', { id: st.id }),
        },
          el('span', { class: 'stage-num', text: String(st.index) }),
          el('span', { class: 'stage-name', text: st.name }),
          st.mastery ? el('span', { class: 'tag mastery', text: 'Mastery' }) : null,
          st.won ? el('span', { class: 'tag done', text: 'Cleared' }) : null,
          el('span', { class: 'stage-best', text: st.bestScore ? 'Best ' + st.bestScore : '' })));
      }
      inner.append(list, backRow());
    },

    learn(inner, vm) {
      inner.append(el('h1', { text: 'Learn' }), el('p', { class: 'subtitle', text: 'Each lesson unlocks by doing, not reading.' }));
      const list = el('div', { class: 'menu-stack' });
      vm.tutorials.forEach((t, i) => {
        const locked = i > 0 && !vm.tutorials[i - 1].done;
        list.append(el('button', {
          class: 'stage-row' + (locked ? ' locked' : ''), type: 'button', disabled: locked,
          onclick: () => onAction('select-tutorial', { id: t.id }),
        },
          el('span', { class: 'stage-name', text: t.name }),
          t.done ? el('span', { class: 'tag done', text: 'Done' }) : null));
      });
      inner.append(list, backRow());
    },

    challenges(inner, vm) {
      inner.append(el('h1', { text: 'Challenges' }));
      inner.append(el('div', { class: 'grid-list' }, vm.challenges.map((c) =>
        el('button', { class: 'mode-card', type: 'button', onclick: () => onAction('select-challenge', { id: c.id }) },
          el('span', { class: 'mode-name', text: c.name }),
          el('span', { class: 'mode-desc', text: c.desc }),
          c.best ? el('span', { class: 'tag done', text: 'Best ' + c.best }) : null))));
      inner.append(backRow());
    },

    setup(inner, vm) {
      inner.append(el('h1', { text: vm.title }), el('p', { class: 'subtitle', text: vm.subtitle || '' }));
      const facts = el('div', { class: 'card' },
        el('h2', { text: 'Round rules' }),
        el('ul', {}, vm.facts.map((f) => el('li', { text: f }))),
        el('p', {},
          el('span', { class: 'tag ' + (vm.ranked ? 'ranked' : 'unranked'), text: vm.ranked ? 'Ranked' : 'Unranked' }),
          el('span', { class: 'tag', text: '1 player' }),
          el('span', { class: 'tag', text: vm.durationText }),
          vm.assistsText ? el('span', { class: 'tag', text: vm.assistsText }) : null));
      inner.append(facts);
      if (vm.controls) {
        const card = el('div', { class: 'card' }, el('h2', { text: 'How to steer' }),
          el('ul', {}, vm.controls.map((f) => el('li', { text: f }))));
        if (vm.suggestLearn) {
          card.append(el('p', { class: 'muted' }, 'First time? ',
            el('button', { class: 'btn small', type: 'button', onclick: () => onAction('mode-learn') }, 'Try the Learn lessons')));
        }
        inner.append(card);
      }
      if (vm.options) {
        const card = el('div', { class: 'card' }, el('h2', { text: 'Options' }));
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
        el('button', { class: 'btn primary', type: 'button', 'data-autofocus': '1', onclick: () => onAction('start-setup') }, 'Start round'),
        backButton()));
    },

    results(inner, vm) {
      inner.append(el('h1', { class: 'result-headline ' + (vm.won ? 'won' : 'lost'), text: vm.headline }));
      inner.append(el('p', { class: 'subtitle', text: vm.reasonText }));
      const rows = [
        ['Food', vm.score.food], ['Growth', vm.score.growth], ['Rivals defeated', vm.score.rivals],
        ['Survival', vm.score.survival], ['Objectives', vm.score.objective],
      ];
      inner.append(el('div', { class: 'card' },
        el('h2', { text: 'Score breakdown' }),
        el('table', { class: 'score-table' },
          rows.map(([k, v]) => el('tr', {}, el('td', { text: k }), el('td', { text: String(v) }))),
          el('tr', { class: 'total' }, el('td', { text: 'Total' }), el('td', { text: String(vm.score.total) }))),
        el('p', { class: 'muted', text: vm.metaText })));
      if (vm.achievements?.length) {
        inner.append(el('div', { class: 'card' }, el('h2', { text: 'Achievements unlocked' }),
          el('ul', {}, vm.achievements.map((a) => el('li', { text: a })))));
      }
      if (vm.comparison) {
        inner.append(el('div', { class: 'card' }, el('h2', { text: 'Comparison' }),
          el('p', { text: vm.comparison })));
      }
      if (vm.progressText) inner.append(el('p', { class: 'muted', text: vm.progressText }));
      inner.append(el('div', { class: 'btn-row' },
        el('button', { class: 'btn primary', type: 'button', 'data-autofocus': '1', onclick: () => onAction(vm.nextAction) }, vm.nextLabel),
        vm.nextAction !== 'restart'
          ? el('button', { class: 'btn', type: 'button', onclick: () => onAction('restart') }, 'Retry')
          : null,
        vm.canReplay ? el('button', { class: 'btn', type: 'button', onclick: () => onAction('watch-replay') }, 'Watch replay') : null,
        el('button', { class: 'btn ghost', type: 'button', onclick: () => onAction('quit') }, 'Leave')));
    },

    help(inner, vm) {
      inner.append(el('h1', { text: 'How to play' }));
      const b = vm.bindings;
      const keys = (a) => (b[a] || []).map((k) => k.replace('Arrow', '')).join(' / ');
      const cards = [
        ['🐍', 'Steering', `Turn with ${keys('up')}, ${keys('left')}, ${keys('down')}, ${keys('right')}, swipe, the on-screen pad, or tap a tile. The serpent always moves forward.`],
        ['🍓', 'Food', 'Berries grow your serpent and add score. Golden berries are worth far more and grow two segments.'],
        ['🪨', 'Hazards', 'Walls, rocks, hedges, and your own body end the round. Plan ahead — you cannot reverse.'],
        ['🟡', 'Small rivals', 'Golden rivals are prey: catch any part of one with your head to defeat it for a big bonus.'],
        ['🟤', 'Big rivals', 'Dark plated rivals hunt you. Any contact is fatal. They telegraph by shape: spikes mean danger.'],
        ['🎯', 'Objectives', 'Each round lists its goals. Complete all of them to win; finishing under par earns bonus points.'],
        ['↩', 'Undo & hints', `Undo (${keys('undo')}) and hints (${keys('hint')}) are available in Practice. Pause with ${keys('pause')}.`],
        ['🏆', 'Scoring', 'Score = food + growth + rival defeats + survival + objectives. Ties break on completion, then fewer invalid moves, then faster time.'],
      ];
      inner.append(el('div', { class: 'help-cards' }, cards.map(([g, t, d]) =>
        el('div', { class: 'help-card' }, el('div', { class: 'help-glyph', 'aria-hidden': 'true', text: g }),
          el('h3', { text: t }), el('p', { text: d })))));
      inner.append(backRow());
    },

    settings(inner, vm) {
      inner.append(el('h1', { text: 'Settings' }));
      settingsForm(inner, vm.settings);
      inner.append(el('div', { class: 'btn-row' },
        el('button', { class: 'btn', type: 'button', onclick: () => onAction('replay-tutorials') }, 'Replay tutorials'),
        backButton()));
    },

    progression(inner, vm) {
      inner.append(el('h1', { text: 'Progression' }));
      inner.append(el('div', { class: 'card' },
        el('h2', { text: 'Journey' }),
        el('p', { text: vm.journeyText }),
        el('p', { class: 'muted', text: vm.masteryText })));
      inner.append(el('div', { class: 'card' },
        el('h2', { text: 'Achievements' }),
        el('ul', {}, vm.achievements.map((a) =>
          el('li', {}, a.unlocked ? `🏅 ${a.name} — ${a.desc}` : `🔒 ${a.name} — ${a.desc}`)))));
      inner.append(el('div', { class: 'card' },
        el('h2', { text: 'Cosmetics' }),
        el('p', { class: 'muted', text: 'Cosmetics change looks only — never hitboxes, timing, or power.' }),
        el('div', { class: 'btn-row' }, vm.cosmetics.map((c) =>
          el('button', {
            class: 'btn small' + (c.equipped ? ' primary' : ''), type: 'button', disabled: !c.unlocked,
            onclick: () => onAction('equip-cosmetic', { id: c.id }),
          }, c.name + (c.unlocked ? '' : ` (${c.cost} mastery)`))))));
      inner.append(el('div', { class: 'btn-row' },
        el('button', { class: 'btn', type: 'button', onclick: () => onAction('nav-journey') }, 'Open journey map'),
        backButton()));
    },

    profile(inner, vm) {
      inner.append(el('h1', { text: 'Profile' }));
      const p = { ...vm.profile };
      const card = el('div', { class: 'card' });
      if (vm.readOnly) {
        // Hosted: the display name is the account nickname (read-only here).
        card.append(
          el('div', { class: 'field' },
            el('label', { text: 'Display name' }),
            el('p', { text: p.displayName })),
          el('p', { class: 'muted', text: vm.accountText }),
        );
      } else {
        card.append(
          el('div', { class: 'field' },
            el('label', { for: 'prof-name', text: 'Display name' }),
            el('input', { type: 'text', id: 'prof-name', value: p.displayName, maxlength: 24, oninput: (e) => { p.displayName = e.target.value; } })),
          el('p', { class: 'muted', text: vm.accountText }),
          el('div', { class: 'btn-row' },
            el('button', { class: 'btn primary', type: 'button', onclick: () => onAction('profile-save', { profile: p }) }, 'Save')),
        );
      }
      if (vm.syncText) card.append(el('p', { class: 'muted', text: vm.syncText }));
      inner.append(card, backRow());
    },

    boards(inner, vm) {
      inner.append(el('h1', { text: 'Leaderboards' }));
      const tabs = el('div', { class: 'tabs', role: 'tablist' });
      const listWrap = el('div', {});
      const renderList = (board) => {
        listWrap.innerHTML = '';
        if (board.casual) listWrap.append(el('p', { class: 'muted', text: 'Casual board — offline scores are not server-validated.' }));
        if (!board.entries.length) listWrap.append(el('p', { class: 'muted', text: 'No scores yet. Be the first!' }));
        listWrap.append(el('div', { class: 'board-list' }, board.entries.map((e, i) => {
          const meta = [e.ruleset, e.seed != null ? 'seed ' + e.seed : null].filter(Boolean).join(' · ');
          return el('div', { class: 'board-row' + (e.me ? ' me' : '') },
            el('span', { text: '#' + (i + 1) }),
            el('span', {}, e.name, meta ? el('span', { class: 'muted', text: ' · ' + meta }) : null),
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
    return el('button', { class: 'btn ghost', type: 'button', onclick: () => onAction('back') }, '← Back');
  }
  function backRow() {
    return el('div', { class: 'btn-row' }, backButton());
  }

  // -------------------------------------------------------------------------
  // Accessible board mirror — concise navigable model, not decoration dump.
  // -------------------------------------------------------------------------

  let mirrorTimer = 0;
  function mirror(state) {
    const now = performance.now();
    if (now - mirrorTimer < 1000) return; // throttle announcements
    mirrorTimer = now;
    if (!state) return;
    const head = state.snake.body[0];
    const food = state.food.map((f) => `${f.kind === 'golden' ? 'golden berry' : 'berry'} at column ${f.x + 1}, row ${f.y + 1}`).join('; ');
    const threats = state.rivals.filter((r) => r.alive && r.tier === 'big')
      .map((r) => `hunter at column ${r.body[0].x + 1}, row ${r.body[0].y + 1}`).join('; ');
    $('#board-mirror').textContent =
      `Arena ${state.grid.w} by ${state.grid.h}. Serpent length ${state.snake.body.length}, heading ${state.snake.dir}, ` +
      `head at column ${head.x + 1}, row ${head.y + 1}. Food: ${food || 'none'}. ${threats ? 'Threats: ' + threats : 'No hunters.'}`;
  }

  function updateTopbar(vm) {
    $('#chip-name').textContent = vm.profileName;
    $('#chip-avatar').style.background = vm.avatarColor || 'var(--accent)';
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

  return {
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
