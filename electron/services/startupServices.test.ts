import { describe, expect, test } from "bun:test";
import { readStartupService } from "../../src/startupServices";

describe("bounded startup reads", () => {
  test("a hung optional service settles without holding other reads", async () => {
    const signal = new AbortController().signal;
    const result = await Promise.allSettled([
      readStartupService(
        "settings",
        async () => ({ language: "nl" }),
        signal,
        20,
      ),
      readStartupService(
        "update status",
        () => new Promise(() => {}),
        signal,
        5,
      ),
    ]);
    expect(result[0]).toEqual({
      status: "fulfilled",
      value: { language: "nl" },
    });
    expect(result[1].status).toBe("rejected");
    if (result[1].status === "rejected")
      expect(result[1].reason.message).toContain(
        "Timed out reading update status",
      );
  });

  test("late replies cannot turn a timeout into a successful read", async () => {
    let complete!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      complete = resolve;
    });
    const read = readStartupService(
      "transcript history",
      () => pending,
      new AbortController().signal,
      5,
    );
    await expect(read).rejects.toThrow("Timed out reading transcript history");
    complete("old history snapshot");
    await expect(read).rejects.toThrow("Timed out reading transcript history");
  });

  test("disposal settles an outstanding read and ignores a late backend rejection", async () => {
    const controller = new AbortController();
    let fail!: (reason: unknown) => void;
    const pending = new Promise<string>((_resolve, reject) => {
      fail = reject;
    });
    const read = readStartupService(
      "rewriting status",
      () => pending,
      controller.signal,
    );
    await Promise.resolve();
    controller.abort();
    await expect(read).rejects.toThrow("Workspace startup was cancelled");
    fail(new Error("backend finished after disposal"));
    await Promise.resolve();
  });

  test("an already disposed attempt never starts another backend read", async () => {
    const controller = new AbortController();
    controller.abort();
    let requested = false;
    await expect(
      readStartupService(
        "settings",
        async () => {
          requested = true;
        },
        controller.signal,
      ),
    ).rejects.toThrow("cancelled");
    expect(requested).toBe(false);
  });

  test("immediate effect cleanup prevents its queued backend read", async () => {
    const controller = new AbortController();
    let requested = false;
    const read = readStartupService(
      "settings",
      async () => {
        requested = true;
      },
      controller.signal,
    );
    controller.abort();
    await expect(read).rejects.toThrow("cancelled");
    await Promise.resolve();
    expect(requested).toBe(false);
  });

  test("a synchronous backend failure retains its original cause", async () => {
    const cause = new Error("IPC channel disconnected");
    await expect(
      readStartupService(
        "settings",
        () => {
          throw cause;
        },
        new AbortController().signal,
      ),
    ).rejects.toBe(cause);
  });
});
