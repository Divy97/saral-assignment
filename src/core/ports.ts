import type { Readable } from "node:stream";

// The queue carries only asset-download jobs. Syncs run directly (boot / cron), never via
// the queue — so a long sync can't block asset downloads behind it, and vice versa.
export type Job = { type: "FETCH_ASSET"; mediaId: string };

export interface Queue {
  enqueue(job: Job): Promise<void>;
  // SQS-shaped consumer: internally receive → handle → ack/delete, retry on throw.
  // NOT a synchronous handler() call — local must mimic SQS, or prod surprises you.
  consume(handler: (job: Job) => Promise<void>): void;
}

export interface Storage {
  // body is a stream, not a Buffer — assets stream download -> disk without ever
  // holding the whole file in memory (matters for large videos).
  put(key: string, body: Readable, contentType: string): Promise<void>;
  getUrl(key: string): string;   // pure function of the adapter — read API calls this
}