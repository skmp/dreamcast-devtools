export type TransportState = "idle" | "connecting" | "open" | "closed";

export type TransportMessageHandler = (payload: string) => void;
export type BinaryMessageHandler = (payload: ArrayBuffer) => void;
export type TransportStateHandler = (state: TransportState, event?: Event | Error) => void;

export interface TransportOptions {
  protocols?: string | string[];
  channelName?: string;
}

export interface AvailableConnection {
  id: string;           // GUID for broadcast, URL for websocket
  name: string;         // Display name
  mode: "native" | "wasm";
  lastSeen: number;     // Timestamp
}

export type ConnectionsChangedHandler = (connections: AvailableConnection[]) => void;

export interface DebuggerTransport {
  readonly kind: "websocket" | "broadcast";
  readonly state: TransportState;
  connect(endpoint: string, options?: TransportOptions): Promise<void>;
  disconnect(code?: number, reason?: string): void;
  send(payload: string): void;
  subscribe(handler: TransportMessageHandler): () => void;
  /** Binary frames go to every subscriber; a subscriber picks its own by the frame header. */
  subscribeBinary(handler: BinaryMessageHandler): () => void;
  onStateChange(handler: TransportStateHandler): () => void;
}

type TimerHandle = ReturnType<typeof setTimeout>;
type IntervalHandle = ReturnType<typeof setInterval>;

// ---------------------------------------------------------------------------------------
// Endpoint resolution. The session store decides which endpoint to use; these are its
// inputs, kept here so they can be tested without a browser.
// ---------------------------------------------------------------------------------------

/** localStorage key of the last endpoint the user entered by hand. */
export const LAST_MANUAL_ENDPOINT_KEY = "nulldc-debugger-endpoint";

/** Name of the query parameter (before the `#`) that selects an endpoint: `?ws=ws://host:port/ws`. */
export const ENDPOINT_QUERY_PARAMETER = "ws";

export type EndpointSource = "query" | "manual" | "env" | "same-origin";

export interface ResolvedEndpoint {
  url: string;
  source: EndpointSource;
}

export interface EndpointInputs {
  /** `window.location.search`: the part before the `#` (the app uses HashRouter, and panels rewrite the hash query) */
  search?: string;
  /** the last manual entry (localStorage, `LAST_MANUAL_ENDPOINT_KEY`) */
  lastManual?: string | null;
  /** `import.meta.env.VITE_WS_URL` */
  envUrl?: string;
  /** `window.location`, for the same-origin `/ws` */
  location?: { protocol: string; host: string };
}

/** The text as a URL when it is a `ws://` or `wss://` URL, otherwise undefined. */
export const parseWebSocketUrl = (text: string | null | undefined): URL | undefined => {
  if (!text) {
    return undefined;
  }
  try {
    const url = new URL(text.trim());
    return url.protocol === "ws:" || url.protocol === "wss:" ? url : undefined;
  } catch {
    return undefined;
  }
};

export const isWebSocketUrl = (text: string | null | undefined): boolean => parseWebSocketUrl(text) !== undefined;

/** `/ws` on the host that served the page; `wss:` when the page was loaded over https. */
export const sameOriginWebSocketUrl = (location: { protocol: string; host: string }): string => {
  const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProtocol}//${location.host}/ws`;
};

/**
 * Every usable endpoint, best first: `?ws=`, the last manual entry, `VITE_WS_URL`,
 * same-origin `/ws`. Entries that are not `ws://` or `wss://` URLs are left out, and so is
 * the same-origin entry of a page that was not served over http(s).
 */
export const resolveWebSocketEndpoints = (inputs: EndpointInputs): ResolvedEndpoint[] => {
  const candidates: Array<{ text: string | null | undefined; source: EndpointSource }> = [];
  if (inputs.search) {
    candidates.push({ text: new URLSearchParams(inputs.search).get(ENDPOINT_QUERY_PARAMETER), source: "query" });
  }
  candidates.push({ text: inputs.lastManual, source: "manual" });
  candidates.push({ text: inputs.envUrl, source: "env" });
  if (inputs.location && (inputs.location.protocol === "http:" || inputs.location.protocol === "https:") && inputs.location.host) {
    candidates.push({ text: sameOriginWebSocketUrl(inputs.location), source: "same-origin" });
  }

  const resolved: ResolvedEndpoint[] = [];
  for (const { text, source } of candidates) {
    const url = parseWebSocketUrl(text);
    if (url && !resolved.some((entry) => entry.url === url.href)) {
      resolved.push({ url: url.href, source });
    }
  }
  return resolved;
};

