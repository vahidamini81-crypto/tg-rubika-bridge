import type { AppLogger } from "../logger.js";
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { NormalizedMessage } from "../types/bridge.js";
import type { RubikaFileType, RubikaRequestSendFileResult } from "../types/rubika.js";
import type {
  TelegramFile,
  TelegramMessage,
  TelegramPhotoSize,
  TelegramUpdate,
} from "../types/telegram.js";
import { chunkText } from "../utils/chunkText.js";
import { isMediaMessage, toRubikaFileType } from "../utils/mediaType.js";
import { deleteTempFile, downloadUrlToTempFile, FileTooLargeError } from "../utils/tempFiles.js";
import { sleep } from "../utils/retry.js";
import type { MediaJobLane, MediaJobRecord, MediaJobStore } from "./mediaJobStore.js";
import type { PairStore } from "./pairStore.js";
import type { PairingService } from "./pairingService.js";

export type TelegramBridgeClient = {
  getFile(fileId: string): Promise<TelegramFile>;
  getFileDownloadUrl(filePath: string): string;
};

export type RubikaBridgeClient = {
  sendMessage(chatId: string, text: string): Promise<string | undefined>;
  editMessageText?(chatId: string, messageId: string, text: string): Promise<void>;
  requestSendFile(type: RubikaFileType): Promise<RubikaRequestSendFileResult>;
  uploadFile(uploadUrl: string, filePath: string): Promise<string>;
  sendFile(chatId: string, fileId: string, text?: string): Promise<void>;
};

export type BridgeServiceConfig = {
  publicMaxFileMb?: number;
  adminMaxFileMb?: number;
  maxFileMb?: number;
  tmpDir: string;
  publicQueueMaxWaiting?: number;
  fetchFn?: typeof fetch;
};

type UploadStatus = "uploaded";
const LARGE_MEDIA_AS_FILE_THRESHOLD_BYTES = 20 * 1024 * 1024;
const MAX_MEDIA_JOB_ATTEMPTS = 6;
const MEDIA_JOB_RETRY_DELAYS_MS = [1_000, 3_000, 10_000, 10_000, 10_000];

export class BridgeService {
  constructor(
    private readonly telegram: TelegramBridgeClient,
    private readonly rubika: RubikaBridgeClient,
    private readonly pairStore: PairStore,
    private readonly pairing: PairingService,
    private readonly config: BridgeServiceConfig,
    private readonly logger: AppLogger,
    private readonly mediaJobStore?: MediaJobStore,
  ) {}

  normalizeUpdate(update: TelegramUpdate): NormalizedMessage | undefined {
    const message = update.message ?? update.channel_post;
    if (!message) return undefined;

    const base = this.baseMessage(update.update_id, message);
    if (message.text !== undefined) {
      return { ...base, type: "text", text: message.text };
    }

    const photo = selectLargestPhoto(message.photo);
    if (photo) {
      return {
        ...base,
        type: "photo",
        caption: message.caption,
        telegramFileId: photo.file_id,
        fileSize: photo.file_size,
      };
    }

    if (message.document) {
      const documentType = normalizedDocumentType(message.document.mime_type);
      return {
        ...base,
        type: documentType,
        caption: message.caption,
        telegramFileId: message.document.file_id,
        originalFilename: message.document.file_name,
        mimeType: message.document.mime_type,
        fileSize: message.document.file_size,
      };
    }

    if (message.animation) {
      return {
        ...base,
        type: "animation",
        caption: message.caption,
        telegramFileId: message.animation.file_id,
        originalFilename: message.animation.file_name,
        mimeType: message.animation.mime_type,
        fileSize: message.animation.file_size,
      };
    }

    if (message.video) {
      return {
        ...base,
        type: "video",
        caption: message.caption,
        telegramFileId: message.video.file_id,
        originalFilename: message.video.file_name,
        mimeType: message.video.mime_type,
        fileSize: message.video.file_size,
      };
    }

    if (message.audio) {
      return {
        ...base,
        type: "audio",
        caption: message.caption,
        telegramFileId: message.audio.file_id,
        originalFilename: message.audio.file_name,
        mimeType: message.audio.mime_type,
        fileSize: message.audio.file_size,
      };
    }

    if (message.voice) {
      return {
        ...base,
        type: "voice",
        caption: message.caption,
        telegramFileId: message.voice.file_id,
        mimeType: message.voice.mime_type,
        fileSize: message.voice.file_size,
      };
    }

    return { ...base, type: "unsupported" };
  }

