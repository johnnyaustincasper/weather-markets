import type { WeatherMarket } from '../types.js';
import type { PaperBlotterEntry } from './paperBlotter.js';
import type { PaperOrder } from './paperOrders.js';
import type { PaperTradeRecord } from './paperPersistence.js';

export type PaperRiskGovernorSettings = {
  enabled: boolean;
  maxDailyDrawdownPct: number;
  maxOpenExposurePct: number;
  maxCorrelatedLocationPct: number;
  maxCorrelatedSetupPct: number;
  safeModeDrawdownPct: number;
  safeModeExposurePct: number;
};

export type PaperRiskGuardrail = {
  key: string;
  label: string;
  valuePct: number;
  limitPct: number;
  remainingPct: number;
  breached: boolean;
  warning: boolean;
  detail: string;
};

export type PaperRiskGovernorSummary = {
  enabled: boolean;
  halted: boolean;
  safeMode: boolean;
  headline: string;
  detail: string;
  drawdownPct: number;
  openExposurePct: number;
  largestLocationPct: number;
  largestSetupPct: number;
  topLocation: { key: string; pct: number; markets: number } | null;
  topSetup: { key: string; pct: number; markets: number } | null;
  guardrails: PaperRiskGuardrail[];
  blockedReasons: string[];
};

