import type { Readable } from "node:stream";

export type Job =
  | { type: "SYNC_TOP" }
  | { type: "SYNC_RECENT" }
  | { type: "FETCH_ASSET"; mediaId: string };

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