  async processUpdate(update: TelegramUpdate): Promise<void> {
    const normalized = this.normalizeUpdate(update);
    if (!normalized) return;

    if (normalized.type === "text" && normalized.text) {
      const handled = await this.pairing.handleTelegramCommand(
        normalized.sourceChatId,
        normalized.telegramUserId,
        normalized.text,
      );
      if (handled) return;
    }

    if (this.mediaJobStore) {
      await this.enqueueDelivery(normalized);
      return;
    }

    if (normalized.type === "text") {
      await this.deliverText(normalized, formatTextMessage(normalized));
      return;
    }

    if (!isMediaMessage(normalized.type)) {
      await this.deliverText(normalized, formatUnsupportedMessage(normalized));
      return;
    }

    await this.deliverMedia(normalized);
  }

  private baseMessage(updateId: number, message: TelegramMessage): Omit<NormalizedMessage, "type"> {
    return {
      sourcePlatform: "telegram",
      telegramUpdateId: updateId,
      sourceChatId: String(message.chat.id),
      sourceMessageId: message.message_id,
      telegramUserId: message.from?.id,
      senderDisplayName: displayName(message),
      isForwarded: Boolean(
        message.forward_origin ??
          message.forward_from ??
          message.forward_from_chat ??
          message.forward_sender_name,
      ),
    };
  }

  private async deliverText(message: NormalizedMessage, text: string): Promise<void> {
    const chatId = await this.destinationChatId(message);
    if (!chatId) return;

    const chunks = chunkText(text, 3500);
    for (const chunk of chunks) {
      try {
        await this.rubika.sendMessage(chatId, chunk);
      } catch (error) {
        this.logger.error({ error, chatId }, "Failed to deliver Rubika text message");
        break;
      }
    }
  }

  private async deliverMedia(message: NormalizedMessage): Promise<void> {
    if (!message.telegramFileId) {
      await this.deliverText(message, formatUnsupportedMessage(message));
      return;
    }

    const maxFileMb = this.maxFileMbForMessage(message);
    const maxBytes = maxFileMb === undefined ? undefined : Math.floor(maxFileMb * 1024 * 1024);
    if (maxFileMb !== undefined && maxBytes !== undefined && message.fileSize !== undefined && message.fileSize > maxBytes) {
      await this.deliverText(message, formatSkippedFileMessage(message, maxFileMb));
      return;
    }

    let tempPath: string | undefined;
    try {
      const chatId = await this.destinationChatId(message);
      if (!chatId) return;

      const fileType = initialRubikaFileType(message);
      const telegramFile = await this.telegram.getFile(message.telegramFileId);
      if (!telegramFile.file_path) {
        throw new Error("Telegram getFile did not return file_path");
      }
      if (maxFileMb !== undefined && maxBytes !== undefined && telegramFile.file_size !== undefined && telegramFile.file_size > maxBytes) {
        await this.deliverText(message, formatSkippedFileMessage(message, maxFileMb));
        return;
      }

      let uploadPath: string;
      if (await isReadableLocalFile(telegramFile.file_path)) {
        uploadPath = telegramFile.file_path;
      } else {
        const downloadUrl = this.telegram.getFileDownloadUrl(telegramFile.file_path);
        const downloaded = await downloadUrlToTempFile(downloadUrl, {
          tmpDir: this.config.tmpDir,
          maxBytes,
          filenameHint: message.originalFilename ?? telegramFile.file_path,
          fetchFn: this.config.fetchFn,
        });
        tempPath = downloaded.path;
        uploadPath = downloaded.path;
      }

      const uploadResult = await this.uploadToRubika(fileType, uploadPath);
      const fileId = uploadResult.fileId;
      if (!fileId) {
        throw new Error("Rubika upload did not return file_id");
      }
      const caption = formatMediaCaption(message);

      try {
        await this.rubika.sendFile(chatId, fileId, caption);
        await this.updateUploadStatus(chatId, message, formatUploadCompleteMessage(message));
      } catch (error) {
        this.logger.error({ error, chatId }, "Failed to deliver Rubika file message");
        await this.updateUploadStatus(chatId, message, formatUploadFailedMessage(message));
        throw error;
      }
    } catch (error) {
      if (error instanceof FileTooLargeError) {
        await this.deliverText(message, formatSkippedFileMessage(message, bytesToMegabytes(error.maxBytes)));
        return;
      }
      if (isTelegramFileTooBigError(error)) {
        await this.deliverText(message, formatTelegramDownloadLimitMessage(message));
        return;
      }
      throw error;
    } finally {
      await deleteTempFile(tempPath);
    }
  }

