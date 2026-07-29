import { env } from "cloudflare:workers";

export type StoredBet = {
  id: number;
  condition_id: string;
  market_slug: string;
  market_title: string;
  market_end_ms: number;
  side: "UP" | "DOWN";
  stake: number;
  shares: number | null;
  entry_price: number;
  fair_probability: number;
  edge: number;
  entry_mode: "VALUE" | "MOMENTUM";
  entry_reason: string;
  status: "OPEN" | "WON" | "LOST" | "EXITED" | "VOID";
  settlement_outcome: string | null;
  payout: number | null;
  pnl: number | null;
  placed_at: number;
  settled_at: number | null;
};

const db = () => {
  if (!env.DB) throw new Error("The paper-trading database is unavailable.");
  return env.DB;
};

export async function ensurePaperDatabase() {
  const d1 = db();
  await d1.batch([
    d1.prepare(`CREATE TABLE IF NOT EXISTS paper_accounts (
      id INTEGER PRIMARY KEY,
      starting_balance REAL NOT NULL DEFAULT 100,
      balance REAL NOT NULL DEFAULT 100,
      fixed_stake REAL NOT NULL DEFAULT 5,
      fixed_shares REAL NOT NULL DEFAULT 5,
      updated_at INTEGER NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS paper_bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      condition_id TEXT NOT NULL,
      market_slug TEXT NOT NULL,
      market_title TEXT NOT NULL,
      market_end_ms INTEGER NOT NULL,
      side TEXT NOT NULL,
      stake REAL NOT NULL,
      shares REAL,
      entry_price REAL NOT NULL,
      fair_probability REAL NOT NULL,
      edge REAL NOT NULL,
      entry_mode TEXT NOT NULL DEFAULT 'VALUE',
      entry_reason TEXT NOT NULL DEFAULT 'Legacy value entry',
      status TEXT NOT NULL DEFAULT 'OPEN',
      settlement_outcome TEXT,
      payout REAL,
      pnl REAL,
      placed_at INTEGER NOT NULL,
      settled_at INTEGER
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS model_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_slug TEXT NOT NULL,
      captured_at INTEGER NOT NULL,
      btc_price REAL NOT NULL,
      strike_price REAL NOT NULL,
      seconds_left INTEGER NOT NULL,
      variance REAL NOT NULL,
      raw_probability REAL NOT NULL,
      calibrated_probability REAL NOT NULL,
      up_bid REAL NOT NULL,
      up_ask REAL NOT NULL,
      down_bid REAL NOT NULL,
      down_ask REAL NOT NULL,
      spread REAL NOT NULL,
      top_depth REAL NOT NULL,
      data_age_ms INTEGER NOT NULL,
      momentum_15_bps REAL NOT NULL DEFAULT 0,
      momentum_30_bps REAL NOT NULL DEFAULT 0,
      momentum_60_bps REAL NOT NULL DEFAULT 0,
      up_contract_move_15 REAL NOT NULL DEFAULT 0,
      down_contract_move_15 REAL NOT NULL DEFAULT 0,
      up_contract_move_30 REAL NOT NULL DEFAULT 0,
      down_contract_move_30 REAL NOT NULL DEFAULT 0,
      choppiness_60 REAL NOT NULL DEFAULT 0,
      volatility_regime TEXT NOT NULL DEFAULT 'UNKNOWN',
      entry_mode TEXT NOT NULL DEFAULT 'WAIT',
      required_edge REAL NOT NULL DEFAULT 0.02,
      signal TEXT NOT NULL,
      blocked_reason TEXT
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS paper_market_locks (
      market_slug TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS direction_models (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'COLLECTING',
      trained_at INTEGER NOT NULL,
      horizon_seconds INTEGER NOT NULL DEFAULT 10,
      snapshot_count INTEGER NOT NULL DEFAULT 0,
      example_count INTEGER NOT NULL DEFAULT 0,
      market_count INTEGER NOT NULL DEFAULT 0,
      train_count INTEGER NOT NULL DEFAULT 0,
      test_count INTEGER NOT NULL DEFAULT 0,
      positive_rate REAL,
      baseline_accuracy REAL,
      accuracy REAL,
      balanced_accuracy REAL,
      precision REAL,
      recall REAL,
      auc REAL,
      log_loss REAL,
      threshold REAL NOT NULL DEFAULT 0.5,
      feature_names TEXT,
      means TEXT,
      scales TEXT,
      weights TEXT,
      bias REAL,
      l2 REAL,
      message TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS up_price_models (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'COLLECTING',
      trained_at INTEGER NOT NULL,
      horizon_seconds INTEGER NOT NULL DEFAULT 10,
      snapshot_count INTEGER NOT NULL DEFAULT 0,
      example_count INTEGER NOT NULL DEFAULT 0,
      market_count INTEGER NOT NULL DEFAULT 0,
      train_count INTEGER NOT NULL DEFAULT 0,
      test_count INTEGER NOT NULL DEFAULT 0,
      mae_cents REAL,
      rmse_cents REAL,
      baseline_mae_cents REAL,
      direction_accuracy REAL,
      r_squared REAL,
      feature_names TEXT,
      means TEXT,
      scales TEXT,
      weights TEXT,
      bias REAL,
      l2 REAL,
      message TEXT NOT NULL
    )`),
    d1.prepare("CREATE INDEX IF NOT EXISTS paper_bets_status_end_idx ON paper_bets (status, market_end_ms)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS paper_bets_placed_idx ON paper_bets (placed_at)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS model_snapshots_market_time_idx ON model_snapshots (market_slug, captured_at)"),
    d1.prepare(`INSERT OR IGNORE INTO paper_accounts
      (id, starting_balance, balance, fixed_stake, updated_at)
      VALUES (1, 100, 100, 5, ?1)`).bind(Date.now()),
  ]);
  const [accountColumns, betColumns, snapshotColumns] = await Promise.all([
    d1.prepare("PRAGMA table_info(paper_accounts)").all<{ name: string }>(),
    d1.prepare("PRAGMA table_info(paper_bets)").all<{ name: string }>(),
    d1.prepare("PRAGMA table_info(model_snapshots)").all<{ name: string }>(),
  ]);
  if (!accountColumns.results.some((column) => column.name === "fixed_shares")) {
    await d1.prepare("ALTER TABLE paper_accounts ADD COLUMN fixed_shares REAL NOT NULL DEFAULT 5").run();
  }
  if (!betColumns.results.some((column) => column.name === "shares")) {
    await d1.prepare("ALTER TABLE paper_bets ADD COLUMN shares REAL").run();
  }
  if (!betColumns.results.some((column) => column.name === "entry_mode")) {
    await d1.prepare("ALTER TABLE paper_bets ADD COLUMN entry_mode TEXT NOT NULL DEFAULT 'VALUE'").run();
  }
  if (!betColumns.results.some((column) => column.name === "entry_reason")) {
    await d1.prepare("ALTER TABLE paper_bets ADD COLUMN entry_reason TEXT NOT NULL DEFAULT 'Legacy value entry'").run();
  }
  const snapshotAdditions = [
    ["up_contract_move_15", "REAL NOT NULL DEFAULT 0"],
    ["down_contract_move_15", "REAL NOT NULL DEFAULT 0"],
    ["up_contract_move_30", "REAL NOT NULL DEFAULT 0"],
    ["down_contract_move_30", "REAL NOT NULL DEFAULT 0"],
    ["entry_mode", "TEXT NOT NULL DEFAULT 'WAIT'"],
  ] as const;
  for (const [name, definition] of snapshotAdditions) {
    if (!snapshotColumns.results.some((column) => column.name === name)) {
      await d1.prepare(`ALTER TABLE model_snapshots ADD COLUMN ${name} ${definition}`).run();
    }
  }
  await d1.prepare(`UPDATE paper_bets
    SET shares = stake / entry_price
    WHERE shares IS NULL AND entry_price > 0`).run();
  await d1.prepare(`INSERT OR IGNORE INTO paper_market_locks (market_slug, created_at)
    SELECT market_slug, MIN(placed_at) FROM paper_bets GROUP BY market_slug`).run();
}

