// Telegram -> Rubika bridge for Cloudflare Workers.
//
// Required Cloudflare setup:
// 1. Create a KV namespace and bind it to this Worker as BOT_KV.
// 2. Add a Cron Trigger, for example every 1 minute, for Rubika polling.
// 3. Set the Telegram webhook:
//    https://api.telegram.org/bot<TG_BOT_TOKEN>/setWebhook?url=https://<worker-url>/telegram/<WEBHOOK_SECRET>
//
// Notes:
// - Pairing data and offsets are stored in KV.
// - Telegram delivers messages by webhook.
// - Rubika is polled by the scheduled handler.
// - Media is capped at 20 MB because the cloud Telegram Bot API download path is limited.

const TG_BOT_TOKEN = "REPLACE_WITH_TELEGRAM_BOT_TOKEN";
const RUBIKA_BOT_TOKEN = "REPLACE_WITH_RUBIKA_BOT_TOKEN";
const WEBHOOK_SECRET = "change-this-secret-path";

const ADMIN_TELEGRAM_USER_IDS = new Set([
  // 123456789,
]);

// Runtime limits and retry policy. Keep MAX_MEDIA_MB at 20 for the public Telegram Bot API.
const PAIR_TTL_SECONDS = 10 * 60;
const RUBIKA_POLL_LIMIT = 25;
const MAX_MEDIA_MB = 20;
const MAX_MEDIA_BYTES = MAX_MEDIA_MB * 1024 * 1024;
const WORKER_VERSION = "worker-media-rubika-parity-1";
const RUBIKA_UPLOAD_RETRIES = 6;
const RUBIKA_UPLOAD_RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 10_000, 10_000, 10_000];
const PROCESSED_UPDATE_TTL_SECONDS = 24 * 60 * 60;
const RUBIKA_API_BASE = `https://botapi.rubika.ir/v3/${RUBIKA_BOT_TOKEN}`;
const TG_API_BASE = `https://api.telegram.org/bot${TG_BOT_TOKEN}`;
const TG_FILE_BASE = `https://api.telegram.org/file/bot${TG_BOT_TOKEN}`;

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      console.error("Unhandled request error", describeError(error));
      return json({ ok: false, error: describeError(error) }, 500);
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(pollRubika(env).catch((error) => {
      console.error("Rubika scheduled poll failed", describeError(error));
    }));
  },
};

// HTTP routes:
// - GET /                  health and deployment info
// - POST /telegram/:secret Telegram webhook
// - GET|POST /rubika/poll  manual Rubika poll/debug endpoint
async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/") {
    return json({
      ok: true,
      service: "telegram-to-rubika-worker",
      version: WORKER_VERSION,
      telegramWebhookPath: `/telegram/${WEBHOOK_SECRET}`,
      rubikaPollPath: "/rubika/poll",
      requiresCron: true,
      kvBindingPresent: Boolean(env.BOT_KV),
      maxMediaMb: MAX_MEDIA_MB,
      supportedMediaTypes: ["photo", "document", "video", "animation", "audio", "voice"],
    });
  }

  if (!env.BOT_KV) return json({ ok: false, error: "Missing BOT_KV binding" }, 500);

  if (request.method === "POST" && url.pathname === `/telegram/${WEBHOOK_SECRET}`) {
    const update = await request.json();
    ctx.waitUntil(processTelegramUpdate(update, env).catch((error) => {
      console.error("Telegram update failed", describeError(error), update?.update_id);
    }));
    return json({ ok: true });
  }

  if ((request.method === "GET" || request.method === "POST") && url.pathname === "/rubika/poll") {
    const summary = await pollRubika(env);
    return json({ ok: true, ...summary });
  }

  return json({ ok: false, error: "Not found" }, 404);
}

