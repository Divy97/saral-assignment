import { describe, it, expect, afterEach } from "vitest";
import { buildDeps } from "./config.js";
import { pool } from "./db/pool.js";
import { InMemoryQueue } from "./adapters/local/in-memory-queue.js";
import { LocalFileStorage } from "./adapters/local/local-file-storage.js";

const original = process.env.STAGE;
afterEach(() => {
  if (original === undefined) delete process.env.STAGE;
  else process.env.STAGE = original;
});

describe("buildDeps", () => {
  it("wires the in-memory queue and local file storage for STAGE=local", () => {
    process.env.STAGE = "local";
    const deps = buildDeps();
    expect(deps.stage).toBe("local");
    expect(deps.pool).toBe(pool);
    expect(deps.queue).toBeInstanceOf(InMemoryQueue);
    expect(deps.storage).toBeInstanceOf(LocalFileStorage);
  });

  it("throws on an invalid STAGE", () => {
    process.env.STAGE = "staging";
    expect(() => buildDeps()).toThrow(/STAGE must be/);
  });

  it("throws for production until the AWS adapters are wired", () => {
    process.env.STAGE = "production";
    expect(() => buildDeps()).toThrow(/not wired/);
  });
});