export async function settleExpiredBetsForTesting() {
  const d1 = db();
  const open = await d1
    .prepare("SELECT * FROM paper_bets WHERE status = 'OPEN' AND market_end_ms <= ?1 ORDER BY market_end_ms")
    .bind(Date.now())
    .all<StoredBet>();
  const byMarket = new Map<string, StoredBet[]>();
  for (const bet of open.results) {
    const key = `${bet.market_slug}:${bet.market_end_ms}`;
    byMarket.set(key, [...(byMarket.get(key) ?? []), bet]);
  }

  for (const bets of byMarket.values()) {
    try {
      const representative = bets[0];
      const slugStartSeconds = Number(representative.market_slug.match(/(\d{10})$/)?.[1]);
      const windowStartMs = Number.isFinite(slugStartSeconds)
        ? slugStartSeconds * 1_000
        : representative.market_end_ms - 300_000;
      const priceUrl = new URL("https://polymarket.com/api/crypto/crypto-price");
      priceUrl.searchParams.set("symbol", "BTC");
      priceUrl.searchParams.set("eventStartTime", new Date(windowStartMs).toISOString());
      priceUrl.searchParams.set("variant", "fiveminute");
      const response = await fetch(priceUrl, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) continue;
      const windowPrice = (await response.json()) as {
        openPrice?: number;
        closePrice?: number;
        completed?: boolean;
      };
      const openPrice = Number(windowPrice.openPrice);
      const closePrice = Number(windowPrice.closePrice);
      if (
        windowPrice.completed !== true ||
        !Number.isFinite(openPrice) ||
        !Number.isFinite(closePrice) ||
        openPrice <= 0 ||
        closePrice <= 0
      ) continue;
      const winner: "UP" | "DOWN" = closePrice >= openPrice ? "UP" : "DOWN";

      for (const bet of bets) {
        const won = bet.side === winner;
        const shares = bet.shares ?? bet.stake / bet.entry_price;
        const payout = won ? shares : 0;
        const pnl = payout - bet.stake;
        const settledAt = Date.now();
        await d1.prepare(`UPDATE paper_bets
          SET status = ?1, settlement_outcome = ?2, payout = ?3, pnl = ?4, settled_at = ?5
          WHERE id = ?6 AND status = 'OPEN'`).bind(
            won ? "WON" : "LOST",
            winner,
            payout,
            pnl,
            settledAt,
            bet.id
          ).run();
      }
    } catch {
      // Test settlement is retried on the next ledger poll.
    }
  }
}

