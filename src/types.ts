export type ForecastSource = {
  name: string;
  probability: number;
  deltaVsMarket: number;
  signal: 'bullish' | 'bearish' | 'neutral';
  note: string;
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
  sources: ForecastSource[];
};
