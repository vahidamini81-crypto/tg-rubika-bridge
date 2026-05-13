import { describe, expect, it, vi } from "vitest";
import { BridgeService, type RubikaBridgeClient, type TelegramBridgeClient } from "../src/services/bridgeService.js";
import { createLogger } from "../src/logger.js";
import type { MediaJobStore } from "../src/services/mediaJobStore.js";
import type { PairStore } from "../src/services/pairStore.js";
import type { PairingService } from "../src/services/pairingService.js";

function createBridge(
  rubika: Partial<RubikaBridgeClient>,
  options: { rubikaChatId?: string; pairing?: Partial<PairingService> } = {},
) {
  const telegram: TelegramBridgeClient = {
    getFile: vi.fn(),
    getFileDownloadUrl: vi.fn(),
  };
  const pairStore = {
    getByTelegramChatId: vi.fn().mockResolvedValue(
      options.rubikaChatId
        ? { telegramChatId: "123", rubikaChatId: options.rubikaChatId, createdAt: new Date().toISOString() }
        : undefined,
    ),
  } as unknown as PairStore;
  const pairing = {
    handleTelegramCommand: vi.fn().mockResolvedValue(false),
    notifyTelegramNotPaired: vi.fn().mockResolvedValue(undefined),
    notifyTelegramQueueFull: vi.fn().mockResolvedValue(undefined),
    refreshTelegramStatus: vi.fn().mockResolvedValue(undefined),
    isAdmin: vi.fn().mockReturnValue(false),
    ...options.pairing,
  } as unknown as PairingService;
  return new BridgeService(
    telegram,
    rubika as RubikaBridgeClient,
    pairStore,
    pairing,
    { maxFileMb: 20, tmpDir: "/tmp/tg-rubika-test" },
    createLogger("silent"),
  );
}

