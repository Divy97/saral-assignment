import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchJson, HttpError, redactUrl } from "./http.js";

const mockFetch = (body: string, status = 200) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));

afterEach(() => vi.unstubAllGlobals());

describe("fetchJson", () => {
  it("returns parsed JSON on a 2xx response", async () => {
    mockFetch(JSON.stringify({ id: "1" }));
    await expect(fetchJson("http://x")).resolves.toEqual({ id: "1" });
  });

  it("throws HttpError with status and body on a non-2xx response", async () => {
    mockFetch("rate limited", 429);
    const err = await fetchJson("http://x").catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(429);
    expect((err as HttpError).body).toContain("rate limited");
  });

  it("throws a clear error on invalid JSON", async () => {
    mockFetch("<html>not json</html>");
    await expect(fetchJson("http://x")).rejects.toThrow(/invalid JSON/);
  });

  it("redacts access_token / token from URLs", () => {
    const redacted = redactUrl("https://graph.facebook.com/x?fields=id&access_token=SECRET&token=ALSO");
    expect(redacted).not.toContain("SECRET");
    expect(redacted).not.toContain("ALSO");
    expect(redacted).toContain("access_token=REDACTED");
    expect(redacted).toContain("fields=id"); // non-secret params preserved
  });

  it("keeps the access token out of the HttpError message", async () => {
    mockFetch("bad", 400);
    const err = (await fetchJson("https://api?access_token=SECRET").catch((e) => e)) as HttpError;
    expect(err.message).not.toContain("SECRET");
    expect(err.message).toContain("REDACTED");
  });
});
