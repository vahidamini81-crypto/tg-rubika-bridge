import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { AppLogger } from "../logger.js";
import type {
  RubikaApiResponse,
  RubikaFileType,
  RubikaRequestSendFileResult,
  RubikaUpdate,
} from "../types/rubika.js";
import { retry } from "../utils/retry.js";

type RetryConfig = {
  retries?: number;
  delaysMs?: number[];
};

export class RubikaClient {
  private readonly apiBase: string;

  constructor(
    token: string,
    private readonly logger: AppLogger,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly retryConfig: RetryConfig = {},
  ) {
    this.apiBase = `https://botapi.rubika.ir/v3/${token}`;
  }

  async sendMessage(chatId: string, text: string): Promise<string | undefined> {
    this.logger.info({ chatId, textLength: text.length }, "Sending Rubika message");
    const payload = await this.withRetry("sendMessage", () =>
      this.post("sendMessage", {
        chat_id: chatId,
        text,
      }),
    );
    return messageIdFrom(payload);
  }

  async editMessageText(chatId: string, messageId: string, text: string): Promise<void> {
    this.logger.info({ chatId, messageId, textLength: text.length }, "Editing Rubika message");
    await this.withRetry("editMessageText", () =>
      this.post("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
      }),
    );
  }

  async getUpdates(params: { offsetId?: string; limit?: number } = {}): Promise<RubikaUpdate[]> {
    this.logger.debug(params, "Requesting Rubika updates");
    const payload = await this.withRetry("getUpdates", () =>
      this.post<Record<string, unknown> | RubikaUpdate[]>("getUpdates", {
        ...(params.offsetId ? { offset_id: params.offsetId } : {}),
        ...(params.limit ? { limit: params.limit } : {}),
      }),
    );
    const data = extractData(payload);
    const updates = Array.isArray(payload) ? payload : data.updates;
    const normalizedUpdates = Array.isArray(updates) ? (updates as RubikaUpdate[]) : [];
    this.logger.debug({ count: normalizedUpdates.length }, "Rubika getUpdates returned");
    return normalizedUpdates;
  }

  async requestSendFile(type: RubikaFileType): Promise<RubikaRequestSendFileResult> {
    this.logger.info({ type }, "Requesting Rubika file upload slot");
    const payload = await this.withRetry("requestSendFile", () =>
      this.post<Record<string, unknown>>("requestSendFile", { type }),
    );
    const data = extractData(payload);
    const uploadUrl = stringFrom(data, ["upload_url", "uploadUrl"]);
    const fileId = stringFrom(data, ["file_id", "fileId"]);

    if (!uploadUrl) {
      throw new Error("Rubika requestSendFile did not return upload_url");
    }

    return { uploadUrl, fileId };
  }

  async uploadFile(uploadUrl: string, filePath: string): Promise<string> {
    const fileSize = await stat(filePath).then((info) => info.size);
    this.logger.info(
      { fileName: basename(filePath), fileSize, uploadHost: safeHost(uploadUrl) },
      "Uploading file to Rubika",
    );
    return this.withRetry("uploadFile", async () => {
      const bytes = await readFile(filePath);
      const form = new FormData();
      form.append("file", new Blob([bytes], { type: "application/octet-stream" }), basename(filePath));

      const response = await this.fetchFn(uploadUrl, {
        method: "POST",
        body: form,
      });
      this.logger.debug(
        { status: response.status, ok: response.ok, uploadHost: safeHost(uploadUrl), fileSize },
        "Rubika upload response received",
      );
      const payload = await parseJsonResponse<Record<string, unknown>>(response, "Rubika uploadFile");
      const data = extractData(payload);
      const fileId = stringFrom(data, ["file_id", "fileId", "id"]);
      if (!fileId) {
        throw new Error("Rubika uploadFile did not return file_id");
      }
      return fileId;
    });
  }

  async sendFile(chatId: string, fileId: string, text?: string): Promise<void> {
    this.logger.info({ chatId, hasText: Boolean(text) }, "Sending Rubika file");
    await this.withRetry("sendFile", () =>
      this.post("sendFile", {
        chat_id: chatId,
        file_id: fileId,
        ...(text ? { text } : {}),
      }),
    );
  }

  private async post<T>(method: string, body: unknown): Promise<T> {
    this.logger.debug({ method }, "Calling Rubika API");
    const response = await this.fetchFn(`${this.apiBase}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    this.logger.debug({ method, status: response.status, ok: response.ok }, "Rubika API response received");
    return parseJsonResponse<T>(response, `Rubika ${method}`);
  }

  private withRetry<T>(operationName: string, operation: () => Promise<T>): Promise<T> {
    return retry(operation, {
      retries: this.retryConfig.retries ?? 3,
      delaysMs: this.retryConfig.delaysMs,
      onRetry: (error, attempt, delayMs) => {
        this.logger.warn({ error, attempt, delayMs, operationName }, "Retrying Rubika operation");
      },
    });
  }
}

async function parseJsonResponse<T>(response: Response, operationName: string): Promise<T> {
  const text = await response.text();
  let payload: RubikaApiResponse<T> | T;
  try {
    payload = text ? (JSON.parse(text) as RubikaApiResponse<T> | T) : ({} as T);
  } catch {
    throw new Error(`${operationName} failed with non-JSON HTTP ${response.status}: ${truncate(text)}`);
  }

  if (!response.ok) {
    throw new Error(`${operationName} failed with HTTP ${response.status}: ${describePayload(payload)}`);
  }

  if (isRubikaEnvelope(payload)) {
    if (payload.ok === false || (payload.status && payload.status !== "OK")) {
      const message = payload.message ? `: ${payload.message}` : "";
      throw new Error(`${operationName} failed${message}: ${describePayload(payload)}`);
    }
    if (payload.data !== undefined) return payload.data as T;
    if (payload.result !== undefined) return payload.result as T;
  }

  return payload as T;
}

function isRubikaEnvelope<T>(payload: RubikaApiResponse<T> | T): payload is RubikaApiResponse<T> {
  return (
    typeof payload === "object" &&
    payload !== null &&
    ("status" in payload || "ok" in payload || "data" in payload || "result" in payload)
  );
}

function extractData(payload: unknown): Record<string, unknown> {
  if (typeof payload === "object" && payload !== null) return payload as Record<string, unknown>;
  return {};
}

function stringFrom(data: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function describePayload(payload: unknown): string {
  try {
    return truncate(JSON.stringify(payload));
  } catch {
    return "[unserializable payload]";
  }
}

function truncate(text: string, maxLength = 500): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function messageIdFrom(payload: unknown): string | undefined {
  const data = extractData(payload);
  const direct = stringFrom(data, ["message_id", "messageId", "id"]);
  if (direct) return direct;
  return stringFrom(extractData(data.message), ["message_id", "messageId", "id"]);
}