  private async destinationChatId(message: NormalizedMessage): Promise<string | undefined> {
    const pair = await this.pairStore.getByTelegramChatId(message.sourceChatId);
    if (pair) return pair.rubikaChatId;

    await this.pairing.notifyTelegramNotPaired(message.sourceChatId);
    return undefined;
  }

  private maxFileMbForMessage(message: NormalizedMessage): number | undefined {
    if (this.pairing.isAdmin(message.telegramUserId)) return this.config.adminMaxFileMb;
    return this.config.publicMaxFileMb ?? this.config.maxFileMb ?? 100;
  }

  private async enqueueDelivery(message: NormalizedMessage): Promise<void> {
    if (!this.mediaJobStore) return;
    const chatId = await this.destinationChatId(message);
    if (!chatId) return;
    const lane: MediaJobLane = this.pairing.isAdmin(message.telegramUserId) ? "admin" : "public";
    if (lane === "public") {
      const waiting = await this.mediaJobStore.countWaiting("public");
      const maxWaiting = this.config.publicQueueMaxWaiting ?? 25;
      if (waiting >= maxWaiting) {
        await this.pairing.notifyTelegramQueueFull(message.sourceChatId, maxWaiting);
        await this.pairing.refreshTelegramStatus(message.sourceChatId);
        return;
      }
    }
    const job = await this.mediaJobStore.create({
      lane,
      telegramUpdateId: message.telegramUpdateId,
      telegramFileId: message.telegramFileId,
      sourceChatId: message.sourceChatId,
      telegramUserId: message.telegramUserId,
      sourceMessageId: message.sourceMessageId,
      senderDisplayName: message.senderDisplayName,
      rubikaChatId: chatId,
      messageType: message.type,
      text: message.text,
      caption: message.caption,
      originalFilename: message.originalFilename,
      mimeType: message.mimeType,
      fileSize: message.fileSize,
      isForwarded: message.isForwarded,
    });
    try {
      const position = (await this.mediaJobStore.countWaitingAhead(lane, job.createdAt)) + 1;
      const statusMessageId = await this.rubika.sendMessage(chatId, formatQueuedMessage(message, lane, position));
      if (statusMessageId) await this.mediaJobStore.update(job.id, { statusMessageId });
      await this.pairing.refreshTelegramStatus(message.sourceChatId);
    } catch (error) {
      this.logger.warn({ error, jobId: job.id, chatId }, "Failed to create Rubika queue status message");
      await this.pairing.refreshTelegramStatus(message.sourceChatId);
    }
  }

