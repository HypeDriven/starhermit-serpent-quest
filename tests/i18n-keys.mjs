// Key extraction for the i18n coverage test (also handy for listing keys):
// literal T('…') / N('…') calls in js/ and native/*.ts, and
// the display fields of the content tables.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { THEMES, JOURNEY_STAGES, TUTORIALS, CHALLENGES, PRACTICE_DIFFICULTIES } from '../js/content.js';

const ROOT = new URL('..', import.meta.url).pathname;
const SKIP = new Set(['i18n.js', 'sh-strings.js']);
const unescape = (s) => s.replace(/\\(['"\\`])/g, '$1');

export function sourceKeys() {
  const keys = new Set();
  // T(cond ? 'a' : 'b', …) picks one of two keys.
  const ternary = /(?<![\w.$])T\([^'"\n()]*?\?\s*'((?:[^'\\\n]|\\.)*)'\s*:\s*'((?:[^'\\\n]|\\.)*)'/g;
  const call = /(?<![\w.$])(?:T|N)\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g;
  const dquote = /(?<![\w.$])T\([^'"\n()]*?\?\s*"((?:[^"\\\n]|\\.)*)"\s*:\s*"((?:[^"\\\n]|\\.)*)"/g;
  for (const sub of ['js', 'native']) {
    const dir = join(ROOT, sub);
    for (const f of readdirSync(dir)) {
      if (!/\.(js|ts)$/.test(f) || SKIP.has(f)) continue;
      const src = readFileSync(join(dir, f), 'utf8');
      for (const m of src.matchAll(call)) keys.add(unescape(m[1] ?? m[2]));
      for (const m of src.matchAll(ternary)) { keys.add(unescape(m[1])); keys.add(unescape(m[2])); }
      for (const m of src.matchAll(dquote)) { keys.add(unescape(m[1])); keys.add(unescape(m[2])); }
    }
  }
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
  // Rule rejections (js/rules.js) and the death caption (native/audio.ts CAPTIONS) shown through T().
  add('The round is already over.', 'Unknown direction.', 'The serpent cannot reverse into itself.',
    'Command is not an object.', 'Unknown command type.', 'Low thud — serpent down');
  // Built-in names translated by pname(): the guest and the garden spirits.
  add('Guest Gardener', 'Bramble', 'Moss', 'Thistle', '{name} (spirit)');
  return keys;
}

export const ALL = new Set([...sourceKeys(), ...contentKeys()]);
