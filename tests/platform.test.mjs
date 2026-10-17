// js/platform.js over the shipped StarHermit SDK with a stubbed fetch and launch fragment:
// token read, profile nickname, cloud save round trip on `game:<slug>`, settings KV, control
// bindings, read-only boards, and no network traffic standalone.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPlatform } from '../js/platform.js';

const SDK = (() => {
  const m = { exports: {} };
  new Function('module', 'exports', readFileSync(new URL('../starhermit-sdk.js', import.meta.url), 'utf8'))(m, m.exports);
  return m.exports;
})();

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const TOKEN = `${b64u({ alg: 'none' })}.${b64u({ sub: 'u-1234567890', game_scope: 'serpent-quest', exp: 9999999999 })}.sig`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timers = { setTimeout: (fn, ms) => (ms > 5000 ? 0 : setTimeout(fn, ms)), clearTimeout: (t) => t && clearTimeout(t) };

let net, local;
function stubNet() {
  const calls = [];
  const store = { save: null, etag: null, version: 0, patches: [], controls: [] };
  const fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ method, url, auth: init.headers && init.headers.Authorization });
    const json = (code, body) => new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } });
    const g = '/api/v1/games/serpent-quest';
    if (url === '/api/v1/users/u-1234567890/profile') return json(200, { nickname: 'Sly Sam' });
    if (url === '/api/v1/me/cloud-saves/game%3Aserpent-quest/info') return json(200, store.save ? { exists: true, etag: store.etag } : { exists: false });
    if (url === '/api/v1/me/cloud-saves/game%3Aserpent-quest') {
      if (method === 'GET') return store.save ? new Response(store.save, { status: 200 }) : json(404, {});
      if (method === 'PUT') {
        // Conditional writes (SDK ETag): a write based on an older version loses with 412.
        const h = init.headers || {};
        if ((h['If-Match'] && h['If-Match'] !== store.etag) || (h['If-None-Match'] === '*' && store.save)) return json(412, { etag: store.etag });
        store.save = Buffer.from(JSON.parse(init.body).dataBase64, 'base64');
        store.etag = `"v${++store.version}"`;
        return json(200, { etag: store.etag });
      }
    }
    if (url === `${g}/settings`) {
      if (method === 'GET') return json(200, { settings: { music: 0.2, bindings: { up: ['KeyI'] } } });
      if (method === 'PATCH') { store.patches.push(JSON.parse(init.body).settings); return json(200, {}); }
    }
    if (url === `${g}/controls`) {
      if (method === 'GET') return json(200, { actions: [{ action: 'camera_reset', codes: ['KeyV'] }] });
      store.controls.push(JSON.parse(init.body));
      return json(200, {});
    }
    if (url === g) return json(200, { leaderboardId: 'lb-1' });
    if (url.startsWith('/api/v1/leaderboards/lb-1/entries')) return json(200, { items: [{ userId: 'u-1234567890', score: 77 }] });
    return json(404, {});
  };
  return { calls, store, fetch };
}
function launch(hash, hostname) {
  const loc = { hash, pathname: '/', search: '', hostname, href: `https://${hostname}/${hash}`, origin: `https://${hostname}` };
  const win = { location: loc, history: { state: null, replaceState(_s, _t, url) { loc.hash = url.includes('#') ? url.slice(url.indexOf('#')) : ''; } } };
  globalThis.window = { StarHermit: SDK.create({ window: win, fetch: net.fetch, ...timers }), addEventListener() {} };
  globalThis.document = { addEventListener() {}, hidden: false };
  globalThis.location = loc;
  return loc;
}
beforeEach(() => {
  net = stubNet();
  local = [];
  globalThis.fetch = async (u) => { local.push(String(u)); return { ok: false, status: 404, json: async () => ({}) }; };
});

