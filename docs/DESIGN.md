# Design — Hashtag Tracking Pipeline

Ingestion pipeline for Instagram hashtag media (`matcha`): fetch from Meta, store
metadata in Postgres, upload assets to storage, dedup, and expose a paginated
read API. Every 3 hours it re-syncs recent media.

## Goals & non-goals

- **Goal:** clear engineering judgment, clean seams, runnable in one command.
- **Non-goal:** a live production deployment. The AWS path is *wired but not
  deployed* — it exists to prove the design swaps cleanly, not to run in the cloud.

## Architecture — local-first with an adapter seam

The domain logic never knows which environment it runs in. A single env var,
`STAGE` (`local` | `production`), is read **once** in a composition root that
builds the concrete adapters and injects them. Nothing downstream reads `STAGE`.

| Concern    | `local`                      | `production` (wired, not deployed)   |
| ---------- | ---------------------------- | ------------------------------------ |
| Queue      | in-memory (SQS-shaped)       | AWS SQS                              |
| Storage    | local filesystem             | AWS S3                              |
| Scheduler  | node-cron                    | EventBridge → Lambda                |
| Runtime    | one Express process          | Lambda entrypoints sharing `core/`  |

**Key insight:** `STAGE` selects *adapters*, not *how the whole thing runs*. Local is one
long-lived process. Production is 2–3 Lambda entrypoints (scheduler, SQS worker,
API) that import the same `core/` services with SQS/S3 adapters. Scheduling in
production is infra (an EventBridge rule), not an in-process object — so there is
no "Scheduler" class in prod, just a Lambda entrypoint calling the same handler.

### Module layout

```
src/
  core/                     # adapter-blind domain logic
    ports.ts                # Queue, Storage interfaces — the only two swap seams
    meta/
      meta-client.ts        # fetch top_media/recent_media, paginate, adaptive limit
      schemas.ts            # Zod schemas for Meta responses
    services/
      media-service.ts      # upsert + dedup + junction writes
      sync.ts               # runTopSync(deps), runRecentSync(deps)
      asset.ts              # FETCH_ASSET handler: download -> upload -> update row
      read-media.ts         # keyset-paginated read query
  db/                       # infrastructure: not domain logic
    pool.ts                 # pg pool
    migrations/             # node-pg-migrate SQL up/down
  adapters/
    local/
      in-memory-queue.ts    # SQS-shaped: enqueue -> poll -> handle -> ack
      local-file-storage.ts
    aws/
      sqs-queue.ts
      s3-storage.ts
  api/
    routes.ts               # GET /hashtags
    schema.ts               # Zod for query params (limit, next_cursor)
  config.ts                 # reads STAGE ONCE -> builds & injects adapters
  entrypoints/
    local.ts                # Express + node-cron + in-process poll loop
```

The production setup below is **documented, not written** — there are no Lambda
entrypoint files. The seams that make them a thin wiring layer *do* exist (the
SQS/S3 adapters, and `core/` services that take injected deps), so the prod path is:

```
  entrypoints/lambda/        # NOT built — the shape a prod deploy would take
    scheduler.ts             # EventBridge -> runRecentSync directly (not via the queue)
    worker.ts                # SQS -> asset handler
    api.ts                   # API Gateway -> Express (e.g. serverless-http)
```

`db/` moved out of `core/` — the pool and migrations are infrastructure, not
domain logic, so the domain services depend on a passed-in client, not on `db/`.

## Data model

