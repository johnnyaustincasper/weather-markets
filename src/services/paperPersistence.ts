import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { getFirestoreDb, getFirebaseProjectId, isFirebaseConfigured } from '../lib/firebase';
import type { PaperBlotterEntry } from './paperBlotter';
import { createPaperBotLoopState, type PaperBotLoopState } from './paperBotLoop';
import { DEFAULT_PAPER_EXECUTION_SETTINGS, sanitizePaperExecutionSettings, type PaperExecutionProfile } from './paperExecutionSettings';
import type { PaperOrder } from './paperOrders';
import type { PaperPositionState } from './paperTrading';

export type PaperTradeRecord = {
  state: PaperPositionState;
  updatedAt: string;
  note: string;
};

export type PersistentPaperState = {
  version: 1;
  watchIds: string[];
  paperState: Record<string, PaperTradeRecord>;
  paperExecutionProfile: PaperExecutionProfile;
  paperBlotter: Record<string, PaperBlotterEntry>;
  paperOrders: Record<string, PaperOrder[]>;
  botState: PaperBotLoopState;
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
export const DEFAULT_PAPER_LEDGER_ID = (import.meta.env.VITE_PAPER_LEDGER_ID as string | undefined)?.trim() || 'default';

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
    }),
    syncedAt: typeof input.syncedAt === 'string' ? input.syncedAt : new Date().toISOString(),
    source: input.source === 'firestore' ? 'firestore' : 'local',
  };
}

export function readPersistentPaperState(): PersistentPaperState {
  return sanitizeState({
    version: 1,
    watchIds: readJson(LOCAL_STORAGE_KEYS.watchIds, []),
    paperState: readJson(LOCAL_STORAGE_KEYS.paperState, {}),
    paperExecutionProfile: readJson(LOCAL_STORAGE_KEYS.paperExecutionProfile, { global: DEFAULT_PAPER_EXECUTION_SETTINGS, perMarket: {} }),
    paperBlotter: readJson(LOCAL_STORAGE_KEYS.paperBlotter, {}),
    paperOrders: readJson(LOCAL_STORAGE_KEYS.paperOrders, {}),
    botState: createPaperBotLoopState({ lastHydratedAt: null, lastPersistedAt: null }),
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

export async function loadPersistentPaperState(ledgerId = DEFAULT_PAPER_LEDGER_ID) {
  const db = getFirestoreDb();
  if (!db || !isFirebaseConfigured()) return { source: 'local' as const, state: null };

  try {
    const snapshot = await getDoc(doc(db, COLLECTION_NAME, ledgerId));
    if (!snapshot.exists()) return { source: 'firestore' as const, state: null };
    const state = sanitizeState({ ...(snapshot.data() as Partial<PersistentPaperState>), source: 'firestore' });
    writePersistentPaperState(state);
    return { source: 'firestore' as const, state };
  } catch {
    return { source: 'local' as const, state: null };
  }
}

let saveTimer: number | null = null;

export function persistPaperState(state: Partial<PersistentPaperState>, ledgerId = DEFAULT_PAPER_LEDGER_ID) {
  const nextState = sanitizeState(state);
  writePersistentPaperState(nextState);

  const db = getFirestoreDb();
  if (!db || !isFirebaseConfigured() || typeof window === 'undefined') {
    return Promise.resolve({ persisted: false as const, reason: 'firebase-not-configured' as const });
  }

  if (saveTimer !== null) window.clearTimeout(saveTimer);

  return new Promise<{ persisted: true } | { persisted: false; reason: 'firebase-not-configured' }>((resolve) => {
    saveTimer = window.setTimeout(() => {
      void setDoc(doc(db, COLLECTION_NAME, ledgerId), {
        ...nextState,
        botState: {
          ...nextState.botState,
          mode: 'paper',
          lastPersistedAt: new Date().toISOString(),
        },
        source: 'firestore',
        firebaseProjectId: getFirebaseProjectId(),
        updatedAt: serverTimestamp(),
      }, { merge: true })
        .then(() => resolve({ persisted: true }))
        .catch(() => resolve({ persisted: false, reason: 'firebase-not-configured' }));
    }, 400);
  });
}
