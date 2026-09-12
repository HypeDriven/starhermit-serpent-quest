// Platform adapter: StarHermit host integration when hosted, graceful offline
// behavior otherwise. The launch token arrives in the URL fragment, is read
// exactly once and stripped from the address bar, and is never persisted.
// Hosted mode calls only documented platform endpoints; this game's own
// dev-server routes are localhost-only hooks. All network failures degrade
// to recoverable UI states, never crashes.

// Minimal ZIP writer/reader (stored entries only, no compression).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function zipStore(name, dataBytes) {
  const enc = new TextEncoder();
  const nameB = enc.encode(name);
  const crc = crc32(dataBytes);
  const out = [];
  const u16 = (v) => out.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (v) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  u32(0x04034b50); u16(20); u16(0); u16(0); u16(0); u16(0);
  u32(crc); u32(dataBytes.length); u32(dataBytes.length);
  u16(nameB.length); u16(0);
  const local = out.length;
  const head = new Uint8Array(out);
  const cd = [];
  const c16 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff);
  const c32 = (v) => cd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  c32(0x02014b50); c16(20); c16(20); c16(0); c16(0); c16(0); c16(0);
  c32(crc); c32(dataBytes.length); c32(dataBytes.length);
  c16(nameB.length); c16(0); c16(0); c16(0); c16(0); c32(0); c32(0); // attrs + local-header offset
  const cdHead = new Uint8Array(cd);
  const cdOff = head.length + nameB.length + dataBytes.length;
  const parts = [head, nameB, dataBytes, cdHead, nameB];
  const eocd = [];
  const e32 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const e16 = (v) => eocd.push(v & 0xff, (v >> 8) & 0xff);
  e32(0x06054b50); e16(0); e16(0); e16(1); e16(1);
  e32(cdHead.length + nameB.length); e32(cdOff); e16(0);
  parts.push(new Uint8Array(eocd));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}
function unzipFirstEntry(zipBytes) {
  // Stored single-entry reader: scan local headers for compression 0.
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  let off = 0;
  while (off + 30 <= zipBytes.length && dv.getUint32(off, true) === 0x04034b50) {
    const method = dv.getUint16(off + 8, true);
    const size = dv.getUint32(off + 18, true);
    const nameLen = dv.getUint16(off + 26, true);
    const extraLen = dv.getUint16(off + 28, true);
    const dataOff = off + 30 + nameLen + extraLen;
    if (method !== 0) throw new Error('unsupported zip entry');
    return zipBytes.slice(dataOff, dataOff + size);
  }
  throw new Error('bad zip');
}
function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function base64ToBytes(b64) {
  const s = atob(b64);
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}
export { zipStore, unzipFirstEntry, bytesToBase64, base64ToBytes };

// Read `#game_token=<jwt>[&session_id=<guid>]` once, then strip it (and the
// one-shot session id) from the address bar. Never persisted.
function readFragmentToken() {
  const hash = location.hash || '';
  if (!hash.includes('game_token=')) return null;
  const token = new URLSearchParams(hash.slice(1)).get('game_token');
  const rest = hash.slice(1)
    .split('&')
    .filter((p) => p && !p.startsWith('game_token=') && !p.startsWith('session_id='))
    .join('&');
  try {
    history.replaceState(null, '', location.pathname + location.search + (rest ? '#' + rest : ''));
  } catch { /* history locked — token still usable */ }
  return token;
}

// JWT payload decode only (no verify): sub = user id, game_scope = slug.
function decodeLaunchToken(token) {
  try {
    const seg = token.split('.')[1] || '';
    const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
    return { sub: json.sub || null, gameScope: json.game_scope || null };
  } catch { return { sub: null, gameScope: null }; }
}

