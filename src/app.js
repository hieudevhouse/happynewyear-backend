import express from 'express';
import { randomBytes } from 'node:crypto';
import { checkPassword, cookies, hashPassword, hashToken, newToken } from './security.js';
import { createEnvelopes, effectiveStatus, ENVELOPE_COUNT, firstReward, hasReward, pageParams, publicCode, publicPlayer, publicPrize } from './domain.js';
import { createCloudinaryUploader, decodeQrImage, isCloudinaryQr } from './cloudinary.js';
import { sessionConfig } from './config.js';

const route = callback => (req, res, next) => Promise.resolve(callback(req, res, next)).catch(next);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const cleanText = (value, max, required = false) => {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) fail(400, 'Thông tin không hợp lệ.');
  const text = value.trim();
  if (required && !text) fail(400, 'Vui lòng điền đầy đủ thông tin.');
  return text;
};
const normalizeCode = value => {
  const code = cleanText(value, 40, true).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{2,39}$/.test(code)) fail(400, 'Mã chỉ gồm 3–40 chữ cái, chữ số và dấu gạch ngang.');
  return code;
};
const publicAdmin = admin => ({ id: String(admin.id || admin._id), username: admin.username });
const prizeOutput = prize => ({ ...publicPrize(prize), weight: prize.weight, active: prize.active });

