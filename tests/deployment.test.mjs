import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { configFromEnv } from '../src/config.js';
import { MemoryStore } from '../src/memory-store.js';

const ORIGIN = 'https://gifts.example.com';
const ADMIN = { username: 'deployment-admin', password: 'only-used-for-deployment-tests' };

async function fixture(t, config = {}) {
  const store = new MemoryStore();
  await store.initialize({ ...ADMIN, prizes: [{ title: 'Gift', sub: '', color: '#ffcc44', icon: 'G' }] });
  const app = createApp({ store, config: { clientOrigins: [ORIGIN, 'https://admin.example.com'], ...config } });
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = 'GET', body, headers = {} } = {}) => fetch(`${base}${path}`, {
    method,
    headers: { Origin: ORIGIN, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return { store, request, base };
}

test('direct cross-origin frontend requests receive credentialed preflight and Date exposure', async t => {
  const { request } = await fixture(t);
  const preflight = await request('/api/auth/login', { method: 'OPTIONS', headers: {
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type',
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
  assert.match(preflight.headers.get('access-control-allow-methods'), /POST/);
  assert.match(preflight.headers.get('access-control-allow-headers'), /Content-Type/i);
  assert.match(preflight.headers.get('vary'), /Origin/);

  const response = await request('/api/health', { headers: { Origin: 'https://admin.example.com' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://admin.example.com');
  assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
  assert.equal(response.headers.get('access-control-expose-headers'), 'Date');
  assert.ok(Number.isFinite(Date.parse(response.headers.get('date'))));
});

test('unknown origins cannot preflight, read sessions, or create admin sessions', async t => {
  const { request, base } = await fixture(t);
  for (const origin of ['https://untrusted.example', 'null', base]) {
    for (const options of [
      { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST' } },
      {},
      { method: 'POST', body: ADMIN },
    ]) {
      const response = await request(options.method === 'POST' ? '/api/auth/login' : '/api/player/session', {
        ...options, headers: { ...options.headers, Origin: origin },
      });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('access-control-allow-origin'), null);
      assert.equal(response.headers.get('set-cookie'), null);
    }
  }
});

test('cross-site configuration applies the same secure cookie attributes to player, admin and logout', async t => {
  const { request, store } = await fixture(t, configFromEnv({
    NODE_ENV: 'production', CLIENT_ORIGIN: ORIGIN, COOKIE_SAME_SITE: 'none', COOKIE_SECURE: 'true', TRUST_PROXY: '1',
  }));
  const login = await request('/api/auth/login', { method: 'POST', body: ADMIN });
  assert.equal(login.status, 200);
  const adminCookie = login.headers.get('set-cookie');
  await store.createCodes(['DEPLOYMENT-PLAYER']);
  const player = await request('/api/player/start', { method: 'POST', body: { code: 'DEPLOYMENT-PLAYER' } });
  assert.equal(player.status, 200);
  const playerCookie = player.headers.get('set-cookie');
  const logout = await request('/api/auth/logout', {
    method: 'POST', body: {}, headers: { Cookie: adminCookie.split(';', 1)[0] },
  });
  assert.equal(logout.status, 200);
  for (const cookie of [adminCookie, playerCookie, logout.headers.get('set-cookie')]) {
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /; SameSite=None/);
    assert.match(cookie, /; Path=\//);
  }
  assert.match(logout.headers.get('set-cookie'), /^lm_admin=;/);
  assert.match(logout.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
  const restored = await request('/api/auth/me', { headers: { Cookie: adminCookie.split(';', 1)[0] } });
  assert.equal(restored.status, 401);
});

test('default local cookies use SameSite Lax without Secure; production defaults Secure', async t => {
  for (const production of [false, true]) {
    await t.test(production ? 'production' : 'development', async t => {
      const { request } = await fixture(t, { production });
      const response = await request('/api/auth/login', { method: 'POST', body: ADMIN });
      assert.equal(response.status, 200);
      const cookie = response.headers.get('set-cookie');
      assert.match(cookie, /; SameSite=Lax/);
      assert.equal(cookie.includes('; Secure'), production);
    });
  }
});

test('trust proxy hop count controls whether rate limits distinguish forwarded client IPs', async t => {
  for (const trustProxy of [0, 1]) {
    await t.test(`TRUST_PROXY=${trustProxy}`, async t => {
      const { request } = await fixture(t, { trustProxy, loginLimit: 1 });
      const attempt = ip => request('/api/auth/login', {
        method: 'POST', body: { ...ADMIN, password: 'wrong-password' }, headers: { 'X-Forwarded-For': ip },
      });
      assert.equal((await attempt('198.51.100.10')).status, 401);
      assert.equal((await attempt('198.51.100.11')).status, trustProxy ? 401 : 429);
      assert.equal((await attempt('198.51.100.10')).status, 429);
    });
  }
});

test('API server returns JSON 404 for frontend routes and unknown APIs', async t => {
  const { request } = await fixture(t);
  for (const path of ['/', '/admin', '/assets/index.js', '/api/missing']) {
    const response = await request(path);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type'), /^application\/json/);
    assert.equal(typeof (await response.json()).message, 'string');
  }
});

test('environment validates cookie/proxy configuration and exact frontend origins', () => {
  assert.equal(configFromEnv({ NODE_ENV: 'production' }).cookieSecure, true);
  assert.equal(configFromEnv({ NODE_ENV: 'development' }).cookieSecure, false);
  assert.equal(configFromEnv({ NODE_ENV: 'production', COOKIE_SECURE: 'false' }).cookieSecure, false);
  assert.equal(configFromEnv({ COOKIE_SAME_SITE: 'strict' }).cookieSameSite, 'strict');
  assert.equal(configFromEnv({ TRUST_PROXY: '2' }).trustProxy, 2);
  assert.deepEqual(configFromEnv({ CLIENT_ORIGIN: `${ORIGIN}, https://admin.example.com` }).clientOrigins,
    [ORIGIN, 'https://admin.example.com']);
  for (const env of [
    { COOKIE_SAME_SITE: 'none', COOKIE_SECURE: 'false' },
    { COOKIE_SAME_SITE: 'invalid' },
    { COOKIE_SECURE: 'yes' },
    { TRUST_PROXY: '-1' },
    { TRUST_PROXY: '1.5' },
    { TRUST_PROXY: 'true' },
    { TRUST_PROXY: '9007199254740992' },
    { CLIENT_ORIGIN: '*' },
    { CLIENT_ORIGIN: 'https://example.com/path' },
    { CLIENT_ORIGIN: 'https://example.com/' },
  ]) assert.throws(() => configFromEnv(env));
  assert.throws(() => createApp({ store: new MemoryStore(), config: { cookieSameSite: 'none', cookieSecure: false } }));
});