export async function reconcilePaperBalance() {
  await db().prepare(`UPDATE paper_accounts
    SET balance = starting_balance
      + COALESCE((
        SELECT SUM(pnl) FROM paper_bets WHERE status IN ('WON', 'LOST', 'EXITED')
      ), 0)
      - COALESCE((
        SELECT SUM(stake) FROM paper_bets WHERE status = 'OPEN'
      ), 0),
      updated_at = ?1
    WHERE id = 1`)
    .bind(Date.now())
    .run();
}

export async function readPaperLedger() {
  await reconcilePaperBalance();
  const d1 = db();
  const [accountResult, betsResult, statsResult, snapshotsResult] = await Promise.all([
    d1.prepare("SELECT * FROM paper_accounts WHERE id = 1").first<{
      starting_balance: number;
      balance: number;
      fixed_stake: number;
      updated_at: number;
    }>(),
    d1.prepare("SELECT * FROM paper_bets ORDER BY placed_at DESC LIMIT 50").all<StoredBet>(),
    d1.prepare(`SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END), 0) AS open_count,
      COALESCE(SUM(CASE WHEN status = 'WON' THEN 1 ELSE 0 END), 0) AS wins,
      COALESCE(SUM(CASE WHEN status = 'LOST' THEN 1 ELSE 0 END), 0) AS losses,
      COALESCE(SUM(CASE WHEN status = 'EXITED' THEN 1 ELSE 0 END), 0) AS recoveries,
      COALESCE(SUM(CASE WHEN status = 'OPEN' THEN stake ELSE 0 END), 0) AS open_stake,
      COALESCE(SUM(pnl), 0) AS realized_pnl
      FROM paper_bets`).first<{
      total: number;
      open_count: number;
      wins: number;
      losses: number;
      recoveries: number;
      open_stake: number;
      realized_pnl: number;
    }>(),
    d1.prepare("SELECT COUNT(*) AS count FROM model_snapshots").first<{ count: number }>(),
  ]);
  return {
    account: accountResult,
    bets: betsResult.results,
    stats: statsResult,
    snapshotCount: snapshotsResult?.count ?? 0,
  };
}

