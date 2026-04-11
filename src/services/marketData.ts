import type { DiscoveryInfo, MarketFeedMeta, ResolutionSchema, Signal, WeatherMarket, WeatherMarketResponse } from '../types';

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
  canonicalQuery: string;
  location: string;
  expiryLabel: string;
  side: 'YES' | 'NO';
  latitude: number;
  longitude: number;
  resolutionSchema: ResolutionSchema;
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
  };
};

const polymarketUrl = 'https://gamma-api.polymarket.com/markets?limit=500&active=true&closed=false';
const userAgent = 'weather-markets-scanner/0.2';
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
const prettySchema = (schema: ResolutionSchema) => {
  if (schema.operator === 'gte' && schema.threshold !== undefined && schema.threshold !== null) {
    return `${schema.metric} ≥ ${schema.threshold}${schema.units ?? ''}`;
  }
  return schema.rawRule;
};

const watchlist: WatchlistSpec[] = [
  {
    id: 'nyc-rain',
    title: 'NYC rainfall exceeds 0.50in over next 72h',
    contract: 'Rainfall > 0.50in / 72h proxy',
    canonicalQuery: 'new york city rainfall over 0.50 inches next 72 hours',
    location: 'New York City',
    expiryLabel: 'Next 72 hours',
    side: 'YES',
    latitude: 40.7128,
    longitude: -74.006,
    resolutionSchema: {
      kind: 'precipitation',
      metric: 'rainfall',
      operator: 'gte',
      threshold: 0.5,
      units: 'in',
      location: 'New York City',
      observationWindow: '72h',
      source: 'gauge or official local weather report',
      rawRule: 'Total rainfall in New York City is at least 0.50 inches over the next 72 hours.',
      parseConfidence: 0.98,
    },
    thesisTemplate: 'Rain risk is scored from hourly precipitation probabilities over the next 72 hours, then blended with NWS language intensity. If a real exchange contract appears, the same schema can price against its listed rule.',
    notesTemplate: 'Watchlist fallback with a structured rainfall schema, ready to attach to a listed contract when Polymarket surfaces one.',
    catalysts: ['Next NWS hourly refresh', 'Overnight QPF shift', 'Radar trend into the metro corridor'],
    risks: ['Probability does not equal realized total', 'Convective miss can break the proxy', 'No direct exchange-listed weather contract live right now'],
    resolution: 'Scanner fallback. Intended to mirror a measurable rainfall-style resolution schema rather than act as an exchange-settling contract.',
  },
  {
    id: 'chicago-snow-risk',
    title: 'Chicago precip/snow setup turns material in next 72h',
    contract: 'Cold precipitation setup proxy',
    canonicalQuery: 'chicago meaningful snow or cold precipitation next 72 hours',
    location: 'Chicago',
    expiryLabel: 'Next 72 hours',
    side: 'YES',
    latitude: 41.8781,
    longitude: -87.6298,
    resolutionSchema: {
      kind: 'precipitation',
      metric: 'cold precipitation risk',
      operator: 'gte',
      threshold: 0.35,
      units: 'probability',
      location: 'Chicago',
      observationWindow: '72h',
      source: 'forecast-derived watchlist proxy',
      rawRule: 'Chicago shows a meaningful cold precipitation setup during the next 72 hours.',
      parseConfidence: 0.82,
    },
    thesisTemplate: 'This proxy uses precipitation probability with a colder-city watchlist bias. It is a structured placeholder for snowfall or cold-precip contracts if those get listed.',
    notesTemplate: 'Good seam for plugging in snowfall-specific exchange markets and accumulations later.',
    catalysts: ['Short-range model cycle', 'NWS precip wording', 'Surface temperature trend'],
    risks: ['Snowfall is not directly modeled yet', 'Warm boundary layer can invalidate the edge', 'Proxy may overstate accumulations'],
    resolution: 'Scanner fallback, designed to map later into measurable snow or wintry-precip contract rules.',
  },
  {
    id: 'phoenix-heat',
    title: 'Phoenix reaches 100°F in next 72h',
    contract: 'High temp ≥ 100°F / 72h proxy',
    canonicalQuery: 'phoenix high temperature at least 100 degrees next 72 hours',
    location: 'Phoenix',
    expiryLabel: 'Next 72 hours',
    side: 'YES',
    latitude: 33.4484,
    longitude: -112.074,
    resolutionSchema: {
      kind: 'temperatureMax',
      metric: 'maximum temperature',
      operator: 'gte',
      threshold: 100,
      units: '°F',
      location: 'Phoenix',
      observationWindow: '72h',
      source: 'official local weather observation',
      rawRule: 'Maximum temperature in Phoenix reaches at least 100°F during the next 72 hours.',
      parseConfidence: 0.98,
    },
    thesisTemplate: 'Heat risk comes from the max Open-Meteo hourly temperature plus NWS hourly temperature path, with an urgency bump when the threshold is near. The same schema can price a real threshold contract when listed.',
    notesTemplate: 'Useful for threshold-style weather markets and seasonal heat watchlists.',
    catalysts: ['NWS hourly temperature drift', 'Cloud cover changes', 'Late-day heating efficiency'],
    risks: ['Open-Meteo and NWS may lag local microsite effects', 'Airport readings can differ', 'No directly listed weather contract available now'],
    resolution: 'Scanner fallback mapped to a clear temperature-threshold resolution schema.',
  },
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

function parseResolutionSchema(market: PolymarketMarket): ResolutionSchema | null {
  const text = `${market.question} ${market.description ?? ''}`.replace(/\s+/g, ' ').trim();
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
      location: tempMatch[1] && tempMatch[2] ? tempMatch[1].trim() : undefined,
      rawRule: text,
      parseConfidence: 0.72,
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
      location: precipMatch[1]?.trim(),
      rawRule: text,
      parseConfidence: 0.74,
    };
  }

  if (/(hurricane|tropical storm|storm surge|rainfall|snowfall|temperature|degrees|precipitation|wind chill|wind speed)/i.test(lower)) {
    return {
      kind: 'unknown',
      metric: 'weather event',
      operator: 'unknown',
      rawRule: text,
      parseConfidence: 0.35,
    };
  }

  return null;
}

