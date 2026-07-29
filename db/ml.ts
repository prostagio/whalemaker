import { env } from "cloudflare:workers";
import {
  DIRECTION_FEATURE_NAMES,
  directionFeaturesFromValues,
  type StoredDirectionModel,
} from "../lib/direction-model";

const MIN_FUTURE_MS = 8_000;
const MAX_FUTURE_MS = 14_000;
const MIN_SAMPLE_GAP_MS = 9_000;
const MAX_SNAPSHOTS = 8_000;
const MIN_EXAMPLES = 160;
const MIN_MARKETS = 8;
const RETRAIN_SNAPSHOT_GAP = 120;
const RETRAIN_AFTER_MS = 30 * 60_000;

type SnapshotRow = {
  market_slug: string;
  captured_at: number;
  btc_price: number;
  strike_price: number;
  seconds_left: number;
  variance: number;
  raw_probability: number;
  calibrated_probability: number;
  up_bid: number;
  up_ask: number;
  down_bid: number;
  down_ask: number;
  spread: number;
  top_depth: number;
  data_age_ms: number;
  momentum_15_bps: number;
  momentum_30_bps: number;
  momentum_60_bps: number;
  up_contract_move_15: number;
  down_contract_move_15: number;
  up_contract_move_30: number;
  down_contract_move_30: number;
  choppiness_60: number;
};

type TrainingExample = {
  marketSlug: string;
  timestamp: number;
  features: number[];
  label: 0 | 1;
};

type DirectionMetrics = {
  accuracy: number;
  balancedAccuracy: number;
  precision: number;
  recall: number;
  auc: number;
  logLoss: number;
  positiveRate: number;
};

type StoredDirectionModelRow = {
  status: "COLLECTING" | "TRAINED";
  trained_at: number;
  horizon_seconds: number;
  snapshot_count: number;
  example_count: number;
  market_count: number;
  train_count: number;
  test_count: number;
  positive_rate: number | null;
  baseline_accuracy: number | null;
  accuracy: number | null;
  balanced_accuracy: number | null;
  precision: number | null;
  recall: number | null;
  auc: number | null;
  log_loss: number | null;
  threshold: number;
  feature_names: string | null;
  means: string | null;
  scales: string | null;
  weights: string | null;
  bias: number | null;
  l2: number | null;
  message: string;
};

const db = () => {
  if (!env.DB) throw new Error("The model database is unavailable.");
  return env.DB;
};

const clampProbability = (value: number) => Math.min(1 - 1e-5, Math.max(1e-5, value));
const sigmoid = (value: number) => {
  if (value >= 0) {
    const exponential = Math.exp(-Math.min(value, 40));
    return 1 / (1 + exponential);
  }
  const exponential = Math.exp(Math.max(value, -40));
  return exponential / (1 + exponential);
};

const parseArray = (value: string | null) => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
  } catch {
    return [];
  }
};

const toStoredModel = (row: StoredDirectionModelRow | null): StoredDirectionModel | null => row ? ({
  status: row.status,
  trainedAt: row.trained_at,
  horizonSeconds: row.horizon_seconds,
  snapshotCount: row.snapshot_count,
  exampleCount: row.example_count,
  marketCount: row.market_count,
  trainCount: row.train_count,
  testCount: row.test_count,
  positiveRate: row.positive_rate,
  baselineAccuracy: row.baseline_accuracy,
  accuracy: row.accuracy,
  balancedAccuracy: row.balanced_accuracy,
  precision: row.precision,
  recall: row.recall,
  auc: row.auc,
  logLoss: row.log_loss,
  threshold: row.threshold,
  featureNames: row.feature_names ? JSON.parse(row.feature_names) : [],
  means: parseArray(row.means),
  scales: parseArray(row.scales),
  weights: parseArray(row.weights),
  bias: row.bias,
  l2: row.l2,
  message: row.message,
}) : null;

const marketUpMidpoint = (row: SnapshotRow) => {
  const upMid = (row.up_bid + row.up_ask) / 2;
  const downMid = (row.down_bid + row.down_ask) / 2;
  const total = upMid + downMid;
  return total > 0 ? clampProbability(upMid / total) : 0.5;
};

const featuresForSnapshot = (row: SnapshotRow) => directionFeaturesFromValues({
  btcPrice: row.btc_price,
  strikePrice: row.strike_price,
  secondsLeft: row.seconds_left,
  variance: row.variance,
  rawProbability: row.raw_probability,
  marketUp: marketUpMidpoint(row),
  momentum15Bps: row.momentum_15_bps,
  momentum30Bps: row.momentum_30_bps,
  momentum60Bps: row.momentum_60_bps,
  upContractMove15: row.up_contract_move_15,
  downContractMove15: row.down_contract_move_15,
  upContractMove30: row.up_contract_move_30,
  downContractMove30: row.down_contract_move_30,
  spread: row.spread,
  topDepth: row.top_depth,
  choppiness60: row.choppiness_60,
  dataAgeMs: row.data_age_ms,
});

