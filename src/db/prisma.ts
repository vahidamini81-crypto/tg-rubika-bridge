import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { normalizeSqliteUrl } from "./sqliteUrl.js";

export function createPrismaClient(): PrismaClient {
  const adapter = new PrismaBetterSqlite3({
    url: normalizeSqliteUrl(process.env.DATABASE_URL ?? "file:./data/bridge.db"),
  });
  return new PrismaClient({ adapter });
}

export type AppPrismaClient = PrismaClient;
