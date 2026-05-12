import type { AppLogger } from "../logger.js";
import type { TelegramUpdate } from "../types/telegram.js";
import { sleep } from "../utils/retry.js";
import type { BridgeService } from "./bridgeService.js";
import type { OffsetStore } from "./offsetStore.js";

export type TelegramPollingClient = {
  deleteWebhook(): Promise<boolean>;
  getUpdates(params: {
    timeout: number;
    offset?: number;
    allowed_updates?: string[];
  }): Promise<TelegramUpdate[]>;
};

export class PollingService {
  private running = false;
  private initialized = false;
  private lastUpdateId: number | undefined;

  constructor(
    private readonly telegram: TelegramPollingClient,
    private readonly bridge: Pick<BridgeService, "processUpdate">,
    private readonly offsetStore: OffsetStore,
    private readonly logger: AppLogger,
    private readonly pollIntervalMs: number,
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      await this.telegram.deleteWebhook();
      this.logger.info("Telegram webhook deleted; polling mode enabled");
    } catch (error) {
      this.logger.warn({ error }, "Telegram deleteWebhook failed; continuing with polling");
    }
    this.lastUpdateId = await this.offsetStore.load();
    this.initialized = true;
  }

  async start(): Promise<void> {
    await this.initialize();
    this.running = true;

    while (this.running) {
      const updateCount = await this.pollOnce();
      if (this.running && updateCount === 0) await sleep(this.pollIntervalMs);
    }
  }

  stop(): void {
    this.running = false;
  }

  async pollOnce(): Promise<number> {
    try {
      const updates = await this.telegram.getUpdates({
        timeout: 25,
        offset: this.lastUpdateId === undefined ? undefined : this.lastUpdateId + 1,
        allowed_updates: ["message", "channel_post"],
      });

      for (const update of updates) {
        try {
          await this.bridge.processUpdate(update);
        } catch (error) {
          this.logger.error({ error, updateId: update.update_id }, "Failed to process Telegram update");
        } finally {
          this.lastUpdateId = update.update_id;
          try {
            await this.offsetStore.save(update.update_id);
          } catch (error) {
            this.logger.error({ error, updateId: update.update_id }, "Failed to persist offset");
          }
        }
      }
      return updates.length;
    } catch (error) {
      this.logger.error({ error }, "Telegram polling failed");
      await sleep(this.pollIntervalMs);
      return 0;
    }
  }
}