  async processMediaJob(job: MediaJobRecord): Promise<void> {
    const message = messageFromJob(job);
    await this.mediaJobStore?.update(job.id, { status: "uploading", attempts: job.attempts + 1 });
    try {
      if (message.type === "text") {
        await this.rubika.sendMessage(job.rubikaChatId, formatTextMessage(message));
        await this.updateUploadStatus(job.rubikaChatId, message, "ارسال پیام کامل شد.");
        await this.mediaJobStore?.update(job.id, {
          status: "sent",
          statusMessageId: message.statusMessageId,
          error: null,
          retryAfter: null,
        });
        await this.pairing.refreshTelegramStatus(job.sourceChatId);
        return;
      }

      if (!isMediaMessage(message.type)) {
        await this.rubika.sendMessage(job.rubikaChatId, formatUnsupportedMessage(message));
        await this.updateUploadStatus(job.rubikaChatId, message, "ارسال پیام کامل شد.");
        await this.mediaJobStore?.update(job.id, {
          status: "sent",
          statusMessageId: message.statusMessageId,
          error: null,
          retryAfter: null,
        });
        await this.pairing.refreshTelegramStatus(job.sourceChatId);
        return;
      }

      this.logger.info(
        {
          jobId: job.id,
          telegramFileId: job.telegramFileId,
          messageType: job.messageType,
          attempt: job.attempts + 1,
          rubikaChatId: job.rubikaChatId,
        },
        "Processing media job",
      );
      await this.deliverMedia(message);
      await this.mediaJobStore?.update(job.id, {
        status: "sent",
        statusMessageId: message.statusMessageId,
        error: null,
        retryAfter: null,
      });
      await this.pairing.refreshTelegramStatus(job.sourceChatId);
    } catch (error) {
      const nextAttempts = job.attempts + 1;
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (nextAttempts < MAX_MEDIA_JOB_ATTEMPTS && isRetryableMediaJobError(error)) {
        const retryAfter = new Date(Date.now() + mediaJobRetryDelayMs(nextAttempts));
        await this.mediaJobStore?.update(job.id, {
          status: "queued",
          attempts: nextAttempts,
          error: errorMessage,
          retryAfter,
          statusMessageId: message.statusMessageId,
        });
        this.logger.warn(
          {
            error,
            jobId: job.id,
            telegramFileId: job.telegramFileId,
            messageType: job.messageType,
            attempt: nextAttempts,
            retryAfter,
            rubikaChatId: job.rubikaChatId,
          },
          "Media job failed with retryable error",
        );
        await this.updateUploadStatus(job.rubikaChatId, message, formatUploadRetryMessage(message, retryAfter, nextAttempts));
        await this.mediaJobStore?.update(job.id, { statusMessageId: message.statusMessageId });
        await this.pairing.refreshTelegramStatus(job.sourceChatId);
        return;
      }
      await this.mediaJobStore?.update(job.id, {
        status: "failed",
        attempts: nextAttempts,
        error: errorMessage,
        retryAfter: null,
        statusMessageId: message.statusMessageId,
      });
      await this.updateUploadStatus(job.rubikaChatId, message, formatUploadFailedMessage(message, error));
      await this.mediaJobStore?.update(job.id, { statusMessageId: message.statusMessageId });
      await this.pairing.refreshTelegramStatus(job.sourceChatId);
      throw error;
    }
  }

  private async uploadToRubika(
    fileType: RubikaFileType,
    uploadPath: string,
  ): Promise<{ fileId: string; status: UploadStatus }> {
    const request = await this.rubika.requestSendFile(fileType);
    const uploadedFileId = await this.rubika.uploadFile(request.uploadUrl, uploadPath);
    return { fileId: uploadedFileId || request.fileId || "", status: "uploaded" };
  }

  private async updateUploadStatus(chatId: string, message: NormalizedMessage, text: string): Promise<void> {
    try {
      if (message.statusMessageId && this.rubika.editMessageText) {
        await this.rubika.editMessageText(chatId, message.statusMessageId, text);
        return;
      }
      const messageId = await this.rubika.sendMessage(chatId, text);
      if (messageId) message.statusMessageId = messageId;
    } catch (error) {
      this.logger.warn({ error, chatId }, "Failed to send Rubika upload status message");
      if (message.statusMessageId) {
        message.statusMessageId = undefined;
        const messageId = await this.rubika.sendMessage(chatId, text);
        if (messageId) message.statusMessageId = messageId;
      }
    }
  }
}

