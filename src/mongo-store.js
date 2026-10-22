import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { hashPassword } from './security.js';
import { dashboardFromCodes, isWalletRedemption, pagination, publicCode, REWARD_LIMIT, winner } from './domain.js';

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const plain = value => value ? { ...value, id: String(value._id) } : null;
const openedEnvelopes = { $filter: { input: { $ifNull: ['$envelopes', []] }, as: 'envelope', cond: { $ne: [{ $ifNull: ['$$envelope.openedAt', null] }, null] } } };
const consumed = { $or: [
  { $eq: ['$status', 'used'] },
  { $ne: [{ $ifNull: ['$usedAt', null] }, null] },
  { $gte: [{ $ifNull: ['$openedCount', 0] }, REWARD_LIMIT] },
  { $gt: [{ $size: openedEnvelopes }, 0] },
] };
const unconsumed = { $not: [consumed] };
export class MongoStore {
  async connect(uri) {
    this.connection = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 10000, bufferCommands: false });
    await this.connection.asPromise();
    const options = { timestamps: true, versionKey: false, bufferCommands: false };
    const imageSchema = new mongoose.Schema({ url: String, publicId: String }, { _id: false });
    const payoutsSchema = new mongoose.Schema({ momo: { type: imageSchema, default: null }, zalopay: { type: imageSchema, default: null } }, { _id: false });
    const redemptionSchema = new mongoose.Schema({ method: { type: String, enum: ['momo', 'zalopay', 'bank'] }, recipientQr: { type: imageSchema, default: null }, status: { type: String, enum: ['qr_ready', 'pending', 'paid'] }, requestedAt: Date, qrShownAt: Date, paidAt: Date }, { _id: false });
    const prizeFields = { id: String, title: String, sub: String, icon: String, color: String, amount: { type: Number, default: 0 }, payouts: { type: payoutsSchema, default: () => ({}) } };
    const envelopeSchema = new mongoose.Schema({ index: Number, number: Number, prize: prizeFields, openedAt: { type: Date, default: null } }, { _id: false });
    this.Code = this.connection.model('Code', new mongoose.Schema({
      _id: { type: String, default: () => randomUUID() }, code: { type: String, unique: true, required: true },
      status: { type: String, default: 'available', index: true }, ownerHash: { type: String, default: null, index: true },
      name: { type: String, default: '' }, claimedAt: Date, usedAt: Date, openedCount: { type: Number, default: 0 }, envelopes: [envelopeSchema], redemption: { type: redemptionSchema, default: null },
    }, options));
    this.Prize = this.connection.model('Prize', new mongoose.Schema({ _id: { type: String, default: () => randomUUID() }, title: String, sub: String, icon: String, color: String, amount: { type: Number, default: 0 }, payouts: { type: payoutsSchema, default: () => ({}) }, weight: { type: Number, default: 1 }, active: { type: Boolean, default: true } }, options));
    this.Admin = this.connection.model('Admin', new mongoose.Schema({ _id: { type: String, default: () => randomUUID() }, username: { type: String, unique: true }, passwordHash: String }, options));
    this.Session = this.connection.model('Session', new mongoose.Schema({ _id: String, kind: String, adminId: String, codeId: String, expiresAt: { type: Date, expires: 0 } }, options));
    this.QrUpload = this.connection.model('QrUpload', new mongoose.Schema({ _id: String, url: String, purpose: String, ownerId: String }, options));
    await Promise.all([this.Code.init(), this.Prize.init(), this.Admin.init(), this.Session.init(), this.QrUpload.init()]);
  }
  isReady() { return this.connection?.readyState === 1; }
  async close() { await this.connection?.close(); }
  async initialize({ username, password, prizes }) {
    if (!await this.Admin.exists({ username })) {
      const passwordHash = await hashPassword(password);
      await this.Admin.updateOne({ username }, { $setOnInsert: { username, passwordHash } }, { upsert: true });
    }
    if (!await this.Prize.exists({})) await this.Prize.insertMany(prizes.map(prize => ({ ...prize, weight: 1, active: true })));
  }
  async findAdmin(username) { return plain(await this.Admin.findOne({ username }).lean()); }
  async getAdmin(id) { return plain(await this.Admin.findById(id).lean()); }
  async createSession(session) { await this.Session.create({ ...session, _id: session.hash }); }
  async getSession(hash, kind) { return plain(await this.Session.findOne({ _id: hash, kind, expiresAt: { $gt: new Date() } }).lean()); }
  async deleteSession(hash) { await this.Session.deleteOne({ _id: hash }); }
  async getCode(code) { return plain(await this.Code.findOne({ code }).lean()); }
  async getCodeById(id) { return plain(await this.Code.findById(id).lean()); }
  async selectPlayerCode(ownerHash, codeId) { await this.Session.updateOne({ _id: ownerHash, kind: 'player' }, { $set: { codeId } }); }
  async getPlayerCode(ownerHash) {
    const session = await this.Session.findById(ownerHash).lean();
    return session?.codeId ? plain(await this.Code.findOne({ _id: session.codeId, ownerHash }).lean()) : null;
  }
  async claimCode(code, ownerHash, envelopes) {
    return plain(await this.Code.findOneAndUpdate({ code, status: 'available', ownerHash: null, $expr: unconsumed }, { $set: { ownerHash, envelopes, status: 'active', claimedAt: new Date(), name: '', openedCount: 0 } }, { new: true }).lean());
  }
  async setPlayerName(id, ownerHash, name) {
    return plain(await this.Code.findOneAndUpdate({ _id: id, ownerHash, status: 'active', $expr: unconsumed }, { $set: { name } }, { new: true }).lean());
  }
  async openEnvelope(id, ownerHash, index) {
    const now = new Date();
    return plain(await this.Code.findOneAndUpdate({ _id: id, ownerHash, status: 'active', name: { $ne: '' }, $expr: unconsumed, [`envelopes.${index}.index`]: index }, [{ $set: {
      envelopes: { $map: { input: '$envelopes', as: 'envelope', in: { $cond: [{ $eq: ['$$envelope.index', index] }, { $mergeObjects: ['$$envelope', { openedAt: now }] }, '$$envelope'] } } },
      openedCount: REWARD_LIMIT, status: 'used', usedAt: now, updatedAt: now,
    } }], { new: true }).lean());
  }
  async saveRedemption(id, ownerHash, redemption) {
    // A wallet selection can be inserted once; only bank QR images may change.
    // This also prevents racing identical wallet requests from restarting 72h.
    const selection = isWalletRedemption(redemption) ? { redemption: null } : { $or: [{ redemption: null }, { 'redemption.method': redemption.method }] };
    return plain(await this.Code.findOneAndUpdate({ _id: id, ownerHash, status: { $ne: 'disabled' }, 'redemption.status': { $ne: 'paid' }, ...selection, $expr: { $gt: [{ $size: openedEnvelopes }, 0] } }, { $set: { redemption } }, { new: true }).lean());
  }
  async markRedemptionPaid(id, expectedQrPublicId) {
    const identity = { _id: id, 'redemption.method': 'bank', 'redemption.recipientQr.publicId': expectedQrPublicId };
    const code = plain(await this.Code.findOneAndUpdate({ ...identity, 'redemption.status': 'pending', $expr: { $gt: [{ $size: openedEnvelopes }, 0] } }, { $set: { 'redemption.status': 'paid', 'redemption.paidAt': new Date() } }, { new: true }).lean());
    return code || plain(await this.Code.findOne({ ...identity, 'redemption.status': 'paid' }).lean());
  }
  async registerQrUpload(upload) { await this.QrUpload.create({ ...upload, _id: upload.publicId }); }
  async getQrUpload(publicId) { const upload = await this.QrUpload.findById(publicId).lean(); return upload ? { ...upload, publicId: upload._id } : null; }
  async createCodes(codes) { return (await this.Code.insertMany(codes.map(code => ({ code })))).map(doc => plain(doc.toObject())); }
  async listCodes({ page, limit, search, status }) {
    const query = {};
    if (search) query.$or = [{ code: new RegExp(escapeRegex(search), 'i') }, { name: new RegExp(escapeRegex(search), 'i') }];
    if (status === 'disabled') query.status = 'disabled';
    else if (status === 'used') { query.status = { $ne: 'disabled' }; query.$expr = consumed; }
    else if (['available', 'active'].includes(status)) { query.status = status; query.$expr = unconsumed; }
    const [records, total] = await Promise.all([this.Code.find(query).select('code status name ownerHash openedCount createdAt claimedAt usedAt envelopes.openedAt redemption').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), this.Code.countDocuments(query)]);
    return pagination(records.map(publicCode), total, page, limit);
  }
  async setCodeStatus(id, status) {
    const now = new Date();
    return plain(await this.Code.findOneAndUpdate({ _id: id }, [{ $set: {
      status: status === 'disabled' ? 'disabled' : { $cond: [consumed, 'used', { $cond: [{ $ne: [{ $ifNull: ['$ownerHash', null] }, null] }, 'active', 'available'] }] },
      usedAt: { $cond: [consumed, { $ifNull: ['$usedAt', { $ifNull: [{ $min: { $map: { input: openedEnvelopes, as: 'envelope', in: '$$envelope.openedAt' } } }, now] }] }, '$usedAt'] },
      updatedAt: now,
    } }], { new: true }).lean());
  }
  async deleteUnusedCode(id) { return Boolean((await this.Code.deleteOne({ _id: id, ownerHash: null, status: { $in: ['available', 'disabled'] }, $expr: unconsumed })).deletedCount); }
  async listPrizes() { return (await this.Prize.find().sort({ createdAt: 1 }).lean()).map(plain); }
  async createPrize(prize) { return plain((await this.Prize.create(prize)).toObject()); }
  async updatePrize(id, prize) { return plain(await this.Prize.findByIdAndUpdate(id, { $set: prize }, { new: true }).lean()); }
  async listWinners({ page, limit, search }) {
    const pipeline = [{ $unwind: '$envelopes' }, { $match: { 'envelopes.openedAt': { $ne: null } } }];
    if (search) pipeline.push({ $match: { $or: [{ code: new RegExp(escapeRegex(search), 'i') }, { name: new RegExp(escapeRegex(search), 'i') }] } });
    pipeline.push({ $sort: { 'envelopes.openedAt': -1 } }, { $facet: { items: [{ $skip: (page - 1) * limit }, { $limit: limit }], total: [{ $count: 'count' }] } });
    const [result] = await this.Code.aggregate(pipeline);
    return pagination(result.items.map(code => winner(code, code.envelopes)), result.total[0]?.count || 0, page, limit);
  }
  async dashboard() {
    // Only opened reward snapshots are read, never sessions, password hashes, or unopened prizes.
    const codes = await this.Code.find().select('code status name ownerHash openedCount createdAt claimedAt usedAt envelopes.index envelopes.prize envelopes.openedAt redemption').lean();
    return dashboardFromCodes(codes);
  }
}
