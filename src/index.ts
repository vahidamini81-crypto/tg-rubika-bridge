import { loadConfig } from "./config.js";
import { TelegramClient } from "./clients/telegramClient.js";
import { RubikaClient } from "./clients/rubikaClient.js";
import { createPrismaClient } from "./db/prisma.js";
import { createLogger } from "./logger.js";
import { BridgeService, MediaJobWorker } from "./services/bridgeService.js";
import { MediaJobStore } from "./services/mediaJobStore.js";
import { PrismaOffsetStore } from "./services/offsetStore.js";
import { PairStore } from "./services/pairStore.js";
import { PairingService } from "./services/pairingService.js";
import { PollingService } from "./services/pollingService.js";
import { PrismaProcessedUpdateStore } from "./services/processedUpdateStore.js";
import { RubikaPollingService } from "./services/rubikaPollingService.js";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const prisma = createPrismaClient();

const telegram = new TelegramClient(config.TG_BOT_TOKEN, fetch, {
  apiBaseUrl: config.TG_API_BASE_URL,
  fileBaseUrl: config.TG_FILE_BASE_URL,
});
const rubika = new RubikaClient(config.RUBIKA_BOT_TOKEN, logger, fetch, {
  uploadRetries: config.RUBIKA_UPLOAD_RETRIES,
});
const offsetStore = new PrismaOffsetStore(prisma);
const pairStore = new PairStore(prisma);
const rubikaProcessedStore = new PrismaProcessedUpdateStore(prisma);
const mediaJobStore = new MediaJobStore(prisma);
const pairing = new PairingService(pairStore, telegram, rubika, logger);

const bridge = new BridgeService(
  telegram,
  rubika,
  pairStore,
  pairing,
  {
    maxFileMb: config.MAX_FILE_MB,
    tmpDir: config.TMP_DIR,
  },
  logger,
  mediaJobStore,
);

const polling = new PollingService(
  telegram,
  bridge,
  offsetStore,
  logger,
  config.POLL_INTERVAL_MS,
);
const rubikaPolling = new RubikaPollingService(
  rubika,
  pairing,
  logger,
  config.POLL_INTERVAL_MS,
  rubikaProcessedStore,
);
const mediaWorker = new MediaJobWorker(
  mediaJobStore,
  bridge,
  logger,
  config.MEDIA_JOB_POLL_INTERVAL_MS,
  config.MEDIA_WORKER_CONCURRENCY,
);

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, "Shutdown signal received");
  polling.stop();
  rubikaPolling.stop();
  mediaWorker.stop();
  void prisma.$disconnect();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

Promise.all([polling.start(), rubikaPolling.start(), mediaWorker.start()]).catch((error) => {
  logger.fatal({ error }, "Bridge stopped unexpectedly");
  process.exitCode = 1;
});
