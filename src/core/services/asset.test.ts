import { describe, it, expect, vi, afterEach } from "vitest";
import type { Pool } from "pg";
import type { Storage } from "../ports.js";
import { handleFetchAsset } from "./asset.js";

type Row = { media_url: string | null; asset_status: string; storage_key: string | null };

// Mock the DB: SELECT returns the given row, other statements are recorded no-ops.
function makePool(row: Row | null) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    return { rows: sql.trimStart().startsWith("SELECT") && row ? [row] : [] };
  });
  return { pool: { query } as unknown as Pool, queries };
}

// Fake storage that records put() calls instead of touching disk.
function makeStorage() {
  const puts: { key: string; contentType: string }[] = [];
  const storage: Storage = {
    put: async (key, _body, contentType) => {
      puts.push({ key, contentType });
    },
    getUrl: (key) => `http://x/${key}`,
  };
  return { storage, puts };
}

const response = (body: string, contentType: string, status = 200) =>
  new Response(status === 200 ? body : null, { status, headers: { "content-type": contentType } });

afterEach(() => vi.unstubAllGlobals());

describe("handleFetchAsset", () => {
  it("downloads a pending asset, stores it as <id>.png, and marks it done", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response("PNGDATA", "image/png")));
    const { pool, queries } = makePool({ media_url: "https://cdn/x", asset_status: "pending", storage_key: null });
    const { storage, puts } = makeStorage();

    await handleFetchAsset("m1", { pool, storage });

    expect(puts).toEqual([{ key: "m1.png", contentType: "image/png" }]);
    const done = queries.find((q) => q.sql.includes("asset_status = 'done'"));
    expect(done?.params).toEqual(["m1", "m1.png"]);
  });

  it("uses the mp4 extension for a video content-type", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response("MP4DATA", "video/mp4")));
    const { pool } = makePool({ media_url: "https://cdn/v", asset_status: "pending", storage_key: null });
    const { storage, puts } = makeStorage();

    await handleFetchAsset("m2", { pool, storage });

    expect(puts[0]?.key).toBe("m2.mp4");
  });

  it("skips (no download, no update) when the row is already done", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { pool, queries } = makePool({ media_url: "https://cdn/x", asset_status: "done", storage_key: "m3.png" });
    const { storage, puts } = makeStorage();

    await handleFetchAsset("m3", { pool, storage });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(puts).toEqual([]);
    expect(queries.some((q) => q.sql.includes("UPDATE"))).toBe(false);
  });

  it("marks failed and does not throw when the download fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response("", "text/html", 500)));
    const { pool, queries } = makePool({ media_url: "https://cdn/x", asset_status: "pending", storage_key: null });
    const { storage, puts } = makeStorage();

    await expect(handleFetchAsset("m4", { pool, storage })).resolves.toBeUndefined();

    expect(puts).toEqual([]);
    expect(queries.some((q) => q.sql.includes("asset_status = 'failed'"))).toBe(true);
  });
});
