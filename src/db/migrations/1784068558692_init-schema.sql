-- Up Migration

-- Tracked hashtags. One row per hashtag (just 'matcha' for now). Holds the
-- resolved Meta id so we don't re-call ig_hashtag_search on every sync.
CREATE TABLE hashtags (
  id            BIGSERIAL PRIMARY KEY,
  ig_hashtag_id TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Core table: one row per real Meta post, keyed on Meta's global id (the dedup key).
-- media_type is left unconstrained on purpose — Zod gates it on the way in, and an
-- unexpected type from Meta should not fail an insert. asset_status is ours, so it
-- gets a CHECK.
CREATE TABLE media (
  media_id       TEXT PRIMARY KEY,
  media_type     TEXT NOT NULL,
  posted_at      TIMESTAMPTZ NOT NULL,          -- Meta's `timestamp`; read-API ordering key (renamed: reserved word)
  caption        TEXT,
  permalink      TEXT,
  media_url      TEXT,                           -- Meta's ephemeral CDN link; never exposed
  like_count     INTEGER,
  comments_count INTEGER,
  asset_status   TEXT NOT NULL DEFAULT 'pending'
                   CHECK (asset_status IN ('pending', 'done', 'failed', 'no_asset')),
  storage_key    TEXT,                           -- our object key; URL derived at read time
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),  -- our ingest time (audit only)
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Serves the read API's keyset pagination: ORDER BY posted_at DESC, media_id DESC.
CREATE INDEX media_posted_at_media_id_idx ON media (posted_at DESC, media_id DESC);

-- Junction: media <-> hashtag is many-to-many in Meta (a post can carry several tags).
CREATE TABLE hashtag_media (
  hashtag_id BIGINT NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
  media_id   TEXT   NOT NULL REFERENCES media(media_id) ON DELETE CASCADE,
  PRIMARY KEY (hashtag_id, media_id)
);

-- FK the PK doesn't cover: lets us join media -> hashtag_media by media_id.
CREATE INDEX hashtag_media_media_id_idx ON hashtag_media (media_id);

-- Down Migration

DROP TABLE IF EXISTS hashtag_media;
DROP TABLE IF EXISTS media;
DROP TABLE IF EXISTS hashtags;