// Telegram updates are handled immediately from the webhook. Commands are processed first;
// non-command messages are forwarded only after the Telegram chat has a Rubika pair.
async function processTelegramUpdate(update, env) {
  const message = update?.message ?? update?.channel_post;
  if (!message?.chat?.id) return;

  const chatId = String(message.chat.id);
  const userId = typeof message.from?.id === "number" ? message.from.id : undefined;

  if (typeof message.text === "string") {
    const handled = await handleTelegramCommand(env, chatId, userId, message.text.trim());
    if (handled) return;
  }

  const pair = await getPair(env, chatId);
  if (!pair) {
    await telegram("sendMessage", {
      chat_id: chatId,
      text: "این گفت‌وگو هنوز متصل نیست. برای اتصال به روبیکا، /pair را بفرستید.",
    });
    return;
  }

  if (typeof message.text === "string") {
    await sendRubikaTextChunks(pair.rubikaChatId, message.text);
    return;
  }

  const media = extractTelegramMedia(message);
  if (!media) {
    await rubika("sendMessage", {
      chat_id: pair.rubikaChatId,
      text: "این نوع پیام تلگرام پشتیبانی نمی‌شود.",
    });
    return;
  }

  await forwardTelegramMedia(env, pair.rubikaChatId, chatId, media);
}

// Telegram command surface is intentionally small so this script stays usable from a Worker.
async function handleTelegramCommand(env, chatId, userId, command) {
  if (command === "/start" || command === "/pair") {
    const code = await createPairCode(env, chatId);
    await telegram("sendMessage", {
      chat_id: chatId,
      text: [
        `کد اتصال: ${code}`,
        "",
        "روبیکا را باز کنید، به این ربات روبیکا پیام بدهید و این دستور را بفرستید:",
        `/pair ${code}`,
        "",
        "این کد تا ۱۰ دقیقه معتبر است.",
      ].join("\n"),
    });
    return true;
  }

  if (command === "/status") {
    const pair = await getPair(env, chatId);
    const lines = [
      "وضعیت ربات",
      pair ? "وضعیت اتصال: متصل" : "وضعیت اتصال: متصل نیست",
      pair ? `مقصد روبیکا: ${pair.rubikaChatId}` : "برای اتصال، /pair را بفرستید.",
      `حداکثر فایل: ${MAX_MEDIA_MB} مگابایت`,
      `به‌روزرسانی: ${new Date().toISOString()}`,
    ];
    await telegram("sendMessage", { chat_id: chatId, text: lines.join("\n") });
    return true;
  }

  if (command === "/pairs" || command === "/list") {
    if (!(await requireAdmin(chatId, userId))) return true;
    await telegram("sendMessage", { chat_id: chatId, text: await formatPairs(env) });
    return true;
  }

  if (command === "/unpair" || command.startsWith("/unpair ")) {
    if (!(await requireAdmin(chatId, userId))) return true;
    const targetChatId = command.slice("/unpair".length).trim();
    if (!targetChatId) {
      await telegram("sendMessage", {
        chat_id: chatId,
        text: "برای حذف اتصال، دستور را به شکل /unpair <telegram_chat_id> بفرستید.",
      });
      return true;
    }
    await env.BOT_KV.delete(pairKey(targetChatId));
    await telegram("sendMessage", {
      chat_id: chatId,
      text: `اتصال تلگرام ${targetChatId} حذف شد.`,
    });
    return true;
  }

  return false;
}

async function requireAdmin(chatId, userId) {
  if (userId !== undefined && ADMIN_TELEGRAM_USER_IDS.has(userId)) return true;
  await telegram("sendMessage", {
    chat_id: chatId,
    text: "این دستور فقط برای ادمین‌های ربات فعال است.",
  });
  return false;
}

