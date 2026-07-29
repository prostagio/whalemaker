import { upPriceFeaturesFromValues } from "./up-price-model.ts";

const MIN_FUTURE_MS = 8_000;
const MAX_FUTURE_MS = 14_000;
const MIN_SAMPLE_GAP_MS = 9_000;

export type UpPriceSnapshot = {
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

export type UpPriceExample = {
  marketSlug: string;
  timestamp: number;
  features: number[];
  currentUpAsk: number;
  futureUpAsk: number;
  targetDeltaCents: number;
};

const clampProbability = (value: number) => Math.min(1 - 1e-5, Math.max(1e-5, value));
const marketUpMidpoint = (row: UpPriceSnapshot) => {
  const upMid = (row.up_bid + row.up_ask) / 2;
  const downMid = (row.down_bid + row.down_ask) / 2;
  const total = upMid + downMid;
  return total > 0 ? clampProbability(upMid / total) : 0.5;
};

const featuresForSnapshot = (row: UpPriceSnapshot) => upPriceFeaturesFromValues({
  btcPrice: row.btc_price,
  strikePrice: row.strike_price,
  secondsLeft: row.seconds_left,
  variance: row.variance,
  rawProbability: row.raw_probability,
  marketUp: marketUpMidpoint(row),
  upBid: row.up_bid,
  upAsk: row.up_ask,
  downAsk: row.down_ask,
  momentum15Bps: row.momentum_15_bps,
  momentum30Bps: row.momentum_30_bps,
  momentum60Bps: row.momentum_60_bps,
  upContractMove15: row.up_contract_move_15,
  downContractMove15: row.down_contract_move_15,
  upContractMove30: row.up_contract_move_30,
  downContractMove30: row.down_contract_move_30,
  topDepth: row.top_depth,
  choppiness60: row.choppiness_60,
  dataAgeMs: row.data_age_ms,
});

export const buildUpPriceExamples = (rows: UpPriceSnapshot[]) => {
  const byMarket = new Map<string, UpPriceSnapshot[]>();
  for (const row of rows) {
    if (
      !Number.isFinite(row.btc_price) ||
      row.btc_price <= 0 ||
      !Number.isFinite(row.up_ask) ||
      row.up_ask <= 0 ||
      row.up_ask >= 1
    ) continue;
    byMarket.set(row.market_slug, [...(byMarket.get(row.market_slug) ?? []), row]);
  }
  const examples: UpPriceExample[] = [];
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
      if (
        horizon > MAX_FUTURE_MS ||
        !Number.isFinite(future.up_ask) ||
        future.up_ask <= 0 ||
        future.up_ask >= 1
      ) continue;
      const features = featuresForSnapshot(row);
      if (features.some((value) => !Number.isFinite(value))) continue;
      examples.push({
        marketSlug,
        timestamp: row.captured_at,
        features,
        currentUpAsk: row.up_ask,
        futureUpAsk: future.up_ask,
        targetDeltaCents: (future.up_ask - row.up_ask) * 100,
      });
      lastExampleAt = row.captured_at;
    }
  }
  return examples.sort((left, right) => left.timestamp - right.timestamp);
};

export const chronologicalUpPriceSplit = (examples: UpPriceExample[]) => {
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
