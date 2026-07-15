import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { ensureHashtag, upsertMediaPage } from "./media-service.js";
import type { MediaItem } from "../meta/schemas.js";

// Integration test: runs against the DATABASE_URL Postgres, skips if it's unreachable.
const IG_ID = "test_ig_svc";

let pool: Pool;
let dbUp = false;

const clean = () =>
  pool
    .query("DELETE FROM media WHERE media_id LIKE 'test_svc_%'")
    .then(() => pool.query("DELETE FROM hashtags WHERE ig_hashtag_id = $1", [IG_ID]));

const item = (over: Partial<MediaItem> & { id: string }): MediaItem => ({
  media_type: "IMAGE",
  timestamp: "2026-07-14T19:25:39+0000",
  ...over,
});

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query("SELECT 1 FROM media LIMIT 1");
    dbUp = true;
    await clean();
  } catch {
    dbUp = false;
  }
});

afterAll(async () => {
  if (dbUp) await clean();
  await pool.end();
});

describe("media-service (integration)", () => {
  it("inserts, dedups, promotes no_asset->pending, and never regresses a done row", async (ctx) => {
    if (!dbUp) return ctx.skip();

    const hashtagId = await ensureHashtag(pool, { igHashtagId: IG_ID, name: "test_matcha_svc" });

    // page 1: one with a url (-> pending), one without (-> no_asset)
    const toFetch1 = await upsertMediaPage(pool, hashtagId, [
      item({ id: "test_svc_1", media_url: "https://cdn/x.jpg", like_count: 10 }),
      item({ id: "test_svc_2" }),
    ]);
    expect(toFetch1).toEqual(["test_svc_1"]);

    // simulate the asset worker finishing test_svc_1
    await pool.query(
      "UPDATE media SET asset_status='done', storage_key='test_svc_1.jpg' WHERE media_id='test_svc_1'",
    );
    const created1: Date = (
      await pool.query("SELECT created_at FROM media WHERE media_id='test_svc_1'")
    ).rows[0].created_at;

    // page 2 (resync): test_svc_1 gains likes (done -> must not regress);
    // test_svc_2 now has a url (no_asset -> pending promotion)
    const toFetch2 = await upsertMediaPage(pool, hashtagId, [
      item({ id: "test_svc_1", media_url: "https://cdn/x.jpg", like_count: 99 }),
      item({ id: "test_svc_2", media_url: "https://cdn/y.jpg" }),
    ]);
    expect(toFetch2).toEqual(["test_svc_2"]); // done row is not re-enqueued

    const rows = (
      await pool.query(
        "SELECT media_id, asset_status, storage_key, like_count, created_at FROM media WHERE media_id LIKE 'test_svc_%'",
      )
    ).rows;
    const r1 = rows.find((r) => r.media_id === "test_svc_1");
    const r2 = rows.find((r) => r.media_id === "test_svc_2");

    // done row: metadata refreshed, asset + created_at untouched
    expect(r1.asset_status).toBe("done");
    expect(r1.storage_key).toBe("test_svc_1.jpg");
    expect(r1.like_count).toBe(99);
    expect(r1.created_at.getTime()).toBe(created1.getTime());

    // promoted row
    expect(r2.asset_status).toBe("pending");

    // dedup held: still exactly two rows
    expect(rows).toHaveLength(2);
  });

  it("collapses a duplicate media_id within one page instead of throwing", async (ctx) => {
    if (!dbUp) return ctx.skip();

    const hashtagId = await ensureHashtag(pool, { igHashtagId: IG_ID, name: "test_matcha_svc" });
    const toFetch = await upsertMediaPage(pool, hashtagId, [
      item({ id: "test_svc_dup", media_url: "https://cdn/a.jpg" }),
      item({ id: "test_svc_dup", media_url: "https://cdn/a.jpg" }),
    ]);

    expect(toFetch).toEqual(["test_svc_dup"]);
    const n = (
      await pool.query("SELECT count(*)::int AS n FROM media WHERE media_id = 'test_svc_dup'")
    ).rows[0].n;
    expect(n).toBe(1);
  });
});
