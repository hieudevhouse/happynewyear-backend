import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { MemoryStore } from '../src/memory-store.js';
import { publicPlayer, publicRedemption, WALLET_QR_WINDOW_MS } from '../src/domain.js';

const ORIGIN = 'http://localhost:5173';
const ADMIN = { username: 'payout-admin', password: 'payout-tests-password-only' };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==';

async function fixture(t, options = {}) {
  const store = new MemoryStore();
  await store.initialize({ ...ADMIN, prizes: [{ title: '50.000 đồng', sub: 'Lộc xuân', icon: '💰', color: '#ffcc44', amount: 50000 }] });
  let nextImage = 0;
  const uploader = options.realUploader ? undefined : options.uploader || (async (_image, { purpose }) => {
    const publicId = `lucky-money/qr/${purpose}/test-${++nextImage}`;
    return { publicId, url: `https://res.cloudinary.com/payout-tests/image/upload/v1/${publicId}.png` };
  });
  const server = createServer(createApp({ store, uploader, config: { clientOrigins: [ORIGIN], cloudinary: { cloudName: 'payout-tests', apiKey: '', apiSecret: '', folder: 'lucky-money/qr' }, ...options.config } }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, { cookie, method = 'GET', body } = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const login = await request('/api/auth/login', { method: 'POST', body: ADMIN });
  assert.equal(login.status, 200);
  const admin = login.cookie;
  const makePlayer = async (value, open = true) => {
    const [code] = await store.createCodes([value]);
    const started = await request('/api/player/start', { method: 'POST', body: { code: value } });
    assert.equal(started.status, 200);
    const cookie = started.cookie;
    await request('/api/player/name', { method: 'PATCH', cookie, body: { name: 'Người nhận' } });
    const opened = open ? await request('/api/player/envelopes/3/open', { method: 'POST', cookie, body: {} }) : null;
    if (open) assert.equal(opened.status, 200);
    return { id: code.id, cookie, opened, started };
  };
  const upload = async (cookie, role = 'player', image = PNG) => request(`/api/${role}/uploads/qr`, { method: 'POST', cookie, body: { image } });
  const save = async (cookie, body) => request('/api/player/redemption', { method: 'POST', cookie, body });
  return { request, store, admin, makePlayer, upload, save };
}

test('bank QR requests persist across sessions and appear in the admin winners list', async t => {
  const f = await fixture(t);
  const owner = await f.makePlayer('PAYOUT-BANK');
  const uploaded = await f.upload(owner.cookie);
  assert.equal(uploaded.status, 201);
  assert.deepEqual(Object.keys(uploaded.body), ['image']);
  const saved = await f.save(owner.cookie, { method: 'bank', recipientQr: uploaded.body.image });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.player.redemption.status, 'pending');
  assert.deepEqual(saved.body.player.redemption.recipientQr, uploaded.body.image);
  assert.equal(saved.body.player.rewards[0].prize.amount, 50000);
  const repeat = await f.save(owner.cookie, { method: 'bank', recipientQr: uploaded.body.image });
  assert.deepEqual(repeat.body, saved.body);
  const restored = await f.request('/api/player/session', { cookie: owner.cookie });
  assert.deepEqual(restored.body.player, saved.body.player);
  const winners = await f.request('/api/admin/winners', { cookie: f.admin });
  assert.equal(winners.body.items[0].codeId, owner.id);
  assert.deepEqual(winners.body.items[0].redemption, saved.body.player.redemption);
  const dashboard = await f.request('/api/admin/dashboard', { cookie: f.admin });
  assert.deepEqual(dashboard.body.recent[0].redemption, saved.body.player.redemption);
});

test('only owned opened codes can upload or select a payout and uploads cannot be forged or borrowed', async t => {
  const f = await fixture(t);
  assert.equal((await f.upload(undefined)).status, 401);
  assert.equal((await f.upload(undefined, 'admin')).status, 401);
  const waiting = await f.makePlayer('PAYOUT-WAIT', false);
  assert.equal((await f.upload(waiting.cookie)).status, 409);
  assert.equal((await f.save(waiting.cookie, { method: 'bank' })).status, 409);
  const a = await f.makePlayer('PAYOUT-OWNER-A');
  const b = await f.makePlayer('PAYOUT-OWNER-B');
  const uploaded = (await f.upload(a.cookie)).body.image;
  assert.equal((await f.save(b.cookie, { method: 'bank', recipientQr: uploaded })).status, 400);
  assert.equal((await f.save(a.cookie, { method: 'bank', recipientQr: { ...uploaded, url: 'https://attacker.invalid/qr.png' } })).status, 400);
  assert.equal((await f.save(a.cookie, { method: 'bank', recipientQr: { ...uploaded, publicId: 'lucky-money/qr/player/not-uploaded', url: 'https://res.cloudinary.com/payout-tests/image/upload/v1/lucky-money/qr/player/not-uploaded.png' } })).status, 400);
  assert.equal((await f.save(a.cookie, { method: 'cash' })).status, 400);
  assert.equal((await f.save(a.cookie, { method: 'bank' })).status, 400);
  assert.equal((await f.save(a.cookie, { method: 'momo' })).status, 409);
  const disabled = await f.request(`/api/admin/codes/${a.id}`, { method: 'PATCH', cookie: f.admin, body: { status: 'disabled' } });
  assert.equal(disabled.status, 200);
  assert.equal((await f.upload(a.cookie)).status, 403);
});

test('wallet gift QR configuration stays hidden until opening and updates live while reward amount stays fixed', async t => {
  const f = await fixture(t);
  const [prize] = await f.store.listPrizes();
  const momo = (await f.upload(f.admin, 'admin')).body.image;
  const zalopay = (await f.upload(f.admin, 'admin')).body.image;
  const set = await f.request(`/api/admin/prizes/${prize.id}`, { method: 'PATCH', cookie: f.admin, body: { payouts: { momo, zalopay } } });
  assert.equal(set.status, 200);
  const owner = await f.makePlayer('PAYOUT-WALLET', false);
  assert.equal(JSON.stringify(owner.started.body).includes(momo.url), false);
  assert.equal(JSON.stringify(owner.started.body).includes(zalopay.url), false);
  const opened = await f.request('/api/player/envelopes/3/open', { method: 'POST', cookie: owner.cookie, body: {} });
  assert.deepEqual(opened.body.reward.prize.payouts, { momo: null, zalopay: null });
  assert.deepEqual(opened.body.reward.prize.payoutMethods, ['momo', 'zalopay']);
  assert.equal(JSON.stringify(opened.body).includes(momo.url), false);
  assert.equal(JSON.stringify(opened.body).includes(zalopay.url), false);
  const chosen = await f.save(owner.cookie, { method: 'momo' });
  assert.equal(chosen.body.player.redemption.status, 'qr_ready');
  assert.equal(chosen.body.player.redemption.recipientQr, null);
  assert.equal(chosen.body.player.redemption.paidAt, undefined);
  assert.deepEqual(chosen.body.player.rewards[0].prize.payouts, { momo, zalopay: null });
  assert.equal(JSON.stringify(chosen.body).includes(zalopay.publicId), false);
  assert.equal((await f.save(owner.cookie, { method: 'zalopay' })).status, 409);
  assert.equal((await f.save(owner.cookie, { method: 'bank' })).status, 409);
  assert.equal((await f.upload(owner.cookie)).status, 409);
  const replacement = (await f.upload(f.admin, 'admin')).body.image;
  await f.request(`/api/admin/prizes/${prize.id}`, { method: 'PATCH', cookie: f.admin, body: { amount: 100000, payouts: { momo: replacement, zalopay: null } } });
  const restored = (await f.request('/api/player/session', { cookie: owner.cookie })).body.player;
  assert.equal(restored.rewards[0].prize.amount, 50000);
  assert.deepEqual(restored.rewards[0].prize.payouts, { momo: replacement, zalopay: null });
  assert.equal((await f.save(owner.cookie, { method: 'zalopay' })).status, 409);
  assert.equal((await f.save(owner.cookie, { method: 'momo' })).status, 200);
});

test('concurrent payout method choices commit exactly one method and never reveal unselected wallet QRs', async t => {
  const f = await fixture(t);
  const [prize] = await f.store.listPrizes();
  const momo = (await f.upload(f.admin, 'admin')).body.image;
  const zalopay = (await f.upload(f.admin, 'admin')).body.image;
  await f.request(`/api/admin/prizes/${prize.id}`, { method: 'PATCH', cookie: f.admin, body: { payouts: { momo, zalopay } } });
  const owner = await f.makePlayer('PAYOUT-RACE');
  const bank = (await f.upload(owner.cookie)).body.image;
  const results = await Promise.all([
    f.save(owner.cookie, { method: 'momo' }),
    f.save(owner.cookie, { method: 'zalopay' }),
    f.save(owner.cookie, { method: 'bank', recipientQr: bank }),
  ]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409, 409]);
  const committed = results.find(result => result.status === 200).body.player;
  for (const [method, image] of Object.entries({ momo, zalopay })) {
    assert.equal(JSON.stringify(committed).includes(image.publicId), committed.redemption.method === method);
  }
  const restored = (await f.request('/api/player/session', { cookie: owner.cookie })).body.player;
  assert.deepEqual(restored, committed);
  const another = await f.makePlayer('PAYOUT-BANK-CONFIDENTIAL');
  const otherBank = (await f.upload(another.cookie)).body.image;
  const bankChosen = await f.save(another.cookie, { method: 'bank', recipientQr: otherBank });
  assert.equal(bankChosen.status, 200);
  assert.deepEqual(bankChosen.body.player.rewards[0].prize.payouts, { momo: null, zalopay: null });
  assert.equal(JSON.stringify(bankChosen.body).includes(momo.publicId), false);
  assert.equal(JSON.stringify(bankChosen.body).includes(zalopay.publicId), false);
});

