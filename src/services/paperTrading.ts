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
  if (score >= 4.2) return 'high';
  if (score >= 3.2) return 'medium';
  return 'low';
}

export function buildPaperTradePlan(market: WeatherMarket, settings: PaperExecutionSettings): PaperTradePlan {
  const absEdge = Math.abs(market.edge);
  const direction = directionFor(market.edge);
  const isWatchlistSetup = market.dataOrigin === 'curated-watchlist';
  const executionOk = !isWatchlistSetup && quotePass(market.quoteStatus);
  const edgeOk = absEdge >= 0.06;
  const confidenceOk = market.confidence >= (isWatchlistSetup ? 0.54 : 0.62);
  const freshnessOk = market.freshnessMinutes <= 100;
  const disagreementOk = market.disagreement <= 0.22;
  const parseOk = market.discovery.parseConfidence >= (isWatchlistSetup ? 0.5 : 0.68);
  const thresholdLabel = market.heuristicDetails.thresholdLabel.toLowerCase();

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
      value: isWatchlistSetup ? 'WAITING' : market.quoteStatus.toUpperCase(),
      passed: executionOk,
      detail: isWatchlistSetup
        ? 'No matching live contract is listed yet, so the setup stays non-executable until the board gives you a clean target.'
        : (executionOk ? 'Order book looks usable for a simulated fill.' : 'Execution is too weak or stale to trust yet.'),
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
  ];

  const passCount = entryCriteria.filter((item) => item.passed).length;
  const score = passCount + (absEdge >= 0.1 ? 0.6 : 0) + (market.confidence >= 0.75 ? 0.4 : 0) + (isWatchlistSetup ? 0.25 : 0);
  const conviction = convictionFor(score);

  const blockers = isWatchlistSetup
    ? [
        'No live exchange contract is listed yet, so this stays a pre-trade watchlist setup.',
        ...entryCriteria.filter((item) => !item.passed && item.label !== 'Listing readiness').map((item) => `${item.label}: ${item.detail}`),
        `Do not queue or activate this until a real contract appears with wording that matches ${thresholdLabel}.`,
      ]
    : entryCriteria.filter((item) => !item.passed).map((item) => `${item.label}: ${item.detail}`);

  const convictionMultiplier = conviction === 'high' ? 1.5 : conviction === 'medium' ? 1 : 0.5;
  const suggestedUnits = Math.max(1, Math.min(settings.maxUnits, Math.round(settings.unitSize * convictionMultiplier)));
  const maxUnits = Math.max(suggestedUnits, settings.maxUnits);
  const scaleInUnits = Math.min(settings.scaleInUnits, maxUnits);
  const riskBudgetPct = Number((suggestedUnits * settings.stopLossPts * 100).toFixed(1));

  const wouldTrade = !isWatchlistSetup && edgeOk && confidenceOk && executionOk && freshnessOk && disagreementOk && parseOk && direction !== 'stand-aside';
  const watchOnly = isWatchlistSetup ? passCount >= 4 && direction !== 'stand-aside' : !wouldTrade && passCount >= 3;
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
        ? `Enter paper ${direction === 'buy-yes' ? 'YES' : 'NO'} using ${settings.fillReference.toUpperCase()} + ${settings.slippageBps} bps slippage while edge stays beyond 6 pts and quote remains ${executionOk ? market.quoteStatus : 'tradable'}.`
        : 'No entry yet. Wait until edge, confidence, execution, and freshness align together.',
    monitoringTrigger: isWatchlistSetup
      ? 'Re-check after each forecast update and every new market listing. Promote this only when a live contract appears with matching settlement language and the model edge still clears the entry bar.'
      : 'Re-check after each quote refresh or weather-model update. If edge compresses by 3+ pts, reassess immediately.',
    stopTrigger: isWatchlistSetup
      ? 'Delete the setup from the active queue if forecast support fades, the trigger wording drifts, or a live listing appears but opens too rich for the model.'
      : `Abort or flatten if marked loss reaches ${signedPct(settings.stopLossPts)}, confidence drops below 55%, or quote degrades to WIDE/STALE for two checks.`,
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
