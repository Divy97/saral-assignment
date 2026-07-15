import { describe, it, expect, vi } from "vitest";
import {
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import { SqsQueue } from "./sqs-queue.js";
import type { Job } from "../../core/ports.js";

const tick = (ms = 20) => new Promise<void>((r) => setTimeout(r, ms));
const job: Job = { type: "FETCH_ASSET", mediaId: "m1" };

// Mock send: ReceiveMessage yields one message then empties (via a macrotask so the poll
// loop yields and stop() can fire). DeleteMessage inputs are recorded.
function makeClient() {
  const deletes: { ReceiptHandle?: string }[] = [];
  let delivered = false;
  const send = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof ReceiveMessageCommand) {
      await new Promise((r) => setTimeout(r, 1));
      if (delivered) return { Messages: [] };
      delivered = true;
      return { Messages: [{ Body: JSON.stringify(job), ReceiptHandle: "rh1" }] };
    }
    if (cmd instanceof DeleteMessageCommand) {
      deletes.push(cmd.input);
      return {};
    }
    return {};
  });
  return { client: { send } as unknown as SQSClient, send, deletes };
}

describe("SqsQueue", () => {
  it("enqueue sends the job as a JSON SendMessage", async () => {
    const send = vi.fn().mockResolvedValue({});
    const q = new SqsQueue({ queueUrl: "url", client: { send } as unknown as SQSClient });

    await q.enqueue(job);

    const cmd = send.mock.calls[0]?.[0] as SendMessageCommand;
    expect(cmd).toBeInstanceOf(SendMessageCommand);
    expect(cmd.input.MessageBody).toBe(JSON.stringify(job));
  });

  it("handles a message then deletes it (ack) on success", async () => {
    const { client, deletes } = makeClient();
    const handler = vi.fn().mockResolvedValue(undefined);
    const q = new SqsQueue({ queueUrl: "url", client, waitTimeSeconds: 0 });

    q.consume(handler);
    await tick();
    q.stop();

    expect(handler).toHaveBeenCalledWith(job);
    expect(deletes[0]?.ReceiptHandle).toBe("rh1");
  });

  it("leaves the message (no delete) when the handler fails", async () => {
    const { client, deletes } = makeClient();
    const handler = vi.fn().mockRejectedValue(new Error("boom"));
    const q = new SqsQueue({ queueUrl: "url", client, waitTimeSeconds: 0 });

    q.consume(handler);
    await tick();
    q.stop();

    expect(handler).toHaveBeenCalledWith(job);
    expect(deletes).toEqual([]); // not acked -> SQS redelivers / DLQ per redrive policy
  });
});
