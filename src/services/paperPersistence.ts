import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { getFirestoreDb, getFirebaseProjectId, isFirebaseConfigured } from '../lib/firebase.js';
import type { PaperBlotterEntry } from './paperBlotter.js';
import { createPaperBotLoopState, type PaperBotLoopState } from './paperBotLoop.js';
import { DEFAULT_PAPER_EXECUTION_SETTINGS, sanitizePaperExecutionSettings, type PaperExecutionProfile } from './paperExecutionSettings.js';
import { DEFAULT_PAPER_RISK_GOVERNOR_SETTINGS } from './paperRiskGovernor.js';
import type { PaperOrder } from './paperOrders.js';
import type { PaperPositionState } from './paperTrading.js';

export type PaperTradeRecord = {
  state: PaperPositionState;
  updatedAt: string;
  note: string;
};

export type PaperBotRunAuditEntry = {
  runAt: string;
  runnerId: string;
  status: 'ok' | 'error';
  summary: string;
  marketCount: number;
  actionCount: number;
  staleMarketCount: number;
  queuedCount: number;
  activeCount: number;
  nextDueAt: string | null;
  source: 'ui' | 'backend';
};

export type PaperLedgerOwnerScope = {
  ownerUid: string;
  ledgerId: string;
  documentId: string;
  collectionName: string;
  documentPath: string;
};

export type PaperBotBackendStatus = {
  runner: string | null;
  trigger: 'schedule' | 'http' | 'script' | null;
  schedule: string | null;
  lastAttemptedAt: string | null;
  lastRunAt: string | null;
  lastRunOk: boolean | null;
  lastRunSummary: string | null;
  lastWarnings: string[];
  lastError: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  lastMarketRefreshAt: string | null;
  lastMarketCount: number;
  lastActionCount: number;
  lastStaleMarketCount: number;
  lastQueuedCount: number;
  lastActiveCount: number;
  expectedCadenceMinutes: number | null;
  observedLagMinutes: number | null;
  staleStatus: 'fresh' | 'watch' | 'stale' | 'unknown';
  staleReason: string | null;
  leaseOwnerId: string | null;
  leaseExpiresAt: string | null;
  updatedAt: string | null;
};

export type PersistentPaperState = {
  version: 1;
  ownerUid: string | null;
  ownerEmail: string | null;
  ownerDisplayName: string | null;
  watchIds: string[];
  paperState: Record<string, PaperTradeRecord>;
  paperExecutionProfile: PaperExecutionProfile;
  paperBlotter: Record<string, PaperBlotterEntry>;
  paperOrders: Record<string, PaperOrder[]>;
  botState: PaperBotLoopState;
  botRunHistory: PaperBotRunAuditEntry[];
  ownerScope?: PaperLedgerOwnerScope;
  backend?: PaperBotBackendStatus;
  syncedAt: string;
  source: 'local' | 'firestore';
};

export const LOCAL_STORAGE_KEYS = {
  watchIds: 'weather-markets-watchlist',
  paperState: 'weather-markets-paper-state',
  paperExecutionProfile: 'weather-markets-paper-execution',
  paperBlotter: 'weather-markets-paper-blotter:v1',
  paperOrders: 'weather-markets-paper-orders:v2',
} as const;

