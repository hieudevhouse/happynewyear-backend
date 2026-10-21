import { createHash, randomUUID } from 'node:crypto';

export const MAX_QR_BYTES = 50 * 1024 * 1024;
const error = (status, message, publicCode) => Object.assign(new Error(message), { status, expose: true, ...(publicCode ? { publicCode } : {}) });

// Never return Cloudinary's raw message: authentication failures can echo the
// API key, signature, or signed request parameters. Only expose known categories.
function providerError(status, message = '') {
  if (/too many|rate.?limit/i.test(message) || status === 429) return error(429, 'Cloudinary đang giới hạn số lần tải ảnh. Bạn chờ một chút rồi thử lại nhé.', 'QR_UPLOAD_RATE_LIMIT');
  if (/pixel|megapixel|resolution|width.*exceed|height.*exceed|dimensions?.*(?:exceed|limit|large)|image size.*(?:limit|exceed)/i.test(message)) return error(413, 'Độ phân giải ảnh vượt giới hạn Cloudinary. Hãy xuất lại mã QR từ ứng dụng ngân hàng hoặc chọn ảnh có kích thước nhỏ hơn.', 'QR_UPLOAD_DIMENSIONS');
  if (/file.*(?:too large|size.*(?:exceed|limit|maximum))|(?:maximum|max|allowed).*file size|(?:size|bytes).*(?:too large|exceed)/i.test(message)) return error(413, 'Ảnh vượt giới hạn dung lượng của tài khoản Cloudinary. Trang cho phép chọn tới 50 MB, nhưng tài khoản Cloudinary có thể nhận ít hơn. Hãy chọn ảnh QR nhẹ hơn hoặc nhờ người tổ chức kiểm tra gói Cloudinary.', 'QR_UPLOAD_SIZE');
  if (/(?:invalid|unknown|incorrect)\s+(?:api[ _-]?key|signature|cloud[ _-]?name)|(?:api[ _-]?key|signature)[\s:'"=]{0,8}(?:invalid|incorrect|not found)|timestamp|stale request|cloud[ _-]?(?:name)?\s*(?:is\s+)?(?:disabled|not found)|account\s*(?:is\s+)?disabled/i.test(message) || status === 401) return error(503, 'Cloudinary từ chối xác thực. Người tổ chức cần kiểm tra cloud name, API key, API secret cùng một tài khoản và giờ máy chủ, sau đó khởi động lại server.', 'QR_UPLOAD_AUTH');
  if (/quota|credits?|storage.*(?:exceed|limit)|usage.*(?:exceed|limit)/i.test(message)) return error(503, 'Tài khoản Cloudinary đã chạm giới hạn sử dụng. Vui lòng báo người tổ chức kiểm tra tài khoản và thử lại sau.', 'QR_UPLOAD_QUOTA');
  if (/invalid image|(?:image|file).*(?:corrupt|invalid|unsupported)|unsupported.*(?:format|image)|cannot.*(?:decode|read).*image|unrecognized.*(?:image|file)/i.test(message)) return error(400, 'Cloudinary không đọc được ảnh này. Hãy xuất lại mã QR từ ứng dụng ngân hàng dưới dạng PNG hoặc JPG rồi tải lại.', 'QR_UPLOAD_IMAGE');
  return error(502, 'Cloudinary chưa nhận được ảnh. Bạn thử tải lại; nếu vẫn lỗi, hãy gửi mã lỗi QR_UPLOAD_FAILED cho người tổ chức.', 'QR_UPLOAD_FAILED');
}

export function decodeQrImage(image) {
  if (typeof image !== 'string') throw error(400, 'Vui lòng chọn ảnh QR PNG, JPEG hoặc WebP.');
  const separator = image.indexOf(',');
  const match = /^data:image\/(png|jpeg|webp);base64$/.exec(image.slice(0, separator));
  const encoded = separator >= 0 ? image.slice(separator + 1) : '';
  if (!match || !encoded || encoded.length % 4 !== 0) throw error(400, 'Ảnh QR phải là PNG, JPEG hoặc WebP hợp lệ.');
  if (encoded.length > Math.ceil(MAX_QR_BYTES / 3) * 4) throw error(413, 'Ảnh QR tối đa 50 MB.');
  // A canonical round trip validates Base64 without a large capturing regex.
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw error(400, 'Dữ liệu ảnh QR không hợp lệ.');
  if (!bytes.length || bytes.length > MAX_QR_BYTES) throw error(413, 'Ảnh QR tối đa 50 MB.');
  const valid = match[1] === 'png'
    ? bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR'
    : match[1] === 'jpeg'
      ? bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217
      : bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16)) && bytes.readUInt32LE(4) + 8 === bytes.length;
  if (!valid) throw error(400, 'Nội dung ảnh không khớp định dạng PNG, JPEG hoặc WebP.');
  return { bytes, mime: `image/${match[1]}` };
}

