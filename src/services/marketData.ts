import type { ClobQuote, DiscoveryInfo, MarketFeedMeta, MarketQuoteUpdate, ResolutionSchema, Signal, WeatherMarket, WeatherMarketResponse } from '../types';

type MarketProvider = {
  getMarkets: () => Promise<WeatherMarketResponse>;
  getQuoteUpdates: () => Promise<MarketQuoteUpdate[]>;
};

type PolymarketEvent = {
  id: string;
  slug: string;
  title: string;
  description?: string;
  endDate?: string;
  liquidity?: number | string;
  volume24hr?: number | string;
  updatedAt?: string;
  markets?: PolymarketMarket[];
};

type PolymarketMarket = {
  id: string;
  question: string;
  slug: string;
  conditionId?: string;
  clobTokenIds?: string;
  endDate?: string;
  liquidity?: string | number;
  liquidityClob?: string | number;
  volume24hr?: number | string;
  volume24hrClob?: number | string;
  outcomes?: string;
  outcomePrices?: string;
  bestBid?: number | string | null;
  bestAsk?: number | string | null;
  lastTradePrice?: number | string | null;
  spread?: number | string | null;
  orderPriceMinTickSize?: number | string | null;
  description?: string;
  updatedAt?: string;
};

type FlattenedEventMarket = {
  event: PolymarketEvent;
  market: PolymarketMarket;
};

type OpenMeteoResponse = {
  hourly?: {
    time: string[];
    precipitation_probability?: Array<number | null>;
    temperature_2m?: Array<number | null>;
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

type WeatherInputs = {
  observedValue: number | null;
  modelProbability: number;
  sourceProbabilities: number[];
  sourceNotes: {
    open: string;
    nws: string;
    market: string;
  };
};

type LocationGuess = {
  label: string;
  latitude: number;
  longitude: number;
};

const polymarketEventsUrl = 'https://gamma-api.polymarket.com/events?tag_slug=weather&limit=100&active=true&closed=false';
const userAgent = 'weather-markets-scanner/0.3';
const now = () => new Date();
const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const fmtPct = (value: number) => `${Math.round(value * 100)}%`;
const fmtMoney = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return '--';
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `$${Math.round(value / 1_000)}k`;
  return `$${Math.round(value)}`;
};
const minutesSince = (iso: string) => Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
const signalForDelta = (delta: number): Signal => (delta > 0.03 ? 'bullish' : delta < -0.03 ? 'bearish' : 'neutral');

const locationCatalog: LocationGuess[] = [
  { label: 'New York City', latitude: 40.7128, longitude: -74.006 },
  { label: 'Chicago', latitude: 41.8781, longitude: -87.6298 },
  { label: 'Phoenix', latitude: 33.4484, longitude: -112.074 },
  { label: 'Miami', latitude: 25.7617, longitude: -80.1918 },
  { label: 'Houston', latitude: 29.7604, longitude: -95.3698 },
  { label: 'Los Angeles', latitude: 34.0522, longitude: -118.2437 },
  { label: 'Dallas', latitude: 32.7767, longitude: -96.797 },
  { label: 'Atlanta', latitude: 33.749, longitude: -84.388 },
  { label: 'Denver', latitude: 39.7392, longitude: -104.9903 },
  { label: 'Seattle', latitude: 47.6062, longitude: -122.3321 },
  { label: 'Boston', latitude: 42.3601, longitude: -71.0589 },
  { label: 'Philadelphia', latitude: 39.9526, longitude: -75.1652 },
  { label: 'Washington DC', latitude: 38.9072, longitude: -77.0369 },
  { label: 'San Francisco', latitude: 37.7749, longitude: -122.4194 },
  { label: 'Las Vegas', latitude: 36.1699, longitude: -115.1398 },
  { label: 'New Orleans', latitude: 29.9511, longitude: -90.0715 },
  { label: 'Orlando', latitude: 28.5383, longitude: -81.3792 },
  { label: 'San Diego', latitude: 32.7157, longitude: -117.1611 },
  { label: 'Minneapolis', latitude: 44.9778, longitude: -93.265 },
  { label: 'Detroit', latitude: 42.3314, longitude: -83.0458 },
];

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': userAgent,
    },
  });

  if (!response.ok) throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

function parseStringArray(value?: string): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown[];
    return parsed.map((item) => String(item));
  } catch {
    return [];
  }
}

