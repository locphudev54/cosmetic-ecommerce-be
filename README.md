# Cosmetic Ecommerce — Server

REST API NestJS cho cửa hàng mỹ phẩm và quản trị catalog/đơn hàng. Server lưu nghiệp vụ bằng PostgreSQL/Prisma; dùng Redis cho authentication, lock/idempotency đơn hàng và queue email; tìm kiếm Elasticsearch, upload Cloudinary và thanh toán VNPay. Giao diện nằm trong repository [client](../client/README.md).

Tài liệu dựa trên source code, scripts, cấu hình và `.env.example`; không lấy giá trị từ `.env`, `.env.prod` hoặc credentials. Ví dụ credential đều là placeholder.

## Mục lục

- [Phạm vi và công nghệ](#phạm-vi-và-công-nghệ)
- [Kiến trúc và dữ liệu](#kiến-trúc-và-dữ-liệu)
- [API, authentication và lỗi](#api-authentication-và-lỗi)
- [Cài đặt và chạy local](#cài-đặt-và-chạy-local)
- [Biến môi trường](#biến-môi-trường)
- [Các lệnh có sẵn](#các-lệnh-có-sẵn)
- [Docker và triển khai](#docker-và-triển-khai)
- [Xử lý sự cố](#xử-lý-sự-cố)
- [Kiểm chứng và đề xuất](#kiểm-chứng-và-đề-xuất)

## Phạm vi và công nghệ

- Auth: đăng ký/đăng nhập, refresh/logout, đổi/quên/đặt lại mật khẩu, Google/Facebook OAuth, truy vấn user hiện tại.
- Catalog: sản phẩm, biến thể, category dạng cây, attributes/values, brands, country of origin, collections; tìm kiếm/lọc/phân trang qua Elasticsearch.
- Giỏ hàng guest/user, merge khi đăng nhập, thông báo thay đổi bằng Socket.IO.
- Đặt hàng user/guest, phí vận chuyển, danh sách/chi tiết/hủy/cập nhật trạng thái đơn và URL thanh toán VNPay. Có template/queue handler email xác nhận, nhưng lời gọi enqueue sau tạo đơn đang comment, chưa tự gửi từ luồng này.
- Upload ảnh Cloudinary, queue email Bull và templates React Email/Handlebars.

Sự tồn tại của model kho/supplier không chứng minh đã có API quản lý kho hoàn chỉnh. Không có controller riêng cho mọi model database; các luồng tích hợp chưa được kiểm thử runtime trong lần khảo sát này.

| Công nghệ | Phiên bản khai báo / vai trò |
| --- | --- |
| Node.js | **24.x**, yêu cầu `engines` trong package.json; Docker dùng Node 24 |
| NestJS / TypeScript | core/common `11.0.12`, TypeScript `5.8.3`, Express adapter |
| Prisma / PostgreSQL | Prisma và adapter-pg `^7.5.0`; schema provider `postgresql` |
| Redis / Bull | ioredis `^5.9.2`, Bull `^4.16.5` |
| Elasticsearch | Client `^8.19.1`, Nest integration `^11.1.0` |
| Authentication | Passport JWT/Google/Facebook, bcrypt, Nest JWT |
| API / validation | Swagger `11.0.7`, class-validator, class-transformer, Joi |
| Tích hợp | Socket.IO `4.8.1`, Cloudinary, Nodemailer/Mailer, React Email, VNPay |
| Vận hành / kiểm tra | Winston, Helmet, Jest 29, ESLint 9, Prettier 3 |

Có npm lockfile, không có `packageManager` bắt buộc phiên bản npm. PostgreSQL/Redis chưa được khóa phiên bản server; Elasticsearch client thuộc dòng 8.x nhưng chưa có bằng chứng về phiên bản cluster triển khai. Maintainer cần xác nhận ma trận dịch vụ hỗ trợ.

## Kiến trúc và dữ liệu

```mermaid
flowchart LR
  Client[Next.js / browser] -->|REST /api/v1 + Bearer| Controller[Controllers + DTO]
  Controller --> Services[Domain services]
  Services --> Prisma[PrismaService + adapter-pg]
  Prisma --> PG[(PostgreSQL)]
  Services --> Redis[(Redis: tokens, locks, idempotency)]
  Services --> ES[(Elasticsearch: product index)]
  Services --> Cloud[Cloudinary]
  Services --> Pay[VNPay]
  Services --> Queue[Bull email queue]
  Queue --> SMTP[EmailProcessor / SMTP]
  Client <-->|Socket.IO /cart| Gateway[CartGateway]
```

`AppModule` ghép các domain và cấu hình Bull. `CoreModule` nạp env/Joi, config namespaces, global JWT/role guards, ValidationPipe, response/logging interceptors và exception filter. RequestLoggerMiddleware áp dụng toàn ứng dụng. `DatabaseModule` cung cấp Prisma và Redis toàn cục.

| Đường dẫn | Trách nhiệm |
| --- | --- |
| `src/main.ts` | Bootstrap, prefix/version URI, CORS, Helmet, Swagger, cookies, static assets |
| `src/domains/` | auth, users, products, categories, attributes, brands, country-of-origin, collections, cart, orders, payment, search, upload, email |
| Domain controller / DTO / service | HTTP contract / input validation / nghiệp vụ và truy vấn dữ liệu; products tách thêm validate/update/find-all services |
| `src/core/` | Guards, decorators, filters, interceptors, pipes, DTO chung, Redis locks |
| `src/config/` | Config factories, schema môi trường, CORS/JWT/Swagger/Winston |
| `src/database/` | Prisma lifecycle và ioredis provider |
| `src/emails/`, `src/domains/email/templates/` | React Email, Handlebars templates; Nest build copy .hbs theo nest-cli.json |
| `src/enums/`, `types/`, `utils/` | Kiểu, enum và utilities; import alias dựa trên src |
| `prisma/schema.prisma`, `prisma/migrations/` | Model và lịch sử migration PostgreSQL |
| `prisma.config.ts` | Nạp dotenv/config, schema/migrations path và DATABASE_URL cho Prisma CLI |
| `postman/` | API collection, cần kiểm tra lại trước sử dụng |
| `api/index.ts`, `vercel.json`, `Dockerfile` | Entry/config triển khai có trong repo, chưa xác minh deployment |
| `uploads/`, `public/`, `logs/` | File/tài nguyên/log; cấu hình static thực tế nằm trong bootstrap |

Nhóm dữ liệu chính: Product/Variant/Image, Category/ProductCategory, Attribute/Value/VariantAttributeValue, Brand/CountryOfOrigin, Collection và bảng liên kết; User/Address/RefreshToken/PasswordResetToken; Cart/CartItem; Order/OrderDetail/ShippingInfo. Schema còn có StockBatch, Supplier, Inbound/Outbound transactions, Folder/File. Xem [schema](prisma/schema.prisma) để biết quan hệ và constraints.

Cart hiện thao tác qua Prisma; `CartRedisService` và đăng ký provider đã comment, không coi cart cache Redis là tính năng đang chạy. Redis vẫn phục vụ auth, locks, orders và Bull. `ProductsModule` import `SearchModule`, nên Elasticsearch thuộc luồng bootstrap; SearchService tạo product index nếu chưa có.

## API, authentication và lỗi

Với cấu hình local bên dưới:

- REST base URL: `http://localhost:8000/api/v1`.
- Swagger: `http://localhost:8000/docs` nếu `SWAGGER_ENABLED=true`; controller/Swagger là nguồn contract hiện hành.
- Socket.IO namespace: `http://localhost:8000/cart`, nhận JWT qua `auth.token`.
- Browser gọi API trực tiếp; Next.js Route Handlers `/api/auth/*` gọi lại server để quản lý cookie/refresh token. Xem [kiến trúc client](../client/README.md#kiến-trúc-và-cấu-trúc).

| Nhóm | Endpoint tiêu biểu, tương đối với /api/v1 |
| --- | --- |
| Kiểm tra HTTP | `GET /`, response chứa data.name; không phải readiness database |
| Auth | `POST /auth/register`, `/auth/login`, `/auth/refresh-token`, `/auth/logout`, `/auth/change-password`, `/auth/forgot-password`, `/auth/reset-password`; `GET /auth/me` |
| OAuth | `GET /auth/google`, `/auth/google/callback`, `/auth/facebook`, `/auth/facebook/callback` |
| Catalog | `/products`, `/products/by-slug/:slug`, `/categories`, `/categories/tree`, `/brands`, `/attributes`, `/country-of-origin`, `/collections`, `/collections/slug/:slug` |
| Search | `POST /search/products`, `POST /search/reindex` (reindex xóa/tạo lại index) |
| Cart | `GET /cart`, `POST /cart/items`, `PATCH/DELETE /cart/items/:item_id`, `POST /cart/items/bulk-delete`, `POST /cart/merge` |
| Orders | `POST/GET /orders`, `POST /orders/guest`, `GET /orders/shipping-fee`, `GET /orders/:id`, `POST /orders/:id/cancel`, `PATCH /orders/:id/status` |
| Payment | `POST /payment/create`, `GET /payment/vnpay-return`, `GET /payment/vnpay-ipn` |
| Upload / Users | `POST /upload/single`, `/upload/multiple`, `DELETE /upload`; `POST/GET /users`, `GET/PATCH/DELETE /users/:id` |

Danh sách chỉ để định hướng, không khẳng định mọi phương thức CRUD tồn tại cho mọi nhóm. Một số constants client chưa có controller hoặc handler đang comment. Chưa thấy controller `/health` dù có Terminus dependency và client constant.

JWT guard mặc định yêu cầu `Authorization: Bearer <access-token>`; `@Public()` cho phép route công khai, cart dùng optional JWT cho guest. JWT strategy kiểm tra blacklist/token version trong Redis và trạng thái user. Refresh token có model PostgreSQL. `RolesGuard` chỉ hạn chế role khi có `@Roles`; không có annotation thì guard không tự giới hạn ADMIN. Ví dụ cập nhật trạng thái đơn khai báo ADMIN/STAFF; controller danh sách đơn ép CUSTOMER lọc theo user hiện tại. Cần xem từng controller/service khi đánh giá role và ownership, không coi mọi API quản trị đã được bảo vệ theo role.

ValidationPipe loại field không có decorator, transform DTO, trả HTTP 422 khi input không hợp lệ. Response thường có `success`, `statusCode`, `message`, `data`, `timestamp`, thêm `meta` khi phân trang. Exception filter trả `success=false`, `statusCode`, `message`, `error`, `path`, `timestamp`, có thể có `requestId`/`details`; production ẩn chi tiết lỗi nội bộ. Callback dùng Express response có redirect riêng.

## Cài đặt và chạy local

### 1. Chuẩn bị

Cài Node 24.x, npm, PostgreSQL, Redis, Elasticsearch phù hợp client 8.x. Chuẩn bị database/user có quyền tạo bảng; `migrate:dev` cần quyền shadow database. Không có Docker Compose hoặc script provisioning dịch vụ trong repository.

Google/Facebook strategies và VNPay client được tạo khi bootstrap, chưa có feature flag tắt riêng. Cần điền cấu hình constructor hợp lệ ngay cả khi chưa thử OAuth/thanh toán. Placeholder chỉ minh họa, không chứng minh tích hợp hoạt động. SMTP/Cloudinary cần tài khoản hoặc sandbox để gửi mail/upload.

Clone từ Git remote (SSH cần quyền và key):

```bash
mkdir cosmetic-ecommerce
cd cosmetic-ecommerce
git clone git@github.com:phulocdev/cosmetic-ecommerce-be.git server
git clone git@github.com:phulocdev/cosmetic-ecommerce-fe.git client
cd server
```

Nếu workspace đã có hai thư mục, chỉ cần vào `server`.

### 2. Tạo môi trường và cài dependencies

Trong PowerShell, nếu chưa có `.env`:

```powershell
Copy-Item .env.example .env
```

Chỉnh `.env` **trước `npm ci`**, vì postinstall chạy Prisma generate và Prisma config nạp env. Trên host, đổi database/Redis hostname `host.docker.internal` thành `localhost`; đổi `NODE_ENV=production` của mẫu thành development. Ví dụ các giá trị cần chỉnh, không thay thế toàn bộ bảng biến ở phần sau:

```dotenv
NODE_ENV=development
APP_PORT=8000
API_PREFIX=api
APP_URL=http://localhost:8000
DATABASE_URL=postgresql://local_user:local_password@localhost:5432/cosmetic_ecommerce?schema=public
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_DB=0
CLIENT_APP_URL=http://localhost:3000
CORS_ORIGIN=http://localhost:3000
JWT_ACCESS_SECRET=replace-with-your-own-access-secret-32-plus-characters
JWT_REFRESH_SECRET=replace-with-your-own-refresh-secret-32-plus-characters
ELASTICSEARCH_NODE=http://localhost:9200
ELASTICSEARCH_USERNAME=replace-with-local-es-user
ELASTICSEARCH_PASSWORD=replace-with-local-es-password
GOOGLE_CLIENT_ID=replace-with-google-client-id
GOOGLE_CLIENT_SECRET=replace-with-google-client-secret
GOOGLE_CALLBACK_URL=http://localhost:8000/api/v1/auth/google/callback
FACEBOOK_APP_ID=replace-with-facebook-app-id
FACEBOOK_APP_SECRET=replace-with-facebook-app-secret
FACEBOOK_CALLBACK_URL=http://localhost:8000/api/v1/auth/facebook/callback
IDEMPOTENCY__REDIS_TTL=1d
CART_COOKIE_MAX_AGE=30d
VNPAY_TMN_CODE=replace-with-sandbox-merchant-code
VNPAY_HASH_SECRET=replace-with-sandbox-hash-secret
VNPAY_HOST=https://sandbox.vnpayment.vn
VNPAY_RETURN_URL=http://localhost:8000/api/v1/payment/vnpay-return
```

Duration có đơn vị vì code dùng `ms()`; chuỗi số không đơn vị trong mẫu có thể bị hiểu là milliseconds. Điền thông số sandbox riêng trước khi thử tích hợp.

```bash
npm ci
```

Nest nạp `.env.${process.env.NODE_ENV}` rồi `.env`; tên file phụ thuộc NODE_ENV có sẵn khi process bắt đầu. Prisma CLI dùng dotenv/config trong prisma.config.ts, không mặc định có cùng cơ chế chọn env như Nest. Không ghi đè env đang có hoặc commit bí mật.

### 3. Tạo database và áp dụng migrations

Ví dụ chạy trong psql bằng tài khoản quản trị PostgreSQL; thay user/password bằng thông tin local:

```sql
CREATE USER local_user WITH PASSWORD 'local_password';
CREATE DATABASE cosmetic_ecommerce OWNER local_user;
```

Khi database hoạt động và DATABASE_URL đúng, trong `server`:

```bash
npm run migrate:deploy
npm run prisma:generate
```

`migrate:deploy` áp dụng migrations đã commit, khởi tạo database local mà không tạo migration mới. Khi phát triển thay đổi schema, dùng `npm run migrate:dev` với shadow database. Không có seed script/cấu hình seed hay dữ liệu admin/demo đã xác minh. Database mới có thể không có sản phẩm hoặc tài khoản quản trị; cần maintainer cung cấp dữ liệu mẫu và cách cấp role.

### 4. Khởi động và kiểm tra

Khởi động Redis/Elasticsearch, sau đó:

```bash
npm run dev
```

Mở Swagger tại `http://localhost:8000/docs`. Kiểm tra HTTP bằng PowerShell:

```powershell
Invoke-RestMethod http://localhost:8000/api/v1
Invoke-RestMethod http://localhost:8000/api/v1/products
```

Request đầu kiểm tra HTTP process, products kiểm tra đường truy vấn catalog. Đối chiếu log database/Redis/Elasticsearch: HTTP lên không chứng minh mọi dịch vụ sẵn sàng vì PrismaService bắt lỗi kết nối và SearchService bắt lỗi tạo index. Sau đó chạy [client](../client/README.md), kiểm tra đăng nhập/catalog/giỏ hàng. Endpoint `test-email` không xác nhận SMTP vì phần gửi mail đang comment.

## Biến môi trường

Nguồn: [.env.example](.env.example), [Joi schema](src/config/validation.schema.ts) và consumer trong code. “Theo tính năng” không có nghĩa đã có chế độ tắt module.

| Biến / nhóm | Yêu cầu, mục đích và ví dụ an toàn |
| --- | --- |
| `DATABASE_URL` | Bắt buộc Joi/Prisma; URL PostgreSQL như ví dụ local |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Phải tự đặt; refresh bắt buộc ≥32 ký tự theo Joi; access được JWT strategy đọc trực tiếp dù Joi chưa khai báo |
| `JWT_ACCESS_EXPIRATION`, `JWT_REFRESH_EXPIRATION` | Tùy chọn, mặc định 15m, 7d |
| `JWT_ISSUER`, `JWT_AUDIENCE` | Có mặc định, định danh issuer/audience |
| `NODE_ENV` | development/production/test/staging, mặc định development theo Joi |
| `APP_NAME`, `APP_PORT`, `APP_URL` | Tên ứng dụng, cổng, URL; local chọn 8000, config mặc định cổng 3000 nếu bỏ trống |
| `PORT` | Không có trong mẫu; nếu có sẽ ưu tiên hơn APP_PORT trong main.ts |
| `APP_HOST`, `API_PREFIX`, `API_VERSION` | Có mặc định; bootstrap thực tế listen 0.0.0.0 và version hardcode v1, đổi APP_HOST/API_VERSION không đổi hai hành vi này |
| `CLIENT_APP_URL` | URL client, mặc định http://localhost:3000; dùng liên kết reset password trong email. Redirect OAuth và payment hiện lấy cors.origin |
| `CORS_ENABLED`, `CORS_ORIGIN` | Mặc định bật, ví dụ origin http://localhost:3000; gửi credentials |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_DB` | Redis cho auth/queue/locks/orders; local localhost, 6379, DB 0; password có thể trống, nên khai báo DB rõ ràng |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALLBACK_URL` | Bắt buộc Joi; callback server /api/v1/auth/google/callback; cần đăng ký với provider để OAuth hoạt động |
| `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `FACEBOOK_CALLBACK_URL` | Không có Joi validation nhưng strategy tạo vô điều kiện; giá trị trống có thể chặn bootstrap; callback /api/v1/auth/facebook/callback |
| `ELASTICSEARCH_NODE`, `ELASTICSEARCH_USERNAME`, `ELASTICSEARCH_PASSWORD` | SearchModule đọc trực tiếp; node URL hợp lệ như http://localhost:9200, auth theo cluster; không có Joi validation |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Joi cho phép trống, cần credential hợp lệ để upload; ví dụ placeholder replace-me |
| `EMAIL_HOST`, `EMAIL_SENDER`, `EMAIL_APP_PASSWORD`, `EMAIL_PORT`, `EMAIL_SECURE` | SMTP; ví dụ smtp.example.com, no-reply@example.com, replace-me, 587, false; Joi cho password trống nhưng gửi mail cần cấu hình phù hợp |
| `VNPAY_TMN_CODE`, `VNPAY_HASH_SECRET`, `VNPAY_HOST`, `VNPAY_RETURN_URL` | Cấu hình merchant/sandbox cho VNPay client và URL thanh toán; server return callback /api/v1/payment/vnpay-return |
| `VNPAY_URL`, `VNPAY_IPN_URL` | Có trong mẫu, chưa thấy consumer; IPN controller thực tế /api/v1/payment/vnpay-ipn, khác /payment/vnpay/ipn trong mẫu; cần đăng ký IPN đúng với provider |
| `IDEMPOTENCY__REDIS_TTL` | Giữ nguyên hai dấu gạch dưới; orders dùng ms() rồi đổi sang giây; dùng 1d thay chuỗi số 86400 trong mẫu |
| `CART_COOKIE_MAX_AGE` | Cart cookie đọc bằng ms(); dùng 30d thay chuỗi số 2592000 trong mẫu |
| `GUEST_CART_REDIS_TTL`, `AUTH_CART_REDIS_TTL` | Có trong mẫu, consumer cart Redis đang comment; chưa tác động cache cart đang chạy |
| `SWAGGER_ENABLED`, `SWAGGER_TITLE`, `SWAGGER_DESCRIPTION`, `SWAGGER_VERSION`, `SWAGGER_PATH` | Có mặc định; ví dụ true, path docs |
| `BCRYPT_SALT_ROUNDS` | Joi 10–14, mặc định 12; một số hàm hash có default riêng, không khẳng định biến điều khiển mọi thao tác hash |
| `LOGIN_ATTEMPTS_WINDOW_SECONDS`, `MAX_LOGIN_ATTEMPTS` | Cửa sổ và giới hạn đăng nhập, mẫu 900 và 5 |
| `THROTTLE_TTL`, `THROTTLE_LIMIT` | Cấu hình ThrottlerModule, mẫu 60000 và 100; chưa thấy global ThrottlerGuard nên không coi rate limit mọi request đã bật |
| `LOG_LEVEL`, `LOG_FORMAT` | Ví dụ debug; Winston chọn format theo NODE_ENV, chưa thấy LOG_FORMAT điều khiển formatter |
| `MAX_FILE_SIZE`, `UPLOAD_DEST` | Mẫu 10485760 bytes, ./uploads; xem pipe/controller cho từng endpoint |
| `APP_STATIC_ASSETS_PREFIX`, `APP_ASSET_PREFIX` | Mẫu khai báo tên đầu, app.config.ts đọc tên sau; prefix mặc định /public/ |
| `HELMET_ENABLED`, `APP_REQUEST_TIMEOUT_MS` | Helmet mặc định bật; timeout config 30000 nhưng global TimeoutInterceptor đang comment, không bảo đảm request bị cắt theo biến này |

Không sao chép secret mặc định trong source vào môi trường thực tế. Tự tạo JWT secrets và thông tin dịch vụ của môi trường riêng.

## Các lệnh có sẵn

Chạy từ `server`. Các tên rút gọn trong cùng ô đều là `npm run <tên-script>`:

| Lệnh | Tác dụng / lưu ý |
| --- | --- |
| `npm ci` | Cài theo lockfile; postinstall chạy prisma generate |
| `npm run dev`, `npm run start:debug` | Nest watch / debug watch |
| `npm run build` | npx nest build |
| `npm start`, `npm run start:prod` | node dist/main.js, cần build trước |
| `npm run migrate:deploy` | Áp dụng migrations đã commit |
| `npm run migrate:dev` | Tạo/áp dụng migration dev, cần shadow database |
| `npm run prisma:generate` | Generate Prisma Client |
| `npm run prisma:sync` | migrate dev rồi generate |
| `npm run prisma:reset` | **Xóa dữ liệu/reset database**; chỉ dùng database local có thể bỏ |
| `npm run test`, `test:watch`, `test:cov`, `test:debug` | Jest, watch, coverage, debug; hiện chưa tìm thấy *.spec.ts |
| `npm run test:e2e` | Tham chiếu test/jest-e2e.json, file/thư mục này chưa có |
| `npm run lint` | ESLint với **--fix**, có thể sửa source; hiện lỗi cấu hình ESLint 9 |
| `npm run format` | Prettier **ghi lại** src/**/*.ts, test/**/*.ts |
| `npm run email:dev`, `npm run email:preview` | email dev / npx react-email dev; chưa thấy react-email khai báo trực tiếp, chưa xác minh chạy được; npx có thể tải package |

Kiểm tra TypeScript không ghi output: `npx --no-install tsc --noEmit --incremental false`; đây không phải script package.json.

## Docker và triển khai

Dockerfile dùng Node 24 Debian slim, dependencies/build/runner stages, generate Prisma khi cài, build Nest, user nestjs, expose 8000. Runner giữ dependencies phát triển, chưa coi image đã tối ưu production. Áp dụng migrations từ checkout có `prisma.config.ts` như hướng dẫn local trước khi chạy container. Sau khi chuẩn bị `.env.prod` riêng:

```powershell
docker build -t cosmetic-server .
docker run --rm --name cosmetic-server --env-file .env.prod -p 8000:8000 cosmetic-server
```

Runner không copy `prisma.config.ts`; lệnh migrate trong container từ README cũ chưa được xác minh với Prisma 7. Maintainer cần chuẩn hóa migration job trước deployment. Không khẳng định chỉ chạy Prisma CLI trong runner là đủ.

Docker Desktop: PostgreSQL/Redis trên host dùng host.docker.internal; Elasticsearch cũng cần node URL truy cập được từ container. Linux cần host gateway/network phù hợp. Browser dùng URL công khai của server. Các lệnh Docker chưa chạy kiểm chứng; không có Compose/pipeline được tìm thấy. `api/index.ts`/`vercel.json` chỉ chứng minh có cấu hình liên quan, không xác nhận deployment hoạt động.

## Xử lý sự cố

| Hiện tượng | Kiểm tra có căn cứ |
| --- | --- |
| Joi thiếu biến | DATABASE_URL, refresh secret ≥32 ký tự và ba biến Google; kiểm tra file env được chọn |
| Strategy thiếu clientID / JWT secret | Điền Facebook app ID/secret/callback và JWT_ACCESS_SECRET dù Joi chưa bắt buộc |
| Prisma generate/migration lỗi | Node 24.x, đầy đủ devDependencies, URL/user/database đúng, PostgreSQL chạy; migrate:dev cần shadow DB; generate lại sau đổi schema |
| Redis reconnect / auth hoặc queue lỗi | Kiểm tra host/port/password/DB; localhost container không chỉ host |
| Search lỗi node/index | Điền node URL/auth, kiểm tra cluster; lỗi tạo index có thể không làm HTTP server dừng |
| Cookie hết hạn quá sớm / TTL sai | Dùng duration có đơn vị 30d, 1d vì ms(); không mặc định chuỗi số là giây |
| VNPay callback 404 / kết quả chưa xác minh | Dùng routes vnpay-return, vnpay-ipn thực tế, đối chiếu sandbox; localhost không truy cập được từ dịch vụ ngoài nếu chưa có đường truy cập công khai |
| Client 404 / CORS | Port 8000, base URL có /api/v1, origin đúng; kiểm tra PORT có ghi đè APP_PORT |
| ESLint thiếu eslint.config.* | ESLint 9 nhưng repo chỉ có .eslintrc.js; maintainer cần migrate hoặc thống nhất legacy mode |
| PowerShell chặn npm.ps1 | Dùng npm.cmd cho các lệnh tương ứng |

## Kiểm chứng và đề xuất

**Đã thực hiện:** đối chiếu scripts, controllers, schema/migrations, env example và consumer. TypeScript `--noEmit --incremental false` thành công với Node `24.12.0`, npm `11.6.2`, dependencies đã cài. `jest --listTests --runInBand` thành công nhưng danh sách rỗng. ESLint chạy trực tiếp không --fix dừng do thiếu flat config; không chạy lint script có thể sửa source. Chưa có e2e config mà script tham chiếu.

**Chưa chạy:** cài lại dependencies, migration/seed, Nest build/dev, Docker, HTTP và các tích hợp. Phạm vi chỉ sửa README, không đọc/sử dụng env đang có, credential/dịch vụ ngoài hoặc thay đổi database; Prisma CLI/bootstrap có thể tự nạp env đó. Kiểm tra tĩnh không chứng minh fresh install, runtime, quyền truy cập hoặc thanh toán đã hoạt động.

**Đề xuất, cần maintainer cung cấp/thống nhất; chưa phải quy trình đã có:**

- Phiên bản PostgreSQL/Redis/Elasticsearch chuẩn, provisioning local, dữ liệu demo và cách tạo admin đầu tiên.
- Sandbox Google/Facebook/Cloudinary/SMTP/VNPay; contract callback/IPN/trạng thái đơn và tiêu chí nghiệm thu thanh toán.
- Ma trận role/ownership từng API; rà soát quyền quản trị và payment callback trước triển khai.
- Contribution/review, coding conventions, test suite và cấu hình lint/e2e chạy được trong CI.
- CI/CD, migration job Docker/Prisma 7, deployment/rollback, backup/restore, readiness và observability.
- Chuẩn hóa các biến mẫu lệch consumer đã nêu; xác nhận timeout/rate limit cần bật.

Tài liệu: [client README](../client/README.md), [.env.example](.env.example), [package.json](package.json), [schema](prisma/schema.prisma), [migrations](prisma/migrations), [Prisma config](prisma.config.ts), [controllers](src/domains), [Postman collection](postman/cosmetic-ecommerce.postman_collection.json), [Dockerfile](Dockerfile).
