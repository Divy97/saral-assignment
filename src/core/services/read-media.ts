import type { Pool } from "pg";

// Raw DB shape. The route maps this to the response: posted_at -> timestamp,
// storage_key -> storage_url (via Storage.getUrl), and drops media_url/updated_at.
export type MediaRow = {
  media_id: string;
  media_type: string;
  posted_at: Date;
  caption: string | null;
  permalink: string | null;
  like_count: number | null;
  comments_count: number | null;
  asset_status: string;
  storage_key: string | null;
  created_at: Date;
};

export interface ReadCursor {
  postedAt: string; // ISO timestamp of the last row
  mediaId: string; // tiebreaker for rows sharing posted_at
}

export interface ReadResult {
  rows: MediaRow[];
  nextCursor: ReadCursor | null;
}

/**
 * A keyset page of a hashtag's media, newest first by (posted_at, media_id). Fetches
 * limit+1 rows to know whether there's a next page — no COUNT needed.
 */
export async function readHashtagMedia(
  pool: Pool,
  params: { hashtagName: string; limit: number; before?: ReadCursor },
): Promise<ReadResult> {
  const values: unknown[] = [params.hashtagName];
  const conditions = ["h.name = $1"];

  if (params.before) {
    values.push(params.before.postedAt, params.before.mediaId);
    conditions.push(
      `(m.posted_at, m.media_id) < ($${values.length - 1}::timestamptz, $${values.length})`,
    );
  }

  values.push(params.limit + 1);
  const limitPlaceholder = `$${values.length}`;

  const { rows } = await pool.query<MediaRow>(
    `SELECT m.media_id, m.media_type, m.posted_at, m.caption, m.permalink,
            m.like_count, m.comments_count, m.asset_status, m.storage_key, m.created_at
       FROM media m
       JOIN hashtag_media hm ON hm.media_id = m.media_id
       JOIN hashtags h ON h.id = hm.hashtag_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY m.posted_at DESC, m.media_id DESC
      LIMIT ${limitPlaceholder}`,
    values,
  );

  const hasMore = rows.length > params.limit;
  const page = hasMore ? rows.slice(0, params.limit) : rows;
  const last = page.at(-1);
  const nextCursor =
    hasMore && last ? { postedAt: last.posted_at.toISOString(), mediaId: last.media_id } : null;

  return { rows: page, nextCursor };
}

/** Opaque cursor = base64url("<postedAt ISO>|<media_id>"). */
export function encodeCursor(cursor: ReadCursor): string {
  return Buffer.from(`${cursor.postedAt}|${cursor.mediaId}`, "utf8").toString("base64url");
}

export function decodeCursor(token: string): ReadCursor | null {
  const decoded = Buffer.from(token, "base64url").toString("utf8");
  const sep = decoded.indexOf("|"); // postedAt is ISO (no "|"); media_id is everything after
  if (sep === -1) return null;
  const postedAt = decoded.slice(0, sep);
  const mediaId = decoded.slice(sep + 1);
  if (!postedAt || !mediaId || Number.isNaN(Date.parse(postedAt))) return null;
  return { postedAt, mediaId };
}
