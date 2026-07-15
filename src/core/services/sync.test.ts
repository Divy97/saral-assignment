import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Pool } from "pg";
import type { Job, Queue } from "../ports.js";

vi.mock("../meta/meta-client.js", () => ({
  searchHashtagId: vi.fn(),
  fetchTopMedia: vi.fn(),
  fetchRecentMedia: vi.fn(),
  MetaCredentialsMissingError: class MetaCredentialsMissingError extends Error {},
}));
vi.mock("./media-service.js", () => ({
  ensureHashtag: vi.fn(),
  upsertMediaPage: vi.fn(),
}));

import { runTopSync } from "./sync.js";
import * as meta from "../meta/meta-client.js";
import * as svc from "./media-service.js";

async function* asPages<T>(...pages: T[][]): AsyncGenerator<T[]> {
  for (const p of pages) yield p;
}

const makeQueue = () => {
  const jobs: Job[] = [];
  const queue: Queue = {
    enqueue: async (j) => {
      jobs.push(j);
    },
    consume: () => {},
  };
  return { queue, jobs };
};

const mediaItem = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  media_type: "IMAGE",
  timestamp: "2026-07-14T19:25:39+0000",
  ...over,
});

const ctxBase = {
  pool: {} as unknown as Pool,
  meta: { accessToken: "t", userId: "u" },
  hashtagName: "matcha",
};

beforeEach(() => vi.resetAllMocks());

describe("runTopSync", () => {
  it("saves every page and queues FETCH_ASSET only for the ids that need an asset", async () => {
    vi.mocked(meta.searchHashtagId).mockResolvedValue("hid");
    vi.mocked(svc.ensureHashtag).mockResolvedValue(42);

    const page1 = [
      mediaItem("a", { media_url: "u/a" }),
      mediaItem("b"), // no url -> no_asset, not queued
      mediaItem("c", { media_url: "u/c", media_type: "VIDEO" }),
    ];
    const page2 = [mediaItem("d"), mediaItem("e")]; // all no_asset
    const page3 = [mediaItem("f", { media_url: "u/f" })];
    vi.mocked(meta.fetchTopMedia).mockReturnValue(asPages(page1, page2, page3) as never);

    vi.mocked(svc.upsertMediaPage)
      .mockResolvedValueOnce(["a", "c"])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(["f"]);

    const { queue, jobs } = makeQueue();
    await runTopSync({ ...ctxBase, queue });

    // saved: upsertMediaPage called once per page with (pool, hashtagId, exact page)
    expect(svc.upsertMediaPage).toHaveBeenCalledTimes(3);
    const calls = vi.mocked(svc.upsertMediaPage).mock.calls;
    expect(calls[0]?.[1]).toBe(42); // resolved hashtag id
    expect(calls[0]?.[2]).toBe(page1);
    expect(calls[1]?.[2]).toBe(page2);
    expect(calls[2]?.[2]).toBe(page3);

    // queued: only the returned ids, in order, nothing for the no_asset pages
    expect(jobs).toEqual([
      { type: "FETCH_ASSET", mediaId: "a" },
      { type: "FETCH_ASSET", mediaId: "c" },
      { type: "FETCH_ASSET", mediaId: "f" },
    ]);
  });

  it("skips gracefully (no throw, no enqueue) when credentials are missing", async () => {
    vi.mocked(meta.searchHashtagId).mockRejectedValue(new meta.MetaCredentialsMissingError());

    const { queue, jobs } = makeQueue();
    await expect(runTopSync({ ...ctxBase, queue })).resolves.toBeUndefined();
    expect(jobs).toEqual([]);
  });

  it("stops when the hashtag is not found", async () => {
    vi.mocked(meta.searchHashtagId).mockResolvedValue(null);

    const { queue, jobs } = makeQueue();
    await runTopSync({ ...ctxBase, queue });

    expect(svc.ensureHashtag).not.toHaveBeenCalled();
    expect(jobs).toEqual([]);
  });
});
