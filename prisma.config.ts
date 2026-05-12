import "dotenv/config";
import { defineConfig, env } from "prisma/config";
import { resolve } from "node:path";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: normalizeSqliteUrl(env("DATABASE_URL")),
  },
});

function normalizeSqliteUrl(url: string): string {
  if (!url.startsWith("file:")) return url;
  const path = url.slice("file:".length);
  if (path.startsWith("/") || path.startsWith("\\")) return url;
  return `file:${resolve(process.cwd(), path)}`;
}
