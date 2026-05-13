import type { AppPrismaClient } from "../db/prisma.js";

export type PendingPairRecord = {
  code: string;
  telegramChatId: string;
  expiresAt: number;
};

export class PendingPairStore {
  constructor(private readonly prisma: AppPrismaClient) {}

  async save(pair: PendingPairRecord): Promise<void> {
    await this.prisma.pendingPair.upsert({
      where: { code: pair.code },
      create: {
        code: pair.code,
        telegramChatId: pair.telegramChatId,
        expiresAt: new Date(pair.expiresAt),
      },
      update: {
        telegramChatId: pair.telegramChatId,
        expiresAt: new Date(pair.expiresAt),
      },
    });
  }

  async get(code: string): Promise<PendingPairRecord | undefined> {
    const pair = await this.prisma.pendingPair.findUnique({ where: { code } });
    return pair
      ? {
          code: pair.code,
          telegramChatId: pair.telegramChatId,
          expiresAt: pair.expiresAt.getTime(),
        }
      : undefined;
  }

  async remove(code: string): Promise<void> {
    await this.prisma.pendingPair.deleteMany({ where: { code } });
  }

  async has(code: string): Promise<boolean> {
    const count = await this.prisma.pendingPair.count({ where: { code } });
    return count > 0;
  }
}
