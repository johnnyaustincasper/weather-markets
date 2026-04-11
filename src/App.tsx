import { useCallback, useEffect, useMemo, useState } from 'react';
import { localMarketProvider } from './services/marketData';
import { captureMarketHistory, getMarketHistory, getWatcherOverview, summarizeMarketTrend, type MarketHistorySnapshot, type MetricTrend } from './services/marketHistory';
import type { MarketFeedMeta, WeatherMarket } from './types';

const WATCH_STORAGE_KEY = 'weather-markets-watchlist';
const REFRESH_MS = 90_000;
const MAX_ALERTS = 18;

const pct = (value: number) => `${Math.round(value * 100)}%`;
const signedPct = (value: number) => `${value >= 0 ? '+' : ''}${Math.round(value * 100)} pts`;
const quotePct = (value: number | null | undefined) => (value === null || value === undefined ? '--' : pct(value));
const signedQuotePct = (value: number | null | undefined) => (value === null || value === undefined ? '--' : `${value >= 0 ? '+' : ''}${Math.round(value * 100)} pts`);
const freshnessLabel = (minutes: number) => {
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
};
const formatClock = (iso?: string) => {
  if (!iso) return '--';
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
};

type MarketStatus = 'live' | 'watch' | 'stale' | 'cold';
type AlertTone = 'good' | 'warn' | 'bad';
type AlertKind = 'edge' | 'confidence' | 'spread' | 'freshness' | 'status';

type MarketAlert = {
  id: string;
  marketId: string;
  marketTitle: string;
  kind: AlertKind;
  tone: AlertTone;
  summary: string;
  detail: string;
  action: string;
  createdAt: string;
};