test('new gift QR configuration is available to previously opened rewards', async t => {
  const f = await fixture(t);
  const owner = await f.makePlayer('PAYOUT-NEW-CONFIG');
  assert.deepEqual(owner.opened.body.reward.prize.payouts, { momo: null, zalopay: null });
  const [prize] = await f.store.listPrizes();
  const momo = (await f.upload(f.admin, 'admin')).body.image;
  await f.request(`/api/admin/prizes/${prize.id}`, { method: 'PATCH', cookie: f.admin, body: { payouts: { momo } } });
  const chosen = await f.save(owner.cookie, { method: 'momo' });
  assert.equal(chosen.status, 200);
  assert.deepEqual(chosen.body.player.rewards[0].prize.payouts.momo, momo);
});

test('wallet QRs expire at exactly 72 hours after first reveal, with stable legacy selection dates', () => {
  const shownAt = new Date('2026-10-01T09:30:00.000Z');
  const deadline = shownAt.getTime() + WALLET_QR_WINDOW_MS;
  const image = { publicId: 'gift/momo', url: 'https://example.invalid/momo.png' };
  for (const method of ['momo', 'zalopay']) {
    // Legacy wallet records have requestedAt but not qrShownAt.
    const redemption = { method, status: 'qr_ready', requestedAt: shownAt, recipientQr: null };
    const code = { code: `DEADLINE-${method}`, ownerHash: 'owner', claimedAt: new Date('2020-01-01'), status: 'used', envelopes: [{ index: 0, number: 1, openedAt: new Date('2026-09-01'), prize: { id: 'gift', payouts: { [method]: image } } }], redemption };
    const active = publicPlayer(code, undefined, deadline - 1);
    assert.equal(active.redemption.qrShownAt, shownAt.toISOString());
    assert.equal(active.redemption.qrExpiresAt, new Date(deadline).toISOString());
    assert.equal(active.redemption.qrExpired, false);
    assert.deepEqual(active.rewards[0].prize.payouts[method], image);
    for (const time of [deadline, deadline + 1, deadline + WALLET_QR_WINDOW_MS]) {
      const expired = publicPlayer(code, undefined, time);
      assert.equal(expired.redemption.qrExpired, true);
      assert.equal(expired.redemption.qrShownAt, active.redemption.qrShownAt);
      assert.equal(expired.redemption.qrExpiresAt, active.redemption.qrExpiresAt);
      assert.deepEqual(expired.rewards[0].prize.payouts, { momo: null, zalopay: null });
      assert.equal(JSON.stringify(expired).includes(image.url), false);
      const liveImage = { publicId: 'gift/replacement', url: 'https://example.invalid/replacement.png' };
      const live = publicPlayer(code, [{ id: 'gift', payouts: { [method]: liveImage } }], time);
      assert.equal(JSON.stringify(live).includes(liveImage.url), false);
    }
    assert.equal(publicRedemption({ ...redemption, qrShownAt: new Date(shownAt.getTime() + 1000) }, deadline).qrExpired, false);
    assert.equal(publicRedemption({ method, status: 'qr_ready' }, deadline).qrExpired, true);
  }
  const bank = publicRedemption({ method: 'bank', status: 'pending', requestedAt: shownAt, recipientQr: image }, deadline * 2);
  assert.deepEqual(bank.recipientQr, image);
  assert.equal(bank.qrShownAt, undefined);
  assert.equal(bank.qrExpiresAt, undefined);
  assert.equal(bank.qrExpired, undefined);
});