const COLLECTION_NAME = 'paperTradeLedgers';
const viteEnv = ((import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env ?? {});
export const DEFAULT_PAPER_LEDGER_ID = viteEnv.VITE_PAPER_LEDGER_ID?.trim() || 'default';

export type LedgerOwnerIdentity = {
  uid: string;
  email?: string | null;
  displayName?: string | null;
};

function hasLocalStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readJson<T>(key: string, fallback: T): T {
  if (!hasLocalStorage()) return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  if (!hasLocalStorage()) return;
  window.localStorage.setItem(key, JSON.stringify(value));
}

function sanitizeState(input: Partial<PersistentPaperState>): PersistentPaperState {
  const rawExecutionProfile = input.paperExecutionProfile && typeof input.paperExecutionProfile === 'object'
    ? input.paperExecutionProfile as Partial<PaperExecutionProfile>
    : null;

  return {
    version: 1,
    ownerUid: typeof input.ownerUid === 'string' ? input.ownerUid : null,
    ownerEmail: typeof input.ownerEmail === 'string' ? input.ownerEmail : null,
    ownerDisplayName: typeof input.ownerDisplayName === 'string' ? input.ownerDisplayName : null,
    watchIds: Array.isArray(input.watchIds) ? input.watchIds.filter((value): value is string => typeof value === 'string') : [],
    paperState: input.paperState && typeof input.paperState === 'object' ? input.paperState : {},
    paperExecutionProfile: {
      global: sanitizePaperExecutionSettings(rawExecutionProfile?.global ?? DEFAULT_PAPER_EXECUTION_SETTINGS),
      perMarket: Object.fromEntries(
        Object.entries(rawExecutionProfile?.perMarket ?? {}).map(([marketId, value]) => [marketId, sanitizePaperExecutionSettings(value)]),
      ),
    },
    paperBlotter: input.paperBlotter && typeof input.paperBlotter === 'object' ? input.paperBlotter : {},
    paperOrders: input.paperOrders && typeof input.paperOrders === 'object' ? input.paperOrders : {},
    botState: createPaperBotLoopState({
      ...input.botState,
      lastHydratedAt: input.botState?.lastHydratedAt ?? null,
      lastPersistedAt: input.botState?.lastPersistedAt ?? null,
      riskGovernor: input.botState?.riskGovernor ?? DEFAULT_PAPER_RISK_GOVERNOR_SETTINGS,
    }),
    botRunHistory: Array.isArray(input.botRunHistory)
      ? input.botRunHistory
        .filter((item): item is PaperBotRunAuditEntry => Boolean(item && typeof item === 'object' && typeof item.runAt === 'string'))
        .slice(0, 12)
      : [],
    ownerScope: input.ownerScope && typeof input.ownerScope === 'object' && typeof input.ownerScope.documentPath === 'string'
      ? {
        ownerUid: typeof input.ownerScope.ownerUid === 'string' ? input.ownerScope.ownerUid : '',
        ledgerId: typeof input.ownerScope.ledgerId === 'string' ? input.ownerScope.ledgerId : DEFAULT_PAPER_LEDGER_ID,
        documentId: typeof input.ownerScope.documentId === 'string' ? input.ownerScope.documentId : '',
        collectionName: typeof input.ownerScope.collectionName === 'string' ? input.ownerScope.collectionName : COLLECTION_NAME,
        documentPath: input.ownerScope.documentPath,
      }
      : undefined,
    backend: input.backend && typeof input.backend === 'object'
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
    syncedAt: typeof input.syncedAt === 'string' ? input.syncedAt : new Date().toISOString(),
    source: input.source === 'firestore' ? 'firestore' : 'local',
  };
}

export function readPersistentPaperState(): PersistentPaperState {
  return sanitizeState({
    version: 1,
    ownerUid: null,
    ownerEmail: null,
    ownerDisplayName: null,
    watchIds: readJson(LOCAL_STORAGE_KEYS.watchIds, []),
    paperState: readJson(LOCAL_STORAGE_KEYS.paperState, {}),
    paperExecutionProfile: readJson(LOCAL_STORAGE_KEYS.paperExecutionProfile, { global: DEFAULT_PAPER_EXECUTION_SETTINGS, perMarket: {} }),
    paperBlotter: readJson(LOCAL_STORAGE_KEYS.paperBlotter, {}),
    paperOrders: readJson(LOCAL_STORAGE_KEYS.paperOrders, {}),
    botState: createPaperBotLoopState({ lastHydratedAt: null, lastPersistedAt: null }),
    botRunHistory: [],
    source: 'local',
  });
}

export function writePersistentPaperState(state: PersistentPaperState) {
  writeJson(LOCAL_STORAGE_KEYS.watchIds, state.watchIds);
  writeJson(LOCAL_STORAGE_KEYS.paperState, state.paperState);
  writeJson(LOCAL_STORAGE_KEYS.paperExecutionProfile, state.paperExecutionProfile);
  writeJson(LOCAL_STORAGE_KEYS.paperBlotter, state.paperBlotter);
  writeJson(LOCAL_STORAGE_KEYS.paperOrders, state.paperOrders);
}

export function isFirestorePersistenceEnabled() {
  return isFirebaseConfigured() && Boolean(getFirestoreDb());
}

export function buildOwnerLedgerDocumentId(ledgerId: string, ownerUid: string) {
  return `${ownerUid}__${ledgerId}`;
}

export type LedgerIdentityDescriptor = {
  ownerUid: string;
  ledgerId: string;
  documentId: string;
  collectionName: string;
  documentPath: string;
};

export function describeOwnerLedgerIdentity(ownerUid: string, ledgerId = DEFAULT_PAPER_LEDGER_ID): LedgerIdentityDescriptor {
  const normalizedOwnerUid = ownerUid.trim();
  const normalizedLedgerId = ledgerId.trim() || DEFAULT_PAPER_LEDGER_ID;
  const documentId = buildOwnerLedgerDocumentId(normalizedLedgerId, normalizedOwnerUid);
  return {
    ownerUid: normalizedOwnerUid,
    ledgerId: normalizedLedgerId,
    documentId,
    collectionName: COLLECTION_NAME,
    documentPath: `${COLLECTION_NAME}/${documentId}`,
  };
}

export async function loadPersistentPaperState(owner: LedgerOwnerIdentity, ledgerId = DEFAULT_PAPER_LEDGER_ID) {
  const db = getFirestoreDb();
  if (!db || !isFirebaseConfigured()) return { source: 'local' as const, state: null };

  try {
    const snapshot = await getDoc(doc(db, COLLECTION_NAME, buildOwnerLedgerDocumentId(ledgerId, owner.uid)));
    if (!snapshot.exists()) return { source: 'firestore' as const, state: null };
    const state = sanitizeState({ ...(snapshot.data() as Partial<PersistentPaperState>), source: 'firestore' });
    writePersistentPaperState(state);
    return { source: 'firestore' as const, state };
  } catch {
    return { source: 'local' as const, state: null };
  }
}

let saveTimer: number | null = null;

type PersistResult =
  | { persisted: true; documentId: string }
  | { persisted: false; reason: 'firebase-not-configured' | 'auth-required' };

export function persistPaperState(state: Partial<PersistentPaperState>, owner: LedgerOwnerIdentity | null, ledgerId = DEFAULT_PAPER_LEDGER_ID): Promise<PersistResult> {
  const nextState = sanitizeState({
    ...state,
    ownerUid: owner?.uid ?? state.ownerUid ?? null,
    ownerEmail: owner?.email ?? state.ownerEmail ?? null,
    ownerDisplayName: owner?.displayName ?? state.ownerDisplayName ?? null,
  });
  writePersistentPaperState(nextState);

  const db = getFirestoreDb();
  if (!db || !isFirebaseConfigured() || typeof window === 'undefined') {
    return Promise.resolve({ persisted: false as const, reason: 'firebase-not-configured' as const });
  }

  if (!owner?.uid) {
    return Promise.resolve({ persisted: false as const, reason: 'auth-required' as const });
  }

  if (saveTimer !== null) window.clearTimeout(saveTimer);

  const documentId = buildOwnerLedgerDocumentId(ledgerId, owner.uid);

  return new Promise<PersistResult>((resolve) => {
    saveTimer = window.setTimeout(() => {
      void setDoc(doc(db, COLLECTION_NAME, documentId), {
        ...nextState,
        ownerUid: owner.uid,
        ownerEmail: owner.email ?? null,
        ownerDisplayName: owner.displayName ?? null,
        baseLedgerId: ledgerId,
        documentId,
        botState: {
          ...nextState.botState,
          mode: 'paper',
          lastPersistedAt: new Date().toISOString(),
        },
        source: 'firestore',
        firebaseProjectId: getFirebaseProjectId(),
        updatedAt: serverTimestamp(),
      }, { merge: true })
        .then(() => resolve({ persisted: true, documentId }))
        .catch(() => resolve({ persisted: false, reason: 'auth-required' }));
    }, 400);
  });
}