test('hosted: token, nickname, cloud save, settings KV, bindings, board', async () => {
  const loc = launch(`#game_token=${TOKEN}`, 'localhost');
  const p = createPlatform();
  assert.equal(p.hosted, true);
  assert.equal(loc.hash, '');
  assert.equal(p.gameKey, 'serpent-quest');
  assert.equal(p.userId, 'u-1234567890');
  assert.equal(await p.fetchProfileName(), 'Sly Sam');

  assert.equal(await p.cloudSync.load(), null);
  p.cloudSync.schedule({ version: 1, progression: { masteryPoints: 5 } });
  assert.equal(p.cloudSync.status, 'saving');
  await p.cloudSync.flush();
  assert.equal(p.cloudSync.status, 'synced');
  assert.deepEqual(await p.cloudSync.load(), { version: 1, progression: { masteryPoints: 5 } });

  const settings = { version: 1, music: 0.7, sfx: 0.9, largeText: false, bindings: { up: ['ArrowUp'], cameraReset: ['KeyC'] } };
  assert.equal(await p.loadSettings(settings), true);
  assert.equal(settings.music, 0.2);
  assert.deepEqual(settings.bindings.up, ['ArrowUp'], 'bindings come from the controls API, not settings');
  settings.largeText = true;
  p.mirrorSettings(settings);
  await sleep(700);
  assert.deepEqual(net.store.patches.at(-1), { largeText: true });

  const b = await p.loadBindings(settings.bindings);
  assert.deepEqual(b, { up: ['ArrowUp'], cameraReset: ['KeyV'] });
  p.saveBinding('cameraReset', ['KeyB']);
  p.saveBinding('confirm', ['Enter']); // not a declared control
  await sleep(10);
  assert.deepEqual(net.store.controls, [{ bindings: { camera_reset: ['KeyB'] } }]);

  const board = await p.fetchLeaderboard(true);
  assert.equal(board[0].name, 'Sly Sam');
  assert.equal(board[0].me, true);
  assert.ok(net.calls.some((c) => c.url.includes('scope=friends')));
  assert.ok(net.calls.every((c) => c.auth === `Bearer ${TOKEN}`));
  assert.deepEqual(local, [], 'no dev-server calls while hosted');
  assert.ok(p.inviteLink().endsWith('/game-invite/u-1234567890/serpent-quest'));
});

test('standalone on the platform host: no network; sign-in offered', async () => {
  // Sign-in is offered only on a game's UUID host (<uuid>.starhermit.com).
  launch('', '0b9d6f2e-3c4a-4e5b-9a7c-1d2e3f405162.starhermit.com');
  const p = createPlatform();
  assert.equal(p.hosted, false);
  assert.equal(p.canSignIn(), true);
  assert.equal(await p.fetchProfileName(), null);
  assert.equal(await p.cloudSync.load(), null);
  p.cloudSync.schedule({ a: 1 });
  await p.cloudSync.flush();
  assert.equal(await p.loadSettings({ music: 1 }), false);
  p.mirrorSettings({ music: 1 });
  assert.deepEqual(await p.loadBindings({ up: ['ArrowUp'] }), { up: ['ArrowUp'] });
  p.saveBinding('up', ['KeyI']);
  assert.equal(await p.fetchLeaderboard(false), null);
  assert.equal(p.inviteLink(), null);
  await sleep(700);
  assert.deepEqual(net.calls, []);
  assert.deepEqual(local, []);
});

test('standalone on localhost: no own-server calls; local clock', async () => {
  launch('', '127.0.0.1');
  const p = createPlatform();
  assert.equal(p.hosted, false);
  assert.ok(Math.abs(p.now().getTime() - Date.now()) < 1000);
  assert.equal(await p.fetchLeaderboard(false), null);
  await sleep(50);
  assert.deepEqual(net.calls, []);
  assert.deepEqual(local, []);
});

test('save conflict: a write that loses to another device reloads the slot for the merge', async () => {
  launch(`#game_token=${TOKEN}`, 'localhost');
  const p = createPlatform();
  assert.equal(await p.cloudSync.load(), null);
  p.cloudSync.schedule({ version: 1, progression: { masteryPoints: 1 } });
  await p.cloudSync.flush();
  // Another device (its own SDK instance on the same account) saves in between.
  const loc2 = { hash: `#game_token=${TOKEN}`, pathname: '/', search: '', hostname: 'localhost', href: `https://localhost/#game_token=${TOKEN}`, origin: 'https://localhost' };
  const other = SDK.create({ window: { location: loc2, history: { state: null, replaceState() {} } }, fetch: net.fetch, ...timers });
  other.init();
  await other.loadJSON();
  other.saveJSON({ version: 1, progression: { masteryPoints: 9 } }, 0);
  await other.flushSave(true);
  const seen = [];
  p.cloudSync.onConflict((remote) => {
    seen.push(remote);
    p.cloudSync.schedule({ version: 1, progression: { masteryPoints: 9, merged: true } });
    p.cloudSync.flush();
  });
  p.cloudSync.schedule({ version: 1, progression: { masteryPoints: 2 } });
  await p.cloudSync.flush();
  for (let i = 0; i < 50 && !seen.length; i++) await sleep(5);
  await sleep(30);
  assert.deepEqual(seen, [{ version: 1, progression: { masteryPoints: 9 } }]);
  assert.deepEqual(await other.loadJSON(), { version: 1, progression: { masteryPoints: 9, merged: true } });
  assert.equal(p.cloudSync.status, 'synced');
});
