import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Worker } from 'node:worker_threads';
import express from 'express';
import test from 'node:test';
import { createRuntime } from '../src/runtime.js';

const ENV = {
  MONGO_URI: 'mongodb://unused.invalid/runtime-tests',
  ADMIN_USERNAME: 'runtime-admin',
  ADMIN_PASSWORD: 'only-used-for-runtime-tests',
  CLIENT_ORIGIN: 'https://gifts.example.com',
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeStore({ connect, initialize, close } = {}) {
  return {
    ready: false,
    calls: { connect: 0, initialize: 0, close: 0 },
    async connect(uri) {
      this.calls.connect++;
      assert.equal(uri, ENV.MONGO_URI);
      await connect?.();
      this.ready = true;
    },
    async initialize(options) {
      this.calls.initialize++;
      assert.equal(options.username, ENV.ADMIN_USERNAME);
      assert.equal(options.password, ENV.ADMIN_PASSWORD);
      assert.ok(options.prizes.length > 0);
      await initialize?.();
    },
    isReady() { return this.ready; },
    async close() {
      this.calls.close++;
      this.ready = false;
      await close?.();
    },
  };
}

async function serve(t, runtime) {
  const app = express();
  app.use(runtime.handle);
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await runtime.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return (path, options = {}) => fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(5000) });
}

