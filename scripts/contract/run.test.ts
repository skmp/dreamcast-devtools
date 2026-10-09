import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { MOCK_M1_SUPPORT, MOCK_SH4_RING, MockDebugger } from "../../server/mockDebugger";
import type { MockClient, MockConnection, MockDebuggerOptions } from "../../server/mockDebugger";
import { listenMockDebugger } from "../../server/mockWebSocket";
import { isSh4ControlFlow, isSh4DelayedBranch } from "./disasm";
import { spawn } from "node:child_process";
import { runContract } from "./run";
import { SCENARIOS, scenariosOfMilestone, selectScenarios } from "./scenarios";
import type { ContractSummary } from "./run";
import { ContractFailure } from "./session";

/**
 * The runner against the mock, and against the mock behind a proxy that breaks the
 * protocol in one way per test: a runner that passes a broken server proves nothing.
 */

type Json = Record<string, unknown>;

interface Faults {
  /** rewrites a frame of the server; undefined drops it; an array sends several */
  toClient?: (frame: Json) => Json | Json[] | undefined;
  /** rewrites a request of the client */
  toServer?: (frame: Json) => Json;
  /** frames the client receives after it has sent a request and before the server sees that request */
  beforeRequest?: (request: Json) => Json[];
  /** answers a request in the server's place: the server does not see a request this returns a frame for */
  answer?: (request: Json) => Json | undefined;
  /** a frame of the client for which this is true is lost: the server does not see it, and nothing answers it */
  lose?: (request: unknown) => boolean;
  /** rewrites a binary frame of the server */
  toClientBinary?: (frame: Buffer) => Buffer;
  /** a frame of the server for which this is true is held back until the next binary frame has been sent */
  afterNextBinary?: (frame: Json) => boolean;
}

/** One set of faults for every connection, or a function that makes one per connection (faults that keep state). */
type FaultSource = Faults | (() => Faults);

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close();
  }
});

/**
 * The mock on a WebSocket, optionally behind a proxy that applies `faults`. Returns the URL
 * to test, and `direct`, the URL of the mock itself (what a client sees that is not behind
 * the proxy).
 */
const startServer = async (
  source?: FaultSource,
  options?: MockDebuggerOptions | MockDebugger,
): Promise<{ url: string; direct: string; mock: MockDebugger }> => {
  const mock = options instanceof MockDebugger ? options : new MockDebugger(options);
  const listener = await listenMockDebugger(mock);
  closers.push(() => listener.close());
  if (!source) {
    return { url: listener.url, direct: listener.url, mock };
  }

  const proxy = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => proxy.once("listening", resolve));
  closers.unshift(
    () =>
      new Promise<void>((resolve) => {
        proxy.clients.forEach((client) => client.terminate());
        proxy.close(() => resolve());
      }),
  );
  proxy.on("connection", (client) => {
    const faults = typeof source === "function" ? source() : source;
    const upstream = new WebSocket(listener.url);
    const early: string[] = [];
    const held: Json[] = [];
    client.on("message", (data) => {
      let text = data.toString();
      let answered: Json | undefined;
      try {
        const request = JSON.parse(text) as Json;
        if (faults.lose?.(request)) {
          return;
        }
        faults.beforeRequest?.(request).forEach((frame) => client.send(JSON.stringify(frame)));
        answered = faults.answer?.(request);
        if (faults.toServer) {
          text = JSON.stringify(faults.toServer(request));
        }
      } catch {
        // not JSON: the runner's malformed frame goes through as it is
      }
      if (answered) {
        client.send(JSON.stringify(answered));
        return;
      }
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(text);
      } else {
        early.push(text);
      }
    });
    upstream.on("open", () => early.splice(0).forEach((text) => upstream.send(text)));
    upstream.on("message", (data, isBinary) => {
      if (isBinary) {
        const frame = Buffer.from(data as Buffer);
        client.send(faults.toClientBinary ? faults.toClientBinary(frame) : frame, { binary: true });
        held.splice(0).forEach((late) => client.send(JSON.stringify(late)));
        return;
      }
      const frame = JSON.parse(data.toString()) as Json;
      if (faults.afterNextBinary?.(frame)) {
        held.push(frame);
        return;
      }
      const rewritten = faults.toClient ? faults.toClient(frame) : frame;
      for (const out of rewritten === undefined ? [] : Array.isArray(rewritten) ? rewritten : [rewritten]) {
        client.send(JSON.stringify(out));
      }
    });
    client.on("close", () => upstream.close());
    upstream.on("close", () => client.close());
    upstream.on("error", () => client.close());
  });
  return { url: `ws://127.0.0.1:${(proxy.address() as AddressInfo).port}/ws`, direct: listener.url, mock };
};

const run = async (faults: FaultSource | undefined, only?: string[], options?: MockDebuggerOptions): Promise<ContractSummary> => {
  const { url } = await startServer(faults, options);
  return runContract({ url, profile: "mock", only: only ? new Set(only) : undefined });
};

/** What a new client of the server sees: the tick that follows its debugger.describe. */
const stateOf = async (url: string): Promise<Json & { executionState: Json; breakpoints: Record<string, Json>; watches: Json[]; categories: Record<string, Json> }> => {
  const probe = new WebSocket(url);
  try {
    return await new Promise((resolve, reject) => {
      probe.on("error", reject);
      probe.on("open", () => probe.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "debugger.describe", params: {} })));
      let described = false;
      probe.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Json;
        if (frame.id === 1) {
          described = true;
        } else if (described && isTick(frame)) {
          resolve(frame.params as never);
        }
      });
    });
  } finally {
    probe.close();
  }
};

/** Sends requests to the server as another client would, and resolves when the last one is answered. */
const request = async (url: string, requests: Array<[method: string, params: Json]>): Promise<void> => {
  const socket = new WebSocket(url);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.on("error", reject);
      socket.on("open", () => requests.forEach(([method, params], index) => socket.send(JSON.stringify({ jsonrpc: "2.0", id: index + 1, method, params }))));
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Json;
        if (frame.id === requests.length) {
          resolve();
        }
      });
    });
  } finally {
    socket.close();
  }
};

/** One request to the mock as a client of its own (no socket), and what it answered. */
const ask = (mock: MockDebugger, method: string, params: Json): Json => {
  const frames: Json[] = [];
  const client = mock.connect({ sendText: (text) => frames.push(JSON.parse(text) as Json), sendBinary: () => undefined });
  client.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  client.close();
  return frames.find((frame) => frame.id === 1)!;
};

const isTick = (frame: Json): frame is Json & { params: Json & { executionState: Json; registers: Record<string, Json[]> } } =>
  frame.method === "event.tick";

/** The answers of a server that refuses a request: on the channel of the result, or as a JSON-RPC error. */
const inBand = (request: Json, code: number, message: string): Json => ({ jsonrpc: "2.0", id: request.id, result: { error: { code, message } } });
const rpcError = (request: Json, code: number, message: string): Json => ({ jsonrpc: "2.0", id: request.id, error: { code, message } });
const paramsOf = (request: Json): Json => (request.params ?? {}) as Json;

/** A frame of the server with the message of every error it carries, on either channel, replaced by `text(code, message)`. */
const worded = (frame: Json, text: (code: number, message: string) => string): Json => {
  const reword = (error: Json) => ({ ...error, message: text(error.code as number, error.message as string) });
  if (frame.error) {
    return { ...frame, error: reword(frame.error as Json) };
  }
  const inBandError = (frame.result as Json | undefined)?.error as Json | undefined;
  return inBandError && typeof inBandError === "object" ? { ...frame, result: { ...(frame.result as Json), error: reword(inBandError) } } : frame;
};

const statusOf = (summary: ContractSummary, id: string) => summary.scenarios.find((scenario) => scenario.id === id)?.status;
const detailsOf = (summary: ContractSummary, id: string) => summary.scenarios.find((scenario) => scenario.id === id)?.details.join("\n") ?? "";

/** What a run of every scenario against the mock reports, when the mock follows the protocol. */
const MOCK_STATUSES = {
  S00: "not-applicable", // emulator only
  S01: "passed",
  S02: "passed",
  S03: "passed",
  S04: "passed",
  S05: "passed",
  S06: "passed",
  S07: "passed",
  S08: "passed",
  S09: "passed",
  S10: "passed",
  S11: "passed",
  S12: "passed",
  S13: "passed",
  S14: "passed",
  S15: "not-applicable", // emulator only
  S16: "partial", // the mock steps the ARM7 and writes registers; it has no memory write and no reset
  S17: "passed",
  S18: "not-applicable", // no tables, no Holly capture
  S21: "not-applicable", // the run with the DSP test program only
};

const statusesOf = (summary: ContractSummary) => Object.fromEntries(summary.scenarios.map((scenario) => [scenario.id, scenario.status]));
/** One line per scenario that did not pass as a whole, for a readable failure of a test. */
const reportOf = (summary: ContractSummary) => summary.scenarios.map((scenario) => `${scenario.id} ${scenario.status} ${scenario.details.join(" | ")}`);

/**
 * A mock that counts reconnects, and that can do what a server must not do when its last
 * client has gone: `forget` gets the state at that moment and returns the requests that undo it.
 */
class ForgetfulMock extends MockDebugger {
  /** how often a client connected while the server had none, after it had had one */
  public reconnects = 0;
  private hadNone = false;
  private readonly forget: (tick: Json) => Array<[method: string, params: Json]>;

  constructor(forget: (tick: Json) => Array<[method: string, params: Json]> = () => [], options?: MockDebuggerOptions) {
    super(options);
    this.forget = forget;
  }

  override connect(connection: MockConnection): MockClient {
    if (this.hadNone) {
      this.hadNone = false;
      this.reconnects++;
    }
    const client = super.connect(connection);
    return {
      id: client.id,
      receive: (text) => client.receive(text),
      close: () => {
        client.close();
        if (this.clientCount === 0) {
          this.hadNone = true;
          this.lastClientLeft();
        }
      },
    };
  }

  private lastClientLeft(): void {
    const frames: Json[] = [];
    const hidden = super.connect({ sendText: (text) => frames.push(JSON.parse(text) as Json), sendBinary: () => undefined });
    hidden.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "debugger.describe", params: {} }));
    const requests = this.forget(frames.find(isTick)!.params);
    requests.forEach(([method, params], index) => hidden.receive(JSON.stringify({ jsonrpc: "2.0", id: index + 2, method, params })));
    hidden.close();
  }
}

/**
 * A tick that the server built before it handled a request, and that arrives after the
 * client has sent that request: a copy of the last tick, under the next tickId, in front of
 * the answer to every request. Nothing in the protocol forbids it (a periodic tick, or one
 * more tick of a stop, built on another thread). One per connection.
 */
const staleTickBeforeEveryAnswer = (): Faults => {
  let tickId = 0;
  let last: (Json & { params: Json }) | undefined;
  const renumbered = (frame: Json & { params: Json }) => ({ ...frame, params: { ...frame.params, tickId: tickId++ } });
  return {
    toClient: (frame) => {
      if (!isTick(frame)) return frame;
      last = frame;
      return renumbered(frame);
    },
    beforeRequest: () => (last ? [renumbered(last)] : []),
  };
};

/** Drops the one tick that follows the response to a request for which `matches` is true. One per connection. */
const noTickAfter = (matches: (request: Json) => boolean): Faults => {
  const ids = new Set<unknown>();
  let drop = false;
  return {
    toServer: (frame) => {
      if (matches(frame)) ids.add(frame.id);
      return frame;
    },
    toClient: (frame) => {
      if (isTick(frame)) {
        const dropped = drop;
        drop = false;
        return dropped ? undefined : frame;
      }
      drop = ids.delete(frame.id);
      return frame;
    },
  };
};

/** S08 adds a stored expression once more, with the register name in upper case: the one state.watch that changes nothing. */
const isWatchOfStoredExpression = (frame: Json) =>
  frame.method === "state.watch" && ((frame.params as Json).expressions as string[]).some((expression) => /[A-Z]/.test(expression));

describe("the contract runner against the mock", () => {
  it("passes every scenario the mock's milestone covers, reports the rest as not applicable, and leaves the server as it found it", async () => {
    const { url, mock } = await startServer();
    const lines: string[] = [];
    const summary = await runContract({ url, profile: "mock", say: (line) => lines.push(line) });

    expect(summary.invariantViolations).toEqual([]);
    expect(summary.cleanUpProblems).toEqual([]);
    expect(statusesOf(summary)).toEqual(MOCK_STATUSES);
    expect(summary.ok).toBe(true);
    expect(summary).toMatchObject({ passed: 15, failed: 0, partial: 1, notApplicable: 4, profile: "mock", timeoutFactor: 1 });
    // nothing was asked to pass: the runner looked at a server
    expect(summary).toMatchObject({ required: [], requiredNotPassed: [], nothingVerified: false, dspProgram: false });
    expect(summary.selected).toEqual(SCENARIOS.map((scenario) => scenario.id));
    expect(summary.scenarios.find((scenario) => scenario.id === "S16")?.parts).toEqual([
      { name: "arm7 step and breakpoint", status: "passed" },
      { name: "writeMemory", status: "not-applicable", detail: 'no capability "memory-write"' },
      { name: "setRegister", status: "passed" },
      { name: "reset", status: "not-applicable", detail: 'no capability "reset"' },
    ]);
    expect(summary.ticksChecked).toBeGreaterThan(50);
    expect(summary.server).toMatchObject({ protocol: 3, emulator: { name: "nullDC (mock)" } });
    // one line per scenario, and the verdict
    for (const scenario of summary.scenarios) {
      expect(lines.filter((line) => line.startsWith(`${scenario.id} `))).toHaveLength(1);
    }
    expect(lines.at(-1)).toBe("contract: OK");

    // nothing of the run is left: no breakpoints, no watches, nothing muted, running as before
    const after = await runContract({ url, profile: "mock", only: new Set(["S01"]) });
    expect(after.finalState).toMatch(/running/);
    const tick = await stateOf(url);
    expect(tick.breakpoints).toEqual({});
    expect(tick.watches).toEqual([]);
    const unmuted = { muted: false, soloed: false };
    expect(tick.categories).toEqual({ events: unmuted, sh4: unmuted, arm7: unmuted, dsp: unmuted });
    expect(tick.executionState.state).toBe("running");
    expect(mock.clientCount).toBeLessThanOrEqual(1);
  }, 180_000);

  it("passes the mock that implements only milestone M1: S16 and S17 are not applicable to it", async () => {
    const summary = await run(undefined, undefined, { supports: MOCK_M1_SUPPORT });
    expect(summary.invariantViolations).toEqual([]);
    expect(summary.cleanUpProblems).toEqual([]);
    expect(statusesOf(summary)).toEqual({ ...MOCK_STATUSES, S16: "not-applicable", S17: "not-applicable" });
    expect(summary.ok).toBe(true);
    expect(summary.server.capabilities).toEqual(["event-breakpoints", "callstack", "sh4-debug-native"]);
  }, 180_000);

  it("the gate of M1: the mock, and the mock as an M1 server, pass every scenario of it; nothing is partial or not applicable", async () => {
    for (const options of [undefined, { supports: MOCK_M1_SUPPORT }]) {
      const { url } = await startServer(undefined, options);
      const lines: string[] = [];
      const summary = await runContract({ url, profile: "mock", milestone: "M1", say: (line) => lines.push(line) });
      expect(reportOf(summary).filter((line) => !/^S\d\d passed /.test(line))).toEqual([]);
      expect(summary.selected).toEqual(scenariosOfMilestone("M1", "mock"));
      expect(summary.required).toEqual(summary.selected);
      expect(summary).toMatchObject({ ok: true, milestone: "M1", failed: 0, partial: 0, notApplicable: 0, requiredNotPassed: [], invariantViolations: [], cleanUpProblems: [] });
      expect(summary.passed).toBe(summary.selected.length);
      expect(lines.at(-1)).toBe("contract: OK");
    }
  }, 180_000);

  it("S21: the run with the DSP test program selects the scenarios of that program alone, and the mock passes it", async () => {
    const { url } = await startServer();
    const summary = await runContract({ url, profile: "mock", milestone: "M3", dspProgram: true });
    expect(reportOf(summary)).toEqual(["S21 passed "]);
    expect(summary).toMatchObject({ ok: true, selected: ["S21"], required: ["S21"], dspProgram: true, cleanUpProblems: [] });
    expect((await stateOf(url)).breakpoints).toEqual({});

    // without the option the scenario is not for this program; a server whose DSP does not step is not asked
    expect(reportOf(await runContract({ url, profile: "mock", only: new Set(["S21"]) }))).toEqual([
      "S21 not-applicable the run with the DSP test program only (--dsp-program): this program is not known to load the DSP",
    ]);
    const m1 = await run(undefined, undefined, { supports: MOCK_M1_SUPPORT });
    expect(statusOf(m1, "S21")).toBe("not-applicable");
    const m1Dsp = await runContract({ url: (await startServer(undefined, { supports: MOCK_M1_SUPPORT })).url, profile: "mock", milestone: "M3", dspProgram: true });
    expect(reportOf(m1Dsp)).toEqual(["S21 not-applicable targets: dsp.stepping is false"]);
    expect(m1Dsp).toMatchObject({ ok: false, nothingVerified: true, requiredNotPassed: [{ id: "S21", status: "not-applicable" }] });
  }, 180_000);

  it("restores a paused server to paused, and keeps the watches it found", async () => {
    const { url } = await startServer(undefined, { startPaused: true });
    // somebody else's watch and breakpoint
    const other = new WebSocket(url);
    await new Promise<void>((resolve) => other.once("open", () => resolve()));
    other.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "state.watch", params: { expressions: ["dc.sh4.cpu.pc", "dc.sh4.cpu.pr"] } }));
    other.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "breakpoints.add", params: { event: "dc.system.reset", enabled: false } }));
    other.send(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "breakpoints.setCategoryStates", params: { categories: { events: { muted: true, soloed: false } } } }));
    await new Promise<void>((resolve) => other.on("message", (data) => (JSON.parse(data.toString()) as Json).id === 3 && resolve()));

    const summary = await runContract({ url, profile: "mock", only: new Set(["S02", "S05", "S06", "S08", "S14"]) });
    expect(summary.scenarios.map((scenario) => `${scenario.id} ${scenario.status} ${scenario.details.join(" | ")}`)).toEqual([
      "S02 passed ",
      "S05 passed ",
      "S06 passed ",
      "S08 passed ",
      "S14 passed ",
    ]);
    expect(summary.finalState).toMatch(/paused/);

    const tick = await new Promise<Json>((resolve) => {
      other.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Json;
        if (isTick(frame)) {
          resolve(frame.params);
        }
      });
      other.send(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "debugger.describe", params: {} }));
    });
    other.close();
    expect((tick.watches as Json[]).map((watch) => watch.expression)).toEqual(["dc.sh4.cpu.pc", "dc.sh4.cpu.pr"]);
    expect(Object.values(tick.breakpoints as Record<string, Json>).map((breakpoint) => breakpoint.event)).toEqual(["dc.system.reset"]);
    expect((tick.categories as Record<string, Json>).events).toEqual({ muted: true, soloed: false });
  }, 60_000);

  it("does not take a tick that was built before a request, and arrives after it, for the tick of that request", async () => {
    const summary = await run(staleTickBeforeEveryAnswer);
    expect(reportOf(summary).filter((line) => / failed /.test(line))).toEqual([]);
    expect(statusesOf(summary)).toEqual(MOCK_STATUSES);
    expect(summary.invariantViolations).toEqual([]);
    expect(summary.cleanUpProblems).toEqual([]);
    expect(summary.ok).toBe(true);

    // S13 alone, i.e. started on a running server: there the tick in front of the first answers is a periodic one
    const running = await run(staleTickBeforeEveryAnswer, ["S13"]);
    expect(reportOf(running)).toEqual(["S13 passed "]);
    expect(running.ok).toBe(true);
  }, 180_000);

  it("S08: needs no tick after a state.watch that changed nothing", async () => {
    const summary = await run(() => noTickAfter(isWatchOfStoredExpression), ["S08"]);
    expect(reportOf(summary)).toEqual(["S08 passed "]);
    expect(summary.ok).toBe(true);
  });

  it("S01, S03: a running tick that says registersStale is full without dc.sh4.cpu", async () => {
    const summary = await run(undefined, ["S01", "S03"], { sliceContext: false });
    expect(reportOf(summary)).toEqual(["S01 passed ", "S03 passed "]);
    expect(summary.ok).toBe(true);
  }, 30_000);

  it("S06: needs no tick after a breakpoints.setCategoryStates that changed nothing", async () => {
    // a server that sends no tick then, found with sh4 muted: muting sh4 is the request that changes nothing
    const mock = new MockDebugger();
    const tables = mock as unknown as {
      setCategoryStates(params: { categories: Record<string, Json> }, context: Json): unknown;
      categories: Map<string, Json>;
    };
    const set = tables.setCategoryStates.bind(mock);
    tables.setCategoryStates = (params, context) => {
      const same = Array.from(tables.categories).every(([key, state]) => !params.categories[key] || JSON.stringify(params.categories[key]) === JSON.stringify(state));
      return same ? {} : set(params, context);
    };
    ask(mock, "breakpoints.setCategoryStates", { categories: { sh4: { muted: true, soloed: false } } });
    const { url } = await startServer(undefined, mock);
    const summary = await runContract({ url, profile: "mock", only: new Set(["S06"]) });
    expect(reportOf(summary)).toEqual(["S06 passed "]);
    expect(summary.ok).toBe(true);
    expect((await stateOf(url)).categories.sh4).toEqual({ muted: true, soloed: false });
  }, 30_000);

  it("S14: reconnects, i.e. the server has no client between the two connections", async () => {
    const mock = new ForgetfulMock();
    const { url } = await startServer(undefined, mock);
    const summary = await runContract({ url, profile: "mock", only: new Set(["S14"]) });
    expect(reportOf(summary)).toEqual(["S14 passed "]);
    expect(mock.reconnects).toBe(1);
  });

  it("S07: a program that does not come back to the breakpoint that was enabled again", async () => {
    // outside of its loop the mock's SH4 walks straight on
    const mock = new MockDebugger({ startPaused: true });
    ask(mock, "state.setRegister", { path: "dc.sh4.cpu", name: "PC", value: "0x8C00FFE0" });
    const { url } = await startServer(undefined, mock);
    const summary = await runContract({ url, profile: "mock", only: new Set(["S07"]) });
    expect(reportOf(summary)).toEqual([
      expect.stringMatching(
        /^S07 passed the program did not come back to 0x8C0[0-9A-F]{5} within 2000 ms of the breakpoint there being enabled again; a breakpoint on the next instruction that was disabled and enabled again was hit$/,
      ),
    ]);
    expect(summary.ok).toBe(true);
  }, 90_000);
});

