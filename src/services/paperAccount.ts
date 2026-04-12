import type { PaperBlotterEntry } from './paperBlotter.js';
import type { PaperBotLoopState } from './paperBotLoop.js';
import type { PaperOrder } from './paperOrders.js';
import type { PaperPositionState } from './paperTrading.js';

export const DEFAULT_PAPER_ACCOUNT_STARTING_CASH = 1000;

export type PaperAccountMarketSnapshot = {
  marketId: string;
  marketTitle: string;
  state: PaperPositionState | 'flat';
  filledUnits: number;
  workingUnits: number;
  reservedCash: number;
  costBasis: number;
  markValue: number;
  openPnl: number;
  realizedPnl: number;
};

export type PaperAccountSummary = {
  startingCash: number;
  cash: number;
  reservedCash: number;
  availableCash: number;
  deployedCash: number;
  exposure: number;
  accountValue: number;
  openPnl: number;
  realizedPnl: number;
  totalPnl: number;
  grossFilledUnits: number;
  workingUnits: number;
  activeMarkets: number;
  queuedMarkets: number;
  closedMarkets: number;
  botManagedCapital: number;
  botManagedPct: number;
  botManagedMarkets: number;
  automationStatus: 'active' | 'paused';
  markets: PaperAccountMarketSnapshot[];
};

const round2 = (value: number) => Number(value.toFixed(2));
const round4 = (value: number) => Number(value.toFixed(4));

function quantityFor(blotter: PaperBlotterEntry | undefined, orders: PaperOrder[]) {
  const filled = orders.reduce((sum, order) => sum + order.filledQuantity, 0);
  const working = orders
    .filter((order) => order.status === 'working' || order.status === 'partial')
    .reduce((sum, order) => sum + order.remainingQuantity, 0);
  const fallback = blotter && blotter.state !== 'flat' ? 1 : 0;
  return {
    filled: filled || fallback,
    working,
  };
}

export function summarizePaperAccount(params: {
  blotter: Record<string, PaperBlotterEntry>;
  orders: Record<string, PaperOrder[]>;
  botState: PaperBotLoopState;
  startingCash?: number;
}): PaperAccountSummary {
  const startingCash = params.startingCash ?? DEFAULT_PAPER_ACCOUNT_STARTING_CASH;
  const marketIds = new Set([...Object.keys(params.blotter), ...Object.keys(params.orders)]);
  const botManagedIds = new Set(
    Object.values(params.botState.marketRuntime)
      .filter((item) => item.state === 'queued' || item.state === 'active')
      .map((item) => item.marketId),
  );

  const markets: PaperAccountMarketSnapshot[] = [];

  for (const marketId of marketIds) {
    const blotter = params.blotter[marketId];
    const orders = params.orders[marketId] ?? [];
    const { filled, working } = quantityFor(blotter, orders);
    const entryPrice = blotter?.entryPrice ?? orders.find((order) => order.fillPrice !== null)?.fillPrice ?? 0;
    const currentMark = blotter?.currentMark ?? blotter?.closePrice ?? entryPrice ?? 0;
    const realizedPerUnit = blotter?.realizedPnlPoints ?? 0;
    const openPerUnit = blotter?.state === 'closed' ? 0 : (blotter?.markedPnlPoints ?? blotter?.pnlPoints ?? 0);
    const costBasis = filled * (entryPrice ?? 0);
    const markValue = blotter?.state === 'closed' ? 0 : filled * (currentMark ?? 0);
    const reservedCash = orders
      .filter((order) => order.status === 'working' || order.status === 'partial')
      .reduce((sum, order) => sum + (order.remainingQuantity * order.limitPrice), 0);

    markets.push({
      marketId,
      marketTitle: blotter?.marketTitle ?? orders[0]?.marketTitle ?? marketId,
      state: blotter?.state ?? 'flat',
      filledUnits: filled,
      workingUnits: working,
      reservedCash: round2(reservedCash),
      costBasis: round2(costBasis),
      markValue: round2(markValue),
      openPnl: round2(filled * openPerUnit),
      realizedPnl: round2(filled * realizedPerUnit),
    });
  }

  const exposure = round2(markets.reduce((sum, market) => sum + market.markValue, 0));
  const reservedCash = round2(markets.reduce((sum, market) => sum + market.reservedCash, 0));
  const openPnl = round2(markets.reduce((sum, market) => sum + market.openPnl, 0));
  const realizedPnl = round2(markets.reduce((sum, market) => sum + market.realizedPnl, 0));
  const totalPnl = round2(openPnl + realizedPnl);
  const accountValue = round2(startingCash + totalPnl);
  const cash = round2(startingCash + realizedPnl - markets.reduce((sum, market) => sum + market.costBasis, 0));
  const availableCash = round2(cash - reservedCash);
  const deployedCash = round2(exposure + reservedCash);
  const activeMarkets = markets.filter((market) => market.state === 'active').length;
  const queuedMarkets = markets.filter((market) => market.state === 'queued').length;
  const closedMarkets = markets.filter((market) => market.state === 'closed').length;
  const grossFilledUnits = round4(markets.reduce((sum, market) => sum + market.filledUnits, 0));
  const workingUnits = round4(markets.reduce((sum, market) => sum + market.workingUnits, 0));
  const botManagedCapital = round2(markets
    .filter((market) => botManagedIds.has(market.marketId))
    .reduce((sum, market) => sum + market.markValue + market.reservedCash, 0));
  const botManagedPct = accountValue > 0 ? round4(botManagedCapital / accountValue) : 0;

  return {
    startingCash: round2(startingCash),
    cash,
    reservedCash,
    availableCash,
    deployedCash,
    exposure,
    accountValue,
    openPnl,
    realizedPnl,
    totalPnl,
    grossFilledUnits,
    workingUnits,
    activeMarkets,
    queuedMarkets,
    closedMarkets,
    botManagedCapital,
    botManagedPct,
    botManagedMarkets: botManagedIds.size,
    automationStatus: params.botState.enabled ? 'active' : 'paused',
    markets: markets.sort((left, right) => right.markValue + right.reservedCash - (left.markValue + left.reservedCash)),
  };
}
