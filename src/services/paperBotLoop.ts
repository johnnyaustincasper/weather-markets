import type { WeatherMarket } from '../types.js';
import { mergePaperExecutionSettings, type PaperExecutionProfile } from './paperExecutionSettings.js';
import { buildPaperTradePlan, type PaperPositionState, type TradeDecision } from './paperTrading.js';
import type { PersistentPaperState, PaperTradeRecord } from './paperPersistence.js';

export type PaperBotRunStatus = 'idle' | 'running' | 'cooldown' | 'blocked' | 'error';
export type PaperBotActionType = 'queued-market' | 'activated-market' | 'closed-market' | 'held-market' | 'skipped-market' | 'lease-blocked';

export type PaperBotMarketRuntime = {
  marketId: string;
  decision: TradeDecision;
  state: PaperPositionState;
  consecutiveWouldTradeTicks: number;
  lastDecisionAt: string | null;
  lastStateChangeAt: string | null;
  lastAction: PaperBotActionType | 'none';
  note: string;
};

export type PaperBotLease = {
  ownerId: string | null;
  acquiredAt: string | null;
  expiresAt: string | null;
};

export type PaperBotLoopState = {
  version: 1;
  mode: 'paper';
  enabled: boolean;
  status: PaperBotRunStatus;
  cadenceMs: number;
  minTicksBeforeActivation: number;
  allowAutoActivation: boolean;
  allowAutoClosure: boolean;
  lease: PaperBotLease;
  tickCount: number;
  failureCount: number;
  lastHydratedAt: string | null;
  lastPersistedAt: string | null;
  lastTickStartedAt: string | null;
  lastTickCompletedAt: string | null;
  nextDueAt: string | null;
  lastError: string | null;
  lastSummary: string | null;
  recentActions: PaperBotLoopAction[];
  marketRuntime: Record<string, PaperBotMarketRuntime>;
};

export type PaperBotLoopAction = {
  type: PaperBotActionType;
  marketId?: string;
  summary: string;
};

export type RunPaperBotTickInput = {
  state: PersistentPaperState;
  markets: WeatherMarket[];
  ownerId?: string;
  now?: string;
};

export type RunPaperBotTickResult = {
  state: PersistentPaperState;
  actions: PaperBotLoopAction[];
  summary: string;
};

export const DEFAULT_PAPER_BOT_LOOP_STATE: PaperBotLoopState = {
  version: 1,
  mode: 'paper',
  enabled: true,
  status: 'idle',
  cadenceMs: 60_000,
  minTicksBeforeActivation: 2,
  allowAutoActivation: true,
  allowAutoClosure: true,
  lease: {
    ownerId: null,
    acquiredAt: null,
    expiresAt: null,
  },
  tickCount: 0,
  failureCount: 0,
  lastHydratedAt: null,
  lastPersistedAt: null,
  lastTickStartedAt: null,
  lastTickCompletedAt: null,
  nextDueAt: null,
  lastError: null,
  lastSummary: null,
  recentActions: [],
  marketRuntime: {},
};

