// Key extraction for the i18n coverage test (also handy for listing keys):
// literal T('…') / N('…') calls in js/, data-i18n markup in index.html, and
// the display fields of the content tables.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { THEMES, JOURNEY_STAGES, TUTORIALS, CHALLENGES, PRACTICE_DIFFICULTIES } from '../js/content.js';

const ROOT = new URL('..', import.meta.url).pathname;
const SKIP = new Set(['i18n.js', 'gfx-strings.js', 'sh-strings.js']);
const unescape = (s) => s.replace(/\\(['"\\`])/g, '$1');

export function sourceKeys() {
  const keys = new Set();
  // T(cond ? 'a' : 'b', …) picks one of two keys.
  const ternary = /(?<![\w.$])T\([^'"\n()]*?\?\s*'((?:[^'\\\n]|\\.)*)'\s*:\s*'((?:[^'\\\n]|\\.)*)'/g;
  const call = /(?<![\w.$])(?:T|N)\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g;
  const dir = join(ROOT, 'js');
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.js') || SKIP.has(f)) continue;
    const src = readFileSync(join(dir, f), 'utf8');
    for (const m of src.matchAll(call)) keys.add(unescape(m[1] ?? m[2]));
    for (const m of src.matchAll(ternary)) { keys.add(unescape(m[1])); keys.add(unescape(m[2])); }
  }
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  for (const m of html.matchAll(/data-i18n(?:-aria|-title)?="([^"]+)"/g)) keys.add(m[1].replace(/&quot;/g, '"'));
  return keys;
}

export function contentKeys() {
  const keys = new Set();
  const add = (...v) => v.forEach((s) => { if (typeof s === 'string' && s) keys.add(s); });
  for (const t of THEMES) add(t.name);
  for (const s of JOURNEY_STAGES) add(s.name);
  for (const t of TUTORIALS) add(t.name, t.text);
  for (const c of CHALLENGES) add(c.name, c.desc);
  for (const d of PRACTICE_DIFFICULTIES) add(d.name);
  // Rule rejections (js/rules.js) and the death caption (js/audio.js) shown through T().
  add('The round is already over.', 'Unknown direction.', 'The serpent cannot reverse into itself.',
    'Command is not an object.', 'Unknown command type.', 'Low thud — serpent down');
  // Built-in names translated by pname(): the guest and the garden spirits.
  add('Guest Gardener', 'Bramble', 'Moss', 'Thistle', '{name} (spirit)');
  return keys;
}

export const ALL = new Set([...sourceKeys(), ...contentKeys()]);