export function createApp({ store, config = {}, uploader }) {
  if (!store) throw new Error('A persistent store (or explicit test store) is required.');
  const app = express();
  app.disable('x-powered-by');
  const { cookieSecure, cookieSameSite, trustProxy } = sessionConfig(config);
  app.set('trust proxy', trustProxy);
  const origins = new Set(config.clientOrigins || ['http://localhost:5173']);
  const sessionDays = config.sessionDays || 30;
  const adminCookie = 'lm_admin';
  const playerCookie = 'lm_player';
  const cookieOptions = { httpOnly: true, secure: cookieSecure, sameSite: cookieSameSite, path: '/' };
  // A real hash also keeps unknown-account login checks comparable to valid users.
  const dummyPasswordHash = hashPassword(newToken());
  const loginAttempts = new Map();
  const playerAttempts = new Map();
  const uploadAttempts = new Map();
  const redemptionAttempts = new Map();
  const cloudinaryConfig = { cloudName: process.env.CLOUDINARY_CLOUD_NAME, folder: process.env.CLOUDINARY_FOLDER || 'lucky-money/qr', ...config.cloudinary };
  const uploadQr = uploader || createCloudinaryUploader(cloudinaryConfig);
  const limited = (bucket, key, max, windowMs) => {
    const now = Date.now();
    if (bucket.size > 2000) for (const [entry, state] of bucket) if (state.reset <= now) bucket.delete(entry);
    const previous = bucket.get(key);
    const state = previous && previous.reset > now ? previous : { count: 0, reset: now + windowMs };
    state.count++;
    bucket.set(key, state);
    if (state.count > max) fail(429, 'Bạn đã thử quá nhiều lần. Vui lòng thử lại sau ít phút.');
  };
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    res.vary('Origin');
    if (origin) {
      if (!origins.has(origin)) return res.status(403).json({ message: 'Nguồn truy cập không được cho phép.' });
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Expose-Headers', 'Date');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      return res.sendStatus(204);
    }
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (!origin && req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ message: 'Nguồn truy cập không được cho phép.' });
      if (!req.is('application/json')) return res.status(415).json({ message: 'Yêu cầu phải dùng application/json.' });
    }
    next();
  });
  const normalJson = express.json({ limit: '16kb', strict: true });
  // A 50 MiB image becomes about 67 MiB when sent as a Base64 data URI.
  const uploadJson = express.json({ limit: '70mb', strict: true });
  app.use((req, res, next) => (req.method === 'POST' && /^\/api\/(admin|player)\/uploads\/qr\/?$/.test(req.path) ? uploadJson : normalJson)(req, res, next));
  app.get(['/health', '/api/health'], (_, res) => {
    const ready = store.isReady();
    res.setHeader('Cache-Control', 'no-store');
    res.status(ready ? 200 : 503).json({ ok: ready, database: ready ? 'connected' : 'unavailable' });
  });
  app.use('/api', (req, res, next) => store.isReady() ? next() : res.status(503).json({ message: 'Cơ sở dữ liệu chưa sẵn sàng. Vui lòng thử lại sau.' }));
  const readSession = async (req, name, kind) => {
    const token = cookies(req)[name];
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const hash = hashToken(token);
    const session = await store.getSession(hash, kind);
    return session ? { ...session, hash } : null;
  };
  const issueSession = async (res, name, kind, extra = {}) => {
    const token = newToken();
    const hash = hashToken(token);
    const maxAge = (kind === 'admin' ? 12 * 3600000 : sessionDays * 86400000);
    await store.createSession({ hash, kind, expiresAt: new Date(Date.now() + maxAge), ...extra });
    res.cookie(name, token, { ...cookieOptions, maxAge });
    return { hash, kind, ...extra };
  };
  const adminOnly = route(async (req, _, next) => {
    const session = await readSession(req, adminCookie, 'admin');
    const admin = session && await store.getAdmin(session.adminId);
    if (!admin) fail(401, 'Vui lòng đăng nhập quản trị.');
    req.admin = admin;
    next();
  });
  const ownedPlayer = async req => {
    const session = await readSession(req, playerCookie, 'player');
    if (!session) fail(401, 'Vui lòng nhập mã lì xì để bắt đầu.');
    const code = await store.getPlayerCode(session.hash);
    if (!code) fail(401, 'Phiên nhận lì xì không còn hợp lệ.');
    if (code.status === 'disabled') fail(403, 'Mã lì xì đã bị tạm khóa.');
    return { session, code };
  };
  // Reveal gift QR configuration only for the reward the player has already opened.
  // Reading the live prize also lets an admin add or replace its QR after a claim.
  const playerOutput = async code => publicPlayer(code, await store.listPrizes());
  const requireReward = code => { if (!firstReward(code)) fail(409, 'Vui lòng mở lì xì trước khi chọn cách nhận tiền.'); };
  const uploadedImage = async (value, purpose, ownerId) => {
    if (!isCloudinaryQr(value, cloudinaryConfig)) fail(400, 'Vui lòng tải ảnh QR lên bằng nút tải ảnh.');
    const upload = await store.getQrUpload(value.publicId);
    if (!upload || upload.url !== value.url || upload.purpose !== purpose || (purpose === 'player' && upload.ownerId !== String(ownerId))) fail(400, 'Ảnh QR chưa được tải lên trong phiên nhận lì xì này.');
    return { url: upload.url, publicId: upload.publicId };
  };
  const uploadImage = async (req, res, purpose, ownerId) => {
    limited(uploadAttempts, `${purpose}:${ownerId}`, config.uploadLimit || 10, 15 * 60000);
    limited(uploadAttempts, `ip:${req.ip}`, 40, 15 * 60000);
    const decodedImage = decodeQrImage(req.body.image);
    const image = await uploadQr(req.body.image, { purpose, ownerId: String(ownerId), decodedImage });
    if (!isCloudinaryQr(image, cloudinaryConfig)) throw Object.assign(new Error('Cloudinary trả về ảnh QR không hợp lệ.'), { status: 502, expose: true });
    await store.registerQrUpload({ url: image.url, publicId: image.publicId, purpose, ownerId: String(ownerId) });
    res.status(201).json({ image: { url: image.url, publicId: image.publicId } });
  };

  app.post('/api/auth/login', route(async (req, res) => {
    limited(loginAttempts, req.ip, config.loginLimit || 8, 15 * 60000);
    const username = cleanText(req.body.username, 80, true);
    const password = req.body.password;
    if (typeof password !== 'string' || !password.length || password.length > 256) fail(400, 'Vui lòng nhập mật khẩu hợp lệ.');
    const admin = await store.findAdmin(username);
    const valid = await checkPassword(password, admin?.passwordHash || await dummyPasswordHash);
    if (!admin || !valid) fail(401, 'Tên đăng nhập hoặc mật khẩu không đúng.');
    const previous = await readSession(req, adminCookie, 'admin');
    if (previous) await store.deleteSession(previous.hash);
    await issueSession(res, adminCookie, 'admin', { adminId: admin.id || String(admin._id) });
    res.json({ admin: publicAdmin(admin) });
  }));
  app.get('/api/auth/me', adminOnly, (req, res) => res.json({ admin: publicAdmin(req.admin) }));
  app.post('/api/auth/logout', route(async (req, res) => {
    const session = await readSession(req, adminCookie, 'admin');
    if (session) await store.deleteSession(session.hash);
    res.clearCookie(adminCookie, cookieOptions);
    res.json({ ok: true });
  }));
  app.get('/api/player/session', route(async (req, res) => {
    const session = await readSession(req, playerCookie, 'player');
    const code = session && await store.getPlayerCode(session.hash);
    if (code?.status === 'disabled') fail(403, 'Mã lì xì đã bị tạm khóa.');
    res.json({ player: code ? await playerOutput(code) : null });
  }));
  app.post('/api/player/start', route(async (req, res) => {
    limited(playerAttempts, req.ip, 60, 60000);
    const codeValue = normalizeCode(req.body.code);
    let code = await store.getCode(codeValue);
    if (!code || code.status === 'disabled') fail(404, 'Mã lì xì không hợp lệ hoặc đã bị khóa.');
    let session = await readSession(req, playerCookie, 'player');
    if (code.ownerHash) {
      if (code.ownerHash !== session?.hash) fail(409, 'Mã lì xì đã được sử dụng trên một phiên khác.');
    } else {
      if (effectiveStatus(code) !== 'available') fail(409, 'Mã lì xì đã được sử dụng.');
      const envelopes = createEnvelopes(await store.listPrizes());
      if (!session) session = await issueSession(res, playerCookie, 'player');
      const claimed = await store.claimCode(codeValue, session.hash, envelopes);
      code = claimed || await store.getCode(codeValue);
      if (code?.ownerHash !== session.hash) fail(409, 'Mã lì xì vừa được sử dụng trên một phiên khác.');
    }
    await store.selectPlayerCode(session.hash, code.id);
    res.json({ player: await playerOutput(code) });
  }));
  app.patch('/api/player/name', route(async (req, res) => {
    const name = cleanText(req.body.name, 80, true).replace(/\s+/g, ' ');
    const { session, code } = await ownedPlayer(req);
    if (hasReward(code) && code.name !== name) fail(409, 'Không thể đổi tên sau khi đã mở lì xì.');
    const updated = code.name === name ? code : await store.setPlayerName(code.id, session.hash, name);
    if (!updated) fail(409, 'Phiên nhận lì xì đã thay đổi. Vui lòng tải lại.');
    res.json({ player: await playerOutput(updated) });
  }));
  app.post('/api/player/envelopes/:index/open', route(async (req, res) => {
    if (!/^\d{1,2}$/.test(req.params.index)) fail(400, 'Bao lì xì không hợp lệ.');
    const index = Number(req.params.index);
    if (index < 0 || index >= ENVELOPE_COUNT) fail(400, 'Bao lì xì không hợp lệ.');
    const { session, code } = await ownedPlayer(req);
    let current = code;
    if (!hasReward(code)) {
      if (!code.name) fail(400, 'Vui lòng nhập họ tên trước khi mở lì xì.');
      current = await store.openEnvelope(code.id, session.hash, index) || await store.getCodeById(code.id);
      if (!current || current.status === 'disabled') fail(403, 'Mã lì xì đã bị tạm khóa.');
    }
    const player = await playerOutput(current);
    const reward = player.rewards[0];
    if (reward?.index === index) return res.json({ player, reward });
    return res.status(409).json({ message: hasReward(current) ? 'Mỗi mã chỉ được nhận một phần quà. Mã lì xì này đã nhận lộc.' : 'Không thể mở bao lì xì. Vui lòng thử lại.', player });
  }));
  app.post('/api/player/uploads/qr', route(async (req, res) => {
    const { code } = await ownedPlayer(req);
    requireReward(code);
    if (code.redemption?.status === 'paid') fail(409, 'Lì xì đã được chuyển tiền, không thể đổi mã QR.');
    if (code.redemption && code.redemption.method !== 'bank') fail(409, 'Bạn đã chọn nhận lì xì qua ví điện tử. Không thể tải QR ngân hàng cho mã này.');
    await uploadImage(req, res, 'player', code.id);
  }));
  app.post('/api/player/redemption', route(async (req, res) => {
    const { session, code } = await ownedPlayer(req);
    requireReward(code);
    limited(redemptionAttempts, session.hash, 60, 60000);
    const { method } = req.body;
    if (!['momo', 'zalopay', 'bank'].includes(method)) fail(400, 'Vui lòng chọn MoMo, ZaloPay hoặc tải QR ngân hàng.');
    if (code.redemption && code.redemption.method !== method) fail(409, 'Bạn đã chọn cách nhận lì xì. Không thể đổi sang cách nhận khác.');
    const recipientQr = method === 'bank' ? await uploadedImage(req.body.recipientQr, 'player', code.id) : null;
    const same = value => value?.method === method && (value.recipientQr?.url || null) === (recipientQr?.url || null) && (value.recipientQr?.publicId || null) === (recipientQr?.publicId || null);
    if (code.redemption?.status === 'paid') {
      if (!same(code.redemption)) fail(409, 'Lì xì đã được chuyển tiền, không thể thay đổi cách nhận.');
      return res.json({ player: await playerOutput(code) });
    }
    // Returning a committed wallet is idempotent even after its QR expired or
    // the admin removed it. publicPlayer enforces the original reveal deadline.
    if (same(code.redemption)) return res.json({ player: await playerOutput(code) });
    if (method !== 'bank') {
      const reward = firstReward(code);
      const prize = (await store.listPrizes()).find(item => String(item.id || item._id) === String(reward.prize.id || reward.prize._id));
      if (!prize?.payouts?.[method]?.url) fail(409, `Chưa có QR quà tặng ${method === 'momo' ? 'MoMo' : 'ZaloPay'} cho phần lì xì này. Vui lòng chọn cách nhận khác.`);
    }
    const requestedAt = new Date();
    const redemption = { method, recipientQr, status: method === 'bank' ? 'pending' : 'qr_ready', requestedAt, ...(method !== 'bank' ? { qrShownAt: requestedAt } : {}) };
    let current = await store.saveRedemption(code.id, session.hash, redemption);
    if (!current) {
      current = await store.getCodeById(code.id);
      if (!current || current.ownerHash !== session.hash || current.status === 'disabled' || !same(current.redemption)) fail(409, 'Cách nhận lì xì đã thay đổi. Vui lòng tải lại trang.');
    }
    res.json({ player: await playerOutput(current) });
  }));
  app.post('/api/codes/validate', route(async (req, res) => {
    limited(playerAttempts, req.ip, 60, 60000);
    const code = normalizeCode(req.body.code);
    const record = await store.getCode(code);
    res.json({ valid: Boolean(record && effectiveStatus(record) === 'available' && !record.ownerHash), code });
  }));

  app.use('/api/admin', adminOnly);
  app.post('/api/admin/uploads/qr', route(async (req, res) => uploadImage(req, res, 'admin', req.admin.id || req.admin._id)));
  app.get('/api/admin/dashboard', route(async (_, res) => res.json(await store.dashboard())));
  app.get('/api/admin/codes', route(async (req, res) => res.json(await store.listCodes(pageParams(req.query)))));
  app.post('/api/admin/codes', route(async (req, res) => {
    const hasCode = typeof req.body.code === 'string' && req.body.code.trim();
    const quantity = req.body.quantity === undefined ? 1 : req.body.quantity;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 500 || (hasCode && quantity !== 1)) fail(400, 'Số lượng mã phải từ 1 đến 500; mã tùy chỉnh chỉ tạo một lần.');
    const codes = hasCode ? [normalizeCode(req.body.code)] : Array.from({ length: quantity }, () => `LM-2027-${randomBytes(5).toString('hex').toUpperCase()}`);
    const items = await store.createCodes(codes);
    res.status(201).json({ items: items.map(publicCode) });
  }));
  app.patch('/api/admin/codes/:id', route(async (req, res) => {
    if (!['disabled', 'available'].includes(req.body.status)) fail(400, 'Trạng thái không hợp lệ.');
    const code = await store.setCodeStatus(req.params.id, req.body.status);
    if (!code) fail(404, 'Không tìm thấy mã lì xì.');
    res.json({ item: publicCode(code) });
  }));
  app.patch('/api/admin/codes/:id/redemption', route(async (req, res) => {
    if (req.body.status !== 'paid') fail(400, 'Chỉ có thể xác nhận đã chuyển tiền.');
    const expectedQrPublicId = cleanText(req.body.expectedQrPublicId, 300, true);
    const current = await store.getCodeById(req.params.id);
    if (!current) fail(404, 'Không tìm thấy mã lì xì.');
    const code = await store.markRedemptionPaid(req.params.id, expectedQrPublicId);
    if (!code) fail(409, 'QR nhận tiền đã thay đổi hoặc yêu cầu không còn chờ chuyển tiền. Vui lòng tải lại danh sách.');
    res.json({ item: publicCode(code) });
  }));
  app.delete('/api/admin/codes/:id', route(async (req, res) => {
    const code = await store.getCodeById(req.params.id);
    if (!code) fail(404, 'Không tìm thấy mã lì xì.');
    if (!await store.deleteUnusedCode(req.params.id)) fail(409, 'Không thể xóa mã đã có người nhận.');
    res.json({ ok: true });
  }));
  app.get('/api/admin/winners', route(async (req, res) => res.json(await store.listWinners(pageParams(req.query)))));
  app.get('/api/admin/prizes', route(async (_, res) => res.json({ items: (await store.listPrizes()).map(prizeOutput) })));
  const validatePrize = async (body, partial = false) => {
    const result = {};
    for (const [field, max, required] of [['title', 100, true], ['sub', 200, false], ['icon', 16, true], ['color', 7, true]]) {
      if (partial && body[field] === undefined) continue;
      result[field] = cleanText(body[field] ?? (required ? undefined : ''), max, required);
    }
    if (result.color !== undefined && !/^#[0-9a-f]{6}$/i.test(result.color)) fail(400, 'Màu phần thưởng phải có dạng #rrggbb.');
    if (body.weight !== undefined || !partial) {
      result.weight = body.weight ?? 1;
      if (!Number.isInteger(result.weight) || result.weight < 1 || result.weight > 10000) fail(400, 'Trọng số phải là số nguyên từ 1 đến 10000.');
    }
    if (body.active !== undefined || !partial) {
      result.active = body.active ?? true;
      if (typeof result.active !== 'boolean') fail(400, 'Trạng thái phần thưởng không hợp lệ.');
    }
    if (body.amount !== undefined || !partial) {
      result.amount = body.amount ?? 0;
      if (!Number.isSafeInteger(result.amount) || result.amount < 0 || result.amount > 1000000000) fail(400, 'Số tiền lì xì phải là số nguyên từ 0 đến 1.000.000.000 đồng.');
    }
    if (body.payouts !== undefined || !partial) {
      const payouts = body.payouts ?? {};
      if (!payouts || typeof payouts !== 'object' || Array.isArray(payouts) || Object.keys(payouts).some(key => !['momo', 'zalopay'].includes(key))) fail(400, 'Chỉ hỗ trợ QR quà tặng MoMo và ZaloPay.');
      result.payouts = { momo: null, zalopay: null };
      for (const method of ['momo', 'zalopay']) if (payouts[method] != null) result.payouts[method] = await uploadedImage(payouts[method], 'admin');
    }
    if (!Object.keys(result).length) fail(400, 'Không có thông tin cần cập nhật.');
    return result;
  };
  app.post('/api/admin/prizes', route(async (req, res) => res.status(201).json({ item: prizeOutput(await store.createPrize(await validatePrize(req.body))) })));
  app.patch('/api/admin/prizes/:id', route(async (req, res) => {
    const prize = await store.updatePrize(req.params.id, await validatePrize(req.body, true));
    if (!prize) fail(404, 'Không tìm thấy phần thưởng.');
    res.json({ item: prizeOutput(prize) });
  }));
  app.use('/api', (_, res) => res.status(404).json({ message: 'API không tồn tại.' }));
  app.use((_, res) => res.status(404).json({ message: 'API không tồn tại.' }));
  app.use((error, _, res, next) => {
    if (res.headersSent) return next(error);
    if (error.code === 11000) return res.status(409).json({ message: 'Mã hoặc tài khoản đã tồn tại.' });
    if (error.type === 'entity.too.large') return res.status(413).json({ message: 'Nội dung gửi lên quá lớn.' });
    if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ message: 'Dữ liệu JSON không hợp lệ.' });
    if (error.status && (error.status < 500 || error.expose === true)) return res.status(error.status).json({ message: error.message, ...(error.expose === true && /^QR_UPLOAD_[A-Z_]+$/.test(error.publicCode || '') ? { code: error.publicCode } : {}) });
    if (!store.isReady() || /Mongo|Mongoose/.test(error.name)) return res.status(503).json({ message: 'Cơ sở dữ liệu chưa sẵn sàng. Vui lòng thử lại sau.' });
    res.status(500).json({ message: 'Không thể xử lý yêu cầu. Vui lòng thử lại.' });
  });
  return app;
}
