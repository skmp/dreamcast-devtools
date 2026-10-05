import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LAST_MANUAL_ENDPOINT_KEY } from "../services/transport";

// Which endpoint a native build connects to: the store against a page (location, storage)
// and a build (VITE_WS_URL) that the test makes up, with sockets that never open.

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
