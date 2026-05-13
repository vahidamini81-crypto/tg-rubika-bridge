# Cloudflare Worker Deployment Guide

This guide is for the single-file Worker in [`worker.js`](./worker.js).

The Worker version is different from the Docker version:

- Telegram sends updates to the Worker by webhook.
- Rubika is checked by a Cloudflare Cron Trigger.
- Pairing data is stored in Cloudflare Workers KV.
- Media is capped at 20 MB because the public Telegram Bot API download path is limited.
- No Docker, SQLite, Prisma, server, or local Telegram Bot API is used.

Useful official links:

- Cloudflare dashboard: <https://dash.cloudflare.com/>
- Cloudflare Workers: <https://developers.cloudflare.com/workers/>
- Workers KV guide: <https://developers.cloudflare.com/kv/get-started/>
- KV bindings: <https://developers.cloudflare.com/kv/concepts/kv-bindings/>
- Cron Triggers: <https://developers.cloudflare.com/workers/configuration/cron-triggers/>
- Telegram BotFather: <https://t.me/BotFather>
- Telegram `setWebhook`: <https://core.telegram.org/bots/api#setwebhook>

---

## English Tutorial

### 1. Get the bot tokens

#### Telegram token

1. Open <https://t.me/BotFather>.
2. Send `/newbot`.
3. Follow BotFather's questions.
4. Copy the token. It looks like:

```text
123456789:AAExampleTelegramTokenHere
```

#### Rubika token

1. Create or open your Rubika bot using Rubika's bot tools.
2. Copy the Rubika bot token.
3. Keep both tokens private.

### 2. Edit `worker.js`

Open [`worker.js`](./worker.js) and edit the constants at the top:

```js
const TG_BOT_TOKEN = "123456789:AAExampleTelegramTokenHere";
const RUBIKA_BOT_TOKEN = "your-rubika-bot-token";
const WEBHOOK_SECRET = "use-a-long-random-secret";

const ADMIN_TELEGRAM_USER_IDS = new Set([
  123456789,
]);
```

Use a real secret for `WEBHOOK_SECRET`, for example:

```text
my-rubika-bridge-8f4b7d20
```

Do not use a simple value like `1234`.

To find your Telegram user id, you can message a Telegram id bot such as `@userinfobot`, or temporarily check Telegram update payloads while testing.

### 3. Create the Worker

1. Open <https://dash.cloudflare.com/>.
2. In the left menu, click **Workers & Pages**.
3. Click **Create**.
4. Choose **Worker**.
5. Click **Create Worker**.
6. Choose any worker name, for example:

```text
telegram-rubika-bridge
```

7. Click **Deploy** or **Create**.
8. Open the new Worker.
9. Click **Edit code** or **Quick edit**.
10. Delete the example code.
11. Paste the full contents of [`worker.js`](./worker.js).
12. Click **Save and deploy**.

After deploy, Cloudflare gives you a URL like:

```text
https://telegram-rubika-bridge.your-account.workers.dev
```

Example from a real Worker URL format:

```text
https://curly-fog-8590.example.workers.dev
```

### 4. Create the KV namespace

1. In Cloudflare dashboard, go to **Workers & Pages**.
2. In the left or top navigation, open **KV** or **Workers KV**.
3. Click **Create instance** or **Create namespace**.
4. Name it:

```text
telegram_rubika_bot
```

5. Click **Create**.

### 5. Bind KV to the Worker

The binding name must be exactly:

```text
BOT_KV
```

Steps:

1. Go to **Workers & Pages**.
2. Click your Worker.
3. Open **Settings**.
4. Open **Bindings**.
5. Click **Add binding**.
6. Select **KV namespace**.
7. In **Variable name**, type:

```text
BOT_KV
```

8. In **KV namespace**, choose the namespace you created, for example `telegram_rubika_bot`.
9. Click **Add binding** or **Save**.
10. Deploy if Cloudflare asks you to deploy the change.

