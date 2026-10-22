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

export const DATABASE_TLS_DETAILS = Object.freeze([
  'TLS_ALERT_INTERNAL',
  'TLS_CERTIFICATE_TRUST',
  'TLS_CERTIFICATE_VALIDITY',
  'TLS_CERTIFICATE_HOSTNAME',
  'TLS_PROTOCOL_OR_CIPHER',
  'TLS_OTHER',
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
const TLS_PROTOCOL_CODES = new Set([
  'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
  'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE', 'ERR_SSL_NO_SHARED_CIPHER',
  'ERR_SSL_NO_CIPHERS_AVAILABLE', 'ERR_SSL_UNSUPPORTED_PROTOCOL',
  'ERR_TLS_INVALID_PROTOCOL_VERSION', 'ERR_TLS_INVALID_PROTOCOL_METHOD',
  'ERR_TLS_DH_PARAM_SIZE', 'ERR_SSL_VERSION_TOO_LOW', 'ERR_SSL_VERSION_TOO_HIGH',
  'ERR_SSL_EE_KEY_TOO_SMALL', 'ERR_SSL_CA_MD_TOO_WEAK',
]);

function read(value, key) {
  try { return value[key]; } catch { return undefined; }
}

// Facts stay inside this module; exported classifiers return fixed labels only.
function* errorFacts(error) {
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

    yield { code, codeName, name, message, syscall };

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
}

// Inspect errors only in memory. Callers may expose the returned fixed reason,
// never the exception, its messages, topology, server addresses, or driver codes.
export function databaseFailureReason(error, stage = 'connect') {
  const reasons = new Set();
  for (const { code, codeName, name, message, syscall } of errorFacts(error)) {
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
  }

  // Specific nested errors take precedence over a generic outer selection timeout.
  for (const reason of DATABASE_FAILURE_REASONS) if (reasons.has(reason)) return reason;
  return stage === 'initialize' ? 'DATABASE_INITIALIZATION_FAILED' : 'DATABASE_CONNECTION_FAILED';
}

export function databaseTlsDetail(error) {
  const details = new Set();
  for (const { code, message } of errorFacts(error)) {
    if (code === 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR' || /\btlsv1 alert internal error\b|\bSSL alert number 80\b/i.test(message)) details.add('TLS_ALERT_INTERNAL');
    if (code === 'CERT_HAS_EXPIRED' || code === 'CERT_NOT_YET_VALID' || /\bcertificate (?:has expired|is not yet valid)\b/i.test(message)) details.add('TLS_CERTIFICATE_VALIDITY');
    else if (TLS_CODES.has(code) || code === 'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED'
      || /\bself[- ]signed certificate\b|\bunable to (?:verify the first certificate|verify leaf signature|get (?:local )?issuer certificate)\b/i.test(message)) details.add('TLS_CERTIFICATE_TRUST');
    if (code === 'ERR_TLS_CERT_ALTNAME_INVALID' || /\bHostname\/IP does not match certificate's altnames\b/i.test(message)) details.add('TLS_CERTIFICATE_HOSTNAME');
    if (TLS_PROTOCOL_CODES.has(code)
      || /\bwrong version number\b|\bunsupported protocol\b|\bno shared cipher\b|\bno ciphers available\b|\balert protocol version\b|\bhandshake failure\b/i.test(message)) details.add('TLS_PROTOCOL_OR_CIPHER');
  }
  for (const detail of DATABASE_TLS_DETAILS) if (details.has(detail)) return detail;
  return 'TLS_OTHER';
}
