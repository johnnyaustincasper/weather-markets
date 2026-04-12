import { createPaperBotLoopState } from '../../src/services/paperBotLoop.js';
import {
  DEFAULT_PAPER_EXECUTION_SETTINGS,
  sanitizePaperExecutionSettings,
  type PaperExecutionProfile,
} from '../../src/services/paperExecutionSettings.js';
import type { PersistentPaperState } from '../../src/services/paperPersistence.js';

export const DEFAULT_LEDGER_COLLECTION = 'paperTradeLedgers';

export function buildPaperLedgerDocumentId(ledgerId: string, ownerId: string) {
  return `${ownerId}__${ledgerId}`;
}

export function sanitizePersistentPaperState(input: Partial<PersistentPaperState> | undefined): PersistentPaperState {
  const rawExecutionProfile = input?.paperExecutionProfile && typeof input.paperExecutionProfile === 'object'
    ? input.paperExecutionProfile as Partial<PaperExecutionProfile>
    : null;

  return {
    version: 1,
    ownerUid: typeof input?.ownerUid === 'string' ? input.ownerUid : null,
    ownerEmail: typeof input?.ownerEmail === 'string' ? input.ownerEmail : null,
    ownerDisplayName: typeof input?.ownerDisplayName === 'string' ? input.ownerDisplayName : null,
    watchIds: Array.isArray(input?.watchIds) ? input.watchIds.filter((value): value is string => typeof value === 'string') : [],
    paperState: input?.paperState && typeof input.paperState === 'object' ? input.paperState : {},
    paperExecutionProfile: {
      global: sanitizePaperExecutionSettings(rawExecutionProfile?.global ?? DEFAULT_PAPER_EXECUTION_SETTINGS),
      perMarket: Object.fromEntries(
        Object.entries(rawExecutionProfile?.perMarket ?? {}).map(([marketId, value]) => [marketId, sanitizePaperExecutionSettings(value)]),
      ),
    },
    paperBlotter: input?.paperBlotter && typeof input.paperBlotter === 'object' ? input.paperBlotter : {},
    paperOrders: input?.paperOrders && typeof input.paperOrders === 'object' ? input.paperOrders : {},
    botState: createPaperBotLoopState({
      ...input?.botState,
      lastHydratedAt: input?.botState?.lastHydratedAt ?? null,
      lastPersistedAt: input?.botState?.lastPersistedAt ?? null,
    }),
    botRunHistory: Array.isArray(input?.botRunHistory)
      ? input.botRunHistory
        .filter((item): item is PersistentPaperState['botRunHistory'][number] => Boolean(item && typeof item === 'object' && typeof item.runAt === 'string'))
        .slice(0, 12)
      : [],
    ownerScope: input?.ownerScope && typeof input.ownerScope === 'object' && typeof input.ownerScope.documentPath === 'string'
      ? {
        ownerUid: typeof input.ownerScope.ownerUid === 'string' ? input.ownerScope.ownerUid : '',
        ledgerId: typeof input.ownerScope.ledgerId === 'string' ? input.ownerScope.ledgerId : 'default',
        documentId: typeof input.ownerScope.documentId === 'string' ? input.ownerScope.documentId : '',
        collectionName: typeof input.ownerScope.collectionName === 'string' ? input.ownerScope.collectionName : DEFAULT_LEDGER_COLLECTION,
        documentPath: input.ownerScope.documentPath,
      }
      : undefined,
    backend: input?.backend && typeof input.backend === 'object'
      ? {
        runner: typeof input.backend.runner === 'string' ? input.backend.runner : null,
        trigger: input.backend.trigger === 'schedule' || input.backend.trigger === 'http' || input.backend.trigger === 'script' ? input.backend.trigger : null,
        schedule: typeof input.backend.schedule === 'string' ? input.backend.schedule : null,
        lastAttemptedAt: typeof input.backend.lastAttemptedAt === 'string' ? input.backend.lastAttemptedAt : null,
        lastRunAt: typeof input.backend.lastRunAt === 'string' ? input.backend.lastRunAt : null,
        lastRunOk: typeof input.backend.lastRunOk === 'boolean' ? input.backend.lastRunOk : null,
        lastRunSummary: typeof input.backend.lastRunSummary === 'string' ? input.backend.lastRunSummary : null,
        lastWarnings: Array.isArray(input.backend.lastWarnings) ? input.backend.lastWarnings.filter((item): item is string => typeof item === 'string').slice(0, 8) : [],
        lastError: typeof input.backend.lastError === 'string' ? input.backend.lastError : null,
        lastFailureAt: typeof input.backend.lastFailureAt === 'string' ? input.backend.lastFailureAt : null,
        consecutiveFailures: typeof input.backend.consecutiveFailures === 'number' ? input.backend.consecutiveFailures : 0,
        lastMarketRefreshAt: typeof input.backend.lastMarketRefreshAt === 'string' ? input.backend.lastMarketRefreshAt : null,
        lastMarketCount: typeof input.backend.lastMarketCount === 'number' ? input.backend.lastMarketCount : 0,
        lastActionCount: typeof input.backend.lastActionCount === 'number' ? input.backend.lastActionCount : 0,
        lastStaleMarketCount: typeof input.backend.lastStaleMarketCount === 'number' ? input.backend.lastStaleMarketCount : 0,
        lastQueuedCount: typeof input.backend.lastQueuedCount === 'number' ? input.backend.lastQueuedCount : 0,
        lastActiveCount: typeof input.backend.lastActiveCount === 'number' ? input.backend.lastActiveCount : 0,
        expectedCadenceMinutes: typeof input.backend.expectedCadenceMinutes === 'number' ? input.backend.expectedCadenceMinutes : null,
        observedLagMinutes: typeof input.backend.observedLagMinutes === 'number' ? input.backend.observedLagMinutes : null,
        staleStatus: input.backend.staleStatus === 'fresh' || input.backend.staleStatus === 'watch' || input.backend.staleStatus === 'stale' ? input.backend.staleStatus : 'unknown',
        staleReason: typeof input.backend.staleReason === 'string' ? input.backend.staleReason : null,
        leaseOwnerId: typeof input.backend.leaseOwnerId === 'string' ? input.backend.leaseOwnerId : null,
        leaseExpiresAt: typeof input.backend.leaseExpiresAt === 'string' ? input.backend.leaseExpiresAt : null,
        updatedAt: typeof input.backend.updatedAt === 'string' ? input.backend.updatedAt : null,
      }
      : undefined,
    syncedAt: typeof input?.syncedAt === 'string' ? input.syncedAt : new Date().toISOString(),
    source: input?.source === 'firestore' ? 'firestore' : 'local',
  };
}
