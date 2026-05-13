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
import { PendingPairStore } from "./services/pendingPairStore.js";
import { TelegramStatusStore } from "./services/telegramStatusStore.js";
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
const pendingPairStore = new PendingPairStore(prisma);
const telegramStatusStore = new TelegramStatusStore(prisma);
const pairing = new PairingService(pairStore, telegram, rubika, logger, mediaJobStore, {
  adminTelegramUserIds: config.ADMIN_TELEGRAM_USER_IDS,
  publicQueueConcurrency: config.PUBLIC_QUEUE_CONCURRENCY,
  adminQueueConcurrency: config.ADMIN_QUEUE_CONCURRENCY,
  publicQueueMaxWaiting: config.PUBLIC_QUEUE_MAX_WAITING,
}, pendingPairStore, telegramStatusStore);

const bridge = new BridgeService(
  telegram,
  rubika,
  pairStore,
  pairing,
  {
    publicMaxFileMb: config.MAX_FILE_MB ?? config.PUBLIC_MAX_FILE_MB,
    adminMaxFileMb: config.ADMIN_MAX_FILE_MB,
    tmpDir: config.TMP_DIR,
    publicQueueMaxWaiting: config.PUBLIC_QUEUE_MAX_WAITING,
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
const publicMediaWorker = new MediaJobWorker(
  mediaJobStore,
  bridge,
  logger,
  config.MEDIA_JOB_POLL_INTERVAL_MS,
  config.PUBLIC_QUEUE_CONCURRENCY,
  "public",
);
const adminMediaWorker = new MediaJobWorker(
  mediaJobStore,
  bridge,
  logger,
  config.MEDIA_JOB_POLL_INTERVAL_MS,
  config.ADMIN_QUEUE_CONCURRENCY,
  "admin",
);

function shutdown(signal: NodeJS.Signals): void {
  logger.info({ signal }, "Shutdown signal received");
  polling.stop();
  rubikaPolling.stop();
  publicMediaWorker.stop();
  adminMediaWorker.stop();
  void prisma.$disconnect();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

Promise.all([polling.start(), rubikaPolling.start(), publicMediaWorker.start(), adminMediaWorker.start()]).catch((error) => {
  logger.fatal({ error }, "Bridge stopped unexpectedly");
  process.exitCode = 1;
});
