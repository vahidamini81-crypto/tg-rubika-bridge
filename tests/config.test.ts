import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("sets balanced media speed defaults", () => {
    const config = loadConfig({
      TG_BOT_TOKEN: "telegram-token",
      RUBIKA_BOT_TOKEN: "rubika-token",
    } as NodeJS.ProcessEnv);

    expect(config.MEDIA_WORKER_CONCURRENCY).toBe(2);
    expect(config.PUBLIC_QUEUE_CONCURRENCY).toBe(1);
    expect(config.ADMIN_QUEUE_CONCURRENCY).toBe(10);
    expect(config.PUBLIC_QUEUE_MAX_WAITING).toBe(25);
    expect(config.MEDIA_JOB_POLL_INTERVAL_MS).toBe(250);
    expect(config.RUBIKA_UPLOAD_RETRIES).toBe(6);
    expect(config.PUBLIC_MAX_FILE_MB).toBe(100);
    expect(config.ADMIN_MAX_FILE_MB).toBeUndefined();
  });

  it("accepts bounded media speed settings", () => {
    const config = loadConfig({
      TG_BOT_TOKEN: "telegram-token",
      RUBIKA_BOT_TOKEN: "rubika-token",
      MEDIA_WORKER_CONCURRENCY: "4",
      PUBLIC_QUEUE_CONCURRENCY: "2",
      ADMIN_QUEUE_CONCURRENCY: "5",
      PUBLIC_QUEUE_MAX_WAITING: "10",
      MEDIA_JOB_POLL_INTERVAL_MS: "100",
      RUBIKA_UPLOAD_RETRIES: "0",
      ADMIN_TELEGRAM_USER_IDS: "123, 456 789",
      PUBLIC_MAX_FILE_MB: "150",
      ADMIN_MAX_FILE_MB: "1000",
    } as NodeJS.ProcessEnv);

    expect(config.MEDIA_WORKER_CONCURRENCY).toBe(4);
    expect(config.PUBLIC_QUEUE_CONCURRENCY).toBe(2);
    expect(config.ADMIN_QUEUE_CONCURRENCY).toBe(5);
    expect(config.PUBLIC_QUEUE_MAX_WAITING).toBe(10);
    expect(config.MEDIA_JOB_POLL_INTERVAL_MS).toBe(100);
    expect(config.RUBIKA_UPLOAD_RETRIES).toBe(0);
    expect(config.ADMIN_TELEGRAM_USER_IDS).toEqual(new Set([123, 456, 789]));
    expect(config.PUBLIC_MAX_FILE_MB).toBe(150);
    expect(config.ADMIN_MAX_FILE_MB).toBe(1000);
  });
});
