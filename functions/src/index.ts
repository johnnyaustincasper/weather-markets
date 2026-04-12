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

initializeApp();
setGlobalOptions({ maxInstances: 1, region: 'us-central1' });

const db = getFirestore();
const DEFAULT_OWNER_ID = process.env.WEATHER_MARKETS_RUNNER_ID?.trim() || 'firebase-scheduler';
const DEFAULT_LEDGER_ID = process.env.WEATHER_MARKETS_PAPER_LEDGER_ID?.trim() || 'default';
const DEFAULT_SCHEDULE = process.env.WEATHER_MARKETS_CRON?.trim() || 'every 5 minutes';
const MANUAL_TRIGGER_SECRET = process.env.WEATHER_MARKETS_TRIGGER_SECRET?.trim() || '';
const MARKET_SCAN_TIMEOUT_MS = 25_000;

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

type BackendHealthSummary = {
  status: 'fresh' | 'watch' | 'stale' | 'unknown';
  observedLagMinutes: number | null;
  expectedCadenceMinutes: number | null;
  reason: string | null;
};

function isConfiguredOwnerId(ownerId: string) {
  return ownerId.trim().length > 0 && ownerId !== 'firebase-scheduler';
}

function sanitizeRequestedValue(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function buildWarnings(ownerId: string, ledgerId: string) {
  const warnings: string[] = [];
  const ownerScope = buildOwnerScope(ownerId, ledgerId);
  if (!isConfiguredOwnerId(ownerId)) {
    warnings.push(`Runner ownerId is still the default firebase-scheduler placeholder. Set WEATHER_MARKETS_RUNNER_ID to the Firebase Auth uid that owns the paper ledger for always-on automation. Expected ledger path: ${ownerScope.documentPath}`);
  }
  return warnings;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function buildOwnerScope(ownerId: string, ledgerId: string): PaperTickRunSummary['ownerScope'] {
  const normalizedOwnerId = ownerId.trim();
  const normalizedLedgerId = ledgerId.trim() || DEFAULT_LEDGER_ID;
  const documentId = buildPaperLedgerDocumentId(normalizedLedgerId, normalizedOwnerId);
  return {
    ownerUid: normalizedOwnerId,
    ledgerId: normalizedLedgerId,
    documentId,
    collectionName: DEFAULT_LEDGER_COLLECTION,
    documentPath: `${DEFAULT_LEDGER_COLLECTION}/${documentId}`,
    envVar: 'WEATHER_MARKETS_RUNNER_ID',
    note: 'Set WEATHER_MARKETS_RUNNER_ID to this ownerUid so the backend runner writes to the same owner-scoped ledger document as the signed-in app.',
  };
}

function getExpectedCadenceMinutes() {
  const match = DEFAULT_SCHEDULE.match(/every\s+(\d+)\s+minute/i);
  return match ? Number(match[1]) : 5;
}

function summarizeBackendHealth(params: {
  lastRunAt?: string | null;
  lastAttemptedAt?: string | null;
  lastRunOk?: boolean | null;
  enabled?: boolean | null;
  now?: string;
}) : BackendHealthSummary {
  const now = params.now ?? new Date().toISOString();
  const anchor = params.lastRunAt ?? params.lastAttemptedAt ?? null;
  const expectedCadenceMinutes = getExpectedCadenceMinutes();
  if (!anchor) {
    return {
      status: 'unknown',
      observedLagMinutes: null,
      expectedCadenceMinutes,
      reason: 'No backend tick has been recorded yet.',
    };
  }

  const observedLagMinutes = Math.max(0, Math.round((new Date(now).getTime() - new Date(anchor).getTime()) / 60_000));
  if (params.enabled === false) {
    return {
      status: 'watch',
      observedLagMinutes,
      expectedCadenceMinutes,
      reason: 'Bot is disabled, so backend cadence is intentionally idle.',
    };
  }

  if (params.lastRunOk === false) {
    return {
      status: 'stale',
      observedLagMinutes,
      expectedCadenceMinutes,
      reason: 'Latest backend tick failed. Operator review is needed before trusting automation.',
    };
  }

  if (observedLagMinutes >= expectedCadenceMinutes * 3) {
    return {
      status: 'stale',
      observedLagMinutes,
      expectedCadenceMinutes,
      reason: `Latest backend heartbeat is ${observedLagMinutes}m old on an expected ${expectedCadenceMinutes}m cadence.`,
    };
  }

  if (observedLagMinutes >= expectedCadenceMinutes * 2) {
    return {
      status: 'watch',
      observedLagMinutes,
      expectedCadenceMinutes,
      reason: `Backend heartbeat is drifting, ${observedLagMinutes}m old on an expected ${expectedCadenceMinutes}m cadence.`,
    };
  }

  return {
    status: 'fresh',
    observedLagMinutes,
    expectedCadenceMinutes,
    reason: 'Backend cadence looks recent enough for operator trust.',
  };
}

function buildBackendStatus(params: {
  runner: string;
  trigger: PaperTickRunSummary['trigger'];
  lastAttemptedAt: string;
  lastRunAt: string;
  lastRunOk: boolean;
  lastRunSummary: string;
  warnings: string[];
  state?: PersistentPaperState;
  marketRefreshAt?: string | null;
  marketCount?: number;
  actionCount?: number;
  staleMarketCount?: number;
  queuedCount?: number;
  activeCount?: number;
  lastError?: string | null;
  lastFailureAt?: string | null;
  consecutiveFailures?: number;
}) {
  const expectedCadenceMinutes = getExpectedCadenceMinutes();
  const backendHealth = summarizeBackendHealth({
    lastRunAt: params.lastRunAt,
    lastAttemptedAt: params.lastAttemptedAt,
    lastRunOk: params.lastRunOk,
    enabled: params.state?.botState?.enabled,
    now: params.lastRunAt,
  });

  return {
    runner: params.runner,
    trigger: params.trigger,
    schedule: DEFAULT_SCHEDULE,
    lastAttemptedAt: params.lastAttemptedAt,
    lastRunAt: params.lastRunAt,
    lastRunOk: params.lastRunOk,
    lastRunSummary: params.lastRunSummary,
    lastWarnings: params.warnings,
    lastError: params.lastError ?? null,
    lastFailureAt: params.lastFailureAt ?? null,
    consecutiveFailures: params.consecutiveFailures ?? 0,
    lastMarketRefreshAt: params.marketRefreshAt ?? null,
    lastMarketCount: params.marketCount ?? 0,
    lastActionCount: params.actionCount ?? 0,
    lastStaleMarketCount: params.staleMarketCount ?? 0,
    lastQueuedCount: params.queuedCount ?? 0,
    lastActiveCount: params.activeCount ?? 0,
    expectedCadenceMinutes,
    observedLagMinutes: backendHealth.observedLagMinutes,
    staleStatus: backendHealth.status,
    staleReason: backendHealth.reason,
    leaseOwnerId: params.state?.botState?.lease.ownerId ?? null,
    leaseExpiresAt: params.state?.botState?.lease.expiresAt ?? null,
    updatedAt: params.lastRunAt,
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
        ...buildBackendStatus({
          runner: ownerId,
          trigger,
          lastAttemptedAt: startedAt,
          lastRunAt: finishedAt,
          lastRunOk: false,
          lastRunSummary: blockedSummary,
          warnings,
          lastError: blockedSummary,
          lastFailureAt: finishedAt,
          consecutiveFailures: 1,
        }),
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
      withTimeout(localMarketProvider.getMarkets(), MARKET_SCAN_TIMEOUT_MS, 'Market scan'),
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
        ...buildBackendStatus({
          runner: ownerId,
          trigger,
          lastAttemptedAt: startedAt,
          lastRunAt: finishedAt,
          lastRunOk: true,
          lastRunSummary: result.summary,
          warnings,
          state: result.state,
          marketRefreshAt: marketsResponse.meta.refreshedAt,
          marketCount: marketsResponse.markets.length,
          actionCount: result.actions.length,
          staleMarketCount,
          queuedCount,
          activeCount,
          consecutiveFailures: 0,
        }),
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
        ...buildBackendStatus({
          runner: ownerId,
          trigger,
          lastAttemptedAt: startedAt,
          lastRunAt: finishedAt,
          lastRunOk: false,
          lastRunSummary: message,
          warnings,
          state: previousState,
          queuedCount,
          activeCount,
          lastError: message,
          lastFailureAt: finishedAt,
          consecutiveFailures: failureCount,
        }),
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

export const getPaperBotStatus = onRequest({ cors: true, timeoutSeconds: 60, memory: '256MiB' }, async (request, response) => {
  try {
    const secret = sanitizeRequestedValue(request.get('x-weather-markets-trigger-secret'))
      ?? sanitizeRequestedValue(request.query.secret)
      ?? sanitizeRequestedValue(request.body?.secret);

    if (MANUAL_TRIGGER_SECRET && secret !== MANUAL_TRIGGER_SECRET) {
      response.status(401).json({ ok: false, error: 'Invalid trigger secret.' });
      return;
    }

    const ledgerId = sanitizeRequestedValue(request.query.ledgerId) ?? sanitizeRequestedValue(request.body?.ledgerId) ?? DEFAULT_LEDGER_ID;
    const ownerId = sanitizeRequestedValue(request.query.ownerId) ?? sanitizeRequestedValue(request.body?.ownerId) ?? DEFAULT_OWNER_ID;
    const documentId = buildPaperLedgerDocumentId(ledgerId, ownerId);
    const state = await loadLedgerState(documentId);
    const ownerScope = buildOwnerScope(ownerId, ledgerId);
    const backend = state.backend ?? buildBackendStatus({
      runner: ownerId,
      trigger: 'http',
      lastAttemptedAt: state.botState.lastTickStartedAt ?? state.syncedAt,
      lastRunAt: state.botState.lastTickCompletedAt ?? state.syncedAt,
      lastRunOk: state.botState.status !== 'error' && state.botState.status !== 'blocked',
      lastRunSummary: state.botState.lastSummary ?? 'No backend summary saved yet.',
      warnings: buildWarnings(ownerId, ledgerId),
      state,
      queuedCount: Object.values(state.paperState).filter((item) => item.state === 'queued').length,
      activeCount: Object.values(state.paperState).filter((item) => item.state === 'active').length,
      lastError: state.botState.lastError,
      consecutiveFailures: state.botState.failureCount ?? 0,
    });
    const health = summarizeBackendHealth({
      lastRunAt: backend.lastRunAt,
      lastAttemptedAt: backend.lastAttemptedAt,
      lastRunOk: backend.lastRunOk,
      enabled: state.botState.enabled,
    });

    response.status(200).json({
      ok: true,
      ledgerId,
      ownerId,
      ownerScope,
      persistencePath: `${DEFAULT_LEDGER_COLLECTION}/${documentId}`,
      botState: {
        enabled: state.botState.enabled,
        status: state.botState.status,
        tickCount: state.botState.tickCount,
        failureCount: state.botState.failureCount,
        nextDueAt: state.botState.nextDueAt,
        lastTickStartedAt: state.botState.lastTickStartedAt,
        lastTickCompletedAt: state.botState.lastTickCompletedAt,
        lastSummary: state.botState.lastSummary,
        lastError: state.botState.lastError,
        haltReason: state.botState.haltReason,
      },
      backend,
      health,
      latestRun: state.botRunHistory?.[0] ?? null,
      recentRuns: (state.botRunHistory ?? []).slice(0, 5),
    });
  } catch (error) {
    logger.error('Paper bot status lookup failed', error);
    response.status(500).json({ ok: false, error: error instanceof Error ? error.message : 'Unknown error' });
  }
});
