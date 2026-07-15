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
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  getUrl(key: string): string;   // pure function of the adapter — read API calls this
}