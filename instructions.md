# Instructions

Hashtag tracking pipeline for Instagram `matcha` media. Full architecture and  
decision record: [docs/DESIGN.md](docs/DESIGN.md).  
ai usage : how I used AI (`[instructions.md#ai-usage](./instructions.md#ai-usage)`) plus the exported chat history: [brainstorming](./docs/ai-usage/brain_storming.txt)  and[implementation](./docs/ai-usage/implementation.txt)

## setup

```bash
cp .env.example .env        # add META_ACCESS_TOKEN + META_USER_ID
docker compose up           # Postgres + app; migrations run on boot
```

The read API is then at `http://localhost:3000/hashtags`.

To run on the host instead of Docker (needs a local Postgres on `DATABASE_URL`):

```bash
pnpm install
cp .env.example .env        # add META_ACCESS_TOKEN + META_USER_ID
pnpm migrate:up             # apply migrations
pnpm dev                    # watch mode; or `pnpm build && pnpm start`
```

Without a Meta token the app still boots and serves the (empty) read API; syncs
log `META token missing — add token to .env` and skip.

## vars


| Var                 | Stage      | Purpose                                                  |
| ------------------- | ---------- | -------------------------------------------------------- |
| `STAGE`             | both       | `local`                                                  |
| `PORT`              | both       | HTTP port (default 3000)                                 |
| `DATABASE_URL`      | both       | Postgres connection string                               |
| `META_ACCESS_TOKEN` | both       | Instagram page token; absent → syncs skip                |
| `META_USER_ID`      | both       | IG business `user_id` for hashtag search                 |
| `SYNC_CRON`         | local      | Recent-sync schedule (default `0 */3 * * *`)             |
| `MEDIA_DIR`         | local      | Local asset directory                                    |
| `PUBLIC_BASE_URL`   | local      | Base for deriving `storage_url` from `storage_key`       |
| `AWS_REGION`        | production | AWS region, e.g. `us-east-1`. Leave unset for local      |
| `SQS_QUEUE_URL`     | production | Full SQS queue URL for asset jobs. Leave unset for local |
| `S3_BUCKET`         | production | S3 bucket for stored assets. Leave unset for local       |




## tradeoffs

- **AWS wired, not deployed.** The SQS and S3 adapters are written and swap in via
`STAGE`, but nothing is actually deployed and there's no IaC. `STAGE` only picks the
adapters. The prod stack (EventBridge to Lambda, SQS worker, API Lambda) is documented,
not built. The Lambda entrypoints aren't written, but the seams that make them thin
wiring are.
- **Scheduling is different per stage.** node-cron locally, EventBridge in prod. Not just
an SDK swap, it's a different runtime. The sync is a plain function so it drops into a
Lambda as is.
- **No watermark / early-stop.** Dedup comes from the upsert and `asset_status`, so we
never re-download. The 500 cap means early-stop doesn't help a high-volume hashtag, and
for a low-volume one the overlap is cheap anyway. A watermark would just be extra state
that can drift, for no real gain.
- **We don't refresh** `media_url` **on expiry.** If an asset doesn't transfer before the
signed URL dies, the row goes to `asset_status = failed` and we don't re-fetch it.
- **Carousel children not fetched.** We only store the cover image (`media_url`).
- **Like/comment counts are latest value only.** No history, no time-series.
- **No Meta fixture/replay.** Real API if a token is there, otherwise we just skip and log.
- **Queue only carries asset downloads, syncs run directly.** Syncs run as a plain function
call (boot / cron), never through the queue. So a long sync and a big download don't block
each other, and there's no risk of a minutes-long job blowing past an SQS visibility timeout
and getting redelivered. With one worker, assets download one at a time, so a slow video only
delays that asset showing up, never the metadata (committed per page) or the read API.
Scaling is additive, just raise asset concurrency or add more consumers (Lambda). Not built,
one worker is enough at this scale.
- **A very large sync would need per-page jobs.** Right now a sync paginates in one run, which
is fine for ~500 items / a few pages. If a hashtag ever fanned out so far that one run could
hit the SQS visibility timeout, I'd split pagination into per-page jobs that re-enqueue the
next `after` cursor (each unit small, retried per page). That needs FIFO + dedup (or a DB
cursor guard) so at-least-once redelivery can't fork the chain into parallel paginations.
Skipped for now, not needed at this scale.
- **Local storage atomic write assumes one writer.** `put` streams to a fixed `{key}.tmp` then
renames (atomic publish). Safe with one worker, only one write per key at a time. With
multiple workers, SQS redelivery could have two writers hit the same temp file and corrupt it.
Fix is a unique suffix (`{key}.{uuid}.tmp`). One-line change, skipped along with the
single-worker decision.



## ai-usage

- **Tool:** Claude Code (Opus).
- **Used it for:** brainstorming the design (local vs AWS, the adapter seam, the
two-phase pipeline, dedup/upsert, the data model, the read-API shape), checking
Meta's hashtag endpoint fields against the official docs, and writing the
implementation.
- **What I did myself:** I did every design decision and pushed back where I didn't
agree (rejecting the watermark, picking `storage_key` over `storage_url`, the junction
table, the opaque cursor). You can understand this better if you check conversation history, I reviewed and tested all the code.
- **Chat history:** two exported sessions, [brainstorming](docs/ai-usage/brain_storming.txt) and [implementation](docs/ai-usage/implementation.txt).

