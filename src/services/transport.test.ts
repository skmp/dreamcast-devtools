import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BroadcastChannelTransport,
  ConnectionDiscovery,
  WebSocketTransport,
  connectFailureMessage,
  isWebSocketUrl,
  resolveWebSocketEndpoint,
  resolveWebSocketEndpoints,
  sameOriginWebSocketUrl,
} from "./transport";
import type { TransportState } from "./transport";

/** The parts of a browser WebSocket the transport uses; the test fires its events. */
class FakeWebSocket extends EventTarget {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  readonly sent: string[] = [];
  readonly closeCalls: Array<[number | undefined, string | undefined]> = [];
  readonly url: string;
  readonly protocols: string | string[] | undefined;

  constructor(url: string, protocols?: string | string[]) {
    super();
    this.url = url;
    this.protocols = protocols;
    FakeWebSocket.instances.push(this);
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close(code?: number, reason?: string) {
    this.closeCalls.push([code, reason]);
    this.readyState = 3;
  }

  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }

  fail() {
    this.dispatchEvent(new Event("error"));
  }

  closed(init: { code?: number; reason?: string } = {}) {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event("close"), init));
  }

  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

const setup = () => {
  FakeWebSocket.instances = [];
  const transport = new WebSocketTransport((url, protocols) => new FakeWebSocket(url, protocols) as unknown as WebSocket);
  const states: Array<{ state: TransportState; detail: unknown }> = [];
  transport.onStateChange((state, detail) => states.push({ state, detail }));
  const socket = () => FakeWebSocket.instances.at(-1)!;
  return { transport, states, socket };
};

describe("WebSocketTransport", () => {
  it("connects, asks for ArrayBuffer frames and routes text and binary frames", async () => {
    const { transport, states, socket } = setup();
    const texts: string[] = [];
    const binaries: ArrayBuffer[] = [];
    transport.subscribe((payload) => texts.push(payload));
    transport.subscribeBinary((payload) => binaries.push(payload));

    const connecting = transport.connect("ws://emulator.test:55543/ws", { protocols: "debugger" });
    expect(transport.state).toBe("connecting");
    expect(socket().url).toBe("ws://emulator.test:55543/ws");
    expect(socket().protocols).toBe("debugger");
    expect(socket().binaryType).toBe("arraybuffer");
    socket().open();
    await connecting;
    expect(transport.state).toBe("open");
    expect(states.map((entry) => entry.state)).toEqual(["open"]);

    socket().message('{"jsonrpc":"2.0"}');
    const frame = new Uint8Array([1, 2, 3]).buffer;
    socket().message(frame);
    expect(texts).toEqual(['{"jsonrpc":"2.0"}']);
    expect(binaries).toEqual([frame]);

    transport.send("ping");
    expect(socket().sent).toEqual(["ping"]);
  });

  it("rejects a failed connection attempt with a readable Error, not with the DOM event", async () => {
    const { transport, states, socket } = setup();
    const connecting = transport.connect("ws://127.0.0.1:9/ws");
    socket().fail();
    socket().closed({ code: 1006 });

    const failure = await connecting.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toBe(connectFailureMessage("ws://127.0.0.1:9/ws"));
    expect(message).toContain("Could not connect to ws://127.0.0.1:9/ws");
    expect(message).toContain("Host/Origin");
    expect(String(failure)).not.toContain("[object");
    // one state change, and it carries the same readable error
    expect(states).toHaveLength(1);
    expect(states[0].state).toBe("closed");
    expect(states[0].detail).toBe(failure);
    expect(transport.state).toBe("closed");
    expect(() => transport.send("x")).toThrow("Not Connected");
  });

  it("uses what the socket says about a failure when it says something (node, tests)", async () => {
    const { transport, socket } = setup();
    const connecting = transport.connect("ws://127.0.0.1:9/ws");
    socket().dispatchEvent(Object.assign(new Event("error"), { message: "connect ECONNREFUSED 127.0.0.1:9" }));
    await expect(connecting).rejects.toThrow("Could not connect to ws://127.0.0.1:9/ws: connect ECONNREFUSED 127.0.0.1:9");
  });

  it("rejects when the socket closes before it opened", async () => {
    const { transport, socket } = setup();
    const connecting = transport.connect("ws://emulator.test/ws");
    socket().closed({ code: 1008, reason: "too many clients" });
    await expect(connecting).rejects.toThrow("Could not connect to ws://emulator.test/ws: too many clients (close code 1008)");
  });

  it("rejects with a readable error when the URL cannot be opened at all", async () => {
    const transport = new WebSocketTransport(() => {
      throw new SyntaxError("The URL 'nonsense' is invalid.");
    });
    await expect(transport.connect("nonsense")).rejects.toThrow("Could not connect to nonsense: The URL 'nonsense' is invalid.");
    expect(transport.state).toBe("closed");
  });

  it("reports the end of an open connection once", async () => {
    const { transport, states, socket } = setup();
    const connecting = transport.connect("ws://emulator.test/ws");
    socket().open();
    await connecting;

    socket().fail();
    socket().closed({ code: 1006 });
    socket().closed({ code: 1006 });
    expect(states.map((entry) => entry.state)).toEqual(["open", "closed"]);
    expect(states[1].detail).toBeInstanceOf(Error);
    expect((states[1].detail as Error).message).toBe("Connection closed: close code 1006");
    expect(() => transport.send("x")).toThrow("Not Connected");
  });

  it("disconnect() closes the socket and reports closed at once; the socket's own close is not reported again", async () => {
    const { transport, states, socket } = setup();
    const connecting = transport.connect("ws://emulator.test/ws");
    socket().open();
    await connecting;

    transport.disconnect(1000, "bye");
    expect(socket().closeCalls).toEqual([[1000, "bye"]]);
    expect(states.map((entry) => entry.state)).toEqual(["open", "closed"]);
    socket().closed({ code: 1000 });
    expect(states).toHaveLength(2);
    // frames that were still on their way are not delivered to a client that hung up
    const texts: string[] = [];
    transport.subscribe((payload) => texts.push(payload));
    socket().message("late");
    expect(texts).toEqual([]);
  });

  it("can connect again after a failure", async () => {
    const { transport, states, socket } = setup();
    const first = transport.connect("ws://emulator.test/ws");
    socket().fail();
    await expect(first).rejects.toThrow();
    const second = transport.connect("ws://emulator.test/ws");
    socket().open();
    await second;
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(states.map((entry) => entry.state)).toEqual(["closed", "open"]);
  });

  it("gives a readable error against a port nobody listens on, with node's own WebSocket", async () => {
    const transport = new WebSocketTransport();
    const failure = await transport.connect("ws://127.0.0.1:9/ws").then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/^Could not connect to ws:\/\/127\.0\.0\.1:9\/ws: /);
    expect(transport.state).toBe("closed");
  });
});