function parseOutcomePrices(prices?: string): number[] {
  return parseStringArray(prices).map((value) => Number(value)).filter((value) => Number.isFinite(value));
}

function parsePolymarketImpliedProbability(market: PolymarketMarket): number | null {
  const bid = toNullableNumber(market.bestBid);
  const ask = toNullableNumber(market.bestAsk);
  if (bid !== null && ask !== null) return clamp((bid + ask) / 2);
  if (bid !== null) return clamp(bid);
  if (ask !== null) return clamp(ask);
  const prices = parseOutcomePrices(market.outcomePrices);
  return prices.length ? clamp(prices[0]) : null;
}

function toNullableNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clobQuoteFor(market: PolymarketMarket): ClobQuote | undefined {
  const outcomes = parseStringArray(market.outcomes);
  const tokenIds = parseStringArray(market.clobTokenIds);
  const tokenId = tokenIds[0];
  if (!tokenId) return undefined;

  const bestBid = toNullableNumber(market.bestBid);
  const bestAsk = toNullableNumber(market.bestAsk);
  const midpoint = bestBid !== null && bestAsk !== null
    ? clamp((bestBid + bestAsk) / 2)
    : bestBid ?? bestAsk ?? null;
  const spread = toNullableNumber(market.spread) ?? (bestBid !== null && bestAsk !== null ? clamp(bestAsk - bestBid, 0, 1) : null);

  return {
    tokenId,
    outcome: outcomes[0] ?? 'Yes',
    bestBid,
    bestAsk,
    midpoint,
    lastTradePrice: toNullableNumber(market.lastTradePrice),
    tickSize: toNullableNumber(market.orderPriceMinTickSize),
    spread,
    fetchedAt: market.updatedAt ?? now().toISOString(),
  };
}