// Rubika does not call this Worker directly. A Cloudflare Cron Trigger calls scheduled(),
// which polls Rubika and confirms /pair codes sent from the Rubika side.
async function pollRubika(env) {
  if (!env.BOT_KV) throw new Error("Missing BOT_KV binding");

  const offsetId = await env.BOT_KV.get("state:rubikaOffset");
  const response = await getRubikaUpdatesWithOffsetRecovery(env, offsetId);
  const summary = {
    received: 0,
    processed: 0,
    paired: 0,
    healthReplies: 0,
    skipped: 0,
    duplicate: 0,
    offsetBefore: offsetId ?? null,
    offsetAfter: await env.BOT_KV.get("state:rubikaOffset"),
    retriedWithoutOffset: response.retriedWithoutOffset,
    responseKeys: response.responseKeys,
  };

  const list = normalizeRubikaUpdates(response.payload);
  summary.received = list.length;
  for (const update of list) {
    const updateId = rubikaUpdateId(update);
    if (updateId && await env.BOT_KV.get(processedKey(updateId))) {
      summary.duplicate += 1;
      await saveRubikaOffset(env, update);
      summary.offsetAfter = await env.BOT_KV.get("state:rubikaOffset");
      continue;
    }

    const normalized = normalizeRubikaTextUpdate(update);
    if (normalized) {
      const result = await handleRubikaText(env, normalized.chatId, normalized.text);
      summary.processed += 1;
      if (result === "paired") summary.paired += 1;
      if (result === "health") summary.healthReplies += 1;
    } else {
      summary.skipped += 1;
    }

    if (updateId) {
      await env.BOT_KV.put(processedKey(updateId), "1", {
        expirationTtl: PROCESSED_UPDATE_TTL_SECONDS,
      });
    }
    await saveRubikaOffset(env, update);
    summary.offsetAfter = await env.BOT_KV.get("state:rubikaOffset");
  }

  return summary;
}

async function handleRubikaText(env, rubikaChatId, text) {
  const code = parsePairCode(text);
  if (!code) {
    await rubika("sendMessage", {
      chat_id: rubikaChatId,
      text: [
        "ربات روبیکا فعال است و می‌تواند پاسخ بدهد.",
        "",
        "برای اتصال این گفت‌وگو به تلگرام، اول در تلگرام /pair را بفرستید و بعد /pair <code> را اینجا ارسال کنید.",
      ].join("\n"),
    });
    return "health";
  }

  const pending = await getJson(env, pendingKey(code));
  if (!pending || !pending.telegramChatId || Number(pending.expiresAt) < Date.now()) {
    await env.BOT_KV.delete(pendingKey(code));
    await rubika("sendMessage", {
      chat_id: rubikaChatId,
      text: "کد اتصال نامعتبر است یا منقضی شده. در تلگرام یک کد جدید با /pair بسازید.",
    });
    return "invalid-code";
  }

  await putJson(env, pairKey(pending.telegramChatId), {
    telegramChatId: pending.telegramChatId,
    rubikaChatId,
    createdAt: new Date().toISOString(),
  });
  await env.BOT_KV.delete(pendingKey(code));

  await Promise.allSettled([
    rubika("sendMessage", {
      chat_id: rubikaChatId,
      text: "اتصال انجام شد. پیام‌های آن گفت‌وگوی تلگرام به اینجا ارسال می‌شود.",
    }),
    telegram("sendMessage", {
      chat_id: pending.telegramChatId,
      text: "اتصال به روبیکا انجام شد. پیام‌های این گفت‌وگوی تلگرام ارسال می‌شود.",
    }),
  ]);
  return "paired";
}