export async function readPaperBetsForExport() {
  const result = await db()
    .prepare("SELECT * FROM paper_bets ORDER BY placed_at DESC")
    .all<StoredBet>();
  return result.results;
}

export async function exitStoredBetForRecovery(input: {
  betId: number;
  exitPrice: number;
  reason: string;
}) {
  const d1 = db();
  if (!Number.isInteger(input.betId) || input.betId <= 0) {
    throw new Error("Invalid recovery bet.");
  }
  if (!Number.isFinite(input.exitPrice) || input.exitPrice <= 0 || input.exitPrice > 1) {
    throw new Error("Invalid recovery exit price.");
  }
  const bet = await d1
    .prepare("SELECT * FROM paper_bets WHERE id = ?1 AND status = 'OPEN'")
    .bind(input.betId)
    .first<StoredBet>();
  if (!bet) throw new Error("The paper bet is no longer open.");
  if (bet.market_end_ms <= Date.now()) {
    throw new Error("The market has ended; settlement will calculate the result.");
  }
  const shares = bet.shares ?? bet.stake / bet.entry_price;
  const proceeds = shares * input.exitPrice;
  const pnl = proceeds - bet.stake;
  const reason = input.reason.replace(/\s+/g, " ").trim().slice(0, 180) || "Recovery exit";
  await d1.prepare(`UPDATE paper_bets
    SET status = 'EXITED', settlement_outcome = ?1, payout = ?2, pnl = ?3, settled_at = ?4
    WHERE id = ?5 AND status = 'OPEN'`)
    .bind(`RECOVERY: ${reason}`, proceeds, pnl, Date.now(), input.betId)
    .run();
  await reconcilePaperBalance();
}

