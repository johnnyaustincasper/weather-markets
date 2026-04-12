import type { PaperTradePlan, PaperPositionState } from './paperTrading.js';
import type { WeatherMarket } from '../types.js';
import type { PaperExecutionProfile, PaperExecutionSettings } from './paperExecutionSettings.js';
import { mergePaperExecutionSettings } from './paperExecutionSettings.js';

type PaperTradeRecord = {
  state: PaperPositionState;
  updatedAt: string;
  note: string;
};

export type PaperExitReason = 'take-profit' | 'stop-loss' | 'monitor';

export type PaperBlotterJournalEntry = {
  at: string;
  kind: 'state-change' | 'mark' | 'suggestion' | 'reprice';
  summary: string;
};

export type PaperBlotterEntry = {
  marketId: string;
  marketTitle: string;
  setupType: WeatherMarket['resolutionSchema']['kind'];
  direction: PaperTradePlan['direction'];
  state: PaperPositionState;
  thesisSnapshot: string;
  entryPrice: number | null;
  currentMark: number | null;
  closePrice: number | null;
  pnlPoints: number | null;
  pnlPercentOnRisk: number | null;
  realizedPnlPoints: number | null;
  realizedPnlPercentOnRisk: number | null;
  markedPnlPoints: number | null;
  outcome: 'win' | 'loss' | 'flat' | 'open' | 'queued';
  queuedAt: string | null;
  activatedAt: string | null;
  closedAt: string | null;
  lastMarkedAt: string | null;
  lastRepricedAt: string | null;
  entryEdge: number;
  currentEdge: number;
  entryConfidence: number;
  currentConfidence: number;
  stopPrice: number | null;
  takeProfitPrice: number | null;
  executionSettings: PaperExecutionSettings;
  exitSuggestion: {
    shouldClose: boolean;
    reason: PaperExitReason;
    summary: string;
    triggeredAt: string | null;
  };
  journal: PaperBlotterJournalEntry[];
};

export type PaperPerformanceBucket = {
  key: string;
  label: string;
  total: number;
  closed: number;
  open: number;
  wins: number;
  losses: number;
  flats: number;
  queued: number;
  winRate: number | null;
  avgEntryEdge: number | null;
  avgRealizedPnl: number | null;
  avgMarkedPnl: number | null;
  totalRealizedPnl: number;
  totalMarkedPnl: number;
};

export type PaperPerformanceSummary = {
  totals: PaperPerformanceBucket;
  bySetupType: PaperPerformanceBucket[];
  byEdgeBucket: PaperPerformanceBucket[];
  byDirection: PaperPerformanceBucket[];
  byConfidenceBucket: PaperPerformanceBucket[];
  expectancyDrift: {
    recentWindow: number;
    baselineWindow: number;
    recent: {
      sampleSize: number;
      wins: number;
      losses: number;
      flats: number;
      expectancyPerTrade: number | null;
      winRate: number | null;
      totalRealizedPnl: number;
    };
    baseline: {
      sampleSize: number;
      wins: number;
      losses: number;
      flats: number;
      expectancyPerTrade: number | null;
      winRate: number | null;
      totalRealizedPnl: number;
    };
    driftPerTrade: number | null;
    driftDirection: 'improving' | 'deteriorating' | 'flat' | 'insufficient';
    severity: 'good' | 'warn' | 'bad' | 'muted';
    headline: string;
    detail: string;
  };
  setupFamilyHeat: {
    leaders: (PaperPerformanceBucket & { expectancyPerTrade: number | null; trendLabel: string })[];
    laggards: (PaperPerformanceBucket & { expectancyPerTrade: number | null; trendLabel: string })[];
  };
  fastValidation: {
    closedCount: number;
    expectancyPerTrade: number | null;
    expectancyLabel: string;
    recentForm: {
      sampleSize: number;
      wins: number;
      losses: number;
      flats: number;
      totalRealizedPnl: number;
      avgRealizedPnl: number | null;
      streak: { direction: 'win' | 'loss' | 'flat' | 'mixed'; count: number };
    };
    scorecard: {
      avgWin: number | null;
      avgLoss: number | null;
      payoffRatio: number | null;
      profitFactor: number | null;
      qualityLabel: string;
    };
    failureClusters: {
      key: string;
      label: string;
      count: number;
      avgRealizedPnl: number | null;
      totalRealizedPnl: number;
      detail: string;
    }[];
    loserPatternClusters: {
      key: string;
      label: string;
      count: number;
      setups: string[];
      directions: PaperTradePlan['direction'][];
      avgEntryEdge: number | null;
      avgConfidenceDrop: number | null;
      avgRealizedPnl: number | null;
      totalRealizedPnl: number;
      detail: string;
    }[];
  };
  diagnostics: {
    bestSetup: PaperPerformanceBucket | null;
    weakestSetup: PaperPerformanceBucket | null;
    strongestEdgeBucket: PaperPerformanceBucket | null;
    weakestEdgeBucket: PaperPerformanceBucket | null;
    bestDirection: PaperPerformanceBucket | null;
    weakestDirection: PaperPerformanceBucket | null;
    strongestConfidenceBucket: PaperPerformanceBucket | null;
    weakestConfidenceBucket: PaperPerformanceBucket | null;
    setupKillSuggestions: {
      key: string;
      setupType: string;
      label: string;
      severity: 'downgrade' | 'disable';
      tradeCount: number;
      lossCount: number;
      winRate: number | null;
      totalRealizedPnl: number;
      sampleNote: string;
      rationale: string;
      action: string;
    }[];
    patterns: { title: string; detail: string; tone: 'good' | 'warn' | 'bad' }[];
    lessons: string[];
  };
  lastClosedAt: string | null;
};

export type PaperAfterActionReview = {
  marketId: string;
  marketTitle: string;
  outcome: PaperBlotterEntry['outcome'];
  verdict: 'excellent' | 'solid' | 'mixed' | 'needs-work';
  score: number;
  headline: string;
  summary: string;
  why: string[];
  refineNextTime: string[];
  strengths: string[];
  warnings: string[];
  timeline: { label: string; detail: string; at: string | null }[];
};

const STORAGE_KEY = 'weather-markets-paper-blotter:v1';
const MAX_JOURNAL = 18;

function hasLocalStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readStore(): Record<string, PaperBlotterEntry> {
  if (!hasLocalStorage()) return {};

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, PaperBlotterEntry> : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, PaperBlotterEntry>) {
  if (!hasLocalStorage()) return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function appendJournal(existing: PaperBlotterJournalEntry[], next: PaperBlotterJournalEntry) {
  const previous = existing[existing.length - 1];
  if (previous?.kind === next.kind && previous.summary === next.summary) return existing.slice(-MAX_JOURNAL);
  return [...existing, next].slice(-MAX_JOURNAL);
}

function rawReferencePriceFor(market: WeatherMarket, fillReference: PaperExecutionSettings['fillReference']) {
  if (fillReference === 'ask') return market.clobQuote?.bestAsk ?? market.clobQuote?.midpoint ?? market.clobQuote?.lastTradePrice ?? market.impliedProbability ?? null;
  if (fillReference === 'bid') return market.clobQuote?.bestBid ?? market.clobQuote?.midpoint ?? market.clobQuote?.lastTradePrice ?? market.impliedProbability ?? null;
  if (fillReference === 'last') return market.clobQuote?.lastTradePrice ?? market.clobQuote?.midpoint ?? market.impliedProbability ?? null;
  return market.clobQuote?.midpoint ?? market.clobQuote?.lastTradePrice ?? market.impliedProbability ?? null;
}

function applySlippage(price: number | null, direction: PaperTradePlan['direction'], slippageBps: number) {
  if (price === null || direction === 'stand-aside') return price;
  const slippage = slippageBps / 10_000;
  const adjusted = direction === 'buy-yes' ? price + slippage : price - slippage;
  return Math.min(1, Math.max(0, adjusted));
}

function entryPriceFor(market: WeatherMarket, direction: PaperTradePlan['direction'], settings: PaperExecutionSettings) {
  return applySlippage(rawReferencePriceFor(market, settings.fillReference), direction, settings.slippageBps);
}

function currentMarkFor(market: WeatherMarket) {
  return market.clobQuote?.midpoint ?? market.clobQuote?.lastTradePrice ?? market.impliedProbability ?? null;
}

function buildMonitorExitSuggestion(state: PaperPositionState) {
  return {
    shouldClose: false,
    reason: 'monitor' as const,
    summary: state === 'queued' ? 'Queued locally, waiting for activation.' : 'Closed locally, no further action.',
    triggeredAt: null,
  };
}

function signedPnL(direction: PaperTradePlan['direction'], entryPrice: number | null, currentMark: number | null) {
  if (entryPrice === null || currentMark === null || direction === 'stand-aside') return null;
  return direction === 'buy-yes' ? currentMark - entryPrice : entryPrice - currentMark;
}

function stopPriceFor(direction: PaperTradePlan['direction'], entryPrice: number | null, settings: PaperExecutionSettings) {
  if (entryPrice === null || direction === 'stand-aside') return null;
  return direction === 'buy-yes'
    ? Math.max(0, entryPrice - settings.stopLossPts)
    : Math.min(1, entryPrice + settings.stopLossPts);
}

function takeProfitPriceFor(direction: PaperTradePlan['direction'], entryPrice: number | null, settings: PaperExecutionSettings) {
  if (entryPrice === null || direction === 'stand-aside') return null;
  return direction === 'buy-yes'
    ? Math.min(1, entryPrice + settings.takeProfitPts)
    : Math.max(0, entryPrice - settings.takeProfitPts);
}

function exitSuggestionFor(direction: PaperTradePlan['direction'], currentMark: number | null, stopPrice: number | null, takeProfitPrice: number | null, market: WeatherMarket) {
  if (direction === 'stand-aside' || currentMark === null) {
    return {
      shouldClose: false,
      reason: 'monitor' as const,
      summary: 'No paper position edge yet, stay in monitor mode.',
      triggeredAt: null,
    };
  }

  const stopHit = stopPrice !== null && (direction === 'buy-yes' ? currentMark <= stopPrice : currentMark >= stopPrice);
  if (stopHit || Math.abs(market.edge) < 0.03 || market.confidence < 0.55) {
    return {
      shouldClose: true,
      reason: 'stop-loss' as const,
      summary: stopHit
        ? 'Stop-loss condition hit, close the paper position.'
        : 'Edge or confidence broke down, close the paper position.',
      triggeredAt: new Date().toISOString(),
    };
  }

  const takeProfitHit = takeProfitPrice !== null && (direction === 'buy-yes' ? currentMark >= takeProfitPrice : currentMark <= takeProfitPrice);
  if (takeProfitHit) {
    return {
      shouldClose: true,
      reason: 'take-profit' as const,
      summary: 'Take-profit condition hit, scale out or close the paper position.',
      triggeredAt: new Date().toISOString(),
    };
  }

  return {
    shouldClose: false,
    reason: 'monitor' as const,
    summary: 'Hold and re-mark on the next quote refresh.',
    triggeredAt: null,
  };
}

function classifyOutcome(state: PaperPositionState, pnlPoints: number | null) {
  if (state === 'queued') return 'queued' as const;
  if (state !== 'closed') return 'open' as const;
  if (pnlPoints === null || Math.abs(pnlPoints) < 0.0001) return 'flat' as const;
  return pnlPoints > 0 ? 'win' as const : 'loss' as const;
}

function buildBucket(key: string, label: string, entries: PaperBlotterEntry[]): PaperPerformanceBucket {
  const closed = entries.filter((entry) => entry.state === 'closed');
  const wins = closed.filter((entry) => entry.outcome === 'win').length;
  const losses = closed.filter((entry) => entry.outcome === 'loss').length;
  const flats = closed.filter((entry) => entry.outcome === 'flat').length;
  const open = entries.filter((entry) => entry.state === 'active').length;
  const queued = entries.filter((entry) => entry.state === 'queued').length;
  const totalRealizedPnl = Number(closed.reduce((sum, entry) => sum + (entry.realizedPnlPoints ?? 0), 0).toFixed(4));
  const totalMarkedPnl = Number(entries.reduce((sum, entry) => sum + (entry.markedPnlPoints ?? 0), 0).toFixed(4));
  const avg = (values: number[]) => values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4)) : null;

  return {
    key,
    label,
    total: entries.length,
    closed: closed.length,
    open,
    wins,
    losses,
    flats,
    queued,
    winRate: closed.length ? wins / closed.length : null,
    avgEntryEdge: avg(entries.map((entry) => entry.entryEdge)),
    avgRealizedPnl: avg(closed.map((entry) => entry.realizedPnlPoints ?? 0)),
    avgMarkedPnl: avg(entries.map((entry) => entry.markedPnlPoints ?? 0)),
    totalRealizedPnl,
    totalMarkedPnl,
  };
}

function edgeBucketKeyFor(entryEdge: number) {
  const absEdge = Math.abs(entryEdge);
  if (absEdge >= 0.15) return { key: 'edge-15-plus', label: '15+ pt edge' };
  if (absEdge >= 0.1) return { key: 'edge-10-14', label: '10 to 14 pt edge' };
  if (absEdge >= 0.06) return { key: 'edge-6-9', label: '6 to 9 pt edge' };
  return { key: 'edge-sub-6', label: 'Under 6 pt edge' };
}

function confidenceBucketKeyFor(entryConfidence: number) {
  if (entryConfidence >= 0.75) return { key: 'confidence-75-plus', label: '75%+ confidence' };
  if (entryConfidence >= 0.65) return { key: 'confidence-65-74', label: '65% to 74%' };
  return { key: 'confidence-sub-65', label: 'Under 65%' };
}

