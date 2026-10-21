# LuckyMoney Backend

API Express/Mongoose cho LuckyMoney 2027, quản lý mã quay, phiên đăng nhập, phần thưởng và QR nhận tiền. Frontend được deploy riêng từ [happynewyear](https://github.com/hieudevhouse/happynewyear).

## Chạy ứng dụng

Cần Node.js từ `22.11.0` trở lên và MongoDB.

```bash
npm ci --omit=dev
npm run setup
```

Sửa `.env` vừa tạo: điền `MONGO_URI`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` và `CLIENT_ORIGIN`. Mật khẩu quản trị cần ít nhất 12 ký tự. Nếu dùng tải QR, điền thêm `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`. File `.env.example` chỉ chứa cấu hình mẫu; không commit `.env` thật.

```bash
npm start
```

API mặc định chạy trên cổng `4000`. Kiểm tra tại `http://localhost:4000/api/health`.

```bash
npm test
```

Để phát triển có tự khởi động lại khi sửa code, dùng `npm run dev`.

## Kết nối frontend trên server riêng

Ví dụ frontend là `https://app.example.com`, API là `https://api.example.com/api`:

```dotenv
NODE_ENV=production
PORT=4000
CLIENT_ORIGIN=https://app.example.com
COOKIE_SECURE=true
COOKIE_SAME_SITE=lax
TRUST_PROXY=1
```

`CLIENT_ORIGIN` phải khớp chính xác origin frontend, gồm scheme và port nếu có, không có đường dẫn hay dấu `/` cuối. Nhiều origin ngăn cách bằng dấu phẩy. Frontend cấu hình `VITE_API_BASE_URL=https://api.example.com/api` rồi build lại.

Hai hostname cùng site và dùng HTTPS như ví dụ có thể dùng `COOKIE_SAME_SITE=lax`. Nếu frontend/API ở hai site khác nhau, dùng `COOKIE_SAME_SITE=none` với `COOKIE_SECURE=true`; trình duyệt có thể chặn cookie bên thứ ba. Có thể cho Nginx phía frontend proxy `/api` sang server backend để phiên dùng cùng hostname với frontend.

`TRUST_PROXY=1` dành cho một reverse proxy trước Express như mẫu Nginx đi kèm. Khi chạy API trực tiếp không qua proxy, dùng `0`. Nếu có nhiều proxy, đặt số hop phù hợp.

## Deploy Linux với Nginx và systemd

Checkout repo vào `/srv/luckymoney/backend`, cài dependencies và cấu hình `.env` như trên. Tạo user/group `luckymoney` có quyền đọc code và `.env`. Hai file mẫu:

- [deploy/nginx-backend.conf](deploy/nginx-backend.conf): đổi hostname và đường dẫn chứng chỉ TLS; proxy `/api/` tới Node tại `127.0.0.1:4000`, giới hạn request body `70m` cho ảnh QR.
- [deploy/luckymoney-backend.service](deploy/luckymoney-backend.service): đổi thư mục checkout, user/group và đường dẫn Node nếu khác mẫu.

```bash
sudo cp deploy/luckymoney-backend.service /etc/systemd/system/luckymoney-backend.service
sudo systemctl daemon-reload
sudo systemctl enable --now luckymoney-backend
sudo systemctl status luckymoney-backend

sudo cp deploy/nginx-backend.conf /etc/nginx/sites-available/luckymoney-backend
sudo ln -s /etc/nginx/sites-available/luckymoney-backend /etc/nginx/sites-enabled/luckymoney-backend
sudo nginx -t
sudo systemctl reload nginx
curl https://api.example.com/api/health
```

Cho backend kết nối tới MongoDB và Cloudinary. Chỉ cho proxy/mạng nội bộ truy cập cổng Node `4000`. Sau khi đổi code hoặc `.env`, chạy `sudo systemctl restart luckymoney-backend`.
