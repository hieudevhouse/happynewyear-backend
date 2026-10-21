import { randomInt } from 'node:crypto';

export const ENVELOPE_COUNT = 16;
export const REWARD_LIMIT = 1;
export const WALLET_QR_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const timestamp = value => {
  if (value == null || value === '') return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
};
export const isWalletRedemption = redemption => ['momo', 'zalopay'].includes(redemption?.method);
// Legacy wallet selections already recorded requestedAt when their QR was first
// revealed. Never use code entry or envelope opening to start this window.
export const getWalletQrShownAt = redemption => {
  if (!isWalletRedemption(redemption)) return null;
  const time = timestamp(redemption.qrShownAt) ?? timestamp(redemption.requestedAt);
  return time == null ? null : new Date(time).toISOString();
};
export const getWalletQrExpiresAt = redemption => {
  const shownAt = getWalletQrShownAt(redemption);
  return shownAt ? new Date(new Date(shownAt).getTime() + WALLET_QR_WINDOW_MS).toISOString() : null;
};
export const isWalletQrExpired = (redemption, now = Date.now()) => {
  if (!isWalletRedemption(redemption)) return false;
  const expiresAt = getWalletQrExpiresAt(redemption);
  // A malformed legacy wallet record without either timestamp must not receive
  // a fresh, unlimited bearer QR window just by loading the page.
  return expiresAt === null || new Date(expiresAt).getTime() <= Number(now);
};
export const publicImage = image => image?.url && image?.publicId ? { url: image.url, publicId: image.publicId } : null;
export const publicPayouts = payouts => ({ momo: publicImage(payouts?.momo), zalopay: publicImage(payouts?.zalopay) });
export const publicPrize = prize => ({ id: String(prize.id || prize._id), title: prize.title, sub: prize.sub, icon: prize.icon, color: prize.color, amount: Number(prize.amount) || 0, payouts: publicPayouts(prize.payouts) });
export const publicRedemption = (redemption, now = Date.now()) => redemption ? { method: redemption.method, recipientQr: publicImage(redemption.recipientQr), status: redemption.status, requestedAt: redemption.requestedAt, ...(redemption.paidAt ? { paidAt: redemption.paidAt } : {}), ...(isWalletRedemption(redemption) ? { qrShownAt: getWalletQrShownAt(redemption), qrExpiresAt: getWalletQrExpiresAt(redemption), qrExpired: isWalletQrExpired(redemption, now) } : {}) } : null;
const openedEnvelopes = code => (code.envelopes || []).filter(envelope => envelope.openedAt);
export const hasReward = code => code.status === 'used' || Boolean(code.usedAt) || Number(code.openedCount) >= REWARD_LIMIT || openedEnvelopes(code).length > 0;
export const firstReward = code => openedEnvelopes(code).sort((a, b) => new Date(a.openedAt) - new Date(b.openedAt) || a.index - b.index)[0] || null;
export const effectiveStatus = code => code.status === 'disabled' ? 'disabled' : hasReward(code) ? 'used' : code.status;
export const publicCode = code => ({ id: String(code.id || code._id), code: code.code, status: effectiveStatus(code), name: code.name || '', openedCount: Math.max(Number(code.openedCount) || 0, openedEnvelopes(code).length), createdAt: code.createdAt, claimedAt: code.claimedAt || null, usedAt: code.usedAt || firstReward(code)?.openedAt || null, redemption: publicRedemption(code.redemption), canDelete: !hasReward(code) && !code.ownerHash && ['available', 'disabled'].includes(code.status) });
export const publicReward = (envelope, livePrizes, redemption, now = Date.now()) => {
  const prize = publicPrize(envelope.prize);
  if (livePrizes) prize.payouts = publicPayouts(livePrizes.find(item => String(item.id || item._id) === prize.id)?.payouts);
  prize.payoutMethods = ['momo', 'zalopay'].filter(method => prize.payouts[method]);
  // A gift QR is a bearer instrument: expose only the wallet committed to this code.
  for (const method of ['momo', 'zalopay']) if (redemption?.method !== method || isWalletQrExpired(redemption, now)) prize.payouts[method] = null;
  return { index: envelope.index, number: envelope.number, prize };
};
export const publicPlayer = (code, livePrizes, now = Date.now()) => {
  const rewards = [firstReward(code)].filter(Boolean).slice(0, REWARD_LIMIT);
  const visibleRewards = rewards.map(envelope => publicReward(envelope, livePrizes, code.redemption, now));
  const redemption = publicRedemption(code.redemption, now);
  return { code: code.code, name: code.name || '', status: effectiveStatus(code), claimedAt: code.claimedAt || null, opened: rewards.map(envelope => envelope.index), rewards: visibleRewards, redemption };
};
export const winner = (code, envelope) => ({ id: `${code.id || code._id}:${envelope.index}`, codeId: String(code.id || code._id), name: code.name || '', code: code.code, claimedAt: code.claimedAt || null, index: envelope.index, prize: publicPrize(envelope.prize), openedAt: envelope.openedAt, redemption: publicRedemption(code.redemption) });
export function createEnvelopes(prizes) {
  const active = prizes.filter(prize => prize.active && prize.weight > 0);
  if (!active.length) throw Object.assign(new Error('Chưa có phần thưởng đang hoạt động.'), { status: 409 });
  const total = active.reduce((sum, prize) => sum + prize.weight, 0);
  return Array.from({ length: ENVELOPE_COUNT }, (_, index) => {
    let point = randomInt(total);
    const prize = active.find(item => { point -= item.weight; return point < 0; });
    return { index, number: index + 1, prize: publicPrize(prize), openedAt: null };
  });
}
export function pageParams(query) {
  const page = Math.max(1, Math.min(100000, Number.parseInt(query.page, 10) || 1));
  const limit = Math.max(1, Math.min(100, Number.parseInt(query.limit, 10) || 20));
  const search = String(query.search || '').trim().slice(0, 80);
  return { page, limit, search, status: query.status };
}
export const pagination = (items, total, page, limit) => ({ items, total, page, pages: Math.max(1, Math.ceil(total / limit)) });
export function dashboardFromCodes(codes) {
  const stats = { totalCodes: codes.length, availableCodes: 0, activeCodes: 0, usedCodes: 0, disabledCodes: 0, totalPlayers: 0, totalRewards: 0, todayRewards: 0, redemptionRate: 0 };
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
  const byDay = new Map();
  for (let offset = 6; offset >= 0; offset--) {
    const date = new Date(Date.now() - offset * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    byDay.set(date, 0);
  }
  const rewards = [];
  for (const code of codes) {
    const status = effectiveStatus(code);
    stats[`${status}Codes`]++;
    if (code.ownerHash) stats.totalPlayers++;
    for (const envelope of code.envelopes || []) {
      if (!envelope.openedAt) continue;
      const date = new Date(envelope.openedAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
      stats.totalRewards++;
      if (date === today) stats.todayRewards++;
      if (byDay.has(date)) byDay.set(date, byDay.get(date) + 1);
      rewards.push(winner(code, envelope));
    }
  }
  stats.redemptionRate = stats.totalCodes ? Math.round(stats.totalPlayers / stats.totalCodes * 1000) / 10 : 0;
  return { stats, daily: [...byDay].map(([date, count]) => ({ date, count })), recent: rewards.sort((a, b) => new Date(b.openedAt) - new Date(a.openedAt)).slice(0, 8) };
}
