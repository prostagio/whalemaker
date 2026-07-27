import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const paperAccounts = sqliteTable("paper_accounts", {
  id: integer("id").primaryKey(),
  startingBalance: real("starting_balance").notNull().default(100),
  balance: real("balance").notNull().default(100),
  fixedStake: real("fixed_stake").notNull().default(5),
  fixedShares: real("fixed_shares").notNull().default(5),
  updatedAt: integer("updated_at").notNull(),
});

export const paperBets = sqliteTable(
  "paper_bets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conditionId: text("condition_id").notNull(),
    marketSlug: text("market_slug").notNull(),
    marketTitle: text("market_title").notNull(),
    marketEndMs: integer("market_end_ms").notNull(),
    side: text("side", { enum: ["UP", "DOWN"] }).notNull(),
    stake: real("stake").notNull(),
    shares: real("shares"),
    entryPrice: real("entry_price").notNull(),
    fairProbability: real("fair_probability").notNull(),
    edge: real("edge").notNull(),
    status: text("status", { enum: ["OPEN", "WON", "LOST", "EXITED", "VOID"] }).notNull().default("OPEN"),
    settlementOutcome: text("settlement_outcome"),
    payout: real("payout"),
    pnl: real("pnl"),
    placedAt: integer("placed_at").notNull(),
    settledAt: integer("settled_at"),
  },
  (table) => [
    index("paper_bets_status_end_idx").on(table.status, table.marketEndMs),
    index("paper_bets_placed_idx").on(table.placedAt),
  ]
);

export const modelSnapshots = sqliteTable(
  "model_snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    marketSlug: text("market_slug").notNull(),
    capturedAt: integer("captured_at").notNull(),
    btcPrice: real("btc_price").notNull(),
    strikePrice: real("strike_price").notNull(),
    secondsLeft: integer("seconds_left").notNull(),
    variance: real("variance").notNull(),
    rawProbability: real("raw_probability").notNull(),
    calibratedProbability: real("calibrated_probability").notNull(),
    upBid: real("up_bid").notNull(),
    upAsk: real("up_ask").notNull(),
    downBid: real("down_bid").notNull(),
    downAsk: real("down_ask").notNull(),
    spread: real("spread").notNull(),
    topDepth: real("top_depth").notNull(),
    dataAgeMs: integer("data_age_ms").notNull(),
    momentum15Bps: real("momentum_15_bps").notNull().default(0),
    momentum30Bps: real("momentum_30_bps").notNull().default(0),
    momentum60Bps: real("momentum_60_bps").notNull().default(0),
    choppiness60: real("choppiness_60").notNull().default(0),
    volatilityRegime: text("volatility_regime").notNull().default("UNKNOWN"),
    requiredEdge: real("required_edge").notNull().default(0.02),
    signal: text("signal").notNull(),
    blockedReason: text("blocked_reason"),
  },
  (table) => [
    index("model_snapshots_market_time_idx").on(table.marketSlug, table.capturedAt),
  ]
);
