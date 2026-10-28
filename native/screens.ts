// The browser build's DOM shell (index.html + js/ui.js) as starhermit:ui,
// built every frame over the arena: the top bar (profile chip, the Daily
// chip with the time to the next garden, Help and Settings), the Objective
// and Score / Status rails (drawers behind 🎯 / 📊 on compact layouts), the
// HUD (mode, goals, moves and time left, score), the countdown, the toast
// and the sound captions, the action tray (steering pad; Hint, Undo, Pause —
// mirrored for left-handed play), the pause card, the accessible board
// mirror (a named target over the playfield), and every full-page screen
// over the garden (title, modes, journey, learn, challenges, setup, results,
// help, settings, progression, profile, leaderboards). The old media queries
// are layouts picked by the window's logical size: wide (≥ 1024 px: both
// rails), compact (< 1024: the drawers), portrait phones (≤ 700 px wide:
// the Daily chip on its own row of the bar) and short landscape (≤ 500 px
// tall: a slimmer bar, 48 px tray buttons, the pause card in two columns).
// The arena is fitted into the playfield they leave (main.ts stage).
import { frame, openMenu } from "starhermit:engine";
import { bindings, primaryPointer, requestRebind } from "starhermit:input";
import * as audio from "./audio.ts";
import * as draw from "starhermit:draw";
import * as ui from "starhermit:ui";
import { BUILD_VERSION, Content, Progress, type BoardEntry, type Dir, type Goal } from "./game.ts";
import { N, S, T, pname } from "./i18n.ts";
import * as platform from "./platform.ts";
import {
  ACHIEVEMENTS, COSMETICS, app, boards, canUndo, chaseDescriptor, copyInvite, currentFlow, dailyChipText, dailyDescriptor, dailyLabel,
  describeFacts, discardSnapshot, doHint, doUndo, durationText, equipCosmetic, fresh, ghostEntries, goBack, hudRects, inRound,
  isRanked, isReplay, later, leaderboardLine, lessonGoal, modeLabel, navigate, now, openMode, openOverRound, playerName,
  playerSteer, playing, progression, quickPlay, quitRound, replayTutorials, resolveDescriptor, restartRound, resultsNext, resume, resumeSnapshot,
  saveGuestName, selectChallenge, selectStage, session, setSetupOption, signIn, snapshotLabel, stage, startLesson, startSetup, togglePause, watchReplay,
} from "./main.ts";
import { token } from "./style.ts";

// ------------------------------------------------------------------ layout
interface Layout { lw: number; lh: number; sc: number; wide: boolean; phone: boolean; short: boolean }
function layoutNow(): Layout {
  const f = frame();
  const sc = ui.preferences().scale;
  const sa = f.safeArea;
  const lw = Math.max(1, (f.width - sa.left - sa.right) / sc), lh = Math.max(1, (f.height - sa.top - sa.bottom) / sc);
  return { lw, lh, sc, wide: lw >= 1024, phone: lw <= 700 && lh > lw, short: lh <= 500 && lw > lh };
}
const lastSize = new Map<string, ui.Rect>();
function textWidth(text: string, style: string, kind?: "button" | "heading"): number {
  return ui.measureText(text, { ...(kind ? { kind } : {}), style: [style] }).width / ui.preferences().scale;
}
/** Text up to `width` wide: one label when it fits, else a paragraph. */
function para(text: string, width: number, cls = "text", id?: string, size?: number): void {
  if (!text) return;
  let u = size ? ui.style(cls, { text: { size } }) : ui.style(cls);
  if (id) u = u.id(id);
  if (ui.measureText(text, { style: [cls], ...(size ? { size } : {}) }).width / ui.preferences().scale <= width) u.label(text);
  else u.paragraph(text, Math.max(20, width));
}
interface Btn { id: string; text: string; style?: string; act: () => void; disabled?: boolean; name?: string; selected?: boolean; content?: () => void; width?: number; height?: number; click?: boolean }
const buttonWidth = (text: string, style: string): number => textWidth(text, style, "button") + 4;
function button(b: Btn): void {
  const style = b.style ?? "btn";
  const opts: ui.ButtonOptions = {};
  if (b.disabled) opts.disabled = true;
  if (b.selected !== undefined) opts.selected = b.selected;
  if (b.content) opts.content = b.content;
  else if (b.name && b.name !== b.text) opts.content = () => { ui.label(b.text); };
  const s: ui.Style = {};
  if (b.width != null) s.width = b.width;
  if (b.height != null) s.height = b.height;
  if (ui.style(style, s).id(b.id).button(b.name ?? b.text, opts) && fresh()) later(() => { if (b.click !== false) clickSound(style); b.act(); });
}
/** ui.js: buttons click (Back plays its own sound; the steering pad its turn tick). */
function clickSound(style: string): void { void style; audio.play("ui-click"); }
/** Buttons at their own widths in rows that wrap at `width` (flex-wrap). */
function flow(label: string, list: Btn[], width: number, gap = 10, justify: "start" | "center" | "end" = "center"): void {
  const rows: Btn[][] = [[]];
  let used = 0;
  const bw = (b: Btn): number => Math.min(width, b.width ?? buttonWidth(b.text, b.style ?? "btn"));
  for (const b of list) {
    const w = bw(b);
    if (rows[rows.length - 1]!.length && used + gap + w > width) { rows.push([]); used = 0; }
    used += (rows[rows.length - 1]!.length ? gap : 0) + w;
    rows[rows.length - 1]!.push(b);
  }
  ui.column(label, () => {
    rows.forEach((row, ri) => ui.row(`${label}-r${ri}`, () => { for (const b of row) button(b); }, { spacing: gap, width, justify, align: "center" }));
  }, { spacing: gap, width });
}
function rect(r: ui.Rect): void { hudRects.push({ x: r.x, y: r.y, width: r.width, height: r.height }); }
/** A box over a window rectangle (window px) drawn by a placed role-none widget. */
function paint(id: string, x: number, y: number, w: number, h: number, drawFn: (r: ui.Rect) => void): void {
  if (w <= 0 || h <= 0) return;
  const sc = ui.preferences().scale, sa = frame().safeArea;
  ui.place(id, { anchor: "top-start", x: (x - sa.left) / sc, y: (y - sa.top) / sc }, () => {
    ui.widget("", { role: "none", size: { width: w / sc, height: h / sc }, draw: drawFn });
  });
}
function toWindow(x: number, y: number, w: number, h: number): ui.Rect {
  const sc = ui.preferences().scale, sa = frame().safeArea;
  return { x: sa.left + x * sc, y: sa.top + y * sc, width: w * sc, height: h * sc };
}
function tag(text: string, kind: "" | "good" | "warn" | "mastery" = ""): void {
  ui.column(`tag-${text}`, () => ui.style(kind ? `tag-${kind}-text` : "tag-text").label(text), { style: kind ? `tag-${kind}` : "tag" });
}