function directionBucketFor(direction: PaperTradePlan['direction']) {
  if (direction === 'buy-yes') return { key: 'buy-yes', label: 'Buy YES' };
  if (direction === 'buy-no') return { key: 'buy-no', label: 'Buy NO' };
  return { key: 'stand-aside', label: 'Stand aside' };
}

function pickBestBucket(buckets: PaperPerformanceBucket[]) {
  return buckets
    .filter((bucket) => bucket.closed > 0)
    .sort((left, right) => right.totalRealizedPnl - left.totalRealizedPnl || (right.winRate ?? -1) - (left.winRate ?? -1))[0] ?? null;
}

function pickWorstBucket(buckets: PaperPerformanceBucket[]) {
  return buckets
    .filter((bucket) => bucket.closed > 0)
    .sort((left, right) => left.totalRealizedPnl - right.totalRealizedPnl || (left.winRate ?? 2) - (right.winRate ?? 2))[0] ?? null;
}

function buildPatterns(entries: PaperBlotterEntry[], totals: PaperPerformanceBucket, bySetupType: PaperPerformanceBucket[], byEdgeBucket: PaperPerformanceBucket[]) {
  const patterns: { title: string; detail: string; tone: 'good' | 'warn' | 'bad' }[] = [];
  const closed = entries.filter((entry) => entry.state === 'closed');
  const winners = closed.filter((entry) => entry.outcome === 'win');
  const losers = closed.filter((entry) => entry.outcome === 'loss');
  const avg = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

  if (closed.length) {
    const winnerEdge = avg(winners.map((entry) => Math.abs(entry.entryEdge)));
    const loserEdge = avg(losers.map((entry) => Math.abs(entry.entryEdge)));
    if (winnerEdge !== null && loserEdge !== null) {
      patterns.push({
        title: winnerEdge > loserEdge ? 'Bigger entry edge is helping' : 'Big entry edge is not converting cleanly',
        detail: `Closed winners opened at ${Math.round(winnerEdge * 100)} pts average edge versus ${Math.round(loserEdge * 100)} pts for losers.`,
        tone: winnerEdge > loserEdge ? 'good' : 'warn',
      });
    }

    const winnerConfidence = avg(winners.map((entry) => entry.entryConfidence));
    const loserConfidence = avg(losers.map((entry) => entry.entryConfidence));
    if (winnerConfidence !== null && loserConfidence !== null) {
      patterns.push({
        title: winnerConfidence >= loserConfidence ? 'Confidence is aligned with outcomes' : 'High-confidence trades are underperforming',
        detail: `Winners opened at ${Math.round(winnerConfidence * 100)}% confidence versus ${Math.round(loserConfidence * 100)}% for losers.`,
        tone: winnerConfidence >= loserConfidence ? 'good' : 'bad',
      });
    }
  }

  const bestSetup = pickBestBucket(bySetupType);
  if (bestSetup) {
    patterns.push({
      title: `${bestSetup.label} is the current leader`,
      detail: `${bestSetup.closed} closed trades, ${Math.round((bestSetup.winRate ?? 0) * 100)}% win rate, ${Math.round(bestSetup.totalRealizedPnl * 100)} pts realized.`,
      tone: bestSetup.totalRealizedPnl >= 0 ? 'good' : 'warn',
    });
  }

  const weakestEdge = pickWorstBucket(byEdgeBucket);
  if (weakestEdge) {
    patterns.push({
      title: `${weakestEdge.label} is dragging review`,
      detail: `${weakestEdge.closed} closed trades with ${Math.round((weakestEdge.winRate ?? 0) * 100)}% win rate and ${Math.round(weakestEdge.totalRealizedPnl * 100)} pts realized.`,
      tone: weakestEdge.totalRealizedPnl < 0 ? 'bad' : 'warn',
    });
  }

  if (!patterns.length && totals.total > 0) {
    patterns.push({
      title: 'More closes needed',
      detail: 'Trades are being tracked, but there are not enough closed outcomes yet to isolate a real pattern.',
      tone: 'warn',
    });
  }

  return patterns.slice(0, 4);
}

function buildLessons(totals: PaperPerformanceBucket, bySetupType: PaperPerformanceBucket[], byEdgeBucket: PaperPerformanceBucket[], byDirection: PaperPerformanceBucket[], byConfidenceBucket: PaperPerformanceBucket[]) {
  const lessons: string[] = [];
  const bestSetup = pickBestBucket(bySetupType);
  const weakestSetup = pickWorstBucket(bySetupType);
  const strongestEdgeBucket = pickBestBucket(byEdgeBucket);
  const weakestEdgeBucket = pickWorstBucket(byEdgeBucket);

  if (bestSetup && bestSetup.totalRealizedPnl > 0) {
    lessons.push(`Lean harder into ${bestSetup.label} when the scanner agrees, it is the strongest realized setup group so far.`);
  }
  if (strongestEdgeBucket && strongestEdgeBucket.key !== 'edge-sub-6') {
    lessons.push(`The cleanest closes are coming from ${strongestEdgeBucket.label.toLowerCase()}, so keep weak-edge trades on a shorter leash.`);
  }
  if (weakestSetup && weakestSetup.totalRealizedPnl < 0) {
    lessons.push(`Review ${weakestSetup.label} entries for false positives, that setup family is the biggest realized drag right now.`);
  }
  if (weakestEdgeBucket && weakestEdgeBucket.totalRealizedPnl < 0) {
    lessons.push(`${weakestEdgeBucket.label} is underperforming, tighten entry standards or downsize that bucket.`);
  }
  const bestDirection = pickBestBucket(byDirection);
  const weakestDirection = pickWorstBucket(byDirection);
  const strongestConfidenceBucket = pickBestBucket(byConfidenceBucket);
  const weakestConfidenceBucket = pickWorstBucket(byConfidenceBucket);

  if (bestDirection && bestDirection.totalRealizedPnl > 0) {
    lessons.push(`${bestDirection.label} is the cleaner side right now, so let the weaker side earn risk back before sizing it equally.`);
  }
  if (strongestConfidenceBucket && strongestConfidenceBucket.totalRealizedPnl > 0) {
    lessons.push(`${strongestConfidenceBucket.label} entries are validating best, so demand more proof before taking lower-confidence trades.`);
  }
  if (weakestDirection && weakestDirection.totalRealizedPnl < 0) {
    lessons.push(`${weakestDirection.label} is bleeding expectancy, so tighten those entries or reduce frequency on that side.`);
  }
  if (weakestConfidenceBucket && weakestConfidenceBucket.totalRealizedPnl < 0) {
    lessons.push(`${weakestConfidenceBucket.label} is underperforming, which is a good sign to wait for cleaner confirmation before deploying.`);
  }
  if (!lessons.length && totals.total > 0) {
    lessons.push('Keep collecting closes. The review layer is live, but there is not enough dispersion yet to promote a hard lesson.');
  }

  return lessons.slice(0, 4);
}

function round4(value: number) {
  return Number(value.toFixed(4));
}

