import { ensurePaperDatabase } from "../../../db/paper";
import {
  maybeTrainDirectionModel,
  readDirectionModel,
  readDirectionTrainingDataset,
} from "../../../db/ml";

export async function GET(request: Request) {
  try {
    await ensurePaperDatabase();
    if (new URL(request.url).searchParams.get("format") === "training") {
      return Response.json(await readDirectionTrainingDataset(), {
        headers: {
          "Cache-Control": "no-store, max-age=0",
          "Content-Disposition": 'attachment; filename="whalemaker-direction-training.json"',
        },
      });
    }
    return Response.json({ model: await readDirectionModel() }, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Direction model is unavailable." },
      { status: 500 }
    );
  }
}

export async function POST() {
  try {
    await ensurePaperDatabase();
    return Response.json({ model: await maybeTrainDirectionModel(true) }, {
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Direction model training failed." },
      { status: 500 }
    );
  }
}