export async function placeStoredBet(input: {
  conditionId: string;
  marketSlug: string;
  marketTitle: string;
  marketEndMs: number;
  side: "UP" | "DOWN";
  shares: number;
  entryPrice: number;
  fairProbability: number;
  edge: number;
  entryMode: "VALUE" | "MOMENTUM";
  entryReason: string;
}) {
  const d1 = db();
  await reconcilePaperBalance();
  if (input.shares !== 5) throw new Error("Paper orders must contain exactly 5 shares.");
  if (!input.marketSlug || input.marketSlug.length > 180) {
    throw new Error("Invalid Polymarket market identifier.");
  }
  if (!Number.isFinite(input.marketEndMs) || input.marketEndMs <= Date.now()) {
    throw new Error("The Polymarket market is no longer open.");
  }
  if (!Number.isFinite(input.fairProbability) || input.fairProbability > 1) {
    throw new Error("Invalid Polymarket market support.");
  }
  if (!Number.isFinite(input.edge)) throw new Error("Invalid model edge.");
  if (input.entryMode === "VALUE") {
    if (input.fairProbability < 0.55) {
      throw new Error("Value entries require at least 55% Polymarket support.");
    }
    if (input.entryPrice < 0.55 || input.entryPrice > 0.90) {
      throw new Error("Value entries must cost between 55¢ and 90¢ per share.");
    }
  } else {
    if (input.fairProbability < 0.45) {
      throw new Error("Momentum entries require at least 45% Polymarket support.");
    }
    if (input.entryPrice < 0.45 || input.entryPrice > 0.85) {
      throw new Error("Momentum entries must cost between 45¢ and 85¢ per share.");
    }
  }
  const stake = input.shares * input.entryPrice;
  const account = await d1
    .prepare("SELECT balance FROM paper_accounts WHERE id = 1")
    .first<{ balance: number }>();
  if (!account || account.balance < stake) throw new Error("Insufficient paper balance.");
  if (input.entryPrice <= 0 || input.entryPrice > 1) throw new Error("Invalid entry price.");
  const now = Date.now();
  const entryReason = input.entryReason.replace(/\s+/g, " ").trim().slice(0, 240);
  if (!entryReason) throw new Error("The entry rationale is required.");
  const lock = await d1.prepare(`INSERT OR IGNORE INTO paper_market_locks
    (market_slug, created_at) VALUES (?1, ?2)`)
    .bind(input.marketSlug, now)
    .run();
  if ((lock.meta.changes ?? 0) !== 1) {
    throw new Error("This market has already been traded; averaging down is disabled.");
  }
  try {
    await d1.batch([
      d1.prepare("UPDATE paper_accounts SET balance = balance - ?1, updated_at = ?2 WHERE id = 1")
        .bind(stake, now),
      d1.prepare(`INSERT INTO paper_bets
        (condition_id, market_slug, market_title, market_end_ms, side, stake, shares,
         entry_price, fair_probability, edge, entry_mode, entry_reason, status, placed_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'OPEN', ?13)`)
        .bind(
          input.conditionId,
          input.marketSlug,
          input.marketTitle,
          input.marketEndMs,
          input.side,
          stake,
          input.shares,
          input.entryPrice,
          input.fairProbability,
          input.edge,
          input.entryMode,
          entryReason,
          now
        ),
    ]);
  } catch (error) {
    await d1.prepare("DELETE FROM paper_market_locks WHERE market_slug = ?1")
      .bind(input.marketSlug)
      .run();
    throw error;
  }
}

export async function storeModelSnapshot(input: Record<string, unknown>) {
  const d1 = db();
  await d1.prepare(`INSERT INTO model_snapshots
    (market_slug, captured_at, btc_price, strike_price, seconds_left, variance,
     raw_probability, calibrated_probability, up_bid, up_ask, down_bid, down_ask,
     spread, top_depth, data_age_ms, momentum_15_bps, momentum_30_bps,
     momentum_60_bps, up_contract_move_15, down_contract_move_15,
     up_contract_move_30, down_contract_move_30, choppiness_60,
     volatility_regime, entry_mode, required_edge, signal, blocked_reason)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28)`)
    .bind(
      input.marketSlug,
      Date.now(),
      input.btcPrice,
      input.strikePrice,
      input.secondsLeft,
      input.variance,
      input.rawProbability,
      input.calibratedProbability,
      input.upBid,
      input.upAsk,
      input.downBid,
      input.downAsk,
      input.spread,
      input.topDepth,
      input.dataAgeMs,
      input.momentum15Bps,
      input.momentum30Bps,
      input.momentum60Bps,
      input.upContractMove15,
      input.downContractMove15,
      input.upContractMove30,
      input.downContractMove30,
      input.choppiness60,
      input.volatilityRegime,
      input.entryMode,
      input.requiredEdge,
      input.signal,
      input.blockedReason || null
    )
    .run();
}

export async function resetPaperLedger() {
  const d1 = db();
  await d1.batch([
    d1.prepare("DELETE FROM paper_bets"),
    d1.prepare("DELETE FROM paper_market_locks"),
    d1.prepare("DELETE FROM model_snapshots"),
    d1.prepare("DELETE FROM up_price_models"),
    d1.prepare("UPDATE paper_accounts SET balance = 100, updated_at = ?1 WHERE id = 1")
      .bind(Date.now()),
  ]);
}
