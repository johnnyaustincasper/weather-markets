import type { QuoteStatus, WeatherMarket } from '../types.js';

export type MarketHistorySnapshot = {
  capturedAt: string;
  impliedProbability: number;
  edge: number;
  confidence: number;
  spread: number | null;
  midpoint: number | null;
  freshnessMinutes: number;
  quoteStatus: QuoteStatus;
  quoteQualityScore: number;
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
  freshness: MetricTrend;
  quoteQuality: MetricTrend;
  latestCapturedAt: string | null;
  previousCapturedAt: string | null;
  snapshotCount: number;
  latestQuoteStatus: QuoteStatus | null;
  previousQuoteStatus: QuoteStatus | null;
  statusFlipCount: number;
};

export type WatcherExecutionRegimeKind = 'flip-risk' | 'execution-degrading' | 'tradability-improving';

export type WatcherRegimeTuning = {
  windowSize: number;
  flipRiskMinFlips: number;
  qualityDropThreshold: number;
  qualityRiseThreshold: number;
  freshnessPenaltyMin: number;
  requireMonotonicQuality: boolean;
};

export type WatcherExecutionRegime = {
  marketId: string;
  title: string;
  location: string;
  kind: WatcherExecutionRegimeKind;
  summary: string;
  detail: string;
  signalCount: number;
  score: number;
  latestQuoteStatus: QuoteStatus | null;
  previousQuoteStatus: QuoteStatus | null;
  latestCapturedAt: string | null;
  tuningLabel: string;
};

export type WatcherExecutionRegimeOverview = {
  windowSize: number;
  totalFlagged: number;
  flipRiskCount: number;
  degradingCount: number;
  improvingCount: number;
  latestCapturedAt: string | null;
  regimes: WatcherExecutionRegime[];
  tuning: WatcherRegimeTuning;
  tuningLabel: string;
};

export type WatcherOverview = {
  trackedMarketCount: number;
  snapshotsStored: number;
  risingEdgeCount: number;
  tighteningSpreadCount: number;
  executionImprovingCount: number;
  freshnessWorseningCount: number;
  lastCapturedAt: string | null;
};

const STORAGE_KEY = 'weather-market-history:v1';
const MAX_SNAPSHOTS_PER_MARKET = 36;
const MAX_MARKET_RECORDS = 80;
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 14;
const DEFAULT_REGIME_WINDOW = 6;

export const DEFAULT_WATCHER_REGIME_TUNING: WatcherRegimeTuning = {
  windowSize: DEFAULT_REGIME_WINDOW,
  flipRiskMinFlips: 2,
  qualityDropThreshold: 0.18,
  qualityRiseThreshold: 0.18,
  freshnessPenaltyMin: 0,
  requireMonotonicQuality: true,
};

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

function quoteStatusScore(status: QuoteStatus) {
  if (status === 'tight') return 1;
  if (status === 'tradable') return 0.72;
  if (status === 'wide') return 0.42;
  if (status === 'stale') return 0.2;
  return 0;
}

function quoteStatusRank(status: QuoteStatus | null) {
  if (status === 'tight') return 4;
  if (status === 'tradable') return 3;
  if (status === 'wide') return 2;
  if (status === 'stale') return 1;
  if (status === 'empty') return 0;
  return -1;
}

function toSnapshot(market: WeatherMarket, capturedAt: string): MarketHistorySnapshot {
  return {
    capturedAt,
    impliedProbability: market.impliedProbability,
    edge: market.edge,
    confidence: market.confidence,
    spread: market.clobQuote?.spread ?? null,
    midpoint: market.clobQuote?.midpoint ?? null,
    freshnessMinutes: market.freshnessMinutes,
    quoteStatus: market.quoteStatus,
    quoteQualityScore: quoteStatusScore(market.quoteStatus),
  };
}

