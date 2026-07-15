import express, { type Router } from "express";
import type { Pool } from "pg";
import type { Storage } from "../core/ports.js";
import {
  readHashtagMedia,
  encodeCursor,
  decodeCursor,
  type MediaRow,
  type ReadCursor,
} from "../core/services/read-media.js";
import { listQuerySchema } from "./schema.js";

export interface HashtagsRouterDeps {
  pool: Pool;
  storage: Storage;
  hashtagName: string;
}

interface ListResult {
  status: number;
  body: unknown;
}

/** Shape a DB row for the response: posted_at -> timestamp, storage_key -> storage_url. */
function serialize(row: MediaRow, storage: Storage) {
  return {
    media_id: row.media_id,
    media_type: row.media_type,
    timestamp: row.posted_at.toISOString(),
    caption: row.caption,
    permalink: row.permalink,
    storage_url: row.storage_key ? storage.getUrl(row.storage_key) : null,
    asset_status: row.asset_status,
    like_count: row.like_count,
    comments_count: row.comments_count,
    created_at: row.created_at.toISOString(),
  };
}

/**
 * GET /hashtags handler as a plain function (framework-agnostic, easy to test): validate
 * params, decode the cursor, read a keyset page, serialize. Never throws — returns a status
 * + body. media_url is never exposed; storage_url is derived from storage_key.
 */
export async function getHashtagMedia(deps: HashtagsRouterDeps, rawQuery: unknown): Promise<ListResult> {
  const parsed = listQuerySchema.safeParse(rawQuery);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "invalid query params" } };
  }
  const { limit, next_cursor, hashtag } = parsed.data;
  const hashtagName = hashtag || deps.hashtagName; // param overrides the default; empty -> default

  let before: ReadCursor | undefined;
  if (next_cursor !== undefined) {
    const decoded = decodeCursor(next_cursor);
    if (!decoded) return { status: 400, body: { error: "invalid next_cursor" } };
    before = decoded;
  }

  try {
    const result = await readHashtagMedia(deps.pool, { hashtagName, limit, before });
    return {
      status: 200,
      body: {
        data: result.rows.map((row) => serialize(row, deps.storage)),
        next_cursor: result.nextCursor ? encodeCursor(result.nextCursor) : null,
      },
    };
  } catch (err) {
    console.error("[api] GET /hashtags failed —", err);
    return { status: 500, body: { error: "internal error" } };
  }
}

export function createHashtagsRouter(deps: HashtagsRouterDeps): Router {
  const router = express.Router();
  router.get("/hashtags", async (req, res) => {
    const { status, body } = await getHashtagMedia(deps, req.query);
    res.status(status).json(body);
  });
  return router;
}
