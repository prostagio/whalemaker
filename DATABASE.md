# WhaleMaker database

WhaleMaker uses a Cloudflare D1 database through the logical `DB` binding in
`.openai/hosting.json`. Sites provisions the hosted database and applies the
checked-in migration during deployment.

## What is stored

### `paper_accounts`

One persistent paper account with:

- $100 starting balance
- current available balance
- $5 fixed stake
- last update time

### `paper_bets`

Every simulated order with its Polymarket condition ID, market slug, exact
market close time, side, entry price, fair probability, edge, settlement
status, winning outcome, payout, PnL, and timestamps.

### `model_snapshots`

A research observation every five seconds while the engine runs. These rows
make later out-of-sample calibration possible without reconstructing live
market conditions.

## How to use it

1. Open the deployed dashboard and start the engine.
2. Keep **Auto-bet qualifying signals** enabled if you want automatic paper
   orders.
3. The dashboard saves qualifying orders immediately and model snapshots every
   five seconds.
4. The ledger checks expired orders every five seconds.
5. In testing mode, it reads Polymarket's completed five-minute Chainlink
   opening and closing prices, calculates `UP` or `DOWN` itself, marks the bet
   `WON` or `LOST`, and updates the persistent balance immediately without
   waiting for official market settlement.
6. **Reset** clears the paper bets and research samples and restores $100.

No wallet, API key, or manual database account is needed for this private paper
version. Real-money orders are deliberately not stored or submitted.

## Local development

The project also creates the same tables in the local D1 emulator on first
request. The canonical schema is in `db/schema.ts`; generated deployment SQL is
stored under `drizzle/`. After changing the schema, run the existing
`db:generate` workflow and inspect the generated SQL before deploying.
