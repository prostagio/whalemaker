import { outcomeFeaturesFromValues } from "./outcome-model.ts";

const MIN_SAMPLE_GAP_MS = 9_000;

export type OutcomeSnapshot = {
  market_slug: string;
  captured_at: number;
  btc_price: number;
  strike_price: number;
  seconds_left: number;
  variance: number;
  raw_probability: number;
  up_bid: number;
  up_ask: number;
  down_bid: number;
  down_ask: number;
  up_ask_size: number;
  up_bid_size: number;
  down_ask_size: number;
  down_bid_size: number;
  data_age_ms: number;
  momentum_15_bps: number;
  momentum_30_bps: number;
  momentum_60_bps: number;
  up_contract_move_15: number;
  down_contract_move_15: number;
  up_contract_move_30: number;
  down_contract_move_30: number;
  choppiness_60: number;
  outcome: "UP" | "DOWN";
};

export type OutcomeExample = {
  marketSlug: string;
  timestamp: number;
  features: number[];
  marketProbability: number;
  label: 0 | 1;
};

const normalizedMarketUp = (row: OutcomeSnapshot) => {
  const upMid = (row.up_bid + row.up_ask) / 2;
  const downMid = (row.down_bid + row.down_ask) / 2;
  const total = upMid + downMid;
  return total > 0 ? Math.min(1 - 1e-5, Math.max(1e-5, upMid / total)) : 0.5;
};

export const buildOutcomeExamples = (rows: OutcomeSnapshot[]) => {
  const byMarket = new Map<string, OutcomeSnapshot[]>();
  for (const row of rows) {
    if (
      !Number.isFinite(row.btc_price) ||
      row.btc_price <= 0 ||
      !Number.isFinite(row.up_ask) ||
      !Number.isFinite(row.down_ask)
    ) continue;
    byMarket.set(row.market_slug, [...(byMarket.get(row.market_slug) ?? []), row]);
  }
  const examples: OutcomeExample[] = [];
  for (const [marketSlug, marketRows] of byMarket) {
    marketRows.sort((left, right) => left.captured_at - right.captured_at);
    let lastExampleAt = -Infinity;
    for (const row of marketRows) {
      if (row.captured_at - lastExampleAt < MIN_SAMPLE_GAP_MS) continue;
      const marketProbability = normalizedMarketUp(row);
      const features = outcomeFeaturesFromValues({
        btcPrice: row.btc_price,
        strikePrice: row.strike_price,
        secondsLeft: row.seconds_left,
        variance: row.variance,
        rawProbability: row.raw_probability,
        marketUp: marketProbability,
        upBid: row.up_bid,
        upAsk: row.up_ask,
        downBid: row.down_bid,
        downAsk: row.down_ask,
        upAskSize: row.up_ask_size,
        upBidSize: row.up_bid_size,
        downAskSize: row.down_ask_size,
        downBidSize: row.down_bid_size,
        momentum15Bps: row.momentum_15_bps,
        momentum30Bps: row.momentum_30_bps,
        momentum60Bps: row.momentum_60_bps,
        upContractMove15: row.up_contract_move_15,
        downContractMove15: row.down_contract_move_15,
        upContractMove30: row.up_contract_move_30,
        downContractMove30: row.down_contract_move_30,
        choppiness60: row.choppiness_60,
        dataAgeMs: row.data_age_ms,
      });
      if (features.some((value) => !Number.isFinite(value))) continue;
      examples.push({
        marketSlug,
        timestamp: row.captured_at,
        features,
        marketProbability,
        label: row.outcome === "UP" ? 1 : 0,
      });
      lastExampleAt = row.captured_at;
    }
  }
  return examples.sort((left, right) => left.timestamp - right.timestamp);
};

export const chronologicalOutcomeSplit = (examples: OutcomeExample[]) => {
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
