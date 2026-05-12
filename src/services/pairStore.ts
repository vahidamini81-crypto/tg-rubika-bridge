import type { AppPrismaClient } from "../db/prisma.js";

export type ChatPair = {
  telegramChatId: string;
  rubikaChatId: string;
  createdAt: string;
};

export class PairStore {
  constructor(private readonly prisma: AppPrismaClient) {}

  async getByTelegramChatId(telegramChatId: string): Promise<ChatPair | undefined> {
    const pair = await this.prisma.chatPair.findUnique({ where: { telegramChatId } });
    return pair ? toChatPair(pair) : undefined;
  }

  async list(): Promise<ChatPair[]> {
    const pairs = await this.prisma.chatPair.findMany({ orderBy: { createdAt: "asc" } });
    return pairs.map(toChatPair);
  }

  async save(pair: Omit<ChatPair, "createdAt">): Promise<ChatPair> {
    const stored = await this.prisma.chatPair.upsert({
      where: { telegramChatId: pair.telegramChatId },
      create: pair,
      update: { rubikaChatId: pair.rubikaChatId },
    });
    return toChatPair(stored);
  }

  async remove(telegramChatId: string): Promise<boolean> {
    const result = await this.prisma.chatPair.deleteMany({ where: { telegramChatId } });
    return result.count > 0;
  }
}

function toChatPair(pair: { telegramChatId: string; rubikaChatId: string; createdAt: Date }): ChatPair {
  return {
    telegramChatId: pair.telegramChatId,
    rubikaChatId: pair.rubikaChatId,
    createdAt: pair.createdAt.toISOString(),
  };
}
