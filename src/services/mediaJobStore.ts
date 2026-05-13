import { randomUUID } from "node:crypto";
import type { AppPrismaClient } from "../db/prisma.js";
import type { NormalizedMessageType } from "../types/bridge.js";

export type MediaJobStatus =
  | "queued"
  | "uploading"
  | "sending"
  | "sent"
  | "failed";

export type MediaJobLane = "public" | "admin";

export type MediaJobInput = {
  lane: MediaJobLane;
  telegramUpdateId: number;
  telegramFileId?: string;
  sourceChatId: string;
  telegramUserId?: number;
  sourceMessageId?: number;
  senderDisplayName?: string;
  rubikaChatId: string;
  messageType: NormalizedMessageType;
  text?: string;
  caption?: string;
  originalFilename?: string;
  mimeType?: string;
  fileSize?: number;
  isForwarded: boolean;
};

export type MediaJobRecord = MediaJobInput & {
  id: string;
  status: MediaJobStatus;
  statusMessageId?: string;
  error?: string;
  attempts: number;
  retryAfter?: Date;
};

export type MediaJobStats = {
  pairCount?: number;
  publicQueued: number;
  publicActive: number;
  publicRetryWaiting: number;
  adminQueued: number;
  adminActive: number;
  adminRetryWaiting: number;
  failed: number;
  oldestQueuedAt?: Date;
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

  async claimNextQueued(lane: MediaJobLane = "public"): Promise<MediaJobRecord | undefined> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - this.staleUploadingMs);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const claimed = await this.prisma.$transaction(async (tx) => {
        const job = await tx.mediaJob.findFirst({
          where: {
            OR: [
              {
                lane,
                status: "queued",
                OR: [{ retryAfter: null }, { retryAfter: { lte: now } }],
              },
              {
                lane,
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

  async countWaiting(lane: MediaJobLane): Promise<number> {
    const now = new Date();
    return this.prisma.mediaJob.count({
      where: {
        lane,
        status: "queued",
        OR: [{ retryAfter: null }, { retryAfter: { lte: now } }],
      },
    });
  }

  async countWaitingAhead(lane: MediaJobLane, createdBefore: Date): Promise<number> {
    const now = new Date();
    return this.prisma.mediaJob.count({
      where: {
        lane,
        status: "queued",
        createdAt: { lt: createdBefore },
        OR: [{ retryAfter: null }, { retryAfter: { lte: now } }],
      },
    });
  }

  async countBySourceChat(sourceChatId: string): Promise<{ queued: number; active: number; retryWaiting: number; failed: number }> {
    const now = new Date();
    const [queued, active, retryWaiting, failed] = await Promise.all([
      this.prisma.mediaJob.count({
        where: {
          sourceChatId,
          status: "queued",
          OR: [{ retryAfter: null }, { retryAfter: { lte: now } }],
        },
      }),
      this.prisma.mediaJob.count({
        where: { sourceChatId, status: { in: ["uploading", "sending"] } },
      }),
      this.prisma.mediaJob.count({
        where: { sourceChatId, status: "queued", retryAfter: { gt: now } },
      }),
      this.prisma.mediaJob.count({
        where: { sourceChatId, status: "failed" },
      }),
    ]);
    return { queued, active, retryWaiting, failed };
  }

  async stats(): Promise<MediaJobStats> {
    const now = new Date();
    const [
      publicQueued,
      publicActive,
      publicRetryWaiting,
      adminQueued,
      adminActive,
      adminRetryWaiting,
      failed,
      oldestQueued,
    ] = await Promise.all([
      this.countWaiting("public"),
      this.prisma.mediaJob.count({ where: { lane: "public", status: { in: ["uploading", "sending"] } } }),
      this.prisma.mediaJob.count({ where: { lane: "public", status: "queued", retryAfter: { gt: now } } }),
      this.countWaiting("admin"),
      this.prisma.mediaJob.count({ where: { lane: "admin", status: { in: ["uploading", "sending"] } } }),
      this.prisma.mediaJob.count({ where: { lane: "admin", status: "queued", retryAfter: { gt: now } } }),
      this.prisma.mediaJob.count({ where: { status: "failed" } }),
      this.prisma.mediaJob.findFirst({
        where: {
          status: "queued",
          OR: [{ retryAfter: null }, { retryAfter: { lte: now } }],
        },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
    ]);
    return {
      publicQueued,
      publicActive,
      publicRetryWaiting,
      adminQueued,
      adminActive,
      adminRetryWaiting,
      failed,
      oldestQueuedAt: oldestQueued?.createdAt,
    };
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
  lane: string;
  telegramUpdateId: number;
  telegramFileId: string | null;
  sourceChatId: string;
  telegramUserId: number | null;
  sourceMessageId: number | null;
  senderDisplayName: string | null;
  rubikaChatId: string;
  messageType: string;
  text: string | null;
  caption: string | null;
  originalFilename: string | null;
  mimeType: string | null;
  fileSize: number | null;
  isForwarded: boolean;
  statusMessageId: string | null;
  error: string | null;
  attempts: number;
  retryAfter: Date | null;
  updatedAt: Date;
}): MediaJobRecord {
  return {
    id: job.id,
    status: job.status as MediaJobStatus,
    lane: job.lane as MediaJobLane,
    telegramUpdateId: job.telegramUpdateId,
    telegramFileId: job.telegramFileId ?? undefined,
    sourceChatId: job.sourceChatId,
    telegramUserId: job.telegramUserId ?? undefined,
    sourceMessageId: job.sourceMessageId ?? undefined,
    senderDisplayName: job.senderDisplayName ?? undefined,
    rubikaChatId: job.rubikaChatId,
    messageType: job.messageType as NormalizedMessageType,
    text: job.text ?? undefined,
    caption: job.caption ?? undefined,
    originalFilename: job.originalFilename ?? undefined,
    mimeType: job.mimeType ?? undefined,
    fileSize: job.fileSize ?? undefined,
    isForwarded: job.isForwarded,
    statusMessageId: job.statusMessageId ?? undefined,
    error: job.error ?? undefined,
    attempts: job.attempts,
    retryAfter: job.retryAfter ?? undefined,
  };
}
