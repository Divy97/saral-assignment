import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import type { Storage } from "../../core/ports.js";

export interface LocalFileStorageOptions {
  mediaDir: string; // filesystem root, e.g. ./media
  publicBaseUrl: string; // e.g. http://localhost:3000
}

// URL path the entrypoint serves `mediaDir` under (app.use("/media", static(mediaDir))).
const URL_MOUNT = "media";

/**
 * Writes assets to the local filesystem. The key is the file name (e.g. `123.jpg`);
 * the asset service builds it as `{media_id}.{ext}`, so a re-run overwrites the same
 * file — no duplicates.
 *
 * The body is streamed to a temp file and then renamed onto the final path: rename is
 * atomic on the same filesystem, so a crash never leaves a partial file visible, and
 * the whole asset never has to sit in memory. getUrl is a pure string — no disk access.
 */
export class LocalFileStorage implements Storage {
  private readonly mediaDir: string;
  private readonly publicBaseUrl: string;

  constructor(opts: LocalFileStorageOptions) {
    this.mediaDir = opts.mediaDir;
    this.publicBaseUrl = opts.publicBaseUrl;
  }

  // contentType is unused locally — the file extension drives express's mime type on
  // serve. The S3 adapter uses it. Kept to satisfy the Storage port.
  async put(key: string, body: Readable, _contentType: string): Promise<void> {
    const target = join(this.mediaDir, key);
    await mkdir(dirname(target), { recursive: true });
    // temp + rename = atomic. single writer per key (deterministic
    // key + single worker), so a fixed .tmp suffix can't collide.
    const tmp = `${target}.tmp`;
    try {
      await pipeline(body, createWriteStream(tmp));
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true }); // don't leave a partial temp file behind
      throw err;
    }
  }

  getUrl(key: string): string {
    return `${this.publicBaseUrl}/${URL_MOUNT}/${key}`;
  }
}
