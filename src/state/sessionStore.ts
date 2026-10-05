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
import { SessionController, type ConnectionState, type RetryInfo, type SessionEndpoint } from "./sessionController";

export type { ConnectionState };

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
    // The emulator of a BroadcastChannel session is another tab. When it is reloaded it has a
    // new id and the old one never answers again, so a reconnect waits for an announcement:
    // of the same emulator, or of the only one there is.
    announcedSince:
      appConfig.mode === "wasm"
        ? (endpoint, since) => {
            const announced = (get().connectionDiscovery?.getAvailableConnections() ?? []).filter(
              (connection) => connection.lastSeen > since,
            );
            const target = announced.find((connection) => connection.id === endpoint.id) ?? (announced.length === 1 ? announced[0] : undefined);
            return target ? { id: target.id, mode: "wasm" } : undefined;
          }
        : undefined,
  });

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
      if (!force && current.connectionState !== "idle" && current.connectionState !== "error") {
        return;
      }

      const native = appConfig.mode === "native";
      const candidates = native ? webSocketCandidates() : current.availableConnections;
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
        ...(native ? { availableConnections: webSocketCandidates() } : {}),
      });
      await controller.start(target);
    },
    disconnect() {
      controller.stop();
    },
  };
});
