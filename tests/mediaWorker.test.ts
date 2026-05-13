import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/logger.js";
import { MediaJobWorker } from "../src/services/bridgeService.js";
import type { MediaJobRecord, MediaJobStore } from "../src/services/mediaJobStore.js";

function job(id: string): MediaJobRecord {
  return {
    id,
    status: "uploading",
    telegramUpdateId: Number(id.replace(/\D/g, "")) || 1,
    telegramFileId: `file-${id}`,
    lane: "public",
    sourceChatId: "telegram-chat",
    telegramUserId: 2,
    rubikaChatId: "rubika-chat",
    messageType: "video",
    isForwarded: false,
    attempts: 0,
  };
}

describe("MediaJobWorker", () => {
  it("processes multiple claimed jobs with configured concurrency", async () => {
    const jobs = [job("job-1"), job("job-2")];
    const store = {
      claimNextQueued: vi.fn(async () => jobs.shift()),
    } as unknown as MediaJobStore;
    const processedIds: string[] = [];
    const processMediaJob = vi.fn(async (processed: MediaJobRecord) => {
      processedIds.push(processed.id);
      if (processMediaJob.mock.calls.length === 2) worker.stop();
    });
    const worker = new MediaJobWorker(
      store,
      { processMediaJob },
      createLogger("silent"),
      1,
      2,
    );

    await worker.start();

    expect(processMediaJob).toHaveBeenCalledTimes(2);
    expect(processedIds.sort()).toEqual([
      "job-1",
      "job-2",
    ]);
  });
});
