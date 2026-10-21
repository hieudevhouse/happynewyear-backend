import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createCloudinaryUploader, decodeQrImage, isCloudinaryQr, MAX_QR_BYTES } from '../src/cloudinary.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==';

test('QR image validation checks MIME, base64, file signatures and decoded size', () => {
  assert.equal(decodeQrImage(PNG).mime, 'image/png');
  for (const image of [null, '', 'https://elsewhere/qr.png', PNG.replace('image/png', 'image/jpeg'), 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,a===', PNG.replace('base64,', 'base64,\n')]) {
    assert.throws(() => decodeQrImage(image), error => error.status === 400);
  }
});

test('QR image validation accepts exactly 50 MB and rejects one byte above the limit', () => {
  assert.equal(MAX_QR_BYTES, 50 * 1024 * 1024);
  const bytes = Buffer.alloc(MAX_QR_BYTES);
  Buffer.from(PNG.split(',')[1], 'base64').copy(bytes);
  const maximum = `data:image/png;base64,${bytes.toString('base64')}`;
  assert.equal(decodeQrImage(maximum).bytes.length, MAX_QR_BYTES);
  // 50 MB leaves one base64 padding character; replacing it adds one decoded byte.
  assert.throws(() => decodeQrImage(`${maximum.slice(0, -1)}A`), error => error.status === 413);
});

test('Cloudinary uploader signs only upload parameters and never transmits the API secret', async () => {
  let request;
  const upload = createCloudinaryUploader({ cloudName: 'example', apiKey: 'test-key', apiSecret: 'server-secret', folder: 'lucky-money/qr', fetch: async (url, options) => {
    request = { url, options };
    const publicId = options.body.get('public_id');
    return { ok: true, json: async () => ({ resource_type: 'image', secure_url: `https://res.cloudinary.com/example/image/upload/v123/${publicId}.png`, public_id: publicId }) };
  } });
  const image = await upload(PNG, { purpose: 'admin' });
  assert.equal(request.url, 'https://api.cloudinary.com/v1_1/example/image/upload');
  assert.equal(request.options.method, 'POST');
  const form = request.options.body;
  const file = form.get('file');
  assert.ok(file instanceof Blob);
  assert.equal(file.type, 'image/png');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), Buffer.from(PNG.split(',')[1], 'base64'));
  assert.equal(form.get('api_key'), 'test-key');
  assert.equal(form.has('api_secret'), false);
  assert.equal(form.get('overwrite'), 'false');
  assert.match(form.get('public_id'), /^lucky-money\/qr\/admin\/[0-9a-f-]+$/);
  const expected = createHash('sha1').update(`overwrite=false&public_id=${form.get('public_id')}&timestamp=${form.get('timestamp')}server-secret`).digest('hex');
  assert.equal(form.get('signature'), expected);
  assert.deepEqual(Object.keys(image), ['url', 'publicId']);
});

test('Cloudinary errors and invalid upstream responses return safe messages', async () => {
  for (const fetcher of [
    async () => { throw new Error('sensitive request api_secret=server-secret'); },
    async () => ({ ok: false, json: async () => ({ error: { message: 'server-secret' } }) }),
    async () => ({ ok: true, json: async () => ({ public_id: 'foreign', secure_url: 'https://attacker.invalid/qr.png', resource_type: 'image' }) }),
  ]) {
    const upload = createCloudinaryUploader({ cloudName: 'example', apiKey: 'test-key', apiSecret: 'server-secret', fetch: fetcher });
    await assert.rejects(upload(PNG), error => error.status === 502 && error.expose && !error.message.includes('server-secret'));
  }
});

test('Cloudinary rejection categories help a bank QR user recover without exposing provider details', async t => {
  const cases = [
    [401, 'Invalid Signature. String to sign: timestamp=123', 'QR_UPLOAD_AUTH', 503],
    [401, 'Unknown API key', 'QR_UPLOAD_AUTH', 503],
    [400, 'cloud_name is disabled', 'QR_UPLOAD_AUTH', 503],
    [400, 'File size too large. Got 12582912. Maximum is 10485760.', 'QR_UPLOAD_SIZE', 413],
    [400, 'Image size 30000000 exceeds limit of 25000000 pixels', 'QR_UPLOAD_DIMENSIONS', 413],
    [400, 'Invalid image file', 'QR_UPLOAD_IMAGE', 400],
    [400, 'Unsupported file format', 'QR_UPLOAD_IMAGE', 400],
    [400, 'Account has exceeded its quota', 'QR_UPLOAD_QUOTA', 503],
    [400, 'Not enough credits', 'QR_UPLOAD_QUOTA', 503],
    [429, 'Too many requests', 'QR_UPLOAD_RATE_LIMIT', 429],
    [400, 'Unexpected upstream rejection', 'QR_UPLOAD_FAILED', 502],
  ];
  for (const [upstreamStatus, reason, publicCode, status] of cases) {
    await t.test(publicCode + ': ' + reason, async () => {
      const upload = createCloudinaryUploader({ cloudName: 'example', apiKey: 'test-key', apiSecret: 'server-secret', fetch: async () => ({
        ok: false,
        status: upstreamStatus,
        headers: new Headers(),
        json: async () => ({ error: { message: `${reason}; api_key=test-key; api_secret=server-secret; signature=private-signature` } }),
      }) });
      await assert.rejects(upload(PNG), error => {
        assert.equal(error.status, status);
        assert.equal(error.publicCode, publicCode);
        assert.equal(error.expose, true);
        for (const sensitive of ['test-key', 'server-secret', 'private-signature', reason]) assert.equal(error.message.includes(sensitive), false);
        return true;
      });
    });
  }
});

