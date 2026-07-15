import { describe, it, expect, afterEach } from "vitest";
import { buildDeps } from "./config.js";
import { pool } from "./db/pool.js";
import { InMemoryQueue } from "./adapters/local/in-memory-queue.js";
import { LocalFileStorage } from "./adapters/local/local-file-storage.js";
import { SqsQueue } from "./adapters/aws/sqs-queue.js";
import { S3Storage } from "./adapters/aws/s3-storage.js";

const original = process.env.STAGE;
afterEach(() => {
  if (original === undefined) delete process.env.STAGE;
  else process.env.STAGE = original;
  delete process.env.AWS_REGION;
  delete process.env.SQS_QUEUE_URL;
  delete process.env.S3_BUCKET;
});

describe("buildDeps", () => {
  it("wires the in-memory queue and local file storage for STAGE=local", async () => {
    process.env.STAGE = "local";
    const deps = await buildDeps();
    expect(deps.stage).toBe("local");
    expect(deps.pool).toBe(pool);
    expect(deps.queue).toBeInstanceOf(InMemoryQueue);
    expect(deps.storage).toBeInstanceOf(LocalFileStorage);
  });

  it("throws on an invalid STAGE", async () => {
    process.env.STAGE = "staging";
    await expect(buildDeps()).rejects.toThrow(/STAGE must be/);
  });

  it("wires SQS + S3 for STAGE=production", async () => {
    process.env.STAGE = "production";
    process.env.AWS_REGION = "us-east-1";
    process.env.SQS_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/123456789012/media-jobs";
    process.env.S3_BUCKET = "matcha-media";
    const deps = await buildDeps();
    expect(deps.queue).toBeInstanceOf(SqsQueue);
    expect(deps.storage).toBeInstanceOf(S3Storage);
  });

  it("rejects production when a required env var is missing", async () => {
    process.env.STAGE = "production"; // no AWS_REGION / SQS_QUEUE_URL / S3_BUCKET
    await expect(buildDeps()).rejects.toThrow(/missing required env var/);
  });
});