function shouldAppendSnapshot(previous: MarketHistorySnapshot | undefined, next: MarketHistorySnapshot) {
  if (!previous) return true;
  return previous.impliedProbability !== next.impliedProbability
    || previous.edge !== next.edge
    || previous.confidence !== next.confidence
    || previous.spread !== next.spread
    || previous.midpoint !== next.midpoint
    || previous.freshnessMinutes !== next.freshnessMinutes
    || previous.quoteStatus !== next.quoteStatus
    || previous.quoteQualityScore !== next.quoteQualityScore
    || previous.capturedAt !== next.capturedAt;
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

function countStatusFlips(snapshots: MarketHistorySnapshot[]) {
  let flipCount = 0;
  for (let index = 1; index < snapshots.length; index += 1) {
    if (snapshots[index - 1]?.quoteStatus !== snapshots[index]?.quoteStatus) flipCount += 1;
  }
  return flipCount;
}

function isMonotonic(values: number[], direction: 'up' | 'down') {
  if (values.length < 3) return false;
  return values.every((value, index) => index === 0 || (direction === 'up' ? value >= values[index - 1] : value <= values[index - 1]));
}

function formatStatus(status: QuoteStatus | null) {
  return status ? status.toUpperCase() : '--';
}

function formatTuningLabel(tuning: WatcherRegimeTuning) {
  return `${tuning.windowSize} snap · ${tuning.flipRiskMinFlips}+ flips · ${Math.round(tuning.qualityDropThreshold * 100)}pt drop / ${Math.round(tuning.qualityRiseThreshold * 100)}pt rise`;
}

function summarizeExecutionRegime(record: MarketHistoryRecord, tuning: WatcherRegimeTuning): WatcherExecutionRegime[] {
  const window = record.snapshots.slice(-tuning.windowSize);
  if (window.length < 3) return [];

  const latest = window[window.length - 1] ?? null;
  const previous = window[window.length - 2] ?? null;
  const quoteQuality = window.map((snapshot) => snapshot.quoteQualityScore);
  const spreadValues = window.map((snapshot) => snapshot.spread).filter((value): value is number => value !== null);
  const statusFlips = countStatusFlips(window);
  const latestStatus = latest?.quoteStatus ?? null;
  const previousStatus = previous?.quoteStatus ?? null;
  const statusRankDelta = quoteStatusRank(latestStatus) - quoteStatusRank(window[0]?.quoteStatus ?? null);
  const qualityDelta = (latest?.quoteQualityScore ?? 0) - (window[0]?.quoteQualityScore ?? 0);
  const freshnessDelta = (latest?.freshnessMinutes ?? 0) - (window[0]?.freshnessMinutes ?? 0);
  const spreadDelta = spreadValues.length >= 2 ? spreadValues[spreadValues.length - 1] - spreadValues[0] : 0;
  const regimes: WatcherExecutionRegime[] = [];
  const tuningLabel = formatTuningLabel(tuning);
  const qualityFalling = tuning.requireMonotonicQuality ? isMonotonic(quoteQuality, 'down') : qualityDelta < 0;
  const qualityRising = tuning.requireMonotonicQuality ? isMonotonic(quoteQuality, 'up') : qualityDelta > 0;

  if (statusFlips >= tuning.flipRiskMinFlips) {
    regimes.push({
      marketId: record.marketId,
      title: record.title,
      location: record.location,
      kind: 'flip-risk',
      summary: `${record.title} keeps flipping quote posture`,
      detail: `${statusFlips} quote-status flips over the last ${window.length} local snapshots, now ${formatStatus(latestStatus)} after ${formatStatus(previousStatus)}. Triggered under ${tuningLabel}.`,
      signalCount: statusFlips,
      score: statusFlips + Math.abs(statusRankDelta) + Math.abs(qualityDelta),
      latestQuoteStatus: latestStatus,
      previousQuoteStatus: previousStatus,
      latestCapturedAt: latest?.capturedAt ?? null,
      tuningLabel,
    });
  }

  if (qualityDelta <= -tuning.qualityDropThreshold && qualityFalling && freshnessDelta >= tuning.freshnessPenaltyMin) {
    regimes.push({
      marketId: record.marketId,
      title: record.title,
      location: record.location,
      kind: 'execution-degrading',
      summary: `${record.title} is steadily losing execution quality`,
      detail: `Quote quality slid ${Math.round(Math.abs(qualityDelta) * 100)} pts over ${window.length} snapshots, freshness worsened by ${Math.round(freshnessDelta)}m${spreadValues.length >= 2 ? `, spread moved ${spreadDelta >= 0 ? '+' : ''}${Math.round(spreadDelta * 100)} pts` : ''}. Triggered under ${tuningLabel}.`,
      signalCount: window.length,
      score: Math.abs(qualityDelta) * 10 + Math.max(freshnessDelta, 0) / 30 + Math.max(spreadDelta, 0) * 5,
      latestQuoteStatus: latestStatus,
      previousQuoteStatus: previousStatus,
      latestCapturedAt: latest?.capturedAt ?? null,
      tuningLabel,
    });
  }

  if (qualityDelta >= tuning.qualityRiseThreshold && qualityRising && statusRankDelta > 0) {
    regimes.push({
      marketId: record.marketId,
      title: record.title,
      location: record.location,
      kind: 'tradability-improving',
      summary: `${record.title} is becoming easier to trade`,
      detail: `Quote quality improved ${Math.round(qualityDelta * 100)} pts over ${window.length} snapshots and quote status climbed from ${formatStatus(window[0]?.quoteStatus ?? null)} to ${formatStatus(latestStatus)}${spreadValues.length >= 2 ? ` with spread ${spreadDelta < 0 ? 'tightening' : 'holding roughly flat'}` : ''}. Triggered under ${tuningLabel}.`,
      signalCount: window.length,
      score: qualityDelta * 10 + statusRankDelta + Math.max(-spreadDelta, 0) * 5,
      latestQuoteStatus: latestStatus,
      previousQuoteStatus: previousStatus,
      latestCapturedAt: latest?.capturedAt ?? null,
      tuningLabel,
    });
  }

  return regimes;
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
    freshness: buildTrend(latest?.freshnessMinutes ?? null, previous?.freshnessMinutes ?? null),
    quoteQuality: buildTrend(latest?.quoteQualityScore ?? null, previous?.quoteQualityScore ?? null),
    latestCapturedAt: latest?.capturedAt ?? null,
    previousCapturedAt: previous?.capturedAt ?? null,
    snapshotCount: snapshots.length,
    latestQuoteStatus: latest?.quoteStatus ?? null,
    previousQuoteStatus: previous?.quoteStatus ?? null,
    statusFlipCount: countStatusFlips(snapshots),
  };
}

