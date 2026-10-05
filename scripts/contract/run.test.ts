import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { MockDebugger } from "../../server/mockDebugger";
import type { MockDebuggerOptions } from "../../server/mockDebugger";
import { listenMockDebugger } from "../../server/mockWebSocket";
import { runContract } from "./run";
import type { ContractSummary } from "./run";

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
}

/** One set of faults for every connection, or a function that makes one per connection (faults that keep state). */
type FaultSource = Faults | (() => Faults);

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) {
    await close();
  }
});

/** The mock on a WebSocket, optionally behind a proxy that applies `faults`. Returns the URL to test. */
const startServer = async (source?: FaultSource, options?: MockDebuggerOptions): Promise<{ url: string; mock: MockDebugger }> => {
  const mock = new MockDebugger(options);
  const listener = await listenMockDebugger(mock);
  closers.push(() => listener.close());
  if (!source) {
    return { url: listener.url, mock };
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
    client.on("message", (data) => {
      let text = data.toString();
      try {
        const request = JSON.parse(text) as Json;
        faults.beforeRequest?.(request).forEach((frame) => client.send(JSON.stringify(frame)));
        if (faults.toServer) {
          text = JSON.stringify(faults.toServer(request));
        }
      } catch {
        // not JSON: the runner's malformed frame goes through as it is
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
        client.send(data, { binary: true });
        return;
      }
      const frame = JSON.parse(data.toString()) as Json;
      const rewritten = faults.toClient ? faults.toClient(frame) : frame;
      for (const out of rewritten === undefined ? [] : Array.isArray(rewritten) ? rewritten : [rewritten]) {
        client.send(JSON.stringify(out));
      }
    });
    client.on("close", () => upstream.close());
    upstream.on("close", () => client.close());
    upstream.on("error", () => client.close());
  });
  return { url: `ws://127.0.0.1:${(proxy.address() as AddressInfo).port}/ws`, mock };
};

const run = async (faults: FaultSource | undefined, only?: string[], options?: MockDebuggerOptions): Promise<ContractSummary> => {
  const { url } = await startServer(faults, options);
  return runContract({ url, profile: "mock", only: only ? new Set(only) : undefined });
};

const isTick = (frame: Json): frame is Json & { params: Json & { executionState: Json; registers: Record<string, Json[]> } } =>
  frame.method === "event.tick";

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
    const probe = new WebSocket(url);
    const tick = await new Promise<Json>((resolve) => {
      probe.on("open", () => probe.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "debugger.describe", params: {} })));
      probe.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Json;
        if (isTick(frame)) {
          resolve(frame.params);
        }
      });
    });
    probe.close();
    expect(tick.breakpoints).toEqual({});
    expect(tick.watches).toEqual([]);
    const unmuted = { muted: false, soloed: false };
    expect(tick.categories).toEqual({ events: unmuted, sh4: unmuted, arm7: unmuted, dsp: unmuted });
    expect((tick.executionState as Json).state).toBe("running");
    expect(mock.clientCount).toBeLessThanOrEqual(1);
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
    expect(detailsOf(echoOnly, "S06")).toMatch(/breakpoints\.setCategoryStates: the tick echoes sh4 as \{"muted":false,"soloed":false\}, expected \{"muted":true,"soloed":false\}/);
    // (a request without effect is waited for, for a second)
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
    const { url } = await startServer();
    // a proxy for binary frames only: the binaryId of the header is changed
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
      const upstream = new WebSocket(url);
      const early: string[] = [];
      client.on("message", (data) => (upstream.readyState === WebSocket.OPEN ? upstream.send(data.toString()) : early.push(data.toString())));
      upstream.on("open", () => early.splice(0).forEach((text) => upstream.send(text)));
      upstream.on("message", (data, isBinary) => {
        if (isBinary) {
          const frame = Buffer.from(data as Buffer);
          frame.writeUInt32LE(99, 8);
          client.send(frame, { binary: true });
        } else {
          client.send(data.toString());
        }
      });
      client.on("close", () => upstream.close());
      upstream.on("close", () => client.close());
    });
    const summary = await runContract({ url: `ws://127.0.0.1:${(proxy.address() as AddressInfo).port}/ws`, profile: "mock", only: new Set(["S17"]) });
    expect(statusOf(summary, "S17")).toBe("failed");
    expect(detailsOf(summary, "S17")).toMatch(/sgc capture: binaryId is 99 in the header and 1 in the result/);
  });
});

describe("the emulator profile", () => {
  /**
   * The mock behind an HTTP server that follows the rules of the emulator's own (GET only,
   * the Host check, the Origin check on the upgrade), with one rule optionally left out.
   */
  const startEmulatorLike = async (flaws: { acceptNullOrigin?: boolean; indexForMissingAssets?: boolean } = {}): Promise<string> => {
    const { url: mockUrl } = await startServer(undefined, { startPaused: true });
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
});