function looksWeatherLinked(market: PolymarketMarket): boolean {
  const combined = `${market.question} ${market.slug} ${market.description ?? ''}`.toLowerCase();
  if (/(carolina hurricanes|miami heat|heat win|snow white|rainn|ceasefire|storming|brain|train)/i.test(combined)) return false;

  const explicitWeather = [
    /\brainfall\b/i,
    /\bsnowfall\b/i,
    /\bprecipitation\b/i,
    /\btemperature\b/i,
    /\bweather\b/i,
    /\bhurricane\b/i,
    /\btropical storm\b/i,
    /\bstorm surge\b/i,
    /\bwind speed\b/i,
    /\bwind chill\b/i,
    /\bheatwave\b/i,
    /\bheat index\b/i,
    /\bdegrees?\b/i,
    /\brain\b/i,
    /\bsnow\b/i,
  ].some((pattern) => pattern.test(combined));

  if (!explicitWeather) return false;
  return parseResolutionSchema(market) !== null || /\b(weather|hurricane|rainfall|snowfall|temperature|precipitation)\b/i.test(combined);
}

function liquidityNumber(market: PolymarketMarket) {
  return Number(market.liquidity) || 0;
}

function volumeNumber(market: PolymarketMarket) {
  return Number(market.volume24hr) || 0;
}