export class MediaJobWorker {
  private running = false;

  constructor(
    private readonly mediaJobStore: MediaJobStore,
    private readonly bridge: Pick<BridgeService, "processMediaJob">,
    private readonly logger: AppLogger,
    private readonly pollIntervalMs = 250,
    private readonly concurrency = 1,
    private readonly lane: MediaJobLane = "public",
  ) {}

  async start(): Promise<void> {
    this.running = true;
    await Promise.all(
      Array.from({ length: this.concurrency }, (_, index) => this.runLoop(index + 1)),
    );
  }

  private async runLoop(workerId: number): Promise<void> {
    while (this.running) {
      const job = await this.mediaJobStore.claimNextQueued(this.lane);
      if (!job) {
        await sleep(this.pollIntervalMs);
        continue;
      }
      try {
        this.logger.debug({ workerId, jobId: job.id }, "Media worker claimed job");
        await this.bridge.processMediaJob(job);
      } catch (error) {
        this.logger.error({ error, workerId, jobId: job.id }, "Media job failed");
      }
    }
  }

  stop(): void {
    this.running = false;
  }
}

function selectLargestPhoto(photo?: TelegramPhotoSize[]): TelegramPhotoSize | undefined {
  if (!photo || photo.length === 0) return undefined;
  return [...photo].sort((a, b) => {
    const aSize = a.file_size ?? a.width * a.height;
    const bSize = b.file_size ?? b.width * b.height;
    return bSize - aSize;
  })[0];
}

function displayName(message: TelegramMessage): string | undefined {
  if (message.from) {
    const name = [message.from.first_name, message.from.last_name].filter(Boolean).join(" ");
    if (name) return name;
    if (message.from.username) return `@${message.from.username}`;
  }
  if (message.sender_chat?.title) return message.sender_chat.title;
  if (message.chat.title) return message.chat.title;
  if (message.chat.username) return `@${message.chat.username}`;
  const chatName = [message.chat.first_name, message.chat.last_name].filter(Boolean).join(" ");
  return chatName || undefined;
}

function normalizedDocumentType(mimeType: string | undefined): NormalizedMessage["type"] {
  if (!mimeType) return "document";
  const normalized = mimeType.toLowerCase();
  if (normalized.startsWith("video/") || normalized === "image/gif") return "video";
  if (normalized.startsWith("image/")) return "photo";
  if (normalized.startsWith("audio/")) return "audio";
  return "document";
}

function formatTextMessage(message: NormalizedMessage): string {
  return message.text ?? "";
}

