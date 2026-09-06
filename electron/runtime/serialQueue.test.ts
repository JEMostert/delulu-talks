import { expect, test } from "bun:test";
import { SerialQueue } from "./serialQueue";

test("shared environment operations never overlap and recover after failure", async () => {
  const queue = new SerialQueue();
  const events: string[] = [];
  let finish!: () => void;
  const first = queue.run(async () => {
    events.push("speech:start");
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    events.push("speech:end");
    throw new Error("download failed");
  });
  const rejected = first.catch((error) => error.message);
  const second = queue.run(async () => {
    events.push("magic:start");
    return "installed";
  });
  await Promise.resolve();
  expect(events).toEqual(["speech:start"]);
  expect(queue.busy).toBe(true);
  finish();
  expect(await rejected).toBe("download failed");
  expect(await second).toBe("installed");
  expect(events).toEqual(["speech:start", "speech:end", "magic:start"]);
  expect(queue.busy).toBe(false);
});