function buildExpectancySlice(entries: PaperBlotterEntry[]) {
  const closed = entries.filter((entry) => entry.state === 'closed');
  const realized = closed.map((entry) => entry.realizedPnlPoints ?? 0);
  const wins = closed.filter((entry) => entry.outcome === 'win').length;
  const losses = closed.filter((entry) => entry.outcome === 'loss').length;
  const flats = closed.filter((entry) => entry.outcome === 'flat').length;
  return {
    sampleSize: closed.length,
    wins,
    losses,
    flats,
    expectancyPerTrade: closed.length ? round4(realized.reduce((sum, value) => sum + value, 0) / closed.length) : null,
    winRate: closed.length ? wins / closed.length : null,
    totalRealizedPnl: round4(realized.reduce((sum, value) => sum + value, 0)),
  };
}

function buildExpectancyDrift(entries: PaperBlotterEntry[]) {
  const closed = entries
    .filter((entry) => entry.state === 'closed')
    .sort((left, right) => new Date(right.closedAt ?? 0).getTime() - new Date(left.closedAt ?? 0).getTime());
  const recentWindow = Math.min(5, closed.length);
  const baselineWindow = Math.min(12, closed.length);
  const recent = buildExpectancySlice(closed.slice(0, recentWindow));
  const baseline = buildExpectancySlice(closed.slice(0, baselineWindow));
  const driftPerTrade = recent.expectancyPerTrade !== null && baseline.expectancyPerTrade !== null
    ? round4(recent.expectancyPerTrade - baseline.expectancyPerTrade)
    : null;

  if (closed.length < 3 || driftPerTrade === null) {
    return {
      recentWindow,
      baselineWindow,
      recent,
      baseline,
      driftPerTrade: null,
      driftDirection: 'insufficient' as const,
      severity: 'muted' as const,
      headline: 'Need more closed trades for drift review',
      detail: 'Expectancy drift becomes useful after a few closes have accumulated.',
    };
  }

  if (driftPerTrade >= 0.02) {
    return {
      recentWindow,
      baselineWindow,
      recent,
      baseline,
      driftPerTrade,
      driftDirection: 'improving' as const,
      severity: 'good' as const,
      headline: 'Recent expectancy is improving',
      detail: `Last ${recent.sampleSize} closes are running ${Math.round(driftPerTrade * 100)} pts/trade better than the broader ${baseline.sampleSize}-trade baseline.`,
    };
  }

  if (driftPerTrade <= -0.02) {
    return {
      recentWindow,
      baselineWindow,
      recent,
      baseline,
      driftPerTrade,
      driftDirection: 'deteriorating' as const,
      severity: 'bad' as const,
      headline: 'Expectancy drift is deteriorating',
      detail: `Last ${recent.sampleSize} closes are running ${Math.abs(Math.round(driftPerTrade * 100))} pts/trade worse than the broader ${baseline.sampleSize}-trade baseline.`,
    };
  }

  return {
    recentWindow,
    baselineWindow,
    recent,
    baseline,
    driftPerTrade,
    driftDirection: 'flat' as const,
    severity: 'warn' as const,
    headline: 'Expectancy is roughly flat versus baseline',
    detail: `Recent tape is within ${Math.abs(Math.round(driftPerTrade * 100))} pts/trade of the ${baseline.sampleSize}-trade baseline, so keep monitoring for a cleaner break.`,
  };
}

function bucketExpectancy(bucket: PaperPerformanceBucket) {
  return bucket.closed ? round4(bucket.totalRealizedPnl / bucket.closed) : null;
}

function setupTrendLabel(bucket: PaperPerformanceBucket) {
  const expectancy = bucketExpectancy(bucket);
  if (bucket.closed < 2 || expectancy === null) return 'Thin sample';
  if (expectancy >= 0.02) return 'Press this family';
  if (expectancy <= -0.02) return 'Cut this family';
  return 'Mixed family';
}

function buildRecentForm(entries: PaperBlotterEntry[]) {
  const recent = entries
    .filter((entry) => entry.state === 'closed')
    .sort((left, right) => new Date(right.closedAt ?? 0).getTime() - new Date(left.closedAt ?? 0).getTime())
    .slice(0, 5);

  const wins = recent.filter((entry) => entry.outcome === 'win').length;
  const losses = recent.filter((entry) => entry.outcome === 'loss').length;
  const flats = recent.filter((entry) => entry.outcome === 'flat').length;
  const totalRealizedPnl = round4(recent.reduce((sum, entry) => sum + (entry.realizedPnlPoints ?? 0), 0));
  const avgRealizedPnl = recent.length ? round4(totalRealizedPnl / recent.length) : null;

  let streakDirection: 'win' | 'loss' | 'flat' | 'mixed' = 'mixed';
  let streakCount = 0;
  if (recent.length) {
    const first = recent[0].outcome;
    if (first === 'win' || first === 'loss' || first === 'flat') {
      streakDirection = first;
      streakCount = recent.findIndex((entry) => entry.outcome !== first);
      if (streakCount === -1) streakCount = recent.length;
    }
  }

  return {
    sampleSize: recent.length,
    wins,
    losses,
    flats,
    totalRealizedPnl,
    avgRealizedPnl,
    streak: { direction: streakDirection, count: streakCount },
  };
}

function buildFailureClusters(entries: PaperBlotterEntry[]) {
  const closedLosers = entries.filter((entry) => entry.state === 'closed' && entry.outcome === 'loss');
  const clusters = [
    {
      key: 'thin-edge',
      label: 'Thin edge losses',
      items: closedLosers.filter((entry) => Math.abs(entry.entryEdge) < 0.06),
      detail: 'Losses that started with less than 6 pts of entry edge.',
    },
    {
      key: 'confidence-fade',
      label: 'Confidence fade',
      items: closedLosers.filter((entry) => entry.currentConfidence <= entry.entryConfidence - 0.05),
      detail: 'Losses where forecast confidence materially deteriorated after entry.',
    },
    {
      key: 'edge-collapse',
      label: 'Edge collapse',
      items: closedLosers.filter((entry) => entry.currentEdge <= entry.entryEdge - 0.03),
      detail: 'Losses where the market quickly closed the original gap.',
    },
    {
      key: 'stop-loss',
      label: 'Stop-triggered exits',
      items: closedLosers.filter((entry) => entry.exitSuggestion.reason === 'stop-loss'),
      detail: 'Losses that ended with the rules engine already signaling a stop/exit.',
    },
  ];

  return clusters
    .filter((cluster) => cluster.items.length)
    .map((cluster) => ({
      key: cluster.key,
      label: cluster.label,
      count: cluster.items.length,
      avgRealizedPnl: cluster.items.length ? round4(cluster.items.reduce((sum, entry) => sum + (entry.realizedPnlPoints ?? 0), 0) / cluster.items.length) : null,
      totalRealizedPnl: round4(cluster.items.reduce((sum, entry) => sum + (entry.realizedPnlPoints ?? 0), 0)),
      detail: cluster.detail,
    }))
    .sort((left, right) => right.count - left.count || left.totalRealizedPnl - right.totalRealizedPnl)
    .slice(0, 4);
}

