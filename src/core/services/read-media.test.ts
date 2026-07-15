import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { readHashtagMedia, encodeCursor, decodeCursor } from "./read-media.js";

const IG_ID = "test_ig_read";
const NAME = "test_matcha_read";

describe("cursor encode/decode", () => {
  it("round-trips a cursor", () => {
    const c = { postedAt: "2026-07-13T14:07:52.000Z", mediaId: "18130665154527971" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it("returns null for malformed tokens", () => {
    expect(decodeCursor(Buffer.from("nopipe").toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from("notadate|123").toString("base64url"))).toBeNull();
  });
});

describe("readHashtagMedia (integration)", () => {
  let pool: Pool;
  let dbUp = false;

  const clean = () =>
    pool
      .query("DELETE FROM media WHERE media_id LIKE 'test_read_%'")
      .then(() => pool.query("DELETE FROM hashtags WHERE ig_hashtag_id = $1", [IG_ID]));

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      await pool.query("SELECT 1 FROM media LIMIT 1");
      dbUp = true;
    } catch {
      dbUp = false;
      return;
    }
    await clean();
    const res = await pool.query<{ id: string }>(
      "INSERT INTO hashtags (ig_hashtag_id, name) VALUES ($1, $2) RETURNING id",
      [IG_ID, NAME],
    );
    const hashtagId = Number(res.rows[0]!.id);
    const insert = async (id: string, postedAt: string) => {
      await pool.query(
        "INSERT INTO media (media_id, media_type, posted_at, asset_status, storage_key) VALUES ($1, 'IMAGE', $2, 'done', $3)",
        [id, postedAt, `${id}.jpg`],
      );
      await pool.query("INSERT INTO hashtag_media (hashtag_id, media_id) VALUES ($1, $2)", [
        hashtagId,
        id,
      ]);
    };
    await insert("test_read_1", "2026-01-01T00:00:01Z");
    await insert("test_read_2", "2026-01-01T00:00:02Z");
    await insert("test_read_3", "2026-01-01T00:00:03Z");
  });

  afterAll(async () => {
    if (dbUp) await clean();
    await pool.end();
  });

  it("returns newest-first and paginates by cursor", async (ctx) => {
    if (!dbUp) return ctx.skip();

    const p1 = await readHashtagMedia(pool, { hashtagName: NAME, limit: 2 });
    expect(p1.rows.map((r) => r.media_id)).toEqual(["test_read_3", "test_read_2"]);
    expect(p1.nextCursor).not.toBeNull();

    const p2 = await readHashtagMedia(pool, { hashtagName: NAME, limit: 2, before: p1.nextCursor! });
    expect(p2.rows.map((r) => r.media_id)).toEqual(["test_read_1"]);
    expect(p2.nextCursor).toBeNull();
  });
});