const makeExamples = (rows: SnapshotRow[]) => {
  const byMarket = new Map<string, SnapshotRow[]>();
  for (const row of rows) {
    if (!Number.isFinite(row.btc_price) || row.btc_price <= 0) continue;
    byMarket.set(row.market_slug, [...(byMarket.get(row.market_slug) ?? []), row]);
  }
  const examples: TrainingExample[] = [];
  for (const [marketSlug, marketRows] of byMarket) {
    marketRows.sort((left, right) => left.captured_at - right.captured_at);
    let lastExampleAt = -Infinity;
    let futureIndex = 1;
    for (let index = 0; index < marketRows.length; index += 1) {
      const row = marketRows[index];
      if (row.captured_at - lastExampleAt < MIN_SAMPLE_GAP_MS) continue;
      futureIndex = Math.max(futureIndex, index + 1);
      while (
        futureIndex < marketRows.length &&
        marketRows[futureIndex].captured_at - row.captured_at < MIN_FUTURE_MS
      ) futureIndex += 1;
      const future = marketRows[futureIndex];
      if (!future) break;
      const horizon = future.captured_at - row.captured_at;
      if (horizon > MAX_FUTURE_MS || future.btc_price === row.btc_price) continue;
      const features = featuresForSnapshot(row);
      if (features.some((value) => !Number.isFinite(value))) continue;
      examples.push({
        marketSlug,
        timestamp: row.captured_at,
        features,
        label: future.btc_price > row.btc_price ? 1 : 0,
      });
      lastExampleAt = row.captured_at;
    }
  }
  return examples.sort((left, right) => left.timestamp - right.timestamp);
};

const fitStandardizer = (examples: TrainingExample[]) => {
  const width = DIRECTION_FEATURE_NAMES.length;
  const means = Array(width).fill(0);
  for (const example of examples) {
    for (let index = 0; index < width; index += 1) means[index] += example.features[index];
  }
  means.forEach((value, index) => {
    means[index] = value / Math.max(1, examples.length);
  });
  const scales = Array(width).fill(0);
  for (const example of examples) {
    for (let index = 0; index < width; index += 1) {
      scales[index] += Math.pow(example.features[index] - means[index], 2);
    }
  }
  scales.forEach((value, index) => {
    scales[index] = Math.max(Math.sqrt(value / Math.max(1, examples.length)), 1e-6);
  });
  return { means, scales };
};

const standardize = (features: number[], means: number[], scales: number[]) =>
  features.map((value, index) => (value - means[index]) / scales[index]);

const fitLogistic = (
  examples: TrainingExample[],
  means: number[],
  scales: number[],
  l2: number,
  epochs: number
) => {
  const weights = Array(DIRECTION_FEATURE_NAMES.length).fill(0);
  const positiveRate = examples.reduce((sum, example) => sum + example.label, 0) / examples.length;
  const standardizedExamples = examples.map((example) => ({
    features: standardize(example.features, means, scales),
    label: example.label,
  }));
  let bias = Math.log(clampProbability(positiveRate) / (1 - clampProbability(positiveRate)));
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradient = Array(weights.length).fill(0);
    let biasGradient = 0;
    for (const example of standardizedExamples) {
      let score = bias;
      for (let index = 0; index < weights.length; index += 1) score += weights[index] * example.features[index];
      const error = sigmoid(score) - example.label;
      biasGradient += error;
      for (let index = 0; index < weights.length; index += 1) gradient[index] += error * example.features[index];
    }
    const learningRate = 0.12 / Math.sqrt(1 + epoch / 30);
    bias -= learningRate * biasGradient / examples.length;
    for (let index = 0; index < weights.length; index += 1) {
      weights[index] -= learningRate * (gradient[index] / examples.length + l2 * weights[index]);
    }
  }
  return { weights, bias };
};

const probabilitiesFor = (
  examples: TrainingExample[],
  means: number[],
  scales: number[],
  weights: number[],
  bias: number
) => examples.map((example) => {
  const standardized = standardize(example.features, means, scales);
  return sigmoid(standardized.reduce((score, value, index) => score + value * weights[index], bias));
});

