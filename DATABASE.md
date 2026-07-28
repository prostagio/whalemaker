# WhaleMaker database

WhaleMaker uses a Cloudflare D1 database through the logical `DB` binding in
`.openai/hosting.json`. Sites provisions the hosted database and applies the
checked-in migration during deployment.

## What is stored

### `paper_accounts`

One persistent paper account with:

- $100 starting balance
- current available balance
- 5-share fixed order size
- last update time

### `paper_bets`

Every simulated order with its Polymarket condition ID, market slug, exact
market close time, side, five-share quantity, dollar entry cost, entry price,
market support, model edge, entry mode, human-readable entry rationale,
settlement status, winning outcome or recovery reason, payout, PnL, and
timestamps.

### `paper_market_locks`

One durable row per Polymarket market that has been traded. The market slug is
the primary key, so concurrent browser tabs cannot create a second position in
the same five-minute game. Resetting the paper ledger clears these locks.

### `model_snapshots`

A research observation every five seconds while the engine runs. These rows
make later out-of-sample calibration possible without reconstructing live
market conditions.

## How to use it

1. Open the deployed dashboard. The engine starts automatically and cannot be
   paused or switched off while the page is running.
2. The dashboard saves qualifying orders immediately and model snapshots every
   five seconds.
3. The ledger checks expired orders every five seconds.
4. In testing mode, it reads Polymarket's completed five-minute Chainlink
   opening and closing prices, calculates `UP` or `DOWN` itself, marks the bet
   `WON` or `LOST`, and updates the persistent balance immediately without
   waiting for official market settlement.
5. **Reset ledger** clears the paper bets and research samples and restores
   $100; it does not stop the engine.

Before expiry, the always-on recovery monitor can mark an open position
`EXITED`. It records proceeds at the displayed executable bid, realized PnL,
the reversal evidence that triggered the exit, and the exit timestamp. These
rows appear as **RECOVERED** in Results and remain included in CSV exports.

No wallet, API key, or manual database account is needed for this private paper
version. Real-money orders are deliberately not stored or submitted.

## Local development

The project also creates the same tables in the local D1 emulator on first
request. The canonical schema is in `db/schema.ts`; generated deployment SQL is
stored under `drizzle/`. After changing the schema, run the existing
`db:generate` workflow and inspect the generated SQL before deploying.
