import { createPaperBotLoopState } from '../../src/services/paperBotLoop.js';
import {
  DEFAULT_PAPER_EXECUTION_SETTINGS,
  sanitizePaperExecutionSettings,
  type PaperExecutionProfile,
} from '../../src/services/paperExecutionSettings.js';
import type { PersistentPaperState } from '../../src/services/paperPersistence.js';

export const DEFAULT_LEDGER_COLLECTION = 'paperTradeLedgers';

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
    syncedAt: typeof input?.syncedAt === 'string' ? input.syncedAt : new Date().toISOString(),
    source: input?.source === 'firestore' ? 'firestore' : 'local',
  };
}
