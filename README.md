# Telegram to Rubika Bot Bridge

Simple one-way bridge:

```text
Telegram -> Telegram Bot -> Rubika Bot -> Rubika chat
```

The app uses polling, so no public webhook URL is required.

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
LOG_LEVEL=info
POLL_INTERVAL_MS=250
MEDIA_WORKER_CONCURRENCY=2
MEDIA_JOB_POLL_INTERVAL_MS=250
RUBIKA_UPLOAD_RETRIES=6
MAX_FILE_MB=500
TMP_DIR=/tmp/tg-rubika-bridge
```

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

Useful commands:

```text
/pair
/pairs
/unpair
```

### Notes

- Text, photo, video, audio, voice, and documents are forwarded.
- Large media is queued and retried automatically.
- Use local Telegram Bot API for faster and larger Telegram file handling.
- Rubika status messages are edited when possible.
- Bot tokens are read from `.env` and are not logged.

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
LOG_LEVEL=info
POLL_INTERVAL_MS=250
MEDIA_WORKER_CONCURRENCY=2
MEDIA_JOB_POLL_INTERVAL_MS=250
RUBIKA_UPLOAD_RETRIES=6
MAX_FILE_MB=500
TMP_DIR=/tmp/tg-rubika-bridge
```

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

دستورهای کاربردی:

```text
/pair
/pairs
/unpair
```

### نکته‌ها

- متن، عکس، ویدیو، صدا، ویس و فایل ارسال می‌شود.
- رسانه‌های بزرگ در صف می‌مانند و خودکار دوباره تلاش می‌شوند.
- برای سرعت بهتر و فایل‌های بزرگ‌تر از Telegram Bot API محلی استفاده کنید.
- پیام وضعیت در روبیکا تا حد امکان ویرایش می‌شود.
- توکن‌ها از `.env` خوانده می‌شوند و در لاگ نوشته نمی‌شوند.
