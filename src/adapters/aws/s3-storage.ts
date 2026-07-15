import { S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { Readable } from "node:stream";
import type { Storage } from "../../core/ports.js";

export interface S3StorageOptions {
  bucket: string;
  region: string;
  client?: S3Client; // injectable for tests
}

/**
 * S3 storage adapter. Same seam as LocalFileStorage: put(key, stream) + getUrl(key).
 * put uses lib-storage `Upload` (streamed multipart) so large videos never sit fully in
 * memory. getUrl is a pure string — no S3 call.
 */
export class S3Storage implements Storage {
  private readonly bucket: string;
  private readonly region: string;
  private readonly client: S3Client;

  constructor(opts: S3StorageOptions) {
    this.bucket = opts.bucket;
    this.region = opts.region;
    this.client = opts.client ?? new S3Client({ region: opts.region });
  }

  async put(key: string, body: Readable, contentType: string): Promise<void> {
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: key, Body: body, ContentType: contentType },
    });
    await upload.done();
  }

  getUrl(key: string): string {
    return `https://${this.bucket}.s3.${this.region}.amazonaws.com/${encodeURIComponent(key)}`;
  }
}
