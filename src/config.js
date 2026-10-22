const SAME_SITES = new Set(['lax', 'strict', 'none']);
const PRODUCTION_FRONTEND_ORIGIN = 'https://happynewyear-six-bay.vercel.app';

export function sessionConfig(config = {}) {
  const cookieSameSite = config.cookieSameSite ?? 'lax';
  const cookieSecure = config.cookieSecure ?? Boolean(config.production);
  const trustProxy = config.trustProxy ?? 0;
  if (!SAME_SITES.has(cookieSameSite)) throw new Error('COOKIE_SAME_SITE must be lax, strict, or none.');
  if (typeof cookieSecure !== 'boolean') throw new Error('COOKIE_SECURE must be true or false.');
  if (cookieSameSite === 'none' && !cookieSecure) throw new Error('COOKIE_SAME_SITE=none requires COOKIE_SECURE=true and HTTPS.');
  if (!Number.isSafeInteger(trustProxy) || trustProxy < 0) throw new Error('TRUST_PROXY must be a non-negative integer hop count.');
  return { cookieSameSite, cookieSecure, trustProxy };
}

export function configFromEnv(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const secureValue = env.COOKIE_SECURE?.trim();
  if (secureValue && !['true', 'false'].includes(secureValue)) throw new Error('COOKIE_SECURE must be true or false.');
  const proxyValue = env.TRUST_PROXY?.trim() || '0';
  if (!/^\d+$/.test(proxyValue)) throw new Error('TRUST_PROXY must be a non-negative integer hop count.');
  const security = sessionConfig({
    production,
    cookieSameSite: env.COOKIE_SAME_SITE?.trim() || 'lax',
    cookieSecure: secureValue ? secureValue === 'true' : production,
    trustProxy: Number(proxyValue),
  });
  const clientOrigins = (env.CLIENT_ORIGIN || 'http://localhost:5173').split(',').map(value => value.trim()).filter(Boolean);
  for (const origin of clientOrigins) {
    let url;
    try { url = new URL(origin); } catch { throw new Error('CLIENT_ORIGIN must contain comma-separated HTTP(S) origins.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) throw new Error('CLIENT_ORIGIN must contain HTTP(S) origins without paths or trailing slashes.');
  }
  if (production) clientOrigins.push(PRODUCTION_FRONTEND_ORIGIN);
  return {
    production,
    ...security,
    clientOrigins: [...new Set(clientOrigins)],
    sessionDays: 30,
    cloudinary: {
      cloudName: env.CLOUDINARY_CLOUD_NAME,
      apiKey: env.CLOUDINARY_API_KEY,
      apiSecret: env.CLOUDINARY_API_SECRET,
      folder: env.CLOUDINARY_FOLDER || 'lucky-money/qr',
    },
  };
}
