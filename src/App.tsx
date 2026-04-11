import { useEffect, useMemo, useState } from 'react';
import { localMarketProvider } from './services/marketData';
import type { ForecastSource, MarketFeedMeta, WeatherMarket } from './types';

const pct = (value: number) => `${Math.round(value * 100)}%`;
const signedPct = (value: number) => `${value >= 0 ? '+' : ''}${Math.round(value * 100)} pts`;
const freshnessLabel = (minutes: number) => {
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
};

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));

function scoreMarket(market: WeatherMarket) {
  const edgeScore = clamp(Math.abs(market.edge) / 0.25);
  const freshnessScore = 1 - clamp(market.freshnessMinutes / 720);
  const stabilityScore = 1 - clamp(market.disagreement / 0.4);
  return Math.round((edgeScore * 0.45 + market.confidence * 0.3 + freshnessScore * 0.15 + stabilityScore * 0.1) * 100);
}

function actionLabel(market: WeatherMarket) {
  const lean = market.edge >= 0 ? `Lean ${market.side}` : `Fade ${market.side}`;
  if (market.confidence >= 0.74 && Math.abs(market.edge) >= 0.1 && market.disagreement <= 0.14) return `Act now · ${lean}`;
  if (market.confidence >= 0.6 && Math.abs(market.edge) >= 0.06) return `Stalk entry · ${lean}`;
  return `Monitor only · ${lean}`;
}

function actionTone(market: WeatherMarket) {
  if (market.confidence >= 0.74 && Math.abs(market.edge) >= 0.1 && market.disagreement <= 0.14) return 'good';
  if (market.confidence >= 0.6 && Math.abs(market.edge) >= 0.06) return 'warn';
  return 'muted';
}

function riskStatus(market: WeatherMarket) {
  if (market.freshnessMinutes >= 240 || market.disagreement >= 0.2) return 'High review load';
  if (market.freshnessMinutes >= 120 || market.disagreement >= 0.12) return 'Medium review load';
  return 'Clean read';
}

function riskTone(market: WeatherMarket) {
  if (market.freshnessMinutes >= 240 || market.disagreement >= 0.2) return 'bad';
  if (market.freshnessMinutes >= 120 || market.disagreement >= 0.12) return 'warn';
  return 'good';
}

function freshnessTone(minutes: number) {
  if (minutes >= 240) return 'bad';
  if (minutes >= 120) return 'warn';
  return 'good';
}

function sourceCoverageLabel(market: WeatherMarket) {
  const freshSources = market.sources.filter((source) => source.freshnessMinutes <= 180).length;
  return `${freshSources}/${market.sources.length} sources fresh`;
}

function convictionSummary(market: WeatherMarket) {
  if (market.confidence >= 0.74 && market.disagreement <= 0.12) {
    return 'Sources are aligned enough that edge quality is actionable.';
  }
  if (market.disagreement >= 0.18) {
    return 'Source spread is wide, size down until forecasts converge.';
  }
  if (market.freshnessMinutes >= 180) {
    return 'The setup may still be right, but the data is aging.';
  }
  return 'There is edge here, but it still needs timing discipline.';
}

function explainDriver(market: WeatherMarket) {
  const biggestSource = [...market.sources].sort(
    (a, b) => Math.abs(b.deltaVsMarket) - Math.abs(a.deltaVsMarket),
  )[0];

  if (!biggestSource) return 'No source breakdown available.';

  return `${biggestSource.name} is furthest from market at ${signedPct(biggestSource.deltaVsMarket)}, which is doing most of the ranking work right now.`;
}

function sourceSignalLabel(source: ForecastSource) {
  if (source.signal === 'bullish') return 'Above tape';
  if (source.signal === 'bearish') return 'Below tape';
  return 'Near tape';
}

