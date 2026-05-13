import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/logger.js";
import type { MediaJobStore } from "../src/services/mediaJobStore.js";
import type { PairStore } from "../src/services/pairStore.js";
import { PairingService } from "../src/services/pairingService.js";
import type { TelegramStatusStore } from "../src/services/telegramStatusStore.js";

function createService() {
  const pairStore = {
    getByTelegramChatId: vi.fn().mockResolvedValue({
      telegramChatId: "chat-1",
      rubikaChatId: "rubika-1",
      createdAt: new Date().toISOString(),
    }),
    list: vi.fn().mockResolvedValue([
      { telegramChatId: "chat-1", rubikaChatId: "rubika-1", createdAt: new Date().toISOString() },
    ]),
    remove: vi.fn().mockResolvedValue(true),
  } as unknown as PairStore;
  const telegram = {
    sendMessage: vi.fn().mockResolvedValue(77),
    editMessageText: vi.fn().mockResolvedValue(undefined),
  };
  const rubika = { sendMessage: vi.fn().mockResolvedValue(undefined) };
  const mediaJobStore = {
    countBySourceChat: vi.fn().mockResolvedValue({ queued: 2, active: 1, retryWaiting: 0, failed: 0 }),
    stats: vi.fn().mockResolvedValue({
      publicQueued: 2,
      publicActive: 1,
      publicRetryWaiting: 0,
      adminQueued: 0,
      adminActive: 0,
      adminRetryWaiting: 0,
      failed: 0,
    }),
  } as unknown as MediaJobStore;
  const telegramStatusStore = {
    get: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  } as unknown as TelegramStatusStore;
  const service = new PairingService(pairStore, telegram, rubika, createLogger("silent"), mediaJobStore, {
    adminTelegramUserIds: new Set([111]),
    publicQueueConcurrency: 1,
    adminQueueConcurrency: 3,
    publicQueueMaxWaiting: 25,
  }, undefined, telegramStatusStore);
  return { service, pairStore, telegram, telegramStatusStore };
}

describe("PairingService command access", () => {
  it("blocks regular users from admin-only list and unpair commands", async () => {
    const { service, pairStore, telegram } = createService();

    await expect(service.handleTelegramCommand("chat-1", 222, "/list")).resolves.toBe(true);
    await expect(service.handleTelegramCommand("chat-1", 222, "/unpair chat-1")).resolves.toBe(true);

    expect(pairStore.remove).not.toHaveBeenCalled();
    expect(telegram.sendMessage).toHaveBeenCalledWith("chat-1", expect.stringContaining("فقط برای ادمین"));
  });

  it("lets admins list pairs, unpair by Telegram chat id, and view global status", async () => {
    const { service, pairStore, telegram } = createService();

    await service.handleTelegramCommand("admin-chat", 111, "/list");
    await service.handleTelegramCommand("admin-chat", 111, "/unpair chat-1");
    await service.handleTelegramCommand("admin-chat", 111, "/status");

    expect(pairStore.remove).toHaveBeenCalledWith("chat-1");
    expect(telegram.sendMessage).toHaveBeenCalledWith("admin-chat", expect.stringContaining("chat-1 -> rubika-1"));
    expect(telegram.sendMessage).toHaveBeenCalledWith("admin-chat", expect.stringContaining("وضعیت کلی ربات"));
  });

  it("shows regular users their own pair and queue status", async () => {
    const { service, telegram } = createService();

    await service.handleTelegramCommand("chat-1", 222, "/status");

    expect(telegram.sendMessage).toHaveBeenCalledWith("chat-1", expect.stringContaining("وضعیت اتصال: متصل"));
    expect(telegram.sendMessage).toHaveBeenCalledWith("chat-1", expect.stringContaining("در صف: 2"));
  });

  it("edits an existing Telegram status message instead of sending another one", async () => {
    const { service, telegram, telegramStatusStore } = createService();
    vi.mocked(telegramStatusStore.get).mockResolvedValue({ messageId: 77, mode: "admin" });

    await service.handleTelegramCommand("admin-chat", 111, "/status");

    expect(telegram.editMessageText).toHaveBeenCalledWith(
      "admin-chat",
      77,
      expect.stringContaining("وضعیت کلی ربات"),
    );
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });
});
