ALTER TABLE `model_snapshots` ADD `up_contract_move_15` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `model_snapshots` ADD `down_contract_move_15` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `model_snapshots` ADD `up_contract_move_30` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `model_snapshots` ADD `down_contract_move_30` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `model_snapshots` ADD `entry_mode` text DEFAULT 'WAIT' NOT NULL;