const aucScore = (labels: number[], probabilities: number[]) => {
  const ranked = probabilities
    .map((probability, index) => ({ probability, label: labels[index] }))
    .sort((left, right) => left.probability - right.probability);
  const positives = labels.filter(Boolean).length;
  const negatives = labels.length - positives;
  if (!positives || !negatives) return 0.5;
  let rankSum = 0;
  let index = 0;
  while (index < ranked.length) {
    let end = index + 1;
    while (end < ranked.length && ranked[end].probability === ranked[index].probability) end += 1;
    const averageRank = (index + 1 + end) / 2;
    for (let tied = index; tied < end; tied += 1) {
      if (ranked[tied].label === 1) rankSum += averageRank;
    }
    index = end;
  }
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
};

const evaluate = (examples: TrainingExample[], probabilities: number[], threshold = 0.5): DirectionMetrics => {
  let truePositive = 0;
  let trueNegative = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let loss = 0;
  examples.forEach((example, index) => {
    const probability = clampProbability(probabilities[index]);
    const predicted = probability >= threshold ? 1 : 0;
    if (predicted === 1 && example.label === 1) truePositive += 1;
    else if (predicted === 0 && example.label === 0) trueNegative += 1;
    else if (predicted === 1) falsePositive += 1;
    else falseNegative += 1;
    loss -= example.label * Math.log(probability) + (1 - example.label) * Math.log(1 - probability);
  });
  const positiveRecall = truePositive / Math.max(1, truePositive + falseNegative);
  const negativeRecall = trueNegative / Math.max(1, trueNegative + falsePositive);
  return {
    accuracy: (truePositive + trueNegative) / Math.max(1, examples.length),
    balancedAccuracy: (positiveRecall + negativeRecall) / 2,
    precision: truePositive / Math.max(1, truePositive + falsePositive),
    recall: positiveRecall,
    auc: aucScore(examples.map((example) => example.label), probabilities),
    logLoss: loss / Math.max(1, examples.length),
    positiveRate: examples.reduce((sum, example) => sum + example.label, 0) / Math.max(1, examples.length),
  };
};

const marketSplit = (examples: TrainingExample[]) => {
  const markets = Array.from(new Set(examples.map((example) => example.marketSlug)));
  const testMarketCount = Math.max(1, Math.ceil(markets.length * 0.2));
  const validationMarketCount = Math.max(1, Math.ceil((markets.length - testMarketCount) * 0.2));
  const testMarkets = new Set(markets.slice(-testMarketCount));
  const validationMarkets = new Set(markets.slice(-(testMarketCount + validationMarketCount), -testMarketCount));
  const test = examples.filter((example) => testMarkets.has(example.marketSlug));
  const validation = examples.filter((example) => validationMarkets.has(example.marketSlug));
  const train = examples.filter((example) => !testMarkets.has(example.marketSlug) && !validationMarkets.has(example.marketSlug));
  return { train, validation, test, markets };
};

const upsertCollectingModel = async (
  snapshotCount: number,
  exampleCount: number,
  marketCount: number,
  message: string
) => {
  const now = Date.now();
  await db().prepare(`INSERT INTO direction_models
    (id, status, trained_at, horizon_seconds, snapshot_count, example_count, market_count,
     train_count, test_count, threshold, message)
    VALUES (1, 'COLLECTING', ?1, 10, ?2, ?3, ?4, 0, 0, 0.5, ?5)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      trained_at = excluded.trained_at,
      snapshot_count = excluded.snapshot_count,
      example_count = excluded.example_count,
      market_count = excluded.market_count,
      message = excluded.message`)
    .bind(now, snapshotCount, exampleCount, marketCount, message)
    .run();
};

export async function readDirectionModel() {
  const row = await db().prepare("SELECT * FROM direction_models WHERE id = 1")
    .first<StoredDirectionModelRow>();
  return toStoredModel(row);
}

