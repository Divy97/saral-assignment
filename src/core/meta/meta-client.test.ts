import { describe, it, expect, vi, afterEach } from "vitest";
import { searchHashtagId, fetchTopMedia, MetaCredentialsMissingError } from "./meta-client.js";
import type { MediaItem } from "./schemas.js";

const creds = { accessToken: "t", userId: "u" };
const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status });
const item = (id: string) => ({ id, media_type: "IMAGE", timestamp: "2026-07-14T19:25:39+0000" });

// drain the generator into a flat list of items
const collect = async (gen: AsyncGenerator<MediaItem[]>): Promise<MediaItem[]> => {
  const out: MediaItem[] = [];
  for await (const page of gen) out.push(...page);
  return out;
};

afterEach(() => vi.unstubAllGlobals());

describe("meta client", () => {
  it("throws MetaCredentialsMissingError when token or user id is missing", async () => {
    await expect(searchHashtagId("matcha", { accessToken: "", userId: "u" })).rejects.toBeInstanceOf(
      MetaCredentialsMissingError,
    );
  });

  it("resolves the hashtag id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: [{ id: "17843758702042126" }] })));
    await expect(searchHashtagId("matcha", creds)).resolves.toBe("17843758702042126");
  });

  it("paginates via the after cursor until it runs out", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: [item("1")], paging: { cursors: { after: "c1" } } }))
      .mockResolvedValueOnce(json({ data: [item("2")] })); // no paging -> last page
    vi.stubGlobal("fetch", fetchMock);

    const items = await collect(fetchTopMedia("123", creds));
    expect(items.map((i) => i.id)).toEqual(["1", "2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips a malformed item instead of failing the whole page", async () => {
    const fetchMock = vi.fn(async () =>
      json({
        data: [
          item("good"),
          { id: 123, media_type: "IMAGE", timestamp: "t" }, // id is a number -> invalid, skipped
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const items = await collect(fetchTopMedia("123", creds));
    expect(items.map((i) => i.id)).toEqual(["good"]);
  });

  it("halves the limit and retries on the reduce-data error", async () => {
    const reduceErr = json(
      { error: { code: 1, message: "Please reduce the amount of data you're asking for" } },
      400,
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reduceErr) // limit=4 fails
      .mockResolvedValueOnce(json({ data: [item("1")] })); // retry at limit=2 succeeds
    vi.stubGlobal("fetch", fetchMock);

    const items = await collect(fetchTopMedia("123", { ...creds, defaultLimit: 4 }));
    expect(items.map((i) => i.id)).toEqual(["1"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("limit=2");
  });
});
