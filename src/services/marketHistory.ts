import type { WeatherMarket } from '../types';

export type MarketHistorySnapshot = {
  capturedAt: string;
  impliedProbability: number;
  edge: number;
  confidence: number;
  spread: number | null;
  midpoint: number | null;
};

export type MarketHistoryRecord = {
  marketId: string;
  title: string;
  location: string;
  contract: string;
  snapshots: MarketHistorySnapshot[];
};

export type MetricTrend = {
  current: number | null;
  previous: number | null;
  delta: number | null;
  direction: 'up' | 'down' | 'flat' | 'unknown';
};

export type MarketTrendSummary = {
  impliedProbability: MetricTrend;
  edge: MetricTrend;
  confidence: MetricTrend;
  spread: MetricTrend;
  latestCapturedAt: string | null;
  previousCapturedAt: string | null;
  snapshotCount: number;
};

export type WatcherOverview = {
  trackedMarketCount: number;
  snapshotsStored: number;
  risingEdgeCount: number;
  tighteningSpreadCount: number;
  lastCapturedAt: string | null;
};

const STORAGE_KEY = 'weather-market-history:v1';
const MAX_SNAPSHOTS_PER_MARKET = 36;
const MAX_MARKET_RECORDS = 80;
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 14;

function hasLocalStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readStore(): Record<string, MarketHistoryRecord> {
  if (!hasLocalStorage()) return {};

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, MarketHistoryRecord>;
    return parsed ?? {};
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, MarketHistoryRecord>) {
  if (!hasLocalStorage()) return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function trimSnapshots(snapshots: MarketHistorySnapshot[]) {
  const cutoff = Date.now() - MAX_AGE_MS;
  return snapshots
    .filter((snapshot) => Number.isFinite(new Date(snapshot.capturedAt).getTime()) && new Date(snapshot.capturedAt).getTime() >= cutoff)
    .slice(-MAX_SNAPSHOTS_PER_MARKET);
}

function toSnapshot(market: WeatherMarket, capturedAt: string): MarketHistorySnapshot {
  return {
    capturedAt,
    impliedProbability: market.impliedProbability,
    edge: market.edge,
    confidence: market.confidence,
    spread: market.clobQuote?.spread ?? null,
    midpoint: market.clobQuote?.midpoint ?? null,
  };
}

function shouldAppendSnapshot(previous: MarketHistorySnapshot | undefined, next: MarketHistorySnapshot) {
  if (!previous) return true;
  return previous.impliedProbability !== next.impliedProbability
    || previous.edge !== next.edge
    || previous.confidence !== next.confidence
    || previous.spread !== next.spread
    || previous.midpoint !== next.midpoint
    || previous.capturedAt !== next.capturedAt;
}

export function captureMarketHistory(markets: WeatherMarket[], capturedAt: string) {
  const store = readStore();

  for (const market of markets) {
    const nextSnapshot = toSnapshot(market, capturedAt);
    const existing = store[market.id];
    const snapshots = trimSnapshots(existing?.snapshots ?? []);
    const previous = snapshots[snapshots.length - 1];
    const merged = shouldAppendSnapshot(previous, nextSnapshot) ? [...snapshots, nextSnapshot] : snapshots;

    store[market.id] = {
      marketId: market.id,
      title: market.title,
      location: market.location,
      contract: market.contract,
      snapshots: trimSnapshots(merged),
    };
  }

  const entries = Object.entries(store)
    .sort(([, left], [, right]) => {
      const leftAt = left.snapshots[left.snapshots.length - 1]?.capturedAt ?? '';
      const rightAt = right.snapshots[right.snapshots.length - 1]?.capturedAt ?? '';
      return rightAt.localeCompare(leftAt);
    })
    .slice(0, MAX_MARKET_RECORDS);

  writeStore(Object.fromEntries(entries));
}

export function getMarketHistory(marketId: string): MarketHistoryRecord | null {
  const store = readStore();
  return store[marketId] ?? null;
}

function buildTrend(current: number | null, previous: number | null): MetricTrend {
  if (current === null || previous === null) {
    return { current, previous, delta: null, direction: 'unknown' };
  }

  const delta = current - previous;
  return {
    current,
    previous,
    delta,
    direction: delta === 0 ? 'flat' : delta > 0 ? 'up' : 'down',
  };
}

export function summarizeMarketTrend(marketId: string): MarketTrendSummary {
  const history = getMarketHistory(marketId);
  const snapshots = history?.snapshots ?? [];
  const latest = snapshots[snapshots.length - 1] ?? null;
  const previous = snapshots[snapshots.length - 2] ?? null;

  return {
    impliedProbability: buildTrend(latest?.impliedProbability ?? null, previous?.impliedProbability ?? null),
    edge: buildTrend(latest?.edge ?? null, previous?.edge ?? null),
    confidence: buildTrend(latest?.confidence ?? null, previous?.confidence ?? null),
    spread: buildTrend(latest?.spread ?? null, previous?.spread ?? null),
    latestCapturedAt: latest?.capturedAt ?? null,
    previousCapturedAt: previous?.capturedAt ?? null,
    snapshotCount: snapshots.length,
  };
}

export function getWatcherOverview(): WatcherOverview {
  const records = Object.values(readStore());
  const snapshotsStored = records.reduce((sum, record) => sum + record.snapshots.length, 0);
  const latestCaptureTimes = records
    .map((record) => record.snapshots[record.snapshots.length - 1]?.capturedAt)
    .filter((capturedAt): capturedAt is string => Boolean(capturedAt))
    .sort();
  const lastCapturedAt = latestCaptureTimes.length ? latestCaptureTimes[latestCaptureTimes.length - 1] : null;

  let risingEdgeCount = 0;
  let tighteningSpreadCount = 0;

  for (const record of records) {
    const trend = summarizeMarketTrend(record.marketId);
    if ((trend.edge.delta ?? 0) > 0) risingEdgeCount += 1;
    if ((trend.spread.delta ?? 0) < 0) tighteningSpreadCount += 1;
  }

  return {
    trackedMarketCount: records.length,
    snapshotsStored,
    risingEdgeCount,
    tighteningSpreadCount,
    lastCapturedAt,
  };
}
