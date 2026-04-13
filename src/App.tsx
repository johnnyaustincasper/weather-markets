import { useCallback, useEffect, useMemo, useState } from 'react';
import type { User } from 'firebase/auth';
import { getMockMarkets } from './data/mockMarkets';
import { applyQuoteRefreshToMarket, localMarketProvider } from './services/marketData';
import {
  buildPaperAfterActionReview,
  getPaperBlotter,
  repricePaperBlotter,
  summarizePaperPerformance,
  syncPaperBlotter,
  type PaperAfterActionReview,
  type PaperBlotterEntry,
  type PaperPerformanceBucket,
} from './services/paperBlotter';
import { summarizePaperAccount } from './services/paperAccount';
import { buildPaperTradePlan, type PaperPositionState } from './services/paperTrading';
import { cancelPaperOrder, getPaperOrders, placePaperOrder, syncPaperOrders, type PaperOrder } from './services/paperOrders';
import {
  summarizePaperRiskGovernor,
} from './services/paperRiskGovernor';
import { summarizePaperValidationGate } from './services/paperValidationGate';
import {
  DEFAULT_PAPER_EXECUTION_SETTINGS,
  mergePaperExecutionSettings,
  sanitizePaperExecutionSettings,
  type PaperExecutionProfile,
  type PaperExecutionSettings,
} from './services/paperExecutionSettings';
import {
  captureMarketHistory,
  getMarketHistory,
  summarizeMarketTrend,
  type MarketHistorySnapshot,
} from './services/marketHistory';
import {
  DEFAULT_PAPER_LEDGER_ID,
  describeOwnerLedgerIdentity,
  isFirestorePersistenceEnabled,
  loadPersistentPaperState,
  persistPaperState,
  type PaperBotBackendStatus,
  type LedgerOwnerIdentity,
  type PaperBotRunAuditEntry,
} from './services/paperPersistence';
import { createPaperBotLoopState, getPaperBotCadenceLabel, runPaperBotTick, type PaperBotLoopState } from './services/paperBotLoop';
import { summarizePaperBotSupervision } from './services/paperBotSupervision';
import { getTradingRuntimeLabel, TRADING_RUNTIME } from './services/tradingRuntime';
import {
  finalizeFirebaseRedirectSignIn,
  getFirebaseEnvStatus,
  getFirebaseProjectId,
  onFirebaseAuthChanged,
  signInToFirebase,
  signOutFromFirebase,
} from './lib/firebase';
import type { MarketFeedMeta, QuoteStatus, WeatherMarket } from './types';

const WATCH_STORAGE_KEY = 'weather-markets-watchlist';
const PAPER_STATE_STORAGE_KEY = 'weather-markets-paper-state';
const PAPER_EXECUTION_STORAGE_KEY = 'weather-markets-paper-execution';
const REFRESH_MS = 90_000;
const QUOTE_REFRESH_MS = 20_000;

