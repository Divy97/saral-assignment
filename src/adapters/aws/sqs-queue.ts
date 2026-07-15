import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  type Message,
} from "@aws-sdk/client-sqs";
import type { Job, Queue } from "../../core/ports.js";

const DEFAULT_WAIT_TIME_SECONDS = 20; // SQS long-poll duration
const MAX_MESSAGES_PER_RECEIVE = 10; // SQS max per ReceiveMessage
const RECEIVE_BACKOFF_MS = 1000; // pause after a failed receive before retrying

export interface SqsQueueOptions {
  queueUrl: string;
  region?: string;
  waitTimeSeconds?: number; // long-poll duration
  maxMessages?: number;
  client?: SQSClient; // injectable for tests
}

/**
 * SQS queue adapter, same seam as InMemoryQueue: enqueue + a polling consumer that does
 * receive -> handle -> delete-on-success. On failure we leave the message: SQS makes it
 * visible again after the visibility timeout and, per the queue's redrive policy, moves it
 * to the DLQ after maxReceiveCount. That retry/DLQ config lives on the queue (infra), not here.
 */
export class SqsQueue implements Queue {
  private readonly queueUrl: string;
  private readonly client: SQSClient;
  private readonly waitTimeSeconds: number;
  private readonly maxMessages: number;
  private running = false;

  constructor(opts: SqsQueueOptions) {
    this.queueUrl = opts.queueUrl;
    this.client = opts.client ?? new SQSClient(opts.region ? { region: opts.region } : {});
    this.waitTimeSeconds = opts.waitTimeSeconds ?? DEFAULT_WAIT_TIME_SECONDS;
    this.maxMessages = opts.maxMessages ?? MAX_MESSAGES_PER_RECEIVE;
  }

  async enqueue(job: Job): Promise<void> {
    await this.client.send(
      new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(job) }),
    );
  }

  consume(handler: (job: Job) => Promise<void>): void {
    if (this.running) throw new Error("consume() already started");
    this.running = true;
    void this.loop(handler);
  }

  stop(): void {
    this.running = false;
  }

  private async loop(handler: (job: Job) => Promise<void>): Promise<void> {
    while (this.running) {
      try {
        const res = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.queueUrl,
            MaxNumberOfMessages: this.maxMessages,
            WaitTimeSeconds: this.waitTimeSeconds,
          }),
        );
        for (const message of res.Messages ?? []) await this.handleMessage(message, handler);
      } catch (err) {
        // A ReceiveMessage/network error must NOT kill the poll loop — log, back off, keep polling.
        console.error("[sqs] receive failed, backing off —", err);
        await new Promise((resolve) => setTimeout(resolve, RECEIVE_BACKOFF_MS));
      }
    }
  }

  // One message: parse, run, ack on success. Unparseable -> drop; handler error -> leave it
  // for SQS to redeliver / DLQ per the queue's redrive policy.
  private async handleMessage(message: Message, handler: (job: Job) => Promise<void>): Promise<void> {
    let job: Job;
    try {
      job = JSON.parse(message.Body ?? "") as Job;
    } catch {
      console.error("[sqs] dropping unparseable message", message.MessageId);
      await this.deleteMessage(message.ReceiptHandle);
      return;
    }
    try {
      await handler(job);
      await this.deleteMessage(message.ReceiptHandle); // ack
    } catch (err) {
      console.error("[sqs] handler failed; leaving message for redelivery/DLQ —", err);
    }
  }

  private async deleteMessage(receiptHandle: string | undefined): Promise<void> {
    if (!receiptHandle) return;
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: receiptHandle }),
    );
  }
}
