import { randomInt } from "node:crypto";
import type { AppLogger } from "../logger.js";
import type { PairStore } from "./pairStore.js";
import type { MediaJobStore } from "./mediaJobStore.js";
import type { PendingPairStore } from "./pendingPairStore.js";
import type { TelegramStatusMode, TelegramStatusStore } from "./telegramStatusStore.js";

export type TelegramPairingClient = {
  sendMessage(chatId: string, text: string): Promise<unknown>;
  editMessageText?(chatId: string, messageId: number, text: string): Promise<unknown>;
};

export type RubikaPairingClient = {
  sendMessage(chatId: string, text: string): Promise<unknown>;
};

export type PairingServiceConfig = {
  adminTelegramUserIds?: Set<number>;
  publicQueueConcurrency?: number;
  adminQueueConcurrency?: number;
  publicQueueMaxWaiting?: number;
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
    private readonly mediaJobStore?: MediaJobStore,
    private readonly config: PairingServiceConfig = {},
    private readonly pendingPairStore?: PendingPairStore,
    private readonly telegramStatusStore?: TelegramStatusStore,
    private readonly ttlMs = 10 * 60 * 1000,
  ) {}

  async handleTelegramCommand(telegramChatId: string, telegramUserId: number | undefined, text: string): Promise<boolean> {
    const command = text.trim();
    if (command === "/pair" || command === "/start") {
      const code = await this.createCode();
      const pending = {
        code,
        telegramChatId,
        expiresAt: Date.now() + this.ttlMs,
      };
      this.pending.set(code, pending);
      await this.pendingPairStore?.save(pending);
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

    if (command === "/status") {
      if (this.isAdmin(telegramUserId)) {
        await this.upsertTelegramStatus(telegramChatId, "admin");
      } else {
        await this.upsertTelegramStatus(telegramChatId, "public");
      }
      return true;
    }

    if (command === "/pairs" || command === "/list") {
      if (!(await this.requireAdmin(telegramChatId, telegramUserId))) return true;
      await this.telegram.sendMessage(telegramChatId, await this.formatPairs());
      return true;
    }

    if (command === "/unpair" || command.startsWith("/unpair ")) {
      if (!(await this.requireAdmin(telegramChatId, telegramUserId))) return true;
      const targetChatId = command.slice("/unpair".length).trim();
      if (!targetChatId) {
        await this.telegram.sendMessage(telegramChatId, "برای حذف اتصال، دستور را به شکل /unpair <telegram_chat_id> بفرستید.");
        return true;
      }
      const removed = await this.pairStore.remove(targetChatId);
      await this.telegram.sendMessage(
        telegramChatId,
        removed ? `اتصال تلگرام ${targetChatId} حذف شد.` : `اتصالی برای تلگرام ${targetChatId} پیدا نشد.`,
      );
      return true;
    }

    return false;
  }

  async confirmRubikaPair(rubikaChatId: string, text: string): Promise<boolean> {
    const code = parsePairCode(text);
    if (!code) return false;

    const pending = await this.findPending(code);
    if (!pending || pending.expiresAt < Date.now()) {
      this.pending.delete(code);
      await this.pendingPairStore?.remove(code);
      await this.rubika.sendMessage(rubikaChatId, "کد اتصال نامعتبر است یا منقضی شده. در تلگرام یک کد جدید با /pair بسازید.");
      return true;
    }

    const pair = await this.pairStore.save({
      telegramChatId: pending.telegramChatId,
      rubikaChatId,
    });
    this.pending.delete(code);
    await this.pendingPairStore?.remove(code);

    await Promise.allSettled([
      this.rubika.sendMessage(rubikaChatId, "اتصال انجام شد. پیام‌های آن گفت‌وگوی تلگرام به اینجا ارسال می‌شود."),
      this.telegram.sendMessage(pair.telegramChatId, "اتصال به روبیکا انجام شد. پیام‌های این گفت‌وگوی تلگرام ارسال می‌شود."),
    ]);
    this.logger.info(
      { telegramChatId: pair.telegramChatId, rubikaChatId: pair.rubikaChatId },
      "Created Telegram/Rubika pair",
    );
    return true;
  }

  async notifyTelegramNotPaired(telegramChatId: string): Promise<void> {
    await this.telegram.sendMessage(telegramChatId, "این گفت‌وگو هنوز متصل نیست. برای اتصال به روبیکا، /pair را بفرستید.");
  }

  async notifyTelegramQueueFull(telegramChatId: string, maxWaiting: number): Promise<void> {
    await this.telegram.sendMessage(
      telegramChatId,
      `صف عمومی فعلاً پر است (${maxWaiting} پیام در انتظار). لطفاً چند دقیقه بعد دوباره تلاش کنید.`,
    );
  }

  async refreshTelegramStatus(telegramChatId: string): Promise<void> {
    const stored = await this.telegramStatusStore?.get(telegramChatId);
    if (!stored) return;
    await this.upsertTelegramStatus(telegramChatId, stored.mode, stored.messageId);
  }

  isAdmin(telegramUserId: number | undefined): boolean {
    return telegramUserId !== undefined && Boolean(this.config.adminTelegramUserIds?.has(telegramUserId));
  }

  private async requireAdmin(telegramChatId: string, telegramUserId: number | undefined): Promise<boolean> {
    if (this.isAdmin(telegramUserId)) return true;
    await this.telegram.sendMessage(telegramChatId, "این دستور فقط برای ادمین‌های ربات فعال است.");
    return false;
  }

  private async formatPublicStatus(telegramChatId: string): Promise<string> {
    const pair = await this.pairStore.getByTelegramChatId(telegramChatId);
    const queue = await this.mediaJobStore?.countBySourceChat(telegramChatId);
    return [
      "وضعیت زنده ربات",
      pair ? "وضعیت اتصال: متصل" : "وضعیت اتصال: متصل نیست",
      pair ? `مقصد روبیکا: ${pair.rubikaChatId}` : "برای اتصال، /pair را بفرستید.",
      queue ? `در صف: ${queue.queued}` : "",
      queue ? `در حال ارسال: ${queue.active}` : "",
      queue && queue.retryWaiting > 0 ? `در انتظار تلاش دوباره: ${queue.retryWaiting}` : "",
      queue && queue.failed > 0 ? `ناموفق: ${queue.failed}` : "",
      `به‌روزرسانی: ${new Date().toISOString()}`,
    ]
      .filter((part) => part !== "")
      .join("\n");
  }

  private async formatAdminStatus(): Promise<string> {
    const pairs = await this.pairStore.list();
    const stats = await this.mediaJobStore?.stats();
    if (!stats) return `وضعیت کلی\nاتصال‌ها: ${pairs.length}`;

    return [
      "وضعیت کلی ربات",
      `اتصال‌ها: ${pairs.length}`,
      `صف عمومی: ${stats.publicQueued} در صف، ${stats.publicActive} در حال ارسال، ${stats.publicRetryWaiting} در انتظار تلاش دوباره`,
      `صف ادمین: ${stats.adminQueued} در صف، ${stats.adminActive} در حال ارسال، ${stats.adminRetryWaiting} در انتظار تلاش دوباره`,
      `ناموفق‌ها: ${stats.failed}`,
      `قدیمی‌ترین صف: ${stats.oldestQueuedAt ? stats.oldestQueuedAt.toISOString() : "-"}`,
      `ظرفیت عمومی: ${this.config.publicQueueMaxWaiting ?? 25}`,
      `پردازش همزمان عمومی/ادمین: ${this.config.publicQueueConcurrency ?? 1}/${this.config.adminQueueConcurrency ?? 10}`,
      `به‌روزرسانی: ${new Date().toISOString()}`,
    ].join("\n");
  }

  private async upsertTelegramStatus(
    telegramChatId: string,
    mode: TelegramStatusMode,
    messageId?: number,
  ): Promise<void> {
    const text = mode === "admin" ? await this.formatAdminStatus() : await this.formatPublicStatus(telegramChatId);
    const stored = messageId === undefined ? await this.telegramStatusStore?.get(telegramChatId) : undefined;
    const targetMessageId = messageId ?? stored?.messageId;

    if (targetMessageId !== undefined && this.telegram.editMessageText) {
      try {
        await this.telegram.editMessageText(telegramChatId, targetMessageId, text);
        await this.telegramStatusStore?.save(telegramChatId, { messageId: targetMessageId, mode });
        return;
      } catch {
        await this.telegramStatusStore?.remove(telegramChatId);
      }
    }

    const sentMessageId = await this.telegram.sendMessage(telegramChatId, text);
    if (typeof sentMessageId === "number") {
      await this.telegramStatusStore?.save(telegramChatId, { messageId: sentMessageId, mode });
    }
  }

  private async formatPairs(): Promise<string> {
    const pairs = await this.pairStore.list();
    if (pairs.length === 0) return "هیچ اتصالی ثبت نشده است.";
    return [
      `اتصال‌های ثبت‌شده: ${pairs.length}`,
      ...pairs.map((pair) => `${pair.telegramChatId} -> ${pair.rubikaChatId}`),
    ].join("\n");
  }

  private async createCode(): Promise<string> {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const code = String(randomInt(100000, 1000000));
      if (!this.pending.has(code) && !(await this.pendingPairStore?.has(code))) return code;
    }
    throw new Error("Could not allocate pair code");
  }

  private async findPending(code: string): Promise<PendingPair | undefined> {
    const memoryPending = this.pending.get(code);
    if (memoryPending) return memoryPending;
    const storedPending = await this.pendingPairStore?.get(code);
    if (!storedPending) return undefined;
    const pending = {
      code: storedPending.code,
      telegramChatId: storedPending.telegramChatId,
      expiresAt: storedPending.expiresAt,
    };
    this.pending.set(code, pending);
    return pending;
  }
}

function parsePairCode(text: string): string | undefined {
  const match = text.trim().match(/^(?:\/pair\s+)?(\d{6})$/);
  return match?.[1];
}
