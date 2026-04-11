export type Signal = 'bullish' | 'bearish' | 'neutral';

export type MarketDataOrigin = 'polymarket-event' | 'polymarket-live' | 'curated-watchlist';

export type WeatherResolutionKind = 'precipitation' | 'temperatureMax' | 'windSpeed' | 'namedStorm' | 'unknown';

export type ResolutionSchema = {
  kind: WeatherResolutionKind;
  metric: string;
  operator: 'gte' | 'lte' | 'between' | 'occurs' | 'unknown';
  threshold?: number | null;
  thresholdHigh?: number | null;
  units?: string;
  location?: string;
  observationWindow?: string;
  source?: string;
  rawRule: string;
  parseConfidence: number;
};

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
  thresholdValue: number | null;
  observedValue: number | null;
  units: string;
  weatherScore: number;
  recencyScore: number;
  sourceAgreement: number;
  quoteAgeMinutes: number;
  quoteSpreadScore: number;
};

export type DiscoveryInfo = {
  hasExchangeContract: boolean;
  matchedVia: 'live-market' | 'watchlist-fallback' | 'live-event-market';
  parseConfidence: number;
  canonicalQuery: string;
  schemaLabel: string;
  eventId?: string;
  eventSlug?: string;
  eventTitle?: string;
};

export type EventMeta = {
  id: string;
  slug: string;
  title: string;
  description?: string;
  endDate?: string;
  liquidity?: number;
  volume24hr?: number;
  updatedAt?: string;
};

export type ClobQuote = {
  tokenId: string;
  outcome: string;
  bestBid: number | null;
  bestAsk: number | null;
  midpoint: number | null;
  lastTradePrice: number | null;
  tickSize: number | null;
  spread: number | null;
  fetchedAt: string;
};

export type QuoteStatus = 'tight' | 'tradable' | 'wide' | 'stale' | 'empty';

export type MarketQuoteUpdate = {
  marketId: string;
  impliedProbability: number | null;
  clobQuote?: ClobQuote;
  updatedAt?: string;
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
  resolutionSchema: ResolutionSchema;
  discovery: DiscoveryInfo;
  marketSlug?: string;
  conditionId?: string;
  clobTokenIds?: string[];
  outcomes?: string[];
  outcomePrices?: number[];
  event?: EventMeta;
  clobQuote?: ClobQuote;
  quoteStatus: QuoteStatus;
};

export type MarketFeedMeta = {
  livePolymarketWeatherCount: number;
  totalPolymarketMarketsScanned: number;
  usedCuratedFallback: boolean;
  refreshedAt: string;
  weatherSourceMix: string[];
  livePolymarketParsedCount: number;
  livePolymarketParsedTitles: string[];
  livePolymarketEventCount: number;
};

export type WeatherMarketResponse = {
  markets: WeatherMarket[];
  meta: MarketFeedMeta;
};
