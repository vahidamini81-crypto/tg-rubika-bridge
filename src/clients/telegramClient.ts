import type { TelegramApiResponse, TelegramFile, TelegramUpdate } from "../types/telegram.js";

export type TelegramGetUpdatesParams = {
  timeout: number;
  offset?: number;
  allowed_updates?: string[];
};

export class TelegramClient {
  private readonly apiBase: string;
  private readonly fileBase: string;

  constructor(
    private readonly token: string,
    private readonly fetchFn: typeof fetch = fetch,
    options: { apiBaseUrl?: string; fileBaseUrl?: string } = {},
  ) {
    this.apiBase = `${trimTrailingSlash(options.apiBaseUrl ?? "https://api.telegram.org")}/bot${token}`;
    this.fileBase = `${trimTrailingSlash(options.fileBaseUrl ?? "https://api.telegram.org/file")}/bot${token}`;
  }

  async deleteWebhook(): Promise<boolean> {
    const response = await this.post<boolean>("deleteWebhook", { drop_pending_updates: false });
    return response;
  }

  async getUpdates(params: TelegramGetUpdatesParams): Promise<TelegramUpdate[]> {
    return this.post<TelegramUpdate[]>("getUpdates", params);
  }

  async getFile(fileId: string): Promise<TelegramFile> {
    return this.post<TelegramFile>("getFile", { file_id: fileId });
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.post<unknown>("sendMessage", {
      chat_id: chatId,
      text,
    });
  }

  getFileDownloadUrl(filePath: string): string {
    return `${this.fileBase}/${filePath}`;
  }

  private async post<T>(method: string, body: unknown): Promise<T> {
    const response = await this.fetchFn(`${this.apiBase}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const payload = (await response.json()) as TelegramApiResponse<T>;
    if (!response.ok || !payload.ok || payload.result === undefined) {
      const description = payload.description ? `: ${payload.description}` : "";
      throw new Error(`Telegram ${method} failed with HTTP ${response.status}${description}`);
    }

    return payload.result;
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
