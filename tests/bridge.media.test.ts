import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { BridgeService, type RubikaBridgeClient, type TelegramBridgeClient } from "../src/services/bridgeService.js";
import { createLogger } from "../src/logger.js";
import type { MediaJobStore } from "../src/services/mediaJobStore.js";
import type { PairStore } from "../src/services/pairStore.js";
import type { PairingService } from "../src/services/pairingService.js";

function pairStore(rubikaChatId = "rubika-chat"): PairStore {
  return {
    getByTelegramChatId: vi.fn().mockResolvedValue({
      telegramChatId: "123",
      rubikaChatId,
      createdAt: new Date().toISOString(),
    }),
  } as unknown as PairStore;
}

function pairing(): PairingService {
  return {
    handleTelegramCommand: vi.fn().mockResolvedValue(false),
    notifyTelegramNotPaired: vi.fn().mockResolvedValue(undefined),
  } as unknown as PairingService;
}

describe("BridgeService media delivery", () => {
  it("downloads, uploads, sends a Telegram photo with caption, then deletes temp file", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "tg-rubika-"));
    const telegram: TelegramBridgeClient = {
      getFile: vi.fn().mockResolvedValue({ file_id: "photo-large", file_path: "photos/pic.jpg", file_size: 5 }),
      getFileDownloadUrl: vi.fn().mockReturnValue("https://telegram.test/file"),
    };
    const rubika: RubikaBridgeClient = {
      sendMessage: vi.fn(),
      requestSendFile: vi.fn().mockResolvedValue({ uploadUrl: "https://upload.test" }),
      uploadFile: vi.fn().mockResolvedValue("rubika-file-id"),
      sendFile: vi.fn().mockResolvedValue(undefined),
    };
    const bridge = new BridgeService(
      telegram,
      rubika,
      pairStore(),
      pairing(),
      {
        maxFileMb: 20,
        tmpDir,
        fetchFn: vi.fn().mockResolvedValue(
          new Response(new Blob(["abcde"]), {
            status: 200,
            headers: { "content-length": "5" },
          }),
        ) as typeof fetch,
      },
      createLogger("silent"),
    );

    await bridge.processUpdate({
      update_id: 20,
      message: {
        message_id: 1,
        chat: { id: 123 },
        from: { id: 1, first_name: "Ada" },
        caption: "photo caption",
        photo: [
          { file_id: "photo-small", width: 10, height: 10, file_size: 1 },
          { file_id: "photo-large", width: 100, height: 100, file_size: 5 },
        ],
      },
    });

    expect(telegram.getFile).toHaveBeenCalledWith("photo-large");
    expect(rubika.requestSendFile).toHaveBeenCalledWith("Image");
    expect(rubika.uploadFile).toHaveBeenCalledTimes(1);
    expect(rubika.sendFile).toHaveBeenCalledWith(
      "rubika-chat",
      "rubika-file-id",
      "photo caption",
    );
    expect(rubika.sendMessage).toHaveBeenCalledWith(
      "rubika-chat",
      expect.stringContaining("Uploading photo to Rubika as Image"),
    );
    expect(rubika.sendMessage).toHaveBeenCalledWith(
      "rubika-chat",
      expect.stringContaining("Finished uploading photo"),
    );
    await expect(readdir(tmpDir)).resolves.toEqual([]);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("skips media larger than MAX_FILE_MB without downloading", async () => {
    const telegram: TelegramBridgeClient = {
      getFile: vi.fn(),
      getFileDownloadUrl: vi.fn(),
    };
    const rubika: RubikaBridgeClient = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      requestSendFile: vi.fn(),
      uploadFile: vi.fn(),
      sendFile: vi.fn(),
    };
    const bridge = new BridgeService(
      telegram,
      rubika,
      pairStore(),
      pairing(),
      { maxFileMb: 1, tmpDir: "/tmp/tg-rubika-test" },
      createLogger("silent"),
    );

    await bridge.processUpdate({
      update_id: 21,
      message: {
        message_id: 2,
        chat: { id: 123 },
        document: {
          file_id: "too-big",
          file_name: "large.zip",
          file_size: 2 * 1024 * 1024,
        },
      },
    });

    expect(telegram.getFile).not.toHaveBeenCalled();
    expect(rubika.sendMessage).toHaveBeenCalledWith(
      "rubika-chat",
      expect.stringContaining("skipped because it is larger than 1 MB"),
    );
  });

  it("reports Telegram Bot API download limits without failing the update", async () => {
    const telegram: TelegramBridgeClient = {
      getFile: vi.fn().mockRejectedValue(new Error("Telegram getFile failed with HTTP 400: Bad Request: file is too big")),
      getFileDownloadUrl: vi.fn(),
    };
    const rubika: RubikaBridgeClient = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      requestSendFile: vi.fn(),
      uploadFile: vi.fn(),
      sendFile: vi.fn(),
    };
    const bridge = new BridgeService(
      telegram,
      rubika,
      pairStore(),
      pairing(),
      { maxFileMb: 500, tmpDir: "/tmp/tg-rubika-test" },
      createLogger("silent"),
    );

    await expect(
      bridge.processUpdate({
        update_id: 24,
        message: {
          message_id: 5,
          chat: { id: 123 },
          video: {
            file_id: "too-big-for-bot-api",
            file_name: "movie.mp4",
            mime_type: "video/mp4",
          },
        },
      }),
    ).resolves.toBeUndefined();

    expect(rubika.requestSendFile).not.toHaveBeenCalled();
    expect(rubika.sendMessage).toHaveBeenCalledWith(
      "rubika-chat",
      expect.stringContaining("Telegram Bot API refused the file download as too large"),
    );
  });

  it("uploads local Telegram Bot API file paths directly for large files", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "tg-rubika-local-"));
    const localFile = join(tmpDir, "movie.mp4");
    await writeFile(localFile, "movie-bytes", "utf8");
    const telegram: TelegramBridgeClient = {
      getFile: vi.fn().mockResolvedValue({ file_id: "large-movie", file_path: localFile, file_size: 10 }),
      getFileDownloadUrl: vi.fn(),
    };
    const rubika: RubikaBridgeClient = {
      sendMessage: vi.fn(),
      requestSendFile: vi.fn().mockResolvedValue({ uploadUrl: "https://upload.test" }),
      uploadFile: vi.fn().mockResolvedValue("rubika-large-video-id"),
      sendFile: vi.fn().mockResolvedValue(undefined),
    };
    const bridge = new BridgeService(
      telegram,
      rubika,
      pairStore(),
      pairing(),
      {
        maxFileMb: 500,
        tmpDir,
        fetchFn: vi.fn() as typeof fetch,
      },
      createLogger("silent"),
    );

    await bridge.processUpdate({
      update_id: 25,
      message: {
        message_id: 6,
        chat: { id: 123 },
        video: {
          file_id: "large-movie",
          file_name: "movie.mp4",
          mime_type: "video/mp4",
          file_size: 38 * 1024 * 1024,
        },
      },
    });

    expect(telegram.getFileDownloadUrl).not.toHaveBeenCalled();
    expect(rubika.requestSendFile).toHaveBeenCalledWith("File");
    expect(rubika.uploadFile).toHaveBeenCalledWith("https://upload.test", localFile);
    expect(rubika.sendFile).toHaveBeenCalledWith(
      "rubika-chat",
      "rubika-large-video-id",
      "",
    );
    expect(rubika.sendMessage).toHaveBeenCalledWith(
      "rubika-chat",
      expect.stringContaining("Large files can take a few minutes"),
    );
    await expect(readdir(tmpDir)).resolves.toEqual(["movie.mp4"]);
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("sends video documents as playable Rubika video instead of generic file", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "tg-rubika-"));
    const telegram: TelegramBridgeClient = {
      getFile: vi.fn().mockResolvedValue({ file_id: "movie", file_path: "documents/movie.mp4", file_size: 5 }),
      getFileDownloadUrl: vi.fn().mockReturnValue("https://telegram.test/movie"),
    };
    const rubika: RubikaBridgeClient = {
      sendMessage: vi.fn(),
      requestSendFile: vi.fn().mockResolvedValue({ uploadUrl: "https://upload.test" }),
      uploadFile: vi.fn().mockResolvedValue("rubika-video-id"),
      sendFile: vi.fn().mockResolvedValue(undefined),
    };
    const bridge = new BridgeService(
      telegram,
      rubika,
      pairStore(),
      pairing(),
      {
        maxFileMb: 500,
        tmpDir,
        fetchFn: vi.fn().mockResolvedValue(new Response(new Blob(["movie"]), { status: 200 })) as typeof fetch,
      },
      createLogger("silent"),
    );

    await bridge.processUpdate({
      update_id: 22,
      message: {
        message_id: 3,
        chat: { id: 123 },
        document: {
          file_id: "movie",
          file_name: "movie.mp4",
          mime_type: "video/mp4",
          file_size: 5,
        },
      },
    });

    expect(rubika.requestSendFile).toHaveBeenCalledWith("Video");
    expect(rubika.sendFile).toHaveBeenCalledWith(
      "rubika-chat",
      "rubika-video-id",
      "",
    );
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("sends Telegram animations as playable Rubika video", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "tg-rubika-"));
    const telegram: TelegramBridgeClient = {
      getFile: vi.fn().mockResolvedValue({ file_id: "gif", file_path: "animations/gif.mp4", file_size: 3 }),
      getFileDownloadUrl: vi.fn().mockReturnValue("https://telegram.test/gif"),
    };
    const rubika: RubikaBridgeClient = {
      sendMessage: vi.fn(),
      requestSendFile: vi.fn().mockResolvedValue({ uploadUrl: "https://upload.test" }),
      uploadFile: vi.fn().mockResolvedValue("rubika-gif-id"),
      sendFile: vi.fn().mockResolvedValue(undefined),
    };
    const bridge = new BridgeService(
      telegram,
      rubika,
      pairStore(),
      pairing(),
      {
        maxFileMb: 500,
        tmpDir,
        fetchFn: vi.fn().mockResolvedValue(new Response(new Blob(["gif"]), { status: 200 })) as typeof fetch,
      },
      createLogger("silent"),
    );

    await bridge.processUpdate({
      update_id: 23,
      message: {
        message_id: 4,
        chat: { id: 123 },
        animation: {
          file_id: "gif",
          file_name: "gif.mp4",
          mime_type: "video/mp4",
          file_size: 3,
        },
      },
    });

    expect(rubika.requestSendFile).toHaveBeenCalledWith("Video");
    expect(rubika.sendFile).toHaveBeenCalledWith(
      "rubika-chat",
      "rubika-gif-id",
      "",
    );
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("notifies Rubika when playable upload falls back to a generic file", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "tg-rubika-fallback-"));
    const localFile = join(tmpDir, "movie.mp4");
    await writeFile(localFile, "movie-bytes", "utf8");
    const telegram: TelegramBridgeClient = {
      getFile: vi.fn().mockResolvedValue({ file_id: "large-movie", file_path: localFile, file_size: 10 }),
      getFileDownloadUrl: vi.fn(),
    };
    const rubika: RubikaBridgeClient = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      requestSendFile: vi
        .fn()
        .mockResolvedValueOnce({ uploadUrl: "https://video-upload.test" })
        .mockResolvedValueOnce({ uploadUrl: "https://file-upload.test" }),
      uploadFile: vi
        .fn()
        .mockRejectedValueOnce(new Error("Rubika uploadFile failed with non-JSON HTTP 502"))
        .mockResolvedValueOnce("rubika-file-id"),
      sendFile: vi.fn().mockResolvedValue(undefined),
    };
    const bridge = new BridgeService(
      telegram,
      rubika,
      pairStore(),
      pairing(),
      { maxFileMb: 500, tmpDir },
      createLogger("silent"),
    );

    await bridge.processUpdate({
      update_id: 26,
      message: {
        message_id: 7,
        chat: { id: 123 },
        video: {
          file_id: "large-movie",
          file_name: "movie.mp4",
          mime_type: "video/mp4",
          file_size: 10,
        },
      },
    });

    expect(rubika.requestSendFile).toHaveBeenNthCalledWith(1, "Video");
    expect(rubika.requestSendFile).toHaveBeenNthCalledWith(2, "File");
    expect(rubika.sendMessage).toHaveBeenCalledWith(
      "rubika-chat",
      expect.stringContaining("Retrying as a regular file"),
    );
    expect(rubika.sendMessage).toHaveBeenCalledWith(
      "rubika-chat",
      expect.stringContaining("accepted it as a regular file"),
    );
    expect(rubika.sendFile).toHaveBeenCalledWith(
      "rubika-chat",
      "rubika-file-id",
      "",
    );
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("keeps retryable media jobs queued instead of failing after one full upload pass", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "tg-rubika-retry-"));
    const localFile = join(tmpDir, "movie.mp4");
    await writeFile(localFile, "movie-bytes", "utf8");
    const telegram: TelegramBridgeClient = {
      getFile: vi.fn().mockResolvedValue({ file_id: "large-movie", file_path: localFile, file_size: 38 * 1024 * 1024 }),
      getFileDownloadUrl: vi.fn(),
    };
    const rubika: RubikaBridgeClient = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      requestSendFile: vi.fn().mockResolvedValue({ uploadUrl: "https://file-upload.test" }),
      uploadFile: vi.fn().mockRejectedValue(new Error("Rubika uploadFile failed with non-JSON HTTP 502")),
      sendFile: vi.fn(),
    };
    const mediaJobStore = {
      update: vi.fn().mockResolvedValue(undefined),
    };
    const bridge = new BridgeService(
      telegram,
      rubika,
      pairStore(),
      pairing(),
      { maxFileMb: 500, tmpDir },
      createLogger("silent"),
    );
    Object.defineProperty(bridge, "mediaJobStore", { value: mediaJobStore });

    await bridge.processMediaJob({
      id: "job-1",
      status: "queued",
      telegramUpdateId: 1,
      telegramFileId: "large-movie",
      sourceChatId: "123",
      rubikaChatId: "rubika-chat",
      messageType: "video",
      fileSize: 38 * 1024 * 1024,
      attempts: 0,
    });

    expect(mediaJobStore.update).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({
        status: "queued",
        attempts: 1,
        error: expect.stringContaining("Rubika uploadFile failed"),
        retryAfter: expect.any(Date),
      }),
    );
    expect(rubika.sendMessage).toHaveBeenCalledWith(
      "rubika-chat",
      expect.stringContaining("retrying automatically"),
    );
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("queues media jobs without uploading during Telegram polling", async () => {
    const telegram: TelegramBridgeClient = {
      getFile: vi.fn(),
      getFileDownloadUrl: vi.fn(),
    };
    const rubika: RubikaBridgeClient = {
      sendMessage: vi.fn().mockResolvedValue("status-message"),
      requestSendFile: vi.fn(),
      uploadFile: vi.fn(),
      sendFile: vi.fn(),
    };
    const mediaJobStore = {
      create: vi.fn().mockResolvedValue({ id: "job-1" }),
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as MediaJobStore;
    const bridge = new BridgeService(
      telegram,
      rubika,
      pairStore(),
      pairing(),
      { maxFileMb: 500, tmpDir: "/tmp/tg-rubika-test" },
      createLogger("silent"),
      mediaJobStore,
    );

    await bridge.processUpdate({
      update_id: 27,
      message: {
        message_id: 8,
        chat: { id: 123 },
        video: {
          file_id: "large-movie",
          file_name: "movie.mp4",
          mime_type: "video/mp4",
          file_size: 10,
        },
      },
    });

    expect(mediaJobStore.create).toHaveBeenCalledWith(
      expect.objectContaining({
        telegramUpdateId: 27,
        telegramFileId: "large-movie",
        rubikaChatId: "rubika-chat",
        messageType: "video",
      }),
    );
    expect(mediaJobStore.update).toHaveBeenCalledWith("job-1", { statusMessageId: "status-message" });
    expect(telegram.getFile).not.toHaveBeenCalled();
    expect(rubika.uploadFile).not.toHaveBeenCalled();
  });
});
