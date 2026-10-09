import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LAST_MANUAL_ENDPOINT_KEY } from "../services/transport";

// Which endpoint a native build connects to: the store against a page (location, storage)
// and a build (VITE_WS_URL) that the test makes up, with sockets that never open. And what
// the store of each build does when its server is gone: sockets that are refused, and the
// BroadcastChannel of a page with an emulator in another tab.

const storage = new Map<string, string>();
const sockets: string[] = [];

class SilentSocket {
  binaryType = "";
  readyState = 0;

  constructor(url: string) {
    sockets.push(url);
  }

  addEventListener() {}
  close() {}
  send() {}
}

/** A socket to a server that is not there: the attempt fails right away. */
class RefusedSocket extends SilentSocket {
  private closeListeners: Array<(event: unknown) => void> = [];

  constructor(url: string) {
    super(url);
    queueMicrotask(() => this.closeListeners.forEach((listener) => listener({ code: 1006 })));
  }

  addEventListener(type?: string, listener?: (event: unknown) => void) {
    if (type === "close" && listener) {
      this.closeListeners.push(listener);
    }
  }
}

/** The BroadcastChannel of one page: what one channel posts, the others of its name get. */
const channels = new Map<string, Set<PageChannel>>();

class PageChannel {
  readonly name: string;
  private listeners: Array<(event: { data: unknown }) => void> = [];

  constructor(name: string) {
    this.name = name;
    channels.set(name, (channels.get(name) ?? new Set()).add(this));
  }

  addEventListener(type: string, listener: (event: { data: unknown }) => void) {
    if (type === "message") {
      this.listeners.push(listener);
    }
  }

  postMessage(data: unknown) {
    for (const peer of Array.from(channels.get(this.name) ?? [])) {
      if (peer !== this) {
        peer.listeners.forEach((listener) => listener({ data }));
      }
    }
  }

  close() {
    channels.get(this.name)?.delete(this);
  }
}

/**
 * An emulator in another tab, as the wasm build of nullDC is: it announces itself every half
 * second, answers the pings of the transport and describes itself. `close()` is its tab
 * being closed: from then on it says nothing.
 */
const emulator = (id: string) => {
  const announcements = new PageChannel("nulldc-debugger-announce");
  const channel = new PageChannel(`nulldc-debugger-${id}`);
  const requests: string[] = [];
  channel.addEventListener("message", ({ data }) => {
    if (data === "ping") {
      channel.postMessage("pong");
      return;
    }
    const request = JSON.parse(String(data)) as { id: number; method: string };
    requests.push(request.method);
    if (request.method === "debugger.describe") {
      const result = { emulator: { name: `emulator ${id}`, version: "test", build: "wasm" }, deviceTree: [] };
      channel.postMessage(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    }
  });
  const announce = () => announcements.postMessage({ id, name: `emulator ${id}`, timestamp: Date.now() });
  announce();
  const timer = setInterval(announce, 500);
  return {
    requests,
    close() {
      clearInterval(timer);
      announcements.close();
      channel.close();
    },
  };
};

const page = (search: string) => ({
  location: { protocol: "http:", host: "127.0.0.1:55543", search },
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  },
});

const PAGE_ENDPOINT = "ws://127.0.0.1:55543/ws";

/** The store of a page that was just loaded. */
const load = async (search = "") => {
  vi.stubGlobal("window", page(search));
  const { useSessionStore } = await import("./sessionStore");
  return useSessionStore;
};

