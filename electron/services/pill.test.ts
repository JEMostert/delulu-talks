import { EventEmitter } from "node:events";
import { expect, test } from "bun:test";
import { PillService } from "./pill";

class FakeChild extends EventEmitter {
  readonly signals: string[] = [];
  readonly stdin = {
    writable: true,
    write: () => true,
    end: () => undefined,
    on: () => this.stdin,
  };

  kill(signal: string): boolean {
    this.signals.push(signal);
    return true;
  }
}

function serviceWithChild(
  child: FakeChild,
  killDelayMs: number,
): InstanceType<typeof PillService> {
  const service = new PillService({ killDelayMs });
  (service as unknown as { child: FakeChild }).child = child;
  return service;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("shutdown escalates to SIGKILL when the helper ignores SIGTERM", async () => {
  const child = new FakeChild();
  serviceWithChild(child, 10).shutdown();

  expect(child.signals).toEqual(["SIGTERM"]);
  await wait(40);
  expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
});
