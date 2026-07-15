import type { Pool } from "pg";
import type { Queue } from "../ports.js";
import {
  fetchRecentMedia,
  fetchTopMedia,
  searchHashtagId,
  MetaCredentialsMissingError,
  type MetaConfig,
} from "../meta/meta-client.js";
import { ensureHashtag, upsertMediaPage } from "./media-service.js";

export interface SyncContext {
  pool: Pool;
  queue: Queue;
  meta: MetaConfig;
  hashtagName: string; // "matcha"
}

type SyncKind = "top" | "recent";

/**
 * Resolve the hashtag id, then walk its media newest-first. For each page we upsert the
 * metadata and enqueue a FETCH_ASSET for every media that needs its asset — the generator
 * only fetches the next page once the current page's jobs are queued.
 *
 * Never throws: missing credentials or any other error is logged and the run stops with
 * whatever pages already committed (per-page commit means partial progress is kept).
 */
async function runSync(kind: SyncKind, ctx: SyncContext): Promise<void> {
  const label = kind === "top" ? "SYNC_TOP" : "SYNC_RECENT";
  try {
    const igHashtagId = await searchHashtagId(ctx.hashtagName, ctx.meta);
    if (!igHashtagId) {
      console.warn(`[sync] ${label}: hashtag "${ctx.hashtagName}" not found — stopping`);
      return;
    }

    const hashtagId = await ensureHashtag(ctx.pool, { igHashtagId, name: ctx.hashtagName });
    console.log(`[sync] ${label}: resolved #${ctx.hashtagName} (${igHashtagId}) — paginating media`);
    const pages =
      kind === "top" ? fetchTopMedia(igHashtagId, ctx.meta) : fetchRecentMedia(igHashtagId, ctx.meta);

    let pageCount = 0;
    let mediaCount = 0;
    let queued = 0;
    for await (const page of pages) {
      pageCount++;
      mediaCount += page.length;
      const toFetch = await upsertMediaPage(ctx.pool, hashtagId, page);
      for (const mediaId of toFetch) {
        await ctx.queue.enqueue({ type: "FETCH_ASSET", mediaId });
      }
      queued += toFetch.length;
      console.log(
        `[sync] ${label}: page ${pageCount} — ${page.length} media, ${toFetch.length} assets queued (running total ${mediaCount} media, ${queued} queued)`,
      );
    }

    console.log(
      `[sync] ${label}: done — ${mediaCount} media over ${pageCount} page(s), ${queued} asset job(s) queued`,
    );
  } catch (err) {
    if (err instanceof MetaCredentialsMissingError) return; // meta client already logged the skip
    console.error(`[sync] ${label}: stopped on error —`, err);
  }
}

export const runTopSync = (ctx: SyncContext): Promise<void> => runSync("top", ctx);
export const runRecentSync = (ctx: SyncContext): Promise<void> => runSync("recent", ctx);
