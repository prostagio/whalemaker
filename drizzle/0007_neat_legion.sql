CREATE TABLE `model_market_outcomes` (
	`market_slug` text PRIMARY KEY NOT NULL,
	`outcome` text NOT NULL,
	`open_price` real NOT NULL,
	`close_price` real NOT NULL,
	`resolved_at` integer NOT NULL,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `outcome_models` (
	`id` integer PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'COLLECTING' NOT NULL,
	`trained_at` integer NOT NULL,
	`snapshot_count` integer DEFAULT 0 NOT NULL,
	`example_count` integer DEFAULT 0 NOT NULL,
	`market_count` integer DEFAULT 0 NOT NULL,
	`train_count` integer DEFAULT 0 NOT NULL,
	`test_count` integer DEFAULT 0 NOT NULL,
	`positive_rate` real,
	`log_loss` real,
	`brier_score` real,
	`accuracy` real,
	`balanced_accuracy` real,
	`auc` real,
	`calibration_error` real,
	`baseline_log_loss` real,
	`baseline_brier_score` real,
	`feature_names` text,
	`trees` text,
	`config` text,
	`message` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `model_snapshots` ADD `up_ask_size` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `model_snapshots` ADD `up_bid_size` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `model_snapshots` ADD `down_ask_size` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `model_snapshots` ADD `down_bid_size` real DEFAULT 0 NOT NULL;