beforeEach(() => {
  storage.clear();
  sockets.length = 0;
  channels.clear();
  vi.resetModules();
  vi.stubGlobal("WebSocket", SilentSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the endpoint of a native build", () => {
  it("is ?ws=, then the last manual entry, then VITE_WS_URL, then /ws of the page: the picker lists them in that order", async () => {
    vi.stubEnv("VITE_WS_URL", "ws://build-default:1/ws");
    storage.set(LAST_MANUAL_ENDPOINT_KEY, "ws://typed:3/ws");
    const store = await load("?ws=ws%3A%2F%2Ffrom-query%3A2%2Fws&other=1");

    store.getState().startDiscovery();
    expect(store.getState().availableConnections.map(({ id, source, name, mode }) => ({ id, source, name, mode }))).toEqual([
      { id: "ws://from-query:2/ws", source: "query", name: "From the address bar (?ws=)", mode: "native" },
      { id: "ws://typed:3/ws", source: "manual", name: "Last manual entry", mode: "native" },
      { id: "ws://build-default:1/ws", source: "env", name: "Build default (VITE_WS_URL)", mode: "native" },
      { id: PAGE_ENDPOINT, source: "same-origin", name: "nullDC @ 127.0.0.1:55543", mode: "native" },
    ]);

    // without being told anything, the page connects to the first
    void store.getState().connect();
    expect(store.getState()).toMatchObject({ connectionState: "connecting", endpoint: "ws://from-query:2/ws" });
    expect(sockets).toEqual(["ws://from-query:2/ws"]);
    store.getState().disconnect();
    expect(store.getState().connectionState).toBe("idle");
  });

  it("is VITE_WS_URL when the page says nothing, and /ws of the page when the build says nothing either", async () => {
    vi.stubEnv("VITE_WS_URL", "ws://build-default:1/ws");
    const withEnv = await load();
    void withEnv.getState().connect();
    expect(withEnv.getState().endpoint).toBe("ws://build-default:1/ws");
    withEnv.getState().disconnect();

    vi.unstubAllEnvs();
    vi.resetModules();
    const plain = await load("?ws=not-a-url");
    void plain.getState().connect();
    expect(plain.getState().endpoint).toBe(PAGE_ENDPOINT);
    expect(plain.getState().availableConnections.map((candidate) => candidate.id)).toEqual([PAGE_ENDPOINT]);
    plain.getState().disconnect();
    expect(sockets).toEqual(["ws://build-default:1/ws", PAGE_ENDPOINT]);
  });

  it("takes any ws:// or wss:// URL that is entered by hand, and remembers it", async () => {
    const store = await load();
    void store.getState().connect({ connectionId: "  wss://emulator.example:8443/ws ", force: true });
    expect(store.getState()).toMatchObject({ connectionState: "connecting", endpoint: "wss://emulator.example:8443/ws" });
    expect(storage.get(LAST_MANUAL_ENDPOINT_KEY)).toBe("wss://emulator.example:8443/ws");
    expect(store.getState().availableConnections.map((candidate) => candidate.source)).toEqual(["manual", "same-origin"]);

    // Connect in the toolbar goes to the endpoint of the session
    void store.getState().connect({ force: true });
    expect(sockets).toEqual(["wss://emulator.example:8443/ws", "wss://emulator.example:8443/ws"]);

    // the endpoint of the page, picked from the list, puts the manual entry away
    void store.getState().connect({ connectionId: PAGE_ENDPOINT, force: true });
    expect(store.getState().endpoint).toBe(PAGE_ENDPOINT);
    expect(storage.has(LAST_MANUAL_ENDPOINT_KEY)).toBe(false);
    store.getState().disconnect();
  });

  it("does not try what is not a WebSocket URL: that is an error, and nothing is remembered", async () => {
    const store = await load();
    void store.getState().connect({ connectionId: "http://127.0.0.1:55543/ws", force: true });
    expect(store.getState()).toMatchObject({
      connectionState: "error",
      connectionError: '"http://127.0.0.1:55543/ws" is not a ws:// or wss:// URL',
    });
    expect(store.getState().client).toBeUndefined();
    expect(sockets).toEqual([]);
    expect(storage.has(LAST_MANUAL_ENDPOINT_KEY)).toBe(false);
  });

  it("an attempt that is under way is not started again by a page that mounts", async () => {
    const store = await load();
    void store.getState().connect();
    void store.getState().connect();
    expect(sockets).toEqual([PAGE_ENDPOINT]);
    store.getState().disconnect();
  });
});

describe("a session whose server is gone", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("in a native build tries again on the clock: there is no announcement to wait for", async () => {
    vi.stubGlobal("WebSocket", RefusedSocket);
    const store = await load();
    void store.getState().connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({ mode: "native", connectionState: "reconnecting", retry: { attempt: 1, delayMs: 1000 } });
    expect(sockets).toEqual([PAGE_ENDPOINT]);

    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toEqual([PAGE_ENDPOINT, PAGE_ENDPOINT]);
    expect(store.getState().retry).toEqual({ attempt: 2, delayMs: 2000 });
    store.getState().disconnect();
  });

  it("an explicit endpoint is the one that is tried again, every time: it is not replaced by the next in the list", async () => {
    // The endpoints of a page are a priority, not a chain to fall down: ?ws= names a server
    // that is not there, and the page's own /ws, which would answer, is never tried instead.
    vi.stubGlobal("WebSocket", RefusedSocket);
    vi.stubEnv("VITE_WS_URL", "ws://build-default:1/ws");
    const explicit = "ws://emulator.test:55001/ws";
    const store = await load(`?ws=${encodeURIComponent(explicit)}`);
    void store.getState().connect();
    await vi.advanceTimersByTimeAsync(0);
    // 1, 2, 5 and then every 10 seconds, each counted from the failure before it
    const delays = [1000, 2000, 5000, 10_000, 10_000, 10_000];
    for (const [index, delayMs] of delays.entries()) {
      expect(store.getState()).toMatchObject({ connectionState: "reconnecting", endpoint: explicit, retry: { attempt: index + 1, delayMs } });
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(sockets).toHaveLength(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(index + 2);
    }
    expect(new Set(sockets)).toEqual(new Set([explicit]));

    // "Retry now" and "Connect" try at once, and try that endpoint
    void store.getState().connect({ force: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(delays.length + 2);
    expect(sockets.at(-1)).toBe(explicit);
    expect(store.getState()).toMatchObject({ connectionState: "reconnecting", endpoint: explicit, retry: { attempt: 1, delayMs: 1000 } });

    // An endpoint the user picked is explicit too: the page's own, picked from the list although
    // ?ws= is first in it, is the one "Retry now" and the clock go back to.
    sockets.length = 0;
    void store.getState().connect({ connectionId: PAGE_ENDPOINT, force: true });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    void store.getState().connect({ force: true });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000 + 2000);
    expect(sockets.length).toBeGreaterThanOrEqual(5);
    expect(new Set(sockets)).toEqual(new Set([PAGE_ENDPOINT]));
    expect(store.getState().endpoint).toBe(PAGE_ENDPOINT);
    store.getState().disconnect();
  });

  it("in a wasm build waits until an emulator has announced itself after the loss, and goes to that one", async () => {
    vi.stubEnv("VITE_TRANSPORT_MODE", "wasm");
    vi.stubGlobal("BroadcastChannel", PageChannel);
    const lost = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = await load();
    store.getState().startDiscovery();
    const first = emulator("guid-1");
    expect(store.getState().availableConnections.map((candidate) => candidate.id)).toEqual(["guid-1"]);

    // the only emulator there is: the page connects to it by itself
    void store.getState().connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getState()).toMatchObject({ mode: "wasm", connectionState: "connected", endpoint: "guid-1" });
    expect(first.requests).toEqual(["debugger.describe"]);
    await vi.advanceTimersByTimeAsync(1900);
    expect(store.getState().connectionState).toBe("connected");

    // Its tab is closed 1.9 s into the session. The ping of second 2 is the first without an
    // answer, and three seconds later the transport gives the connection up.
    first.close();
    await vi.advanceTimersByTimeAsync(3100);
    expect(lost).toHaveBeenCalledWith("Pong timeout - connection lost");
    expect(store.getState()).toMatchObject({
      connectionState: "reconnecting",
      endpoint: "guid-1",
      retry: { attempt: 1, waitingForAnnouncement: true },
    });
    expect(store.getState().client).toBeUndefined();

    // Discovery still lists the emulator, with what it said before it went. That is not an
    // announcement after the loss, and no clock runs either: a channel to nobody would "open".
    await vi.advanceTimersByTimeAsync(600);
    expect(store.getState().connectionDiscovery?.getAvailableConnections().map((candidate) => candidate.id)).toEqual(["guid-1"]);
    expect(store.getState().connectionState).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(store.getState()).toMatchObject({ connectionState: "reconnecting", retry: { attempt: 1, waitingForAnnouncement: true } });
    expect(channels.get("nulldc-debugger-guid-1")?.size ?? 0).toBe(0);

    // The emulator is started again in a new tab, with a new id: the session goes there, and
    // the new server is described.
    const second = emulator("guid-2");
    await vi.advanceTimersByTimeAsync(500);
    expect(store.getState()).toMatchObject({ connectionState: "connected", endpoint: "guid-2" });
    expect(store.getState().retry).toBeUndefined();
    expect(second.requests).toEqual(["debugger.describe"]);
    expect(first.requests).toEqual(["debugger.describe"]);

    store.getState().disconnect();
    store.getState().stopDiscovery();
    second.close();
  });
});
