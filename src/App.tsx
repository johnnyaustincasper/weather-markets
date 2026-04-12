import { useCallback, useEffect, useMemo, useState } from 'react';
import { getMockMarkets } from './data/mockMarkets';
import { applyQuoteRefreshToMarket, localMarketProvider } from './services/marketData';
import {
  getPaperBlotter,
  repricePaperBlotter,
  summarizePaperPerformance,
  syncPaperBlotter,
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

  useEffect(() => {
    setPaperBlotter(syncPaperBlotter(displayMarkets, paperState, paperPlans, paperExecutionProfile));
    setPaperOrders(syncPaperOrders(displayMarkets).orders);
  }, [displayMarkets, paperExecutionProfile, paperPlans, paperState]);

  const liveTradeCount = displayMarkets.filter((market) => market.dataOrigin !== 'curated-watchlist' && paperPlans[market.id]?.decision === 'would-trade').length;
  const watchCount = displayMarkets.filter((market) => market.dataOrigin === 'curated-watchlist' || paperPlans[market.id]?.decision === 'watch').length;
  const topTrade = displayMarkets[0];
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

  const selectedPlan = selectedMarket ? paperPlans[selectedMarket.id] : null;
  const selectedDelta = selectedMarket ? marketDeltas[selectedMarket.id] : null;
  const selectedBlotter = selectedMarket ? paperBlotter[selectedMarket.id] : null;
  const selectedPaperState = selectedMarket ? paperState[selectedMarket.id] : null;
  const selectedOrders = selectedMarket ? (paperOrders[selectedMarket.id] ?? []) : [];
  const selectedOrderDraft = selectedMarket && selectedPlan
    ? (paperOrderDrafts[selectedMarket.id] ?? { quantity: selectedPlan.sizing.suggestedUnits, limitPrice: clampOrderPrice(selectedMarket.impliedProbability), note: '' })
    : null;

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
        {loading && <section className="panel system-banner"><strong>Mission board loading</strong><span>Pulling contracts, quotes, and weather-model inputs.</span></section>}

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
                          <button className="command-button" onClick={handlePlacePaperOrder}>Stage order</button>
                        </div>
                        <div className="stack-list compact-orders">
                          {selectedOrders.length ? selectedOrders.map((order) => (
                            <div className="stack-row" key={order.id}>
                              <div>
                                <div className="source-title-row">
                                  <strong>{order.direction === 'buy-yes' ? 'BUY YES' : 'BUY NO'} · {order.quantity}u @ {pct(order.limitPrice)}</strong>
                                  <span className={`status-pill ${order.status === 'filled' ? 'tone-good' : order.status === 'cancelled' ? 'tone-muted' : 'tone-warn'}`}>{order.status.toUpperCase()}</span>
                                </div>
                                <p>{order.note}</p>
                              </div>
                              <div className="source-metrics">
                                <small>{formatDateTime(order.createdAt)}</small>
                                {order.status === 'working' && <button className="command-button" onClick={() => handleCancelPaperOrder(order.id)}>Cancel</button>}
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
            <strong>{Object.values(paperOrders).flat().filter((order) => order.status === 'working').length} staged</strong>
            <span className="subtle">{Object.values(paperOrders).flat().find((order) => order.status === 'working')?.marketTitle ?? 'No active paper orders waiting in the book.'}</span>
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

export default App;
