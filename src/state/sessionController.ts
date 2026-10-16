import type { AvailableConnection, TransportState } from "../services/transport";

// The life of a debugger session: connect, notice that the connection is gone, and connect
// again. No store, no DOM and no real client in here, so the rules can be tested with a
// clock that is stepped by hand; sessionStore runs it with the real things.
//
// The rules:
// - A session is started for an endpoint and lasts until it is stopped or another one is
//   started. While it lasts, the client wants to be connected to that endpoint.
// - When an attempt fails or an open connection closes, the state is "reconnecting" and the
//   next attempt is made 1, 2, 5 and then every 10 seconds after the failure before it.
//   A connection that opened starts the count again.
// - With `announcedSince` (the BroadcastChannel transport, where a connection to nobody
//   "opens" too) there is no clock: the next attempt waits until an emulator has announced
//   itself after the loss, and goes to the endpoint that did.
// - Every time a connection opens, `onConnected` runs: the server is described again.

export type ConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "error";

/** Seconds after a failure at which the next attempt is made; the last one repeats. */
export const RECONNECT_DELAYS_MS: readonly number[] = [1000, 2000, 5000, 10_000];

/** The wait before retry number `attempt` (1 is the first retry). */
export const reconnectDelayMs = (attempt: number): number =>
  RECONNECT_DELAYS_MS[Math.min(Math.max(attempt, 1), RECONNECT_DELAYS_MS.length) - 1];

/** How often an announcement is looked for while a session waits for one. */
export const ANNOUNCEMENT_POLL_MS = 500;

export interface SessionEndpoint {
  /** WebSocket URL, or the id of an emulator on the BroadcastChannel transport */
  id: string;
  mode: "native" | "wasm";
}

/**
 * Where a session that lost its emulator goes once emulators have announced themselves: to
 * the one it had, or to the only one there is. `connections` is what discovery has heard of,
 * and only what was heard after `since` (ms) counts: an announcement from before the loss can
 * be the last thing the emulator that is gone said. The emulator of a BroadcastChannel session
 * is another tab, and when it is reloaded it has a new id and the old one never answers
 * again. With several others to choose from there is no answer: the user picks.
 */
export const announcedEndpoint = (
  connections: ReadonlyArray<Pick<AvailableConnection, "id" | "lastSeen">>,
  endpoint: SessionEndpoint,
  since: number,
): SessionEndpoint | undefined => {
  const announced = connections.filter((connection) => connection.lastSeen > since);
  const target = announced.find((connection) => connection.id === endpoint.id) ?? (announced.length === 1 ? announced[0] : undefined);
  return target ? { id: target.id, mode: "wasm" } : undefined;
};

export interface SessionClient {
  connect(): Promise<void>;
  disconnect(): void;
  onTransportStateChange(handler: (state: TransportState, event?: Event | Error) => void): () => void;
}

export interface RetryInfo {
  /** 1 for the first attempt after the connection was lost or could not be made */
  attempt: number;
  /** the attempt starts this long after the failure; undefined while it waits for an announcement or runs */
  delayMs?: number;
  waitingForAnnouncement?: boolean;
}

export interface SessionSnapshot<C> {
  connectionState: ConnectionState;
  /** why the session is not connected */
  connectionError?: string;
  endpoint?: SessionEndpoint;
  /** the client of the open connection; undefined in every other state */
  client?: C;
  retry?: RetryInfo;
}

export interface SessionControllerDeps<C extends SessionClient> {
  createClient(endpoint: SessionEndpoint): C;
  /** the state changed */
  publish(snapshot: SessionSnapshot<C>): void;
  /** a connection opened: describe the server (again) */
  onConnected(client: C): void;
  /** the connection of the session is gone: nothing that came from it is live any more */
  onDisconnected(): void;
  /**
   * The endpoint to reconnect to once an emulator has announced itself after `since` (ms),
   * undefined while none has. Without it retries are timed.
   */
  announcedSince?(endpoint: SessionEndpoint, since: number): SessionEndpoint | undefined;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  now?(): number;
}

interface Session<C> {
  endpoint: SessionEndpoint;
  /** failed attempts and losses since the last open connection */
  failures: number;
  client?: C;
  /** the current client's connection opened */
  opened: boolean;
  unsubscribe?: () => void;
  timer?: unknown;
}

const failureText = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return typeof error === "string" && error ? error : fallback;
};

export class SessionController<C extends SessionClient> {
  private readonly deps: SessionControllerDeps<C>;
  private session: Session<C> | undefined;
  private current: SessionSnapshot<C> = { connectionState: "idle" };

