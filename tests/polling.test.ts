import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/logger.js";
import { PollingService, type TelegramPollingClient } from "../src/services/pollingService.js";
import { InMemoryOffsetStore } from "../src/services/offsetStore.js";

describe("PollingService", () => {
  it("deletes webhook on initialize and polls with allowed updates", async () => {
    const telegram: TelegramPollingClient = {
      deleteWebhook: vi.fn().mockResolvedValue(true),
      getUpdates: vi.fn().mockResolvedValue([]),
    };
    const bridge = { processUpdate: vi.fn().mockResolvedValue(undefined) };
    const service = new PollingService(
      telegram,
      bridge,
      new InMemoryOffsetStore(),
      createLogger("silent"),
      1,
    );

    await service.initialize();
    await service.pollOnce();

    expect(telegram.deleteWebhook).toHaveBeenCalledTimes(1);
    expect(telegram.getUpdates).toHaveBeenCalledWith({
      timeout: 25,
      offset: undefined,
      allowed_updates: ["message", "channel_post"],
    });
  });

  it("continues after a failed update and advances offset", async () => {
    const telegram: TelegramPollingClient = {
      deleteWebhook: vi.fn().mockResolvedValue(true),
      getUpdates: vi.fn().mockResolvedValue([
        { update_id: 100, message: { message_id: 1, chat: { id: 1 }, text: "fail" } },
        { update_id: 101, message: { message_id: 2, chat: { id: 1 }, text: "ok" } },
      ]),
    };
    const bridge = {
      processUpdate: vi
        .fn()
        .mockRejectedValueOnce(new Error("delivery failed"))
        .mockResolvedValueOnce(undefined),
    };
    const offsetStore = new InMemoryOffsetStore();
    const service = new PollingService(
      telegram,
      bridge,
      offsetStore,
      createLogger("silent"),
      1,
    );

    await service.initialize();
    await service.pollOnce();

    expect(bridge.processUpdate).toHaveBeenCalledTimes(2);
    await expect(offsetStore.load()).resolves.toBe(101);

    await service.pollOnce();
    expect(telegram.getUpdates).toHaveBeenLastCalledWith({
      timeout: 25,
      offset: 102,
      allowed_updates: ["message", "channel_post"],
    });
  });
});
