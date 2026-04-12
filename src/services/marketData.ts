import type { ClobQuote, DiscoveryInfo, MarketFeedMeta, MarketQuoteUpdate, QuoteStatus, ResolutionSchema, Signal, WeatherMarket, WeatherMarketResponse } from '../types.js';

type MarketProvider = {
  getMarkets: () => Promise<WeatherMarketResponse>;
  getQuoteUpdates: () => Promise<MarketQuoteUpdate[]>;
};

type PolymarketTag = {
  id?: string;
  label?: string;
  slug?: string;
  name?: string;
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
  tags?: PolymarketTag[];
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
    wind_speed_10m?: Array<number | null>;
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
      windSpeed?: string;
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
  scoringMode: string;
};

type LocationGuess = {
  label: string;
  latitude: number;
  longitude: number;
  aliases: string[];
  specificity: 'city' | 'metro' | 'region';
};

type EventScoringProfile = {
  mode: 'temperature-threshold' | 'precipitation-threshold' | 'wind-threshold' | 'named-storm-occurrence' | 'generic-weather';
  confidenceWeight: number;
  summary: string;
};

type WeatherDiscoveryAssessment = {
  include: boolean;
  score: number;
  reasons: string[];
  ambiguityPenalty: number;
  matchStrength: 'strong' | 'moderate' | 'weak';
};

type ForecastSupportAssessment = {
  coverageDays: number | null;
  horizonGapDays: number | null;
  status: 'supported' | 'near-limit' | 'unsupported' | 'evergreen';
  summary: string;
  actionabilityPenalty: number;
};

const polymarketEventsUrl = 'https://gamma-api.polymarket.com/events?tag_slug=weather&limit=100&active=true&closed=false';
const polymarketGeneralEventsUrl = 'https://gamma-api.polymarket.com/events?limit=500&active=true&closed=false';
const userAgent = 'weather-markets-scanner/0.5';
const WEATHER_DISCOVERY_KEYWORDS = [
  'weather', 'temperature', 'hottest', 'heat', 'rain', 'rainfall', 'precipitation', 'snow', 'snowfall', 'wind', 'gust',
  'hurricane', 'storm', 'tornado', 'arctic sea ice', 'sea ice', 'climate', 'global temperature', 'landfall',
];
const HIGH_SIGNAL_WEATHER_TERMS = [
  'temperature', 'rainfall', 'precipitation', 'snowfall', 'snow', 'wind speed', 'wind gust', 'gust', 'heat index', 'hottest',
  'sea ice', 'global temperature', 'hurricane', 'tropical storm', 'named storm', 'landfall', 'storm forms',
];
const HARD_WEATHER_EXCLUSION_KEYWORDS = [
  'measles', 'bird flu', 'flu', 'covid', 'pandemic', 'earthquake', 'earthquakes', 'volcano', 'volcanic', 'meteor', 'asteroid', 'wildfire', 'wildfires',
];
const SOFT_WEATHER_EXCLUSION_KEYWORDS = [
  'disease', 'outbreak', 'virus', 'war', 'election', 'stock', 'bitcoin', 'ipo', 'tariff', 'lawsuit', 'earnings',
];
const WEATHER_POSITIVE_TAG_SLUGS = [
  'weather', 'weather-science', 'climate', 'climate-weather', 'hurricane', 'hurricanes', 'global-temp', 'climate-change', 'climate-science',
];
const WEATHER_NEGATIVE_TAG_SLUGS = [
  'measles', 'pandemics', 'earthquakes', 'natural-disasters', 'natural-disaster', 'wildfire', 'wildfires',
];
const WEATHER_MEASUREMENT_TERMS = [
  'temperature', 'temp', 'rainfall', 'precipitation', 'snowfall', 'snow', 'wind speed', 'wind gust', 'gust', 'heat index', 'sea ice', 'global temperature',
];
const WEATHER_SETTLEMENT_CUES = [
  'at least', 'less than', 'more than', 'between', 'above', 'below', 'under', 'over', 'reach', 'reaches', 'hits', 'stays below', 'make landfall', 'forms',
];
const AMBIGUOUS_WEATHER_TOPIC_TERMS = [
  'weather this summer', 'weather this year', 'climate change', 'weather event', 'storm season', 'hot summer', 'cold winter',
];
const LONG_RANGE_OR_TOPIC_ONLY_TERMS = [
  'this summer', 'this winter', 'this season', 'storm season', 'hurricane season', 'this year', 'in 2026', 'in 2027',
];
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
const normalizeText = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const locationCatalog: LocationGuess[] = [
  { label: 'New York City', latitude: 40.7128, longitude: -74.006, aliases: ['new york city', 'new york', 'nyc', 'manhattan'], specificity: 'city' },
  { label: 'Chicago', latitude: 41.8781, longitude: -87.6298, aliases: ['chicago'], specificity: 'city' },
  { label: 'Phoenix', latitude: 33.4484, longitude: -112.074, aliases: ['phoenix'], specificity: 'city' },
  { label: 'Miami', latitude: 25.7617, longitude: -80.1918, aliases: ['miami', 'miami fl'], specificity: 'city' },
  { label: 'Houston', latitude: 29.7604, longitude: -95.3698, aliases: ['houston'], specificity: 'city' },
  { label: 'Los Angeles', latitude: 34.0522, longitude: -118.2437, aliases: ['los angeles', 'la california'], specificity: 'city' },
  { label: 'Dallas', latitude: 32.7767, longitude: -96.797, aliases: ['dallas'], specificity: 'city' },
  { label: 'Atlanta', latitude: 33.749, longitude: -84.388, aliases: ['atlanta'], specificity: 'city' },
  { label: 'Denver', latitude: 39.7392, longitude: -104.9903, aliases: ['denver'], specificity: 'city' },
  { label: 'Seattle', latitude: 47.6062, longitude: -122.3321, aliases: ['seattle'], specificity: 'city' },
  { label: 'Boston', latitude: 42.3601, longitude: -71.0589, aliases: ['boston'], specificity: 'city' },
  { label: 'Philadelphia', latitude: 39.9526, longitude: -75.1652, aliases: ['philadelphia', 'philly'], specificity: 'city' },
  { label: 'Washington DC', latitude: 38.9072, longitude: -77.0369, aliases: ['washington dc', 'dc', 'district of columbia'], specificity: 'city' },
  { label: 'San Francisco', latitude: 37.7749, longitude: -122.4194, aliases: ['san francisco', 'sf'], specificity: 'city' },
  { label: 'Las Vegas', latitude: 36.1699, longitude: -115.1398, aliases: ['las vegas', 'vegas'], specificity: 'city' },
  { label: 'New Orleans', latitude: 29.9511, longitude: -90.0715, aliases: ['new orleans'], specificity: 'city' },
  { label: 'Orlando', latitude: 28.5383, longitude: -81.3792, aliases: ['orlando'], specificity: 'city' },
  { label: 'San Diego', latitude: 32.7157, longitude: -117.1611, aliases: ['san diego'], specificity: 'city' },
  { label: 'Minneapolis', latitude: 44.9778, longitude: -93.265, aliases: ['minneapolis', 'twin cities'], specificity: 'metro' },
  { label: 'Detroit', latitude: 42.3314, longitude: -83.0458, aliases: ['detroit'], specificity: 'city' },
  { label: 'Tampa', latitude: 27.9506, longitude: -82.4572, aliases: ['tampa', 'tampa bay'], specificity: 'metro' },
  { label: 'Austin', latitude: 30.2672, longitude: -97.7431, aliases: ['austin'], specificity: 'city' },
  { label: 'Nashville', latitude: 36.1627, longitude: -86.7816, aliases: ['nashville'], specificity: 'city' },
  { label: 'San Antonio', latitude: 29.4241, longitude: -98.4936, aliases: ['san antonio'], specificity: 'city' },
  { label: 'Portland', latitude: 45.5152, longitude: -122.6784, aliases: ['portland'], specificity: 'city' },
];

