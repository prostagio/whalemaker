export const DIRECTION_FEATURE_NAMES = [
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
  "spread_cents",
  "log_top_depth",
  "choppiness_60",
  "data_age_seconds",
] as const;

export type StoredDirectionModel = {
  status: "COLLECTING" | "TRAINED";
  trainedAt: number;
  horizonSeconds: number;
  snapshotCount: number;
  exampleCount: number;
  marketCount: number;
  trainCount: number;
  testCount: number;
  positiveRate: number | null;
  baselineAccuracy: number | null;
  accuracy: number | null;
  balancedAccuracy: number | null;
  precision: number | null;
  recall: number | null;
  auc: number | null;
  logLoss: number | null;
  threshold: number;
  featureNames: string[];
  means: number[];
  scales: number[];
  weights: number[];
  bias: number | null;
  l2: number | null;
  message: string;
};

const EPSILON = 1e-8;
const clampProbability = (value: number) => Math.min(1 - 1e-5, Math.max(1e-5, value));
const sigmoid = (value: number) => {
  if (value >= 0) {
    const exponential = Math.exp(-Math.min(value, 40));
    return 1 / (1 + exponential);
  }
  const exponential = Math.exp(Math.max(value, -40));
  return exponential / (1 + exponential);
};

export const directionFeaturesFromValues = (values: {
  btcPrice: number;
  strikePrice: number;
  secondsLeft: number;
  variance: number;
  rawProbability: number;
  marketUp: number;
  momentum15Bps: number;
  momentum30Bps: number;
  momentum60Bps: number;
  upContractMove15: number;
  downContractMove15: number;
  upContractMove30: number;
  downContractMove30: number;
  spread: number;
  topDepth: number;
  choppiness60: number;
  dataAgeMs: number;
}) => {
  const marketUp = clampProbability(values.marketUp);
  return [
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
    values.spread * 100,
    Math.log1p(Math.max(0, values.topDepth)),
    values.choppiness60,
    values.dataAgeMs / 1_000,
  ];
};

export const predictDirectionProbability = (
  model: StoredDirectionModel,
  features: number[]
) => {
  if (
    model.status !== "TRAINED" ||
    model.bias == null ||
    features.some((value) => !Number.isFinite(value)) ||
    model.weights.length !== features.length ||
    model.means.length !== features.length ||
    model.scales.length !== features.length
  ) return null;
  const score = features.reduce((total, value, index) =>
    total + ((value - model.means[index]) / model.scales[index]) * model.weights[index],
  model.bias);
  return sigmoid(score);
};
