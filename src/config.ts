import type { Pool } from "pg";
import type { Queue, Storage } from "./core/ports.js";
import { pool } from "./db/pool.js";
import { InMemoryQueue } from "./adapters/local/in-memory-queue.js";
import { LocalFileStorage } from "./adapters/local/local-file-storage.js";

export type Stage = "local" | "production";

export interface Deps {
  stage: Stage;
  pool: Pool; // same pg pool in both stages
  queue: Queue;
  storage: Storage;
}

function getStage(): Stage {
  const stage = process.env.STAGE;
  if (stage !== "local" && stage !== "production") {
    throw new Error(`STAGE must be "local" or "production", got: ${stage ?? "(unset)"}`);
  }
  return stage;
}

/**
 * The composition root — the ONLY place STAGE is read. Builds the swappable adapters
 * and hands them back; every consumer takes the interfaces, never the env.
 */
export function buildDeps(): Deps {
  const stage = getStage();

  if (stage === "local") {
    return {
      stage,
      pool,
      queue: new InMemoryQueue(),
      storage: new LocalFileStorage({
        mediaDir: process.env.MEDIA_DIR ?? "./media",
        publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "http://localhost:3000",
      }),
    };
  }

  // production: SqsQueue + S3Storage. Not wired yet — those adapters land in a later
  // branch, and will be dynamically imported here so the AWS SDK stays out of the
  // local path.
  throw new Error("production adapters (SQS/S3) are not wired yet");
}
