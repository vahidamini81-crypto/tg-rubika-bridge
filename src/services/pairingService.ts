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
          `Pair code: ${code}`,
          "",
          "Open Rubika, send a message to this Rubika bot, and type:",
          `/pair ${code}`,
          "",
          "The code expires in 10 minutes.",
        ].join("\n"),
      );
      return true;
    }

    if (command === "/unpair") {
      const removed = await this.pairStore.remove(telegramChatId);
      await this.telegram.sendMessage(
        telegramChatId,
        removed ? "This Telegram chat is no longer paired." : "This Telegram chat was not paired.",
      );
      return true;
    }

    if (command === "/pairs") {
      const pair = await this.pairStore.getByTelegramChatId(telegramChatId);
      await this.telegram.sendMessage(
        telegramChatId,
        pair
          ? `This Telegram chat is paired with Rubika chat ${pair.rubikaChatId}.`
          : "This Telegram chat is not paired. Send /pair to create a pair code.",
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
      await this.rubika.sendMessage(rubikaChatId, "Pair code is invalid or expired. Create a new /pair code in Telegram.");
      return true;
    }

    const pair = await this.pairStore.save({
      telegramChatId: pending.telegramChatId,
      rubikaChatId,
    });
    this.pending.delete(code);

    await this.rubika.sendMessage(rubikaChatId, "Paired. Telegram messages from that chat will be forwarded here.");
    await this.telegram.sendMessage(pair.telegramChatId, "Paired with Rubika. Messages from this Telegram chat will be forwarded.");
    this.logger.info(
      { telegramChatId: pair.telegramChatId, rubikaChatId: pair.rubikaChatId },
      "Created Telegram/Rubika pair",
    );
    return true;
  }

  async notifyTelegramNotPaired(telegramChatId: string): Promise<void> {
    await this.telegram.sendMessage(telegramChatId, "This chat is not paired yet. Send /pair to connect it to a Rubika chat.");
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
