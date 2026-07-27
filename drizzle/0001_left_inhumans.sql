ALTER TABLE `paper_accounts` ADD `fixed_shares` real DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `paper_bets` ADD `shares` real;