/** The endpoint to connect to first, or undefined when there is none. */
export const resolveWebSocketEndpoint = (inputs: EndpointInputs): ResolvedEndpoint | undefined =>
  resolveWebSocketEndpoints(inputs)[0];

// ---------------------------------------------------------------------------------------

abstract class BaseTransport implements DebuggerTransport {
  public abstract readonly kind: DebuggerTransport["kind"];
  public state: TransportState = "idle";
  protected messageHandlers = new Set<TransportMessageHandler>();
  protected binaryHandlers = new Set<BinaryMessageHandler>();
  protected stateHandlers = new Set<TransportStateHandler>();

  abstract connect(endpoint: string, options?: TransportOptions): Promise<void>;
  abstract disconnect(code?: number, reason?: string): void;
  abstract send(payload: string): void;

  public subscribe(handler: TransportMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  public subscribeBinary(handler: BinaryMessageHandler): () => void {
    this.binaryHandlers.add(handler);
    return () => this.binaryHandlers.delete(handler);
  }

  public onStateChange(handler: TransportStateHandler): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  protected broadcastState(state: TransportState, event?: Event | Error) {
    this.state = state;
    Array.from(this.stateHandlers).forEach((handler) => handler(state, event));
  }

  protected broadcastMessage(payload: string) {
    Array.from(this.messageHandlers).forEach((handler) => handler(payload));
  }

  protected broadcastBinaryMessage(payload: ArrayBuffer) {
    Array.from(this.binaryHandlers).forEach((handler) => handler(payload));
  }
}

/** What the error or close event of a socket says, if anything. Browsers say nothing. */
const describeSocketEvent = (event: unknown): string | undefined => {
  if (!event || typeof event !== "object") {
    return undefined;
  }
  const { message, reason, code, error } = event as { message?: unknown; reason?: unknown; code?: unknown; error?: unknown };
  if (typeof message === "string" && message) {
    return message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof reason === "string" && reason) {
    return typeof code === "number" ? `${reason} (close code ${code})` : reason;
  }
  if (typeof code === "number" && code !== 1000 && code !== 1005) {
    return `close code ${code}`;
  }
  return undefined;
};

/**
 * Why a WebSocket did not open. A browser tells a page nothing about a failed connection
 * attempt (not even an HTTP status), so the text lists what it can be.
 */
export const connectFailureMessage = (endpoint: string, detail?: string): string =>
  detail
    ? `Could not connect to ${endpoint}: ${detail}`
    : `Could not connect to ${endpoint}: the server is not running, is not reachable or refused the connection ` +
      "(a refusal by the server's Host/Origin check looks the same to the page)";

export type WebSocketFactory = (endpoint: string, protocols?: string | string[]) => WebSocket;

const createWebSocket: WebSocketFactory = (endpoint, protocols) => new WebSocket(endpoint, protocols);

export class WebSocketTransport extends BaseTransport {
  public readonly kind = "websocket" as const;
  private socket?: WebSocket;
  private readonly createSocket: WebSocketFactory;

  /** `createSocket` replaces the global WebSocket (tests). */
  constructor(createSocket: WebSocketFactory = createWebSocket) {
    super();
    this.createSocket = createSocket;
  }

  async connect(endpoint: string, options?: TransportOptions): Promise<void> {
    if (this.socket && this.state === "open") {
      return;
    }

    this.state = "connecting";

    await new Promise<void>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = this.createSocket(endpoint, options?.protocols);
      } catch (error) {
        // e.g. not a ws:// URL, or a ws:// URL from an https page
        const failure = new Error(connectFailureMessage(endpoint, error instanceof Error ? error.message : String(error)));
        this.broadcastState("closed", failure);
        reject(failure);
        return;
      }
      ws.binaryType = "arraybuffer";
      this.socket = ws;

