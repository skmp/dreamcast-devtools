import { create } from "zustand";
import { appConfig } from "../config";
import { DebuggerClient } from "../services/debuggerClient";
import {
  ConnectionDiscovery,
  LAST_MANUAL_ENDPOINT_KEY,
  parseWebSocketUrl,
  resolveWebSocketEndpoints,
  type AvailableConnection,
  type EndpointSource,
} from "../services/transport";
import { useDebuggerDataStore } from "./debuggerDataStore";
import { SessionController, announcedEndpoint, type ConnectionState, type RetryInfo, type SessionEndpoint } from "./sessionController";

export type { ConnectionState };

/**
 * An endpoint the connection picker offers. `source` says where a WebSocket endpoint comes
 * from, and `sourceText` says it in words (the picker shows it under the URL).
 */
export interface ConnectionCandidate extends AvailableConnection {
  source?: EndpointSource;
  sourceText?: string;
}

interface ConnectOptions {
  /** connect even when a session exists: the user asked for it */
  force?: boolean;
  /** an entry of `availableConnections`, or what the user typed: a `ws://` / `wss://` URL, or the id of an emulator (wasm) */
  connectionId?: string;
}

interface SessionStore {
  /** the client of the open connection; undefined while there is none */
  client?: DebuggerClient;
  mode: "native" | "wasm";
  endpoint?: string;
  connectionState: ConnectionState;
  connectionError?: string;
  /** while reconnecting: which attempt comes next, and when */
  retry?: RetryInfo;
  connectionDiscovery?: ConnectionDiscovery;
  availableConnections: ConnectionCandidate[];
  selectedConnectionId?: string;
  showConnectionModal: boolean;
  connect: (options?: ConnectOptions) => Promise<void>;
  disconnect: () => void;
  startDiscovery: () => void;
  stopDiscovery: () => void;
  setShowConnectionModal: (show: boolean) => void;
  setSelectedConnectionId: (id?: string) => void;
}

/** Where an endpoint comes from, in words; the page's own `/ws` needs none. */
const SOURCE_TEXTS: Record<EndpointSource, string | undefined> = {
  query: "From the address bar (?ws=)",
  manual: "Last manual entry",
  env: "Build default (VITE_WS_URL)",
  "same-origin": undefined,
};

/** The emulator that answered debugger.describe on the connection of the session: where, and the name it gave. */
export interface DescribedEmulator {
  endpoint: string;
  name: string;
}

/**
 * Who answered on the connection of the session, if anyone has: debugger.describe of this
 * connection has been answered with a name. (`initialized` is of the current connection only:
 * the session controller resets the data store when a connection ends, and every connection
 * that opens describes its server again. `shape` alone is still what the server before said.)
 */
const describedEmulator = (session: { endpoint?: string }) => {
  const data = useDebuggerDataStore.getState();
  const name = data.shape?.emulator.name.trim();
  if (!session.endpoint || !data.initialized || !name) {
    return undefined;
  }
  return { endpoint: session.endpoint, name } satisfies DescribedEmulator;
};

/** The host of a WebSocket endpoint, with its port: "127.0.0.1:55543". */
const hostOf = (url: string): string => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

/**
 * The name of a WebSocket endpoint in the picker: `<emulator> @ <host>` once the emulator there
 * has answered debugger.describe on the connection of the session, with the name it gave (the
 * emulator says "nullDC", the mock "nullDC (mock)"); the host alone before that (not connected,
 * connecting, a failed connection) and for every endpoint the session is not connected to. The
 * name is never kept from a connection before, and never stored.
 */
export const endpointLabel = (url: string, described?: DescribedEmulator): string =>
  described?.endpoint === url ? `${described.name} @ ${hostOf(url)}` : hostOf(url);

const readLastManual = (): string | null => {
  try {
    return window.localStorage.getItem(LAST_MANUAL_ENDPOINT_KEY);
  } catch {
    return null;
  }
};

const writeLastManual = (url: string | undefined) => {
  try {
    if (url === undefined) {
      window.localStorage.removeItem(LAST_MANUAL_ENDPOINT_KEY);
    } else {
      window.localStorage.setItem(LAST_MANUAL_ENDPOINT_KEY, url);
    }
  } catch (error) {
    console.warn("Failed to store the manual endpoint", error);
  }
};

/**
 * The WebSocket endpoints of this page, best first: `?ws=` of the URL (the part before the
 * `#`: the routes and the memory panel own what comes after it), the last endpoint entered
 * by hand, `VITE_WS_URL` of the build, and `/ws` on the host that served the page. Each is
 * named by `endpointLabel`.
 */
const webSocketCandidates = (described: DescribedEmulator | undefined): ConnectionCandidate[] =>
  resolveWebSocketEndpoints({
    search: window.location.search,
    lastManual: readLastManual(),
    envUrl: import.meta.env.VITE_WS_URL,
    location: window.location,
  }).map(({ url, source }) => ({
    id: url,
    name: endpointLabel(url, described),
    mode: "native" as const,
    lastSeen: Date.now(),
    source,
    ...(SOURCE_TEXTS[source] ? { sourceText: SOURCE_TEXTS[source] } : {}),
  }));