test('wallet reveal deadline persists across racing requests, reloads and expired retries', async t => {
  const f = await fixture(t);
  const [prize] = await f.store.listPrizes();
  const momo = (await f.upload(f.admin, 'admin')).body.image;
  await f.request(`/api/admin/prizes/${prize.id}`, { method: 'PATCH', cookie: f.admin, body: { payouts: { momo } } });
  const owner = await f.makePlayer('PAYOUT-WALLET-DEADLINE');
  const record = f.store.codes.get(owner.id);
  record.claimedAt = new Date('2020-01-01');
  record.envelopes[3].openedAt = new Date('2020-01-02');
  const before = Date.now();
  const choices = await Promise.all([f.save(owner.cookie, { method: 'momo' }), f.save(owner.cookie, { method: 'momo' })]);
  for (const choice of choices) assert.equal(choice.status, 200);
  assert.deepEqual(choices[0].body, choices[1].body);
  const first = choices[0].body.player.redemption;
  assert.ok(new Date(first.qrShownAt).getTime() >= before);
  assert.equal(new Date(first.qrExpiresAt) - new Date(first.qrShownAt), WALLET_QR_WINDOW_MS);
  assert.equal(first.qrExpired, false);
  assert.ok(record.redemption.qrShownAt);
  const restored = await f.request('/api/player/session', { cookie: owner.cookie });
  assert.deepEqual(restored.body.player.redemption, first);

  // Advance this saved reveal rather than changing the process clock or session.
  const expiredAt = new Date(Date.now() - WALLET_QR_WINDOW_MS - 1000);
  Object.assign(record.redemption, { requestedAt: expiredAt, qrShownAt: expiredAt });
  const expiredDates = { qrShownAt: expiredAt.toISOString(), qrExpiresAt: new Date(expiredAt.getTime() + WALLET_QR_WINDOW_MS).toISOString() };
  const stillConfigured = await f.save(owner.cookie, { method: 'momo' });
  assert.equal(stillConfigured.status, 200);
  assert.equal(stillConfigured.body.player.redemption.qrExpired, true);
  assert.deepEqual(stillConfigured.body.player.rewards[0].prize.payouts, { momo: null, zalopay: null });
  assert.equal(JSON.stringify(stillConfigured.body).includes(momo.url), false);
  // Removing or replacing admin configuration must never restart the window.
  await f.request(`/api/admin/prizes/${prize.id}`, { method: 'PATCH', cookie: f.admin, body: { payouts: { momo: null } } });
  const responses = [
    await f.save(owner.cookie, { method: 'momo' }),
    await f.request('/api/player/session', { cookie: owner.cookie }),
    await f.request('/api/player/start', { method: 'POST', cookie: owner.cookie, body: { code: 'PAYOUT-WALLET-DEADLINE' } }),
    await f.request('/api/player/envelopes/3/open', { method: 'POST', cookie: owner.cookie, body: {} }),
  ];
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(response.body.player.redemption.qrExpired, true);
    for (const [key, value] of Object.entries(expiredDates)) assert.equal(response.body.player.redemption[key], value);
    assert.deepEqual(response.body.player.rewards[0].prize.payouts, { momo: null, zalopay: null });
    assert.equal(JSON.stringify(response.body).includes(momo.url), false);
  }
  assert.equal(record.redemption.qrShownAt.toISOString(), expiredAt.toISOString());
  const winners = (await f.request('/api/admin/winners', { cookie: f.admin })).body.items;
  assert.equal(winners[0].redemption.qrExpired, true);
  assert.equal(winners[0].redemption.qrShownAt, expiredDates.qrShownAt);
});

