import { z } from "zod";

/**
 * One media object from top_media / recent_media. Both endpoints return the exact same
 * shape, so this is shared. Unknown extra fields are stripped (Zod default).
 */
export const mediaItemSchema = z.object({
  id: z.string(),
  // Known values: IMAGE | VIDEO | CAROUSEL_ALBUM. Kept as a plain string on purpose — a
  // new Meta type must not fail validation and drop the row (the DB column is unconstrained too).
  media_type: z.string(),
  timestamp: z.string(), // ISO8601, e.g. "2026-07-13T14:07:52+0000"; Postgres parses it as-is
  permalink: z.string().nullish(),
  media_url: z.string().nullish(), // absent for recent_media albums -> asset_status = no_asset
  caption: z.string().nullish(),
  like_count: z.number().int().nullish(), // omitted when the owner hides like counts
  comments_count: z.number().int().nullish(),
});

/** Envelope for both top_media and recent_media (identical shape). */
export const mediaPageSchema = z.object({
  // items are validated individually by the client (mediaItemSchema.safeParse) so one
  // malformed item is skipped rather than failing the whole page.
  data: z.array(z.unknown()),
  paging: z
    .object({
      cursors: z.object({ after: z.string() }).nullish(),
      next: z.string().nullish(), // full URL of the next page; absent on the last page
    })
    .nullish(),
});

/** GET /ig_hashtag_search */
export const hashtagSearchSchema = z.object({
  data: z.array(z.object({ id: z.string() })),
});

/**
 * Meta error envelope. Used to detect the "Please reduce the amount of data" error
 * (code 1) that drives the adaptive limit-halving.
 */
export const metaErrorSchema = z.object({
  error: z.object({
    code: z.number(),
    message: z.string(),
  }),
});

export type MediaItem = z.infer<typeof mediaItemSchema>;
export type MediaPage = z.infer<typeof mediaPageSchema>;
export type HashtagSearch = z.infer<typeof hashtagSearchSchema>;
export type MetaError = z.infer<typeof metaErrorSchema>;
