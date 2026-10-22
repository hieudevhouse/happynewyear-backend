# Deploy backend trên Vercel

Repo backend: [happynewyear-backend](https://github.com/hieudevhouse/happynewyear-backend). Frontend được deploy ở project riêng.

## Cấu hình project

Import repo backend vào Vercel, hoặc mở **Settings → Build and Deployment** của project đã có:

| Mục | Giá trị |
| --- | --- |
| Root Directory | `./` — repo này đã chứa backend ở thư mục gốc |
| Framework Preset | Express nếu có; để Vercel tự nhận diện Express |
| Node.js Version | `22.x`, khớp `engines.node` trong `package.json` |
| Build Command | Tắt override, dùng mặc định của framework |
| Output Directory | Tắt override, không đặt `dist` hoặc `frontend/dist` |
| Install Command | Mặc định của Vercel; repo dùng npm và có `package-lock.json` |

`server.js` import Express và export default app để Vercel nhận diện entry point. Vercel triển khai toàn bộ Express app thành một Function. Không đặt `npm start` làm Build Command; không cần mở cổng hoặc tự đặt `PORT` trên Vercel. `npm start` và `PORT=4000` vẫn dùng được khi chạy local/VPS. Xem [Express trên Vercel](https://vercel.com/docs/frameworks/backend/express) và [hướng dẫn triển khai Express](https://vercel.com/kb/guide/ship-a-express-app-on-vercel).

Chọn Node `22.x` để dùng cùng phiên bản major với repo. `engines.node` trong `package.json` có thể ghi đè lựa chọn trên dashboard; kiểm tra phiên bản thực tế trong Build Logs. Xem [Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions).

## Biến môi trường

Mở **Settings → Environment Variables**, tạo các biến sau cho **Production**, và thêm **Preview** nếu muốn dùng deployment thử nghiệm. `.env` ở máy local không được commit nên không tự xuất hiện trên Vercel.

| Biến | Giá trị cần nhập |
| --- | --- |
| `NODE_ENV` | `production` |
| `MONGO_URI` | Connection string MongoDB có thể truy cập từ Vercel; không dùng `localhost`/`127.0.0.1` |
| `ADMIN_USERNAME` | Tên tài khoản quản trị của ứng dụng |
| `ADMIN_PASSWORD` | Mật khẩu riêng, ít nhất 12 ký tự |
| `CLIENT_ORIGIN` | Origin FE chính xác, ví dụ `https://ten-frontend.vercel.app`; không có path hoặc dấu `/` cuối |
| `COOKIE_SECURE` | `true` |
| `COOKIE_SAME_SITE` | `none` nếu FE và BE ở hai site khác nhau, ví dụ hai project `*.vercel.app` |
| `TRUST_PROXY` | `1` khi request đến app trực tiếp qua proxy Vercel |
| `CLOUDINARY_CLOUD_NAME` | Cloud name của tài khoản Cloudinary nếu dùng upload QR |
| `CLOUDINARY_API_KEY` | API key Cloudinary, chỉ lưu ở backend |
| `CLOUDINARY_API_SECRET` | API secret Cloudinary, chỉ lưu ở backend |
| `CLOUDINARY_FOLDER` | Tùy chọn, mặc định `lucky-money/qr` |

`CLIENT_ORIGIN` hỗ trợ nhiều origin ngăn cách bằng dấu phẩy. Với FE dùng custom domain, nhập origin custom domain đang truy cập. Cookie giữa hai site cần HTTPS và `SameSite=None`; một số trình duyệt vẫn chặn cookie bên thứ ba. Nếu FE/BE dùng HTTPS trên các subdomain cùng site, có thể dùng `COOKIE_SAME_SITE=lax`.

`TRUST_PROXY=1` tương ứng tin một hop proxy gần Express. Vercel đặt `X-Forwarded-For` và `X-Forwarded-Proto`; nếu thêm CDN/proxy khác phía trước, cần kiểm tra lại đường đi request và số hop. Xem [Vercel request headers](https://vercel.com/docs/headers/request-headers) và [Express behind proxies](https://expressjs.com/en/guide/behind-proxies/).

Sau khi thêm hoặc sửa biến môi trường, **Redeploy** để tạo deployment mới. Vercel không áp dụng thay đổi env vào deployment cũ. Xem [Environment variables](https://vercel.com/docs/environment-variables).

FE cần `VITE_API_BASE_URL=https://<domain-backend>/api`, sau đó build/deploy lại FE. Không đưa `MONGO_URI`, mật khẩu quản trị hoặc Cloudinary secret vào biến `VITE_*`.

## MongoDB Atlas

Dùng database user của Atlas có quyền trên database ứng dụng, không dùng mật khẩu tài khoản đăng nhập trang Atlas. Kiểm tra cluster đang hoạt động, connection string đúng, và **Network Access / IP Access List** cho phép kết nối từ môi trường Vercel. Thêm IP máy local không đồng nghĩa cho phép Vercel. Atlas chỉ nhận kết nối từ IP trong access list. Xem [Atlas IP Access List](https://www.mongodb.com/docs/atlas/security/ip-access-list/).

Vercel dùng IP outbound động theo mặc định. Nếu cần giới hạn IP cụ thể, cấu hình Static IPs hoặc Secure Compute rồi allowlist đúng IP outbound đó trong Atlas. Xem [Vercel outbound IP allowlisting](https://vercel.com/kb/guide/how-to-allowlist-deployment-ip-address).

Atlas native integration với Vercel có thể tự thêm `0.0.0.0/0`: cấu hình này cho phép mọi địa chỉ IPv4 thử kết nối đến database, dù vẫn cần xác thực. Chỉ chọn sau khi chấp nhận phạm vi truy cập đó, dùng mật khẩu mạnh và database user có quyền cần thiết; ưu tiên giới hạn IP khi hạ tầng cho phép. Nếu integration tạo biến tên khác, đặt giá trị connection string tương ứng vào **`MONGO_URI`**, vì đây là tên app đọc. Xem [Atlas integration với Vercel](https://www.mongodb.com/docs/atlas/reference/partner-integrations/vercel/).

## Kiểm tra và đọc lỗi

Sau khi deploy, gọi:

```bash
curl -i https://<domain-backend>/health
curl -i https://<domain-backend>/api/health
```

Hai endpoint hỗ trợ `GET`/`HEAD`, không yêu cầu đăng nhập và không cache:

- `200`, `{"ok":true,"database":"connected"}`: ứng dụng và MongoDB đã sẵn sàng.
- `503`, `{"ok":false,"database":"unavailable"}`: cấu hình hoặc database chưa sẵn sàng; kiểm tra Runtime Logs trước khi thử lại.

Nếu quá trình khởi tạo thất bại, JSON `503` có thêm `code` để phân biệt:

| `code` | Cần kiểm tra |
| --- | --- |
| `API_CONFIGURATION_ERROR` | `MONGO_URI`, `ADMIN_USERNAME`, `ADMIN_PASSWORD` (ít nhất 12 ký tự), origin, cookie và proxy; Runtime Logs ghi tên biến cần kiểm tra, không ghi giá trị bí mật |
| `DATABASE_UNAVAILABLE` | Connection string, trạng thái cluster, Network Access và quyền database user; lỗi cũng có thể xảy ra khi tạo index hoặc khởi tạo dữ liệu |
| `API_INITIALIZATION_ERROR` | Lỗi tạo ứng dụng sau khi kết nối database; đối chiếu bản code và cấu hình backend |

Ứng dụng khởi tạo MongoDB khi có request và dùng lại kết nối trong cùng instance. Lỗi cấu hình/kết nối được trả thành `503` thay vì làm entry point crash. Khi khởi tạo thành công, `/` trả `404` vì repo chỉ phục vụ API; dùng `/health` để kiểm tra.

`500 FUNCTION_INVOCATION_FAILED` là lỗi Function không thực thi thành công; mã `hkg1::...` chỉ giúp đối chiếu request, chưa cho biết nguyên nhân. Mở project → **Logs**, lọc đúng deployment/domain và thời điểm, gọi lại `/health`, rồi xem log của request đó. Build Logs chỉ cho biết quá trình build; lỗi runtime cần xem Runtime Logs. Khi chia sẻ log, bỏ connection string, mật khẩu và token. Xem [Runtime Logs](https://vercel.com/docs/logs/runtime) và [FUNCTION_INVOCATION_FAILED](https://vercel.com/docs/errors/function_invocation_failed).

Khi đưa bản sửa entry point lên Git, cần có cả `server.js`, `src/runtime.js` và `src/mongo-store.js`. Nếu bỏ sót file mới `src/runtime.js`, import sẽ thất bại trước khi ứng dụng có thể trả JSON `503`. Trong **Deployments**, kiểm tra deployment Production đã dùng đúng commit chứa bản sửa. Redeploy commit cũ không đưa các thay đổi còn ở máy local lên Vercel.

## Giới hạn upload QR

Vercel Function giới hạn request body **4.5 MB**, dù Express trong repo cho phép `70mb`. Ảnh dạng base64 còn làm payload lớn hơn file gốc. Nếu gặp `413 FUNCTION_PAYLOAD_TOO_LARGE`, giảm kích thước ảnh/payload; ảnh lớn cần luồng upload trực tiếp lên dịch vụ lưu trữ với xác thực phù hợp, hoặc deploy backend ở server có giới hạn body phù hợp. Tăng limit Express không nâng được giới hạn của Vercel. Xem [Function limits](https://vercel.com/docs/functions/limitations) và [FUNCTION_PAYLOAD_TOO_LARGE](https://vercel.com/docs/errors/function_payload_too_large).