describe("BridgeService text delivery", () => {
  it("forwards Telegram text to the paired Rubika chat", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const bridge = createBridge({ sendMessage }, { rubikaChatId: "rubika-chat" });

    await bridge.processUpdate({
      update_id: 10,
      message: {
        message_id: 7,
        chat: { id: 123 },
        from: { id: 1, first_name: "Ada", last_name: "Lovelace" },
        text: "hello",
      },
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "rubika-chat",
      "hello",
    );
  });

  it("notifies Telegram when the chat is not paired", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const notifyTelegramNotPaired = vi.fn().mockResolvedValue(undefined);
    const bridge = createBridge({ sendMessage }, { pairing: { notifyTelegramNotPaired } });

    await bridge.processUpdate({
      update_id: 14,
      message: {
        message_id: 11,
        chat: { id: 987654 },
        text: "dynamic destination",
      },
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(notifyTelegramNotPaired).toHaveBeenCalledWith("987654");
  });

  it("marks forwarded Telegram text in the Rubika message", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const bridge = createBridge({ sendMessage }, { rubikaChatId: "rubika-chat" });

    await bridge.processUpdate({
      update_id: 11,
      message: {
        message_id: 8,
        chat: { id: -100 },
        from: { id: 2, username: "sender" },
        forward_sender_name: "Original Sender",
        text: "forwarded body",
      },
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "rubika-chat",
      "forwarded body",
    );
  });

  it("handles Telegram pairing commands without forwarding them", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const handleTelegramCommand = vi.fn().mockResolvedValue(true);
    const bridge = createBridge(
      { sendMessage },
      { rubikaChatId: "rubika-chat", pairing: { handleTelegramCommand } },
    );

    await bridge.processUpdate({
      update_id: 12,
      message: {
        message_id: 9,
        chat: { id: 123 },
        text: "/pair",
      },
    });

    expect(handleTelegramCommand).toHaveBeenCalledWith("123", undefined, "/pair");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("splits long text before sending", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const bridge = createBridge({ sendMessage }, { rubikaChatId: "rubika-chat" });
    const text = "x".repeat(7200);

    await bridge.processUpdate({
      update_id: 13,
      message: {
        message_id: 10,
        chat: { id: 123 },
        text,
      },
    });

    expect(sendMessage).toHaveBeenCalledTimes(3);
    for (const [, chunk] of sendMessage.mock.calls) {
      expect(chunk.length).toBeLessThanOrEqual(3500);
    }
  });

  it("queues Telegram text when a job store is configured", async () => {
    const sendMessage = vi.fn().mockResolvedValue("status-message");
    const createdAt = new Date("2026-05-13T00:00:00.000Z");
    const mediaJobStore = {
      countWaiting: vi.fn().mockResolvedValue(0),
      countWaitingAhead: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({ id: "job-1", createdAt }),
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as MediaJobStore;
    const bridge = new BridgeService(
      { getFile: vi.fn(), getFileDownloadUrl: vi.fn() },
      { sendMessage } as unknown as RubikaBridgeClient,
      {
        getByTelegramChatId: vi.fn().mockResolvedValue({
          telegramChatId: "123",
          rubikaChatId: "rubika-chat",
          createdAt: new Date().toISOString(),
        }),
      } as unknown as PairStore,
      {
        handleTelegramCommand: vi.fn().mockResolvedValue(false),
        notifyTelegramNotPaired: vi.fn(),
        notifyTelegramQueueFull: vi.fn(),
        refreshTelegramStatus: vi.fn().mockResolvedValue(undefined),
        isAdmin: vi.fn().mockReturnValue(false),
      } as unknown as PairingService,
      { maxFileMb: 20, tmpDir: "/tmp/tg-rubika-test", publicQueueMaxWaiting: 25 },
      createLogger("silent"),
      mediaJobStore,
    );

    await bridge.processUpdate({
      update_id: 30,
      message: {
        message_id: 12,
        chat: { id: 123 },
        from: { id: 2 },
        text: "queued text",
      },
    });

    expect(mediaJobStore.create).toHaveBeenCalledWith(
      expect.objectContaining({
        lane: "public",
        messageType: "text",
        text: "queued text",
      }),
    );
    expect(mediaJobStore.countWaitingAhead).toHaveBeenCalledWith("public", createdAt);
    expect(sendMessage).toHaveBeenCalledWith("rubika-chat", expect.stringContaining("جایگاه فعلی: 1"));
  });

  it("rejects public jobs when the public queue is full but admits admin jobs", async () => {
    const notifyTelegramQueueFull = vi.fn().mockResolvedValue(undefined);
    const mediaJobStore = {
      countWaiting: vi.fn().mockResolvedValue(25),
      countWaitingAhead: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({ id: "job-1", createdAt: new Date("2026-05-13T00:00:00.000Z") }),
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as MediaJobStore;
    const bridge = new BridgeService(
      { getFile: vi.fn(), getFileDownloadUrl: vi.fn() },
      { sendMessage: vi.fn().mockResolvedValue("status-message") } as unknown as RubikaBridgeClient,
      {
        getByTelegramChatId: vi.fn().mockResolvedValue({
          telegramChatId: "123",
          rubikaChatId: "rubika-chat",
          createdAt: new Date().toISOString(),
        }),
      } as unknown as PairStore,
      {
        handleTelegramCommand: vi.fn().mockResolvedValue(false),
        notifyTelegramNotPaired: vi.fn(),
        notifyTelegramQueueFull,
        refreshTelegramStatus: vi.fn().mockResolvedValue(undefined),
        isAdmin: vi.fn((userId: number | undefined) => userId === 111),
      } as unknown as PairingService,
      { maxFileMb: 20, tmpDir: "/tmp/tg-rubika-test", publicQueueMaxWaiting: 25 },
      createLogger("silent"),
      mediaJobStore,
    );

    await bridge.processUpdate({
      update_id: 31,
      message: { message_id: 13, chat: { id: 123 }, from: { id: 222 }, text: "public" },
    });
    await bridge.processUpdate({
      update_id: 32,
      message: { message_id: 14, chat: { id: 123 }, from: { id: 111 }, text: "admin" },
    });

    expect(notifyTelegramQueueFull).toHaveBeenCalledWith("123", 25);
    expect(mediaJobStore.create).toHaveBeenCalledTimes(1);
    expect(mediaJobStore.create).toHaveBeenCalledWith(expect.objectContaining({ lane: "admin", text: "admin" }));
  });
});