Test the binding by opening your Worker root URL:

```text
https://YOUR-WORKER.workers.dev/
```

Expected response includes:

```json
{
  "ok": true,
  "service": "telegram-to-rubika-worker",
  "version": "worker-media-rubika-parity-1",
  "kvBindingPresent": true,
  "maxMediaMb": 20
}
```

If `kvBindingPresent` is `false`, the binding was not added correctly.

### 6. Add the Cron Trigger for Rubika

Rubika does not call the Worker directly. The Worker must poll Rubika.

1. Go to **Workers & Pages**.
2. Click your Worker.
3. Open **Settings**.
4. Open **Triggers**.
5. Find **Cron Triggers**.
6. Click **Add cron trigger**.
7. Enter:

```text
*/1 * * * *
```

8. Click **Add** or **Save**.

This runs once per minute. Cloudflare Cron Triggers use UTC time and may take a few minutes to propagate.

You can also manually poll Rubika in your browser:

```text
https://YOUR-WORKER.workers.dev/rubika/poll
```

Example response:

```json
{
  "ok": true,
  "received": 0,
  "processed": 0,
  "paired": 0,
  "healthReplies": 0,
  "skipped": 0,
  "duplicate": 0
}
```

### 7. Set the Telegram webhook

Build this URL:

```text
https://api.telegram.org/bot<TG_BOT_TOKEN>/setWebhook?url=https://YOUR-WORKER.workers.dev/telegram/<WEBHOOK_SECRET>
```

Example:

```text
https://api.telegram.org/bot123456789:AAExampleTelegramTokenHere/setWebhook?url=https://telegram-rubika-bridge.your-account.workers.dev/telegram/my-rubika-bridge-8f4b7d20
```

Open that URL in your browser.

Expected Telegram response:

```json
{
  "ok": true,
  "result": true,
  "description": "Webhook was set"
}
```

If you changed the Worker URL or `WEBHOOK_SECRET`, run the `setWebhook` URL again.

### 8. Test Telegram

1. Open your Telegram bot.
2. Send:

```text
/start
```

or:

```text
/pair
```

3. The bot should reply with a 6-digit code, for example:

```text
کد اتصال: 482913
```

If Telegram does not respond:

- Check the webhook URL.
- Check `TG_BOT_TOKEN`.
- Check that the Worker is deployed.
- Open the Worker root URL and confirm it returns JSON.

### 9. Pair Rubika

1. Open your Rubika bot chat.
2. Send the pairing command using the code from Telegram:

```text
/pair 482913
```

3. Wait up to 1 minute for the Cron Trigger, or manually open:

```text
https://YOUR-WORKER.workers.dev/rubika/poll
```

4. Rubika should reply that pairing is complete.
5. Telegram should also receive a connected message.

### 10. Send messages

After pairing:

1. Send text in Telegram.
2. Check that it appears in Rubika.
3. Send a small photo, audio, voice, video, or document under 20 MB.
4. Check Rubika.

Supported Telegram media:

- Photo
- Document
- Video
- Animation/GIF
- Audio
- Voice

If media fails, Telegram should receive an error code such as:

```text
کد خطا: RUBIKA_UPLOAD
```

Common meanings:

- `TELEGRAM_GET_FILE`: Telegram did not return a file path.
- `TELEGRAM_DOWNLOAD`: Telegram file download failed.
- `RUBIKA_REQUEST_SEND_FILE`: Rubika did not provide an upload URL.
- `RUBIKA_UPLOAD`: Rubika upload endpoint failed.
- `RUBIKA_SEND_FILE`: Rubika accepted upload but failed to send it to the chat.

### 11. Admin commands

Admin commands work only for Telegram user ids listed in `ADMIN_TELEGRAM_USER_IDS`.

Commands:

```text
/status
/list
/pairs
/unpair <telegram_chat_id>
```

Example:

```text
/unpair 123456789
```

### 12. Troubleshooting

#### Root URL says `kvBindingPresent: false`

Add the KV binding again. The variable name must be exactly:

```text
BOT_KV
```

#### Telegram works, Rubika does not

Usually the Cron Trigger is missing.

Check:

1. Worker **Settings**.
2. **Triggers**.
3. **Cron Triggers**.
4. Confirm this exists:

```text
*/1 * * * *
```

Then manually open:

```text
https://YOUR-WORKER.workers.dev/rubika/poll
```

#### Media gives `Rubika uploadFile failed with non-JSON HTTP 502`

That means Telegram download succeeded, but Rubika's upload server returned a temporary 502 response. The Worker retries several times. If it still fails, try again later or test with a smaller file.

#### File over 20 MB fails

This is expected for the Worker version. Keep media under 20 MB.

#### Deployed code does not look updated

Open:

```text
https://YOUR-WORKER.workers.dev/
```

Confirm the response includes:

```json
"version": "worker-media-rubika-parity-1"
```

If not, paste the latest `worker.js` into Cloudflare again and click **Save and deploy**.

---

## آموزش فارسی

### ۱. گرفتن توکن ربات‌ها

#### توکن تلگرام

1. این لینک را باز کنید: <https://t.me/BotFather>
2. دستور `/newbot` را بفرستید.
3. مراحل BotFather را انجام دهید.
4. توکن را کپی کنید. شکل توکن معمولاً شبیه این است:

```text
123456789:AAExampleTelegramTokenHere
```

#### توکن روبیکا

1. ربات روبیکای خود را با ابزارهای ربات روبیکا بسازید یا باز کنید.
2. توکن ربات روبیکا را کپی کنید.
3. توکن‌ها را در جای عمومی منتشر نکنید.

### ۲. ویرایش `worker.js`

فایل [`worker.js`](./worker.js) را باز کنید و مقدارهای بالای فایل را تغییر دهید:

```js
const TG_BOT_TOKEN = "123456789:AAExampleTelegramTokenHere";
const RUBIKA_BOT_TOKEN = "your-rubika-bot-token";
const WEBHOOK_SECRET = "use-a-long-random-secret";

const ADMIN_TELEGRAM_USER_IDS = new Set([
  123456789,
]);
```

برای `WEBHOOK_SECRET` یک متن طولانی و غیرقابل حدس بگذارید، مثلاً:

```text
my-rubika-bridge-8f4b7d20
```

مقدار ساده مثل `1234` نگذارید.

برای پیدا کردن شناسه عددی کاربر تلگرام، می‌توانید به ربات‌هایی مثل `@userinfobot` پیام بدهید.

### ۳. ساخت Worker در Cloudflare

1. وارد داشبورد Cloudflare شوید: <https://dash.cloudflare.com/>
2. از منوی سمت چپ روی **Workers & Pages** کلیک کنید.
3. روی **Create** کلیک کنید.
4. گزینه **Worker** را انتخاب کنید.
5. روی **Create Worker** کلیک کنید.
6. یک نام برای Worker بگذارید، مثلاً:

```text
telegram-rubika-bridge
```

7. روی **Deploy** یا **Create** کلیک کنید.
8. Worker ساخته‌شده را باز کنید.
9. روی **Edit code** یا **Quick edit** کلیک کنید.
10. کد نمونه Cloudflare را پاک کنید.
11. کل محتوای فایل [`worker.js`](./worker.js) را جایگزین کنید.
12. روی **Save and deploy** کلیک کنید.

بعد از Deploy، یک آدرس شبیه این می‌گیرید:

```text
https://telegram-rubika-bridge.your-account.workers.dev
```

مثال:

```text
https://curly-fog-8590.example.workers.dev
```

### ۴. ساخت KV namespace

