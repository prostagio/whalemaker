import { env } from "cloudflare:workers";
import {
  DIRECTION_FEATURE_NAMES,
  type StoredDirectionModel,
} from "../lib/direction-model";
import {
  buildDirectionExamples,
  chronologicalMarketSplit,
  type DirectionSnapshot,
} from "../lib/direction-training";
import {
  directionProbabilities,
  evaluateDirectionProbabilities,
  fitDirectionLogistic,
} from "../lib/direction-logistic";

const MAX_SNAPSHOTS = 8_000;
const MIN_EXAMPLES = 160;
const MIN_MARKETS = 8;
const RETRAIN_SNAPSHOT_GAP = 120;
const RETRAIN_AFTER_MS = 30 * 60_000;

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

const readDirectionSnapshots = async () => {
  const result = await db().prepare(`SELECT
      market_slug, captured_at, btc_price, strike_price, seconds_left, variance,
      raw_probability, calibrated_probability, up_bid, up_ask, down_bid, down_ask,
      spread, top_depth, data_age_ms, momentum_15_bps, momentum_30_bps,
      momentum_60_bps, up_contract_move_15, down_contract_move_15,
      up_contract_move_30, down_contract_move_30, choppiness_60
    FROM model_snapshots
    ORDER BY captured_at DESC
    LIMIT ?1`).bind(MAX_SNAPSHOTS).all<DirectionSnapshot>();
  return [...result.results].reverse();
};

export async function readDirectionTrainingDataset() {
  const snapshots = await readDirectionSnapshots();
  return {
    featureNames: [...DIRECTION_FEATURE_NAMES],
    horizonSeconds: 10,
    snapshotCount: snapshots.length,
    examples: buildDirectionExamples(snapshots),
  };
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

  const rows = await readDirectionSnapshots();
  const examples = buildDirectionExamples(rows);
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

  const { train, validation, test, markets } = chronologicalMarketSplit(examples);
  const candidates = [0.005, 0.02, 0.08].map((l2) => {
    const fitted = fitDirectionLogistic(train, l2, 140);
    const probabilities = directionProbabilities(validation, fitted);
    return { l2, metrics: evaluateDirectionProbabilities(validation, probabilities) };
  }).sort((left, right) =>
    right.metrics.balancedAccuracy - left.metrics.balancedAccuracy ||
    left.metrics.logLoss - right.metrics.logLoss
  );
  const selectedL2 = candidates[0].l2;
  const development = [...train, ...validation].sort((left, right) => left.timestamp - right.timestamp);
  const fitted = fitDirectionLogistic(development, selectedL2, 220);
  const testProbabilities = directionProbabilities(test, fitted);
  const metrics = evaluateDirectionProbabilities(test, testProbabilities);
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
      JSON.stringify(fitted.means),
      JSON.stringify(fitted.scales),
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
