# Telegram to Rubika Bot Bridge

Simple one-way bridge:

```text
Telegram -> Telegram Bot -> Rubika Bot -> Rubika chat
```

The app uses polling, so no public webhook URL is required.

Cloudflare Workers single-file deployment is documented separately in
[WORKER_DEPLOYMENT.md](./WORKER_DEPLOYMENT.md). Use that guide if you want to
upload [`worker.js`](./worker.js) to Cloudflare instead of running the Docker
version.

## English

### Requirements

- Telegram bot token from [BotFather](https://t.me/BotFather)
- Rubika bot token
- Docker and Docker Compose
- Optional for large Telegram files: `api_id` and `api_hash` from [my.telegram.org](https://my.telegram.org)

### `.env`

Create `.env` in the project root:

```env
TG_BOT_TOKEN=123456:telegram_bot_token
RUBIKA_BOT_TOKEN=rubika_bot_token
ADMIN_TELEGRAM_USER_IDS=123456789,987654321
LOG_LEVEL=info
POLL_INTERVAL_MS=250
PUBLIC_QUEUE_CONCURRENCY=1
ADMIN_QUEUE_CONCURRENCY=10
PUBLIC_QUEUE_MAX_WAITING=25
MEDIA_JOB_POLL_INTERVAL_MS=250
RUBIKA_UPLOAD_RETRIES=6
PUBLIC_MAX_FILE_MB=100
ADMIN_MAX_FILE_MB=
TMP_DIR=/tmp/tg-rubika-bridge
```

Configuration details:

- `ADMIN_TELEGRAM_USER_IDS`: comma or space separated Telegram user ids. These are Telegram user ids, not chat ids and not Rubika ids.
- `PUBLIC_QUEUE_CONCURRENCY`: number of public queued messages processed at the same time. Default: `1`.
- `ADMIN_QUEUE_CONCURRENCY`: number of admin queued messages processed at the same time. Default: `10`.
- `PUBLIC_QUEUE_MAX_WAITING`: maximum waiting public jobs before new public messages are rejected with a queue-full reply. Default: `25`.
- `PUBLIC_MAX_FILE_MB`: public user file limit. Default: `100`.
- `ADMIN_MAX_FILE_MB`: admin file limit. Leave empty for unlimited admin files.
- `MEDIA_JOB_POLL_INTERVAL_MS`: queue worker polling interval.
- `RUBIKA_UPLOAD_RETRIES`: retry count for Rubika upload/send operations.

For local Telegram Bot API mode, also add:

```env
TELEGRAM_API_ID=123456
TELEGRAM_API_HASH=your_api_hash
```

Get these values from `my.telegram.org`:

1. Sign in with your Telegram account.
2. Open **API development tools**.
3. Create an app.
4. Copy **api_id** and **api_hash**.

### Deploy

Normal mode:

```bash
docker compose up -d --build
```

Large-file mode with local Telegram Bot API:

```bash
docker compose -f docker-compose.yml -f docker-compose.local-bot-api.yml up -d --build
```

Data is stored in SQLite under `./data`.

### Pair Chats

1. Send `/pair` to your Telegram bot.
2. Copy the code.
3. Send `/pair <code>` to your Rubika bot.
4. Send a message in Telegram and check Rubika.

Pair codes are stored in SQLite until they expire, so a bot restart does not immediately invalidate a newly issued code. Codes still expire after the configured pairing TTL.

Public commands:

```text
/start
/pair
/status
```

- `/start` or `/pair`: creates a new pairing code for the current Telegram chat.
- `/status`: for regular users, shows whether the current Telegram chat is paired and shows that chat's queue counts.

Admin commands:

```text
/status
/list
/pairs
/unpair <telegram_chat_id>
```

- `/status`: for admins, shows global status: pair count, public/admin queue counts, active workers, retry-waiting jobs, failed jobs, oldest queued job, and configured limits.
- `/list`: lists all Telegram-to-Rubika pairs.
- `/pairs`: alias for `/list`.
- `/unpair <telegram_chat_id>`: removes the pair for the given Telegram chat id. Use `/list` to see the ids.

Admin access is based on `message.from.id` from Telegram. This means admin commands should be sent by the configured Telegram user, even if the chat id is different.

### Queue Behavior

- Every forwarded Telegram message is queued before delivery to Rubika.
- Public messages use the public lane and are limited by `PUBLIC_QUEUE_MAX_WAITING`.
- Admin messages use the admin lane and do not consume public capacity.
- Admin workers and public workers are separate. By default the bot processes `10` admin jobs and `1` public job concurrently.
- Public users get a friendly Telegram reply when the public queue is full.
- Rubika queue/status messages are sent when possible and edited when possible.

### File Limits

- Public files are limited by `PUBLIC_MAX_FILE_MB`, default `100`.
- Admin files are unlimited when `ADMIN_MAX_FILE_MB` is empty.
- Set `ADMIN_MAX_FILE_MB=500` or any positive number if admins should also have a file size cap.
- Telegram Bot API itself can still reject very large downloads unless local Telegram Bot API mode is used.

### Notes

- Text, photo, video, audio, voice, and documents are forwarded.
- All forwarded messages are queued. Public users use a limited queue; admin Telegram user ids use a separate priority queue.
- Use local Telegram Bot API for faster and larger Telegram file handling.
- Rubika status messages are edited when possible.
- Bot tokens are read from `.env` and are not logged.
- Runtime data is stored in SQLite under `./data/bridge.db`, including chat pairs, queued jobs, offsets, processed Rubika updates, and pending pair codes.

## فارسی

پل ساده یک‌طرفه:

```text
Telegram -> Telegram Bot -> Rubika Bot -> Rubika chat
```

برنامه با polling کار می‌کند، پس به آدرس webhook عمومی نیاز ندارد.

### نیازمندی‌ها

- توکن ربات تلگرام از [BotFather](https://t.me/BotFather)
- توکن ربات روبیکا
- Docker و Docker Compose
- اختیاری برای فایل‌های بزرگ تلگرام: `api_id` و `api_hash` از [my.telegram.org](https://my.telegram.org)

### فایل `.env`

در ریشه پروژه فایل `.env` بسازید:

```env
TG_BOT_TOKEN=123456:telegram_bot_token
RUBIKA_BOT_TOKEN=rubika_bot_token
ADMIN_TELEGRAM_USER_IDS=123456789,987654321
LOG_LEVEL=info
POLL_INTERVAL_MS=250
PUBLIC_QUEUE_CONCURRENCY=1
ADMIN_QUEUE_CONCURRENCY=10
PUBLIC_QUEUE_MAX_WAITING=25
MEDIA_JOB_POLL_INTERVAL_MS=250
RUBIKA_UPLOAD_RETRIES=6
PUBLIC_MAX_FILE_MB=100
ADMIN_MAX_FILE_MB=
TMP_DIR=/tmp/tg-rubika-bridge
```

توضیح تنظیمات:

- `ADMIN_TELEGRAM_USER_IDS`: شناسه عددی کاربران ادمین تلگرام، جدا شده با کاما یا فاصله. این مقدار شناسه کاربر تلگرام است، نه شناسه چت و نه شناسه روبیکا.
- `PUBLIC_QUEUE_CONCURRENCY`: تعداد پیام‌های صف عمومی که همزمان پردازش می‌شوند. پیش‌فرض: `1`.
- `ADMIN_QUEUE_CONCURRENCY`: تعداد پیام‌های صف ادمین که همزمان پردازش می‌شوند. پیش‌فرض: `10`.
- `PUBLIC_QUEUE_MAX_WAITING`: حداکثر تعداد پیام‌های عمومی در انتظار. اگر صف پر باشد، پیام‌های عمومی جدید رد می‌شوند و کاربر پیام مناسب می‌گیرد. پیش‌فرض: `25`.
- `PUBLIC_MAX_FILE_MB`: محدودیت حجم فایل برای کاربران عمومی. پیش‌فرض: `100`.
- `ADMIN_MAX_FILE_MB`: محدودیت حجم فایل برای ادمین‌ها. اگر خالی باشد، فایل ادمین محدودیت حجمی ندارد.
- `MEDIA_JOB_POLL_INTERVAL_MS`: فاصله بررسی صف توسط workerها.
- `RUBIKA_UPLOAD_RETRIES`: تعداد تلاش دوباره برای عملیات ارسال و آپلود در روبیکا.

برای حالت Telegram Bot API محلی، این‌ها را هم اضافه کنید:

```env
TELEGRAM_API_ID=123456
TELEGRAM_API_HASH=your_api_hash
```

دریافت از `my.telegram.org`:

1. با حساب تلگرام وارد شوید.
2. بخش **API development tools** را باز کنید.
3. یک اپ بسازید.
4. مقدارهای **api_id** و **api_hash** را بردارید.

### اجرا روی سرور

حالت معمولی:

```bash
docker compose up -d --build
```

حالت فایل‌های بزرگ با Telegram Bot API محلی:

```bash
docker compose -f docker-compose.yml -f docker-compose.local-bot-api.yml up -d --build
```

داده‌ها در SQLite و داخل پوشه `./data` ذخیره می‌شوند.

### اتصال چت‌ها

1. در تلگرام به ربات پیام `/pair` بدهید.
2. کد را کپی کنید.
3. در روبیکا به ربات پیام `/pair <code>` بدهید.
4. از تلگرام پیام بفرستید و نتیجه را در روبیکا ببینید.

کدهای اتصال تا زمان انقضا در SQLite ذخیره می‌شوند، بنابراین ری‌استارت ربات یک کد تازه ساخته‌شده را فوراً از بین نمی‌برد. کدها همچنان بعد از زمان اعتبار خود منقضی می‌شوند.

دستورهای عمومی:

```text
/start
/pair
/status
```

- `/start` یا `/pair`: برای چت فعلی تلگرام یک کد اتصال جدید می‌سازد.
- `/status`: برای کاربران عادی، وضعیت اتصال همین چت تلگرام و شمارش صف مربوط به همین چت را نشان می‌دهد.

دستورهای ادمین:

```text
/status
/list
/pairs
/unpair <telegram_chat_id>
```

- `/status`: برای ادمین‌ها، وضعیت کلی ربات را نشان می‌دهد: تعداد اتصال‌ها، وضعیت صف عمومی و ادمین، workerهای فعال، پیام‌های منتظر تلاش دوباره، پیام‌های ناموفق، قدیمی‌ترین پیام صف و محدودیت‌های تنظیم‌شده.
- `/list`: همه اتصال‌های تلگرام به روبیکا را نمایش می‌دهد.
- `/pairs`: همان دستور `/list` است.
- `/unpair <telegram_chat_id>`: اتصال مربوط به شناسه چت تلگرام داده‌شده را حذف می‌کند. برای دیدن شناسه‌ها از `/list` استفاده کنید.

دسترسی ادمین بر اساس `message.from.id` در تلگرام بررسی می‌شود. یعنی دستور ادمین باید توسط همان کاربر تلگرامی ثبت‌شده در `.env` ارسال شود، حتی اگر شناسه چت فرق داشته باشد.

### رفتار صف

- همه پیام‌های تلگرام قبل از ارسال به روبیکا وارد صف می‌شوند.
- پیام‌های کاربران عمومی وارد صف عمومی می‌شوند و با `PUBLIC_QUEUE_MAX_WAITING` محدود می‌شوند.
- پیام‌های ادمین وارد صف ادمین می‌شوند و ظرفیت صف عمومی را مصرف نمی‌کنند.
- workerهای ادمین و عمومی جدا هستند. به صورت پیش‌فرض ربات همزمان `10` پیام ادمین و `1` پیام عمومی را پردازش می‌کند.
- اگر صف عمومی پر باشد، کاربر عمومی در تلگرام پیام مناسب دریافت می‌کند.
- پیام‌های وضعیت صف در روبیکا تا حد امکان ارسال و در صورت امکان ویرایش می‌شوند.

### محدودیت فایل

- فایل کاربران عمومی با `PUBLIC_MAX_FILE_MB` محدود می‌شود. مقدار پیش‌فرض `100` مگابایت است.
- اگر `ADMIN_MAX_FILE_MB` خالی باشد، فایل‌های ادمین محدودیت حجمی ندارند.
- اگر می‌خواهید ادمین‌ها هم محدودیت داشته باشند، مثلاً `ADMIN_MAX_FILE_MB=500` بگذارید.
- خود Telegram Bot API ممکن است دانلود فایل‌های خیلی بزرگ را رد کند، مگر اینکه حالت Telegram Bot API محلی را فعال کرده باشید.

### نکته‌ها

- متن، عکس، ویدیو، صدا، ویس و فایل ارسال می‌شود.
- همه پیام‌های ارسالی در صف قرار می‌گیرند. کاربران عمومی صف محدود دارند و شناسه‌های تلگرام ادمین صف جدا و سریع‌تر دارند.
- برای سرعت بهتر و فایل‌های بزرگ‌تر از Telegram Bot API محلی استفاده کنید.
- پیام وضعیت در روبیکا تا حد امکان ویرایش می‌شود.
- توکن‌ها از `.env` خوانده می‌شوند و در لاگ نوشته نمی‌شوند.
- داده‌های اجرا در SQLite و در `./data/bridge.db` ذخیره می‌شوند؛ شامل اتصال‌ها، صف پیام‌ها، offsetها، پیام‌های پردازش‌شده روبیکا و کدهای اتصال در انتظار.
