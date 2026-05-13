import type { AppPrismaClient } from "../db/prisma.js";

export type TelegramStatusMode = "public" | "admin";

export type TelegramStatusRecord = {
  messageId: number;
  mode: TelegramStatusMode;
};

export class TelegramStatusStore {
  constructor(private readonly prisma: AppPrismaClient) {}

  async get(telegramChatId: string): Promise<TelegramStatusRecord | undefined> {
    const state = await this.prisma.appState.findUnique({ where: { key: keyFor(telegramChatId) } });
    if (!state) return undefined;
    try {
      const parsed = JSON.parse(state.value) as Partial<TelegramStatusRecord>;
      if (!Number.isSafeInteger(parsed.messageId)) return undefined;
      const messageId = parsed.messageId;
      if (messageId === undefined) return undefined;
      return {
        messageId,
        mode: parsed.mode === "admin" ? "admin" : "public",
      };
    } catch {
      return undefined;
    }
  }

  async save(telegramChatId: string, record: TelegramStatusRecord): Promise<void> {
    await this.prisma.appState.upsert({
      where: { key: keyFor(telegramChatId) },
      create: { key: keyFor(telegramChatId), value: JSON.stringify(record) },
      update: { value: JSON.stringify(record) },
    });
  }

  async remove(telegramChatId: string): Promise<void> {
    await this.prisma.appState.deleteMany({ where: { key: keyFor(telegramChatId) } });
  }
}

function keyFor(telegramChatId: string): string {
  return `telegram.statusMessage.${telegramChatId}`;
}
