import { ensurePaperDatabase } from "../../../db/paper";
import {
  maybeTrainOutcomeModel,
  readOutcomeModel,
  readOutcomeTrainingDataset,
} from "../../../db/outcome-ml";

export async function GET(request: Request) {
  try {
    await ensurePaperDatabase();
    if (new URL(request.url).searchParams.get("format") === "training") {
      return Response.json(await readOutcomeTrainingDataset(), {
        headers: {
          "Cache-Control": "no-store, max-age=0",
          "Content-Disposition": 'attachment; filename="whalemaker-outcome-training.json"',
        },
      });
    }
    return Response.json({ model: await readOutcomeModel() }, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Outcome model is unavailable." },
      { status: 500 }
    );
  }
}

export async function POST() {
  try {
    await ensurePaperDatabase();
    return Response.json({ model: await maybeTrainOutcomeModel(true) }, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Outcome model training failed." },
      { status: 500 }
    );
  }
}