// Media follows the same high-level flow as the Node app:
// Telegram getFile -> download -> Rubika requestSendFile -> multipart field "file" -> sendFile.
// Workers do not have a filesystem, so the downloaded Telegram file is kept as a Blob.
async function forwardTelegramMedia(env, rubikaChatId, telegramChatId, media) {
  if (media.fileSize !== undefined && media.fileSize > MAX_MEDIA_BYTES) {
    await telegram("sendMessage", {
      chat_id: telegramChatId,
      text: formatTooLarge(media.type),
    });
    return;
  }

  try {
    let statusMessageId;
    try {
      statusMessageId = await rubika("sendMessage", {
        chat_id: rubikaChatId,
        text: formatUploadStartedMessage(media),
      }).then(messageIdFromPayload);
    } catch (error) {
      console.warn("Failed to send Rubika upload status", describeError(error));
    }

    const tgFile = await telegram("getFile", { file_id: media.fileId });
    if (!tgFile?.file_path) throw new Error("Telegram getFile did not return file_path");
    if (tgFile.file_size !== undefined && tgFile.file_size > MAX_MEDIA_BYTES) {
      await telegram("sendMessage", {
        chat_id: telegramChatId,
        text: formatTooLarge(media.type),
      });
      return;
    }

    const downloadUrl = `${TG_FILE_BASE}/${tgFile.file_path}`;
    const download = await fetch(downloadUrl);
    if (!download.ok) throw new Error(`Telegram file download failed with HTTP ${download.status}`);

    const contentLength = Number(download.headers.get("content-length") ?? "0");
    if (contentLength > MAX_MEDIA_BYTES) {
      await telegram("sendMessage", {
        chat_id: telegramChatId,
        text: formatTooLarge(media.type),
      });
      return;
    }

    const blob = await download.blob();
    if (blob.size > MAX_MEDIA_BYTES) {
      await telegram("sendMessage", {
        chat_id: telegramChatId,
        text: formatTooLarge(media.type),
      });
      return;
    }

    const effectiveMedia = { ...media, fileSize: tgFile.file_size ?? media.fileSize ?? blob.size };
    const requested = await rubika("requestSendFile", { type: rubikaFileType(effectiveMedia) });
    const uploadUrl = stringFrom(requested, ["upload_url", "uploadUrl"]);
    if (!uploadUrl) throw new Error("Rubika requestSendFile did not return upload_url");

    const filename = safeFilename(media.filename ?? filenameFromPath(tgFile.file_path));
    const uploadPayload = await uploadFileToRubika(uploadUrl, blob, filename);
    const fileId = findFileId(uploadPayload) ?? findFileId(requested);
    if (!fileId) throw new Error("Rubika upload did not return file_id");

    await rubika("sendFile", {
      chat_id: rubikaChatId,
      file_id: fileId,
      ...(media.caption ? { text: media.caption } : {}),
    });
    await updateRubikaStatus(rubikaChatId, statusMessageId, formatUploadCompleteMessage(media));
  } catch (error) {
    console.error("Media forwarding failed", describeError(error));
    await telegram("sendMessage", {
      chat_id: telegramChatId,
      text: [
        `ارسال ${persianTypeName(media.type)} ناموفق بود.`,
        mediaFailureHint(error),
        `کد خطا: ${mediaErrorCode(error)}`,
        `جزئیات: ${safeErrorForUser(error)}`,
        media.caption ? `متن همراه: ${media.caption}` : "",
      ].filter(Boolean).join("\n"),
    });
    try {
      await rubika("sendMessage", {
        chat_id: rubikaChatId,
        text: formatUploadFailedMessage(media, error),
      });
    } catch (statusError) {
      console.warn("Failed to send Rubika upload failure status", describeError(statusError));
    }
  }
}

async function sendRubikaTextChunks(chatId, text) {
  for (const chunk of chunkText(text, 3500)) {
    await rubika("sendMessage", { chat_id: chatId, text: chunk });
  }
}

