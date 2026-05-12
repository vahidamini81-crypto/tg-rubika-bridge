import { z } from "zod";

const booleanFromString = z
  .union([z.boolean(), z.string()])
  .default("false")
  .transform((value) => {
    if (typeof value === "boolean") return value;
    return value.toLowerCase() === "true";
  });

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  TG_BOT_TOKEN: z.string().min(1),
  TG_API_BASE_URL: z.string().url().optional(),
  TG_FILE_BASE_URL: z.string().url().optional(),
  RUBIKA_BOT_TOKEN: z.string().min(1),
  DATABASE_URL: z.string().min(1).default("file:./data/bridge.db"),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(250),
  MAX_FILE_MB: z.coerce.number().positive().default(500),
  TMP_DIR: z.string().min(1).default("/tmp/tg-rubika-bridge"),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(env);
}
