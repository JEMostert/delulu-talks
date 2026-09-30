import { describe, expect, test } from "bun:test";
import { parseIpcRequest } from "../../src/ipcRequests";

describe("shared renderer request contracts", () => {
  test("rejects malformed requests before a domain listener can receive them", () => {
    const invalid: [string, unknown[]][] = [
      ["settings:update", [null]],
      ["settings:update", [[]]],
      ["settings:update", [{ modelIdleMinutes: Infinity }]],
      ["settings:update", [{ magicEnabled: "true" }]],
      ["settings:update", [{ customWords: [null] }]],
      ["settings:update", [{ unknownSetting: true }]],
      ["magic:rewrite", [{ text: "draft", allowInferences: "false" }]],
      ["magic:rewrite", [["draft"]]],
      ["lab:run", [{ path: 42 }]],
      ["history:updateTranscript", ["id", { text: "oops" }]],
      [
        "history:setRewrite",
        ["id", { text: "new", processingTimeMs: NaN }, "old"],
      ],
      ["history:export", ["id", {}]],
      ["recorder:level", [NaN]],
      ["recorder:submit", [{ wav: new Uint8Array(44), durationMs: Infinity }]],
      ["recorder:submit", [{ wav: [1, 2, 3], durationMs: 500 }]],
      ["recorder:submit", [{ wav: new Uint8Array(10), durationMs: 500 }]],
      ["dictation:start", ["unexpected"]],
      ["unknown:channel", []],
    ];
    for (const [channel, args] of invalid)
      expect(() => parseIpcRequest(channel, args)).toThrow();
  });

  test("the same request can pass preload then main without changing again", () => {
    const requests: [string, unknown[]][] = [
      [
        "settings:update",
        [
          {
            shortcut: "  Ctrl+Alt+D  ",
            customWords: [
              {
                id: "word",
                term: "  name  ",
                soundsLike: "naym",
                enabled: true,
              },
            ],
          },
        ],
      ],
      ["magic:rewrite", [{ text: "  draft  ", instructions: "  polish  " }]],
      [
        "history:setRewrite",
        ["id", { text: "  polished  ", processingTimeMs: 15 }, "draft", 0],
      ],
      ["history:setRewrite", ["id", null, "draft", 0]],
      [
        "recorder:submit",
        [{ sessionId: "capture", wav: new Uint8Array(44), durationMs: 500 }],
      ],
      ["recorder:level", [1.5]],
      ["lab:run", [{ path: "/tmp/source.wav" }]],
      ["history:export", ["id", "unsupported"]],
    ];
    for (const [channel, args] of requests) {
      const inPreload = parseIpcRequest(channel, args);
      expect(parseIpcRequest(channel, inPreload)).toEqual(inPreload);
    }
  });

  test("preserves text clipping, null corrections, defaults and finite level clamping", () => {
    const id = "x".repeat(200);
    const text = "t".repeat(500_001);
    expect(parseIpcRequest("history:updateTranscript", [id, text])).toEqual([
      id.slice(0, 128),
      text.slice(0, 500_000),
    ]);
    expect(parseIpcRequest("history:updateTranscript", ["id", null])).toEqual([
      "id",
      null,
    ]);
    expect(
      parseIpcRequest("magic:rewrite", [{ text: " draft ", preset: "other" }]),
    ).toEqual([
      {
        text: " draft ",
        preset: "polish",
        instructions: "",
        allowInferences: false,
        context: undefined,
        operationId: undefined,
        sourceLanguage: undefined,
      },
    ]);
    expect(parseIpcRequest("recorder:level", [-0.5])).toEqual([0]);
    expect(parseIpcRequest("recorder:level", [1.5])).toEqual([1]);
    expect(parseIpcRequest("history:export", ["id", "other"])).toEqual([
      "id",
      "txt",
    ]);
  });
});