export const useSessionStore = create<SessionStore>()((set, get) => {
  /**
   * Names the WebSocket endpoints of the picker again (`endpointLabel`) when the description of
   * the session's server changed. A connection that ends resets the data store, so this runs at
   * the end of a connection too. An endpoint an emulator announced (wasm) keeps the name it gave
   * there.
   */
  const relabel = () => {
    const described = describedEmulator(get());
    const current = get().availableConnections;
    const next = current.map((candidate) => {
      if (candidate.source === undefined) {
        return candidate;
      }
      const name = endpointLabel(candidate.id, described);
      return name === candidate.name ? candidate : { ...candidate, name };
    });
    if (next.some((candidate, index) => candidate !== current[index])) {
      set({ availableConnections: next });
    }
  };

  // what the server said about itself: only the description, not every tick, can change a name
  useDebuggerDataStore.subscribe((data, before) => {
    if (data.initialized !== before.initialized || data.shape !== before.shape) {
      relabel();
    }
  });

  const controller = new SessionController<DebuggerClient>({
    createClient: (endpoint) =>
      new DebuggerClient({
        mode: endpoint.mode,
        endpoint: endpoint.id,
        transportOptions: endpoint.mode === "wasm" ? { channelName: endpoint.id } : undefined,
      }),
    publish: (snapshot) =>
      set({
        connectionState: snapshot.connectionState,
        connectionError: snapshot.connectionError,
        client: snapshot.client,
        retry: snapshot.retry,
        ...(snapshot.endpoint ? { endpoint: snapshot.endpoint.id } : {}),
      }),
    // every connection is described: after a reconnect the server can be another one
    onConnected: (client) => void useDebuggerDataStore.getState().initialize(client),
    onDisconnected: () => useDebuggerDataStore.getState().reset(),
    // The emulator of a BroadcastChannel session is another tab, and a channel to nobody
    // "opens" too: a reconnect on the clock would connect to an emulator that is gone. So in
    // a wasm build a reconnect waits for an announcement (announcedEndpoint says of whom).
    announcedSince:
      appConfig.mode === "wasm"
        ? (endpoint, since) => announcedEndpoint(get().connectionDiscovery?.getAvailableConnections() ?? [], endpoint, since)
        : undefined,
  });

  return {
    mode: appConfig.mode,
    connectionState: "idle",
    availableConnections: [],
    showConnectionModal: false,
    startDiscovery() {
      if (appConfig.mode === "native") {
        set({ availableConnections: webSocketCandidates(describedEmulator(get())) });
        return;
      }
      const current = get();
      if (current.connectionDiscovery) {
        return; // Already started
      }

      const discovery = new ConnectionDiscovery(appConfig.mode);
      discovery.onConnectionsChanged((connections) => {
        set({ availableConnections: connections });
      });
      discovery.start();
      set({ connectionDiscovery: discovery });
    },
    stopDiscovery() {
      const current = get();
      if (current.connectionDiscovery) {
        current.connectionDiscovery.stop();
        set({ connectionDiscovery: undefined, availableConnections: [] });
      }
    },
    setShowConnectionModal(show) {
      set({ showConnectionModal: show });
    },
    setSelectedConnectionId(id) {
      set({ selectedConnectionId: id });
    },
    async connect({ force, connectionId } = {}) {
      const current = get();
      if (!force && current.connectionState !== "idle" && current.connectionState !== "error") {
        return;
      }

      const native = appConfig.mode === "native";
      const candidates = native ? webSocketCandidates(describedEmulator(current)) : current.availableConnections;
      let target: SessionEndpoint | undefined;

      const wanted = connectionId?.trim() || current.selectedConnectionId;
      if (wanted) {
        const listed = candidates.find((candidate) => candidate.id === wanted);
        if (listed) {
          target = { id: listed.id, mode: listed.mode };
          // an endpoint picked from the list replaces what was once typed, unless it is that entry
          if (native && connectionId && listed.source !== "manual" && listed.source !== "query") {
            writeLastManual(undefined);
          }
        } else if (native) {
          // not in the list: an endpoint entered by hand
          const url = parseWebSocketUrl(wanted);
          if (!url) {
            controller.fail(`"${wanted}" is not a ws:// or wss:// URL`);
            return;
          }
          target = { id: url.href, mode: "native" };
          writeLastManual(url.href);
        } else {
          target = { id: wanted, mode: "wasm" };
        }
      } else if (native) {
        // the first of: ?ws=, the last manual entry, VITE_WS_URL, same-origin /ws
        target = candidates[0] ? { id: candidates[0].id, mode: "native" } : undefined;
      } else if (candidates.length === 1) {
        // Auto-connect to the only emulator that announced itself
        target = { id: candidates[0].id, mode: candidates[0].mode };
      }

      if (!target) {
        // nothing to connect to, or several emulators to choose from
        set({ showConnectionModal: true });
        return;
      }

      set({
        selectedConnectionId: target.id,
        showConnectionModal: false,
        ...(native ? { availableConnections: webSocketCandidates(describedEmulator(get())) } : {}),
      });
      await controller.start(target);
    },
    disconnect() {
      controller.stop();
    },
  };
});