function addMs(iso: string, ms: number) {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

function isLeaseActive(loopState: PaperBotLoopState, nowIso: string, ownerId: string) {
  if (!loopState.lease.ownerId || !loopState.lease.expiresAt) return false;
  if (new Date(loopState.lease.expiresAt).getTime() <= new Date(nowIso).getTime()) return false;
  return loopState.lease.ownerId !== ownerId;
}

function makeTradeRecord(state: PaperPositionState, note: string, updatedAt: string): PaperTradeRecord {
  return { state, note, updatedAt };
}

function sanitizeRuntime(existing: PaperBotMarketRuntime | undefined, marketId: string, tradeState: PaperPositionState): PaperBotMarketRuntime {
  return {
    marketId,
    decision: existing?.decision ?? 'no-trade',
    state: tradeState,
    consecutiveWouldTradeTicks: existing?.consecutiveWouldTradeTicks ?? 0,
    lastDecisionAt: existing?.lastDecisionAt ?? null,
    lastStateChangeAt: existing?.lastStateChangeAt ?? null,
    lastAction: existing?.lastAction ?? 'none',
    note: existing?.note ?? 'No bot action yet.',
  };
}

export function createPaperBotLoopState(overrides?: Partial<PaperBotLoopState>): PaperBotLoopState {
  return {
    ...DEFAULT_PAPER_BOT_LOOP_STATE,
    ...overrides,
    lease: {
      ...DEFAULT_PAPER_BOT_LOOP_STATE.lease,
      ...(overrides?.lease ?? {}),
    },
    recentActions: Array.isArray(overrides?.recentActions) ? overrides.recentActions.slice(0, 20) : [],
    marketRuntime: overrides?.marketRuntime ?? {},
  };
}

export function getPaperBotCadenceLabel(cadenceMs: number) {
  if (cadenceMs < 60_000) return `${Math.round(cadenceMs / 1000)}s`;
  if (cadenceMs < 3_600_000) return `${Math.round(cadenceMs / 60_000)}m`;
  return `${Math.round(cadenceMs / 3_600_000)}h`;
}

export function runPaperBotTick({ state, markets, ownerId = 'local-runner', now = new Date().toISOString() }: RunPaperBotTickInput): RunPaperBotTickResult {
  const existingLoop = createPaperBotLoopState(state.botState);

  if (!existingLoop.enabled) {
    return {
      state: {
        ...state,
        botState: {
          ...existingLoop,
          status: 'idle',
          lastSummary: 'Paper bot is disabled.',
          nextDueAt: null,
        },
      },
      actions: [],
      summary: 'Paper bot is disabled.',
    };
  }

  if (isLeaseActive(existingLoop, now, ownerId)) {
    const blockedSummary = `Lease held by ${existingLoop.lease.ownerId} until ${existingLoop.lease.expiresAt}.`;
    return {
      state: {
        ...state,
        botState: {
          ...existingLoop,
          status: 'blocked',
          lastSummary: blockedSummary,
          nextDueAt: existingLoop.lease.expiresAt,
        },
      },
      actions: [{ type: 'lease-blocked', summary: blockedSummary }],
      summary: blockedSummary,
    };
  }

  const actions: PaperBotLoopAction[] = [];
  const nextPaperState = { ...state.paperState };
  const nextRuntime: Record<string, PaperBotMarketRuntime> = { ...existingLoop.marketRuntime };
  const settings: PaperExecutionProfile = state.paperExecutionProfile;
  const marketMap = Object.fromEntries(markets.map((market) => [market.id, market]));

  for (const market of markets) {
    const tradeSettings = mergePaperExecutionSettings(settings, market.id);
    const plan = buildPaperTradePlan(market, tradeSettings);
    const existingTrade = nextPaperState[market.id] ?? makeTradeRecord('flat', 'No paper position.', now);
    const runtime = sanitizeRuntime(nextRuntime[market.id], market.id, existingTrade.state);
    const nextWouldTradeCount = plan.decision === 'would-trade' ? runtime.consecutiveWouldTradeTicks + 1 : 0;

    let nextTrade = existingTrade;
    let lastAction: PaperBotMarketRuntime['lastAction'] = 'held-market';
    let note = runtime.note;

    if (existingTrade.state === 'flat' && plan.decision === 'would-trade') {
      nextTrade = makeTradeRecord('queued', `Auto-queued by bot after ${Math.abs(Math.round(market.edge * 100))} pt edge and ${Math.round(market.confidence * 100)}% confidence.`, now);
      actions.push({ type: 'queued-market', marketId: market.id, summary: `${market.title}: queued for paper entry.` });
      lastAction = 'queued-market';
      note = nextTrade.note;
    } else if (existingTrade.state === 'queued' && plan.decision === 'would-trade' && existingLoop.allowAutoActivation && nextWouldTradeCount >= existingLoop.minTicksBeforeActivation) {
      nextTrade = makeTradeRecord('active', `Auto-activated by bot after ${nextWouldTradeCount} consecutive qualifying ticks.`, now);
      actions.push({ type: 'activated-market', marketId: market.id, summary: `${market.title}: activated as paper position.` });
      lastAction = 'activated-market';
      note = nextTrade.note;
    } else if ((existingTrade.state === 'queued' || existingTrade.state === 'active') && existingLoop.allowAutoClosure) {
      const shouldClose = plan.decision === 'no-trade' || market.confidence < 0.55 || Math.abs(market.edge) < 0.03 || market.quoteStatus === 'stale' || market.quoteStatus === 'empty';
      if (shouldClose) {
        nextTrade = makeTradeRecord('closed', `Auto-closed by bot because edge/confidence/execution support broke down.`, now);
        actions.push({ type: 'closed-market', marketId: market.id, summary: `${market.title}: closed by bot safety rules.` });
        lastAction = 'closed-market';
        note = nextTrade.note;
      } else {
        actions.push({ type: 'held-market', marketId: market.id, summary: `${market.title}: held in ${existingTrade.state} state.` });
        lastAction = 'held-market';
        note = `Holding ${existingTrade.state} state, edge ${Math.round(market.edge * 100)} pts and confidence ${Math.round(market.confidence * 100)}%.`;
      }
    } else {
      actions.push({ type: 'skipped-market', marketId: market.id, summary: `${market.title}: skipped, decision ${plan.decision}.` });
      lastAction = 'skipped-market';
      note = `Skipped on this tick, decision ${plan.decision}.`;
    }

    nextPaperState[market.id] = nextTrade;
    nextRuntime[market.id] = {
      marketId: market.id,
      decision: plan.decision,
      state: nextTrade.state,
      consecutiveWouldTradeTicks: nextTrade.state === 'closed' ? 0 : nextWouldTradeCount,
      lastDecisionAt: now,
      lastStateChangeAt: nextTrade.updatedAt !== existingTrade.updatedAt ? now : runtime.lastStateChangeAt,
      lastAction,
      note,
    };
  }

  for (const marketId of Object.keys(nextRuntime)) {
    if (marketMap[marketId]) continue;
    const runtime = nextRuntime[marketId];
    nextRuntime[marketId] = {
      ...runtime,
      decision: 'no-trade',
      consecutiveWouldTradeTicks: 0,
      lastDecisionAt: now,
      lastAction: 'skipped-market',
      note: 'Market no longer present in scan universe.',
    };
  }

  const actionableCount = actions.filter((action) => action.type !== 'skipped-market').length;
  const summary = actionableCount
    ? `Tick ran on ${markets.length} markets, ${actionableCount} actionable updates, next run in ${getPaperBotCadenceLabel(existingLoop.cadenceMs)}.`
    : `Tick ran on ${markets.length} markets, no actionable updates, next run in ${getPaperBotCadenceLabel(existingLoop.cadenceMs)}.`;

  return {
    state: {
      ...state,
      paperState: nextPaperState,
      botState: {
        ...existingLoop,
        status: 'cooldown',
        lease: {
          ownerId,
          acquiredAt: now,
          expiresAt: addMs(now, Math.max(existingLoop.cadenceMs, 30_000)),
        },
        tickCount: existingLoop.tickCount + 1,
        lastTickStartedAt: now,
        lastTickCompletedAt: now,
        nextDueAt: addMs(now, existingLoop.cadenceMs),
        lastError: null,
        lastSummary: summary,
        recentActions: [...actions, ...existingLoop.recentActions].slice(0, 20),
        marketRuntime: nextRuntime,
      },
      syncedAt: now,
    },
    actions,
    summary,
  };
}
