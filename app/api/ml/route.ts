import { ensurePaperDatabase } from "../../../db/paper";
import {
  maybeTrainUpPriceModel,
  readUpPriceModel,
  readUpPriceTrainingDataset,
} from "../../../db/up-price-ml";

export async function GET(request: Request) {
  try {
    await ensurePaperDatabase();
    if (new URL(request.url).searchParams.get("format") === "training") {
      return Response.json(await readUpPriceTrainingDataset(), {
        headers: {
          "Cache-Control": "no-store, max-age=0",
          "Content-Disposition": 'attachment; filename="whalemaker-up-price-training.json"',
        },
      });
    }
    return Response.json({ model: await readUpPriceModel() }, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "UP-price model is unavailable." },
      { status: 500 }
    );
  }
}

export async function POST() {
  try {
    await ensurePaperDatabase();
    return Response.json({ model: await maybeTrainUpPriceModel(true) }, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "UP-price model training failed." },
      { status: 500 }
    );
  }
}
