import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import express from 'express';
import { createRuntime } from './src/runtime.js';

export { createApp } from './src/app.js';

const runtime = createRuntime();
const handler = express();
handler.disable('x-powered-by');
handler.use(runtime.handle);

// Vercel imports this synchronous Express app without starting an HTTP listener.
export default handler;

export async function startServer() {
  const envPath = fileURLToPath(new URL('./.env', import.meta.url));
  if (existsSync(envPath)) process.loadEnvFile(envPath);
  const app = await runtime.getApp();
  const port = Number(process.env.PORT || 4000);
  const server = app.listen(port, '0.0.0.0', () => console.log(`LuckyMoney API listening on port ${port}`));
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    server.close(async () => { await runtime.close(); process.exit(0); });
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
  return { app, server, store: runtime.store };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch(() => {
    // Connection errors may contain database credentials. Do not log the raw exception.
    console.error('API startup failed. Check backend/.env: MongoDB, administrator, origin, cookie, and proxy configuration.');
    process.exitCode = 1;
  });
}
