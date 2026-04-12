export type PaperFillReference = 'mid' | 'ask' | 'bid' | 'last';

export type PaperExecutionSettings = {
  unitSize: number;
  maxUnits: number;
  scaleInUnits: number;
  fillReference: PaperFillReference;
  slippageBps: number;
  stopLossPts: number;
  takeProfitPts: number;
};

export type PaperExecutionProfile = {
  global: PaperExecutionSettings;
  perMarket: Record<string, Partial<PaperExecutionSettings>>;
};

export const DEFAULT_PAPER_EXECUTION_SETTINGS: PaperExecutionSettings = {
  unitSize: 2,
  maxUnits: 5,
  scaleInUnits: 1,
  fillReference: 'ask',
  slippageBps: 50,
  stopLossPts: 0.03,
  takeProfitPts: 0.06,
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const int = (value: number, fallback: number, min: number, max: number) => {
  const parsed = Number.isFinite(value) ? Math.round(value) : fallback;
  return clamp(parsed, min, max);
};
const dec = (value: number, fallback: number, min: number, max: number) => {
  const parsed = Number.isFinite(value) ? value : fallback;
  return clamp(parsed, min, max);
};

export function sanitizePaperExecutionSettings(input?: Partial<PaperExecutionSettings> | null): PaperExecutionSettings {
  return {
    unitSize: int(input?.unitSize ?? DEFAULT_PAPER_EXECUTION_SETTINGS.unitSize, DEFAULT_PAPER_EXECUTION_SETTINGS.unitSize, 1, 100),
    maxUnits: int(input?.maxUnits ?? DEFAULT_PAPER_EXECUTION_SETTINGS.maxUnits, DEFAULT_PAPER_EXECUTION_SETTINGS.maxUnits, 1, 200),
    scaleInUnits: int(input?.scaleInUnits ?? DEFAULT_PAPER_EXECUTION_SETTINGS.scaleInUnits, DEFAULT_PAPER_EXECUTION_SETTINGS.scaleInUnits, 1, 100),
    fillReference: input?.fillReference === 'mid' || input?.fillReference === 'ask' || input?.fillReference === 'bid' || input?.fillReference === 'last'
      ? input.fillReference
      : DEFAULT_PAPER_EXECUTION_SETTINGS.fillReference,
    slippageBps: int(input?.slippageBps ?? DEFAULT_PAPER_EXECUTION_SETTINGS.slippageBps, DEFAULT_PAPER_EXECUTION_SETTINGS.slippageBps, 0, 1000),
    stopLossPts: dec(input?.stopLossPts ?? DEFAULT_PAPER_EXECUTION_SETTINGS.stopLossPts, DEFAULT_PAPER_EXECUTION_SETTINGS.stopLossPts, 0.005, 0.5),
    takeProfitPts: dec(input?.takeProfitPts ?? DEFAULT_PAPER_EXECUTION_SETTINGS.takeProfitPts, DEFAULT_PAPER_EXECUTION_SETTINGS.takeProfitPts, 0.005, 0.8),
  };
}

export function mergePaperExecutionSettings(profile: PaperExecutionProfile, marketId: string): PaperExecutionSettings {
  return sanitizePaperExecutionSettings({
    ...profile.global,
    ...(profile.perMarket[marketId] ?? {}),
  });
}