test('older code entry and envelope opening never expire bank upload, replacement or transfer confirmation', async t => {
  const f = await fixture(t);
  const owner = await f.makePlayer('PAYOUT-NO-BANK-DEADLINE', false);
  const record = f.store.codes.get(owner.id);
  record.claimedAt = new Date('2020-01-01');
  assert.equal((await f.request('/api/player/name', { method: 'PATCH', cookie: owner.cookie, body: { name: 'Updated before opening' } })).status, 200);
  assert.equal((await f.request('/api/player/envelopes/3/open', { method: 'POST', cookie: owner.cookie, body: {} })).status, 200);
  record.envelopes[3].openedAt = new Date('2020-01-02');
  const first = await f.upload(owner.cookie);
  assert.equal(first.status, 201);
  assert.equal((await f.save(owner.cookie, { method: 'bank', recipientQr: first.body.image })).status, 200);
  record.redemption.requestedAt = new Date('2020-01-03');
  const restored = (await f.request('/api/player/session', { cookie: owner.cookie })).body.player;
  assert.deepEqual(restored.redemption.recipientQr, first.body.image);
  assert.equal(restored.redemption.qrExpiresAt, undefined);
  assert.equal(restored.claimExpiresAt, undefined);
  const replacement = await f.upload(owner.cookie);
  assert.equal(replacement.status, 201);
  const updated = await f.save(owner.cookie, { method: 'bank', recipientQr: replacement.body.image });
  assert.equal(updated.status, 200);
  const paid = await f.request(`/api/admin/codes/${owner.id}/redemption`, { method: 'PATCH', cookie: f.admin, body: { status: 'paid', expectedQrPublicId: replacement.body.image.publicId } });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.item.redemption.status, 'paid');
  assert.equal(paid.body.item.redemption.qrExpired, undefined);
});

