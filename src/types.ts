export type Signal = 'bullish' | 'bearish' | 'neutral';

export type MarketDataOrigin = 'polymarket-live' | 'curated-watchlist';

export type ForecastSource = {
  name: string;
  probability: number;
  deltaVsMarket: number;
  signal: Signal;
  note: string;
  freshnessMinutes: number;
};

export type ForecastHeuristicDetails = {
  thresholdLabel: string;
  thresholdValue: number;
  observedValue: number | null;
  units: string;
  weatherScore: number;
  recencyScore: number;
  sourceAgreement: number;
};

export type WeatherMarket = {
  id: string;
  title: string;
  contract: string;
  location: string;
  expiry: string;
  side: 'YES' | 'NO';
  impliedProbability: number;
  modelProbability: number;
  edge: number;
  disagreement: number;
  confidence: number;
  liquidity: string;
  volume24h: string;
  notes: string;
  thesis: string;
  catalysts: string[];
  risks: string[];
  resolution: string;
  freshnessMinutes: number;
  dataOrigin: MarketDataOrigin;
  lastUpdated: string;
  heuristicSummary: string;
  heuristicDetails: ForecastHeuristicDetails;
  sources: ForecastSource[];
};

export type MarketFeedMeta = {
  livePolymarketWeatherCount: number;
  totalPolymarketMarketsScanned: number;
  usedCuratedFallback: boolean;
  refreshedAt: string;
  weatherSourceMix: string[];
};

export type WeatherMarketResponse = {
  markets: WeatherMarket[];
  meta: MarketFeedMeta;
};
