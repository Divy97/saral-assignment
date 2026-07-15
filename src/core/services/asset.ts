import { Readable } from "node:stream";
import type { Pool } from "pg";
import type { Storage } from "../ports.js";

export interface AssetContext {
  pool: Pool;
  storage: Storage;
}

const DOWNLOAD_TIMEOUT_MS = 120_000; // assets (esp. videos) can be large; guard against a hung download

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

/** File extension from the response Content-Type — differentiates video vs image. */
function extFromContentType(contentType: string | null): string {
  const base = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (EXT_BY_CONTENT_TYPE[base]) return EXT_BY_CONTENT_TYPE[base];
  if (base.startsWith("video/")) return "mp4";
  if (base.startsWith("image/")) return "jpg";
  return "bin";
}

type AssetRow = { media_url: string | null; asset_status: string; storage_key: string | null };

/**
 * FETCH_ASSET handler: download a media's asset and store it under `{media_id}.{ext}`.
 *
 * Idempotent — skips if the row is already `done`. Never crashes the worker: a download or
 * upload failure is logged and the row is marked `failed`, then we move on (no auto-retry).
 * We store the storage KEY, not a URL — the read API derives the URL from it.
 */
export async function handleFetchAsset(mediaId: string, ctx: AssetContext): Promise<void> {
  const { pool, storage } = ctx;

  const { rows } = await pool.query<AssetRow>(
    "SELECT media_url, asset_status, storage_key FROM media WHERE media_id = $1",
    [mediaId],
  );
  const row = rows[0];
  if (!row) {
    console.warn(`[asset] ${mediaId}: no media row — skipping`);
    return;
  }
  if (row.asset_status === "done") return; // already stored (idempotent on redelivery)
  if (!row.media_url) {
    console.warn(`[asset] ${mediaId}: pending row has no media_url — marking no_asset`);
    await pool.query(
      "UPDATE media SET asset_status = 'no_asset', updated_at = now() WHERE media_id = $1",
      [mediaId],
    );
    return;
  }

  try {
    console.log(`[asset] ${mediaId}: downloading ${row.media_url.slice(0, 60)}…`);
    const res = await fetch(row.media_url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok || !res.body) throw new Error(`download failed with HTTP ${res.status}`);

    const contentType = res.headers.get("content-type");
    const key = `${mediaId}.${extFromContentType(contentType)}`;
    await storage.put(key, Readable.fromWeb(res.body), contentType ?? "application/octet-stream");

    await pool.query(
      "UPDATE media SET storage_key = $2, asset_status = 'done', updated_at = now() WHERE media_id = $1",
      [mediaId, key],
    );
    console.log(`[asset] ${mediaId}: stored as ${key}`);
  } catch (err) {
    // Never crash the worker — mark failed and move on.
    console.error(`[asset] ${mediaId}: download/upload failed —`, err instanceof Error ? err.message : err);
    await pool
      .query("UPDATE media SET asset_status = 'failed', updated_at = now() WHERE media_id = $1", [mediaId])
      .catch((e) => console.error(`[asset] ${mediaId}: could not mark failed —`, e));
  }
}
