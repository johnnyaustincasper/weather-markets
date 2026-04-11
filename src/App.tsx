import { useEffect, useMemo, useState } from 'react';
import { localMarketProvider } from './services/marketData';
import type { WeatherMarket } from './types';

const pct = (value: number) => `${Math.round(value * 100)}%`;
const signedPct = (value: number) => `${value >= 0 ? '+' : ''}${Math.round(value * 100)} pts`;

function App() {
  const [markets, setMarkets] = useState<WeatherMarket[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');

  useEffect(() => {
    localMarketProvider.getMarkets().then((data) => {
      setMarkets(data);
      setSelectedId(data[0]?.id ?? '');
    });
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
            <h1>Scan clean weather mispricings before the tape catches up.</h1>
            <p className="subtle hero-copy">
              Premium triage for forecast-driven prediction markets, blending market pricing with modeled weather probabilities.
            </p>
          </div>
          <div className="hero-metrics">
            <Metric label="Live candidates" value={String(markets.length).padStart(2, '0')} />
            <Metric label="Best absolute edge" value={signedPct(topEdge)} positive={topEdge > 0} />
            <Metric label="Average confidence" value={pct(avgConfidence)} />
          </div>
        </section>

        <section className="summary-grid">
          <div className="panel summary-card">
            <span className="summary-label">Highest conviction</span>
            <strong>{markets[0]?.title ?? 'Loading...'}</strong>
            <span className="subtle">{markets[0] ? `${pct(markets[0].confidence)} confidence` : 'Waiting for feed'}</span>
          </div>
          <div className="panel summary-card">
            <span className="summary-label">Source dispersion</span>
            <strong>{selectedMarket ? pct(selectedMarket.disagreement) : '0%'}</strong>
            <span className="subtle">Higher means more forecast disagreement across sources.</span>
          </div>
          <div className="panel summary-card">
            <span className="summary-label">Model posture</span>
            <strong>{selectedMarket?.edge && selectedMarket.edge > 0 ? 'Constructive YES' : 'Prefer fade / NO'}</strong>
            <span className="subtle">Driven by internal blend versus market implied pricing.</span>
          </div>
        </section>

        <section className="content-grid">
          <div className="panel table-panel">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Candidates</p>
                <h2>Opportunity board</h2>
              </div>
              <span className="badge">Mock feed, integration-ready</span>
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
                    <span>Conf {pct(market.confidence)}</span>
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
                <span className="badge soft">{selectedMarket?.liquidity ?? '--'} liquidity</span>
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
                    <p>Bigger dislocation between market and model increases rank.</p>
                  </div>
                  <div className="score-card">
                    <span>Confidence</span>
                    <strong>{pct(selectedMarket.confidence)}</strong>
                    <p>Confidence rises when signals align and resolution is clean.</p>
                  </div>
                  <div className="score-card">
                    <span>Disagreement penalty</span>
                    <strong>{pct(selectedMarket.disagreement)}</strong>
                    <p>Higher source spread tempers sizing and caps conviction.</p>
                  </div>
                  <div className="score-card full">
                    <span>Key catalysts</span>
                    <ul>
                      {selectedMarket.catalysts.map((item) => <li key={item}>{item}</li>)}
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
