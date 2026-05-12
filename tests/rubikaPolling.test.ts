import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/logger.js";
import {
  RubikaPollingService,
  type RubikaPollingClient,
} from "../src/services/rubikaPollingService.js";
import type { PairingService } from "../src/services/pairingService.js";
import { InMemoryProcessedUpdateStore } from "../src/services/processedUpdateStore.js";

function createService(
  updates: Record<string, unknown>[],
  options: { confirmRubikaPair?: ReturnType<typeof vi.fn> } = {},
) {
  const rubika: RubikaPollingClient = {
    getUpdates: vi.fn().mockResolvedValue(updates),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  };
  const pairing = {
    confirmRubikaPair: options.confirmRubikaPair ?? vi.fn().mockResolvedValue(false),
  } as unknown as PairingService;

  return {
    rubika,
    pairing,
    service: new RubikaPollingService(rubika, pairing, createLogger("silent"), 1),
  };
}

describe("RubikaPollingService", () => {
  it("replies to a valid non-pair Rubika text as a health check", async () => {
    const { rubika, pairing, service } = createService([
      {
        update_id: "u1",
        message: {
          chat_id: "rubika-chat",
          text: "hello",
        },
      },
    ]);

    await service.pollOnce();

    expect(pairing.confirmRubikaPair).toHaveBeenCalledWith("rubika-chat", "hello");
    expect(rubika.sendMessage).toHaveBeenCalledWith(
      "rubika-chat",
      expect.stringContaining("Rubika bot is running and can reply."),
    );
  });

  it("does not send the health reply when a pair code was handled", async () => {
    const confirmRubikaPair = vi.fn().mockResolvedValue(true);
    const { rubika, service } = createService(
      [
        {
          update_id: "u2",
          message: {
            chat_id: "rubika-chat",
            text: "/pair 123456",
          },
        },
      ],
      { confirmRubikaPair },
    );

    await service.pollOnce();

    expect(rubika.sendMessage).not.toHaveBeenCalled();
  });

  it("advances past skipped Rubika updates that still include an update id", async () => {
    const { rubika, service } = createService([{ update_id: "u3", message: { text: "missing chat" } }]);

    await service.pollOnce();
    await service.pollOnce();

    expect(rubika.getUpdates).toHaveBeenLastCalledWith({ offsetId: "u3", limit: 25 });
  });

  it("normalizes the observed Rubika shape with top-level chat_id and update_time without using update_time as offset", async () => {
    const { rubika, pairing, service } = createService([
      {
        type: "UpdatedMessage",
        chat_id: "rubika-chat",
        update_time: 12345,
        new_message: {
          message: "hello from rubika",
        },
      },
    ]);

    await service.pollOnce();
    await service.pollOnce();

    expect(pairing.confirmRubikaPair).toHaveBeenCalledWith("rubika-chat", "hello from rubika");
    expect(rubika.sendMessage).toHaveBeenCalledWith(
      "rubika-chat",
      expect.stringContaining("Rubika bot is running and can reply."),
    );
    expect(rubika.getUpdates).toHaveBeenLastCalledWith({ offsetId: undefined, limit: 25 });
    expect(pairing.confirmRubikaPair).toHaveBeenCalledTimes(1);
  });

  it("clears a Rubika offset after INVALID_INPUT so polling recovers without a restart", async () => {
    const { rubika, service } = createService([
      {
        update_id: "u4",
        message: {
          chat_id: "rubika-chat",
          text: "hello",
        },
      },
    ]);

    await service.pollOnce();
    vi.mocked(rubika.getUpdates).mockRejectedValueOnce(
      new Error('Rubika getUpdates failed: {"status":"INVALID_INPUT"}'),
    );

    await service.pollOnce();
    await service.pollOnce();

    expect(rubika.getUpdates).toHaveBeenNthCalledWith(2, { offsetId: "u4", limit: 25 });
    expect(rubika.getUpdates).toHaveBeenLastCalledWith({ offsetId: undefined, limit: 25 });
  });

  it("persists processed Rubika update ids so restarts do not replay old messages", async () => {
    const processedStore = new InMemoryProcessedUpdateStore();
    const updates = [
      {
        update_id: "u5",
        message: {
          chat_id: "rubika-chat",
          text: "hello",
        },
      },
    ];
    const rubika: RubikaPollingClient = {
      getUpdates: vi.fn().mockResolvedValue(updates),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };
    const firstPairing = {
      confirmRubikaPair: vi.fn().mockResolvedValue(false),
    } as unknown as PairingService;
    const restartedPairing = {
      confirmRubikaPair: vi.fn().mockResolvedValue(false),
    } as unknown as PairingService;

    await new RubikaPollingService(
      rubika,
      firstPairing,
      createLogger("silent"),
      1,
      processedStore,
    ).pollOnce();
    await new RubikaPollingService(
      rubika,
      restartedPairing,
      createLogger("silent"),
      1,
      processedStore,
    ).pollOnce();

    expect(firstPairing.confirmRubikaPair).toHaveBeenCalledTimes(1);
    expect(restartedPairing.confirmRubikaPair).not.toHaveBeenCalled();
    expect(rubika.sendMessage).toHaveBeenCalledTimes(1);
  });
});
