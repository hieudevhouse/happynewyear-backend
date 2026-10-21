import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const localPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(localPath)) {
  console.log('.env đã có sẵn; giữ nguyên cấu hình hiện tại.');
} else {
  const example = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
  const configured = example.replace(/^ADMIN_PASSWORD=.*$/m, `ADMIN_PASSWORD=${randomBytes(24).toString('hex')}`);
  writeFileSync(localPath, configured, { flag: 'wx', mode: 0o600 });
  console.log('Đã tạo .env với mật khẩu quản trị ngẫu nhiên. Điền MONGO_URI trước khi chạy.');
  console.log('Tài khoản đăng nhập nằm ở ADMIN_USERNAME và ADMIN_PASSWORD trong .env.');
}
