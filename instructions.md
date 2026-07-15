# Instructions

Hashtag tracking pipeline for Instagram `matcha` media. Full architecture and
decision record: [`docs/DESIGN.md`](docs/DESIGN.md).

## setup

> Finalized once the implementation runs end to end. Intended flow:

```bash
pnpm install
cp .env.example .env        # add META_ACCESS_TOKEN + META_USER_ID
docker compose up           # Postgres + app; migrations run on boot
```

Read API then at `http://localhost:3000/hashtags`.

Without a Meta token the app still boots and serves the (empty) read API; syncs
log `META token missing — add token to .env` and skip.

## vars

| Var                 | Stage        | Purpose                                            |
| ------------------- | ------------ | -------------------------------------------------- |
| `STAGE`             | both         | `local` \| `production` — selects adapters         |
| `PORT`              | both         | HTTP port (default 3000)                           |
| `DATABASE_URL`      | both         | Postgres connection string                         |
| `META_ACCESS_TOKEN` | both         | Instagram page token; absent → syncs skip          |
| `META_USER_ID`      | both         | IG business `user_id` for hashtag search           |
| `SYNC_CRON`         | local        | Recent-sync schedule (default `0 */3 * * *`)       |
| `MEDIA_DIR`         | local        | Local asset directory                              |
| `PUBLIC_BASE_URL`   | local        | Base for deriving `storage_url` from `storage_key` |
| `AWS_REGION`        | production   | —                                                  |
| `SQS_QUEUE_URL`     | production   | —                                                  |
| `S3_BUCKET`         | production   | —                                                  |

## tradeoffs

- **AWS wired, not deployed.** SQS/S3 adapters and Lambda entrypoints exist and
  swap via `STAGE`, but nothing is deployed and there is no IaC. `STAGE` selects
  adapters; the production *topology* (EventBridge → Lambda, SQS-triggered worker,
  API Lambda) is documented, not running.
- **Scheduling differs by stage.** node-cron locally, EventBridge in prod — not an
  SDK swap but a different runtime. The sync logic is a plain handler so it drops
  into a Lambda unchanged.
- **No watermark / incremental early-stop.** Correctness comes from upsert (dedup)
  + `asset_status` (no re-download). The 500-item cap makes an early-stop moot for
  a high-volume hashtag, and the overlap is cheap for a low-volume one — so a
  watermark would be state that can drift for no gain.
- **`media_url` not refreshed on expiry.** Assets that fail to transfer before the
  signed URL dies land at `asset_status = failed` and are not re-fetched.
- **Carousel children not fetched.** Only the cover image (`media_url`) is stored.
- **Engagement counts are latest-value only.** No history/time-series.
- **No Meta fixture/replay.** Real API when a token is present; skip + log otherwise.
- **Queue carries only asset downloads; syncs run directly.** Syncs run as a plain call
  (boot / cron), never through the queue — so a long sync and a big download never block
  each other, and there's no risk of a minutes-long job exceeding an SQS visibility timeout
  and being redelivered. With one worker, assets download serially: a slow video only delays
  *asset availability*, never metadata (committed per page) or the read API. Scaling is
  additive — raise asset concurrency / add consumers (Lambda). Not built; one worker suffices
  at assignment scale.
- **A very large sync would need cursor-chained page jobs.** A sync paginates in one direct
  run — fine for ~500 items / a few pages. If a hashtag ever fanned out so far that one run
  risked the SQS visibility timeout, pagination would split into per-page jobs that re-enqueue
  the next `after` cursor (each unit short, retried per page). That needs FIFO + dedup (or a DB
  cursor guard) so at-least-once redelivery can't fork the chain into parallel paginations.
  Deferred — unnecessary at this scale.
- **Local storage atomic write assumes a single writer.** `put` streams to a fixed
  `{key}.tmp` then renames (atomic publish). Safe with one worker — one write per key
  at a time. With multiple workers, SQS at-least-once redelivery could have two writers
  hit the same temp file and corrupt it; the fix is a unique suffix (`{key}.{uuid}.tmp`).
  One-line change, deferred alongside the single-worker decision.

## ai-usage

> Draft — the candidate finalizes before submission.

- **Tool:** Claude Code (Opus).
- **Used for:** interactive design discussion — evaluating local vs AWS,
  the adapter seam, the two-phase ingestion pipeline, dedup/upsert semantics,
  data model, and the read-API contract; verifying Meta hashtag-endpoint field
  behavior against the official docs; and implementation.
- **Reviewed/decided by the candidate:** every architectural decision was
  driven, pushed back on, and finalized by the candidate (e.g. rejecting the
  watermark, choosing `storage_key` over `storage_url`, the junction table,
  the opaque cursor). Code reviewed and tested by the candidate.
