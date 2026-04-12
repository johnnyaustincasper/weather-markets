import { useCallback, useEffect, useMemo, useState } from 'react';
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
} from './services/paperBlotter';
import { buildPaperTradePlan, type PaperPositionState } from './services/paperTrading';
import { cancelPaperOrder, getPaperOrders, placePaperOrder, syncPaperOrders, type PaperOrder } from './services/paperOrders';
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
  isFirestorePersistenceEnabled,
  loadPersistentPaperState,
  persistPaperState,
} from './services/paperPersistence';
import { createPaperBotLoopState } from './services/paperBotLoop';
import { getFirebaseProjectId } from './lib/firebase';
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
  const [paperOrderDrafts, setPaperOrderDrafts] = useState<Record<string, { quantity: number; limitPrice: number; note: string }>>({});
  const [paperRepriceMeta, setPaperRepriceMeta] = useState<{ at: string; changedCount: number } | null>(null);
  const [selectedReviewMarketId, setSelectedReviewMarketId] = useState('');
  const [persistenceStatus, setPersistenceStatus] = useState<{ mode: 'local' | 'firestore'; detail: string }>({
    mode: isFirestorePersistenceEnabled() ? 'firestore' : 'local',
    detail: isFirestorePersistenceEnabled()
      ? `Firestore ledger ${DEFAULT_PAPER_LEDGER_ID} in project ${getFirebaseProjectId()}.`
      : 'Browser-local paper ledger. Add Firebase env vars to enable durable backend persistence.',
  });

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

    void (async () => {
      if (!isFirestorePersistenceEnabled()) return;
      try {
        const result = await loadPersistentPaperState(DEFAULT_PAPER_LEDGER_ID);
        if (!active || !result.state) {
          if (active) {
            setPersistenceStatus({
              mode: 'firestore',
              detail: `Firestore is configured for ${getFirebaseProjectId()}, no remote paper ledger found yet so local state will seed it.`,
            });
          }
          return;
        }

        setWatchIds(result.state.watchIds);
        setPaperState(result.state.paperState);
        setPaperExecutionProfile(result.state.paperExecutionProfile);
        setPaperBlotter(result.state.paperBlotter);
        setPaperOrders(result.state.paperOrders);
        setPersistenceStatus({
          mode: 'firestore',
          detail: `Hydrated paper ledger from Firestore (${getFirebaseProjectId()}/${DEFAULT_PAPER_LEDGER_ID}).`,
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
  }, []);

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
    if (!isFirestorePersistenceEnabled()) return;

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
              lastHydratedAt: new Date().toISOString(),
              lastPersistedAt: null,
            }),
            syncedAt: new Date().toISOString(),
            source: 'local',
          }, DEFAULT_PAPER_LEDGER_ID);

          if (!result.persisted) return;
          setPersistenceStatus({
            mode: 'firestore',
            detail: `Persisting paper ledger to Firestore (${getFirebaseProjectId()}/${DEFAULT_PAPER_LEDGER_ID}).`,
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
  }, [watchIds, paperState, paperExecutionProfile, paperBlotter, paperOrders]);

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
      <main className="command-deck">
        <section className="panel mission-hero">
          <div className="hero-callout">
            <div className="eyebrow-row">
              <p className="eyebrow">WX-2060 strategic command deck</p>
              <span className={`status-pill ${error ? 'tone-bad' : showingFallbackFirst || meta?.usedCuratedFallback ? 'tone-warn' : 'tone-good'}`}>{error ? 'Feed degraded' : showingFallbackFirst || meta?.usedCuratedFallback ? 'Scenario-first mode' : 'Live tactical mode'}</span>
            </div>
            <h1>Map weather-market campaigns like an operator, not a spreadsheet.</h1>
            <p className="hero-copy subtle">This deck scans live weather contracts, compares exchange pricing against weather models, and lets you develop full paper-trade plans with execution controls, change tracking, and scenario discipline.</p>
            <div className="hero-ribbon">
              <span className="badge soft">Last scan {formatClock(lastScanAt || meta?.refreshedAt)}</span>
              <span className="badge soft">{meta ? `${meta.livePolymarketWeatherCount} live contracts on scope` : 'Building scope'}</span>
              <span className="badge soft">Sources {meta?.weatherSourceMix.join(' · ') ?? 'Live feeds'}</span>
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

        {error && <section className="panel system-banner tone-bad"><strong>System advisory</strong><span>{error}</span></section>}
        <section className={`panel system-banner ${persistenceStatus.mode === 'firestore' ? 'tone-good' : 'tone-warn'}`}>
          <strong>{persistenceStatus.mode === 'firestore' ? 'Backend persistence online' : 'Local-only persistence'}</strong>
          <span>{persistenceStatus.detail}</span>
        </section>
        {loading && <section className="panel system-banner"><strong>Mission board loading</strong><span>Pulling contracts, quotes, and weather-model inputs.</span></section>}

        <section className="panel ops-priority-panel">
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
          <section className="panel theater-panel">
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
            <section className="panel command-panel">
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
                          <button className="command-button" onClick={handlePlacePaperOrder}>Stage order</button>
                        </div>
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

            <section className="panel telemetry-panel">
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

        <section className="panel review-panel portfolio-panel">
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

        <section className="panel review-panel">
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
                  label="Best edge bucket"
                  value={paperPerformance.diagnostics.strongestEdgeBucket?.label ?? '--'}
                  detail={paperPerformance.diagnostics.strongestEdgeBucket ? `${pct(paperPerformance.diagnostics.strongestEdgeBucket.winRate ?? 0)} win rate.` : 'Need closed trades.'}
                  toneClass={paperPerformance.diagnostics.strongestEdgeBucket && paperPerformance.diagnostics.strongestEdgeBucket.totalRealizedPnl >= 0 ? 'positive' : undefined}
                />
                <ExecutionSummaryCard
                  label="Weakest edge bucket"
                  value={paperPerformance.diagnostics.weakestEdgeBucket?.label ?? '--'}
                  detail={paperPerformance.diagnostics.weakestEdgeBucket ? `${signedPct(paperPerformance.diagnostics.weakestEdgeBucket.totalRealizedPnl)} realized.` : 'Need closed trades.'}
                  toneClass={paperPerformance.diagnostics.weakestEdgeBucket && paperPerformance.diagnostics.weakestEdgeBucket.totalRealizedPnl < 0 ? 'negative' : undefined}
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
