import { describe, it, expect } from "vitest";
import {
  hashtagSearchSchema,
  mediaItemSchema,
  mediaPageSchema,
  metaErrorSchema,
} from "./schemas.js";

describe("meta schemas", () => {
  it("parses a full top_media item", () => {
    const item = {
      id: "18130665154527971",
      media_type: "CAROUSEL_ALBUM",
      timestamp: "2026-07-13T14:07:52+0000",
      permalink: "https://www.instagram.com/p/DavGBaDDaSX/",
      media_url: "https://scontent.cdninstagram.com/...",
      caption: "WTF?? Ibiza edition 🤪 #matcha",
      like_count: 541,
      comments_count: 56,
    };
    expect(mediaItemSchema.parse(item)).toMatchObject({ id: "18130665154527971" });
  });

  it("parses a sparse item with only id, media_type, timestamp (no media_url/caption/counts)", () => {
    const item = {
      id: "18086699789406964",
      media_type: "IMAGE",
      timestamp: "2026-07-14T19:25:39+0000",
    };
    const parsed = mediaItemSchema.parse(item);
    expect(parsed.media_url).toBeUndefined();
    expect(parsed.caption).toBeUndefined();
  });

  it("accepts null for optional fields (Meta may send null, not just omit the key)", () => {
    const item = {
      id: "1",
      media_type: "IMAGE",
      timestamp: "2026-07-14T19:25:39+0000",
      caption: null,
      media_url: null,
      permalink: null,
      like_count: null,
      comments_count: null,
    };
    expect(() => mediaItemSchema.parse(item)).not.toThrow();
  });

  it("parses the paged envelope", () => {
    const page = {
      data: [{ id: "1", media_type: "IMAGE", timestamp: "2026-07-14T19:25:39+0000" }],
      paging: { cursors: { after: "abc" }, next: "https://graph.facebook.com/...&after=abc" },
    };
    const parsed = mediaPageSchema.parse(page);
    expect(parsed.data).toHaveLength(1);
    expect(parsed.paging?.next).toContain("after=abc");
  });

  it("parses an envelope with no paging (last page)", () => {
    expect(mediaPageSchema.parse({ data: [] })).toEqual({ data: [] });
  });

  it("parses the hashtag search response", () => {
    expect(hashtagSearchSchema.parse({ data: [{ id: "17843758702042126" }] }).data[0]?.id).toBe(
      "17843758702042126",
    );
  });

  it("parses the reduce-the-data error body", () => {
    const body = { error: { code: 1, message: "Please reduce the amount of data..." } };
    expect(metaErrorSchema.parse(body).error.code).toBe(1);
  });
});
