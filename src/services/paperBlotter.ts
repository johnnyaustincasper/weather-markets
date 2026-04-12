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
  lastClosedAt: string | null;
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

  for (const entry of entries) {
    const list = groups.get(entry.setupType) ?? [];
    list.push(entry);
    groups.set(entry.setupType, list);
  }

  const bySetupType = Array.from(groups.entries())
    .map(([key, bucketEntries]) => buildBucket(key, key, bucketEntries))
    .sort((left, right) => right.totalRealizedPnl - left.totalRealizedPnl || right.closed - left.closed);

  const closedTimes = entries
    .map((entry) => entry.closedAt)
    .filter((value): value is string => Boolean(value))
    .sort();
  const lastClosedAt = closedTimes.length ? closedTimes[closedTimes.length - 1] : null;

  return {
    totals: buildBucket('all', 'All setups', entries),
    bySetupType,
    lastClosedAt,
  };
}