function parseResolutionSchema(item: FlattenedEventMarket): ResolutionSchema {
  const text = `${item.market.question} ${item.market.description ?? ''} ${item.event.title} ${item.event.description ?? ''}`.replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();

  const tempMatch = text.match(/([A-Z][A-Za-z .'-]+?)\s+(?:reaches|hits|hit|above|over|at least)\s+(\d{2,3})\s*°?\s*f/i)
    ?? text.match(/temperature.*?(\d{2,3})\s*°?\s*f/i);
  if (tempMatch) {
    return {
      kind: 'temperatureMax',
      metric: 'maximum temperature',
      operator: 'gte',
      threshold: Number(tempMatch[2] ?? tempMatch[1]),
      units: '°F',
      location: tempMatch[1] && tempMatch[2] ? tempMatch[1].trim() : guessLocation(text)?.label,
      rawRule: text,
      parseConfidence: 0.78,
    };
  }

  const precipMatch = text.match(/([A-Z][A-Za-z .'-]+?)?.*?(rainfall|precipitation|snowfall|snow).*?(?:above|over|at least|greater than)\s+(\d+(?:\.\d+)?)\s*(inches|inch|in|\")/i);
  if (precipMatch) {
    return {
      kind: 'precipitation',
      metric: precipMatch[2].toLowerCase(),
      operator: 'gte',
      threshold: Number(precipMatch[3]),
      units: 'in',
      location: precipMatch[1]?.trim() ?? guessLocation(text)?.label,
      rawRule: text,
      parseConfidence: 0.8,
    };
  }

  if (/(hurricane|tropical storm|storm surge|rainfall|snowfall|temperature|degrees|precipitation|wind chill|wind speed|heatwave|heat index)/i.test(lower)) {
    return {
      kind: 'unknown',
      metric: 'weather event',
      operator: 'unknown',
      location: guessLocation(text)?.label,
      rawRule: text,
      parseConfidence: 0.45,
    };
  }

  return {
    kind: 'unknown',
    metric: 'weather event',
    operator: 'unknown',
    location: guessLocation(text)?.label,
    rawRule: text,
    parseConfidence: 0.2,
  };
}

function prettySchema(schema: ResolutionSchema) {
  if (schema.operator === 'gte' && schema.threshold !== undefined && schema.threshold !== null) {
    return `${schema.metric} ≥ ${schema.threshold}${schema.units ?? ''}`;
  }
  return schema.rawRule;
}

function liquidityNumber(market: PolymarketMarket) {
  return Number(market.liquidityClob ?? market.liquidity) || 0;
}

function volumeNumber(market: PolymarketMarket) {
  return Number(market.volume24hrClob ?? market.volume24hr) || 0;
}

function guessLocation(text: string): LocationGuess | null {
  const lower = text.toLowerCase();
  return locationCatalog.find((location) => lower.includes(location.label.toLowerCase())) ?? null;
}

async function getPolymarketSnapshot(): Promise<{ items: FlattenedEventMarket[]; meta: Pick<MarketFeedMeta, 'livePolymarketWeatherCount' | 'totalPolymarketMarketsScanned' | 'livePolymarketParsedCount' | 'livePolymarketParsedTitles' | 'livePolymarketEventCount'> }> {
  try {
    const events = await fetchJson<PolymarketEvent[]>(polymarketEventsUrl);
    const items = events.flatMap((event) => (event.markets ?? []).map((market) => ({ event, market })));
    const parsedItems = items.filter((item) => parseResolutionSchema(item).parseConfidence >= 0.45);
    return {
      items,
      meta: {
        livePolymarketWeatherCount: items.length,
        totalPolymarketMarketsScanned: items.length,
        livePolymarketParsedCount: parsedItems.length,
        livePolymarketParsedTitles: parsedItems.slice(0, 5).map((item) => item.market.question),
        livePolymarketEventCount: events.length,
      },
    };
  } catch {
    return {
      items: [],
      meta: {
        livePolymarketWeatherCount: 0,
        totalPolymarketMarketsScanned: 0,
        livePolymarketParsedCount: 0,
        livePolymarketParsedTitles: [],
        livePolymarketEventCount: 0,
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

function buildPrecipProbabilities(openMeteo: OpenMeteoResponse | null, nws: NwsHourlyResponse | null): WeatherInputs {
  const openValues = (openMeteo?.hourly?.precipitation_probability ?? []).filter((value): value is number => value !== null).slice(0, 72);
  const nwsValues = (nws?.properties?.periods ?? []).map((period) => period.probabilityOfPrecipitation?.value).filter((value): value is number => value !== null).slice(0, 36);
  const openProb = openValues.length ? clamp(Math.max(...openValues) / 100) : 0.4;
  const nwsProb = nwsValues.length ? clamp(Math.max(...nwsValues) / 100) : 0.4;
  const modelProbability = clamp(openProb * 0.55 + nwsProb * 0.45);

  return {
    observedValue: openValues.length ? Math.max(...openValues) / 100 : null,
    modelProbability,
    sourceProbabilities: [openProb, nwsProb],
    sourceNotes: {
      open: openValues.length ? `Peak hourly precipitation probability over next 72h reached ${Math.round(Math.max(...openValues))}%.` : 'Open-Meteo unavailable, fallback prior used.',
      nws: nwsValues.length ? `NWS hourly precip probability peaked at ${Math.round(Math.max(...nwsValues))}%.` : 'NWS hourly feed unavailable, fallback prior used.',
      market: 'CLOB prices are applied after event discovery and weather enrichment.',
    },
  };
}

function buildTemperatureProbabilities(schema: ResolutionSchema, openMeteo: OpenMeteoResponse | null, nws: NwsHourlyResponse | null): WeatherInputs {
  const openValues = (openMeteo?.hourly?.temperature_2m ?? []).filter((value): value is number => value !== null).slice(0, 72);
  const nwsValues = (nws?.properties?.periods ?? []).map((period) => period.temperature).filter((value): value is number => value !== undefined).slice(0, 36);
  const threshold = schema.threshold ?? 100;
  const openMax = openValues.length ? Math.max(...openValues) : threshold - 4;
  const nwsMax = nwsValues.length ? Math.max(...nwsValues) : threshold - 3;
  const openProb = clamp(0.5 + (openMax - threshold) / 12);
  const nwsProb = clamp(0.5 + (nwsMax - threshold) / 10);
  const modelProbability = clamp(openProb * 0.6 + nwsProb * 0.4);

  return {
    observedValue: Math.max(openMax, nwsMax),
    modelProbability,
    sourceProbabilities: [openProb, nwsProb],
    sourceNotes: {
      open: `Open-Meteo max hourly temperature is ${Math.round(openMax)}°F over the next 72h.`,
      nws: `NWS hourly temperature path peaks near ${Math.round(nwsMax)}°F.`,
      market: 'CLOB prices are applied after event discovery and temperature enrichment.',
    },
  };
}

function buildGenericProbabilities(openMeteo: OpenMeteoResponse | null, nws: NwsHourlyResponse | null): WeatherInputs {
  const precip = buildPrecipProbabilities(openMeteo, nws);
  const temp = buildTemperatureProbabilities({ kind: 'temperatureMax', metric: 'maximum temperature', operator: 'gte', threshold: 90, units: '°F', rawRule: 'Generic weather event', parseConfidence: 0.2 }, openMeteo, nws);
  const modelProbability = clamp(precip.modelProbability * 0.5 + temp.modelProbability * 0.5);
  return {
    observedValue: temp.observedValue,
    modelProbability,
    sourceProbabilities: [precip.sourceProbabilities[0], temp.sourceProbabilities[0]],
    sourceNotes: {
      open: 'Generic weather blend from Open-Meteo precipitation and temperature paths.',
      nws: 'Generic weather blend from NWS hourly precipitation and temperature context.',
      market: 'CLOB prices are applied after generic event discovery.',
    },
  };
}

function disagreementFrom(values: number[]) {
  if (values.length < 2) return 0.05;
  return clamp(Math.max(...values) - Math.min(...values));
}

function confidenceFrom(edge: number, disagreement: number, freshnessMinutes: number, parseConfidence: number) {
  const edgeScore = clamp(Math.abs(edge) / 0.25);
  const agreementScore = 1 - clamp(disagreement / 0.4);
  const freshnessScore = 1 - clamp(freshnessMinutes / 720);
  return clamp(edgeScore * 0.35 + agreementScore * 0.25 + freshnessScore * 0.15 + parseConfidence * 0.25, 0.1, 0.98);
}

function discoveryFor(item: FlattenedEventMarket, schema: ResolutionSchema): DiscoveryInfo {
  return {
    hasExchangeContract: true,
    matchedVia: 'live-event-market',
    parseConfidence: schema.parseConfidence,
    canonicalQuery: item.event.slug,
    schemaLabel: prettySchema(schema),
    eventId: item.event.id,
    eventSlug: item.event.slug,
    eventTitle: item.event.title,
  };
}

async function normalizeEventMarket(item: FlattenedEventMarket): Promise<WeatherMarket> {
  const schema = parseResolutionSchema(item);
  const location = guessLocation(`${schema.location ?? ''} ${item.market.question} ${item.event.title}`);
  const [openMeteo, nws] = location
    ? await Promise.all([getOpenMeteo(location.latitude, location.longitude), getNwsHourly(location.latitude, location.longitude)])
    : [null, null];

  const built = schema.kind === 'temperatureMax'
    ? buildTemperatureProbabilities(schema, openMeteo, nws)
    : schema.kind === 'precipitation'
      ? buildPrecipProbabilities(openMeteo, nws)
      : buildGenericProbabilities(openMeteo, nws);

  const impliedProbability = parsePolymarketImpliedProbability(item.market) ?? 0.5;
  const edge = clamp(built.modelProbability - impliedProbability, -1, 1);
  const freshnessCandidates = [item.market.updatedAt, item.event.updatedAt, nws?.properties?.updated].filter((value): value is string => Boolean(value));
  const freshnessMinutes = freshnessCandidates.length ? Math.min(...freshnessCandidates.map(minutesSince)) : 180;
  const disagreement = disagreementFrom([...built.sourceProbabilities, impliedProbability]);
  const confidence = confidenceFrom(edge, disagreement, freshnessMinutes, schema.parseConfidence);
  const recencyScore = 1 - clamp(freshnessMinutes / 720);
  const sourceAgreement = 1 - clamp(disagreement / 0.4);
  const outcomes = parseStringArray(item.market.outcomes);
  const outcomePrices = parseOutcomePrices(item.market.outcomePrices);
  const clobTokenIds = parseStringArray(item.market.clobTokenIds);
  const clobQuote = clobQuoteFor(item.market);

  return {
    id: item.market.id,
    title: item.market.question,
    contract: item.event.title,
    location: schema.location ?? location?.label ?? 'Global / not parsed',
    expiry: item.market.endDate ? new Date(item.market.endDate).toLocaleString('en-US', { month: 'short', day: 'numeric' }) : (item.event.endDate ? new Date(item.event.endDate).toLocaleString('en-US', { month: 'short', day: 'numeric' }) : 'Live'),
    side: 'YES',
    impliedProbability,
    modelProbability: built.modelProbability,
    edge,
    disagreement,
    confidence,
    liquidity: fmtMoney(liquidityNumber(item.market)),
    volume24h: fmtMoney(volumeNumber(item.market)),
    notes: `Discovered from weather-tagged Gamma event “${item.event.title}”, then enriched with weather feeds and CLOB fields.`,
    thesis: 'Event-first discovery from Gamma weather events, with downstream weather-model context and post-discovery market enrichment.',
    catalysts: ['Gamma weather event updates', 'CLOB price movement', 'Open-Meteo refresh', 'NWS hourly refresh'],
    risks: ['Location parsing may be coarse for global climate markets', 'Unknown-schema events use generic weather enrichment', 'Market language may not map cleanly into a single local observation rule'],
    resolution: item.market.description ?? item.event.description ?? 'See Polymarket event description.',
    freshnessMinutes,
    dataOrigin: 'polymarket-event',
    lastUpdated: freshnessCandidates[0] ?? new Date().toISOString(),
    heuristicSummary: `${fmtPct(impliedProbability)} market price from event-first discovery versus ${fmtPct(built.modelProbability)} weather model context.`,
    heuristicDetails: {
      thresholdLabel: prettySchema(schema),
      thresholdValue: schema.threshold ?? null,
      observedValue: built.observedValue,
      units: schema.units ?? '',
      weatherScore: built.modelProbability,
      recencyScore,
      sourceAgreement,
    },
    sources: [
      {
        name: 'Open-Meteo',
        probability: built.sourceProbabilities[0] ?? built.modelProbability,
        deltaVsMarket: (built.sourceProbabilities[0] ?? built.modelProbability) - impliedProbability,
        signal: signalForDelta((built.sourceProbabilities[0] ?? built.modelProbability) - impliedProbability),
        note: location ? built.sourceNotes.open : 'No reliable local location parse, so Open-Meteo enrichment was skipped.',
        freshnessMinutes,
      },
      {
        name: 'NWS hourly',
        probability: built.sourceProbabilities[1] ?? built.modelProbability,
        deltaVsMarket: (built.sourceProbabilities[1] ?? built.modelProbability) - impliedProbability,
        signal: signalForDelta((built.sourceProbabilities[1] ?? built.modelProbability) - impliedProbability),
        note: location ? built.sourceNotes.nws : 'No reliable local location parse, so NWS enrichment was skipped.',
        freshnessMinutes,
      },
      {
        name: 'Polymarket CLOB',
        probability: impliedProbability,
        deltaVsMarket: 0,
        signal: 'neutral',
        note: built.sourceNotes.market,
        freshnessMinutes: item.market.updatedAt ? minutesSince(item.market.updatedAt) : freshnessMinutes,
      },
    ],
    resolutionSchema: schema,
    discovery: discoveryFor(item, schema),
    marketSlug: item.market.slug,
    conditionId: item.market.conditionId,
    clobTokenIds,
    clobQuote,
    outcomes,
    outcomePrices,
    event: {
      id: item.event.id,
      slug: item.event.slug,
      title: item.event.title,
      description: item.event.description,
      endDate: item.event.endDate,
      liquidity: Number(item.event.liquidity) || 0,
      volume24hr: Number(item.event.volume24hr) || 0,
      updatedAt: item.event.updatedAt,
    },
  };
}

export async function getWeatherMarketQuoteUpdates(): Promise<MarketQuoteUpdate[]> {
  const polymarket = await getPolymarketSnapshot();
  return polymarket.items.map((item) => ({
    marketId: item.market.id,
    impliedProbability: parsePolymarketImpliedProbability(item.market),
    clobQuote: clobQuoteFor(item.market),
    updatedAt: item.market.updatedAt,
  }));
}

export async function getWeatherMarkets(): Promise<WeatherMarketResponse> {
  const polymarket = await getPolymarketSnapshot();
  const markets = await Promise.all(polymarket.items.map((item) => normalizeEventMarket(item)));
  markets.sort((a, b) => Math.abs(b.edge) * b.confidence - Math.abs(a.edge) * a.confidence);

  return {
    markets,
    meta: {
      ...polymarket.meta,
      usedCuratedFallback: false,
      refreshedAt: now().toISOString(),
      weatherSourceMix: ['Gamma weather events', 'Polymarket CLOB', 'Open-Meteo', 'NWS'],
    },
  };
}

export const localMarketProvider: MarketProvider = {
  getMarkets: getWeatherMarkets,
  getQuoteUpdates: getWeatherMarketQuoteUpdates,
};