async function telegram(method, body) {
  const response = await fetch(`${TG_API_BASE}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(`Telegram ${method} failed with HTTP ${response.status}: ${payload.description ?? "unknown error"}`);
  }
  return payload.result;
}

async function rubika(method, body) {
  const payload = await rubikaRaw(method, body);
  return extractEnvelopeData(payload);
}

async function rubikaRaw(method, body) {
  const response = await fetch(`${RUBIKA_API_BASE}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseJson(response, `Rubika ${method}`);
}

// Rubika upload hosts occasionally return plain-text 502/503/504 responses.
// Retry only those transient upload failures; regular API errors should surface immediately.
async function uploadFileToRubika(uploadUrl, blob, filename) {
  let lastError;
  for (let attempt = 1; attempt <= RUBIKA_UPLOAD_RETRIES; attempt += 1) {
    try {
      const form = new FormData();
      form.append("file", blob, filename);
      const response = await fetch(uploadUrl, { method: "POST", body: form });
      return await parseJson(response, "Rubika uploadFile");
    } catch (error) {
      lastError = error;
      if (attempt >= RUBIKA_UPLOAD_RETRIES || !isRetryableRubikaUploadError(error)) break;
      const delayMs = RUBIKA_UPLOAD_RETRY_DELAYS_MS[Math.min(attempt - 1, RUBIKA_UPLOAD_RETRY_DELAYS_MS.length - 1)] ?? 10_000;
      console.warn("Retrying Rubika upload", { attempt, delayMs, error: describeError(error) });
      await sleep(delayMs);
    }
  }
  throw lastError;
}

// If Rubika rejects an old offset, clear it once and poll again from the latest available state.
async function getRubikaUpdatesWithOffsetRecovery(env, offsetId) {
  const body = {
    ...(offsetId ? { offset_id: offsetId } : {}),
    limit: RUBIKA_POLL_LIMIT,
  };
  try {
    const payload = await rubikaRaw("getUpdates", body);
    return {
      payload,
      retriedWithoutOffset: false,
      responseKeys: payloadKeys(payload),
    };
  } catch (error) {
    if (offsetId && isInvalidInputError(error)) {
      await env.BOT_KV.delete("state:rubikaOffset");
      const payload = await rubikaRaw("getUpdates", { limit: RUBIKA_POLL_LIMIT });
      return {
        payload,
        retriedWithoutOffset: true,
        responseKeys: payloadKeys(payload),
      };
    }
    throw error;
  }
}

async function parseJson(response, operationName) {
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${operationName} failed with non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  if (!response.ok) {
    throw new Error(`${operationName} failed with HTTP ${response.status}: ${JSON.stringify(payload).slice(0, 500)}`);
  }
  if (payload && typeof payload === "object" && (payload.ok === false || (payload.status && payload.status !== "OK"))) {
    throw new Error(`${operationName} failed: ${payload.message ?? JSON.stringify(payload).slice(0, 500)}`);
  }
  return payload;
}

function extractEnvelopeData(payload) {
  if (!payload || typeof payload !== "object") return payload;
  if (payload.data !== undefined) return payload.data;
  if (payload.result !== undefined) return payload.result;
  return payload;
}

function payloadKeys(payload) {
  const data = extractEnvelopeData(payload);
  if (data && typeof data === "object" && !Array.isArray(data)) return Object.keys(data).slice(0, 20);
  if (payload && typeof payload === "object" && !Array.isArray(payload)) return Object.keys(payload).slice(0, 20);
  return [];
}

function extractTelegramMedia(message) {
  const photo = selectLargestPhoto(message.photo);
  if (photo) {
    return {
      type: "photo",
      fileId: photo.file_id,
      fileSize: photo.file_size,
      caption: message.caption,
      mimeType: "image/jpeg",
      filename: "telegram-photo.jpg",
    };
  }
  if (message.document) return mediaFrom(message.document, normalizedDocumentType(message.document.mime_type), message.caption);
  if (message.animation) return mediaFrom(message.animation, "animation", message.caption);
  if (message.video) return mediaFrom(message.video, "video", message.caption);
  if (message.audio) return mediaFrom(message.audio, "audio", message.caption);
  if (message.voice) return mediaFrom(message.voice, "voice", message.caption);
  return undefined;
}

function mediaFrom(input, type, caption) {
  return {
    type,
    fileId: input.file_id,
    fileSize: input.file_size,
    filename: input.file_name,
    mimeType: input.mime_type,
    caption,
  };
}

// Match the Node bridge: Telegram documents are reclassified by MIME type before upload.
function normalizedDocumentType(mimeType) {
  if (!mimeType) return "document";
  const normalized = mimeType.toLowerCase();
  if (normalized.startsWith("video/") || normalized === "image/gif") return "video";
  if (normalized.startsWith("image/")) return "photo";
  if (normalized.startsWith("audio/")) return "audio";
  return "document";
}

function selectLargestPhoto(photo) {
  if (!Array.isArray(photo) || photo.length === 0) return undefined;
  return [...photo].sort((a, b) => {
    const aSize = a.file_size ?? ((a.width ?? 0) * (a.height ?? 0));
    const bSize = b.file_size ?? ((b.width ?? 0) * (b.height ?? 0));
    return bSize - aSize;
  })[0];
}

function rubikaFileType(media) {
  if (media.fileSize !== undefined && media.fileSize >= 20 * 1024 * 1024) return "File";
  if (media.type === "photo") return "Image";
  if (media.type === "video" || media.type === "animation") return "Video";
  if (media.type === "audio" || media.type === "voice") return "Music";
  return "File";
}

// Rubika status edits are best effort. If editing fails, send a fresh status message.
async function updateRubikaStatus(chatId, messageId, text) {
  if (messageId) {
    try {
      await rubika("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
      });
      return;
    } catch (error) {
      console.warn("Failed to edit Rubika status", describeError(error));
    }
  }
  await rubika("sendMessage", { chat_id: chatId, text });
}

