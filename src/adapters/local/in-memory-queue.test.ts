import { describe, it, expect, vi, afterEach } from "vitest";
import { InMemoryQueue } from "./in-memory-queue.js";

const tick = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms));

let queue: InMemoryQueue | undefined;
afterEach(() => queue?.stop());

describe("InMemoryQueue", () => {
  it("delivers an enqueued job to the consumer and acks on success", async () => {
    queue = new InMemoryQueue({ pollIntervalMs: 1 });
    const handler = vi.fn().mockResolvedValue(undefined);
    queue.consume(handler);

    await queue.enqueue({ type: "SYNC_RECENT" });
    await tick();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ type: "SYNC_RECENT" });
  });

  it("retries a failing job up to maxReceives, then stops (dead-letters)", async () => {
    queue = new InMemoryQueue({ pollIntervalMs: 1, retryDelayMs: 1, maxReceives: 3 });
    const handler = vi.fn().mockRejectedValue(new Error("tried 3 times but failed"));
    queue.consume(handler);

    await queue.enqueue({ type: "FETCH_ASSET", mediaId: "123" });
    await tick(60);

    expect(handler).toHaveBeenCalledTimes(3);
  });
});
