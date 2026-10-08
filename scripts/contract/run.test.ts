import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { MOCK_M1_SUPPORT, MOCK_SH4_RING, MockDebugger } from "../../server/mockDebugger";
import type { MockClient, MockConnection, MockDebuggerOptions } from "../../server/mockDebugger";
import { listenMockDebugger } from "../../server/mockWebSocket";
import { isSh4ControlFlow, isSh4DelayedBranch } from "./disasm";
import { runContract } from "./run";
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
    expect(summary).toMatchObject({ passed: 15, failed: 0, partial: 1, notApplicable: 3, profile: "mock", timeoutFactor: 1 });
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
  }, 60_000);

  it("passes the mock that implements only milestone M1: S16 and S17 are not applicable to it", async () => {
    const summary = await run(undefined, undefined, { supports: MOCK_M1_SUPPORT });
    expect(summary.invariantViolations).toEqual([]);
    expect(summary.cleanUpProblems).toEqual([]);
    expect(statusesOf(summary)).toEqual({ ...MOCK_STATUSES, S16: "not-applicable", S17: "not-applicable" });
    expect(summary.ok).toBe(true);
    expect(summary.server.capabilities).toEqual(["event-breakpoints", "callstack", "sh4-debug-native"]);
  }, 60_000);

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

    // S13 alone, i.e. on a running server: there the tick in front of the answer is a periodic one
    const running = await run(staleTickBeforeEveryAnswer, ["S13"]);
    expect(reportOf(running)).toEqual(["S13 passed "]);
    expect(running.ok).toBe(true);
  }, 60_000);

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
  }, 30_000);
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

  it("I5: a paused tick that is not full, a running tick without a hard-wired path, a stopId that goes back", async () => {
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
    expect(violations).toMatch(/I5: stopId 0 follows stopId 1/);
  });

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

  it("S01: targets that do not have the values of the table of 3.1, and a tree without nodes of milestone M1", async () => {
    const describing = (rewrite: (result: Json & { targets: Array<Json & { id: string }>; deviceTree: Json[] }) => Json): Faults => ({
      toClient: (frame) => {
        const result = frame.result as (Json & { targets: Array<Json & { id: string }>; deviceTree: Json[] }) | undefined;
        return result?.deviceTree ? { ...frame, result: rewrite(result) } : frame;
      },
    });
    const constants = await run(
      describing((result) => ({
        ...result,
        targets: result.targets.map((target) =>
          target.id === "dsp"
            ? { ...target, addressRadix: 16, addressDigits: 2, label: "" }
            : target.id === "arm7"
              ? { ...target, addressDigits: 6, defaultDisassemblyAddress: 0x00200000, defaultMemoryAddress: 0x00200000 }
              : { ...target, addressMax: 0x1fffffff, breakpointEvent: "dc.sh4.pc" },
        ),
      })),
      ["S01"],
    );
    expect(constants.scenarios[0].details).toEqual([
      "target sh4: breakpointEvent is \"dc.sh4.pc\", the table of 3.1 says \"dc.sh4.cpu.pc\"",
      "target sh4: addressMax is 0x1FFFFFFF, the table of 3.1 says 0xFFFFFFFF",
      "target arm7: addressDigits is 6, the table of 3.1 says 8",
      "target arm7: defaultDisassemblyAddress is 0x00200000, the table of 3.1 says 0",
      "target arm7: defaultMemoryAddress is 0x00200000, the table of 3.1 says 0",
      "target dsp: addressRadix is 16, the table of 3.1 says 10",
      "target dsp: addressDigits is 2, the table of 3.1 says 3",
    ]);

    // without the timer unit and the interrupt controller of Holly, and with a core node that opens no panel
    const prune = (nodes: Json[]): Json[] =>
      nodes
        .filter((node) => node.path !== "dc.sh4.tmu" && node.path !== "dc.holly.intc")
        .map((node) => {
          const { actions, children, ...rest } = node as Json & { actions?: string[]; children?: Json[] };
          return { ...rest, ...(actions && node.path !== "dc.holly.core" ? { actions } : {}), ...(children ? { children: prune(children) } : {}) };
        });
    const pruned = describing((result) => ({ ...result, deviceTree: prune(result.deviceTree) }));
    const nodes = await run(
      {
        ...pruned,
        toClient: (frame) => {
          if (!isTick(frame)) return pruned.toClient!(frame);
          const { "dc.sh4.tmu": _tmu, "dc.holly.intc": _intc, ...registers } = frame.params.registers;
          return { ...frame, params: { ...frame.params, registers } };
        },
      },
      ["S01"],
    );
    expect(nodes.scenarios[0].details).toEqual([
      "the device tree has no node dc.sh4.tmu, which the table of 2.8 lists for milestone M1",
      "the device tree has no node dc.holly.intc, which the table of 2.8 lists for milestone M1",
      'dc.holly.core: the action "holly-core" of the table of 2.8 is missing',
    ]);
    expect(nodes.invariantViolations).toEqual([]);
  });

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

  it("S02: control.pause that is refused when it names a target, as the UI's request does", async () => {
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

    // the target is ignored: a pause is not a request to one target
    const others = await run(refusing(["arm7", "dsp"]), ["S02"]);
    expect(statusOf(others, "S02")).toBe("failed");
    expect(detailsOf(others, "S02")).toMatch(/^control\.pause \{"target":"arm7"\}: in-band error -32004/);
  });

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
  }, 30_000);

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
  });

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
    expect(frozen.invariantViolations.join("\n")).toMatch(/2\.8: watch 1 \(dc\.timing\.sh4_cycles\) reads "0x[0-9A-F]{16}", the register in the same tick reads "0x[0-9A-F]{16}" \(tick \d+\)/);
    expect(frozen.invariantViolations.join("\n")).toMatch(/2\.8: watch 2 \(dc\.sh4\.cpu\.pc\) reads "0x8C0000[0-9A-F]{2}", the register in the same tick reads/);
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
    expect(detailsOf(stale, "S03")).toMatch(/invariant: 2\.2\.8: watch 2 \(dc\.sh4\.cpu\.pc\) reads "0x8C0000A0" in a tick that says registersStale, expected "n\/a"/);
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
    expect(reusedBreakpointIds.invariantViolations).toEqual([]);

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
    expect(reusedWatchIds.invariantViolations).toEqual([]);
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
  }, 30_000);

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

  it("S12: an error with a data member, an error on the wrong channel, a wrong message", async () => {
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

    const wrongMessage = await run(
      {
        toClient: (frame) => ((frame.error as Json | undefined)?.code === -32601 ? { ...frame, error: { code: -32601, message: "Unhandled JSON-RPC method" } } : frame),
      },
      ["S12"],
    );
    expect(statusOf(wrongMessage, "S12")).toBe("failed");
    expect(detailsOf(wrongMessage, "S12")).toMatch(/the message of -32601 is .*got "Unhandled JSON-RPC method"/);
  });

  it("S12: a batch that is executed, and frames that are no request and get no answer", async () => {
    const batch = await run(
      { answer: (request) => (Array.isArray(request) ? ([{ jsonrpc: "2.0", id: 1, result: {} }] as unknown as Json) : undefined) },
      ["S12"],
    );
    expect(statusOf(batch, "S12")).toBe("failed");
    expect(detailsOf(batch, "S12")).toBe(
      'a batch (a JSON array of requests) is answered with [{"jsonrpc":"2.0","id":1,"result":{}}], expected the JSON-RPC error -32600 "invalid request"',
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
      'a request whose id is a string is answered with {"jsonrpc":"2.0","id":"1","result":{}}, expected the JSON-RPC error -32600 "invalid request"',
    );
  }, 30_000);

  it("reports a scenario whose capability the server does not advertise as not applicable, never as passed", async () => {
    const summary = await run(
      {
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
      },
      ["S16", "S17", "S18"],
    );
    expect(summary.scenarios.map((scenario) => scenario.status)).toEqual(["not-applicable", "not-applicable", "not-applicable"]);
    expect(summary).toMatchObject({ passed: 0, failed: 0, partial: 0, notApplicable: 3 });
    expect(detailsOf(summary, "S17")).toBe('no capability "sgc-capture"; targets: dsp.stepping is false');
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

    // the run found the server running; it is resumed, and stops at the breakpoint that is still there
    expect(summary.cleanUpProblems).toEqual([
      expect.stringMatching(/^breakpoint 1 \(dc\.sh4\.cpu\.pc at 0x8C0000A[0-9A-E]\) is left behind$/),
      "the target is paused, it was running",
    ]);
    expect(summary.finalState).toMatch(/paused stop \d+ breakpoint bp 1$/);
    expect(summary.ok).toBe(false);
    const after = await stateOf(direct);
    expect(Object.keys(after.breakpoints)).toEqual(["1"]);
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
