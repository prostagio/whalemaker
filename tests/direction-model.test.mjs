import assert from "node:assert/strict";
import test from "node:test";
import {
  DIRECTION_FEATURE_NAMES,
  directionFeaturesFromValues,
  predictDirectionProbability,
} from "../lib/direction-model.ts";
import {
  buildDirectionExamples,
  chronologicalMarketSplit,
} from "../lib/direction-training.ts";
import {
  directionProbabilities,
  evaluateDirectionProbabilities,
  fitDirectionLogistic,
} from "../lib/direction-logistic.ts";

const snapshot = (market, timestamp, price) => ({
  market_slug: market,
  captured_at: timestamp,
  btc_price: price,
  strike_price: 100_000,
  seconds_left: 200 - timestamp / 1_000,
  variance: 2.5e-9,
  raw_probability: 0.52,
  calibrated_probability: 0.53,
  up_bid: 0.51,
  up_ask: 0.53,
  down_bid: 0.47,
  down_ask: 0.49,
  spread: 0.02,
  top_depth: 25,
  data_age_ms: 150,
  momentum_15_bps: 1,
  momentum_30_bps: 0.5,
  momentum_60_bps: -0.2,
  up_contract_move_15: 0.02,
  down_contract_move_15: -0.02,
  up_contract_move_30: 0.03,
  down_contract_move_30: -0.03,
  choppiness_60: 0.3,
});

test("builds same-market ten-second labels without overlapping candidates", () => {
  const rows = [
    snapshot("market-a", 0, 100_000),
    snapshot("market-a", 5_000, 100_001),
    snapshot("market-a", 10_000, 100_010),
    snapshot("market-a", 15_000, 100_005),
    snapshot("market-a", 20_000, 99_990),
    snapshot("market-b", 0, 100_000),
    snapshot("market-b", 10_000, 99_995),
  ];
  const examples = buildDirectionExamples(rows);
  assert.deepEqual(
    examples.map(({ marketSlug, timestamp, label }) => ({ marketSlug, timestamp, label })),
    [
      { marketSlug: "market-a", timestamp: 0, label: 1 },
      { marketSlug: "market-b", timestamp: 0, label: 0 },
      { marketSlug: "market-a", timestamp: 10_000, label: 0 },
    ]
  );
  assert.ok(examples.every((example) => example.features.length === DIRECTION_FEATURE_NAMES.length));
});

test("keeps every market in exactly one chronological split", () => {
  const examples = Array.from({ length: 10 }, (_, index) => ({
    marketSlug: `market-${index}`,
    timestamp: index * 300_000,
    features: Array(DIRECTION_FEATURE_NAMES.length).fill(index),
    label: index % 2,
  }));
  const split = chronologicalMarketSplit(examples);
  const trainMarkets = new Set(split.train.map((example) => example.marketSlug));
  const validationMarkets = new Set(split.validation.map((example) => example.marketSlug));
  const testMarkets = new Set(split.test.map((example) => example.marketSlug));
  assert.equal([...trainMarkets].some((market) => validationMarkets.has(market) || testMarkets.has(market)), false);
  assert.equal([...validationMarkets].some((market) => testMarkets.has(market)), false);
  assert.deepEqual([...testMarkets], ["market-8", "market-9"]);
});

test("uses the same finite feature vector for live inference", () => {
  const features = directionFeaturesFromValues({
    btcPrice: 100_020,
    strikePrice: 100_000,
    secondsLeft: 150,
    variance: 2.5e-9,
    rawProbability: 0.54,
    marketUp: 0.52,
    momentum15Bps: 1.2,
    momentum30Bps: 0.8,
    momentum60Bps: 0.3,
    upContractMove15: 0.02,
    downContractMove15: -0.02,
    upContractMove30: 0.04,
    downContractMove30: -0.04,
    spread: 0.02,
    topDepth: 25,
    choppiness60: 0.3,
    dataAgeMs: 150,
  });
  assert.equal(features.length, DIRECTION_FEATURE_NAMES.length);
  assert.ok(features.every(Number.isFinite));
  const model = {
    status: "TRAINED",
    trainedAt: Date.now(),
    horizonSeconds: 10,
    snapshotCount: 1_000,
    exampleCount: 400,
    marketCount: 20,
    trainCount: 300,
    testCount: 100,
    positiveRate: 0.5,
    baselineAccuracy: 0.5,
    accuracy: 0.55,
    balancedAccuracy: 0.55,
    precision: 0.55,
    recall: 0.55,
    auc: 0.57,
    logLoss: 0.68,
    threshold: 0.5,
    featureNames: [...DIRECTION_FEATURE_NAMES],
    means: Array(features.length).fill(0),
    scales: Array(features.length).fill(1),
    weights: Array(features.length).fill(0),
    bias: 0,
    l2: 0.02,
    message: "test",
  };
  assert.equal(predictDirectionProbability(model, features), 0.5);
  assert.equal(predictDirectionProbability(model, [...features.slice(0, -1), Number.POSITIVE_INFINITY]), null);
});

test("fits a regularized classifier that learns a known directional signal", () => {
  const examples = Array.from({ length: 120 }, (_, index) => {
    const signal = (index % 20) - 9.5;
    return {
      marketSlug: `market-${Math.floor(index / 20)}`,
      timestamp: index * 10_000,
      features: [signal, ...Array(DIRECTION_FEATURE_NAMES.length - 1).fill(0)],
      label: signal > 0 ? 1 : 0,
    };
  });
  const training = examples.slice(0, 80);
  const testing = examples.slice(80);
  const fitted = fitDirectionLogistic(training, 0.02, 220);
  const metrics = evaluateDirectionProbabilities(testing, directionProbabilities(testing, fitted));
  assert.ok(metrics.accuracy > 0.95);
  assert.ok(metrics.auc > 0.99);
  assert.ok(metrics.logLoss < 0.25);
});
