import { describe, expect, test } from "bun:test";
import type { Radio, RadioMix } from "./ipc";
import { MixWriter } from "./radio";

type Call = { what: string; settle: (fail?: boolean) => void };

/** A station whose answers arrive only when the test says so. */
function station() {
  const calls: Call[] = [];
  const answer = (what: string, mix?: RadioMix) =>
    new Promise<Radio>((resolve, reject) => {
      calls.push({
        what,
        settle: (fail) =>
          fail
            ? reject(new Error(`${what} failed`))
            : resolve({ mix: mix ?? edit(what) } as Radio),
      });
    });
  const writer = new MixWriter((mix) => answer(`mix ${mix.theme}`, mix));
  return { calls, answer, writer };
}

const edit = (theme: string) => ({ theme }) as RadioMix;
/** Let queued promise steps run. */
const tick = () => new Promise((r) => setTimeout(r, 0));
const names = (calls: Call[]) => calls.map((c) => c.what);

describe("MixWriter", () => {
  test("a later edit waits for a slow earlier write and wins", async () => {
    const { calls, writer } = station();
    writer.edit(edit("a"));
    const first = writer.flush();
    await tick();
    writer.edit(edit("b"));
    const second = writer.flush();
    writer.edit(edit("c"));
    const third = writer.flush();
    await tick();
    // One write at a time: b is not on its way while a is.
    expect(names(calls)).toEqual(["mix a"]);
    calls[0].settle();
    expect((await first)?.mix.theme).toBe("a");
    // a's answer is stale: newer work is still waiting.
    expect(writer.busy).toBe(true);
    await tick();
    // The next write sends the newest edit; b never needs its own write.
    expect(names(calls)).toEqual(["mix a", "mix c"]);
    calls[1].settle();
    expect((await second)?.mix.theme).toBe("c");
    expect(await third).toBeNull();
    expect(writer.busy).toBe(false);
  });

  for (const command of ["save station", "activate station"]) {
    test(`${command} runs after a write already on its way`, async () => {
      const { calls, answer, writer } = station();
      writer.edit(edit("a"));
      void writer.flush();
      await tick();
      const done = writer.run(() => answer(command));
      await tick();
      expect(names(calls)).toEqual(["mix a"]);
      calls[0].settle();
      await tick();
      expect(names(calls)).toEqual(["mix a", command]);
      calls[1].settle();
      await done;
      expect(writer.busy).toBe(false);
    });
  }

  test("a failed write keeps the edit and stops the station command", async () => {
    const { calls, answer, writer } = station();
    writer.edit(edit("a"));
    const failed = writer.flush();
    await tick();
    calls[0].settle(true);
    await expect(failed).rejects.toThrow("mix a failed");
    await tick();
    expect(writer.busy).toBe(true);
    // Save as tries the edit again first and does not save without it.
    const save = writer.run(() => answer("save station"));
    await tick();
    expect(names(calls)).toEqual(["mix a", "mix a"]);
    calls[1].settle(true);
    await expect(save).rejects.toThrow("mix a failed");
    await tick();
    expect(names(calls)).toEqual(["mix a", "mix a"]);
    // A newer edit replaces the failed one rather than being undone by it.
    writer.edit(edit("b"));
    void writer.flush();
    await tick();
    expect(names(calls)).toEqual(["mix a", "mix a", "mix b"]);
  });
});