export const DEFAULT_PAPER_RISK_GOVERNOR_SETTINGS: PaperRiskGovernorSettings = {
  enabled: true,
  maxDailyDrawdownPct: 0.06,
  maxOpenExposurePct: 0.45,
  maxCorrelatedLocationPct: 0.22,
  maxCorrelatedSetupPct: 0.28,
  safeModeDrawdownPct: 0.04,
  safeModeExposurePct: 0.35,
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round4 = (value: number) => Number(value.toFixed(4));

function workingExposureFor(orders: PaperOrder[]) {
  return orders
    .filter((order) => order.status === 'working' || order.status === 'partial')
    .reduce((sum, order) => sum + (order.remainingQuantity * order.limitPrice), 0);
}

function filledExposureFor(blotter: PaperBlotterEntry | undefined, orders: PaperOrder[], trade: PaperTradeRecord | undefined) {
  if (blotter?.state === 'closed' || trade?.state === 'closed') return 0;

  const markedPrice = Math.max(0, blotter?.currentMark ?? blotter?.entryPrice ?? 0);
  const filledQuantity = orders.reduce((sum, order) => sum + order.filledQuantity, 0);
  if (filledQuantity > 0) return markedPrice * filledQuantity;

  if (trade?.state === 'active' && blotter) return markedPrice;
  return 0;
}

function totalExposureFor(blotter: PaperBlotterEntry | undefined, orders: PaperOrder[], trade: PaperTradeRecord | undefined) {
  return filledExposureFor(blotter, orders, trade) + workingExposureFor(orders);
}

export function sanitizePaperRiskGovernorSettings(input?: Partial<PaperRiskGovernorSettings> | null): PaperRiskGovernorSettings {
  return {
    enabled: input?.enabled ?? DEFAULT_PAPER_RISK_GOVERNOR_SETTINGS.enabled,
    maxDailyDrawdownPct: clamp(input?.maxDailyDrawdownPct ?? DEFAULT_PAPER_RISK_GOVERNOR_SETTINGS.maxDailyDrawdownPct, 0.01, 0.5),
    maxOpenExposurePct: clamp(input?.maxOpenExposurePct ?? DEFAULT_PAPER_RISK_GOVERNOR_SETTINGS.maxOpenExposurePct, 0.05, 1),
    maxCorrelatedLocationPct: clamp(input?.maxCorrelatedLocationPct ?? DEFAULT_PAPER_RISK_GOVERNOR_SETTINGS.maxCorrelatedLocationPct, 0.05, 1),
    maxCorrelatedSetupPct: clamp(input?.maxCorrelatedSetupPct ?? DEFAULT_PAPER_RISK_GOVERNOR_SETTINGS.maxCorrelatedSetupPct, 0.05, 1),
    safeModeDrawdownPct: clamp(input?.safeModeDrawdownPct ?? DEFAULT_PAPER_RISK_GOVERNOR_SETTINGS.safeModeDrawdownPct, 0.01, 0.5),
    safeModeExposurePct: clamp(input?.safeModeExposurePct ?? DEFAULT_PAPER_RISK_GOVERNOR_SETTINGS.safeModeExposurePct, 0.05, 1),
  };
}

function sameDay(left: string | null | undefined, right: string) {
  if (!left) return false;
  return left.slice(0, 10) === right.slice(0, 10);
}

export function summarizePaperRiskGovernor(params: {
  settings?: PaperRiskGovernorSettings;
  startingCash: number;
  blotter: Record<string, PaperBlotterEntry>;
  orders: Record<string, PaperOrder[]>;
  paperState: Record<string, PaperTradeRecord>;
  markets: WeatherMarket[];
  now?: string;
}): PaperRiskGovernorSummary {
  const now = params.now ?? new Date().toISOString();
  const settings = sanitizePaperRiskGovernorSettings(params.settings);
  const marketMap = Object.fromEntries(params.markets.map((market) => [market.id, market]));
  const equityBase = Math.max(params.startingCash, 1);

  const dailyClosedLoss = Object.values(params.blotter)
    .filter((entry) => entry.state === 'closed' && sameDay(entry.closedAt, now))
    .reduce((sum, entry) => sum + Math.min(0, entry.realizedPnlPoints ?? entry.pnlPoints ?? 0), 0);
  const dailyOpenLoss = Object.values(params.blotter)
    .filter((entry) => entry.state === 'active')
    .reduce((sum, entry) => sum + Math.min(0, entry.markedPnlPoints ?? entry.pnlPoints ?? 0), 0);
  const drawdownPct = round4(Math.abs(dailyClosedLoss + dailyOpenLoss));

  const exposureMarketIds = new Set([
    ...Object.keys(params.orders),
    ...Object.keys(params.paperState),
    ...Object.keys(params.blotter),
  ]);

  const openExposure = Array.from(exposureMarketIds).reduce((sum, marketId) => {
    const blotter = params.blotter[marketId];
    const orders = params.orders[marketId] ?? [];
    const trade = params.paperState[marketId];
    return sum + totalExposureFor(blotter, orders, trade);
  }, 0);
  const openExposurePct = round4(openExposure / equityBase);

  const locationBuckets = new Map<string, { exposure: number; markets: Set<string> }>();
  const setupBuckets = new Map<string, { exposure: number; markets: Set<string> }>();

  for (const marketId of exposureMarketIds) {
    const market = marketMap[marketId];
    if (!market) continue;
    const blotter = params.blotter[marketId];
    const orders = params.orders[marketId] ?? [];
    const trade = params.paperState[marketId];
    const exposure = totalExposureFor(blotter, orders, trade);
    if (exposure <= 0) continue;

    const locationKey = market.location || 'Unknown';
    const existingLocation = locationBuckets.get(locationKey) ?? { exposure: 0, markets: new Set<string>() };
    existingLocation.exposure += exposure;
    existingLocation.markets.add(marketId);
    locationBuckets.set(locationKey, existingLocation);

    const setupKey = market.resolutionSchema.kind || 'unknown';
    const existingSetup = setupBuckets.get(setupKey) ?? { exposure: 0, markets: new Set<string>() };
    existingSetup.exposure += exposure;
    existingSetup.markets.add(marketId);
    setupBuckets.set(setupKey, existingSetup);
  }

  const topLocationEntry = Array.from(locationBuckets.entries()).sort((a, b) => b[1].exposure - a[1].exposure)[0] ?? null;
  const topSetupEntry = Array.from(setupBuckets.entries()).sort((a, b) => b[1].exposure - a[1].exposure)[0] ?? null;
  const largestLocationPct = round4((topLocationEntry?.[1].exposure ?? 0) / equityBase);
  const largestSetupPct = round4((topSetupEntry?.[1].exposure ?? 0) / equityBase);

  const guardrails: PaperRiskGuardrail[] = [
    {
      key: 'daily-drawdown',
      label: 'Daily drawdown',
      valuePct: drawdownPct,
      limitPct: settings.maxDailyDrawdownPct,
      remainingPct: round4(settings.maxDailyDrawdownPct - drawdownPct),
      breached: drawdownPct >= settings.maxDailyDrawdownPct,
      warning: drawdownPct >= settings.safeModeDrawdownPct,
      detail: `Closed losses today plus active open losses are using ${Math.round(drawdownPct * 100)}% of starting equity.`,
    },
    {
      key: 'open-exposure',
      label: 'Open exposure',
      valuePct: openExposurePct,
      limitPct: settings.maxOpenExposurePct,
      remainingPct: round4(settings.maxOpenExposurePct - openExposurePct),
      breached: openExposurePct >= settings.maxOpenExposurePct,
      warning: openExposurePct >= settings.safeModeExposurePct,
      detail: `Filled plus working paper risk is consuming ${Math.round(openExposurePct * 100)}% of starting equity.`,
    },
    {
      key: 'location-correlation',
      label: 'Location correlation',
      valuePct: largestLocationPct,
      limitPct: settings.maxCorrelatedLocationPct,
      remainingPct: round4(settings.maxCorrelatedLocationPct - largestLocationPct),
      breached: largestLocationPct >= settings.maxCorrelatedLocationPct,
      warning: largestLocationPct >= settings.maxCorrelatedLocationPct * 0.85,
      detail: topLocationEntry
        ? `${topLocationEntry[0]} now carries ${Math.round(largestLocationPct * 100)}% of equity across ${topLocationEntry[1].markets.size} linked market${topLocationEntry[1].markets.size === 1 ? '' : 's'}.`
        : 'No location concentration yet.',
    },
    {
      key: 'setup-correlation',
      label: 'Setup correlation',
      valuePct: largestSetupPct,
      limitPct: settings.maxCorrelatedSetupPct,
      remainingPct: round4(settings.maxCorrelatedSetupPct - largestSetupPct),
      breached: largestSetupPct >= settings.maxCorrelatedSetupPct,
      warning: largestSetupPct >= settings.maxCorrelatedSetupPct * 0.85,
      detail: topSetupEntry
        ? `${topSetupEntry[0]} setups now carry ${Math.round(largestSetupPct * 100)}% of equity across ${topSetupEntry[1].markets.size} linked market${topSetupEntry[1].markets.size === 1 ? '' : 's'}.`
        : 'No setup clustering yet.',
    },
  ];

  const blockedReasons = settings.enabled
    ? guardrails.filter((item) => item.breached).map((item) => `${item.label} breached`)
    : [];
  const safeMode = settings.enabled && !blockedReasons.length && guardrails.some((item) => item.warning);
  const halted = settings.enabled && blockedReasons.length > 0;
  const headline = !settings.enabled
    ? 'Risk governor disabled'
    : halted
      ? 'Risk governor blocking new bot risk'
      : safeMode
        ? 'Risk governor in safe mode'
        : 'Risk governor inside limits';
  const detail = !settings.enabled
    ? 'Bot risk checks are disabled, so only the basic execution rails remain.'
    : halted
      ? `${blockedReasons.join(', ')}. New queueing and activation should stay blocked until exposure cools off.`
      : safeMode
        ? 'At least one guardrail is near its hard limit, so the bot should protect capital and avoid adding fresh correlated risk.'
        : 'Drawdown, open exposure, and correlated weather concentration are all inside the configured paper limits.';

  return {
    enabled: settings.enabled,
    halted,
    safeMode,
    headline,
    detail,
    drawdownPct,
    openExposurePct,
    largestLocationPct,
    largestSetupPct,
    topLocation: topLocationEntry ? { key: topLocationEntry[0], pct: largestLocationPct, markets: topLocationEntry[1].markets.size } : null,
    topSetup: topSetupEntry ? { key: topSetupEntry[0], pct: largestSetupPct, markets: topSetupEntry[1].markets.size } : null,
    guardrails,
    blockedReasons,
  };
}
