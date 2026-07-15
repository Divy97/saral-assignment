# Hashtag Tracking Pipeline

Ingestion pipeline for Instagram hashtag media (`matcha`): fetch from Meta's Graph API,
store metadata in Postgres, download assets to storage, dedup, and expose a paginated
read API. Recent media re-syncs every 3 hours.

## Quick start

```bash
docker compose up
```

That's it — this brings up Postgres + the app, runs migrations on boot, syncs top media
on startup, and schedules the recent-media sync every 3 hours. Then:

```bash
curl 'http://localhost:3000/hashtags?limit=25'
```

**Meta token:** ingestion calls the real Meta API. Add your credentials to `.env`
(copy from `.env.example`):

```
META_ACCESS_TOKEN=<your token>
META_USER_ID=<your ig business account id>
```

Without a token the app still boots and serves the read API — the sync just logs a skip
message. See [`instructions.md`](./instructions.md) for full setup and env vars.

## What it does

```
cron / boot ──> sync (paginate Meta, per-page commit)
                  ├─ upsert metadata (dedup on media_id, fill-forward)
                  └─ enqueue FETCH_ASSET per new/incomplete media
                        └─ worker: download → storage → mark done
GET /hashtags ──> keyset-paginated read (newest first), storage URLs resolved at read time
```

## Read API

`GET /hashtags` — stored media, newest first.

| Param | Default | Notes |
| --- | --- | --- |
| `limit` | 25 | 1–100; out of range → 400 |
| `next_cursor` | — | opaque cursor from the previous response; malformed → 400 |

Returns `{ "data": [...], "next_cursor": "..." | null }`. Each item exposes `media_id`,
`media_type`, `timestamp`, `caption`, `permalink`, `storage_url` (null until the asset is
downloaded), `asset_status`, `like_count`, `comments_count`, `created_at`.

## Architecture

Local-first with a clean adapter seam. A single `STAGE` env var (`local` | `production`)
is read **once** in a composition root that builds the concrete adapters and injects them —
nothing downstream knows which environment it runs in.

| Concern | `local` | `production` (wired, not deployed) |
| --- | --- | --- |
| Queue | in-memory (SQS-shaped) | AWS SQS |
| Storage | local filesystem | AWS S3 |
| Scheduler | node-cron | EventBridge |

See [`docs/DESIGN.md`](./docs/DESIGN.md) for the full design, data model, and tradeoffs.

## Tech stack

Node + TypeScript · Express · Postgres (`pg`, `node-pg-migrate`, no ORM) · Zod ·
node-cron · Docker. AWS adapters use `@aws-sdk/client-s3` / `client-sqs` (production path only).

## Scripts

```bash
pnpm dev            # run locally with hot reload (needs Postgres + .env)
pnpm test           # run the test suite (vitest)
pnpm typecheck      # tsc --noEmit
pnpm migrate:up     # apply migrations
pnpm build          # compile to dist/
```

## Docs

- [`instructions.md`](./instructions.md) — setup, environment variables, tradeoffs, AI usage
- [`docs/DESIGN.md`](./docs/DESIGN.md) — architecture, data model, pipeline, known limitations
