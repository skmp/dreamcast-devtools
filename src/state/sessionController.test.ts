import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TransportState } from "../services/transport";
import {
  ANNOUNCEMENT_POLL_MS,
  RECONNECT_DELAYS_MS,
  SessionController,
  announcedEndpoint,
  reconnectDelayMs,
  type SessionClient,
  type SessionEndpoint,
  type SessionSnapshot,
} from "./sessionController";

/** A client whose connection the test opens, refuses and closes. */
class FakeClient implements SessionClient {
  readonly endpoint: SessionEndpoint;
  disconnected = false;
  private handlers = new Set<(state: TransportState, event?: Event | Error) => void>();
  private settle: { resolve: () => void; reject: (error: Error) => void } | undefined;

  constructor(endpoint: SessionEndpoint) {
    this.endpoint = endpoint;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.settle = { resolve, reject };
    });
  }

  disconnect(): void {
    this.disconnected = true;
    this.emit("closed", new Error("disconnected by the client"));
  }

  onTransportStateChange(handler: (state: TransportState, event?: Event | Error) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private emit(state: TransportState, event?: Error) {
    Array.from(this.handlers).forEach((handler) => handler(state, event));
  }

  /** the connection opens */
  async open() {
    this.emit("open");
    this.settle!.resolve();
    await flush();
  }

  /** the attempt fails */
  async refuse(message = `Could not connect to ${this.endpoint.id}: refused`) {
    this.emit("closed", new Error(message));
    this.settle!.reject(new Error(message));
    await flush();
  }

  /** an open connection ends */
  async drop(message = "Connection closed") {
    this.emit("closed", new Error(message));
    await flush();
  }
}

const flush = async () => {
  for (let turn = 0; turn < 5; turn++) {
    await Promise.resolve();
  }
};

const NATIVE: SessionEndpoint = { id: "ws://127.0.0.1:55543/ws", mode: "native" };

const setup = (announcedSince?: (endpoint: SessionEndpoint, since: number) => SessionEndpoint | undefined) => {
  const clients: FakeClient[] = [];
  const snapshots: Array<SessionSnapshot<FakeClient>> = [];
  const events: string[] = [];
  const controller = new SessionController<FakeClient>({
    createClient: (endpoint) => {
      const client = new FakeClient(endpoint);
      clients.push(client);
      return client;
    },
    publish: (snapshot) => snapshots.push(snapshot),
    onConnected: (client) => events.push(`connected ${clients.indexOf(client)}`),
    onDisconnected: () => events.push("disconnected"),
    announcedSince,
  });
  return { controller, clients, snapshots, events, state: () => controller.snapshot };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the reconnect delays", () => {
  it("are 1, 2, 5 and then 10 seconds", () => {
    expect(RECONNECT_DELAYS_MS).toEqual([1000, 2000, 5000, 10_000]);
    expect([1, 2, 3, 4, 5, 6, 50].map(reconnectDelayMs)).toEqual([1000, 2000, 5000, 10_000, 10_000, 10_000, 10_000]);
  });
});

