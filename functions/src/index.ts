import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { onRequest } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2/options';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { localMarketProvider } from '../../src/services/marketData.js';
import { runPaperBotTick } from '../../src/services/paperBotLoop.js';
import type { PaperBotRunAuditEntry, PersistentPaperState } from '../../src/services/paperPersistence.js';
import { buildPaperLedgerDocumentId, DEFAULT_LEDGER_COLLECTION, sanitizePersistentPaperState } from './paperLedger.js';
import { describeOwnerLedgerIdentity } from '../../src/services/paperPersistence.js';

initializeApp();
setGlobalOptions({ maxInstances: 1, region: 'us-central1' });

const db = getFirestore();
const DEFAULT_OWNER_ID = process.env.WEATHER_MARKETS_RUNNER_ID?.trim() || 'firebase-scheduler';
const DEFAULT_LEDGER_ID = process.env.WEATHER_MARKETS_PAPER_LEDGER_ID?.trim() || 'default';
const DEFAULT_SCHEDULE = process.env.WEATHER_MARKETS_CRON?.trim() || 'every 5 minutes';
const MANUAL_TRIGGER_SECRET = process.env.WEATHER_MARKETS_TRIGGER_SECRET?.trim() || '';

export type PaperTickRunSummary = {
  ok: boolean;
  ledgerId: string;
  ownerId: string;
  ownerScope: {
    ownerUid: string;
    ledgerId: string;
    documentId: string;
    collectionName: string;
    documentPath: string;
    envVar: 'WEATHER_MARKETS_RUNNER_ID';
    note: string;
  };
  actionCount: number;
  summary: string;
  marketCount: number;
  staleMarketCount: number;
  queuedCount: number;
  activeCount: number;
  persistencePath: string;
  startedAt: string;
  finishedAt: string;
  trigger: 'schedule' | 'http' | 'script';
  warnings: string[];
};

type PaperTickRunOptions = {
  ledgerId?: string;
  ownerId?: string;
  trigger?: PaperTickRunSummary['trigger'];
};

function isConfiguredOwnerId(ownerId: string) {
  return ownerId.trim().length > 0 && ownerId !== 'firebase-scheduler';
}

