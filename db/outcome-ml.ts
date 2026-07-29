import { env } from "cloudflare:workers";
import {
  OUTCOME_FEATURE_NAMES,
  type OutcomeBoostConfig,
  type OutcomeTree,
  type StoredOutcomeModel,
} from "../lib/outcome-model";
import {
  buildOutcomeExamples,
  chronologicalOutcomeSplit,
  type OutcomeSnapshot,
} from "../lib/outcome-training";
import {
  evaluateOutcomeProbabilities,
  fitOutcomeBoost,
  outcomeProbabilities,
} from "../lib/outcome-boosting";

const MAX_SNAPSHOTS = 8_000;
const MIN_EXAMPLES = 240;
const MIN_MARKETS = 12;
const RETRAIN_SNAPSHOT_GAP = 120;
const RETRAIN_MARKET_GAP = 4;
const RETRAIN_AFTER_MS = 30 * 60_000;
const OUTCOME_RESOLVE_BATCH = 8;

type StoredOutcomeModelRow = {
  status: "COLLECTING" | "TRAINED";
  trained_at: number;
  snapshot_count: number;
  example_count: number;
  market_count: number;
  train_count: number;
  test_count: number;
  positive_rate: number | null;
  log_loss: number | null;
  brier_score: number | null;
  accuracy: number | null;
  balanced_accuracy: number | null;
  auc: number | null;
  calibration_error: number | null;
  baseline_log_loss: number | null;
  baseline_brier_score: number | null;
  feature_names: string | null;
  trees: string | null;
  config: string | null;
  message: string;
};
type EligibleMarket = {
  marketSlug: string;
  startSeconds: number;
};
type ResolvedMarket = {
  marketSlug: string;
  outcome: "UP" | "DOWN";
  openPrice: number;
  closePrice: number;
};

const db = () => {
  if (!env.DB) throw new Error("The outcome-model database is unavailable.");
  return env.DB;
};

