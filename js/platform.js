// Platform adapter: StarHermit host integration when hosted, graceful offline
// behavior otherwise. All platform access goes through the canonical SDK
// (starhermit-sdk.js, loaded as a classic script before the modules;
// window.StarHermit): it reads the launch token from the fragment
// (#game_token / sign-in #access_token), strips it, never persists it and
// renews it. The game never calls its own server routes: standalone it makes
// no network requests at all. All network failures degrade to recoverable UI
// states, never crashes.

const SH = () => (typeof window !== 'undefined' && window.StarHermit) || globalThis.StarHermit || null;

// Settings mirrored to the per-player KV (bindings use the controls API).
const NOT_SETTINGS = new Set(['version', 'bindings']);
// Game action -> platform control action (control.* in starhermit.txt).
const CONTROL_ACTIONS = { up: 'up', down: 'down', left: 'left', right: 'right', pause: 'pause', undo: 'undo', hint: 'hint', cameraReset: 'camera_reset' };

export function createPlatform() {
  const sh = SH();
  if (sh) sh.init();
  const isHosted = () => !!(sh && sh.signedIn);

  let authCb = null;
  let sentSettings = {};
  let settingsTimer = 0;

  async function nickname(userId) {
    const p = sh ? await sh.profile(userId).catch(() => null) : null;
    return p ? p.displayName : 'Player ' + String(userId || '?').slice(0, 8);
  }

  // Cloud save: the SDK's game:<slug> slot, remote-preferred on load.
  // localStorage stays the offline cache; the slot is a mirror. Saves
  // debounce ~2 s and flush on pagehide/visibilitychange.
  let cloudStatus = isHosted() ? 'idle' : 'offline';
  let cloudStatusCb = null;
  function setCloudStatus(s) {
    cloudStatus = s;
    if (cloudStatusCb) cloudStatusCb(s);
  }
  if (sh) {
    sh.on('saved', (ok) => setCloudStatus(ok ? 'synced' : 'error'));
    sh.on('auth', (a) => { if (!a.signedIn) setCloudStatus('offline'); if (authCb) authCb(!!a.signedIn); });
  }

  const cloudSync = {
    get status() { return cloudStatus; },
    onStatus(cb) { cloudStatusCb = cb; },
    async load() {
      if (!isHosted()) return null;
      return sh.loadJSON();
    },
    schedule(doc) {
      if (!isHosted()) return;
      setCloudStatus('saving');
      sh.saveJSON(doc, 2000);
    },
    async flush() {
      if (!isHosted()) return;
      await sh.flushSave(true);
    },
  };
  window.addEventListener('pagehide', () => { cloudSync.flush(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) cloudSync.flush(); });

  const pickSettings = (settings) => Object.fromEntries(Object.keys(settings).filter((k) => !NOT_SETTINGS.has(k)).map((k) => [k, settings[k]]));

  return {
    get hosted() { return isHosted(); },
    get launchTokenPresent() { return isHosted(); },
    get userId() { return isHosted() ? sh.userId : null; },
    get gameKey() { return sh ? sh.slug : null; },
    cloudSync,

    // Account chrome: sign-in (platform host, no token), invite share link, sign-out notice.
    canSignIn() { return !!(sh && sh.canSignIn()); },
    signIn() { return !!(sh && sh.signIn()); },
    inviteLink() { return isHosted() ? sh.inviteLink() : null; },
    onAuth(cb) { authCb = cb; },
    async avatarUrl() { return isHosted() ? sh.avatarUrl().catch(() => null) : null; },

    // Per-player settings KV: platform values win at start; changes are patched.
    async loadSettings(settings) {
      if (!isHosted()) return false;
      const remote = await sh.getSettings().catch(() => ({}));
      let changed = false;
      for (const k of Object.keys(settings)) {
        if (NOT_SETTINGS.has(k) || !remote || remote[k] === undefined || remote[k] === null) continue;
        settings[k] = remote[k];
        changed = true;
      }
      sentSettings = JSON.parse(JSON.stringify(pickSettings(settings)));
      return changed;
    },
    mirrorSettings(settings) {
      if (!isHosted()) return;
      clearTimeout(settingsTimer);
      settingsTimer = setTimeout(() => {
        const now = pickSettings(settings);
        const diff = {};
        for (const [k, v] of Object.entries(now)) if (JSON.stringify(v) !== JSON.stringify(sentSettings[k])) diff[k] = v;
        if (!Object.keys(diff).length) return;
        sentSettings = JSON.parse(JSON.stringify(now));
        sh.patchSettings(diff);
      }, 600);
    },

    // Controls: platform overrides of the declared keyboard actions (codes).
    async loadBindings(bindings) {
      if (!sh) return bindings;
      const defaults = {};
      for (const [game, ctl] of Object.entries(CONTROL_ACTIONS)) if (bindings[game]) defaults[ctl] = bindings[game];
      const resolved = await sh.loadBindings(defaults).catch(() => defaults);
      const out = { ...bindings };
      for (const [game, ctl] of Object.entries(CONTROL_ACTIONS)) if (resolved[ctl]) out[game] = resolved[ctl];
      return out;
    },
    saveBinding(action, codes) {
      if (isHosted() && CONTROL_ACTIONS[action]) sh.setControl(CONTROL_ACTIONS[action], codes).catch(() => {});
    },

    // Daily boundaries use the local clock (no server time sync).
    now() { return new Date(); },

    // Account display name from the platform profile (never /api/v1/me,
    // never usernames). "Player " + id prefix fallback on any failure.
    async fetchProfileName() {
      if (!isHosted() || !sh.userId) return null;
      return nickname(sh.userId);
    },

    // Read-only leaderboards (clients can never submit scores). Resolves
    // entry userIds to nicknames. Null when the game has no board or the
    // read fails — caller shows local records.
    async fetchLeaderboard(friendsOnly) {
      if (!isHosted()) return null;
      const game = await sh.getGame();
      let leaderboardId = game && game.leaderboardId;
      if (!leaderboardId) {
        const boards = await sh.leaderboards();
        leaderboardId = boards && boards[0] && boards[0].id;
      }
      if (!leaderboardId) return null;
      const res = await sh.leaderboardEntries(leaderboardId, { page: 1, pageSize: 50, scope: friendsOnly ? 'friends' : undefined });
      const list = res.items || res.entries || [];
      return Promise.all(list.map(async (e) => {
        const uid = e.userId || e.user_id || e.playerId || null;
        return {
          name: uid ? await nickname(uid) : 'Player',
          me: !!uid && uid === sh.userId,
          score: e.score ?? e.value ?? 0,
          won: !!e.won,
          invalidActions: e.invalidActions || 0,
          elapsedMs: e.durationMs || e.elapsedMs || 0,
          sessionId: e.sessionId || uid || '',
          ruleset: e.ruleset || null,
          seed: e.seed != null ? String(e.seed) : null,
          when: e.at ? new Date(e.at).toISOString().slice(0, 10) : (e.when || null),
        };
      }));
    },
  };
}
