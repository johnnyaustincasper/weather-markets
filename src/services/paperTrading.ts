import type { QuoteStatus, WeatherMarket } from '../types';

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

export function buildPaperTradePlan(market: WeatherMarket): PaperTradePlan {
  const absEdge = Math.abs(market.edge);
  const direction = directionFor(market.edge);
  const executionOk = quotePass(market.quoteStatus);
  const edgeOk = absEdge >= 0.06;
  const confidenceOk = market.confidence >= 0.62;
  const freshnessOk = market.freshnessMinutes <= 100;
  const disagreementOk = market.disagreement <= 0.22;
  const parseOk = market.discovery.parseConfidence >= 0.68;

  const entryCriteria: DecisionCriterion[] = [
    {
      label: 'Edge',
      value: signedPct(market.edge),
      passed: edgeOk,
      detail: edgeOk ? 'Gap is large enough to justify a paper entry.' : 'Edge is still too thin for first-pass deployment.',
    },
    {
      label: 'Confidence',
      value: pct(market.confidence),
      passed: confidenceOk,
      detail: confidenceOk ? 'Forecast stack is coherent enough to lean in.' : 'Confidence is still below the practical trade bar.',
    },
    {
      label: 'Execution',
      value: market.quoteStatus.toUpperCase(),
      passed: executionOk,
      detail: executionOk ? 'Order book looks usable for a simulated fill.' : 'Execution is too weak or stale to trust yet.',
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
      detail: parseOk ? 'Contract resolution is parsed well enough for automation scaffolding.' : 'Settlement parsing is still too fuzzy for bot-like behavior.',
    },
  ];

  const passCount = entryCriteria.filter((item) => item.passed).length;
  const score = passCount + (absEdge >= 0.1 ? 0.6 : 0) + (market.confidence >= 0.75 ? 0.4 : 0);
  const conviction = convictionFor(score);

  const blockers = entryCriteria.filter((item) => !item.passed).map((item) => `${item.label}: ${item.detail}`);

  const suggestedUnits = conviction === 'high' ? 3 : conviction === 'medium' ? 2 : 1;
  const maxUnits = conviction === 'high' ? 5 : conviction === 'medium' ? 3 : 2;
  const scaleInUnits = conviction === 'high' ? 1 : 1;
  const riskBudgetPct = conviction === 'high' ? 1.5 : conviction === 'medium' ? 1 : 0.5;

  const wouldTrade = edgeOk && confidenceOk && executionOk && freshnessOk && disagreementOk && parseOk && direction !== 'stand-aside';
  const watchOnly = !wouldTrade && passCount >= 3;
  const decision: TradeDecision = wouldTrade ? 'would-trade' : watchOnly ? 'watch' : 'no-trade';

  const thesis = direction === 'buy-yes'
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
    entryTrigger: wouldTrade
      ? `Enter paper ${direction === 'buy-yes' ? 'YES' : 'NO'} while edge stays beyond 6 pts and quote remains ${executionOk ? market.quoteStatus : 'tradable'}.`
      : 'No entry yet. Wait until edge, confidence, execution, and freshness align together.',
    monitoringTrigger: 'Re-check after each quote refresh or weather-model update. If edge compresses by 3+ pts, reassess immediately.',
    stopTrigger: `Abort or flatten if edge compresses under 3 pts, confidence drops below 55%, or quote degrades to WIDE/STALE for two checks.`,
    takeProfitTrigger: 'Scale out when the market closes at least half the model gap, or when the contract becomes fully priced and asymmetry disappears.',
    exitCriteria: [
      'Edge compresses below 3 pts or flips against the thesis.',
      'Confidence falls below 55% or forecast disagreement widens above 28%.',
      'Quote quality degrades to wide/stale for multiple refreshes.',
      'Event window is too close for fresh forecast updates to matter.',
    ],
    sizing: {
      suggestedUnits,
      maxUnits,
      scaleInUnits,
      riskBudgetPct,
      notionalLabel: `${riskBudgetPct}% paper risk budget, ${suggestedUnits}/${maxUnits} units initial size`,
    },
  };
}
