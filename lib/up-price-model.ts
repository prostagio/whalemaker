export const UP_PRICE_FEATURE_NAMES = [
  "current_up_ask_cents",
  "up_spread_cents",
  "outcome_overround_cents",
  "distance_bps",
  "seconds_left",
  "log_variance",
  "clob_up_logit",
  "model_clob_gap",
  "momentum_15_bps",
  "momentum_30_bps",
  "momentum_60_bps",
  "contract_trend_15",
  "contract_trend_30",
  "log_top_depth",
  "choppiness_60",
  "data_age_seconds",
] as const;

export type StoredUpPriceModel = {
  status: "COLLECTING" | "TRAINED";
  trainedAt: number;
  horizonSeconds: number;
  snapshotCount: number;
  exampleCount: number;
  marketCount: number;
  trainCount: number;
  testCount: number;
  maeCents: number | null;
  rmseCents: number | null;
  baselineMaeCents: number | null;
  directionAccuracy: number | null;
  rSquared: number | null;
  featureNames: string[];
  means: number[];
  scales: number[];
  weights: number[];
  bias: number | null;
  l2: number | null;
  message: string;
};

export type UpPriceFeatureValues = {
  btcPrice: number;
  strikePrice: number;
  secondsLeft: number;
  variance: number;
  rawProbability: number;
  marketUp: number;
  upBid: number;
  upAsk: number;
  downAsk: number;
  momentum15Bps: number;
  momentum30Bps: number;
  momentum60Bps: number;
  upContractMove15: number;
  downContractMove15: number;
  upContractMove30: number;
  downContractMove30: number;
  topDepth: number;
  choppiness60: number;
  dataAgeMs: number;
};

const EPSILON = 1e-8;
const clampProbability = (value: number) => Math.min(1 - 1e-5, Math.max(1e-5, value));
const clampContractPrice = (value: number) => Math.min(0.99, Math.max(0.01, value));

export const upPriceFeaturesFromValues = (values: UpPriceFeatureValues) => {
  const marketUp = clampProbability(values.marketUp);
  return [
    values.upAsk * 100,
    (values.upAsk - values.upBid) * 100,
    (values.upAsk + values.downAsk - 1) * 100,
    Math.log(Math.max(values.btcPrice, EPSILON) / Math.max(values.strikePrice, EPSILON)) * 10_000,
    values.secondsLeft,
    Math.log(Math.max(values.variance, 1e-12)),
    Math.log(marketUp / (1 - marketUp)),
    values.rawProbability - marketUp,
    values.momentum15Bps,
    values.momentum30Bps,
    values.momentum60Bps,
    (values.upContractMove15 - values.downContractMove15) * 100,
    (values.upContractMove30 - values.downContractMove30) * 100,
    Math.log1p(Math.max(0, values.topDepth)),
    values.choppiness60,
    values.dataAgeMs / 1_000,
  ];
};

export const predictUpPrice = (
  model: StoredUpPriceModel,
  features: number[],
  currentUpAsk: number
) => {
  if (
    model.status !== "TRAINED" ||
    model.bias == null ||
    !Number.isFinite(currentUpAsk) ||
    features.some((value) => !Number.isFinite(value)) ||
    model.weights.length !== features.length ||
    model.means.length !== features.length ||
    model.scales.length !== features.length
  ) return null;
  const deltaCents = features.reduce((total, value, index) =>
    total + ((value - model.means[index]) / model.scales[index]) * model.weights[index],
  model.bias);
  const price = clampContractPrice(currentUpAsk + deltaCents / 100);
  return {
    price,
    deltaCents: (price - currentUpAsk) * 100,
  };
};
