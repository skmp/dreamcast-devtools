import { JsonRpcException } from "../../src/lib/jsonRpc";
import {
  DEBUGGER_ERROR_MESSAGES,
  DebuggerRpcMethodSchemas,
  IN_BAND_ERROR_METHODS,
  PROTOCOL_VERSION,
  RpcMethod,
  StrictDebuggerRpcMethodSchemas,
} from "../../src/lib/debuggerSchema";
import type { DebuggerRpcSchema, DebuggerShape, DebuggerTick } from "../../src/lib/debuggerSchema";
import { JsonRpcClient, RpcValidationError } from "../../src/services/jsonRpcClient";
import { WebSocketTransport } from "../../src/services/transport";
import { checkResponseEnvelope, checkTick, indexDescribe } from "./invariants";
import type { DescribeIndex, TickTracking } from "./invariants";

/** An assertion of a scenario that did not hold. `more`: further lines of the same finding, one each. */
export class ContractFailure extends Error {
  public readonly more: string[];

  constructor(message: string, more: string[] = []) {
    super(message);
    this.more = more;
  }
}

export const fail = (message: string, more?: string[]): never => {
  throw new ContractFailure(message, more);
};

export const check = (condition: unknown, message: string): void => {
  if (!condition) {
    fail(message);
  }
};

/** One frame as it arrived, in arrival order across responses and notifications. */
export interface RecordedFrame {
  seq: number;
  /** ms since the session was opened */
  at: number;
  kind: "tick" | "response" | "other";
  json: Record<string, unknown>;
}

export interface TickRecord {
  seq: number;
  at: number;
  tick: DebuggerTick;
}

/** A binary frame as it arrived. `seq` is its position among the text frames of the connection. */
export interface BinaryRecord {
  seq: number;
  at: number;
  data: ArrayBuffer;
}

export interface SessionOptions {
  /** the emulator profile multiplies every timeout of the scenarios by 5 */
  timeoutFactor: number;
  /** `client` of debugger.describe */
  clientName: string;
  /** receives one line per frame when --verbose is given */
  trace?: (line: string) => void;
  /** receives every tick of the connection as it arrives (the run keeps the ids it has seen) */
  onTick?: (tick: DebuggerTick) => void;
}

type InBandResult = { error?: { code: number; message: string } };

/**
 * One connection of the contract runner: JsonRpcClient on a WebSocketTransport (the
 * client's own classes, not the stores), with the strict schemas for every response, and a
 * tap on the transport that sees every frame before the client does. The tap applies the
 * invariants to every tick and the envelope rules to every response; what it finds goes to
 * `violations`, whatever the scenario that was running asserts.
 */
export class ContractSession {
  public readonly url: string;
  public readonly frames: RecordedFrame[] = [];
  public readonly ticks: TickRecord[] = [];
  public readonly binary: BinaryRecord[] = [];
  public readonly violations: string[] = [];
  public shape!: DebuggerShape;
  public index: DescribeIndex | undefined;
  /**
   * Every issue the strict schema has with the latest debugger.describe result, as
   * `<path>: <message>`; empty when the result is valid. Such a result does not end the run:
   * it is what S01 reports, and `shape` is then what the client's own schema makes of it.
   */
  public describeProblems: string[] = [];
  public ticksChecked = 0;
  private readonly options: SessionOptions;
  private readonly transport: WebSocketTransport;
  private readonly rpc: JsonRpcClient<DebuggerRpcSchema>;
  private readonly tracking: TickTracking = {};
  private readonly waiters = new Set<() => void>();
  private readonly openedAt = Date.now();
  private seq = 0;
  private closed = false;
  private socketClosed = false;

