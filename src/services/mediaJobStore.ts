import { randomUUID } from "node:crypto";
import type { AppPrismaClient } from "../db/prisma.js";
import type { NormalizedMessageType } from "../types/bridge.js";

export type MediaJobStatus =
  | "queued"
  | "uploading"
  | "fallback_uploading"
  | "sending"
  | "sent"
  | "failed";

export type MediaJobInput = {
  telegramUpdateId: number;
  telegramFileId: string;
  sourceChatId: string;
  rubikaChatId: string;
  messageType: NormalizedMessageType;
  caption?: string;
  originalFilename?: string;
  mimeType?: string;
  fileSize?: number;
};

export type MediaJobRecord = MediaJobInput & {
  id: string;
  status: MediaJobStatus;
  statusMessageId?: string;
  error?: string;
  attempts: number;
  retryAfter?: Date;
};

export class MediaJobStore {
  constructor(private readonly prisma: AppPrismaClient) {}

  async create(input: MediaJobInput): Promise<MediaJobRecord> {
    const job = await this.prisma.mediaJob.create({
      data: {
        id: randomUUID(),
        status: "queued",
        ...input,
      },
    });
    return toMediaJob(job);
  }

  async claimNextQueued(): Promise<MediaJobRecord | undefined> {
    const now = new Date();
    const job = await this.prisma.mediaJob.findFirst({
      where: {
        status: { in: ["queued", "uploading", "fallback_uploading", "sending"] },
        OR: [{ retryAfter: null }, { retryAfter: { lte: now } }],
      },
      orderBy: { createdAt: "asc" },
    });
    return job ? toMediaJob(job) : undefined;
  }

  async update(
    id: string,
    data: Partial<Pick<MediaJobRecord, "status" | "statusMessageId" | "attempts">> & {
      error?: string | null;
      retryAfter?: Date | null;
    },
  ): Promise<MediaJobRecord> {
    const job = await this.prisma.mediaJob.update({
      where: { id },
      data,
    });
    return toMediaJob(job);
  }
}

function toMediaJob(job: {
  id: string;
  status: string;
  telegramUpdateId: number;
  telegramFileId: string;
  sourceChatId: string;
  rubikaChatId: string;
  messageType: string;
  caption: string | null;
  originalFilename: string | null;
  mimeType: string | null;
  fileSize: number | null;
  statusMessageId: string | null;
  error: string | null;
  attempts: number;
  retryAfter: Date | null;
}): MediaJobRecord {
  return {
    id: job.id,
    status: job.status as MediaJobStatus,
    telegramUpdateId: job.telegramUpdateId,
    telegramFileId: job.telegramFileId,
    sourceChatId: job.sourceChatId,
    rubikaChatId: job.rubikaChatId,
    messageType: job.messageType as NormalizedMessageType,
    caption: job.caption ?? undefined,
    originalFilename: job.originalFilename ?? undefined,
    mimeType: job.mimeType ?? undefined,
    fileSize: job.fileSize ?? undefined,
    statusMessageId: job.statusMessageId ?? undefined,
    error: job.error ?? undefined,
    attempts: job.attempts,
    retryAfter: job.retryAfter ?? undefined,
  };
}