function formatQueuedMessage(message: NormalizedMessage, lane: MediaJobLane, position: number): string {
  if (lane === "admin") {
    return [
      `${persianTypeName(message.type)} در صف ویژه ادمین قرار گرفت.`,
      `جایگاه فعلی: ${position}`,
      message.originalFilename ? `نام فایل: ${message.originalFilename}` : "",
      message.fileSize ? `اندازه: ${formatMegabytes(message.fileSize)}` : "",
    ]
      .filter((part) => part !== "")
      .join("\n");
  }

  return [
    `${persianTypeName(message.type)} شما در صف ارسال است.`,
    `جایگاه فعلی: ${position}`,
    message.originalFilename ? `نام فایل: ${message.originalFilename}` : "",
    message.fileSize ? `اندازه: ${formatMegabytes(message.fileSize)}` : "",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function formatMediaCaption(message: NormalizedMessage): string {
  return message.caption ?? "";
}

function formatUnsupportedMessage(_message: NormalizedMessage): string {
  return "این نوع پیام تلگرام پشتیبانی نمی‌شود.";
}

function formatSkippedFileMessage(message: NormalizedMessage, maxFileMb: number): string {
  return [
    `${persianTypeName(message.type)} ارسال نشد، چون حجم آن بیشتر از ${maxFileMb} مگابایت است.`,
    message.caption ? `متن همراه: ${message.caption}` : "",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function formatTelegramDownloadLimitMessage(message: NormalizedMessage): string {
  return [
    `${persianTypeName(message.type)} ارسال نشد، چون Telegram Bot API دانلود فایل را به دلیل حجم زیاد رد کرد.`,
    "برای ارسال فایل‌های بزرگ تلگرام، از سرور محلی Telegram Bot API یا دانلودر Telegram Client API استفاده کنید.",
    message.caption ? `متن همراه: ${message.caption}` : "",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function formatUploadRetryMessage(message: NormalizedMessage, retryAfter: Date, attempts: number): string {
  return [
    `ارسال ${persianTypeName(message.type)} به روبیکا هنوز ناموفق است؛ دوباره خودکار تلاش می‌شود.`,
    `تلاش بعدی: ${attempts + 1}/${MAX_MEDIA_JOB_ATTEMPTS}`,
    `زمان تلاش بعدی: ${retryAfter.toISOString()}`,
  ].join("\n");
}

function formatUploadCompleteMessage(message: NormalizedMessage): string {
  return `ارسال ${persianTypeName(message.type)} کامل شد.`;
}

function formatUploadFailedMessage(message: NormalizedMessage, error?: unknown): string {
  if (isRubikaUploadTooLargeError(error)) {
    return [
      `ارسال ${persianTypeName(message.type)} ناموفق بود.`,
      "روبیکا این فایل را به دلیل حجم زیاد در مرحله آپلود رد کرد؛ تلاش دوباره با همین فایل معمولاً کمکی نمی‌کند.",
    ].join("\n");
  }
  return `ارسال ${persianTypeName(message.type)} ناموفق بود. لطفاً بعداً دوباره تلاش کنید.`;
}

function formatMegabytes(bytes: number): string {
  return `${bytesToMegabytes(bytes).toFixed(1)} مگابایت`;
}

function bytesToMegabytes(bytes: number): number {
  return bytes / 1024 / 1024;
}

function persianTypeName(type: NormalizedMessage["type"]): string {
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
    case "text":
      return "متن";
    case "unsupported":
    default:
      return "پیام";
  }
}

function messageFromJob(job: MediaJobRecord): NormalizedMessage {
  return {
    sourcePlatform: "telegram",
    telegramUpdateId: job.telegramUpdateId,
    sourceChatId: job.sourceChatId,
    telegramUserId: job.telegramUserId,
    sourceMessageId: job.sourceMessageId,
    type: job.messageType,
    text: job.text,
    caption: job.caption,
    telegramFileId: job.telegramFileId,
    originalFilename: job.originalFilename,
    mimeType: job.mimeType,
    fileSize: job.fileSize,
    senderDisplayName: job.senderDisplayName,
    isForwarded: job.isForwarded,
    statusMessageId: job.statusMessageId,
  };
}

function initialRubikaFileType(message: NormalizedMessage): RubikaFileType {
  if (message.fileSize !== undefined && message.fileSize >= LARGE_MEDIA_AS_FILE_THRESHOLD_BYTES) {
    return "File";
  }
  return toRubikaFileType(message.type);
}

function isRetryableMediaJobError(error: unknown): boolean {
  return isRubikaTransientError(error);
}

function mediaJobRetryDelayMs(attempts: number): number {
  return MEDIA_JOB_RETRY_DELAYS_MS[Math.min(attempts - 1, MEDIA_JOB_RETRY_DELAYS_MS.length - 1)] ?? 10_000;
}

function isTelegramFileTooBigError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("file is too big");
}

function isRubikaTransientError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("Rubika ") &&
    (error.message.includes("HTTP 500") ||
      error.message.includes("HTTP 502") ||
      error.message.includes("HTTP 503") ||
      error.message.includes("HTTP 504"))
  );
}

function isRubikaUploadTooLargeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("Rubika ") &&
    (error.message.includes("HTTP 413") || error.message.includes("Request Entity Too Large"))
  );
}

async function isReadableLocalFile(filePath: string): Promise<boolean> {
  if (!isAbsolute(filePath)) return false;
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