  constructor(url: string, options: SessionOptions) {
    this.url = url;
    this.options = options;
    this.transport = new WebSocketTransport((endpoint, protocols) => {
      const socket = new WebSocket(endpoint, protocols);
      // The transport says "closed" as soon as disconnect() is called. This is the close event
      // of the socket itself: the closing handshake is over, the server has seen the close.
      socket.addEventListener("close", () => {
        this.socketClosed = true;
        this.wake();
      });
      return socket;
    });
    // The tap is subscribed before the client: it sees a frame first, and it sees the ticks
    // the client drops. It is also what makes the runner independent of when the client
    // dispatches: both frames of "response, then tick" can arrive in one turn.
    this.transport.subscribe((payload) => this.onText(payload));
    this.transport.subscribeBinary((data) => {
      // binary frames are numbered with the text frames: "response first, binary frame second" is an order
      this.binary.push({ seq: this.seq++, at: Date.now() - this.openedAt, data });
      this.options.trace?.(`<- binary frame, ${data.byteLength} bytes`);
      this.wake();
    });
    this.rpc = new JsonRpcClient<DebuggerRpcSchema>(this.transport, {
      requestTimeoutMs: 10_000 * options.timeoutFactor,
      validationSchemas: StrictDebuggerRpcMethodSchemas,
      validateResponses: true,
      // the runner sends invalid requests on purpose
      validateParams: false,
    });
    this.rpc.onInvalidMessage((report) => {
      // ticks are reported by the tap, with the same strict schema
      if (report.kind !== "notification") {
        this.violations.push(`I1: ${report.message}`);
      }
    });
    this.transport.onStateChange((state) => {
      if (state === "closed") {
        this.closed = true;
        this.wake();
      }
    });
  }

  /**
   * Connects (an error that is not a ContractFailure: there is no server to test), sends
   * debugger.describe and waits for the tick that follows it.
   */
  async open(): Promise<void> {
    await this.rpc.connect(this.url);
    await this.describe();
  }

  /**
   * Sends debugger.describe and returns the tick that follows the response. The result
   * replaces `shape` and `index`: capabilities describe the server at the moment of the call,
   * so what was read before the machine had started is not what holds afterwards.
   */
  async describe(): Promise<TickRecord> {
    const response = await this.requestDescribe();
    // A periodic tick can arrive before the response; the one to wait for comes after it.
    return this.waitForTick(() => true, 2000, "the tick that follows debugger.describe", response.seq);
  }

