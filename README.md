# Telegram to Rubika Bot Bridge

One-way Node.js/TypeScript MVP bridge:

```text
Telegram user/group/channel -> Telegram Bot -> pairing store -> Rubika Bot API -> paired Rubika chat
```

This service uses Telegram and Rubika polling. It does not need a public webhook URL.

## Features

- Telegram text forwarding
- Forwarded Telegram messages treated as normal messages, with forwarded text labeled
- Telegram photo, document, video, audio, and voice forwarding
- Telegram Bot API hosted downloads are limited by Telegram before this bridge's
  `MAX_FILE_MB` limit is reached; use a local Telegram Bot API server or a
  Telegram client API downloader for large files.
- Unsupported message fallback text
- Pair Telegram chats with Rubika chats using one-time codes
- Temporary media download, upload, and deletion
- Rubika API retry with 1s, 3s, and 10s backoff
- Rubika polling diagnostics and a health reply for non-pair messages
- In-memory offset by default, optional tiny JSON offset file
- Graceful shutdown on `SIGINT` and `SIGTERM`

## Setup

1. Create a Telegram bot with BotFather and copy the bot token.
2. Create a Rubika bot and copy the Rubika bot token.
3. Create `.env` with both bot tokens.
5. Run the service:

```bash
docker compose up -d --build
```

6. In Telegram, send `/pair` to the Telegram bot.
7. In Rubika, send `/pair <code>` to the Rubika bot.
8. Send a Telegram message to the paired Telegram chat.
9. Confirm the message appears in the paired Rubika chat.

To test whether Rubika polling and replies work before pairing, send any normal
message to the Rubika bot. It should reply with:

```text
Rubika bot is running and can reply.
```

If it does not reply, run with `LOG_LEVEL=debug` and check for Rubika
`getUpdates`, skipped update, and API response logs.

## Environment

```env
NODE_ENV=production
LOG_LEVEL=info
TG_BOT_TOKEN=
TG_API_BASE_URL=
TG_FILE_BASE_URL=
RUBIKA_BOT_TOKEN=
POLL_INTERVAL_MS=250
MAX_FILE_MB=500
TMP_DIR=/tmp/tg-rubika-bridge
DATABASE_URL=file:./data/bridge.db
```

Pair records, Telegram offsets, Rubika processed update IDs, and media job state
are stored in SQLite via Prisma. The default Docker Compose file overrides
`DATABASE_URL` to `file:/app/data/bridge.db`, backed by the mounted `./data`
directory.

## Large Telegram Files

Telegram's hosted Bot API rejects bot downloads larger than 20 MB. To forward
larger files, run a local Telegram Bot API server in local mode. Get
`TELEGRAM_API_ID` and `TELEGRAM_API_HASH` from `https://my.telegram.org`, add
them to `.env`, then start with:

```bash
docker compose -f docker-compose.yml -f docker-compose.local-bot-api.yml up -d --build
```

The override routes bot requests to `telegram-bot-api:8081` and mounts the
local Bot API file volume into the bridge. When `getFile` returns an absolute
local path, the bridge uploads that file path directly to Rubika.

Large media uploads are queued in SQLite and processed by a background worker.
The bridge sends one Rubika status message per upload and edits it as the upload
progresses when Rubika supports message editing. If editing fails, it sends a
short replacement status message.

The default Docker Compose file mounts `./data:/app/data` so pairs survive container restarts.

## Local Development

```bash
npm install
npm run dev
```

Run checks:

```bash
npm run build
npm test
```

## Message Formatting

Text:

```text
<text>
```

Forwarded text:

```text
<text>
```

Media caption:

```text
<caption if any>
```

## Security Notes

- `.env` is gitignored.
- Bot tokens are not logged.
- Telegram file downloads are written only to `TMP_DIR` and removed after each upload attempt.
- User messages, file IDs, message IDs, and delivery history are not persisted.
- The service calls Telegram `deleteWebhook` once on startup so polling can work.