function sanitizeRequestedValue(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function buildWarnings(ownerId: string, ledgerId: string) {
  const warnings: string[] = [];
  const ownerScope = describeOwnerLedgerIdentity(ownerId, ledgerId);
  if (!isConfiguredOwnerId(ownerId)) {
    warnings.push(`Runner ownerId is still the default firebase-scheduler placeholder. Set WEATHER_MARKETS_RUNNER_ID to the Firebase Auth uid that owns the paper ledger for always-on automation. Expected ledger path: ${ownerScope.documentPath}`);
  }
  return warnings;
}

function buildOwnerScope(ownerId: string, ledgerId: string): PaperTickRunSummary['ownerScope'] {
  const ownerScope = describeOwnerLedgerIdentity(ownerId, ledgerId);
  return {
    ...ownerScope,
    envVar: 'WEATHER_MARKETS_RUNNER_ID',
    note: 'Set WEATHER_MARKETS_RUNNER_ID to this ownerUid so the backend runner writes to the same owner-scoped ledger document as the signed-in app.',
  };
}

async function loadLedgerState(documentId: string): Promise<PersistentPaperState> {
  const snapshot = await db.collection(DEFAULT_LEDGER_COLLECTION).doc(documentId).get();
  if (!snapshot.exists) {
    return sanitizePersistentPaperState({ source: 'firestore' });
  }

  return sanitizePersistentPaperState({ ...(snapshot.data() as Partial<PersistentPaperState>), source: 'firestore' });
}

function buildAuditEntry(params: {
  runAt: string;
  runnerId: string;
  status: PaperBotRunAuditEntry['status'];
  summary: string;
  marketCount: number;
  actionCount: number;
  staleMarketCount: number;
  queuedCount: number;
  activeCount: number;
  nextDueAt: string | null;
}): PaperBotRunAuditEntry {
  return {
    ...params,
    source: 'backend',
  };
}

export async function runPaperBotTickOnce(options?: PaperTickRunOptions): Promise<PaperTickRunSummary> {
  const startedAt = new Date().toISOString();
  const ledgerId = options?.ledgerId?.trim() || DEFAULT_LEDGER_ID;
  const ownerId = options?.ownerId?.trim() || DEFAULT_OWNER_ID;
  const trigger = options?.trigger ?? 'script';
  const ownerScope = buildOwnerScope(ownerId, ledgerId);
  const documentId = buildPaperLedgerDocumentId(ledgerId, ownerId);
  const persistencePath = `${DEFAULT_LEDGER_COLLECTION}/${documentId}`;
  const warnings = buildWarnings(ownerId, ledgerId);

  if (trigger === 'schedule' && !isConfiguredOwnerId(ownerId)) {
    const finishedAt = new Date().toISOString();
    const blockedSummary = 'Scheduled tick blocked because WEATHER_MARKETS_RUNNER_ID still points at the default placeholder owner.';
    const runAuditEntry = buildAuditEntry({
      runAt: finishedAt,
      runnerId: ownerId,
      status: 'error',
      summary: blockedSummary,
      marketCount: 0,
      actionCount: 0,
      staleMarketCount: 0,
      queuedCount: 0,
      activeCount: 0,
      nextDueAt: null,
    });

    await db.collection(DEFAULT_LEDGER_COLLECTION).doc(documentId).set({
      ownerUid: ownerId,
      baseLedgerId: ledgerId,
      documentId,
      source: 'firestore',
      ownerScope,
      backend: {
        runner: ownerId,
        trigger,
        schedule: DEFAULT_SCHEDULE,
        lastAttemptedAt: startedAt,
        lastRunAt: finishedAt,
        lastRunOk: false,
        lastRunSummary: blockedSummary,
        lastWarnings: warnings,
      },
      botRunHistory: [runAuditEntry],
      botState: {
        ...sanitizePersistentPaperState({ source: 'firestore' }).botState,
        enabled: false,
        status: 'blocked',
        lastHydratedAt: startedAt,
        lastPersistedAt: finishedAt,
        lastError: blockedSummary,
        lastSummary: blockedSummary,
      },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    const summary = {
      ok: false,
      ledgerId,
      ownerId,
      ownerScope,
      actionCount: 0,
      summary: blockedSummary,
      marketCount: 0,
      staleMarketCount: 0,
      queuedCount: 0,
      activeCount: 0,
      persistencePath,
      startedAt,
      finishedAt,
      trigger,
      warnings,
    } satisfies PaperTickRunSummary;

    logger.warn('Paper bot scheduled tick blocked', summary);
    return summary;
  }

  try {
    const [marketsResponse, state] = await Promise.all([
      localMarketProvider.getMarkets(),
      loadLedgerState(documentId),
    ]);

    const result = runPaperBotTick({
      state,
      markets: marketsResponse.markets,
      ownerId,
      now: startedAt,
    });

    const finishedAt = new Date().toISOString();
    const staleMarketCount = marketsResponse.markets.filter((market) => market.freshnessMinutes >= 90 || market.quoteStatus === 'stale' || market.quoteStatus === 'empty').length;
    const queuedCount = Object.values(result.state.paperState).filter((item) => item.state === 'queued').length;
    const activeCount = Object.values(result.state.paperState).filter((item) => item.state === 'active').length;
    const runAuditEntry = buildAuditEntry({
      runAt: finishedAt,
      runnerId: ownerId,
      status: 'ok',
      summary: result.summary,
      marketCount: marketsResponse.markets.length,
      actionCount: result.actions.length,
      staleMarketCount,
      queuedCount,
      activeCount,
      nextDueAt: result.state.botState.nextDueAt,
    });

    await db.collection(DEFAULT_LEDGER_COLLECTION).doc(documentId).set({
      ...result.state,
      ownerUid: result.state.ownerUid ?? ownerId,
      baseLedgerId: ledgerId,
      documentId,
      source: 'firestore',
      ownerScope,
      backend: {
        runner: ownerId,
        trigger,
        lastAttemptedAt: startedAt,
        lastMarketRefreshAt: marketsResponse.meta.refreshedAt,
        lastMarketCount: marketsResponse.markets.length,
        lastActionCount: result.actions.length,
        lastRunSummary: result.summary,
        lastRunAt: finishedAt,
        lastRunOk: true,
        lastWarnings: warnings,
        lastStaleMarketCount: staleMarketCount,
        lastQueuedCount: queuedCount,
        lastActiveCount: activeCount,
        schedule: DEFAULT_SCHEDULE,
      },
      botRunHistory: [runAuditEntry, ...(result.state.botRunHistory ?? [])].slice(0, 12),
      botState: {
        ...result.state.botState,
        status: 'cooldown',
        failureCount: 0,
        lastHydratedAt: startedAt,
        lastPersistedAt: finishedAt,
        nextDueAt: result.state.botState.nextDueAt,
        lastError: null,
        lastSummary: result.summary,
      },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    const summary = {
      ok: true,
      ledgerId,
      ownerId,
      ownerScope,
      actionCount: result.actions.length,
      summary: result.summary,
      marketCount: marketsResponse.markets.length,
      staleMarketCount,
      queuedCount,
      activeCount,
      persistencePath,
      startedAt,
      finishedAt,
      trigger,
      warnings,
    } satisfies PaperTickRunSummary;

    logger.info('Paper bot tick completed', summary);
    return summary;
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : 'Unknown error';
    const previousState = await loadLedgerState(documentId);
    const failureCount = (previousState.botState?.failureCount ?? 0) + 1;
    const queuedCount = Object.values(previousState.paperState ?? {}).filter((item) => item.state === 'queued').length;
    const activeCount = Object.values(previousState.paperState ?? {}).filter((item) => item.state === 'active').length;
    const runAuditEntry = buildAuditEntry({
      runAt: finishedAt,
      runnerId: ownerId,
      status: 'error',
      summary: message,
      marketCount: 0,
      actionCount: 0,
      staleMarketCount: 0,
      queuedCount,
      activeCount,
      nextDueAt: previousState.botState?.nextDueAt ?? null,
    });

    await db.collection(DEFAULT_LEDGER_COLLECTION).doc(documentId).set({
      ownerUid: previousState.ownerUid ?? ownerId,
      ownerEmail: previousState.ownerEmail ?? null,
      ownerDisplayName: previousState.ownerDisplayName ?? null,
      baseLedgerId: ledgerId,
      documentId,
      source: 'firestore',
      ownerScope,
      backend: {
        runner: ownerId,
        trigger,
        lastAttemptedAt: startedAt,
        lastRunAt: finishedAt,
        lastRunOk: false,
        lastRunSummary: message,
        lastWarnings: warnings,
        schedule: DEFAULT_SCHEDULE,
      },
      botRunHistory: [runAuditEntry, ...(previousState.botRunHistory ?? [])].slice(0, 12),
      botState: {
        ...previousState.botState,
        status: 'error',
        failureCount,
        lastHydratedAt: startedAt,
        lastPersistedAt: finishedAt,
        lastError: message,
        lastSummary: `Tick failed: ${message}`,
      },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    logger.error('Paper bot tick failed', { ledgerId, ownerId, ownerScope, trigger, persistencePath, error: message, warnings });
    throw error;
  }
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
    await runPaperBotTickOnce({ trigger: 'schedule' });
  },
);

export const triggerPaperBotNow = onRequest({ cors: true, timeoutSeconds: 180, memory: '512MiB' }, async (request, response) => {
  try {
    const secret = sanitizeRequestedValue(request.get('x-weather-markets-trigger-secret'))
      ?? sanitizeRequestedValue(request.query.secret)
      ?? sanitizeRequestedValue(request.body?.secret);

    if (MANUAL_TRIGGER_SECRET && secret !== MANUAL_TRIGGER_SECRET) {
      response.status(401).json({ ok: false, error: 'Invalid trigger secret.' });
      return;
    }

    const ledgerId = sanitizeRequestedValue(request.query.ledgerId) ?? sanitizeRequestedValue(request.body?.ledgerId);
    const ownerId = sanitizeRequestedValue(request.query.ownerId) ?? sanitizeRequestedValue(request.body?.ownerId);
    const summary = await runPaperBotTickOnce({ ledgerId, ownerId, trigger: 'http' });
    response.status(summary.ok ? 200 : 409).json(summary);
  } catch (error) {
    logger.error('Paper bot tick failed', error);
    response.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