describe("endpoint resolution", () => {
  const location = { protocol: "http:", host: "127.0.0.1:55543" };

  it("recognises ws:// and wss:// URLs only", () => {
    expect(isWebSocketUrl("ws://localhost:55543/ws")).toBe(true);
    expect(isWebSocketUrl("  wss://example.org/ws ")).toBe(true);
    expect(isWebSocketUrl("http://localhost:55543/ws")).toBe(false);
    expect(isWebSocketUrl("localhost:55543")).toBe(false);
    expect(isWebSocketUrl("")).toBe(false);
    expect(isWebSocketUrl(null)).toBe(false);
  });

  it("derives the same-origin endpoint from the page's location", () => {
    expect(sameOriginWebSocketUrl(location)).toBe("ws://127.0.0.1:55543/ws");
    expect(sameOriginWebSocketUrl({ protocol: "https:", host: "debug.example.org" })).toBe("wss://debug.example.org/ws");
  });

  it("prefers ?ws=, then the last manual entry, then VITE_WS_URL, then same-origin /ws", () => {
    const inputs = {
      search: "?crashTest&ws=ws%3A%2F%2Flocalhost%3A1111%2Fws",
      lastManual: "ws://localhost:2222/ws",
      envUrl: "ws://localhost:3333/ws",
      location,
    };
    expect(resolveWebSocketEndpoints(inputs)).toEqual([
      { url: "ws://localhost:1111/ws", source: "query" },
      { url: "ws://localhost:2222/ws", source: "manual" },
      { url: "ws://localhost:3333/ws", source: "env" },
      { url: "ws://127.0.0.1:55543/ws", source: "same-origin" },
    ]);
    expect(resolveWebSocketEndpoint(inputs)).toEqual({ url: "ws://localhost:1111/ws", source: "query" });
    expect(resolveWebSocketEndpoint({ ...inputs, search: "" })?.source).toBe("manual");
    expect(resolveWebSocketEndpoint({ envUrl: inputs.envUrl, location })?.source).toBe("env");
    expect(resolveWebSocketEndpoint({ location })).toEqual({ url: "ws://127.0.0.1:55543/ws", source: "same-origin" });
  });

  it("skips entries that are not WebSocket URLs, and duplicates", () => {
    expect(
      resolveWebSocketEndpoints({
        search: "?ws=http://localhost:1111/",
        lastManual: "ws://127.0.0.1:55543/ws",
        envUrl: "",
        location,
      }),
    ).toEqual([{ url: "ws://127.0.0.1:55543/ws", source: "manual" }]);
  });

  it("has no same-origin endpoint for a page that was not served over http(s)", () => {
    expect(resolveWebSocketEndpoint({ location: { protocol: "file:", host: "" } })).toBeUndefined();
    expect(resolveWebSocketEndpoint({})).toBeUndefined();
  });
});