test('Vercel entry exports an Express handler without reading env files, connecting, or listening', async t => {
  const source = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import net from 'node:net';
    import { syncBuiltinESMExports } from 'node:module';
    import mongoose from ${JSON.stringify(import.meta.resolve('mongoose'))};
    const originalExists = fs.existsSync;
    fs.existsSync = path => {
      if (String(path).endsWith('.env')) throw new Error('Entry checked a local env file');
      return originalExists(path);
    };
    process.loadEnvFile = () => { throw new Error('Entry loaded a local env file'); };
    net.Server.prototype.listen = () => { throw new Error('Entry opened an HTTP listener'); };
    mongoose.createConnection = () => { throw new Error('Entry opened a MongoDB connection'); };
    syncBuiltinESMExports();
    const entry = await import(${JSON.stringify(new URL('../server.js', import.meta.url).href)});
    assert.equal(typeof entry.default, 'function');
    assert.equal(typeof entry.default.listen, 'function');
    assert.equal(typeof entry.startServer, 'function');
    console.log('import-safe');
  `;
  // Keep operating-system process settings while excluding application credentials.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(MONGO_URI|ADMIN_|CLIENT_ORIGIN$|COOKIE_|TRUST_PROXY$|CLOUDINARY_)/i.test(key)));
  const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), { env, stdout: true, stderr: true });
  t.after(() => worker.terminate());
  let stdout = '';
  let stderr = '';
  worker.stdout.on('data', chunk => { stdout += chunk; });
  worker.stderr.on('data', chunk => { stderr += chunk; });
  const [exitCode] = await once(worker, 'exit');
  assert.equal(exitCode, 0);
  assert.equal(stdout.trim(), 'import-safe');
  assert.equal(stderr, '');
});

test('invalid runtime configuration returns uncached 503 JSON and does not open a store', async t => {
  for (const invalid of [{ MONGO_URI: '' }, { ADMIN_USERNAME: '' }, { ADMIN_PASSWORD: 'short' }, { CLIENT_ORIGIN: 'https://gifts.example.com/' }]) {
    await t.test(Object.keys(invalid)[0], async t => {
      const messages = [];
      let factories = 0;
      const runtime = createRuntime({
        env: { ...ENV, ...invalid },
        storeFactory() { factories++; return fakeStore(); },
        logger: { error: message => messages.push(message) },
      });
      const request = await serve(t, runtime);
      for (const path of ['/health', '/api/health/']) {
        const response = await request(path);
        assert.equal(response.status, 503);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.deepEqual(await response.json(), { ok: false, database: 'unavailable', code: 'API_CONFIGURATION_ERROR' });
      }
      const head = await request('/api/health', { method: 'HEAD' });
      assert.equal(head.status, 503);
      assert.equal(await head.text(), '');
      const api = await request('/api/auth/me');
      assert.equal(api.status, 503);
      assert.deepEqual(await api.json(), {
        message: 'API is temporarily unavailable. Please try again later.', code: 'API_CONFIGURATION_ERROR',
      });
      assert.equal(factories, 0);
      assert.ok(messages.length > 0);
      assert.ok(!messages.join(' ').includes(ENV.ADMIN_PASSWORD));
      assert.ok(!messages.join(' ').includes(ENV.MONGO_URI));
    });
  }
});

test('database connection failure cleans up, hides driver credentials, and retries the next request', async t => {
  const messages = [];
  const failed = fakeStore({ connect() { throw new Error(`Driver failure: ${ENV.MONGO_URI} password=${ENV.ADMIN_PASSWORD}`); } });
  const recovered = fakeStore();
  const stores = [failed, recovered];
  let factories = 0;
  const runtime = createRuntime({
    env: ENV, storeFactory: () => stores[factories++], logger: { error: message => messages.push(message) },
  });
  const request = await serve(t, runtime);
  const unavailable = await request('/api/health');
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { ok: false, database: 'unavailable', code: 'DATABASE_UNAVAILABLE', reason: 'DATABASE_CONNECTION_FAILED' });
  assert.deepEqual(failed.calls, { connect: 1, initialize: 0, close: 1 });
  assert.equal(runtime.store, undefined);
  assert.ok(!messages.join(' ').includes(ENV.MONGO_URI));
  assert.ok(!messages.join(' ').includes(ENV.ADMIN_PASSWORD));

  const healthy = await request('/api/health');
  assert.equal(healthy.status, 200);
  assert.deepEqual(await healthy.json(), { ok: true, database: 'connected' });
  assert.equal(runtime.store, recovered);
  assert.deepEqual(recovered.calls, { connect: 1, initialize: 1, close: 0 });
  assert.equal(factories, 2);
});

test('database initialization and app construction failures close their partial stores', async t => {
  for (const stage of ['initialize', 'app']) {
    await t.test(stage, async t => {
      const store = fakeStore({ initialize: stage === 'initialize' ? () => { throw new Error('initialization failed'); } : undefined });
      const runtime = createRuntime({
        env: ENV, storeFactory: () => store, logger: { error() {} },
        ...(stage === 'app' ? { appFactory() { throw new Error('app failed'); } } : {}),
      });
      const request = await serve(t, runtime);
      const response = await request('/health');
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        ok: false, database: 'unavailable', code: stage === 'initialize' ? 'DATABASE_UNAVAILABLE' : 'API_INITIALIZATION_ERROR',
        ...(stage === 'initialize' ? { reason: 'DATABASE_INITIALIZATION_FAILED' } : {}),
      });
      assert.deepEqual(store.calls, { connect: 1, initialize: 1, close: 1 });
      assert.equal(runtime.store, undefined);
    });
  }
});

test('health exposes a fixed database failure reason while logs and API responses omit credentials', async t => {
  const messages = [];
  const runtime = createRuntime({
    env: ENV,
    storeFactory: () => fakeStore({ connect() {
      throw Object.assign(new Error(`Authentication failed for ${ENV.MONGO_URI}, password=${ENV.ADMIN_PASSWORD}`), { code: 18 });
    } }),
    logger: { error: message => messages.push(message) },
  });
  const request = await serve(t, runtime);
  const health = await request('/api/health');
  const body = await health.json();
  assert.equal(health.status, 503);
  assert.deepEqual(body, {
    ok: false, database: 'unavailable', code: 'DATABASE_UNAVAILABLE', reason: 'DATABASE_AUTHENTICATION_FAILED',
  });
  const api = await request('/api/auth/me');
  assert.equal(api.status, 503);
  assert.deepEqual(await api.json(), {
    message: 'API is temporarily unavailable. Please try again later.', code: 'DATABASE_UNAVAILABLE',
  });
  assert.match(messages.join(' '), /DATABASE_AUTHENTICATION_FAILED/);
  for (const output of [JSON.stringify(body), messages.join(' ')]) {
    assert.ok(!output.includes(ENV.MONGO_URI));
    assert.ok(!output.includes(ENV.ADMIN_PASSWORD));
  }
});

test('concurrent cold requests share initialization and warm requests reuse the same app and connection', async t => {
  const connected = deferred();
  const store = fakeStore({ connect: () => connected.promise });
  let factories = 0;
  const runtime = createRuntime({ env: ENV, storeFactory: () => { factories++; return store; } });
  t.after(() => runtime.close());
  assert.equal(factories, 0);
  const first = runtime.getApp();
  const second = runtime.getApp();
  assert.equal(first, second);
  assert.equal(factories, 1);
  assert.equal(store.calls.connect, 1);
  assert.equal(store.calls.initialize, 0);
  connected.resolve();
  const [firstApp, secondApp] = await Promise.all([first, second]);
  assert.equal(firstApp, secondApp);
  assert.equal(await runtime.getApp(), firstApp);
  const request = await serve(t, runtime);
  const responses = await Promise.all([request('/health'), request('/api/health')]);
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, database: 'connected' });
  }
  assert.equal(factories, 1);
  assert.deepEqual(store.calls, { connect: 1, initialize: 1, close: 0 });
});

test('closing during initialization waits for ownership, closes once, and allows a later fresh runtime', async () => {
  const connected = deferred();
  const firstStore = fakeStore({ connect: () => connected.promise });
  const nextStore = fakeStore();
  const stores = [firstStore, nextStore];
  let factories = 0;
  const runtime = createRuntime({ env: ENV, storeFactory: () => stores[factories++] });
  const initializing = runtime.getApp();
  const closing = runtime.close();
  assert.equal(runtime.close(), closing);
  const later = runtime.getApp();
  assert.equal(firstStore.calls.close, 0);
  assert.equal(factories, 1);
  connected.resolve();
  await initializing;
  await closing;
  await later;
  assert.deepEqual(firstStore.calls, { connect: 1, initialize: 1, close: 1 });
  assert.deepEqual(nextStore.calls, { connect: 1, initialize: 1, close: 0 });
  assert.equal(runtime.store, nextStore);
  await runtime.close();
  assert.equal(nextStore.calls.close, 1);
  assert.equal(runtime.store, undefined);
});
