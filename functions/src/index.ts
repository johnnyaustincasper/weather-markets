import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { setGlobalOptions } from 'firebase-functions/v2/options';
import { localMarketProvider } from '../../src/services/marketData.js';
import { runPaperBotTick } from '../../src/services/paperBotLoop.js';
import type { PersistentPaperState } from '../../src/services/paperPersistence.js';
import { DEFAULT_LEDGER_COLLECTION, sanitizePersistentPaperState } from './paperLedger.js';

initializeApp();
setGlobalOptions({ maxInstances: 1, region: 'us-central1' });

const db = getFirestore();
const DEFAULT_OWNER_ID = process.env.WEATHER_MARKETS_RUNNER_ID?.trim() || 'firebase-scheduler';
const DEFAULT_LEDGER_ID = process.env.WEATHER_MARKETS_PAPER_LEDGER_ID?.trim() || 'default';
const DEFAULT_SCHEDULE = process.env.WEATHER_MARKETS_CRON?.trim() || 'every 5 minutes';

export type PaperTickRunSummary = {
  ok: boolean;
  ledgerId: string;
  ownerId: string;
  actionCount: number;
  summary: string;
  marketCount: number;
  persistencePath: string;
  startedAt: string;
  finishedAt: string;
};

async function loadLedgerState(ledgerId: string): Promise<PersistentPaperState> {
  const snapshot = await db.collection(DEFAULT_LEDGER_COLLECTION).doc(ledgerId).get();
  if (!snapshot.exists) {
    return sanitizePersistentPaperState({ source: 'firestore' });
  }

  return sanitizePersistentPaperState({ ...(snapshot.data() as Partial<PersistentPaperState>), source: 'firestore' });
}

export async function runPaperBotTickOnce(params?: { ledgerId?: string; ownerId?: string }): Promise<PaperTickRunSummary> {
  const startedAt = new Date().toISOString();
  const ledgerId = params?.ledgerId?.trim() || DEFAULT_LEDGER_ID;
  const ownerId = params?.ownerId?.trim() || DEFAULT_OWNER_ID;
  const persistencePath = `${DEFAULT_LEDGER_COLLECTION}/${ledgerId}`;

  const [marketsResponse, state] = await Promise.all([
    localMarketProvider.getMarkets(),
    loadLedgerState(ledgerId),
  ]);

  const result = runPaperBotTick({
    state,
    markets: marketsResponse.markets,
    ownerId,
    now: startedAt,
  });

  const finishedAt = new Date().toISOString();
  await db.collection(DEFAULT_LEDGER_COLLECTION).doc(ledgerId).set({
    ...result.state,
    source: 'firestore',
    backend: {
      runner: ownerId,
      lastMarketRefreshAt: marketsResponse.meta.refreshedAt,
      lastMarketCount: marketsResponse.markets.length,
      lastActionCount: result.actions.length,
      lastRunSummary: result.summary,
      lastRunAt: finishedAt,
      schedule: DEFAULT_SCHEDULE,
    },
    botState: {
      ...result.state.botState,
      status: 'cooldown',
      lastHydratedAt: startedAt,
      lastPersistedAt: finishedAt,
      nextDueAt: result.state.botState.nextDueAt,
      lastSummary: result.summary,
    },
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  const summary = {
    ok: true,
    ledgerId,
    ownerId,
    actionCount: result.actions.length,
    summary: result.summary,
    marketCount: marketsResponse.markets.length,
    persistencePath,
    startedAt,
    finishedAt,
  } satisfies PaperTickRunSummary;

  logger.info('Paper bot tick completed', summary);
  return summary;
}

export const runScheduledPaperBot = onSchedule(
  {
    schedule: DEFAULT_SCHEDULE,
    timeZone: 'America/Chicago',
    retryCount: 0,
    memory: '512MiB',
    timeoutSeconds: 180,
  },
  async () => {
    await runPaperBotTickOnce();
  },
);

export const triggerPaperBotNow = onRequest({ cors: true, timeoutSeconds: 180, memory: '512MiB' }, async (request, response) => {
  try {
    const ledgerId = typeof request.query.ledgerId === 'string' ? request.query.ledgerId : undefined;
    const ownerId = typeof request.query.ownerId === 'string' ? request.query.ownerId : undefined;
    const summary = await runPaperBotTickOnce({ ledgerId, ownerId });
    response.status(200).json(summary);
  } catch (error) {
    logger.error('Paper bot tick failed', error);
    response.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
