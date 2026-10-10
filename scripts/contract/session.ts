import { JsonRpcException } from "../../src/lib/jsonRpc";
import {
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

/**
 * How the server answers the requests of a run, over all of its connections: how many in a
 * row ran into the request timeout. An answer ends the row, an error as well as a result.
 * Not so an answer to `debugger.describe`: that is what the runner reads the server with
 * between scenarios, and a server that answers it and nothing else does not answer the
 * requests of the scenarios.
 */
export interface AnswerLog {
  /** the requests in a row that were not answered within the request timeout */
  unanswered: number;
  /** the method of the latest of them */
  latest?: string;
}

/**
 * This many request timeouts in a row, and the server has stopped answering: nothing more is
 * sent to it, and the scenarios that are left are failed as "not run" (design 5.5.1). A run
 * does not send each of their requests into its timeout.
 */
export const UNANSWERED_REQUESTS_LIMIT = 3;

/** The timeout of a request, before the factor of the profile. */
const REQUEST_TIMEOUT_MS = 10_000;

/** A request of the client that got no answer in time (the client's own error: it has no class of its own). */
const isRequestTimeout = (error: unknown): boolean =>
  error instanceof Error && !(error instanceof JsonRpcException) && !(error instanceof RpcValidationError) && error.message.startsWith("Request timed out: ");

export interface SessionOptions {
  /** the emulator profile multiplies every timeout of the scenarios by 5 */
  timeoutFactor: number;
  /** the log the connections of a run share; a session without one keeps its own */
  answers?: AnswerLog;
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
  private readonly answers: AnswerLog;
  private readonly requestTimeoutMs: number;
  private readonly waiters = new Set<() => void>();
  private readonly openedAt = Date.now();
  private seq = 0;
  private closed = false;
  private socketClosed = false;

  constructor(url: string, options: SessionOptions) {
    this.url = url;
    this.options = options;
    this.answers = options.answers ?? { unanswered: 0 };
    this.requestTimeoutMs = REQUEST_TIMEOUT_MS * options.timeoutFactor;
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
    // The tap applies the strict schema to every tick (I1), and nothing else reads ticks: the
    // client gets the schemas of the responses only, so that a tick is validated once.
    const { [RpcMethod.EVENT_TICK]: _tick, ...responseSchemas } = StrictDebuggerRpcMethodSchemas;
    this.rpc = new JsonRpcClient<DebuggerRpcSchema>(this.transport, {
      requestTimeoutMs: this.requestTimeoutMs,
      validationSchemas: responseSchemas,
      validateResponses: true,
      // the runner sends invalid requests on purpose
      validateParams: false,
    });
    this.rpc.onInvalidMessage((report) => {
      this.violations.push(`I1: ${report.message}`);
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
   * Sends debugger.describe (with the runner's own protocol number and name, unless `params`
   * says otherwise) and returns the response frame. A result that fails the strict
   * schema is kept in `describeProblems` (and is an I1 violation, as for every response) and
   * the session goes on with what the client's schema reads from it; only a describe without
   * a result the client can use fails here.
   */
  async requestDescribe(
    params: { protocol?: number; client?: string } = { protocol: PROTOCOL_VERSION, client: this.options.clientName },
  ): Promise<RecordedFrame> {
    const mark = this.mark();
    this.describeProblems = [];
    try {
      this.shape = (await this.request(RpcMethod.DEBUGGER_DESCRIBE, params)) as DebuggerShape;
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

  /**
   * Why the server counts as one that has stopped answering, if it does: several requests in a
   * row, on any connection of the run, ran into their timeout. Nothing more is sent to it.
   */
  get stoppedAnswering(): string | undefined {
    const { unanswered, latest } = this.answers;
    return unanswered >= UNANSWERED_REQUESTS_LIMIT
      ? `the server has stopped answering: ${unanswered} requests in a row were not answered within ${this.requestTimeoutMs} ms each (the latest: ${latest})`
      : undefined;
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

  /**
   * Drops what was recorded before `mark`, except the latest tick: for a scenario that causes
   * thousands of large ticks and needs none of them afterwards. Marks stay valid.
   */
  forget(mark: number): void {
    const latest = this.ticks.at(-1);
    const kept = this.ticks.filter((record) => record.seq >= mark || record === latest);
    this.ticks.splice(0, this.ticks.length, ...kept);
    const frames = this.frames.filter((frame) => frame.seq >= mark || frame.seq === latest?.seq);
    this.frames.splice(0, this.frames.length, ...frames);
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
   * Every request of the session goes through here, and is counted: one that runs into its
   * timeout adds to the row, one that is answered (with a result, with an error, or with what
   * the schema rejects) ends it, unless it is debugger.describe. To a server that has stopped
   * answering nothing is sent: the request fails at once.
   */
  private async request(method: string, params: unknown): Promise<unknown> {
    const stopped = this.stoppedAnswering;
    if (stopped) {
      throw new Error(`not sent: ${stopped}`);
    }
    const answered = () => {
      if (method !== RpcMethod.DEBUGGER_DESCRIBE) {
        this.answers.unanswered = 0;
        this.answers.latest = undefined;
      }
    };
    try {
      const result: unknown = await this.rpc.call(method as never, params as never);
      answered();
      return result;
    } catch (error) {
      if (isRequestTimeout(error)) {
        this.answers.unanswered++;
        this.answers.latest = method;
      } else if (error instanceof JsonRpcException || error instanceof RpcValidationError) {
        answered();
      }
      throw error;
    }
  }

  /**
   * A request that has to succeed: the result is validated with the strict schema, and for
   * an in-band method it has to be `{}`.
   */
  async call<M extends keyof DebuggerRpcSchema & string>(method: M, params: unknown): Promise<DebuggerRpcSchema[M]["result"]> {
    let result: unknown;
    try {
      result = await this.request(method, params);
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
   * A request that may succeed or be refused: its result, or its error with the channel it came
   * on. For a rule that has two answers (a step of an ARM7 that may be held in reset, a read
   * that one server answers with data and another with "nothing readable"). A request that is
   * not answered, or whose answer the schema rejects, fails as in `call`.
   */
  async outcome(method: string, params: unknown): Promise<{ result: unknown } | { error: { code: number; message: string }; inBand: boolean }> {
    try {
      const result = await this.request(method, params);
      const inBand = IN_BAND_ERROR_METHODS.has(method) ? (result as InBandResult | undefined)?.error : undefined;
      return inBand ? { error: inBand, inBand: true } : { result };
    } catch (error) {
      if (error instanceof JsonRpcException) {
        check(!IN_BAND_ERROR_METHODS.has(method) || error.code === -32601, `${method} ${JSON.stringify(params)}: the error ${error.code} came as a JSON-RPC error, this method reports failures in-band`);
        return { error: { code: error.code, message: error.message }, inBand: false };
      }
      return fail(callFailure(method, params, error));
    }
  }

  /**
   * A request that has to fail with `code`, on the channel of its method: in-band for the
   * methods whose result type is RpcError, a JSON-RPC error for the others (and for -32601).
   * The code is the contract. The message is a line for a person: it has to be there, and
   * what it says is the server's business (design 3.5).
   */
  async expectError(method: string, params: unknown, code: number): Promise<{ code: number; message: string }> {
    const inBandExpected = IN_BAND_ERROR_METHODS.has(method) && code !== -32601;
    const what = `${method} ${JSON.stringify(params)}`;
    let error: { code: number; message: string } | undefined;
    try {
      const result = await this.request(method, params);
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
    check(typeof error.message === "string" && error.message.length > 0, `${what}: the error ${code} has no message; error.message is a non-empty string`);
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