async function getPolymarketSnapshot(): Promise<{ markets: PolymarketMarket[]; parsedMarkets: PolymarketMarket[]; meta: Pick<MarketFeedMeta, 'livePolymarketWeatherCount' | 'totalPolymarketMarketsScanned' | 'livePolymarketParsedCount' | 'livePolymarketParsedTitles'> }> {
  try {
    const markets = await fetchJson<PolymarketMarket[]>(polymarketUrl);
    const weatherMarkets = markets.filter(looksWeatherLinked);
    const parsedMarkets = weatherMarkets.filter((market) => parseResolutionSchema(market)?.parseConfidence);
    return {
      markets: weatherMarkets,
      parsedMarkets,
      meta: {
        livePolymarketWeatherCount: weatherMarkets.length,
        totalPolymarketMarketsScanned: markets.length,
        livePolymarketParsedCount: parsedMarkets.length,
        livePolymarketParsedTitles: parsedMarkets.slice(0, 5).map((market) => market.question),
      },
    };
  } catch {
    return {
      markets: [],
      parsedMarkets: [],
      meta: {
        livePolymarketWeatherCount: 0,
        totalPolymarketMarketsScanned: 0,
        livePolymarketParsedCount: 0,
        livePolymarketParsedTitles: [],
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

function buildPrecipProbabilities(spec: WatchlistSpec, openMeteo: OpenMeteoResponse | null, nws: NwsHourlyResponse | null): WeatherInputs {
  const openValues = (openMeteo?.hourly?.precipitation_probability ?? []).filter((value): value is number => value !== null).slice(0, 72);
  const nwsValues = (nws?.properties?.periods ?? []).map((period) => period.probabilityOfPrecipitation?.value).filter((value): value is number => value !== null).slice(0, 36);
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

function buildTemperatureProbabilities(spec: WatchlistSpec, openMeteo: OpenMeteoResponse | null, nws: NwsHourlyResponse | null): WeatherInputs {
  const openValues = (openMeteo?.hourly?.temperature_2m ?? []).filter((value): value is number => value !== null).slice(0, 72);
  const nwsValues = (nws?.properties?.periods ?? []).map((period) => period.temperature).filter((value): value is number => value !== undefined).slice(0, 36);
  const threshold = spec.resolutionSchema.threshold ?? 100;
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

function pickBestLiveMatch(spec: WatchlistSpec, liveMarkets: PolymarketMarket[]) {
  const tokens = spec.canonicalQuery.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 2);
  const scored = liveMarkets.map((market) => {
    const text = `${market.question} ${market.slug} ${market.description ?? ''}`.toLowerCase();
    const overlap = tokens.filter((token) => text.includes(token)).length;
    const schema = parseResolutionSchema(market);
    const schemaBonus = schema && schema.kind === spec.resolutionSchema.kind ? 3 : 0;
    const locationBonus = spec.location.toLowerCase().split(/\s+/).some((part) => text.includes(part)) ? 2 : 0;
    return { market, score: overlap + schemaBonus + locationBonus, schema };
  }).sort((a, b) => b.score - a.score || volumeNumber(b.market) - volumeNumber(a.market));

  return scored[0] && scored[0].score >= 5 ? scored[0] : null;
}

function blendedImpliedProbability(spec: WatchlistSpec, built: WeatherInputs, liveMatch: PolymarketMarket | null, liveMarkets: PolymarketMarket[]) {
  const direct = liveMatch ? parsePolymarketImpliedProbability(liveMatch) : null;
  if (direct !== null) return direct;

  const liveWeatherCandidates = liveMarkets.map((market) => parsePolymarketImpliedProbability(market)).filter((value): value is number => value !== null);
  const marketBaseline = liveWeatherCandidates.length ? avg(liveWeatherCandidates) : 0.5;
  const locationBias = spec.location === 'Phoenix' ? 0.04 : spec.location === 'Chicago' ? -0.05 : -0.02;
  return clamp(marketBaseline * 0.6 + built.modelProbability * 0.15 + 0.2 + locationBias);
}

function discoveryFor(spec: WatchlistSpec, liveMatch: ReturnType<typeof pickBestLiveMatch>): DiscoveryInfo {
  return {
    hasExchangeContract: Boolean(liveMatch),
    matchedVia: liveMatch ? 'live-market' : 'watchlist-fallback',
    parseConfidence: liveMatch?.schema?.parseConfidence ?? spec.resolutionSchema.parseConfidence,
    canonicalQuery: spec.canonicalQuery,
    schemaLabel: prettySchema(liveMatch?.schema ?? spec.resolutionSchema),
  };
}

async function normalizeWatchlistMarket(spec: WatchlistSpec, liveMarkets: PolymarketMarket[]): Promise<WeatherMarket> {
  const [openMeteo, nws] = await Promise.all([getOpenMeteo(spec.latitude, spec.longitude), getNwsHourly(spec.latitude, spec.longitude)]);
  const built = spec.resolutionSchema.kind === 'temperatureMax'
    ? buildTemperatureProbabilities(spec, openMeteo, nws)
    : buildPrecipProbabilities(spec, openMeteo, nws);

  const nwsUpdated = nws?.properties?.updated;
  const freshnessInputs = [nwsUpdated].filter((value): value is string => Boolean(value));
  const freshnessMinutes = freshnessInputs.length ? Math.min(...freshnessInputs.map(minutesSince)) : 180;
  const liveMatch = pickBestLiveMatch(spec, liveMarkets);
  const impliedProbability = blendedImpliedProbability(spec, built, liveMatch?.market ?? null, liveMarkets);
  const edge = clamp(built.modelProbability - impliedProbability, -1, 1);
  const disagreement = disagreementFrom(built.sourceProbabilities);
  const confidence = confidenceFrom(edge, disagreement, freshnessMinutes);
  const lastUpdated = freshnessInputs[0] ?? new Date().toISOString();
  const weatherScore = clamp(built.modelProbability);
  const recencyScore = 1 - clamp(freshnessMinutes / 720);
  const sourceAgreement = 1 - clamp(disagreement / 0.4);
  const effectiveSchema = liveMatch?.schema ?? spec.resolutionSchema;
  const discovery = discoveryFor(spec, liveMatch);

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
      name: liveMatch ? 'Polymarket listed contract' : 'Scanner blend',
      probability: liveMatch ? impliedProbability : built.modelProbability,
      deltaVsMarket: liveMatch ? 0 : built.modelProbability - impliedProbability,
      signal: liveMatch ? 'neutral' : signalForDelta(built.modelProbability - impliedProbability),
      note: liveMatch
        ? `Mapped from listed market “${liveMatch.market.question}” using parsed rule ${prettySchema(effectiveSchema)}.`
        : `No live weather listing was confidently matched, so the scanner uses a structured ${effectiveSchema.kind} schema fallback.`,
      freshnessMinutes: liveMatch?.market.updatedAt ? minutesSince(liveMatch.market.updatedAt) : freshnessMinutes,
    },
  ];

  return {
    id: spec.id,
    title: liveMatch?.market.question ?? spec.title,
    contract: liveMatch?.market.question ?? spec.contract,
    location: effectiveSchema.location ?? spec.location,
    expiry: liveMatch?.market.endDate ? new Date(liveMatch.market.endDate).toLocaleString('en-US', { month: 'short', day: 'numeric' }) : spec.expiryLabel,
    side: spec.side,
    impliedProbability,
    modelProbability: built.modelProbability,
    edge,
    disagreement,
    confidence,
    liquidity: liveMatch ? fmtMoney(liquidityNumber(liveMatch.market)) : (liveMarkets.length ? fmtMoney(avg(liveMarkets.map(liquidityNumber))) : '--'),
    volume24h: liveMatch ? fmtMoney(volumeNumber(liveMatch.market)) : (liveMarkets.length ? fmtMoney(avg(liveMarkets.map(volumeNumber))) : '--'),
    notes: liveMatch ? `Live Polymarket contract discovered and mapped to the watchlist schema. ${spec.notesTemplate}` : spec.notesTemplate,
    thesis: spec.thesisTemplate,
    catalysts: spec.catalysts,
    risks: spec.risks,
    resolution: liveMatch?.market.description ?? spec.resolution,
    freshnessMinutes,
    dataOrigin: liveMatch ? 'polymarket-live' : 'curated-watchlist',
    lastUpdated,
    heuristicSummary: liveMatch
      ? `${fmtPct(impliedProbability)} listed market price mapped to ${prettySchema(effectiveSchema)}. Model blend sits at ${fmtPct(built.modelProbability)}.`
      : `${fmtPct(built.modelProbability)} model probability from live weather feeds versus ${fmtPct(impliedProbability)} market prior, with a parsed ${effectiveSchema.kind} resolution schema ready for a listed contract.`,
    heuristicDetails: {
      thresholdLabel: prettySchema(effectiveSchema),
      thresholdValue: effectiveSchema.threshold ?? null,
      observedValue: built.observedValue,
      units: effectiveSchema.units ?? '',
      weatherScore,
      recencyScore,
      sourceAgreement,
    },
    sources,
    resolutionSchema: effectiveSchema,
    discovery,
    marketSlug: liveMatch?.market.slug,
  };
}

export async function getWeatherMarkets(): Promise<WeatherMarketResponse> {
  const polymarket = await getPolymarketSnapshot();
  const markets = await Promise.all(watchlist.map((spec) => normalizeWatchlistMarket(spec, polymarket.markets)));
  markets.sort((a, b) => {
    if (a.dataOrigin !== b.dataOrigin) return a.dataOrigin === 'polymarket-live' ? -1 : 1;
    return Math.abs(b.edge) * b.confidence - Math.abs(a.edge) * a.confidence;
  });

  return {
    markets,
    meta: {
      ...polymarket.meta,
      usedCuratedFallback: !markets.some((market) => market.dataOrigin === 'polymarket-live'),
      refreshedAt: now().toISOString(),
      weatherSourceMix: ['Polymarket', 'Open-Meteo', 'NWS'],
    },
  };
}

export const localMarketProvider: MarketProvider = {
  getMarkets: getWeatherMarkets,
};
