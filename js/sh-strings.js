// Serpent Quest — StarHermit platform chrome strings (sign-in, invite link, controls)
// in the nine supported locales, picked from navigator.language.
import { pickLocale } from './gfx-strings.js';

const BASE = {
  'en-US': {
    signIn: 'Sign in with StarHermit', invite: 'Invite a friend',
    inviteCopied: 'Invite link copied to the clipboard.', inviteLink: 'Invite link: {url}',
    signedOut: 'Signed out of StarHermit. Progress is kept on this device.',
  },
  'es-419': {
    signIn: 'Iniciar sesión con StarHermit', invite: 'Invitar a un amigo',
    inviteCopied: 'Enlace de invitación copiado al portapapeles.', inviteLink: 'Enlace de invitación: {url}',
    signedOut: 'Se cerró la sesión de StarHermit. El progreso se guarda en este dispositivo.',
  },
  'es-ES': {
    signIn: 'Iniciar sesión con StarHermit', invite: 'Invitar a un amigo',
    inviteCopied: 'Enlace de invitación copiado al portapapeles.', inviteLink: 'Enlace de invitación: {url}',
    signedOut: 'Se ha cerrado la sesión de StarHermit. El progreso se guarda en este dispositivo.',
  },
  'de-DE': {
    signIn: 'Mit StarHermit anmelden', invite: 'Freund einladen',
    inviteCopied: 'Einladungslink in die Zwischenablage kopiert.', inviteLink: 'Einladungslink: {url}',
    signedOut: 'Von StarHermit abgemeldet. Der Fortschritt bleibt auf diesem Gerät.',
  },
  'fr-FR': {
    signIn: 'Se connecter avec StarHermit', invite: 'Inviter un ami',
    inviteCopied: 'Lien d’invitation copié dans le presse-papiers.', inviteLink: 'Lien d’invitation : {url}',
    signedOut: 'Déconnecté de StarHermit. La progression reste sur cet appareil.',
  },
  'fr-CA': {
    signIn: 'Se connecter avec StarHermit', invite: 'Inviter un ami',
    inviteCopied: 'Lien d’invitation copié dans le presse-papiers.', inviteLink: 'Lien d’invitation : {url}',
    signedOut: 'Déconnecté de StarHermit. La progression reste sur cet appareil.',
  },
  'pt-BR': {
    signIn: 'Entrar com StarHermit', invite: 'Convidar um amigo',
    inviteCopied: 'Link de convite copiado para a área de transferência.', inviteLink: 'Link de convite: {url}',
    signedOut: 'Você saiu do StarHermit. O progresso fica salvo neste dispositivo.',
  },
  'it-IT': {
    signIn: 'Accedi con StarHermit', invite: 'Invita un amico',
    inviteCopied: 'Link di invito copiato negli appunti.', inviteLink: 'Link di invito: {url}',
    signedOut: 'Disconnesso da StarHermit. I progressi restano su questo dispositivo.',
  },
};
BASE['en-GB'] = { ...BASE['en-US'] };

/** shText('inviteLink', { url }) in the player's locale. */
export function shText(key, vars) {
  const nav = typeof navigator !== 'undefined' ? navigator.language : 'en-US';
  const L = BASE[pickLocale(nav)] || BASE['en-US'];
  let s = L[key] ?? BASE['en-US'][key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
}
