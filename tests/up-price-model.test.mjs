import assert from "node:assert/strict";
import test from "node:test";
import {
  UP_PRICE_FEATURE_NAMES,
  predictUpPrice,
  upPriceFeaturesFromValues,
} from "../lib/up-price-model.ts";
import {
  buildUpPriceExamples,
  chronologicalUpPriceSplit,
} from "../lib/up-price-training.ts";
import {
  evaluateUpPricePredictions,
  fitUpPriceRegression,
  upPriceDeltaPredictions,
} from "../lib/up-price-regression.ts";

const snapshot = (market, timestamp, upAsk) => ({
  market_slug: market,
  captured_at: timestamp,
  btc_price: 100_000 + timestamp / 1_000,
  strike_price: 100_000,
  seconds_left: 200 - timestamp / 1_000,
  variance: 2.5e-9,
  raw_probability: 0.52,
  calibrated_probability: 0.53,
  up_bid: upAsk - 0.02,
  up_ask: upAsk,
  down_bid: 0.96 - upAsk,
  down_ask: 0.98 - upAsk,
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

test("builds same-market ten-second UP-price targets", () => {
  const examples = buildUpPriceExamples([
    snapshot("market-a", 0, 0.50),
    snapshot("market-a", 5_000, 0.51),
    snapshot("market-a", 10_000, 0.54),
    snapshot("market-a", 20_000, 0.49),
    snapshot("market-b", 0, 0.60),
    snapshot("market-b", 10_000, 0.58),
  ]);
  assert.deepEqual(
    examples.map(({ marketSlug, timestamp, targetDeltaCents }) => ({
      marketSlug,
      timestamp,
      targetDeltaCents: Number(targetDeltaCents.toFixed(6)),
    })),
    [
      { marketSlug: "market-a", timestamp: 0, targetDeltaCents: 4 },
      { marketSlug: "market-b", timestamp: 0, targetDeltaCents: -2 },
      { marketSlug: "market-a", timestamp: 10_000, targetDeltaCents: -5 },
    ]
  );
  assert.ok(examples.every((example) => example.features.length === UP_PRICE_FEATURE_NAMES.length));
});

test("keeps price examples from each market in one chronological split", () => {
  const examples = Array.from({ length: 10 }, (_, index) => ({
    marketSlug: `market-${index}`,
    timestamp: index * 300_000,
    features: Array(UP_PRICE_FEATURE_NAMES.length).fill(index),
    currentUpAsk: 0.5,
    futureUpAsk: 0.5,
    targetDeltaCents: 0,
  }));
  const split = chronologicalUpPriceSplit(examples);
  const trainMarkets = new Set(split.train.map((example) => example.marketSlug));
  const validationMarkets = new Set(split.validation.map((example) => example.marketSlug));
  const testMarkets = new Set(split.test.map((example) => example.marketSlug));
  assert.equal([...trainMarkets].some((market) => validationMarkets.has(market) || testMarkets.has(market)), false);
  assert.equal([...validationMarkets].some((market) => testMarkets.has(market)), false);
  assert.deepEqual([...testMarkets], ["market-8", "market-9"]);
});

test("uses the same finite price feature vector for live inference", () => {
  const features = upPriceFeaturesFromValues({
    btcPrice: 100_020,
    strikePrice: 100_000,
    secondsLeft: 150,
    variance: 2.5e-9,
    rawProbability: 0.54,
    marketUp: 0.52,
    upBid: 0.51,
    upAsk: 0.53,
    downAsk: 0.49,
    momentum15Bps: 1.2,
    momentum30Bps: 0.8,
    momentum60Bps: 0.3,
    upContractMove15: 0.02,
    downContractMove15: -0.02,
    upContractMove30: 0.04,
    downContractMove30: -0.04,
    topDepth: 25,
    choppiness60: 0.3,
    dataAgeMs: 150,
  });
  const model = {
    status: "TRAINED",
    trainedAt: Date.now(),
    horizonSeconds: 10,
    snapshotCount: 1_000,
    exampleCount: 400,
    marketCount: 20,
    trainCount: 300,
    testCount: 100,
    maeCents: 2,
    rmseCents: 3,
    baselineMaeCents: 2.5,
    directionAccuracy: 0.55,
    rSquared: 0.1,
    featureNames: [...UP_PRICE_FEATURE_NAMES],
    means: Array(features.length).fill(0),
    scales: Array(features.length).fill(1),
    weights: Array(features.length).fill(0),
    bias: 2,
    l2: 0.02,
    message: "test",
  };
  assert.equal(features.length, UP_PRICE_FEATURE_NAMES.length);
  assert.ok(features.every(Number.isFinite));
  const forecast = predictUpPrice(model, features, 0.53);
  assert.ok(forecast);
  assert.ok(Math.abs(forecast.price - 0.55) < 1e-12);
  assert.ok(Math.abs(forecast.deltaCents - 2) < 1e-12);
  assert.equal(predictUpPrice(model, [...features.slice(0, -1), Number.POSITIVE_INFINITY], 0.53), null);
});

test("fits a regularized price model that learns a known delta", () => {
  const examples = Array.from({ length: 120 }, (_, index) => {
    const signal = (index % 20) - 9.5;
    const targetDeltaCents = signal * 0.4;
    return {
      marketSlug: `market-${Math.floor(index / 20)}`,
      timestamp: index * 10_000,
      features: [signal, ...Array(UP_PRICE_FEATURE_NAMES.length - 1).fill(0)],
      currentUpAsk: 0.5,
      futureUpAsk: 0.5 + targetDeltaCents / 100,
      targetDeltaCents,
    };
  });
  const training = examples.slice(0, 80);
  const testing = examples.slice(80);
  const fitted = fitUpPriceRegression(training, 0.005, 320);
  const metrics = evaluateUpPricePredictions(testing, upPriceDeltaPredictions(testing, fitted));
  assert.ok(metrics.maeCents < 0.4);
  assert.ok(metrics.rSquared > 0.95);
  assert.ok(metrics.directionAccuracy > 0.9);
});