// ------------------------------------------------------------------ the frame
export function drawScreens(): void {
  const L = layoutNow();
  const barH = topbarHeight(L);
  const railW = L.wide ? 260 : 0;
  Object.assign(stage, toWindow(railW, barH, L.lw - 2 * railW, L.lh - barH));
  playArea(L, barH, railW);
  if (app.screen) fullScreen(L, barH);
  else if (app.pause && session?.paused) pauseCard(L);
  else if (app.drawer) drawerSheet(L, barH);
  topbar(L);
  toastLine(L, barH);
  const f = frame();
  if (app.focusNext) {
    const age = f.frame - app.openedFrame;
    if (age >= 1) ui.setFocus(app.focusNext);
    if (age >= 3) app.focusNext = null;
  }
}

// ------------------------------------------------------------------ the top bar (index.html #topbar)
function topbarHeight(L: Layout): number {
  const prev = lastSize.get("bar");
  return prev ? prev.height / L.sc : L.phone ? 100 : L.short ? 52 : 56;
}
function topbar(L: Layout): void {
  const name = pname(playerName());
  const chipMax = L.phone ? L.lw - 150 : Math.max(80, L.lw * 0.4);
  const profile = (): void => button({
    id: "chip-profile", text: name, name: T("Profile"), style: "chip", act: () => { openOverRound("profile"); if (!platform.signedIn() && primaryPointer() !== "coarse") app.focusNext = "prof-name"; },
    content: () => ui.row("chip-profile-face", () => {
      ui.widget("", { role: "none", size: { width: 18, height: 18 }, draw: (r) => draw.circle(r.x + r.width / 2, r.y + r.height / 2, r.width / 2, token("accent")) });
      para(name, Math.min(chipMax - 60, textWidth(name, "chip-text") + 2), "chip-text");
    }, { spacing: 7, align: "center" }),
  });
  const daily = (w: number): void => {
    const text = dailyChipText();
    button({ id: "chip-daily", text, name: text, style: "chip", act: () => { navigateDaily(); }, content: () => para(text, w - 30, "chip-text") });
  };
  const icons = (): void => void ui.row("topbar-actions", () => {
    button({ id: "btn-help-top", text: "?", name: T("Help"), style: "icon-btn", act: () => openOverRound("help"), content: () => ui.style("icon-glyph").label("?") });
    button({ id: "btn-settings-top", text: "⚙", name: T("Settings"), style: "icon-btn", act: () => openOverRound("settings"), content: () => ui.style("icon-glyph").label("⚙") });
  }, { spacing: 8, align: "center" });
  const bar = ui.place("topbar", { anchor: "top-start", x: 0, y: 0 }, () => {
    ui.column("topbar-col", () => {
      if (L.phone) {
        ui.row("topbar-row", () => { profile(); ui.spacer(); icons(); }, { width: L.lw - 20, spacing: 8, align: "center" });
        ui.row("topbar-row2", () => daily(L.lw - 20), { width: L.lw - 20, justify: "center" });
      } else {
        ui.row("topbar-row", () => {
          profile();
          ui.spacer();
          daily(Math.min(L.lw * 0.45, 420));
          ui.spacer();
          icons();
        }, { width: L.lw - 20, spacing: 8, align: "center" });
      }
    }, { style: "topbar", width: L.lw, spacing: 8, ...(L.short ? { padding: { top: 4, bottom: 4, start: 10, end: 10 } } : {}) });
  });
  lastSize.set("bar", bar);
  rect(bar);
}
function navigateDaily(): void { openMode("daily"); }

// ------------------------------------------------------------------ the playfield (index.html #stage)
function playArea(L: Layout, barH: number, railW: number): void {
  const sc = L.sc;
  const st = { x: railW, y: barH, w: L.lw - 2 * railW, h: L.lh - barH };
  // The rails' panels (the HUD and goals only during a round).
  if (L.wide) {
    for (const side of ["left", "right"] as const) {
      const x = side === "left" ? 0 : L.lw - railW;
      paint(`rail-${side}-bg`, toWindow(x, barH, 0, 0).x, toWindow(0, barH, 0, 0).y, railW * sc, (L.lh - barH) * sc, (r) => {
        draw.rect(r.x, r.y, r.width, r.height, alpha(token("panel"), 0.92));
        draw.rect(side === "left" ? r.x + r.width - Math.max(1, sc) : r.x, r.y, Math.max(1, sc), r.height, "#ffffff14");
      });
      if (session && currentFlow) {
        const r = ui.place(`rail-${side}`, { anchor: "top-start", x: x + 12, y: barH + 12 }, () => {
          ui.column(`rail-${side}-col`, () => (side === "left" ? leftRail(railW - 24) : rightRail(railW - 24)), { spacing: 12, width: railW - 24 });
        });
        rect(r);
      }
    }
  }
  if (!session || !currentFlow || app.screen) return;
  const s = session.state;
  // The drawer buttons (compact).
  let hudL = st.x + 12, hudR = 12 + (L.wide ? railW : 0);
  if (!L.wide) {
    const b1 = ui.place("drawer-left-btn", { anchor: "top-start", x: st.x + 8, y: st.y + 8 }, () => button({ id: "drawer-left-btn", text: "🎯", name: T("Open objective panel"), style: "icon-btn", act: () => { app.drawer = "left"; } }));
    const b2 = ui.place("drawer-right-btn", { anchor: "top-end", x: 8, y: st.y + 8 }, () => button({ id: "drawer-right-btn", text: "📊", name: T("Open status panel"), style: "icon-btn", act: () => { app.drawer = "right"; } }));
    rect(b1); rect(b2);
    hudL = st.x + 58; hudR = 58;
  }
  // The HUD: the objective box and the score.
  const goals = goalsNow();
  const hudW = Math.max(120, (st.w - (hudL - st.x) - hudR - 70) * (L.wide ? 0.6 : 1));
  const hud = ui.place("hud", { anchor: "top-start", x: hudL, y: st.y + 8 }, () => {
    ui.column("hud-objective", () => {
      const label = modeLabel(currentFlow!.mode) + (currentFlow!.ranked ? "" : " · " + T("unranked")) + (currentFlow!.descriptor.name ? " — " + T(String(currentFlow!.descriptor.name)) : "");
      para(label, hudW, L.phone ? "dim-small" : "hud-mode", "hud-mode");
      goals.forEach((g, i) => para(`${goalLabel(g)}: ${Math.min(g.progress, g.count)} / ${g.count}${g.done ? " ✓" : ""}`, hudW, g.done ? "hud-done" : "hud-text", `hud-goal-${i}`));
      if (s.config.moveLimit) para(T("Moves left: {n}", { n: Math.max(0, s.config.moveLimit - s.stats.commands) }), hudW, "hud-text", "hud-moves");
      if (s.config.maxTicks) para(T("Time left: {n}", { n: Math.max(0, Math.ceil(((s.config.maxTicks - s.tick) * s.config.tickMs) / 1000)) + "s" }), hudW, "hud-text", "hud-time");
    }, { style: "hud-box", spacing: 0 });
  });
  rect(hud);
  const score = ui.place("hud-score", { anchor: "top-end", x: hudR, y: st.y + 8 }, () => {
    ui.column("hud-score-box", () => ui.style("hud-score-text").id("hud-score").label(String(s.score.total)), { style: "hud-box" });
  });
  rect(score);
  // The board mirror for screen readers (index.html #board-mirror), refreshed at most once a second.
  ui.target(mirrorText(), stage, { role: "label" });
  // The countdown.
  if (app.countdown) {
    const age = Math.min(1, (now() - app.countdown.at) / 900); // the old #countdown.pop animation: 1.35 → 0.95 over 0.9 s
    const big = Math.max(64, Math.min(144, 0.18 * Math.min(L.lw, L.lh))); // clamp(4rem, 18vmin, 9rem)
    const size = big * (1.35 - 0.4 * Math.min(1, age));
    ui.place("countdown", { anchor: "top-start", x: st.x, y: st.y + st.h / 2 - size * 0.7 }, () => {
      ui.column("countdown-col", () => { ui.style("countdown", { text: { size } }).id("countdown").label(app.countdown!.text); }, { width: st.w, align: "center" });
    });
  }
  // The caption (above the thumb zone) and the tray.
  if (app.caption) {
    ui.place("caption", { anchor: "top-start", x: st.x, y: st.y + st.h * 0.78 - 30 }, () => {
      ui.column("caption-row", () => ui.column("caption-box", () => para(app.caption!.text, Math.min(st.w * 0.8, 46 * 8), "caption-text", "caption-text"), { style: "caption", align: "center" }), { width: st.w, align: "center" });
    });
  }
  tray(L, st);
}
const alpha = (c: string, a: number): string => c.slice(0, 7) + Math.round(a * 255).toString(16).padStart(2, "0");

