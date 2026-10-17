// Every player-facing string exists in all nine locales (node --test).
// Keys are the US-English source strings: literal T('…') / N('…') calls in
// js/, data-i18n markup in index.html, and the display fields of the content
// tables (stages, lessons, challenges, difficulties, themes, …).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DICTS, LOCALES, T, pname, setLocale, getLang } from '../js/i18n.js';
import { gfxStrings } from '../js/gfx-strings.js';
import { shText } from '../js/sh-strings.js';
import { ALL } from './i18n-keys.mjs';

const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('the key set is non-trivial', () => {
  assert.ok(ALL.size > 300, `only ${ALL.size} keys found`);
});

for (const locale of LOCALES.filter((l) => l !== 'en-US' && l !== 'en-GB')) {
  test(`${locale}: every key is translated with the same placeholders`, () => {
    const dict = DICTS[locale];
    const missing = [...ALL].filter((k) => !Object.prototype.hasOwnProperty.call(dict, k));
    assert.deepEqual(missing, [], `${missing.length} missing in ${locale}`);
    const bad = [...ALL].filter((k) => placeholders(dict[k]) !== placeholders(k));
    assert.deepEqual(bad, [], `placeholder mismatch in ${locale}`);
  });
}

test('no locale carries keys that no longer exist', () => {
  for (const locale of LOCALES) {
    const stray = Object.keys(DICTS[locale]).filter((k) => !ALL.has(k));
    assert.deepEqual(stray, [], locale);
  }
});

test('T falls back to the key, fills placeholders; built-in names translate, player names pass through', () => {
  setLocale('de-DE');
  assert.equal(getLang(), 'de-DE');
  assert.equal(T('Not a real key {x}', { x: 1 }), 'Not a real key 1');
  assert.equal(T('Paused'), 'Pausiert');
  assert.equal(pname('Guest Gardener'), 'Gastgärtner');
  assert.equal(pname('Moss (spirit)'), 'Moos (Geist)');
  assert.equal(pname('Sly Sam'), 'Sly Sam');
  setLocale('fr-CA');
  assert.equal(T('Watch replay'), 'Voir la reprise');
  assert.equal(T('Paused'), 'En pause'); // inherited from fr-FR
  setLocale('xx-YY');
  assert.equal(getLang(), 'en-US');
  assert.equal(T('Paused'), 'Paused');
});

test('graphics and StarHermit chrome strings follow the game language', () => {
  setLocale('it-IT');
  assert.equal(gfxStrings().quality, gfxStrings('it-IT').quality);
  assert.notEqual(shText('signIn'), 'Sign in with StarHermit');
  setLocale('en-US');
  assert.equal(shText('signIn'), 'Sign in with StarHermit');
});