export function isCloudinaryQr(image, { cloudName, folder = 'lucky-money/qr' } = {}) {
  if (!image || typeof image !== 'object' || Array.isArray(image) || typeof image.url !== 'string' || typeof image.publicId !== 'string' || image.url.length > 1000 || image.publicId.length > 300) return false;
  if (!image.publicId.startsWith(`${folder}/`) || !/^[A-Za-z0-9_/-]+$/.test(image.publicId) || image.publicId.includes('..')) return false;
  try {
    const url = new URL(image.url);
    if (url.protocol !== 'https:' || url.host !== 'res.cloudinary.com' || url.username || url.password || url.search || url.hash) return false;
    const segments = decodeURIComponent(url.pathname).split('/').filter(Boolean);
    if (cloudName && segments[0] !== cloudName) return false;
    if (segments[1] !== 'image' || segments[2] !== 'upload') return false;
    const resource = segments.slice(3).filter((part, index) => !(index === 0 && /^v\d+$/.test(part))).join('/');
    return resource.replace(/\.(png|jpe?g|webp)$/i, '') === image.publicId;
  } catch { return false; }
}

export function createCloudinaryUploader(options = {}) {
  const cloudName = options.cloudName ?? process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = options.apiKey ?? process.env.CLOUDINARY_API_KEY;
  const apiSecret = options.apiSecret ?? process.env.CLOUDINARY_API_SECRET;
  const folder = options.folder || process.env.CLOUDINARY_FOLDER || 'lucky-money/qr';
  const fetcher = options.fetch || globalThis.fetch;
  return async (image, { purpose = 'player', decodedImage } = {}) => {
    const { bytes, mime } = decodedImage || decodeQrImage(image);
    if (!cloudName || !apiKey || !apiSecret || !/^[A-Za-z0-9_-]+$/.test(cloudName) || !/^[A-Za-z0-9_/-]+$/.test(folder) || folder.includes('..') || folder.startsWith('/') || folder.endsWith('/')) {
      throw error(503, 'Chưa cấu hình Cloudinary. Vui lòng điền CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET và CLOUDINARY_FOLDER trong .env.', 'QR_UPLOAD_AUTH');
    }
    const publicId = `${folder}/${purpose === 'admin' ? 'admin' : 'player'}/${randomUUID()}`;
    const params = { overwrite: 'false', public_id: publicId, timestamp: String(Math.floor(Date.now() / 1000)) };
    const signature = createHash('sha1').update(Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('&') + apiSecret).digest('hex');
    const form = new FormData();
    for (const [key, value] of Object.entries({ ...params, api_key: apiKey, signature })) form.set(key, value);
    // Binary multipart avoids Cloudinary's smaller size limit for Base64 data URIs.
    form.set('file', new Blob([bytes], { type: mime }), `qr.${mime.split('/')[1]}`);
    let response;
    try {
      response = await fetcher(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
    } catch (failure) {
      if (failure.name === 'TimeoutError' || failure.name === 'AbortError' || ['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT'].includes(failure.cause?.code || failure.code)) throw error(504, 'Cloudinary phản hồi quá chậm. Hãy kiểm tra kết nối mạng của máy chủ rồi tải lại ảnh.', 'QR_UPLOAD_TIMEOUT');
      throw error(502, 'Máy chủ chưa kết nối được Cloudinary. Bạn thử lại; nếu vẫn lỗi, người tổ chức cần kiểm tra kết nối mạng của server.', 'QR_UPLOAD_NETWORK');
    }
    let body;
    try { body = await response.json(); } catch {}
    if (!response.ok) throw providerError(response.status, typeof body?.error?.message === 'string' ? body.error.message : response.headers?.get?.('x-cld-error') || '');
    const uploaded = { url: body?.secure_url, publicId: body?.public_id };
    if (uploaded.publicId !== publicId || body?.resource_type !== 'image' || !isCloudinaryQr(uploaded, { cloudName, folder })) throw error(502, 'Cloudinary trả về ảnh không hợp lệ. Vui lòng tải lại ảnh hoặc báo người tổ chức kiểm tra cấu hình.', 'QR_UPLOAD_RESPONSE');
    return uploaded;
  };
}