const pct = (value: number) => `${Math.round(value * 100)}%`;
const signedPct = (value: number) => `${value >= 0 ? '+' : ''}${Math.round(value * 100)} pts`;
const quotePct = (value: number | null | undefined) => (value === null || value === undefined ? '--' : pct(value));
const freshnessLabel = (minutes: number) => {
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
};
const formatClock = (iso?: string) => {
  if (!iso) return '--';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
};
const formatDateTime = (iso?: string) => {
  if (!iso) return '--';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const clampOrderPrice = (value: number) => Math.min(0.99, Math.max(0.01, value));
const formatUsd = (value: number) => value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const clampPctInput = (value: number, minPct: number, maxPct: number) => Math.min(maxPct, Math.max(minPct, value));
const milestoneLabel = (current: number, target: number) => `${Math.min(current, target)}/${target}`;
const automationGateTone = (allowed: boolean, status: 'trusted' | 'cautious' | 'restricted' | 'promoted' | 'unproven' | 'demoted' | 'disabled') => (
  allowed ? 'tone-good' : status === 'cautious' || status === 'promoted' || status === 'unproven' ? 'tone-warn' : 'tone-bad'
);
const riskRailStatusLabel = (safePct: number, hardPct: number) => `Safe at ${pct(safePct)}, auto-stop at ${pct(hardPct)}`;
const compactUid = (value?: string | null) => {
  if (!value) return '--';
  return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
};
const copyToClipboard = async (value: string) => {
  if (typeof navigator === 'undefined' || !navigator.clipboard) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
};

type MarketStatus = 'best' | 'watch' | 'candidate' | 'stale' | 'skip';
type AlertTone = 'good' | 'warn' | 'bad';

type MarketAlert = {
  id: string;
  marketId: string;
  marketTitle: string;
  tone: AlertTone;
  summary: string;
  detail: string;
  createdAt: string;
};

type MarketDelta = {
  edgeDelta: number;
  confidenceDelta: number;
  freshnessDelta: number;
  status: MarketStatus;
  alerts: MarketAlert[];
};

type PaperTradeRecord = {
  state: PaperPositionState;
  updatedAt: string;
  note: string;
};

type WorkflowStageTone = 'good' | 'warn' | 'bad' | 'muted';

type WorkflowStage = {
  key: string;
  label: string;
  status: string;
  detail: string;
  tone: WorkflowStageTone;
  actionLabel?: string;
  onAction?: () => void;
};

type CommandAction = {
  title: string;
  detail: string;
  tone: AlertTone | 'muted';
  actionLabel?: string;
  onAction?: () => void;
};

type ExposureBucket = {
  key: string;
  label: string;
  units: number;
  markets: number;
  active: number;
  queued: number;
};

type DeskAlert = {
  title: string;
  detail: string;
  tone: AlertTone | 'muted';
  marketId?: string;
};

type BotActivityItem = {
  id: string;
  at: string;
  title: string;
  detail: string;
  tone: AlertTone | 'muted';
  kind: 'fill' | 'bot-run' | 'position';
};

const loadWatchIds = () => {
  if (typeof window === 'undefined') return [] as string[];
  try {
    const raw = window.localStorage.getItem(WATCH_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [] as string[];
  }
};

const loadPaperState = (): Record<string, PaperTradeRecord> => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(PAPER_STATE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, PaperTradeRecord> : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const loadPaperExecutionProfile = (): PaperExecutionProfile => {
  if (typeof window === 'undefined') return { global: DEFAULT_PAPER_EXECUTION_SETTINGS, perMarket: {} };
  try {
    const raw = window.localStorage.getItem(PAPER_EXECUTION_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Partial<PaperExecutionProfile> : {};
    const perMarket = Object.fromEntries(Object.entries(parsed.perMarket ?? {}).map(([marketId, value]) => [marketId, sanitizePaperExecutionSettings(value)]));
    return {
      global: sanitizePaperExecutionSettings(parsed.global),
      perMarket,
    };
  } catch {
    return { global: DEFAULT_PAPER_EXECUTION_SETTINGS, perMarket: {} };
  }
};

const deriveMarketStatus = (market: WeatherMarket, decision: 'would-trade' | 'watch' | 'no-trade', watched: boolean): MarketStatus => {
  if (market.dataOrigin === 'curated-watchlist') return 'candidate';
  if (market.freshnessMinutes >= 180 || market.quoteStatus === 'empty') return 'skip';
  if (market.freshnessMinutes >= 90 || market.quoteStatus === 'stale') return 'stale';
  if (decision === 'would-trade') return 'best';
  if (watched || decision === 'watch' || Math.abs(market.edge) >= 0.06) return 'watch';
  return 'skip';
};

const buildMarketAlerts = (current: WeatherMarket, previous: WeatherMarket | undefined, status: MarketStatus): MarketDelta => {
  const edgeDelta = current.edge - (previous?.edge ?? current.edge);
  const confidenceDelta = current.confidence - (previous?.confidence ?? current.confidence);
  const freshnessDelta = current.freshnessMinutes - (previous?.freshnessMinutes ?? current.freshnessMinutes);
  const alerts: MarketAlert[] = [];

  if (previous && Math.abs(edgeDelta) >= 0.04) {
    alerts.push({
      id: `${current.id}-edge-${current.lastUpdated}`,
      marketId: current.id,
      marketTitle: current.title,
      tone: Math.abs(current.edge) > Math.abs(previous.edge) ? 'good' : 'warn',
      summary: Math.abs(current.edge) > Math.abs(previous.edge) ? 'Edge improved' : 'Edge faded',
      detail: `Edge moved from ${signedPct(previous.edge)} to ${signedPct(current.edge)}.`,
      createdAt: current.lastUpdated,
    });
  }

  if (previous && Math.abs(confidenceDelta) >= 0.06) {
    alerts.push({
      id: `${current.id}-confidence-${current.lastUpdated}`,
      marketId: current.id,
      marketTitle: current.title,
      tone: confidenceDelta > 0 ? 'good' : 'warn',
      summary: confidenceDelta > 0 ? 'Model confidence up' : 'Model confidence down',
      detail: `Confidence changed from ${pct(previous.confidence)} to ${pct(current.confidence)}.`,
      createdAt: current.lastUpdated,
    });
  }

  if (previous && freshnessDelta >= 20) {
    alerts.push({
      id: `${current.id}-freshness-${current.lastUpdated}`,
      marketId: current.id,
      marketTitle: current.title,
      tone: current.freshnessMinutes >= 120 ? 'bad' : 'warn',
      summary: 'Data getting older',
      detail: `Freshness moved from ${freshnessLabel(previous.freshnessMinutes)} to ${freshnessLabel(current.freshnessMinutes)}.`,
      createdAt: current.lastUpdated,
    });
  }

  if (!previous) {
    alerts.push({
      id: `${current.id}-new-${current.lastUpdated}`,
      marketId: current.id,
      marketTitle: current.title,
      tone: status === 'best' ? 'good' : 'warn',
      summary: 'New on the board',
      detail: 'This setup appeared in the latest scan.',
      createdAt: current.lastUpdated,
    });
  }

  return { edgeDelta, confidenceDelta, freshnessDelta, status, alerts };
};

const directionLabel = (direction: 'buy-yes' | 'buy-no' | 'stand-aside') => {
  if (direction === 'buy-yes') return 'YES';
  if (direction === 'buy-no') return 'NO';
  return 'Flat';
};

function App() {
  const [authUser, setAuthUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [markets, setMarkets] = useState<WeatherMarket[]>([]);
  const [previousMarkets, setPreviousMarkets] = useState<Record<string, WeatherMarket>>({});
  const [meta, setMeta] = useState<MarketFeedMeta | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [watchIds, setWatchIds] = useState<string[]>(() => loadWatchIds());
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastScanAt, setLastScanAt] = useState('');
  const [historyTick, setHistoryTick] = useState(0);
  const [paperState, setPaperState] = useState<Record<string, PaperTradeRecord>>(() => loadPaperState());
  const [paperExecutionProfile, setPaperExecutionProfile] = useState<PaperExecutionProfile>(() => loadPaperExecutionProfile());
  const [paperBlotter, setPaperBlotter] = useState<Record<string, PaperBlotterEntry>>(() => getPaperBlotter());
  const [paperOrders, setPaperOrders] = useState<Record<string, PaperOrder[]>>(() => getPaperOrders());
  const [paperBotState, setPaperBotState] = useState<PaperBotLoopState>(() => createPaperBotLoopState({ lastHydratedAt: null, lastPersistedAt: null }));
  const [paperBotRunHistory, setPaperBotRunHistory] = useState<PaperBotRunAuditEntry[]>([]);
  const [paperBotBackend, setPaperBotBackend] = useState<PaperBotBackendStatus | null>(null);
  const [paperOrderDrafts, setPaperOrderDrafts] = useState<Record<string, { quantity: number; limitPrice: number; note: string }>>({});
  const [paperRepriceMeta, setPaperRepriceMeta] = useState<{ at: string; changedCount: number } | null>(null);
  const [selectedReviewMarketId, setSelectedReviewMarketId] = useState('');
  const firebaseEnvStatus = useMemo(() => getFirebaseEnvStatus(), []);
  const [persistenceStatus, setPersistenceStatus] = useState<{ mode: 'local' | 'firestore'; detail: string }>({
    mode: isFirestorePersistenceEnabled() ? 'firestore' : 'local',
    detail: isFirestorePersistenceEnabled()
      ? `Firebase is configured for project ${getFirebaseProjectId()}, but browser persistence stays local until you sign in.`
      : 'Browser-local paper ledger. Add Firebase env vars to enable durable backend persistence.',
  });

  const ledgerOwner = useMemo<LedgerOwnerIdentity | null>(() => authUser ? ({
    uid: authUser.uid,
    email: authUser.email,
    displayName: authUser.displayName,
  }) : null, [authUser]);
  const appLedgerScope = useMemo(() => ledgerOwner ? describeOwnerLedgerIdentity(ledgerOwner.uid, DEFAULT_PAPER_LEDGER_ID) : null, [ledgerOwner]);
  const authModeLabel = ledgerOwner ? 'Signed in with Google' : persistenceStatus.mode === 'firestore' ? 'Firestore ready, waiting on owner auth' : 'Local-only mode';
  const authModeDetail = !firebaseEnvStatus.ready
    ? `Firebase env missing: ${firebaseEnvStatus.missing.join(', ')}`
    : ledgerOwner
      ? `Owner-scoped sync is live in project ${getFirebaseProjectId() ?? '--'}.`
      : authReady
        ? 'Sign in with Google to move this ledger out of browser-local mode and into your owner-scoped Firestore path.'
        : 'Checking Firebase Auth session...';

  useEffect(() => {
    void finalizeFirebaseRedirectSignIn().catch(() => {
      // best effort, auth listener below remains source of truth
    });

    return onFirebaseAuthChanged((user) => {
      setAuthUser(user);
      setAuthReady(true);
    });
  }, []);

  const handleSignIn = useCallback(async () => {
    try {
      setAuthBusy(true);
      setPersistenceStatus({
        mode: isFirestorePersistenceEnabled() ? 'firestore' : 'local',
        detail: 'Starting Google sign-in. If your browser blocks popups or you are on mobile, the app will continue with a full-page Google redirect.',
      });
      const result = await signInToFirebase();
      if (!result) return;
      setPersistenceStatus({
        mode: 'firestore',
        detail: `Signed in as ${result.user.email ?? result.user.uid}. Firestore sync is ready for ledger ${DEFAULT_PAPER_LEDGER_ID}.`,
      });
    } catch (error) {
      setPersistenceStatus({
        mode: 'local',
        detail: error instanceof Error ? `Firebase sign-in failed, local browser state still active: ${error.message}` : 'Firebase sign-in failed, local browser state still active.',
      });
    } finally {
      setAuthBusy(false);
    }
  }, []);

  const handleSignOut = useCallback(async () => {
    try {
      setAuthBusy(true);
      await signOutFromFirebase();
      setPersistenceStatus({
        mode: 'local',
        detail: 'Signed out, so browser-local paper state remains available but Firestore sync is paused.',
      });
    } catch (error) {
      setPersistenceStatus({
        mode: 'local',
        detail: error instanceof Error ? `Sign-out hit a local-only fallback: ${error.message}` : 'Sign-out hit a local-only fallback.',
      });
    } finally {
      setAuthBusy(false);
    }
  }, []);

  const fetchMarkets = useCallback(async (silent = false) => {
    if (silent) setRefreshing(true);
    else setLoading(true);

    try {
      const response = await localMarketProvider.getMarkets();
      const capturedAt = response.meta.refreshedAt || new Date().toISOString();
      captureMarketHistory(response.markets, capturedAt);
      setHistoryTick((value) => value + 1);
      setMarkets((current) => {
        setPreviousMarkets(Object.fromEntries(current.map((market) => [market.id, market])));
        return response.markets;
      });
      setMeta(response.meta);
      setLastScanAt(capturedAt);
      setError('');
      setSelectedId((current) => current || response.markets[0]?.id || '');
      setPaperOrders(syncPaperOrders(response.markets).orders);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load weather markets.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const refreshQuotes = useCallback(async () => {
    try {
      const updates = await localMarketProvider.getQuoteUpdates();
      const capturedAt = new Date().toISOString();
      let changed = false;

      setMarkets((current) => {
        const next = current.map((market) => {
          const update = updates.find((item) => item.marketId === market.id);
          if (!update || (!update.clobQuote && update.impliedProbability === null)) return market;

          const nextMarket = applyQuoteRefreshToMarket(market, update);
          if (
            nextMarket.impliedProbability === market.impliedProbability
            && nextMarket.edge === market.edge
            && nextMarket.confidence === market.confidence
            && nextMarket.disagreement === market.disagreement
            && nextMarket.freshnessMinutes === market.freshnessMinutes
            && nextMarket.quoteStatus === market.quoteStatus
            && nextMarket.clobQuote?.bestBid === market.clobQuote?.bestBid
            && nextMarket.clobQuote?.bestAsk === market.clobQuote?.bestAsk
            && nextMarket.clobQuote?.midpoint === market.clobQuote?.midpoint
            && nextMarket.clobQuote?.spread === market.clobQuote?.spread
            && nextMarket.clobQuote?.lastTradePrice === market.clobQuote?.lastTradePrice
          ) {
            return market;
          }

          changed = true;
          return nextMarket;
        });

        if (changed) {
          captureMarketHistory(next, capturedAt);
          setHistoryTick((value) => value + 1);
        }
        return next;
      });
    } catch {
      // best effort
    }
  }, []);

  useEffect(() => {
    void fetchMarkets();
  }, [fetchMarkets]);

  useEffect(() => {
    let active = true;

    if (!isFirestorePersistenceEnabled()) {
      setPersistenceStatus({
        mode: 'local',
        detail: 'Browser-local paper ledger. Add Firebase env vars to enable durable backend persistence.',
      });
      return () => {
        active = false;
      };
    }

    if (!ledgerOwner) {
      setPersistenceStatus({
        mode: 'local',
        detail: `Firebase is configured for project ${getFirebaseProjectId()}, but browser persistence stays local until you sign in.`,
      });
      return () => {
        active = false;
      };
    }

    void (async () => {
      try {
        const result = await loadPersistentPaperState(ledgerOwner, DEFAULT_PAPER_LEDGER_ID);
        if (!active || !result.state) {
          if (active) {
            setPersistenceStatus({
              mode: 'firestore',
              detail: `Signed in as ${ledgerOwner.email ?? ledgerOwner.uid}. No remote ledger exists yet, so local state will seed Firestore on the next write.`,
            });
          }
          return;
        }

        setWatchIds(result.state.watchIds);
        setPaperState(result.state.paperState);
        setPaperExecutionProfile(result.state.paperExecutionProfile);
        setPaperBlotter(result.state.paperBlotter);
        setPaperOrders(result.state.paperOrders);
        setPaperBotState(createPaperBotLoopState(result.state.botState));
        setPaperBotRunHistory(result.state.botRunHistory ?? []);
        setPaperBotBackend(result.state.backend ?? null);
        setPersistenceStatus({
          mode: 'firestore',
          detail: `Hydrated your Firestore paper ledger (${getFirebaseProjectId()}/${DEFAULT_PAPER_LEDGER_ID}) for ${ledgerOwner.email ?? ledgerOwner.uid}.`,
        });
      } catch (error) {
        if (!active) return;
        setPersistenceStatus({
          mode: 'local',
          detail: error instanceof Error ? `Firestore load failed, using local browser state: ${error.message}` : 'Firestore load failed, using local browser state.',
        });
      }
    })();

    return () => {
      active = false;
    };
  }, [ledgerOwner]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(WATCH_STORAGE_KEY, JSON.stringify(watchIds));
  }, [watchIds]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(PAPER_STATE_STORAGE_KEY, JSON.stringify(paperState));
  }, [paperState]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(PAPER_EXECUTION_STORAGE_KEY, JSON.stringify(paperExecutionProfile));
  }, [paperExecutionProfile]);

  useEffect(() => {
    if (!isFirestorePersistenceEnabled() || !ledgerOwner) return;

    const timeout = window.setTimeout(() => {
      void (async () => {
        try {
          const result = await persistPaperState({
            version: 1,
            watchIds,
            paperState,
            paperExecutionProfile,
            paperBlotter,
            paperOrders,
            botState: createPaperBotLoopState({
              ...paperBotState,
              lastHydratedAt: paperBotState.lastHydratedAt ?? new Date().toISOString(),
              lastPersistedAt: null,
            }),
            botRunHistory: paperBotRunHistory,
            runtime: TRADING_RUNTIME,
            syncedAt: new Date().toISOString(),
            source: 'local',
          }, ledgerOwner, DEFAULT_PAPER_LEDGER_ID);

          if (!result.persisted) {
            setPersistenceStatus({
              mode: 'local',
              detail: result.reason === 'auth-required'
                ? 'Firebase is configured, but Firestore sync is paused until you sign in with a trusted account.'
                : 'Firebase config is incomplete, so paper state is staying local-only.',
            });
            return;
          }
          setPersistenceStatus({
            mode: 'firestore',
            detail: `Persisting owner-scoped paper ledger to Firestore (${getFirebaseProjectId()}/${result.documentId}).`,
          });
        } catch (error) {
          setPersistenceStatus({
            mode: 'local',
            detail: error instanceof Error ? `Firestore save failed, local browser state still active: ${error.message}` : 'Firestore save failed, local browser state still active.',
          });
        }
      })();
    }, 400);

    return () => window.clearTimeout(timeout);
  }, [ledgerOwner, watchIds, paperState, paperExecutionProfile, paperBlotter, paperOrders, paperBotState, paperBotRunHistory]);

  const runPaperBotNow = useCallback(() => {
    if (!markets.length) return;

    const now = new Date().toISOString();
    const runnerId = ledgerOwner?.uid ?? `ui-${DEFAULT_PAPER_LEDGER_ID}`;
    const result = runPaperBotTick({
      state: {
        version: 1,
        ownerUid: ledgerOwner?.uid ?? null,
        ownerEmail: ledgerOwner?.email ?? null,
        ownerDisplayName: ledgerOwner?.displayName ?? null,
        watchIds,
        paperState,
        paperExecutionProfile,
        paperBlotter,
        paperOrders,
        botState: paperBotState,
        botRunHistory: paperBotRunHistory,
        runtime: TRADING_RUNTIME,
        syncedAt: now,
        source: persistenceStatus.mode,
      },
      markets,
      ownerId: runnerId,
      now,
    });

    const staleMarketCount = markets.filter((market) => market.freshnessMinutes >= 90 || market.quoteStatus === 'stale' || market.quoteStatus === 'empty').length;
    const queuedCount = Object.values(result.state.paperState).filter((item) => item.state === 'queued').length;
    const activeCount = Object.values(result.state.paperState).filter((item) => item.state === 'active').length;

    setPaperState(result.state.paperState);
    setPaperBotState(createPaperBotLoopState(result.state.botState));
    setPaperBotRunHistory((current) => {
      const entry: PaperBotRunAuditEntry = {
        runAt: now,
        runnerId,
        status: 'ok',
        summary: result.summary,
        marketCount: markets.length,
        actionCount: result.actions.length,
        staleMarketCount,
        queuedCount,
        activeCount,
        nextDueAt: result.state.botState.nextDueAt,
        source: 'ui',
      };
      return [entry, ...current].slice(0, 12);
    });
  }, [ledgerOwner, markets, paperBlotter, paperBotRunHistory, paperBotState, paperExecutionProfile, paperOrders, paperState, persistenceStatus.mode, watchIds]);

  useEffect(() => {
    if (!paperBotState.enabled || !markets.length) return;

    const interval = window.setInterval(() => {
      runPaperBotNow();
    }, Math.max(paperBotState.cadenceMs, 15_000));

    return () => window.clearInterval(interval);
  }, [markets.length, paperBotState.cadenceMs, paperBotState.enabled, runPaperBotNow]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void fetchMarkets(true);
    }, REFRESH_MS);

    return () => window.clearInterval(interval);
  }, [fetchMarkets]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshQuotes();
    }, QUOTE_REFRESH_MS);

    return () => window.clearInterval(interval);
  }, [refreshQuotes]);

  const watchSet = useMemo(() => new Set(watchIds), [watchIds]);
  const liveGoodMatches = useMemo(() => markets.filter((market) => market.dataOrigin !== 'curated-watchlist').filter((market) => {
    const plan = buildPaperTradePlan(market, mergePaperExecutionSettings(paperExecutionProfile, market.id));
    return plan.decision === 'would-trade' || plan.decision === 'watch';
  }), [markets, paperExecutionProfile]);
  const fallbackMarkets = useMemo(() => getMockMarkets(), []);
  const displayMarkets = useMemo(() => {
    const liveMarkets = markets.filter((market) => market.dataOrigin !== 'curated-watchlist');
    return liveGoodMatches.length ? [...liveMarkets, ...fallbackMarkets] : [...fallbackMarkets, ...liveMarkets];
  }, [fallbackMarkets, liveGoodMatches.length, markets]);
  const selectedMarket = useMemo(() => displayMarkets.find((market) => market.id === selectedId) ?? displayMarkets[0], [displayMarkets, selectedId]);
  const effectivePaperSettings = useMemo(() => Object.fromEntries(displayMarkets.map((market) => [market.id, mergePaperExecutionSettings(paperExecutionProfile, market.id)])), [displayMarkets, paperExecutionProfile]);
  const paperPlans = useMemo(() => Object.fromEntries(displayMarkets.map((market) => [market.id, buildPaperTradePlan(market, effectivePaperSettings[market.id])])), [displayMarkets, effectivePaperSettings]);

  const marketDeltas = useMemo(() => {
    return Object.fromEntries(displayMarkets.map((market) => {
      const plan = paperPlans[market.id];
      const status = deriveMarketStatus(market, plan.decision, watchSet.has(market.id));
      return [market.id, buildMarketAlerts(market, previousMarkets[market.id], status)];
    }));
  }, [displayMarkets, paperPlans, previousMarkets, watchSet]);

  const allAlerts = useMemo(() => {
    return Object.values(marketDeltas)
      .flatMap((item) => item.alerts)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 10);
  }, [marketDeltas]);

  const selectedTrend = useMemo(() => selectedMarket && selectedMarket.dataOrigin !== 'curated-watchlist' ? summarizeMarketTrend(selectedMarket.id) : null, [selectedMarket, historyTick]);
  const selectedHistory = useMemo(() => selectedMarket && selectedMarket.dataOrigin !== 'curated-watchlist' ? getMarketHistory(selectedMarket.id)?.snapshots ?? [] : [], [selectedMarket, historyTick]);
  const historyPreview = useMemo(() => selectedHistory.slice().reverse().slice(0, 5), [selectedHistory]);
  const paperPerformance = useMemo(() => summarizePaperPerformance(paperBlotter), [paperBlotter]);
  const paperValidationGate = useMemo(() => summarizePaperValidationGate(paperBlotter), [paperBlotter]);
  const paperAccount = useMemo(() => summarizePaperAccount({ blotter: paperBlotter, orders: paperOrders, botState: paperBotState }), [paperBlotter, paperBotState, paperOrders]);
  const paperRiskGovernor = useMemo(() => summarizePaperRiskGovernor({
    settings: paperBotState.riskGovernor,
    startingCash: paperAccount.startingCash,
    blotter: paperBlotter,
    orders: paperOrders,
    paperState,
    markets: displayMarkets,
  }), [displayMarkets, paperAccount.startingCash, paperBlotter, paperBotState.riskGovernor, paperOrders, paperState]);
  const paperBotRuntime = useMemo(() => Object.values(paperBotState.marketRuntime), [paperBotState.marketRuntime]);
  const paperBotSupervision = useMemo(() => summarizePaperBotSupervision({
    botState: paperBotState,
    markets: displayMarkets,
    paperState,
    paperBlotter,
    paperOrders,
  }), [displayMarkets, paperBlotter, paperBotState, paperOrders, paperState]);
  const paperBotHotMarkets = useMemo(() => paperBotRuntime
    .filter((item) => item.state === 'queued' || item.state === 'active' || item.consecutiveWouldTradeTicks > 0)
    .sort((left, right) => right.consecutiveWouldTradeTicks - left.consecutiveWouldTradeTicks)
    .slice(0, 5), [paperBotRuntime]);
  const latestBotAudit = paperBotRunHistory[0] ?? null;
  const backendHealthTone = paperBotBackend?.staleStatus === 'stale'
    ? 'negative'
    : paperBotBackend?.staleStatus === 'watch'
      ? undefined
      : paperBotBackend?.staleStatus === 'fresh'
        ? 'positive'
        : undefined;
  const backendHeartbeatLabel = paperBotBackend?.observedLagMinutes === null || paperBotBackend?.observedLagMinutes === undefined
    ? '--'
    : `${paperBotBackend.observedLagMinutes}m`;
  const backendFailureLabel = paperBotBackend?.consecutiveFailures ? String(paperBotBackend.consecutiveFailures) : '0';
  const backendLedgerScope = useMemo(() => {
    const runnerId = paperBotBackend?.runner?.trim();
    return runnerId ? describeOwnerLedgerIdentity(runnerId, DEFAULT_PAPER_LEDGER_ID) : null;
  }, [paperBotBackend?.runner]);
  const ownerScopeAligned = Boolean(appLedgerScope && backendLedgerScope && appLedgerScope.documentPath === backendLedgerScope.documentPath);
  const allPaperOrders = useMemo(() => Object.values(paperOrders).flat(), [paperOrders]);
  const allFilledOrders = useMemo(() => allPaperOrders.filter((order) => order.filledQuantity > 0), [allPaperOrders]);
  const openBlotterEntries = useMemo(() => Object.values(paperBlotter)
    .filter((entry) => entry.state === 'active' || entry.state === 'queued')
    .sort((left, right) => Math.abs(right.markedPnlPoints ?? 0) - Math.abs(left.markedPnlPoints ?? 0)), [paperBlotter]);
  const livePositionSummary = useMemo(() => {
    const workingOrders = allPaperOrders.filter((order) => order.status === 'working' || order.status === 'partial');
    const partialOrders = allPaperOrders.filter((order) => order.status === 'partial');
    const filledOrders = allPaperOrders.filter((order) => order.status === 'filled');
    const activePositions = Object.values(paperState).filter((item) => item.state === 'active');
    const queuedPositions = Object.values(paperState).filter((item) => item.state === 'queued');
    const closedPositions = Object.values(paperState).filter((item) => item.state === 'closed');
    const totalFilledUnits = allFilledOrders.reduce((sum, order) => sum + order.filledQuantity, 0);
    const realized = paperPerformance.totals.totalRealizedPnl;
    const markedOpen = openBlotterEntries.reduce((sum, entry) => sum + (entry.markedPnlPoints ?? 0), 0);

    return {
      workingOrders: workingOrders.length,
      partialOrders: partialOrders.length,
      filledOrders: filledOrders.length,
      activePositions: activePositions.length,
      queuedPositions: queuedPositions.length,
      closedPositions: closedPositions.length,
      totalFilledUnits,
      realized,
      markedOpen: Number(markedOpen.toFixed(4)),
    };
  }, [allFilledOrders, allPaperOrders, openBlotterEntries, paperPerformance.totals.totalRealizedPnl, paperState]);
  const botActivityFeed = useMemo(() => {
    const fillItems: BotActivityItem[] = allFilledOrders.map((order) => ({
      id: `fill-${order.id}`,
      at: order.lastFillAt ?? order.updatedAt,
      title: `${order.direction === 'buy-yes' ? 'BUY YES' : 'BUY NO'} fill`,
      detail: `${order.marketTitle} filled ${order.filledQuantity}/${order.quantity}u at ${pct(order.fillPrice ?? order.limitPrice)} average.`,
      tone: order.status === 'filled' ? 'good' : 'warn',
      kind: 'fill',
    }));
    const botRunItems: BotActivityItem[] = paperBotRunHistory.map((run) => ({
      id: `run-${run.runAt}-${run.runnerId}`,
      at: run.runAt,
      title: run.source === 'backend' ? 'Backend bot tick' : 'UI bot tick',
      detail: `${run.summary} ${run.actionCount} actions, ${run.queuedCount} queued, ${run.activeCount} active.`,
      tone: run.status === 'ok' ? 'good' : 'bad',
      kind: 'bot-run',
    }));
    const positionItems: BotActivityItem[] = Object.entries(paperState)
      .filter(([, record]) => record.state === 'active' || record.state === 'queued' || record.state === 'closed')
      .map(([marketId, record]) => ({
        id: `position-${marketId}-${record.updatedAt}`,
        at: record.updatedAt,
        title: `${record.state.toUpperCase()} position`,
        detail: `${displayMarkets.find((market) => market.id === marketId)?.title ?? marketId}: ${record.note}`,
        tone: record.state === 'active' ? 'good' : record.state === 'queued' ? 'warn' : 'muted',
        kind: 'position',
      }));

    return [...fillItems, ...botRunItems, ...positionItems]
      .sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime())
      .slice(0, 8);
  }, [allFilledOrders, displayMarkets, paperBotRunHistory, paperState]);
  const positionSpotlight = useMemo(() => openBlotterEntries.slice(0, 6), [openBlotterEntries]);
  const exposureSummary = useMemo(() => {
    const tracked = displayMarkets
      .map((market) => {
        const state = paperState[market.id]?.state;
        if (state !== 'active' && state !== 'queued') return null;

        const plan = paperPlans[market.id];
        const orders = paperOrders[market.id] ?? [];
        const filledUnits = orders.reduce((sum, order) => sum + order.filledQuantity, 0);
        const workingUnits = orders
          .filter((order) => order.status === 'working' || order.status === 'partial')
          .reduce((sum, order) => sum + order.remainingQuantity, 0);
        const suggestedUnits = plan?.sizing.suggestedUnits ?? 0;
        const units = state === 'active'
          ? Math.max(filledUnits, suggestedUnits || 1)
          : Math.max(workingUnits, suggestedUnits || 1);

        return {
          marketId: market.id,
          title: market.title,
          state,
          direction: plan?.direction ?? 'stand-aside',
          location: market.location,
          setupType: market.resolutionSchema.kind,
          units,
        };
      })
      .filter((item): item is NonNullable<typeof item> => Boolean(item));

    const sumUnits = (items: typeof tracked) => items.reduce((sum, item) => sum + item.units, 0);
    const active = tracked.filter((item) => item.state === 'active');
    const queued = tracked.filter((item) => item.state === 'queued');
    const yesUnits = sumUnits(tracked.filter((item) => item.direction === 'buy-yes'));
    const noUnits = sumUnits(tracked.filter((item) => item.direction === 'buy-no'));
    const grossUnits = sumUnits(tracked);
    const netBiasUnits = yesUnits - noUnits;

    const buildBuckets = (items: typeof tracked, getKey: (item: typeof tracked[number]) => string, getLabel: (item: typeof tracked[number]) => string) => {
      const buckets = new Map<string, ExposureBucket>();
      for (const item of items) {
        const key = getKey(item);
        const existing = buckets.get(key) ?? { key, label: getLabel(item), units: 0, markets: 0, active: 0, queued: 0 };
        existing.units += item.units;
        existing.markets += 1;
        if (item.state === 'active') existing.active += item.units;
        if (item.state === 'queued') existing.queued += item.units;
        buckets.set(key, existing);
      }
      return Array.from(buckets.values()).sort((left, right) => right.units - left.units).slice(0, 4);
    };

    const byLocation = buildBuckets(tracked, (item) => item.location, (item) => item.location);
    const bySetup = buildBuckets(tracked, (item) => item.setupType, (item) => setupTypeLabel(item.setupType));
    const byDirection = buildBuckets(tracked, (item) => item.direction, (item) => `${directionLabel(item.direction)} bias`);
    const topLocation = byLocation[0];
    const topSetup = bySetup[0];

    const alerts: DeskAlert[] = [];
    if (!tracked.length) {
      alerts.push({ title: 'No desk risk on', detail: 'Nothing is queued or active, so the board is clean for the next setup.', tone: 'muted' });
    }
    if (grossUnits > 0 && topLocation && topLocation.units / grossUnits >= 0.5) {
      alerts.push({ title: 'Location concentration high', detail: `${topLocation.label} holds ${topLocation.units} of ${grossUnits} tracked units. Add a second city or cut size before stacking more there.`, tone: 'warn' });
    }
    if (grossUnits > 0 && Math.max(yesUnits, noUnits) / grossUnits >= 0.75) {
      const dominantSide = yesUnits >= noUnits ? 'YES' : 'NO';
      alerts.push({ title: `${dominantSide} bias is crowded`, detail: `${dominantSide} exposure controls ${Math.max(yesUnits, noUnits)} of ${grossUnits} tracked units, so one weather regime could hit most of the book together.`, tone: 'warn' });
    }
    if (queued.length >= 3 && active.length === 0) {
      alerts.push({ title: 'Queue is building without fills', detail: `${queued.length} setups are staged but none are active. Either improve limits or trim stale tickets so attention stays sharp.`, tone: 'bad' });
    }
    if (topSetup && topSetup.units >= Math.max(6, grossUnits * 0.45)) {
      alerts.push({ title: 'Setup-type clustering', detail: `${topSetup.label} is carrying the biggest stack. Make sure the desk is not just replaying one weather pattern.`, tone: 'warn' });
    }

    const nextSteps: CommandAction[] = tracked.length
      ? [
          topLocation
            ? { title: 'Check city concentration', detail: `${topLocation.label} is the biggest exposure pocket at ${topLocation.units} units across ${topLocation.markets} markets.`, tone: topLocation.units / Math.max(grossUnits, 1) >= 0.5 ? 'warn' : 'muted' }
            : { title: 'City balance looks clean', detail: 'No single location dominates the desk yet.', tone: 'good' },
          Math.abs(netBiasUnits) >= Math.max(3, grossUnits * 0.35)
            ? { title: `Bias hedge needed`, detail: `Net ${netBiasUnits > 0 ? 'long YES' : 'long NO'} by ${Math.abs(netBiasUnits)} units. Prefer the opposite side on the next valid setup.`, tone: 'warn' }
            : { title: 'Bias is balanced', detail: 'YES and NO exposure are reasonably paired right now.', tone: 'good' },
          queued.length > active.length
            ? { title: 'Promote or prune the queue', detail: `${queued.length} queued versus ${active.length} active. Clean up stale staged orders so the queue stays actionable.`, tone: 'warn' }
            : { title: 'Active book is leading', detail: `${active.length} active positions are being supported by a manageable queue.`, tone: 'good' },
        ]
      : [];

    return {
      tracked,
      grossUnits,
      activeUnits: sumUnits(active),
      queuedUnits: sumUnits(queued),
      yesUnits,
      noUnits,
      netBiasUnits,
      byLocation,
      bySetup,
      byDirection,
      alerts: alerts.slice(0, 4),
      nextSteps,
    };
  }, [displayMarkets, paperOrders, paperPlans, paperState]);
  const afterActionReviews = useMemo(() => Object.values(paperBlotter)
    .slice()
    .sort((left, right) => new Date(right.closedAt ?? right.lastMarkedAt ?? 0).getTime() - new Date(left.closedAt ?? left.lastMarkedAt ?? 0).getTime())
    .map((entry) => buildPaperAfterActionReview(entry)), [paperBlotter]);
  const selectedAfterActionReview = useMemo(() => {
    if (!afterActionReviews.length) return null;
    return afterActionReviews.find((entry) => entry.marketId === selectedReviewMarketId) ?? afterActionReviews[0];
  }, [afterActionReviews, selectedReviewMarketId]);

  useEffect(() => {
    if (!afterActionReviews.length) {
      if (selectedReviewMarketId) setSelectedReviewMarketId('');
      return;
    }
    if (!selectedReviewMarketId || !afterActionReviews.some((entry) => entry.marketId === selectedReviewMarketId)) {
      setSelectedReviewMarketId(afterActionReviews[0].marketId);
    }
  }, [afterActionReviews, selectedReviewMarketId]);

  useEffect(() => {
    setPaperBlotter(syncPaperBlotter(displayMarkets, paperState, paperPlans, paperExecutionProfile));
    setPaperOrders(syncPaperOrders(displayMarkets).orders);
  }, [displayMarkets, paperExecutionProfile, paperPlans, paperState]);

  useEffect(() => {
    const filledOrderMarketIds = Object.entries(paperOrders)
      .filter(([, orders]) => orders.some((order) => order.filledQuantity > 0 && order.status !== 'cancelled'))
      .map(([marketId]) => marketId);

    if (!filledOrderMarketIds.length) return;

    setPaperState((current) => {
      let changed = false;
      const next = { ...current };

      for (const marketId of filledOrderMarketIds) {
        const existing = current[marketId];
        if (existing?.state === 'active' || existing?.state === 'closed') continue;
        changed = true;
        next[marketId] = {
          state: 'active',
          updatedAt: new Date().toISOString(),
          note: 'Auto-promoted to active after a local paper fill so exit tracking and review stay attached to the execution path.',
        };
      }

      return changed ? next : current;
    });
  }, [paperOrders]);

  const rankedMarkets = useMemo(() => {
    return displayMarkets
      .map((market) => {
        const plan = paperPlans[market.id];
        const delta = marketDeltas[market.id];
        const actionability = plan.decision === 'would-trade' ? 3 : plan.decision === 'watch' ? 2 : 1;
        const freshnessPenalty = market.freshnessMinutes >= 120 ? 0.18 : market.freshnessMinutes >= 60 ? 0.08 : 0;
        const executionPenalty = market.quoteStatus === 'empty' ? 0.25 : market.quoteStatus === 'stale' ? 0.16 : market.quoteStatus === 'wide' ? 0.08 : 0;
        const scenarioPenalty = market.dataOrigin === 'curated-watchlist' ? 0.12 : 0;
        const priorityScore = Math.abs(market.edge) * 2.4 + market.confidence + actionability * 0.2 - freshnessPenalty - executionPenalty - scenarioPenalty;
        return { market, plan, delta, priorityScore };
      })
      .sort((left, right) => right.priorityScore - left.priorityScore);
  }, [displayMarkets, marketDeltas, paperPlans]);

  const liveTradeCount = displayMarkets.filter((market) => market.dataOrigin !== 'curated-watchlist' && paperPlans[market.id]?.decision === 'would-trade').length;
  const watchCount = displayMarkets.filter((market) => market.dataOrigin === 'curated-watchlist' || paperPlans[market.id]?.decision === 'watch').length;
  const topTrade = rankedMarkets[0]?.market;
  const paperQueueCount = Object.values(paperState).filter((item) => item.state === 'queued' || item.state === 'active').length;
  const performanceHeadline = paperPerformance.totals.closed
    ? `${paperPerformance.totals.wins}-${paperPerformance.totals.losses}${paperPerformance.totals.flats ? `-${paperPerformance.totals.flats}` : ''}`
    : 'No closes yet';
  const showingFallbackFirst = !liveGoodMatches.length;
  const scanState = error
    ? 'Scanner offline, showing cached state until feeds recover.'
    : loading && !meta
      ? 'Scanning Polymarket and weather feeds for the first ranked trade list.'
      : refreshing
        ? 'Refreshing market odds and model odds now.'
        : showingFallbackFirst || meta?.usedCuratedFallback
          ? 'No strong live contract made the board, so command is leading with clearly labeled watchlist scenarios until a better live listing appears.'
          : 'Live scan online. Market odds are being compared against current weather-model odds.';

  const toggleWatch = (marketId: string) => {
    setWatchIds((current) => current.includes(marketId) ? current.filter((id) => id !== marketId) : [...current, marketId]);
  };

  const togglePaperBotEnabled = () => {
    setPaperBotState((current) => createPaperBotLoopState({
      ...current,
      enabled: !current.enabled,
      autoStopped: false,
      status: !current.enabled ? 'idle' : 'blocked',
      nextDueAt: !current.enabled ? new Date(Date.now() + current.cadenceMs).toISOString() : null,
      haltReason: null,
      safeModeReason: null,
      autoStoppedAt: null,
      safeModeSince: null,
      lastSummary: !current.enabled ? 'Paper bot resumed from the operator console.' : 'Paper bot paused from the operator console.',
    }));
  };


  const togglePaperBotSafeMode = () => {
    setPaperBotState((current) => createPaperBotLoopState({
      ...current,
      operatorSafeMode: !current.operatorSafeMode,
      haltReason: !current.operatorSafeMode ? 'operator-safe-mode' : current.haltReason === 'operator-safe-mode' ? null : current.haltReason,
      safeModeReason: !current.operatorSafeMode ? 'Operator safe mode is active from the command center.' : null,
      safeModeSince: !current.operatorSafeMode ? new Date().toISOString() : null,
      lastSummary: !current.operatorSafeMode
        ? 'Operator safe mode enabled. Fresh paper risk is paused.'
        : 'Operator safe mode cleared. Fresh paper risk can resume when other gates allow.',
    }));
  };

  const toggleSkipLowConfidence = () => {
    setPaperBotState((current) => createPaperBotLoopState({
      ...current,
      skipLowConfidence: !current.skipLowConfidence,
      lastSummary: !current.skipLowConfidence
        ? `Low-confidence setups will now be skipped below ${pct(current.minimumConfidence)} confidence.`
        : 'Low-confidence skip filter disabled. The bot will rely on the remaining guardrails.',
    }));
  };

  const cycleConfidenceFloor = () => {
    setPaperBotState((current) => {
      const options = [0.58, 0.62, 0.66, 0.7];
      const currentIndex = options.findIndex((value) => Math.abs(value - current.minimumConfidence) < 0.001);
      const minimumConfidence = options[(currentIndex + 1) % options.length] ?? options[0];

      return createPaperBotLoopState({
        ...current,
        minimumConfidence,
        skipLowConfidence: true,
        lastSummary: `Confidence floor set to ${pct(minimumConfidence)} for fresh paper setups.`,
      });
    });
  };

  const updateRiskGovernorSetting = <K extends keyof PaperBotLoopState['riskGovernor']>(key: K, value: PaperBotLoopState['riskGovernor'][K]) => {
    setPaperBotState((current) => createPaperBotLoopState({
      ...current,
      riskGovernor: {
        ...current.riskGovernor,
        [key]: value,
      },
      autoStopped: false,
      haltReason: null,
      safeModeReason: null,
      autoStoppedAt: null,
      safeModeSince: null,
      lastSummary: 'Risk governor thresholds updated from the operator console.',
    }));
  };

  const cyclePaperBotCadence = () => {
    setPaperBotState((current) => {
      const options = [60_000, 180_000, 300_000];
      const currentIndex = options.indexOf(current.cadenceMs);
      const nextCadenceMs = options[(currentIndex + 1) % options.length] ?? options[0];
      return createPaperBotLoopState({
        ...current,
        cadenceMs: nextCadenceMs,
        nextDueAt: current.enabled ? new Date(Date.now() + nextCadenceMs).toISOString() : null,
        lastSummary: `Paper bot cadence set to ${getPaperBotCadenceLabel(nextCadenceMs)}.`,
      });
    });
  };

  const setMarketPaperState = (marketId: string, state: PaperPositionState) => {
    setPaperState((current) => ({
      ...current,
      [marketId]: {
        state,
        updatedAt: new Date().toISOString(),
        note: state === 'flat' ? 'Reset to flat paper state.' : state === 'queued' ? 'Queued for paper entry review.' : state === 'active' ? 'Paper position marked active.' : 'Paper position closed locally.',
      },
    }));
  };

  const updateGlobalPaperSetting = <K extends keyof PaperExecutionSettings>(key: K, value: PaperExecutionSettings[K]) => {
    setPaperExecutionProfile((current) => ({
      ...current,
      global: sanitizePaperExecutionSettings({ ...current.global, [key]: value }),
    }));
  };

  const handleRepricePaperBlotter = () => {
    const result = repricePaperBlotter(displayMarkets, paperState, paperPlans, paperExecutionProfile);
    setPaperBlotter(result.blotter);
    setPaperRepriceMeta({ at: result.repricedAt, changedCount: result.changedCount });
  };

  const updateOrderDraft = (marketId: string, patch: Partial<{ quantity: number; limitPrice: number; note: string }>) => {
    setPaperOrderDrafts((current) => {
      const base = current[marketId] ?? { quantity: 1, limitPrice: 0.5, note: '' };
      return { ...current, [marketId]: { ...base, ...patch } };
    });
  };

  const handlePlacePaperOrder = () => {
    if (!selectedMarket || !selectedPlan || selectedPlan.direction === 'stand-aside' || selectedMarket.dataOrigin === 'curated-watchlist' || !selectedOrderDraft) return;
    if (paperRiskGovernor.halted || paperRiskGovernor.safeMode) return;
    const result = placePaperOrder(selectedMarket, selectedPlan, selectedOrderDraft.quantity, selectedOrderDraft.limitPrice, selectedOrderDraft.note);
    setPaperOrders(result.orders);
    setPaperState((current) => ({
      ...current,
      [selectedMarket.id]: {
        state: 'queued',
        updatedAt: new Date().toISOString(),
        note: `Working ${selectedPlan.direction === 'buy-yes' ? 'YES' : 'NO'} order staged at ${pct(selectedOrderDraft.limitPrice)} for ${selectedOrderDraft.quantity} units.`,
      },
    }));
  };

  const handleCancelPaperOrder = (orderId: string) => {
    if (!selectedMarket) return;
    setPaperOrders(cancelPaperOrder(selectedMarket.id, orderId));
  };

  const promoteSelectedMarketToActive = () => {
    if (!selectedMarket) return;
    setPaperState((current) => ({
      ...current,
      [selectedMarket.id]: {
        state: 'active',
        updatedAt: new Date().toISOString(),
        note: 'Promoted to active after a working paper order filled locally.',
      },
    }));
  };

  const closeSelectedMarketForReview = () => {
    if (!selectedMarket) return;
    const closeReason = selectedBlotter?.exitSuggestion.shouldClose
      ? `Exit trigger: ${selectedBlotter.exitSuggestion.summary}`
      : 'Closed manually for review.';
    const fillContext = selectedLatestFilledOrder
      ? ` Last average fill was ${pct(selectedLatestFilledOrder.fillPrice ?? selectedLatestFilledOrder.limitPrice)} on ${selectedLatestFilledOrder.filledQuantity}/${selectedLatestFilledOrder.quantity} units.`
      : '';

    setPaperState((current) => ({
      ...current,
      [selectedMarket.id]: {
        state: 'closed',
        updatedAt: new Date().toISOString(),
        note: `${closeReason}${fillContext}`,
      },
    }));
    setSelectedReviewMarketId(selectedMarket.id);
  };

  const selectedPlan = selectedMarket ? paperPlans[selectedMarket.id] : null;
  const selectedDelta = selectedMarket ? marketDeltas[selectedMarket.id] : null;
  const priorityQueue = rankedMarkets.slice(0, 5);
  const opportunityBoard = rankedMarkets.filter(({ plan, market }) => plan.decision !== 'no-trade' || market.dataOrigin === 'curated-watchlist').slice(0, 4);
  const threatBoard = rankedMarkets
    .filter(({ delta, market }) => delta.alerts.some((alert) => alert.tone === 'bad' || alert.tone === 'warn') || market.quoteStatus === 'stale' || market.freshnessMinutes >= 90)
    .slice(0, 4);
  const selectedBlotter = selectedMarket ? paperBlotter[selectedMarket.id] : null;
  const selectedPaperState = selectedMarket ? paperState[selectedMarket.id] : null;
  const selectedOrders = selectedMarket ? (paperOrders[selectedMarket.id] ?? []) : [];
  const selectedWorkingOrders = selectedOrders.filter((order) => order.status === 'working' || order.status === 'partial');
  const selectedFilledOrders = selectedOrders.filter((order) => order.filledQuantity > 0);
  const selectedLatestFilledOrder = selectedFilledOrders[0] ?? null;
  const selectedExitReady = Boolean(selectedBlotter?.exitSuggestion.shouldClose);
  const operatorInterventions = useMemo(() => {
    const actions: CommandAction[] = [];
    const deskAlerts: DeskAlert[] = [];

    if (!paperBotState.enabled) {
      actions.push({
        title: 'Automation is paused',
        detail: 'No scheduler or UI tick will progress queued positions until the bot is re-enabled.',
        tone: 'warn',
        actionLabel: 'Enable bot',
        onAction: togglePaperBotEnabled,
      });
    }

    if (paperBotSupervision.healthTone === 'bad') {
      actions.push({
        title: 'Bot supervision needs intervention',
        detail: paperBotSupervision.detail,
        tone: 'bad',
        actionLabel: 'Run bot now',
        onAction: runPaperBotNow,
      });
    }

    if (paperAccount.availableCash < 0) {
      actions.push({
        title: 'Buying power is over-allocated',
        detail: `${formatUsd(Math.abs(paperAccount.availableCash))} more is reserved than currently free. Trim working paper orders before adding new risk.`,
        tone: 'bad',
      });
    }

    if (paperRiskGovernor.halted || paperRiskGovernor.safeMode) {
      actions.push({
        title: paperRiskGovernor.halted ? 'Risk governor is halting new risk' : 'Risk governor entered safe mode',
        detail: paperRiskGovernor.detail,
        tone: paperRiskGovernor.halted ? 'bad' : 'warn',
      });
    }

    if (latestBotAudit?.staleMarketCount && latestBotAudit.staleMarketCount >= Math.max(2, Math.ceil(displayMarkets.length / 2))) {
      actions.push({
        title: 'Refresh stale board inputs',
        detail: `${latestBotAudit.staleMarketCount} markets were stale on the latest bot audit, so current automation decisions deserve caution.`,
        tone: 'warn',
        actionLabel: 'Refresh board',
        onAction: () => void fetchMarkets(true),
      });
    }

    openBlotterEntries
      .filter((entry) => entry.exitSuggestion.shouldClose)
      .slice(0, 2)
      .forEach((entry) => {
        actions.push({
          title: `Exit ready: ${entry.marketTitle}`,
          detail: entry.exitSuggestion.summary,
          tone: 'bad',
          actionLabel: 'Open market',
          onAction: () => setSelectedId(entry.marketId),
        });
      });

    threatBoard.slice(0, 3).forEach(({ market, delta }) => {
      deskAlerts.push({
        title: market.title,
        detail: delta.alerts[0]?.detail ?? `Quote state ${market.quoteStatus.toUpperCase()} and freshness ${freshnessLabel(market.freshnessMinutes)} need attention.`,
        tone: delta.alerts.some((alert) => alert.tone === 'bad') || market.quoteStatus === 'empty' ? 'bad' : 'warn',
        marketId: market.id,
      });
    });

    exposureSummary.alerts.slice(0, 2).forEach((alert) => deskAlerts.push(alert));

    return {
      actions: actions.slice(0, 5),
      alerts: deskAlerts.slice(0, 5),
      urgentCount: actions.filter((item) => item.tone === 'bad').length + deskAlerts.filter((item) => item.tone === 'bad').length,
    };
  }, [displayMarkets.length, exposureSummary.alerts, fetchMarkets, latestBotAudit?.staleMarketCount, openBlotterEntries, paperAccount.availableCash, paperBotState.enabled, paperBotSupervision.detail, paperBotSupervision.healthTone, paperRiskGovernor.detail, paperRiskGovernor.halted, paperRiskGovernor.safeMode, runPaperBotNow, threatBoard, togglePaperBotEnabled]);
  const selectedActionQueue: CommandAction[] = selectedMarket && selectedPlan
    ? [
        selectedMarket.dataOrigin === 'curated-watchlist'
          ? {
              title: 'Wait for listing',
              detail: 'Keep this in scouting mode until a real contract appears with matching settlement wording.',
              tone: 'warn',
            }
          : selectedPlan.decision === 'would-trade'
            ? {
                title: `Stage ${paperDirectionLabel(selectedPlan.direction)}`,
                detail: `Actionable now if execution holds. Target ${selectedPlan.sizing.suggestedUnits} units and only work orders while the edge stays above the entry bar.`,
                tone: 'good',
              }
            : {
                title: 'Hold fire',
                detail: 'Do not stage size yet. Let edge, confidence, and execution line up together first.',
                tone: 'muted',
              },
        selectedWorkingOrders.length
          ? {
              title: 'Manage working risk',
              detail: `${selectedWorkingOrders.length} order${selectedWorkingOrders.length > 1 ? 's are' : ' is'} already working. Reprice only if the quote shifts or the thesis improves.`,
              tone: 'warn',
            }
          : {
              title: 'No working order',
              detail: 'Nothing is staged in the book yet, so the next action lives in the order ticket below.',
              tone: 'muted',
            },
        selectedExitReady
          ? {
              title: 'Exit check triggered',
              detail: selectedBlotter?.exitSuggestion.summary ?? 'The blotter wants attention now.',
              tone: 'bad',
            }
          : {
              title: 'Monitor exit tripwires',
              detail: selectedPlan.stopTrigger,
              tone: selectedPaperState?.state === 'active' ? 'warn' : 'muted',
            },
      ]
    : [];
  const selectedOrderDraft = selectedMarket && selectedPlan
    ? (paperOrderDrafts[selectedMarket.id] ?? { quantity: selectedPlan.sizing.suggestedUnits, limitPrice: clampOrderPrice(selectedMarket.impliedProbability), note: '' })
    : null;
  const workflowStages: WorkflowStage[] = selectedMarket && selectedPlan
    ? [
        {
          key: 'stage',
          label: 'Stage',
          status: selectedOrderDraft ? `${selectedOrderDraft.quantity}u @ ${pct(selectedOrderDraft.limitPrice)}` : 'Draft empty',
          detail: selectedPlan.direction === 'stand-aside'
            ? 'No executable edge right now, so keep this in monitor mode.'
            : selectedMarket.dataOrigin === 'curated-watchlist'
              ? 'Scenario only. Wait for a real contract before staging anything.'
              : `Bias ${paperDirectionLabel(selectedPlan.direction)} with ${selectedPlan.sizing.notionalLabel}.`,
          tone: selectedPlan.direction === 'stand-aside' || selectedMarket.dataOrigin === 'curated-watchlist' ? 'muted' : 'good',
        },
        {
          key: 'working',
          label: 'Working',
          status: selectedWorkingOrders.length ? `${selectedWorkingOrders.length} live in book` : 'Nothing working',
          detail: selectedWorkingOrders.length
            ? `Best working ticket is ${selectedWorkingOrders[0].direction === 'buy-yes' ? 'BUY YES' : 'BUY NO'} ${selectedWorkingOrders[0].filledQuantity}/${selectedWorkingOrders[0].quantity}u filled at ${pct(selectedWorkingOrders[0].limitPrice)}.`
            : 'Stage a paper order to track queue priority, partial fills, and local fill realism.',
          tone: selectedWorkingOrders.length ? 'warn' : 'muted',
        },
        {
          key: 'fill',
          label: 'Fill handoff',
          status: selectedLatestFilledOrder ? `Filled ${selectedLatestFilledOrder.filledQuantity}/${selectedLatestFilledOrder.quantity}u @ ${pct(selectedLatestFilledOrder.fillPrice ?? selectedLatestFilledOrder.limitPrice)}` : selectedPaperState?.state === 'active' ? 'Position active' : 'No fill yet',
          detail: selectedPaperState?.state === 'active'
            ? selectedPaperState.note
            : selectedLatestFilledOrder
              ? 'Local fill detected. Promote this into the active lane so exits, blotter marks, and later review all stay linked.'
              : 'Once a staged order fills, move it into the active lane.',
          tone: selectedPaperState?.state === 'active' ? 'good' : selectedLatestFilledOrder ? 'warn' : 'muted',
          actionLabel: selectedLatestFilledOrder && selectedPaperState?.state !== 'active' ? 'Mark active' : undefined,
          onAction: selectedLatestFilledOrder && selectedPaperState?.state !== 'active' ? promoteSelectedMarketToActive : undefined,
        },
        {
          key: 'exit',
          label: 'Exit watch',
          status: selectedBlotter?.exitSuggestion.reason === 'take-profit' ? 'Take profit' : selectedBlotter?.exitSuggestion.reason === 'stop-loss' ? 'Exit now' : selectedPaperState?.state === 'active' ? 'Monitor' : 'Not active',
          detail: selectedBlotter?.exitSuggestion.summary ?? 'No active blotter entry yet.',
          tone: selectedExitReady ? 'bad' : selectedPaperState?.state === 'active' ? 'good' : 'muted',
          actionLabel: selectedPaperState?.state === 'active' ? 'Close to review' : undefined,
          onAction: selectedPaperState?.state === 'active' ? closeSelectedMarketForReview : undefined,
        },
        {
          key: 'review',
          label: 'Review',
          status: selectedPaperState?.state === 'closed' ? 'Ready to score' : 'Pending close',
          detail: selectedPaperState?.state === 'closed'
            ? 'This trade is now in the after-action queue below with its timeline and lessons.'
            : 'Closed trades roll into the after-action queue for process review.',
          tone: selectedPaperState?.state === 'closed' ? 'good' : 'muted',
        },
      ]
    : [];

  return (
    <div className="command-app-shell">
      <div className="grid-haze grid-haze-left" />
      <div className="grid-haze grid-haze-right" />
      <div className="crt-noise" />
      <main className="command-deck">
        <section className="panel mission-hero" data-panel="sys.hero">
          <div className="hero-callout">
            <div className="eyebrow-row">
              <p className="eyebrow">WX-2060 strategic command deck // operator terminal</p>
              <span className={`status-pill ${error ? 'tone-bad' : showingFallbackFirst || meta?.usedCuratedFallback ? 'tone-warn' : 'tone-good'}`}>{error ? 'Feed degraded' : showingFallbackFirst || meta?.usedCuratedFallback ? 'Scenario-first mode' : 'Live tactical mode'}</span>
            </div>
            <h1>Run the weather desk like a live terminal, not a stack of cards.</h1>
            <p className="hero-copy subtle">This console scans live weather contracts, compares exchange pricing against weather models, and keeps bot state, account posture, tape movement, and paper execution in one dense operating surface.</p>
            <div className="hero-ribbon">
              <span className="badge soft">scan@{formatClock(lastScanAt || meta?.refreshedAt)}</span>
              <span className="badge soft">{meta ? `${meta.livePolymarketWeatherCount} live contracts on scope` : 'Building scope'}</span>
              <span className="badge soft">feeds {meta?.weatherSourceMix.join(' · ') ?? 'Live feeds'}</span>
              <span className="badge soft">{getTradingRuntimeLabel(TRADING_RUNTIME)} · live locked</span>
            </div>
            <p className="hero-status subtle">{scanState}</p>
          </div>
          <div className="hero-rail">
            <Metric label="Strike-ready setups" value={String(liveTradeCount).padStart(2, '0')} positive={liveTradeCount > 0} />
            <Metric label="Scenario watchpoints" value={String(watchCount).padStart(2, '0')} positive={watchCount > 0} />
            <Metric label="Lead edge" value={topTrade ? signedPct(topTrade.edge) : '--'} positive={(topTrade?.edge ?? 0) >= 0} />
            <Metric label="Open paper missions" value={String(paperQueueCount).padStart(2, '0')} positive={paperQueueCount > 0} />
          </div>
        </section>

        {error && <section className="panel system-banner tone-bad" data-panel="sys.alert"><strong>System advisory</strong><span>{error}</span></section>}

        <section className={`panel auth-command-strip ${ledgerOwner ? 'auth-live' : persistenceStatus.mode === 'local' ? 'auth-local' : 'auth-pending'}`} data-panel="auth.command">
          <div className="panel-header auth-command-header">
            <div>
              <p className="eyebrow">Auth command</p>
              <h2>{ledgerOwner ? 'Google owner attached to command' : 'Sign in with Google to attach this desk'}</h2>
              <p className="subtle panel-intro">{authModeDetail}</p>
            </div>
            <div className="table-actions auth-command-actions">
              <span className={`status-pill ${ledgerOwner ? 'tone-good' : 'tone-warn'}`}>{authModeLabel}</span>
              <span className={`badge soft ${firebaseEnvStatus.ready ? '' : 'tone-bad'}`}>{firebaseEnvStatus.ready ? `Firebase ${getFirebaseProjectId() ?? '--'}` : 'Firebase env incomplete'}</span>
              {ledgerOwner ? (
                <button className="command-button" onClick={() => void handleSignOut()} disabled={authBusy}>
                  {authBusy ? 'Working…' : 'Sign out'}
                </button>
              ) : (
                <button className="command-button auth-primary-button auth-command-primary" onClick={() => void handleSignIn()} disabled={authBusy || !authReady || !firebaseEnvStatus.ready}>
                  {authBusy ? 'Connecting…' : 'Sign in with Google'}
                </button>
              )}
            </div>
          </div>
          <div className="auth-command-grid">
            <div className="auth-command-card auth-command-primary-card">
              <span className="detail-label">Mode</span>
              <strong>{ledgerOwner ? 'SIGNED-IN OWNER MODE' : 'LOCAL-ONLY BROWSER MODE'}</strong>
              <p>{ledgerOwner
                ? `This browser is writing to ${appLedgerScope?.documentPath ?? `${ledgerOwner.uid}__${DEFAULT_PAPER_LEDGER_ID}`}.`
                : 'Nothing is tied to a Google owner yet. Until you sign in, this device keeps the paper ledger locally in this browser only.'}</p>
            </div>
            <div className="auth-command-card">
              <span className="detail-label">Owner</span>
              <strong>{ledgerOwner?.displayName ?? ledgerOwner?.email ?? 'Not signed in'}</strong>
              <p>{ledgerOwner?.email ?? (firebaseEnvStatus.ready ? 'Use the big Google button to attach an owner account.' : 'Add VITE_FIREBASE_* env first, then sign in with Google.')}</p>
            </div>
            <div className="auth-command-card auth-uid-card">
              <span className="detail-label">Owner UID</span>
              <strong>{ledgerOwner?.uid ?? 'Awaiting Google sign-in'}</strong>
              <p>{ledgerOwner ? `Ledger document ${appLedgerScope?.documentId ?? '--'}` : 'UID shows here immediately after sign-in so the owner path is explicit.'}</p>
              {ledgerOwner && (
                <div className="table-actions">
                  <button className="command-button" onClick={() => void copyToClipboard(ledgerOwner.uid)}>
                    Copy UID
                  </button>
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="panel account-command-panel" data-panel="acct.summary">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Paper account command</p>
              <h2>Simulated equity and bot-managed capital</h2>
              <p className="subtle panel-intro">This is the paper stack the desk is managing, shown as a simple account view instead of scattered blotter fragments. Starting capital is {formatUsd(paperAccount.startingCash)} and updates come from the same blotter, orders, and bot runtime already driving the desk.</p>
            </div>
            <div className="table-actions">
              <span className={`status-pill ${paperAccount.automationStatus === 'active' ? 'tone-good' : 'tone-warn'}`}>{paperAccount.automationStatus === 'active' ? 'Bot managing capital' : 'Bot paused'}</span>
              <span className="badge soft">{paperAccount.botManagedMarkets} bot-managed lanes</span>
            </div>
          </div>

          <div className="execution-summary-grid review-metrics paper-account-grid">
            <ExecutionSummaryCard label="Account value" value={formatUsd(paperAccount.accountValue)} detail={`${formatUsd(paperAccount.startingCash)} start · ${paperAccount.totalPnl >= 0 ? '+' : '-'}${formatUsd(Math.abs(paperAccount.totalPnl))} total PnL`} toneClass={paperAccount.totalPnl >= 0 ? 'positive' : 'negative'} />
            <ExecutionSummaryCard label="Cash" value={formatUsd(paperAccount.cash)} detail={`${formatUsd(paperAccount.availableCash)} available after ${formatUsd(paperAccount.reservedCash)} working capital reserve`} toneClass={paperAccount.cash >= 0 ? 'positive' : 'negative'} />
            <ExecutionSummaryCard label="Exposure" value={formatUsd(paperAccount.exposure)} detail={`${paperAccount.grossFilledUnits} filled units across ${paperAccount.activeMarkets} active campaigns`} />
            <ExecutionSummaryCard label="Open PnL" value={`${paperAccount.openPnl >= 0 ? '+' : '-'}${formatUsd(Math.abs(paperAccount.openPnl))}`} detail={`${paperAccount.activeMarkets} active · ${paperAccount.queuedMarkets} queued`} toneClass={paperAccount.openPnl >= 0 ? 'positive' : 'negative'} />
            <ExecutionSummaryCard label="Realized PnL" value={`${paperAccount.realizedPnl >= 0 ? '+' : '-'}${formatUsd(Math.abs(paperAccount.realizedPnl))}`} detail={paperAccount.closedMarkets ? `${paperAccount.closedMarkets} closed campaigns booked.` : 'No realized closes booked yet.'} toneClass={paperAccount.realizedPnl >= 0 ? 'positive' : 'negative'} />
            <ExecutionSummaryCard label="Bot-managed capital" value={formatUsd(paperAccount.botManagedCapital)} detail={`${Math.round(paperAccount.botManagedPct * 100)}% of paper equity is currently under automation control.`} toneClass={paperAccount.automationStatus === 'active' ? 'positive' : undefined} />
          </div>

          <div className="review-diagnostics-grid">
            <div className="intel-card">
              <div className="subpanel-header">
                <div>
                  <span className="detail-label">Capital posture</span>
                  <p className="subtle">A fast read on where the simulated account stands right now.</p>
                </div>
              </div>
              <div className="stack-list compact-review-list">
                <div className="stack-row review-row">
                  <div>
                    <div className="source-title-row">
                      <strong>{paperAccount.availableCash >= 0 ? 'Buying power is intact' : 'Buying power is over-allocated'}</strong>
                      <span className={`status-pill tone-${paperAccount.availableCash >= 0 ? 'good' : 'bad'}`}>{formatUsd(paperAccount.availableCash)} free</span>
                    </div>
                    <p>{paperAccount.availableCash >= 0 ? `The paper desk still has ${formatUsd(paperAccount.availableCash)} free after reserving staged orders.` : `Working orders are reserving more than current free cash. Trim tickets before adding risk.`}</p>
                  </div>
                </div>
                <div className="stack-row review-row">
                  <div>
                    <div className="source-title-row">
                      <strong>Deployed versus reserved</strong>
                      <span className="status-pill tone-muted">{formatUsd(paperAccount.deployedCash)} committed</span>
                    </div>
                    <p>{formatUsd(paperAccount.exposure)} is marked in live exposure and {formatUsd(paperAccount.reservedCash)} is still parked in working orders.</p>
                  </div>
                </div>
                <div className="stack-row review-row">
                  <div>
                    <div className="source-title-row">
                      <strong>Automation framing</strong>
                      <span className={`status-pill ${paperAccount.automationStatus === 'active' ? 'tone-good' : 'tone-warn'}`}>{paperAccount.automationStatus === 'active' ? 'Managed' : 'Manual only'}</span>
                    </div>
                    <p>{paperAccount.automationStatus === 'active' ? `The bot is actively shepherding ${paperAccount.botManagedMarkets} lanes and ${formatUsd(paperAccount.botManagedCapital)} of paper capital.` : 'The bot is paused, so the account is being tracked manually even though blotter and queue state remain intact.'}</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="intel-card">
              <div className="subpanel-header">
                <div>
                  <span className="detail-label">Largest capital lanes</span>
                  <p className="subtle">Where the paper account is actually tied up.</p>
                </div>
                <span className="badge soft">Top {Math.min(4, paperAccount.markets.length)}</span>
              </div>
              <div className="stack-list compact-review-list">
                {paperAccount.markets.slice(0, 4).length ? paperAccount.markets.slice(0, 4).map((market) => (
                  <div className="stack-row review-row" key={market.marketId}>
                    <div>
                      <div className="source-title-row">
                        <strong>{market.marketTitle}</strong>
                        <span className={`status-pill ${market.state === 'active' ? 'tone-good' : market.state === 'queued' ? 'tone-warn' : 'tone-muted'}`}>{market.state.toUpperCase()}</span>
                      </div>
                      <p>{formatUsd(market.markValue)} marked exposure · {formatUsd(market.reservedCash)} reserved · {market.filledUnits} filled units · {market.workingUnits} working units.</p>
                    </div>
                    <div className="source-metrics">
                      <small>Open {market.openPnl >= 0 ? '+' : '-'}{formatUsd(Math.abs(market.openPnl))}</small>
                      <small>Realized {market.realizedPnl >= 0 ? '+' : '-'}{formatUsd(Math.abs(market.realizedPnl))}</small>
                    </div>
                  </div>
                )) : <p className="subtle">No paper capital is deployed yet.</p>}
              </div>
            </div>
          </div>
        </section>

        <section className={`panel system-banner ${persistenceStatus.mode === 'firestore' ? 'tone-good' : 'tone-warn'}`}>
          <strong>{persistenceStatus.mode === 'firestore' ? 'Firestore attached' : 'Local-only mode'}</strong>
          <span>{persistenceStatus.detail}</span>
          <div className="identity-status-grid">
            <div className="identity-status-card">
              <span className="detail-label">Storage mode</span>
              <strong>{persistenceStatus.mode === 'firestore' ? 'Firestore sync on' : 'Browser only'}</strong>
              <p>{persistenceStatus.mode === 'firestore' ? `Project ${getFirebaseProjectId() ?? '--'} · ledger ${DEFAULT_PAPER_LEDGER_ID}` : 'This browser is the source of truth until Google sign-in finishes.'}</p>
            </div>
            <div className="identity-status-card">
              <span className="detail-label">Owner</span>
              <strong>{ledgerOwner?.displayName ?? ledgerOwner?.email ?? 'Not signed in'}</strong>
              <p>{ledgerOwner ? `UID ${ledgerOwner.uid}` : authReady ? 'Use the Google button below to bind this ledger to your owner account.' : 'Checking Firebase Auth session...'}</p>
            </div>
          </div>
        </section>
        {isFirestorePersistenceEnabled() && (
          <section className={`panel system-banner ${appLedgerScope && backendLedgerScope ? (ownerScopeAligned ? 'tone-good' : 'tone-warn') : 'tone-muted'}`}>
            <strong>{appLedgerScope && backendLedgerScope ? (ownerScopeAligned ? 'Ledger target aligned' : 'Ledger target mismatch') : 'Ledger target visibility'}</strong>
            <span>
              App path {appLedgerScope?.documentPath ?? 'sign in to resolve owner-scoped app path'}.
              {backendLedgerScope
                ? ` Backend runner path ${backendLedgerScope.documentPath}.`
                : ' Backend runner has not reported a target path yet.'}
            </span>
            {appLedgerScope ? (
              <div className="stack-list compact-review-list">
                <div className="stack-row review-row">
                  <div>
                    <div className="source-title-row">
                      <strong>Backend env to set</strong>
                      <span className={`status-pill ${ownerScopeAligned ? 'tone-good' : 'tone-warn'}`}>WEATHER_MARKETS_RUNNER_ID</span>
                    </div>
                    <p><code>WEATHER_MARKETS_RUNNER_ID={appLedgerScope.ownerUid}</code></p>
                  </div>
                  <div className="source-metrics">
                    <small>{appLedgerScope.documentId}</small>
                    <small>functions/.env.example</small>
                  </div>
                </div>
              </div>
            ) : null}
          </section>
        )}
        {isFirestorePersistenceEnabled() && (
          <section className={`panel system-banner ${ledgerOwner ? 'tone-good' : 'tone-warn'}`}>
            <strong>{ledgerOwner ? 'Google owner connected' : 'One-click Google sign-in'}</strong>
            <span>
              {ledgerOwner
                ? `Signed in as ${ledgerOwner.displayName ?? ledgerOwner.email ?? ledgerOwner.uid}. This device is writing the owner-scoped ledger at ${appLedgerScope?.documentPath ?? `${ledgerOwner.uid}__${DEFAULT_PAPER_LEDGER_ID}`}.`
                : authReady
                  ? 'Tap once to attach this app to Firestore. Popup blocked or on mobile, it will automatically fall back to a full-page Google redirect.'
                  : 'Checking Firebase Auth session...'}
            </span>
            <div className="identity-status-grid">
              <div className="identity-status-card">
                <span className="detail-label">Email</span>
                <strong>{ledgerOwner?.email ?? 'Awaiting sign-in'}</strong>
                <p>{ledgerOwner?.displayName ?? 'Google account owner label will appear here after auth completes.'}</p>
              </div>
              <div className="identity-status-card">
                <span className="detail-label">UID</span>
                <strong>{compactUid(ledgerOwner?.uid)}</strong>
                <p>{ledgerOwner ? ledgerOwner.uid : 'UID appears here so the Firestore owner identity is unambiguous.'}</p>
              </div>
            </div>
            <div className="table-actions">
              {ledgerOwner ? (
                <button className="command-button" onClick={() => void handleSignOut()} disabled={authBusy}>
                  {authBusy ? 'Working…' : 'Sign out'}
                </button>
              ) : (
                <button className="command-button auth-primary-button" onClick={() => void handleSignIn()} disabled={authBusy || !authReady}>
                  {authBusy ? 'Connecting…' : 'Continue with Google'}
                </button>
              )}
            </div>
          </section>
        )}
        <section className="panel review-panel operator-command-panel" data-panel="ops.intervention">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Operator intervention center</p>
              <h2>What needs a human right now</h2>
              <p className="subtle panel-intro">This compresses the desk into immediate human decisions, so warnings, account stress, stale inputs, and exit-ready positions are not buried inside other panels.</p>
            </div>
            <div className="table-actions">
              <span className={`status-pill tone-${operatorInterventions.urgentCount ? 'bad' : operatorInterventions.actions.length ? 'warn' : 'good'}`}>{operatorInterventions.urgentCount ? `${operatorInterventions.urgentCount} urgent` : operatorInterventions.actions.length ? 'Watchlist active' : 'No human action needed'}</span>
              <span className="badge soft">{operatorInterventions.alerts.length} desk alerts</span>
            </div>
          </div>

          <div className="execution-summary-grid review-metrics intervention-summary-grid">
            <ExecutionSummaryCard label="Bot health" value={paperBotSupervision.healthLabel.toUpperCase()} detail={paperBotSupervision.detail} toneClass={paperBotSupervision.healthTone === 'bad' ? 'negative' : paperBotSupervision.healthTone === 'good' ? 'positive' : undefined} />
            <ExecutionSummaryCard label="Buying power" value={formatUsd(paperAccount.availableCash)} detail={`${formatUsd(paperAccount.reservedCash)} reserved in working orders.`} toneClass={paperAccount.availableCash >= 0 ? 'positive' : 'negative'} />
            <ExecutionSummaryCard label="Exit-ready positions" value={String(openBlotterEntries.filter((entry) => entry.exitSuggestion.shouldClose).length)} detail="Open paper campaigns already tripping exit logic." toneClass={openBlotterEntries.some((entry) => entry.exitSuggestion.shouldClose) ? 'negative' : 'positive'} />
            <ExecutionSummaryCard label="Stale inputs" value={String(displayMarkets.filter((market) => market.freshnessMinutes >= 90 || market.quoteStatus === 'stale' || market.quoteStatus === 'empty').length)} detail="Markets whose quotes or weather data are not fresh enough to trust blindly." toneClass={displayMarkets.some((market) => market.freshnessMinutes >= 90 || market.quoteStatus === 'stale' || market.quoteStatus === 'empty') ? 'negative' : 'positive'} />
          </div>

          <div className="review-diagnostics-grid operator-intervention-grid">
            <div className="intel-card">
              <div className="subpanel-header">
                <div>
                  <span className="detail-label">Immediate interventions</span>
                  <p className="subtle">Concrete next steps, with buttons when the desk can act from here.</p>
                </div>
                <span className="badge soft">{operatorInterventions.actions.length}</span>
              </div>
              <div className="stack-list compact-review-list">
                {operatorInterventions.actions.length ? operatorInterventions.actions.map((item) => (
                  <div className="stack-row review-row intervention-row" key={item.title}>
                    <div>
                      <div className="source-title-row">
                        <strong>{item.title}</strong>
                        <span className={`status-pill tone-${item.tone}`}>{item.tone === 'bad' ? 'Act now' : item.tone === 'warn' ? 'Watch' : item.tone === 'good' ? 'Healthy' : 'Stand by'}</span>
                      </div>
                      <p>{item.detail}</p>
                    </div>
                    {item.actionLabel && item.onAction && <button className="command-button" onClick={item.onAction}>{item.actionLabel}</button>}
                  </div>
                )) : <p className="subtle">No immediate intervention items. The desk is currently in supervision mode, not rescue mode.</p>}
              </div>
            </div>

            <div className="intel-card">
              <div className="subpanel-header">
                <div>
                  <span className="detail-label">Desk warnings</span>
                  <p className="subtle">The highest-friction warnings across health, risk, and tape quality.</p>
                </div>
                <span className="badge soft">{operatorInterventions.alerts.length}</span>
              </div>
              <div className="stack-list compact-review-list">
                {operatorInterventions.alerts.length ? operatorInterventions.alerts.map((alert) => (
                  <div className="stack-row review-row intervention-row" key={`${alert.title}-${alert.detail}`}>
                    <div>
                      <div className="source-title-row">
                        <strong>{alert.title}</strong>
                        <span className={`status-pill tone-${alert.tone}`}>{alert.tone === 'bad' ? 'Escalated' : alert.tone === 'warn' ? 'Warning' : alert.tone === 'good' ? 'Healthy' : 'Info'}</span>
                      </div>
                      <p>{alert.detail}</p>
                    </div>
                    {alert.marketId && <button className="command-button" onClick={() => setSelectedId(alert.marketId!)}>Inspect</button>}
                  </div>
                )) : <p className="subtle">No current desk-wide warnings beyond normal monitoring.</p>}
              </div>
            </div>
          </div>
        </section>

        <section className="panel review-panel portfolio-panel" data-panel="bot.supervision">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Bot control</p>
              <h2>Persistent paper operator</h2>
              <p className="subtle panel-intro">The paper bot is now wired into live app state, so queued and active decisions persist through refreshes and backend hydration. This panel now also surfaces supervision checks so an always-on runner is easier to trust.</p>
            </div>
            <div className="table-actions">
              <button className={`command-button ${paperBotState.enabled ? 'active' : ''}`} onClick={togglePaperBotEnabled}>{paperBotState.enabled ? 'Pause bot' : 'Resume bot'}</button>
              <button className="command-button" onClick={cyclePaperBotCadence}>Cadence {getPaperBotCadenceLabel(paperBotState.cadenceMs)}</button>
              <button className="command-button" onClick={runPaperBotNow} disabled={!markets.length}>Force tick</button>
            </div>
          </div>
          <div className="execution-summary-grid review-metrics">
            <ExecutionSummaryCard label="Status" value={paperBotState.autoStopped ? 'AUTO-STOPPED' : paperBotState.status.toUpperCase()} detail={paperBotState.lastSummary ?? 'No bot tick yet.'} toneClass={paperBotState.autoStopped ? 'negative' : paperBotState.enabled ? 'positive' : undefined} />
            <ExecutionSummaryCard label="Ticks" value={String(paperBotState.tickCount)} detail={`Cadence ${getPaperBotCadenceLabel(paperBotState.cadenceMs)}`} />
            <ExecutionSummaryCard label="Next due" value={paperBotState.nextDueAt ? formatClock(paperBotState.nextDueAt) : '--'} detail={paperBotState.nextDueAt ? formatDateTime(paperBotState.nextDueAt) : 'Bot is paused.'} />
            <ExecutionSummaryCard label="Risk posture" value={paperRiskGovernor.halted ? 'HALTED' : paperRiskGovernor.safeMode ? 'SAFE MODE' : 'OPEN'} detail={paperBotState.autoStoppedAt ? `Auto-stopped ${formatDateTime(paperBotState.autoStoppedAt)}` : paperBotState.safeModeSince ? `Safe mode since ${formatDateTime(paperBotState.safeModeSince)}` : paperRiskGovernor.detail} toneClass={paperRiskGovernor.halted ? 'negative' : paperRiskGovernor.safeMode ? undefined : 'positive'} />
            <ExecutionSummaryCard label="Latest audit" value={latestBotAudit ? formatClock(latestBotAudit.runAt) : '--'} detail={latestBotAudit ? `${latestBotAudit.actionCount} actions, ${latestBotAudit.staleMarketCount} stale inputs` : 'No durable run record yet.'} toneClass={latestBotAudit ? 'positive' : undefined} />
            <ExecutionSummaryCard label="Backend heartbeat" value={backendHeartbeatLabel} detail={paperBotBackend?.staleReason ?? 'No backend heartbeat recorded yet.'} toneClass={backendHealthTone} />
            <ExecutionSummaryCard label="Backend failures" value={backendFailureLabel} detail={paperBotBackend?.lastError ?? paperBotBackend?.lastRunSummary ?? 'No backend failure recorded.'} toneClass={paperBotBackend?.consecutiveFailures ? 'negative' : undefined} />
            <ExecutionSummaryCard label="Bot trust" value={paperValidationGate.botTrust.status.toUpperCase()} detail={paperValidationGate.botTrust.note} toneClass={paperValidationGate.botTrust.status === 'trusted' ? 'positive' : paperValidationGate.botTrust.status === 'restricted' ? 'negative' : undefined} />
            <ExecutionSummaryCard label="Automation gate" value={paperValidationGate.botTrust.automationAllowed ? 'OPEN' : 'BLOCKED'} detail={paperValidationGate.botTrust.automationAllowed ? 'Fresh queueing and activation are allowed.' : paperValidationGate.botTrust.blockers[0] ?? 'Fresh queueing and activation stay blocked.'} toneClass={paperValidationGate.botTrust.automationAllowed ? 'positive' : 'negative'} />
          </div>
          <div className="review-diagnostics-grid operator-intervention-grid">
            <div className="intel-card">
              <div className="subpanel-header">
                <div>
                  <span className="detail-label">Explicit operator controls</span>
                  <p className="subtle">Command-center overrides for pause, safe mode, manual ticks, and low-confidence filtering.</p>
                </div>
                <span className="badge soft">Paper ops</span>
              </div>
              <div className="stack-list compact-review-list">
                <div className="stack-row review-row intervention-row">
                  <div>
                    <div className="source-title-row">
                      <strong>Pause / resume automation</strong>
                      <span className={`status-pill ${paperBotState.enabled ? 'tone-good' : 'tone-warn'}`}>{paperBotState.enabled ? 'RUNNING' : 'PAUSED'}</span>
                    </div>
                    <p>Stops or resumes the paper bot without clearing queue state, blotter history, or backend audits.</p>
                  </div>
                  <button className="command-button" onClick={togglePaperBotEnabled}>{paperBotState.enabled ? 'Pause bot' : 'Resume bot'}</button>
                </div>
                <div className="stack-row review-row intervention-row">
                  <div>
                    <div className="source-title-row">
                      <strong>Safe mode override</strong>
                      <span className={`status-pill ${paperBotState.operatorSafeMode ? 'tone-warn' : 'tone-muted'}`}>{paperBotState.operatorSafeMode ? 'MANUAL SAFE MODE' : 'OPEN'}</span>
                    </div>
                    <p>Prevents fresh queueing and activation while still letting existing positions keep managing out.</p>
                  </div>
                  <button className={`command-button ${paperBotState.operatorSafeMode ? 'active' : ''}`} onClick={togglePaperBotSafeMode}>{paperBotState.operatorSafeMode ? 'Disable safe mode' : 'Enable safe mode'}</button>
                </div>
                <div className="stack-row review-row intervention-row">
                  <div>
                    <div className="source-title-row">
                      <strong>Skip low-confidence setups</strong>
                      <span className={`status-pill ${paperBotState.skipLowConfidence ? 'tone-good' : 'tone-muted'}`}>{paperBotState.skipLowConfidence ? `ON < ${pct(paperBotState.minimumConfidence)}` : 'OFF'}</span>
                    </div>
                    <p>Fresh paper risk is filtered when confidence falls under the operator floor.</p>
                  </div>
                  <div className="table-actions">
                    <button className={`command-button ${paperBotState.skipLowConfidence ? 'active' : ''}`} onClick={toggleSkipLowConfidence}>{paperBotState.skipLowConfidence ? 'Disable filter' : 'Enable filter'}</button>
                    <button className="command-button" onClick={cycleConfidenceFloor}>Floor {pct(paperBotState.minimumConfidence)}</button>
                  </div>
                </div>
                <div className="stack-row review-row intervention-row">
                  <div>
                    <div className="source-title-row">
                      <strong>Force one tick</strong>
                      <span className="status-pill tone-good">MANUAL</span>
                    </div>
                    <p>Runs the paper bot immediately against the current board instead of waiting for the next cadence window.</p>
                  </div>
                  <button className="command-button" onClick={runPaperBotNow} disabled={!markets.length}>Force tick</button>
                </div>
              </div>
            </div>
          </div>
          <div className="review-diagnostics-grid after-action-grid">
            <div className="intel-card">
              <div className="source-title-row review-list-header">
                <strong>Run audit trail</strong>
                <span className="badge soft">{paperBotRunHistory.length} saved</span>
              </div>
              <div className="stack-list compact-review-list">
                {paperBotRunHistory.length ? paperBotRunHistory.map((run) => (
                  <div className="stack-row review-row" key={`${run.runAt}-${run.runnerId}`}>
                    <div>
                      <div className="source-title-row">
                        <strong>{formatDateTime(run.runAt)}</strong>
                        <span className={`status-pill tone-${run.status === 'ok' ? 'good' : 'bad'}`}>{run.source === 'backend' ? 'Backend tick' : 'UI tick'}</span>
                      </div>
                      <p>{run.summary}</p>
                      {run.source === 'backend' && paperBotBackend?.runner ? <p className="subtle">Runner {paperBotBackend.runner}{paperBotBackend.lastRunOk === false && paperBotBackend.lastFailureAt === run.runAt ? `, failed ${paperBotBackend.consecutiveFailures} time${paperBotBackend.consecutiveFailures === 1 ? '' : 's'} in a row` : ''}.</p> : null}
                    </div>
                    <div className="source-metrics">
                      <small>{run.actionCount} actions</small>
                      <small>{run.staleMarketCount} stale</small>
                      <small>{run.queuedCount} queued / {run.activeCount} active</small>
                    </div>
                  </div>
                )) : <p className="subtle">Once the scheduler or operator runs a tick, the recent audit trail will land here.</p>}
              </div>
            </div>
            <div className="intel-card">
              <div className="source-title-row review-list-header">
                <strong>Runtime watch</strong>
                <span className={`status-pill tone-${paperBotSupervision.healthTone}`}>{paperBotSupervision.healthLabel}</span>
              </div>
              <div className="stack-list compact-review-list">
                <div className="stack-row review-row">
                  <div>
                    <div className="source-title-row">
                      <strong>{paperBotSupervision.headline}</strong>
                      <span className="badge soft">{paperBotHotMarkets.length} hot lanes</span>
                    </div>
                    <p>{paperBotSupervision.detail}</p>
                  </div>
                </div>
                {paperBotSupervision.checks.map((check) => (
                  <div className="stack-row review-row" key={check.label}>
                    <div>
                      <div className="source-title-row">
                        <strong>{check.label}</strong>
                        <span className={`status-pill tone-${check.tone}`}>{check.status}</span>
                      </div>
                      <p>{check.detail}</p>
                    </div>
                  </div>
                ))}
                {paperBotBackend ? (
                  <div className="stack-row review-row">
                    <div>
                      <div className="source-title-row">
                        <strong>Backend runtime</strong>
                        <span className={`status-pill ${paperBotBackend.staleStatus === 'stale' ? 'tone-bad' : paperBotBackend.staleStatus === 'watch' ? 'tone-warn' : paperBotBackend.staleStatus === 'fresh' ? 'tone-good' : 'tone-muted'}`}>{paperBotBackend.staleStatus.toUpperCase()}</span>
                      </div>
                      <p>{paperBotBackend.staleReason ?? 'Backend status metadata is present but did not include a runtime note.'}</p>
                      {backendLedgerScope ? <p className="subtle">Runner target: {backendLedgerScope.documentPath}{appLedgerScope ? ownerScopeAligned ? ' (matches signed-in app owner).' : ' (does not match the signed-in app owner path).' : ''}</p> : null}
                    </div>
                    <div className="source-metrics">
                      <small>{paperBotBackend.runner ?? 'runner?'}</small>
                      <small>{paperBotBackend.lastRunAt ? formatDateTime(paperBotBackend.lastRunAt) : 'no run yet'}</small>
                      <small>{paperBotBackend.lastQueuedCount} queued / {paperBotBackend.lastActiveCount} active</small>
                    </div>
                  </div>
                ) : null}
                {paperBotSupervision.alerts.map((alert) => (
                  <div className="stack-row review-row" key={alert.title}>
                    <div>
                      <div className="source-title-row">
                        <strong>{alert.title}</strong>
                        <span className={`status-pill tone-${alert.tone}`}>{alert.tone === 'bad' ? 'Intervene' : 'Watch'}</span>
                      </div>
                      <p>{alert.detail}</p>
                    </div>
                  </div>
                ))}
                {paperBotHotMarkets.length ? paperBotHotMarkets.map((runtime) => (
                  <div className="stack-row review-row" key={runtime.marketId}>
                    <div>
                      <div className="source-title-row">
                        <strong>{displayMarkets.find((market) => market.id === runtime.marketId)?.title ?? runtime.marketId}</strong>
                        <span className={`status-pill ${paperState[runtime.marketId]?.state === 'active' ? 'tone-good' : 'tone-warn'}`}>{runtime.state.toUpperCase()}</span>
                      </div>
                      <p>{runtime.note}</p>
                    </div>
                    <div className="source-metrics">
                      <small>{runtime.decision}</small>
                      <small>{runtime.consecutiveWouldTradeTicks} ticks</small>
                    </div>
                  </div>
                )) : <p className="subtle">No queued or active bot lanes yet.</p>}
              </div>
            </div>
          </div>
        </section>
        {loading && <section className="panel system-banner" data-panel="sys.loading"><strong>Mission board loading</strong><span>Pulling contracts, quotes, and weather-model inputs.</span></section>}

        <section className="panel review-panel execution-visibility-panel" data-panel="acct.execution">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Paper execution visibility</p>
              <h2>Bot fills, positions, and PnL at a glance</h2>
              <p className="subtle panel-intro">This is a read-only paper ledger view. It makes staged orders, local fills, active positions, and realized versus marked PnL obvious without introducing any live trading controls.</p>
            </div>
            <div className="table-actions">
              <span className="badge soft">Paper-only</span>
              <span className="badge soft">{livePositionSummary.totalFilledUnits} filled units</span>
            </div>
          </div>

          <div className="execution-summary-grid review-metrics execution-glance-grid">
            <ExecutionSummaryCard label="Working orders" value={String(livePositionSummary.workingOrders)} detail={`${livePositionSummary.partialOrders} partially filled`} toneClass={livePositionSummary.workingOrders ? 'positive' : undefined} />
            <ExecutionSummaryCard label="Filled orders" value={String(livePositionSummary.filledOrders)} detail={`${livePositionSummary.totalFilledUnits} units executed locally`} toneClass={livePositionSummary.filledOrders ? 'positive' : undefined} />
            <ExecutionSummaryCard label="Open positions" value={`${livePositionSummary.activePositions} active / ${livePositionSummary.queuedPositions} queued`} detail={`${livePositionSummary.closedPositions} closed in ledger`} toneClass={livePositionSummary.activePositions ? 'positive' : undefined} />
            <ExecutionSummaryCard label="Open marked PnL" value={signedPct(livePositionSummary.markedOpen)} detail="Across queued and active blotter entries." toneClass={livePositionSummary.markedOpen >= 0 ? 'positive' : 'negative'} />
            <ExecutionSummaryCard label="Realized PnL" value={signedPct(livePositionSummary.realized)} detail="Closed paper trades only." toneClass={livePositionSummary.realized >= 0 ? 'positive' : 'negative'} />
          </div>

          <div className="review-diagnostics-grid execution-visibility-grid">
            <div className="intel-card">
              <div className="subpanel-header">
                <div>
                  <span className="detail-label">Live position spotlight</span>
                  <p className="subtle">Open paper positions sorted by how much PnL is moving right now.</p>
                </div>
                <span className="badge soft">{positionSpotlight.length} shown</span>
              </div>
              <div className="stack-list compact-review-list">
                {positionSpotlight.length ? positionSpotlight.map((entry) => (
                  <button key={entry.marketId} type="button" className={`review-selector ${selectedMarket?.id === entry.marketId ? 'selected' : ''}`} onClick={() => setSelectedId(entry.marketId)}>
                    <div>
                      <div className="source-title-row">
                        <strong>{entry.marketTitle}</strong>
                        <span className={`status-pill ${entry.state === 'active' ? 'tone-good' : 'tone-warn'}`}>{entry.state.toUpperCase()}</span>
                      </div>
                      <p>{entry.direction === 'buy-yes' ? 'BUY YES' : 'BUY NO'} · Entry {quotePct(entry.entryPrice)} · Mark {quotePct(entry.currentMark)} · {entry.exitSuggestion.summary}</p>
                    </div>
                    <div className="source-metrics">
                      <small>Marked {entry.markedPnlPoints === null ? '--' : signedPct(entry.markedPnlPoints)}</small>
                      <small>Realized {entry.realizedPnlPoints === null ? '--' : signedPct(entry.realizedPnlPoints)}</small>
                    </div>
                  </button>
                )) : <p className="subtle">No open paper positions yet.</p>}
              </div>
            </div>

            <div className="intel-card">
              <div className="subpanel-header">
                <div>
                  <span className="detail-label">Recent bot activity</span>
                  <p className="subtle">Combines recent fills, position state changes, and bot run audits into one unmistakable tape.</p>
                </div>
                <span className="badge soft">{botActivityFeed.length} events</span>
              </div>
              <div className="stack-list compact-review-list">
                {botActivityFeed.length ? botActivityFeed.map((item) => (
                  <div className="stack-row review-row" key={item.id}>
                    <div>
                      <div className="source-title-row">
                        <strong>{item.title}</strong>
                        <span className={`status-pill tone-${item.tone}`}>{item.kind === 'fill' ? 'Fill' : item.kind === 'bot-run' ? 'Bot' : 'Position'}</span>
                      </div>
                      <p>{item.detail}</p>
                    </div>
                    <div className="source-metrics">
                      <small>{formatClock(item.at)}</small>
                      <small>{formatDateTime(item.at)}</small>
                    </div>
                  </div>
                )) : <p className="subtle">The activity tape will populate after the first paper order or bot tick.</p>}
              </div>
            </div>
          </div>
        </section>

        <section className="panel ops-priority-panel" data-panel="ops.priority">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Operator stack</p>
              <h2>What needs action now</h2>
              <p className="subtle panel-intro">The board below sorts immediate opportunities, current threats, and the next three actions for the selected campaign.</p>
            </div>
          </div>

          <div className="ops-priority-grid">
            <div className="intel-card">
              <div className="subpanel-header">
                <div>
                  <span className="detail-label">Priority queue</span>
                  <p className="subtle">Best use of attention right now.</p>
                </div>
                <span className="badge soft">Top {priorityQueue.length}</span>
              </div>
              <div className="stack-list compact-review-list">
                {priorityQueue.map(({ market, plan, priorityScore }, index) => (
                  <button key={market.id} type="button" className={`review-selector ${selectedMarket?.id === market.id ? 'selected' : ''}`} onClick={() => setSelectedId(market.id)}>
                    <div>
                      <div className="source-title-row">
                        <strong>#{index + 1} {market.title}</strong>
                        <span className={`status-pill ${paperDecisionToneClass(plan.decision)}`}>{market.dataOrigin === 'curated-watchlist' ? 'Scout' : paperDecisionLabel(plan.decision)}</span>
                      </div>
                      <p>{market.dataOrigin === 'curated-watchlist' ? 'Scenario only' : `${paperDirectionLabel(plan.direction)} ready if tape holds`} · Edge {signedPct(market.edge)} · Confidence {pct(market.confidence)}</p>
                    </div>
                    <div className="source-metrics">
                      <small>Score {priorityScore.toFixed(2)}</small>
                      <small>{freshnessLabel(market.freshnessMinutes)}</small>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="intel-card">
              <div className="subpanel-header">
                <div>
                  <span className="detail-label">Threats and opportunities</span>
                  <p className="subtle">Separate upside from board hygiene so the desk knows what changed.</p>
                </div>
              </div>
              <div className="ops-split-grid">
                <div className="stack-list compact-review-list">
                  <div className="source-title-row review-list-header">
                    <strong>Opportunities</strong>
                    <span className="status-pill tone-good">{opportunityBoard.length}</span>
                  </div>
                  {opportunityBoard.map(({ market, plan }) => (
                    <div className="stack-row review-row" key={market.id}>
                      <div>
                        <div className="source-title-row">
                          <strong>{market.title}</strong>
                          <span className={`status-pill ${paperDecisionToneClass(plan.decision)}`}>{paperDirectionLabel(plan.direction)}</span>
                        </div>
                        <p>{plan.entryTrigger}</p>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="stack-list compact-review-list">
                  <div className="source-title-row review-list-header">
                    <strong>Threats</strong>
                    <span className="status-pill tone-bad">{threatBoard.length}</span>
                  </div>
                  {threatBoard.length ? threatBoard.map(({ market, delta }) => (
                    <div className="stack-row review-row" key={market.id}>
                      <div>
                        <div className="source-title-row">
                          <strong>{market.title}</strong>
                          <span className={`status-pill ${statusToneClass(delta.status)}`}>{statusLabel(delta.status)}</span>
                        </div>
                        <p>{delta.alerts[0]?.detail ?? `Watch freshness ${freshnessLabel(market.freshnessMinutes)} and quote state ${market.quoteStatus.toUpperCase()}.`}</p>
                      </div>
                    </div>
                  )) : <p className="subtle">No urgent board threats. The scanner is stable.</p>}
                </div>
              </div>
            </div>

            <div className="intel-card next-actions-card">
              <div className="subpanel-header">
                <div>
                  <span className="detail-label">Next actions for selected market</span>
                  <p className="subtle">A simple operator checklist, not just analytics.</p>
                </div>
                {selectedMarket && <span className={`status-pill ${selectedMarket.dataOrigin === 'curated-watchlist' ? 'tone-warn' : 'tone-good'}`}>{selectedMarket.dataOrigin === 'curated-watchlist' ? 'Scouting' : 'Execution'}</span>}
              </div>
              <div className="stack-list compact-review-list">
                {selectedActionQueue.length ? selectedActionQueue.map((item) => (
                  <div className="stack-row review-row" key={item.title}>
                    <div>
                      <div className="source-title-row">
                        <strong>{item.title}</strong>
                        <span className={`status-pill tone-${item.tone}`}>{item.tone === 'good' ? 'Do now' : item.tone === 'bad' ? 'Urgent' : item.tone === 'warn' ? 'Watch' : 'Stand by'}</span>
                      </div>
                      <p>{item.detail}</p>
                    </div>
                  </div>
                )) : <p className="subtle">Select a market to get a task stack.</p>}
              </div>
            </div>
          </div>
        </section>

        <section className="operations-grid">
          <section className="panel theater-panel" data-panel="market.board">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Operational theater</p>
                <h2>Mission board</h2>
                <p className="subtle panel-intro">Each tile is a deployable situation card. Live contracts stay separate from watchlist scenarios so planning stays honest.</p>
              </div>
              <div className="table-actions">
                <button className="command-button" onClick={() => void fetchMarkets(true)} disabled={loading || refreshing}>{refreshing ? 'Refreshing…' : 'Refresh board'}</button>
              </div>
            </div>

            <div className="theater-grid">
              {displayMarkets.map((market, index) => {
                const plan = paperPlans[market.id];
                const delta = marketDeltas[market.id];
                const watched = watchSet.has(market.id);
                const selected = market.id === selectedMarket?.id;
                return (
                  <button key={market.id} type="button" className={`theater-card ${selected ? 'selected' : ''}`} onClick={() => setSelectedId(market.id)}>
                    <div className="theater-card-topline">
                      <span className="sector-label">Sector {String(index + 1).padStart(2, '0')}</span>
                      <span className={`status-pill ${statusToneClass(delta.status)}`}>{statusLabel(delta.status)}</span>
                    </div>
                    <strong>{market.title}</strong>
                    <p>{market.location} · {market.expiry}</p>
                    <div className="signal-strip">
                      <SignalCell label="Market" value={market.dataOrigin === 'curated-watchlist' ? '--' : pct(market.impliedProbability)} />
                      <SignalCell label="Model" value={pct(market.modelProbability)} />
                      <SignalCell label="Edge" value={signedPct(market.edge)} tone={market.edge >= 0 ? 'positive' : 'negative'} />
                      <SignalCell label="Fresh" value={freshnessLabel(market.freshnessMinutes)} />
                    </div>
                    <div className="card-footer-row">
                      <span className={`status-pill ${market.dataOrigin === 'curated-watchlist' ? 'tone-warn' : 'tone-good'}`}>{market.dataOrigin === 'curated-watchlist' ? 'Scenario only' : 'Live contract'}</span>
                      <span className={`status-pill ${paperDecisionToneClass(plan.decision)}`}>{market.dataOrigin === 'curated-watchlist' ? 'Observe' : paperDecisionLabel(plan.decision)}</span>
                      {watched && <span className="status-pill tone-muted">Pinned</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <div className="right-column">
            <section className="panel command-panel" data-panel="trade.console">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Command brief</p>
                  <h2>{selectedMarket?.title ?? 'Awaiting selection'}</h2>
                  <p className="subtle panel-intro">Central planning surface for thesis, execution state, risks, and paper-order control.</p>
                </div>
                {selectedMarket && (
                  <button className={`command-button ${watchSet.has(selectedMarket.id) ? 'active' : ''}`} onClick={() => toggleWatch(selectedMarket.id)}>
                    {watchSet.has(selectedMarket.id) ? 'Pinned to board' : 'Pin to board'}
                  </button>
                )}
              </div>

              {selectedMarket && selectedPlan && selectedDelta && (
                <>
                  <div className="command-summary-grid">
                    <Metric label="Contract status" value={selectedMarket.dataOrigin === 'curated-watchlist' ? 'SCENARIO' : 'LIVE'} positive={selectedMarket.dataOrigin !== 'curated-watchlist'} />
                    <Metric label="Action lane" value={selectedMarket.dataOrigin === 'curated-watchlist' ? 'Observe' : paperDirectionLabel(selectedPlan.direction)} positive={selectedPlan.direction !== 'stand-aside'} />
                    <Metric label="Confidence" value={pct(selectedMarket.confidence)} positive={selectedMarket.confidence >= 0.6} />
                    <Metric label="Quote posture" value={selectedMarket.quoteStatus.toUpperCase()} positive={selectedMarket.quoteStatus === 'tight' || selectedMarket.quoteStatus === 'tradable'} />
                  </div>

                  <div className="doctrine-grid">
                    <ActionCard title="Operational thesis" body={selectedPlan.thesis} emphasis />
                    <ActionCard title="Entry trigger" body={selectedPlan.entryTrigger} />
                    <ActionCard title="Abort / stop" body={selectedPlan.stopTrigger} />
                    <ActionCard title="Heuristic read" body={selectedMarket.heuristicSummary} />
                  </div>

                  <div className="intel-grid">
                    <div className="intel-card">
                      <span className="detail-label">Go / no-go checks</span>
                      <ul>
                        {selectedPlan.entryCriteria.map((item) => (
                          <li key={item.label} className={item.passed ? 'positive' : 'negative'}>{item.label}: {item.value}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="intel-card">
                      <span className="detail-label">Threats to plan</span>
                      <ul>
                        {(selectedPlan.blockers.length ? selectedPlan.blockers : selectedPlan.exitCriteria).slice(0, 5).map((item) => <li key={item}>{item}</li>)}
                      </ul>
                    </div>
                  </div>

                  <section className="execution-bay">
                    <div className="workflow-lane-grid">
                      {workflowStages.map((stage) => (
                        <div key={stage.key} className={`score-card workflow-stage-card workflow-tone-${stage.tone}`}>
                          <span>{stage.label}</span>
                          <strong>{stage.status}</strong>
                          <p>{stage.detail}</p>
                          {stage.actionLabel && stage.onAction && <button className="command-button workflow-action" onClick={stage.onAction}>{stage.actionLabel}</button>}
                        </div>
                      ))}
                    </div>

                    <div className="subpanel-header">
                      <div>
                        <span className="detail-label">Execution bay</span>
                        <p className="subtle">Paper-only controls for staging, sizing, and repricing the selected campaign.</p>
                      </div>
                      <div className="paper-state-actions">
                        <button className={`command-button ${selectedPaperState?.state === 'flat' ? 'active' : ''}`} onClick={() => setMarketPaperState(selectedMarket.id, 'flat')}>Flat</button>
                        <button className={`command-button ${selectedPaperState?.state === 'queued' ? 'active' : ''}`} onClick={() => setMarketPaperState(selectedMarket.id, 'queued')}>Queue</button>
                        <button className={`command-button ${selectedPaperState?.state === 'active' ? 'active' : ''}`} onClick={() => setMarketPaperState(selectedMarket.id, 'active')}>Active</button>
                        <button className={`command-button ${selectedPaperState?.state === 'closed' ? 'active' : ''}`} onClick={() => setMarketPaperState(selectedMarket.id, 'closed')}>Closed</button>
                      </div>
                    </div>

                    <div className="execution-summary-grid">
                      <ExecutionSummaryCard label="Suggested size" value={`${selectedPlan.sizing.suggestedUnits} units`} detail={selectedPlan.sizing.notionalLabel} />
                      <ExecutionSummaryCard label="Take profit" value={signedPct(paperExecutionProfile.global.takeProfitPts)} detail={selectedPlan.takeProfitTrigger} />
                      <ExecutionSummaryCard label="Stop loss" value={signedPct(paperExecutionProfile.global.stopLossPts)} detail={selectedPlan.stopTrigger} />
                      <ExecutionSummaryCard label="Current state" value={(selectedPaperState?.state ?? 'flat').toUpperCase()} detail={selectedPaperState?.note ?? 'No paper position stored for this trade yet.'} toneClass={paperStateToneClass(selectedPaperState?.state)} />
                    </div>

                    {selectedMarket.dataOrigin !== 'curated-watchlist' && selectedPlan.direction !== 'stand-aside' && selectedOrderDraft && (
                      <div className="intel-card order-ticket-shell">
                        <div className="subpanel-header">
                          <div>
                            <span className="detail-label">Order staging console</span>
                            <p className="subtle">Stage working paper orders around the live mark.</p>
                          </div>
                          <span className={`status-pill ${paperDecisionToneClass(selectedPlan.decision)}`}>{paperDirectionLabel(selectedPlan.direction)}</span>
                        </div>
                        <div className="order-ticket-grid">
                          <label>
                            <span>Size</span>
                            <input type="number" min="1" max={selectedPlan.sizing.maxUnits} value={selectedOrderDraft.quantity} onChange={(event) => updateOrderDraft(selectedMarket.id, { quantity: Math.max(1, Number(event.target.value) || 1) })} />
                          </label>
                          <label>
                            <span>Limit</span>
                            <input type="number" min="0.01" max="0.99" step="0.01" value={selectedOrderDraft.limitPrice} onChange={(event) => updateOrderDraft(selectedMarket.id, { limitPrice: clampOrderPrice(Number(event.target.value) || 0.5) })} />
                          </label>
                          <label className="order-ticket-note">
                            <span>Commander note</span>
                            <input type="text" value={selectedOrderDraft.note} placeholder="Why this level?" onChange={(event) => updateOrderDraft(selectedMarket.id, { note: event.target.value })} />
                          </label>
                        </div>
                        <div className="hero-ribbon">
                          <span className="badge soft">Mark {quotePct(selectedMarket.clobQuote?.midpoint ?? selectedMarket.impliedProbability)}</span>
                          <span className="badge soft">Ask {quotePct(selectedMarket.clobQuote?.bestAsk)}</span>
                          <span className="badge soft">Bid {quotePct(selectedMarket.clobQuote?.bestBid)}</span>
                          <span className="badge soft">Working {selectedWorkingOrders.length}</span>
                          <span className="badge soft">With fills {selectedFilledOrders.length}</span>
                          <button className="command-button" onClick={handlePlacePaperOrder} disabled={paperRiskGovernor.halted || paperRiskGovernor.safeMode}>Stage order</button>
                        </div>
                        {(paperRiskGovernor.halted || paperRiskGovernor.safeMode) && <p className="subtle">Order staging is blocked while the risk governor is {paperRiskGovernor.halted ? 'in hard-stop mode' : 'in safe mode'}. {paperRiskGovernor.detail}</p>}
                        <div className="stack-list compact-orders">
                          {selectedOrders.length ? selectedOrders.map((order) => (
                            <div className="stack-row" key={order.id}>
                              <div>
                                <div className="source-title-row">
                                  <strong>{order.direction === 'buy-yes' ? 'BUY YES' : 'BUY NO'} · {order.filledQuantity}/{order.quantity}u @ {pct(order.limitPrice)}</strong>
                                  <span className={`status-pill ${order.status === 'filled' ? 'tone-good' : order.status === 'partial' ? 'tone-warn' : order.status === 'cancelled' ? 'tone-muted' : 'tone-warn'}`}>{order.status.toUpperCase()}</span>
                                </div>
                                <p>{order.note}</p>
                              </div>
                              <div className="source-metrics">
                                <small>{formatDateTime(order.createdAt)}</small>
                                {(order.status === 'working' || order.status === 'partial') && <button className="command-button" onClick={() => handleCancelPaperOrder(order.id)}>Cancel</button>}
                              </div>
                            </div>
                          )) : <p className="subtle">No paper orders staged yet for this contract.</p>}
                        </div>
                      </div>
                    )}

                    <div className="support-grid">
                      <PaperExecutionSettingsForm settings={paperExecutionProfile.global} onChange={updateGlobalPaperSetting} compact />
                      <div className="intel-card">
                        <div className="subpanel-header">
                          <div>
                            <span className="detail-label">Blotter state</span>
                            <p className="subtle">Local campaign journal for this browser.</p>
                          </div>
                          <button className="command-button" onClick={handleRepricePaperBlotter}>Reprice</button>
                        </div>
                        {paperRepriceMeta && <p className="subtle">Last repriced {formatClock(paperRepriceMeta.at)} for {paperRepriceMeta.changedCount} positions.</p>}
                        {selectedBlotter ? (
                          <ul>
                            <li>Entry mark: {quotePct(selectedBlotter.entryPrice)}</li>
                            <li>Current mark: {quotePct(selectedBlotter.currentMark)}</li>
                            <li>PnL: <span className={(selectedBlotter.pnlPoints ?? 0) >= 0 ? 'positive' : 'negative'}>{selectedBlotter.pnlPoints === null ? '--' : signedPct(selectedBlotter.pnlPoints)}</span></li>
                            <li>{selectedBlotter.exitSuggestion.summary}</li>
                            <li>Journal: {(selectedBlotter.journal ?? []).slice(-1)[0]?.summary ?? 'No journal yet.'}</li>
                          </ul>
                        ) : (
                          <p className="subtle">No blotter entry yet. Queue or activate this trade to start tracking it.</p>
                        )}
                      </div>
                    </div>
                  </section>
                </>
              )}
            </section>

            <section className="panel telemetry-panel" data-panel="signal.telemetry">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Telemetry</p>
                  <h2>Recent movement and board alerts</h2>
                </div>
                <div className="table-actions">
                  <span className="badge soft">{selectedTrend?.snapshotCount ?? 0} snapshots</span>
                  <span className={`badge soft ${selectedMarket ? quoteToneClass(selectedMarket.quoteStatus) : ''}`}>{selectedMarket?.dataOrigin === 'curated-watchlist' ? 'SCENARIO ONLY' : selectedMarket?.quoteStatus?.toUpperCase() ?? 'NO QUOTE'}</span>
                </div>
              </div>

              {selectedMarket && (
                <div className="execution-summary-grid telemetry-metrics">
                  <ExecutionSummaryCard label="Edge change" value={selectedTrend?.edge.delta == null ? '--' : signedPct(selectedTrend.edge.delta)} detail={`Now ${signedPct(selectedMarket.edge)}`} toneClass={selectedTrend?.edge.delta == null ? undefined : selectedTrend.edge.delta >= 0 ? 'positive' : 'negative'} />
                  <ExecutionSummaryCard label="Confidence change" value={selectedTrend?.confidence.delta == null ? '--' : signedPct(selectedTrend.confidence.delta)} detail={`Now ${pct(selectedMarket.confidence)}`} toneClass={selectedTrend?.confidence.delta == null ? undefined : selectedTrend.confidence.delta >= 0 ? 'positive' : 'negative'} />
                  <ExecutionSummaryCard label="Freshness" value={freshnessLabel(selectedMarket.freshnessMinutes)} detail={selectedTrend?.freshness.delta == null ? 'Need another refresh' : `${selectedTrend.freshness.delta >= 0 ? '+' : ''}${selectedTrend.freshness.delta}m vs first local snapshot`} />
                  <ExecutionSummaryCard label="Spread / disagreement" value={pct(selectedMarket.disagreement)} detail={selectedMarket.heuristicSummary} />
                </div>
              )}

              <div className="telemetry-lanes">
                <div className="intel-card">
                  <span className="detail-label">History tape</span>
                  <div className="stack-list compact-history">
                    {selectedMarket?.dataOrigin === 'curated-watchlist'
                      ? <p className="subtle">This row is a planning scenario, so there is no live contract history yet.</p>
                      : historyPreview.length ? historyPreview.map((snapshot, index) => <HistoryRow key={`${snapshot.capturedAt}-${index}`} snapshot={snapshot} />) : <p className="subtle">History appears after another refresh.</p>}
                  </div>
                </div>
                <div className="intel-card">
                  <span className="detail-label">Signal traffic</span>
                  <div className="stack-list">
                    {allAlerts.length ? allAlerts.map((alert) => (
                      <div className="stack-row" key={alert.id}>
                        <div>
                          <div className="source-title-row">
                            <strong>{alert.marketTitle}</strong>
                            <span className={`status-pill tone-${alert.tone}`}>{alert.summary}</span>
                          </div>
                          <p>{alert.detail}</p>
                        </div>
                        <div className="source-metrics">
                          <small>{formatDateTime(alert.createdAt)}</small>
                        </div>
                      </div>
                    )) : <p className="subtle">No alerts yet. The next refresh will show what changed.</p>}
                  </div>
                </div>
              </div>
            </section>
          </div>
        </section>

        <section className="panel review-panel portfolio-panel" data-panel="desk.risk">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Desk risk</p>
              <h2>Portfolio concentration and bias</h2>
              <p className="subtle panel-intro">The scanner can now show whether your paper book is actually diversified, or if multiple trades are really one weather bet wearing different labels.</p>
            </div>
            <div className="table-actions">
              <span className="badge soft">{exposureSummary.grossUnits} tracked units</span>
              <span className="badge soft">{exposureSummary.tracked.length} live campaigns</span>
            </div>
          </div>

          <div className="execution-summary-grid review-metrics">
            <ExecutionSummaryCard label="Active risk" value={`${exposureSummary.activeUnits}u`} detail={`${exposureSummary.tracked.filter((item) => item.state === 'active').length} active campaigns`} />
            <ExecutionSummaryCard label="Queued risk" value={`${exposureSummary.queuedUnits}u`} detail={`${exposureSummary.tracked.filter((item) => item.state === 'queued').length} queued campaigns`} />
            <ExecutionSummaryCard label="YES vs NO" value={`${exposureSummary.yesUnits}u / ${exposureSummary.noUnits}u`} detail="Gross directional split across the paper desk." />
            <ExecutionSummaryCard label="Net bias" value={exposureSummary.netBiasUnits === 0 ? 'Flat' : `${exposureSummary.netBiasUnits > 0 ? '+' : ''}${exposureSummary.netBiasUnits}u`} detail={exposureSummary.netBiasUnits > 0 ? 'Desk leans YES.' : exposureSummary.netBiasUnits < 0 ? 'Desk leans NO.' : 'Desk is balanced.'} toneClass={exposureSummary.netBiasUnits === 0 ? undefined : exposureSummary.netBiasUnits > 0 ? 'positive' : 'negative'} />
          </div>

          <div className="review-diagnostics-grid">
            <div className="intel-card">
              <div className="subpanel-header">
                <div>
                  <span className="detail-label">Risk governor rails</span>
                  <p className="subtle">Hard caps auto-stop the bot and flip automation off. Safe-mode rails keep existing positions managing out, but block any fresh queueing or activation.</p>
                </div>
                <span className={`status-pill tone-${paperRiskGovernor.halted ? 'bad' : paperRiskGovernor.safeMode ? 'warn' : 'good'}`}>{paperRiskGovernor.headline}</span>
              </div>

              <div className="stack-list compact-review-list exposure-alert-stack">
                <div className="stack-row review-row">
                  <div>
                    <div className="source-title-row">
                      <strong>Auto-stop behavior</strong>
                      <span className={`status-pill tone-${paperBotState.autoStopped ? 'bad' : paperBotState.operatorSafeMode || paperRiskGovernor.safeMode ? 'warn' : 'good'}`}>{paperBotState.autoStopped ? 'Auto-stopped' : paperBotState.operatorSafeMode ? 'Operator safe mode' : paperRiskGovernor.safeMode ? 'Risk safe mode' : 'Open'}</span>
                    </div>
                    <p>{paperBotState.autoStopped ? `The bot auto-stopped at ${formatDateTime(paperBotState.autoStoppedAt ?? undefined)} and stays disabled until an operator resumes it.` : paperBotState.operatorSafeMode ? 'Operator safe mode is active, so fresh paper risk is paused even though current positions can keep managing out.' : paperRiskGovernor.safeMode ? `${paperRiskGovernor.detail} Fresh queueing and activation stay blocked until the book cools off.` : 'No hard cap is tripped right now. Fresh risk can flow as long as the other execution gates stay open.'}</p>
                  </div>
                  <div className="source-metrics">
                    <small>{paperBotState.haltReason ?? paperBotState.safeModeReason ?? 'No halt reason'}</small>
                  </div>
                </div>
                <div className="stack-row review-row">
                  <div>
                    <div className="source-title-row">
                      <strong>Drawdown rail</strong>
                      <span className="status-pill tone-muted">{riskRailStatusLabel(paperBotState.riskGovernor.safeModeDrawdownPct, paperBotState.riskGovernor.maxDailyDrawdownPct)}</span>
                    </div>
                    <p>Daily losses across closed trades and active open losses first push the desk into safe mode, then hard-stop automation.</p>
                  </div>
                </div>
                <div className="stack-row review-row">
                  <div>
                    <div className="source-title-row">
                      <strong>Exposure rail</strong>
                      <span className="status-pill tone-muted">{riskRailStatusLabel(paperBotState.riskGovernor.safeModeExposurePct, paperBotState.riskGovernor.maxOpenExposurePct)}</span>
                    </div>
                    <p>Total filled plus working paper exposure can warn early, then auto-stop once the hard cap is hit. Location and setup caps are always hard limits.</p>
                  </div>
                </div>
              </div>

              <div className="order-ticket-grid">
                <label>
                  <span>Hard drawdown %</span>
                  <input type="number" min="1" max="50" step="1" value={Math.round(paperBotState.riskGovernor.maxDailyDrawdownPct * 100)} onChange={(event) => updateRiskGovernorSetting('maxDailyDrawdownPct', clampPctInput(Number(event.target.value) || 1, 1, 50) / 100)} />
                </label>
                <label>
                  <span>Safe drawdown %</span>
                  <input type="number" min="1" max="50" step="1" value={Math.round(paperBotState.riskGovernor.safeModeDrawdownPct * 100)} onChange={(event) => updateRiskGovernorSetting('safeModeDrawdownPct', clampPctInput(Number(event.target.value) || 1, 1, 50) / 100)} />
                </label>
                <label>
                  <span>Hard exposure %</span>
                  <input type="number" min="5" max="100" step="1" value={Math.round(paperBotState.riskGovernor.maxOpenExposurePct * 100)} onChange={(event) => updateRiskGovernorSetting('maxOpenExposurePct', clampPctInput(Number(event.target.value) || 5, 5, 100) / 100)} />
                </label>
                <label>
                  <span>Safe exposure %</span>
                  <input type="number" min="5" max="100" step="1" value={Math.round(paperBotState.riskGovernor.safeModeExposurePct * 100)} onChange={(event) => updateRiskGovernorSetting('safeModeExposurePct', clampPctInput(Number(event.target.value) || 5, 5, 100) / 100)} />
                </label>
                <label>
                  <span>Location cap %</span>
                  <input type="number" min="5" max="100" step="1" value={Math.round(paperBotState.riskGovernor.maxCorrelatedLocationPct * 100)} onChange={(event) => updateRiskGovernorSetting('maxCorrelatedLocationPct', clampPctInput(Number(event.target.value) || 5, 5, 100) / 100)} />
                </label>
                <label>
                  <span>Setup cap %</span>
                  <input type="number" min="5" max="100" step="1" value={Math.round(paperBotState.riskGovernor.maxCorrelatedSetupPct * 100)} onChange={(event) => updateRiskGovernorSetting('maxCorrelatedSetupPct', clampPctInput(Number(event.target.value) || 5, 5, 100) / 100)} />
                </label>
              </div>

              <div className="stack-list compact-review-list exposure-alert-stack">
                {paperRiskGovernor.guardrails.map((rail) => (
                  <div className="stack-row review-row" key={rail.key}>
                    <div>
                      <div className="source-title-row">
                        <strong>{rail.label}</strong>
                        <span className={`status-pill tone-${rail.breached ? 'bad' : rail.warning ? 'warn' : 'good'}`}>{Math.round(rail.valuePct * 100)}% / {Math.round(rail.limitPct * 100)}%</span>
                      </div>
                      <p>{rail.detail}</p>
                    </div>
                    <div className="source-metrics">
                      <small>{rail.remainingPct <= 0 ? 'limit hit' : `${Math.round(rail.remainingPct * 100)}% headroom`}</small>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="intel-card">
              <div className="subpanel-header">
                <div>
                  <span className="detail-label">Concentration map</span>
                  <p className="subtle">Top exposure pockets by city, setup type, and side.</p>
                </div>
              </div>

              <div className="exposure-grid">
                <ExposureColumn title="By city" buckets={exposureSummary.byLocation} />
                <ExposureColumn title="By setup" buckets={exposureSummary.bySetup} />
                <ExposureColumn title="By bias" buckets={exposureSummary.byDirection} />
              </div>
            </div>

            <div className="intel-card">
              <div className="subpanel-header">
                <div>
                  <span className="detail-label">Desk actions</span>
                  <p className="subtle">What the portfolio shape suggests you should do next.</p>
                </div>
              </div>

              <div className="stack-list compact-review-list">
                {exposureSummary.nextSteps.length ? exposureSummary.nextSteps.map((item) => (
                  <div className="stack-row review-row" key={item.title}>
                    <div>
                      <div className="source-title-row">
                        <strong>{item.title}</strong>
                        <span className={`status-pill tone-${item.tone}`}>{item.tone === 'good' ? 'Healthy' : item.tone === 'warn' ? 'Adjust' : 'Watch'}</span>
                      </div>
                      <p>{item.detail}</p>
                    </div>
                  </div>
                )) : <p className="subtle">Queue or activate a trade to start monitoring desk-level concentration.</p>}
              </div>

              <div className="stack-list compact-review-list exposure-alert-stack">
                {exposureSummary.alerts.map((alert) => (
                  <div className="stack-row review-row" key={alert.title}>
                    <div>
                      <div className="source-title-row">
                        <strong>{alert.title}</strong>
                        <span className={`status-pill tone-${alert.tone}`}>{alert.tone === 'bad' ? 'Attention' : alert.tone === 'warn' ? 'Risk' : 'Clear'}</span>
                      </div>
                      <p>{alert.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="panel review-panel" data-panel="posttrade.review">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Performance review</p>
              <h2>Did the ranked setups actually work?</h2>
              <p className="subtle panel-intro">This local review layer keeps realized outcomes for closed paper trades and marked PnL for open ones, so you can see whether the scanner is earning the right to be trusted.</p>
            </div>
            <div className="table-actions">
              <span className="badge soft">{paperPerformance.totals.closed} closed</span>
              <span className="badge soft">{paperPerformance.lastClosedAt ? `Last close ${formatClock(paperPerformance.lastClosedAt)}` : 'No closed trades yet'}</span>
            </div>
          </div>

          <div className="execution-summary-grid review-metrics">
            <ExecutionSummaryCard label="Win rate" value={paperPerformance.totals.winRate === null ? '--' : pct(paperPerformance.totals.winRate)} detail={`${paperPerformance.totals.wins} wins · ${paperPerformance.totals.losses} losses · ${paperPerformance.totals.flats} flat`} />
            <ExecutionSummaryCard label="Avg entry edge" value={paperPerformance.totals.avgEntryEdge === null ? '--' : signedPct(paperPerformance.totals.avgEntryEdge)} detail="Average scanner edge at trade open." />
            <ExecutionSummaryCard label="Realized PnL" value={signedPct(paperPerformance.totals.totalRealizedPnl)} detail={paperPerformance.totals.closed ? `${paperPerformance.totals.closed} closed paper trades.` : 'Nothing realized yet.'} toneClass={paperPerformance.totals.totalRealizedPnl >= 0 ? 'positive' : 'negative'} />
            <ExecutionSummaryCard label="Marked PnL" value={signedPct(paperPerformance.totals.totalMarkedPnl)} detail={`${paperPerformance.totals.open} active · ${paperPerformance.totals.queued} queued`} toneClass={paperPerformance.totals.totalMarkedPnl >= 0 ? 'positive' : 'negative'} />
          </div>

          <div className="review-diagnostics-grid">
            <div className="intel-card">
              <div className="subpanel-header">
                <div>
                  <span className="detail-label">Fast validation</span>
                  <p className="subtle">A quicker read on whether the paper engine is showing edge or just noise.</p>
                </div>
                <span className="badge soft">{paperPerformance.fastValidation.closedCount} closes</span>
              </div>

              <div className="execution-summary-grid compact-score-grid">
                <ExecutionSummaryCard
                  label="Expectancy / trade"
                  value={paperPerformance.fastValidation.expectancyPerTrade === null ? '--' : signedPct(paperPerformance.fastValidation.expectancyPerTrade)}
                  detail={paperPerformance.fastValidation.expectancyLabel}
                  toneClass={paperPerformance.fastValidation.expectancyPerTrade === null ? undefined : paperPerformance.fastValidation.expectancyPerTrade >= 0 ? 'positive' : 'negative'}
                />
                <ExecutionSummaryCard
                  label="Recent form"
                  value={paperPerformance.fastValidation.recentForm.sampleSize ? `${paperPerformance.fastValidation.recentForm.wins}-${paperPerformance.fastValidation.recentForm.losses}${paperPerformance.fastValidation.recentForm.flats ? `-${paperPerformance.fastValidation.recentForm.flats}` : ''}` : '--'}
                  detail={paperPerformance.fastValidation.recentForm.sampleSize ? `${paperPerformance.fastValidation.recentForm.sampleSize} most recent closes.` : 'Need recent closed trades.'}
                />
                <ExecutionSummaryCard
                  label="Current streak"
                  value={streakLabel(paperPerformance.fastValidation.recentForm.streak.direction, paperPerformance.fastValidation.recentForm.streak.count)}
                  detail={paperPerformance.fastValidation.recentForm.avgRealizedPnl === null ? 'Need recent closes.' : `Avg ${signedPct(paperPerformance.fastValidation.recentForm.avgRealizedPnl)} over the last tape.`}
                  toneClass={paperPerformance.fastValidation.recentForm.streak.direction === 'win' ? 'positive' : paperPerformance.fastValidation.recentForm.streak.direction === 'loss' ? 'negative' : undefined}
                />
                <ExecutionSummaryCard
                  label="Recent realized"
                  value={paperPerformance.fastValidation.recentForm.sampleSize ? signedPct(paperPerformance.fastValidation.recentForm.totalRealizedPnl) : '--'}
                  detail="Cumulative realized result across the last five closes."
                  toneClass={paperPerformance.fastValidation.recentForm.totalRealizedPnl >= 0 ? 'positive' : 'negative'}
                />
              </div>

              <div className="execution-summary-grid compact-score-grid">
                <ExecutionSummaryCard
                  label="Avg winner"
                  value={paperPerformance.fastValidation.scorecard.avgWin === null ? '--' : signedPct(paperPerformance.fastValidation.scorecard.avgWin)}
                  detail="Average realized gain on winning closes."
                  toneClass={paperPerformance.fastValidation.scorecard.avgWin !== null && paperPerformance.fastValidation.scorecard.avgWin > 0 ? 'positive' : undefined}
                />
                <ExecutionSummaryCard
                  label="Avg loser"
                  value={paperPerformance.fastValidation.scorecard.avgLoss === null ? '--' : signedPct(-paperPerformance.fastValidation.scorecard.avgLoss)}
                  detail="Average realized loss on losing closes."
                  toneClass={paperPerformance.fastValidation.scorecard.avgLoss !== null && paperPerformance.fastValidation.scorecard.avgLoss > 0 ? 'negative' : undefined}
                />
                <ExecutionSummaryCard
                  label="Payoff ratio"
                  value={paperPerformance.fastValidation.scorecard.payoffRatio === null ? '--' : `${paperPerformance.fastValidation.scorecard.payoffRatio.toFixed(2)}x`}
                  detail="Avg winner divided by avg loser."
                  toneClass={paperPerformance.fastValidation.scorecard.payoffRatio === null ? undefined : paperPerformance.fastValidation.scorecard.payoffRatio >= 1 ? 'positive' : 'negative'}
                />
                <ExecutionSummaryCard
                  label="Profit factor"
                  value={paperPerformance.fastValidation.scorecard.profitFactor === null ? '--' : `${paperPerformance.fastValidation.scorecard.profitFactor.toFixed(2)}x`}
                  detail={paperPerformance.fastValidation.scorecard.qualityLabel}
                  toneClass={paperPerformance.fastValidation.scorecard.profitFactor === null ? undefined : paperPerformance.fastValidation.scorecard.profitFactor >= 1 ? 'positive' : 'negative'}
                />
              </div>
            </div>

            <div className="intel-card">
              <div className="subpanel-header">
                <div>
                  <span className="detail-label">Failure clusters</span>
                  <p className="subtle">The most repeated ways local paper trades are failing.</p>
                </div>
              </div>

              <div className="stack-list compact-review-list">
                {paperPerformance.fastValidation.failureClusters.length ? paperPerformance.fastValidation.failureClusters.map((cluster) => (
                  <div className="stack-row review-row" key={cluster.key}>
                    <div>
                      <div className="source-title-row">
                        <strong>{cluster.label}</strong>
                        <span className="status-pill tone-bad">{cluster.count} losses</span>
                      </div>
                      <p>{cluster.detail}</p>
                    </div>
                    <div className="source-metrics">
                      <small>Total {signedPct(cluster.totalRealizedPnl)}</small>
                      <small>Avg {cluster.avgRealizedPnl === null ? '--' : signedPct(cluster.avgRealizedPnl)}</small>
                    </div>
                  </div>
                )) : <p className="subtle">No repeat failure mode yet. Keep closing trades and this will cluster the weak spots automatically.</p>}
              </div>
            </div>

            <div className="intel-card">
              <div className="subpanel-header">
                <div>
                  <span className="detail-label">Loser pattern clusters</span>
                  <p className="subtle">Repeated loss shapes, grouped by the way a paper trade broke down after entry.</p>
                </div>
              </div>

              <div className="stack-list compact-review-list">
                {paperPerformance.fastValidation.loserPatternClusters.length ? paperPerformance.fastValidation.loserPatternClusters.map((cluster) => (
                  <div className="stack-row review-row" key={cluster.key}>
                    <div>
                      <div className="source-title-row">
                        <strong>{cluster.label}</strong>
                        <span className="status-pill tone-bad">{cluster.count} repeats</span>
                      </div>
                      <p>{cluster.detail}</p>
                      <small className="subtle">{cluster.setups.map(setupTypeLabel).join(' · ')}{cluster.directions.length ? ` · ${cluster.directions.map(directionLabel).join(' / ')}` : ''}</small>
                    </div>
                    <div className="source-metrics">
                      <small>Avg edge {cluster.avgEntryEdge === null ? '--' : signedPct(cluster.avgEntryEdge)}</small>
                      <small>Conf {cluster.avgConfidenceDrop === null ? '--' : signedPct(cluster.avgConfidenceDrop)}</small>
                      <small>Total {signedPct(cluster.totalRealizedPnl)}</small>
                    </div>
                  </div>
                )) : <p className="subtle">No repeat loser shape yet. Once losses start rhyming, this will surface the recurring pattern.</p>}
              </div>
            </div>

            <div className="intel-card">
              <div className="subpanel-header">
                <div>
                  <span className="detail-label">Expectancy drift review</span>
                  <p className="subtle">Compare the latest tape against the broader paper baseline so drift shows up fast.</p>
                </div>
                <span className={`status-pill tone-${paperPerformance.expectancyDrift.severity}`}>{paperPerformance.expectancyDrift.headline}</span>
              </div>

              <div className="execution-summary-grid compact-score-grid">
                <ExecutionSummaryCard
                  label={`Recent ${paperPerformance.expectancyDrift.recent.sampleSize || paperPerformance.expectancyDrift.recentWindow}`}
                  value={paperPerformance.expectancyDrift.recent.expectancyPerTrade === null ? '--' : signedPct(paperPerformance.expectancyDrift.recent.expectancyPerTrade)}
                  detail={paperPerformance.expectancyDrift.recent.sampleSize ? `${paperPerformance.expectancyDrift.recent.wins} wins · ${paperPerformance.expectancyDrift.recent.totalRealizedPnl >= 0 ? '+' : ''}${signedPct(Math.abs(paperPerformance.expectancyDrift.recent.totalRealizedPnl)).replace(/^[+\-]?/, '')} total realized`.replace('++', '+') : 'Need recent closes.'}
                  toneClass={paperPerformance.expectancyDrift.recent.expectancyPerTrade === null ? undefined : paperPerformance.expectancyDrift.recent.expectancyPerTrade >= 0 ? 'positive' : 'negative'}
                />
                <ExecutionSummaryCard
                  label={`Baseline ${paperPerformance.expectancyDrift.baseline.sampleSize || paperPerformance.expectancyDrift.baselineWindow}`}
                  value={paperPerformance.expectancyDrift.baseline.expectancyPerTrade === null ? '--' : signedPct(paperPerformance.expectancyDrift.baseline.expectancyPerTrade)}
                  detail={paperPerformance.expectancyDrift.baseline.sampleSize ? `${paperPerformance.expectancyDrift.baseline.winRate === null ? '--' : pct(paperPerformance.expectancyDrift.baseline.winRate)} win rate over the broader tape.` : 'Need broader baseline.'}
                  toneClass={paperPerformance.expectancyDrift.baseline.expectancyPerTrade === null ? undefined : paperPerformance.expectancyDrift.baseline.expectancyPerTrade >= 0 ? 'positive' : 'negative'}
                />
                <ExecutionSummaryCard
                  label="Drift / trade"
                  value={paperPerformance.expectancyDrift.driftPerTrade === null ? '--' : signedPct(paperPerformance.expectancyDrift.driftPerTrade)}
                  detail={paperPerformance.expectancyDrift.detail}
                  toneClass={paperPerformance.expectancyDrift.driftPerTrade === null ? undefined : paperPerformance.expectancyDrift.driftPerTrade >= 0 ? 'positive' : 'negative'}
                />
                <ExecutionSummaryCard
                  label="Recent win rate"
                  value={paperPerformance.expectancyDrift.recent.winRate === null ? '--' : pct(paperPerformance.expectancyDrift.recent.winRate)}
                  detail={paperPerformance.expectancyDrift.recent.sampleSize ? `${paperPerformance.expectancyDrift.recent.sampleSize} closes in the current drift window.` : 'Need recent closes.'}
                  toneClass={paperPerformance.expectancyDrift.recent.winRate === null ? undefined : paperPerformance.expectancyDrift.recent.winRate >= 0.5 ? 'positive' : 'negative'}
                />
              </div>

              <div className="stack-list compact-review-list">
                <div className="stack-row review-row">
                  <div>
                    <div className="source-title-row">
                      <strong>{paperPerformance.expectancyDrift.headline}</strong>
                      <span className={`status-pill tone-${paperPerformance.expectancyDrift.severity}`}>{paperPerformance.expectancyDrift.driftDirection.replace('-', ' ')}</span>
                    </div>
                    <p>{paperPerformance.expectancyDrift.detail}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="stack-list">
            {paperPerformance.bySetupType.length ? paperPerformance.bySetupType.map((bucket) => (
              <div className="stack-row review-row" key={bucket.key}>
                <div>
                  <div className="source-title-row">
                    <strong>{setupTypeLabel(bucket.key)}</strong>
                    <span className="status-pill tone-muted">{bucket.total} tracked</span>
                  </div>
                  <p>{bucket.closed ? `${pct(bucket.winRate ?? 0)} win rate · ${signedPct(bucket.totalRealizedPnl)} realized · ${signedPct(bucket.totalMarkedPnl)} marked.` : `No closed trades yet, ${bucket.open} active and ${bucket.queued} queued.`}</p>
                </div>
                <div className="source-metrics">
                  <small>Avg edge {bucket.avgEntryEdge === null ? '--' : signedPct(bucket.avgEntryEdge)}</small>
                  <small>Avg realized {bucket.avgRealizedPnl === null ? '--' : signedPct(bucket.avgRealizedPnl)}</small>
                </div>
              </div>
            )) : <p className="subtle">Queue or close paper trades to unlock setup-level review.</p>}
          </div>

          <div className="review-diagnostics-grid">
            <div className="intel-card">
              <div className="subpanel-header">
                <div>
                  <span className="detail-label">Edge buckets</span>
                  <p className="subtle">Which sizes of scanner edge are actually paying.</p>
                </div>
              </div>
              <div className="stack-list compact-review-list">
                {paperPerformance.byEdgeBucket.length ? paperPerformance.byEdgeBucket.map((bucket) => (
                  <div className="stack-row review-row" key={bucket.key}>
                    <div>
                      <div className="source-title-row">
                        <strong>{bucket.label}</strong>
                        <span className="status-pill tone-muted">{bucket.total} tracked</span>
                      </div>
                      <p>{bucket.closed ? `${pct(bucket.winRate ?? 0)} win rate · ${signedPct(bucket.totalRealizedPnl)} realized.` : `No closed trades yet, ${bucket.open} active and ${bucket.queued} queued.`}</p>
                    </div>
                    <div className="source-metrics">
                      <small>Avg edge {bucket.avgEntryEdge === null ? '--' : signedPct(bucket.avgEntryEdge)}</small>
                      <small>Avg realized {bucket.avgRealizedPnl === null ? '--' : signedPct(bucket.avgRealizedPnl)}</small>
                    </div>
                  </div>
                )) : <p className="subtle">Close trades to see whether bigger entry gaps are earning better outcomes.</p>}
              </div>
            </div>

            <div className="intel-card">
              <div className="subpanel-header">
                <div>
                  <span className="detail-label">Setup bias slices</span>
                  <p className="subtle">A cleaner read on whether side selection and confidence quality are helping or hurting.</p>
                </div>
              </div>
              <div className="exposure-grid">
                <PerformanceSliceColumn title="By direction" buckets={paperPerformance.byDirection} />
                <PerformanceSliceColumn title="By confidence" buckets={paperPerformance.byConfidenceBucket} />
              </div>
            </div>

            <div className="intel-card">
              <div className="subpanel-header">
                <div>
                  <span className="detail-label">What seems to work</span>
                  <p className="subtle">Fast read on top and bottom areas, with simple desk lessons.</p>
                </div>
              </div>
              <div className="execution-summary-grid compact-score-grid">
                <ExecutionSummaryCard
                  label="Best setup"
                  value={paperPerformance.diagnostics.bestSetup?.label ?? '--'}
                  detail={paperPerformance.diagnostics.bestSetup ? `${signedPct(paperPerformance.diagnostics.bestSetup.totalRealizedPnl)} realized across ${paperPerformance.diagnostics.bestSetup.closed} closes.` : 'Need closed trades.'}
                  toneClass={paperPerformance.diagnostics.bestSetup && paperPerformance.diagnostics.bestSetup.totalRealizedPnl >= 0 ? 'positive' : undefined}
                />
                <ExecutionSummaryCard
                  label="Weakest setup"
                  value={paperPerformance.diagnostics.weakestSetup?.label ?? '--'}
                  detail={paperPerformance.diagnostics.weakestSetup ? `${signedPct(paperPerformance.diagnostics.weakestSetup.totalRealizedPnl)} realized across ${paperPerformance.diagnostics.weakestSetup.closed} closes.` : 'Need closed trades.'}
                  toneClass={paperPerformance.diagnostics.weakestSetup && paperPerformance.diagnostics.weakestSetup.totalRealizedPnl < 0 ? 'negative' : undefined}
                />
                <ExecutionSummaryCard
                  label="Best direction"
                  value={paperPerformance.diagnostics.bestDirection?.label ?? '--'}
                  detail={paperPerformance.diagnostics.bestDirection ? `${signedPct(paperPerformance.diagnostics.bestDirection.totalRealizedPnl)} realized.` : 'Need closed trades.'}
                  toneClass={paperPerformance.diagnostics.bestDirection && paperPerformance.diagnostics.bestDirection.totalRealizedPnl >= 0 ? 'positive' : undefined}
                />
                <ExecutionSummaryCard
                  label="Weakest direction"
                  value={paperPerformance.diagnostics.weakestDirection?.label ?? '--'}
                  detail={paperPerformance.diagnostics.weakestDirection ? `${signedPct(paperPerformance.diagnostics.weakestDirection.totalRealizedPnl)} realized.` : 'Need closed trades.'}
                  toneClass={paperPerformance.diagnostics.weakestDirection && paperPerformance.diagnostics.weakestDirection.totalRealizedPnl < 0 ? 'negative' : undefined}
                />
                <ExecutionSummaryCard
                  label="Best confidence"
                  value={paperPerformance.diagnostics.strongestConfidenceBucket?.label ?? '--'}
                  detail={paperPerformance.diagnostics.strongestConfidenceBucket ? `${pct(paperPerformance.diagnostics.strongestConfidenceBucket.winRate ?? 0)} win rate.` : 'Need closed trades.'}
                  toneClass={paperPerformance.diagnostics.strongestConfidenceBucket && paperPerformance.diagnostics.strongestConfidenceBucket.totalRealizedPnl >= 0 ? 'positive' : undefined}
                />
                <ExecutionSummaryCard
                  label="Weakest confidence"
                  value={paperPerformance.diagnostics.weakestConfidenceBucket?.label ?? '--'}
                  detail={paperPerformance.diagnostics.weakestConfidenceBucket ? `${signedPct(paperPerformance.diagnostics.weakestConfidenceBucket.totalRealizedPnl)} realized.` : 'Need closed trades.'}
                  toneClass={paperPerformance.diagnostics.weakestConfidenceBucket && paperPerformance.diagnostics.weakestConfidenceBucket.totalRealizedPnl < 0 ? 'negative' : undefined}
                />
              </div>

              <div className="stack-list compact-review-list">
                {paperPerformance.diagnostics.patterns.map((pattern) => (
                  <div className="stack-row" key={pattern.title}>
                    <div>
                      <div className="source-title-row">
                        <strong>{pattern.title}</strong>
                        <span className={`status-pill tone-${pattern.tone}`}>Pattern</span>
                      </div>
                      <p>{pattern.detail}</p>
                    </div>
                  </div>
                ))}
                {paperPerformance.diagnostics.lessons.length ? paperPerformance.diagnostics.lessons.map((lesson) => (
                  <div className="stack-row" key={lesson}>
                    <div>
                      <div className="source-title-row">
                        <strong>Post-trade lesson</strong>
                        <span className="status-pill tone-good">Lesson</span>
                      </div>
                      <p>{lesson}</p>
                    </div>
                  </div>
                )) : <p className="subtle">Lessons will appear once enough trades have been tracked.</p>}
              </div>
            </div>

            <div className="intel-card">
              <div className="subpanel-header">
                <div>
                  <span className="detail-label">Setup family pressure map</span>
                  <p className="subtle">Push winning families harder and flag losing families before they keep draining expectancy.</p>
                </div>
              </div>

              <div className="stack-list compact-review-list">
                <div className="source-title-row review-list-header">
                  <strong>Validation gate</strong>
                  <span className={`status-pill tone-${paperValidationGate.botTrust.status === 'trusted' ? 'good' : paperValidationGate.botTrust.status === 'restricted' ? 'bad' : 'warn'}`}>{paperValidationGate.botTrust.status}</span>
                </div>
                <p className="subtle">Promotion requires {paperValidationGate.policy.minClosedTradesForPromotion}+ closes and {signedPct(paperValidationGate.policy.promotionExpectancyPerTrade)} expectancy/trade. Full trust requires {paperValidationGate.policy.minClosedTradesForTrust}+ closes, {signedPct(paperValidationGate.policy.trustExpectancyPerTrade)} expectancy/trade, and healthy family outcomes.</p>
                <div className="stack-row review-row">
                  <div>
                    <div className="source-title-row">
                      <strong>Desk automation status</strong>
                      <span className={`status-pill ${automationGateTone(paperValidationGate.botTrust.automationAllowed, paperValidationGate.botTrust.status)}`}>{paperValidationGate.botTrust.automationAllowed ? 'open' : 'blocked'}</span>
                    </div>
                    <p>{paperValidationGate.botTrust.note}</p>
                    {paperValidationGate.botTrust.blockers.length ? <small className="subtle">Blocking now: {paperValidationGate.botTrust.blockers.join(' ')}</small> : <small className="subtle">Sample, expectancy, and family health all currently support normal automation.</small>}
                  </div>
                  <div className="source-metrics">
                    <small>{milestoneLabel(paperValidationGate.botTrust.milestones.sample.current, paperValidationGate.botTrust.milestones.sample.target)} desk closes</small>
                    <small>{paperValidationGate.botTrust.expectancyPerTrade === null ? '--' : signedPct(paperValidationGate.botTrust.expectancyPerTrade)} expectancy</small>
                    <small>{paperValidationGate.botTrust.trustedFamilies} trusted families</small>
                    <small>{paperValidationGate.botTrust.promotedFamilies} promoted families</small>
                  </div>
                </div>
                {paperValidationGate.setupFamilies.length ? paperValidationGate.setupFamilies.map((family) => (
                  <div className="stack-row review-row" key={`gate-${family.key}`}>
                    <div>
                      <div className="source-title-row">
                        <strong>{setupTypeLabel(family.key as WeatherMarket['resolutionSchema']['kind'])}</strong>
                        <span className={`status-pill ${family.status === 'trusted' ? 'tone-good' : family.status === 'promoted' ? 'tone-warn' : family.status === 'demoted' || family.status === 'disabled' ? 'tone-bad' : 'tone-muted'}`}>{family.status}</span>
                        <span className={`status-pill ${automationGateTone(family.automationAllowed, family.status)}`}>{family.automationAllowed ? 'automation open' : 'automation blocked'}</span>
                      </div>
                      <p>{family.note}</p>
                      {family.blockers.length ? <small className="subtle">Blocking now: {family.blockers.join(' ')}</small> : <small className="subtle">This family has earned enough sample and expectancy to participate in automation.</small>}
                    </div>
                    <div className="source-metrics">
                      <small>{family.closedCount} closes</small>
                      <small>{milestoneLabel(family.milestones.promotionSample.current, family.milestones.promotionSample.target)} to promote</small>
                      <small>{milestoneLabel(family.milestones.trustSample.current, family.milestones.trustSample.target)} to trust</small>
                      <small>{family.winRate === null ? '--' : pct(family.winRate)} win rate</small>
                      <small>{family.expectancyPerTrade === null ? '--' : signedPct(family.expectancyPerTrade)} expectancy</small>
                      <small>{family.health}</small>
                    </div>
                  </div>
                )) : <p className="subtle">No setup family has enough paper history for a promotion or demotion call yet.</p>}
              </div>

              <div className="stack-list compact-review-list">
                <div className="source-title-row review-list-header">
                  <strong>Kill suggestions</strong>
                  <span className="status-pill tone-warn">Guardrails</span>
                </div>
                {paperPerformance.diagnostics.setupKillSuggestions.length ? paperPerformance.diagnostics.setupKillSuggestions.map((suggestion) => (
                  <div className="stack-row review-row" key={suggestion.key}>
                    <div>
                      <div className="source-title-row">
                        <strong>{setupTypeLabel(suggestion.setupType)}</strong>
                        <span className={`status-pill ${suggestion.severity === 'disable' ? 'tone-bad' : 'tone-warn'}`}>{suggestion.severity}</span>
                      </div>
                      <p>{suggestion.rationale}</p>
                      <small className="subtle">{suggestion.action}</small>
                    </div>
                    <div className="source-metrics">
                      <small>{suggestion.tradeCount} closes</small>
                      <small>{suggestion.lossCount} losses</small>
                      <small>{suggestion.winRate === null ? '--' : pct(suggestion.winRate)} win rate</small>
                      <small>{signedPct(suggestion.totalRealizedPnl)} realized</small>
                    </div>
                  </div>
                )) : <p className="subtle">No setup family is weak enough yet to recommend downgrading or disabling.</p>}
              </div>

              <div className="ops-split-grid">
                <div className="stack-list compact-review-list">
                  <div className="source-title-row review-list-header">
                    <strong>Winning families</strong>
                    <span className="status-pill tone-good">Leaders</span>
                  </div>
                  {paperPerformance.setupFamilyHeat.leaders.length ? paperPerformance.setupFamilyHeat.leaders.map((bucket) => (
                    <div className="stack-row review-row" key={`leader-${bucket.key}`}>
                      <div>
                        <div className="source-title-row">
                          <strong>{setupTypeLabel(bucket.key as WeatherMarket['resolutionSchema']['kind'])}</strong>
                          <span className="status-pill tone-good">{bucket.trendLabel}</span>
                        </div>
                        <p>{bucket.closed} closes · {bucket.winRate === null ? '--' : pct(bucket.winRate)} win rate · {bucket.expectancyPerTrade === null ? '--' : signedPct(bucket.expectancyPerTrade)} expectancy/trade.</p>
                      </div>
                    </div>
                  )) : <p className="subtle">Need closed trades before setup families can separate cleanly.</p>}
                </div>

                <div className="stack-list compact-review-list">
                  <div className="source-title-row review-list-header">
                    <strong>Losing families</strong>
                    <span className="status-pill tone-bad">Laggards</span>
                  </div>
                  {paperPerformance.setupFamilyHeat.laggards.length ? paperPerformance.setupFamilyHeat.laggards.map((bucket) => (
                    <div className="stack-row review-row" key={`laggard-${bucket.key}`}>
                      <div>
                        <div className="source-title-row">
                          <strong>{setupTypeLabel(bucket.key as WeatherMarket['resolutionSchema']['kind'])}</strong>
                          <span className={`status-pill tone-${bucket.expectancyPerTrade !== null && bucket.expectancyPerTrade < 0 ? 'bad' : 'warn'}`}>{bucket.trendLabel}</span>
                        </div>
                        <p>{bucket.closed} closes · {bucket.winRate === null ? '--' : pct(bucket.winRate)} win rate · {bucket.expectancyPerTrade === null ? '--' : signedPct(bucket.expectancyPerTrade)} expectancy/trade.</p>
                      </div>
                    </div>
                  )) : <p className="subtle">No lagging family identified yet.</p>}
                </div>
              </div>
            </div>
          </div>

          <div className="review-diagnostics-grid after-action-grid">
            <div className="intel-card">
              <div className="subpanel-header">
                <div>
                  <span className="detail-label">After-action queue</span>
                  <p className="subtle">Pick a tracked trade and review what actually drove the result.</p>
                </div>
                <span className="badge soft">{afterActionReviews.length} tracked</span>
              </div>
              <div className="stack-list compact-review-list review-selector-list">
                {afterActionReviews.length ? afterActionReviews.map((review) => (
                  <button key={review.marketId} type="button" className={`review-selector ${selectedAfterActionReview?.marketId === review.marketId ? 'selected' : ''}`} onClick={() => setSelectedReviewMarketId(review.marketId)}>
                    <div>
                      <div className="source-title-row">
                        <strong>{review.marketTitle}</strong>
                        <span className={`status-pill ${reviewVerdictToneClass(review.verdict)}`}>{review.verdict.replace('-', ' ')}</span>
                      </div>
                      <p>{review.headline}</p>
                    </div>
                    <div className="source-metrics">
                      <small>{review.outcome.toUpperCase()}</small>
                      <small>Score {review.score}/100</small>
                    </div>
                  </button>
                )) : <p className="subtle">Track a few trades and this becomes your local post-trade desk review.</p>}
              </div>
            </div>

            <div className="intel-card">
              <div className="subpanel-header">
                <div>
                  <span className="detail-label">Actionable trade review</span>
                  <p className="subtle">Focus on decision quality, not just the outcome.</p>
                </div>
                {selectedAfterActionReview && <span className={`status-pill ${reviewVerdictToneClass(selectedAfterActionReview.verdict)}`}>Score {selectedAfterActionReview.score}/100</span>}
              </div>

              {selectedAfterActionReview ? (
                <div className="stack-list after-action-detail">
                  <div className="score-card">
                    <span>Review headline</span>
                    <strong>{selectedAfterActionReview.headline}</strong>
                    <p>{selectedAfterActionReview.summary}</p>
                  </div>

                  <div className="execution-summary-grid compact-score-grid">
                    <ExecutionSummaryCard label="Outcome" value={selectedAfterActionReview.outcome.toUpperCase()} detail={selectedAfterActionReview.marketTitle} toneClass={selectedAfterActionReview.outcome === 'win' ? 'positive' : selectedAfterActionReview.outcome === 'loss' ? 'negative' : undefined} />
                    <ExecutionSummaryCard label="Verdict" value={selectedAfterActionReview.verdict.replace('-', ' ').toUpperCase()} detail="Process quality, not just PnL." toneClass={reviewVerdictTextClass(selectedAfterActionReview.verdict)} />
                  </div>

                  <ReviewListCard title="Why this trade ended this way" tone="good" items={selectedAfterActionReview.why} emptyLabel="Add more tracked history to sharpen causal review." />
                  <ReviewListCard title="What to keep" tone="good" items={selectedAfterActionReview.strengths} emptyLabel="No clear strengths yet." />
                  <ReviewListCard title="Warnings" tone="bad" items={selectedAfterActionReview.warnings} emptyLabel="No major warnings flagged." />
                  <ReviewListCard title="Refine next time" tone="warn" items={selectedAfterActionReview.refineNextTime} emptyLabel="No refinement ideas yet." />

                  <div className="stack-list compact-review-list">
                    {selectedAfterActionReview.timeline.map((step) => (
                      <div className="stack-row review-row" key={step.label}>
                        <div>
                          <div className="source-title-row">
                            <strong>{step.label}</strong>
                            <span className="status-pill tone-muted">{step.at ? formatClock(step.at) : 'N/A'}</span>
                          </div>
                          <p>{step.detail}</p>
                        </div>
                        <div className="source-metrics">
                          <small>{step.at ? formatDateTime(step.at) : 'No timestamp'}</small>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : <p className="subtle">No tracked paper trades yet.</p>}
            </div>
          </div>
        </section>

        <section className="footer-strip">
          <div className="panel summary-card">
            <span className="summary-label">Primary objective</span>
            <strong>{topTrade?.title ?? 'Waiting for scan'}</strong>
            <span className="subtle">{topTrade ? `${topTrade.dataOrigin === 'curated-watchlist' ? 'Scenario only' : 'Live contract'} · ${signedPct(topTrade.edge)} edge · ${pct(topTrade.confidence)} confidence.` : 'The first scan is still loading.'}</span>
          </div>
          <div className="panel summary-card">
            <span className="summary-label">Signal volume</span>
            <strong>{allAlerts.length} recent alerts</strong>
            <span className="subtle">{allAlerts[0]?.detail ?? 'Alerts appear once scans can be compared.'}</span>
          </div>
          <div className="panel summary-card">
            <span className="summary-label">Working tickets</span>
            <strong>{Object.values(paperOrders).flat().filter((order) => order.status === 'working' || order.status === 'partial').length} staged</strong>
            <span className="subtle">{Object.values(paperOrders).flat().find((order) => order.status === 'working' || order.status === 'partial')?.marketTitle ?? 'No active paper orders waiting in the book.'}</span>
          </div>
          <div className="panel summary-card">
            <span className="summary-label">Paper outcomes</span>
            <strong>{performanceHeadline}</strong>
            <span className="subtle">{paperPerformance.totals.closed ? `${pct(paperPerformance.totals.winRate ?? 0)} win rate · ${signedPct(paperPerformance.totals.totalRealizedPnl)} realized.` : 'Close a few paper trades to start scoring your edge.'}</span>
          </div>
          <div className="panel summary-card">
            <span className="summary-label">Coverage</span>
            <strong>{meta ? `${meta.livePolymarketEventCount} events scanned` : 'Scanning now'}</strong>
            <span className="subtle">{meta ? `${meta.totalPolymarketMarketsScanned} total markets checked.` : 'Connecting to live feeds.'}</span>
          </div>
        </section>
      </main>
    </div>
  );
}

function Metric({ label, value, positive }: { label: string; value: string; positive?: boolean }) {
  return (
    <div className="metric-card">
      <span>{label}</span>
      <strong className={positive === undefined ? '' : positive ? 'positive' : 'negative'}>{value}</strong>
    </div>
  );
}

function SignalCell({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="signal-cell">
      <span>{label}</span>
      <strong className={tone ?? ''}>{value}</strong>
    </div>
  );
}

function ActionCard({ title, body, emphasis }: { title: string; body: string; emphasis?: boolean }) {
  return (
    <div className={`operator-card ${emphasis ? 'emphasis-card' : ''}`}>
      <span>{title}</span>
      <strong>{body}</strong>
    </div>
  );
}

function PaperExecutionSettingsForm({
  settings,
  onChange,
  compact,
}: {
  settings: PaperExecutionSettings;
  onChange: <K extends keyof PaperExecutionSettings>(key: K, value: PaperExecutionSettings[K]) => void;
  compact?: boolean;
}) {
  return (
    <div className={`tuning-grid paper-settings-grid ${compact ? 'compact-form' : ''}`}>
      <label>
        <span>Base size</span>
        <input type="range" min="1" max="10" step="1" value={settings.unitSize} onChange={(event) => onChange('unitSize', Number(event.target.value))} />
        <strong>{settings.unitSize} units</strong>
      </label>
      <label>
        <span>Max size</span>
        <input type="range" min="1" max="20" step="1" value={settings.maxUnits} onChange={(event) => onChange('maxUnits', Number(event.target.value))} />
        <strong>{settings.maxUnits} units</strong>
      </label>
      <label>
        <span>Slippage</span>
        <input type="range" min="0" max="200" step="5" value={settings.slippageBps} onChange={(event) => onChange('slippageBps', Number(event.target.value))} />
        <strong>{settings.slippageBps} bps</strong>
      </label>
      <label>
        <span>Fill source</span>
        <select value={settings.fillReference} onChange={(event) => onChange('fillReference', event.target.value as PaperExecutionSettings['fillReference'])}>
          <option value="ask">Ask</option>
          <option value="mid">Mid</option>
          <option value="bid">Bid</option>
          <option value="last">Last</option>
        </select>
        <strong>{settings.fillReference.toUpperCase()}</strong>
      </label>
    </div>
  );
}

function HistoryRow({ snapshot }: { snapshot: MarketHistorySnapshot }) {
  return (
    <div className="stack-row history-row">
      <div>
        <strong>{formatDateTime(snapshot.capturedAt)}</strong>
        <p>Market {pct(snapshot.impliedProbability)} · Model edge {signedPct(snapshot.edge)} · Confidence {pct(snapshot.confidence)}</p>
      </div>
      <span>{freshnessLabel(snapshot.freshnessMinutes)}</span>
    </div>
  );
}

function ExecutionSummaryCard({ label, value, detail, toneClass }: { label: string; value: string; detail: string; toneClass?: string }) {
  return (
    <div className="score-card execution-summary-card">
      <span>{label}</span>
      <strong className={toneClass ?? ''}>{value}</strong>
      <p>{detail}</p>
    </div>
  );
}

function ExposureColumn({ title, buckets }: { title: string; buckets: ExposureBucket[] }) {
  return (
    <div className="stack-list compact-review-list">
      <div className="source-title-row review-list-header">
        <strong>{title}</strong>
        <span className="status-pill tone-muted">{buckets.length}</span>
      </div>
      {buckets.length ? buckets.map((bucket) => (
        <div className="stack-row review-row" key={bucket.key}>
          <div>
            <div className="source-title-row">
              <strong>{bucket.label}</strong>
              <span className="status-pill tone-muted">{bucket.units}u</span>
            </div>
            <p>{bucket.markets} market{bucket.markets > 1 ? 's' : ''} · {bucket.active}u active · {bucket.queued}u queued</p>
          </div>
        </div>
      )) : <p className="subtle">No tracked exposure yet.</p>}
    </div>
  );
}

function PerformanceSliceColumn({ title, buckets }: { title: string; buckets: PaperPerformanceBucket[] }) {
  return (
    <div className="stack-list compact-review-list">
      <div className="source-title-row review-list-header">
        <strong>{title}</strong>
        <span className="status-pill tone-muted">{buckets.length}</span>
      </div>
      {buckets.length ? buckets.map((bucket) => (
        <div className="stack-row review-row" key={bucket.key}>
          <div>
            <div className="source-title-row">
              <strong>{bucket.label}</strong>
              <span className="status-pill tone-muted">{bucket.total} tracked</span>
            </div>
            <p>{bucket.closed ? `${pct(bucket.winRate ?? 0)} win rate · ${signedPct(bucket.totalRealizedPnl)} realized.` : `No closed trades yet, ${bucket.open} active and ${bucket.queued} queued.`}</p>
          </div>
          <div className="source-metrics">
            <small>{bucket.closed} closed</small>
            <small>Avg {bucket.avgRealizedPnl === null ? '--' : signedPct(bucket.avgRealizedPnl)}</small>
          </div>
        </div>
      )) : <p className="subtle">No tracked slices yet.</p>}
    </div>
  );
}

function ReviewListCard({ title, items, tone, emptyLabel }: { title: string; items: string[]; tone: 'good' | 'warn' | 'bad'; emptyLabel: string }) {
  return (
    <div className="intel-card">
      <div className="source-title-row review-list-header">
        <strong>{title}</strong>
        <span className={`status-pill tone-${tone}`}>{items.length} notes</span>
      </div>
      <ul>
        {items.length ? items.map((item) => <li key={item}>{item}</li>) : <li>{emptyLabel}</li>}
      </ul>
    </div>
  );
}

function paperDecisionLabel(decision: 'would-trade' | 'watch' | 'no-trade') {
  if (decision === 'would-trade') return 'Deploy';
  if (decision === 'watch') return 'Monitor';
  return 'Hold';
}

function paperDecisionToneClass(decision: 'would-trade' | 'watch' | 'no-trade') {
  if (decision === 'would-trade') return 'tone-good';
  if (decision === 'watch') return 'tone-warn';
  return 'tone-muted';
}

function paperDirectionLabel(direction: 'buy-yes' | 'buy-no' | 'stand-aside') {
  if (direction === 'buy-yes') return 'Bias YES';
  if (direction === 'buy-no') return 'Bias NO';
  return 'Stand aside';
}

function statusLabel(status: MarketStatus) {
  if (status === 'best') return 'Priority alpha';
  if (status === 'watch') return 'Watch sector';
  if (status === 'candidate') return 'Scenario lane';
  if (status === 'stale') return 'Signal aging';
  return 'Low priority';
}

function statusToneClass(status: MarketStatus) {
  if (status === 'best') return 'tone-good';
  if (status === 'watch' || status === 'candidate') return 'tone-warn';
  if (status === 'stale') return 'tone-bad';
  return 'tone-muted';
}

function quoteToneClass(status: QuoteStatus) {
  if (status === 'tight' || status === 'tradable') return 'tone-good';
  if (status === 'wide' || status === 'stale') return 'tone-warn';
  return 'tone-bad';
}

function paperStateToneClass(state?: PaperPositionState) {
  if (state === 'active') return 'positive';
  if (state === 'queued') return 'tone-warn';
  if (state === 'closed') return 'tone-muted';
  return 'tone-muted';
}

function setupTypeLabel(value: string) {
  if (value === 'temperatureMax') return 'Temperature max';
  if (value === 'windSpeed') return 'Wind speed';
  if (value === 'namedStorm') return 'Named storm';
  if (value === 'precipitation') return 'Precipitation';
  return 'Other';
}

function reviewVerdictToneClass(verdict: PaperAfterActionReview['verdict']) {
  if (verdict === 'excellent' || verdict === 'solid') return 'tone-good';
  if (verdict === 'mixed') return 'tone-warn';
  return 'tone-bad';
}

function reviewVerdictTextClass(verdict: PaperAfterActionReview['verdict']) {
  if (verdict === 'excellent' || verdict === 'solid') return 'positive';
  if (verdict === 'needs-work') return 'negative';
  return undefined;
}

function streakLabel(direction: 'win' | 'loss' | 'flat' | 'mixed', count: number) {
  if (!count || direction === 'mixed') return 'Mixed';
  if (direction === 'win') return `${count}W streak`;
  if (direction === 'loss') return `${count}L streak`;
  return `${count} flat`;
}

export default App;