function messageIdFromPayload(payload) {
  return findStringDeep(payload, ["message_id", "messageId", "id"]);
}

function findFileId(payload) {
  return findStringDeep(payload, ["file_id", "fileId", "id"]);
}

function findStringDeep(value, keys, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return undefined;
  for (const key of keys) {
    const direct = value[key];
    if (typeof direct === "string" && direct.length > 0) return direct;
    if (typeof direct === "number") return String(direct);
  }
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      const found = findStringDeep(child, keys, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

async function createPairCode(env, telegramChatId) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 900000 + 100000);
    if (await env.BOT_KV.get(pendingKey(code))) continue;
    await putJson(env, pendingKey(code), {
      code,
      telegramChatId,
      expiresAt: Date.now() + PAIR_TTL_SECONDS * 1000,
    }, { expirationTtl: PAIR_TTL_SECONDS });
    return code;
  }
  throw new Error("Could not allocate pair code");
}

async function getPair(env, telegramChatId) {
  return getJson(env, pairKey(telegramChatId));
}

async function formatPairs(env) {
  const list = await env.BOT_KV.list({ prefix: "pair:" });
  if (!list.keys.length) return "هیچ اتصالی ثبت نشده است.";
  const pairs = [];
  for (const key of list.keys) {
    const pair = await getJson(env, key.name);
    if (pair?.telegramChatId && pair?.rubikaChatId) {
      pairs.push(`${pair.telegramChatId} -> ${pair.rubikaChatId}`);
    }
  }
  return [`اتصال‌های ثبت‌شده: ${pairs.length}`, ...pairs].join("\n");
}

async function saveRubikaOffset(env, update) {
  const offset = stringFrom(update, ["offset_id", "offsetId", "update_id", "updateId"]);
  if (offset) await env.BOT_KV.put("state:rubikaOffset", offset);
}

function normalizeRubikaUpdates(payload) {
  const data = extractEnvelopeData(payload);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.updates)) return data.updates;
  return [];
}

function normalizeRubikaTextUpdate(update) {
  const message = objectFrom(update?.message) ?? objectFrom(update?.new_message) ?? objectFrom(update);
  const chatId =
    stringFrom(message, ["chat_id", "chatId", "object_guid"]) ??
    stringFrom(objectFrom(message?.chat), ["chat_id", "chatId", "id", "object_guid"]) ??
    stringFrom(update, ["chat_id", "chatId", "object_guid"]);
  const text = stringFrom(message, ["text", "message", "body"]);
  if (!chatId || !text) return undefined;
  return { chatId, text };
}

function rubikaUpdateId(update) {
  return stringFrom(update, ["update_id", "updateId", "offset_id", "offsetId", "message_id", "update_time"]);
}

function parsePairCode(text) {
  return text.trim().match(/^(?:\/pair\s+)?(\d{6})$/)?.[1];
}

