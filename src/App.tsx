import { useEffect, useMemo, useState } from 'react';
import { localMarketProvider } from './services/marketData';
import type { MarketFeedMeta, WeatherMarket } from './types';

const pct = (value: number) => `${Math.round(value * 100)}%`;
const signedPct = (value: number) => `${value >= 0 ? '+' : ''}${Math.round(value * 100)} pts`;
const freshnessLabel = (minutes: number) => {
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
};

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

  const selectedMarket = useMemo(
    () => markets.find((market) => market.id === selectedId) ?? markets[0],
    [markets, selectedId],
  );

  const topEdge = useMemo(() => Math.max(...markets.map((market) => Math.abs(market.edge)), 0), [markets]);
  const avgConfidence = useMemo(() => {
    if (!markets.length) return 0;
    return markets.reduce((sum, market) => sum + market.confidence, 0) / markets.length;
  }, [markets]);

  return (
    <div className="app-shell">
      <div className="ambient ambient-left" />
      <div className="ambient ambient-right" />
      <main className="dashboard">
        <section className="hero panel">
          <div>
            <p className="eyebrow">Weather Markets</p>
            <h1>Scan live weather dislocations before the tape catches up.</h1>
            <p className="subtle hero-copy">
              Real feed blend using Polymarket market context plus live Open-Meteo and NWS forecasts. Heuristics are intentionally simple and ready for model upgrades.
            </p>
            <div className="hero-status-row">
              <span className="badge">{meta ? `${meta.totalPolymarketMarketsScanned} Polymarket markets scanned` : 'Loading feeds'}</span>
              {meta?.usedCuratedFallback && <span className="badge soft">Curated weather fallback active</span>}
              {selectedMarket && <span className="badge soft">Freshness {freshnessLabel(selectedMarket.freshnessMinutes)}</span>}
            </div>
          </div>
          <div className="hero-metrics">
            <Metric label="Live candidates" value={String(markets.length).padStart(2, '0')} />
            <Metric label="Best absolute edge" value={signedPct(topEdge)} positive={topEdge > 0} />
            <Metric label="Average confidence" value={pct(avgConfidence)} />
            <Metric label="Live weather markets on Polymarket" value={String(meta?.livePolymarketWeatherCount ?? 0).padStart(2, '0')} />
          </div>
        </section>

        {error && <section className="panel error-panel">{error}</section>}
        {loading && <section className="panel loading-panel">Refreshing live market and weather feeds…</section>}

        <section className="summary-grid">
          <div className="panel summary-card">
            <span className="summary-label">Highest conviction</span>
            <strong>{markets[0]?.title ?? 'Loading...'}</strong>
            <span className="subtle">{markets[0] ? `${pct(markets[0].confidence)} confidence` : 'Waiting for feed'}</span>
          </div>
          <div className="panel summary-card">
            <span className="summary-label">Source dispersion</span>
            <strong>{selectedMarket ? pct(selectedMarket.disagreement) : '0%'}</strong>
            <span className="subtle">Higher means the live sources disagree more.</span>
          </div>
          <div className="panel summary-card">
            <span className="summary-label">Model posture</span>
            <strong>{selectedMarket?.edge && selectedMarket.edge > 0 ? 'Constructive YES' : 'Prefer fade / NO'}</strong>
            <span className="subtle">Based on blended weather heuristics versus market prior.</span>
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
                    <th>Market</th>
                    <th>Implied</th>
                    <th>Model</th>
                    <th>Edge</th>
                    <th>Disagreement</th>
                    <th>Confidence</th>
                    <th>Freshness</th>
                  </tr>
                </thead>
                <tbody>
                  {markets.map((market) => (
                    <tr
                      key={market.id}
                      className={market.id === selectedMarket?.id ? 'active-row' : ''}
                      onClick={() => setSelectedId(market.id)}
                    >
                      <td>
                        <div className="market-cell">
                          <strong>{market.title}</strong>
                          <span>{market.location} · {market.expiry}</span>
                        </div>
                      </td>
                      <td>{pct(market.impliedProbability)}</td>
                      <td>{pct(market.modelProbability)}</td>
                      <td className={market.edge >= 0 ? 'positive' : 'negative'}>{signedPct(market.edge)}</td>
                      <td>{pct(market.disagreement)}</td>
                      <td>{pct(market.confidence)}</td>
                      <td>{freshnessLabel(market.freshnessMinutes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card-list">
              {markets.map((market) => (
                <button
                  key={market.id}
                  className={`market-card ${market.id === selectedMarket?.id ? 'selected' : ''}`}
                  onClick={() => setSelectedId(market.id)}
                >
                  <div className="market-card-top">
                    <span className="pill">{market.side}</span>
                    <span className={market.edge >= 0 ? 'positive' : 'negative'}>{signedPct(market.edge)}</span>
                  </div>
                  <strong>{market.title}</strong>
                  <p>{market.notes}</p>
                  <div className="market-card-metrics">
                    <span>Market {pct(market.impliedProbability)}</span>
                    <span>Model {pct(market.modelProbability)}</span>
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
                  <div className="detail-metrics">
                    <Metric label="Implied" value={pct(selectedMarket.impliedProbability)} />
                    <Metric label="Model" value={pct(selectedMarket.modelProbability)} />
                    <Metric label="Edge" value={signedPct(selectedMarket.edge)} positive={selectedMarket.edge >= 0} />
                    <Metric label="24h volume" value={selectedMarket.volume24h} />
                  </div>
                  <div className="detail-copy">
                    <div>
                      <span className="detail-label">Heuristic summary</span>
                      <p>{selectedMarket.heuristicSummary}</p>
                    </div>
                    <div>
                      <span className="detail-label">Thesis</span>
                      <p>{selectedMarket.thesis}</p>
                    </div>
                    <div>
                      <span className="detail-label">Resolution</span>
                      <p>{selectedMarket.resolution}</p>
                    </div>
                    <div>
                      <span className="detail-label">Desk notes</span>
                      <p>{selectedMarket.notes}</p>
                    </div>
                  </div>
                </>
              )}
            </section>

            <section className="panel comparison-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Source comparison</p>
                  <h2>Forecast disagreement</h2>
                </div>
              </div>
              <div className="source-list">
                {selectedMarket?.sources.map((source) => (
                  <div className="source-row" key={source.name}>
                    <div>
                      <strong>{source.name}</strong>
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
                  <p className="eyebrow">Scoring</p>
                  <h2>Why this ranks here</h2>
                </div>
              </div>
              {selectedMarket && (
                <div className="score-grid">
                  <div className="score-card">
                    <span>Edge quality</span>
                    <strong>{signedPct(selectedMarket.edge)}</strong>
                    <p>Bigger dislocations between market prior and blend rank higher.</p>
                  </div>
                  <div className="score-card">
                    <span>Confidence</span>
                    <strong>{pct(selectedMarket.confidence)}</strong>
                    <p>Confidence rises with freshness and source agreement.</p>
                  </div>
                  <div className="score-card">
                    <span>Disagreement</span>
                    <strong>{pct(selectedMarket.disagreement)}</strong>
                    <p>Higher spread across live sources tempers conviction.</p>
                  </div>
                  <div className="score-card">
                    <span>Freshness</span>
                    <strong>{freshnessLabel(selectedMarket.freshnessMinutes)}</strong>
                    <p>Based on the latest weather feed timestamps seen by the pipeline.</p>
                  </div>
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

export default App;
