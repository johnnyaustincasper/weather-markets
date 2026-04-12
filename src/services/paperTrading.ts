import type { QuoteStatus, WeatherMarket } from '../types.js';
import type { PaperExecutionSettings } from './paperExecutionSettings.js';

export type TradeDecision = 'would-trade' | 'watch' | 'no-trade';
export type TradeDirection = 'buy-yes' | 'buy-no' | 'stand-aside';
export type PaperPositionState = 'flat' | 'queued' | 'active' | 'closed';

export type DecisionCriterion = {
  label: string;
  value: string;
  passed: boolean;
  detail: string;
};

export type PaperTradePlan = {
  decision: TradeDecision;
  direction: TradeDirection;
  conviction: 'high' | 'medium' | 'low';
  thesis: string;
  blockers: string[];
  entryCriteria: DecisionCriterion[];
  exitCriteria: string[];
  sizing: {
    suggestedUnits: number;
    maxUnits: number;
    scaleInUnits: number;
    riskBudgetPct: number;
    unitSize: number;
    notionalLabel: string;
  };
  entryTrigger: string;
  monitoringTrigger: string;
  stopTrigger: string;
  takeProfitTrigger: string;
};

const pct = (value: number) => `${Math.round(value * 100)}%`;
const signedPct = (value: number) => `${value >= 0 ? '+' : ''}${Math.round(value * 100)} pts`;

function directionFor(edge: number): TradeDirection {
  if (edge >= 0.01) return 'buy-yes';
  if (edge <= -0.01) return 'buy-no';
  return 'stand-aside';
}

function quotePass(status: QuoteStatus) {
  return status === 'tight' || status === 'tradable';
}

function convictionFor(score: number): PaperTradePlan['conviction'] {
  if (score >= 6.4) return 'high';
  if (score >= 4.9) return 'medium';
  return 'low';
}

function eventSpecificQuality(market: WeatherMarket) {
  const schema = market.resolutionSchema;
  const hasNearLimitTiming = /\bnear-limit\b/i.test(market.heuristicDetails.thresholdLabel) || /near its limit/i.test(market.heuristicSummary);
  const unsupportedTiming = /\bunsupported\b/i.test(market.heuristicDetails.thresholdLabel) || /well beyond the 3-day forecast window/i.test(market.notes);

  if (schema.kind === 'temperatureMax') {
    const thresholdDistance = schema.threshold == null || market.heuristicDetails.observedValue == null
      ? 0
      : Math.abs(market.heuristicDetails.observedValue - schema.threshold);
    const thresholdOk = schema.threshold == null || market.heuristicDetails.observedValue == null || thresholdDistance <= 8;
    return {
      score: thresholdOk ? 1.25 : 0.55,
      passed: thresholdOk,
      label: 'Event fit',
      value: schema.threshold == null || market.heuristicDetails.observedValue == null ? 'SCaffold' : `${Math.round(thresholdDistance)}° from trigger`,
      detail: thresholdOk
        ? 'Temperature setup is close enough to the contract trigger to treat the edge as actionable.'
        : 'Temperature path is still too far from the trigger, so this behaves more like a vague weather lean than a tradeable threshold setup.',
    };
  }

  if (schema.kind === 'precipitation') {
    const observed = market.heuristicDetails.observedValue ?? 0;
    const threshold = schema.threshold ?? 0.5;
    const thresholdOk = observed >= Math.max(threshold * 0.7, threshold - 0.35);
    return {
      score: thresholdOk ? 1.2 : 0.45,
      passed: thresholdOk,
      label: 'Event fit',
      value: `${Math.round(observed * 100)}% precip / ${threshold}${schema.units ?? ''}`,
      detail: thresholdOk
        ? 'Rain setup has enough intensity to map cleanly onto the accumulation threshold.'
        : 'Rain probabilities are still too soft for this threshold, so false positives are more likely than clean payoff.',
    };
  }

  if (schema.kind === 'windSpeed') {
    const observed = market.heuristicDetails.observedValue ?? 0;
    const threshold = schema.threshold ?? 25;
    const thresholdOk = observed >= threshold - 5;
    return {
      score: thresholdOk ? 1.15 : 0.5,
      passed: thresholdOk,
      label: 'Event fit',
      value: `${Math.round(observed)} mph / ${threshold} mph`,
      detail: thresholdOk
        ? 'Wind path is close enough to the trigger to justify a directional trade plan.'
        : 'Wind path is still too far below the trigger, which makes this setup noisy and easy to overtrade.',
    };
  }

  const timingOk = !unsupportedTiming && !hasNearLimitTiming;
  return {
    score: timingOk ? 0.95 : 0.35,
    passed: timingOk,
    label: 'Event fit',
    value: unsupportedTiming ? 'TIMING WEAK' : hasNearLimitTiming ? 'TIMING THIN' : 'TIMING OK',
    detail: timingOk
      ? 'Event timing sits inside the forecast support window.'
      : 'Event timing is too close to the forecast boundary to trust a bot-led trade without extra confirmation.',
  };
}

