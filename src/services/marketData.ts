import type { MarketFeedMeta, Signal, WeatherMarket, WeatherMarketResponse } from '../types';

type MarketProvider = {
  getMarkets: () => Promise<WeatherMarketResponse>;
};

type PolymarketMarket = {
  id: string;
  question: string;
  slug: string;
  endDate?: string;
  liquidity?: string;
  volume24hr?: number | string;
  outcomes?: string;
  outcomePrices?: string;
  description?: string;
  updatedAt?: string;
};

type WatchlistSpec = {
  id: string;
  title: string;
  contract: string;
  location: string;
  expiryLabel: string;
  side: 'YES' | 'NO';
  latitude: number;
  longitude: number;
  eventType: 'precipitation' | 'temperatureMax';
  thresholdValue: number;
  thresholdLabel: string;
  units: string;
  thesisTemplate: string;
  notesTemplate: string;
  catalysts: string[];
  risks: string[];
  resolution: string;
};

type OpenMeteoResponse = {
  hourly?: {
    time: string[];
    precipitation_probability?: Array<number | null>;
    temperature_2m?: Array<number | null>;
  };
  hourly_units?: {
    precipitation_probability?: string;
    temperature_2m?: string;
  };
};

type NwsPointsResponse = {
  properties?: {
    forecastHourly?: string;
  };
};

type NwsHourlyResponse = {
  properties?: {
    updated?: string;
    periods?: Array<{
      startTime: string;
      endTime: string;
      temperature?: number;
      temperatureUnit?: string;
      probabilityOfPrecipitation?: { value: number | null };
      shortForecast?: string;
      detailedForecast?: string;
    }>;
  };
};

const polymarketUrl = 'https://gamma-api.polymarket.com/markets?limit=500&active=true&closed=false';
const userAgent = 'weather-markets-scanner/0.1';
const now = () => new Date();
const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const avg = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / (values.length || 1);
const fmtPct = (value: number) => `${Math.round(value * 100)}%`;
const fmtMoney = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return '--';
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `$${Math.round(value / 1_000)}k`;
  return `$${Math.round(value)}`;
};
const minutesSince = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
const signalForDelta = (delta: number): Signal => (delta > 0.03 ? 'bullish' : delta < -0.03 ? 'bearish' : 'neutral');

const watchlist: WatchlistSpec[] = [
  {
    id: 'nyc-rain',
    title: 'NYC rainfall exceeds 0.50in over next 72h',
    contract: 'Rainfall > 0.50in / 72h proxy',
    location: 'New York City',
    expiryLabel: 'Next 72 hours',
    side: 'YES',
    latitude: 40.7128,
    longitude: -74.006,
    eventType: 'precipitation',
    thresholdValue: 0.5,
    thresholdLabel: '0.50 inches',
    units: 'in',
    thesisTemplate: 'Rain risk is scored from hourly precipitation probabilities over the next 72 hours, then blended with NWS language intensity to produce a trading proxy rather than an official resolution model.',
    notesTemplate: 'Curated weather watchlist contract while live weather-linked Polymarket supply is thin.',
    catalysts: ['Next NWS hourly refresh', 'Overnight QPF shift', 'Radar trend into the metro corridor'],
    risks: ['Probability does not equal realized total', 'Convective miss can break the proxy', 'No direct exchange-listed weather contract today'],
    resolution: 'Proxy contract, not exchange-resolving. Intended for scanner ranking and future market mapping.',
  },
  {
    id: 'chicago-snow-risk',
    title: 'Chicago precip/snow setup turns material in next 72h',
    contract: 'Cold precipitation setup proxy',
    location: 'Chicago',
    expiryLabel: 'Next 72 hours',
    side: 'YES',
    latitude: 41.8781,
    longitude: -87.6298,
    eventType: 'precipitation',
    thresholdValue: 0.35,
    thresholdLabel: 'meaningful cold precip',
    units: 'probability',
    thesisTemplate: 'This proxy uses precipitation probability with a colder-city watchlist bias, useful for spotting optionality when market attention is low.',
    notesTemplate: 'Good seam for plugging in snowfall-specific models later.',
    catalysts: ['Short-range model cycle', 'NWS precip wording', 'Surface temperature trend'],
    risks: ['Snowfall is not directly modeled yet', 'Warm boundary layer can invalidate the edge', 'Proxy may overstate accumulations'],
    resolution: 'Proxy contract, designed for scanner ranking until direct measurable-snow markets are available.',
  },
  {
    id: 'phoenix-heat',
    title: 'Phoenix reaches 100°F in next 72h',
    contract: 'High temp ≥ 100°F / 72h proxy',
    location: 'Phoenix',
    expiryLabel: 'Next 72 hours',
    side: 'YES',
    latitude: 33.4484,
    longitude: -112.074,
    eventType: 'temperatureMax',
    thresholdValue: 100,
    thresholdLabel: '100°F',
    units: '°F',
    thesisTemplate: 'Heat risk comes from the max Open-Meteo hourly temperature plus NWS hourly temperature path, with an urgency bump when the threshold is near.',
    notesTemplate: 'Useful for threshold-style weather markets and seasonal heat watchlists.',
    catalysts: ['NWS hourly temperature drift', 'Cloud cover changes', 'Late-day heating efficiency'],
    risks: ['Open-Meteo and NWS may lag local microsite effects', 'Airport readings can differ', 'No directly listed weather contract available now'],
    resolution: 'Proxy contract, not directly exchange-resolving.',
  },
];

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': userAgent,
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

