import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("sets balanced media speed defaults", () => {
    const config = loadConfig({
      TG_BOT_TOKEN: "telegram-token",
      RUBIKA_BOT_TOKEN: "rubika-token",
    } as NodeJS.ProcessEnv);

    expect(config.MEDIA_WORKER_CONCURRENCY).toBe(2);
    expect(config.MEDIA_JOB_POLL_INTERVAL_MS).toBe(250);
    expect(config.RUBIKA_UPLOAD_RETRIES).toBe(6);
  });

  it("accepts bounded media speed settings", () => {
    const config = loadConfig({
      TG_BOT_TOKEN: "telegram-token",
      RUBIKA_BOT_TOKEN: "rubika-token",
      MEDIA_WORKER_CONCURRENCY: "4",
      MEDIA_JOB_POLL_INTERVAL_MS: "100",
      RUBIKA_UPLOAD_RETRIES: "0",
    } as NodeJS.ProcessEnv);

    expect(config.MEDIA_WORKER_CONCURRENCY).toBe(4);
    expect(config.MEDIA_JOB_POLL_INTERVAL_MS).toBe(100);
    expect(config.RUBIKA_UPLOAD_RETRIES).toBe(0);
  });
});
