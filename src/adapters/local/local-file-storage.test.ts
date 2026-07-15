import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { LocalFileStorage } from "./local-file-storage.js";

const stream = (s: string) => Readable.from(Buffer.from(s));

describe("LocalFileStorage", () => {
  let dir = "";
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("writes the body under the key and overwrites on repeat (no duplicates)", async () => {
    dir = await mkdtemp(join(tmpdir(), "storage-"));
    const storage = new LocalFileStorage({ mediaDir: dir, publicBaseUrl: "http://x" });

    await storage.put("123.jpg", stream("first"), "image/jpeg");
    await storage.put("123.jpg", stream("second"), "image/jpeg");

    expect(await readFile(join(dir, "123.jpg"), "utf8")).toBe("second");
  });

  it("removes the temp file and rethrows if the write fails mid-stream", async () => {
    dir = await mkdtemp(join(tmpdir(), "storage-"));
    const storage = new LocalFileStorage({ mediaDir: dir, publicBaseUrl: "http://x" });

    const failing = new Readable({
      read() {
        this.destroy(new Error("stream boom"));
      },
    });

    await expect(storage.put("123.jpg", failing, "image/jpeg")).rejects.toThrow("stream boom");

    // neither the temp file nor the target should survive
    expect(await readdir(dir)).toHaveLength(0);
  });

  it("derives the URL from base + mount + key without touching disk", () => {
    dir = join(tmpdir(), "does-not-exist");
    const storage = new LocalFileStorage({ mediaDir: dir, publicBaseUrl: "http://localhost:3000" });

    expect(storage.getUrl("123.jpg")).toBe("http://localhost:3000/media/123.jpg");
  });
});