function buildLoserPatternClusters(entries: PaperBlotterEntry[]) {
  const closedLosers = entries.filter((entry) => entry.state === 'closed' && entry.outcome === 'loss');
  const clusterSpecs = [
    {
      key: 'setup-thin-edge-confidence-fade',
      label: 'Thin edge, then confidence faded',
      detail: 'Losses that started with a modest edge and later lost forecast support.',
      match: (entry: PaperBlotterEntry) => Math.abs(entry.entryEdge) < 0.08 && entry.currentConfidence <= entry.entryConfidence - 0.05,
    },
    {
      key: 'setup-edge-collapse-stop',
      label: 'Edge collapsed into stop',
      detail: 'Losses where the original gap compressed quickly and the exit engine already wanted out.',
      match: (entry: PaperBlotterEntry) => entry.currentEdge <= entry.entryEdge - 0.03 && entry.exitSuggestion.reason === 'stop-loss',
    },
    {
      key: 'setup-high-confidence-false-positive',
      label: 'High-confidence false positives',
      detail: 'Losses that looked strong on entry but still failed, a sign the family may be over-trusted.',
      match: (entry: PaperBlotterEntry) => entry.entryConfidence >= 0.72 && (entry.realizedPnlPoints ?? 0) <= -0.03,
    },
    {
      key: 'setup-low-edge-stop',
      label: 'Low edge stop-outs',
      detail: 'Losses taken from weak starting asymmetry that still consumed stop budget.',
      match: (entry: PaperBlotterEntry) => Math.abs(entry.entryEdge) < 0.06 && entry.exitSuggestion.reason === 'stop-loss',
    },
  ];

  return clusterSpecs
    .map((cluster) => {
      const items = closedLosers.filter(cluster.match);
      const confidenceDrops = items.map((entry) => entry.currentConfidence - entry.entryConfidence);
      const avg = (values: number[]) => values.length ? round4(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
      return {
        key: cluster.key,
        label: cluster.label,
        count: items.length,
        setups: Array.from(new Set(items.map((entry) => entry.setupType))),
        directions: Array.from(new Set(items.map((entry) => entry.direction))),
        avgEntryEdge: avg(items.map((entry) => Math.abs(entry.entryEdge))),
        avgConfidenceDrop: avg(confidenceDrops),
        avgRealizedPnl: avg(items.map((entry) => entry.realizedPnlPoints ?? 0)),
        totalRealizedPnl: round4(items.reduce((sum, entry) => sum + (entry.realizedPnlPoints ?? 0), 0)),
        detail: cluster.detail,
      };
    })
    .filter((cluster) => cluster.count >= 2)
    .sort((left, right) => right.count - left.count || left.totalRealizedPnl - right.totalRealizedPnl)
    .slice(0, 4);
}

function buildSetupKillSuggestions(bySetupType: PaperPerformanceBucket[]) {
  return bySetupType
    .filter((bucket) => bucket.closed >= 3 && bucket.losses >= 2 && bucket.totalRealizedPnl < 0)
    .map((bucket) => {
      const winRate = bucket.winRate ?? 0;
      const disable = bucket.closed >= 4 && bucket.losses >= 3 && winRate <= 0.34 && bucket.totalRealizedPnl <= -0.12;
      const severity = disable ? 'disable' as const : 'downgrade' as const;
      return {
        key: `kill-${bucket.key}`,
        setupType: bucket.key,
        label: bucket.label,
        severity,
        tradeCount: bucket.closed,
        lossCount: bucket.losses,
        winRate: bucket.winRate,
        totalRealizedPnl: bucket.totalRealizedPnl,
        sampleNote: disable ? 'Enough closed losses to justify a hard stop.' : 'Early warning only, sample is still modest.',
        rationale: disable
          ? `${bucket.label} has ${bucket.losses} losses in ${bucket.closed} closes with ${round4(bucket.totalRealizedPnl)} realized PnL, which is a sustained drag.`
          : `${bucket.label} is negative across ${bucket.closed} closes and is not yet earning normal sizing back.` ,
        action: disable
          ? `Disable ${bucket.label.toLowerCase()} entries until fresh paper data proves the family recovered.`
          : `Downgrade ${bucket.label.toLowerCase()} to reduced sizing or watch-only until outcomes improve.`,
      };
    })
    .sort((left, right) => (left.severity === right.severity ? left.totalRealizedPnl - right.totalRealizedPnl : left.severity === 'disable' ? -1 : 1))
    .slice(0, 3);
}

export function getPaperBlotter() {
  return readStore();
}

export function repricePaperBlotter(markets: WeatherMarket[], paperState: Record<string, PaperTradeRecord>, paperPlans: Record<string, PaperTradePlan>, executionProfile: PaperExecutionProfile) {
  const store = readStore();
  const marketMap = Object.fromEntries(markets.map((market) => [market.id, market]));
  const nextStore: Record<string, PaperBlotterEntry> = { ...store };
  const repricedAt = new Date().toISOString();
  let changedCount = 0;

  for (const [marketId, existing] of Object.entries(store)) {
    const paperRecord = paperState[marketId];
    const market = marketMap[marketId];
    const plan = paperPlans[marketId];
    if (!paperRecord || !market || !plan || paperRecord.state === 'flat') continue;

    const executionSettings = mergePaperExecutionSettings(executionProfile, marketId);
    const entryPrice = existing.entryPrice ?? entryPriceFor(market, plan.direction, executionSettings);
    const currentMark = currentMarkFor(market);
    const pnlPoints = signedPnL(plan.direction, entryPrice, currentMark);
    const stopPrice = stopPriceFor(plan.direction, entryPrice, executionSettings);
    const takeProfitPrice = takeProfitPriceFor(plan.direction, entryPrice, executionSettings);
    const exitSuggestion = paperRecord.state === 'active'
      ? exitSuggestionFor(plan.direction, currentMark, stopPrice, takeProfitPrice, market)
      : buildMonitorExitSuggestion(paperRecord.state);

    let journal = existing.journal ?? [];
    const previousLabel = `${existing.executionSettings.fillReference.toUpperCase()} + ${existing.executionSettings.slippageBps} bps`;
    const nextLabel = `${executionSettings.fillReference.toUpperCase()} + ${executionSettings.slippageBps} bps`;
    journal = appendJournal(journal, {
      at: repricedAt,
      kind: 'reprice',
      summary: `Repriced local paper blotter from ${previousLabel} to ${nextLabel}, entry ${entryPrice === null ? '--' : `${Math.round(entryPrice * 100)}%`} and risk rails refreshed.`,
    });

    const realizedPnlPoints = paperRecord.state === 'closed' ? (existing.realizedPnlPoints ?? pnlPoints) : existing.realizedPnlPoints;

    nextStore[marketId] = {
      ...existing,
      marketTitle: market.title,
      setupType: market.resolutionSchema.kind,
      direction: plan.direction,
      state: paperRecord.state,
      thesisSnapshot: plan.thesis,
      entryPrice,
      currentMark,
      closePrice: paperRecord.state === 'closed' ? (existing.closePrice ?? currentMark) : existing.closePrice,
      pnlPoints,
      pnlPercentOnRisk: pnlPoints === null ? null : pnlPoints * 100,
      realizedPnlPoints,
      realizedPnlPercentOnRisk: realizedPnlPoints === null ? null : realizedPnlPoints * 100,
      markedPnlPoints: pnlPoints,
      outcome: classifyOutcome(paperRecord.state, realizedPnlPoints),
      lastMarkedAt: repricedAt,
      lastRepricedAt: repricedAt,
      entryEdge: existing.entryEdge,
      currentEdge: market.edge,
      entryConfidence: existing.entryConfidence,
      currentConfidence: market.confidence,
      stopPrice,
      takeProfitPrice,
      executionSettings,
      exitSuggestion,
      journal,
    };
    changedCount += 1;
  }

  writeStore(nextStore);
  return { blotter: nextStore, repricedAt, changedCount };
}

export function syncPaperBlotter(markets: WeatherMarket[], paperState: Record<string, PaperTradeRecord>, paperPlans: Record<string, PaperTradePlan>, executionProfile: PaperExecutionProfile) {
  const store = readStore();
  const nextStore: Record<string, PaperBlotterEntry> = { ...store };

  for (const market of markets) {
    const paperRecord = paperState[market.id];
    if (!paperRecord || paperRecord.state === 'flat') continue;

    const plan = paperPlans[market.id];
    if (!plan) continue;

    const existing = nextStore[market.id];
    const state = paperRecord.state;
    const nowIso = new Date().toISOString();
    const executionSettings = mergePaperExecutionSettings(executionProfile, market.id);
    const entryPrice = existing?.entryPrice ?? entryPriceFor(market, plan.direction, executionSettings);
    const currentMark = currentMarkFor(market);
    const pnlPoints = signedPnL(plan.direction, entryPrice, currentMark);
    const stopPrice = existing?.stopPrice ?? stopPriceFor(plan.direction, entryPrice, executionSettings);
    const takeProfitPrice = existing?.takeProfitPrice ?? takeProfitPriceFor(plan.direction, entryPrice, executionSettings);
    const exitSuggestion = state === 'active'
      ? exitSuggestionFor(plan.direction, currentMark, stopPrice, takeProfitPrice, market)
      : buildMonitorExitSuggestion(state);

    let journal = existing?.journal ?? [];

    if (!existing) {
      journal = appendJournal(journal, {
        at: paperRecord.updatedAt,
        kind: 'state-change',
        summary: `${state.toUpperCase()} at ${entryPrice === null ? 'no mark' : `${Math.round(entryPrice * 100)}%`} using ${executionSettings.fillReference.toUpperCase()} + ${executionSettings.slippageBps} bps with thesis snapshot saved.`,
      });
    } else if (existing.state !== state) {
      journal = appendJournal(journal, {
        at: paperRecord.updatedAt,
        kind: 'state-change',
        summary: `State changed from ${existing.state.toUpperCase()} to ${state.toUpperCase()}.`,
      });
    }

    if (currentMark !== existing?.currentMark || market.edge !== existing?.currentEdge || market.confidence !== existing?.currentConfidence) {
      journal = appendJournal(journal, {
        at: nowIso,
        kind: 'mark',
        summary: `Marked ${currentMark === null ? '--' : `${Math.round(currentMark * 100)}%`} with ${pnlPoints === null ? '--' : `${pnlPoints >= 0 ? '+' : ''}${Math.round(pnlPoints * 100)} pts`} paper PnL.`,
      });
    }

    if (exitSuggestion.shouldClose && exitSuggestion.summary !== existing?.exitSuggestion.summary) {
      journal = appendJournal(journal, {
        at: exitSuggestion.triggeredAt ?? nowIso,
        kind: 'suggestion',
        summary: exitSuggestion.summary,
      });
    }

    const realizedPnlPoints = state === 'closed' ? (existing?.realizedPnlPoints ?? pnlPoints) : existing?.realizedPnlPoints ?? null;

    nextStore[market.id] = {
      marketId: market.id,
      marketTitle: market.title,
      setupType: market.resolutionSchema.kind,
      direction: plan.direction,
      executionSettings,
      state,
      thesisSnapshot: existing?.thesisSnapshot ?? plan.thesis,
      entryPrice,
      currentMark,
      closePrice: state === 'closed' ? (existing?.closePrice ?? currentMark) : existing?.closePrice ?? null,
      pnlPoints,
      pnlPercentOnRisk: pnlPoints === null ? null : pnlPoints * 100,
      realizedPnlPoints,
      realizedPnlPercentOnRisk: realizedPnlPoints === null ? null : realizedPnlPoints * 100,
      markedPnlPoints: pnlPoints,
      outcome: classifyOutcome(state, realizedPnlPoints ?? pnlPoints),
      queuedAt: state === 'queued' ? existing?.queuedAt ?? paperRecord.updatedAt : existing?.queuedAt ?? null,
      activatedAt: state === 'active' ? existing?.activatedAt ?? paperRecord.updatedAt : existing?.activatedAt ?? null,
      closedAt: state === 'closed' ? existing?.closedAt ?? paperRecord.updatedAt : existing?.closedAt ?? null,
      lastMarkedAt: nowIso,
      lastRepricedAt: existing?.lastRepricedAt ?? null,
      entryEdge: existing?.entryEdge ?? market.edge,
      currentEdge: market.edge,
      entryConfidence: existing?.entryConfidence ?? market.confidence,
      currentConfidence: market.confidence,
      stopPrice,
      takeProfitPrice,
      exitSuggestion: existing?.state === 'active' && !exitSuggestion.shouldClose && existing.exitSuggestion.shouldClose
        ? existing.exitSuggestion
        : exitSuggestion,
      journal,
    };
  }

  for (const [marketId, paperRecord] of Object.entries(paperState)) {
    if (paperRecord.state !== 'closed') continue;
    const existing = nextStore[marketId];
    if (!existing) continue;
    let journal = existing.journal;
    if (existing.state !== 'closed') {
      journal = appendJournal(journal, {
        at: paperRecord.updatedAt,
        kind: 'state-change',
        summary: 'Paper position closed locally.',
      });
    }
    nextStore[marketId] = {
      ...existing,
      state: 'closed',
      closePrice: existing.closePrice ?? existing.currentMark,
      realizedPnlPoints: existing.realizedPnlPoints ?? existing.pnlPoints,
      realizedPnlPercentOnRisk: existing.realizedPnlPercentOnRisk ?? (existing.pnlPoints === null ? null : existing.pnlPoints * 100),
      outcome: classifyOutcome('closed', existing.realizedPnlPoints ?? existing.pnlPoints),
      closedAt: existing.closedAt ?? paperRecord.updatedAt,
      journal,
    };
  }

  writeStore(nextStore);
  return nextStore;
}

export function summarizePaperPerformance(blotter: Record<string, PaperBlotterEntry>): PaperPerformanceSummary {
  const entries = Object.values(blotter);
  const closedEntries = entries.filter((entry) => entry.state === 'closed');
  const groups = new Map<string, PaperBlotterEntry[]>();
  const edgeGroups = new Map<string, { label: string; entries: PaperBlotterEntry[] }>();
  const directionGroups = new Map<string, { label: string; entries: PaperBlotterEntry[] }>();
  const confidenceGroups = new Map<string, { label: string; entries: PaperBlotterEntry[] }>();

  for (const entry of entries) {
    const list = groups.get(entry.setupType) ?? [];
    list.push(entry);
    groups.set(entry.setupType, list);

    const edgeBucket = edgeBucketKeyFor(entry.entryEdge);
    const edgeList = edgeGroups.get(edgeBucket.key)?.entries ?? [];
    edgeList.push(entry);
    edgeGroups.set(edgeBucket.key, { label: edgeBucket.label, entries: edgeList });

    const directionBucket = directionBucketFor(entry.direction);
    const directionList = directionGroups.get(directionBucket.key)?.entries ?? [];
    directionList.push(entry);
    directionGroups.set(directionBucket.key, { label: directionBucket.label, entries: directionList });

    const confidenceBucket = confidenceBucketKeyFor(entry.entryConfidence);
    const confidenceList = confidenceGroups.get(confidenceBucket.key)?.entries ?? [];
    confidenceList.push(entry);
    confidenceGroups.set(confidenceBucket.key, { label: confidenceBucket.label, entries: confidenceList });
  }

  const bySetupType = Array.from(groups.entries())
    .map(([key, bucketEntries]) => buildBucket(key, key, bucketEntries))
    .sort((left, right) => right.totalRealizedPnl - left.totalRealizedPnl || right.closed - left.closed);

  const byEdgeBucket = Array.from(edgeGroups.entries())
    .map(([key, value]) => buildBucket(key, value.label, value.entries))
    .sort((left, right) => right.totalRealizedPnl - left.totalRealizedPnl || right.closed - left.closed);

  const byDirection = Array.from(directionGroups.entries())
    .map(([key, value]) => buildBucket(key, value.label, value.entries))
    .sort((left, right) => right.totalRealizedPnl - left.totalRealizedPnl || right.closed - left.closed);

  const byConfidenceBucket = Array.from(confidenceGroups.entries())
    .map(([key, value]) => buildBucket(key, value.label, value.entries))
    .sort((left, right) => right.totalRealizedPnl - left.totalRealizedPnl || right.closed - left.closed);

  const totals = buildBucket('all', 'All setups', entries);

  const closedTimes = entries
    .map((entry) => entry.closedAt)
    .filter((value): value is string => Boolean(value))
    .sort();
  const lastClosedAt = closedTimes.length ? closedTimes[closedTimes.length - 1] : null;
  const expectancyPerTrade = closedEntries.length ? round4(closedEntries.reduce((sum, entry) => sum + (entry.realizedPnlPoints ?? 0), 0) / closedEntries.length) : null;
  const expectancyDrift = buildExpectancyDrift(entries);
  const recentForm = buildRecentForm(entries);
  const failureClusters = buildFailureClusters(entries);
  const loserPatternClusters = buildLoserPatternClusters(entries);
  const wins = closedEntries.filter((entry) => entry.outcome === 'win').map((entry) => entry.realizedPnlPoints ?? 0);
  const losses = closedEntries.filter((entry) => entry.outcome === 'loss').map((entry) => Math.abs(entry.realizedPnlPoints ?? 0));
  const avgWin = wins.length ? round4(wins.reduce((sum, value) => sum + value, 0) / wins.length) : null;
  const avgLoss = losses.length ? round4(losses.reduce((sum, value) => sum + value, 0) / losses.length) : null;
  const grossWins = wins.length ? wins.reduce((sum, value) => sum + value, 0) : 0;
  const grossLosses = losses.length ? losses.reduce((sum, value) => sum + value, 0) : 0;
  const payoffRatio = avgWin !== null && avgLoss !== null && avgLoss > 0 ? round4(avgWin / avgLoss) : null;
  const profitFactor = grossLosses > 0 ? round4(grossWins / grossLosses) : wins.length ? null : null;
  const setupFamilies = bySetupType
    .filter((bucket) => bucket.closed > 0)
    .map((bucket) => ({ ...bucket, expectancyPerTrade: bucketExpectancy(bucket), trendLabel: setupTrendLabel(bucket) }));

  return {
    totals,
    bySetupType,
    byEdgeBucket,
    byDirection,
    byConfidenceBucket,
    expectancyDrift,
    setupFamilyHeat: {
      leaders: setupFamilies
        .slice()
        .sort((left, right) => (right.expectancyPerTrade ?? -999) - (left.expectancyPerTrade ?? -999) || right.closed - left.closed)
        .slice(0, 3),
      laggards: setupFamilies
        .slice()
        .sort((left, right) => (left.expectancyPerTrade ?? 999) - (right.expectancyPerTrade ?? 999) || right.closed - left.closed)
        .slice(0, 3),
    },
    fastValidation: {
      closedCount: closedEntries.length,
      expectancyPerTrade,
      expectancyLabel: expectancyPerTrade === null
        ? 'Need closed trades'
        : expectancyPerTrade > 0.01
          ? 'Positive expectancy'
          : expectancyPerTrade < -0.01
            ? 'Negative expectancy'
            : 'Near flat expectancy',
      recentForm,
      scorecard: {
        avgWin,
        avgLoss,
        payoffRatio,
        profitFactor,
        qualityLabel: closedEntries.length < 4
          ? 'Sample still thin'
          : expectancyPerTrade !== null && expectancyPerTrade > 0 && (profitFactor === null || profitFactor > 1)
            ? 'Repeatable edge improving'
            : expectancyPerTrade !== null && expectancyPerTrade < 0
              ? 'Process needs tightening'
              : 'Mixed tape, keep slicing',
      },
      failureClusters,
      loserPatternClusters,
    },
    diagnostics: {
      bestSetup: pickBestBucket(bySetupType),
      weakestSetup: pickWorstBucket(bySetupType),
      strongestEdgeBucket: pickBestBucket(byEdgeBucket),
      weakestEdgeBucket: pickWorstBucket(byEdgeBucket),
      bestDirection: pickBestBucket(byDirection),
      weakestDirection: pickWorstBucket(byDirection),
      strongestConfidenceBucket: pickBestBucket(byConfidenceBucket),
      weakestConfidenceBucket: pickWorstBucket(byConfidenceBucket),
      setupKillSuggestions: buildSetupKillSuggestions(bySetupType),
      patterns: buildPatterns(entries, totals, bySetupType, byEdgeBucket),
      lessons: buildLessons(totals, bySetupType, byEdgeBucket, byDirection, byConfidenceBucket),
    },
    lastClosedAt,
  };
}

function verdictFor(score: number): PaperAfterActionReview['verdict'] {
  if (score >= 80) return 'excellent';
  if (score >= 65) return 'solid';
  if (score >= 45) return 'mixed';
  return 'needs-work';
}

function headlineFor(entry: PaperBlotterEntry, verdict: PaperAfterActionReview['verdict']) {
  if (entry.outcome === 'win') return verdict === 'excellent' ? 'Thesis held and execution captured it.' : 'Good winner, worth repeating with discipline.';
  if (entry.outcome === 'loss') return 'Loss review, isolate whether the thesis broke or the entry was poor.';
  if (entry.outcome === 'flat') return 'Flat trade, timing and follow-through need a closer look.';
  if (entry.outcome === 'queued') return 'Queued trade, review readiness before activating.';
  return 'Open trade, monitor whether the original reason still holds.';
}

export function buildPaperAfterActionReview(entry: PaperBlotterEntry): PaperAfterActionReview {
  let score = 50;
  const why: string[] = [];
  const refineNextTime: string[] = [];
  const strengths: string[] = [];
  const warnings: string[] = [];

  const realized = entry.realizedPnlPoints ?? entry.pnlPoints ?? 0;
  const edgeChange = entry.currentEdge - entry.entryEdge;
  const confidenceChange = entry.currentConfidence - entry.entryConfidence;
  const hasExitSignal = entry.exitSuggestion.shouldClose;

  if (entry.outcome === 'win') {
    score += 22;
    why.push(`The trade finished green at ${Math.round(realized * 100)} pts, so the position captured real edge instead of only looking good on entry.`);
  } else if (entry.outcome === 'loss') {
    score -= 18;
    why.push(`The trade finished down ${Math.abs(Math.round(realized * 100))} pts, so something in thesis quality, timing, or risk discipline needs tightening.`);
  } else if (entry.outcome === 'flat') {
    why.push('The trade went nowhere after entry, which usually means fair value was already close or the catalyst never really arrived.');
  }

  if (Math.abs(entry.entryEdge) >= 0.1) {
    score += 10;
    strengths.push(`Entry edge was substantial at ${Math.round(entry.entryEdge * 100)} pts.`);
    why.push('The scanner had a meaningful pricing gap at entry, which is the right raw material for a worthwhile trade.');
  } else if (Math.abs(entry.entryEdge) < 0.06) {
    score -= 8;
    warnings.push(`Entry edge was only ${Math.round(entry.entryEdge * 100)} pts.`);
    refineNextTime.push('Be more selective on thin-edge trades, especially when the board is already close to fair value.');
  }

  if (edgeChange > 0.03) {
    score += 8;
    strengths.push(`Edge improved by ${Math.round(edgeChange * 100)} pts after entry.`);
    why.push('The market moved further toward the thesis after entry, which is a sign the read improved with time.');
  } else if (edgeChange < -0.03) {
    score -= 10;
    warnings.push(`Edge faded by ${Math.abs(Math.round(edgeChange * 100))} pts after entry.`);
    refineNextTime.push('Re-check faster when the edge compresses by 3+ pts, because the market may have caught up before the thesis played out.');
  }

  if (confidenceChange >= 0.05) {
    score += 6;
    strengths.push(`Forecast confidence improved from ${Math.round(entry.entryConfidence * 100)}% to ${Math.round(entry.currentConfidence * 100)}%.`);
  } else if (confidenceChange <= -0.05) {
    score -= 7;
    warnings.push(`Forecast confidence slipped from ${Math.round(entry.entryConfidence * 100)}% to ${Math.round(entry.currentConfidence * 100)}%.`);
    refineNextTime.push('Cut faster when forecast confidence deteriorates, even before the hard stop is hit.');
  }

  if (entry.state === 'closed' && hasExitSignal) {
    score += entry.exitSuggestion.reason === 'take-profit' ? 8 : entry.exitSuggestion.reason === 'stop-loss' ? 2 : 0;
    why.push(`The final close aligned with the desk rule: ${entry.exitSuggestion.summary}`);
  } else if (entry.state === 'active' && hasExitSignal) {
    score -= 6;
    warnings.push('The review engine is already signaling a close, but the trade is still marked active.');
    refineNextTime.push('When the review engine flips to close, either exit or write down a specific override reason.');
  }

  if (!refineNextTime.length) {
    refineNextTime.push(entry.outcome === 'win'
      ? 'Keep the same setup, but document the exact entry conditions so you can repeat them deliberately.'
      : 'Write one sentence on what had to be true for this trade to work, then test whether that condition actually improved after entry.');
  }

  if (!strengths.length) strengths.push('The trade is at least being tracked with entry, mark, and thesis snapshots, which makes honest review possible.');
  if (!warnings.length && entry.outcome !== 'win') warnings.push('There is no single glaring failure signal, so focus on timing, catalyst clarity, and whether the initial edge was actually actionable.');

  score = Math.max(0, Math.min(100, score));
  const verdict = verdictFor(score);

  return {
    marketId: entry.marketId,
    marketTitle: entry.marketTitle,
    outcome: entry.outcome,
    verdict,
    score,
    headline: headlineFor(entry, verdict),
    summary: entry.outcome === 'win'
      ? 'This was a good trade if the gain came from a real edge that persisted, not just random tape noise.'
      : entry.outcome === 'loss'
        ? 'Treat this as a process review, not just a red number. The key question is whether the thesis degraded or you paid too much for it.'
        : entry.outcome === 'flat'
          ? 'Flat outcomes are useful because they expose trades that looked exciting but never developed enough asymmetry.'
          : entry.outcome === 'queued'
            ? 'Queued trades should be judged on readiness and selectivity before they become risk.'
            : 'Keep checking whether the current tape still matches the original thesis snapshot.',
    why: why.slice(0, 4),
    refineNextTime: refineNextTime.slice(0, 4),
    strengths: strengths.slice(0, 3),
    warnings: warnings.slice(0, 3),
    timeline: [
      { label: 'Queued', detail: entry.queuedAt ? 'Trade entered the paper queue.' : 'Not queued.', at: entry.queuedAt },
      { label: 'Activated', detail: entry.activatedAt ? `Active near ${entry.entryPrice === null ? '--' : `${Math.round(entry.entryPrice * 100)}%`}.` : 'Never marked active.', at: entry.activatedAt },
      { label: 'Latest mark', detail: entry.currentMark === null ? 'No current mark saved.' : `Latest mark ${Math.round(entry.currentMark * 100)}%, current edge ${Math.round(entry.currentEdge * 100)} pts.`, at: entry.lastMarkedAt },
      { label: 'Closed', detail: entry.closedAt ? `Closed near ${entry.closePrice === null ? '--' : `${Math.round(entry.closePrice * 100)}%`} with ${entry.realizedPnlPoints === null ? '--' : `${entry.realizedPnlPoints >= 0 ? '+' : ''}${Math.round(entry.realizedPnlPoints * 100)} pts`}.` : 'Still open.', at: entry.closedAt },
    ],
  };
}
