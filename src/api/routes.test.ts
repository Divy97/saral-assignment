import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Pool } from "pg";
import type { Storage } from "../core/ports.js";

// Mock only the DB query; keep the real cursor codec.
vi.mock("../core/services/read-media.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core/services/read-media.js")>();
  return { ...actual, readHashtagMedia: vi.fn() };
});

import { getHashtagMedia } from "./routes.js";
import { readHashtagMedia, encodeCursor } from "../core/services/read-media.js";

const storage: Storage = { put: async () => {}, getUrl: (k) => `http://host/media/${k}` };
const deps = { pool: {} as unknown as Pool, storage, hashtagName: "matcha" };

const row = (over: Record<string, unknown> = {}) => ({
  media_id: "1",
  media_type: "IMAGE",
  posted_at: new Date("2026-07-13T14:07:52.000Z"),
  caption: "c",
  permalink: "p",
  like_count: 5,
  comments_count: 2,
  asset_status: "done",
  storage_key: "1.jpg",
  created_at: new Date("2026-07-14T00:00:00.000Z"),
  ...over,
});

beforeEach(() => vi.mocked(readHashtagMedia).mockReset());

describe("getHashtagMedia", () => {
  it("rejects a limit above 100", async () => {
    const r = await getHashtagMedia(deps, { limit: "150" });
    expect(r.status).toBe(400);
    expect(readHashtagMedia).not.toHaveBeenCalled();
  });

  it("rejects a malformed cursor", async () => {
    const r = await getHashtagMedia(deps, { next_cursor: Buffer.from("nopipe").toString("base64url") });
    expect(r.status).toBe(400);
  });

  it("serializes rows with a derived storage_url and encodes next_cursor", async () => {
    const cursor = { postedAt: "2026-07-13T14:07:52.000Z", mediaId: "1" };
    vi.mocked(readHashtagMedia).mockResolvedValue({ rows: [row()], nextCursor: cursor });

    const r = await getHashtagMedia(deps, {});
    expect(r.status).toBe(200);
    const body = r.body as { data: any[]; next_cursor: string | null };
    expect(body.data[0]).toMatchObject({
      media_id: "1",
      timestamp: "2026-07-13T14:07:52.000Z",
      storage_url: "http://host/media/1.jpg",
      asset_status: "done",
    });
    expect(body.data[0]).not.toHaveProperty("media_url");
    expect(body.next_cursor).toBe(encodeCursor(cursor));
  });

  it("uses the hashtag query param over the default when provided", async () => {
    vi.mocked(readHashtagMedia).mockResolvedValue({ rows: [], nextCursor: null });
    await getHashtagMedia(deps, { hashtag: "chai" });
    expect(readHashtagMedia).toHaveBeenCalledWith(
      deps.pool,
      expect.objectContaining({ hashtagName: "chai" }),
    );
  });

  it("returns empty data (200, not an error) when the hashtag has no media", async () => {
    vi.mocked(readHashtagMedia).mockResolvedValue({ rows: [], nextCursor: null });
    const r = await getHashtagMedia(deps, { hashtag: "unknown" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ data: [], next_cursor: null });
  });

  it("null storage_url when no asset, null next_cursor at the end", async () => {
    vi.mocked(readHashtagMedia).mockResolvedValue({
      rows: [row({ storage_key: null, asset_status: "pending" })],
      nextCursor: null,
    });

    const r = await getHashtagMedia(deps, { limit: "25" });
    const body = r.body as { data: any[]; next_cursor: string | null };
    expect(body.data[0].storage_url).toBeNull();
    expect(body.next_cursor).toBeNull();
  });
});
