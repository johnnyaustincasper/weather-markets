import type { PaperOrder } from './paperOrders.js';
import type { PaperTradeRecord } from './paperPersistence.js';
import { getPaperBotCadenceLabel, type PaperBotLoopState } from './paperBotLoop.js';
import type { WeatherMarket } from '../types.js';

export type SupervisionTone = 'good' | 'warn' | 'bad' | 'muted';

export type BotSupervisionAlert = {
  title: string;
  detail: string;
  tone: SupervisionTone;
};

export type BotSupervisionCheck = {
  label: string;
  status: string;
  detail: string;
  tone: SupervisionTone;
};

export type PaperBotSupervisionSummary = {
  healthLabel: string;
  healthTone: SupervisionTone;
  headline: string;
  detail: string;
  alerts: BotSupervisionAlert[];
  checks: BotSupervisionCheck[];
};

const minutesBetween = (from?: string | null, to?: string) => {
  if (!from) return null;
  const deltaMs = new Date(to ?? new Date().toISOString()).getTime() - new Date(from).getTime();
  return Math.max(0, Math.round(deltaMs / 60_000));
};

export function summarizePaperBotSupervision(params: {
  botState: PaperBotLoopState;
  markets: WeatherMarket[];
  paperState: Record<string, PaperTradeRecord>;
  paperOrders: Record<string, PaperOrder[]>;
  now?: string;
}): PaperBotSupervisionSummary {
  const { botState, markets, paperState, paperOrders, now = new Date().toISOString() } = params;
  const activeMarkets = Object.values(paperState).filter((item) => item.state === 'active').length;
  const queuedMarkets = Object.values(paperState).filter((item) => item.state === 'queued').length;
  const workingOrders = Object.values(paperOrders).flat().filter((order) => order.status === 'working' || order.status === 'partial').length;
  const staleMarkets = markets.filter((market) => market.freshnessMinutes >= 90 || market.quoteStatus === 'stale' || market.quoteStatus === 'empty').length;
  const overdueMinutes = botState.nextDueAt ? minutesBetween(botState.nextDueAt, now) : null;
  const lastCompletedMinutes = minutesBetween(botState.lastTickCompletedAt, now);
  const leaseExpired = Boolean(botState.lease.expiresAt) && new Date(botState.lease.expiresAt as string).getTime() <= new Date(now).getTime();
  const cadenceLabel = getPaperBotCadenceLabel(botState.cadenceMs);
  const alerts: BotSupervisionAlert[] = [];

  if (!botState.enabled) {
    alerts.push({
      title: 'Automation paused',
      detail: 'The bot is disabled, so no backend or UI tick will promote or close paper positions until an operator turns it back on.',
      tone: 'warn',
    });
  }

  if (overdueMinutes !== null && overdueMinutes >= Math.max(2, Math.round(botState.cadenceMs / 60_000))) {
    alerts.push({
      title: 'Bot looks overdue',
      detail: `Next due time passed ${overdueMinutes}m ago. Treat the runner as stalled until another tick lands.`,
      tone: 'bad',
    });
  }

  if (lastCompletedMinutes !== null && lastCompletedMinutes >= Math.max(5, Math.round((botState.cadenceMs * 3) / 60_000))) {
    alerts.push({
      title: 'No recent completed tick',
      detail: `The last completed tick was ${lastCompletedMinutes}m ago, which is long for a ${cadenceLabel} cadence.`,
      tone: 'bad',
    });
  }

  if (leaseExpired) {
    alerts.push({
      title: 'Lease expired',
      detail: 'The last runner lease is already expired. Another worker can safely take over, but supervision should confirm a fresh tick actually happens.',
      tone: 'warn',
    });
  }

  if (queuedMarkets >= 3 && activeMarkets === 0) {
    alerts.push({
      title: 'Queue building without activation',
      detail: `${queuedMarkets} markets are queued and none are active. That can mean filters are too strict, fills are not happening, or the runner is not progressing.`,
      tone: 'warn',
    });
  }

  if (workingOrders > 0 && activeMarkets === 0) {
    alerts.push({
      title: 'Working orders need handoff',
      detail: `${workingOrders} working or partial paper orders exist but no market is active yet. Make sure fills are being promoted into tracked positions.`,
      tone: 'warn',
    });
  }

  if (staleMarkets >= Math.max(2, Math.ceil(markets.length / 2))) {
    alerts.push({
      title: 'Input quality degraded',
      detail: `${staleMarkets} of ${markets.length} markets are stale, empty, or aging. Bot decisions are less trustworthy until fresh quotes and weather data come back.`,
      tone: 'bad',
    });
  }

  const checks: BotSupervisionCheck[] = [
    {
      label: 'Cadence',
      status: cadenceLabel,
      detail: botState.enabled ? `Next run ${botState.nextDueAt ? `scheduled for ${new Date(botState.nextDueAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : 'not scheduled yet'}.` : 'Automation is paused.',
      tone: botState.enabled ? 'good' : 'warn',
    },
    {
      label: 'Last completed tick',
      status: lastCompletedMinutes === null ? 'Never' : `${lastCompletedMinutes}m ago`,
      detail: botState.lastTickCompletedAt ? `Completed at ${new Date(botState.lastTickCompletedAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.` : 'The bot has not finished a tick yet.',
      tone: lastCompletedMinutes === null ? 'warn' : lastCompletedMinutes >= Math.max(5, Math.round((botState.cadenceMs * 3) / 60_000)) ? 'bad' : 'good',
    },
    {
      label: 'Execution handoff',
      status: `${queuedMarkets} queued / ${activeMarkets} active`,
      detail: workingOrders ? `${workingOrders} working or partial orders are waiting in the paper book.` : 'No staged paper orders are waiting right now.',
      tone: queuedMarkets >= 3 && activeMarkets === 0 ? 'warn' : activeMarkets > 0 ? 'good' : 'muted',
    },
    {
      label: 'Input freshness',
      status: `${Math.max(0, markets.length - staleMarkets)}/${markets.length || 0} usable`,
      detail: staleMarkets ? `${staleMarkets} markets are stale, empty, or aging.` : 'Quotes and weather inputs currently look fresh enough for supervision.',
      tone: staleMarkets >= Math.max(2, Math.ceil(markets.length / 2)) ? 'bad' : staleMarkets > 0 ? 'warn' : 'good',
    },
  ];

  const healthTone: SupervisionTone = alerts.some((alert) => alert.tone === 'bad')
    ? 'bad'
    : alerts.some((alert) => alert.tone === 'warn')
      ? 'warn'
      : botState.enabled
        ? 'good'
        : 'muted';

  const healthLabel = healthTone === 'bad'
    ? 'Needs intervention'
    : healthTone === 'warn'
      ? 'Watch closely'
      : botState.enabled
        ? 'Healthy'
        : 'Paused';

  const headline = alerts[0]?.title ?? (botState.enabled ? 'Bot supervision looks healthy' : 'Bot is paused by operator');
  const detail = alerts[0]?.detail ?? (botState.lastSummary || `The bot is on a ${cadenceLabel} cadence and has no active supervision warnings right now.`);

  return {
    healthLabel,
    healthTone,
    headline,
    detail,
    alerts: alerts.slice(0, 4),
    checks,
  };
}