async function getJson(env, key) {
  const value = await env.BOT_KV.get(key);
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

async function putJson(env, key, value, options) {
  await env.BOT_KV.put(key, JSON.stringify(value), options);
}

function pairKey(telegramChatId) {
  return `pair:${telegramChatId}`;
}

function pendingKey(code) {
  return `pending:${code}`;
}

function processedKey(updateId) {
  return `processed:${updateId}`;
}

function objectFrom(value) {
  return value && typeof value === "object" ? value : undefined;
}

function stringFrom(source, keys) {
  if (!source || typeof source !== "object") return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

function chunkText(text, maxLength) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let index = remaining.lastIndexOf("\n", maxLength);
    if (index < maxLength * 0.5) index = remaining.lastIndexOf(" ", maxLength);
    if (index < maxLength * 0.5) index = maxLength;
    chunks.push(remaining.slice(0, index).trim());
    remaining = remaining.slice(index).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function filenameFromPath(path) {
  const name = String(path).split("/").filter(Boolean).pop();
  return name || "telegram-file.bin";
}

function safeFilename(name) {
  const value = String(name || "").split(/[\\/]/).filter(Boolean).pop();
  if (!value || value === "." || value === "..") return "telegram-file.bin";
  return value;
}

function formatTooLarge(type) {
  return `${persianTypeName(type)} ارسال نشد، چون حجم آن بیشتر از ${MAX_MEDIA_MB} مگابایت است.`;
}

function formatUploadStartedMessage(media) {
  return [
    `ارسال ${persianTypeName(media.type)} شروع شد.`,
    media.filename ? `نام فایل: ${media.filename}` : "",
    media.fileSize ? `اندازه: ${formatMegabytes(media.fileSize)}` : "",
  ].filter(Boolean).join("\n");
}

function formatUploadCompleteMessage(media) {
  return `ارسال ${persianTypeName(media.type)} کامل شد.`;
}

function formatUploadFailedMessage(media, error) {
  if (isRubikaUploadTooLargeError(error)) {
    return [
      `ارسال ${persianTypeName(media.type)} ناموفق بود.`,
      "روبیکا این فایل را به دلیل حجم زیاد در مرحله آپلود رد کرد.",
    ].join("\n");
  }
  return `ارسال ${persianTypeName(media.type)} ناموفق بود. لطفاً بعداً دوباره تلاش کنید.`;
}

function formatMegabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} مگابایت`;
}

function mediaFailureHint(error) {
  const message = describeError(error).toLowerCase();
  if (message.includes("file is too big") || message.includes("telegram file download")) {
    return "اگر فایل بزرگ است، محدودیت Telegram Bot API برای Worker معمولاً ۲۰ مگابایت است.";
  }
  if (isRetryableRubikaUploadError(error)) {
    return "سرور آپلود روبیکا خطای موقت داد. چند بار تلاش شد اما هنوز موفق نشد.";
  }
  if (isRubikaUploadTooLargeError(error)) {
    return "روبیکا این فایل را به دلیل حجم زیاد در مرحله آپلود رد کرد.";
  }
  return "خطا در دانلود از تلگرام یا آپلود به روبیکا رخ داد.";
}

function mediaErrorCode(error) {
  const message = describeError(error);
  if (message.includes("Telegram getFile")) return "TELEGRAM_GET_FILE";
  if (message.includes("Telegram file download")) return "TELEGRAM_DOWNLOAD";
  if (message.includes("requestSendFile")) return "RUBIKA_REQUEST_SEND_FILE";
  if (message.includes("uploadFile")) return "RUBIKA_UPLOAD";
  if (message.includes("sendFile")) return "RUBIKA_SEND_FILE";
  if (isRubikaUploadTooLargeError(error)) return "RUBIKA_UPLOAD_TOO_LARGE";
  return "MEDIA_FORWARD_FAILED";
}

function safeErrorForUser(error) {
  return describeError(error)
    .replace(TG_BOT_TOKEN, "[telegram-token]")
    .replace(RUBIKA_BOT_TOKEN, "[rubika-token]")
    .slice(0, 300);
}

function isInvalidInputError(error) {
  return error instanceof Error && error.message.includes("INVALID_INPUT");
}

function isRubikaUploadTooLargeError(error) {
  return (
    error instanceof Error &&
    error.message.includes("Rubika ") &&
    (error.message.includes("HTTP 413") || error.message.includes("Request Entity Too Large"))
  );
}

function isRetryableRubikaUploadError(error) {
  const message = describeError(error);
  return (
    message.includes("Rubika uploadFile") &&
    (message.includes("HTTP 500") ||
      message.includes("HTTP 502") ||
      message.includes("HTTP 503") ||
      message.includes("HTTP 504") ||
      message.includes("non-JSON HTTP 502") ||
      message.includes("non-JSON HTTP 503") ||
      message.includes("non-JSON HTTP 504"))
  );
}

function persianTypeName(type) {
  switch (type) {
    case "photo":
      return "عکس";
    case "document":
      return "فایل";
    case "video":
      return "ویدیو";
    case "animation":
      return "انیمیشن";
    case "audio":
      return "صدا";
    case "voice":
      return "ویس";
    default:
      return "پیام";
  }
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}