test('Cloudinary rejection classification also reads its diagnostic header when no JSON is available', async () => {
  const upload = createCloudinaryUploader({ cloudName: 'example', apiKey: 'test-key', apiSecret: 'server-secret', fetch: async () => ({
    ok: false,
    status: 400,
    headers: new Headers({ 'X-Cld-Error': 'File size too large. Maximum is 10485760; server-secret' }),
    json: async () => { throw new SyntaxError('Unexpected HTML response containing server-secret'); },
  }) });
  await assert.rejects(upload(PNG), error => error.status === 413 && error.publicCode === 'QR_UPLOAD_SIZE' && !error.message.includes('server-secret'));
});

test('network failures and timeouts have distinct safe upload errors', async () => {
  for (const [failure, publicCode, status] of [
    [new TypeError('fetch failed with api_secret=server-secret', { cause: { code: 'ECONNRESET' } }), 'QR_UPLOAD_NETWORK', 502],
    [new DOMException('Timed out while sending server-secret', 'TimeoutError'), 'QR_UPLOAD_TIMEOUT', 504],
  ]) {
    const upload = createCloudinaryUploader({ cloudName: 'example', apiKey: 'test-key', apiSecret: 'server-secret', fetch: async () => { throw failure; } });
    await assert.rejects(upload(PNG), error => error.status === status && error.publicCode === publicCode && error.expose && !error.message.includes('server-secret'));
  }
});

test('successful Cloudinary responses still require valid JSON and exactly the requested public asset', async () => {
  for (const responseBody of [
    () => { throw new SyntaxError('Malformed response with server-secret'); },
    () => null,
    (_publicId) => ({ resource_type: 'image', public_id: 'lucky-money/qr/player/foreign', secure_url: 'https://res.cloudinary.com/example/image/upload/v123/lucky-money/qr/player/foreign.png' }),
    publicId => ({ resource_type: 'image', public_id: publicId, secure_url: `https://res.cloudinary.com/another-cloud/image/upload/v123/${publicId}.png` }),
    publicId => ({ resource_type: 'raw', public_id: publicId, secure_url: `https://res.cloudinary.com/example/image/upload/v123/${publicId}.png` }),
  ]) {
    const upload = createCloudinaryUploader({ cloudName: 'example', apiKey: 'test-key', apiSecret: 'server-secret', fetch: async (_url, options) => ({
      ok: true,
      status: 200,
      json: async () => responseBody(options.body.get('public_id')),
    }) });
    await assert.rejects(upload(PNG), error => error.status === 502 && error.publicCode === 'QR_UPLOAD_RESPONSE' && error.expose && !error.message.includes('server-secret'));
  }
});

test('Cloudinary asset validation permits only the configured image folder and cloud', () => {
  const image = { url: 'https://res.cloudinary.com/example/image/upload/v123/lucky-money/qr/player/abc.png', publicId: 'lucky-money/qr/player/abc' };
  assert.equal(isCloudinaryQr(image, { cloudName: 'example' }), true);
  for (const candidate of [
    { ...image, url: image.url.replace('https:', 'http:') },
    { ...image, url: image.url.replace('example/', 'someone-else/') },
    { ...image, url: image.url.replace('res.cloudinary.com', 'res.cloudinary.com.attacker.invalid') },
    { ...image, url: `${image.url}?anything=true` },
    { ...image, url: image.url.replace('/image/', '/raw/') },
    { ...image, publicId: 'foreign/abc' },
    { ...image, publicId: 'lucky-money/qr/../abc' },
  ]) assert.equal(isCloudinaryQr(candidate, { cloudName: 'example' }), false);
});
