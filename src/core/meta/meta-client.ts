import { fetchJson, HttpError } from "../../lib/http.js";
import {
  hashtagSearchSchema,
  mediaItemSchema,
  mediaPageSchema,
  metaErrorSchema,
  type MediaItem,
  type MediaPage,
} from "./schemas.js";

const DEFAULT_BASE_URL = "https://graph.facebook.com/v24.0";
const DEFAULT_LIMIT = 5;
const MAX_RETRIES = 5;
const MAX_ITEMS = 500;
const MEDIA_FIELDS =
  "id,media_type,timestamp,permalink,media_url,caption,like_count,comments_count";

export interface MetaConfig {
  accessToken: string;
  userId: string;
  baseUrl?: string;
  defaultLimit?: number; // starting page size; halved on payload errors
  maxRetries?: number; // max halving retries per page
  maxItems?: number; // hard cap on items per sync (spec: 500)
}

/** Thrown when creds are absent — the sync handler catches this and skips the run. */
export class MetaCredentialsMissingError extends Error {
  constructor() {
    super("Meta credentials missing (META_ACCESS_TOKEN / META_USER_ID)");
    this.name = "MetaCredentialsMissingError";
  }
}

function assertCredentials(config: MetaConfig): void {
  if (!config.accessToken || !config.userId) {
    console.warn(
      "[meta] no access token / user id — skipping sync (set META_ACCESS_TOKEN and META_USER_ID in .env)",
    );
    throw new MetaCredentialsMissingError();
  }
}

type MediaEdge = "top_media" | "recent_media";

/** Resolve a hashtag's Meta id from its name (e.g. "matcha"). Returns null if not found. */
export async function searchHashtagId(name: string, config: MetaConfig): Promise<string | null> {
  assertCredentials(config);
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const params = new URLSearchParams({
    user_id: config.userId,
    q: name,
    access_token: config.accessToken,
  });
  const parsed = hashtagSearchSchema.parse(await fetchJson(`${baseUrl}/ig_hashtag_search?${params}`));
  return parsed.data[0]?.id ?? null;
}

/**
 * Yields one page of validated media items at a time so the caller can commit and enqueue
 * per page. If iteration dies on a later page, the earlier pages are already processed.
 */
export function fetchTopMedia(hashtagId: string, config: MetaConfig): AsyncGenerator<MediaItem[]> {
  return streamMediaPages("top_media", hashtagId, config);
}

export function fetchRecentMedia(
  hashtagId: string,
  config: MetaConfig,
): AsyncGenerator<MediaItem[]> {
  return streamMediaPages("recent_media", hashtagId, config);
}

function buildMediaUrl(
  edge: MediaEdge,
  hashtagId: string,
  config: MetaConfig,
  limit: number,
  after: string | null | undefined,
): string {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const params = new URLSearchParams({
    user_id: config.userId,
    fields: MEDIA_FIELDS,
    limit: String(limit),
    access_token: config.accessToken,
  });
  if (after) params.set("after", after);
  return `${baseUrl}/${hashtagId}/${edge}?${params}`;
}

/**
 * Paginate an edge newest-first, yielding each page's valid items. We build each URL
 * ourselves (so we own `limit`) and advance with the response's `after` cursor rather
 * than blindly following `next`.
 *
 * Items are validated individually — a malformed item is skipped and logged, never failing
 * the whole page. On the "reduce the amount of data" error we halve the limit and retry the
 * SAME page (floored at 1, capped at maxRetries), then log-and-stop rather than crash. The
 * reduced limit persists to later pages (it only goes down). Stops after maxItems.
 */
async function* streamMediaPages(
  edge: MediaEdge,
  hashtagId: string,
  config: MetaConfig,
): AsyncGenerator<MediaItem[]> {
  assertCredentials(config);
  const maxItems = config.maxItems ?? MAX_ITEMS;
  const maxRetries = config.maxRetries ?? MAX_RETRIES;
  let limit = config.defaultLimit ?? DEFAULT_LIMIT;

  let after: string | null | undefined;
  let retries = 0;
  let total = 0;

  while (total < maxItems) {
    const url = buildMediaUrl(edge, hashtagId, config, limit, after);
    let page: MediaPage;
    try {
      page = mediaPageSchema.parse(await fetchJson(url));
    } catch (err) {
      if (isReduceDataError(err) && limit > 1 && retries < maxRetries) {
        retries++;
        limit = Math.max(1, Math.floor(limit / 2));
        console.warn(
          `[meta] ${edge}: payload too large, retry ${retries}/${maxRetries} at limit=${limit}`,
        );
        continue; // retry the same cursor with a smaller limit
      }
      if (isReduceDataError(err)) {
        console.warn(`[meta] ${edge}: giving up on a page (limit=${limit}) — stopping early`);
        break; // log-and-stop: keep the pages already yielded
      }
      throw err; // network / auth / anything else is a real failure
    }

    retries = 0; // page fetched OK; reset the per-page counter
    const items = parseMediaItems(page.data, edge);
    total += items.length;
    if (items.length > 0) yield items;

    after = page.paging?.cursors?.after;
    if (!after || page.data.length === 0) break; // last page
  }
}

/** Validate items individually — skip and log malformed ones, keep the good ones. */
function parseMediaItems(data: unknown[], edge: MediaEdge): MediaItem[] {
  const items: MediaItem[] = [];
  for (const raw of data) {
    const parsed = mediaItemSchema.safeParse(raw);
    if (parsed.success) {
      items.push(parsed.data);
    } else {
      console.warn(`[meta] ${edge}: skipping malformed media item`, parsed.error.issues);
    }
  }
  return items;
}

function isReduceDataError(err: unknown): boolean {
  if (!(err instanceof HttpError)) return false;
  let body: unknown;
  try {
    body = JSON.parse(err.body);
  } catch {
    return false;
  }
  const parsed = metaErrorSchema.safeParse(body);
  return (
    parsed.success && parsed.data.error.message.toLowerCase().includes("reduce the amount of data")
  );
}