describe("BroadcastChannelTransport", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** The next message a channel receives. */
  const nextMessage = (channel: BroadcastChannel) =>
    new Promise<unknown>((resolve) => {
      channel.addEventListener("message", (event) => resolve((event as MessageEvent).data), { once: true });
    });

  it("talks JSON strings and ArrayBuffers on nulldc-debugger-<id>, pings, and closes when the pongs stop", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const id = `test-${process.pid}-${Date.now()}`;
    const emulator = new BroadcastChannel(`nulldc-debugger-${id}`);
    const transport = new BroadcastChannelTransport();
    const states: TransportState[] = [];
    const texts: string[] = [];
    const binaries: ArrayBuffer[] = [];
    const waiting = new Map<string, () => void>();
    transport.onStateChange((state) => states.push(state));
    transport.subscribe((payload) => {
      texts.push(payload);
      waiting.get(payload)?.();
    });
    transport.subscribeBinary((payload) => binaries.push(payload));
    /** Resolves when the transport has delivered everything the emulator posted so far. */
    let markers = 0;
    const flushed = () => {
      const marker = `marker-${markers++}`;
      const seen = new Promise<void>((resolve) => waiting.set(marker, resolve));
      emulator.postMessage(marker);
      return seen;
    };

    try {
      await transport.connect(id);
      expect(states).toEqual(["open"]);

      // client -> emulator
      const request = nextMessage(emulator);
      transport.send('{"jsonrpc":"2.0","id":1,"method":"debugger.describe","params":{}}');
      expect(await request).toBe('{"jsonrpc":"2.0","id":1,"method":"debugger.describe","params":{}}');

      // emulator -> client: a text frame, a binary frame, and a pong that is not a message
      emulator.postMessage('{"jsonrpc":"2.0","id":1,"result":{}}');
      emulator.postMessage(new Uint8Array([1, 2, 3]).buffer);
      emulator.postMessage("pong");
      await flushed();
      expect(texts).toEqual(['{"jsonrpc":"2.0","id":1,"result":{}}', "marker-0"]);
      expect(binaries).toHaveLength(1);
      expect(Array.from(new Uint8Array(binaries[0]))).toEqual([1, 2, 3]);

      // heartbeat: a ping every second; answered pings keep the connection up
      for (let second = 0; second < 5; second++) {
        const ping = nextMessage(emulator);
        await vi.advanceTimersByTimeAsync(1000);
        expect(await ping).toBe("ping");
        expect(vi.getTimerCount()).toBe(2); // the interval and the pong timeout
        emulator.postMessage("pong");
        await flushed();
        expect(vi.getTimerCount()).toBe(1); // the pong cancelled the timeout
      }
      expect(states).toEqual(["open"]);

      // unanswered pings: closed three seconds after the first of them, not after the last
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2999);
      expect(states).toEqual(["open"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(states).toEqual(["open", "closed"]);
      expect(vi.getTimerCount()).toBe(0);
      expect(() => transport.send("x")).toThrow("Not Connected");
    } finally {
      transport.disconnect();
      emulator.close();
    }
  });
});

describe("ConnectionDiscovery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("in a native build lists /ws of the page, named by its host alone: nobody has said yet who is there", () => {
    vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1:55543" });
    const discovery = new ConnectionDiscovery("native");
    const seen: string[][] = [];
    discovery.onConnectionsChanged((connections) => seen.push(connections.map((connection) => connection.name)));
    discovery.start();
    expect(discovery.getAvailableConnections()).toEqual([
      { id: "ws://127.0.0.1:55543/ws", name: "127.0.0.1:55543", mode: "native", lastSeen: expect.any(Number) },
    ]);
    expect(seen).toEqual([["127.0.0.1:55543"]]);
    discovery.stop();
  });
});