function goalsNow(): Goal[] {
  const lg = lessonGoal();
  return lg ? [lg] : session!.state.goals;
}
function goalLabel(g: { kind: string }): string {
  const names: Record<string, string> = { food: N("Berries eaten"), length: N("Serpent length"), rivals: N("Rivals defeated"), survive: N("Ticks survived"), score: N("Score"), lesson: N("Lesson progress") };
  return names[g.kind] ? T(names[g.kind]!) : g.kind;
}
function leftRail(w: number): void {
  const s = session!.state;
  ui.column("rail-objective", () => {
    para(T("Objective"), w - 28, "rail-h");
    for (const [i, g] of goalsNow().entries()) para(`• ${goalLabel(g)} — ${Math.min(g.progress, g.count)}/${g.count}${g.done ? " ✓" : ""}`, w - 28, "rail-text", `rail-goal-${i}`);
    if (s.config.parTicks) para(T("Par: {n} ticks", { n: s.config.parTicks }), w - 28, "rail-text");
  }, { style: "rail-card", width: w, spacing: 4 });
  ui.column("rail-journey", () => {
    para(T("Journey"), w - 28, "rail-h");
    const cleared = Object.values(progression().stages).filter((x) => x.won).length;
    para(T("{cleared}/{total} journey stages", { cleared, total: Content.JOURNEY_STAGES.length }), w - 28, "rail-text");
  }, { style: "rail-card", width: w, spacing: 4 });
}
function rightRail(w: number): void {
  const s = session!.state;
  ui.column("rail-score", () => {
    para(T("Score"), w - 28, "rail-h");
    const parts: [string, number][] = [[T("Food"), s.score.food], [T("Growth"), s.score.growth], [T("Rivals"), s.score.rivals], [T("Survival"), s.score.survival], [T("Objectives"), s.score.objective]];
    parts.forEach(([k, v], i) => para(`• ${k}: ${v}`, w - 28, "rail-text", `rail-score-${i}`));
  }, { style: "rail-card", width: w, spacing: 4 });
  ui.column("rail-status", () => {
    para(T("Status"), w - 28, "rail-h");
    const text = T("Length {len} · tick {tick}", { len: s.snake.body.length, tick: s.tick }) + (s.rivals.some((r) => r.alive && r.tier === "big") ? " · " + T("a hunter prowls!") : "");
    para(text, w - 28, "rail-text", "rail-status-text");
  }, { style: "rail-card", width: w, spacing: 4 });
}
let mirror = { text: "", at: -1e9 };
/** ui.js mirror(): a concise description of the arena (refreshed at most once a second). */
function mirrorText(): string {
  const t = frame().time;
  if (t - mirror.at < 1 && mirror.text) return mirror.text;
  const s = session!.state;
  const head = s.snake.body[0]!;
  const food = s.food.map((f) => T(f.kind === "golden" ? N("golden berry at column {x}, row {y}") : N("berry at column {x}, row {y}"), { x: f.x + 1, y: f.y + 1 })).join("; ");
  const threats = s.rivals.filter((r) => r.alive && r.tier === "big").map((r) => T("hunter at column {x}, row {y}", { x: r.body[0]!.x + 1, y: r.body[0]!.y + 1 })).join("; ");
  const dirs: Record<Dir, string> = { up: N("up"), down: N("down"), left: N("left"), right: N("right") };
  mirror = {
    at: t,
    text: T("Arena {w} by {h}. Serpent length {len}, heading {dir}, head at column {x}, row {y}.", { w: s.grid.w, h: s.grid.h, len: s.snake.body.length, dir: T(dirs[s.snake.dir]), x: head.x + 1, y: head.y + 1 })
      + " " + T("Food: {list}.", { list: food || T("none") }) + " " + (threats ? T("Threats: {list}", { list: threats }) : T("No hunters.")),
  };
  return mirror.text;
}

/** index.html #action-tray: the steering pad and Hint / Undo / Pause (left-handed: mirrored). */
function tray(L: Layout, st: { x: number; y: number; w: number; h: number }): void {
  const live = playing();
  const size = L.short ? 48 : 52, gap = 8;
  const left = platform.options.leftHanded;
  const pad = (): void => {
    ui.column("dpad", () => {
      const cell = (dir: Dir | null, glyph: string, label: string): void => {
        if (!dir) { ui.widget("", { role: "none", size: { width: size, height: size } }); return; }
        button({ id: `tray-${dir}`, text: glyph, name: T(label), style: "tray-btn", width: size, height: size, disabled: !live, click: false, act: () => playerSteer(dir), content: () => ui.style("tray-glyph").label(glyph) });
      };
      ui.row("dpad-1", () => { cell(null, "", ""); cell("up", "▲", N("Steer up")); cell(null, "", ""); }, { spacing: gap });
      ui.row("dpad-2", () => { cell("left", "◀", N("Steer left")); cell(null, "", ""); cell("right", "▶", N("Steer right")); }, { spacing: gap });
      ui.row("dpad-3", () => { cell(null, "", ""); cell("down", "▼", N("Steer down")); cell(null, "", ""); }, { spacing: gap });
    }, { spacing: gap });
  };
  const actions = (): void => {
    const list: [string, string, string, () => void, boolean][] = [
      ["tray-hint", "💡", T("Hint"), doHint, !live],
      ["tray-undo", "↩", T("Undo"), doUndo, !live || !canUndo()],
      ["tray-pause", "", T("Pause"), togglePause, !(inRound() && !isReplay())],
    ];
    if (left) list.reverse();
    ui.row("tray-actions", () => {
      for (const [id, glyph, name, act, disabled] of list) {
        button({
          id, text: name, name, style: "tray-btn", width: size, height: size, disabled, act,
          content: () => glyph ? ui.style("tray-glyph").label(glyph) : ui.widget("", {
            role: "none", size: { width: 22, height: 22 },
            draw: (r, s) => { const bw = 5 * s.scale; draw.rect(r.x + r.width / 2 - bw * 1.5, r.y + 2 * s.scale, bw, r.height - 4 * s.scale, token("ink")); draw.rect(r.x + r.width / 2 + bw * 0.5, r.y + 2 * s.scale, bw, r.height - 4 * s.scale, token("ink")); },
          }),
        });
      }
    }, { spacing: gap });
  };
  const a = ui.place("tray-left", { anchor: "bottom-start", x: st.x + 10, y: 8 }, left ? actions : pad);
  const b = ui.place("tray-right", { anchor: "bottom-end", x: (L.wide ? 260 : 0) + 10, y: 8 }, left ? pad : actions);
  rect(a); rect(b);
}