const POLYMARKET_FETCH_TIMEOUT_MS = 8_000;
const WEATHER_FETCH_TIMEOUT_MS = 4_500;
const BOT_MARKET_NORMALIZE_CONCURRENCY = 4;

async function fetchJson<T>(url: string, timeoutMs = POLYMARKET_FETCH_TIMEOUT_MS): Promise<T> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': userAgent,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}

async function mapWithConcurrency<TInput, TOutput>(items: TInput[], concurrency: number, mapper: (item: TInput, index: number) => Promise<TOutput>): Promise<TOutput[]> {
  if (!items.length) return [];

  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<TOutput>(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  };

  await Promise.all(Array.from({ length: safeConcurrency }, () => worker()));
  return results;
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

function toNullableNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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

function findLocationCandidates(text: string): LocationGuess[] {
  const normalized = normalizeText(text);
  return locationCatalog
    .filter((location) => location.aliases.some((alias) => normalized.includes(normalizeText(alias))))
    .sort((left, right) => {
      const leftAlias = Math.max(...left.aliases.map((alias) => normalizeText(alias).length));
      const rightAlias = Math.max(...right.aliases.map((alias) => normalizeText(alias).length));
      return rightAlias - leftAlias;
    });
}

function guessLocation(text: string): LocationGuess | null {
  return findLocationCandidates(text)[0] ?? null;
}

function extractLocationLabel(text: string): string | undefined {
  const leading = text.match(/^([A-Z][A-Za-z.' -]+?)(?:\s+(?:temperature|temp|rainfall|precipitation|snowfall|snow|wind|gusts|heat|hits|reaches|gets|tops))/i);
  if (leading?.[1]) return leading[1].trim();

  const preposition = text.match(/(?:in|for|at|around|near)\s+([A-Z][A-Za-z.' -]+?)(?=\s+(?:to|over|above|under|below|through|before|on|by|this|next|during|\?|$))/i);
  if (preposition?.[1]) return preposition[1].trim();

  return guessLocation(text)?.label;
}

function parseWindSpeedNumber(value?: string) {
  if (!value) return null;
  const match = value.match(/(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function inferObservationWindow(text: string) {
  const match = text.match(/\b(today|tonight|tomorrow|this weekend|this week|next week|this summer|this season|in 2026|in 2027|by [A-Z][a-z]+\s+\d{1,2}|through [A-Z][a-z]+\s+\d{1,2}|before [A-Z][a-z]+\s+\d{1,2})\b/i);
  return match?.[1];
}

function eventTagSlugs(event: PolymarketEvent) {
  return (event.tags ?? []).map((tag) => normalizeText(tag.slug ?? tag.label ?? tag.name ?? '')).filter(Boolean);
}

function hasWeatherMeasurementCue(text: string) {
  return WEATHER_MEASUREMENT_TERMS.some((keyword) => text.includes(normalizeText(keyword)));
}

function hasSettlementCue(text: string) {
  return WEATHER_SETTLEMENT_CUES.some((keyword) => text.includes(normalizeText(keyword)));
}

function assessWeatherDiscovery(item: FlattenedEventMarket): WeatherDiscoveryAssessment {
  const haystack = normalizeText(`${item.market.question} ${item.market.description ?? ''} ${item.event.title} ${item.event.description ?? ''}`);
  const titleOnly = normalizeText(`${item.market.question} ${item.event.title}`);
  const tagSlugs = eventTagSlugs(item.event);
  const schema = parseResolutionSchema(item);
  const hasLocation = Boolean(extractLocationLabel(`${item.market.question} ${item.event.title}`) || guessLocation(`${schema.location ?? ''} ${item.market.question} ${item.event.title}`));
  const measurableRule = hasWeatherMeasurementCue(haystack) && hasSettlementCue(haystack);
  const namedStormRule = /\b(hurricane|tropical storm|named storm|storm)\b/.test(haystack) && /\b(form|forms|landfall|landfalls|make landfall|made landfall)\b/.test(haystack);
  let score = 0;
  let ambiguityPenalty = 0;
  const reasons: string[] = [];

  if (WEATHER_DISCOVERY_KEYWORDS.some((keyword) => haystack.includes(normalizeText(keyword)))) {
    score += 2.2;
    reasons.push('weather keyword');
  }
  if (HIGH_SIGNAL_WEATHER_TERMS.some((keyword) => haystack.includes(normalizeText(keyword)))) {
    score += 2.4;
    reasons.push('high-signal weather term');
  }
  if (tagSlugs.some((slug) => WEATHER_POSITIVE_TAG_SLUGS.includes(slug))) {
    score += 1.8;
    reasons.push('weather tag');
  }
  if (namedStormRule) {
    score += 2;
    reasons.push('storm contract wording');
  }
  if (measurableRule) {
    score += 2;
    reasons.push('measurable weather rule');
  }
  if (schema.parseConfidence >= 0.8) {
    score += 1.6;
    reasons.push('high parse confidence');
  } else if (schema.parseConfidence >= 0.6) {
    score += 0.9;
    reasons.push('usable parse confidence');
  }
  if (hasLocation) {
    score += 0.6;
    reasons.push('resolved location');
  }
  if (liquidityNumber(item.market) >= 2_500) {
    score += 0.5;
    reasons.push('meaningful liquidity');
  }

  if (schema.kind === 'unknown' && !measurableRule && !namedStormRule) {
    ambiguityPenalty += 2.4;
    reasons.push('unknown rule shape');
  }
  if (!hasLocation && schema.kind !== 'namedStorm' && !titleOnly.includes('global temperature') && !titleOnly.includes('sea ice')) {
    ambiguityPenalty += 1.1;
    reasons.push('missing location');
  }
  if (AMBIGUOUS_WEATHER_TOPIC_TERMS.some((keyword) => haystack.includes(normalizeText(keyword)))) {
    ambiguityPenalty += 1.4;
    reasons.push('topic-only weather wording');
  }
  if (LONG_RANGE_OR_TOPIC_ONLY_TERMS.some((keyword) => haystack.includes(normalizeText(keyword))) && !measurableRule && !namedStormRule) {
    ambiguityPenalty += 1.5;
    reasons.push('long-range topic wording');
  }
  if (WEATHER_DISCOVERY_KEYWORDS.some((keyword) => titleOnly.includes(normalizeText(keyword))) && !measurableRule && !namedStormRule && schema.parseConfidence < 0.58) {
    ambiguityPenalty += 1.7;
    reasons.push('weak weather linkage');
  }
  if (schema.kind === 'unknown' && schema.operator === 'unknown' && !hasLocation) {
    ambiguityPenalty += 1.6;
    reasons.push('generic unlocated contract');
  }

  if (HARD_WEATHER_EXCLUSION_KEYWORDS.some((keyword) => haystack.includes(normalizeText(keyword)))) {
    score -= 6;
    reasons.push('hard exclusion keyword');
  }
  if (SOFT_WEATHER_EXCLUSION_KEYWORDS.some((keyword) => haystack.includes(normalizeText(keyword)))) {
    score -= 1.5;
    reasons.push('soft exclusion keyword');
  }
  if (tagSlugs.some((slug) => WEATHER_NEGATIVE_TAG_SLUGS.includes(slug))) {
    score -= 3.4;
    reasons.push('adjacent non-weather tag');
  }

  const netScore = score - ambiguityPenalty;
  const strong = netScore >= 5.2 && (measurableRule || namedStormRule || schema.parseConfidence >= 0.8);
  const moderate = netScore >= 3.8 && schema.parseConfidence >= 0.58 && (measurableRule || namedStormRule || hasLocation);
  const include = !reasons.includes('hard exclusion keyword') && (strong || moderate);
  return {
    include,
    score: netScore,
    reasons,
    ambiguityPenalty,
    matchStrength: strong ? 'strong' : moderate ? 'moderate' : 'weak',
  };
}

function isWeatherLikeEvent(item: FlattenedEventMarket) {
  return assessWeatherDiscovery(item).include;
}

function parseResolutionSchema(item: FlattenedEventMarket): ResolutionSchema {
  const text = `${item.market.question} ${item.market.description ?? ''} ${item.event.title} ${item.event.description ?? ''}`.replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  const resolvedLocation = extractLocationLabel(text);
  const observationWindow = inferObservationWindow(text);

  const tempMatch = text.match(/([A-Z][A-Za-z .'-]+?)\s+(?:reaches|hits|hit|gets|touches|above|over|at least)\s+(\d{2,3})\s*°?\s*f/i)
    ?? text.match(/temperature(?: in [A-Z][A-Za-z .'-]+?)?.*?(?:above|over|at least)\s+(\d{2,3})\s*°?\s*f/i)
    ?? text.match(/high(?: temperature)?(?: in [A-Z][A-Za-z .'-]+?)?.*?(?:above|over|at least)\s+(\d{2,3})\s*°?\s*f/i);
  if (tempMatch) {
    const threshold = Number(tempMatch[2] ?? tempMatch[1]);
    return {
      kind: 'temperatureMax',
      metric: 'maximum temperature',
      operator: 'gte',
      threshold,
      units: '°F',
      location: tempMatch[2] ? tempMatch[1]?.trim() ?? resolvedLocation : resolvedLocation,
      observationWindow,
      source: 'market-rule-parser',
      rawRule: text,
      parseConfidence: resolvedLocation ? 0.9 : 0.76,
    };
  }

  const tempUnderMatch = text.match(/([A-Z][A-Za-z .'-]+?)?.*?(?:stays below|under|at most|no higher than)\s+(\d{2,3})\s*°?\s*f/i);
  if (tempUnderMatch) {
    return {
      kind: 'temperatureMax',
      metric: 'maximum temperature',
      operator: 'lte',
      threshold: Number(tempUnderMatch[2]),
      units: '°F',
      location: tempUnderMatch[1]?.trim() ?? resolvedLocation,
      observationWindow,
      source: 'market-rule-parser',
      rawRule: text,
      parseConfidence: resolvedLocation ? 0.88 : 0.72,
    };
  }

  const precipMatch = text.match(/([A-Z][A-Za-z .'-]+?)?.*?(rainfall|precipitation|snowfall|snow).*?(?:above|over|at least|greater than)\s+(\d+(?:\.\d+)?)\s*(inches|inch|in|")/i);
  if (precipMatch) {
    return {
      kind: 'precipitation',
      metric: precipMatch[2].toLowerCase(),
      operator: 'gte',
      threshold: Number(precipMatch[3]),
      units: 'in',
      location: precipMatch[1]?.trim() ?? resolvedLocation,
      observationWindow,
      source: 'market-rule-parser',
      rawRule: text,
      parseConfidence: resolvedLocation ? 0.9 : 0.8,
    };
  }

  const precipUnderMatch = text.match(/([A-Z][A-Za-z .'-]+?)?.*?(rainfall|precipitation|snowfall|snow).*?(?:below|under|less than|at most)\s+(\d+(?:\.\d+)?)\s*(inches|inch|in|")/i);
  if (precipUnderMatch) {
    return {
      kind: 'precipitation',
      metric: precipUnderMatch[2].toLowerCase(),
      operator: 'lte',
      threshold: Number(precipUnderMatch[3]),
      units: 'in',
      location: precipUnderMatch[1]?.trim() ?? resolvedLocation,
      observationWindow,
      source: 'market-rule-parser',
      rawRule: text,
      parseConfidence: resolvedLocation ? 0.88 : 0.78,
    };
  }

  const tempRangeMatch = text.match(/global temperature increase by between\s+(\d+(?:\.\d+)?)\s*º?c\s+and\s+(\d+(?:\.\d+)?)\s*º?c/i)
    ?? text.match(/between\s+(\d+(?:\.\d+)?)\s*&\s*(\d+(?:\.\d+)?)\s*(?:m\s+)?square kilometers/i)
    ?? text.match(/between\s+(\d+(?:\.\d+)?)\s+and\s+(\d+(?:\.\d+)?)\s+(tornadoes|earthquakes|storms)/i);
  if (tempRangeMatch) {
    return {
      kind: lower.includes('temperature') || lower.includes('hottest') ? 'temperatureMax' : 'unknown',
      metric: lower.includes('sea ice') ? 'sea ice extent' : lower.includes('temperature') || lower.includes('hottest') ? 'temperature range' : 'weather range',
      operator: 'between',
      threshold: Number(tempRangeMatch[1]),
      thresholdHigh: Number(tempRangeMatch[2]),
      units: lower.includes('ºc') || lower.includes('temperature') ? '°C' : lower.includes('square kilometers') ? 'm sq km' : '',
      location: resolvedLocation,
      observationWindow,
      source: 'market-rule-parser',
      rawRule: text,
      parseConfidence: lower.includes('sea ice') || lower.includes('temperature') ? 0.84 : 0.62,
    };
  }

  const windMatch = text.match(/([A-Z][A-Za-z .'-]+?)?.*?(wind speed|winds|gusts).*?(?:above|over|at least|greater than|reach(?:es)?)\s+(\d+(?:\.\d+)?)\s*(mph|miles per hour)/i);
  if (windMatch) {
    return {
      kind: 'windSpeed',
      metric: windMatch[2].toLowerCase(),
      operator: 'gte',
      threshold: Number(windMatch[3]),
      units: 'mph',
      location: windMatch[1]?.trim() ?? resolvedLocation,
      observationWindow,
      source: 'market-rule-parser',
      rawRule: text,
      parseConfidence: resolvedLocation ? 0.86 : 0.72,
    };
  }

  const stormMatch = text.match(/\b(hurricane|tropical storm|storm)\s+([A-Z][a-z]+)\b/i);
  if (stormMatch) {
    return {
      kind: 'namedStorm',
      metric: `${stormMatch[1].toLowerCase()} occurrence`,
      operator: 'occurs',
      location: resolvedLocation,
      observationWindow,
      source: 'market-rule-parser',
      rawRule: text,
      parseConfidence: resolvedLocation ? 0.78 : 0.65,
    };
  }

  if (/hurricane make landfall|category\s+[1-5]\s+hurricane make landfall|named storm forms/i.test(lower)) {
    return {
      kind: 'namedStorm',
      metric: /landfall/.test(lower) ? 'hurricane landfall' : 'named storm occurrence',
      operator: 'occurs',
      location: /us|united states/.test(lower) ? 'United States' : resolvedLocation,
      observationWindow,
      source: 'market-rule-parser',
      rawRule: text,
      parseConfidence: 0.88,
    };
  }

  if (/hottest year on record|hottest on record|global temperature increase|sea ice extent|tornadoes occur/i.test(lower)) {
    return {
      kind: lower.includes('temperature') || lower.includes('hottest') ? 'temperatureMax' : 'unknown',
      metric: lower.includes('sea ice') ? 'sea ice extent' : lower.includes('tornado') ? 'tornado count' : 'global temperature anomaly',
      operator: /less than|fewer than/.test(lower) ? 'lte' : /more than|at least|or more/.test(lower) ? 'gte' : /between/.test(lower) ? 'between' : 'unknown',
      threshold: Number(text.match(/(\d+(?:\.\d+)?)/)?.[1] ?? NaN) || undefined,
      thresholdHigh: Number(text.match(/between\s+\d+(?:\.\d+)?\s+(?:and|&)\s+(\d+(?:\.\d+)?)/i)?.[1] ?? NaN) || undefined,
      units: lower.includes('ºc') ? '°C' : lower.includes('sea ice') ? 'm sq km' : '',
      location: resolvedLocation,
      observationWindow,
      source: 'market-rule-parser',
      rawRule: text,
      parseConfidence: 0.8,
    };
  }

  if (/(rainfall|snowfall|temperature|degrees|precipitation|wind chill|wind speed|heatwave|heat index)/i.test(lower)) {
    return {
      kind: 'unknown',
      metric: 'weather event',
      operator: 'unknown',
      location: resolvedLocation,
      observationWindow,
      source: 'market-rule-parser',
      rawRule: text,
      parseConfidence: resolvedLocation ? 0.55 : 0.45,
    };
  }

  return {
    kind: 'unknown',
    metric: 'weather event',
    operator: 'unknown',
    location: resolvedLocation,
    observationWindow,
    source: 'market-rule-parser',
    rawRule: text,
    parseConfidence: resolvedLocation ? 0.32 : 0.2,
  };
}

function prettySchema(schema: ResolutionSchema) {
  if (schema.operator === 'between' && schema.threshold !== undefined && schema.threshold !== null && schema.thresholdHigh !== undefined && schema.thresholdHigh !== null) {
    return `${schema.metric} ${schema.threshold}-${schema.thresholdHigh}${schema.units ?? ''}`;
  }
  if ((schema.operator === 'gte' || schema.operator === 'lte') && schema.threshold !== undefined && schema.threshold !== null) {
    const operator = schema.operator === 'gte' ? '≥' : '≤';
    return `${schema.metric} ${operator} ${schema.threshold}${schema.units ?? ''}`;
  }
  if (schema.operator === 'occurs') return `${schema.metric}${schema.location ? ` in ${schema.location}` : ''}`;
  return schema.rawRule;
}

function liquidityNumber(market: PolymarketMarket) {
  return Number(market.liquidityClob ?? market.liquidity) || 0;
}

function volumeNumber(market: PolymarketMarket) {
  return Number(market.volume24hrClob ?? market.volume24hr) || 0;
}

function forecastDaysAvailableFor(schema: ResolutionSchema) {
  if (schema.kind === 'temperatureMax' || schema.kind === 'precipitation' || schema.kind === 'windSpeed') return 3;
  if (schema.kind === 'namedStorm') return 5;
  return 0;
}

function marketEndDateFor(item: FlattenedEventMarket) {
  return item.market.endDate ?? item.event.endDate ?? null;
}

function forecastSupportFor(item: FlattenedEventMarket, schema: ResolutionSchema): ForecastSupportAssessment {
  const coverageDays = forecastDaysAvailableFor(schema);
  if (coverageDays === 0) {
    return {
      coverageDays: null,
      horizonGapDays: null,
      status: 'evergreen',
      summary: 'No short-range forecast qualification applied because this contract is not a near-term local weather setup.',
      actionabilityPenalty: 0,
    };
  }

  const endDate = marketEndDateFor(item);
  if (!endDate) {
    return {
      coverageDays,
      horizonGapDays: null,
      status: 'near-limit',
      summary: `Forecast model supports about ${coverageDays} days, but settlement timing is not explicit in the contract metadata.`,
      actionabilityPenalty: 0.05,
    };
  }

  const hoursToExpiry = (new Date(endDate).getTime() - Date.now()) / 36e5;
  const horizonGapDays = hoursToExpiry / 24 - coverageDays;

  if (hoursToExpiry <= coverageDays * 24 + 12) {
    return {
      coverageDays,
      horizonGapDays: Math.max(0, horizonGapDays),
      status: hoursToExpiry <= coverageDays * 24 ? 'supported' : 'near-limit',
      summary: `Forecast horizon covers this contract through roughly ${Math.max(0, Math.round(hoursToExpiry))}h to expiry.`,
      actionabilityPenalty: hoursToExpiry <= coverageDays * 24 ? 0 : 0.04,
    };
  }

  if (hoursToExpiry <= (coverageDays + 2) * 24) {
    return {
      coverageDays,
      horizonGapDays,
      status: 'near-limit',
      summary: `Contract expires about ${Math.round(hoursToExpiry / 24)} days out, slightly beyond the ${coverageDays}-day forecast window.`,
      actionabilityPenalty: 0.1,
    };
  }

  return {
    coverageDays,
    horizonGapDays,
    status: 'unsupported',
    summary: `Contract expires about ${Math.round(hoursToExpiry / 24)} days out, well beyond the ${coverageDays}-day forecast window used by the model.`,
    actionabilityPenalty: 0.24,
  };
}

function eventScoringProfile(schema: ResolutionSchema): EventScoringProfile {
  if (schema.kind === 'temperatureMax') {
    return {
      mode: 'temperature-threshold',
      confidenceWeight: schema.operator === 'lte' ? 0.92 : 1,
      summary: 'Temperature path against a parsed max-temperature threshold.',
    };
  }
  if (schema.kind === 'precipitation') {
    return {
      mode: 'precipitation-threshold',
      confidenceWeight: 0.98,
      summary: 'Precipitation path against an explicit accumulation threshold.',
    };
  }
  if (schema.kind === 'windSpeed') {
    return {
      mode: 'wind-threshold',
      confidenceWeight: 0.9,
      summary: 'Wind threshold scored from hourly wind and forecast text.',
    };
  }
  if (schema.kind === 'namedStorm') {
    return {
      mode: 'named-storm-occurrence',
      confidenceWeight: 0.82,
      summary: 'Storm-event scaffold from wind and precipitation stress instead of generic weather blending.',
    };
  }
  return {
    mode: 'generic-weather',
    confidenceWeight: 0.72,
    summary: 'Fallback blend, kept conservative until a tighter market rule parse exists.',
  };
}

function parseQualityBoost(schema: ResolutionSchema) {
  if (schema.kind === 'temperatureMax' || schema.kind === 'precipitation' || schema.kind === 'windSpeed') return 0.12;
  if (schema.kind === 'namedStorm') return 0.08;
  return schema.operator === 'between' ? 0.06 : 0;
}

function liveMatchConfidenceFrom(discovery: WeatherDiscoveryAssessment, schema: ResolutionSchema, canonicalLocation: string | null, quote?: ClobQuote, market?: PolymarketMarket) {
  const locationBoost = canonicalLocation ? 0.08 : 0;
  const matchStrengthBoost = discovery.matchStrength === 'strong' ? 0.08 : discovery.matchStrength === 'moderate' ? 0.03 : -0.08;
  const ambiguityPenalty = clamp(discovery.ambiguityPenalty / 5, 0, 0.22);
  const quoteBoost = quote && quoteStatusFrom(quote) !== 'empty' ? 0.04 : 0;
  const liquidityBoost = market && liquidityNumber(market) >= 5_000 ? 0.03 : market && liquidityNumber(market) <= 250 ? -0.03 : 0;
  const structuralPenalty = schema.kind === 'unknown'
    ? 0.14
    : (!canonicalLocation && schema.kind !== 'namedStorm' ? 0.06 : 0);
  return clamp(0.18 + discovery.score / 9 + schema.parseConfidence * 0.42 + parseQualityBoost(schema) + locationBoost + matchStrengthBoost + quoteBoost + liquidityBoost - ambiguityPenalty - structuralPenalty, 0.08, 0.995);
}

async function getPolymarketSnapshot(): Promise<{ items: FlattenedEventMarket[]; meta: Pick<MarketFeedMeta, 'livePolymarketWeatherCount' | 'totalPolymarketMarketsScanned' | 'livePolymarketParsedCount' | 'livePolymarketParsedTitles' | 'livePolymarketEventCount'> }> {
  const [weatherTaggedResult, generalResult] = await Promise.allSettled([
    fetchJson<PolymarketEvent[]>(polymarketEventsUrl, POLYMARKET_FETCH_TIMEOUT_MS),
    fetchJson<PolymarketEvent[]>(polymarketGeneralEventsUrl, POLYMARKET_FETCH_TIMEOUT_MS),
  ]);

  const weatherTaggedEvents = weatherTaggedResult.status === 'fulfilled' ? weatherTaggedResult.value : [];
  const generalEvents = generalResult.status === 'fulfilled' ? generalResult.value : [];
  const taggedItems = weatherTaggedEvents.flatMap((event) => (event.markets ?? []).map((market) => ({ event, market })));
  const discoveredItems = generalEvents
    .flatMap((event) => (event.markets ?? []).map((market) => ({ event, market })))
    .filter(isWeatherLikeEvent);

  const deduped = new Map<string, FlattenedEventMarket>();
  [...taggedItems, ...discoveredItems].forEach((item) => {
    deduped.set(item.market.id, item);
  });

  const items = [...deduped.values()]
    .map((item) => ({ item, assessment: assessWeatherDiscovery(item) }))
    .filter(({ assessment }) => assessment.include)
    .sort((left, right) => right.assessment.score - left.assessment.score)
    .map(({ item }) => item);
  const parsedItems = items.filter((item) => parseResolutionSchema(item).parseConfidence >= 0.45);

  return {
    items,
    meta: {
      livePolymarketWeatherCount: items.length,
      totalPolymarketMarketsScanned: taggedItems.length + generalEvents.flatMap((event) => event.markets ?? []).length,
      livePolymarketParsedCount: parsedItems.length,
      livePolymarketParsedTitles: parsedItems.slice(0, 5).map((item) => item.market.question),
      livePolymarketEventCount: new Set(items.map((item) => item.event.id)).size,
    },
  };
}

async function getNwsHourly(latitude: number, longitude: number): Promise<NwsHourlyResponse | null> {
  try {
    const points = await fetchJson<NwsPointsResponse>(`https://api.weather.gov/points/${latitude},${longitude}`, WEATHER_FETCH_TIMEOUT_MS);
    const hourlyUrl = points.properties?.forecastHourly;
    if (!hourlyUrl) return null;
    return fetchJson<NwsHourlyResponse>(hourlyUrl, WEATHER_FETCH_TIMEOUT_MS);
  } catch {
    return null;
  }
}

async function getOpenMeteo(latitude: number, longitude: number): Promise<OpenMeteoResponse | null> {
  try {
    return await fetchJson<OpenMeteoResponse>(`https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&hourly=precipitation_probability,temperature_2m,wind_speed_10m&forecast_days=3&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch`, WEATHER_FETCH_TIMEOUT_MS);
  } catch {
    return null;
  }
}

function buildThresholdProbability(observed: number, threshold: number, operator: 'gte' | 'lte', divisor: number) {
  const centered = operator === 'gte'
    ? 0.5 + (observed - threshold) / divisor
    : 0.5 + (threshold - observed) / divisor;
  return clamp(centered);
}

function buildPrecipProbabilities(schema: ResolutionSchema, openMeteo: OpenMeteoResponse | null, nws: NwsHourlyResponse | null): WeatherInputs {
  const openValues = (openMeteo?.hourly?.precipitation_probability ?? []).filter((value): value is number => value !== null).slice(0, 72);
  const nwsValues = (nws?.properties?.periods ?? []).map((period) => period.probabilityOfPrecipitation?.value).filter((value): value is number => value !== null).slice(0, 36);
  const openProb = openValues.length ? clamp(Math.max(...openValues) / 100) : 0.4;
  const nwsProb = nwsValues.length ? clamp(Math.max(...nwsValues) / 100) : 0.4;
  const operator = schema.operator === 'lte' ? 'lte' : 'gte';
  const threshold = schema.threshold ?? 0.5;
  const thresholdProb = clamp(operator === 'gte' ? threshold / 2 : 1 - threshold / 2, 0.15, 0.85);
  const modelProbability = clamp(openProb * 0.45 + nwsProb * 0.35 + thresholdProb * 0.2);

  return {
    observedValue: openValues.length ? Math.max(...openValues) / 100 : null,
    modelProbability,
    sourceProbabilities: [openProb, nwsProb],
    sourceNotes: {
      open: openValues.length ? `Peak hourly precipitation probability over next 72h reached ${Math.round(Math.max(...openValues))}%.` : 'Open-Meteo unavailable, fallback prior used.',
      nws: nwsValues.length ? `NWS hourly precip probability peaked at ${Math.round(Math.max(...nwsValues))}%.` : 'NWS hourly feed unavailable, fallback prior used.',
      market: `Precipitation rule scored in ${operator === 'gte' ? 'over-threshold' : 'under-threshold'} mode from parsed market language.`,
    },
    scoringMode: 'precipitation-threshold',
  };
}

function buildTemperatureProbabilities(schema: ResolutionSchema, openMeteo: OpenMeteoResponse | null, nws: NwsHourlyResponse | null): WeatherInputs {
  const openValues = (openMeteo?.hourly?.temperature_2m ?? []).filter((value): value is number => value !== null).slice(0, 72);
  const nwsValues = (nws?.properties?.periods ?? []).map((period) => period.temperature).filter((value): value is number => value !== undefined).slice(0, 36);
  const threshold = schema.threshold ?? 100;
  const operator = schema.operator === 'lte' ? 'lte' : 'gte';
  const openObserved = openValues.length ? Math.max(...openValues) : threshold - (operator === 'gte' ? 4 : -4);
  const nwsObserved = nwsValues.length ? Math.max(...nwsValues) : threshold - (operator === 'gte' ? 3 : -3);
  const openProb = buildThresholdProbability(openObserved, threshold, operator, 12);
  const nwsProb = buildThresholdProbability(nwsObserved, threshold, operator, 10);
  const modelProbability = clamp(openProb * 0.6 + nwsProb * 0.4);

  return {
    observedValue: Math.max(openObserved, nwsObserved),
    modelProbability,
    sourceProbabilities: [openProb, nwsProb],
    sourceNotes: {
      open: `Open-Meteo max hourly temperature is ${Math.round(openObserved)}°F over the next 72h.`,
      nws: `NWS hourly temperature path peaks near ${Math.round(nwsObserved)}°F.`,
      market: `Temperature rule scored in ${operator === 'gte' ? 'heat-threshold' : 'cool-cap'} mode from parsed market language.`,
    },
    scoringMode: 'temperature-threshold',
  };
}

function buildWindProbabilities(schema: ResolutionSchema, openMeteo: OpenMeteoResponse | null, nws: NwsHourlyResponse | null): WeatherInputs {
  const openValues = (openMeteo?.hourly?.wind_speed_10m ?? []).filter((value): value is number => value !== null).slice(0, 72);
  const nwsValues = (nws?.properties?.periods ?? [])
    .map((period) => parseWindSpeedNumber(period.windSpeed))
    .filter((value): value is number => value !== null)
    .slice(0, 36);
  const threshold = schema.threshold ?? 25;
  const openObserved = openValues.length ? Math.max(...openValues) : threshold - 5;
  const nwsObserved = nwsValues.length ? Math.max(...nwsValues) : threshold - 3;
  const openProb = buildThresholdProbability(openObserved, threshold, 'gte', 14);
  const nwsProb = buildThresholdProbability(nwsObserved, threshold, 'gte', 12);
  const textBoost = clamp(((nws?.properties?.periods ?? []).some((period) => /wind|gust/i.test(`${period.shortForecast ?? ''} ${period.detailedForecast ?? ''}`)) ? 0.08 : 0), 0, 0.08);
  const modelProbability = clamp(openProb * 0.55 + nwsProb * 0.35 + textBoost);

  return {
    observedValue: Math.max(openObserved, nwsObserved),
    modelProbability,
    sourceProbabilities: [openProb, nwsProb],
    sourceNotes: {
      open: `Open-Meteo max hourly wind speed is ${Math.round(openObserved)} mph over the next 72h.`,
      nws: `NWS hourly wind path peaks near ${Math.round(nwsObserved)} mph and forecast text is checked for gust language.`,
      market: 'Wind rule scored from hourly wind plus NWS forecast wording.',
    },
    scoringMode: 'wind-threshold',
  };
}

function buildStormProbabilities(openMeteo: OpenMeteoResponse | null, nws: NwsHourlyResponse | null): WeatherInputs {
  const precip = buildPrecipProbabilities({ kind: 'precipitation', metric: 'storm precipitation', operator: 'gte', threshold: 0.5, units: 'in', rawRule: 'Storm scaffold', parseConfidence: 0.5 }, openMeteo, nws);
  const wind = buildWindProbabilities({ kind: 'windSpeed', metric: 'storm wind', operator: 'gte', threshold: 25, units: 'mph', rawRule: 'Storm scaffold', parseConfidence: 0.5 }, openMeteo, nws);
  const modelProbability = clamp(precip.modelProbability * 0.45 + wind.modelProbability * 0.55);
  return {
    observedValue: Math.max(precip.observedValue ?? 0, wind.observedValue ?? 0),
    modelProbability,
    sourceProbabilities: [precip.modelProbability, wind.modelProbability],
    sourceNotes: {
      open: 'Storm scaffold blends precipitation stress with wind-speed stress from Open-Meteo.',
      nws: 'Storm scaffold blends NWS precipitation context, wind path, and text mentions.',
      market: 'Named-storm contracts avoid the old generic blend and use storm-condition scaffolding instead.',
    },
    scoringMode: 'named-storm-occurrence',
  };
}

function buildGenericProbabilities(openMeteo: OpenMeteoResponse | null, nws: NwsHourlyResponse | null): WeatherInputs {
  const precip = buildPrecipProbabilities({ kind: 'precipitation', metric: 'generic precipitation', operator: 'gte', threshold: 0.4, units: 'in', rawRule: 'Generic weather event', parseConfidence: 0.2 }, openMeteo, nws);
  const temp = buildTemperatureProbabilities({ kind: 'temperatureMax', metric: 'maximum temperature', operator: 'gte', threshold: 90, units: '°F', rawRule: 'Generic weather event', parseConfidence: 0.2 }, openMeteo, nws);
  const wind = buildWindProbabilities({ kind: 'windSpeed', metric: 'wind speed', operator: 'gte', threshold: 20, units: 'mph', rawRule: 'Generic weather event', parseConfidence: 0.2 }, openMeteo, nws);
  const modelProbability = clamp(precip.modelProbability * 0.35 + temp.modelProbability * 0.35 + wind.modelProbability * 0.3);
  return {
    observedValue: Math.max(temp.observedValue ?? 0, wind.observedValue ?? 0),
    modelProbability,
    sourceProbabilities: [precip.modelProbability, temp.modelProbability, wind.modelProbability],
    sourceNotes: {
      open: 'Generic weather blend from Open-Meteo precipitation, temperature, and wind paths.',
      nws: 'Generic weather blend from NWS hourly precipitation, temperature, wind, and text context.',
      market: 'Fallback only, used when the market rule still cannot be mapped cleanly.',
    },
    scoringMode: 'generic-weather',
  };
}

function disagreementFrom(values: number[]) {
  if (values.length < 2) return 0.05;
  return clamp(Math.max(...values) - Math.min(...values));
}

function quoteAgeMinutesFrom(quote?: ClobQuote) {
  return quote?.fetchedAt ? minutesSince(quote.fetchedAt) : 240;
}

function quoteSpreadScoreFrom(quote?: ClobQuote) {
  if (!quote) return 0.12;
  if (quote.bestBid === null && quote.bestAsk === null) return 0.08;
  if (quote.spread === null) return 0.3;
  return 1 - clamp(quote.spread / 0.18);
}

function quoteStatusFrom(quote?: ClobQuote): QuoteStatus {
  const quoteAgeMinutes = quoteAgeMinutesFrom(quote);
  if (!quote || (quote.bestBid === null && quote.bestAsk === null)) return 'empty';
  if (quoteAgeMinutes >= 45) return 'stale';
  const spread = quote.spread;
  if (spread === null) return 'tradable';
  if (spread <= 0.035) return 'tight';
  if (spread <= 0.085) return 'tradable';
  return 'wide';
}

function confidenceFrom(edge: number, disagreement: number, freshnessMinutes: number, parseConfidence: number, profile: EventScoringProfile, quote?: ClobQuote, liveMatchConfidence?: number) {
  const edgeScore = clamp(Math.abs(edge) / 0.25);
  const agreementScore = 1 - clamp(disagreement / 0.4);
  const freshnessScore = 1 - clamp(freshnessMinutes / 720);
  const quoteAgeScore = 1 - clamp(quoteAgeMinutesFrom(quote) / 180);
  const quoteSpreadScore = quoteSpreadScoreFrom(quote);
  const discoveryScore = liveMatchConfidence ?? parseConfidence;
  return clamp((edgeScore * 0.26 + agreementScore * 0.18 + freshnessScore * 0.13 + parseConfidence * 0.16 + discoveryScore * 0.19 + quoteAgeScore * 0.04 + quoteSpreadScore * 0.04) * profile.confidenceWeight, 0.08, 0.98);
}

export function applyQuoteRefreshToMarket(market: WeatherMarket, update: MarketQuoteUpdate): WeatherMarket {
  const impliedProbability = update.impliedProbability ?? market.impliedProbability;
  const clobQuote = update.clobQuote ?? market.clobQuote;
  const edge = clamp(market.modelProbability - impliedProbability, -1, 1);
  const quoteAgeMinutes = quoteAgeMinutesFrom(clobQuote);
  const freshnessMinutes = Math.max(quoteAgeMinutes, Math.max(0, minutesSince(update.updatedAt ?? market.lastUpdated)));
  const disagreement = disagreementFrom([
    ...market.sources.filter((source) => source.name !== 'Polymarket CLOB').map((source) => source.probability),
    impliedProbability,
  ]);
  const profile = eventScoringProfile(market.resolutionSchema);
  const confidence = confidenceFrom(edge, disagreement, freshnessMinutes, market.discovery.parseConfidence, profile, clobQuote, market.discovery.parseConfidence);
  const recencyScore = 1 - clamp(freshnessMinutes / 720);
  const sourceAgreement = 1 - clamp(disagreement / 0.4);
  const quoteStatus = quoteStatusFrom(clobQuote);
  const heuristicSummary = `${fmtPct(impliedProbability)} market price versus ${fmtPct(market.modelProbability)} ${market.heuristicDetails.weatherScore === market.modelProbability ? market.resolutionSchema.kind.replace(/([A-Z])/g, ' $1').trim().toLowerCase() : 'weather'} model context for ${market.location}. ${quoteStatus === 'tight' ? 'Quote is tight.' : quoteStatus === 'wide' ? 'Quote is wide.' : quoteStatus === 'stale' ? 'Quote is aging.' : quoteStatus === 'empty' ? 'Order book is thin.' : 'Quote remains tradable.'}`;

  return {
    ...market,
    impliedProbability,
    edge,
    disagreement,
    confidence,
    freshnessMinutes,
    lastUpdated: update.updatedAt ?? market.lastUpdated,
    heuristicSummary,
    heuristicDetails: {
      ...market.heuristicDetails,
      recencyScore,
      sourceAgreement,
      quoteAgeMinutes,
      quoteSpreadScore: quoteSpreadScoreFrom(clobQuote),
    },
    sources: market.sources.map((source) => source.name === 'Polymarket CLOB'
      ? {
        ...source,
        probability: impliedProbability,
        deltaVsMarket: 0,
        freshnessMinutes: quoteAgeMinutes,
        signal: 'neutral',
        note: `Live quote refresh updated implied probability to ${fmtPct(impliedProbability)} with ${quoteStatus} quote status.`,
      }
      : {
        ...source,
        deltaVsMarket: source.probability - impliedProbability,
        signal: signalForDelta(source.probability - impliedProbability),
        freshnessMinutes: Math.max(source.freshnessMinutes, freshnessMinutes),
      }),
    clobQuote,
    quoteStatus,
  };
}

function discoveryFor(item: FlattenedEventMarket, schema: ResolutionSchema, canonicalLocation: string | null): DiscoveryInfo {
  const canonicalQueryParts = [canonicalLocation, schema.metric, schema.threshold ? `${schema.operator}-${schema.threshold}${schema.units ?? ''}` : schema.operator].filter(Boolean);
  return {
    hasExchangeContract: true,
    matchedVia: 'live-event-market',
    parseConfidence: schema.parseConfidence,
    canonicalQuery: canonicalQueryParts.join(' | ') || item.event.slug,
    schemaLabel: prettySchema(schema),
    eventId: item.event.id,
    eventSlug: item.event.slug,
    eventTitle: item.event.title,
  };
}

async function normalizeEventMarket(item: FlattenedEventMarket): Promise<WeatherMarket> {
  const discoveryAssessment = assessWeatherDiscovery(item);
  const schema = parseResolutionSchema(item);
  const forecastSupport = forecastSupportFor(item, schema);
  const canonicalLocationGuess = guessLocation(`${schema.location ?? ''} ${item.market.question} ${item.event.title}`);
  const canonicalLocation = canonicalLocationGuess?.label ?? null;
  const [openMeteo, nws] = canonicalLocationGuess
    ? await Promise.all([getOpenMeteo(canonicalLocationGuess.latitude, canonicalLocationGuess.longitude), getNwsHourly(canonicalLocationGuess.latitude, canonicalLocationGuess.longitude)])
    : [null, null];

  const profile = eventScoringProfile(schema);
  const built = schema.kind === 'temperatureMax'
    ? buildTemperatureProbabilities(schema, openMeteo, nws)
    : schema.kind === 'precipitation'
      ? buildPrecipProbabilities(schema, openMeteo, nws)
      : schema.kind === 'windSpeed'
        ? buildWindProbabilities(schema, openMeteo, nws)
        : schema.kind === 'namedStorm'
          ? buildStormProbabilities(openMeteo, nws)
          : buildGenericProbabilities(openMeteo, nws);

  const impliedProbability = parsePolymarketImpliedProbability(item.market) ?? 0.5;
  const edge = clamp(built.modelProbability - impliedProbability, -1, 1);
  const freshnessCandidates = [item.market.updatedAt, item.event.updatedAt, nws?.properties?.updated].filter((value): value is string => Boolean(value));
  const freshnessMinutes = freshnessCandidates.length ? Math.min(...freshnessCandidates.map(minutesSince)) : 180;
  const disagreement = disagreementFrom([...built.sourceProbabilities, impliedProbability]);
  const clobQuote = clobQuoteFor(item.market);
  const liveMatchConfidence = liveMatchConfidenceFrom(discoveryAssessment, schema, canonicalLocation, clobQuote, item.market);
  const confidence = clamp(
    confidenceFrom(edge, disagreement, freshnessMinutes, schema.parseConfidence, profile, clobQuote, liveMatchConfidence) - forecastSupport.actionabilityPenalty,
    0.05,
    0.98,
  );
  const recencyScore = 1 - clamp(freshnessMinutes / 720);
  const sourceAgreement = 1 - clamp(disagreement / 0.4);
  const outcomes = parseStringArray(item.market.outcomes);
  const outcomePrices = parseOutcomePrices(item.market.outcomePrices);
  const clobTokenIds = parseStringArray(item.market.clobTokenIds);
  const displayedLocation = schema.location ?? canonicalLocation ?? 'Global / not parsed';

  return {
    id: item.market.id,
    title: item.market.question,
    contract: item.event.title,
    location: displayedLocation,
    expiry: item.market.endDate ? new Date(item.market.endDate).toLocaleString('en-US', { month: 'short', day: 'numeric' }) : (item.event.endDate ? new Date(item.event.endDate).toLocaleString('en-US', { month: 'short', day: 'numeric' }) : 'Live'),
    side: 'YES',
    impliedProbability,
    modelProbability: built.modelProbability,
    edge,
    disagreement,
    confidence,
    liquidity: fmtMoney(liquidityNumber(item.market)),
    volume24h: fmtMoney(volumeNumber(item.market)),
    notes: `Discovered from Gamma event “${item.event.title}” with ${discoveryAssessment.matchStrength} live weather-match confidence ${fmtPct(liveMatchConfidence)}. Canonical location resolved to ${canonicalLocation ?? 'no confident local point'}, then scored with ${profile.summary.toLowerCase()}. ${forecastSupport.summary} Discovery signals: ${discoveryAssessment.reasons.slice(0, 4).join(', ')}.`,
    thesis: 'Event-first discovery from Gamma weather events, with canonicalized market-rule parsing before weather-model enrichment.',
    catalysts: ['Gamma weather event updates', 'CLOB price movement', 'Open-Meteo refresh', 'NWS hourly refresh'],
    risks: [
      canonicalLocation ? 'Canonical location is inferred from market language and may still miss sub-city observation sites.' : 'No reliable canonical location was found, so confidence is capped by parser quality and live-match certainty.',
      schema.kind === 'unknown' ? 'Rule remains partially unparsed, so fallback scoring is intentionally conservative.' : `Scoring currently follows ${built.scoringMode} and should be upgraded with settlement-specific features later.`,
      forecastSupport.status === 'unsupported'
        ? 'This contract sits outside the short-range forecast window, so confidence is penalized and it should be treated as low-actionability.'
        : forecastSupport.status === 'near-limit'
          ? 'This contract is near the edge of the forecast window, so confidence is trimmed for horizon risk.'
          : 'Polymarket wording may still hide edge cases in observation windows or exact settlement sources.',
    ],
    resolution: item.market.description ?? item.event.description ?? 'See Polymarket event description.',
    freshnessMinutes,
    dataOrigin: 'polymarket-event',
    lastUpdated: freshnessCandidates[0] ?? new Date().toISOString(),
    heuristicSummary: `${fmtPct(impliedProbability)} market price versus ${fmtPct(built.modelProbability)} ${built.scoringMode.replace(/-/g, ' ')} model context for ${displayedLocation}. ${forecastSupport.status === 'unsupported' ? 'Forecast support is weak for this timing.' : forecastSupport.status === 'near-limit' ? 'Forecast support is near its limit.' : forecastSupport.status === 'supported' ? 'Forecast support is aligned with timing.' : 'Timing is not forecast-bound.'}`,
    heuristicDetails: {
      thresholdLabel: `${prettySchema(schema)}${schema.observationWindow ? ` · ${schema.observationWindow}` : ''}${forecastSupport.coverageDays ? ` · ${forecastSupport.status}` : ''}`,
      thresholdValue: schema.threshold ?? null,
      observedValue: built.observedValue,
      units: schema.units ?? '',
      weatherScore: built.modelProbability,
      recencyScore,
      sourceAgreement,
      quoteAgeMinutes: quoteAgeMinutesFrom(clobQuote),
      quoteSpreadScore: quoteSpreadScoreFrom(clobQuote),
    },
    sources: [
      {
        name: 'Open-Meteo',
        probability: built.sourceProbabilities[0] ?? built.modelProbability,
        deltaVsMarket: (built.sourceProbabilities[0] ?? built.modelProbability) - impliedProbability,
        signal: signalForDelta((built.sourceProbabilities[0] ?? built.modelProbability) - impliedProbability),
        note: canonicalLocationGuess ? built.sourceNotes.open : 'No reliable local location parse, so Open-Meteo enrichment was skipped.',
        freshnessMinutes,
      },
      {
        name: 'NWS hourly',
        probability: built.sourceProbabilities[1] ?? built.modelProbability,
        deltaVsMarket: (built.sourceProbabilities[1] ?? built.modelProbability) - impliedProbability,
        signal: signalForDelta((built.sourceProbabilities[1] ?? built.modelProbability) - impliedProbability),
        note: canonicalLocationGuess ? built.sourceNotes.nws : 'No reliable local location parse, so NWS enrichment was skipped.',
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
    discovery: {
      ...discoveryFor(item, schema, canonicalLocation),
      parseConfidence: liveMatchConfidence,
    },
    marketSlug: item.market.slug,
    conditionId: item.market.conditionId,
    clobTokenIds,
    outcomes,
    outcomePrices,
    clobQuote,
    quoteStatus: quoteStatusFrom(clobQuote),
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

function isTrustworthyLiveMarket(market: WeatherMarket) {
  const parseThreshold = market.resolutionSchema.kind === 'namedStorm'
    ? 0.58
    : market.resolutionSchema.kind === 'unknown'
      ? 0.84
      : 0.68;
  const confidenceThreshold = market.resolutionSchema.kind === 'unknown' ? 0.52 : 0.44;
  const liquidityValue = Number.parseFloat(market.liquidity.replace(/[^\d.]/g, '')) || 0;
  const hasUsableQuote = market.quoteStatus !== 'empty' || market.event?.liquidity === 0 || market.event?.liquidity === undefined || (market.event?.liquidity ?? 0) >= 2_500;
  const forecastUnsupported = market.notes.includes('well beyond the 3-day forecast window used by the model');
  const nearLimitTiming = /near its limit/i.test(market.heuristicSummary) || /\bnear-limit\b/i.test(market.heuristicDetails.thresholdLabel);
  const staleInputs = market.freshnessMinutes > 150;
  const thinLiquidity = liquidityValue < 500 && (market.event?.liquidity ?? 0) < 500;

  if (market.resolutionSchema.kind === 'unknown') return false;
  if (forecastUnsupported && market.resolutionSchema.kind !== 'namedStorm') return false;
  if (market.discovery.parseConfidence < parseThreshold) return false;
  if (market.confidence < confidenceThreshold) return false;
  if (!hasUsableQuote) return false;
  if (thinLiquidity && Math.abs(market.edge) < 0.1) return false;
  if (staleInputs && market.confidence < 0.72) return false;
  if (nearLimitTiming && Math.abs(market.edge) < 0.12) return false;
  if (market.resolutionSchema.kind === 'namedStorm' && market.disagreement > 0.16) return false;
  return true;
}

export async function getWeatherMarkets(): Promise<WeatherMarketResponse> {
  const polymarket = await getPolymarketSnapshot();
  const markets = await mapWithConcurrency(polymarket.items, BOT_MARKET_NORMALIZE_CONCURRENCY, (item) => normalizeEventMarket(item));
  markets.sort((a, b) => Math.abs(b.edge) * b.confidence - Math.abs(a.edge) * a.confidence);

  const qualifiedMarkets = markets.filter((market) => isTrustworthyLiveMarket(market));

  return {
    markets: qualifiedMarkets,
    meta: {
      ...polymarket.meta,
      usedCuratedFallback: false,
      refreshedAt: now().toISOString(),
      weatherSourceMix: ['Gamma weather events', 'Polymarket CLOB', 'Open-Meteo', 'NWS'],
    },
  };
}

async function getQuoteUpdates(): Promise<MarketQuoteUpdate[]> {
  const polymarket = await getPolymarketSnapshot();
  return polymarket.items.map((item) => ({
    marketId: item.market.id,
    impliedProbability: parsePolymarketImpliedProbability(item.market),
    clobQuote: clobQuoteFor(item.market),
    updatedAt: item.market.updatedAt,
  }));
}

export const localMarketProvider: MarketProvider = {
  getMarkets: getWeatherMarkets,
  getQuoteUpdates,
};