      let opened = false;
      let finished = false;
      let errorDetail: string | undefined;

      const finish = (event?: unknown) => {
        if (finished) {
          return;
        }
        finished = true;
        if (this.socket === ws) {
          this.socket = undefined;
        }
        if (!opened) {
          const failure = new Error(connectFailureMessage(endpoint, errorDetail ?? describeSocketEvent(event)));
          // closing a socket that never opened is harmless, and stops a late "open"
          try {
            ws.close();
          } catch {
            // already closed
          }
          this.broadcastState("closed", failure);
          reject(failure);
          return;
        }
        const detail = errorDetail ?? describeSocketEvent(event);
        this.broadcastState("closed", new Error(detail ? `Connection closed: ${detail}` : "Connection closed"));
      };

      ws.addEventListener("open", () => {
        if (finished) {
          return;
        }
        opened = true;
        this.broadcastState("open");
        resolve();
      });
      ws.addEventListener("message", (event: MessageEvent) => {
        if (finished) {
          return;
        }
        if (event.data instanceof ArrayBuffer) {
          this.broadcastBinaryMessage(event.data);
        } else {
          this.broadcastMessage(String(event.data));
        }
      });
      ws.addEventListener("error", (event: Event) => {
        errorDetail = describeSocketEvent(event) ?? errorDetail;
        if (!opened) {
          finish(event);
        }
        // after the open, the close event that follows reports the end of the connection
      });
      ws.addEventListener("close", (event: Event) => {
        finish(event);
      });
      this.finishSocket = finish;
    });
  }

  /** Ends the current connection attempt or connection as seen by the handlers. */
  private finishSocket?: (event?: unknown) => void;

  disconnect(code?: number, reason?: string) {
    const socket = this.socket;
    if (!socket) {
      return;
    }

    const finish = this.finishSocket;
    this.finishSocket = undefined;
    try {
      socket.close(code, reason);
    } catch {
      // an invalid code or reason; the socket is dropped anyway
    }
    // the handlers hear "closed" now, not when the peer has answered the close frame
    finish?.({ reason: "disconnected by the client" });
    this.socket = undefined;
  }

  send(payload: string) {
    // WebSocket.OPEN, by value: a socket supplied by a factory need not be the global class
    if (!this.socket || this.socket.readyState !== 1) {
      throw new Error("Not Connected");
    }

    this.socket.send(payload);
  }
}

export class BroadcastChannelTransport extends BaseTransport {
  public readonly kind = "broadcast" as const;
  private channel?: BroadcastChannel;
  private pingInterval?: IntervalHandle;
  private pongTimeout?: TimerHandle;
  private readonly PING_INTERVAL_MS = 1000;
  private readonly PONG_TIMEOUT_MS = 3000;

  async connect(endpoint: string, _options?: TransportOptions): Promise<void> {
    if (typeof BroadcastChannel === "undefined") {
      throw new Error("BroadcastChannel is not supported in this environment");
    }

    if (this.channel) {
      return;
    }

    this.state = "connecting";
    // endpoint is the GUID for broadcast channel mode
    const channelName = `dreamcast-devtools-${endpoint}`;
    const channel = new BroadcastChannel(channelName);
    this.channel = channel;

    channel.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.broadcastBinaryMessage(event.data);
      } else if (typeof event.data === "string") {
        // Handle ping/pong messages
        if (event.data === "pong") {
          if (this.pongTimeout !== undefined) {
            clearTimeout(this.pongTimeout);
            this.pongTimeout = undefined;
          }
          return;
        }
        this.broadcastMessage(event.data);
      }
    });

    channel.addEventListener("messageerror", (event) => {
      this.broadcastState("closed", event);
    });

    this.broadcastState("open");

    // Start ping/pong heartbeat
    this.startHeartbeat();
  }

  disconnect(): void {
    this.stopHeartbeat();

    if (!this.channel) {
      return;
    }
    this.channel.close();
    this.channel = undefined;
    this.broadcastState("closed", new Error("Connection closed"));
  }

  send(payload: string): void {
    if (!this.channel) {
      throw new Error("Not Connected");
    }
    this.channel.postMessage(payload);
  }

  private startHeartbeat(): void {
    // Send ping every second
    this.pingInterval = setInterval(() => {
      if (this.channel) {
        this.channel.postMessage("ping");

        // Expect a pong within 3 seconds of the first ping that is still unanswered. (One
        // timer, not one per ping: a pong cancels it, and a later ping must not replace it.)
        if (this.pongTimeout === undefined) {
          this.pongTimeout = setTimeout(() => {
            this.pongTimeout = undefined;
            console.warn("Pong timeout - connection lost");
            this.disconnect();
          }, this.PONG_TIMEOUT_MS);
        }
      }
    }, this.PING_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.pingInterval !== undefined) {
      clearInterval(this.pingInterval);
      this.pingInterval = undefined;
    }
    if (this.pongTimeout !== undefined) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = undefined;
    }
  }
}