// ------------------------------------------------------------------ toast (index.html #toast)
function toastLine(L: Layout, barH: number): void {
  const t = app.toast;
  if (!t) return;
  const floating = !!app.screen || !session;
  const w = Math.min(L.lw * 0.8, 46 * 8);
  const st = { x: L.wide && !floating ? 260 : 0, w: L.wide && !floating ? L.lw - 520 : L.lw };
  const y = floating ? L.lh - 20 - 44 : barH + (L.lh - barH) * 0.72 - 20;
  ui.place("toast", { anchor: "top-start", x: st.x, y }, () => {
    ui.column("toast-row", () => ui.column("toast-box", () => para(t.text, w - 30, t.warn ? "toast-warn-text" : "toast-text", "toast-text"), { style: t.warn ? "toast-warn" : "toast", align: "center" }), { width: st.w, align: "center" });
  });
}

// ------------------------------------------------------------------ the pause card (index.html #pause-overlay)
function pauseCard(L: Layout): void {
  const two = L.short;
  const w = Math.min(two ? 520 : 420, 0.92 * L.lw);
  const inner = w - 34;
  const half = (inner - 10) / 2;
  const links: Btn[] = [
    { id: "btn-restart-round", text: T("Restart round"), act: restartRound },
    { id: "btn-pause-settings", text: T("Settings"), act: () => navigate("settings") },
    { id: "btn-pause-help", text: T("Help"), act: () => navigate("help") },
    { id: "btn-leave-round", text: T("Leave round"), style: "btn-danger", act: quitRound },
  ];
  const open = ui.dialog(T("Paused"), "", true, () => {
    ui.column("pause-card", () => {
      para(T("Paused"), inner, "card-h2", "pause-h");
      para(app.pause!.summary(), inner, "dim-small", "pause-summary");
      button({ id: "btn-resume", text: T("Resume"), style: "btn-primary", width: inner, act: resume });
      if (two) {
        for (let i = 0; i < links.length; i += 2) ui.row(`pause-row-${i}`, () => { for (const b of links.slice(i, i + 2)) button({ ...b, width: half }); }, { spacing: 10 });
      } else for (const b of links) button({ ...b, width: inner });
    }, { style: "pause-card", width: w, spacing: two ? 8 : 10 });
  });
  // Escape / Back closes the card: resume (not on the frame it opened).
  if (!open && fresh()) later(resume);
}

// ------------------------------------------------------------------ the rail drawers (compact; ui.js openDrawer)
function drawerSheet(L: Layout, barH: number): void {
  if (!session) { app.drawer = null; return; }
  const side = app.drawer!;
  const w = Math.min(320, L.lw * 0.85);
  const sc = L.sc;
  // The scrim: a tap outside the sheet closes it.
  ui.place("sheet-scrim", { anchor: side === "left" ? "top-end" : "top-start", x: 0, y: 0 }, () => {
    const r = ui.widget(T("Close panel"), { role: "button", size: { width: L.lw - w, height: L.lh }, draw: (q) => draw.rect(q.x, q.y, q.width, q.height, "#000000aa") });
    if (r.activated && fresh()) later(() => { app.drawer = null; });
  });
  ui.place("sheet", { anchor: side === "left" ? "top-start" : "top-end", x: 0, y: 0 }, () => {
    ui.column("sheet-col", () => {
      ui.spacer(Math.max(1, barH - 16));
      if (side === "left") leftRail(w - 32); else rightRail(w - 32);
      button({ id: "btn-sheet-close", text: T("Close"), style: "btn-small", act: () => { app.drawer = null; } });
    }, { style: "sheet", width: w, height: L.lh, spacing: 12 });
  });
  void sc;
}

// ------------------------------------------------------------------ full-page screens (index.html .screen)
function fullScreen(L: Layout, barH: number): void {
  const f = frame();
  // The screen's veil over the garden (color-mix(--bg 82%, transparent); the old backdrop blur is left out).
  const top = toWindow(0, barH, 0, 0).y;
  paint("screen-veil", 0, top, f.width, f.height - top, (r) => draw.rect(r.x, r.y, r.width, r.height, token("bg-82")));
  const name = app.screen!;
  const pinned = name !== "title";
  const footerH = pinned ? (lastSize.get("footer")?.height ?? 70 * L.sc) / L.sc : 0;
  const bodyH = L.lh - barH - footerH;
  const cw = Math.min(L.lw - (L.phone ? 22 : 32), 680);
  const key = `screen-${name}`;
  const prev = lastSize.get(key);
  const scroll = !!prev && prev.height / L.sc > bodyH;
  const opening = f.frame - app.openedFrame <= 6;
  ui.place("screen", { anchor: "top-start", x: 0, y: barH }, () => {
    ui.column("screen-col", () => {
      const body = (): void => {
        const r = ui.column(`${key}-body`, () => {
          ui.column(`${key}-inner`, () => buildScreen(name, cw - (scroll ? 14 : 0), L), { width: cw - (scroll ? 14 : 0), spacing: 16, align: "center" });
        }, { width: L.lw - (scroll ? 14 : 0), align: "center", padding: { top: 16, bottom: 16 } });
        lastSize.set(key, r);
      };
      if (scroll) ui.scrollArea(`${key}-scroll`, { width: L.lw, height: bodyH }, body, opening ? { scrollTo: { top: 0 } } : undefined);
      else { ui.column("screen-centre", () => { ui.spacer(); body(); ui.spacer(); }, { width: L.lw, height: bodyH }); }
    }, { width: L.lw, height: bodyH, spacing: 0 });
  });
  if (pinned) {
    const foot = ui.place("footer", { anchor: "bottom", y: 0 }, () => {
      ui.column("footer-col", () => footer(name, Math.min(L.lw - 24, 680)), { width: L.lw, align: "center", padding: { top: 8, bottom: 12 } });
    });
    lastSize.set("footer", foot);
  }
}
function h1(text: string, L: Layout, id: string): void {
  const size = Math.max(28.8, Math.min(41.6, 0.05 * L.lw));
  para(text, Math.min(L.lw - 40, 700), "screen-h1", id, size);
}
function buildScreen(name: string, w: number, L: Layout): void {
  switch (name) {
    case "title": titleScreen(w, L); break;
    case "modes": modesScreen(w, L); break;
    case "journey": journeyScreen(w, L); break;
    case "learn": learnScreen(w, L); break;
    case "challenges": challengesScreen(w, L); break;
    case "setup": setupScreen(w, L); break;
    case "results": resultsScreen(w, L); break;
    case "help": helpScreen(w, L); break;
    case "settings": settingsScreen(w, L); break;
    case "progression": progressionScreen(w, L); break;
    case "profile": profileScreen(w, L); break;
    case "boards": boardsScreen(w, L); break;
  }
}
const back = (): Btn => ({ id: "btn-back", text: T("← Back"), style: "btn-ghost", act: goBack, click: false });
function footer(name: string, w: number): void {
  if (name === "setup") flow("setup-actions", [{ id: "btn-start", text: T("Start round"), style: "btn-primary", act: startSetup }, back()], w, 10);
  else if (name === "results") {
    const v = app.results;
    if (!v) return;
    const list: Btn[] = [{ id: "btn-results-next", text: v.isReplay ? T("Play again") : v.nextLabel, style: "btn-primary", act: resultsNext }];
    if (!v.isReplay && v.nextAction !== "restart") list.push({ id: "btn-retry", text: T("Retry"), act: restartRound });
    if (v.canReplay) list.push({ id: "btn-watch-replay", text: T("Watch replay"), act: watchReplay });
    list.push({ id: "btn-leave", text: T("Leave"), style: "btn-ghost", act: quitRound });
    flow("results-actions", list, w, 10);
  } else if (name === "settings") flow("settings-actions", [{ id: "btn-replay-tutorials", text: T("Replay tutorials"), act: replayTutorials }, back()], w, 10);
  else if (name === "progression") flow("progression-actions", [{ id: "btn-open-journey", text: T("Open journey map"), act: () => navigate("journey") }, back()], w, 10);
  else if (name === "profile" && !platform.signedIn()) flow("profile-actions", [{ id: "btn-profile-save", text: T("Save"), style: "btn-primary", act: () => saveGuestName(nameDraft ?? "") }, back()], w, 10);
  else button(back());
}
function card(id: string, w: number, build: (inner: number) => void, style = "card"): void {
  ui.column(id, () => build(w - 34), { style, width: w, spacing: 8 });
}
function bullets(id: string, items: string[], w: number, cls = "text"): void {
  items.forEach((t, i) => para(`• ${t}`, w, cls, `${id}-${i}`));
}