function parseOutcomePrices(prices?: string): number[] {
  if (!prices) return [];
  try {
    const parsed = JSON.parse(prices) as string[];
    return parsed.map((value) => Number(value)).filter((value) => Number.isFinite(value));
  } catch {
    return [];
  }
}

function parsePolymarketImpliedProbability(market: PolymarketMarket): number | null {
  const prices = parseOutcomePrices(market.outcomePrices);
  return prices.length ? clamp(prices[0]) : null;
}

function looksWeatherLinked(market: PolymarketMarket): boolean {
  const text = `${market.question} ${market.description ?? ''}`.toLowerCase();
  return [
    'temperature', 'temp ', '°', 'rain', 'snow', 'precip', 'hurricane', 'storm', 'weather', 'wind', 'flood', 'heat', 'freeze',
  ].some((token) => text.includes(token));
}

async function getPolymarketSnapshot(): Promise<{ markets: PolymarketMarket[]; meta: Pick<MarketFeedMeta, 'livePolymarketWeatherCount' | 'totalPolymarketMarketsScanned'> }> {
  try {
    const markets = await fetchJson<PolymarketMarket[]>(polymarketUrl);
    const weatherMarkets = markets.filter(looksWeatherLinked);
    return {
      markets: weatherMarkets,
      meta: {
        livePolymarketWeatherCount: weatherMarkets.length,
        totalPolymarketMarketsScanned: markets.length,
      },
    };
  } catch {
    return {
      markets: [],
      meta: {
        livePolymarketWeatherCount: 0,
        totalPolymarketMarketsScanned: 0,
      },
    };
  }
}

async function getNwsHourly(latitude: number, longitude: number): Promise<NwsHourlyResponse | null> {
  try {
    const points = await fetchJson<NwsPointsResponse>(`https://api.weather.gov/points/${latitude},${longitude}`);
    const hourlyUrl = points.properties?.forecastHourly;
    if (!hourlyUrl) return null;
    return fetchJson<NwsHourlyResponse>(hourlyUrl);
  } catch {
    return null;
  }
}