export async function maybeTrainDirectionModel(force = false) {
  const d1 = db();
  const [current, snapshotCountRow] = await Promise.all([
    readDirectionModel(),
    d1.prepare("SELECT COUNT(*) AS count FROM model_snapshots").first<{ count: number }>(),
  ]);
  const snapshotCount = snapshotCountRow?.count ?? 0;
  const shouldTrain = force ||
    !current ||
    snapshotCount - current.snapshotCount >= RETRAIN_SNAPSHOT_GAP ||
    Date.now() - current.trainedAt >= RETRAIN_AFTER_MS;
  if (!shouldTrain) return current;

  const result = await d1.prepare(`SELECT
      market_slug, captured_at, btc_price, strike_price, seconds_left, variance,
      raw_probability, calibrated_probability, up_bid, up_ask, down_bid, down_ask,
      spread, top_depth, data_age_ms, momentum_15_bps, momentum_30_bps,
      momentum_60_bps, up_contract_move_15, down_contract_move_15,
      up_contract_move_30, down_contract_move_30, choppiness_60
    FROM model_snapshots
    ORDER BY captured_at DESC
    LIMIT ?1`).bind(MAX_SNAPSHOTS).all<SnapshotRow>();
  const rows = [...result.results].reverse();
  const examples = makeExamples(rows);
  const marketCount = new Set(examples.map((example) => example.marketSlug)).size;
  if (examples.length < MIN_EXAMPLES || marketCount < MIN_MARKETS) {
    const message = `Collecting data: ${examples.length}/${MIN_EXAMPLES} labeled examples across ${marketCount}/${MIN_MARKETS} markets.`;
    await upsertCollectingModel(snapshotCount, examples.length, marketCount, message);
    console.log("direction_model_training", JSON.stringify({
      status: "COLLECTING",
      snapshotCount,
      exampleCount: examples.length,
      marketCount,
      message,
    }));
    return readDirectionModel();
  }

  const { train, validation, test, markets } = marketSplit(examples);
  const trainStandardizer = fitStandardizer(train);
  const candidates = [0.005, 0.02, 0.08].map((l2) => {
    const fitted = fitLogistic(train, trainStandardizer.means, trainStandardizer.scales, l2, 140);
    const probabilities = probabilitiesFor(
      validation,
      trainStandardizer.means,
      trainStandardizer.scales,
      fitted.weights,
      fitted.bias
    );
    return { l2, metrics: evaluate(validation, probabilities) };
  }).sort((left, right) =>
    right.metrics.balancedAccuracy - left.metrics.balancedAccuracy ||
    left.metrics.logLoss - right.metrics.logLoss
  );
  const selectedL2 = candidates[0].l2;
  const development = [...train, ...validation].sort((left, right) => left.timestamp - right.timestamp);
  const standardizer = fitStandardizer(development);
  const fitted = fitLogistic(development, standardizer.means, standardizer.scales, selectedL2, 220);
  const testProbabilities = probabilitiesFor(
    test,
    standardizer.means,
    standardizer.scales,
    fitted.weights,
    fitted.bias
  );
  const metrics = evaluate(test, testProbabilities);
  const developmentPositiveRate = development.reduce((sum, example) => sum + example.label, 0) / development.length;
  const baselineLabel = developmentPositiveRate >= 0.5 ? 1 : 0;
  const baselineAccuracy = test.filter((example) => example.label === baselineLabel).length / test.length;
  const message = metrics.balancedAccuracy > 0.5
    ? "Trained on earlier markets and evaluated on later unseen markets."
    : "Model trained, but held-out balanced accuracy is not above chance; prediction remains research-only.";
  await d1.prepare(`INSERT INTO direction_models
    (id, status, trained_at, horizon_seconds, snapshot_count, example_count, market_count,
     train_count, test_count, positive_rate, baseline_accuracy, accuracy, balanced_accuracy,
     precision, recall, auc, log_loss, threshold, feature_names, means, scales, weights,
     bias, l2, message)
    VALUES (1, 'TRAINED', ?1, 10, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
      ?12, ?13, ?14, 0.5, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      trained_at = excluded.trained_at,
      snapshot_count = excluded.snapshot_count,
      example_count = excluded.example_count,
      market_count = excluded.market_count,
      train_count = excluded.train_count,
      test_count = excluded.test_count,
      positive_rate = excluded.positive_rate,
      baseline_accuracy = excluded.baseline_accuracy,
      accuracy = excluded.accuracy,
      balanced_accuracy = excluded.balanced_accuracy,
      precision = excluded.precision,
      recall = excluded.recall,
      auc = excluded.auc,
      log_loss = excluded.log_loss,
      feature_names = excluded.feature_names,
      means = excluded.means,
      scales = excluded.scales,
      weights = excluded.weights,
      bias = excluded.bias,
      l2 = excluded.l2,
      message = excluded.message`)
    .bind(
      Date.now(),
      snapshotCount,
      examples.length,
      markets.length,
      development.length,
      test.length,
      metrics.positiveRate,
      baselineAccuracy,
      metrics.accuracy,
      metrics.balancedAccuracy,
      metrics.precision,
      metrics.recall,
      metrics.auc,
      metrics.logLoss,
      JSON.stringify(DIRECTION_FEATURE_NAMES),
      JSON.stringify(standardizer.means),
      JSON.stringify(standardizer.scales),
      JSON.stringify(fitted.weights),
      fitted.bias,
      selectedL2,
      message
    )
    .run();
  console.log("direction_model_training", JSON.stringify({
    status: "TRAINED",
    snapshotCount,
    exampleCount: examples.length,
    marketCount: markets.length,
    trainCount: development.length,
    testCount: test.length,
    baselineAccuracy,
    ...metrics,
    l2: selectedL2,
  }));
  return readDirectionModel();
}
