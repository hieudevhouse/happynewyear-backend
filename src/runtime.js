import { createApp } from './app.js';
import { configFromEnv } from './config.js';
import { MongoStore } from './mongo-store.js';
import { PRIZES } from './prizes.js';

const unavailableMessage = 'API is temporarily unavailable. Please try again later.';

// Keep the initialized application and connection for subsequent warm invocations.
// Creating a runtime does not read local env files, open a socket, or connect to MongoDB.
export function createRuntime({ env = process.env, storeFactory = () => new MongoStore(), logger = console, appFactory = createApp } = {}) {
  let app;
  let store;
  let initialization;
  let closing;

  const initialize = async () => {
    let candidateStore;
    let code = 'API_CONFIGURATION_ERROR';
    let message = 'API configuration is invalid. Check CLIENT_ORIGIN, COOKIE_SECURE, COOKIE_SAME_SITE, and TRUST_PROXY.';
    try {
      const invalid = [];
      if (!env.MONGO_URI?.trim()) invalid.push('MONGO_URI');
      if (!env.ADMIN_USERNAME?.trim()) invalid.push('ADMIN_USERNAME');
      if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 12) invalid.push('ADMIN_PASSWORD');
      if (invalid.length) {
        message = `API configuration is invalid. Set valid values for: ${invalid.join(', ')}.`;
        throw new Error();
      }
      const config = configFromEnv(env);
      code = 'DATABASE_UNAVAILABLE';
      message = 'MongoDB connection failed. Check MONGO_URI and MongoDB network access.';
      candidateStore = storeFactory();
      await candidateStore.connect(env.MONGO_URI);
      message = 'MongoDB initialization failed. Check database permissions and administrator configuration.';
      await candidateStore.initialize({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD, prizes: PRIZES });
      code = 'API_INITIALIZATION_ERROR';
      message = 'API initialization failed. Check backend configuration.';
      const candidateApp = appFactory({ store: candidateStore, config });
      store = candidateStore;
      app = candidateApp;
      return app;
    } catch {
      // Driver errors can contain the URI and credentials. Only log our fixed messages.
      if (candidateStore) {
        try { await candidateStore.close(); }
        catch { logger.error('MongoDB cleanup failed after API initialization.'); }
      }
      logger.error(message);
      throw Object.assign(new Error(message), { code });
    }
  };

  const getApp = () => {
    if (closing) return closing.then(getApp);
    if (app) return Promise.resolve(app);
    if (!initialization) {
      initialization = initialize().catch(error => {
        initialization = undefined;
        throw error;
      });
    }
    return initialization;
  };

  const handle = (req, res, next) => {
    getApp().then(currentApp => currentApp(req, res, next)).catch(error => {
      if (res.headersSent) return next(error);
      res.setHeader('Cache-Control', 'no-store');
      const code = ['API_CONFIGURATION_ERROR', 'DATABASE_UNAVAILABLE', 'API_INITIALIZATION_ERROR'].includes(error.code)
        ? error.code : 'API_INITIALIZATION_ERROR';
      const health = ['/health', '/api/health'].includes(req.path.replace(/\/$/, ''));
      res.status(503).json(health ? { ok: false, database: 'unavailable', code } : { message: unavailableMessage, code });
    });
  };

  const close = () => {
    if (!closing) {
      closing = (async () => {
        // If shutdown starts during a cold request, wait until its connection is owned.
        if (initialization) {
          try { await initialization; } catch { /* Failed initialization already cleaned up. */ }
        }
        const currentStore = store;
        app = undefined;
        store = undefined;
        initialization = undefined;
        if (currentStore) await currentStore.close();
      })().finally(() => { closing = undefined; });
    }
    return closing;
  };

  return { getApp, handle, close, get store() { return store; } };
}
