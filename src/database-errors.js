export const DATABASE_FAILURE_REASONS = Object.freeze([
  'DATABASE_AUTHENTICATION_FAILED',
  'DATABASE_PERMISSION_DENIED',
  'DATABASE_DNS_ERROR',
  'DATABASE_TLS_ERROR',
  'DATABASE_URI_INVALID',
  'DATABASE_NETWORK_UNREACHABLE',
  'DATABASE_CONNECTION_FAILED',
  'DATABASE_INITIALIZATION_FAILED',
]);

const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ENODATA', 'ESERVFAIL', 'EREFUSED', 'ENOTIMP', 'EBADRESP']);
const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ETIMEOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE']);
const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_SIGNATURE_FAILURE', 'CERT_REVOKED', 'CERT_UNTRUSTED', 'CERT_REJECTED',
]);
const NETWORK_ERRORS = new Set(['MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoServerSelectionError', 'MongooseServerSelectionError', 'MongoTimeoutError']);
const AUTH_ERRORS = new Set(['MongoAuthenticationError', 'MongoMissingCredentialsError']);

function read(value, key) {
  try { return value[key]; } catch { return undefined; }
}

// Inspect errors only in memory. Callers may expose the returned fixed reason,
// never the exception, its messages, topology, server addresses, or driver codes.
export function databaseFailureReason(error, stage = 'connect') {
  const reasons = new Set();
  const pending = [{ value: error, depth: 0 }];
  const visited = new Set();
  const enqueue = (value, depth) => {
    if (value && typeof value === 'object' && depth <= 6 && pending.length < 64) pending.push({ value, depth });
  };

  for (let index = 0; index < pending.length && index < 64; index++) {
    const { value, depth } = pending[index];
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);
    const code = read(value, 'code');
    const codeName = read(value, 'codeName');
    const name = read(value, 'name');
    const rawMessage = read(value, 'message');
    const message = typeof rawMessage === 'string' ? rawMessage.slice(0, 4096) : '';
    const syscall = read(value, 'syscall');

    if (code === 18 || code === '18' || codeName === 'AuthenticationFailed' || AUTH_ERRORS.has(name)
      || /\bauthentication\s+(?:failed|failure)\b|\bbad\s+auth\b|\bunable to authenticate\b/i.test(message)) {
      reasons.add('DATABASE_AUTHENTICATION_FAILED');
    }
    if (code === 13 || code === '13' || codeName === 'Unauthorized') reasons.add('DATABASE_PERMISSION_DENIED');
    if (DNS_CODES.has(code) || (typeof syscall === 'string' && /^query(?:Srv|Txt)$/i.test(syscall)) || /\bquery(?:Srv|Txt)\b/i.test(message)) {
      reasons.add('DATABASE_DNS_ERROR');
    }
    if (TLS_CODES.has(code) || (typeof code === 'string' && /^ERR_(?:TLS|SSL)_/.test(code))
      || /\bSSL routines\b|\btlsv1 alert internal error\b/i.test(message)) reasons.add('DATABASE_TLS_ERROR');
    if (name === 'MongoParseError'
      || (name === 'MongoInvalidArgumentError' && /\b(?:uri|scheme|connection string)\b/i.test(message))
      || /\b(?:invalid|malformed)\s+(?:scheme|uri|connection string)\b|\b(?:uri|connection string)\s+(?:must|is invalid|is malformed)\b/i.test(message)) {
      reasons.add('DATABASE_URI_INVALID');
    }
    if (NETWORK_CODES.has(code) || code === 6 || code === 7 || code === 89 || NETWORK_ERRORS.has(name)) reasons.add('DATABASE_NETWORK_UNREACHABLE');

    for (const key of ['cause', 'reason', 'error', 'originalError', 'errorResponse']) enqueue(read(value, key), depth + 1);
    const servers = read(value, 'servers');
    if (servers instanceof Map) {
      let count = 0;
      for (const server of Map.prototype.values.call(servers)) {
        enqueue(server, depth + 1);
        if (++count >= 16) break;
      }
    }
  }

  // Specific nested errors take precedence over a generic outer selection timeout.
  for (const reason of DATABASE_FAILURE_REASONS) if (reasons.has(reason)) return reason;
  return stage === 'initialize' ? 'DATABASE_INITIALIZATION_FAILED' : 'DATABASE_CONNECTION_FAILED';
}
