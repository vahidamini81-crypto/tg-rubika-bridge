import { describe, expect, it, vi } from "vitest";
import { BridgeService, type RubikaBridgeClient, type TelegramBridgeClient } from "../src/services/bridgeService.js";
import { createLogger } from "../src/logger.js";
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

    expect(handleTelegramCommand).toHaveBeenCalledWith("123", "/pair");
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
});
