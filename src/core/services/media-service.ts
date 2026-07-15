import type { Pool } from "pg";
import type { MediaItem } from "../meta/schemas.js";

// media_id, media_type, posted_at, caption, permalink, media_url, like_count, comments_count, asset_status
const MEDIA_COLS = 9;

type UpsertRow = { media_id: string; asset_status: string; storage_key: string | null };

/** A new row is `pending` when Meta gave a downloadable url, else `no_asset` (nothing to fetch). */
function initialAssetStatus(mediaUrl: string | null | undefined): "pending" | "no_asset" {
  return mediaUrl ? "pending" : "no_asset";
}

/**
 * Meta can repeat a media_id within a page, and a single `ON CONFLICT DO UPDATE` cannot touch
 * the same row twice ("cannot affect row a second time"). Collapse to one row per id (last wins).
 */
function dedupeById(items: MediaItem[]): MediaItem[] {
  const byId = new Map<string, MediaItem>();
  for (const it of items) byId.set(it.id, it);
  return [...byId.values()];
}

/** Upsert the tracked hashtag and return our internal id (the junction FK). */
export async function ensureHashtag(
  pool: Pool,
  params: { igHashtagId: string; name: string },
): Promise<number> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO hashtags (ig_hashtag_id, name)
     VALUES ($1, $2)
     ON CONFLICT (ig_hashtag_id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
     RETURNING id`,
    [params.igHashtagId, params.name],
  );
  const row = result.rows[0];
  if (!row) throw new Error("ensureHashtag returned no row");
  return Number(row.id); // BIGSERIAL comes back as a string; a hashtag id is tiny, safe as a number
}

/**
 * Upsert a page of media and link it to the hashtag, in one transaction (per-page commit).
 *
 * Dedup + fill-forward: on conflict we refresh metadata but keep existing values when Meta
 * sends null (COALESCE), never touch storage_key/created_at, and only promote asset_status
 * from no_asset -> pending when a media_url first appears. A new row starts pending if it has
 * a url, else no_asset.
 *
 * Returns the media_ids that need a FETCH_ASSET job (pending with no stored asset yet).
 */
export async function upsertMediaPage(
  pool: Pool,
  hashtagId: number,
  items: MediaItem[],
): Promise<string[]> {
  if (items.length === 0) return [];
  const uniqueItems = dedupeById(items);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const mediaRows: string[] = [];
    const mediaParams: unknown[] = [];
    uniqueItems.forEach((it, i) => {
      const b = i * MEDIA_COLS;
      mediaRows.push(
        `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9})`,
      );
      mediaParams.push(
        it.id,
        it.media_type,
        it.timestamp,
        it.caption ?? null,
        it.permalink ?? null,
        it.media_url ?? null,
        it.like_count ?? null,
        it.comments_count ?? null,
        initialAssetStatus(it.media_url),
      );
    });

    const result = await client.query<UpsertRow>(
      `INSERT INTO media
         (media_id, media_type, posted_at, caption, permalink, media_url, like_count, comments_count, asset_status)
       VALUES ${mediaRows.join(", ")}
       ON CONFLICT (media_id) DO UPDATE SET
         media_type     = EXCLUDED.media_type,
         caption        = COALESCE(EXCLUDED.caption, media.caption),
         permalink      = COALESCE(EXCLUDED.permalink, media.permalink),
         media_url      = COALESCE(EXCLUDED.media_url, media.media_url),
         like_count     = COALESCE(EXCLUDED.like_count, media.like_count),
         comments_count = COALESCE(EXCLUDED.comments_count, media.comments_count),
         asset_status   = CASE
           WHEN media.asset_status = 'no_asset' AND EXCLUDED.media_url IS NOT NULL THEN 'pending'
           ELSE media.asset_status
         END,
         updated_at     = now()
       RETURNING media_id, asset_status, storage_key`,
      mediaParams,
    );

    // Link each media to the hashtag (hashtag_id fixed at $1).
    const junctionRows = uniqueItems.map((_, i) => `($1, $${i + 2})`);
    await client.query(
      `INSERT INTO hashtag_media (hashtag_id, media_id)
       VALUES ${junctionRows.join(", ")}
       ON CONFLICT (hashtag_id, media_id) DO NOTHING`,
      [hashtagId, ...uniqueItems.map((it) => it.id)],
    );

    await client.query("COMMIT");

    return result.rows
      .filter((r) => r.asset_status === "pending" && r.storage_key === null)
      .map((r) => r.media_id);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
