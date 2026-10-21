import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/memory-store.js';

const ORIGIN = 'http://localhost:5173';
const ADMIN = { username: 'http-test-admin', password: 'only-used-in-memory-tests' };
const PRIZE = { title: 'Spring gift', sub: 'Test prize', icon: 'G', color: '#f9c65a' };

async function fixture(t) {
  const store = new MemoryStore();
  await store.initialize({ ...ADMIN, prizes: [PRIZE] });
  const server = createServer(createApp({ store, config: { clientOrigins: [ORIGIN] } }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function request(path, { method = 'GET', body, cookie } = {}) {
    const headers = { Origin: ORIGIN, Accept: 'application/json' };
    if (cookie) headers.Cookie = cookie;
    if (method !== 'GET') headers['Content-Type'] = 'application/json';
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return {
      status: response.status,
      body: await response.json(),
      cookie: response.headers.get('set-cookie')?.split(';', 1)[0],
    };
  }

  async function player(codeValue) {
    const [code] = await store.createCodes([codeValue]);
    const started = await request('/api/player/start', { method: 'POST', body: { code: codeValue } });
    assert.equal(started.status, 200);
    assert.match(started.cookie, /^lm_player=/);
    const named = await request('/api/player/name', {
      method: 'PATCH', cookie: started.cookie, body: { name: 'Test Player' },
    });
    assert.equal(named.status, 200);
    return { id: code.id, code: codeValue, cookie: started.cookie };
  }

  async function adminCookie() {
    const loggedIn = await request('/api/auth/login', { method: 'POST', body: ADMIN });
    assert.equal(loggedIn.status, 200);
    assert.match(loggedIn.cookie, /^lm_admin=/);
    return loggedIn.cookie;
  }

  return { store, request, player, adminCookie };
}

const open = (request, cookie, index) => request(`/api/player/envelopes/${index}/open`, {
  method: 'POST', cookie, body: {},
});

test('concurrent selections of different envelopes award exactly one prize per code', async t => {
  const { store, request, player } = await fixture(t);
  const owner = await player('HTTP-RACE-ONE');
  const results = await Promise.all([open(request, owner.cookie, 3), open(request, owner.cookie, 12)]);

  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const won = results.find(result => result.status === 200);
  const rejected = results.find(result => result.status === 409);
  assert.equal(won.body.player.status, 'used');
  assert.equal(won.body.player.rewards.length, 1);
  assert.deepEqual(won.body.player.opened, [won.body.reward.index]);
  assert.equal(typeof rejected.body.message, 'string');
  assert.deepEqual(rejected.body.player, won.body.player);

  const stored = await store.getCodeById(owner.id);
  assert.equal(stored.openedCount, 1);
  assert.equal(stored.status, 'used');
  assert.ok(stored.usedAt);
  assert.equal(stored.envelopes.filter(envelope => envelope.openedAt).length, 1);
  assert.equal((await store.listWinners({ page: 1, limit: 20, search: '' })).total, 1);
});

test('retrying a winning envelope and restoring its session never creates another reward', async t => {
  const { store, request, player } = await fixture(t);
  const owner = await player('HTTP-RETRY-ONE');
  const firstSelections = await Promise.all([
    open(request, owner.cookie, 15),
    open(request, owner.cookie, 15),
  ]);
  const won = firstSelections[0];
  for (const selection of firstSelections) {
    assert.equal(selection.status, 200);
    assert.deepEqual(selection.body, won.body);
  }

  const retries = await Promise.all([
    open(request, owner.cookie, 15),
    open(request, owner.cookie, 15),
  ]);
  for (const retry of retries) {
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.body, won.body);
  }

  const restored = await request('/api/player/session', { cookie: owner.cookie });
  assert.equal(restored.status, 200);
  assert.deepEqual(restored.body.player, won.body.player);
  const otherSelection = await open(request, owner.cookie, 0);
  assert.equal(otherSelection.status, 409);
  assert.deepEqual(otherSelection.body.player, won.body.player);
  const resumed = await request('/api/player/start', {
    method: 'POST', cookie: owner.cookie, body: { code: owner.code },
  });
  assert.equal(resumed.status, 200);
  assert.deepEqual(resumed.body.player, won.body.player);

  const anotherBrowser = await request('/api/player/start', { method: 'POST', body: { code: owner.code } });
  assert.equal(anotherBrowser.status, 409);
  const validation = await request('/api/codes/validate', { method: 'POST', body: { code: owner.code } });
  assert.equal(validation.status, 200);
  assert.equal(validation.body.valid, false);
  assert.equal((await store.getCodeById(owner.id)).openedCount, 1);
  assert.equal((await store.listWinners({ page: 1, limit: 20, search: '' })).total, 1);
});

test('admin disabling and unlocking a consumed code cannot replenish its prize', async t => {
  const { store, request, player, adminCookie } = await fixture(t);
  const owner = await player('HTTP-UNLOCK-ONE');
  const won = await open(request, owner.cookie, 5);
  assert.equal(won.status, 200);
  const cookie = await adminCookie();

  const disabled = await request(`/api/admin/codes/${owner.id}`, {
    method: 'PATCH', cookie, body: { status: 'disabled' },
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.item.status, 'disabled');
  assert.equal((await open(request, owner.cookie, 6)).status, 403);

  const unlocked = await request(`/api/admin/codes/${owner.id}`, {
    method: 'PATCH', cookie, body: { status: 'available' },
  });
  assert.equal(unlocked.status, 200);
  assert.equal(unlocked.body.item.status, 'used');
  const rejected = await open(request, owner.cookie, 6);
  assert.equal(rejected.status, 409);
  assert.deepEqual(rejected.body.player, won.body.player);
  assert.deepEqual((await open(request, owner.cookie, 5)).body, won.body);

  const used = await request('/api/admin/codes?status=used', { cookie });
  const active = await request('/api/admin/codes?status=active', { cookie });
  assert.equal(used.status, 200);
  assert.deepEqual(used.body.items.map(item => item.id), [owner.id]);
  assert.equal(active.status, 200);
  assert.equal(active.body.total, 0);
  const dashboard = await request('/api/admin/dashboard', { cookie });
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.body.stats.usedCodes, 1);
  assert.equal(dashboard.body.stats.totalRewards, 1);
  assert.equal((await store.getCodeById(owner.id)).openedCount, 1);
});

test('legacy active codes expose only the earliest prize and preserve historical awards', async t => {
  const { store, request, player, adminCookie } = await fixture(t);
  const owner = await player('HTTP-LEGACY-ONE');
  const legacy = store.codes.get(owner.id);
  // This fixture models a stored record created by the previous multi-prize rules.
  legacy.envelopes[2].openedAt = new Date('2026-01-02T00:00:00Z');
  legacy.envelopes[7].openedAt = new Date('2026-01-01T00:00:00Z');
  legacy.openedCount = 2;
  legacy.status = 'active';

  const restored = await request('/api/player/session', { cookie: owner.cookie });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.player.status, 'used');
  assert.deepEqual(restored.body.player.opened, [7]);
  assert.equal(restored.body.player.rewards.length, 1);
  assert.equal(restored.body.player.rewards[0].index, 7);

  for (const index of [2, 11]) {
    const rejected = await open(request, owner.cookie, index);
    assert.equal(rejected.status, 409);
    assert.deepEqual(rejected.body.player, restored.body.player);
  }
  const original = await open(request, owner.cookie, 7);
  assert.equal(original.status, 200);
  assert.deepEqual(original.body.player, restored.body.player);
  assert.deepEqual(original.body.reward, restored.body.player.rewards[0]);

  const cookie = await adminCookie();
  const used = await request('/api/admin/codes?status=used', { cookie });
  assert.equal(used.status, 200);
  assert.deepEqual(used.body.items.map(item => item.id), [owner.id]);
  const stored = await store.getCodeById(owner.id);
  assert.equal(stored.openedCount, 2);
  assert.equal(stored.envelopes.filter(envelope => envelope.openedAt).length, 2);
  assert.equal((await store.listWinners({ page: 1, limit: 20, search: '' })).total, 2);
});

test('a legacy consumed counter without a reward snapshot still blocks another award', async t => {
  const { store, request, player } = await fixture(t);
  const owner = await player('HTTP-LEGACY-COUNT');
  const legacy = store.codes.get(owner.id);
  legacy.openedCount = 1;
  legacy.status = 'active';

  const restored = await request('/api/player/session', { cookie: owner.cookie });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.player.status, 'used');
  assert.equal(restored.body.player.rewards.length, 0);
  const rejected = await open(request, owner.cookie, 4);
  assert.equal(rejected.status, 409);
  assert.deepEqual(rejected.body.player, restored.body.player);
  const stored = await store.getCodeById(owner.id);
  assert.equal(stored.openedCount, 1);
  assert.equal(stored.envelopes.filter(envelope => envelope.openedAt).length, 0);
});