const parseJson = <T>(value: string | null, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const toStoredModel = (row: StoredOutcomeModelRow | null): StoredOutcomeModel | null => row ? ({
  status: row.status,
  trainedAt: row.trained_at,
  snapshotCount: row.snapshot_count,
  exampleCount: row.example_count,
  marketCount: row.market_count,
  trainCount: row.train_count,
  testCount: row.test_count,
  positiveRate: row.positive_rate,
  logLoss: row.log_loss,
  brierScore: row.brier_score,
  accuracy: row.accuracy,
  balancedAccuracy: row.balanced_accuracy,
  auc: row.auc,
  calibrationError: row.calibration_error,
  baselineLogLoss: row.baseline_log_loss,
  baselineBrierScore: row.baseline_brier_score,
  featureNames: parseJson(row.feature_names, []),
  trees: parseJson<OutcomeTree[]>(row.trees, []),
  config: parseJson<OutcomeBoostConfig | null>(row.config, null),
  message: row.message,
}) : null;

export async function readOutcomeModel() {
  const row = await db().prepare("SELECT * FROM outcome_models WHERE id = 1")
    .first<StoredOutcomeModelRow>();
  return toStoredModel(row);
}

const resolveCompletedMarketOutcomes = async () => {
  const d1 = db();
  const missing = await d1.prepare(`SELECT s.market_slug
    FROM model_snapshots s
    LEFT JOIN model_market_outcomes o ON o.market_slug = s.market_slug
    WHERE o.market_slug IS NULL
    GROUP BY s.market_slug
    ORDER BY MIN(s.captured_at)
    LIMIT 32`).all<{ market_slug: string }>();
  const now = Date.now();
  const eligible = (missing.results as { market_slug: string }[]).map((row): EligibleMarket => {
    const startSeconds = Number(row.market_slug.match(/(\d{10})$/)?.[1]);
    return { marketSlug: row.market_slug, startSeconds };
  }).filter((item: EligibleMarket) =>
    Number.isFinite(item.startSeconds) &&
    (item.startSeconds + 300) * 1_000 < now - 5_000
  ).slice(0, OUTCOME_RESOLVE_BATCH);
  if (!eligible.length) return;

  const resolved = await Promise.all(eligible.map(async ({ marketSlug, startSeconds }: EligibleMarket): Promise<ResolvedMarket | null> => {
    try {
      const priceUrl = new URL("https://polymarket.com/api/crypto/crypto-price");
      priceUrl.searchParams.set("symbol", "BTC");
      priceUrl.searchParams.set("eventStartTime", new Date(startSeconds * 1_000).toISOString());
      priceUrl.searchParams.set("variant", "fiveminute");
      const response = await fetch(priceUrl, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(6_000),
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as {
        openPrice?: number;
        closePrice?: number;
        completed?: boolean;
      };
      const openPrice = Number(payload.openPrice);
      const closePrice = Number(payload.closePrice);
      if (
        payload.completed !== true ||
        !Number.isFinite(openPrice) ||
        !Number.isFinite(closePrice) ||
        openPrice <= 0 ||
        closePrice <= 0
      ) return null;
      return {
        marketSlug,
        outcome: closePrice >= openPrice ? "UP" as const : "DOWN" as const,
        openPrice,
        closePrice,
      };
    } catch {
      return null;
    }
  }));
  const successful = resolved.filter((item: ResolvedMarket | null): item is ResolvedMarket => item !== null);
  if (!successful.length) return;
  await d1.batch(successful.map((item: ResolvedMarket) =>
    d1.prepare(`INSERT INTO model_market_outcomes
      (market_slug, outcome, open_price, close_price, resolved_at, source)
      VALUES (?1, ?2, ?3, ?4, ?5, 'POLYMARKET_CHAINLINK')
      ON CONFLICT(market_slug) DO UPDATE SET
        outcome = excluded.outcome,
        open_price = excluded.open_price,
        close_price = excluded.close_price,
        resolved_at = excluded.resolved_at,
        source = excluded.source`)
      .bind(item.marketSlug, item.outcome, item.openPrice, item.closePrice, Date.now())
  ));
};

const readOutcomeSnapshots = async () => {
  const result = await db().prepare(`SELECT
      s.market_slug, s.captured_at, s.btc_price, s.strike_price, s.seconds_left,
      s.variance, s.raw_probability, s.up_bid, s.up_ask, s.down_bid, s.down_ask,
      s.up_ask_size, s.up_bid_size, s.down_ask_size, s.down_bid_size,
      s.data_age_ms, s.momentum_15_bps, s.momentum_30_bps, s.momentum_60_bps,
      s.up_contract_move_15, s.down_contract_move_15, s.up_contract_move_30,
      s.down_contract_move_30, s.choppiness_60, o.outcome
    FROM model_snapshots s
    INNER JOIN model_market_outcomes o ON o.market_slug = s.market_slug
    ORDER BY s.captured_at DESC
    LIMIT ?1`).bind(MAX_SNAPSHOTS).all<OutcomeSnapshot>();
  return [...result.results].reverse();
};

export async function readOutcomeTrainingDataset() {
  const snapshots = await readOutcomeSnapshots();
  return {
    featureNames: [...OUTCOME_FEATURE_NAMES],
    snapshotCount: snapshots.length,
    examples: buildOutcomeExamples(snapshots),
  };
}

const upsertCollectingModel = async (
  snapshotCount: number,
  exampleCount: number,
  marketCount: number,
  message: string
) => {
  await db().prepare(`INSERT INTO outcome_models
    (id, status, trained_at, snapshot_count, example_count, market_count,
     train_count, test_count, message)
    VALUES (1, 'COLLECTING', ?1, ?2, ?3, ?4, 0, 0, ?5)
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

export async function maybeTrainOutcomeModel(force = false) {
  const d1 = db();
  await resolveCompletedMarketOutcomes();
  const [current, snapshotCountRow, marketCountRow] = await Promise.all([
    readOutcomeModel(),
    d1.prepare("SELECT COUNT(*) AS count FROM model_snapshots").first<{ count: number }>(),
    d1.prepare("SELECT COUNT(*) AS count FROM model_market_outcomes").first<{ count: number }>(),
  ]);
  const snapshotCount = snapshotCountRow?.count ?? 0;
  const labeledMarketCount = marketCountRow?.count ?? 0;
  const shouldTrain = force ||
    !current ||
    current.status === "COLLECTING" ||
    snapshotCount < current.snapshotCount ||
    snapshotCount - current.snapshotCount >= RETRAIN_SNAPSHOT_GAP ||
    labeledMarketCount - current.marketCount >= RETRAIN_MARKET_GAP ||
    Date.now() - current.trainedAt >= RETRAIN_AFTER_MS;
  if (!shouldTrain) return current;

  const rows = await readOutcomeSnapshots();
  const examples = buildOutcomeExamples(rows);
  const marketCount = new Set(examples.map((example) => example.marketSlug)).size;
  if (examples.length < MIN_EXAMPLES || marketCount < MIN_MARKETS) {
    const message = `Collecting settled markets: ${examples.length}/${MIN_EXAMPLES} snapshots across ${marketCount}/${MIN_MARKETS} outcomes.`;
    await upsertCollectingModel(snapshotCount, examples.length, marketCount, message);
    return readOutcomeModel();
  }

  const { train, validation, test, markets } = chronologicalOutcomeSplit(examples);
  const configs = [
    { treeCount: 80, learningRate: 0.04, minLeaf: 20, l2: 6, bins: 16 },
    { treeCount: 120, learningRate: 0.03, minLeaf: 16, l2: 8, bins: 20 },
    { treeCount: 160, learningRate: 0.022, minLeaf: 14, l2: 10, bins: 24 },
  ];
  const candidates = configs.flatMap((config) => {
    const fitted = fitOutcomeBoost(train, config);
    return [0, 0.25, 0.5, 0.75, 1].map((correctionScale) => {
      const probabilities = outcomeProbabilities(validation, fitted, correctionScale);
      return {
        config: { ...config, correctionScale },
        metrics: evaluateOutcomeProbabilities(validation, probabilities),
      };
    });
  }).sort((left, right) =>
    left.metrics.logLoss - right.metrics.logLoss ||
    left.metrics.brierScore - right.metrics.brierScore
  );
  const selectedConfig = candidates[0].config;
  const development = [...train, ...validation].sort((left, right) => left.timestamp - right.timestamp);
  const fitted = fitOutcomeBoost(development, selectedConfig);
  fitted.config.correctionScale = selectedConfig.correctionScale;
  const testProbabilities = outcomeProbabilities(test, fitted);
  const metrics = evaluateOutcomeProbabilities(test, testProbabilities);
  const baselineMetrics = evaluateOutcomeProbabilities(
    test,
    test.map((example) => example.marketProbability)
  );
  const message = metrics.logLoss < baselineMetrics.logLoss
    ? "Outcome model beats the raw CLOB probability on later unseen markets."
    : "Outcome model is trained, but the raw CLOB probability remains the stronger unseen-market baseline.";
  await d1.prepare(`INSERT INTO outcome_models
    (id, status, trained_at, snapshot_count, example_count, market_count,
     train_count, test_count, positive_rate, log_loss, brier_score, accuracy,
     balanced_accuracy, auc, calibration_error, baseline_log_loss,
     baseline_brier_score, feature_names, trees, config, message)
    VALUES (1, 'TRAINED', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
      ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      trained_at = excluded.trained_at,
      snapshot_count = excluded.snapshot_count,
      example_count = excluded.example_count,
      market_count = excluded.market_count,
      train_count = excluded.train_count,
      test_count = excluded.test_count,
      positive_rate = excluded.positive_rate,
      log_loss = excluded.log_loss,
      brier_score = excluded.brier_score,
      accuracy = excluded.accuracy,
      balanced_accuracy = excluded.balanced_accuracy,
      auc = excluded.auc,
      calibration_error = excluded.calibration_error,
      baseline_log_loss = excluded.baseline_log_loss,
      baseline_brier_score = excluded.baseline_brier_score,
      feature_names = excluded.feature_names,
      trees = excluded.trees,
      config = excluded.config,
      message = excluded.message`)
    .bind(
      Date.now(),
      snapshotCount,
      examples.length,
      markets.length,
      development.length,
      test.length,
      metrics.positiveRate,
      metrics.logLoss,
      metrics.brierScore,
      metrics.accuracy,
      metrics.balancedAccuracy,
      metrics.auc,
      metrics.calibrationError,
      baselineMetrics.logLoss,
      baselineMetrics.brierScore,
      JSON.stringify(OUTCOME_FEATURE_NAMES),
      JSON.stringify(fitted.trees),
      JSON.stringify(fitted.config),
      message
    )
    .run();
  return readOutcomeModel();
}
