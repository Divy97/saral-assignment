import { describe, it, expect, vi } from "vitest";
import { Readable } from "node:stream";

const done = vi.fn().mockResolvedValue({});
// Mock lib-storage's Upload so put() makes no real S3 call. Regular function so `new` works.
vi.mock("@aws-sdk/lib-storage", () => ({
  Upload: vi.fn(function (this: { done: () => Promise<unknown> }) {
    this.done = done;
  }),
}));

import { S3Storage } from "./s3-storage.js";
import { Upload } from "@aws-sdk/lib-storage";
import type { S3Client } from "@aws-sdk/client-s3";

const fakeClient = {} as S3Client;

describe("S3Storage", () => {
  it("builds a virtual-hosted URL from bucket/region/key", () => {
    const s = new S3Storage({ bucket: "matcha-media", region: "us-east-1", client: fakeClient });
    expect(s.getUrl("123.jpg")).toBe("https://matcha-media.s3.us-east-1.amazonaws.com/123.jpg");
  });

  it("uploads the stream via lib-storage Upload", async () => {
    const s = new S3Storage({ bucket: "matcha-media", region: "us-east-1", client: fakeClient });
    await s.put("123.jpg", Readable.from("data"), "image/jpeg");

    expect(Upload).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          Bucket: "matcha-media",
          Key: "123.jpg",
          ContentType: "image/jpeg",
        }),
      }),
    );
    expect(done).toHaveBeenCalled();
  });
});