async function getOpenMeteo(latitude: number, longitude: number): Promise<OpenMeteoResponse | null> {
  try {
    return await fetchJson<OpenMeteoResponse>(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&hourly=precipitation_probability,temperature_2m&forecast_days=3&temperature_unit=fahrenheit&precipitation_unit=inch`);
  } catch {
    return null;
  }
}

function buildPrecipProbabilities(spec: WatchlistSpec, openMeteo: OpenMeteoResponse | null, nws: NwsHourlyResponse | null) {
  const openValues = (openMeteo?.hourly?.precipitation_probability ?? []).filter((value): value is number => value !== null).slice(0, 72);
  const nwsValues = (nws?.properties?.periods ?? [])
    .map((period) => period.probabilityOfPrecipitation?.value)
    .filter((value): value is number => value !== null)
    .slice(0, 36);

  const openProb = openValues.length ? clamp(Math.max(...openValues) / 100) : 0.35;
  const nwsProb = nwsValues.length ? clamp(Math.max(...nwsValues) / 100) : 0.35;
  const modelProbability = clamp(openProb * 0.55 + nwsProb * 0.45 + (spec.id.includes('chicago') ? 0.04 : 0));

  return {
    observedValue: openValues.length ? Math.max(...openValues) / 100 : null,
    modelProbability,
    sourceProbabilities: [openProb, nwsProb],
    sourceNotes: {
      open: openValues.length ? `Peak hourly precipitation probability over next 72h reached ${Math.round(Math.max(...openValues))}%.` : 'Open-Meteo unavailable, fallback prior used.',
      nws: nwsValues.length ? `NWS hourly precip probability peaked at ${Math.round(Math.max(...nwsValues))}%.` : 'NWS hourly feed unavailable, fallback prior used.',
    },
  };
}

function buildTemperatureProbabilities(spec: WatchlistSpec, openMeteo: OpenMeteoResponse | null, nws: NwsHourlyResponse | null) {
  const openValues = (openMeteo?.hourly?.temperature_2m ?? []).filter((value): value is number => value !== null).slice(0, 72);
  const nwsValues = (nws?.properties?.periods ?? []).map((period) => period.temperature).filter((value): value is number => value !== undefined).slice(0, 36);

  const openMax = openValues.length ? Math.max(...openValues) : spec.thresholdValue - 4;
  const nwsMax = nwsValues.length ? Math.max(...nwsValues) : spec.thresholdValue - 3;
  const openProb = clamp(0.5 + (openMax - spec.thresholdValue) / 12);
  const nwsProb = clamp(0.5 + (nwsMax - spec.thresholdValue) / 10);
  const modelProbability = clamp(openProb * 0.6 + nwsProb * 0.4);

  return {
    observedValue: Math.max(openMax, nwsMax),
    modelProbability,
    sourceProbabilities: [openProb, nwsProb],
    sourceNotes: {
      open: `Open-Meteo max hourly temperature is ${Math.round(openMax)}°F over the next 72h.`,
      nws: `NWS hourly temperature path peaks near ${Math.round(nwsMax)}°F.`,
    },
  };
}

function disagreementFrom(values: number[]) {
  if (values.length < 2) return 0.05;
  return clamp(Math.max(...values) - Math.min(...values));
}

function confidenceFrom(edge: number, disagreement: number, freshnessMinutes: number) {
  const edgeScore = clamp(Math.abs(edge) / 0.25);
  const agreementScore = 1 - clamp(disagreement / 0.4);
  const freshnessScore = 1 - clamp(freshnessMinutes / 720);
  return clamp(edgeScore * 0.45 + agreementScore * 0.35 + freshnessScore * 0.2, 0.1, 0.98);
}

function syntheticImpliedFromPolymarket(liveMarkets: PolymarketMarket[], spec: WatchlistSpec, modelProbability: number) {
  const liveWeatherCandidates = liveMarkets.map((market) => parsePolymarketImpliedProbability(market)).filter((value): value is number => value !== null);
  const marketBaseline = liveWeatherCandidates.length ? avg(liveWeatherCandidates) : 0.5;
  const locationBias = spec.location === 'Phoenix' ? 0.04 : spec.location === 'Chicago' ? -0.05 : -0.02;
  return clamp(marketBaseline * 0.6 + modelProbability * 0.15 + 0.2 + locationBias);
}

async function normalizeWatchlistMarket(spec: WatchlistSpec, liveMarkets: PolymarketMarket[]): Promise<WeatherMarket> {
  const [openMeteo, nws] = await Promise.all([getOpenMeteo(spec.latitude, spec.longitude), getNwsHourly(spec.latitude, spec.longitude)]);
  const built = spec.eventType === 'temperatureMax'
    ? buildTemperatureProbabilities(spec, openMeteo, nws)
    : buildPrecipProbabilities(spec, openMeteo, nws);

  const nwsUpdated = nws?.properties?.updated;
  const freshnessInputs = [nwsUpdated].filter((value): value is string => Boolean(value));
  const freshnessMinutes = freshnessInputs.length ? Math.min(...freshnessInputs.map(minutesSince)) : 180;
  const impliedProbability = syntheticImpliedFromPolymarket(liveMarkets, spec, built.modelProbability);
  const edge = clamp(built.modelProbability - impliedProbability, -1, 1);
  const disagreement = disagreementFrom(built.sourceProbabilities);
  const confidence = confidenceFrom(edge, disagreement, freshnessMinutes);
  const lastUpdated = freshnessInputs[0] ?? new Date().toISOString();
  const weatherScore = clamp(built.modelProbability);
  const recencyScore = 1 - clamp(freshnessMinutes / 720);
  const sourceAgreement = 1 - clamp(disagreement / 0.4);

  const sources = [
    {
      name: 'Open-Meteo',
      probability: built.sourceProbabilities[0],
      deltaVsMarket: built.sourceProbabilities[0] - impliedProbability,
      signal: signalForDelta(built.sourceProbabilities[0] - impliedProbability),
      note: built.sourceNotes.open,
      freshnessMinutes,
    },
    {
      name: 'NWS hourly',
      probability: built.sourceProbabilities[1],
      deltaVsMarket: built.sourceProbabilities[1] - impliedProbability,
      signal: signalForDelta(built.sourceProbabilities[1] - impliedProbability),
      note: built.sourceNotes.nws,
      freshnessMinutes,
    },
    {
      name: 'Scanner blend',
      probability: built.modelProbability,
      deltaVsMarket: built.modelProbability - impliedProbability,
      signal: signalForDelta(built.modelProbability - impliedProbability),
      note: `Blend weights live weather sources and uses a simple ${spec.eventType === 'temperatureMax' ? 'threshold-distance' : 'precipitation-risk'} heuristic.`,
      freshnessMinutes,
    },
  ];

  return {
    id: spec.id,
    title: spec.title,
    contract: spec.contract,
    location: spec.location,
    expiry: spec.expiryLabel,
    side: spec.side,
    impliedProbability,
    modelProbability: built.modelProbability,
    edge,
    disagreement,
    confidence,
    liquidity: liveMarkets.length ? fmtMoney(avg(liveMarkets.map((market) => Number(market.liquidity) || 0))) : '--',
    volume24h: liveMarkets.length ? fmtMoney(avg(liveMarkets.map((market) => Number(market.volume24hr) || 0))) : '--',
    notes: spec.notesTemplate,
    thesis: spec.thesisTemplate,
    catalysts: spec.catalysts,
    risks: spec.risks,
    resolution: spec.resolution,
    freshnessMinutes,
    dataOrigin: 'curated-watchlist',
    lastUpdated,
    heuristicSummary: `${fmtPct(built.modelProbability)} model probability from live weather feeds versus ${fmtPct(impliedProbability)} synthetic market prior anchored to current Polymarket tape.`,
    heuristicDetails: {
      thresholdLabel: spec.thresholdLabel,
      thresholdValue: spec.thresholdValue,
      observedValue: built.observedValue,
      units: spec.units,
      weatherScore,
      recencyScore,
      sourceAgreement,
    },
    sources,
  };
}

export async function getWeatherMarkets(): Promise<WeatherMarketResponse> {
  const polymarket = await getPolymarketSnapshot();
  const markets = await Promise.all(watchlist.map((spec) => normalizeWatchlistMarket(spec, polymarket.markets)));
  markets.sort((a, b) => Math.abs(b.edge) * b.confidence - Math.abs(a.edge) * a.confidence);

  return {
    markets,
    meta: {
      ...polymarket.meta,
      usedCuratedFallback: true,
      refreshedAt: now().toISOString(),
      weatherSourceMix: ['Polymarket', 'Open-Meteo', 'NWS'],
    },
  };
}

export const localMarketProvider: MarketProvider = {
  getMarkets: getWeatherMarkets,
};
