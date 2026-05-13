import type { AppLogger } from "../logger.js";
import type { RubikaUpdate } from "../types/rubika.js";
import { sleep } from "../utils/retry.js";
import type { PairingService } from "./pairingService.js";
import { InMemoryProcessedUpdateStore, type ProcessedUpdateStore } from "./processedUpdateStore.js";

export type RubikaPollingClient = {
  getUpdates(params: { offsetId?: string; limit?: number }): Promise<RubikaUpdate[]>;
  sendMessage(chatId: string, text: string): Promise<unknown>;
};

export class RubikaPollingService {
  private running = false;
  private lastOffsetId: string | undefined;
  private readonly processedUpdateIds = new Set<string>();
  private processedUpdateIdsLoaded = false;

  constructor(
    private readonly rubika: RubikaPollingClient,
    private readonly pairing: PairingService,
    private readonly logger: AppLogger,
    private readonly pollIntervalMs: number,
    private readonly processedUpdateStore: ProcessedUpdateStore = new InMemoryProcessedUpdateStore(),
  ) {}

  async start(): Promise<void> {
    this.running = true;
    this.logger.info({ pollIntervalMs: this.pollIntervalMs }, "Starting Rubika polling");
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
      await this.loadProcessedUpdateIds();
      const updates = await this.rubika.getUpdates({
        offsetId: this.lastOffsetId,
        limit: 25,
      });

      let processedCount = 0;
      for (const update of updates) {
        const localUpdateId = updateIdFrom(update);
        if (localUpdateId && this.processedUpdateIds.has(localUpdateId)) {
          this.logger.debug({ updateId: localUpdateId }, "Skipped duplicate Rubika update");
          continue;
        }
        processedCount += 1;

        const normalized = normalizeRubikaUpdate(update);
        if (!normalized) {
          const skippedUpdateId = localUpdateId;
          this.logger.warn(
            { keys: Object.keys(update).slice(0, 20), updateId: skippedUpdateId },
            "Skipped Rubika update because chat id, update id, or text was missing",
          );
          await this.rememberProcessedUpdate(skippedUpdateId);
          this.advanceOffset(update);
          continue;
        }
        try {
          this.logger.info(
            {
              chatId: normalized.chatId,
              updateId: normalized.updateId,
              textLength: normalized.text.length,
            },
            "Processing Rubika text update",
          );
          const handled = await this.pairing.confirmRubikaPair(normalized.chatId, normalized.text);
          if (!handled) {
            await this.rubika.sendMessage(
              normalized.chatId,
              [
                "ربات روبیکا فعال است و می‌تواند پاسخ بدهد.",
                "",
                "برای اتصال این گفت‌وگو به تلگرام، اول در تلگرام /pair را بفرستید و بعد /pair <code> را اینجا ارسال کنید.",
              ].join("\n"),
            );
            this.logger.info(
              { chatId: normalized.chatId, updateId: normalized.updateId },
              "Sent Rubika health reply",
            );
          }
        } catch (error) {
          this.logger.error({ error, updateId: normalized.updateId }, "Failed to process Rubika update");
        } finally {
          await this.rememberProcessedUpdate(normalized.updateId);
          this.advanceOffset(update);
        }
      }
      if (processedCount > 0) {
        this.logger.info(
          { count: processedCount, receivedCount: updates.length, offsetId: this.lastOffsetId },
          "Received new Rubika updates",
        );
      } else if (updates.length > 0) {
        this.logger.debug(
          { receivedCount: updates.length, offsetId: this.lastOffsetId },
          "Received duplicate Rubika updates",
        );
      }
      return processedCount;
    } catch (error) {
      if (isInvalidInputError(error) && this.lastOffsetId) {
        this.logger.warn(
          { error, offsetId: this.lastOffsetId },
          "Rubika rejected offset id; clearing it so polling can recover without restart",
        );
        this.lastOffsetId = undefined;
        return 0;
      }
      this.logger.error({ error }, "Rubika polling failed");
      await sleep(this.pollIntervalMs);
      return 0;
    }
  }

  private advanceOffset(update: RubikaUpdate): void {
    const offsetId = offsetIdFrom(update);
    if (offsetId) this.lastOffsetId = offsetId;
  }

  private async loadProcessedUpdateIds(): Promise<void> {
    if (this.processedUpdateIdsLoaded) return;
    const updateIds = await this.processedUpdateStore.load();
    for (const updateId of updateIds) {
      this.processedUpdateIds.add(updateId);
    }
    this.processedUpdateIdsLoaded = true;
  }

  private async rememberProcessedUpdate(updateId: string | undefined): Promise<void> {
    if (!updateId) return;
    this.processedUpdateIds.add(updateId);
    if (this.processedUpdateIds.size > 1000) {
      const oldestUpdateId = this.processedUpdateIds.values().next().value;
      if (oldestUpdateId) this.processedUpdateIds.delete(oldestUpdateId);
    }
    await this.processedUpdateStore.save([...this.processedUpdateIds]);
  }
}

function normalizeRubikaUpdate(update: RubikaUpdate): { updateId: string; chatId: string; text: string } | undefined {
  const message = objectFrom(update.message) ?? objectFrom(update.new_message) ?? objectFrom(update);
  const updateId = updateIdFrom(update);
  const chatId =
    stringFrom(message, ["chat_id", "chatId", "object_guid"]) ??
    stringFrom(objectFrom(message?.chat), ["chat_id", "chatId", "id", "object_guid"]) ??
    stringFrom(update, ["chat_id", "chatId", "object_guid"]);
  const text = stringFrom(message, ["text", "message", "body"]);

  if (!updateId || !chatId || !text) return undefined;
  return { updateId, chatId, text };
}

function updateIdFrom(update: RubikaUpdate): string | undefined {
  return stringFrom(update, ["update_id", "updateId", "offset_id", "offsetId", "message_id", "update_time"]);
}

function offsetIdFrom(update: RubikaUpdate): string | undefined {
  return stringFrom(update, ["offset_id", "offsetId", "update_id", "updateId"]);
}

function isInvalidInputError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("INVALID_INPUT");
}

function objectFrom(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function stringFrom(source: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}
