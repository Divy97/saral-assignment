import type { Job, Queue } from "../../core/ports.js";

interface Message {
  job: Job;
  receiveCount: number;
}

export interface InMemoryQueueOptions {
  maxReceives?: number; // attempts before dead-lettering (SQS maxReceiveCount)
  pollIntervalMs?: number; // wait between polls when the queue is empty
  retryDelayMs?: number; // delay before a failed job becomes visible again (visibility timeout)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * SQS-shaped in-memory queue: enqueue → poll → handle → ack, retry on throw,
 * dead-letter after maxReceives. Deliberately NOT a direct handler() call, so the
 * local path exercises the same receive/ack/retry semantics as SQS in production.
 */
export class InMemoryQueue implements Queue {
  private readonly messages: Message[] = [];
  private readonly maxReceives: number;
  private readonly pollIntervalMs: number;
  private readonly retryDelayMs: number;
  private running = false;

  constructor(opts: InMemoryQueueOptions = {}) {
    this.maxReceives = opts.maxReceives ?? 5;
    this.pollIntervalMs = opts.pollIntervalMs ?? 200;
    this.retryDelayMs = opts.retryDelayMs ?? 1000;
  }

  async enqueue(job: Job): Promise<void> {
    this.messages.push({ job, receiveCount: 0 });
  }

  consume(handler: (job: Job) => Promise<void>): void {
    if (this.running) throw new Error("consume() already started");
    this.running = true;
    void this.loop(handler);
  }

  // Stops the poll loop — used for graceful shutdown and test teardown.
  stop(): void {
    this.running = false;
  }

  private async loop(handler: (job: Job) => Promise<void>): Promise<void> {
    while (this.running) {
      const message = this.messages.shift(); // receive
      if (!message) {
        await sleep(this.pollIntervalMs);
        continue;
      }
      try {
        await handler(message.job); // handle → ack (already removed)
      } catch (err) {
        message.receiveCount += 1;
        if (message.receiveCount >= this.maxReceives) {
          // In prod, SQS moves this to a DLQ; locally we log and drop.
          console.error(
            `[queue] dead-lettering job after ${this.maxReceives} attempts`,
            message.job,
            err,
          );
        } else {
          console.warn(
            `[queue] job failed (attempt ${message.receiveCount}/${this.maxReceives}), retrying`,
            message.job,
          );
          // re-enqueue after the delay without blocking the loop (mimics visibility timeout)
          void sleep(this.retryDelayMs).then(() => this.messages.push(message));
        }
      }
    }
  }
}
