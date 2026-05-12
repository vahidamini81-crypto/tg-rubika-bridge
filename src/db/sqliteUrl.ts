import { resolve } from "node:path";

export function normalizeSqliteUrl(url: string): string {
  if (!url.startsWith("file:")) return url;
  const path = url.slice("file:".length);
  if (path.startsWith("/") || path.startsWith("\\")) return url;
  return `file:${resolve(process.cwd(), path)}`;
}