export const createTransport = (
  mode: "native" | "wasm",
): DebuggerTransport => {
  if (mode === "native") {
    return new WebSocketTransport();
  }
  return new BroadcastChannelTransport();
};

// Connection discovery for both websocket and broadcast channel modes
export class ConnectionDiscovery {
  private mode: "native" | "wasm";
  private connections = new Map<string, AvailableConnection>();
  private announcementChannel?: BroadcastChannel;
  private cleanupInterval?: IntervalHandle;
  private handlers = new Set<ConnectionsChangedHandler>();
  private readonly EXPIRY_MS = 4000;
  private readonly CLEANUP_INTERVAL_MS = 1000;

  constructor(mode: "native" | "wasm") {
    this.mode = mode;
  }

  start(): void {
    if (this.mode === "wasm") {
      this.startBroadcastDiscovery();
    } else {
      this.startWebSocketDiscovery();
    }
  }

  stop(): void {
    if (this.announcementChannel) {
      this.announcementChannel.close();
      this.announcementChannel = undefined;
    }
    if (this.cleanupInterval !== undefined) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
    this.connections.clear();
  }

  getAvailableConnections(): AvailableConnection[] {
    return Array.from(this.connections.values());
  }

  onConnectionsChanged(handler: ConnectionsChangedHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private startBroadcastDiscovery(): void {
    if (typeof BroadcastChannel === "undefined") {
      console.warn("BroadcastChannel not supported");
      return;
    }

    // Listen for announcements
    this.announcementChannel = new BroadcastChannel("dreamcast-devtools-announce");
    this.announcementChannel.addEventListener("message", (event) => {
      try {
        // Handle both JSON string and object formats
        let announcement: { id: string; name: string; timestamp: number };
        if (typeof event.data === "string") {
          announcement = JSON.parse(event.data);
        } else {
          announcement = event.data as { id: string; name: string; timestamp: number };
        }

        if (announcement.id && announcement.name) {
          const connection: AvailableConnection = {
            id: announcement.id,
            name: announcement.name,
            mode: "wasm",
            lastSeen: Date.now(),
          };
          const isNew = !this.connections.has(announcement.id);
          this.connections.set(announcement.id, connection);
          if (isNew) {
            this.notifyHandlers();
          }
        }
      } catch (error) {
        console.error("Failed to parse announcement", error);
      }
    });

    // Cleanup expired connections
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const [id, conn] of this.connections.entries()) {
        if (now - conn.lastSeen > this.EXPIRY_MS) {
          this.connections.delete(id);
          changed = true;
        }
      }
      if (changed) {
        this.notifyHandlers();
      }
    }, this.CLEANUP_INTERVAL_MS);
  }

  private startWebSocketDiscovery(): void {
    // For WebSocket mode, return current host as the only connection
    const { host } = globalThis.location;
    const url = sameOriginWebSocketUrl(globalThis.location);

    // the host alone: who is there is known when the emulator has described itself
    // (the session store names an endpoint after that, sessionStore.ts endpointLabel)
    const connection: AvailableConnection = {
      id: url,
      name: host,
      mode: "native",
      lastSeen: Date.now(),
    };

    this.connections.set(url, connection);
    this.notifyHandlers();
  }

  private notifyHandlers(): void {
    const connections = this.getAvailableConnections();
    this.handlers.forEach((handler) => handler(connections));
  }
}
