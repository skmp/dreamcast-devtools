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

export type ConnectionState = "idle" | "connecting" | "connected" | "error";

/** An endpoint the connection picker offers. `source` says where a WebSocket endpoint comes from. */
export interface ConnectionCandidate extends AvailableConnection {
  source?: EndpointSource;
}

interface ConnectOptions {
  /** connect even when a session exists: the user asked for it */
  force?: boolean;
  /** an entry of `availableConnections`, or what the user typed: a `ws://` / `wss://` URL, or the id of an emulator (wasm) */
  connectionId?: string;
}

interface SessionStore {
  client?: DebuggerClient;
  mode: "native" | "wasm";
  endpoint?: string;
  connectionState: ConnectionState;
  connectionError?: string;
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

const SOURCE_NAMES: Record<EndpointSource, (host: string) => string> = {
  query: () => "From the address bar (?ws=)",
  manual: () => "Last manual entry",
  env: () => "Build default (VITE_WS_URL)",
  "same-origin": (host) => `nullDC @ ${host}`,
};

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
 * by hand, `VITE_WS_URL` of the build, and `/ws` on the host that served the page.
 */
const webSocketCandidates = (): ConnectionCandidate[] =>
  resolveWebSocketEndpoints({
    search: window.location.search,
    lastManual: readLastManual(),
    envUrl: import.meta.env.VITE_WS_URL,
    location: window.location,
  }).map(({ url, source }) => ({
    id: url,
    name: SOURCE_NAMES[source](window.location.host),
    mode: "native" as const,
    lastSeen: Date.now(),
    source,
  }));

export const useSessionStore = create<SessionStore>()((set, get) => {
  return {
    mode: appConfig.mode,
    connectionState: "idle",
    availableConnections: [],
    showConnectionModal: false,
    startDiscovery() {
      if (appConfig.mode === "native") {
        set({ availableConnections: webSocketCandidates() });
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
      if (!force && (current.connectionState === "connecting" || current.connectionState === "connected")) {
        return;
      }

      current.client?.disconnect();

      const native = appConfig.mode === "native";
      const candidates = native ? webSocketCandidates() : current.availableConnections;
      let target: { id: string; mode: "native" | "wasm" } | undefined;

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
            set({ connectionState: "error", connectionError: `"${wanted}" is not a ws:// or wss:// URL`, client: undefined });
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

      const endpoint = target.id;
      const client = new DebuggerClient({
        mode: target.mode,
        endpoint,
        transportOptions: target.mode === "wasm" ? { channelName: endpoint } : undefined,
      });

      // Subscribe to transport state changes to keep connectionState in sync
      client.onTransportStateChange((state) => {
        if (get().client !== client) {
          // no longer the client of the session
          return;
        }
        if (state === "closed") {
          set({ connectionState: "error", connectionError: "Connection closed" });
        } else if (state === "open") {
          set({ connectionState: "connected" });
        }
      });

      set({
        connectionState: "connecting",
        connectionError: undefined,
        endpoint,
        client,
        selectedConnectionId: target.id,
        showConnectionModal: false,
        ...(native ? { availableConnections: webSocketCandidates() } : {}),
      });

      try {
        await client.connect();
        set({ connectionState: "connected" });
      } catch (error) {
        console.error("Failed to connect", error);
        client.disconnect();
        set({
          connectionState: "error",
          connectionError: error instanceof Error ? error.message : String(error),
          client: undefined,
        });
      }
    },
    disconnect() {
      get().client?.disconnect();
      set({ connectionState: "idle", connectionError: undefined, client: undefined });
    },
  };
});
