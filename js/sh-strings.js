// Serpent Quest — StarHermit platform chrome strings (sign-in, invite link, controls)
// in the nine supported locales, picked from navigator.language.
import { pickLocale } from './gfx-strings.js';

const BASE = {
  'en-US': {
    signIn: 'Sign in with StarHermit', invite: 'Invite a friend',
    inviteCopied: 'Invite link copied to the clipboard.', inviteLink: 'Invite link: {url}',
    signedOut: 'Signed out of StarHermit. Progress is kept on this device.',
    lbPosting: "Posting score to the leaderboard…", lbRank: "Leaderboard rank: #{rank}",
    lbPosted: "Score posted to the leaderboard.", lbNotPosted: "Score not posted to the leaderboard.",
  },
  'es-419': {
    signIn: 'Iniciar sesión con StarHermit', invite: 'Invitar a un amigo',
    inviteCopied: 'Enlace de invitación copiado al portapapeles.', inviteLink: 'Enlace de invitación: {url}',
    signedOut: 'Se cerró la sesión de StarHermit. El progreso se guarda en este dispositivo.',
    lbPosting: "Enviando la puntuación a la clasificación…", lbRank: "Puesto en la clasificación: #{rank}",
    lbPosted: "Puntuación enviada a la clasificación.", lbNotPosted: "No se envió la puntuación a la clasificación.",
  },
  'es-ES': {
    signIn: 'Iniciar sesión con StarHermit', invite: 'Invitar a un amigo',
    inviteCopied: 'Enlace de invitación copiado al portapapeles.', inviteLink: 'Enlace de invitación: {url}',
    signedOut: 'Se ha cerrado la sesión de StarHermit. El progreso se guarda en este dispositivo.',
    lbPosting: "Enviando la puntuación a la clasificación…", lbRank: "Puesto en la clasificación: #{rank}",
    lbPosted: "Puntuación enviada a la clasificación.", lbNotPosted: "No se ha enviado la puntuación a la clasificación.",
  },
  'de-DE': {
    signIn: 'Mit StarHermit anmelden', invite: 'Freund einladen',
    inviteCopied: 'Einladungslink in die Zwischenablage kopiert.', inviteLink: 'Einladungslink: {url}',
    signedOut: 'Von StarHermit abgemeldet. Der Fortschritt bleibt auf diesem Gerät.',
    lbPosting: "Punktzahl wird an die Bestenliste gesendet …", lbRank: "Platz in der Bestenliste: #{rank}",
    lbPosted: "Punktzahl an die Bestenliste gesendet.", lbNotPosted: "Punktzahl nicht an die Bestenliste gesendet.",
  },
  'fr-FR': {
    signIn: 'Se connecter avec StarHermit', invite: 'Inviter un ami',
    inviteCopied: 'Lien d’invitation copié dans le presse-papiers.', inviteLink: 'Lien d’invitation : {url}',
    signedOut: 'Déconnecté de StarHermit. La progression reste sur cet appareil.',
    lbPosting: "Envoi du score au classement…", lbRank: "Rang au classement : #{rank}",
    lbPosted: "Score envoyé au classement.", lbNotPosted: "Score non envoyé au classement.",
  },
  'fr-CA': {
    signIn: 'Se connecter avec StarHermit', invite: 'Inviter un ami',
    inviteCopied: 'Lien d’invitation copié dans le presse-papiers.', inviteLink: 'Lien d’invitation : {url}',
    signedOut: 'Déconnecté de StarHermit. La progression reste sur cet appareil.',
    lbPosting: "Envoi du pointage au classement…", lbRank: "Rang au classement : #{rank}",
    lbPosted: "Pointage envoyé au classement.", lbNotPosted: "Pointage non envoyé au classement.",
  },
  'pt-BR': {
    signIn: 'Entrar com StarHermit', invite: 'Convidar um amigo',
    inviteCopied: 'Link de convite copiado para a área de transferência.', inviteLink: 'Link de convite: {url}',
    signedOut: 'Você saiu do StarHermit. O progresso fica salvo neste dispositivo.',
    lbPosting: "Enviando a pontuação para o ranking…", lbRank: "Posição no ranking: #{rank}",
    lbPosted: "Pontuação enviada para o ranking.", lbNotPosted: "A pontuação não foi enviada para o ranking.",
  },
  'it-IT': {
    signIn: 'Accedi con StarHermit', invite: 'Invita un amico',
    inviteCopied: 'Link di invito copiato negli appunti.', inviteLink: 'Link di invito: {url}',
    signedOut: 'Disconnesso da StarHermit. I progressi restano su questo dispositivo.',
    lbPosting: "Invio del punteggio alla classifica…", lbRank: "Posizione in classifica: #{rank}",
    lbPosted: "Punteggio inviato alla classifica.", lbNotPosted: "Punteggio non inviato alla classifica.",
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