Three tables. Media is global (dedup on Meta's `media_id`); hashtag membership is
a relationship, not a property of the post — hence the junction.

```
hashtags
  id             PK
  ig_hashtag_id  TEXT   -- from ig_hashtag_search; cached so we don't re-resolve
  name           TEXT   -- 'matcha'
  created_at, updated_at

media                    -- core table, one row per real post
  media_id        TEXT PK     -- Meta's global id; dedup lives here. TEXT, not bigint (opaque ids)
  media_type      TEXT        -- IMAGE | VIDEO | CAROUSEL_ALBUM (unconstrained in DB; Zod gates it)
  posted_at       TIMESTAMPTZ -- IG post time (Meta's `timestamp`; renamed — reserved word)
  caption         TEXT NULL
  permalink       TEXT NULL
  media_url       TEXT NULL   -- Meta's ephemeral CDN link; stored, never exposed
  like_count      INT NULL
  comments_count  INT NULL
  asset_status    TEXT        -- pending | done | failed | no_asset
  storage_key     TEXT NULL   -- our storage object key; URL derived at read time
  created_at      TIMESTAMPTZ -- our ingest time (audit only)
  updated_at      TIMESTAMPTZ

hashtag_media            -- junction (media <-> hashtag is many-to-many in Meta)
  hashtag_id  FK -> hashtags(id)
  media_id    FK -> media(media_id)
  PRIMARY KEY (hashtag_id, media_id)
```

### Field rationale (what we keep and why)

- **`media_id` as PK / TEXT:** dedup key, and Meta ids are opaque — don't assume
  numeric range.
- **`asset_status`:** `pending` (asset queued), `done` (uploaded), `failed` (had a
  URL, transfer errored through all retries), `no_asset` (Meta gave no
  downloadable URL — e.g. a recent_media album). Distinguishing the last two
  matters: one is a failure to retry, the other is "nothing to fetch."
- **`storage_key`, not `storage_url`:** decouples stored data from host/bucket/CDN.
  The URL is a pure function of the adapter, resolved via `Storage.getUrl(key)` at
  read time. Change the bucket → no data migration.
- **`media_url` kept but never exposed:** it's a signed, rotating, short-lived CDN
  link. Serving it would hand clients dead links. We serve our own `storage_url`.
- **`like_count` / `comments_count`:** latest value only, no history table — we
  don't track engagement-over-time; the read API returns current counts.
- **No `watermark` / sync-state column:** see tradeoffs.
- **No `children`:** carousels return one cover image in `media_url`; fetching
  children adds calls for no read-API value.

## Ingestion pipeline

Two-phase, because fetching metadata and transferring binaries are different
failure domains and shouldn't share a fate.

```
node-cron (local) / EventBridge (prod), every 3h
  └─ runRecentSync — called DIRECTLY, not via the queue
       └─ paginate recent_media newest-first (cap 500)
            └─ per page: upsert metadata rows (fill-forward), commit
                 └─ per new/incomplete media with a URL: enqueue FETCH_ASSET  ← the only thing on the queue
                      └─ asset worker: download -> upload -> UPDATE row (storage_key, done)
                           └─ on failure: mark asset_status = failed (no auto-retry)
```

Top media is synced once on startup, recent media every 3h.

**The queue carries only `FETCH_ASSET`.** Syncs are triggered by the scheduler and run
directly (a plain function call), so a long sync never blocks asset downloads behind it and
a big download never blocks a sync — with a single worker, routing syncs through the queue
would serialize them. In prod the same shape holds: EventBridge triggers the sync directly;
SQS carries only the asset jobs.

### Per-page commit

Upsert each page and enqueue its `FETCH_ASSET` jobs *before* requesting the next
page. Progress is durable if pagination dies mid-run, and memory stays bounded
(never hold 500 items at once).

### Upsert semantics — fill-forward, never regress

Re-syncs overlap heavily (recent_media is a rolling ~24h window). The
`INSERT ... ON CONFLICT (media_id) DO UPDATE` is a conditional merge:

- `media_url = COALESCE(new.media_url, old.media_url)` — gain a URL, never null one out.
- `asset_status = CASE WHEN old = 'no_asset' AND new.media_url IS NOT NULL
  THEN 'pending' ELSE old END` — promote only; never knock a `done` row back.
- Refresh mutable metadata (`caption`, `like_count`, `comments_count`).
- `created_at` untouched; `updated_at = now()`.
- Enqueue `FETCH_ASSET` only on insert or a `no_asset → pending` promotion
  (detected via `RETURNING`); the worker skips anything already `done`.
- Junction upsert is `ON CONFLICT DO NOTHING`.

### Idempotency (SQS is at-least-once)

- Metadata: upsert on `media_id`.
- Asset: deterministic key `{media_id}.{ext}` (the file name) — a re-run overwrites
  the same object, no orphans. Skip early if `asset_status = 'done'`. Locally the key
  is served under `/media/<key>`; on S3 it's the object key. `storage_key` in the DB
  holds the key; `Storage.getUrl(key)` resolves the URL per adapter at read time.
- Extension / content-type derived from the download response `Content-Type`
  header, not from `media_type`.

### Adaptive page size

Meta's `top_media` rejects large payloads (`limit × fields`): observed `limit=5`
failing, `limit=2` passing with all fields. On that error: halve the limit and
re-request the **same cursor**, floor at 1, cap ~3–5 retries, then log-and-skip
the page rather than failing the whole sync.

## Read API

`GET /hashtags` — stored media, newest first.

**Ordering — `posted_at`, not `created_at`.** The spec says "descending order of
creation time." We read that as the post's creation time (`posted_at`, Meta's
`timestamp`), not our ingest time (`created_at`). Reason: a bulk sync inserts a
whole page within the same second, so `created_at` collapses to near-ties and the
order within a sync degrades to `media_id`; `posted_at` is the stable, meaningful
"newest posts first" a consumer expects. `created_at` is still stored (audit) and
could back a second ordering if ever needed.

**Query params:** `limit` (int, default 25, 1–100; `<1` or `>100` → 400, not
clamped), `next_cursor` (opaque base64url token; malformed → 400).

**Pagination:** keyset on `(posted_at DESC, media_id DESC)` — newest posts first.
The cursor encodes both values (a bare timestamp is unsafe — posts can share a
`posted_at` second; `media_id` is the tiebreaker). Query fetches `limit + 1` to
compute `next_cursor` without a `COUNT`.

**Response:**

```jsonc
{
  "data": [
    {
      "media_id": "…", "media_type": "…", "timestamp": "…",
      "caption": "…", "permalink": "…",
      "storage_url": "…",        // derived from storage_key; null unless asset_status = done
      "asset_status": "done",
      "like_count": 0, "comments_count": 0,
      "created_at": "…"
    }
  ],
  "next_cursor": "…"             // null when no more pages
}
```

Hidden from the response: `media_url` (dead CDN link), `updated_at`, internal PKs.
`asset_status` is exposed so a `null` `storage_url` reads as "not ready," not "broken."

All params parse through one Zod schema at the route boundary; a parse failure → 400.

## Known limitations

- **>24h downtime gap:** recent_media only covers ~24h. If the app is down longer,
  media that aged out is unrecoverable. Inherent to the API.
- **media_url expiry:** if a `FETCH_ASSET` sits too long (queue backlog / DLQ), the
  signed URL dies and retries fail identically. Recovery would be re-fetching the
  URL from Meta first — out of scope; such rows land at `failed`.
- **No live deploy:** AWS entrypoints/adapters are written and swappable but not
  deployed; there is no IaC.
- **No Meta token → skip:** if no token is present, the sync logs
  `META token missing — add token to .env` and skips. No fixture/replay fallback.