// ------------------------------------------------------------------ title (ui.js title)
function titleScreen(w: number, L: Layout): void {
  para("Serpent Quest", L.lw - 40, "screen-h1", "title-h", Math.max(28.8, Math.min(41.6, 0.05 * L.lw)));
  para(T("Steer. Grow. Outwit the garden."), w, "subtitle", "title-sub");
  const snap = platform.save().snapshot ? platform.save() : null;
  if (snap) {
    card("snapshot-card", w, (inner) => {
      para(T("Interrupted round found"), inner, "card-h2");
      para(snapshotLabel() ?? "", inner, "dim-small", "snapshot-label");
      flow("snapshot-actions", [
        { id: "btn-resume-snapshot", text: T("Resume round"), style: "btn-primary", act: resumeSnapshot },
        { id: "btn-discard-snapshot", text: T("Discard"), style: "btn-ghost", act: discardSnapshot },
      ], inner, 10);
    });
  }
  const list: Btn[] = [
    { id: "btn-play", text: T("▶ Play"), style: "btn-primary", act: quickPlay },
    { id: "btn-modes", text: T("Modes"), act: () => navigate("modes") },
    { id: "btn-daily", text: dailyLabel(), act: () => openMode("daily") },
    { id: "btn-progression", text: T("Journey & achievements"), act: () => navigate("progression") },
    { id: "btn-boards", text: T("Leaderboards"), act: () => navigate("boards") },
  ];
  if (platform.signedIn() && platform.inviteLink()) list.push({ id: "btn-invite", text: S("invite"), style: "btn-ghost", act: copyInvite });
  if (!platform.signedIn()) list.push({ id: "btn-signin", text: S("signIn"), style: "btn-ghost", act: signIn });
  ui.column("menu-stack", () => { for (const b of list) button({ ...b, width: w }); }, { spacing: 10, width: w });
  const p = progression();
  const cleared = Object.values(p.stages).filter((s) => s.won).length;
  para(T("Journey: {cleared} / {total} stages cleared · Mastery {mastery} · {name}", { cleared, total: Content.JOURNEY_STAGES.length, mastery: p.masteryPoints, name: pname(playerName()) }), w, "dim", "title-progress");
}

// ------------------------------------------------------------------ modes, journey, learn, challenges
/** CSS repeat(auto-fill, minmax(min, 1fr)). */
function cardGrid(id: string, count: number, w: number, min: number, gap: number, cell: (i: number, cw: number) => void): void {
  const cols = Math.max(1, Math.floor((w + gap) / (min + gap)));
  const cw = (w - (cols - 1) * gap) / cols;
  ui.column(id, () => {
    for (let r = 0; r * cols < count; r++) {
      ui.row(`${id}-r${r}`, () => { for (let i = r * cols; i < Math.min(count, (r + 1) * cols); i++) cell(i, cw); }, { spacing: gap, align: "stretch" });
    }
  }, { spacing: gap, width: w });
}
function modeCard(id: string, name: string, desc: string, cw: number, act: () => void, extra?: () => void): void {
  const inner = cw - 30;
  button({
    id, text: name, name, style: "mode-card", width: cw, act,
    content: () => ui.column(`${id}-face`, () => { para(name, inner, "mode-name"); para(desc, inner, "mode-desc"); extra?.(); }, { spacing: 5, width: inner }),
  });
}
const MODES: [string, string, string][] = [
  ["learn", N("Learn"), N("Interactive lessons — one rule at a time.")],
  ["journey", N("Journey"), N("A 42-stage authored path with mastery gates.")],
  ["daily", N("Daily"), N("One shared garden per UTC day. Ranked.")],
  ["practice", N("Practice"), N("Your pace: difficulty, undo, unranked.")],
  ["challenge", N("Challenge"), N("Constrained goals: move limits, speed, mazes.")],
  ["chase", N("Score chase"), N("One long run. Highest score wins.")],
];
function modesScreen(w: number, L: Layout): void {
  h1(T("Choose a mode"), L, "modes-h");
  cardGrid("mode-list", MODES.length, w, 150, 10, (i, cw) => { const [id, name, desc] = MODES[i]!; modeCard(`mode-${id}`, T(name), T(desc), cw, () => openMode(id)); });
}
function stageRow(id: string, num: string, name: string, w: number, locked: boolean, act: () => void, tags: [string, "" | "good" | "warn" | "mastery"][], best: string): void {
  const label = [num, name, ...tags.map((t) => t[0]), best].filter(Boolean).join(" · ");
  button({
    id, text: label, name: label, style: "stage-row", width: w, disabled: locked, act,
    content: () => ui.row(`${id}-face`, () => {
      if (num) ui.column(`${id}-n`, () => ui.style("stage-num").label(num), { width: 36 });
      ui.column(`${id}-name`, () => para(name, Math.max(60, w - 30 - (num ? 44 : 0) - tags.length * 80 - (best ? 90 : 0)), "stage-name"), { grow: 1 });
      for (const [t, k] of tags) tag(t, k);
      if (best) ui.style("stage-best").label(best);
    }, { spacing: 8, align: "center", width: w - 28 }),
  });
}
function journeyScreen(w: number, L: Layout): void {
  const p = progression();
  const cleared = Object.values(p.stages).filter((s) => s.won).length;
  h1(T("Journey"), L, "journey-h");
  para(T("{cleared} of {total} cleared. Mastery stages award extra points.", { cleared, total: Content.JOURNEY_STAGES.length }), w, "subtitle", "journey-sub");
  ui.column("stage-list", () => {
    Content.JOURNEY_STAGES.forEach((st, i) => {
      const rec = p.stages[st.id];
      const locked = i > 0 && !p.stages[Content.JOURNEY_STAGES[i - 1]!.id]?.won;
      const tags: [string, "" | "good" | "warn" | "mastery"][] = [];
      if (st.kind === "mastery") tags.push([T("Mastery"), "mastery"]);
      if (rec?.won) tags.push([T("Cleared"), "good"]);
      stageRow(`stage-${st.index}`, String(st.index), T(String(st.name)), w, locked, () => selectStage(st), tags, rec?.bestScore ? T("Best {score}", { score: rec.bestScore }) : "");
    });
  }, { spacing: 10, width: w });
}
function learnScreen(w: number, L: Layout): void {
  const p = progression();
  h1(T("Learn"), L, "learn-h");
  para(T("Each lesson unlocks by doing, not reading."), w, "subtitle", "learn-sub");
  ui.column("lesson-list", () => {
    Content.TUTORIALS.forEach((t, i) => {
      const locked = i > 0 && !p.tutorials[Content.TUTORIALS[i - 1]!.id]?.done;
      stageRow(`lesson-${i + 1}`, "", T(t.name), w, locked, () => startLesson(t), p.tutorials[t.id]?.done ? [[T("Done"), "good"]] : [], "");
    });
  }, { spacing: 10, width: w });
}
function challengesScreen(w: number, L: Layout): void {
  h1(T("Challenges"), L, "challenges-h");
  cardGrid("challenge-list", Content.CHALLENGES.length, w, 150, 10, (i, cw) => {
    const c = Content.CHALLENGES[i]!;
    const best = boards().challenges[c.id]?.score || 0;
    modeCard(`challenge-${c.id}`, T(String(c.name)), T(c.desc), cw, () => selectChallenge(c), best ? () => tag(T("Best {score}", { score: best }), "good") : undefined);
  });
}

