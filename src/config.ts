import { z } from "zod";

const booleanFromString = z
  .union([z.boolean(), z.string()])
  .default("false")
  .transform((value) => {
    if (typeof value === "boolean") return value;
    return value.toLowerCase() === "true";
  });

const adminTelegramUserIds = z
  .string()
  .default("")
  .transform((value) =>
    new Set(
      value
        .split(/[,\s]+/)
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .map((part) => Number(part))
        .filter((part) => Number.isSafeInteger(part) && part > 0),
    ),
  );

const optionalPositiveNumber = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.coerce.number().positive().optional(),
);

const optionalUrl = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.string().default("info"),
  TG_BOT_TOKEN: z.string().min(1),
  TG_API_BASE_URL: optionalUrl,
  TG_FILE_BASE_URL: optionalUrl,
  RUBIKA_BOT_TOKEN: z.string().min(1),
  DATABASE_URL: z.string().min(1).default("file:./data/bridge.db"),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(250),
  MEDIA_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  PUBLIC_QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  ADMIN_QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(10),
  PUBLIC_QUEUE_MAX_WAITING: z.coerce.number().int().min(1).default(25),
  ADMIN_TELEGRAM_USER_IDS: adminTelegramUserIds,
  MEDIA_JOB_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(250),
  RUBIKA_UPLOAD_RETRIES: z.coerce.number().int().min(0).max(10).default(6),
  PUBLIC_MAX_FILE_MB: z.coerce.number().positive().default(100),
  ADMIN_MAX_FILE_MB: optionalPositiveNumber,
  MAX_FILE_MB: optionalPositiveNumber,
  TMP_DIR: z.string().min(1).default("/tmp/tg-rubika-bridge"),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return envSchema.parse(env);
}