test('bank transfer confirmation is atomic, checks the QR being paid, and preserves one prize', async t => {
  const f = await fixture(t);
  const owner = await f.makePlayer('PAYOUT-PAID');
  const first = (await f.upload(owner.cookie)).body.image;
  await f.save(owner.cookie, { method: 'bank', recipientQr: first });
  const second = (await f.upload(owner.cookie)).body.image;
  await f.save(owner.cookie, { method: 'bank', recipientQr: second });
  const mark = expectedQrPublicId => f.request(`/api/admin/codes/${owner.id}/redemption`, { method: 'PATCH', cookie: f.admin, body: { status: 'paid', expectedQrPublicId } });
  assert.equal((await mark(first.publicId)).status, 409);
  const [a, b] = await Promise.all([mark(second.publicId), mark(second.publicId)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(a.body, b.body);
  assert.equal(a.body.item.redemption.status, 'paid');
  assert.ok(a.body.item.redemption.paidAt);
  assert.equal((await f.save(owner.cookie, { method: 'bank', recipientQr: first })).status, 409);
  assert.equal((await f.save(owner.cookie, { method: 'momo' })).status, 409);
  assert.equal((await f.save(owner.cookie, { method: 'bank', recipientQr: second })).body.player.redemption.status, 'paid');
  assert.equal((await f.upload(owner.cookie)).status, 409);
  assert.equal((await f.request('/api/player/envelopes/4/open', { method: 'POST', cookie: owner.cookie, body: {} })).status, 409);
  assert.equal((await f.store.getCodeById(owner.id)).openedCount, 1);
  await f.request(`/api/admin/codes/${owner.id}`, { method: 'PATCH', cookie: f.admin, body: { status: 'available' } });
  assert.equal((await f.store.getCodeById(owner.id)).status, 'used');
});

test('QR uploads validate actual file content, size, rate limits and preserve normal API body limits', async t => {
  const f = await fixture(t, { config: { uploadLimit: 3 } });
  assert.equal((await f.upload(f.admin, 'admin', 'data:image/png;base64,PHNjcmlwdD48L3NjcmlwdD4=')).status, 400);
  assert.equal((await f.upload(f.admin, 'admin', 'data:image/svg+xml;base64,PHN2Zz4=')).status, 400);
  assert.equal((await f.upload(f.admin, 'admin')).status, 201);
  assert.equal((await f.upload(f.admin, 'admin')).status, 429);
  const bytes = Buffer.alloc(6 * 1024 * 1024);
  Buffer.from(PNG.split(',')[1], 'base64').copy(bytes);
  const largeImage = `data:image/png;base64,${bytes.toString('base64')}`;
  const g = await fixture(t);
  assert.equal((await g.upload(g.admin, 'admin', largeImage)).status, 201);
  assert.equal((await g.request('/api/admin/prizes', { method: 'POST', cookie: g.admin, body: { title: 'A'.repeat(20000) } })).status, 413);
});

test('admin prize settings accept only valid integer amounts and registered admin gift QR images', async t => {
  const f = await fixture(t);
  const [prize] = await f.store.listPrizes();
  const update = body => f.request(`/api/admin/prizes/${prize.id}`, { method: 'PATCH', cookie: f.admin, body });
  for (const amount of [-1, 1.5, '10000', 1000000001]) assert.equal((await update({ amount })).status, 400);
  assert.equal((await update({ payouts: { bank: null } })).status, 400);
  const owner = await f.makePlayer('PAYOUT-WRONG-PURPOSE');
  const bank = (await f.upload(owner.cookie)).body.image;
  assert.equal((await update({ payouts: { momo: bank } })).status, 400);
  const gift = (await f.upload(f.admin, 'admin')).body.image;
  assert.equal((await f.save(owner.cookie, { method: 'bank', recipientQr: gift })).status, 400);
  assert.equal((await update({ amount: 100000, payouts: { momo: gift } })).status, 200);
});

test('missing Cloudinary credentials return a descriptive safe 503', async t => {
  const f = await fixture(t, { realUploader: true });
  const result = await f.upload(f.admin, 'admin');
  assert.equal(result.status, 503);
  assert.match(result.body.message, /CLOUDINARY_API_KEY/);
});

test('bank QR upload returns the safe actionable provider code without recording a failed image', async t => {
  const message = 'Cloudinary từ chối ảnh vì vượt giới hạn dung lượng của tài khoản.';
  const f = await fixture(t, { uploader: async () => {
    throw Object.assign(new Error(message), { status: 413, expose: true, publicCode: 'QR_UPLOAD_SIZE' });
  } });
  const owner = await f.makePlayer('PAYOUT-UPLOAD-ERROR');
  const result = await f.upload(owner.cookie);
  assert.equal(result.status, 413);
  assert.deepEqual(result.body, { message, code: 'QR_UPLOAD_SIZE' });
  const player = (await f.request('/api/player/session', { cookie: owner.cookie })).body.player;
  assert.equal(player.redemption, null);
  assert.equal(player.rewards.length, 1);
});
