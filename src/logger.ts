import pino from "pino";

export function createLogger(level = "info") {
  return pino({
    level,
    serializers: {
      error: pino.stdSerializers.err,
    },
    redact: {
      paths: ["TG_BOT_TOKEN", "RUBIKA_BOT_TOKEN", "*.token", "*.botToken"],
      remove: true,
    },
  });
}

export type AppLogger = ReturnType<typeof createLogger>;