// ------------------------------------------------------------------ setup (ui.js setup)
function steeringHints(): string[] {
  // primaryPointer() is "none" on a phone until the first touch: phone-sized windows count as touch.
  const coarse = layoutNow().phone || primaryPointer() === "coarse";
  return [
    coarse ? T("Steer with the on-screen pad, a swipe, or by tapping a tile.")
      : T("Steer with {up} {left} {down} {right}, or click a tile.", { up: keysFor("up") || "W", left: keysFor("left") || "A", down: keysFor("down") || "S", right: keysFor("right") || "D" }),
    T("The serpent never stops — it keeps sliding forward until you turn it."),
    T("Hitting a hedge wall, your own tail or a rival ends the round."),
  ];
}
function setupScreen(w: number, L: Layout): void {
  const setup = app.setup;
  if (!setup) return;
  const flowDef = setup.flow;
  const desc = resolveDescriptor(flowDef);
  const config = Content.toRulesConfig(desc);
  const ranked = isRanked(flowDef.mode);
  h1(flowDef.title?.() || (desc.name ? T(String(desc.name)) : T("Set up round")), L, "setup-h");
  const sub = flowDef.subtitle?.() ?? "";
  if (sub) para(sub, w, "subtitle", "setup-sub");
  card("setup-rules", w, (inner) => {
    para(T("Round rules"), inner, "card-h2");
    bullets("setup-fact", describeFacts(desc, config), inner);
    ui.row("setup-tags", () => {
      tag(T(ranked ? "Ranked" : "Unranked"), ranked ? "good" : "warn");
      tag(T("1 player"));
      tag(durationText(desc));
      const assists = platform.options.timingAssist ? T("Timing assist on") : desc.mechanics?.allowUndo ? T("Undo allowed") : null;
      if (assists) tag(assists);
    }, { spacing: 5, align: "center" });
  });
  if (flowDef.mode !== "learn") {
    card("setup-steer", w, (inner) => {
      para(T("How to steer"), inner, "card-h2");
      bullets("setup-hint", steeringHints(), inner);
      const p = progression();
      if (!Object.values(p.tutorials).some((t) => t?.done) && !Object.values(p.stages).some((s) => s?.attempts)) {
        ui.row("setup-learn", () => {
          para(T("First time?"), inner * 0.4, "dim");
          button({ id: "btn-try-learn", text: T("Try the Learn lessons"), style: "btn-small", act: () => navigate("learn") });
        }, { spacing: 8, align: "center" });
      }
    });
  }
  if (flowDef.mode === "practice") {
    card("setup-options", w, (inner) => {
      para(T("Options"), inner, "card-h2");
      const diffs = Content.PRACTICE_DIFFICULTIES;
      const dIdx = Math.max(0, diffs.findIndex((d) => d.id === (setup.options.difficulty || "steady")));
      selectRow("opt-difficulty", T("Difficulty"), dIdx, diffs.map((d) => T(d.name)), inner, (i) => setSetupOption("difficulty", diffs[i]!.id));
      const themes = Content.THEMES;
      const tIdx = Math.max(0, themes.findIndex((t) => t.id === (setup.options.theme || "meadow")));
      selectRow("opt-theme", T("Garden theme"), tIdx, themes.map((t) => T(t.name)), inner, (i) => setSetupOption("theme", themes[i]!.id));
    });
  }
}

// ------------------------------------------------------------------ results (ui.js results)
function resultsScreen(w: number, L: Layout): void {
  const v = app.results;
  if (!v) return;
  const r = v.results;
  para(v.headline, Math.min(L.lw - 40, 700), v.won ? "result-won" : "result-lost", "result-headline");
  if (v.reasonText) para(v.reasonText, w, "subtitle", "result-reason");
  card("score-card", w, (inner) => {
    para(T("Score breakdown"), inner, "card-h2");
    const rows: [string, number][] = [[T("Food"), r.score.food], [T("Growth"), r.score.growth], [T("Rivals defeated"), r.score.rivals], [T("Survival"), r.score.survival], [T("Objectives"), r.score.objective]];
    ui.column("score-table", () => {
      rows.forEach(([k, n], i) => ui.row(`score-${i}`, () => {
        ui.column(`score-${i}-k`, () => para(k, inner - 100, "td"), { grow: 1 });
        ui.style("td-num").id(`score-${i}-v`).label(String(n));
      }, { style: "score-row", width: inner, align: "center" }));
      ui.row("score-total-row", () => {
        ui.column("score-total-k", () => para(T("Total"), inner - 100, "total"), { grow: 1 });
        ui.style("total-num").id("score-total").label(String(r.score.total));
      }, { style: "score-total", width: inner, align: "center" });
    }, { width: inner, spacing: 0 });
    const n = r.invalidActions;
    para(T(n === 1 ? "{ticks} ticks · {secs}s · {n} invalid move · seed {seed} · build {build}" : "{ticks} ticks · {secs}s · {n} invalid moves · seed {seed} · build {build}", {
      ticks: r.ticks, secs: (r.elapsedMs / 1000).toFixed(1), n, seed: "0x" + r.seed.toString(16), build: BUILD_VERSION,
    }), inner, "dim-small", "results-meta");
  });
  if (v.newlyUnlocked.length) {
    card("ach-card", w, (inner) => {
      para(T("Achievements unlocked"), inner, "card-h2");
      bullets("ach-new", v.newlyUnlocked.map((a) => `${T(a.name)} — ${T(a.desc)}`), inner);
    });
  }
  if (v.comparison) card("cmp-card", w, (inner) => { para(T("Comparison"), inner, "card-h2"); para(v.comparison!, inner, "text", "results-comparison"); });
  const lb = leaderboardLine();
  if (lb) para(lb, w, "text", "results-lb");
  const p = progression();
  para(T("Rounds played: {rounds} · Mastery {mastery}", { rounds: p.totalRounds, mastery: p.masteryPoints }), w, "dim", "results-progress");
}

