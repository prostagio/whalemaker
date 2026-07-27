CREATE TABLE `model_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`market_slug` text NOT NULL,
	`captured_at` integer NOT NULL,
	`btc_price` real NOT NULL,
	`strike_price` real NOT NULL,
	`seconds_left` integer NOT NULL,
	`variance` real NOT NULL,
	`raw_probability` real NOT NULL,
	`calibrated_probability` real NOT NULL,
	`up_bid` real NOT NULL,
	`up_ask` real NOT NULL,
	`down_bid` real NOT NULL,
	`down_ask` real NOT NULL,
	`spread` real NOT NULL,
	`top_depth` real NOT NULL,
	`data_age_ms` integer NOT NULL,
	`momentum_15_bps` real DEFAULT 0 NOT NULL,
	`momentum_30_bps` real DEFAULT 0 NOT NULL,
	`momentum_60_bps` real DEFAULT 0 NOT NULL,
	`choppiness_60` real DEFAULT 0 NOT NULL,
	`volatility_regime` text DEFAULT 'UNKNOWN' NOT NULL,
	`required_edge` real DEFAULT 0.02 NOT NULL,
	`signal` text NOT NULL,
	`blocked_reason` text
);
--> statement-breakpoint
CREATE INDEX `model_snapshots_market_time_idx` ON `model_snapshots` (`market_slug`,`captured_at`);--> statement-breakpoint
CREATE TABLE `paper_accounts` (
	`id` integer PRIMARY KEY NOT NULL,
	`starting_balance` real DEFAULT 100 NOT NULL,
	`balance` real DEFAULT 100 NOT NULL,
	`fixed_stake` real DEFAULT 5 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `paper_bets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`condition_id` text NOT NULL,
	`market_slug` text NOT NULL,
	`market_title` text NOT NULL,
	`market_end_ms` integer NOT NULL,
	`side` text NOT NULL,
	`stake` real NOT NULL,
	`entry_price` real NOT NULL,
	`fair_probability` real NOT NULL,
	`edge` real NOT NULL,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`settlement_outcome` text,
	`payout` real,
	`pnl` real,
	`placed_at` integer NOT NULL,
	`settled_at` integer
);
--> statement-breakpoint
CREATE INDEX `paper_bets_status_end_idx` ON `paper_bets` (`status`,`market_end_ms`);--> statement-breakpoint
CREATE INDEX `paper_bets_placed_idx` ON `paper_bets` (`placed_at`);