export function buildPaperTradePlan(market: WeatherMarket, settings: PaperExecutionSettings): PaperTradePlan {
  const absEdge = Math.abs(market.edge);
  const direction = directionFor(market.edge);
  const isWatchlistSetup = market.dataOrigin === 'curated-watchlist';
  const thresholdLabel = market.heuristicDetails.thresholdLabel.toLowerCase();
  const eventFit = eventSpecificQuality(market);
  const liquidityValue = Number.parseFloat(market.liquidity.replace(/[^\d.]/g, '')) || 0;
  const quoteAge = market.heuristicDetails.quoteAgeMinutes;
  const hasNearLimitTiming = /\bnear-limit\b/i.test(market.heuristicDetails.thresholdLabel) || /near its limit/i.test(market.heuristicSummary);
  const unsupportedTiming = /\bunsupported\b/i.test(market.heuristicDetails.thresholdLabel) || /well beyond the 3-day forecast window/i.test(market.notes);
  const executionOk = !isWatchlistSetup && quotePass(market.quoteStatus) && quoteAge <= 35;
  const edgeOk = absEdge >= (market.resolutionSchema.kind === 'namedStorm' ? 0.09 : 0.07);
  const confidenceOk = market.confidence >= (isWatchlistSetup ? 0.58 : 0.67);
  const freshnessOk = market.freshnessMinutes <= (isWatchlistSetup ? 110 : 85);
  const disagreementOk = market.disagreement <= 0.18;
  const parseOk = market.discovery.parseConfidence >= (isWatchlistSetup ? 0.58 : 0.74);
  const liquidityOk = isWatchlistSetup || liquidityValue >= 800;
  const timingOk = !unsupportedTiming;
  const qualityFloorOk = eventFit.passed && timingOk && (!hasNearLimitTiming || absEdge >= 0.1);

  const entryCriteria: DecisionCriterion[] = [
    {
      label: 'Edge',
      value: signedPct(market.edge),
      passed: edgeOk,
      detail: isWatchlistSetup
        ? (edgeOk ? 'Model edge is strong enough to justify stalking the next clean listing.' : 'The forecast lean is interesting, but not sharp enough to build a serious pre-trade plan yet.')
        : (edgeOk ? 'Gap is large enough to justify a paper entry.' : 'Edge is still too thin for first-pass deployment.'),
    },
    {
      label: 'Confidence',
      value: pct(market.confidence),
      passed: confidenceOk,
      detail: confidenceOk
        ? (isWatchlistSetup ? 'Forecast stack is coherent enough to keep this setup near the top of the watchlist.' : 'Forecast stack is coherent enough to lean in.')
        : (isWatchlistSetup ? 'Forecast support is still too soft for a serious pre-trade queue.' : 'Confidence is still below the practical trade bar.'),
    },
    {
      label: isWatchlistSetup ? 'Listing readiness' : 'Execution',
      value: isWatchlistSetup ? 'WAITING' : `${market.quoteStatus.toUpperCase()} · ${quoteAge}m`,
      passed: executionOk,
      detail: isWatchlistSetup
        ? 'No matching live contract is listed yet, so the setup stays non-executable until the board gives you a clean target.'
        : (executionOk ? 'Order book looks usable for a simulated fill and the quote is still fresh.' : 'Execution is too weak, stale, or old to trust yet.'),
    },
    {
      label: 'Freshness',
      value: `${market.freshnessMinutes}m`,
      passed: freshnessOk,
      detail: freshnessOk ? 'Inputs are recent enough for the current tape.' : 'Weather or quote inputs are aging out.',
    },
    {
      label: 'Model spread',
      value: pct(market.disagreement),
      passed: disagreementOk,
      detail: disagreementOk ? 'Forecast disagreement is controlled.' : 'Forecast disagreement is still too wide.',
    },
    {
      label: 'Rule parse',
      value: pct(market.discovery.parseConfidence),
      passed: parseOk,
      detail: parseOk
        ? (isWatchlistSetup ? 'Setup definition is specific enough to watch for a matching contract.' : 'Contract resolution is parsed well enough for automation scaffolding.')
        : (isWatchlistSetup ? 'The trigger still needs clearer contract wording before it can graduate from scouting to queueing.' : 'Settlement parsing is still too fuzzy for bot-like behavior.'),
    },
    eventFit,
    {
      label: 'Liquidity',
      value: liquidityValue ? `$${Math.round(liquidityValue)}` : 'N/A',
      passed: liquidityOk,
      detail: liquidityOk ? 'Depth is decent enough that the bot is less likely to chase a ghost quote.' : 'Liquidity is too thin, so even a decent model edge can be fake or untradeable.',
    },
    {
      label: 'Timing window',
      value: unsupportedTiming ? 'UNSUPPORTED' : hasNearLimitTiming ? 'NEAR LIMIT' : 'SUPPORTED',
      passed: qualityFloorOk,
      detail: qualityFloorOk
        ? 'Forecast support and event timing are strong enough for automation review.'
        : unsupportedTiming
          ? 'This contract sits outside the reliable forecast window.'
          : 'Timing is close to the forecast boundary, so only exceptional edges should survive.',
    },
  ];

  const passCount = entryCriteria.filter((item) => item.passed).length;
  const score = passCount
    + (absEdge >= 0.1 ? 0.9 : absEdge >= 0.08 ? 0.5 : 0)
    + (market.confidence >= 0.75 ? 0.7 : market.confidence >= 0.7 ? 0.35 : 0)
    + (market.disagreement <= 0.12 ? 0.35 : 0)
    + (parseOk ? 0.35 : -0.5)
    + (qualityFloorOk ? 0.6 : -1.25)
    + (isWatchlistSetup ? 0.15 : 0);
  const conviction = convictionFor(score);

  const highQualitySetup = qualityFloorOk && parseOk && freshnessOk && disagreementOk && confidenceOk;
  const blockers = isWatchlistSetup
    ? [
        'No live exchange contract is listed yet, so this stays a pre-trade watchlist setup.',
        ...entryCriteria.filter((item) => !item.passed && item.label !== 'Listing readiness').map((item) => `${item.label}: ${item.detail}`),
        `Do not queue or activate this until a real contract appears with wording that matches ${thresholdLabel}.`,
      ]
    : [
        ...entryCriteria.filter((item) => !item.passed).map((item) => `${item.label}: ${item.detail}`),
        ...(highQualitySetup ? [] : ['Quality floor: Event-specific fit, timing support, or parse quality is not good enough for bot execution yet.']),
      ];

  const convictionMultiplier = conviction === 'high' ? 1.5 : conviction === 'medium' ? 1 : 0.5;
  const suggestedUnits = Math.max(1, Math.min(settings.maxUnits, Math.round(settings.unitSize * convictionMultiplier)));
  const maxUnits = Math.max(suggestedUnits, settings.maxUnits);
  const scaleInUnits = Math.min(settings.scaleInUnits, maxUnits);
  const riskBudgetPct = Number((suggestedUnits * settings.stopLossPts * 100).toFixed(1));
  const wouldTrade = !isWatchlistSetup
    && highQualitySetup
    && edgeOk
    && executionOk
    && liquidityOk
    && direction !== 'stand-aside'
    && score >= 6.1;
  const watchOnly = isWatchlistSetup
    ? passCount >= 6 && direction !== 'stand-aside' && timingOk
    : !wouldTrade && highQualitySetup && passCount >= 5 && absEdge >= 0.045;
  const decision: TradeDecision = wouldTrade ? 'would-trade' : watchOnly ? 'watch' : 'no-trade';

  const thesis = isWatchlistSetup
    ? direction === 'buy-yes'
      ? `Forecasts price ${thresholdLabel} around ${pct(market.modelProbability)} odds, so this is worth stalking as a future YES trade if a matching contract lists too cheap.`
      : direction === 'buy-no'
        ? `Forecasts lean away from ${thresholdLabel}, so this stays on the board only in case a matching listing opens too rich.`
        : 'This setup is informative, but the directional edge is still too small to justify a pre-trade stance.'
    : direction === 'buy-yes'
      ? `Model probability is ${pct(market.modelProbability)} against a ${pct(market.impliedProbability)} market, so the scanner would lean YES if execution holds.`
      : direction === 'buy-no'
        ? `Market is richer than the model by ${signedPct(Math.abs(market.edge))}, so the scanner would lean NO if the quote stays tradable.`
        : 'Edge is too small to justify a side yet.';

  return {
    decision,
    direction,
    conviction,
    thesis,
    blockers,
    entryCriteria,
    entryTrigger: isWatchlistSetup
      ? `No live entry yet. If a real contract lists with wording close to ${thresholdLabel}, only queue it after the board opens inside the model zone and forecast support still holds.`
      : wouldTrade
        ? `Enter paper ${direction === 'buy-yes' ? 'YES' : 'NO'} using ${settings.fillReference.toUpperCase()} + ${settings.slippageBps} bps slippage while edge stays beyond ${market.resolutionSchema.kind === 'namedStorm' ? '9' : '7'} pts, quote remains ${executionOk ? market.quoteStatus : 'tradable'}, and event-specific fit still clears the quality floor.`
        : 'No entry yet. Wait until edge, confidence, execution, event fit, and timing support align together.',
    monitoringTrigger: isWatchlistSetup
      ? 'Re-check after each forecast update and every new market listing. Promote this only when a live contract appears with matching settlement language and the model edge still clears the entry bar.'
      : 'Re-check after each quote refresh or weather-model update. If edge compresses by 3+ pts, reassess immediately.',
    stopTrigger: isWatchlistSetup
      ? 'Delete the setup from the active queue if forecast support fades, the trigger wording drifts, or a live listing appears but opens too rich for the model.'
      : `Abort or flatten if marked loss reaches ${signedPct(settings.stopLossPts)}, confidence drops below 58%, event fit breaks, or quote degrades to WIDE/STALE for two checks.`,
    takeProfitTrigger: isWatchlistSetup
      ? 'If a matching contract lists and you get filled, start taking profit when the weather move is recognized and the original listing discount is gone.'
      : `Scale out when marked gain reaches ${signedPct(settings.takeProfitPts)} or when the contract becomes fully priced and asymmetry disappears.`,
    exitCriteria: isWatchlistSetup
      ? [
          'Remove it from the priority queue if the next forecast cycle cuts the edge below 4 pts.',
          'Drop it if confidence slips below 50% or forecast disagreement widens above 28%.',
          'Do not trade a later listing unless settlement wording, city, threshold, and time window match the setup closely.',
          'Once listed, pass if the contract opens near fair value and the asymmetry is already gone.',
        ]
      : [
          `Marked loss reaches ${signedPct(settings.stopLossPts)} or edge compresses below 3 pts or flips against the thesis.`,
          'Confidence falls below 55% or forecast disagreement widens above 28%.',
          `Marked gain reaches ${signedPct(settings.takeProfitPts)} or quote quality degrades to wide/stale for multiple refreshes.`,
          'Event window is too close for fresh forecast updates to matter.',
        ],
    sizing: {
      suggestedUnits,
      maxUnits,
      scaleInUnits,
      riskBudgetPct,
      unitSize: settings.unitSize,
      notionalLabel: isWatchlistSetup
        ? `${riskBudgetPct}% paper risk placeholder, ${suggestedUnits}/${maxUnits} units if a matching contract lists cleanly, scale in ${scaleInUnits}, base unit ${settings.unitSize}`
        : `${riskBudgetPct}% paper risk budget, ${suggestedUnits}/${maxUnits} units initial size, scale in ${scaleInUnits}, base unit ${settings.unitSize}`,
    },
  };
}