// ------------------------------------------------------------------ help (ui.js help)
const GLYPH: Record<string, string> = { "Arrow Up": "Up", "Arrow Down": "Down", "Arrow Left": "Left", "Arrow Right": "Right" };
function keysFor(action: string): string {
  let list: string[] = [];
  try { list = bindings(action).filter((b) => b.device === "keyboard").map((b) => GLYPH[b.label] ?? b.label); } catch { /* not yet */ }
  return [...new Set(list)].join(" / ");
}
function helpScreen(w: number, L: Layout): void {
  h1(T("How to play"), L, "help-h");
  const k = keysFor;
  const cards: [string, string, string][] = [
    ["🐍", T("Steering"), T("Turn with {up}, {left}, {down}, {right}, swipe, the on-screen pad, or tap a tile. The serpent always moves forward.", { up: k("up"), left: k("left"), down: k("down"), right: k("right") })],
    ["🍓", T("Food"), T("Berries grow your serpent and add score. Golden berries are worth far more and grow two segments.")],
    ["🪨", T("Hazards"), T("Walls, rocks, hedges, and your own body end the round. Plan ahead — you cannot reverse.")],
    ["🟡", T("Small rivals"), T("Golden rivals are prey: catch any part of one with your head to defeat it for a big bonus.")],
    ["🟤", T("Big rivals"), T("Dark plated rivals hunt you. Any contact is fatal. They telegraph by shape: spikes mean danger.")],
    ["🎯", T("Objectives"), T("Each round lists its goals. Complete all of them to win; finishing under par earns bonus points.")],
    ["↩", T("Undo & hints"), T("Undo ({undo}) and hints ({hint}) are available in Practice. Pause with {pause}.", { undo: k("undo"), hint: k("hint"), pause: k("pause") })],
    ["🏆", T("Scoring"), T("Score = food + growth + rival defeats + survival + objectives. Ties break on completion, then fewer invalid moves, then faster time.")],
  ];
  cardGrid("help-cards", cards.length, w, 200, 11, (i, cw) => {
    const [g, t, d] = cards[i]!;
    ui.column(`help-card-${i}`, () => {
      ui.style("help-glyph").label(g);
      para(t, cw - 28, "help-h3");
      para(d, cw - 28, "help-p", `help-text-${i}`);
    }, { style: "help-card", width: cw, spacing: 4 });
  });
}

// ------------------------------------------------------------------ settings (ui.js settingsForm, the game's part)
function selectRow(id: string, label: string, idx: number, options: string[], w: number, set: (i: number) => void): void {
  ui.row(`${id}-row`, () => {
    para(label, w * 0.45, "field-label", `${id}-label`);
    ui.spacer();
    const pick = ui.id(id).select(label, idx, options, { width: Math.min(w * 0.5, 260) } as ui.WidgetOptions);
    if (pick !== idx) later(() => set(pick));
  }, { style: "field-row", width: w, align: "center" });
}
/** A settings row with a switch (a role "checkbox" widget: built-in check box labels don't wrap). */
function toggleRow(id: string, label: string, hint: string | null, on: boolean, w: number, set: (v: boolean) => void): void {
  ui.row(`${id}-row`, () => {
    ui.column(`${id}-text`, () => { para(T(label), w - 76, "field-label", `${id}-label`); if (hint) para(T(hint), w - 76, "hint"); }, { spacing: 2, grow: 1 });
    const res = ui.id(id).widget(T(label), {
      role: "checkbox", checked: on, size: { width: 56, height: 44 },
      draw: (r, st) => {
        const s = st.scale, bw = 52 * s, bh = 30 * s, bx = r.x + (r.width - bw) / 2, by = r.y + (r.height - bh) / 2;
        draw.roundRect(bx, by, bw, bh, 15, on ? token("accent") : token("panel-2"));
        draw.strokeRoundRect(bx, by, bw, bh, 15, "#ffffff44", 1);
        draw.circle(on ? bx + bw - bh / 2 : bx + bh / 2, by + bh / 2, bh / 2 - 4 * s, on ? token("accent-ink") : token("ink-dim"));
      },
    });
    if (res.activated && fresh()) later(() => set(!on));
  }, { style: "field-row", width: w, align: "center", spacing: 8 });
}
const PALETTE_NAMES: [string, string][] = [["standard", N("Standard")], ["deuteranopia", N("Deuteranopia-safe")], ["protanopia", N("Protanopia-safe")], ["tritanopia", N("Tritanopia-safe")]];
const CAMERA_NAMES: [string, string][] = [["default", N("Angled garden view")], ["top", N("Top-down view")]];
function settingsScreen(w: number, L: Layout): void {
  const o = platform.options;
  h1(T("Settings"), L, "settings-h");
  card("settings-runtime", w, (inner) => {
    para(T("Sound, graphics, language, larger text, high contrast and reduced motion are in the StarHermit Options."), inner, "dim-small", "options-note");
    flow("settings-runtime-btns", [
      { id: "btn-options", text: T("Open Options"), style: "btn-small", act: () => openMenu() },
      { id: "btn-rebind", text: T("Key bindings"), style: "btn-small", act: () => requestRebind() },
    ], inner, 10, "start");
  });
  card("settings-view", w, (inner) => {
    para(T("Graphics"), inner, "card-h2");
    selectRow("set-cameraView", T("Camera view"), Math.max(0, CAMERA_NAMES.findIndex(([id]) => id === o.cameraView)), CAMERA_NAMES.map(([, l]) => T(l)), inner,
      (i) => platform.setOption("cameraView", CAMERA_NAMES[i]![0]));
  });
  card("settings-access", w, (inner) => {
    para(T("Accessibility"), inner, "card-h2");
    selectRow("set-colorPalette", T("Color palette"), Math.max(0, PALETTE_NAMES.findIndex(([id]) => id === o.colorPalette)), PALETTE_NAMES.map(([, l]) => T(l)), inner,
      (i) => platform.setOption("colorPalette", PALETTE_NAMES[i]![0]));
    toggleRow("set-leftHanded", N("Left-handed controls"), null, o.leftHanded, inner, (v) => platform.setOption("leftHanded", v));
    toggleRow("set-haptics", N("Haptics (vibration)"), null, o.haptics, inner, (v) => platform.setOption("haptics", v));
    toggleRow("set-captions", N("Sound captions"), N("Text cues for meaningful audio."), o.captions, inner, (v) => platform.setOption("captions", v));
    toggleRow("set-timingAssist", N("Timing assistance"), N("Slightly slower serpent. Rounds become unranked."), o.timingAssist, inner, (v) => platform.setOption("timingAssist", v));
  });
}

