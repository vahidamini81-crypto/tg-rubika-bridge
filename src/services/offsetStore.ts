import type { AppPrismaClient } from "../db/prisma.js";

export interface OffsetStore {
  load(): Promise<number | undefined>;
  save(updateId: number): Promise<void>;
}

export class InMemoryOffsetStore implements OffsetStore {
  private updateId: number | undefined;

  async load(): Promise<number | undefined> {
    return this.updateId;
  }

  async save(updateId: number): Promise<void> {
    this.updateId = updateId;
  }
}

export class PrismaOffsetStore implements OffsetStore {
  private readonly key = "telegram.lastUpdateId";

  constructor(private readonly prisma: AppPrismaClient) {}

  async load(): Promise<number | undefined> {
    const state = await this.prisma.appState.findUnique({ where: { key: this.key } });
    if (!state) return undefined;
    const parsed = Number(state.value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }

  async save(updateId: number): Promise<void> {
    await this.prisma.appState.upsert({
      where: { key: this.key },
      create: { key: this.key, value: String(updateId) },
      update: { value: String(updateId) },
    });
  }
}

export const FileOffsetStore = PrismaOffsetStore;
