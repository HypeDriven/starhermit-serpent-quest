// Localization: the engine's string tables (assets/strings.json, US-English
// text as the keys, the nine StarHermit locales) in the interface language the
// runtime reports (the player's choice in Options › Language, else the
// account's preferred language or the device's). Every string is drawn through
// T() each frame, so a change shows on the next frame and never restarts the
// round. The account lines are the engine's own `starhermit.*` strings.
import { strings } from "starhermit:engine";
import * as ui from "starhermit:ui";
import { N as mark, fmt, pname as playerName, setTranslator } from "../js/i18n.js";

export type Vars = Record<string, string | number>;
strings.load("assets/strings.json");
strings.defaultLocale = "en-US";
ui.setLanguage(strings.locale);
strings.onChange((locale) => ui.setLanguage(locale));
setTranslator((k: string) => strings.has(k), (k: string, v?: Vars) => strings.t(k, v));

export function currentLocale(): string { return strings.locale; }
/** An English source string in the player's language; unknown strings pass through; `{name}` placeholders from vars. */
export function T(key: string, vars?: Vars | null): string {
  return strings.has(key) ? strings.t(key, vars ?? undefined) : vars ? (fmt(key, vars) as string) : key;
}
/** Marks an English key that is translated with T() where it is shown. */
export const N = mark as (s: string) => string;
/** A display name: the guest and the garden spirits translated, player names as they are. */
export const pname = playerName as (s: string) => string;
const ACCOUNT = {
  signIn: "signIn", invite: "invite", inviteCopied: "inviteCopied", inviteLink: "inviteLink", signedOut: "signedOut",
  lbPosting: "leaderboardPosting", lbRank: "leaderboardRank", lbPosted: "leaderboardPosted", lbNotPosted: "leaderboardNotPosted",
} as const;
/** An account line (the engine's) in the player's language. */
export function S(key: keyof typeof ACCOUNT, vars?: Vars): string { return strings.t(`starhermit.${ACCOUNT[key]}`, vars); }
