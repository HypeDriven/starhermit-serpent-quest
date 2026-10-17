// Serpent Quest localization core.
//
// Every player-facing string is authored in US English and looked up by that
// English text: T('Play') → the current locale's translation (en-US is the
// key itself). Placeholders use {name}. N('…') marks a string for extraction
// without translating it at that point (the caller translates at display time).
//
// The locale comes from sh-language.js (window.StarHermitLanguage): the game's
// Language setting (`ui.language`), Automatic → the StarHermit account's
// preferred language → navigator.languages → en-US. `?lang=` forces a locale
// for one page load (QA links) and hides the selector. A change re-applies
// `data-i18n` markup, sets <html lang>, and notifies onLanguage listeners so
// every screen, HUD and dialog re-renders in place.

import EN_GB from './locales/en-GB.js';
import { ES_419, ES_ES } from './locales/es.js';
import DE_DE from './locales/de.js';
import { FR_FR, FR_CA } from './locales/fr.js';
import PT_BR from './locales/pt.js';
import IT_IT from './locales/it.js';

export const LOCALES = ['en-US', 'en-GB', 'es-419', 'es-ES', 'de-DE', 'fr-FR', 'fr-CA', 'pt-BR', 'it-IT'];

/** Locale → { English key: translation }. en-US is the identity; en-GB lists spelling changes. */
export const DICTS = {
  'en-US': {},
  'en-GB': EN_GB,
  'es-419': ES_419,
  'es-ES': { ...ES_419, ...ES_ES },
  'de-DE': DE_DE,
  'fr-FR': FR_FR,
  'fr-CA': { ...FR_FR, ...FR_CA },
  'pt-BR': PT_BR,
  'it-IT': IT_IT,
};

let lang = 'en-US';
let dict = DICTS[lang];
const listeners = new Set();
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function fmt(s, vars) {
  return String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] != null ? String(vars[k]) : m));
}

/** Translate an English source string (unknown strings, e.g. player names, pass through). */
export function T(key, vars) {
  if (key == null) return '';
  const s = String(key);
  const out = has(dict, s) ? dict[s] : s;
  return vars ? fmt(out, vars) : out;
}

/** Mark a string for extraction; translated later with T(). */
export const N = (key) => key;

/** A display name: built-in names (the guest, the garden spirits) are translated; player names pass through. */
export function pname(name) {
  const s = String(name ?? '');
  const spirit = /^(Bramble|Moss|Thistle) \(spirit\)$/.exec(s);
  if (spirit) return T('{name} (spirit)', { name: T(spirit[1]) });
  return s === 'Guest Gardener' ? T(s) : s;
}

export function getLang() { return lang; }

export function onLanguage(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Re-apply data-i18n (text), data-i18n-aria (aria-label) and data-i18n-title markup. */
export function applyMarkup(root = globalThis.document) {
  if (!root?.querySelectorAll) return;
  for (const node of root.querySelectorAll('[data-i18n]')) node.textContent = T(node.dataset.i18n);
  for (const node of root.querySelectorAll('[data-i18n-aria]')) node.setAttribute('aria-label', T(node.dataset.i18nAria));
  for (const node of root.querySelectorAll('[data-i18n-title]')) node.setAttribute('title', T(node.dataset.i18nTitle));
}

export function setLocale(next) {
  const resolved = DICTS[next] ? next : 'en-US';
  const changed = resolved !== lang;
  lang = resolved;
  dict = DICTS[lang];
  const doc = globalThis.document;
  if (doc?.documentElement) {
    doc.documentElement.lang = lang;
    if (doc.readyState !== 'loading') applyMarkup(doc);
  }
  if (changed) for (const fn of [...listeners]) { try { fn(lang); } catch (e) { console.error(e); } }
}

/** Wire the StarHermit language preference (browser only). Returns the sh-language instance or null. */
export function initLanguage() {
  const SHL = globalThis.StarHermitLanguage;
  let forced = null;
  try { forced = new URLSearchParams(globalThis.location?.search || '').get('lang'); } catch { /* opaque origin */ }
  const forcedLocale = forced && SHL ? SHL.match(forced, LOCALES) : null;
  if (!SHL) { setLocale('en-US'); return null; }
  return SHL.create({
    game: 'serpent-quest', supported: LOCALES, panel: !forcedLocale,
    apply: (locale) => setLocale(forcedLocale || locale),
  });
}
