import { expect, test } from "bun:test";
import { LiveTyping } from "./liveTyping";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("text is pasted in spoken order, coalesced while a paste runs", async () => {
  const deltas = ["Hello, ", "how ", "are ", "you"];
  const pasted: string[] = [];
  const gate = deferred();
  let first = true;
  const live = new LiveTyping({
    start: async () => true,
    audio: async () => deltas.shift() ?? "",
    finish: async () => "?",
    shape: (text) => text.replace("you", "you all"),
    paste: async (text) => {
      if (first) {
        first = false;
        await gate.promise;
      }
      pasted.push(text);
    },
  });
  for (let i = 0; i < 4; i++) live.audio(16_000, "AAAA");
  await new Promise((resolve) => setTimeout(resolve, 5));
  gate.resolve();
  const result = await live.finish();
  expect(pasted[0]).toBe("Hello, ");
  expect(pasted.join("")).toBe("Hello, how are you all?");
  expect(result).toEqual({
    raw: "Hello, how are you?",
    typed: "Hello, how are you all?",
    failure: null,
  });
});

test("a failed stream stops pasting and reports why", async () => {
  const pasted: string[] = [];
  let calls = 0;
  const live = new LiveTyping({
    start: async () => true,
    audio: async () => {
      calls++;
      if (calls === 2) throw new Error("worker exited");
      return calls === 1 ? "One " : "three ";
    },
    finish: async () => "never",
    shape: (text) => text,
    paste: async (text) => void pasted.push(text),
  });
  live.audio(16_000, "A");
  live.audio(16_000, "A");
  live.audio(16_000, "A");
  const result = await live.finish();
  expect(pasted).toEqual(["One "]);
  expect(result.failure).toBe("worker exited");
  expect(live.healthy).toBe(false);
});

test("a stream that cannot start pastes nothing", async () => {
  const live = new LiveTyping({
    start: async () => false,
    audio: async () => "text",
    finish: async () => "",
    shape: (text) => text,
    paste: async () => {
      throw new Error("must not paste");
    },
  });
  live.audio(16_000, "A");
  expect((await live.finish()).failure).toBe("Live typing could not start");
});
