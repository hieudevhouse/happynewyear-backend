// Explicit test adapter. Production never imports this module or falls back to memory.
import { randomUUID } from 'node:crypto';
import { hashPassword } from './security.js';
import { dashboardFromCodes, effectiveStatus, firstReward, hasReward, isWalletRedemption, pagination, publicCode, REWARD_LIMIT, winner } from './domain.js';

const clone = value => value ? structuredClone(value) : value;
export class MemoryStore {
  constructor() { this.codes = new Map(); this.prizes = new Map(); this.admins = new Map(); this.sessions = new Map(); this.qrUploads = new Map(); this.ready = true; }
  isReady() { return this.ready; }
  async initialize({ username, password, prizes }) {
    if (![...this.admins.values()].some(admin => admin.username === username)) {
      const id = randomUUID();
      this.admins.set(id, { id, username, passwordHash: await hashPassword(password) });
    }
    if (!this.prizes.size) for (const prize of prizes) await this.createPrize({ ...prize, active: true, weight: 1 });
  }
  async findAdmin(username) { return clone([...this.admins.values()].find(admin => admin.username === username)); }
  async getAdmin(id) { return clone(this.admins.get(id)); }
  async createSession(session) { this.sessions.set(session.hash, clone(session)); }
  async getSession(hash, kind) { const session = this.sessions.get(hash); return session?.kind === kind && new Date(session.expiresAt) > new Date() ? clone(session) : null; }
  async deleteSession(hash) { this.sessions.delete(hash); }
  async getCode(code) { return clone([...this.codes.values()].find(item => item.code === code)); }
  async getCodeById(id) { return clone(this.codes.get(id)); }
  async selectPlayerCode(ownerHash, codeId) { const session = this.sessions.get(ownerHash); if (session?.kind === 'player') session.codeId = codeId; }
  async getPlayerCode(ownerHash) { const code = this.codes.get(this.sessions.get(ownerHash)?.codeId); return code?.ownerHash === ownerHash ? clone(code) : null; }
  async claimCode(code, ownerHash, envelopes) {
    const record = [...this.codes.values()].find(item => item.code === code);
    if (!record || record.status !== 'available' || record.ownerHash || hasReward(record)) return null;
    Object.assign(record, { ownerHash, envelopes: clone(envelopes), status: 'active', claimedAt: new Date() });
    return clone(record);
  }
  async setPlayerName(id, ownerHash, name) {
    const code = this.codes.get(id);
    if (!code || code.ownerHash !== ownerHash || hasReward(code) || code.status !== 'active') return null;
    code.name = name;
    return clone(code);
  }
  async openEnvelope(id, ownerHash, index) {
    const code = this.codes.get(id);
    if (!code || code.ownerHash !== ownerHash || code.status !== 'active' || !code.name || hasReward(code) || !code.envelopes[index]) return null;
    const now = new Date();
    code.envelopes[index].openedAt = now;
    code.openedCount = REWARD_LIMIT;
    code.status = 'used';
    code.usedAt = now;
    return clone(code);
  }
  async saveRedemption(id, ownerHash, redemption) {
    const code = this.codes.get(id);
    if (!code || code.ownerHash !== ownerHash || code.status === 'disabled' || !firstReward(code) || code.redemption?.status === 'paid' || (code.redemption && code.redemption.method !== redemption.method)) return null;
    // Concurrent requests for the same wallet must retain its first reveal time.
    if (isWalletRedemption(redemption) && code.redemption) return clone(code);
    code.redemption = clone(redemption);
    return clone(code);
  }
  async markRedemptionPaid(id, expectedQrPublicId) {
    const code = this.codes.get(id);
    if (!code || !firstReward(code) || code.redemption?.method !== 'bank' || code.redemption.recipientQr?.publicId !== expectedQrPublicId || !['pending', 'paid'].includes(code.redemption?.status)) return null;
    if (code.redemption.status === 'pending') Object.assign(code.redemption, { status: 'paid', paidAt: new Date() });
    return clone(code);
  }
  async registerQrUpload(upload) { this.qrUploads.set(upload.publicId, clone(upload)); }
  async getQrUpload(publicId) { return clone(this.qrUploads.get(publicId)); }
  async createCodes(codes) {
    if (codes.some(code => [...this.codes.values()].some(item => item.code === code))) throw Object.assign(new Error('Duplicate'), { code: 11000 });
    return codes.map(code => {
      const item = { id: randomUUID(), code, status: 'available', ownerHash: null, name: '', openedCount: 0, createdAt: new Date(), usedAt: null, envelopes: [] };
      this.codes.set(item.id, item);
      return clone(item);
    });
  }
  async listCodes({ page, limit, search, status }) {
    const records = [...this.codes.values()].filter(code => (!status || effectiveStatus(code) === status) && (!search || `${code.code} ${code.name}`.toLowerCase().includes(search.toLowerCase()))).sort((a, b) => b.createdAt - a.createdAt);
    return pagination(records.slice((page - 1) * limit, page * limit).map(publicCode), records.length, page, limit);
  }
  async setCodeStatus(id, status) {
    const code = this.codes.get(id);
    if (!code) return null;
    const consumed = hasReward(code);
    if (consumed && !code.usedAt) code.usedAt = firstReward(code)?.openedAt || new Date();
    code.status = status === 'disabled' ? 'disabled' : consumed ? 'used' : code.ownerHash ? 'active' : 'available';
    return clone(code);
  }
  async deleteUnusedCode(id) { const code = this.codes.get(id); return code && !hasReward(code) && !code.ownerHash && ['available', 'disabled'].includes(code.status) ? this.codes.delete(id) : false; }
  async listPrizes() { return clone([...this.prizes.values()]); }
  async createPrize(prize) { const item = { ...prize, id: randomUUID(), createdAt: new Date() }; this.prizes.set(item.id, item); return clone(item); }
  async updatePrize(id, prize) { const item = this.prizes.get(id); if (!item) return null; Object.assign(item, prize); return clone(item); }
  async listWinners({ page, limit, search }) {
    const records = [...this.codes.values()].flatMap(code => code.envelopes.filter(envelope => envelope.openedAt).map(envelope => winner(code, envelope))).filter(row => !search || `${row.code} ${row.name}`.toLowerCase().includes(search.toLowerCase())).sort((a, b) => b.openedAt - a.openedAt);
    return pagination(records.slice((page - 1) * limit, page * limit), records.length, page, limit);
  }
  async dashboard() { return dashboardFromCodes([...this.codes.values()]); }
}
