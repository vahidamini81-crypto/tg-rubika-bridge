import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { PrismaOffsetStore, InMemoryOffsetStore } from "../src/services/offsetStore.js";

describe("offset stores", () => {
  it("stores offset in memory", async () => {
    const store = new InMemoryOffsetStore();
    await expect(store.load()).resolves.toBeUndefined();
    await store.save(123);
    await expect(store.load()).resolves.toBe(123);
  });

  it("stores offset in sqlite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tg-rubika-offset-"));
    const url = `file:${join(dir, "offset.db")}`;
    const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url }) });
    await prisma.$executeRawUnsafe(
      'CREATE TABLE "AppState" ("key" TEXT NOT NULL PRIMARY KEY, "value" TEXT NOT NULL, "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)',
    );
    const store = new PrismaOffsetStore(prisma);

    await expect(store.load()).resolves.toBeUndefined();
    await store.save(456);
    await expect(new PrismaOffsetStore(prisma).load()).resolves.toBe(456);

    await prisma.$disconnect();
    await rm(dir, { recursive: true, force: true });
  });
});