1. در داشبورد Cloudflare وارد **Workers & Pages** شوید.
2. بخش **KV** یا **Workers KV** را باز کنید.
3. روی **Create instance** یا **Create namespace** کلیک کنید.
4. این نام را وارد کنید:

```text
telegram_rubika_bot
```

5. روی **Create** کلیک کنید.

### ۵. اتصال KV به Worker

نام Binding باید دقیقاً این باشد:

```text
BOT_KV
```

مراحل:

1. وارد **Workers & Pages** شوید.
2. Worker خود را باز کنید.
3. وارد **Settings** شوید.
4. بخش **Bindings** را باز کنید.
5. روی **Add binding** کلیک کنید.
6. گزینه **KV namespace** را انتخاب کنید.
7. در بخش **Variable name** بنویسید:

```text
BOT_KV
```

8. در بخش **KV namespace** همان namespace ساخته‌شده، مثلاً `telegram_rubika_bot` را انتخاب کنید.
9. روی **Add binding** یا **Save** کلیک کنید.
10. اگر Cloudflare خواست، دوباره Deploy کنید.

برای تست، آدرس اصلی Worker را باز کنید:

```text
https://YOUR-WORKER.workers.dev/
```

پاسخ درست باید شامل این مقدار باشد:

```json
{
  "ok": true,
  "service": "telegram-to-rubika-worker",
  "version": "worker-media-rubika-parity-1",
  "kvBindingPresent": true,
  "maxMediaMb": 20
}
```

اگر `kvBindingPresent` برابر `false` بود، Binding درست اضافه نشده است.

### ۶. اضافه کردن Cron Trigger برای روبیکا

روبیکا خودش به Worker پیام نمی‌فرستد. Worker باید روبیکا را Poll کند.

1. وارد **Workers & Pages** شوید.
2. Worker خود را باز کنید.
3. وارد **Settings** شوید.
4. بخش **Triggers** را باز کنید.
5. بخش **Cron Triggers** را پیدا کنید.
6. روی **Add cron trigger** کلیک کنید.
7. این مقدار را وارد کنید:

```text
*/1 * * * *
```

8. روی **Add** یا **Save** کلیک کنید.

این مقدار یعنی هر ۱ دقیقه یک بار. فعال شدن Cron ممکن است چند دقیقه زمان ببرد.

برای تست دستی روبیکا، این آدرس را در مرورگر باز کنید:

```text
https://YOUR-WORKER.workers.dev/rubika/poll
```

نمونه پاسخ:

```json
{
  "ok": true,
  "received": 0,
  "processed": 0,
  "paired": 0,
  "healthReplies": 0,
  "skipped": 0,
  "duplicate": 0
}
```

### ۷. تنظیم Webhook تلگرام

این آدرس را بسازید:

```text
https://api.telegram.org/bot<TG_BOT_TOKEN>/setWebhook?url=https://YOUR-WORKER.workers.dev/telegram/<WEBHOOK_SECRET>
```

مثال:

```text
https://api.telegram.org/bot123456789:AAExampleTelegramTokenHere/setWebhook?url=https://telegram-rubika-bridge.your-account.workers.dev/telegram/my-rubika-bridge-8f4b7d20
```

این آدرس را در مرورگر باز کنید.

پاسخ درست تلگرام:

```json
{
  "ok": true,
  "result": true,
  "description": "Webhook was set"
}
```

اگر آدرس Worker یا `WEBHOOK_SECRET` را عوض کردید، دوباره همین لینک `setWebhook` را باز کنید.

### ۸. تست تلگرام

1. چت ربات تلگرام را باز کنید.
2. این دستور را بفرستید:

```text
/start
```

یا:

```text
/pair
```

3. ربات باید یک کد ۶ رقمی بدهد، مثلاً:

```text
کد اتصال: 482913
```

اگر تلگرام جواب نداد:

- آدرس Webhook را بررسی کنید.
- مقدار `TG_BOT_TOKEN` را بررسی کنید.
- مطمئن شوید Worker Deploy شده است.
- آدرس اصلی Worker را باز کنید و ببینید JSON برمی‌گرداند یا نه.

