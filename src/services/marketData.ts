import { mockMarkets } from '../data/mockMarkets';
import type { WeatherMarket } from '../types';

export async function getWeatherMarkets(): Promise<WeatherMarket[]> {
  return Promise.resolve(mockMarkets);
}

export type MarketProvider = {
  getMarkets: () => Promise<WeatherMarket[]>;
};

export const localMarketProvider: MarketProvider = {
  getMarkets: getWeatherMarkets,
};

// Future adapters can normalize Polymarket contracts plus weather forecast APIs here.
// Example:
// export class PolymarketWeatherProvider implements MarketProvider { ... }
