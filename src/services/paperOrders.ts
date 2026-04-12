import type { QuoteStatus, WeatherMarket } from '../types.js';
import type { PaperTradePlan } from './paperTrading.js';

export type PaperOrderStatus = 'working' | 'partial' | 'filled' | 'cancelled';

export type PaperOrder = {
  id: string;
  marketId: string;
  marketTitle: string;
  direction: PaperTradePlan['direction'];
  limitPrice: number;
  quantity: number;
  filledQuantity: number;
  remainingQuantity: number;
  status: PaperOrderStatus;
  createdAt: string;
  updatedAt: string;
  filledAt: string | null;
  lastFillAt: string | null;
  fillPrice: number | null;
  note: string;
};

const STORAGE_KEY = 'weather-markets-paper-orders:v2';

function hasLocalStorage() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readStore(): Record<string, PaperOrder[]> {
  if (!hasLocalStorage()) return {};

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, PaperOrder[]> : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: Record<string, PaperOrder[]>) {
  if (!hasLocalStorage()) return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function clamp(value: number, min = 0.01, max = 0.99) {
  return Math.min(max, Math.max(min, value));
}

function roundPrice(value: number | null) {
  return value === null ? null : Number(clamp(value).toFixed(4));
}

function roundFillPrice(value: number | null) {
  return value === null ? null : Number(value.toFixed(4));
}

function baseReferencePrice(market: WeatherMarket, direction: PaperTradePlan['direction']) {
  if (direction === 'buy-yes') return market.clobQuote?.bestAsk ?? market.clobQuote?.midpoint ?? market.clobQuote?.lastTradePrice ?? market.impliedProbability;
  if (direction === 'buy-no') {
    const yesBid = market.clobQuote?.bestBid ?? market.clobQuote?.midpoint ?? market.clobQuote?.lastTradePrice ?? market.impliedProbability;
    return yesBid === null || yesBid === undefined ? null : clamp(1 - yesBid);
  }
  return null;
}

function effectiveSpread(market: WeatherMarket) {
  return market.clobQuote?.spread ?? (market.clobQuote?.bestAsk !== null && market.clobQuote?.bestAsk !== undefined && market.clobQuote?.bestBid !== null && market.clobQuote?.bestBid !== undefined
    ? market.clobQuote.bestAsk - market.clobQuote.bestBid
    : null);
}

function waitFactor(createdAt: string) {
  const restedSeconds = Math.max(0, (Date.now() - new Date(createdAt).getTime()) / 1000);
  if (restedSeconds < 15) return 0;
  if (restedSeconds < 45) return 0.45;
  if (restedSeconds < 120) return 0.8;
  return 1;
}

function quoteFactor(status: QuoteStatus) {
  if (status === 'tight') return 1;
  if (status === 'tradable') return 0.72;
  if (status === 'wide') return 0.4;
  if (status === 'stale') return 0.2;
  return 0;
}

function fillCapFor(order: PaperOrder, market: WeatherMarket) {
  const spread = effectiveSpread(market) ?? 0.08;
  const spreadFactor = spread <= 0.03 ? 1 : spread <= 0.06 ? 0.78 : spread <= 0.1 ? 0.55 : 0.35;
  const sizePenalty = order.quantity >= 8 ? 0.45 : order.quantity >= 5 ? 0.7 : 1;
  const improvement = order.fillPrice === null ? 0 : Math.abs((order.fillPrice ?? 0) - order.limitPrice);
  const urgencyFactor = improvement >= 0.03 ? 1 : improvement >= 0.015 ? 0.82 : 0.65;
  return Math.max(0.15, quoteFactor(market.quoteStatus) * spreadFactor * sizePenalty * urgencyFactor * waitFactor(order.createdAt));
}

function nextFillQuantity(order: PaperOrder, market: WeatherMarket) {
  const cap = fillCapFor(order, market);
  const proposed = Math.max(1, Math.floor(order.quantity * cap));
  return Math.min(order.remainingQuantity, proposed);
}

function nextAverageFillPrice(existingAverage: number | null, existingFilled: number, nextPrice: number, nextQuantity: number) {
  const totalFilled = existingFilled + nextQuantity;
  if (totalFilled <= 0) return roundFillPrice(nextPrice);
  const weighted = (((existingAverage ?? nextPrice) * existingFilled) + (nextPrice * nextQuantity)) / totalFilled;
  return roundFillPrice(weighted);
}

export function getPaperOrders() {
  return readStore();
}

export function placePaperOrder(market: WeatherMarket, plan: PaperTradePlan, quantity: number, limitPrice: number, note: string) {
  const store = readStore();
  const nowIso = new Date().toISOString();
  const order: PaperOrder = {
    id: `${market.id}-${Date.now()}`,
    marketId: market.id,
    marketTitle: market.title,
    direction: plan.direction,
    quantity: Math.max(1, Math.round(quantity)),
    filledQuantity: 0,
    remainingQuantity: Math.max(1, Math.round(quantity)),
    limitPrice: clamp(limitPrice),
    status: 'working',
    createdAt: nowIso,
    updatedAt: nowIso,
    filledAt: null,
    lastFillAt: null,
    fillPrice: null,
    note: note.trim() || `Staged ${plan.direction === 'buy-yes' ? 'YES' : 'NO'} paper order.`,
  };

  store[market.id] = [order, ...(store[market.id] ?? [])].slice(0, 12);
  writeStore(store);
  return { order, orders: store };
}

export function cancelPaperOrder(marketId: string, orderId: string) {
  const store = readStore();
  const next = (store[marketId] ?? []).map((order) => order.id !== orderId ? order : {
    ...order,
    status: 'cancelled' as const,
    updatedAt: new Date().toISOString(),
    note: order.filledQuantity > 0
      ? `Cancelled locally with ${order.filledQuantity}/${order.quantity} units already filled.`
      : 'Cancelled locally before any fill.',
  });
  store[marketId] = next;
  writeStore(store);
  return store;
}

export function syncPaperOrders(markets: WeatherMarket[]) {
  const store = readStore();
  const marketMap = Object.fromEntries(markets.map((market) => [market.id, market]));
  let changed = false;

  for (const [marketId, orders] of Object.entries(store)) {
    const market = marketMap[marketId];
    if (!market) continue;

    store[marketId] = orders.map((order) => {
      if (order.status === 'cancelled' || order.status === 'filled') return order;
      const liveFill = roundPrice(baseReferencePrice(market, order.direction));
      if (liveFill === null) return order;
      const fillable = liveFill <= order.limitPrice;
      if (!fillable) return order;

      const filledNow = nextFillQuantity(order, market);
      if (filledNow <= 0) return order;

      changed = true;
      const nowIso = new Date().toISOString();
      const totalFilled = order.filledQuantity + filledNow;
      const remainingQuantity = Math.max(0, order.quantity - totalFilled);
      const status: PaperOrderStatus = remainingQuantity > 0 ? 'partial' : 'filled';
      const averageFillPrice = nextAverageFillPrice(order.fillPrice, order.filledQuantity, liveFill, filledNow);

      return {
        ...order,
        status,
        filledQuantity: totalFilled,
        remainingQuantity,
        updatedAt: nowIso,
        filledAt: status === 'filled' ? nowIso : order.filledAt,
        lastFillAt: nowIso,
        fillPrice: averageFillPrice,
        note: status === 'filled'
          ? `Filled ${totalFilled}/${order.quantity} units locally at ${Math.round((averageFillPrice ?? liveFill) * 100)}% average after the book crossed the limit.`
          : `Partial local fill: ${totalFilled}/${order.quantity} units average ${Math.round((averageFillPrice ?? liveFill) * 100)}%, ${remainingQuantity} still working.`,
      };
    });
  }

  if (changed) writeStore(store);
  return { orders: store, changed };
}