describe("the contract runner against a server that breaks the protocol", () => {
  it("I1: an unknown key in a tick", async () => {
    const summary = await run({ toClient: (frame) => (isTick(frame) ? { ...frame, params: { ...frame.params, frameNumber: 1 } } : frame) }, ["S01", "S02"]);
    expect(summary.ok).toBe(false);
    expect(statusOf(summary, "S01")).toBe("failed");
    expect(summary.invariantViolations.join("\n")).toMatch(/I1: tick\.: Unrecognized key/);
  });

  it("I1: null instead of an omitted field", async () => {
    const summary = await run(
      { toClient: (frame) => (isTick(frame) ? { ...frame, params: { ...frame.params, executionState: { ...frame.params.executionState, notice: null } } } : frame) },
      ["S02"],
    );
    expect(summary.ok).toBe(false);
    expect(summary.invariantViolations.join("\n")).toMatch(/I1: the tick contains null at \$\.executionState\.notice/);
  });

  it("I1: a field a v3 server always sends is missing, and an unlisted enum value", async () => {
    const summary = await run(
      {
        toClient: (frame) => {
          if (!isTick(frame)) return frame;
          const { categories: _categories, ...params } = frame.params;
          const executionState = { ...frame.params.executionState };
          if (executionState.reason === "pause") executionState.reason = "user";
          return { ...frame, params: { ...params, executionState } };
        },
      },
      ["S02"],
    );
    expect(statusOf(summary, "S02")).toBe("failed");
    expect(summary.invariantViolations.join("\n")).toMatch(/I1: tick\.categories/);
    expect(summary.invariantViolations.join("\n")).toMatch(/I1: tick\.executionState\.reason/);
  });

  it("I2: tickId does not increase", async () => {
    const summary = await run({ toClient: (frame) => (isTick(frame) ? { ...frame, params: { ...frame.params, tickId: 7 } } : frame) }, ["S02"]);
    expect(summary.ok).toBe(false);
    expect(summary.invariantViolations.join("\n")).toMatch(/I2: tickId 7 follows tickId 7/);
  });

  it("I3: a breakpoint under a key that is not its id", async () => {
    const summary = await run(
      {
        toClient: (frame) => {
          if (!isTick(frame)) return frame;
          const breakpoints = Object.fromEntries(Object.entries(frame.params.breakpoints as Json).map(([key, value]) => [`bp${key}`, value]));
          return { ...frame, params: { ...frame.params, breakpoints } };
        },
      },
      ["S13"],
    );
    expect(statusOf(summary, "S13")).toBe("failed");
    expect(summary.invariantViolations.join("\n")).toMatch(/I3: breakpoints\["bp1"\] has id 1/);
  });

  it("I4: a register value that is not formatted to its width, and a register list that differs from describe", async () => {
    const lower = await run(
      {
        toClient: (frame) => {
          if (!isTick(frame)) return frame;
          const registers = Object.fromEntries(
            Object.entries(frame.params.registers).map(([path, list]) => [path, list.map((register) => ({ ...register, value: String(register.value).toLowerCase() }))]),
          );
          return { ...frame, params: { ...frame.params, registers } };
        },
      },
      ["S01"],
    );
    expect(lower.ok).toBe(false);
    expect(lower.invariantViolations.join("\n")).toMatch(/I4: dc\.sh4\.cpu\.PC = "0x8c0000a[0-9a-e]" is not 0x \+ 8 upper-case hex digits or "n\/a"/);

    const shorter = await run(
      {
        toClient: (frame) => {
          if (!isTick(frame)) return frame;
          const registers = { ...frame.params.registers, "dc.aica.dsp": frame.params.registers["dc.aica.dsp"].slice(0, 1), "dc.nowhere": [] };
          return { ...frame, params: { ...frame.params, registers } };
        },
      },
      ["S01"],
    );
    expect(shorter.invariantViolations.join("\n")).toMatch(/I4: registers\["dc\.aica\.dsp"\] carries \[STEP\], describe lists \[STEP MDEC_CT RBP RBL\]/);
    expect(shorter.invariantViolations.join("\n")).toMatch(/I4: registers\["dc\.nowhere"\] is not a path of the describe tree/);
  });

  it("I5: a paused tick that is not full, a running tick without one of the four base paths, a stopId that goes back", async () => {
    const summary = await run(
      {
        toClient: (frame) => {
          if (!isTick(frame)) return frame;
          const registers = { ...frame.params.registers };
          const executionState = { ...frame.params.executionState };
          if (executionState.state === "paused") {
            delete registers["dc.holly.intc"];
          } else {
            delete registers["dc.aica.arm7"];
            delete registers["dc.timing"];
            executionState.stopId = 0;
          }
          return { ...frame, params: { ...frame.params, registers, executionState } };
        },
      },
      ["S02", "S03"],
    );
    expect(summary.ok).toBe(false);
    const violations = summary.invariantViolations.join("\n");
    expect(violations).toMatch(/I5: a paused tick is full, this one lacks dc\.holly\.intc/);
    expect(violations).toMatch(/I5: a running tick carries dc\.aica\.arm7/);
    // the time is the fourth base path
    expect(violations).toMatch(/I5: a running tick carries dc\.timing/);
    expect(violations).toMatch(/I5: stopId 0 follows stopId 1/);
  });

  it("registersStale in a paused tick, a timestamp in seconds, and an event log that is newest first or numbers its entries anew in every tick", async () => {
    const tickFault = (rewrite: (params: Json & { executionState: Json; eventLog: Json[]; timestamp: number }) => Json): Faults => ({
      toClient: (frame) => (isTick(frame) ? { ...frame, params: rewrite(frame.params as never) } : frame),
    });
    const started = Date.now();

    const stale = await run(
      tickFault((params) => (params.executionState.state === "paused" ? { ...params, executionState: { ...params.executionState, registersStale: true } } : params)),
      ["S01", "S02"],
    );
    expect(reportOf(stale)).toEqual([
      "S01 passed ",
      expect.stringMatching(/^S02 failed invariant: I5: registersStale in a paused tick; a paused tick is full, and the SH4 context is complete at a stop \(tick \d+\)/),
    ]);

    const seconds = await run(
      tickFault((params) => ({ ...params, timestamp: Math.floor(params.timestamp / 1000) })),
      ["S01"],
    );
    expect(reportOf(seconds)).toEqual([expect.stringMatching(/^S01 failed invariant: I2: timestamp \d{10} is not the wall clock in ms; the clock of this machine reads \d{13} \(tick \d+\)/)]);

    // The entries of the event log have a timestamp of their own, which is what the UI shows as a
    // time of day: in seconds, or in ms since the server started, while the tick's own is right.
    for (const entryTime of [(timestamp: number) => Math.floor(timestamp / 1000), (timestamp: number) => timestamp - started]) {
      const entries = await run(
        tickFault((params) => ({ ...params, eventLog: params.eventLog.map((entry) => ({ ...entry, timestamp: entryTime(entry.timestamp as number) })) })),
        ["S01", "S03"],
      );
      expect(statusOf(entries, "S01")).toBe("passed");
      expect(statusOf(entries, "S03")).toBe("failed");
      expect(detailsOf(entries, "S03")).toMatch(/^invariant: I3: the timestamp \d+ of the event-log entry \d+ is not the wall clock in ms; the clock of this machine reads \d{13} \(tick \d+\)$/m);
      expect(entries.invariantViolations.every((violation) => /^I3: the timestamp /.test(violation))).toBe(true);
    }

    // (S03 runs for two seconds, in which the mock logs a key-on and a key-off twice a second)
    const newestFirst = await run(
      tickFault((params) => ({ ...params, eventLog: params.eventLog.slice().reverse() })),
      ["S03"],
    );
    expect(statusOf(newestFirst, "S03")).toBe("failed");
    expect(detailsOf(newestFirst, "S03")).toMatch(/^invariant: I3: the event log is oldest first and its eventIds ascend; eventId \d+ follows eventId \d+ \(tick \d+\)$/m);

    // the position in the log for an id, in a log that keeps its three newest entries
    const perTick = await run(
      tickFault((params) => ({ ...params, eventLog: params.eventLog.slice(-3).map((entry, position) => ({ ...entry, eventId: String(position) })) })),
      ["S03"],
    );
    expect(statusOf(perTick, "S03")).toBe("failed");
    expect(detailsOf(perTick, "S03")).toMatch(/^invariant: I3: eventId 0 named another entry in an earlier tick: it is \[\d+,"aica","info","key o(n|ff): channel \d+","dc\.aica\.channels\.key_o(n|ff)","\d+"\] now and was \[/m);
    // (nothing else is wrong with these ticks)
    expect(perTick.invariantViolations.every((violation) => /^I3: eventId \d named another entry/.test(violation))).toBe(true);
  }, 30_000);

  it("a tree that lists fewer events than the server raises: the event log names an event no node lists", async () => {
    // the vertical blank and nothing else, where the server logs key-on, key-off and GD-ROM commands
    const summary = await run(
      {
        toClient: (frame) => {
          const result = frame.result as Json | undefined;
          const only = (nodes: Json[]): Json[] =>
            nodes.map((node) => {
              const { events, children, ...rest } = node as Json & { events?: string[]; children?: Json[] };
              const kept = events?.filter((event) => event === "dc.holly.core.vblank");
              return { ...rest, ...(kept?.length ? { events: kept } : {}), ...(children ? { children: only(children) } : {}) };
            });
          return result?.deviceTree ? { ...frame, result: { ...result, deviceTree: only(result.deviceTree as Json[]) } } : frame;
        },
      },
      ["S01", "S03"],
    );
    // what the tree lists is the server's to say, so S01 has nothing against it ...
    expect(statusOf(summary, "S01")).toBe("passed");
    // ... until the server raises what it does not list (S03 runs for two seconds)
    expect(statusOf(summary, "S03")).toBe("failed");
    expect(detailsOf(summary, "S03")).toMatch(
      /^invariant: 2\.6: the event log has an entry of dc\.aica\.channels\.key_o(n|ff) \(eventId \d+\), which no node of the device tree lists; a server lists the events it can raise \(tick \d+\)$/m,
    );
  }, 30_000);

  it("S01: the tick after the describe response is not full", async () => {
    let afterDescribe = false;
    const summary = await run(
      {
        toClient: (frame) => {
          if (isTick(frame) && afterDescribe) {
            afterDescribe = false;
            const { "dc.sh4.cpu": cpu, "dc.aica.arm7": arm7, "dc.aica.dsp": dsp, "dc.timing": timing } = frame.params.registers;
            return { ...frame, params: { ...frame.params, registers: { "dc.sh4.cpu": cpu, "dc.aica.arm7": arm7, "dc.aica.dsp": dsp, "dc.timing": timing } } };
          }
          if ("result" in frame && (frame.result as Json | undefined)?.deviceTree) {
            afterDescribe = true;
          }
          return frame;
        },
      },
      ["S01"],
    );
    expect(statusOf(summary, "S01")).toBe("failed");
    expect(detailsOf(summary, "S01")).toMatch(/the tick after describe is full; it lacks dc/);
  });

  it("S01: a describe result that fails the strict schema is S01 failed, with every issue, and the run goes on", async () => {
    const summary = await run(
      {
        toClient: (frame) => {
          const result = frame.result as (Json & { emulator: Json; deviceTree: Array<Json & { children: Json[] }> }) | undefined;
          if (!result?.deviceTree) return frame;
          // five things the strict schema refuses and the client's own schema reads past
          const { ui: _ui, ...rest } = result;
          const [dc, ...others] = result.deviceTree;
          const [sh4, ...siblings] = dc.children;
          return {
            ...frame,
            result: {
              ...rest,
              build: "debug",
              emulator: { ...result.emulator, commit: "0123abc" },
              deviceTree: [{ ...dc, actions: ["no-such-panel"], children: [{ ...sh4, registers: [] }, ...siblings] }, ...others],
            },
          };
        },
      },
      ["S01", "S02", "S13"],
    );
    expect(statusOf(summary, "S01")).toBe("failed");
    expect(summary.scenarios[0].details.slice(0, 6)).toEqual([
      "the debugger.describe result does not follow the schema of protocol v3 (5 issues):",
      '  emulator: Unrecognized key: "commit"',
      "  ui: Invalid input: expected string, received undefined",
      expect.stringMatching(/^ {2}deviceTree\.0\.actions\.0: Invalid option: expected one of "/),
      "  deviceTree.0.children.0.registers: Too small: expected array to have >=1 items",
      '  Unrecognized key: "build"',
    ]);
    // what S01 itself looks for is still looked for
    expect(detailsOf(summary, "S01")).toMatch(/^dc: action "no-such-panel" is not a panel id$/m);
    expect(detailsOf(summary, "S01")).toMatch(/^dc\.sh4: an empty "registers" array is omitted, not sent$/m);
    // every response is validated: the run reports the result of each debugger.describe it sends
    expect(summary.invariantViolations).toEqual([expect.stringMatching(/^I1: Response validation failed for debugger\.describe: emulator: Unrecognized key: "commit"; .* \(and 2 more\)/)]);
    expect(reportOf(summary).slice(1)).toEqual([
      "S02 passed ",
      // (its second connection asks debugger.describe too)
      expect.stringMatching(/^S13 failed invariant: I1: Response validation failed for debugger\.describe: /),
    ]);
    expect(summary.server).toMatchObject({ protocol: 3, ui: undefined, emulator: { name: "nullDC (mock)" } });
    expect(summary.ok).toBe(false);
    expect(summary.cleanUpProblems).toEqual([]);
  }, 30_000);

  it("S01: debugger.describe that is refused unless the client says protocol 3", async () => {
    const summary = await run(
      { answer: (request) => (request.method === "debugger.describe" && paramsOf(request).protocol !== 3 ? rpcError(request, -32602, "invalid params: protocol") : undefined) },
      ["S01", "S02"],
    );
    expect(reportOf(summary)).toEqual([
      'S01 failed debugger.describe {}: JSON-RPC error -32602 "invalid params: protocol" | ' +
        'debugger.describe {"protocol":2,"client":"contract runner, as a client of protocol 2"}: JSON-RPC error -32602 "invalid params: protocol"',
      "S02 passed ",
    ]);
  });

  it("S01: a server that answers a client of another protocol version in another shape; the run goes on with the answer to its own request", async () => {
    // without targets for a client that does not say protocol 3
    const summary = await run(() => {
      const older = new Set<unknown>();
      return {
        toServer: (frame) => {
          if (frame.method === "debugger.describe" && paramsOf(frame).protocol !== 3) older.add(frame.id);
          return frame;
        },
        toClient: (frame) => {
          if (!older.delete(frame.id)) return frame;
          const { targets: _targets, ...result } = frame.result as Json;
          return { ...frame, result };
        },
      };
    }, ["S01", "S02", "S10"]);
    expect(reportOf(summary)).toEqual([
      expect.stringMatching(/^S01 failed debugger\.describe \{\}: the debugger\.describe result does not follow the schema of protocol v3 \(1 issue\): \| {3}targets: Invalid input: expected array, received undefined \| debugger\.describe \{\}: targets is present \| /),
      "S02 passed ",
      "S10 passed ",
    ]);
  });

  /** A server whose debugger.describe result is rewritten, and whose ticks are (for a tree that lists other registers). */
  const describing = (
    rewrite: (result: Json & { targets: Array<Json & { id: string }>; deviceTree: Json[] }) => Json,
    registers?: (registers: Record<string, Json[]>) => Record<string, Json[]>,
  ): Faults => ({
    toClient: (frame) => {
      if (isTick(frame)) {
        return registers ? { ...frame, params: { ...frame.params, registers: registers(frame.params.registers) } } : frame;
      }
      const result = frame.result as (Json & { targets: Array<Json & { id: string }>; deviceTree: Json[] }) | undefined;
      return result?.deviceTree ? { ...frame, result: rewrite(result) } : frame;
    },
  });
  /** Every node of a tree, rewritten (undefined: the node is left out). */
  const mapNodes = (nodes: Json[], rewrite: (node: Json) => Json | undefined): Json[] =>
    nodes.flatMap((node) => {
      const rewritten = rewrite(node);
      if (!rewritten) return [];
      const children = rewritten.children as Json[] | undefined;
      return [children ? { ...rewritten, children: mapNodes(children, rewrite) } : rewritten];
    });

  it("S01: targets that do not have the normative values of the table of 3.1; labels and default addresses are the server's", async () => {
    const constants = await run(
      describing((result) => ({
        ...result,
        targets: result.targets.map((target) =>
          target.id === "dsp"
            ? { ...target, addressRadix: 16, addressDigits: 2, instructionSize: 4 }
            : target.id === "arm7"
              ? { ...target, addressDigits: 6, addressMax: 0x001fffff, pcRegister: "R15" }
              : { ...target, addressMax: 0x1fffffff, breakpointEvent: "dc.sh4.pc", pcPath: "dc.sh4" },
        ),
      })),
      ["S01"],
    );
    expect(constants.scenarios[0].details).toEqual([
      "target sh4: dc.sh4.PC is not in the device tree",
      "target arm7: dc.aica.arm7.R15 is not in the device tree",
      "target sh4: pcPath is \"dc.sh4\", the table of 3.1 says \"dc.sh4.cpu\"",
      "target sh4: breakpointEvent is \"dc.sh4.pc\", the table of 3.1 says \"dc.sh4.cpu.pc\"",
      "target sh4: addressMax is 0x1FFFFFFF, the table of 3.1 says 0xFFFFFFFF",
      "target arm7: pcRegister is \"R15\", the table of 3.1 says \"PC\"",
      "target arm7: addressMax is 0x001FFFFF, the table of 3.1 says 0x00FFFFFF",
      "target arm7: addressDigits is 6, the table of 3.1 says 8",
      "target dsp: instructionSize is 4, the table of 3.1 says 1",
      "target dsp: addressRadix is 16, the table of 3.1 says 10",
      "target dsp: addressDigits is 2, the table of 3.1 says 3",
    ]);

    // a target that says it has memory where the table says it has none
    const memory = await run(
      describing((result) => ({ ...result, targets: result.targets.map((target) => (target.id === "dsp" ? { ...target, memory: true, defaultMemoryAddress: 0 } : target)) })),
      ["S01"],
    );
    expect(memory.scenarios[0].details).toEqual(["target dsp: memory is true, the table of 3.1 says false"]);

    // The label and the default addresses are the server's choice: an emulator gives the entry
    // of the loaded program. And a target may step before, or not yet in, the emulator's milestone.
    const own = await run(
      describing((result) => ({
        ...result,
        targets: result.targets.map((target) =>
          target.id === "sh4"
            ? { ...target, label: "Hitachi SH-4", defaultDisassemblyAddress: 0x8c0000a0, defaultMemoryAddress: 0x0c000000 }
            : target.id === "arm7"
              ? { ...target, label: "", defaultDisassemblyAddress: 0x00200010, defaultMemoryAddress: 0x00200000, stepping: false }
              : { ...target, label: "AICA DSP", defaultDisassemblyAddress: 64, stepping: false },
        ),
      })),
      ["S01", "S09", "S10"],
    );
    expect(reportOf(own)).toEqual(["S01 passed ", "S09 passed ", "S10 passed "]);
    expect(own.ok).toBe(true);
  }, 30_000);

  it("S01: a tree without nodes or actions of milestone M1, nested by the dots of its paths, or without the vertical blank", async () => {
    // without the timer unit and the interrupt controller of Holly, and with a core node that opens no panel
    const nodes = await run(
      describing(
        (result) => ({
          ...result,
          deviceTree: mapNodes(result.deviceTree, (node) => {
            if (node.path === "dc.sh4.tmu" || node.path === "dc.holly.intc") return undefined;
            const { actions, ...rest } = node as Json & { actions?: string[] };
            return node.path === "dc.holly.core" ? rest : node;
          }),
        }),
        ({ "dc.sh4.tmu": _tmu, "dc.holly.intc": _intc, ...registers }) => registers,
      ),
      ["S01"],
    );
    expect(nodes.scenarios[0].details).toEqual([
      "the device tree has no node dc.sh4.tmu, which the table of 2.8 lists for milestone M1",
      "the device tree has no node dc.holly.intc, which the table of 2.8 lists for milestone M1",
      'dc.holly.core: the action "holly-core" of the table of 2.8 is missing',
    ]);
    expect(nodes.invariantViolations).toEqual([]);

    // Every node where the dots of its path put it: the SH4 modules directly under dc.sh4 (no
    // dc.sh4.pbus in between), dc.gdrom, dc.maple and dc.timing under dc.
    const byDots = await run(
      describing((result) => {
        const [dc] = result.deviceTree as Array<Json & { children: Array<Json & { children: Json[] }> }>;
        const children = dc.children.flatMap((node) => {
          if (node.path === "dc.system") {
            const { children: moved, ...system } = node;
            return [system, ...moved];
          }
          if (node.path === "dc.sh4") {
            const pbus = node.children.find((child) => child.path === "dc.sh4.pbus") as Json & { children: Json[] };
            const { children: modules, ...bare } = pbus;
            return [{ ...node, children: [...node.children.filter((child) => child !== pbus), bare, ...modules] }];
          }
          return [node];
        });
        return { ...result, deviceTree: [{ ...dc, children }] };
      }),
      ["S01"],
    );
    expect(statusOf(byDots, "S01")).toBe("failed");
    expect(byDots.scenarios[0].details).toEqual([
      ...["bsc", "ccn", "cpg", "dmac", "intc", "rtc", "sci", "scif", "tmu", "ubc", "sq", "icache", "ocache", "ocram", "tlb"].map(
        (name) => `dc.sh4.${name} is under dc.sh4, the table of 2.8 has it under dc.sh4.pbus`,
      ),
      ...["gdrom", "maple", "timing"].map((name) => `dc.${name} is under dc, the table of 2.8 has it under dc.system`),
    ]);
    // (the paths, the registers and the ticks are all as they were)
    expect(byDots.invariantViolations).toEqual([]);

    // a second root
    const twoRoots = await run(
      describing((result) => {
        const [dc] = result.deviceTree as Array<Json & { children: Json[] }>;
        return { ...result, deviceTree: [{ ...dc, children: dc.children.filter((node) => node.path !== "dc.system") }, dc.children.find((node) => node.path === "dc.system")!] };
      }),
      ["S01"],
    );
    expect(twoRoots.scenarios[0].details).toEqual(["dc.system is a root of the device tree, the table of 2.8 has it under dc"]);

    // the event every running machine raises is listed by every server
    const noVblank = await run(
      describing((result) => ({
        ...result,
        deviceTree: mapNodes(result.deviceTree, (node) => {
          const { events, ...rest } = node as Json & { events?: string[] };
          const kept = events?.filter((event) => event !== "dc.holly.core.vblank");
          return kept?.length ? { ...rest, events: kept } : rest;
        }),
      })),
      ["S01"],
    );
    expect(noVblank.scenarios[0].details).toEqual(["no node of the device tree lists the event dc.holly.core.vblank, which every server lists (2.6)"]);
  }, 30_000);

  it("S01: the register list of dc.sh4.cpu is that of 2.8, and the three anchor registers are there", async () => {
    /** The SH4's register list rewritten in the tree and in every tick, so that the ticks agree with the tree. */
    const cpu = (rewrite: (registers: Json[]) => Json[]): Faults =>
      describing(
        (result) => ({ ...result, deviceTree: mapNodes(result.deviceTree, (node) => (node.path === "dc.sh4.cpu" ? { ...node, registers: rewrite(node.registers as Json[]) } : node)) }),
        (registers) => (registers["dc.sh4.cpu"] ? { ...registers, "dc.sh4.cpu": rewrite(registers["dc.sh4.cpu"]) } : registers),
      );

    // without the floating-point registers and the other bank
    const integerOnly = await run(
      cpu((registers) => registers.filter((register) => !/^(FR|XF)\d+$|_BANK$/.test(String(register.name)))),
      ["S01"],
    );
    expect(integerOnly.scenarios[0].details).toEqual([
      `dc.sh4.cpu lacks ${[0, 1, 2, 3, 4, 5, 6, 7].map((n) => `R${n}_BANK`).join(" ")} ${Array.from({ length: 16 }, (_, n) => `FR${n}`).join(" ")} ${Array.from({ length: 16 }, (_, n) => `XF${n}`).join(" ")}; its register list is that of 2.8`,
    ]);
    expect(integerOnly.invariantViolations).toEqual([]);

    // another order, a register of its own, a width that is not 32
    const reordered = await run(
      cpu((registers) => [registers[1], registers[0], ...registers.slice(2)]),
      ["S01"],
    );
    expect(reordered.scenarios[0].details).toEqual([expect.stringMatching(/^the registers of dc\.sh4\.cpu are not in the order of 2\.8: they are PR PC SR GBR VBR /)]);
    const extra = await run(
      cpu((registers) => [...registers, { name: "PTEH", value: "0x00000000", width: 32 }]),
      ["S01"],
    );
    expect(extra.scenarios[0].details).toEqual(["dc.sh4.cpu lists PTEH, which the register list of 2.8 does not have"]);
    const narrow = await run(
      cpu((registers) => registers.map((register) => (register.name === "FPUL" ? { ...register, width: 16, value: "0x0000" } : register))),
      ["S01"],
    );
    expect(narrow.scenarios[0].details).toEqual(["the registers of dc.sh4.cpu have width 32; not so FPUL (16)"]);

    // The DSP's step under another name, with a target that points at it: the tree and the
    // target agree with each other, and neither is what the design names.
    const renamed = (registers: Json[]) => registers.map((register) => (register.name === "STEP" ? { ...register, name: "POSITION" } : register));
    const anchor = await run(
      describing(
        (result) => ({
          ...result,
          targets: result.targets.map((target) => (target.id === "dsp" ? { ...target, pcRegister: "POSITION" } : target)),
          deviceTree: mapNodes(result.deviceTree, (node) => (node.path === "dc.aica.dsp" ? { ...node, registers: renamed(node.registers as Json[]) } : node)),
        }),
        (registers) => (registers["dc.aica.dsp"] ? { ...registers, "dc.aica.dsp": renamed(registers["dc.aica.dsp"]) } : registers),
      ),
      ["S01"],
    );
    expect(anchor.scenarios[0].details).toEqual([
      'target dsp: pcRegister is "POSITION", the table of 3.1 says "STEP"',
      "dc.aica.dsp has no register STEP, one of the three anchor registers of 2.8",
    ]);
    expect(anchor.invariantViolations).toEqual([]);
  }, 30_000);

  it("S01: a server that answers debugger.describe with nothing the client can read, or sends no tick after it, fails S01; nothing else is run", async () => {
    const lines: string[] = [];
    const refused = await startServer({
      toClient: (frame) => ((frame.result as Json | undefined)?.deviceTree ? { jsonrpc: "2.0", id: frame.id, error: { code: -32601, message: "method not found: debugger.describe" } } : frame),
    });
    const noDescribe = await runContract({ url: refused.url, profile: "mock", only: new Set(["S01", "S02"]), say: (line) => lines.push(line) });
    expect(reportOf(noDescribe)).toEqual([
      'S01 failed debugger.describe {"protocol":3,"client":"nullDC contract runner"}: JSON-RPC error -32601 "method not found: debugger.describe"',
      'S02 failed not run: debugger.describe {"protocol":3,"client":"nullDC contract runner"}: JSON-RPC error -32601 "method not found: debugger.describe"',
    ]);
    expect(noDescribe).toMatchObject({ ok: false, passed: 0, failed: 2, cleanUpProblems: [] });
    // (the mock runs, and its ticks arrive whatever the proxy made of the describe response)
    expect(noDescribe.finalState).toMatch(/running/);
    expect(noDescribe.server).toEqual({ emulator: { name: "unknown", version: "unknown", build: "unknown" }, protocol: undefined, ui: undefined, capabilities: [], targets: [] });
    expect(lines.at(-1)).toBe("contract: FAILED");

    // a paused server sends no periodic tick: without the tick that follows the response there is none at all
    const silent = await startServer(() => noTickAfter((frame) => frame.method === "debugger.describe"), { startPaused: true });
    const noTick = await runContract({ url: silent.url, profile: "mock", only: new Set(["S01", "S05"]) });
    expect(reportOf(noTick)).toEqual([
      "S01 failed the tick that follows debugger.describe: not seen within 2000 ms; ticks since then: 0",
      "S05 failed not run: the tick that follows debugger.describe: not seen within 2000 ms; ticks since then: 0",
    ]);
    expect(noTick).toMatchObject({ ok: false, finalState: "unknown", server: { protocol: 3, emulator: { name: "nullDC (mock)" } } });
    // nothing was asked of it but debugger.describe
    expect(silent.mock.clientCount).toBeLessThanOrEqual(1);
    expect((await stateOf(silent.direct)).executionState).toMatchObject({ state: "paused", reason: "start" });
  }, 30_000);

  it("a server that cannot be connected to is not a failed run: the error leaves the runner", async () => {
    // a port nothing listens on any more
    const gone = await listenMockDebugger(new MockDebugger());
    await gone.close();
    const attempt = runContract({ url: gone.url, profile: "mock", only: new Set(["S01"]) });
    await expect(attempt).rejects.toThrow(/^Could not connect to ws:\/\/127\.0\.0\.1:\d+\/ws/);
    await expect(attempt).rejects.not.toBeInstanceOf(ContractFailure);
  });

  it("S04: a running tick before the paused tick of a step", async () => {
    let tickId = 0;
    const summary = await run(
      {
        toClient: (frame) => {
          if (!isTick(frame)) return frame;
          const renumbered = () => ({ ...frame, params: { ...frame.params, tickId: tickId++ } });
          if (frame.params.executionState.reason !== "step") {
            return renumbered();
          }
          const { reason: _reason, ...running } = frame.params.executionState;
          const first = renumbered();
          return [{ ...first, params: { ...first.params, executionState: { ...running, state: "running" }, callstacks: { sh4: [], arm7: [] } } }, renumbered()];
        },
      },
      ["S04"],
    );
    expect(statusOf(summary, "S04")).toBe("failed");
    expect(detailsOf(summary, "S04")).toMatch(/a running tick arrived before the paused tick of the step/);
  });

  it("S05: a breakpoint stop without breakpointId; S02: a pause without a new stopId", async () => {
    const summary = await run(
      {
        toClient: (frame) => {
          if (!isTick(frame)) return frame;
          const { breakpointId: _breakpointId, ...executionState } = frame.params.executionState;
          if (executionState.reason === "breakpoint") executionState.reason = "pause";
          return { ...frame, params: { ...frame.params, executionState } };
        },
      },
      ["S05"],
    );
    expect(statusOf(summary, "S05")).toBe("failed");
    expect(detailsOf(summary, "S05")).toMatch(/the stop reports breakpointId undefined, expected 1/);

    const frozen = await run(
      { toClient: (frame) => (isTick(frame) ? { ...frame, params: { ...frame.params, executionState: { ...frame.params.executionState, stopId: 5 } } } : frame) },
      ["S02"],
    );
    expect(statusOf(frozen, "S02")).toBe("failed");
    expect(detailsOf(frozen, "S02")).toMatch(/stopId 5 is not new/);
  });

  it("S05, I7: a breakpointId that outlives its breakpoint, a stop that goes over to the other breakpoint on the address, a stop that loses its reason", async () => {
    /** A server that goes on reporting something for a stop whose breakpoint the client removed. One per connection. */
    const afterRemoval = (rewrite: (executionState: Json, removed: number, tick: Json) => Json): FaultSource => () => {
      // stopId -> the breakpoint that stop reported
      const reported = new Map<unknown, number>();
      return {
        toClient: (frame) => {
          if (!isTick(frame)) return frame;
          const state = frame.params.executionState;
          if (typeof state.breakpointId === "number") {
            reported.set(state.stopId, state.breakpointId);
            return frame;
          }
          const removed = reported.get(state.stopId);
          return state.state === "paused" && removed !== undefined
            ? { ...frame, params: { ...frame.params, executionState: rewrite(state, removed, frame.params) } }
            : frame;
        },
      };
    };

    // the id is repeated in the ticks of the stop although the breakpoint is gone
    const stale = await run(
      afterRemoval((state, removed) => ({ ...state, breakpointId: removed })),
      ["S05"],
    );
    expect(statusOf(stale, "S05")).toBe("failed");
    expect(detailsOf(stale, "S05")).toMatch(
      /^after breakpoints\.remove \{1\} a paused tick of the same stop carries breakpointId 1; the ticks of a stop stop carrying the id of a breakpoint that was removed$/m,
    );
    // (in a later tick of the stop, not in its first one)
    expect(stale.invariantViolations.join("\n")).toMatch(/I7: breakpointId 1 is not a key of breakpoints in the same tick \(stop \d+\)/);
    expect(stale.cleanUpProblems).toEqual([]);

    // the stop reports the twin on the same address instead: an id that is listed, and not the stop's
    const twin = await run(
      afterRemoval((state, _removed, tick) => {
        const left = Object.keys(tick.breakpoints as Json).map(Number);
        return left.length > 0 ? { ...state, breakpointId: left[0] } : state;
      }),
      ["S05"],
    );
    expect(statusOf(twin, "S05")).toBe("failed");
    expect(detailsOf(twin, "S05")).toMatch(/^after breakpoints\.remove \{1\} a paused tick of the same stop carries breakpointId 2; /);
    expect(twin.invariantViolations).toEqual([]);

    // the reason leaves with the id
    const noReason = await run(
      afterRemoval((state) => ({ ...state, reason: "pause" })),
      ["S05"],
    );
    expect(statusOf(noReason, "S05")).toBe("failed");
    expect(detailsOf(noReason, "S05")).toBe('after breakpoints.remove {1} the paused tick of the same stop has reason "pause"; the reason stays "breakpoint"');
  }, 30_000);

  it("S02: control.pause that is refused for a target id, listed or not, or accepted for a string that is none", async () => {
    const refusing = (targets: string[]): Faults => ({
      answer: (request) =>
        request.method === "control.pause" && targets.includes(paramsOf(request).target as string)
          ? inBand(request, -32004, "not supported: pause of one target")
          : undefined,
    });
    const any = await run(refusing(["sh4", "arm7", "dsp"]), ["S02"]);
    expect(statusOf(any, "S02")).toBe("failed");
    expect(detailsOf(any, "S02")).toMatch(/^control\.pause \{"target":"sh4"\}: in-band error -32004/);
    expect(any.cleanUpProblems).toEqual([]);

    // the target is ignored: a pause is not a request to one target, and each id is tried
    for (const target of ["arm7", "dsp"]) {
      const one = await run(refusing([target]), ["S02"]);
      expect(statusOf(one, "S02"), target).toBe("failed");
      expect(detailsOf(one, "S02"), target).toBe(`control.pause {"target":"${target}"}: in-band error -32004 "not supported: pause of one target"`);
    }

    // also for a target the server does not list: a server of the SH4 alone that takes the pause for a request to a target
    const mock = new MockDebugger({ supports: { targets: ["sh4"] } });
    const control = mock as unknown as { handlers: Record<string, { run(params: Json, context: Json): unknown }>; supportedTarget(id: string): unknown };
    const pause = control.handlers["control.pause"].run;
    control.handlers["control.pause"].run = (params, context) => {
      if (params.target !== undefined) control.supportedTarget(params.target as string);
      return pause(params, context);
    };
    const unlisted = await runContract({ url: (await startServer(undefined, mock)).url, profile: "mock", only: new Set(["S02"]) });
    expect(reportOf(unlisted)).toEqual(['S02 failed control.pause {"target":"arm7"}: in-band error -32004 "not supported: target arm7"']);
    // ... which the mock, listing the SH4 alone, does not do
    expect(reportOf(await run(undefined, ["S02"], { supports: { targets: ["sh4"] } }))).toEqual(["S02 passed "]);

    // a string that is no target id is a mistyped parameter (control.runUntil is what the mock answers with {} here)
    const lenient = await run({ toServer: (frame) => (frame.method === "control.pause" && paramsOf(frame).target === "gpu" ? { ...frame, method: "control.runUntil", params: {} } : frame) }, ["S02"]);
    expect(reportOf(lenient)).toEqual(['S02 failed control.pause {"target":"gpu"}: expected the error -32602, got the result {}']);
    // (the run state is put back whatever the server made of it)
    expect(lenient.cleanUpProblems).toEqual([]);
    const wrongCode = await run(
      { answer: (request) => (request.method === "control.pause" && paramsOf(request).target === "gpu" ? inBand(request, -32004, "not supported: target gpu") : undefined) },
      ["S02"],
    );
    expect(reportOf(wrongCode)).toEqual(['S02 failed control.pause {"target":"gpu"}: expected the error -32602, got -32004 "not supported: target gpu"']);
  }, 30_000);

  it("S05: a second breakpoint on the same address that is not added, or that is the one a stop reports", async () => {
    // the server answers {} to a request for a breakpoint it has, and adds nothing
    const mock = new MockDebugger();
    const tables = mock as unknown as { addBreakpoint(params: Json, context: Json): unknown; breakpoints: Map<number, Json>; tickAfter(context: Json): void };
    const add = tables.addBreakpoint.bind(mock);
    tables.addBreakpoint = (params, context) => {
      if (Array.from(tables.breakpoints.values()).some((breakpoint) => breakpoint.event === params.event && breakpoint.address === params.address)) {
        tables.tickAfter(context);
        return {};
      }
      return add(params, context);
    };
    const { url } = await startServer(undefined, mock);
    const deduplicated = await runContract({ url, profile: "mock", only: new Set(["S05"]) });
    expect(statusOf(deduplicated, "S05")).toBe("failed");
    expect(detailsOf(deduplicated, "S05")).toMatch(/^breakpoints\.add: no tick lists a new breakpoint \(1 tick within 1000 ms of the request/);
    expect(deduplicated.cleanUpProblems).toEqual([]);

    // when several match, the lowest id is reported
    const highest = await run(
      {
        toClient: (frame) =>
          isTick(frame) && frame.params.executionState.breakpointId === 1 && "2" in (frame.params.breakpoints as Json)
            ? { ...frame, params: { ...frame.params, executionState: { ...frame.params.executionState, breakpointId: 2 } } }
            : frame,
      },
      ["S05"],
    );
    expect(detailsOf(highest, "S05")).toBe("the stop reports breakpointId 2, expected 1");
  }, 30_000);

  it("S05, S07: breakpoints.add that is refused when it names the kind, as the UI's request does", async () => {
    const summary = await run(
      {
        answer: (request) => {
          const { kind, address } = paramsOf(request);
          return request.method === "breakpoints.add" && ((kind === "code" && typeof address === "number") || kind === "event")
            ? inBand(request, -32602, "invalid params: kind")
            : undefined;
        },
      },
      ["S05", "S07"],
    );
    expect(statusOf(summary, "S05")).toBe("failed");
    expect(detailsOf(summary, "S05")).toMatch(/^breakpoints\.add \{"event":"dc\.sh4\.cpu\.pc","address":\d+,"kind":"code","enabled":true\}: in-band error -32602/);
    expect(statusOf(summary, "S07")).toBe("failed");
    expect(detailsOf(summary, "S07")).toMatch(/^breakpoints\.add \{"event":"[a-z0-9_.]+","kind":"event","enabled":false\}: in-band error -32602/);
    expect(summary.cleanUpProblems).toEqual([]);
  });

  it("S06 / S07: a muted or a disabled breakpoint that stops the target", async () => {
    // the server ignores breakpoints.toggle {enabled: false}, while its ticks claim the breakpoint is disabled
    let toggled = false;
    const neverMuted = await run(
      {
        toServer: (frame) => {
          if (frame.method !== "breakpoints.toggle") return frame;
          toggled = true;
          return { ...frame, params: { ...(frame.params as Json), enabled: true } };
        },
        toClient: (frame) => {
          if (!isTick(frame) || !toggled) return frame;
          const breakpoints = Object.fromEntries(
            Object.entries(frame.params.breakpoints as Record<string, Json>).map(([key, value]) => [key, { ...value, enabled: false }]),
          );
          return { ...frame, params: { ...frame.params, breakpoints } };
        },
      },
      ["S07"],
    );
    expect(statusOf(neverMuted, "S07")).toBe("failed");
    expect(detailsOf(neverMuted, "S07")).toMatch(/a disabled breakpoint on the next instruction: the target stopped/);

    const echoOnly = await run(
      {
        // the server ignores the request ...
        toServer: (frame) => (frame.method === "breakpoints.setCategoryStates" ? { ...frame, params: { categories: {} } } : frame),
      },
      ["S06"],
    );
    expect(statusOf(echoOnly, "S06")).toBe("failed");
    // (the first request of S06 is the one that names only "events")
    expect(detailsOf(echoOnly, "S06")).toMatch(/breakpoints\.setCategoryStates: the tick echoes events as \{"muted":false,"soloed":false\}, expected \{"muted":true,"soloed":false\}/);
    // (a request without effect is waited for, for a second)
  }, 30_000);

  it("S07: a breakpoint that is not enabled again by breakpoints.toggle, or is listed as enabled and never hit again", async () => {
    // the server answers {} to {enabled: true} and leaves the breakpoint disabled
    const ignored = await run({ toServer: (frame) => (frame.method === "breakpoints.toggle" ? { ...frame, params: { ...paramsOf(frame), enabled: false } } : frame) }, ["S07"]);
    expect(statusOf(ignored, "S07")).toBe("failed");
    expect(detailsOf(ignored, "S07")).toMatch(/^breakpoints\.toggle: breakpoint 1 is not listed as enabled \(1 tick within 1000 ms of the request/);

    // the server lists it as enabled, and has not armed it
    const listedOnly = await run(() => {
      const revived = new Set<unknown>();
      return {
        toServer: (frame) => {
          if (frame.method !== "breakpoints.toggle") return frame;
          revived[paramsOf(frame).enabled ? "add" : "delete"](paramsOf(frame).id);
          return { ...frame, params: { ...paramsOf(frame), enabled: false } };
        },
        toClient: (frame) => {
          if (!isTick(frame)) return frame;
          const breakpoints = Object.fromEntries(
            Object.entries(frame.params.breakpoints as Record<string, Json>).map(([key, value]) => [key, revived.has(value.id) ? { ...value, enabled: true } : value]),
          );
          return { ...frame, params: { ...frame.params, breakpoints } };
        },
      };
    }, ["S07"]);
    expect(statusOf(listedOnly, "S07")).toBe("failed");
    // the mock's loop comes back to the breakpoint within 130 ms; the runner then shows it once more, on the next instruction
    expect(detailsOf(listedOnly, "S07")).toMatch(/^a paused tick at the breakpoint 0x8C0000[0-9A-F]{2}: not seen within 2000 ms/);
    expect(listedOnly.cleanUpProblems).toEqual([]);
  }, 90_000);

  it("S11: a server without the ARM7 callstack: no frames in the tick, or state.getCallstack {arm7} refused", async () => {
    const empty = await run(
      { toClient: (frame) => (isTick(frame) ? { ...frame, params: { ...frame.params, callstacks: { ...(frame.params.callstacks as Json), arm7: [] } } } : frame) },
      ["S11"],
    );
    expect(statusOf(empty, "S11")).toBe("failed");
    expect(detailsOf(empty, "S11")).toBe("a paused tick carries the ARM7 callstack (frame 0 the PC, frame 1 the link register); this one has 0 frame(s)");

    const refused = await run(
      {
        answer: (request) =>
          request.method === "state.getCallstack" && paramsOf(request).target === "arm7" ? rpcError(request, -32004, "not supported: arm7 callstack") : undefined,
      },
      ["S11"],
    );
    expect(statusOf(refused, "S11")).toBe("failed");
    expect(detailsOf(refused, "S11")).toBe('state.getCallstack {"target":"arm7","maxFrames":8}: JSON-RPC error -32004 "not supported: arm7 callstack"');

    // the link register is R14, and the frame says where it came from
    const wrongLink = await run(
      {
        toClient: (frame) => {
          if (!isTick(frame)) return frame;
          const arm7 = ((frame.params.callstacks as Json).arm7 as Json[]).map((entry) => (entry.index === 1 ? { ...entry, location: "pr" } : entry));
          return { ...frame, params: { ...frame.params, callstacks: { ...(frame.params.callstacks as Json), arm7 } } };
        },
      },
      ["S11"],
    );
    expect(detailsOf(wrongLink, "S11")).toBe('arm7: frame 1 has location "pr", expected "lr"');

    // a server that does not list the ARM7 is not asked for its callstack
    const withoutArm7 = await run(undefined, ["S11"], { supports: { targets: ["sh4", "dsp"] } });
    expect(reportOf(withoutArm7)).toEqual(["S11 passed "]);
  }, 30_000);

  it("the strict copy: a callstack frame without sp, more than 64 frames from state.getCallstack, an event breakpoint with an address", async () => {
    const withoutSp = (frames: Json[]) => frames.map(({ sp: _sp, ...frame }) => frame);
    const noSp = await run(
      {
        toClient: (frame) => {
          if (isTick(frame)) {
            const { sh4, arm7 } = frame.params.callstacks as { sh4: Json[]; arm7: Json[] };
            return { ...frame, params: { ...frame.params, callstacks: { sh4: withoutSp(sh4), arm7: withoutSp(arm7) } } };
          }
          const result = frame.result as { frames?: Json[] } | undefined;
          return result?.frames ? { ...frame, result: { ...result, frames: withoutSp(result.frames) } } : frame;
        },
      },
      ["S11"],
    );
    expect(statusOf(noSp, "S11")).toBe("failed");
    expect(noSp.invariantViolations.join("\n")).toMatch(/I1: tick\.callstacks\.sh4\.0\.sp: Invalid input: expected number, received undefined/);
    expect(noSp.invariantViolations.join("\n")).toMatch(/I1: Response validation failed for state\.getCallstack: frames\.0\.sp: /);

    // 65 frames for the largest maxFrames there is
    const tooMany = await run(
      {
        toClient: (frame) => {
          const result = frame.result as { frames?: Json[] } | undefined;
          if (!result?.frames || result.frames.length < 16) return frame;
          const frames = Array.from({ length: 65 }, (_, index) => ({ ...result.frames![index % result.frames!.length], index }));
          return { ...frame, result: { ...result, frames } };
        },
      },
      ["S11"],
    );
    expect(statusOf(tooMany, "S11")).toBe("failed");
    expect(detailsOf(tooMany, "S11")).toMatch(/^state\.getCallstack \{"target":"sh4","maxFrames":64\}: Response validation failed for state\.getCallstack: frames: Too big: expected array to have <=64 items$/m);

    // the server stores the address that came with an event breakpoint
    const mock = new MockDebugger();
    const tables = mock as unknown as { addBreakpoint(params: Json, context: Json): unknown; breakpoints: Map<number, Json>; nextBreakpointId: number };
    const add = tables.addBreakpoint.bind(mock);
    tables.addBreakpoint = (params, context) => {
      const id = tables.nextBreakpointId;
      const result = add(params, context);
      if (params.kind === "event" && params.address !== undefined && tables.breakpoints.has(id)) {
        tables.breakpoints.set(id, { ...tables.breakpoints.get(id), address: params.address });
      }
      return result;
    };
    const { url } = await startServer(undefined, mock);
    const stored = await runContract({ url, profile: "mock", only: new Set(["S07"]) });
    expect(statusOf(stored, "S07")).toBe("failed");
    expect(detailsOf(stored, "S07")).toMatch(/^breakpoints\.add: the tick lists the event breakpoint with address 2348875776; an event breakpoint has none$/m);
    expect(stored.invariantViolations.join("\n")).toMatch(/I1: tick\.breakpoints\.\d+\.address: an event breakpoint has no address/);
    expect(stored.cleanUpProblems).toEqual([]);
  }, 60_000);

  it("a watch that is not evaluated in every tick: the value of the last stop while running, or a value while the SH4 context is stale", async () => {
    const frozen = await run(() => {
      const atStop = new Map<unknown, unknown>();
      return {
        toClient: (frame) => {
          if (!isTick(frame)) return frame;
          const watches = frame.params.watches as Json[];
          if (frame.params.executionState.state === "paused") {
            watches.forEach((watch) => atStop.set(watch.id, watch.value));
            return frame;
          }
          return { ...frame, params: { ...frame.params, watches: watches.map((watch) => ({ ...watch, value: atStop.get(watch.id) ?? watch.value })) } };
        },
      };
    }, ["S03"]);
    expect(statusOf(frozen, "S03")).toBe("failed");
    expect(detailsOf(frozen, "S03")).toMatch(/^the watch on dc\.timing\.sh4_cycles reads "0x[0-9A-F]{16}" in every running tick; watches are evaluated in every tick$/m);
    expect(frozen.invariantViolations.join("\n")).toMatch(/I6: watch 1 \(dc\.timing\.sh4_cycles\) reads "0x[0-9A-F]{16}", the register in the same tick reads "0x[0-9A-F]{16}" \(tick \d+\)/);
    expect(frozen.invariantViolations.join("\n")).toMatch(/I6: watch 2 \(dc\.sh4\.cpu\.pc\) reads "0x8C0000[0-9A-F]{2}", the register in the same tick reads/);
    expect(frozen.cleanUpProblems).toEqual([]);

    // a backend without a context at the slice hook: its ticks say registersStale, and a watch on the SH4 reads "n/a"
    const stale = await run(
      {
        toClient: (frame) =>
          isTick(frame)
            ? { ...frame, params: { ...frame.params, watches: (frame.params.watches as Json[]).map((watch) => (watch.value === "n/a" ? { ...watch, value: "0x8C0000A0" } : watch)) } }
            : frame,
      },
      ["S03"],
      { sliceContext: false },
    );
    expect(statusOf(stale, "S03")).toBe("failed");
    expect(detailsOf(stale, "S03")).toMatch(/invariant: I6: watch 2 \(dc\.sh4\.cpu\.pc\) reads "0x8C0000A0" in a tick that says registersStale, expected "n\/a"/);
  }, 30_000);

  it("S06: a soloed category whose own breakpoints are not active either", async () => {
    const mock = new MockDebugger();
    const machine = mock as unknown as { isActive(breakpoint: Json): boolean; categories: Map<string, { soloed: boolean }> };
    const isActive = machine.isActive.bind(mock);
    machine.isActive = (breakpoint) => !Array.from(machine.categories.values()).some((category) => category.soloed) && isActive(breakpoint);
    const { url } = await startServer(undefined, mock);
    const summary = await runContract({ url, profile: "mock", only: new Set(["S06"]) });
    expect(statusOf(summary, "S06")).toBe("failed");
    expect(detailsOf(summary, "S06")).toMatch(/^a paused tick at the breakpoint 0x8C0000[0-9A-F]{2}: not seen within 2000 ms; ticks since then: \d+ \(#\d+ running /);
    expect(summary.cleanUpProblems).toEqual([]);
    expect((await stateOf(url)).categories.sh4).toEqual({ muted: false, soloed: false });
  }, 30_000);

  it("S13: a change of the watches, or of the categories, whose tick goes to the client that asked for it only", async () => {
    /** The mock, with the tick after the methods that match `quiet` sent to the requesting client only. */
    const notBroadcasting = (quiet: RegExp): MockDebugger => {
      const mock = new MockDebugger();
      const inner = mock as unknown as {
        dispatch(client: Json, id: number, method: string, params: Json): void;
        tickAfter(context: { client: Json & { id: number }; afterResponse: Array<() => void> }): void;
        broadcastTick(): void;
        sendTick(client: Json, tick: Json): void;
        buildTick(full: boolean): Json;
        clients: Map<number, Json>;
      };
      let method = "";
      const dispatch = inner.dispatch.bind(mock);
      inner.dispatch = (client, id, name, params) => {
        method = name;
        dispatch(client, id, name, params);
      };
      inner.tickAfter = (context) => {
        const own = quiet.test(method);
        context.afterResponse.push(() => {
          if (!own) {
            inner.broadcastTick();
          } else if (inner.clients.has(context.client.id)) {
            inner.sendTick(context.client, inner.buildTick(false));
          }
        });
      };
      return mock;
    };
    const only = new Set(["S13"]);

    const watches = await runContract({ url: (await startServer(undefined, notBroadcasting(/^state\.(watch|unwatch)$/))).url, profile: "mock", only });
    expect(statusOf(watches, "S13")).toBe("failed");
    expect(detailsOf(watches, "S13")).toBe("a tick on the second connection that lists watch 1: not seen within 1000 ms; ticks since then: 0");

    const categories = await runContract({ url: (await startServer(undefined, notBroadcasting(/setCategoryStates/))).url, profile: "mock", only });
    expect(statusOf(categories, "S13")).toBe("failed");
    expect(detailsOf(categories, "S13")).toBe("a tick on the second connection with the category events muted: not seen within 1000 ms; ticks since then: 0");
    expect(categories.cleanUpProblems).toEqual([]);
  }, 30_000);

  it("S05, S08: ids that are used again: a new breakpoint, or a new watch, under the lowest free id", async () => {
    /** The server's ids, shown to the client as the lowest id that nothing listed has. */
    const lowestFree = () => {
      const shown = new Map<number, number>();
      const real = new Map<number, number>();
      const last = new Map<number, number>();
      return {
        show: (ids: number[]) => {
          Array.from(shown.keys())
            .filter((id) => !ids.includes(id))
            .forEach((id) => shown.delete(id));
          for (const id of [...ids].sort((a, b) => a - b)) {
            if (!shown.has(id)) {
              const taken = new Set(shown.values());
              let free = 1;
              while (taken.has(free)) free++;
              shown.set(id, free);
              real.set(free, id);
              last.set(id, free);
            }
          }
        },
        shown: (id: number) => shown.get(id) ?? last.get(id) ?? id,
        real: (id: unknown) => (typeof id === "number" ? (real.get(id) ?? id) : id),
      };
    };

    const breakpointIds = lowestFree();
    const reusedBreakpointIds = await run(
      {
        toClient: (frame) => {
          if (!isTick(frame)) return frame;
          const listed = Object.values(frame.params.breakpoints as Record<string, Json & { id: number }>);
          breakpointIds.show(listed.map((breakpoint) => breakpoint.id));
          const breakpoints = Object.fromEntries(listed.map((breakpoint) => [String(breakpointIds.shown(breakpoint.id)), { ...breakpoint, id: breakpointIds.shown(breakpoint.id) }]));
          const executionState = { ...frame.params.executionState };
          if (typeof executionState.breakpointId === "number") executionState.breakpointId = breakpointIds.shown(executionState.breakpointId);
          return { ...frame, params: { ...frame.params, breakpoints, executionState } };
        },
        toServer: (frame) =>
          frame.method === "breakpoints.remove" || frame.method === "breakpoints.toggle"
            ? { ...frame, params: { ...(frame.params as Json), id: breakpointIds.real((frame.params as Json).id) } }
            : frame,
      },
      ["S05", "S06"],
    );
    // the breakpoint of S05 was 1, and so is the first one of S06
    expect(statusOf(reusedBreakpointIds, "S05")).toBe("passed");
    expect(statusOf(reusedBreakpointIds, "S06")).toBe("failed");
    expect(detailsOf(reusedBreakpointIds, "S06")).toMatch(/breakpoints\.add: the new breakpoint has id 1, which an earlier breakpoint of this run had; ids are never reused/);
    // I8 says the same of every tick, whoever added the breakpoint
    expect(new Set(reusedBreakpointIds.invariantViolations.map((violation) => violation.replace(/ \(tick \d+\)$/, "")))).toEqual(
      new Set(["I8: breakpoint id 1 is listed again after a tick that did not list it; ids are never reused"]),
    );

    const watchIds = lowestFree();
    const reusedWatchIds = await run(
      {
        toClient: (frame) => {
          if (!isTick(frame)) return frame;
          const listed = frame.params.watches as Array<Json & { id: number }>;
          watchIds.show(listed.map((watch) => watch.id));
          const watches = listed.map((watch) => ({ ...watch, id: watchIds.shown(watch.id) })).sort((a, b) => a.id - b.id);
          return { ...frame, params: { ...frame.params, watches } };
        },
        toServer: (frame) => {
          const params = frame.params as Json;
          if (frame.method === "state.unwatch") return { ...frame, params: { watchIds: (params.watchIds as unknown[]).map(watchIds.real) } };
          if (frame.method === "state.modifyWatchExpression") return { ...frame, params: { ...params, watchId: watchIds.real(params.watchId) } };
          return frame;
        },
      },
      ["S05", "S08"],
    );
    expect(statusOf(reusedWatchIds, "S05")).toBe("passed");
    expect(statusOf(reusedWatchIds, "S08")).toBe("failed");
    expect(detailsOf(reusedWatchIds, "S08")).toMatch(/state\.watch: the new watch has id 1, which an earlier watch of this run had; ids are never reused/);
    expect(new Set(reusedWatchIds.invariantViolations.map((violation) => violation.replace(/ \(tick \d+\)$/, "")))).toEqual(
      new Set(["I8: watch id 1 is listed again after a tick that did not list it; ids are never reused"]),
    );
  });

  it("S03: periodic running ticks that are never full", async () => {
    const BASE = ["dc.sh4.cpu", "dc.aica.arm7", "dc.aica.dsp", "dc.timing"];
    const summary = await run(
      () => {
        // the tick that follows a describe response stays full, every other running tick carries the base paths
        let afterDescribe = false;
        return {
          toClient: (frame) => {
            if (!isTick(frame)) {
              afterDescribe = Boolean((frame.result as Json | undefined)?.deviceTree);
              return frame;
            }
            if (afterDescribe || frame.params.executionState.state !== "running") {
              afterDescribe = false;
              return frame;
            }
            const registers = Object.fromEntries(Object.entries(frame.params.registers).filter(([path]) => BASE.includes(path)));
            return { ...frame, params: { ...frame.params, registers } };
          },
        };
      },
      ["S01", "S02", "S03"],
    );
    expect(reportOf(summary).slice(0, 2)).toEqual(["S01 passed ", "S02 passed "]);
    expect(statusOf(summary, "S03")).toBe("failed");
    expect(detailsOf(summary, "S03")).toMatch(/no running tick in the 2000 ms after the resume carries every described path; every fifth periodic tick is full\. The last one lacks dc, /);
    // no invariant says so: a running tick may be partial
    expect(summary.invariantViolations).toEqual([]);
  }, 30_000);

  it("S08: a stored expression that is added twice", async () => {
    const { url, direct } = await startServer({
      // the request that adds nothing adds something
      toServer: (frame) => (isWatchOfStoredExpression(frame) ? { ...frame, params: { expressions: ["dc.aica.arm7.pc"] } } : frame),
    });
    const summary = await runContract({ url, profile: "mock", only: new Set(["S08"]) });
    expect(statusOf(summary, "S08")).toBe("failed");
    expect(detailsOf(summary, "S08")).toBe("an expression that is already stored is not added twice");
    // and the watch nobody asked for is removed again
    expect(summary.cleanUpProblems).toEqual([]);
    expect((await stateOf(direct)).watches).toEqual([]);
  });

  it("S01: register values of the describe tree that are not written as those of a tick", async () => {
    const lower = (nodes: Json[]): Json[] =>
      nodes.map((node) => ({
        ...node,
        ...(node.registers ? { registers: (node.registers as Json[]).map((register) => ({ ...register, value: String(register.value).toLowerCase() })) } : {}),
        ...(node.children ? { children: lower(node.children as Json[]) } : {}),
      }));
    const summary = await run(
      {
        toClient: (frame) => {
          const result = frame.result as Json | undefined;
          return result?.deviceTree ? { ...frame, result: { ...result, deviceTree: lower(result.deviceTree as Json[]) } } : frame;
        },
      },
      ["S01"],
    );
    expect(statusOf(summary, "S01")).toBe("failed");
    expect(detailsOf(summary, "S01")).toMatch(/^dc\.sh4\.cpu\.PC = "0x8c0000a[0-9a-e]" in the describe tree is not 0x \+ 8 upper-case hex digits or "n\/a"$/m);
    // the ticks are right, and the strict schema has nothing to say about a string
    expect(summary.invariantViolations).toEqual([]);
  });

  it("S04: control.stepOver or control.stepOut of the SH4 that is not supported", async () => {
    // control.reset is what the mock answers with the in-band -32004
    const without = (method: string) =>
      run({ toServer: (frame) => (frame.method === method ? { ...frame, method: "control.reset", params: {} } : frame) }, ["S04"]);
    const noStepOver = await without("control.stepOver");
    expect(statusOf(noStepOver, "S04")).toBe("failed");
    expect(detailsOf(noStepOver, "S04")).toBe('control.stepOver {"target":"sh4"}: in-band error -32004 "not supported: control.reset"');
    const noStepOut = await without("control.stepOut");
    expect(statusOf(noStepOut, "S04")).toBe("failed");
    expect(detailsOf(noStepOut, "S04")).toBe('control.stepOut {"target":"sh4"}: in-band error -32004 "not supported: control.reset"');

    // a step-over that runs on instead of stepping
    const resumes = await run({ toServer: (frame) => (frame.method === "control.stepOver" ? { ...frame, method: "control.stepOut" } : frame) }, ["S04"]);
    expect(statusOf(resumes, "S04")).toBe("failed");
    expect(detailsOf(resumes, "S04")).toBe('control.stepOver {sh4}: a running tick arrived before the paused tick of the step');
  });

  it("S06: breakpoints.setCategoryStates that resets the keys it is not given, or refuses a key it does not know", async () => {
    const unmuted = { muted: false, soloed: false };
    const resets = await run(
      {
        toServer: (frame) =>
          frame.method === "breakpoints.setCategoryStates"
            ? { ...frame, params: { categories: { events: unmuted, sh4: unmuted, arm7: unmuted, dsp: unmuted, ...((frame.params as Json).categories as Json) } } }
            : frame,
      },
      ["S06"],
    );
    expect(statusOf(resets, "S06")).toBe("failed");
    expect(detailsOf(resets, "S06")).toMatch(
      /^breakpoints\.setCategoryStates \{dsp\} changed a key it does not name: the categories are \{"events":\{"muted":false,"soloed":false\},.*, expected \{"events":\{"muted":true,"soloed":false\},/,
    );
    expect(resets.cleanUpProblems).toEqual([]);

    const refuses = await run(
      {
        // (toggling a breakpoint that does not exist is what the mock answers with the in-band -32602)
        toServer: (frame) =>
          frame.method === "breakpoints.setCategoryStates" && "no-such-category" in ((frame.params as Json).categories as Json)
            ? { ...frame, method: "breakpoints.toggle", params: { id: 0x7fffffff, enabled: true } }
            : frame,
      },
      ["S06"],
    );
    expect(statusOf(refuses, "S06")).toBe("failed");
    expect(detailsOf(refuses, "S06")).toMatch(/^breakpoints\.setCategoryStates \{"categories":\{"no-such-category":\{"muted":true,"soloed":true\}\}\}: in-band error -32602 /);
    expect(refuses.cleanUpProblems).toEqual([]);
  }, 30_000);

  it("S07: a server without event breakpoints", async () => {
    const refused = await run(
      {
        // an event of the tree is answered as one that is not in the server's table
        toServer: (frame) => {
          const params = frame.params as Json;
          return frame.method === "breakpoints.add" && params.address === undefined && params.kind !== "code" ? { ...frame, params: { ...params, event: "dc.no.such.event" } } : frame;
        },
      },
      ["S07"],
    );
    expect(statusOf(refused, "S07")).toBe("failed");
    expect(detailsOf(refused, "S07")).toBe('breakpoints.add {"event":"dc.system.reset","kind":"event","enabled":false}: in-band error -32004 "not supported: event dc.no.such.event"');

    const notAdvertised = await run(
      {
        toClient: (frame) => {
          const result = frame.result as Json | undefined;
          return result?.deviceTree ? { ...frame, result: { ...result, capabilities: (result.capabilities as string[]).filter((capability) => capability !== "event-breakpoints") } } : frame;
        },
      },
      ["S07"],
    );
    expect(statusOf(notAdvertised, "S07")).toBe("failed");
    expect(detailsOf(notAdvertised, "S07")).toBe('the capability "event-breakpoints" is part of milestone M1');
  }, 30_000);

  it("S07: event breakpoints that are listed and never stop the target, and a tree without the vertical blank event", async () => {
    const mock = new MockDebugger();
    // the event is logged, and no breakpoint on it is ever reported as hit
    const machine = mock as unknown as { emitEvent(name: string, message: string): number | undefined };
    const emit = machine.emitEvent.bind(mock);
    machine.emitEvent = (name, message) => {
      emit(name, message);
      return undefined;
    };
    const { url } = await startServer(undefined, mock);
    const neverHit = await runContract({ url, profile: "mock", only: new Set(["S07"]) });
    expect(statusOf(neverHit, "S07")).toBe("failed");
    expect(detailsOf(neverHit, "S07")).toMatch(/^a paused tick at the event breakpoint on dc\.holly\.core\.vblank: not seen within 2000 ms; ticks since then: \d+ \(#\d+ running /);
    expect(neverHit.cleanUpProblems).toEqual([]);
    expect((await stateOf(url)).breakpoints).toEqual({});

    const withoutEvent = (nodes: Json[]): Json[] =>
      nodes.map((node) => {
        const { events, children, ...rest } = node as Json & { events?: string[]; children?: Json[] };
        const kept = events?.filter((event) => event !== "dc.holly.core.vblank");
        return { ...rest, ...(kept?.length ? { events: kept } : {}), ...(children ? { children: withoutEvent(children) } : {}) };
      });
    const notListed = await run(
      {
        toClient: (frame) => {
          const result = frame.result as Json | undefined;
          return result?.deviceTree ? { ...frame, result: { ...result, deviceTree: withoutEvent(result.deviceTree as Json[]) } } : frame;
        },
      },
      ["S07"],
    );
    expect(statusOf(notListed, "S07")).toBe("failed");
    expect(detailsOf(notListed, "S07")).toBe("the device tree lists the event dc.holly.core.vblank, which every running program raises");
  }, 90_000);

  it("S08: a watch bound that is not enforced, and state.unwatch that refuses an id it does not know", async () => {
    // (state.unwatch of nothing is what the mock answers with {})
    const accepted = (matches: (expressions: string[]) => boolean) =>
      run(
        {
          toServer: (frame) =>
            frame.method === "state.watch" && matches((frame.params as Json).expressions as string[]) ? { ...frame, method: "state.unwatch", params: { watchIds: [] } } : frame,
        },
        ["S08"],
      );
    const many = await accepted((expressions) => expressions.length > 64);
    expect(statusOf(many, "S08")).toBe("failed");
    expect(detailsOf(many, "S08")).toMatch(/^state\.watch \{"expressions":\["dc\.sh4\.cpu\.pc",.*\]\}: expected the error -32602, got the result \{\}$/);
    const long = await accepted((expressions) => expressions.some((expression) => expression.length > 256));
    expect(statusOf(long, "S08")).toBe("failed");
    expect(detailsOf(long, "S08")).toMatch(/^state\.watch \{"expressions":\["dc\.sh4\.cpu\.r{246}"\]\}: expected the error -32602, got the result \{\}$/);

    const strict = await run(() => {
      // the watches of the last tick: an id that is not among them is answered as state.modifyWatchExpression answers it
      let listed: unknown[] = [];
      return {
        toClient: (frame) => {
          if (isTick(frame)) listed = (frame.params.watches as Json[]).map((watch) => watch.id);
          return frame;
        },
        toServer: (frame) => {
          const ids = frame.method === "state.unwatch" ? ((frame.params as Json).watchIds as unknown[]) : [];
          const unknown = ids.find((id) => !listed.includes(id));
          return unknown === undefined ? frame : { ...frame, method: "state.modifyWatchExpression", params: { watchId: unknown, newExpression: "dc.sh4.cpu.pc" } };
        },
      };
    }, ["S08"]);
    expect(statusOf(strict, "S08")).toBe("failed");
    expect(detailsOf(strict, "S08")).toMatch(/^state\.unwatch \{"watchIds":\[1\]\}: in-band error -32602 "invalid params: unknown watch id 1"$/);
  });

  it("S08 to S11: bounds that are smaller than the protocol's: the largest length, count, maxFrames and number of expressions are refused", async () => {
    const summary = await run(
      {
        answer: (request) => {
          const { length, count, maxFrames, expressions } = paramsOf(request) as { length?: number; count?: number; maxFrames?: number; expressions?: string[] };
          if (
            (request.method === "state.getMemorySlice" && length! > 4096 && length! <= 65536) ||
            (request.method === "state.getDisassembly" && count! > 256 && count! <= 1024) ||
            (request.method === "state.getCallstack" && maxFrames! > 32 && maxFrames! <= 64)
          ) {
            return rpcError(request, -32602, "invalid params: too large");
          }
          return request.method === "state.watch" && expressions!.length > 16 && expressions!.length <= 64 ? inBand(request, -32602, "invalid params: too many") : undefined;
        },
      },
      ["S08", "S09", "S10", "S11"],
    );
    expect(reportOf(summary)).toEqual([
      expect.stringMatching(/^S08 failed state\.watch \{"expressions":\[("dc[a-z0-9_.]+",?){64}\]\}: in-band error -32602 "invalid params: too many"$/),
      expect.stringMatching(/^S09 failed state\.getMemorySlice \{"target":"sh4","address":\d+,"length":65536\}: JSON-RPC error -32602 "invalid params: too large"$/),
      expect.stringMatching(/^S10 failed state\.getDisassembly \{"target":"sh4","address":\d+,"count":1024\}: JSON-RPC error -32602 "invalid params: too large"$/),
      'S11 failed state.getCallstack {"target":"sh4","maxFrames":64}: JSON-RPC error -32602 "invalid params: too large"',
    ]);
    expect(summary.cleanUpProblems).toEqual([]);
  }, 30_000);

  it("S10, S11: a server that uses the context of state.getDisassembly, or needs the parameters that have a default", async () => {
    const context = await run(
      {
        toServer: (frame) => {
          const params = paramsOf(frame) as { target?: string; address: number; context?: number };
          const size = params.target === "arm7" ? 4 : params.target === "dsp" ? 1 : 2;
          return frame.method === "state.getDisassembly" && params.context ? { ...frame, params: { ...params, address: Math.max(0, params.address - params.context * size) } } : frame;
        },
      },
      ["S10"],
    );
    expect(detailsOf(context, "S10")).toMatch(/^sh4: with context 8 the 16 lines start at 0x8C000[0-9A-F]{3}, without it the 16 lines start at 0x8C0000[0-9A-F]{2}; context is ignored$/);

    const defaults = await run(
      {
        answer: (request) =>
          (request.method === "state.getDisassembly" && paramsOf(request).target === undefined) || (request.method === "state.getCallstack" && paramsOf(request).maxFrames === undefined)
            ? rpcError(request, -32602, "invalid params: missing")
            : undefined,
      },
      ["S10", "S11"],
    );
    expect(reportOf(defaults)).toEqual([
      expect.stringMatching(/^S10 failed state\.getDisassembly \{"address":\d+,"count":16\}: JSON-RPC error -32602 "invalid params: missing"$/),
      'S11 failed state.getCallstack {"target":"sh4"}: JSON-RPC error -32602 "invalid params: missing"',
    ]);

    // a default of eight frames where the protocol says 32 (the mock's stacks have sixteen)
    const shallow = await run(
      {
        toServer: (frame) =>
          frame.method === "state.getCallstack" && paramsOf(frame).maxFrames === undefined ? { ...frame, params: { ...paramsOf(frame), maxFrames: 8 } } : frame,
      },
      ["S11"],
    );
    expect(detailsOf(shallow, "S11")).toBe("state.getCallstack without maxFrames returned 8 frames, with maxFrames 32 16; maxFrames defaults to 32");
  }, 30_000);

  it("S07, S08: a server that stores more breakpoints or watches than the protocol allows, or fewer", async () => {
    // the 1025th breakpoint and the 257th watch are stored
    const mock = new MockDebugger();
    const tables = mock as unknown as {
      watch(params: { expressions: string[] }, context: Json): unknown;
      addBreakpoint(params: Json, context: Json): unknown;
      watches: Map<number, Json>;
      breakpoints: Map<number, Json>;
      nextWatchId: number;
      nextBreakpointId: number;
      resolveExpression(expression: string): Json;
      tickAfter(context: Json): void;
    };
    const watch = tables.watch.bind(mock);
    tables.watch = (params, context) => {
      if (tables.watches.size + params.expressions.length <= 256) {
        return watch(params, context);
      }
      for (const expression of params.expressions) {
        const id = tables.nextWatchId++;
        tables.watches.set(id, { id, ...tables.resolveExpression(expression) });
      }
      tables.tickAfter(context);
      return {};
    };
    const add = tables.addBreakpoint.bind(mock);
    tables.addBreakpoint = (params, context) => {
      if (tables.breakpoints.size < 1024) {
        return add(params, context);
      }
      const id = tables.nextBreakpointId++;
      tables.breakpoints.set(id, { id, event: params.event, kind: "event", enabled: false });
      tables.tickAfter(context);
      return {};
    };
    const { url } = await startServer(undefined, mock);
    const unbounded = await runContract({ url, profile: "mock", only: new Set(["S07", "S08"]) });
    expect(reportOf(unbounded)).toEqual([
      'S07 failed breakpoints.add {"event":"dc.system.reset","kind":"event","enabled":false}: expected the error -32602, got the result {}',
      expect.stringMatching(/^S08 failed state\.watch \{"expressions":\["dc[a-z0-9_.]+"\]\}: expected the error -32602, got the result \{\}$/),
    ]);
    // what the two scenarios stored is removed again: 1025 breakpoints, 257 watches
    expect(unbounded.cleanUpProblems).toEqual([]);
    const left = await stateOf(url);
    expect([Object.keys(left.breakpoints).length, left.watches.length]).toEqual([0, 0]);

    // 512 breakpoints and 128 watches at most
    const smaller = await run(() => {
      let stored = { breakpoints: 0, watches: 0 };
      return {
        toClient: (frame) => {
          if (isTick(frame)) {
            stored = { breakpoints: Object.keys(frame.params.breakpoints as Json).length, watches: (frame.params.watches as Json[]).length };
          }
          return frame;
        },
        answer: (request) => {
          if (request.method === "breakpoints.add" && stored.breakpoints >= 512) {
            return inBand(request, -32602, "invalid params: at most 512 breakpoints");
          }
          return request.method === "state.watch" && stored.watches + (paramsOf(request).expressions as string[]).length > 128
            ? inBand(request, -32602, "invalid params: at most 128 watches")
            : undefined;
        },
      };
    }, ["S07", "S08"]);
    expect(reportOf(smaller)).toEqual([
      'S07 failed breakpoints.add {"event":"dc.system.reset","kind":"event","enabled":false}: in-band error -32602 "invalid params: at most 512 breakpoints"',
      expect.stringMatching(/^S08 failed state\.watch \{"expressions":\[("dc[a-z0-9_.]+",?){64}\]\}: in-band error -32602 "invalid params: at most 128 watches"$/),
    ]);
    expect(smaller.cleanUpProblems).toEqual([]);
  }, 120_000);

  it("S09: a target that says memory: true and refuses state.getMemorySlice", async () => {
    const summary = await run(
      {
        // (the DSP is what the mock answers with -32004)
        toServer: (frame) =>
          frame.method === "state.getMemorySlice" && (frame.params as Json).target === "arm7" ? { ...frame, params: { ...(frame.params as Json), target: "dsp" } } : frame,
      },
      ["S09"],
    );
    expect(statusOf(summary, "S09")).toBe("failed");
    expect(detailsOf(summary, "S09")).toBe('state.getMemorySlice {"target":"arm7","address":0,"length":16}: JSON-RPC error -32004 "not supported: target dsp has no memory"');
  });

  it("S10: an unreadable word that is not \"??\" and \"<unreadable>\"", async () => {
    const summary = await run(
      {
        toClient: (frame) => {
          const lines = (frame.result as Json | undefined)?.lines as Json[] | undefined;
          return lines ? { ...frame, result: { lines: lines.map((line) => (line.bytes === "??" ? { ...line, disassembly: "???" } : line)) } } : frame;
        },
      },
      ["S10"],
    );
    expect(statusOf(summary, "S10")).toBe("failed");
    expect(detailsOf(summary, "S10")).toBe('sh4: the unreadable word at 0x10000000 is bytes "??" and text "???", expected "??" and "<unreadable>"');
  });

  it("S14: a server that forgets, or lets go, when its last client disconnects", async () => {
    const reconnect = async (forget: (tick: Json) => Array<[string, Json]>) => {
      const { url } = await startServer(undefined, new ForgetfulMock(forget));
      const summary = await runContract({ url, profile: "mock", only: new Set(["S14"]) });
      expect(statusOf(summary, "S14")).toBe("failed");
      return detailsOf(summary, "S14");
    };
    const before = /after the reconnect the first tick has\n.*\n.*before it the last tick had/;

    const noWatches = await reconnect((tick) => [["state.unwatch", { watchIds: (tick.watches as Json[]).map((watch) => watch.id) }]]);
    expect(noWatches).toMatch(before);
    expect(noWatches).toMatch(/"watches":\[\],.*\n.*\n.*"watches":\[\[1,"dc\.sh4\.cpu\.gbr"\]\]/);

    const noBreakpoints = await reconnect((tick) => Object.keys(tick.breakpoints as Json).map((id) => ["breakpoints.remove", { id: Number(id) }]));
    expect(noBreakpoints).toMatch(before);
    expect(noBreakpoints).toMatch(/\{"breakpoints":\{\},.*\n.*\n.*\{"breakpoints":\{"1":/);

    const unmuted = { muted: false, soloed: false };
    const noCategories = await reconnect(() => [["breakpoints.setCategoryStates", { categories: { events: unmuted, sh4: unmuted, arm7: unmuted, dsp: unmuted } }]]);
    expect(noCategories).toMatch(before);
    expect(noCategories).toMatch(/"dsp":\{"muted":false,"soloed":false\}.*\n.*\n.*"dsp":\{"muted":true,"soloed":false\}/);

    const released = await reconnect(() => [["control.runUntil", {}]]);
    expect(released).toMatch(/after the reconnect the first tick is #\d+ running stop 1; before it the target was #\d+ paused stop 1 pause, and a stop outlives a reconnect within the grace period/);
  }, 30_000);

  it("S08: a watch expression that is not stored in lower case", async () => {
    const summary = await run(
      {
        toClient: (frame) => {
          if (!isTick(frame)) return frame;
          const watches = (frame.params.watches as Json[]).map((watch) => ({ ...watch, expression: String(watch.expression).replace(/\.pr$/, ".PR") }));
          return { ...frame, params: { ...frame.params, watches } };
        },
      },
      ["S08"],
    );
    expect(statusOf(summary, "S08")).toBe("failed");
    expect(detailsOf(summary, "S08")).toMatch(/the renamed watch is listed as "dc\.sh4\.cpu\.PR", expected "dc\.sh4\.cpu\.pr"/);
  });

  it("S09: unreadable bytes that are not listed", async () => {
    const summary = await run(
      {
        toClient: (frame) => {
          const result = frame.result as Json | undefined;
          if (result && "unreadable" in result) {
            const { unreadable: _unreadable, ...rest } = result;
            return { ...frame, result: rest };
          }
          return frame;
        },
      },
      ["S09"],
    );
    expect(statusOf(summary, "S09")).toBe("failed");
    expect(detailsOf(summary, "S09")).toMatch(/lists unreadable undefined, expected \[\[16,16\]\]/);
  });

  it("S12: an error with a data member, an error on the wrong channel, an error without a message", async () => {
    const withData = await run(
      {
        toClient: (frame) => (frame.error ? { ...frame, error: { ...(frame.error as Json), data: { stack: "at dispatch" } } } : frame),
      },
      ["S12"],
    );
    expect(statusOf(withData, "S12")).toBe("failed");
    expect(withData.invariantViolations.join("\n")).toMatch(/3\.5: an error object has code and message only, this one has code,data,message/);

    const wrongChannel = await run(
      {
        toClient: (frame) => {
          const inBand = (frame.result as Json | undefined)?.error as Json | undefined;
          return inBand ? { jsonrpc: "2.0", id: frame.id, error: inBand } : frame;
        },
      },
      ["S12"],
    );
    expect(statusOf(wrongChannel, "S12")).toBe("failed");
    expect(detailsOf(wrongChannel, "S12")).toMatch(/control\.step \{"target":4\}: the error -32602 came as a JSON-RPC error, this method reports failures in-band/);

    // a message has to be there: on either channel, and in the answer to a frame that is no request
    const emptied = (code: number): Faults => ({ toClient: (frame) => worded(frame, (sent, text) => (sent === code ? "" : text)) });
    const noMessage = await run(emptied(-32601), ["S12"]);
    expect(statusOf(noMessage, "S12")).toBe("failed");
    expect(detailsOf(noMessage, "S12")).toMatch(/^no\.such\.method \{\}: the error -32601 has no message; error\.message is a non-empty string$/m);
    expect(noMessage.invariantViolations.join("\n")).toMatch(/3\.5: the error -32601 has an empty message; error\.message is a non-empty string/);
    const noInBandMessage = await run(emptied(-32003), ["S12"]);
    expect(statusOf(noInBandMessage, "S12")).toBe("failed");
    expect(noInBandMessage.invariantViolations.join("\n")).toMatch(/I1: Response validation failed for control\.step: error\.message: /);
    const noParseMessage = await run(emptied(-32700), ["S12"]);
    expect(detailsOf(noParseMessage, "S12")).toMatch(/^the answer to malformed JSON is \{"jsonrpc":"2\.0","id":null,"error":\{"code":-32700,"message":""\}\}, expected /);
  }, 30_000);

  it("the wording of error messages is the server's: a server that words every one of them differently passes", async () => {
    // "Invalid params", as JSON-RPC libraries write it, and a text of its own for everything else
    const summary = await run({ toClient: (frame) => worded(frame, (code) => (code === -32602 ? "Invalid params" : `the request failed (${-code})`)) });
    expect(reportOf(summary).filter((line) => !/ (passed|not-applicable|partial) /.test(line))).toEqual([]);
    expect(statusesOf(summary)).toEqual(MOCK_STATUSES);
    expect(summary.invariantViolations).toEqual([]);
    expect(summary.ok).toBe(true);
  }, 180_000);

  it("S12: a server without register-write that answers {} to state.editWatch", async () => {
    const summary = await run(
      { answer: (request) => (request.method === "state.editWatch" ? { jsonrpc: "2.0", id: request.id, result: {} } : undefined) },
      ["S12"],
      { supports: MOCK_M1_SUPPORT },
    );
    expect(statusOf(summary, "S12")).toBe("failed");
    expect(detailsOf(summary, "S12")).toMatch(/^state\.editWatch \{"watchId":1,"value":"0x00000000"\}: expected the error -32004, got the result \{\}$/);
    // the watch of the probe is removed again
    expect(summary.cleanUpProblems).toEqual([]);
  }, 30_000);

  it("S12: a batch that is executed, and frames that are no request and get no answer", async () => {
    const batch = await run(
      { answer: (request) => (Array.isArray(request) ? ([{ jsonrpc: "2.0", id: 1, result: {} }] as unknown as Json) : undefined) },
      ["S12"],
    );
    expect(statusOf(batch, "S12")).toBe("failed");
    expect(detailsOf(batch, "S12")).toBe(
      'a batch (a JSON array of requests) is answered with [{"jsonrpc":"2.0","id":1,"result":{}}], expected the JSON-RPC error -32600 with a message, and nothing else',
    );

    // each of the frames that is no request of this protocol, lost without an answer
    const isRequest = (frame: unknown): frame is Json => typeof frame === "object" && frame !== null && !Array.isArray(frame);
    for (const [lost, what] of [
      [(frame: unknown) => frame === 42, "a frame that is JSON and not an object \\(42\\)"],
      [(frame: unknown) => isRequest(frame) && frame.jsonrpc === undefined, "a request without the jsonrpc member"],
      [(frame: unknown) => isRequest(frame) && typeof frame.id === "string", "a request whose id is a string"],
    ] as const) {
      const summary = await run({ lose: lost }, ["S12"]);
      expect(statusOf(summary, "S12")).toBe("failed");
      expect(detailsOf(summary, "S12")).toMatch(new RegExp(`^no answer to ${what} within 2000 ms$`));
    }

    // a string id that is taken for an id: the request is executed
    const lenient = await run(
      { answer: (request) => (typeof request.id === "string" ? { jsonrpc: "2.0", id: request.id, result: {} } : undefined) },
      ["S12"],
    );
    expect(detailsOf(lenient, "S12")).toBe(
      'a request whose id is a string is answered with {"jsonrpc":"2.0","id":"1","result":{}}, expected the JSON-RPC error -32600 with a message, and nothing else',
    );
  }, 30_000);

  it("reports a scenario whose capability the server does not advertise as not applicable, never as passed; a run of nothing else has verified nothing", async () => {
    const lines: string[] = [];
    const { url } = await startServer({
      toClient: (frame) => {
        const result = frame.result as Json | undefined;
        if (!result?.deviceTree) return frame;
        return {
          ...frame,
          result: {
            ...result,
            capabilities: ["event-breakpoints", "callstack", "sh4-debug-native"],
            targets: (result.targets as Json[]).map((target) => (target.id === "sh4" ? target : { ...target, stepping: false })),
          },
        };
      },
    });
    const summary = await runContract({ url, profile: "mock", only: new Set(["S16", "S17", "S18"]), say: (line) => lines.push(line) });
    expect(summary.scenarios.map((scenario) => scenario.status)).toEqual(["not-applicable", "not-applicable", "not-applicable"]);
    expect(summary).toMatchObject({ passed: 0, failed: 0, partial: 0, notApplicable: 3 });
    expect(detailsOf(summary, "S17")).toBe('no capability "sgc-capture"');
    // nothing failed and nothing was asked to pass, and still this is no success: nothing passed
    expect(summary).toMatchObject({ ok: false, nothingVerified: true, required: [], requiredNotPassed: [] });
    expect(lines.slice(-3)).toEqual([
      "nothing verified: no scenario passed",
      expect.stringMatching(/^0 passed, 0 failed, 0 partial, 3 not applicable; /),
      "contract: FAILED",
    ]);
    // one scenario that passes is enough for a run that looks at a server
    const looked = await runContract({ url, profile: "mock", only: new Set(["S01", "S16", "S17", "S18"]) });
    expect(looked).toMatchObject({ ok: true, nothingVerified: false, passed: 1, notApplicable: 3 });
  });

  it("fails the gate of a milestone when a scenario of it is not applicable or partial: a capability that is not advertised", async () => {
    // an M1 server at the gate of M2: S16 is selected with the scenarios of M1, and it is not applicable
    const lines: string[] = [];
    const { url } = await startServer(undefined, { supports: MOCK_M1_SUPPORT });
    const m2 = await runContract({ url, profile: "mock", milestone: "M2", only: new Set(["S02", "S16"]), say: (line) => lines.push(line) });
    expect(m2).toMatchObject({ passed: 1, failed: 0, partial: 0, notApplicable: 1, ok: false, selected: ["S02", "S16"], required: ["S02", "S16"] });
    expect(m2.requiredNotPassed).toEqual([{ id: "S16", status: "not-applicable" }]);
    expect(lines.slice(-3)).toEqual(["required: S16 is not applicable; it has to pass", expect.stringMatching(/^1 passed, 0 failed, 0 partial, 1 not applicable; /), "contract: FAILED"]);
    // the same with --require, without a gate
    const required = await runContract({ url, profile: "mock", only: new Set(["S01", "S16", "S17"]), require: new Set(["S17", "S16"]) });
    expect(required).toMatchObject({ ok: false, required: ["S16", "S17"] });
    expect(required.requiredNotPassed).toEqual([
      { id: "S16", status: "not-applicable" },
      { id: "S17", status: "not-applicable" },
    ]);
    // a scenario --require names is run although the gate does not have it
    const further = await runContract({ url, profile: "mock", milestone: "M1", only: new Set(["S01", "S17"]), require: new Set(["S17"]) });
    expect(further).toMatchObject({ ok: false, selected: ["S01", "S17"], required: ["S01", "S17"], requiredNotPassed: [{ id: "S17", status: "not-applicable" }] });

    // the mock, which has two of the four parts of S16: partial fails the gate of M2, and S17 passes that of M3
    const full = (await startServer()).url;
    const partial = await runContract({ url: full, profile: "mock", milestone: "M2", only: new Set(["S16"]) });
    expect(partial).toMatchObject({ ok: false, nothingVerified: true, partial: 1, requiredNotPassed: [{ id: "S16", status: "partial" }] });
    const m3only = await runContract({ url: full, profile: "mock", milestone: "M3", only: new Set(["S17"]) });
    expect(m3only).toMatchObject({ ok: true, required: ["S17"], requiredNotPassed: [] });

    // a required scenario that was not run has not passed
    const notRun = await runContract({ url: full, profile: "mock", only: new Set(["S01"]), require: new Set(["S01", "S02"]) });
    expect(notRun.requiredNotPassed).toEqual([{ id: "S02", status: "not-run" }]);
    expect(notRun.ok).toBe(false);
  }, 30_000);

  it("S01 at the gate of a milestone: the three targets are listed, and the capabilities of the milestone advertised", async () => {
    // a server that lists the SH4 alone can be looked at, and is no server of milestone M1
    const sh4Only = { supports: { targets: ["sh4" as const], stepping: ["sh4" as const], capabilities: ["event-breakpoints", "callstack"] } };
    const { url } = await startServer(undefined, sh4Only);
    expect(reportOf(await runContract({ url, profile: "mock", only: new Set(["S01"]) }))).toEqual(["S01 passed "]);
    const gate = await runContract({ url, profile: "mock", milestone: "M1", only: new Set(["S01"]) });
    expect(gate.scenarios[0].details).toEqual([
      "the gate of M1: the target arm7 is not listed; a server of a milestone lists sh4, arm7 and dsp (3.1)",
      "the gate of M1: the target dsp is not listed; a server of a milestone lists sh4, arm7 and dsp (3.1)",
    ]);
    expect(gate.ok).toBe(false);

    // the capabilities of M1, and those M2 adds
    const noCallstack = await runContract({
      url: (await startServer(undefined, { supports: { ...MOCK_M1_SUPPORT, capabilities: ["event-breakpoints"] } })).url,
      profile: "mock",
      milestone: "M1",
      only: new Set(["S01"]),
    });
    expect(noCallstack.scenarios[0].details).toEqual(['the gate of M1: the capability "callstack" is not advertised (3.1)']);
    const m1 = (await startServer(undefined, { supports: MOCK_M1_SUPPORT })).url;
    expect(reportOf(await runContract({ url: m1, profile: "mock", milestone: "M1", only: new Set(["S01"]) }))).toEqual(["S01 passed "]);
    const atM2 = await runContract({ url: m1, profile: "mock", milestone: "M2", only: new Set(["S01"]) });
    expect(atM2.scenarios[0].details).toEqual([
      'the gate of M2: the capability "memory-write" is not advertised (3.1)',
      'the gate of M2: the capability "register-write" is not advertised (3.1)',
      'the gate of M2: the capability "reset" is not advertised (3.1)',
    ]);
  }, 30_000);

  it("--only never turns an empty result into a success: a selection that leaves nothing to pass is a failed run", async () => {
    const { url } = await startServer(undefined, { supports: MOCK_M1_SUPPORT });
    // the scenarios of later milestones, which the gate of M1 does not have
    const lines: string[] = [];
    const outside = await runContract({ url, profile: "mock", milestone: "M1", only: new Set(["S16", "S17", "S18"]), say: (line) => lines.push(line) });
    expect(outside).toMatchObject({ ok: false, nothingVerified: true, selected: [], required: [], scenarios: [], passed: 0, failed: 0 });
    expect(lines.slice(-3)).toEqual([
      "nothing verified: the selection leaves no scenario to run",
      expect.stringMatching(/^0 passed, 0 failed, 0 partial, 0 not applicable; /),
      "contract: FAILED",
    ]);
    expect(await runContract({ url, profile: "mock", milestone: "M2", only: new Set(["S17"]) })).toMatchObject({ ok: false, nothingVerified: true, selected: [] });
    // inside a gate --only narrows it: what is left has to pass, and does
    const piece = await runContract({ url, profile: "mock", milestone: "M1", only: new Set(["S01", "S02"]) });
    expect(piece).toMatchObject({ ok: true, selected: ["S01", "S02"], required: ["S01", "S02"], passed: 2 });
    // the server was connected to and left as it was
    expect((await stateOf(url)).executionState.state).toBe("running");
  }, 30_000);

  it("names the scenarios of the gate of each milestone, and what a run selects and requires", () => {
    const upTo = (last: number) => Array.from({ length: last }, (_, index) => `S${String(index + 1).padStart(2, "0")}`);
    expect(scenariosOfMilestone("M1", "mock")).toEqual(upTo(14));
    expect(scenariosOfMilestone("M1", "emulator")).toEqual(["S00", ...upTo(15)]);
    expect(scenariosOfMilestone("M2", "emulator")).toEqual(["S00", ...upTo(16)]);
    expect(scenariosOfMilestone("M3", "mock")).toEqual([...upTo(14), "S16", "S17"]);
    // the gate of M3 is two runs: everything but S21 with the test program of M1, S00 and S21 with the DSP test program
    expect(scenariosOfMilestone("M3", "emulator")).toEqual(["S00", ...upTo(17)]);
    expect(scenariosOfMilestone("M3", "emulator", true)).toEqual(["S00", "S21"]);
    expect(scenariosOfMilestone("M3", "mock", true)).toEqual(["S21"]);
    expect(scenariosOfMilestone("M4", "emulator")).toEqual(SCENARIOS.map((scenario) => scenario.id).filter((id) => id !== "S21"));
    expect(scenariosOfMilestone("M4", "emulator", true)).toEqual(["S00", "S21"]);

    const all = SCENARIOS.map((scenario) => scenario.id);
    // looking at a server: everything is run, nothing has to pass
    expect(selectScenarios({ profile: "mock" })).toEqual({ selected: all, required: [] });
    expect(selectScenarios({ profile: "emulator", only: new Set(["S05", "S02"]) })).toEqual({ selected: ["S02", "S05"], required: [] });
    expect(selectScenarios({ profile: "emulator", dspProgram: true })).toEqual({ selected: ["S00", "S21"], required: [] });
    // a gate: its scenarios, each required
    const m1 = scenariosOfMilestone("M1", "emulator");
    expect(selectScenarios({ profile: "emulator", milestone: "M1" })).toEqual({ selected: m1, required: m1 });
    expect(selectScenarios({ profile: "emulator", milestone: "M3", dspProgram: true })).toEqual({ selected: ["S00", "S21"], required: ["S00", "S21"] });
    expect(selectScenarios({ profile: "mock", milestone: "M1", only: new Set(["S02", "S16"]) })).toEqual({ selected: ["S02"], required: ["S02"] });
    expect(selectScenarios({ profile: "mock", milestone: "M1", only: new Set(["S16", "S17", "S18"]) })).toEqual({ selected: [], required: [] });
    expect(selectScenarios({ profile: "mock", milestone: "M2", only: new Set(["S17"]) })).toEqual({ selected: [], required: [] });
    // --require: run and required, also outside the gate
    expect(selectScenarios({ profile: "mock", require: new Set(["S16"]), only: new Set(["S01", "S16"]) })).toEqual({ selected: ["S01", "S16"], required: ["S16"] });
    expect(selectScenarios({ profile: "mock", milestone: "M1", require: new Set(["S17"]) })).toEqual({
      selected: [...scenariosOfMilestone("M1", "mock"), "S17"],
      required: [...scenariosOfMilestone("M1", "mock"), "S17"],
    });
  });

  it("S17: a binary frame whose header does not belong to the result", async () => {
    const summary = await run(
      {
        // the binaryId of the header is changed
        toClientBinary: (frame) => {
          frame.writeUInt32LE(99, 8);
          return frame;
        },
      },
      ["S17"],
    );
    expect(statusOf(summary, "S17")).toBe("failed");
    expect(detailsOf(summary, "S17")).toMatch(/sgc capture: binaryId is 99 in the header and 1 in the result/);
  });

  it("S17: a binary frame that is sent before the response it belongs to", async () => {
    const summary = await run({ afterNextBinary: (frame) => typeof (frame.result as Json | undefined)?.frameCount === "number" }, ["S17"]);
    expect(statusOf(summary, "S17")).toBe("failed");
    expect(detailsOf(summary, "S17")).toMatch(
      /sgc capture: the binary frame of state\.getSgcFrameData arrived before its JSON response; the response is sent first, the binary frame second/,
    );
  });
});

describe("what a failing run leaves behind", () => {
  it("removes a breakpoint that no tick ever showed to it", async () => {
    // the server stores the breakpoint and sends no tick after breakpoints.add
    const { url, direct } = await startServer(() => noTickAfter((frame) => frame.method === "breakpoints.add"));
    const summary = await runContract({ url, profile: "mock", only: new Set(["S05"]) });
    expect(statusOf(summary, "S05")).toBe("failed");
    expect(detailsOf(summary, "S05")).toBe("breakpoints.add: no tick within 1000 ms of the request");

    expect(summary.cleanUpProblems).toEqual([]);
    expect(summary.finalState).toMatch(/running/);
    // (an enabled breakpoint in the mock's loop would have stopped it by now)
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = await stateOf(direct);
    expect(after.breakpoints).toEqual({});
    expect(after.executionState.state).toBe("running");
  }, 30_000);

  it("removes the breakpoint of an error probe that the server did not refuse", async () => {
    const { url, direct } = await startServer({
      // the odd address of S12 is accepted
      toServer: (frame) => {
        const params = frame.params as Json;
        return frame.method === "breakpoints.add" && params.address === 0x8c010001 ? { ...frame, params: { ...params, address: 0x8c010000 } } : frame;
      },
    });
    const summary = await runContract({ url, profile: "mock", only: new Set(["S12"]) });
    expect(statusOf(summary, "S12")).toBe("failed");
    expect(detailsOf(summary, "S12")).toMatch(/breakpoints\.add \{"event":"dc\.sh4\.cpu\.pc","address":2348875777\}: expected the error -32602, got the result \{\}/);
    expect(summary.cleanUpProblems).toEqual([]);
    expect((await stateOf(direct)).breakpoints).toEqual({});
  }, 30_000);

  it("says what it could not put back, and reports the state the server is really in", async () => {
    const { url, direct } = await startServer({
      // the server answers breakpoints.remove with {} and keeps the breakpoint
      toServer: (frame) => (frame.method === "breakpoints.remove" ? { ...frame, method: "state.unwatch", params: { watchIds: [0x7fffffff] } } : frame),
    });
    const summary = await runContract({ url, profile: "mock", only: new Set(["S05"]) });
    expect(statusOf(summary, "S05")).toBe("failed");
    expect(detailsOf(summary, "S05")).toMatch(/^breakpoints\.remove: breakpoint 1 is still listed \(1 tick within 1000 ms of the request/);
    expect(detailsOf(summary, "S05")).toMatch(/clean-up: breakpoint 1 \(dc\.sh4\.cpu\.pc at 0x8C0000A[0-9A-E]\) is left behind/);

    // the run found the server running; it is resumed, and stops at the breakpoints that are still there
    // (S05 adds its breakpoint twice, and the stop reports the lower id)
    expect(summary.cleanUpProblems).toEqual([
      expect.stringMatching(/^breakpoint 1 \(dc\.sh4\.cpu\.pc at 0x8C0000A[0-9A-E]\) is left behind$/),
      expect.stringMatching(/^breakpoint 2 \(dc\.sh4\.cpu\.pc at 0x8C0000A[0-9A-E]\) is left behind$/),
      "the target is paused, it was running",
    ]);
    expect(summary.finalState).toMatch(/paused stop \d+ breakpoint bp 1$/);
    expect(summary.ok).toBe(false);
    const after = await stateOf(direct);
    expect(Object.keys(after.breakpoints)).toEqual(["1", "2"]);
    expect(after.executionState).toMatchObject({ state: "paused", reason: "breakpoint", breakpointId: 1 });
  }, 30_000);

  it("says so when the ticks do not show what is left", async () => {
    // the server stores watches and its ticks have no watches
    const { url, direct } = await startServer({
      toClient: (frame) => {
        if (!isTick(frame)) return frame;
        const { watches: _watches, ...params } = frame.params;
        return { ...frame, params };
      },
    });
    const summary = await runContract({ url, profile: "mock", only: new Set(["S08"]) });
    expect(statusOf(summary, "S08")).toBe("failed");
    expect(detailsOf(summary, "S08")).toMatch(/^state\.watch: no tick lists a new watch /);
    expect(summary.cleanUpProblems).toEqual(["the tick lists no watches: what is left of them is not known"]);
    expect((await stateOf(direct)).watches).toHaveLength(1);
  }, 30_000);
});

describe("the emulator profile", () => {
  /**
   * The mock behind an HTTP server that follows the rules of the emulator's own (GET only,
   * the Host check, the Origin check on the upgrade), with one rule optionally left out.
   */
  const startEmulatorLike = async (
    flaws: { acceptNullOrigin?: boolean; indexForMissingAssets?: boolean } = {},
    mock: MockDebuggerOptions | MockDebugger = { startPaused: true },
  ): Promise<string> => {
    const { url: mockUrl } = await startServer(undefined, mock);
    const allowedHost = (host: string | undefined) => ["127.0.0.1", "localhost", "[::1]"].includes((host ?? "").replace(/:\d+$/, "").toLowerCase());
    const server = createServer((request, response) => {
      const send = (status: number, type: string, body: string) =>
        response.writeHead(status, { "Content-Type": type, "X-Content-Type-Options": "nosniff" }).end(body);
      if (!allowedHost(request.headers.host)) {
        return send(403, "text/plain", "forbidden");
      }
      if (request.method !== "GET") {
        return send(405, "text/plain", "method not allowed");
      }
      const path = (request.url ?? "/").split("?")[0];
      if (path !== "/" && /\.[a-z0-9]+$/i.test(path) && !flaws.indexForMissingAssets) {
        return send(404, "text/plain", "not found");
      }
      return send(200, "text/html", "<!doctype html><title>nullDC 3.0.0</title>");
    });
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      const origin = request.headers.origin;
      let originAllowed = origin === undefined;
      if (origin === "null") {
        originAllowed = flaws.acceptNullOrigin === true;
      } else if (origin !== undefined) {
        try {
          const parsed = new URL(origin);
          originAllowed = /^https?:$/.test(parsed.protocol) && allowedHost(parsed.host);
        } catch {
          originAllowed = false;
        }
      }
      if (!allowedHost(request.headers.host) || !originAllowed) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(request, socket, head, (client) => {
        const upstream = new WebSocket(mockUrl);
        const early: string[] = [];
        client.on("message", (data) => (upstream.readyState === WebSocket.OPEN ? upstream.send(data.toString()) : early.push(data.toString())));
        upstream.on("open", () => early.splice(0).forEach((text) => upstream.send(text)));
        upstream.on("message", (data, isBinary) => client.send(isBinary ? data : data.toString(), { binary: isBinary }));
        client.on("close", () => upstream.close());
        upstream.on("close", () => client.close());
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    closers.unshift(
      () =>
        new Promise<void>((resolve) => {
          wss.clients.forEach((client) => client.terminate());
          server.close(() => resolve());
        }),
    );
    return `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws`;
  };

  it("S15: checks the HTTP side, the Host check and the Origin check", async () => {
    const url = await startEmulatorLike();
    const summary = await runContract({ url, profile: "emulator", timeoutFactor: 1, only: new Set(["S15", "S02"]) });
    expect(summary.scenarios.map((scenario) => `${scenario.id} ${scenario.status} ${scenario.details.join(" | ")}`)).toEqual(["S02 passed ", "S15 passed "]);
    expect(summary.profile).toBe("emulator");
    // the emulator was found at its StartPaused stop and is left paused
    expect(summary.finalState).toMatch(/paused/);
  });

  it("S15: a server that accepts Origin: null, or serves index.html for a missing asset, fails", async () => {
    const lenientOrigin = await runContract({ url: await startEmulatorLike({ acceptNullOrigin: true }), profile: "emulator", timeoutFactor: 1, only: new Set(["S15"]) });
    expect(statusOf(lenientOrigin, "S15")).toBe("failed");
    expect(detailsOf(lenientOrigin, "S15")).toBe("an upgrade with Origin: null is refused with 403");

    const noNotFound = await runContract({ url: await startEmulatorLike({ indexForMissingAssets: true }), profile: "emulator", timeoutFactor: 1, only: new Set(["S15"]) });
    expect(statusOf(noNotFound, "S15")).toBe("failed");
    expect(detailsOf(noNotFound, "S15")).toBe("a missing asset is 200, expected 404");
  });

  it("S04: a step that executes two instructions fails, wherever the target happens to be paused", async () => {
    /** The mock parked at its StartPaused stop with the SH4 at `pc`; with `skip` its step executes two instructions. */
    const parkedAt = (pc: number, skip: boolean): MockDebugger => {
      const mock = new MockDebugger({ startPaused: true });
      if (skip) {
        const machine = mock as unknown as { advance(target: string): { wrapped: boolean }; running: boolean };
        const advance = machine.advance.bind(mock);
        machine.advance = (target) => {
          const result = advance(target);
          // (a paused machine advances only in a step)
          return target === "sh4" && !machine.running ? advance(target) : result;
        };
      }
      ask(mock, "state.setRegister", { path: "dc.sh4.cpu", name: "PC", value: String(pc) });
      return mock;
    };
    const stepFrom = async (pc: number, skip: boolean) => {
      const listener = await listenMockDebugger(parkedAt(pc, skip));
      try {
        return await runContract({ url: listener.url, profile: "emulator", timeoutFactor: 1, only: new Set(["S04"]) });
      } finally {
        await listener.close();
      }
    };

    // The eight addresses of the mock's loop, whose last line is its branch, and 24 outside of
    // it, where the mock disassembles branches of every kind and walks straight on. (All at
    // once: outside of its loop the mock never returns, and the runner waits 5 s for that.)
    const starts = [
      ...Array.from({ length: MOCK_SH4_RING.length }, (_, index) => MOCK_SH4_RING.base + index * 2),
      ...Array.from({ length: 24 }, (_, index) => 0x8c00ffc0 + index * 2),
    ];
    const kinds = { plain: 0, controlFlow: 0, afterDelayedBranch: 0 };
    await Promise.all(
      starts.map(async (pc) => {
        const lines = ask(parkedAt(pc, false), "state.getDisassembly", { target: "sh4", address: pc - 2, count: 2 }).result as { lines: Array<{ disassembly: string }> };
        const [previous, line] = lines.lines;
        kinds[isSh4ControlFlow(line.disassembly) ? "controlFlow" : isSh4DelayedBranch(previous.disassembly) ? "afterDelayedBranch" : "plain"]++;

        // the server that follows the protocol passes from here ...
        expect(reportOf(await stepFrom(pc, false)), `from 0x${pc.toString(16)}`).toEqual(["S04 passed "]);
        // ... and the one whose step skips an instruction does not
        const skipping = await stepFrom(pc, true);
        expect(statusOf(skipping, "S04"), `from 0x${pc.toString(16)}`).toBe("failed");
        expect(detailsOf(skipping, "S04")).toMatch(
          /^".+" at 0x8C0[0-9A-F]{5} is not control flow, and the step ended at 0x8C0[0-9A-F]{5}, not at 0x8C0[0-9A-F]{5} or an exception vector$/,
        );
        expect(skipping.ok).toBe(false);
      }),
    );
    // the PC of the first step cannot be checked on a control-flow line or in the slot of a delayed branch: the runner steps on from there
    expect(kinds.plain).toBeGreaterThan(0);
    expect(kinds.controlFlow).toBeGreaterThan(0);
    expect(kinds.afterDelayedBranch).toBeGreaterThan(0);
  }, 120_000);

  it("S00: reports a server that is not at its StartPaused stop, and one whose program does not reach the entry point", async () => {
    // a running mock is not an emulator at its start stop
    const { url: running } = await startServer();
    const notStarted = await runContract({ url: running, profile: "emulator", timeoutFactor: 0.02, only: new Set(["S00"]) });
    expect(statusOf(notStarted, "S00")).toBe("failed");
    expect(detailsOf(notStarted, "S00")).toMatch(/the emulator has to be at the StartPaused stop .*; it is #\d+ running stop 0/);

    // the mock's loop never reaches 0x8C010000: the anchor breakpoint is not hit, and it is removed again
    const { url: paused } = await startServer(undefined, { startPaused: true });
    const noAnchor = await runContract({ url: paused, profile: "emulator", timeoutFactor: 0.05, only: new Set(["S00"]) });
    expect(statusOf(noAnchor, "S00")).toBe("failed");
    expect(detailsOf(noAnchor, "S00")).toMatch(/a paused tick at the ELF entry 0x8C010000: not seen within 500 ms/);
    expect(noAnchor.cleanUpProblems).toEqual([]);
    expect(noAnchor.finalState).toMatch(/paused/);
  });

  it("S00: the sh4-debug capability is read at the anchor stop, where an SH4 backend is selected", async () => {
    /**
     * The mock at its StartPaused stop, 32 bytes before the entry point; `capabilities` rewrites
     * what debugger.describe lists, and is told whether the SH4 has run yet.
     */
    const anchor = async (capabilities: (listed: string[], hasRun: boolean) => string[]) => {
      const mock = new MockDebugger({ startPaused: true });
      ask(mock, "state.setRegister", { path: "dc.sh4.cpu", name: "PC", value: "0x8C00FFE0" });
      const lines: string[] = [];
      const { url } = await startServer(() => {
        let hasRun = false;
        return {
          toClient: (frame) => {
            if (isTick(frame)) {
              hasRun ||= frame.params.executionState.state === "running";
              return frame;
            }
            const result = frame.result as Json | undefined;
            return result?.deviceTree ? { ...frame, result: { ...result, capabilities: capabilities(result.capabilities as string[], hasRun) } } : frame;
          },
        };
      }, mock);
      const summary = await runContract({ url, profile: "emulator", timeoutFactor: 1, only: new Set(["S00"]), say: (line) => lines.push(line) });
      return { summary, lines };
    };
    const withoutEngine = (listed: string[]) => listed.filter((capability) => !capability.startsWith("sh4-debug-"));

    // a server that selects its backend with the first Run(): neither capability at the StartPaused stop
    const { summary: late, lines } = await anchor((listed, hasRun) => (hasRun ? listed : withoutEngine(listed)));
    expect(lines.find((line) => line.startsWith("server: "))).toMatch(/capabilities: event-breakpoints, callstack, register-write, sgc-capture; targets: /);
    expect(reportOf(late)).toEqual(["S00 passed SH4 debug engine: native"]);
    expect(late.ok).toBe(true);
    // (the summary names what the server said last)
    expect(late.server.capabilities).toContain("sh4-debug-native");

    // at the anchor stop the capability has to be there, and it has to be the one of the engine
    const { summary: never } = await anchor(withoutEngine);
    expect(reportOf(never)).toEqual(['S00 failed SH4_DEBUG_ENGINE is native, and debugger.describe at this stop does not list the capability "sh4-debug-native"']);
    const { summary: both } = await anchor((listed) => [...listed, "sh4-debug-fallback"]);
    expect(reportOf(both)).toEqual(['S00 failed SH4_DEBUG_ENGINE is native, and debugger.describe at this stop lists the capability "sh4-debug-fallback"']);
    expect(both.cleanUpProblems).toEqual([]);
  }, 30_000);

  it("S00: a runner that connected before the game had started asks debugger.describe again at the start stop", async () => {
    // the mock's SH4 walks straight on outside of its loop: from here it reaches the entry point 0x8C010000
    const mock = new MockDebugger({ startPaused: true });
    const url = await startEmulatorLike({}, mock);
    await request(url, [["state.setRegister", { path: "dc.sh4.cpu", name: "PC", value: "0x8C00FFE0" }]]);
    // no game yet: the static tree, and neither sh4-debug capability
    mock.setLifetime("no-machine");
    const lines: string[] = [];
    const running = runContract({ url, profile: "emulator", timeoutFactor: 1, only: new Set(["S00"]), say: (line) => lines.push(line) });
    await new Promise((resolve) => setTimeout(resolve, 400));
    mock.setLifetime("running");

    const summary = await running;
    expect(lines.filter((line) => /^server: |^waiting /.test(line)).map((line) => line.replace(/; targets: .*/, ""))).toEqual([
      "server: nullDC (mock) 3.0.0 (native), protocol 3, ui none; capabilities: event-breakpoints, callstack, register-write, sgc-capture",
      expect.stringMatching(/^waiting for the StartPaused stop \(the server is #\d+ paused stop 2 no-game\)$/),
      "server: nullDC (mock) 3.0.0 (native), protocol 3, ui none; capabilities: event-breakpoints, callstack, register-write, sgc-capture, sh4-debug-native",
    ]);
    expect(reportOf(summary)).toEqual(["S00 passed SH4 debug engine: native"]);
    expect(summary.server.capabilities).toContain("sh4-debug-native");
    expect(summary.ok).toBe(true);
    expect(summary.finalState).toMatch(/paused/);
  }, 30_000);
});

describe("the command line", () => {
  /** `npm run contract -- <args>` as a child process: its exit code and what it printed. */
  const cli = (args: string[]): Promise<{ code: number | null; output: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "--tsconfig", "tsconfig.scripts.json", "scripts/contract-test.ts", ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const chunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, output: Buffer.concat(chunks).toString("utf8") }));
    });

  it("exits with 0 for a gate that passed, 1 for a result that is not a pass, 2 when there was no run", async () => {
    const { url } = await startServer(undefined, { supports: MOCK_M1_SUPPORT });
    const target = ["--url", url, "--profile", "mock"];

    // a piece of the gate of M1
    const passed = await cli([...target, "--milestone", "M1", "--only", "S01,S02"]);
    expect(passed.output).toMatch(/^2 passed, 0 failed, 0 partial, 0 not applicable; .*\ncontract: OK\n$/m);
    expect(passed.code).toBe(0);

    // nothing of what was asked for is in the gate, or applies to the server: no success
    for (const args of [
      ["--only", "S16,S17,S18"],
      ["--milestone", "M1", "--only", "S16,S17,S18"],
      ["--milestone", "M2", "--only", "S17"],
    ]) {
      const nothing = await cli([...target, ...args]);
      expect(nothing.output, args.join(" ")).toMatch(/^nothing verified: .*\n0 passed, 0 failed, .*\ncontract: FAILED\n$/m);
      expect(nothing.code, args.join(" ")).toBe(1);
    }
    // a gate whose scenario is not applicable
    const gate = await cli([...target, "--milestone", "M2", "--only", "S02,S16"]);
    expect(gate.output).toMatch(/^required: S16 is not applicable; it has to pass$/m);
    expect(gate.code).toBe(1);

    // a wrong option, and a server that is not there
    for (const args of [["--milestone", "M5"], ["--only", "S99"], ["--require", "S16", "--only", "S01"], ["--milestone", "M2", "--dsp-program"], ["--no-such-option"]]) {
      const wrong = await cli([...target, ...args]);
      expect(wrong.code, args.join(" ")).toBe(2);
      expect(wrong.output, args.join(" ")).toMatch(/^contract: /m);
    }
    const gone = await listenMockDebugger(new MockDebugger());
    await gone.close();
    expect((await cli(["--url", gone.url, "--profile", "mock", "--only", "S01"])).code).toBe(2);
  }, 120_000);

  it("--list names every scenario with its milestone", async () => {
    const listed = await cli(["--list"]);
    expect(listed.code).toBe(0);
    expect(listed.output.trim().split("\n")).toHaveLength(SCENARIOS.length);
    expect(listed.output).toMatch(/^S00 anchor \(M1, emulator profile\)$/m);
    expect(listed.output).toMatch(/^S21 M3: DSP \(M3, --dsp-program\)$/m);
  }, 30_000);
});
