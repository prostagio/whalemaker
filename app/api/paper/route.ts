import {
  ensurePaperDatabase,
  exitStoredBetForRecovery,
  placeStoredBet,
  readPaperBetsForExport,
  readPaperLedger,
  resetPaperLedger,
  settleExpiredBetsForTesting,
  storeModelSnapshot,
} from "../../../db/paper";
import { maybeTrainOutcomeModel } from "../../../db/outcome-ml";

const csvCell = (value: string | number | null) => {
  const text = value == null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const isoTime = (value: number | null) => value ? new Date(value).toISOString() : "";

const betsCsv = async () => {
  const bets = await readPaperBetsForExport();
  const headings = [
    "id", "market_slug", "market_title", "condition_id", "side", "stake_usd",
    "shares", "entry_price", "market_support", "model_edge", "entry_mode", "entry_reason",
    "status", "settlement_outcome",
    "payout_usd", "pnl_usd", "market_end_utc", "placed_at_utc", "settled_at_utc",
  ];
  const rows = bets.map((bet) => [
    bet.id, bet.market_slug, bet.market_title, bet.condition_id, bet.side, bet.stake,
    bet.shares, bet.entry_price, bet.fair_probability, bet.edge, bet.entry_mode, bet.entry_reason,
    bet.status, bet.settlement_outcome,
    bet.payout, bet.pnl, isoTime(bet.market_end_ms), isoTime(bet.placed_at),
    isoTime(bet.settled_at),
  ]);
  return [headings, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
};

const response = async () => {
  await settleExpiredBetsForTesting();
  const [ledger, outcomeModel] = await Promise.all([
    readPaperLedger(),
    maybeTrainOutcomeModel(),
  ]);
  return Response.json({ ...ledger, outcomeModel }, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
};

export async function GET(request: Request) {
  try {
    await ensurePaperDatabase();
    if (new URL(request.url).searchParams.get("format") === "csv") {
      await settleExpiredBetsForTesting();
      return new Response(await betsCsv(), {
        headers: {
          "Cache-Control": "no-store, max-age=0",
          "Content-Disposition": 'attachment; filename="whalemaker-paper-results.csv"',
          "Content-Type": "text/csv; charset=utf-8",
        },
      });
    }
    return await response();
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Database operation failed." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    await ensurePaperDatabase();
    const payload = (await request.json()) as Record<string, unknown>;
    if (payload.action === "reset") {
      await resetPaperLedger();
    } else if (payload.action === "recover") {
      await exitStoredBetForRecovery({
        betId: Number(payload.betId),
        exitPrice: Number(payload.exitPrice),
        reason: String(payload.reason || "Confirmed market reversal"),
      });
    } else if (payload.action === "snapshot") {
      await storeModelSnapshot(payload);
    } else if (payload.action === "place") {
      await placeStoredBet({
        conditionId: String(payload.conditionId),
        marketSlug: String(payload.marketSlug),
        marketTitle: String(payload.marketTitle),
        marketEndMs: Number(payload.marketEndMs),
        side: payload.side === "DOWN" ? "DOWN" : "UP",
        shares: Number(payload.shares),
        entryPrice: Number(payload.entryPrice),
        fairProbability: Number(payload.fairProbability),
        edge: Number(payload.edge),
        entryMode: payload.entryMode === "MOMENTUM" ? "MOMENTUM" : "VALUE",
        entryReason: String(payload.entryReason || ""),
      });
    } else {
      return Response.json({ error: "Unknown paper-ledger action." }, { status: 400 });
    }
    return await response();
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Database operation failed." },
      { status: 500 }
    );
  }
}
