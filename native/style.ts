// The look of the top bar, rails, HUD, tray and screens: the browser build's
// css/style.css, rewritten class-based in tools/ui-style.css and converted
// once with `starhermit css` into assets/ui-style.json (`npm run css`),
// registered at start with the theme the runtime's own widgets (scroll bars,
// focus rings, selects, sliders) take. The colour-vision palettes
// (body.palette-*: accent and danger) and the runtime's high-contrast option
// (body.high-contrast) are token sets; the colour-mix() shades the sheet used
// are recomputed from them here.
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

type Tokens = Record<string, string>;
const BASE: Tokens = {
  bg: "#14201a", panel: "#1e2f26", "panel-2": "#27392e", "panel-2-hover": "#31483a", ink: "#f2f7ef", "ink-dim": "#b9c9b6",
  accent: "#7cc24f", "accent-ink": "#12240f", "accent-2": "#ffd166", danger: "#e36a5a", "danger-ink": "#ffc9bf", focus: "#ffd166",
  line: "#ffffff16", "line-2": "#ffffff2a",
};
/** body.palette-*. */
const PALETTES: Record<string, Tokens> = {
  standard: {},
  deuteranopia: { accent: "#58b7ff", "accent-2": "#ffd166", danger: "#ff9a3c" },
  protanopia: { accent: "#4fc9e8", "accent-2": "#ffe08a", danger: "#ffb03a" },
  tritanopia: { accent: "#6fe38a", "accent-2": "#ff8fa5", danger: "#e35ab0" },
};
/** body.high-contrast (the brighter borders on cards, rails, buttons too). */
const CONTRAST: Tokens = {
  bg: "#000000", panel: "#0a0a0a", "panel-2": "#141414", "panel-2-hover": "#262626", ink: "#ffffff", "ink-dim": "#e2e2e2",
  accent: "#9dff5a", focus: "#ffdf40", line: "#ffffff66", "line-2": "#ffffff66",
};

const alpha = (c: string, a: number): string => c.slice(0, 7) + Math.round(a * 255).toString(16).padStart(2, "0");

let current: Tokens = {};
/** The tokens for a palette and contrast, with the sheet's derived shades. */
export function tokensFor(palette: string, highContrast: boolean): Tokens {
  const t: Tokens = { ...BASE, ...(highContrast ? CONTRAST : {}), ...(PALETTES[palette] ?? {}) };
  t["bg-82"] = alpha(t.bg!, 0.82);
  t["panel-88"] = alpha(t.panel!, 0.88);
  t["panel-92"] = alpha(t.panel!, 0.92);
  return t;
}

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  ui.setFont({ family: "sans-serif" });
  ui.setTheme({
    fontSize: 16, smallSize: 13.6, headingSize: 24, padding: 8, spacing: 8, radius: 10,
    text: BASE.ink!, muted: BASE["ink-dim"]!, panel: BASE.panel!, control: BASE["panel-2"]!, hovered: BASE["panel-2-hover"]!,
    pressed: "#3a5444", field: BASE["panel-2"]!, accent: BASE.accent!, focus: BASE.focus!, outline: "#ffffff2a",
  });
  ui.setTokens(css.tokens);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$ink" } },
    paragraph: { text: { color: "$ink" } },
    heading: { text: { color: "$ink" } },
    widget: { focusRing: { color: "$focus", width: 3, offset: 2 } },
    scrollArea: { parts: { bar: { background: "#ffffff33", radius: 4 } } },
    tooltip: { background: "$panel", text: { color: "$ink" }, radius: 6, padding: 6 },
    // The pause overlay's dim (#0009) behind the dialogs.
    dialog: { background: "#00000000", padding: 0, parts: { backdrop: { background: "#00000099" } } },
  });
  applyTokens("standard", false);
}

let key = "";
/** Applies the palette / contrast tokens (cheap when unchanged). */
export function applyTokens(palette: string, highContrast: boolean): void {
  const k = `${palette}:${highContrast}`;
  if (k === key) return;
  key = k;
  current = tokensFor(palette, highContrast);
  ui.setTokens(current);
  ui.setTheme({
    text: current.ink!, muted: current["ink-dim"]!, panel: current.panel!, control: current["panel-2"]!, hovered: current["panel-2-hover"]!,
    field: current["panel-2"]!, accent: current.accent!, focus: current.focus!, outline: current["line-2"]!,
  });
}
/** A token's current colour (for draw calls, which take real colours). */
export function token(name: string): string { return current[name] ?? "#000000"; }
