import "dotenv/config";
import express from "express";
import { schedule } from "node-cron";
import { buildDeps } from "../config.js";
import { createHashtagsRouter } from "../api/routes.js";
import { runTopSync, runRecentSync, type SyncContext } from "../core/services/sync.js";
import { handleFetchAsset } from "../core/services/asset.js";
import type { MetaConfig } from "../core/meta/meta-client.js";

const deps = await buildDeps(); // reads STAGE once -> { stage, pool, queue, storage }

const meta: MetaConfig = {
  accessToken: process.env.META_ACCESS_TOKEN ?? "",
  userId: process.env.META_USER_ID ?? "",
  maxItems: Number(process.env.META_MAX_ITEMS) || 500, // per-sync cap; spec target 500, lower for a quick demo
};
const hashtagName = process.env.HASHTAG ?? "matcha";
const mediaDir = process.env.MEDIA_DIR ?? "./media";
const syncCron = process.env.SYNC_CRON ?? "0 */3 * * *";
const port = Number(process.env.PORT ?? 3000);

const syncCtx: SyncContext = { pool: deps.pool, queue: deps.queue, meta, hashtagName };

// Worker: the queue carries only asset downloads. Runs concurrently with the syncs below,
// so a long sync never blocks downloads and a big download never blocks a sync.
deps.queue.consume((job) => handleFetchAsset(job.mediaId, { pool: deps.pool, storage: deps.storage }));

// Syncs run DIRECTLY (not via the queue): top media once on boot, recent media every 3h.
// Each enqueues FETCH_ASSET jobs for the worker to drain. Fire-and-forget so boot/cron don't block.
console.log(`[boot] stage=${deps.stage} hashtag=#${hashtagName} cron="${syncCron}" mediaDir=${mediaDir}`);
console.log("[boot] running SYNC_TOP");
void runTopSync(syncCtx);
schedule(syncCron, () => {
  console.log("[cron] schedule fired — running SYNC_RECENT");
  void runRecentSync(syncCtx);
});

// HTTP
const app = express();

app.get("/health", async (_req, res) => {
  try {
    await deps.pool.query("SELECT 1");
    res.json({ status: "ok", db: "up" });
  } catch (err) {
    console.error("health check failed", err);
    res.status(503).json({ status: "error", db: "down" });
  }
});

// serve locally-stored assets so storage_url (base + /media/<key>) resolves
app.use("/media", express.static(mediaDir));
app.use(createHashtagsRouter({ pool: deps.pool, storage: deps.storage, hashtagName }));

app.listen(port, () => {
  console.log(`[local] listening on :${port} (stage=${deps.stage}, hashtag=${hashtagName})`);
});
