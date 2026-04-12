import type { WeatherMarket } from '../types';
import type { PaperTradePlan } from './paperTrading';

export type PaperOrderStatus = 'working' | 'filled' | 'cancelled';

export type PaperOrder = {
  id: string;
  marketId: string;
  marketTitle: string;
  direction: PaperTradePlan['direction'];
  limitPrice: number;
  quantity: number;
  status: PaperOrderStatus;
  createdAt: string;
  updatedAt: string;
  filledAt: string | null;
  fillPrice: number | null;
  note: string;
};

const STORAGE_KEY = 'weather-markets-paper-orders:v1';

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

function bookFillPrice(market: WeatherMarket, direction: PaperTradePlan['direction']) {
  if (direction === 'buy-yes') return market.clobQuote?.bestAsk ?? market.clobQuote?.midpoint ?? market.clobQuote?.lastTradePrice ?? market.impliedProbability;
  if (direction === 'buy-no') {
    const yesBid = market.clobQuote?.bestBid ?? market.clobQuote?.midpoint ?? market.clobQuote?.lastTradePrice ?? market.impliedProbability;
    return yesBid === null || yesBid === undefined ? null : clamp(1 - yesBid);
  }
  return null;
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
    limitPrice: clamp(limitPrice),
    status: 'working',
    createdAt: nowIso,
    updatedAt: nowIso,
    filledAt: null,
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
    note: 'Cancelled locally before fill.',
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
      if (order.status !== 'working') return order;
      const liveFill = bookFillPrice(market, order.direction);
      if (liveFill === null) return order;
      const fillable = liveFill <= order.limitPrice;
      if (!fillable) return order;
      changed = true;
      const nowIso = new Date().toISOString();
      return {
        ...order,
        status: 'filled' as const,
        updatedAt: nowIso,
        filledAt: nowIso,
        fillPrice: liveFill,
        note: `Filled locally at ${Math.round(liveFill * 100)}% when the live book crossed the limit.`,
      };
    });
  }

  if (changed) writeStore(store);
  return { orders: store, changed };
}
