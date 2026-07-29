import assert from "node:assert/strict";
import test from "node:test";
import {
  OUTCOME_FEATURE_NAMES,
  outcomeFeaturesFromValues,
  predictOutcomeProbability,
} from "../lib/outcome-model.ts";
import {
  buildOutcomeExamples,
  chronologicalOutcomeSplit,
} from "../lib/outcome-training.ts";
import {
  evaluateOutcomeProbabilities,
  fitOutcomeBoost,
  outcomeProbabilities,
} from "../lib/outcome-boosting.ts";

const snapshot = (market, timestamp, outcome) => ({
  market_slug: market,
  captured_at: timestamp,
  btc_price: 100_000 + timestamp / 1_000,
  strike_price: 100_000,
  seconds_left: 240 - timestamp / 1_000,
  variance: 2.5e-9,
  raw_probability: 0.52,
  up_bid: 0.49,
  up_ask: 0.51,
  down_bid: 0.49,
  down_ask: 0.51,
  up_ask_size: 20,
  up_bid_size: 30,
  down_ask_size: 25,
  down_bid_size: 20,
  data_age_ms: 150,
  momentum_15_bps: 1,
  momentum_30_bps: 0.5,
  momentum_60_bps: -0.2,
  up_contract_move_15: 0.02,
  down_contract_move_15: -0.02,
  up_contract_move_30: 0.03,
  down_contract_move_30: -0.03,
  choppiness_60: 0.3,
  outcome,
});

test("builds settlement labels without crossing markets", () => {
  const examples = buildOutcomeExamples([
    snapshot("market-a", 0, "UP"),
    snapshot("market-a", 5_000, "UP"),
    snapshot("market-a", 10_000, "UP"),
    snapshot("market-b", 0, "DOWN"),
    snapshot("market-b", 10_000, "DOWN"),
  ]);
  assert.deepEqual(
    examples.map(({ marketSlug, timestamp, label }) => ({ marketSlug, timestamp, label })),
    [
      { marketSlug: "market-a", timestamp: 0, label: 1 },
      { marketSlug: "market-b", timestamp: 0, label: 0 },
      { marketSlug: "market-a", timestamp: 10_000, label: 1 },
      { marketSlug: "market-b", timestamp: 10_000, label: 0 },
    ]
  );
  assert.ok(examples.every((example) => example.features.length === OUTCOME_FEATURE_NAMES.length));
});

test("keeps every settled market in one chronological split", () => {
  const examples = Array.from({ length: 10 }, (_, index) => ({
    marketSlug: `market-${index}`,
    timestamp: index * 300_000,
    features: Array(OUTCOME_FEATURE_NAMES.length).fill(index),
    marketProbability: 0.5,
    label: index % 2,
  }));
  const split = chronologicalOutcomeSplit(examples);
  const trainMarkets = new Set(split.train.map((example) => example.marketSlug));
  const validationMarkets = new Set(split.validation.map((example) => example.marketSlug));
  const testMarkets = new Set(split.test.map((example) => example.marketSlug));
  assert.equal([...trainMarkets].some((market) => validationMarkets.has(market) || testMarkets.has(market)), false);
  assert.equal([...validationMarkets].some((market) => testMarkets.has(market)), false);
  assert.deepEqual([...testMarkets], ["market-8", "market-9"]);
});

test("creates the same finite feature vector for live outcome inference", () => {
  const features = outcomeFeaturesFromValues({
    btcPrice: 100_020,
    strikePrice: 100_000,
    secondsLeft: 150,
    variance: 2.5e-9,
    rawProbability: 0.54,
    marketUp: 0.52,
    upBid: 0.51,
    upAsk: 0.53,
    downBid: 0.47,
    downAsk: 0.49,
    upAskSize: 20,
    upBidSize: 30,
    downAskSize: 25,
    downBidSize: 20,
    momentum15Bps: 1.2,
    momentum30Bps: 0.8,
    momentum60Bps: 0.3,
    upContractMove15: 0.02,
    downContractMove15: -0.02,
    upContractMove30: 0.04,
    downContractMove30: -0.04,
    choppiness60: 0.3,
    dataAgeMs: 150,
  });
  assert.equal(features.length, OUTCOME_FEATURE_NAMES.length);
  assert.ok(features.every(Number.isFinite));
  const model = {
    status: "TRAINED",
    trainedAt: Date.now(),
    snapshotCount: 1_000,
    exampleCount: 500,
    marketCount: 20,
    trainCount: 400,
    testCount: 100,
    positiveRate: 0.5,
    logLoss: 0.6,
    brierScore: 0.2,
    accuracy: 0.6,
    balancedAccuracy: 0.6,
    auc: 0.65,
    calibrationError: 0.05,
    baselineLogLoss: 0.65,
    baselineBrierScore: 0.22,
    featureNames: [...OUTCOME_FEATURE_NAMES],
    trees: [],
    config: {
      treeCount: 80,
      learningRate: 0.04,
      minLeaf: 20,
      l2: 6,
      bins: 16,
      correctionScale: 1,
    },
    message: "test",
  };
  assert.ok(Math.abs(predictOutcomeProbability(model, features, 0.52) - 0.52) < 1e-12);
  assert.equal(predictOutcomeProbability(model, [...features.slice(0, -1), Number.NaN], 0.52), null);
});

test("gradient boosting learns a nonlinear settlement signal", () => {
  const examples = Array.from({ length: 240 }, (_, index) => {
    const signal = (index % 24) - 11.5;
    const label = Math.abs(signal) > 5 ? 1 : 0;
    return {
      marketSlug: `market-${Math.floor(index / 24)}`,
      timestamp: index * 10_000,
      features: [signal, ...Array(OUTCOME_FEATURE_NAMES.length - 1).fill(0)],
      marketProbability: 0.5,
      label,
    };
  });
  const training = examples.slice(0, 168);
  const testing = examples.slice(168);
  const fitted = fitOutcomeBoost(training, {
    treeCount: 80,
    learningRate: 0.06,
    minLeaf: 8,
    l2: 2,
    bins: 24,
  });
  const probabilities = outcomeProbabilities(testing, fitted);
  const metrics = evaluateOutcomeProbabilities(testing, probabilities);
  assert.ok(metrics.accuracy > 0.9);
  assert.ok(metrics.auc > 0.98);
  assert.ok(metrics.logLoss < 0.3);
  assert.deepEqual(outcomeProbabilities(testing, fitted, 0), testing.map(() => 0.5));
});
