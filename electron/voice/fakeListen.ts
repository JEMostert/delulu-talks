import type {
  ListenEvent,
  ListenNextResult,
  ListenSessionInfo,
} from "../../src/listening";
import {
  VoiceBridgeError,
  type VoiceBridgeHandlers,
} from "../services/voiceBridge";

type NewEvent = ListenEvent extends infer Event
  ? Event extends ListenEvent
    ? Omit<Event, "seq" | "sessionId">
    : never
  : never;

/** In-memory listening sessions with the documented cursor rules, for tests. */
export function fakeListen() {
  let session: (ListenSessionInfo & { events: ListenEvent[] }) | null = null;
  const waiters = new Set<() => void>();
  const info = (): ListenSessionInfo => {
    const { events, ...rest } = session!;
    return {
      ...rest,
      lastSeq: events.at(-1)?.seq ?? rest.ackedSeq,
      queued: events.filter((event) => event.seq > rest.ackedSeq).length,
      waiters: waiters.size,
    };
  };
  const find = (id: string) => {
    if (!session || session.id !== id)
      throw new VoiceBridgeError("SESSION_NOT_FOUND", `No session ${id}`);
    return session;
  };
  const acknowledge = (after: number) => {
    session!.ackedSeq = Math.max(session!.ackedSeq, after);
    session!.events = session!.events.filter(
      (event) => event.seq > session!.ackedSeq,
    );
  };
  let seq = 0;
  const handlers: Pick<
    VoiceBridgeHandlers,
    "listenStart" | "listenNext" | "listenAck" | "listenStatus" | "listenStop"
  > = {
    async listenStart(client) {
      if (session && session.state !== "stopped") {
        if (session.client !== client)
          throw new VoiceBridgeError(
            "SESSION_BUSY",
            `${session.client} is already listening`,
          );
        return info();
      }
      session = {
        id: `ses_${client}`,
        client,
        state: "listening",
        startedAt: 1,
        ackedSeq: 0,
        lastSeq: 0,
        queued: 0,
        userSpeaking: false,
        transcribing: false,
        waiters: 0,
        error: null,
        events: [],
      };
      return info();
    },
    async listenNext(id, { after, timeoutMs, signal }) {
      const current = find(id);
      if (after !== undefined) acknowledge(after);
      for (;;) {
        const event = current.events.find(
          (item) => item.seq > current.ackedSeq,
        );
        if (event) return { status: "event", event, session: info() };
        if (current.state === "stopped")
          return { status: "stopped", reason: "stopped", session: info() };
        const outcome = await new Promise<"wake" | "timeout" | "abort">(
          (resolve) => {
            const finish = (value: "wake" | "timeout" | "abort") => {
              clearTimeout(timer);
              waiters.delete(wake);
              signal.removeEventListener("abort", abort);
              resolve(value);
            };
            const wake = () => finish("wake");
            const abort = () => finish("abort");
            const timer = setTimeout(() => finish("timeout"), timeoutMs);
            waiters.add(wake);
            signal.addEventListener("abort", abort, { once: true });
          },
        );
        if (outcome === "timeout")
          return { status: "timeout", session: info() } as ListenNextResult;
        if (outcome === "abort") throw new Error("aborted");
      }
    },
    listenAck(id, after) {
      find(id);
      acknowledge(after);
      return info();
    },
    listenStatus(id) {
      if (!session || (id && session.id !== id)) return null;
      return info();
    },
    async listenStop(id) {
      const current = find(id);
      current.state = "stopped";
      for (const wake of [...waiters]) wake();
      return info();
    },
  };
  return {
    handlers,
    /** Simulate the app producing an event (utterance or interruption). */
    push(event: NewEvent) {
      const value = {
        ...event,
        seq: ++seq,
        sessionId: session!.id,
      } as ListenEvent;
      session!.events.push(value);
      for (const wake of [...waiters]) wake();
      return value;
    },
    get waiting() {
      return waiters.size;
    },
  };
}