// ------------------------------------------------------------------ progression, profile, boards
function progressionScreen(w: number, L: Layout): void {
  const p = progression();
  h1(T("Progression"), L, "progression-h");
  const cleared = Object.values(p.stages).filter((s) => s.won).length;
  card("prog-journey", w, (inner) => {
    para(T("Journey"), inner, "card-h2");
    para(T("{cleared} / {total} journey stages cleared.", { cleared, total: Content.JOURNEY_STAGES.length }), inner, "text", "prog-journey-text");
    para(T("{mastery} mastery points · {rounds} rounds played · daily streak {streak}", { mastery: p.masteryPoints, rounds: p.totalRounds, streak: p.currentStreakDays }), inner, "dim", "prog-mastery");
  });
  card("prog-ach", w, (inner) => {
    para(T("Achievements"), inner, "card-h2");
    ACHIEVEMENTS.forEach((a, i) => para(`${p.achievements[a.key] ? "🏅" : "🔒"} ${T(a.name)} — ${T(a.desc)}`, inner, "text", `ach-${i}`));
  });
  card("prog-cosmetics", w, (inner) => {
    para(T("Cosmetics"), inner, "card-h2");
    para(T("Cosmetics change looks only — never hitboxes, timing, or power."), inner, "dim-small");
    flow("cosmetic-list", COSMETICS.map((c) => {
      const unlocked = p.cosmetics.unlocked.includes(c.id) || p.masteryPoints >= c.cost;
      const equipped = p.cosmetics.equipped.trail === c.id;
      return { id: `cosmetic-${c.id}`, text: unlocked ? T(c.name) : T("{name} ({cost} mastery)", { name: T(c.name), cost: c.cost }), style: "btn-small", selected: equipped, disabled: !unlocked, act: () => equipCosmetic(c.id) };
    }), inner, 8, "center");
  });
}
let nameDraft: string | null = null;
function profileScreen(w: number, L: Layout): void {
  h1(T("Profile"), L, "profile-h");
  const hosted = platform.signedIn();
  card("profile-card", w, (inner) => {
    para(T("Display name"), inner, "field-label");
    if (hosted) { nameDraft = null; para(pname(playerName()), inner, "strong", "profile-name"); }
    else {
      if (app.screen === "profile" && frame().frame - app.openedFrame <= 1) nameDraft = pname(playerName());
      nameDraft = ui.id("prof-name").textField(T("Display name"), nameDraft ?? "", { maxChars: 24, width: Math.min(inner, 360), placeholder: T("Display name") });
      if (ui.submitted(T("Display name")) && fresh()) later(() => saveGuestName(nameDraft ?? ""));
    }
    para(hosted ? T("Signed in through the host. Your garden name comes from your account profile.")
      : T("Playing as a local guest. Progress is stored on this device; sign in through the host for durable cloud progress."), inner, "dim", "profile-account");
    if (hosted) {
      const st = platform.syncState();
      const text = st === "saving" ? N("Cloud save: saving…") : st === "synced" ? N("Cloud save: synced") : st === "error" ? N("Cloud save: offline — will retry") : N("Cloud save: offline");
      para(T(text), inner, "dim", "profile-sync");
    }
  });
}
let hosted: { global: BoardEntry[] | null; friends: BoardEntry[] | null } | null | undefined;
let hostedFor = -1;
function boardsScreen(w: number, L: Layout): void {
  h1(T("Leaderboards"), L, "boards-h");
  const chaseDesc = chaseDescriptor(), dailyDesc = dailyDescriptor();
  const chaseCfg = Content.toRulesConfig(chaseDesc), dailyCfg = Content.toRulesConfig(dailyDesc);
  const b = boards();
  const casual = !platform.signedIn();
  const mk = (name: string, locals: BoardEntry[], cfg: ReturnType<typeof Content.toRulesConfig>, ruleset: string) => {
    const entries = [...locals.map((e) => ({ ...e })), ...ghostEntries(cfg, ruleset)].sort(Progress.compareResults);
    return { name, entries: entries.slice(0, 10), casual };
  };
  const list = [
    mk(T("Weekly chase"), b.chase || [], chaseCfg, String(chaseDesc.rulesetId)),
    mk(T("Daily"), b.daily[String(dailyDesc.day)] ? [b.daily[String(dailyDesc.day)]!] : [], dailyCfg, String(dailyDesc.rulesetId)),
  ];
  if (!casual) {
    if (hostedFor !== app.openedFrame) {
      hostedFor = app.openedFrame;
      hosted = undefined;
      void Promise.all([platform.hostedBoard(false), platform.hostedBoard(true)]).then(([g, f]) => {
        const map = (rows: platform.HostedRow[] | null): BoardEntry[] | null => rows ? rows.map((r) => ({ name: r.name, me: r.me, score: r.score, won: false, invalidActions: 0, elapsedMs: 0, sessionId: "", ruleset: null, seed: null, when: null })) : null;
        hosted = { global: map(g), friends: map(f) };
      });
    }
    if (hosted?.global) list.push({ name: T("Global"), entries: hosted.global.slice(0, 10), casual: false });
    if (hosted?.friends) list.push({ name: T("Friends"), entries: hosted.friends.slice(0, 10), casual: false });
    if (hosted && !hosted.global && !hosted.friends) list.push({ name: T("Friends"), entries: [], casual: true });
  } else list.push({ name: T("Friends"), entries: [], casual: true });
  if (app.boardsTab >= list.length) app.boardsTab = 0;
  ui.row("board-tabs", () => {
    flow("board-tabs-flow", list.map((bd, i) => ({ id: `tab-${i}`, text: bd.name, style: "tab", selected: i === app.boardsTab, act: () => { app.boardsTab = i; } })), w, 6, "start");
  }, { width: w, role: "radiogroup" } as ui.Layout);
  const board = list[app.boardsTab]!;
  if (board.casual) para(T("Casual board — offline scores are not server-validated."), w, "dim", "boards-casual");
  if (!board.entries.length) para(T("No scores yet. Be the first!"), w, "dim", "boards-empty");
  ui.column("board-list", () => {
    board.entries.forEach((e, i) => {
      const meta = [e.ruleset, e.seed != null ? T("seed {seed}", { seed: e.seed }) : null].filter(Boolean).join(" · ");
      ui.row(`board-row-${i}`, () => {
        ui.column(`board-row-${i}-n`, () => ui.style("text").label("#" + (i + 1)), { width: 36 });
        ui.column(`board-row-${i}-name`, () => para(pname(e.name) + (meta ? " · " + meta : ""), w - 36 - 150 - 30, "text-small"), { grow: 1 });
        ui.style("strong").id(`board-row-${i}-score`).label(String(e.score));
        ui.column(`board-row-${i}-when`, () => ui.style("dim-tiny").label(e.when || ""), { width: 80, align: "end" });
      }, { style: e.me ? "board-row-me" : "board-row", width: w, spacing: 10, align: "center" });
    });
  }, { spacing: 6, width: w });
}
