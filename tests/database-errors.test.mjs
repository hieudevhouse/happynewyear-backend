import assert from 'node:assert/strict';
import test from 'node:test';
import { DATABASE_FAILURE_REASONS, databaseFailureReason, DATABASE_TLS_DETAILS, databaseTlsDetail } from '../src/database-errors.js';

const SECRET_MESSAGE = 'mongodb+srv://private-user:private-password@private-cluster.example/database';
const driverError = (properties = {}) => Object.assign(new Error(SECRET_MESSAGE), properties);

function reason(error, expected, stage) {
  const actual = databaseFailureReason(error, stage);
  assert.equal(actual, expected);
  assert.ok(DATABASE_FAILURE_REASONS.includes(actual));
  for (const secret of ['private-user', 'private-password', 'private-cluster', SECRET_MESSAGE]) assert.ok(!actual.includes(secret));
}

test('database failure reasons are a fixed immutable allowlist', () => {
  assert.deepEqual(DATABASE_FAILURE_REASONS, [
    'DATABASE_AUTHENTICATION_FAILED', 'DATABASE_PERMISSION_DENIED', 'DATABASE_DNS_ERROR',
    'DATABASE_TLS_ERROR', 'DATABASE_URI_INVALID', 'DATABASE_NETWORK_UNREACHABLE',
    'DATABASE_CONNECTION_FAILED', 'DATABASE_INITIALIZATION_FAILED',
  ]);
  assert.ok(Object.isFrozen(DATABASE_FAILURE_REASONS));
});

test('authentication and authorization errors emit fixed reasons without driver credentials', () => {
  for (const properties of [{ code: 18 }, { code: '18' }, { codeName: 'AuthenticationFailed' }, { name: 'MongoAuthenticationError' }, { name: 'MongoMissingCredentialsError' }, { message: `bad auth : authentication failed ${SECRET_MESSAGE}`, code: 8000 }]) {
    reason(driverError(properties), 'DATABASE_AUTHENTICATION_FAILED');
  }
  for (const properties of [{ code: 13 }, { code: '13' }, { codeName: 'Unauthorized' }]) {
    reason(driverError(properties), 'DATABASE_PERMISSION_DENIED', 'initialize');
  }
  // Atlas uses 8000 for multiple errors; the numeric code alone cannot prove bad auth.
  reason(driverError({ code: 8000 }), 'DATABASE_CONNECTION_FAILED');
});

test('DNS resolution and SRV/TXT lookup failures are distinguished from network failures', () => {
  for (const properties of [{ code: 'ENOTFOUND' }, { code: 'EAI_AGAIN' }, { code: 'ENODATA' }, { syscall: 'querySrv', code: 'ECONNREFUSED' }, { syscall: 'queryTxt', code: 'ETIMEOUT' }, { message: `querySrv ETIMEOUT ${SECRET_MESSAGE}` }]) {
    reason(driverError(properties), 'DATABASE_DNS_ERROR');
  }
  for (const properties of [{ code: 'ECONNREFUSED' }, { code: 'ETIMEDOUT' }, { code: 'ECONNRESET' }, { code: 'ENETUNREACH' }, { name: 'MongoNetworkError' }, { name: 'MongoNetworkTimeoutError' }, { name: 'MongooseServerSelectionError' }, { code: 89 }]) {
    reason(driverError(properties), 'DATABASE_NETWORK_UNREACHABLE');
  }
});

test('TLS and malformed URI errors produce only safe categories', () => {
  for (const code of ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR']) {
    reason(driverError({ code }), 'DATABASE_TLS_ERROR');
  }
  for (const message of [`SSL routines:ssl3_read_bytes:tlsv1 alert internal error ${SECRET_MESSAGE}`, `tlsv1 alert internal error ${SECRET_MESSAGE}`]) {
    reason(driverError({ name: 'MongooseServerSelectionError', reason: { servers: new Map([
      ['private-host.example', { error: driverError({ cause: driverError({ message }) }) }],
    ]) } }), 'DATABASE_TLS_ERROR');
  }
  for (const properties of [
    { name: 'MongoParseError' },
    { name: 'MongoInvalidArgumentError', message: `Invalid URI: ${SECRET_MESSAGE}` },
    { message: `Invalid scheme, expected connection string to start with mongodb://: ${SECRET_MESSAGE}` },
    { message: `URI must include hostname: ${SECRET_MESSAGE}` },
  ]) reason(driverError(properties), 'DATABASE_URI_INVALID');
});

test('nested causes and topology server error values override generic server selection errors', () => {
  reason(driverError({ name: 'MongoServerSelectionError', cause: driverError({ cause: driverError({ code: 18 }) }) }), 'DATABASE_AUTHENTICATION_FAILED');
  const topology = {
    servers: new Map([
      ['private-first-host.example:27017', { error: driverError({ code: 'ECONNRESET' }) }],
      ['private-second-host.example:27017', { error: driverError({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }) }],
    ]),
  };
  reason(driverError({ name: 'MongooseServerSelectionError', reason: topology, cause: topology }), 'DATABASE_TLS_ERROR');
  reason(driverError({ reason: { error: driverError({ codeName: 'Unauthorized' }) } }), 'DATABASE_PERMISSION_DENIED', 'initialize');
});

