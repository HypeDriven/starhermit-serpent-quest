// Localization: the browser build's dictionaries (js/locales/*.js through
// js/i18n.js, US-English text as the keys, the nine StarHermit locales; the
// account strings in js/sh-strings.js) in the interface language the runtime
// reports (preferences().language: the player's choice in Options › Language,
// else the account's preferred language or the device's). The runtime's
// Options replace the game's own Language section (sh-language.js) and the
// DOM relabelling: every string is drawn through T() each frame, so a change
// shows on the next frame and never restarts the round.
import { onPreferencesChange, preferences } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { LOCALES, T as translate, N as mark, pname as playerName, setLocale } from "../js/i18n.js";
import { shText } from "../js/sh-strings.js";

const PRIMARY: Record<string, string> = { en: "en-US", es: "es-419", de: "de-DE", fr: "fr-FR", pt: "pt-BR", it: "it-IT" };

/** The shipped locale nearest a BCP 47 tag (en-GB, es-ES and fr-CA by region; es-MX → es-419, pt-PT → pt-BR). */
export function pickLocale(tag: string): string {
  const s = String(tag || "en-US");
  const exact = (LOCALES as string[]).find((l) => l.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  const lang = s.split("-")[0]!.toLowerCase();
  if (lang === "en" && /-(gb|uk|ie|au|nz|za|in)$/i.test(s)) return "en-GB";
  if (lang === "es" && /-es$/i.test(s)) return "es-ES";
  if (lang === "fr" && /-ca$/i.test(s)) return "fr-CA";
  return PRIMARY[lang] ?? "en-US";
}

let locale = "";
function apply(tag: string): void {
  const next = pickLocale(tag);
  if (next === locale) return;
  locale = next;
  setLocale(locale);
  ui.setLanguage(locale);
}
apply(preferences().language);
onPreferencesChange((p) => apply(p.language));

export function currentLocale(): string { return locale; }
export type Vars = Record<string, string | number>;
/** An English source string in the player's language; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string { return translate(key, vars ?? undefined) as string; }
/** Marks an English key that is translated with T() where it is shown. */
export const N = mark as (s: string) => string;
/** A display name: the guest and the garden spirits translated, player names as they are. */
export const pname = playerName as (s: string) => string;
/** The account strings (signIn, invite, inviteCopied, copyFailed, signedOut, lbPosting, lbRank, lbPosted, lbNotPosted). */
export function S(key: string, vars?: Vars): string { return shText(key, vars) as string; }
