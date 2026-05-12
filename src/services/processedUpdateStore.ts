import type { AppPrismaClient } from "../db/prisma.js";

export interface ProcessedUpdateStore {
  load(): Promise<string[]>;
  save(updateIds: string[]): Promise<void>;
}

export class InMemoryProcessedUpdateStore implements ProcessedUpdateStore {
  private updateIds: string[] = [];

  async load(): Promise<string[]> {
    return this.updateIds;
  }

  async save(updateIds: string[]): Promise<void> {
    this.updateIds = updateIds;
  }
}

export class PrismaProcessedUpdateStore implements ProcessedUpdateStore {
  constructor(private readonly prisma: AppPrismaClient) {}

  async load(): Promise<string[]> {
    const updates = await this.prisma.rubikaProcessedUpdate.findMany({
      orderBy: { createdAt: "asc" },
      take: 1000,
    });
    return updates.map((update) => update.updateId);
  }

  async save(updateIds: string[]): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.rubikaProcessedUpdate.deleteMany({
        where: { updateId: { notIn: updateIds.length > 0 ? updateIds : [""] } },
      });
      for (const updateId of updateIds) {
        await tx.rubikaProcessedUpdate.upsert({
          where: { updateId },
          create: { updateId },
          update: {},
        });
      }
    });
  }
}

export const FileProcessedUpdateStore = PrismaProcessedUpdateStore;