  /**
   * Sends debugger.describe and returns the response frame. A result that fails the strict
   * schema is kept in `describeProblems` (and is an I1 violation, as for every response) and
   * the session goes on with what the client's schema reads from it; only a describe without
   * a result the client can use fails here.
   */
  async requestDescribe(): Promise<RecordedFrame> {
    const mark = this.mark();
    const params = { protocol: PROTOCOL_VERSION, client: this.options.clientName };
    this.describeProblems = [];
    try {
      this.shape = await this.rpc.call(RpcMethod.DEBUGGER_DESCRIBE, params);
    } catch (error) {
      const lenient =
        error instanceof RpcValidationError
          ? DebuggerRpcMethodSchemas[RpcMethod.DEBUGGER_DESCRIBE].result.safeParse(this.responseSince(mark)?.json.result)
          : undefined;
      if (!(error instanceof RpcValidationError) || !lenient?.success) {
        return fail(callFailure(RpcMethod.DEBUGGER_DESCRIBE, params, error));
      }
      this.describeProblems = error.issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message));
      this.shape = lenient.data;
    }
    this.index = indexDescribe(this.shape);
    // (the tap has indexed the same result already, before the tick that follows it)
    return this.responseSince(mark) ?? fail("the debugger.describe response was not recorded");
  }

  get isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    this.rpc.disconnect();
  }

  /**
   * Closes the connection and waits for the close event of the socket, at most `timeoutMs`
   * (not scaled). Returns whether the socket finished closing in that time.
   */
  async closeAndWait(timeoutMs: number): Promise<boolean> {
    this.close();
    const deadline = Date.now() + timeoutMs;
    while (!this.socketClosed) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return false;
      }
      await this.sleepOrWake(remaining);
    }
    return true;
  }

  /** Resolves when the server has closed the connection. */
  async untilClosed(): Promise<void> {
    while (!this.closed) {
      await new Promise<void>((resolve) => this.waiters.add(resolve));
    }
  }

  /** The position in the frame sequence; frames with `seq >= mark()` arrive after this call. */
  mark(): number {
    return this.seq;
  }

  /** The first response at or after `mark`: that of a request sent right after `mark()`, the runner sends one at a time. */
  responseSince(mark: number): RecordedFrame | undefined {
    return this.frames.find((frame) => frame.seq >= mark && frame.kind === "response");
  }

  scale(ms: number): number {
    return ms * this.options.timeoutFactor;
  }

  // -------------------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------------------

  /**
   * A request that has to succeed: the result is validated with the strict schema, and for
   * an in-band method it has to be `{}`.
   */
  async call<M extends keyof DebuggerRpcSchema & string>(method: M, params: unknown): Promise<DebuggerRpcSchema[M]["result"]> {
    let result: unknown;
    try {
      result = await this.rpc.call(method, params as never);
    } catch (error) {
      return fail(callFailure(method, params, error));
    }
    if (IN_BAND_ERROR_METHODS.has(method)) {
      const inBand = (result as InBandResult).error;
      if (inBand) {
        return fail(`${method} ${JSON.stringify(params)}: in-band error ${inBand.code} "${inBand.message}"`);
      }
      // the success result of every method whose result type is RpcError is the empty object
      check(Object.keys(result as object).length === 0, `${method}: the success result is {}, got ${JSON.stringify(result)}`);
    }
    return result as DebuggerRpcSchema[M]["result"];
  }

  /**
   * A request that has to fail with `code`, on the channel of its method: in-band for the
   * methods whose result type is RpcError, a JSON-RPC error for the others (and for -32601).
   * The message has to be the one the protocol gives for the code.
   */
  async expectError(method: string, params: unknown, code: number): Promise<{ code: number; message: string }> {
    const inBandExpected = IN_BAND_ERROR_METHODS.has(method) && code !== -32601;
    const what = `${method} ${JSON.stringify(params)}`;
    let error: { code: number; message: string } | undefined;
    try {
      const result = await this.rpc.call(method as never, params as never);
      const inBand = (result as InBandResult | undefined)?.error;
      if (!inBand) {
        return fail(`${what}: expected the error ${code}, got the result ${JSON.stringify(result).slice(0, 200)}`);
      }
      check(inBandExpected, `${what}: the error ${inBand.code} came in-band, this method reports failures as JSON-RPC errors`);
      error = inBand;
    } catch (failure) {
      if (failure instanceof ContractFailure) {
        throw failure;
      }
      if (!(failure instanceof JsonRpcException)) {
        return fail(`${what}: ${failure instanceof Error ? failure.message : String(failure)}`);
      }
      check(!inBandExpected, `${what}: the error ${failure.code} came as a JSON-RPC error, this method reports failures in-band`);
      error = { code: failure.code, message: failure.message };
    }
    check(error.code === code, `${what}: expected the error ${code}, got ${error.code} "${error.message}"`);
    const pattern = DEBUGGER_ERROR_MESSAGES[code];
    check(!pattern || pattern.test(error.message), `${what}: the message of ${code} is ${String(pattern)}, got "${error.message}"`);
    return error;
  }

  // -------------------------------------------------------------------------------------
  // Ticks
  // -------------------------------------------------------------------------------------

  latestTick(): TickRecord {
    const last = this.ticks.at(-1);
    return last ?? fail("no tick has arrived on this connection");
  }

  ticksSince(mark: number): TickRecord[] {
    return this.ticks.filter((record) => record.seq >= mark);
  }

  /**
   * The first tick at or after `since` that satisfies the predicate; waits up to `timeoutMs`
   * (scaled by the profile) for it. `since` is a `mark()` taken BEFORE the request that
   * causes the tick: the tick can arrive in the same turn as the response.
   */
  async waitForTick(predicate: (tick: DebuggerTick) => boolean, timeoutMs: number, what: string, since: number): Promise<TickRecord> {
    const deadline = Date.now() + this.scale(timeoutMs);
    let examined = 0;
    for (;;) {
      const candidates = this.ticksSince(since);
      for (; examined < candidates.length; examined++) {
        if (predicate(candidates[examined].tick)) {
          return candidates[examined];
        }
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0 || this.closed) {
        const seen = candidates.map((record) => describeState(record.tick)).slice(-6).join(", ");
        return fail(
          `${what}: not seen within ${this.scale(timeoutMs)} ms${this.closed ? " (the connection closed)" : ""}; ` +
            `ticks since then: ${candidates.length}${seen ? ` (${seen})` : ""}`,
        );
      }
      await this.sleepOrWake(remaining);
    }
  }

  /** Waits for `ms` (scaled) and returns the ticks that arrived meanwhile. */
  async collectTicks(ms: number): Promise<TickRecord[]> {
    const mark = this.mark();
    await new Promise<void>((resolve) => setTimeout(resolve, this.scale(ms)));
    return this.ticksSince(mark);
  }

  /** The next binary frame at or after index `from` of `binary`, or undefined after `timeoutMs` (not scaled). */
  async waitForBinary(from: number, timeoutMs: number): Promise<BinaryRecord | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (this.binary.length <= from) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || this.closed) {
        return undefined;
      }
      await this.sleepOrWake(remaining);
    }
    return this.binary[from];
  }

  // -------------------------------------------------------------------------------------

  private sleepOrWake(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, Math.min(ms, 250));
      this.waiters.add(finish);
    });
  }

  private wake(): void {
    Array.from(this.waiters).forEach((waiter) => waiter());
  }

  private onText(payload: string): void {
    const seq = this.seq++;
    const at = Date.now() - this.openedAt;
    let json: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(payload);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not an object");
      }
      json = parsed as Record<string, unknown>;
    } catch {
      this.violations.push(`3.0: a text frame that is not a JSON object: ${payload.slice(0, 120)}`);
      return;
    }

    if (json.method === "event.tick") {
      const found = checkTick(json.params, this.index, this.tracking);
      this.ticksChecked++;
      for (const violation of found) {
        this.violations.push(`${violation} (tick ${String((json.params as { tickId?: unknown } | undefined)?.tickId)})`);
      }
      const keys = Object.keys(json).sort().join(",");
      if (keys !== "jsonrpc,method,params") {
        this.violations.push(`3.0: a notification has the keys jsonrpc, method and params, this one has ${keys}`);
      }
      this.frames.push({ seq, at, kind: "tick", json });
      // Ticks the strict schema rejected are still ticks for the scenarios: they report what they need
      this.ticks.push({ seq, at, tick: json.params as DebuggerTick });
      this.options.onTick?.(json.params as DebuggerTick);
      this.options.trace?.(`<- tick ${describeState(json.params as DebuggerTick)}`);
    } else if (typeof json.method === "string") {
      // the server sends no requests, and event.tick is the only notification
      this.violations.push(`3.0: the server sent "${json.method}"; event.tick is the only notification`);
      this.frames.push({ seq, at, kind: "other", json });
    } else {
      for (const violation of checkResponseEnvelope(json)) {
        this.violations.push(`${violation} (response to request ${String(json.id)})`);
      }
      // The latest describe result is the reference for I4 and I5. It is taken here, not when
      // the call returns: the tick that follows the response can be dispatched before that.
      const result = json.result as { deviceTree?: unknown } | undefined;
      if (result && typeof result === "object" && Array.isArray(result.deviceTree)) {
        try {
          this.index = indexDescribe(result as DebuggerShape);
        } catch {
          // a tree the strict schema is about to reject
        }
      }
      this.frames.push({ seq, at, kind: "response", json });
      this.options.trace?.(`<- ${payload.length > 240 ? `${payload.slice(0, 240)}...` : payload}`);
    }
    this.wake();
  }
}

/** Why a request that had to succeed did not. */
const callFailure = (method: string, params: unknown, error: unknown): string =>
  error instanceof JsonRpcException
    ? `${method} ${JSON.stringify(params)}: JSON-RPC error ${error.code} "${error.message}"`
    : `${method} ${JSON.stringify(params)}: ${error instanceof Error ? error.message : String(error)}`;

export const describeState = (tick: DebuggerTick): string => {
  const state = tick.executionState;
  if (!state) {
    return "?";
  }
  const parts = [`#${tick.tickId}`, state.state, `stop ${state.stopId}`];
  if (state.reason) {
    parts.push(state.reason);
  }
  if (state.breakpointId !== undefined) {
    parts.push(`bp ${state.breakpointId}`);
  }
  return parts.join(" ");
};
