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

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

/**
 * The composition root — the ONLY place STAGE is read. Builds the swappable adapters and
 * hands them back; every consumer takes the interfaces, never the env. Async because the
 * production adapters are dynamically imported, so the AWS SDK never loads on the local path.
 */
export async function buildDeps(): Promise<Deps> {
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

  // production — dynamic import keeps @aws-sdk/* out of the local bundle/startup path.
  const [{ SqsQueue }, { S3Storage }] = await Promise.all([
    import("./adapters/aws/sqs-queue.js"),
    import("./adapters/aws/s3-storage.js"),
  ]);
  const region = requireEnv("AWS_REGION");
  return {
    stage,
    pool,
    queue: new SqsQueue({ queueUrl: requireEnv("SQS_QUEUE_URL"), region }),
    storage: new S3Storage({ bucket: requireEnv("S3_BUCKET"), region }),
  };
}