test('unknown, primitive and cyclic errors terminate with fixed stage fallbacks', () => {
  for (const error of [undefined, null, false, 18, SECRET_MESSAGE, {}, driverError()]) {
    reason(error, 'DATABASE_CONNECTION_FAILED');
    reason(error, 'DATABASE_INITIALIZATION_FAILED', 'initialize');
  }
  const cycle = driverError();
  cycle.cause = cycle;
  cycle.reason = { error: cycle, servers: new Map([['private-host.example', cycle]]) };
  reason(cycle, 'DATABASE_CONNECTION_FAILED');
  cycle.reason.error = driverError({ code: 13 });
  reason(cycle, 'DATABASE_PERMISSION_DENIED', 'initialize');
});

test('inspection handles throwing property getters and limits nested topology traversal', () => {
  let deep = driverError({ code: 18 });
  for (let depth = 0; depth < 20; depth++) deep = { cause: deep };
  reason(deep, 'DATABASE_CONNECTION_FAILED');
  const servers = new Map();
  for (let index = 0; index < 1000; index++) servers.set(`private-host-${index}.example`, { error: {} });
  servers.set('private-auth-host.example', { error: driverError({ code: 18 }) });
  reason({ reason: { servers } }, 'DATABASE_CONNECTION_FAILED');
  const getter = {};
  for (const key of ['name', 'message', 'code', 'codeName', 'cause', 'reason', 'error', 'servers']) {
    Object.defineProperty(getter, key, { get() { throw new Error(SECRET_MESSAGE); } });
  }
  reason(getter, 'DATABASE_CONNECTION_FAILED');
});

test('TLS details use an immutable fixed allowlist and distinguish alert, certificate, and protocol failures', () => {
  assert.deepEqual(DATABASE_TLS_DETAILS, [
    'TLS_ALERT_INTERNAL', 'TLS_CERTIFICATE_TRUST', 'TLS_CERTIFICATE_VALIDITY',
    'TLS_CERTIFICATE_HOSTNAME', 'TLS_PROTOCOL_OR_CIPHER', 'TLS_OTHER',
  ]);
  assert.ok(Object.isFrozen(DATABASE_TLS_DETAILS));
  const cases = [
    [{ code: 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR' }, 'TLS_ALERT_INTERNAL'],
    [{ message: `SSL routines:tlsv1 alert internal error ${SECRET_MESSAGE}` }, 'TLS_ALERT_INTERNAL'],
    [{ message: `SSL alert number 80 ${SECRET_MESSAGE}` }, 'TLS_ALERT_INTERNAL'],
    [{ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }, 'TLS_CERTIFICATE_TRUST'],
    [{ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, 'TLS_CERTIFICATE_TRUST'],
    [{ message: `self-signed certificate ${SECRET_MESSAGE}` }, 'TLS_CERTIFICATE_TRUST'],
    [{ code: 'CERT_HAS_EXPIRED' }, 'TLS_CERTIFICATE_VALIDITY'],
    [{ code: 'CERT_NOT_YET_VALID' }, 'TLS_CERTIFICATE_VALIDITY'],
    [{ message: `certificate has expired ${SECRET_MESSAGE}` }, 'TLS_CERTIFICATE_VALIDITY'],
    [{ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, 'TLS_CERTIFICATE_HOSTNAME'],
    [{ message: `Hostname/IP does not match certificate's altnames ${SECRET_MESSAGE}` }, 'TLS_CERTIFICATE_HOSTNAME'],
    [{ code: 'ERR_SSL_WRONG_VERSION_NUMBER' }, 'TLS_PROTOCOL_OR_CIPHER'],
    [{ code: 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION' }, 'TLS_PROTOCOL_OR_CIPHER'],
    [{ message: `SSL routines:ssl3_read_bytes:sslv3 alert handshake failure ${SECRET_MESSAGE}` }, 'TLS_PROTOCOL_OR_CIPHER'],
    [{ code: 'ERR_SSL_UNKNOWN_REASON' }, 'TLS_OTHER'],
  ];
  for (const [properties, expected] of cases) {
    const actual = databaseTlsDetail(driverError(properties));
    assert.equal(actual, expected);
    assert.ok(DATABASE_TLS_DETAILS.includes(actual));
    for (const secret of ['private-user', 'private-password', 'private-cluster', SECRET_MESSAGE]) assert.ok(!actual.includes(secret));
  }
});

test('TLS detail inspection traverses topology causes without mistaking an outer network timeout for a TLS subtype', () => {
  const outer = driverError({ name: 'MongooseServerSelectionError', code: 'ETIMEDOUT' });
  assert.equal(databaseTlsDetail(outer), 'TLS_OTHER');
  reason(outer, 'DATABASE_NETWORK_UNREACHABLE');
  outer.reason = { servers: new Map([
    ['private-host.example', { error: driverError({ name: 'MongoNetworkError', cause: driverError({ code: 'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR' }) }) }],
  ]) };
  assert.equal(databaseTlsDetail(outer), 'TLS_ALERT_INTERNAL');
  reason(outer, 'DATABASE_TLS_ERROR');
  outer.cause = outer;
  assert.equal(databaseTlsDetail(outer), 'TLS_ALERT_INTERNAL');
  for (const error of [undefined, null, SECRET_MESSAGE, driverError({ code: 18 }), driverError({ code: 'ECONNREFUSED' })]) {
    assert.equal(databaseTlsDetail(error), 'TLS_OTHER');
  }
  let deep = driverError({ code: 'CERT_HAS_EXPIRED' });
  for (let depth = 0; depth < 20; depth++) deep = { cause: deep };
  assert.equal(databaseTlsDetail(deep), 'TLS_OTHER');
});
