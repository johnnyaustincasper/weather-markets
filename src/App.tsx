import { useCallback, useEffect, useMemo, useState } from 'react';
import { getMockMarkets } from './data/mockMarkets';
import { applyQuoteRefreshToMarket, localMarketProvider } from './services/marketData';
import { getPaperBlotter, repricePaperBlotter, syncPaperBlotter, type PaperBlotterEntry } from './services/paperBlotter';
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
  const historyPreview = useMemo(() => selectedHistory.slice().reverse().slice(0, 4), [selectedHistory]);

  useEffect(() => {
    setPaperBlotter(syncPaperBlotter(displayMarkets, paperState, paperPlans, paperExecutionProfile));
    setPaperOrders(syncPaperOrders(displayMarkets).orders);
  }, [displayMarkets, paperExecutionProfile, paperPlans, paperState]);

  const liveTradeCount = displayMarkets.filter((market) => market.dataOrigin !== 'curated-watchlist' && paperPlans[market.id]?.decision === 'would-trade').length;
  const watchCount = displayMarkets.filter((market) => market.dataOrigin === 'curated-watchlist' || paperPlans[market.id]?.decision === 'watch').length;
  const topTrade = displayMarkets[0];
  const paperQueueCount = Object.values(paperState).filter((item) => item.state === 'queued' || item.state === 'active').length;
  const showingFallbackFirst = !liveGoodMatches.length;
  const scanState = error
    ? 'Scanner offline, showing cached state until feeds recover.'
    : loading && !meta
      ? 'Scanning Polymarket and weather feeds for the first ranked trade list.'
      : refreshing
        ? 'Refreshing market odds and model odds now.'
        : showingFallbackFirst || meta?.usedCuratedFallback
          ? 'No strong live contract made the board, so the app is leading with clearly labeled WATCHLIST SETUP candidates until better live listings appear.'
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
    <div className="app-shell">
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />
      <main className="dashboard simple-dashboard">
        <section className="hero panel compact-hero">
          <div>
            <p className="eyebrow">Weather market trade finder</p>
            <h1>Find weather trades where market odds and model odds disagree.</h1>
            <p className="subtle hero-copy">
              The app does three things: scans weather prediction markets, compares market price vs model price, and lets you paper trade the best setups.
            </p>
            <div className="hero-steps">
              <div className="hero-step"><strong>1</strong><span>Scan live contracts</span></div>
              <div className="hero-step"><strong>2</strong><span>Rank the biggest pricing gaps</span></div>
              <div className="hero-step"><strong>3</strong><span>Paper trade the cleanest ideas</span></div>
            </div>
            <div className="hero-status-row">
              <span className={`badge ${error ? 'tone-bad' : showingFallbackFirst || meta?.usedCuratedFallback ? 'tone-warn' : 'tone-good'}`}>{error ? 'Scanner offline' : showingFallbackFirst || meta?.usedCuratedFallback ? 'Fallback-first board' : 'Live board'}</span>
              <span className="badge soft">Last scan {formatClock(lastScanAt || meta?.refreshedAt)}</span>
              <span className="badge soft">{meta ? `${meta.livePolymarketWeatherCount} live contracts found` : 'Building trade list'}</span>
            </div>
            <p className="subtle hero-status-copy">{scanState}</p>
          </div>
          <div className="hero-metrics focus-metrics">
            <Metric label="Best setups now" value={String(liveTradeCount).padStart(2, '0')} positive={liveTradeCount > 0} />
            <Metric label="Watchlist ideas" value={String(watchCount).padStart(2, '0')} positive={watchCount > 0} />
            <Metric label="Top edge" value={topTrade ? signedPct(topTrade.edge) : '--'} positive={(topTrade?.edge ?? 0) >= 0} />
            <Metric label="Paper trades live" value={String(paperQueueCount).padStart(2, '0')} positive={paperQueueCount > 0} />
          </div>
        </section>

        {error && <section className="panel error-panel"><strong>Unable to rank trades right now.</strong><span>{error}</span></section>}
        {loading && <section className="panel loading-panel"><strong>Building trade list…</strong><span>Pulling contracts, quotes, and weather inputs.</span></section>}

        <section className="content-grid core-layout">
          <section className="panel table-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Core trade list</p>
                <h2>Best weather trades right now</h2>
                <p className="subtle panel-intro">Rows are brutally labeled. LIVE CONTRACT means a real exchange listing. WATCHLIST SETUP means a fallback candidate to monitor until a real listing appears.</p>
              </div>
              <div className="table-actions">
                <span className="badge">{meta?.weatherSourceMix.join(' · ') ?? 'Live feeds'}</span>
                <button className="refresh-button" onClick={() => void fetchMarkets(true)} disabled={loading || refreshing}>{refreshing ? 'Refreshing…' : 'Refresh'}</button>
              </div>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Trade</th>
                    <th>Type</th>
                    <th>Market</th>
                    <th>Model</th>
                    <th>Edge</th>
                    <th>Action</th>
                    <th>Freshness</th>
                  </tr>
                </thead>
                <tbody>
                  {displayMarkets.map((market) => {
                    const plan = paperPlans[market.id];
                    const delta = marketDeltas[market.id];
                    const watched = watchSet.has(market.id);
                    return (
                      <tr key={market.id} className={market.id === selectedMarket?.id ? 'active-row' : ''} onClick={() => setSelectedId(market.id)}>
                        <td>
                          <div className="market-cell">
                            <strong>{market.title}</strong>
                            <span>{market.location} · {market.expiry}</span>
                            <div className="inline-flags">
                              <span className={`status-chip ${statusToneClass(delta.status)}`}>{statusLabel(delta.status)}</span>
                              {watched && <span className="status-chip tone-muted">Watching</span>}
                            </div>
                          </div>
                        </td>
                        <td>
                          <div className="market-type-cell">
                            <span className={`status-chip ${market.dataOrigin === 'curated-watchlist' ? 'tone-warn' : 'tone-good'}`}>{market.dataOrigin === 'curated-watchlist' ? 'WATCHLIST SETUP' : 'LIVE CONTRACT'}</span>
                            <small>{market.dataOrigin === 'curated-watchlist' ? 'Not tradeable yet' : 'Real listed market'}</small>
                          </div>
                        </td>
                        <td>{market.dataOrigin === 'curated-watchlist' ? '--' : pct(market.impliedProbability)}</td>
                        <td>{pct(market.modelProbability)}</td>
                        <td>
                          <div className="delta-cell">
                            <span className={market.edge >= 0 ? 'positive' : 'negative'}>{signedPct(market.edge)}</span>
                            <small className={delta.edgeDelta >= 0 ? 'positive' : 'negative'}>{previousMarkets[market.id] ? signedPct(delta.edgeDelta) : 'New'}</small>
                          </div>
                        </td>
                        <td>
                          <span className={`status-chip ${market.dataOrigin === 'curated-watchlist' ? 'tone-warn' : paperDecisionToneClass(plan.decision)}`}>{market.dataOrigin === 'curated-watchlist' ? 'Watchlist only' : paperDecisionLabel(plan.decision)}</span>
                        </td>
                        <td>{freshnessLabel(market.freshnessMinutes)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <div className="detail-stack">
            <section className="panel detail-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Selected trade</p>
                  <h2>{selectedMarket?.title ?? 'Select a trade'}</h2>
                  <p className="subtle panel-intro">A plain-English view of why this row matters, with very clear separation between live contracts and fallback watchlist setups.</p>
                </div>
                {selectedMarket && (
                  <button className={`watch-toggle ${watchSet.has(selectedMarket.id) ? 'active' : ''}`} onClick={() => toggleWatch(selectedMarket.id)}>
                    {watchSet.has(selectedMarket.id) ? 'Watching' : 'Watch'}
                  </button>
                )}
              </div>

              {selectedMarket && selectedPlan && selectedDelta && (
                <>
                  <div className="detail-metrics trade-metrics">
                    <Metric label="Row type" value={selectedMarket.dataOrigin === 'curated-watchlist' ? 'WATCHLIST SETUP' : 'LIVE CONTRACT'} positive={selectedMarket.dataOrigin !== 'curated-watchlist'} />
                    <Metric label="Market odds" value={selectedMarket.dataOrigin === 'curated-watchlist' ? '--' : pct(selectedMarket.impliedProbability)} />
                    <Metric label="Model odds" value={pct(selectedMarket.modelProbability)} />
                    <Metric label="Edge" value={signedPct(selectedMarket.edge)} positive={selectedMarket.edge >= 0} />
                    <Metric label="Paper action" value={selectedMarket.dataOrigin === 'curated-watchlist' ? 'Watchlist only' : paperDecisionLabel(selectedPlan.decision)} positive={selectedPlan.decision === 'would-trade'} />
                  </div>

                  <div className="operator-grid simple-cards">
                    <ActionCard title="Trade direction" body={selectedMarket.dataOrigin === 'curated-watchlist' ? 'Wait for live listing' : paperDirectionLabel(selectedPlan.direction)} emphasis />
                    <ActionCard title="Why it matters" body={selectedPlan.thesis} />
                    <ActionCard title="Entry" body={selectedPlan.entryTrigger} />
                    <ActionCard title="Exit" body={selectedPlan.stopTrigger} />
                  </div>

                  <div className="checklist-grid">
                    <div className="checklist-card">
                      <span className="detail-label">Why it ranks here</span>
                      <ul>
                        {selectedPlan.entryCriteria.map((item) => (
                          <li key={item.label} className={item.passed ? 'positive' : 'negative'}>{item.label}: {item.value}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="checklist-card">
                      <span className="detail-label">What could kill the trade</span>
                      <ul>
                        {(selectedPlan.blockers.length ? selectedPlan.blockers : selectedPlan.exitCriteria).slice(0, 5).map((item) => <li key={item}>{item}</li>)}
                      </ul>
                    </div>
                  </div>

                  <section className="paper-engine-panel minimal-paper-panel">
                    <div className="paper-engine-header">
                      <div>
                        <span className="detail-label">Paper trading</span>
                        <p className="subtle">Track what you would do, without sending real orders. Watchlist setups stay explicitly non-executable.</p>
                      </div>
                      <div className="paper-state-actions">
                        <button className={`watch-toggle ${selectedPaperState?.state === 'flat' ? 'active' : ''}`} onClick={() => setMarketPaperState(selectedMarket.id, 'flat')}>Flat</button>
                        <button className={`watch-toggle ${selectedPaperState?.state === 'queued' ? 'active' : ''}`} onClick={() => setMarketPaperState(selectedMarket.id, 'queued')}>Queue</button>
                        <button className={`watch-toggle ${selectedPaperState?.state === 'active' ? 'active' : ''}`} onClick={() => setMarketPaperState(selectedMarket.id, 'active')}>Active</button>
                        <button className={`watch-toggle ${selectedPaperState?.state === 'closed' ? 'active' : ''}`} onClick={() => setMarketPaperState(selectedMarket.id, 'closed')}>Closed</button>
                      </div>
                    </div>

                    <div className="execution-summary-grid">
                      <ExecutionSummaryCard label="Suggested size" value={`${selectedPlan.sizing.suggestedUnits} units`} detail={selectedPlan.sizing.notionalLabel} />
                      <ExecutionSummaryCard label="Take profit" value={signedPct(paperExecutionProfile.global.takeProfitPts)} detail={selectedPlan.takeProfitTrigger} />
                      <ExecutionSummaryCard label="Stop loss" value={signedPct(paperExecutionProfile.global.stopLossPts)} detail={selectedPlan.stopTrigger} />
                      <ExecutionSummaryCard label="Current state" value={(selectedPaperState?.state ?? 'flat').toUpperCase()} detail={selectedPaperState?.note ?? 'No paper position stored for this trade yet.'} toneClass={paperStateToneClass(selectedPaperState?.state)} />
                    </div>

                    {selectedMarket.dataOrigin !== 'curated-watchlist' && selectedPlan.direction !== 'stand-aside' && selectedOrderDraft && (
                      <div className="checklist-card order-ticket-card">
                        <div className="tuning-header-row">
                          <div>
                            <span className="detail-label">Paper order ticket</span>
                            <p className="subtle">Stage a real limit price instead of just flipping the position state.</p>
                          </div>
                          <span className={`status-chip ${paperDecisionToneClass(selectedPlan.decision)}`}>{paperDirectionLabel(selectedPlan.direction)}</span>
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
                            <span>Note</span>
                            <input type="text" value={selectedOrderDraft.note} placeholder="Why this level?" onChange={(event) => updateOrderDraft(selectedMarket.id, { note: event.target.value })} />
                          </label>
                        </div>
                        <div className="hero-status-row">
                          <span className="badge soft">Live mark {quotePct(selectedMarket.clobQuote?.midpoint ?? selectedMarket.impliedProbability)}</span>
                          <span className="badge soft">Ask {quotePct(selectedMarket.clobQuote?.bestAsk)}</span>
                          <span className="badge soft">Bid {quotePct(selectedMarket.clobQuote?.bestBid)}</span>
                          <button className="watch-toggle" onClick={handlePlacePaperOrder}>Stage order</button>
                        </div>
                        <div className="source-list compact-orders">
                          {selectedOrders.length ? selectedOrders.map((order) => (
                            <div className="source-row" key={order.id}>
                              <div>
                                <div className="source-title-row">
                                  <strong>{order.direction === 'buy-yes' ? 'BUY YES' : 'BUY NO'} · {order.quantity}u @ {pct(order.limitPrice)}</strong>
                                  <span className={`status-chip ${order.status === 'filled' ? 'tone-good' : order.status === 'cancelled' ? 'tone-muted' : 'tone-warn'}`}>{order.status.toUpperCase()}</span>
                                </div>
                                <p>{order.note}</p>
                              </div>
                              <div className="source-metrics">
                                <small>{formatDateTime(order.createdAt)}</small>
                                {order.status === 'working' && <button className="watch-toggle" onClick={() => handleCancelPaperOrder(order.id)}>Cancel</button>}
                              </div>
                            </div>
                          )) : <p className="subtle">No paper orders staged yet for this contract.</p>}
                        </div>
                      </div>
                    )}

                    <div className="mini-settings-row">
                      <PaperExecutionSettingsForm settings={paperExecutionProfile.global} onChange={updateGlobalPaperSetting} compact />
                      <div className="checklist-card">
                        <div className="tuning-header-row">
                          <div>
                            <span className="detail-label">Paper blotter</span>
                            <p className="subtle">Local journal for this browser only.</p>
                          </div>
                          <button className="watch-toggle" onClick={handleRepricePaperBlotter}>Reprice</button>
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

            <section className="panel history-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Recent changes</p>
                  <h2>What moved on this trade</h2>
                </div>
                <div className="table-actions">
                  <span className="badge soft">{selectedTrend?.snapshotCount ?? 0} snapshots</span>
                  <span className={`badge soft ${selectedMarket ? quoteToneClass(selectedMarket.quoteStatus) : ''}`}>{selectedMarket?.dataOrigin === 'curated-watchlist' ? 'WATCHLIST ONLY' : selectedMarket?.quoteStatus?.toUpperCase() ?? 'NO QUOTE'}</span>
                </div>
              </div>
              {selectedMarket && (
                <div className="execution-summary-grid">
                  <ExecutionSummaryCard label="Edge change" value={selectedTrend?.edge.delta == null ? '--' : signedPct(selectedTrend.edge.delta)} detail={`Now ${signedPct(selectedMarket.edge)}`} toneClass={selectedTrend?.edge.delta == null ? undefined : selectedTrend.edge.delta >= 0 ? 'positive' : 'negative'} />
                  <ExecutionSummaryCard label="Confidence change" value={selectedTrend?.confidence.delta == null ? '--' : signedPct(selectedTrend.confidence.delta)} detail={`Now ${pct(selectedMarket.confidence)}`} toneClass={selectedTrend?.confidence.delta == null ? undefined : selectedTrend.confidence.delta >= 0 ? 'positive' : 'negative'} />
                  <ExecutionSummaryCard label="Freshness" value={freshnessLabel(selectedMarket.freshnessMinutes)} detail={selectedTrend?.freshness.delta == null ? 'Need another refresh' : `${selectedTrend.freshness.delta >= 0 ? '+' : ''}${selectedTrend.freshness.delta}m vs first local snapshot`} />
                  <ExecutionSummaryCard label="Spread" value={pct(selectedMarket.disagreement)} detail={selectedMarket.heuristicSummary} />
                </div>
              )}
              <div className="history-list compact-history">
                {selectedMarket?.dataOrigin === 'curated-watchlist'
                  ? <p className="subtle">This row is a fallback watchlist setup, so there is no live contract history yet.</p>
                  : historyPreview.length ? historyPreview.map((snapshot, index) => <HistoryRow key={`${snapshot.capturedAt}-${index}`} snapshot={snapshot} />) : <p className="subtle">History appears after another refresh.</p>}
              </div>
            </section>
          </div>
        </section>

        <section className="summary-grid summary-grid-wide bottom-strip">
          <div className="panel summary-card">
            <span className="summary-label">Top setup now</span>
            <strong>{topTrade?.title ?? 'Waiting for scan'}</strong>
            <span className="subtle">{topTrade ? `${topTrade.dataOrigin === 'curated-watchlist' ? 'WATCHLIST SETUP' : 'LIVE CONTRACT'} · ${signedPct(topTrade.edge)} edge, ${pct(topTrade.confidence)} confidence.` : 'The first scan is still loading.'}</span>
          </div>
          <div className="panel summary-card">
            <span className="summary-label">Scanner alerts</span>
            <strong>{allAlerts.length} recent changes</strong>
            <span className="subtle">{allAlerts[0]?.detail ?? 'Alerts appear once the app can compare one scan against the next.'}</span>
          </div>
          <div className="panel summary-card">
            <span className="summary-label">Working paper orders</span>
            <strong>{Object.values(paperOrders).flat().filter((order) => order.status === 'working').length} staged</strong>
            <span className="subtle">{Object.values(paperOrders).flat().find((order) => order.status === 'working')?.marketTitle ?? 'No active paper orders waiting in the book.'}</span>
          </div>
          <div className="panel summary-card">
            <span className="summary-label">Market coverage</span>
            <strong>{meta ? `${meta.livePolymarketEventCount} events scanned` : 'Scanning now'}</strong>
            <span className="subtle">{meta ? `${meta.totalPolymarketMarketsScanned} total markets checked.` : 'Connecting to live feeds.'}</span>
          </div>
        </section>

        <section className="panel comparison-panel alerts-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Board changes</p>
              <h2>Latest scanner alerts</h2>
            </div>
          </div>
          <div className="source-list">
            {allAlerts.length ? allAlerts.map((alert) => (
              <div className="source-row" key={alert.id}>
                <div>
                  <div className="source-title-row">
                    <strong>{alert.marketTitle}</strong>
                    <span className={`status-chip tone-${alert.tone}`}>{alert.summary}</span>
                  </div>
                  <p>{alert.detail}</p>
                </div>
                <div className="source-metrics">
                  <small>{formatDateTime(alert.createdAt)}</small>
                </div>
              </div>
            )) : (
              <div className="source-row"><p className="subtle">No alerts yet. The next refresh will show what changed.</p></div>
            )}
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
    <div className="history-row">
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
  if (decision === 'would-trade') return 'Paper trade';
  if (decision === 'watch') return 'Watch';
  return 'Pass';
}

function paperDecisionToneClass(decision: 'would-trade' | 'watch' | 'no-trade') {
  if (decision === 'would-trade') return 'tone-good';
  if (decision === 'watch') return 'tone-warn';
  return 'tone-muted';
}

function paperDirectionLabel(direction: 'buy-yes' | 'buy-no' | 'stand-aside') {
  if (direction === 'buy-yes') return 'Buy YES';
  if (direction === 'buy-no') return 'Buy NO';
  return 'Stand aside';
}

function statusLabel(status: MarketStatus) {
  if (status === 'best') return 'Best setup';
  if (status === 'watch') return 'Watch';
  if (status === 'candidate') return 'Fallback candidate';
  if (status === 'stale') return 'Stale';
  return 'Skip';
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

export default App;