export function createPlatform() {
  const onPlatformHost = /(^|\.)starhermit\.com$/i.test(location.hostname);
  const devHost = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(location.hostname);

  // Fragment is the real launch channel; query params are a local-dev
  // fallback only and are ignored on platform hosts.
  let launchToken = readFragmentToken();
  if (!launchToken && !onPlatformHost) {
    const params = new URLSearchParams(location.search);
    launchToken = params.get('launch_token') || params.get('token') || params.get('launch');
  }
  let sub = null;
  let gameScope = null;
  if (launchToken) ({ sub, gameScope } = decodeLaunchToken(launchToken));
  const hosted = !!launchToken;

  let timeOffsetMs = 0;
  let activityOpen = false;
  let presenceTimer = 0;
  const funnelQueue = [];
  const profileCache = new Map();

  async function api(path, opts = {}) {
    const res = await fetch('/api/v1' + path, {
      ...opts,
      headers: {
        'content-type': 'application/json',
        ...(launchToken ? { authorization: 'Bearer ' + launchToken } : {}),
        ...(opts.headers || {}),
      },
    });
    if (res.status === 429) throw Object.assign(new Error('rate-limited'), { code: 'rate-limited' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) {
      throw Object.assign(new Error(body.error || 'request-failed'), { code: body.error || res.status });
    }
    return body;
  }

  // Raw variant for endpoints that answer with bytes (the cloud-save slot).
  async function apiBytes(path, opts = {}) {
    const res = await fetch('/api/v1' + path, {
      ...opts,
      headers: {
        ...(launchToken ? { authorization: 'Bearer ' + launchToken } : {}),
        ...(opts.headers || {}),
      },
    });
    if (res.status === 404) return null;
    if (res.status === 429) throw Object.assign(new Error('rate-limited'), { code: 'rate-limited' });
    if (!res.ok) throw Object.assign(new Error('request-failed'), { code: res.status });
    return new Uint8Array(await res.arrayBuffer());
  }

  // Display NICKNAME only; "Player " + id prefix as fallback. Never usernames.
  function nicknameOf(p, userId) {
    if (p && p.nickname) return p.nickname;
    return 'Player ' + String((p && p.id) || userId || '?').slice(0, 8);
  }

  async function fetchUserProfile(userId) {
    if (profileCache.has(userId)) return profileCache.get(userId);
    const p = await api('/users/' + encodeURIComponent(userId) + '/profile');
    profileCache.set(userId, p);
    return p;
  }

  // Launch tokens live 60 min; re-mint on a 45-min cadence, retry failures
  // in about a minute. Scoped tokens may re-mint to a new token value.
  let refreshTimer = 0;
  function scheduleTokenRefresh(delayMs) {
    if (!launchToken || !gameScope) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      try {
        const res = await api('/games/' + encodeURIComponent(gameScope) + '/launch-token', { method: 'POST', body: '{}' });
        if (res.token) {
          launchToken = res.token;
          const d = decodeLaunchToken(launchToken);
          if (d.sub) sub = d.sub;
          if (d.gameScope) gameScope = d.gameScope;
        }
        scheduleTokenRefresh(45 * 60000);
      } catch {
        scheduleTokenRefresh(60000);
      }
    }, delayMs || 45 * 60000);
  }
  scheduleTokenRefresh();

  // Cloud save: ONE slot keyed by the game slug, zip+base64, remote-preferred
  // on load. localStorage stays the offline cache; the slot is a mirror.
  // Saves debounce ~2 s and flush on pagehide/visibilitychange.
  let cloudStatus = hosted ? 'idle' : 'offline';
  let cloudStatusCb = null;
  let saveTimer = 0;
  let pendingDoc = null;

  function setCloudStatus(s) {
    cloudStatus = s;
    if (cloudStatusCb) cloudStatusCb(s);
  }

  const cloudSync = {
    get status() { return cloudStatus; },
    onStatus(cb) { cloudStatusCb = cb; },
    async load() {
      if (!hosted || !gameScope) return null;
      const bytes = await apiBytes('/me/cloud-saves/' + encodeURIComponent(gameScope));
      if (!bytes) return null;
      return JSON.parse(new TextDecoder().decode(unzipFirstEntry(bytes)));
    },
    schedule(doc) {
      if (!hosted || !gameScope) return;
      pendingDoc = doc;
      clearTimeout(saveTimer);
      setCloudStatus('saving');
      saveTimer = setTimeout(() => { cloudSync.flush(); }, 2000);
    },
    async flush() {
      if (!hosted || !gameScope || pendingDoc == null) return;
      clearTimeout(saveTimer);
      const doc = pendingDoc;
      pendingDoc = null;
      try {
        const bytes = zipStore('save.json', new TextEncoder().encode(JSON.stringify(doc)));
        await api('/me/cloud-saves/' + encodeURIComponent(gameScope), {
          method: 'PUT', keepalive: true,
          body: JSON.stringify({ dataBase64: bytesToBase64(bytes) }),
        });
        setCloudStatus('synced');
      } catch {
        pendingDoc = doc; // leave queued for the next schedule/flush
        setCloudStatus('error');
      }
    },
  };
  window.addEventListener('pagehide', () => { cloudSync.flush(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) cloudSync.flush(); });

  return {
    hosted,
    launchTokenPresent: !!launchToken,
    get userId() { return sub; },
    get gameKey() { return gameScope; },
    cloudSync,

    now() { return new Date(Date.now() + timeOffsetMs); },
    timeOffsetMs() { return timeOffsetMs; },

    // Server time exists only on this game's own dev server (localhost);
    // on-platform daily boundaries use local time.
    async syncTime() {
      if (hosted || !devHost) return { synced: false };
      const t0 = Date.now();
      try {
        const body = await api('/time');
        const t1 = Date.now();
        const serverMs = typeof body.now === 'number' ? body.now : Date.parse(body.now);
        if (!Number.isFinite(serverMs)) return { synced: false };
        timeOffsetMs = serverMs - Math.round((t0 + t1) / 2);
        return { synced: true, offsetMs: timeOffsetMs };
      } catch {
        return { synced: false };
      }
    },

    // Account display name from the platform profile (never /api/v1/me,
    // never usernames). "Player " + id prefix fallback on any failure.
    async fetchProfileName() {
      if (!hosted || !sub) return null;
      try {
        return nicknameOf(await fetchUserProfile(sub), sub);
      } catch {
        return 'Player ' + String(sub).slice(0, 8);
      }
    },

    // Read-only leaderboards (clients can never submit scores). Resolves
    // entry userIds to nicknames via the profile helper. Null when the game
    // has no leaderboardId or the read fails — caller shows local records.
    async fetchLeaderboard(friendsOnly) {
      if (!hosted || !gameScope) return null;
      try {
        const game = await api('/games/' + encodeURIComponent(gameScope));
        const leaderboardId = game.leaderboardId;
        if (!leaderboardId) return null;
        const q = new URLSearchParams({ friendsOnly: friendsOnly ? 'true' : 'false', page: '1', pageSize: '50' });
        const res = await api('/leaderboards/' + encodeURIComponent(leaderboardId) + '/entries?' + q.toString());
        const list = res.entries || res.items || [];
        return await Promise.all(list.map(async (e) => {
          const uid = e.userId || e.user_id || e.playerId || null;
          let name = uid ? 'Player ' + String(uid).slice(0, 8) : 'Player';
          if (uid) {
            try { name = nicknameOf(await fetchUserProfile(uid), uid); } catch { /* keep fallback */ }
          }
          return {
            name,
            me: !!uid && uid === sub,
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
      } catch {
        return null;
      }
    },

    // Its own replay-validated daily submission — reachable only against this
    // game's dev server on localhost (its-backend); a graceful casual
    // fallback otherwise. Hosted mode never submits (platform boards are
    // script-owned and read-only for clients).
    async submitScore(payload) {
      if (hosted) return { accepted: false, casual: true };
      try {
        const res = await api('/scores', { method: 'POST', body: JSON.stringify(payload) });
        return res.accepted ? res : { accepted: false, casual: true };
      } catch {
        return { accepted: false, casual: true };
      }
    },

    // Presence/activity/telemetry have no per-game platform endpoints; these
    // remain localhost dev-server hooks only (its own server.js answers
    // them). Hosted mode sends nothing.
    activityStart() {
      if (hosted || !devHost || activityOpen) return;
      activityOpen = true;
      api('/activity/start', { method: 'POST', body: '{}' }).catch(() => {});
    },
    activityEnd() {
      if (hosted || !devHost || !activityOpen) return;
      activityOpen = false;
      api('/activity/end', { method: 'POST', body: '{}' }).catch(() => {});
    },
    presenceStart(getState) {
      this.presenceStop();
      if (hosted || !devHost) return;
      presenceTimer = setInterval(() => {
        api('/presence', { method: 'POST', body: JSON.stringify({ state: getState() }) }).catch(() => {});
      }, 30000);
    },
    presenceStop() {
      if (presenceTimer) clearInterval(presenceTimer);
      presenceTimer = 0;
    },

    // Anonymous funnel events only: start, tutorial step, round end, retry,
    // settings change, error category. Consent-gated; queued locally when
    // offline (localhost dev-server hook; nothing is sent on-platform).
    telemetry(eventName, data, consent) {
      if (!consent) return;
      const event = { e: eventName, d: data || {}, at: Date.now() };
      if (hosted) return; // no per-game telemetry endpoint on-platform
      if (!devHost) {
        if (funnelQueue.length < 200) funnelQueue.push(event);
        return;
      }
      api('/telemetry', { method: 'POST', body: JSON.stringify(event) }).catch(() => {
        if (funnelQueue.length < 200) funnelQueue.push(event);
      });
    },
  };
}
