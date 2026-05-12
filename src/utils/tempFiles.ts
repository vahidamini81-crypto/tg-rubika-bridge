import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { randomUUID } from "node:crypto";

export class FileTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`File exceeds maximum allowed size of ${maxBytes} bytes`);
  }
}

export type DownloadedTempFile = {
  path: string;
  size: number;
};

export async function downloadUrlToTempFile(
  url: string,
  options: {
    tmpDir: string;
    maxBytes: number;
    filenameHint?: string;
    fetchFn?: typeof fetch;
  },
): Promise<DownloadedTempFile> {
  const fetchFn = options.fetchFn ?? fetch;
  await mkdir(options.tmpDir, { recursive: true });

  const response = await fetchFn(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download Telegram file: HTTP ${response.status}`);
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > options.maxBytes) {
    throw new FileTooLargeError(options.maxBytes);
  }

  const extension = extname(sanitizeFilename(options.filenameHint ?? "")) || ".bin";
  const tempPath = join(options.tmpDir, `${randomUUID()}${extension}`);
  const file = createWriteStream(tempPath, { flags: "wx" });
  let size = 0;

  try {
    const stream = Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>);
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > options.maxBytes) {
        throw new FileTooLargeError(options.maxBytes);
      }
      if (!file.write(buffer)) {
        await new Promise<void>((resolve) => file.once("drain", resolve));
      }
    }
    await new Promise<void>((resolve, reject) => {
      file.end((error?: Error | null) => {
        if (error) reject(error);
        else resolve();
      });
    });
    return { path: tempPath, size };
  } catch (error) {
    file.destroy();
    await deleteTempFile(tempPath);
    throw error;
  }
}

export async function deleteTempFile(path: string | undefined): Promise<void> {
  if (!path) return;
  await rm(path, { force: true });
}

function sanitizeFilename(filename: string): string {
  if (!filename) return "";
  return basename(filename).replace(/[^a-zA-Z0-9._-]/g, "_");
}
