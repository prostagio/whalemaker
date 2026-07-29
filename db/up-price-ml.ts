import { env } from "cloudflare:workers";
import {
  UP_PRICE_FEATURE_NAMES,
  type StoredUpPriceModel,
} from "../lib/up-price-model";
import {
  buildUpPriceExamples,
  chronologicalUpPriceSplit,
  type UpPriceSnapshot,
} from "../lib/up-price-training";
import {
  evaluateUpPricePredictions,
  fitUpPriceRegression,
  upPriceDeltaPredictions,
} from "../lib/up-price-regression";

const MAX_SNAPSHOTS = 8_000;
const MIN_EXAMPLES = 160;
const MIN_MARKETS = 8;
const RETRAIN_SNAPSHOT_GAP = 120;
const RETRAIN_AFTER_MS = 30 * 60_000;

type StoredUpPriceModelRow = {
  status: "COLLECTING" | "TRAINED";
  trained_at: number;
  horizon_seconds: number;
  snapshot_count: number;
  example_count: number;
  market_count: number;
  train_count: number;
  test_count: number;
  mae_cents: number | null;
  rmse_cents: number | null;
  baseline_mae_cents: number | null;
  direction_accuracy: number | null;
  r_squared: number | null;
  feature_names: string | null;
  means: string | null;
  scales: string | null;
  weights: string | null;
  bias: number | null;
  l2: number | null;
  message: string;
};

const db = () => {
  if (!env.DB) throw new Error("The UP-price model database is unavailable.");
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

const toStoredModel = (row: StoredUpPriceModelRow | null): StoredUpPriceModel | null => row ? ({
  status: row.status,
  trainedAt: row.trained_at,
  horizonSeconds: row.horizon_seconds,
  snapshotCount: row.snapshot_count,
  exampleCount: row.example_count,
  marketCount: row.market_count,
  trainCount: row.train_count,
  testCount: row.test_count,
  maeCents: row.mae_cents,
  rmseCents: row.rmse_cents,
  baselineMaeCents: row.baseline_mae_cents,
  directionAccuracy: row.direction_accuracy,
  rSquared: row.r_squared,
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
  await db().prepare(`INSERT INTO up_price_models
    (id, status, trained_at, horizon_seconds, snapshot_count, example_count, market_count,
     train_count, test_count, message)
    VALUES (1, 'COLLECTING', ?1, 10, ?2, ?3, ?4, 0, 0, ?5)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      trained_at = excluded.trained_at,
      snapshot_count = excluded.snapshot_count,
      example_count = excluded.example_count,
      market_count = excluded.market_count,
      message = excluded.message`)
    .bind(Date.now(), snapshotCount, exampleCount, marketCount, message)
    .run();
};

export async function readUpPriceModel() {
  const row = await db().prepare("SELECT * FROM up_price_models WHERE id = 1")
    .first<StoredUpPriceModelRow>();
  return toStoredModel(row);
}

const readUpPriceSnapshots = async () => {
  const result = await db().prepare(`SELECT
      market_slug, captured_at, btc_price, strike_price, seconds_left, variance,
      raw_probability, calibrated_probability, up_bid, up_ask, down_bid, down_ask,
      spread, top_depth, data_age_ms, momentum_15_bps, momentum_30_bps,
      momentum_60_bps, up_contract_move_15, down_contract_move_15,
      up_contract_move_30, down_contract_move_30, choppiness_60
    FROM model_snapshots
    ORDER BY captured_at DESC
    LIMIT ?1`).bind(MAX_SNAPSHOTS).all<UpPriceSnapshot>();
  return [...result.results].reverse();
};

export async function readUpPriceTrainingDataset() {
  const snapshots = await readUpPriceSnapshots();
  return {
    featureNames: [...UP_PRICE_FEATURE_NAMES],
    horizonSeconds: 10,
    snapshotCount: snapshots.length,
    examples: buildUpPriceExamples(snapshots),
  };
}

export async function maybeTrainUpPriceModel(force = false) {
  const d1 = db();
  const [current, snapshotCountRow] = await Promise.all([
    readUpPriceModel(),
    d1.prepare("SELECT COUNT(*) AS count FROM model_snapshots").first<{ count: number }>(),
  ]);
  const snapshotCount = snapshotCountRow?.count ?? 0;
  const shouldTrain = force ||
    !current ||
    snapshotCount < current.snapshotCount ||
    snapshotCount - current.snapshotCount >= RETRAIN_SNAPSHOT_GAP ||
    Date.now() - current.trainedAt >= RETRAIN_AFTER_MS;
  if (!shouldTrain) return current;

  const rows = await readUpPriceSnapshots();
  const examples = buildUpPriceExamples(rows);
  const marketCount = new Set(examples.map((example) => example.marketSlug)).size;
  if (examples.length < MIN_EXAMPLES || marketCount < MIN_MARKETS) {
    const message = `Collecting data: ${examples.length}/${MIN_EXAMPLES} labeled prices across ${marketCount}/${MIN_MARKETS} markets.`;
    await upsertCollectingModel(snapshotCount, examples.length, marketCount, message);
    return readUpPriceModel();
  }

  const { train, validation, test, markets } = chronologicalUpPriceSplit(examples);
  const candidates = [0.005, 0.02, 0.08].map((l2) => {
    const fitted = fitUpPriceRegression(train, l2, 220);
    const predictions = upPriceDeltaPredictions(validation, fitted);
    return { l2, metrics: evaluateUpPricePredictions(validation, predictions) };
  }).sort((left, right) =>
    left.metrics.maeCents - right.metrics.maeCents ||
    left.metrics.rmseCents - right.metrics.rmseCents
  );
  const selectedL2 = candidates[0].l2;
  const development = [...train, ...validation].sort((left, right) => left.timestamp - right.timestamp);
  const fitted = fitUpPriceRegression(development, selectedL2, 320);
  const testPredictions = upPriceDeltaPredictions(test, fitted);
  const metrics = evaluateUpPricePredictions(test, testPredictions);
  const message = metrics.maeCents < metrics.baselineMaeCents
    ? "The price model beats a no-change forecast on later unseen markets."
    : "The model is trained, but does not yet beat a no-change forecast on later unseen markets.";
  await d1.prepare(`INSERT INTO up_price_models
    (id, status, trained_at, horizon_seconds, snapshot_count, example_count, market_count,
     train_count, test_count, mae_cents, rmse_cents, baseline_mae_cents,
     direction_accuracy, r_squared, feature_names, means, scales, weights, bias, l2, message)
    VALUES (1, 'TRAINED', ?1, 10, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
      ?12, ?13, ?14, ?15, ?16, ?17, ?18)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      trained_at = excluded.trained_at,
      snapshot_count = excluded.snapshot_count,
      example_count = excluded.example_count,
      market_count = excluded.market_count,
      train_count = excluded.train_count,
      test_count = excluded.test_count,
      mae_cents = excluded.mae_cents,
      rmse_cents = excluded.rmse_cents,
      baseline_mae_cents = excluded.baseline_mae_cents,
      direction_accuracy = excluded.direction_accuracy,
      r_squared = excluded.r_squared,
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
      metrics.maeCents,
      metrics.rmseCents,
      metrics.baselineMaeCents,
      metrics.directionAccuracy,
      metrics.rSquared,
      JSON.stringify(UP_PRICE_FEATURE_NAMES),
      JSON.stringify(fitted.means),
      JSON.stringify(fitted.scales),
      JSON.stringify(fitted.weights),
      fitted.bias,
      selectedL2,
      message
    )
    .run();
  return readUpPriceModel();
}