export function getWatcherExecutionRegimes(tuning: WatcherRegimeTuning = DEFAULT_WATCHER_REGIME_TUNING): WatcherExecutionRegimeOverview {
  const records = Object.values(readStore());
  const regimes = records
    .flatMap((record) => summarizeExecutionRegime(record, tuning))
    .sort((left, right) => right.score - left.score || (right.latestCapturedAt ?? '').localeCompare(left.latestCapturedAt ?? ''));

  const latestCapturedAt = regimes[0]?.latestCapturedAt ?? null;
  const flipRiskCount = regimes.filter((regime) => regime.kind === 'flip-risk').length;
  const degradingCount = regimes.filter((regime) => regime.kind === 'execution-degrading').length;
  const improvingCount = regimes.filter((regime) => regime.kind === 'tradability-improving').length;

  return {
    windowSize: tuning.windowSize,
    totalFlagged: regimes.length,
    flipRiskCount,
    degradingCount,
    improvingCount,
    latestCapturedAt,
    regimes,
    tuning,
    tuningLabel: formatTuningLabel(tuning),
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
  let executionImprovingCount = 0;
  let freshnessWorseningCount = 0;

  for (const record of records) {
    const trend = summarizeMarketTrend(record.marketId);
    if ((trend.edge.delta ?? 0) > 0) risingEdgeCount += 1;
    if ((trend.spread.delta ?? 0) < 0) tighteningSpreadCount += 1;
    if ((trend.quoteQuality.delta ?? 0) > 0) executionImprovingCount += 1;
    if ((trend.freshness.delta ?? 0) > 0) freshnessWorseningCount += 1;
  }

  return {
    trackedMarketCount: records.length,
    snapshotsStored,
    risingEdgeCount,
    tighteningSpreadCount,
    executionImprovingCount,
    freshnessWorseningCount,
    lastCapturedAt,
  };
}