### ۹. اتصال روبیکا

1. چت ربات روبیکا را باز کنید.
2. کد گرفته‌شده از تلگرام را این‌طور بفرستید:

```text
/pair 482913
```

3. حداکثر ۱ دقیقه صبر کنید، یا دستی این آدرس را باز کنید:

```text
https://YOUR-WORKER.workers.dev/rubika/poll
```

4. روبیکا باید پیام موفقیت اتصال بدهد.
5. تلگرام هم باید پیام اتصال موفق دریافت کند.

### ۱۰. ارسال پیام

بعد از اتصال:

1. در تلگرام متن بفرستید.
2. در روبیکا نتیجه را ببینید.
3. عکس، ویس، صدا، ویدیو یا فایل کمتر از ۲۰ مگابایت بفرستید.
4. نتیجه را در روبیکا بررسی کنید.

مدیاهای پشتیبانی‌شده:

- عکس
- فایل
- ویدیو
- انیمیشن/GIF
- صدا
- ویس

اگر مدیا خطا داد، تلگرام یک کد خطا می‌فرستد، مثلاً:

```text
کد خطا: RUBIKA_UPLOAD
```

معنی خطاهای رایج:

- `TELEGRAM_GET_FILE`: تلگرام مسیر فایل را برنگردانده است.
- `TELEGRAM_DOWNLOAD`: دانلود فایل از تلگرام شکست خورده است.
- `RUBIKA_REQUEST_SEND_FILE`: روبیکا آدرس آپلود نداده است.
- `RUBIKA_UPLOAD`: آپلود به سرور روبیکا شکست خورده است.
- `RUBIKA_SEND_FILE`: فایل آپلود شده ولی ارسال آن در چت روبیکا شکست خورده است.

### ۱۱. دستورهای ادمین

دستورهای ادمین فقط برای شناسه‌هایی کار می‌کنند که در `ADMIN_TELEGRAM_USER_IDS` گذاشته‌اید.

دستورها:

```text
/status
/list
/pairs
/unpair <telegram_chat_id>
```

مثال:

```text
/unpair 123456789
```

### ۱۲. رفع اشکال

#### آدرس اصلی Worker مقدار `kvBindingPresent: false` نشان می‌دهد

Binding را دوباره اضافه کنید. نام متغیر باید دقیقاً این باشد:

```text
BOT_KV
```

#### تلگرام کار می‌کند ولی روبیکا نه

معمولاً Cron Trigger اضافه نشده است.

بررسی کنید:

1. Worker را باز کنید.
2. وارد **Settings** شوید.
3. وارد **Triggers** شوید.
4. مطمئن شوید این Cron وجود دارد:

```text
*/1 * * * *
```

بعد این آدرس را دستی باز کنید:

```text
https://YOUR-WORKER.workers.dev/rubika/poll
```

#### خطای `Rubika uploadFile failed with non-JSON HTTP 502`

یعنی دانلود از تلگرام موفق بوده، ولی سرور آپلود روبیکا خطای موقت داده است. Worker چند بار دوباره تلاش می‌کند. اگر باز هم خطا داد، بعداً دوباره امتحان کنید یا فایل کوچک‌تری بفرستید.

#### فایل بیشتر از ۲۰ مگابایت ارسال نمی‌شود

این برای نسخه Worker طبیعی است. فایل‌ها را کمتر از ۲۰ مگابایت نگه دارید.

#### کد جدید Deploy نشده است

این آدرس را باز کنید:

```text
https://YOUR-WORKER.workers.dev/
```

باید این مقدار را ببینید:

```json
"version": "worker-media-rubika-parity-1"
```

اگر نبود، دوباره محتوای جدید `worker.js` را در Cloudflare جایگذاری کنید و **Save and deploy** را بزنید.
