export const OUTCOME_FEATURE_NAMES = [
  "market_up_probability",
  "up_ask_cents",
  "up_bid_cents",
  "down_ask_cents",
  "down_bid_cents",
  "up_spread_cents",
  "down_spread_cents",
  "outcome_overround_cents",
  "up_book_imbalance",
  "down_book_imbalance",
  "ask_depth_log_ratio",
  "distance_bps",
  "seconds_left",
  "log_variance",
  "raw_chainlink_probability",
  "model_clob_gap",
  "momentum_15_bps",
  "momentum_30_bps",
  "momentum_60_bps",
  "contract_trend_15",
  "contract_trend_30",
  "log_total_depth",
  "choppiness_60",
  "data_age_seconds",
] as const;

export type OutcomeTree = {
  featureIndex: number;
  threshold: number;
  leftValue: number;
  rightValue: number;
};

export type OutcomeBoostConfig = {
  treeCount: number;
  learningRate: number;
  minLeaf: number;
  l2: number;
  bins: number;
  correctionScale: number;
};

export type StoredOutcomeModel = {
  status: "COLLECTING" | "TRAINED";
  trainedAt: number;
  snapshotCount: number;
  exampleCount: number;
  marketCount: number;
  trainCount: number;
  testCount: number;
  positiveRate: number | null;
  logLoss: number | null;
  brierScore: number | null;
  accuracy: number | null;
  balancedAccuracy: number | null;
  auc: number | null;
  calibrationError: number | null;
  baselineLogLoss: number | null;
  baselineBrierScore: number | null;
  featureNames: string[];
  trees: OutcomeTree[];
  config: OutcomeBoostConfig | null;
  message: string;
};

export type OutcomeFeatureValues = {
  btcPrice: number;
  strikePrice: number;
  secondsLeft: number;
  variance: number;
  rawProbability: number;
  marketUp: number;
  upBid: number;
  upAsk: number;
  downBid: number;
  downAsk: number;
  upAskSize: number;
  upBidSize: number;
  downAskSize: number;
  downBidSize: number;
  momentum15Bps: number;
  momentum30Bps: number;
  momentum60Bps: number;
  upContractMove15: number;
  downContractMove15: number;
  upContractMove30: number;
  downContractMove30: number;
  choppiness60: number;
  dataAgeMs: number;
};

const EPSILON = 1e-8;
export const clampOutcomeProbability = (value: number) =>
  Math.min(1 - 1e-5, Math.max(1e-5, value));
export const outcomeLogit = (probability: number) => {
  const value = clampOutcomeProbability(probability);
  return Math.log(value / (1 - value));
};
export const outcomeSigmoid = (score: number) => {
  if (score >= 0) {
    const exponential = Math.exp(-Math.min(score, 40));
    return 1 / (1 + exponential);
  }
  const exponential = Math.exp(Math.max(score, -40));
  return exponential / (1 + exponential);
};
const imbalance = (bidSize: number, askSize: number) => {
  const total = Math.max(0, bidSize) + Math.max(0, askSize);
  return total > 0 ? (Math.max(0, bidSize) - Math.max(0, askSize)) / total : 0;
};

export const outcomeFeaturesFromValues = (values: OutcomeFeatureValues) => {
  const marketUp = clampOutcomeProbability(values.marketUp);
  const totalDepth = Math.max(0, values.upAskSize) + Math.max(0, values.upBidSize) +
    Math.max(0, values.downAskSize) + Math.max(0, values.downBidSize);
  return [
    marketUp,
    values.upAsk * 100,
    values.upBid * 100,
    values.downAsk * 100,
    values.downBid * 100,
    (values.upAsk - values.upBid) * 100,
    (values.downAsk - values.downBid) * 100,
    (values.upAsk + values.downAsk - 1) * 100,
    imbalance(values.upBidSize, values.upAskSize),
    imbalance(values.downBidSize, values.downAskSize),
    Math.log1p(Math.max(0, values.upAskSize)) - Math.log1p(Math.max(0, values.downAskSize)),
    Math.log(Math.max(values.btcPrice, EPSILON) / Math.max(values.strikePrice, EPSILON)) * 10_000,
    values.secondsLeft,
    Math.log(Math.max(values.variance, 1e-12)),
    values.rawProbability,
    values.rawProbability - marketUp,
    values.momentum15Bps,
    values.momentum30Bps,
    values.momentum60Bps,
    (values.upContractMove15 - values.downContractMove15) * 100,
    (values.upContractMove30 - values.downContractMove30) * 100,
    Math.log1p(totalDepth),
    values.choppiness60,
    values.dataAgeMs / 1_000,
  ];
};

export const predictOutcomeProbability = (
  model: StoredOutcomeModel,
  features: number[],
  marketUp: number
) => {
  if (
    model.status !== "TRAINED" ||
    !model.config ||
    features.length !== OUTCOME_FEATURE_NAMES.length ||
    features.some((value) => !Number.isFinite(value))
  ) return null;
  const correction = model.trees.reduce((score, tree) =>
    score + (features[tree.featureIndex] <= tree.threshold ? tree.leftValue : tree.rightValue),
  0);
  return outcomeSigmoid(outcomeLogit(marketUp) + model.config.correctionScale * correction);
};
