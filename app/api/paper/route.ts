import {
  ensurePaperDatabase,
  placeStoredBet,
  readPaperLedger,
  resetPaperLedger,
  settleResolvedBets,
  storeModelSnapshot,
} from "../../../db/paper";

const response = async () => {
  await settleResolvedBets();
  return Response.json(await readPaperLedger(), {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
};

export async function GET() {
  try {
    await ensurePaperDatabase();
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
    } else if (payload.action === "snapshot") {
      await storeModelSnapshot(payload);
    } else if (payload.action === "place") {
      await placeStoredBet({
        conditionId: String(payload.conditionId),
        marketSlug: String(payload.marketSlug),
        marketTitle: String(payload.marketTitle),
        marketEndMs: Number(payload.marketEndMs),
        side: payload.side === "DOWN" ? "DOWN" : "UP",
        stake: Number(payload.stake),
        entryPrice: Number(payload.entryPrice),
        fairProbability: Number(payload.fairProbability),
        edge: Number(payload.edge),
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