function App() {
  const [markets, setMarkets] = useState<WeatherMarket[]>([]);
  const [meta, setMeta] = useState<MarketFeedMeta | null>(null);
  const [selectedId, setSelectedId] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    localMarketProvider.getMarkets()
      .then((response) => {
        setMarkets(response.markets);
        setMeta(response.meta);
        setSelectedId(response.markets[0]?.id ?? '');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Unable to load weather markets.'))
      .finally(() => setLoading(false));
  }, []);

  const rankedMarkets = useMemo(
    () => markets.map((market) => ({ market, score: scoreMarket(market) })).sort((a, b) => b.score - a.score),
    [markets],
  );

  const selectedMarket = useMemo(
    () => rankedMarkets.find(({ market }) => market.id === selectedId)?.market ?? rankedMarkets[0]?.market,
    [rankedMarkets, selectedId],
  );

  const topEdge = useMemo(() => Math.max(...markets.map((market) => Math.abs(market.edge)), 0), [markets]);
  const avgConfidence = useMemo(() => {
    if (!markets.length) return 0;
    return markets.reduce((sum, market) => sum + market.confidence, 0) / markets.length;
  }, [markets]);
  const actionNowCount = useMemo(
    () => markets.filter((market) => actionTone(market) === 'good').length,
    [markets],
  );
  const reviewLoadCount = useMemo(
    () => markets.filter((market) => riskTone(market) !== 'good').length,
    [markets],
  );
  const staleCount = useMemo(
    () => markets.filter((market) => market.freshnessMinutes >= 120).length,
    [markets],
  );

  return (
    <div className="app-shell">
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />
      <main className="dashboard">
        <section className="hero panel">
          <div>
            <p className="eyebrow">Weather Markets</p>
            <h1>Operator dashboard for weather mispricings, not just a market list.</h1>
            <p className="subtle hero-copy">
              Rank by trade quality, drill into the thesis, inspect source alignment, and spot when stale or noisy weather inputs should slow you down.
            </p>
            <div className="hero-status-row">
              <span className="badge">{meta ? `${meta.totalPolymarketMarketsScanned} Polymarket markets scanned` : 'Loading feeds'}</span>
              {meta?.usedCuratedFallback && <span className="badge soft">Curated weather watchlist active</span>}
              {selectedMarket && <span className={`badge tone-${freshnessTone(selectedMarket.freshnessMinutes)}`}>Freshness {freshnessLabel(selectedMarket.freshnessMinutes)}</span>}
              {selectedMarket && <span className={`badge tone-${riskTone(selectedMarket)}`}>{riskStatus(selectedMarket)}</span>}
            </div>
          </div>
          <div className="hero-metrics">
            <Metric label="Actionable now" value={String(actionNowCount).padStart(2, '0')} positive={actionNowCount > 0} />
            <Metric label="Best absolute edge" value={signedPct(topEdge)} positive={topEdge > 0} />
            <Metric label="Average confidence" value={pct(avgConfidence)} />
            <Metric label="Needs review" value={String(reviewLoadCount + staleCount).padStart(2, '0')} positive={false} />
          </div>
        </section>

        {error && <section className="panel error-panel">{error}</section>}
        {loading && <section className="panel loading-panel">Refreshing live market and weather feeds…</section>}

        <section className="summary-grid">
          <div className="panel summary-card">
            <span className="summary-label">Desk pulse</span>
            <strong>{rankedMarkets[0] ? `${rankedMarkets[0].score}/100 top opportunity score` : 'Loading...'}</strong>
            <span className="subtle">Weighted for edge, confidence, freshness, and source stability.</span>
          </div>
          <div className="panel summary-card">
            <span className="summary-label">Source dispersion</span>
            <strong>{selectedMarket ? pct(selectedMarket.disagreement) : '0%'}</strong>
            <span className="subtle">Higher dispersion means more forecast conflict and weaker sizing confidence.</span>
          </div>
          <div className="panel summary-card">
            <span className="summary-label">Operator posture</span>
            <strong>{selectedMarket ? actionLabel(selectedMarket) : 'Waiting for feed'}</strong>
            <span className="subtle">Turns model-vs-market gap into a desk action recommendation.</span>
          </div>
        </section>

        <section className="content-grid">
          <div className="panel table-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Candidates</p>
                <h2>Opportunity board</h2>
              </div>
              <span className="badge">{meta?.weatherSourceMix.join(' · ') ?? 'Live feeds'}</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Rank</th>
                    <th>Market</th>
                    <th>Action</th>
                    <th>Score</th>
                    <th>Edge</th>
                    <th>Confidence</th>
                    <th>Sources</th>
                    <th>Risk</th>
                    <th>Freshness</th>
                  </tr>
                </thead>
                <tbody>
                  {rankedMarkets.map(({ market, score }, index) => (
                    <tr
                      key={market.id}
                      className={market.id === selectedMarket?.id ? 'active-row' : ''}
                      onClick={() => setSelectedId(market.id)}
                    >
                      <td>
                        <div className="rank-cell">
                          <strong>#{index + 1}</strong>
                          <span>{market.side}</span>
                        </div>
                      </td>
                      <td>
                        <div className="market-cell">
                          <strong>{market.title}</strong>
                          <span>{market.location} · {market.expiry}</span>
                        </div>
                      </td>
                      <td><span className={`status-chip tone-${actionTone(market)}`}>{actionLabel(market)}</span></td>
                      <td>{score}/100</td>
                      <td className={market.edge >= 0 ? 'positive' : 'negative'}>{signedPct(market.edge)}</td>
                      <td>{pct(market.confidence)}</td>
                      <td>{sourceCoverageLabel(market)}</td>
                      <td><span className={`status-chip tone-${riskTone(market)}`}>{riskStatus(market)}</span></td>
                      <td>{freshnessLabel(market.freshnessMinutes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card-list">
              {rankedMarkets.map(({ market, score }, index) => (
                <button
                  key={market.id}
                  className={`market-card ${market.id === selectedMarket?.id ? 'selected' : ''}`}
                  onClick={() => setSelectedId(market.id)}
                >
                  <div className="market-card-top">
                    <span className="pill">#{index + 1}</span>
                    <span className={`status-chip tone-${actionTone(market)}`}>{actionLabel(market)}</span>
                  </div>
                  <strong>{market.title}</strong>
                  <p>{convictionSummary(market)}</p>
                  <div className="market-card-metrics">
                    <span>Score {score}/100</span>
                    <span className={market.edge >= 0 ? 'positive' : 'negative'}>{signedPct(market.edge)}</span>
                    <span>{freshnessLabel(market.freshnessMinutes)}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="detail-stack">
            <section className="panel detail-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Market detail</p>
                  <h2>{selectedMarket?.title ?? 'Select a market'}</h2>
                </div>
                <span className="badge soft">{selectedMarket?.liquidity ?? '--'} avg liquidity context</span>
              </div>
              {selectedMarket && (
                <>
                  <div className="detail-badges">
                    <span className={`status-chip tone-${actionTone(selectedMarket)}`}>{actionLabel(selectedMarket)}</span>
                    <span className={`status-chip tone-${riskTone(selectedMarket)}`}>{riskStatus(selectedMarket)}</span>
                    <span className={`status-chip tone-${freshnessTone(selectedMarket.freshnessMinutes)}`}>{sourceCoverageLabel(selectedMarket)}</span>
                    <span className="status-chip tone-muted">{selectedMarket.dataOrigin === 'curated-watchlist' ? 'Curated proxy market' : 'Live market mapping'}</span>
                  </div>

                  <div className="detail-metrics">
                    <Metric label="Opportunity score" value={`${scoreMarket(selectedMarket)}/100`} positive={scoreMarket(selectedMarket) >= 70} />
                    <Metric label="Implied" value={pct(selectedMarket.impliedProbability)} />
                    <Metric label="Model" value={pct(selectedMarket.modelProbability)} />
                    <Metric label="Edge" value={signedPct(selectedMarket.edge)} positive={selectedMarket.edge >= 0} />
                    <Metric label="24h volume" value={selectedMarket.volume24h} />
                    <Metric label="Freshness" value={freshnessLabel(selectedMarket.freshnessMinutes)} positive={selectedMarket.freshnessMinutes < 120} />
                  </div>

                  <div className="operator-grid">
                    <div className="operator-card emphasis-card">
                      <span className="detail-label">Recommended desk action</span>
                      <strong>{actionLabel(selectedMarket)}</strong>
                      <p>{convictionSummary(selectedMarket)}</p>
                    </div>
                    <div className="operator-card">
                      <span className="detail-label">What is driving rank</span>
                      <strong>{explainDriver(selectedMarket)}</strong>
                      <p>{selectedMarket.heuristicSummary}</p>
                    </div>
                  </div>

                  <div className="detail-copy">
                    <div>
                      <span className="detail-label">Thesis</span>
                      <p>{selectedMarket.thesis}</p>
                    </div>
                    <div>
                      <span className="detail-label">Resolution / contract framing</span>
                      <p>{selectedMarket.resolution}</p>
                    </div>
                    <div>
                      <span className="detail-label">Desk notes</span>
                      <p>{selectedMarket.notes}</p>
                    </div>
                  </div>

                  <div className="checklist-grid">
                    <div className="checklist-card">
                      <span className="detail-label">Catalysts to watch</span>
                      <ul>
                        {selectedMarket.catalysts.map((item) => <li key={item}>{item}</li>)}
                      </ul>
                    </div>
                    <div className="checklist-card risk-card">
                      <span className="detail-label">Risk flags</span>
                      <ul>
                        {selectedMarket.risks.map((item) => <li key={item}>{item}</li>)}
                      </ul>
                    </div>
                  </div>
                </>
              )}
            </section>

            <section className="panel comparison-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Source comparison</p>
                  <h2>Source visibility and tape gap</h2>
                </div>
              </div>
              <div className="source-list">
                {selectedMarket?.sources.map((source) => (
                  <div className="source-row" key={source.name}>
                    <div>
                      <div className="source-title-row">
                        <strong>{source.name}</strong>
                        <span className={`status-chip tone-${source.signal === 'neutral' ? 'muted' : source.signal === 'bullish' ? 'good' : 'bad'}`}>{sourceSignalLabel(source)}</span>
                      </div>
                      <p>{source.note}</p>
                    </div>
                    <div className="source-metrics">
                      <span>{pct(source.probability)}</span>
                      <span className={source.deltaVsMarket >= 0 ? 'positive' : 'negative'}>{signedPct(source.deltaVsMarket)}</span>
                      <small>{freshnessLabel(source.freshnessMinutes)}</small>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="panel scoring-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Explainability</p>
                  <h2>Why this is ranked here</h2>
                </div>
              </div>
              {selectedMarket && (
                <div className="score-grid">
                  <ScoreCard
                    label="Edge quality"
                    value={signedPct(selectedMarket.edge)}
                    copy="Bigger dislocations between tape and weather blend are more tradable when they stay consistent across sources."
                  />
                  <ScoreCard
                    label="Confidence"
                    value={pct(selectedMarket.confidence)}
                    copy="Confidence rises with fresher inputs and tighter source agreement."
                  />
                  <ScoreCard
                    label="Disagreement"
                    value={pct(selectedMarket.disagreement)}
                    copy="Forecast conflict lowers conviction and should cap size."
                  />
                  <ScoreCard
                    label="Freshness"
                    value={freshnessLabel(selectedMarket.freshnessMinutes)}
                    copy="Aging weather inputs increase the odds the tape catches up before you do."
                  />
                  <div className="score-card full">
                    <span>Heuristic inputs</span>
                    <ul>
                      <li>Threshold: {selectedMarket.heuristicDetails.thresholdLabel}</li>
                      <li>Observed: {selectedMarket.heuristicDetails.observedValue === null ? 'n/a' : `${Math.round(selectedMarket.heuristicDetails.observedValue * 10) / 10} ${selectedMarket.heuristicDetails.units}`}</li>
                      <li>Weather score: {pct(selectedMarket.heuristicDetails.weatherScore)}</li>
                      <li>Recency score: {pct(selectedMarket.heuristicDetails.recencyScore)}</li>
                      <li>Source agreement: {pct(selectedMarket.heuristicDetails.sourceAgreement)}</li>
                    </ul>
                  </div>
                  <div className="score-card full muted-card">
                    <span>Operator takeaway</span>
                    <p>{convictionSummary(selectedMarket)}</p>
                    <p>{explainDriver(selectedMarket)}</p>
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

function ScoreCard({ label, value, copy }: { label: string; value: string; copy: string }) {
  return (
    <div className="score-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <p>{copy}</p>
    </div>
  );
}

export default App;
