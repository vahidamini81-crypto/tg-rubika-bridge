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
import type { MediaJobRecord, MediaJobStore } from "./mediaJobStore.js";
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
  maxFileMb: number;
  tmpDir: string;
  fetchFn?: typeof fetch;
};

type UploadStatus = "uploaded" | "uploaded_as_file" | "failed";
const LARGE_MEDIA_AS_FILE_THRESHOLD_BYTES = 20 * 1024 * 1024;
const MAX_MEDIA_JOB_ATTEMPTS = 6;
const MEDIA_JOB_RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 300_000];

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
        normalized.text,
      );
      if (handled) return;
    }

    if (normalized.type === "text") {
      await this.deliverText(normalized, formatTextMessage(normalized));
      return;
    }

    if (!isMediaMessage(normalized.type)) {
      await this.deliverText(normalized, formatUnsupportedMessage(normalized));
      return;
    }

    if (this.mediaJobStore) {
      await this.enqueueMedia(normalized);
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

    const maxBytes = Math.floor(this.config.maxFileMb * 1024 * 1024);
    if (message.fileSize !== undefined && message.fileSize > maxBytes) {
      await this.deliverText(message, formatSkippedFileMessage(message, this.config.maxFileMb));
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
      if (telegramFile.file_size !== undefined && telegramFile.file_size > maxBytes) {
        await this.deliverText(message, formatSkippedFileMessage(message, this.config.maxFileMb));
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

      await this.updateUploadStatus(chatId, message, formatUploadStartedMessage(message, fileType));
      const uploadResult = await this.uploadToRubika(fileType, uploadPath, chatId, message);
      const fileId = uploadResult.fileId;
      if (!fileId) {
        throw new Error("Rubika upload did not return file_id");
      }
      const caption = formatMediaCaption(message);

      try {
        await this.rubika.sendFile(chatId, fileId, caption);
        await this.updateUploadStatus(chatId, message, formatUploadCompleteMessage(message, uploadResult.status));
      } catch (error) {
        this.logger.error({ error, chatId }, "Failed to deliver Rubika file message");
        await this.updateUploadStatus(chatId, message, formatUploadFailedMessage(message));
      }
    } catch (error) {
      if (error instanceof FileTooLargeError) {
        await this.deliverText(message, formatSkippedFileMessage(message, this.config.maxFileMb));
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

  private async enqueueMedia(message: NormalizedMessage): Promise<void> {
    if (!this.mediaJobStore || !message.telegramFileId) return;
    const chatId = await this.destinationChatId(message);
    if (!chatId) return;
    const job = await this.mediaJobStore.create({
      telegramUpdateId: message.telegramUpdateId,
      telegramFileId: message.telegramFileId,
      sourceChatId: message.sourceChatId,
      rubikaChatId: chatId,
      messageType: message.type,
      caption: message.caption,
      originalFilename: message.originalFilename,
      mimeType: message.mimeType,
      fileSize: message.fileSize,
    });
    const statusMessageId = await this.rubika.sendMessage(chatId, formatQueuedMessage(message));
    if (statusMessageId) await this.mediaJobStore.update(job.id, { statusMessageId });
  }

  async processMediaJob(job: MediaJobRecord): Promise<void> {
    const message = messageFromJob(job);
    await this.mediaJobStore?.update(job.id, { status: "uploading", attempts: job.attempts + 1 });
    try {
      await this.deliverMedia(message);
      await this.mediaJobStore?.update(job.id, { status: "sent", error: null, retryAfter: null });
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
        });
        await this.updateUploadStatus(job.rubikaChatId, message, formatUploadRetryMessage(message, retryAfter, nextAttempts));
        return;
      }
      await this.mediaJobStore?.update(job.id, {
        status: "failed",
        attempts: nextAttempts,
        error: errorMessage,
        retryAfter: null,
      });
      await this.updateUploadStatus(job.rubikaChatId, message, formatUploadFailedMessage(message));
      throw error;
    }
  }

  private async uploadToRubika(
    fileType: RubikaFileType,
    uploadPath: string,
    chatId: string,
    message: NormalizedMessage,
  ): Promise<{ fileId: string; status: UploadStatus }> {
    const request = await this.rubika.requestSendFile(fileType);
    try {
      const uploadedFileId = await this.rubika.uploadFile(request.uploadUrl, uploadPath);
      return { fileId: uploadedFileId || request.fileId || "", status: "uploaded" };
    } catch (error) {
      if (fileType === "File" || !isRubikaUploadGatewayError(error)) throw error;
      this.logger.warn(
        { error, fileType },
        "Rubika playable media upload failed; retrying as generic file",
      );
      await this.updateUploadStatus(chatId, message, formatUploadFallbackMessage(message));
      const fallbackRequest = await this.rubika.requestSendFile("File");
      const fallbackFileId = await this.rubika.uploadFile(fallbackRequest.uploadUrl, uploadPath);
      return { fileId: fallbackFileId || fallbackRequest.fileId || "", status: "uploaded_as_file" };
    }
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
    private readonly pollIntervalMs = 500,
  ) {}

  async start(): Promise<void> {
    this.running = true;
    while (this.running) {
      const job = await this.mediaJobStore.claimNextQueued();
      if (!job) {
        await sleep(this.pollIntervalMs);
        continue;
      }
      try {
        await this.bridge.processMediaJob(job);
      } catch (error) {
        this.logger.error({ error, jobId: job.id }, "Media job failed");
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

function formatQueuedMessage(message: NormalizedMessage): string {
  return [
    `Queued ${message.type} for upload.`,
    message.originalFilename ? `File: ${message.originalFilename}` : "",
    message.fileSize ? `Size: ${formatMegabytes(message.fileSize)}` : "",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function formatMediaCaption(message: NormalizedMessage): string {
  return message.caption ?? "";
}

function formatUnsupportedMessage(_message: NormalizedMessage): string {
  return "Unsupported Telegram message type.";
}

function formatSkippedFileMessage(message: NormalizedMessage, maxFileMb: number): string {
  return [
    `Telegram ${message.type} skipped because it is larger than ${maxFileMb} MB.`,
    message.caption ? `Caption: ${message.caption}` : "",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function formatTelegramDownloadLimitMessage(message: NormalizedMessage): string {
  return [
    `Telegram ${message.type} could not be forwarded because Telegram Bot API refused the file download as too large.`,
    "To forward large Telegram files, run a local Telegram Bot API server or use a Telegram client API downloader.",
    message.caption ? `Caption: ${message.caption}` : "",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function formatUploadStartedMessage(message: NormalizedMessage, fileType: RubikaFileType): string {
  return [
    `Uploading ${message.type} to Rubika as ${fileType}. Large files can take a few minutes.`,
    message.originalFilename ? `File: ${message.originalFilename}` : "",
    message.fileSize ? `Size: ${formatMegabytes(message.fileSize)}` : "",
  ]
    .filter((part) => part !== "")
    .join("\n");
}

function formatUploadRetryMessage(message: NormalizedMessage, retryAfter: Date, attempts: number): string {
  return [
    `Rubika upload for ${message.type} is still failing; retrying automatically.`,
    `Attempt: ${attempts + 1}/${MAX_MEDIA_JOB_ATTEMPTS}`,
    `Next retry: ${retryAfter.toISOString()}`,
  ].join("\n");
}

function formatUploadFallbackMessage(message: NormalizedMessage): string {
  return [
    `Rubika had trouble accepting this ${message.type} as playable media.`,
    "Retrying as a regular file now.",
  ].join("\n");
}

function formatUploadCompleteMessage(message: NormalizedMessage, status: UploadStatus): string {
  if (status === "uploaded_as_file") {
    return [
      `Finished uploading ${message.type}. Rubika accepted it as a regular file.`,
    ].join("\n");
  }
  return `Finished uploading ${message.type}.`;
}

function formatUploadFailedMessage(message: NormalizedMessage): string {
  return [
    `Failed to send ${message.type} after uploading. Please try again later.`,
  ].join("\n");
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function messageFromJob(job: MediaJobRecord): NormalizedMessage {
  return {
    sourcePlatform: "telegram",
    telegramUpdateId: job.telegramUpdateId,
    sourceChatId: job.sourceChatId,
    type: job.messageType,
    caption: job.caption,
    telegramFileId: job.telegramFileId,
    originalFilename: job.originalFilename,
    mimeType: job.mimeType,
    fileSize: job.fileSize,
    isForwarded: false,
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
  return isRubikaUploadGatewayError(error);
}

function mediaJobRetryDelayMs(attempts: number): number {
  return MEDIA_JOB_RETRY_DELAYS_MS[Math.min(attempts - 1, MEDIA_JOB_RETRY_DELAYS_MS.length - 1)] ?? 300_000;
}

function isTelegramFileTooBigError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("file is too big");
}

function isRubikaUploadGatewayError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("Rubika uploadFile failed") &&
    (error.message.includes("HTTP 502") || error.message.includes("HTTP 504"))
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