  constructor(deps: SessionControllerDeps<C>) {
    this.deps = deps;
  }

  get snapshot(): SessionSnapshot<C> {
    return this.current;
  }

  /** Starts a session for an endpoint and makes the first attempt now. An earlier session ends. */
  async start(endpoint: SessionEndpoint): Promise<void> {
    this.end();
    const session: Session<C> = { endpoint, failures: 0, opened: false };
    this.session = session;
    await this.attempt(session, "connecting");
  }

  /** Ends the session: the client no longer wants a connection. */
  stop(): void {
    this.end();
    this.publish({ connectionState: "idle" });
  }

  /** A state without a session, for an endpoint that cannot even be tried. */
  fail(message: string): void {
    this.end();
    this.publish({ connectionState: "error", connectionError: message });
  }

  private publish(snapshot: SessionSnapshot<C>): void {
    this.current = snapshot;
    this.deps.publish(snapshot);
  }

  private setTimer(callback: () => void, ms: number): unknown {
    return this.deps.setTimer ? this.deps.setTimer(callback, ms) : setTimeout(callback, ms);
  }

  private clearTimer(handle: unknown): void {
    if (this.deps.clearTimer) {
      this.deps.clearTimer(handle);
    } else {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** Drops the session and its client without reporting a loss. */
  private end(): void {
    const session = this.session;
    if (!session) {
      return;
    }
    this.session = undefined;
    if (session.timer !== undefined) {
      this.clearTimer(session.timer);
      session.timer = undefined;
    }
    const wasOpen = session.opened;
    this.release(session);
    if (wasOpen) {
      this.deps.onDisconnected();
    }
  }

  /** Lets go of the session's client. Its "closed" is not a loss: the session is already past it. */
  private release(session: Session<C>): void {
    const client = session.client;
    session.unsubscribe?.();
    session.unsubscribe = undefined;
    session.client = undefined;
    session.opened = false;
    client?.disconnect();
  }

  private async attempt(session: Session<C>, state: "connecting" | "reconnecting"): Promise<void> {
    if (this.session !== session) {
      return;
    }
    const client = this.deps.createClient(session.endpoint);
    session.client = client;
    session.opened = false;
    session.unsubscribe = client.onTransportStateChange((transportState, event) => {
      // the end of a connection that had opened; a failed attempt is reported by connect()
      if (transportState === "closed" && this.session === session && session.client === client && session.opened) {
        this.lost(session, failureText(event, "Connection closed"));
      }
    });

    this.publish({
      connectionState: state,
      endpoint: session.endpoint,
      connectionError: state === "reconnecting" ? this.current.connectionError : undefined,
      retry: state === "reconnecting" ? { attempt: session.failures } : undefined,
    });

    try {
      await client.connect();
    } catch (error) {
      if (this.session === session && session.client === client) {
        this.release(session);
        this.retryLater(session, failureText(error, `Could not connect to ${session.endpoint.id}`));
      }
      return;
    }
    if (this.session !== session || session.client !== client) {
      // superseded while it was connecting
      client.disconnect();
      return;
    }
    session.opened = true;
    session.failures = 0;
    this.publish({ connectionState: "connected", endpoint: session.endpoint, client });
    this.deps.onConnected(client);
  }

  private lost(session: Session<C>, message: string): void {
    this.release(session);
    this.deps.onDisconnected();
    this.retryLater(session, message);
  }

  private retryLater(session: Session<C>, message: string): void {
    session.failures++;
    const attempt = session.failures;
    const announcedSince = this.deps.announcedSince;
    if (announcedSince) {
      const since = this.now();
      this.publish({
        connectionState: "reconnecting",
        connectionError: message,
        endpoint: session.endpoint,
        retry: { attempt, waitingForAnnouncement: true },
      });
      const poll = () => {
        session.timer = undefined;
        if (this.session !== session) {
          return;
        }
        const announced = announcedSince(session.endpoint, since);
        if (announced) {
          session.endpoint = announced;
          void this.attempt(session, "reconnecting");
        } else {
          session.timer = this.setTimer(poll, ANNOUNCEMENT_POLL_MS);
        }
      };
      session.timer = this.setTimer(poll, ANNOUNCEMENT_POLL_MS);
      return;
    }

    const delayMs = reconnectDelayMs(attempt);
    this.publish({
      connectionState: "reconnecting",
      connectionError: message,
      endpoint: session.endpoint,
      retry: { attempt, delayMs },
    });
    session.timer = this.setTimer(() => {
      session.timer = undefined;
      void this.attempt(session, "reconnecting");
    }, delayMs);
  }
}