type MarketDelta = {
  edgeDelta: number;
  confidenceDelta: number;
  disagreementDelta: number;
  freshnessDelta: number;
  statusFrom: MarketStatus;
  statusTo: MarketStatus;
  alerts: MarketAlert[];
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

const toneForAlert = (kind: AlertKind, magnitude: number): AlertTone => {
  if (kind === 'freshness' || kind === 'status') return magnitude >= 1 ? 'warn' : 'bad';
  if (magnitude >= 0.08) return 'good';
  if (magnitude >= 0.04) return 'warn';
  return 'bad';
};

const deriveMarketStatus = (market: WeatherMarket, watched: boolean): MarketStatus => {
  if (market.freshnessMinutes >= 240) return 'cold';
  if (market.freshnessMinutes >= 90 || market.confidence < 0.5) return 'stale';
  if (watched || Math.abs(market.edge) >= 0.08 || market.confidence >= 0.74) return 'watch';
  return 'live';
};

const buildMarketAlerts = (current: WeatherMarket, previous: WeatherMarket | undefined, watched: boolean): MarketDelta => {
  const statusTo = deriveMarketStatus(current, watched);
  const statusFrom = previous ? deriveMarketStatus(previous, watched) : statusTo;
  const edgeDelta = current.edge - (previous?.edge ?? current.edge);
  const confidenceDelta = current.confidence - (previous?.confidence ?? current.confidence);
  const disagreementDelta = current.disagreement - (previous?.disagreement ?? current.disagreement);
  const freshnessDelta = current.freshnessMinutes - (previous?.freshnessMinutes ?? current.freshnessMinutes);
  const alerts: MarketAlert[] = [];

  if (previous) {
    if (Math.abs(edgeDelta) >= 0.04) {
      const improved = Math.abs(current.edge) > Math.abs(previous.edge);
      alerts.push({
        id: `${current.id}-edge-${current.lastUpdated}`,
        marketId: current.id,
        marketTitle: current.title,
        kind: 'edge',
        tone: improved ? toneForAlert('edge', Math.abs(edgeDelta)) : 'warn',
        summary: improved ? 'Edge spike' : 'Edge retraced',
        detail: `Edge moved from ${signedPct(previous.edge)} to ${signedPct(current.edge)} (${signedPct(edgeDelta)}).`,
        action: improved ? 'Re-rank this contract and confirm weather thesis still holds.' : 'Trim conviction, market may have already caught up.',
        createdAt: current.lastUpdated,
      });
    }

    if (Math.abs(confidenceDelta) >= 0.06) {
      const rising = confidenceDelta > 0;
      alerts.push({
        id: `${current.id}-confidence-${current.lastUpdated}`,
        marketId: current.id,
        marketTitle: current.title,
        kind: 'confidence',
        tone: rising ? toneForAlert('confidence', Math.abs(confidenceDelta)) : 'warn',
        summary: rising ? 'Confidence improved' : 'Confidence slipped',
        detail: `Confidence changed from ${pct(previous.confidence)} to ${pct(current.confidence)}.`,
        action: rising ? 'Promote for faster review or add to watch.' : 'Audit disagreement and feed quality before acting.',
        createdAt: current.lastUpdated,
      });
    }

    if (Math.abs(disagreementDelta) >= 0.05) {
      const compressed = disagreementDelta < 0;
      alerts.push({
        id: `${current.id}-spread-${current.lastUpdated}`,
        marketId: current.id,
        marketTitle: current.title,
        kind: 'spread',
        tone: compressed ? 'good' : 'warn',
        summary: compressed ? 'Spread compressed' : 'Spread expanded',
        detail: `Forecast disagreement moved from ${pct(previous.disagreement)} to ${pct(current.disagreement)}.`,
        action: compressed ? 'Cleaner setup, check whether price still lags.' : 'Desk should slow down until source disagreement settles.',
        createdAt: current.lastUpdated,
      });
    }

    if (freshnessDelta >= 20) {
      alerts.push({
        id: `${current.id}-freshness-${current.lastUpdated}`,
        marketId: current.id,
        marketTitle: current.title,
        kind: 'freshness',
        tone: current.freshnessMinutes >= 180 ? 'bad' : 'warn',
        summary: 'Freshness deteriorated',
        detail: `Data aged from ${freshnessLabel(previous.freshnessMinutes)} to ${freshnessLabel(current.freshnessMinutes)}.`,
        action: 'Treat this as monitor-only until newer weather or market prints arrive.',
        createdAt: current.lastUpdated,
      });
    }

    if (statusFrom !== statusTo) {
      alerts.push({
        id: `${current.id}-status-${current.lastUpdated}`,
        marketId: current.id,
        marketTitle: current.title,
        kind: 'status',
        tone: statusTo === 'watch' || statusTo === 'live' ? 'good' : 'warn',
        summary: 'Status changed',
        detail: `Scanner posture moved from ${statusFrom.toUpperCase()} to ${statusTo.toUpperCase()}.`,
        action: statusTo === 'watch' ? 'Add review notes and keep this on the board.' : 'Reassess whether this still deserves attention.',
        createdAt: current.lastUpdated,
      });
    }
  }

  return {
    edgeDelta,
    confidenceDelta,
    disagreementDelta,
    freshnessDelta,
    statusFrom,
    statusTo,
    alerts,
  };
};

function App() {
  const [markets, setMarkets] = useState<WeatherMarket[]>([]);
  const [previousMarkets, setPreviousMarkets] = useState<Record<string, WeatherMarket>>({});
  const [meta, setMeta] = useState<MarketFeedMeta | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');
  const [watchIds, setWatchIds] = useState<string[]>(() => loadWatchIds());
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastScanAt, setLastScanAt] = useState<string>('');
  const [historyTick, setHistoryTick] = useState(0);

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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load weather markets.');
    } finally {
      setLoading(false);
      setRefreshing(false);
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
    const interval = window.setInterval(() => {
      void fetchMarkets(true);
    }, REFRESH_MS);

    return () => window.clearInterval(interval);
  }, [fetchMarkets]);

  const selectedMarket = useMemo(
    () => markets.find((market) => market.id === selectedId) ?? markets[0],
    [markets, selectedId],
  );

  const watchSet = useMemo(() => new Set(watchIds), [watchIds]);

  const marketDeltas = useMemo(() => {
    return Object.fromEntries(markets.map((market) => [market.id, buildMarketAlerts(market, previousMarkets[market.id], watchSet.has(market.id))]));
  }, [markets, previousMarkets, watchSet]);

  const allAlerts = useMemo(() => {
    return Object.values(marketDeltas)
      .flatMap((item) => item.alerts)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, MAX_ALERTS);
  }, [marketDeltas]);

  const topEdge = useMemo(() => Math.max(...markets.map((market) => Math.abs(market.edge)), 0), [markets]);
  const avgConfidence = useMemo(() => {
    if (!markets.length) return 0;
    return markets.reduce((sum, market) => sum + market.confidence, 0) / markets.length;
  }, [markets]);
  const watcherOverview = useMemo(() => getWatcherOverview(), [historyTick]);
  const selectedTrend = useMemo(() => selectedMarket ? summarizeMarketTrend(selectedMarket.id) : null, [selectedMarket, historyTick]);
  const selectedHistory = useMemo(() => selectedMarket ? getMarketHistory(selectedMarket.id)?.snapshots ?? [] : [], [selectedMarket, historyTick]);
  const watchCount = watchIds.filter((id) => markets.some((market) => market.id === id)).length;
  const deterioratingCount = markets.filter((market) => (marketDeltas[market.id]?.freshnessDelta ?? 0) >= 20).length;
  const actionCount = allAlerts.filter((alert) => alert.tone !== 'bad').length;

  const toggleWatch = (marketId: string) => {
    setWatchIds((current) => current.includes(marketId) ? current.filter((id) => id !== marketId) : [...current, marketId]);
  };

  return (
    <div className="app-shell">
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />
      <main className="dashboard">
        <section className="hero panel">
          <div>
            <p className="eyebrow">Weather Markets</p>
            <h1>Discover live weather markets, then act on what actually changed.</h1>
            <p className="subtle hero-copy">
              The scanner now diffs each refresh locally, flags edge and confidence moves, warns when disagreement or freshness worsens, and keeps a watch-focused queue for the desk.
            </p>
            <div className="hero-status-row">
              <span className="badge">{meta ? `${meta.livePolymarketEventCount} weather events discovered` : 'Loading feeds'}</span>
              <span className="badge soft">{meta ? `${meta.livePolymarketWeatherCount} event markets flattened` : 'Flattening events'}</span>
              <span className="badge soft">{meta ? `${allAlerts.length} notable changes` : 'Scanning for changes'}</span>
              {selectedMarket && <span className="badge soft">Status {marketDeltas[selectedMarket.id]?.statusTo.toUpperCase() ?? 'LIVE'}</span>}
            </div>
          </div>
          <div className="hero-metrics">
            <Metric label="Displayed candidates" value={String(markets.length).padStart(2, '0')} />
            <Metric label="Watchlist" value={String(watchCount).padStart(2, '0')} positive={watchCount > 0} />
            <Metric label="Best absolute edge" value={signedPct(topEdge)} positive={topEdge > 0} />
            <Metric label="Average confidence" value={pct(avgConfidence)} />
          </div>
        </section>

        {error && <section className="panel error-panel">{error}</section>}
        {loading && <section className="panel loading-panel">Refreshing live market and weather feeds…</section>}

        <section className="summary-grid">
          <div className="panel summary-card">
            <span className="summary-label">Action queue</span>
            <strong>{actionCount} reviewable alerts</strong>
            <span className="subtle">{allAlerts[0]?.marketTitle ?? 'Waiting for the first delta snapshot.'}</span>
          </div>
          <div className="panel summary-card">
            <span className="summary-label">Feed posture</span>
            <strong>{deterioratingCount} markets losing freshness</strong>
            <span className="subtle">Last local scan {formatClock(lastScanAt || meta?.refreshedAt)}</span>
          </div>
          <div className="panel summary-card">
            <span className="summary-label">Watcher memory</span>
            <strong>{watcherOverview.snapshotsStored} local snapshots stored</strong>
            <span className="subtle">{watcherOverview.risingEdgeCount} names improving edge, {watcherOverview.tighteningSpreadCount} seeing tighter spread.</span>
          </div>
        </section>

        <section className="content-grid">
          <div className="panel table-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Candidates</p>
                <h2>Opportunity board</h2>
              </div>
              <div className="table-actions">
                <span className="badge">{meta?.weatherSourceMix.join(' · ') ?? 'Live feeds'}</span>
                <button className="refresh-button" onClick={() => void fetchMarkets(true)} disabled={loading || refreshing}>
                  {refreshing ? 'Refreshing…' : 'Refresh scan'}
                </button>
              </div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Market</th>
                    <th>Status</th>
                    <th>Watch</th>
                    <th>Edge</th>
                    <th>Confidence</th>
                    <th>Spread</th>
                    <th>Freshness</th>
                  </tr>
                </thead>
                <tbody>
                  {markets.map((market) => {
                    const delta = marketDeltas[market.id];
                    const isWatched = watchSet.has(market.id);
                    return (
                      <tr
                        key={market.id}
                        className={market.id === selectedMarket?.id ? 'active-row' : ''}
                        onClick={() => setSelectedId(market.id)}
                      >
                        <td>
                          <div className="market-cell">
                            <strong>{market.title}</strong>
                            <span>{market.location} · {market.expiry}</span>
                            <div className="inline-flags">
                              {delta.alerts.slice(0, 2).map((alert) => (
                                <span key={alert.id} className={`status-chip tone-${alert.tone}`}>{alert.summary}</span>
                              ))}
                            </div>
                          </div>
                        </td>
                        <td>
                          <span className={`status-chip ${statusToneClass(delta.statusTo)}`}>
                            {delta.statusTo.toUpperCase()}
                          </span>
                        </td>
                        <td>
                          <button
                            className={`watch-toggle ${isWatched ? 'active' : ''}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleWatch(market.id);
                            }}
                          >
                            {isWatched ? 'Watching' : 'Watch'}
                          </button>
                        </td>
                        <td>
                          <div className="delta-cell">
                            <span className={market.edge >= 0 ? 'positive' : 'negative'}>{signedPct(market.edge)}</span>
                            <small className={delta.edgeDelta >= 0 ? 'positive' : 'negative'}>{previousMarkets[market.id] ? signedPct(delta.edgeDelta) : 'New'}</small>
                          </div>
                        </td>
                        <td>
                          <div className="delta-cell">
                            <span>{pct(market.confidence)}</span>
                            <small className={delta.confidenceDelta >= 0 ? 'positive' : 'negative'}>{previousMarkets[market.id] ? signedPct(delta.confidenceDelta) : 'New'}</small>
                          </div>
                        </td>
                        <td>
                          <div className="delta-cell">
                            <span>{pct(market.disagreement)}</span>
                            <small className={delta.disagreementDelta <= 0 ? 'positive' : 'negative'}>{previousMarkets[market.id] ? signedPct(delta.disagreementDelta) : 'New'}</small>
                          </div>
                        </td>
                        <td>
                          <div className="delta-cell">
                            <span>{freshnessLabel(market.freshnessMinutes)}</span>
                            <small className={delta.freshnessDelta > 0 ? 'negative' : 'positive'}>{previousMarkets[market.id] ? `${delta.freshnessDelta >= 0 ? '+' : ''}${delta.freshnessDelta}m` : 'New'}</small>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="card-list">
              {markets.map((market) => {
                const delta = marketDeltas[market.id];
                const isWatched = watchSet.has(market.id);
                return (
                  <button
                    key={market.id}
                    className={`market-card ${market.id === selectedMarket?.id ? 'selected' : ''}`}
                    onClick={() => setSelectedId(market.id)}
                  >
                    <div className="market-card-top">
                      <span className={`pill ${statusToneClass(delta.statusTo)}`}>{delta.statusTo.toUpperCase()}</span>
                      <span className={market.edge >= 0 ? 'positive' : 'negative'}>{signedPct(market.edge)}</span>
                    </div>
                    <strong>{market.title}</strong>
                    <p>{market.discovery.schemaLabel}</p>
                    <div className="market-card-metrics">
                      <span>{pct(market.confidence)} confidence</span>
                      <span>{pct(market.disagreement)} spread</span>
                      <span>{freshnessLabel(market.freshnessMinutes)}</span>
                    </div>
                    <div className="market-card-actions">
                      <span className="subtle">{delta.alerts[0]?.summary ?? 'No new alert yet'}</span>
                      <span className={`watch-inline ${isWatched ? 'active' : ''}`}>{isWatched ? 'Watching' : 'Tap detail to watch'}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="detail-stack">
            <section className="panel detail-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Market detail</p>
                  <h2>{selectedMarket?.title ?? 'Select a market'}</h2>
                </div>
                <div className="table-actions">
                  {selectedMarket && (
                    <button
                      className={`watch-toggle ${watchSet.has(selectedMarket.id) ? 'active' : ''}`}
                      onClick={() => toggleWatch(selectedMarket.id)}
                    >
                      {watchSet.has(selectedMarket.id) ? 'Watching' : 'Add to watch'}
                    </button>
                  )}
                  <span className="badge soft">{selectedMarket?.dataOrigin === 'polymarket-event' || selectedMarket?.dataOrigin === 'polymarket-live' ? 'Discovered from Gamma weather events' : 'Schema fallback'}</span>
                </div>
              </div>
              {selectedMarket && (
                <>
                  <div className="detail-badges">
                    <span className={`status-chip ${statusToneClass(marketDeltas[selectedMarket.id]?.statusTo ?? 'live')}`}>Status {marketDeltas[selectedMarket.id]?.statusTo.toUpperCase()}</span>
                    {marketDeltas[selectedMarket.id]?.alerts.slice(0, 3).map((alert) => (
                      <span key={alert.id} className={`status-chip tone-${alert.tone}`}>{alert.summary}</span>
                    ))}
                  </div>
                  <div className="detail-metrics">
                    <Metric label="Implied" value={pct(selectedMarket.impliedProbability)} />
                    <Metric label="Model" value={pct(selectedMarket.modelProbability)} />
                    <Metric label="Edge" value={signedPct(selectedMarket.edge)} positive={selectedMarket.edge >= 0} />
                    <Metric label="24h volume" value={selectedMarket.volume24h} />
                  </div>
                  {selectedMarket.clobQuote && (
                    <div className="detail-metrics">
                      <Metric label="CLOB bid" value={quotePct(selectedMarket.clobQuote.bestBid)} />
                      <Metric label="CLOB ask" value={quotePct(selectedMarket.clobQuote.bestAsk)} />
                      <Metric label="CLOB mid" value={quotePct(selectedMarket.clobQuote.midpoint)} />
                      <Metric label="Spread" value={quotePct(selectedMarket.clobQuote.spread)} />
                    </div>
                  )}
                  <div className="operator-grid">
                    <ActionCard
                      title="Primary move"
                      body={marketDeltas[selectedMarket.id]?.alerts[0]?.detail ?? 'Initial local snapshot captured. Next refresh will surface change alerts.'}
                    />
                    <ActionCard
                      title="Desk action"
                      body={marketDeltas[selectedMarket.id]?.alerts[0]?.action ?? 'Watch this market if the desk wants a standing alert on the next scan delta.'}
                      emphasis
                    />
                  </div>
                  {selectedTrend && (
                    <div>
                      <span className="detail-label">Persistent watcher deltas</span>
                      <div className="trend-grid">
                        <TrendMetric label="Implied" trend={selectedTrend.impliedProbability} formatter={pct} deltaFormatter={signedPct} />
                        <TrendMetric label="Edge" trend={selectedTrend.edge} formatter={signedPct} deltaFormatter={signedPct} />
                        <TrendMetric label="Confidence" trend={selectedTrend.confidence} formatter={pct} deltaFormatter={signedPct} />
                        <TrendMetric label="Spread" trend={selectedTrend.spread} formatter={quotePct} deltaFormatter={signedQuotePct} />
                      </div>
                    </div>
                  )}
                  <div className="detail-copy">
                    <div>
                      <span className="detail-label">Discovery</span>
                      <p>{selectedMarket.discovery.hasExchangeContract ? 'Discovered directly from a live Gamma weather event market.' : 'No live contract confidently matched, so the fallback schema remains active.'}</p>
                    </div>
                    <div>
                      <span className="detail-label">Schema</span>
                      <p>{selectedMarket.discovery.schemaLabel}</p>
                    </div>
                    <div>
                      <span className="detail-label">Heuristic summary</span>
                      <p>{selectedMarket.heuristicSummary}</p>
                    </div>
                    <div>
                      <span className="detail-label">Resolution</span>
                      <p>{selectedMarket.resolution}</p>
                    </div>
                    <div>
                      <span className="detail-label">Desk notes</span>
                      <p>{selectedMarket.notes}</p>
                    </div>
                    {selectedMarket.clobQuote && (
                      <div>
                        <span className="detail-label">CLOB quote</span>
                        <p>
                          Outcome {selectedMarket.clobQuote.outcome} on token {selectedMarket.clobQuote.tokenId.slice(0, 10)}…,
                          last trade {quotePct(selectedMarket.clobQuote.lastTradePrice)},
                          tick {selectedMarket.clobQuote.tickSize ?? '--'}.
                        </p>
                      </div>
                    )}
                  </div>
                </>
              )}
            </section>

            <section className="panel history-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Watcher history</p>
                  <h2>Recent local snapshots</h2>
                </div>
                <span className="badge soft">{selectedTrend?.snapshotCount ?? 0} captures</span>
              </div>
              {selectedHistory.length ? (
                <div className="history-list">
                  {selectedHistory.slice().reverse().map((snapshot, index) => (
                    <HistoryRow key={`${snapshot.capturedAt}-${index}`} snapshot={snapshot} />
                  ))}
                </div>
              ) : (
                <p className="subtle">History appears once this market has been scanned locally and then revisited on a later refresh.</p>
              )}
            </section>

            <section className="panel comparison-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Scanner alerts</p>
                  <h2>What changed on this board</h2>
                </div>
                <span className="badge soft">Local only, no notifications sent</span>
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
                      <span>{alert.action}</span>
                      <small>{formatClock(alert.createdAt)}</small>
                    </div>
                  </div>
                )) : (
                  <div className="source-row">
                    <div>
                      <strong>Awaiting delta history</strong>
                      <p>The first snapshot is loaded. Alerts will appear after the next refresh when the scanner has something to compare.</p>
                    </div>
                    <div className="source-metrics">
                      <span>Pin markets now so the desk is ready for the next change.</span>
                    </div>
                  </div>
                )}
              </div>
            </section>

            <section className="panel scoring-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Scoring</p>
                  <h2>Why this ranks here</h2>
                </div>
              </div>
              {selectedMarket && (
                <div className="score-grid">
                  <div className="score-card">
                    <span>Parse confidence</span>
                    <strong>{pct(selectedMarket.discovery.parseConfidence)}</strong>
                    <p>How confidently the rule was mapped into a structured weather schema.</p>
                  </div>
                  <div className="score-card">
                    <span>Confidence</span>
                    <strong>{pct(selectedMarket.confidence)}</strong>
                    <p>Confidence rises with freshness and source agreement.</p>
                  </div>
                  <div className="score-card">
                    <span>Disagreement</span>
                    <strong>{pct(selectedMarket.disagreement)}</strong>
                    <p>The scanner treats this as spread and alerts when it compresses or widens materially.</p>
                  </div>
                  <div className="score-card">
                    <span>Freshness</span>
                    <strong>{freshnessLabel(selectedMarket.freshnessMinutes)}</strong>
                    <p>Freshness deterioration is watched across scans and can demote a market's status.</p>
                  </div>
                  <div className="score-card full">
                    <span>Heuristic inputs</span>
                    <ul>
                      <li>Threshold: {selectedMarket.heuristicDetails.thresholdLabel}</li>
                      <li>Observed: {selectedMarket.heuristicDetails.observedValue === null ? 'n/a' : `${Math.round(selectedMarket.heuristicDetails.observedValue * 10) / 10} ${selectedMarket.heuristicDetails.units}`}</li>
                      <li>Weather score: {pct(selectedMarket.heuristicDetails.weatherScore)}</li>
                      <li>Recency score: {pct(selectedMarket.heuristicDetails.recencyScore)}</li>
                      <li>Source agreement: {pct(selectedMarket.heuristicDetails.sourceAgreement)}</li>
                      <li>Canonical query: {selectedMarket.discovery.canonicalQuery}</li>
                      {selectedMarket.discovery.eventTitle && <li>Event: {selectedMarket.discovery.eventTitle}</li>}
                      {selectedMarket.conditionId && <li>Condition ID: {selectedMarket.conditionId}</li>}
                      {selectedMarket.clobTokenIds?.length ? <li>CLOB token IDs: {selectedMarket.clobTokenIds.join(', ')}</li> : null}
                      {selectedMarket.outcomes?.length ? <li>Outcomes: {selectedMarket.outcomes.join(' / ')}</li> : null}
                      {selectedMarket.outcomePrices?.length ? <li>Outcome prices: {selectedMarket.outcomePrices.map((price) => pct(price)).join(' / ')}</li> : null}
                    </ul>
                  </div>
                  <div className="score-card full muted-card">
                    <span>Main risks</span>
                    <ul>
                      {selectedMarket.risks.map((item) => <li key={item}>{item}</li>)}
                    </ul>
                  </div>
                </div>
              )}
            </section>
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

function TrendMetric({
  label,
  trend,
  formatter,
  deltaFormatter,
}: {
  label: string;
  trend: MetricTrend;
  formatter: (value: number) => string;
  deltaFormatter: (value: number) => string;
}) {
  const tone = trend.direction === 'up' ? 'positive' : trend.direction === 'down' ? 'negative' : '';

  return (
    <div className="score-card">
      <span>{label}</span>
      <strong>{trend.current === null ? '--' : formatter(trend.current)}</strong>
      <p className={tone}>{trend.delta === null ? 'Need another snapshot' : deltaFormatter(trend.delta)}</p>
    </div>
  );
}

function HistoryRow({ snapshot }: { snapshot: MarketHistorySnapshot }) {
  return (
    <div className="history-row">
      <div>
        <strong>{new Date(snapshot.capturedAt).toLocaleString()}</strong>
        <p>Implied {pct(snapshot.impliedProbability)} · Edge {signedPct(snapshot.edge)} · Confidence {pct(snapshot.confidence)}</p>
      </div>
      <span>Spread {quotePct(snapshot.spread)}</span>
    </div>
  );
}

function statusToneClass(status: MarketStatus) {
  if (status === 'watch') return 'tone-good';
  if (status === 'stale') return 'tone-warn';
  if (status === 'cold') return 'tone-bad';
  return 'tone-muted';
}

export default App;
