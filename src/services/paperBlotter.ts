import type { PaperTradePlan, PaperPositionState } from './paperTrading';
import type { WeatherMarket } from '../types';
import type { PaperExecutionProfile, PaperExecutionSettings } from './paperExecutionSettings';
import { mergePaperExecutionSettings } from './paperExecutionSettings';

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
  diagnostics: {
    bestSetup: PaperPerformanceBucket | null;
    weakestSetup: PaperPerformanceBucket | null;
    strongestEdgeBucket: PaperPerformanceBucket | null;
    weakestEdgeBucket: PaperPerformanceBucket | null;
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

function buildLessons(totals: PaperPerformanceBucket, bySetupType: PaperPerformanceBucket[], byEdgeBucket: PaperPerformanceBucket[]) {
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
  if (!lessons.length && totals.total > 0) {
    lessons.push('Keep collecting closes. The review layer is live, but there is not enough dispersion yet to promote a hard lesson.');
  }

  return lessons.slice(0, 4);
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
  const groups = new Map<string, PaperBlotterEntry[]>();
  const edgeGroups = new Map<string, { label: string; entries: PaperBlotterEntry[] }>();

  for (const entry of entries) {
    const list = groups.get(entry.setupType) ?? [];
    list.push(entry);
    groups.set(entry.setupType, list);

    const edgeBucket = edgeBucketKeyFor(entry.entryEdge);
    const edgeList = edgeGroups.get(edgeBucket.key)?.entries ?? [];
    edgeList.push(entry);
    edgeGroups.set(edgeBucket.key, { label: edgeBucket.label, entries: edgeList });
  }

  const bySetupType = Array.from(groups.entries())
    .map(([key, bucketEntries]) => buildBucket(key, key, bucketEntries))
    .sort((left, right) => right.totalRealizedPnl - left.totalRealizedPnl || right.closed - left.closed);

  const byEdgeBucket = Array.from(edgeGroups.entries())
    .map(([key, value]) => buildBucket(key, value.label, value.entries))
    .sort((left, right) => right.totalRealizedPnl - left.totalRealizedPnl || right.closed - left.closed);

  const totals = buildBucket('all', 'All setups', entries);

  const closedTimes = entries
    .map((entry) => entry.closedAt)
    .filter((value): value is string => Boolean(value))
    .sort();
  const lastClosedAt = closedTimes.length ? closedTimes[closedTimes.length - 1] : null;

  return {
    totals,
    bySetupType,
    byEdgeBucket,
    diagnostics: {
      bestSetup: pickBestBucket(bySetupType),
      weakestSetup: pickWorstBucket(bySetupType),
      strongestEdgeBucket: pickBestBucket(byEdgeBucket),
      weakestEdgeBucket: pickWorstBucket(byEdgeBucket),
      patterns: buildPatterns(entries, totals, bySetupType, byEdgeBucket),
      lessons: buildLessons(totals, bySetupType, byEdgeBucket),
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
