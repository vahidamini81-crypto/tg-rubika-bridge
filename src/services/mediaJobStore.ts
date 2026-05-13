import { randomUUID } from "node:crypto";
import type { AppPrismaClient } from "../db/prisma.js";
import type { NormalizedMessageType } from "../types/bridge.js";

export type MediaJobStatus =
  | "queued"
  | "uploading"
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
  constructor(
    private readonly prisma: AppPrismaClient,
    private readonly staleUploadingMs = 15 * 60 * 1000,
  ) {}

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
    const staleBefore = new Date(now.getTime() - this.staleUploadingMs);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const claimed = await this.prisma.$transaction(async (tx) => {
        const job = await tx.mediaJob.findFirst({
          where: {
            OR: [
              {
                status: "queued",
                OR: [{ retryAfter: null }, { retryAfter: { lte: now } }],
              },
              {
                status: "uploading",
                updatedAt: { lt: staleBefore },
              },
            ],
          },
          orderBy: { createdAt: "asc" },
        });
        if (!job) return undefined;

        const result = await tx.mediaJob.updateMany({
          where: {
            id: job.id,
            status: job.status,
            updatedAt: job.updatedAt,
          },
          data: {
            status: "uploading",
            retryAfter: null,
          },
        });
        if (result.count !== 1) return undefined;

        const updated = await tx.mediaJob.findUnique({ where: { id: job.id } });
        return updated ? toMediaJob(updated) : undefined;
      });
      if (claimed) return claimed;
    }

    return undefined;
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
  updatedAt: Date;
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
