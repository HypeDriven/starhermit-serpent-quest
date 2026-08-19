// Platform adapter: StarHermit host integration when hosted, graceful offline
// behavior otherwise. Tokens are read from the launch URL and never persisted.
// All network failures degrade to recoverable UI states, never crashes.

export function createPlatform() {
  const params = new URLSearchParams(location.search);
  const launchToken = params.get('launch_token') || params.get('token') || null;
  const hosted = !!launchToken;
  let timeOffsetMs = 0;
  let activityOpen = false;
  let presenceTimer = 0;
  const funnelQueue = [];

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

  return {
    hosted,
    launchTokenPresent: !!launchToken,

    // Round-trip-adjusted server time sync for countdowns and daily boundaries.
    async syncTime() {
      if (!hosted) return { synced: false };
      const t0 = Date.now();
      try {
        const body = await api('/time');
        const t1 = Date.now();
        const serverMs = typeof body.now === 'number' ? body.now : Date.parse(body.now);
        timeOffsetMs = serverMs - Math.round((t0 + t1) / 2);
        return { synced: true, offsetMs: timeOffsetMs };
      } catch {
        return { synced: false };
      }
    },

    now() { return new Date(Date.now() + timeOffsetMs); },
    timeOffsetMs() { return timeOffsetMs; },

    // Playtime accuracy: pair activity start/end.
    activityStart() {
      if (!hosted || activityOpen) return;
      activityOpen = true;
      api('/activity/start', { method: 'POST', body: '{}' }).catch(() => {});
    },
    activityEnd() {
      if (!hosted || !activityOpen) return;
      activityOpen = false;
      api('/activity/end', { method: 'POST', body: '{}' }).catch(() => {});
    },

    // Throttled presence while actively playing; honors hidden profiles by
    // simply not sending when the player opted out (checked by caller).
    presenceStart(getState) {
      this.presenceStop();
      if (!hosted) return;
      presenceTimer = setInterval(() => {
        api('/presence', { method: 'POST', body: JSON.stringify({ state: getState() }) }).catch(() => {});
      }, 30000);
    },
    presenceStop() {
      if (presenceTimer) clearInterval(presenceTimer);
      presenceTimer = 0;
    },

    // Anonymous funnel events only: start, tutorial step, round end, retry,
    // settings change, error category. Consent-gated; queued locally when offline.
    telemetry(eventName, data, consent) {
      if (!consent) return;
      const event = { e: eventName, d: data || {}, at: Date.now() };
      if (!hosted) {
        if (funnelQueue.length < 200) funnelQueue.push(event);
        return;
      }
      api('/telemetry', { method: 'POST', body: JSON.stringify(event) }).catch(() => {
        if (funnelQueue.length < 200) funnelQueue.push(event);
      });
    },

    // Competitive submission. Offline: caller stores locally and labels casual.
    async submitScore(payload) {
      if (!hosted) return { accepted: false, casual: true };
      return api('/scores', { method: 'POST', body: JSON.stringify(payload) });
    },

    async fetchBoard(boardId) {
      if (!hosted) return { entries: [], casual: true };
      return api('/boards/' + encodeURIComponent(boardId));
    },

    async fetchFriends() {
      if (!hosted) return [];
      try { return (await api('/friends')).friends || []; } catch { return []; }
    },
  };
}
