import { randomInt } from "node:crypto";
import type { AppLogger } from "../logger.js";
import type { PairStore } from "./pairStore.js";

export type TelegramPairingClient = {
  sendMessage(chatId: string, text: string): Promise<unknown>;
};

export type RubikaPairingClient = {
  sendMessage(chatId: string, text: string): Promise<unknown>;
};

type PendingPair = {
  code: string;
  telegramChatId: string;
  expiresAt: number;
};

export class PairingService {
  private readonly pending = new Map<string, PendingPair>();

  constructor(
    private readonly pairStore: PairStore,
    private readonly telegram: TelegramPairingClient,
    private readonly rubika: RubikaPairingClient,
    private readonly logger: AppLogger,
    private readonly ttlMs = 10 * 60 * 1000,
  ) {}

  async handleTelegramCommand(telegramChatId: string, text: string): Promise<boolean> {
    const command = text.trim();
    if (command === "/pair" || command === "/start") {
      const code = this.createCode();
      this.pending.set(code, {
        code,
        telegramChatId,
        expiresAt: Date.now() + this.ttlMs,
      });
      await this.telegram.sendMessage(
        telegramChatId,
        [
          `کد اتصال: ${code}`,
          "",
          "روبیکا را باز کنید، به این ربات روبیکا پیام بدهید و این دستور را بفرستید:",
          `/pair ${code}`,
          "",
          "این کد تا ۱۰ دقیقه معتبر است.",
        ].join("\n"),
      );
      return true;
    }

    if (command === "/unpair") {
      const removed = await this.pairStore.remove(telegramChatId);
      await this.telegram.sendMessage(
        telegramChatId,
        removed ? "اتصال این گفت‌وگوی تلگرام حذف شد." : "این گفت‌وگوی تلگرام متصل نبود.",
      );
      return true;
    }

    if (command === "/pairs") {
      const pair = await this.pairStore.getByTelegramChatId(telegramChatId);
      await this.telegram.sendMessage(
        telegramChatId,
        pair
          ? `این گفت‌وگوی تلگرام به گفت‌وگوی روبیکا ${pair.rubikaChatId} متصل است.`
          : "این گفت‌وگوی تلگرام هنوز متصل نیست. برای ساخت کد اتصال، /pair را بفرستید.",
      );
      return true;
    }

    return false;
  }

  async confirmRubikaPair(rubikaChatId: string, text: string): Promise<boolean> {
    const code = parsePairCode(text);
    if (!code) return false;

    const pending = this.pending.get(code);
    if (!pending || pending.expiresAt < Date.now()) {
      this.pending.delete(code);
      await this.rubika.sendMessage(rubikaChatId, "کد اتصال نامعتبر است یا منقضی شده. در تلگرام یک کد جدید با /pair بسازید.");
      return true;
    }

    const pair = await this.pairStore.save({
      telegramChatId: pending.telegramChatId,
      rubikaChatId,
    });
    this.pending.delete(code);

    await this.rubika.sendMessage(rubikaChatId, "اتصال انجام شد. پیام‌های آن گفت‌وگوی تلگرام به اینجا ارسال می‌شود.");
    await this.telegram.sendMessage(pair.telegramChatId, "اتصال به روبیکا انجام شد. پیام‌های این گفت‌وگوی تلگرام ارسال می‌شود.");
    this.logger.info(
      { telegramChatId: pair.telegramChatId, rubikaChatId: pair.rubikaChatId },
      "Created Telegram/Rubika pair",
    );
    return true;
  }

  async notifyTelegramNotPaired(telegramChatId: string): Promise<void> {
    await this.telegram.sendMessage(telegramChatId, "این گفت‌وگو هنوز متصل نیست. برای اتصال به روبیکا، /pair را بفرستید.");
  }

  private createCode(): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const code = String(randomInt(100000, 1000000));
      if (!this.pending.has(code)) return code;
    }
    throw new Error("Could not allocate pair code");
  }
}

function parsePairCode(text: string): string | undefined {
  const match = text.trim().match(/^(?:\/pair\s+)?(\d{6})$/);
  return match?.[1];
}