describe("a session", () => {
  it("connects, and has the server described when the connection is open", async () => {
    const { controller, clients, state, events } = setup();
    void controller.start(NATIVE);
    expect(state()).toMatchObject({ connectionState: "connecting", endpoint: NATIVE });
    expect(state().client).toBeUndefined();
    expect(events).toEqual([]);

    await clients[0].open();
    expect(state()).toEqual({ connectionState: "connected", endpoint: NATIVE, client: clients[0] });
    expect(events).toEqual(["connected 0"]);
  });

  it("stop() ends it: idle, the client disconnected, the data dropped, and its close is not taken for a loss", async () => {
    const { controller, clients, state, events } = setup();
    void controller.start(NATIVE);
    await clients[0].open();
    controller.stop();
    expect(state()).toEqual({ connectionState: "idle" });
    expect(clients[0].disconnected).toBe(true);
    expect(events).toEqual(["connected 0", "disconnected"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clients).toHaveLength(1);
    expect(state().connectionState).toBe("idle");
  });

  it("an endpoint that cannot be tried is an error, without a retry", async () => {
    const { controller, clients, state } = setup();
    controller.fail('"nonsense" is not a ws:// or wss:// URL');
    expect(state()).toEqual({ connectionState: "error", connectionError: '"nonsense" is not a ws:// or wss:// URL' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clients).toHaveLength(0);
  });
});

describe("when the connection is lost", () => {
  it("the state is reconnecting, the data is dropped at once, and the next attempt is made after 1 s", async () => {
    const { controller, clients, state, events } = setup();
    void controller.start(NATIVE);
    await clients[0].open();
    await clients[0].drop("Connection closed: close code 1006");

    expect(state()).toEqual({
      connectionState: "reconnecting",
      connectionError: "Connection closed: close code 1006",
      endpoint: NATIVE,
      retry: { attempt: 1, delayMs: 1000 },
    });
    expect(events).toEqual(["connected 0", "disconnected"]);
    expect(clients).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(clients).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(clients).toHaveLength(2);
    // while the attempt runs: still reconnecting, with the reason of the loss
    expect(state()).toMatchObject({ connectionState: "reconnecting", connectionError: "Connection closed: close code 1006", retry: { attempt: 1 } });
  });

  it("failed attempts follow each other after 1, 2, 5, 10, 10 s, each from the failure before it", async () => {
    const { controller, clients, state } = setup();
    void controller.start(NATIVE);
    await clients[0].open();
    await clients[0].drop();

    const waits: number[] = [];
    for (let attempt = 1; attempt <= 6; attempt++) {
      const retry = state().retry!;
      expect(retry.attempt).toBe(attempt);
      waits.push(retry.delayMs!);
      await vi.advanceTimersByTimeAsync(retry.delayMs! - 1);
      expect(clients).toHaveLength(attempt);
      await vi.advanceTimersByTimeAsync(1);
      expect(clients).toHaveLength(attempt + 1);
      // the attempt takes its time to fail; the next wait starts when it has
      await vi.advanceTimersByTimeAsync(700);
      await clients[attempt].refuse();
      expect(state()).toMatchObject({ connectionState: "reconnecting", connectionError: `Could not connect to ${NATIVE.id}: refused` });
    }
    expect(waits).toEqual([1000, 2000, 5000, 10_000, 10_000, 10_000]);
  });

  it("on success the server is described again, and the count starts over for the next loss", async () => {
    const { controller, clients, state, events } = setup();
    void controller.start(NATIVE);
    await clients[0].open();
    await clients[0].drop();
    await vi.advanceTimersByTimeAsync(1000);
    await clients[1].refuse();
    await vi.advanceTimersByTimeAsync(2000);
    await clients[2].open();

    expect(state()).toEqual({ connectionState: "connected", endpoint: NATIVE, client: clients[2] });
    expect(events).toEqual(["connected 0", "disconnected", "connected 2"]);

    await clients[2].drop();
    expect(state().retry).toEqual({ attempt: 1, delayMs: 1000 });
    expect(events).toEqual(["connected 0", "disconnected", "connected 2", "disconnected"]);
  });

  it("a first attempt that fails is retried the same way", async () => {
    const { controller, clients, state, events } = setup();
    void controller.start(NATIVE);
    await clients[0].refuse();
    expect(state()).toMatchObject({ connectionState: "reconnecting", retry: { attempt: 1, delayMs: 1000 } });
    // nothing was connected, so nothing is dropped
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    await clients[1].open();
    expect(state().connectionState).toBe("connected");
    expect(events).toEqual(["connected 1"]);
  });

  it("stop() while reconnecting cancels the attempt that is due", async () => {
    const { controller, clients, state } = setup();
    void controller.start(NATIVE);
    await clients[0].open();
    await clients[0].drop();
    controller.stop();
    expect(state()).toEqual({ connectionState: "idle" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clients).toHaveLength(1);
  });

  it("start() while reconnecting is a new session: an attempt now, and the delays from the beginning", async () => {
    const { controller, clients, state } = setup();
    void controller.start(NATIVE);
    await clients[0].open();
    await clients[0].drop();
    await vi.advanceTimersByTimeAsync(1000);
    await clients[1].refuse();
    expect(state().retry).toEqual({ attempt: 2, delayMs: 2000 });

    const other: SessionEndpoint = { id: "ws://127.0.0.1:1/ws", mode: "native" };
    void controller.start(other);
    expect(clients).toHaveLength(3);
    expect(clients[2].endpoint).toEqual(other);
    expect(state()).toMatchObject({ connectionState: "connecting", endpoint: other });
    await clients[2].refuse();
    expect(state().retry).toEqual({ attempt: 1, delayMs: 1000 });
    // the retry of the old session does not happen
    await vi.advanceTimersByTimeAsync(999);
    expect(clients).toHaveLength(3);
  });

  it("an attempt that opens after its session was replaced is closed and ignored", async () => {
    const { controller, clients, state, events } = setup();
    void controller.start(NATIVE);
    const other: SessionEndpoint = { id: "ws://127.0.0.1:1/ws", mode: "native" };
    void controller.start(other);
    expect(clients[0].disconnected).toBe(true);
    await clients[0].open();
    expect(state()).toMatchObject({ connectionState: "connecting", endpoint: other });
    expect(events).toEqual([]);
    await clients[1].open();
    expect(state()).toEqual({ connectionState: "connected", endpoint: other, client: clients[1] });
    expect(events).toEqual(["connected 1"]);
  });
});

describe("a session that waits for an announcement (the BroadcastChannel transport)", () => {
  const WASM: SessionEndpoint = { id: "guid-1", mode: "wasm" };

  it("does not try again on a clock: it waits until the emulator has announced itself after the loss", async () => {
    let announced: SessionEndpoint | undefined = undefined;
    const since: number[] = [];
    const { controller, clients, state } = setup((endpoint, lostAt) => {
      since.push(lostAt);
      expect(endpoint).toEqual(WASM);
      return announced;
    });
    void controller.start(WASM);
    await clients[0].open();
    vi.setSystemTime(2_000_000);
    await clients[0].drop("Connection closed");

    expect(state()).toEqual({
      connectionState: "reconnecting",
      connectionError: "Connection closed",
      endpoint: WASM,
      retry: { attempt: 1, waitingForAnnouncement: true },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(clients).toHaveLength(1);
    // it was asked about announcements after the moment of the loss
    expect(new Set(since)).toEqual(new Set([2_000_000]));
    expect(since.length).toBeGreaterThanOrEqual(60_000 / ANNOUNCEMENT_POLL_MS - 1);

    announced = WASM;
    await vi.advanceTimersByTimeAsync(ANNOUNCEMENT_POLL_MS);
    expect(clients).toHaveLength(2);
    await clients[1].open();
    expect(state()).toEqual({ connectionState: "connected", endpoint: WASM, client: clients[1] });
  });

  it("reconnects to the emulator that announced itself: after a reload of its tab that is another id", async () => {
    let announced: SessionEndpoint | undefined = undefined;
    const { controller, clients, state } = setup(() => announced);
    void controller.start(WASM);
    await clients[0].open();
    await clients[0].drop();

    announced = { id: "guid-2", mode: "wasm" };
    await vi.advanceTimersByTimeAsync(ANNOUNCEMENT_POLL_MS);
    expect(clients[1].endpoint).toEqual({ id: "guid-2", mode: "wasm" });
    await clients[1].open();
    expect(state()).toMatchObject({ connectionState: "connected", endpoint: { id: "guid-2", mode: "wasm" } });
  });

  it("stop() ends the wait", async () => {
    let asked = 0;
    const { controller, clients } = setup(() => {
      asked++;
      return undefined;
    });
    void controller.start(WASM);
    await clients[0].open();
    await clients[0].drop();
    await vi.advanceTimersByTimeAsync(ANNOUNCEMENT_POLL_MS * 2);
    controller.stop();
    const before = asked;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(asked).toBe(before);
    expect(clients).toHaveLength(1);
  });
});

describe("the emulator a waiting session goes to", () => {
  const WASM: SessionEndpoint = { id: "guid-1", mode: "wasm" };
  const LOST_AT = 2_000_000;
  /** what discovery has heard of: the id of each emulator, and how long after the loss it last announced itself */
  const heard = (...emulators: Array<[id: string, afterLoss: number]>) =>
    emulators.map(([id, afterLoss]) => ({ id, name: `emulator ${id}`, mode: "wasm" as const, lastSeen: LOST_AT + afterLoss }));

  it("is the one it had, when that has announced itself after the loss", () => {
    expect(announcedEndpoint(heard(["guid-1", 300]), WASM, LOST_AT)).toEqual({ id: "guid-1", mode: "wasm" });
    // whoever else is there
    expect(announcedEndpoint(heard(["guid-2", 100], ["guid-1", 300], ["guid-3", 200]), WASM, LOST_AT)).toEqual(WASM);
  });

  it("is the only other one that has: the tab of the emulator was reloaded, and has a new id", () => {
    expect(announcedEndpoint(heard(["guid-2", 300]), WASM, LOST_AT)).toEqual({ id: "guid-2", mode: "wasm" });
    // the one that is gone is still in the list of discovery for a few seconds, with what it said before
    expect(announcedEndpoint(heard(["guid-1", -700], ["guid-2", 300]), WASM, LOST_AT)).toEqual({ id: "guid-2", mode: "wasm" });
  });

  it("is none while two others are there to choose from", () => {
    expect(announcedEndpoint(heard(["guid-2", 300], ["guid-3", 400]), WASM, LOST_AT)).toBeUndefined();
    expect(announcedEndpoint(heard(["guid-1", -700], ["guid-2", 300], ["guid-3", 400]), WASM, LOST_AT)).toBeUndefined();
  });

  it("is none while nothing was heard after the loss: what an emulator said before it says nothing about now", () => {
    expect(announcedEndpoint([], WASM, LOST_AT)).toBeUndefined();
    expect(announcedEndpoint(heard(["guid-1", -700]), WASM, LOST_AT)).toBeUndefined();
    // at the moment of the loss is not after it
    expect(announcedEndpoint(heard(["guid-1", 0]), WASM, LOST_AT)).toBeUndefined();
    expect(announcedEndpoint(heard(["guid-1", -700], ["guid-2", -200]), WASM, LOST_AT)).toBeUndefined();
    expect(announcedEndpoint(heard(["guid-1", 1]), WASM, LOST_AT)).toEqual(WASM);
  });
});
