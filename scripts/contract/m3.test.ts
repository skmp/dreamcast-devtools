import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { BinaryFrameKind, encodeBinaryFrame } from "../../src/lib/binaryFrame";
import { MOCK_AICA_PERIOD_CYCLES, MOCK_DSP_PROGRAM, MOCK_DSP_WORDS, MOCK_M2_SUPPORT, MOCK_M3_SUPPORT, MockDebugger } from "../../server/mockDebugger";
import type { MockDebuggerOptions } from "../../server/mockDebugger";
import { generateMockSgcCapture } from "../../server/mockSgc";
import { M3_DSP_REGISTERS } from "./design";
import { dspLineText, dspProgramOfElf } from "./dspText";
import type { ElfSymbols } from "./elfSymbols";
import { runContract } from "./run";
import type { ContractOptions, ContractSummary } from "./run";
import { M3_NOTES, SCENARIOS, scenariosOfMilestone, selectScenarios } from "./scenarios";
import { closeServers, describing, inBand, isTick, mapNodes, paramsOf, reportOf, rpcError, startServer } from "./testSupport";
import type { FaultSource, Faults, Json } from "./testSupport";

/**
 * The rules milestone M3 added to the runner (the cut of the M3 round, 3.1 item 3, package
 * F4a's item 5). Each has a server that breaks it, which the runner has to fail with the line
 * that says so, and where the rule leaves a server a choice, a server that takes the other one
 * and has to pass. A broken server is the mock with one method patched, or the mock behind a
 * proxy. The broken servers 1 to 11 of the reader report of the M3 cut (devtools.md 4.3) are
 * each one of these, named so in the title of the test.
 */

afterEach(closeServers);

/** What the tests reach into of the mock's machine. */
interface Machine {
  running: boolean;
  cycles: bigint;
  nextBurst: bigint;
  stopBreakpointId: number | undefined;
  arm7HeldFor: number | undefined;
  suspended: { sample: number; step: number; exempt: boolean } | undefined;
  recording: { client: unknown; id: number; frames: number; endAt: bigint; stopAtEnd: boolean; deadline: ReturnType<typeof setTimeout> } | undefined;
  capture: { frameCount: number; data: Uint8Array } | undefined;
  nextBreakpointId: number;
  values: Map<string, Map<string, unknown>>;
  breakpoints: Map<number, Json & { id: number; event: string; enabled: boolean; address?: number }>;
  categories: Map<string, { muted: boolean; soloed: boolean }>;
  clients: Map<number, { id: number; connection: { sendBinary(frame: Uint8Array): void } }>;
  setCycles(cycles: bigint): void;
  setRegisterValue(path: string, name: string, value: unknown): void;
  enterStop(reason: string, breakpointId?: number, fallbackStep?: boolean): void;
  leaveStop(): void;
  isActive(breakpoint: { id: number; event: string; enabled: boolean }): boolean;
  activeDspBreakpoints(): Map<number, number>;
  runBurst(sample: number, step: number, exempt: boolean, last?: number): boolean;
  finishBurst(): void;
  completeSample(): void;
  stepDsp(): void;
  refreshDsp(): void;
  completeCapture(stop?: boolean): boolean;
  cancelCapture(code: number, message: string): void;
  recordSgcFrames(params: Json, context: RequestContext): void;
  getMemoryBinary(params: Json, context: RequestContext): Json;
  memoryTarget(params: Json): "sh4" | "arm7";
  readMemory(target: "sh4" | "arm7", address: number, length: number): { data: Uint8Array; unreadable: Array<[number, number]> };
  addBreakpoint(params: Json, context: RequestContext): unknown;
}
interface RequestContext {
  client: { id: number; binaryId: number; connection: { sendBinary(frame: Uint8Array): void } };
  id: number;
  afterResponse: Array<() => void>;
  deferred: boolean;
}

const PERIOD = MOCK_AICA_PERIOD_CYCLES;
/** The mock as the runner starts it for the run with the DSP test program: at its stop of the start, its ARM7 held (M3-D31). */
const ANCHORED: MockDebuggerOptions = { arm7Held: true, startPaused: true };

/** The mock with its machine patched: a server that does one thing wrong, or one thing its own way. */
const patched = (patch: (machine: Machine, mock: MockDebugger) => void, options: MockDebuggerOptions = {}): MockDebugger => {
  const mock = new MockDebugger(options);
  patch(mock as unknown as Machine, mock);
  return mock;
};

/** A run against a server (the mock, patched or not, behind faults or not). */
const run = async (server: MockDebugger | MockDebuggerOptions | undefined, faults: FaultSource | undefined, options: Partial<ContractOptions>): Promise<ContractSummary> => {
  const { url } = await startServer(faults, server);
  return runContract({ url, profile: "mock", ...options });
};
/** S17 alone, or one part of it. */
const s17 = (server?: MockDebugger | MockDebuggerOptions, faults?: FaultSource, more: Partial<ContractOptions> = {}, part?: "sgcCapture" | "memoryBinary") =>
  run(server, faults, { only: new Set(["S17"]), ...(part ? { parts: new Map([["S17", new Set([part])]]) } : {}), ...more });
/** S21 alone, in the run with the DSP test program. */
const s21 = (server?: MockDebugger | MockDebuggerOptions, faults?: FaultSource, more: Partial<ContractOptions> = {}) =>
  run(server, faults, { only: new Set(["S21"]), dspProgram: true, ...more });

const detailOf = (summary: ContractSummary, id: string) => summary.scenarios.find((scenario) => scenario.id === id)?.details.join("\n") ?? "";
/** The first line a scenario reported: why it failed (its notes come behind). */
const firstOf = (summary: ContractSummary, id: string) => summary.scenarios.find((scenario) => scenario.id === id)?.details[0] ?? "";
const statusOf = (summary: ContractSummary, id: string) => summary.scenarios.find((scenario) => scenario.id === id)?.status;
const partOf = (summary: ContractSummary, name: string) => summary.scenarios[0].parts?.find((part) => part.name === name);

/** A proxy that keeps what ENABLED of dc.aica.arm7 read in the latest tick. */
const watchingEnabled = () => {
  const state = { held: false, running: false };
  const toClient = (frame: Json): Json => {
    if (isTick(frame)) {
      state.running = frame.params.executionState.state === "running";
      const enabled = frame.params.registers["dc.aica.arm7"]?.find((register) => register.name === "ENABLED")?.value;
      state.held = enabled === "0x0";
    }
    return frame;
  };
  return { state, toClient };
};

/** Faults that answer requests for which `matches` is true with -32012 while the ARM7 is held (round 2's rule, which the owner's answer to M3-Q1 retired). */
const refusedWhileHeld = (matches: (request: Json) => boolean): FaultSource => () => {
  const watch = watchingEnabled();
  return {
    toClient: watch.toClient,
    answer: (request) => (matches(request) && watch.state.held ? inBand(request, -32012, "aica not clocked (arm7 in reset)") : undefined),
  };
};

/**
 * The ELF of a guest whose DSP program is the mock's: the block of 2.4 between g_dsp_mpro and
 * g_dsp_mpro_end (a 32-bit little-endian word for each 16-bit word of MPRO, the word in the
 * low half, four for each step from step 0), for its loaded steps; `change` alters one word.
 */
const guestElf = (change?: { word: number; value: number }): ElfSymbols => {
  const start = 0x8c010400;
  const words = Array.from(MOCK_DSP_WORDS.subarray(0, MOCK_DSP_PROGRAM.length * 4));
  if (change) {
    words[change.word] = change.value;
  }
  const data = new Uint8Array(words.length * 4);
  const view = new DataView(data.buffer);
  words.forEach((word, index) => view.setUint32(index * 4, word, true));
  return {
    entry: 0x8c010000,
    symbols: new Map([
      ["_start", 0x8c010000],
      ["g_dsp_mpro", start],
      ["g_dsp_mpro_end", start + data.length],
    ]),
    segments: [{ address: start, data }],
  };
};

/**
 * The server that behaves as the emulator does on the sounding guest: its ARM7 held at the
 * anchor, its DSP clocked there, and the guest's DSP program loaded behind the anchor, by the
 * guest's _start (6.1): until the target has been resumed once every step of the DSP is
 * empty, in its disassembly. (A step of the DSP from the anchor runs the SH4 to the first
 * sound burst, in front of which the guest has not written its program yet.)
 */
const emulatorOnTheGuest = (): Faults => {
  let resumed = false;
  return {
    toServer: (frame) => {
      if (frame.method === "control.runUntil") {
        resumed = true;
      }
      return frame;
    },
    toClient: (frame) => {
      const lines = (frame.result as { lines?: Array<Json & { address: number; bytes: string }> } | undefined)?.lines;
      if (resumed || !lines || !lines.every((line) => /^[0-9A-F]{2}( [0-9A-F]{2}){7}$/.test(line.bytes)) || lines.length === 0) {
        return frame;
      }
      return {
        ...frame,
        result: { lines: lines.map((line) => ({ address: line.address, bytes: "00 00 00 00 00 00 00 00", disassembly: dspLineText(line.address, [0, 0, 0, 0]) })) },
      };
    },
  };
};

describe("S01 under the gate of M3", () => {
  it("the mock passes, as everything it can do and as what the emulator of M3 does; the mock of M2 does not", async () => {
    for (const supports of [undefined, MOCK_M3_SUPPORT]) {
      const summary = await run({ supports }, undefined, { only: new Set(["S01"]), milestone: "M3" });
      expect(reportOf(summary), String(supports)).toEqual(["S01 passed "]);
    }
    const m2 = await run({ supports: MOCK_M2_SUPPORT }, undefined, { only: new Set(["S01"]), milestone: "M3" });
    expect(statusOf(m2, "S01")).toBe("failed");
    expect(detailOf(m2, "S01")).toMatch(/the gate of M3: targets: dsp\.stepping is not true; a server of milestone M3 steps the DSP/);
    expect(detailOf(m2, "S01")).toMatch(/the gate of M3: dc\.aica\.dsp lacks ACC Y_REG FRC_REG ADRS_REG LATCH LATCH_COPY MEMVAL NOFL_PIPE MIXS_BANK; /);
  }, 60_000);

  it("broken server 11: a server that lists dsp without stepping fails the first run under M3, not under M2", async () => {
    const noStepping = describing((result) => ({ ...result, targets: result.targets.map((target) => (target.id === "dsp" ? { ...target, stepping: false } : target)) }));
    const m3 = await run({ supports: MOCK_M3_SUPPORT }, noStepping, { only: new Set(["S01"]), milestone: "M3" });
    expect(detailOf(m3, "S01")).toBe("the gate of M3: targets: dsp.stepping is not true; a server of milestone M3 steps the DSP and takes its code breakpoints (3.1)");
    const m2 = await run({ supports: MOCK_M3_SUPPORT }, noStepping, { only: new Set(["S01"]), milestone: "M2" });
    expect(reportOf(m2)).toEqual(["S01 passed "]);
  }, 60_000);

  it("broken server 10: a dc.aica.dsp without one of the datapath registers fails under M3; and a width of one of them is wrong on every server", async () => {
    /** The DSP's register list rewritten in the tree and in every tick, so that the ticks agree with the tree. */
    const dsp = (rewrite: (registers: Json[]) => Json[]): Faults =>
      describing(
        (result) => ({ ...result, deviceTree: mapNodes(result.deviceTree, (node) => (node.path === "dc.aica.dsp" ? { ...node, registers: rewrite(node.registers as Json[]) } : node)) }),
        (registers) => (registers["dc.aica.dsp"] ? { ...registers, "dc.aica.dsp": rewrite(registers["dc.aica.dsp"]) } : registers),
      );
    const without = await run({ supports: MOCK_M3_SUPPORT }, dsp((registers) => registers.filter((register) => register.name !== "LATCH_COPY")), { only: new Set(["S01"]), milestone: "M3" });
    expect(detailOf(without, "S01")).toMatch(/^the gate of M3: dc\.aica\.dsp lacks LATCH_COPY; from milestone M3 it has the datapath registers of the DSP's core/);
    // (a server of M2 need not have them)
    const m2 = await run({ supports: MOCK_M3_SUPPORT }, dsp((registers) => registers.slice(0, 4)), { only: new Set(["S01"]), milestone: "M2" });
    expect(reportOf(m2)).toEqual(["S01 passed "]);
    // the widths are normative for every server that lists one of them, under no gate as well
    for (const [name, width] of M3_DSP_REGISTERS) {
      const wrong = await run(
        undefined,
        dsp((registers) => registers.map((register) => (register.name === name ? { ...register, width: width + 1, value: `0x${"0".repeat(Math.ceil((width + 1) / 4))}` } : register))),
        { only: new Set(["S01"]) },
      );
      expect(detailOf(wrong, "S01"), name).toBe(`dc.aica.dsp.${name} has width ${width + 1}, 2.8 says ${width}`);
    }
  }, 120_000);
});

describe("S10: the text of a DSP line is the playground's line of its bytes", () => {
  it("the mock passes: every line is \"MPRO[n] = \" and disassembleDesc(decodeInst(words)) of src/app/dsp/dspUtils.ts, TRA:0 for an empty step", async () => {
    const summary = await run(undefined, undefined, { only: new Set(["S10"]) });
    expect(reportOf(summary)).toEqual(["S10 passed "]);
    expect(dspLineText(0, [0, 0, 0, 0])).toBe("MPRO[0] = TRA:0");
    expect(dspLineText(5, [0x0104, 0xb080, 0x0001, 0x0000])).toBe("MPRO[5] = TWT TWA:2 XSEL YSEL:1 IRA:33 BSEL");
  }, 60_000);

  it("broken server 7: a DSP program view that is fabricated: a text of its own, a text without the prefix, a text of other bytes, bytes that are not words", async () => {
    const dspLines = (rewrite: (line: Json & { address: number; bytes: string; disassembly: string }) => Json): Faults => ({
      toClient: (frame) => {
        const lines = (frame.result as { lines?: Array<Json & { address: number; bytes: string; disassembly: string }> } | undefined)?.lines;
        return lines && lines.every((line) => /^MPRO\[/.test(line.disassembly)) ? { ...frame, result: { lines: lines.map(rewrite) } } : frame;
      },
    });
    for (const [rewrite, message] of [
      // the mock as it was: field strings without the prefix, some run together
      [(line: Json & { address: number }) => ({ ...line, disassembly: "TWT TWA YSEL BSELXSEL YSEL IRA:2 ZERO" }), /^dsp: step \d+ reads "TWT TWA YSEL BSELXSEL YSEL IRA:2 ZERO"; the playground's line of its bytes .* is "MPRO\[\d+\] = /],
      [(line: Json & { disassembly: string }) => ({ ...line, disassembly: line.disassembly.replace(/^MPRO\[\d+\] = /, "") }), /^dsp: step \d+ reads ".*"; the playground's line of its bytes/],
      [(line: Json & { address: number }) => ({ ...line, bytes: "12 34 56 78 9A BC DE F0" }), /^dsp: step \d+ reads ".*"; the playground's line of its bytes 12 34 56 78 9A BC DE F0 is "MPRO\[\d+\] = /],
      [(line: Json) => ({ ...line, bytes: "00 00 00 00" }), /^dsp: the bytes of step \d+ are "00 00 00 00", not its four MPRO words as 8 pairs|^dsp: "00 00 00 00" are not 8 bytes/],
    ] as const) {
      const summary = await run(undefined, dspLines(rewrite as (line: Json) => Json), { only: new Set(["S10"]) });
      expect(statusOf(summary, "S10")).toBe("failed");
      expect(detailOf(summary, "S10")).toMatch(message);
    }
  }, 120_000);
});

describe("S17, part sgcCapture", () => {
  it("the mock passes; with the ARM7 held at its first stop the first capture is made there, and S17 notes it", async () => {
    const plain = await s17(undefined, undefined, {}, "sgcCapture");
    expect(partOf(plain, "sgc capture")).toEqual({ name: "sgc capture", status: "passed" });
    expect(plain.scenarios[0].notes).toEqual([]);
    const held = await s17(ANCHORED, undefined, { dspProgram: true }, "sgcCapture");
    expect(partOf(held, "sgc capture")).toEqual({ name: "sgc capture", status: "passed" });
    expect(held.scenarios[0].notes).toEqual([M3_NOTES.sgcHeld]);
    expect(M3_NOTES).toEqual({ sgcHeld: "sgc: captured with the arm7 held", dspHeld: "dsp: stepped with the arm7 held" });
  }, 60_000);

  it("a server whose DSP does not step: no capture is held open, and 4096 frames are captured from a stop", async () => {
    const lines: string[] = [];
    const summary = await s17({ supports: { stepping: ["sh4", "arm7"] } }, undefined, { say: (line) => lines.push(line) }, "sgcCapture");
    expect(partOf(summary, "sgc capture")).toEqual({ name: "sgc capture", status: "passed" });
    expect(summary.scenarios[0].notes).toEqual(["the capture held open at a DSP breakpoint was not made: targets: dsp.stepping is false"]);
  }, 60_000);

  it("broken server 6, inverted: a capture that is answered -32012 while the ARM7 is held fails S17", async () => {
    const summary = await s17(ANCHORED, refusedWhileHeld((request) => request.method === "state.recordSgcFrames"), { dspProgram: true }, "sgcCapture");
    expect(statusOf(summary, "S17")).toBe("failed");
    expect(partOf(summary, "sgc capture")?.detail).toMatch(
      /^with the ARM7 held \(ENABLED reads 0\) at the first stop of S17: state\.recordSgcFrames \{"frames":64\}: in-band error -32012 .*; the AICA is clocked whatever ARMRST says: .* \(the M3 round's M3-D7\)$/,
    );
    expect(summary.requiredNotesMissing).toEqual([]);
    const gate = await run(ANCHORED, refusedWhileHeld((request) => request.method === "state.recordSgcFrames"), { only: new Set(["S17"]), dspProgram: true, requireNotes: [M3_NOTES.sgcHeld] });
    expect(gate.requiredNotesMissing).toEqual([M3_NOTES.sgcHeld]);
    expect(gate.ok).toBe(false);
  }, 60_000);

  it("broken server 2: a capture answered at the arm, before it is complete", async () => {
    // The response at once; the capture takes some 50 emulation steps of the mock (the server's own
    // response, when it is complete, goes nowhere), so that the read behind the response is made
    // while it records.
    const early = patched((machine) => {
      const record = machine.recordSgcFrames.bind(machine);
      machine.recordSgcFrames = (params, context) => {
        record(params, context);
        (machine as unknown as { send(client: unknown, message: Json): void }).send(context.client, { jsonrpc: "2.0", id: context.id, result: {} });
        machine.recording!.client = { id: -1 };
        machine.recording!.endAt += 50n * 448n * 7143n;
      };
    });
    const summary = await s17(early, undefined, {}, "sgcCapture");
    expect(partOf(summary, "sgc capture")?.detail).toBe(
      'state.getSgcFrameData right behind the response of state.recordSgcFrames {"frames":64} answers -32011: there is no capture; the response is sent when the capture is complete, and the capture is then the server\'s (design 3.3)',
    );
  }, 60_000);

  it("a capture whose buffer replaces the server's at the arm: emptied, or of the new count before it is complete", async () => {
    const emptied = patched((machine) => {
      const record = machine.recordSgcFrames.bind(machine);
      machine.recordSgcFrames = (params, context) => {
        record(params, context);
        machine.capture = undefined;
      };
    });
    const empty = await s17(emptied, undefined, {}, "sgcCapture");
    expect(partOf(empty, "sgc capture")?.detail).toBe(
      "state.getSgcFrameData while a capture records answers -32011: the server's capture is the one before (96 frames) until the new one is complete (M3-D27)",
    );
    const replaced = patched((machine) => {
      const record = machine.recordSgcFrames.bind(machine);
      machine.recordSgcFrames = (params, context) => {
        record(params, context);
        const frames = (params.frames as number | undefined) ?? 1024;
        machine.capture = generateMockSgcCapture(frames, 99);
      };
    });
    const early = await s17(replaced, undefined, {}, "sgcCapture");
    expect(partOf(early, "sgc capture")?.detail).toMatch(
      /^state\.getSgcFrameData while a capture records has frameCount 4096; the server's capture is the one before \(96 frames\) until the new one is complete \(M3-D27\)$/,
    );
  }, 60_000);

  it("the capture's stop in front of its response, the emulator's other legal order: S17 passes", async () => {
    // the response of a capture made at a stop is held back until its paused tick with reason
    // "capture" has gone out (a capture while running has no stop: its response goes as it comes)
    let reordered = 0;
    const tickFirst = (): Faults => {
      const atStop = new Set<unknown>();
      let paused = false;
      let held: Json | undefined;
      return {
        toServer: (frame) => {
          if (frame.method === "state.recordSgcFrames" && paused) atStop.add(frame.id);
          return frame;
        },
        toClient: (frame) => {
          if (isTick(frame)) {
            paused = frame.params.executionState.state === "paused";
          }
          if (!isTick(frame) && atStop.has(frame.id) && (frame.result as Json | undefined)?.error === undefined) {
            held = frame;
            return undefined;
          }
          if (held && isTick(frame) && frame.params.executionState.reason === "capture") {
            const response = held;
            held = undefined;
            reordered++;
            return [frame, response];
          }
          return frame;
        },
      };
    };
    const summary = await s17(undefined, tickFirst, {}, "sgcCapture");
    expect(partOf(summary, "sgc capture")).toEqual({ name: "sgc capture", status: "passed" });
    expect(reordered).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it("broken server 3: a server that cannot record while the target runs, or that stops it for the capture", async () => {
    const refused = (): Faults => {
      const watch = watchingEnabled();
      return { toClient: watch.toClient, answer: (request) => (request.method === "state.recordSgcFrames" && watch.state.running ? inBand(request, -32003, "not paused") : undefined) };
    };
    const no = await s17(undefined, refused, {}, "sgcCapture");
    expect(partOf(no, "sgc capture")?.detail).toMatch(/^state\.recordSgcFrames \{"frames":96\}: in-band error -32003/);
    const stops = patched((machine) => {
      const record = machine.recordSgcFrames.bind(machine);
      machine.recordSgcFrames = (params, context) => {
        record(params, context);
        machine.recording!.stopAtEnd = true;
      };
    });
    const stopped = await s17(stops, undefined, {}, "sgcCapture");
    expect(partOf(stopped, "sgc capture")?.detail).toMatch(/^state\.recordSgcFrames while running stopped the target \(#\d+ paused stop \d+ capture\); a running target keeps running$/);
  }, 60_000);

  it("broken server 4: a server that ignores frames when it is absent, or that runs for any time between the request and the stop", async () => {
    const ignores: Faults = { toServer: (frame) => (frame.method === "state.recordSgcFrames" && paramsOf(frame).frames === undefined ? { ...frame, params: { frames: 64 } } : frame) };
    const absent = await s17(undefined, ignores, {}, "sgcCapture");
    expect(partOf(absent, "sgc capture")?.detail).toMatch(/^state\.getSgcFrameData right behind the response of state\.recordSgcFrames \{\} has frameCount 64, that of the capture before, not 1024: /);
    // five periods of the AICA more than the capture, and the capture on the wall clock of 44.1 kHz
    const longer = patched((machine) => {
      const record = machine.recordSgcFrames.bind(machine);
      machine.recordSgcFrames = (params, context) => {
        record(params, context);
        machine.recording!.endAt += 5n * PERIOD;
      };
    });
    const long = await s17(longer, undefined, {}, "sgcCapture");
    expect(partOf(long, "sgc capture")?.detail).toMatch(
      /^state\.recordSgcFrames \{"frames":64\}: dc\.timing\.SH4_CYCLES grew by 1015868 from the stop before to the stop of the capture; 64 frames are 2 periods of the AICA \(2 x 145124\), one either way$/,
    );
    const wallClock = patched((machine) => {
      // the mock as it was: a whole emulation step of SH4 time for the capture
      const record = machine.recordSgcFrames.bind(machine);
      machine.recordSgcFrames = (params, context) => {
        record(params, context);
        machine.recording!.endAt = machine.cycles + 448n * 7143n;
      };
    });
    const timed = await s17(wallClock, undefined, {}, "sgcCapture");
    expect(partOf(timed, "sgc capture")?.detail).toMatch(/^state\.recordSgcFrames \{"frames":64\}: dc\.timing\.SH4_CYCLES grew by 3200064 /);
  }, 60_000);

  it("the bounds: frames 0 or 4097 accepted fails; and a second connection that reads another capture", async () => {
    for (const frames of [0, 4097]) {
      const accepts: Faults = { answer: (request) => (request.method === "state.recordSgcFrames" && paramsOf(request).frames === frames ? { jsonrpc: "2.0", id: request.id, result: {} } : undefined) };
      const summary = await s17(undefined, accepts, {}, "sgcCapture");
      expect(partOf(summary, "sgc capture")?.detail, String(frames)).toMatch(new RegExp(`^state\\.recordSgcFrames \\{"frames":${frames}\\}: expected the error -32602, got the result \\{\\}`));
    }
    // (the first call of a FaultSource is the proxy's own, for its limits; then one per connection)
    let connections = 0;
    const own: FaultSource = () => {
      const second = ++connections === 3;
      return { answer: (request) => (second && request.method === "state.getSgcFrameData" ? rpcError(request, -32011, "no capture available") : undefined) };
    };
    const other = await s17(undefined, own, {}, "sgcCapture");
    expect(partOf(other, "sgc capture")?.detail).toMatch(/^state\.getSgcFrameData \{\}: JSON-RPC error -32011/);
  }, 60_000);

  it("broken server 5: a capture of zeros, or with no channel that sounds, under --dsp-program", async () => {
    const zeros: Faults = {
      toClientBinary: (frame) => (frame.readUInt32LE(4) === BinaryFrameKind.SGC_FRAMES ? Buffer.concat([frame.subarray(0, 16), Buffer.alloc(frame.length - 16)]) : frame),
    };
    const silent = await s17(ANCHORED, zeros, { dspProgram: true }, "sgcCapture");
    expect(partOf(silent, "sgc capture")?.detail).toMatch(/^no record of the 4 captures has a channel that sounds \(flags bit 0 set and a level above 0\): the DSP test program keys two channels$/);
    // (the run with the M1 test program does not ask: 2ndmix's records are silent)
    const plain = await s17(undefined, zeros, {}, "sgcCapture");
    expect(partOf(plain, "sgc capture")).toEqual({ name: "sgc capture", status: "passed" });
  }, 60_000);

  it("held open: a second request that is accepted, and a stop that ends the capture", async () => {
    const replacing = patched((machine) => {
      const record = machine.recordSgcFrames.bind(machine);
      machine.recordSgcFrames = (params, context) => {
        if (machine.recording) {
          machine.cancelCapture(-32014, "capture timed out: replaced");
        }
        record(params, context);
      };
    });
    const second = await s17(replacing, undefined, {}, "sgcCapture");
    // (the second request records in the place of the first, held at the breakpoint: its deadline answers it)
    expect(partOf(second, "sgc capture")?.detail).toMatch(/^state\.recordSgcFrames was answered before its capture was complete \(state\.recordSgcFrames \{"frames":4096\}: in-band error -32014 /);
    const stopEnds = patched((machine) => {
      const enterStop = machine.enterStop.bind(machine);
      machine.enterStop = (reason, breakpointId, fallbackStep) => {
        enterStop(reason, breakpointId, fallbackStep);
        if (reason === "breakpoint" && machine.recording) {
          machine.recording.stopAtEnd = false;
          machine.completeCapture(false);
        }
      };
    });
    const ended = await s17(stopEnds, undefined, {}, "sgcCapture");
    expect(partOf(ended, "sgc capture")?.detail).toBe(
      "state.recordSgcFrames was answered before its capture was complete ({}): the response came while the capture is held open at a DSP breakpoint",
    );
    // and a server that refuses nothing while a capture records
    const unrefused = patched((machine) => {
      const record = machine.recordSgcFrames.bind(machine);
      machine.recordSgcFrames = (params, context) => {
        if (machine.recording) {
          (machine as unknown as { send(client: unknown, message: Json): void }).send(context.client, { jsonrpc: "2.0", id: context.id, result: {} });
          context.deferred = true;
          return;
        }
        record(params, context);
      };
    });
    const refusedNothing = await s17(unrefused, undefined, {}, "sgcCapture");
    expect(partOf(refusedNothing, "sgc capture")?.detail).toBe(
      'state.recordSgcFrames {"frames":16} while a capture records: expected the error -32003 (the first capture goes on, M3-D27), got the result {}',
    );
  }, 60_000);

  it("held open: a first stop that is not the breakpoint's, a capture that ends in a stop of another reason, a capture that ends with another count", async () => {
    // the breakpoint's stop, while a capture records, published as a pause
    const notTheBreakpoints = patched((machine) => {
      const enterStop = machine.enterStop.bind(machine);
      machine.enterStop = (reason, breakpointId, fallbackStep) => (reason === "breakpoint" && machine.recording ? enterStop("pause") : enterStop(reason, breakpointId, fallbackStep));
    });
    expect(partOf(await s17(notTheBreakpoints, undefined, {}, "sgcCapture"), "sgc capture")?.detail).toMatch(
      /^a capture armed at a stop with a DSP breakpoint on step 0: the first stop is #\d+ paused stop \d+ pause, expected that breakpoint's; a stop keeps a capture recording \(M3-D27\)$/,
    );
    // the capture of 4096 frames ends in a stop with reason "pause"
    const pauseAtTheEnd = patched((machine) => {
      let ending: number | undefined;
      const completeCapture = machine.completeCapture.bind(machine);
      machine.completeCapture = (stop) => {
        ending = machine.recording?.frames;
        try {
          return completeCapture(stop);
        } finally {
          ending = undefined;
        }
      };
      const enterStop = machine.enterStop.bind(machine);
      machine.enterStop = (reason, breakpointId, fallbackStep) => enterStop(reason === "capture" && ending === 4096 ? "pause" : reason, breakpointId, fallbackStep);
    });
    expect(partOf(await s17(pauseAtTheEnd, undefined, {}, "sgcCapture"), "sgc capture")?.detail).toMatch(
      /^the paused tick with reason "capture" of the capture that was held open: not seen within 5000 ms; ticks since then: \d+ \(.*#\d+ paused stop \d+ pause\)$/,
    );
    // the capture of 4096 frames records 4095
    const fewer = patched((machine) => {
      const record = machine.recordSgcFrames.bind(machine);
      machine.recordSgcFrames = (params, context) => {
        record(params, context);
        if (params.frames === 4096) machine.recording!.frames = 4095;
      };
    });
    expect(partOf(await s17(fewer, undefined, {}, "sgcCapture"), "sgc capture")?.detail).toBe("the capture that was held open has frameCount 4095, 4096 were recorded");
  }, 60_000);

  it("a second connection that reads the capture with other bytes; records with flags above bit 2, a level above 0x3FF, a byte of 110..127 that is not zero", async () => {
    // (the first call of a FaultSource is the proxy's own; then the scenario's connection, then the second one)
    let connections = 0;
    const otherBytes: FaultSource = () => {
      const second = ++connections === 3;
      return {
        toClientBinary: (frame) => (second && frame.readUInt32LE(4) === BinaryFrameKind.SGC_FRAMES ? Buffer.concat([frame.subarray(0, 16), Buffer.from([frame[16] ^ 0x5a]), frame.subarray(17)]) : frame),
      };
    };
    expect(partOf(await s17(undefined, otherBytes, {}, "sgcCapture"), "sgc capture")?.detail).toBe(
      "a second connection reads a capture of 96 frames with other bytes; the capture is the server's (design 3.3)",
    );
    const first = 'state\\.getSgcFrameData right behind the response of state\\.recordSgcFrames \\{"frames":64\\}: record at 0: ';
    for (const [change, message] of [
      [(record: Buffer) => (record[109] |= 0x08), new RegExp(`^${first}flags byte \\d+ has bits above bit 2$`)],
      [(record: Buffer) => record.writeUInt32LE(0x400, 96), new RegExp(`^${first}aeg_value 1024 is above 0x3FF$`)],
      [(record: Buffer) => (record[110] = 1), new RegExp(`^${first}byte 110 is not zero$`)],
    ] as const) {
      // the first record of every capture read, changed
      const faults: Faults = {
        toClientBinary: (frame) => {
          if (frame.readUInt32LE(4) !== BinaryFrameKind.SGC_FRAMES) return frame;
          const copy = Buffer.from(frame);
          change(copy.subarray(16, 16 + 128));
          return copy;
        },
      };
      expect(partOf(await s17(undefined, faults, {}, "sgcCapture"), "sgc capture")?.detail).toMatch(message);
    }
  }, 120_000);
});

describe("S17, part memoryBinary", () => {
  it("the mock passes; without the capability the part is not applicable", async () => {
    // (alone, the part makes a capture of one frame to read between its two last reads)
    const summary = await s17(undefined, undefined, {}, "memoryBinary");
    expect(partOf(summary, "memory binary")).toEqual({ name: "memory binary", status: "passed" });
    expect(summary.scenarios[0].notes).toEqual([]);
    const m2 = await s17({ supports: MOCK_M2_SUPPORT });
    expect(reportOf(m2)).toEqual(['S17 not-applicable no capability "sgc-capture"; no capability "memory-binary"']);
    // a server without the capture: the counter kind 1 shares is not exercised, and the part says so
    const noCapture = await s17({ supports: { ...MOCK_M3_SUPPORT, capabilities: MOCK_M3_SUPPORT.capabilities.filter((capability) => capability !== "sgc-capture") } });
    expect(partOf(noCapture, "memory binary")).toEqual({ name: "memory binary", status: "passed" });
    expect(noCapture.scenarios[0].notes).toEqual(['memory binary: no capability "sgc-capture", so the counter kind 1 shares with kind 2 was not exercised']);
  }, 60_000);

  it("the result and the frame: baseAddress in another mirror, totalBytes one more, a payloadBytes of its own; bytes of the unreadable run that are not zero", async () => {
    const result = (rewrite: (result: Json, params: Json) => Json) =>
      patched((machine) => {
        const binary = machine.getMemoryBinary.bind(machine);
        machine.getMemoryBinary = (params, context) => rewrite(binary(params, context), params);
      });
    const first = 'state.getMemoryBinary {"target":"sh4","address":2348875776,"length":64}';
    const mirror = await s17(result((answer, params) => ({ ...answer, baseAddress: (params.address as number) & 0x1fffffff })), undefined, {}, "memoryBinary");
    expect(partOf(mirror, "memory binary")?.detail).toBe(`${first}: baseAddress is 0x0C010000; it is the address asked for`);
    const more = await s17(result((answer) => ({ ...answer, totalBytes: (answer.totalBytes as number) + 1 })), undefined, {}, "memoryBinary");
    expect(partOf(more, "memory binary")?.detail).toBe(`${first}: totalBytes is 65, the length asked for is 64`);
    /** the frames of kind 2 whose payload has `length` bytes, rewritten */
    const frames = (length: number, rewrite: (frame: Buffer) => Buffer): Faults => ({
      toClientBinary: (frame) => (frame.readUInt32LE(4) === BinaryFrameKind.MEMORY && frame.length === 16 + length ? rewrite(Buffer.from(frame)) : frame),
    });
    // a frame of 48 bytes, whose header says so, for a read of 64
    const shorter = frames(64, (frame) => {
      frame.writeUInt32LE(48, 12);
      return frame.subarray(0, 16 + 48);
    });
    expect(partOf(await s17(undefined, shorter, {}, "memoryBinary"), "memory binary")?.detail).toBe(`${first}: payloadBytes is 48; payloadBytes == totalBytes == length`);
    // across the end of the flash: the last byte of the unreadable run is not 0 (the result's run is right)
    const notZero = frames(32, (frame) => {
      frame[16 + 31] = 0xa5;
      return frame;
    });
    expect(partOf(await s17(undefined, notZero, {}, "memoryBinary"), "memory binary")?.detail).toBe("state.getMemoryBinary across 0x0021FFF0: the unreadable bytes are not 0");
  }, 120_000);

  it("broken server 1: no method, a frame of another kind, another length or other bytes than the memory", async () => {
    const none = await run({ supports: { ...MOCK_M3_SUPPORT, capabilities: MOCK_M3_SUPPORT.capabilities.filter((capability) => capability !== "memory-binary") } }, undefined, {
      only: new Set(["S01", "S17"]),
      milestone: "M3",
    });
    expect(detailOf(none, "S01")).toMatch(/the gate of M3: the capability "memory-binary" is not advertised/);
    expect(statusOf(none, "S17")).toBe("partial");
    expect(none.ok).toBe(false);
    for (const [rewrite, message] of [
      [(frame: Buffer) => Buffer.concat([frame.subarray(0, 4), Buffer.from([1, 0, 0, 0]), frame.subarray(8)]), /: kind is 1, expected 2$/],
      [(frame: Buffer) => Buffer.concat([frame, Buffer.alloc(4)]), /: the binary frame: /],
      [(frame: Buffer) => Buffer.concat([frame.subarray(0, 20), Buffer.from([frame[20] ^ 0xff]), frame.subarray(21)]), /^state\.getMemoryBinary at 0x8C010000 for 64 bytes: byte 4 is \d+, state\.getMemorySlice reads \d+ there$/],
    ] as const) {
      const once = { done: false };
      const faults: Faults = {
        toClientBinary: (frame) => {
          if (frame.readUInt32LE(4) !== BinaryFrameKind.MEMORY || once.done) return frame;
          once.done = true;
          return rewrite(frame);
        },
      };
      const summary = await s17(undefined, faults, {}, "memoryBinary");
      expect(partOf(summary, "memory binary")?.detail).toMatch(message);
    }
  }, 120_000);

  it("a frame that goes to every client; large reads that are zeros past their first 64 KiB, their last 64 bytes kept or not, and large reads whose last 64 bytes alone differ", async () => {
    const broadcast = patched((machine) => {
      const binary = machine.getMemoryBinary.bind(machine);
      machine.getMemoryBinary = (params, context) => {
        const result = binary(params, context);
        const { data } = machine.readMemory(machine.memoryTarget(params), params.address as number, params.length as number);
        context.afterResponse.push(() => {
          for (const client of machine.clients.values()) {
            if (client.id !== context.client.id) client.connection.sendBinary(encodeBinaryFrame(BinaryFrameKind.MEMORY, result.binaryId as number, data));
          }
        });
        return result;
      };
    });
    const everyone = await s17(broadcast, undefined, {}, "memoryBinary");
    expect(partOf(everyone, "memory binary")?.detail).toBe(
      "a second connection received a binary frame of a state.getMemoryBinary it did not ask for; the frame goes to the requesting client only (M3-D36)",
    );
    /** the frames of kind 2 whose payload has `length` bytes: zeros past their first 64 KiB (but their last 64 bytes, with `tail`), or their last byte changed */
    const large = (length: number, change: "zeros" | "zeros, tail kept" | "last byte"): Faults => ({
      toClientBinary: (frame) => {
        if (frame.readUInt32LE(4) !== BinaryFrameKind.MEMORY || frame.length !== 16 + length) return frame;
        const copy = Buffer.from(frame);
        if (change === "last byte") {
          copy[copy.length - 1] ^= 0xff;
        } else {
          copy.fill(0, 16 + 0x10000, change === "zeros" ? copy.length : copy.length - 64);
        }
        return copy;
      },
    });
    const sixteen = 16 * 1048576;
    // (the server of a guest whose stack, at the top of main memory, is zeros: the window at 0x0C010000 tells)
    for (const change of ["zeros", "zeros, tail kept"] as const) {
      const short = await s17(undefined, large(sixteen, change), {}, "memoryBinary");
      expect(partOf(short, "memory binary")?.detail, change).toMatch(/^a read of 16 MiB from 0x0C000000, at 0x0C010000 past its first 64 KiB: byte \d+ is 0, state\.getMemorySlice reads \d+ there$/);
    }
    const tail = await s17(undefined, large(sixteen, "last byte"), {}, "memoryBinary");
    expect(partOf(tail, "memory binary")?.detail).toMatch(/^the last 64 bytes of a read of 16 MiB from 0x0C000000: byte 63 is \d+, state\.getMemorySlice reads \d+ there$/);
    // wave memory, both reads alike (so that they agree with each other)
    const wave = await s17(undefined, large(0x200000, "zeros, tail kept"), {}, "memoryBinary");
    expect(partOf(wave, "memory binary")?.detail).toMatch(/^2 MiB of wave memory through the ARM7, at 0x00010000 past its first 64 KiB: byte \d+ is 0, state\.getMemorySlice reads \d+ there$/);
    const waveTail = await s17(undefined, large(0x200000, "last byte"), {}, "memoryBinary");
    expect(partOf(waveTail, "memory binary")?.detail).toMatch(/^the last 64 bytes of 2 MiB of wave memory through the ARM7: byte 63 is \d+, state\.getMemorySlice reads \d+ there$/);
    // memory that reads 0 in every window past 64 KiB, in both methods: the part passes, and says that it could not tell
    const zeroWindows = patched((machine) => {
      const readMemory = machine.readMemory.bind(machine);
      machine.readMemory = (target, address, length) => {
        const read = readMemory(target, address, length);
        const windows = target === "sh4" ? [0x0c010000, 0x00810000] : [0x10000];
        for (let offset = 0; offset < length; offset++) {
          const at = target === "sh4" ? (address + offset) & 0x1fffffff : address + offset;
          if (windows.some((start) => at >= start && at < start + 64)) read.data[offset] = 0;
        }
        return read;
      };
    });
    const zero = await s17(zeroWindows, undefined, {}, "memoryBinary");
    expect(partOf(zero, "memory binary")).toEqual({ name: "memory binary", status: "passed" });
    expect(zero.scenarios[0].notes).toEqual([
      "memory binary: the memory reads 0 in every window past the first 64 KiB of the large reads, so a read that is zeros past its first 64 KiB is not told apart",
    ]);
  }, 120_000);

  it("binaryId counted per kind, a frame in front of its response, a frame behind an error", async () => {
    /** a server that counts the frames of kind 2 apart from those of kind 1; with `spends`, an error of the method takes an id too */
    const perKind = (options: MockDebuggerOptions = {}, spends = false) =>
      patched((machine) => {
        let memory = 0;
        machine.getMemoryBinary = (params, context) => {
          let read: ReturnType<Machine["readMemory"]>;
          try {
            read = machine.readMemory(machine.memoryTarget(params), params.address as number, params.length as number);
          } catch (error) {
            if (spends) memory++;
            throw error;
          }
          const binaryId = ++memory;
          context.afterResponse.push(() => context.client.connection.sendBinary(encodeBinaryFrame(BinaryFrameKind.MEMORY, binaryId, read.data)));
          return { baseAddress: params.address, totalBytes: read.data.byteLength, ...(read.unreadable.length ? { unreadable: read.unreadable } : {}), binaryId };
        };
      }, options);
    // A read, a capture's read, a read: with a counter for each kind the second read has the id
    // right behind the first, whatever the connection had before, so no id of kind 1 fits in
    // between. The whole of S17 (the captures of sgcCapture in front), the part alone (it makes a
    // capture of its own), a server whose DSP does not step (a capture fewer), and one that spends
    // ids on the errors of the method.
    for (const [label, server, part] of [
      ["S17", perKind(), undefined],
      ["the part alone", perKind(), "memoryBinary"],
      ["the DSP not stepping", perKind({ supports: { stepping: ["sh4", "arm7"] } }), undefined],
      ["ids spent on errors", perKind({}, true), undefined],
      ["ids spent on errors, the part alone", perKind({}, true), "memoryBinary"],
    ] as const) {
      const summary = await s17(server, undefined, {}, part);
      const detail = partOf(summary, "memory binary")?.detail ?? "";
      const ids = /^binaryIds (\d+), (\d+), (\d+) of state\.getMemoryBinary, state\.getSgcFrameData and state\.getMemoryBinary in a row do not increase; a connection has one counter for the binary frames of every kind \(M3-D36\)$/.exec(detail);
      expect(ids, `${label}: ${detail}`).not.toBeNull();
      expect(Number(ids![3]), label).toBe(Number(ids![1]) + 1);
    }

    const early = await s17(undefined, { afterNextBinary: (frame) => typeof (frame.result as Json | undefined)?.baseAddress === "number" && (frame.result as Json).totalBytes !== undefined }, {}, "memoryBinary");
    expect(partOf(early, "memory binary")?.detail).toMatch(/the binary frame of state\.getMemoryBinary arrived before its JSON response; the response is sent first, the binary frame second/);

    const behindError = patched((machine) => {
      const binary = machine.getMemoryBinary.bind(machine);
      machine.getMemoryBinary = (params, context) => {
        try {
          return binary(params, context);
        } catch (error) {
          setTimeout(() => context.client.connection.sendBinary(encodeBinaryFrame(BinaryFrameKind.MEMORY, ++context.client.binaryId, new Uint8Array(16))), 10);
          throw error;
        }
      };
    });
    const errorFrame = await s17(behindError, undefined, {}, "memoryBinary");
    expect(partOf(errorFrame, "memory binary")?.detail).toBe("a binary frame followed the error -32010 of state.getMemoryBinary");
  }, 60_000);

  it("the answers of the method: -32004 for dsp, 16777217 refused, the unreadable run, wave memory one store behind both targets", async () => {
    for (const [faults, message] of [
      [{ answer: (request: Json) => (request.method === "state.getMemoryBinary" && paramsOf(request).target === "dsp" ? rpcError(request, -32010, "address not readable") : undefined) }, /^state\.getMemoryBinary \{"target":"dsp","address":0,"length":16\}: expected the error -32004, got -32010/],
      [
        { answer: (request: Json) => (request.method === "state.getMemoryBinary" && paramsOf(request).length === 16777217 ? { jsonrpc: "2.0", id: request.id, result: { baseAddress: 0x0c000000, totalBytes: 16777217, binaryId: 99 } } : undefined) },
        /^state\.getMemoryBinary \{"target":"sh4","address":201326592,"length":16777217\}: expected the error -32602, got the result /,
      ],
      [
        { toClient: (frame: Json) => ((frame.result as Json | undefined)?.unreadable ? { ...frame, result: { ...(frame.result as Json), unreadable: [[16, 15]] } } : frame) },
        /^state\.getMemoryBinary across 0x0021FFF0 for 32: unreadable is \[\[16,15\]\], expected \[\[16,16\]\]$/,
      ],
    ] as const) {
      const summary = await s17(undefined, faults as Faults, {}, "memoryBinary");
      expect(partOf(summary, "memory binary")?.detail).toMatch(message);
    }
    let waves = 0;
    const twoStores: Faults = {
      toClientBinary: (frame) => (frame.readUInt32LE(4) === BinaryFrameKind.MEMORY && frame.length === 16 + 0x200000 && ++waves === 1 ? Buffer.concat([frame.subarray(0, 0x1000), Buffer.from([frame[0x1000] ^ 1]), frame.subarray(0x1001)]) : frame),
    };
    const two = await s17(undefined, twoStores, {}, "memoryBinary");
    expect(partOf(two, "memory binary")?.detail).toMatch(/^wave memory: byte 0x00000FF0 reads \d+ through the ARM7 and \d+ through the SH4 at 0x00800000 \+ 0x00000FF0$/);
  }, 60_000);
});

describe("S21", () => {
  it("the mock passes; with the ARM7 held at its first stop the first step of the DSP is made there, and S21 notes it", async () => {
    const plain = await s21();
    expect(reportOf(plain)).toEqual(["S21 passed "]);
    const held = await s21(ANCHORED);
    expect(reportOf(held)).toEqual([`S21 passed ${M3_NOTES.dspHeld}`]);
  }, 60_000);

  it("broken server 6, inverted: a step of the DSP answered -32012 while the ARM7 is held fails S21", async () => {
    // (control.step alone: step over and step out are -32004 held or not, the test below)
    const summary = await s21(ANCHORED, refusedWhileHeld((request) => request.method === "control.step" && paramsOf(request).target === "dsp"));
    expect(statusOf(summary, "S21")).toBe("failed");
    expect(firstOf(summary, "S21")).toMatch(
      /^with the ARM7 held \(ENABLED reads 0\) at the first stop of S21: control\.step \{"target":"dsp"\}: in-band error -32012 .*; the AICA is clocked whatever ARMRST says: .* \(the M3 round's M3-D7\)$/,
    );
  }, 60_000);

  it("with the ARM7 held, step over and step out of the DSP are -32004 as ever: a server that answers -32012 for them while the ARM7 is held fails S21", async () => {
    const overOrOut = (request: Json) => /^control\.step(Over|Out)$/.test(String(request.method)) && paramsOf(request).target === "dsp";
    for (const method of ["control.stepOver", "control.stepOut"]) {
      const summary = await s21(ANCHORED, refusedWhileHeld((request) => request.method === method && paramsOf(request).target === "dsp"));
      expect(statusOf(summary, "S21")).toBe("failed");
      expect(firstOf(summary, "S21"), method).toMatch(
        new RegExp(
          `^with the ARM7 held \\(ENABLED reads 0\\) at the first stop of S21: ${method.replace(".", "\\.")} \\{"target":"dsp"\\}: expected the error -32004, got -32012 "[^"]*"; the AICA is clocked whatever ARMRST says: .* \\(the M3 round's M3-D7\\)$`,
        ),
      );
    }
    // (the same server with its ARM7 clocked answers -32004, as the mock does: S21 passes)
    expect(reportOf(await s21(undefined, refusedWhileHeld(overOrOut)))).toEqual(["S21 passed "]);
  }, 60_000);

  it("the server that behaves as the emulator on the guest passes: the ARM7 held at the anchor, the DSP clocked there, the program loaded behind it, its words in the ELF", async () => {
    const withElf = await s21(ANCHORED, emulatorOnTheGuest, { elf: guestElf() });
    expect(reportOf(withElf)).toEqual([`S21 passed ${M3_NOTES.dspHeld}`]);
    const without = await s21(ANCHORED, emulatorOnTheGuest);
    expect(reportOf(without)).toEqual([`S21 passed ${M3_NOTES.dspHeld}`]);
    // the program the ELF has is what the runner compares with
    expect(dspProgramOfElf(guestElf())).toMatchObject({ bytes: expect.arrayContaining(["00 00 00 00 00 00 00 00"]) });
    const other = await s21(ANCHORED, emulatorOnTheGuest, { elf: guestElf({ word: 9, value: 0x1234 }) });
    expect(firstOf(other, "S21")).toBe("the DSP's program is not the block between g_dsp_mpro and g_dsp_mpro_end of the ELF after five times a second of running: the first step that differs is 2");
    const noSymbols = await s21(ANCHORED, emulatorOnTheGuest, { elf: { entry: 0x8c010000, symbols: new Map() } });
    expect(firstOf(noSymbols, "S21")).toMatch(/^--elf: the ELF has no symbols g_dsp_mpro and g_dsp_mpro_end; /);
  }, 120_000);

  it("the rules of the resume from a DSP breakpoint: no exemption, a breakpoint reached once a burst", async () => {
    const noExemption = patched((machine) => {
      const runBurst = machine.runBurst.bind(machine);
      machine.runBurst = (sample, step, _exempt, last) => runBurst(sample, step, false, last);
    });
    const once = await s21(noExemption);
    expect(detailOf(once, "S21")).toMatch(/^a resume from the stop of the DSP breakpoint on step \d+ stopped at it again with MDEC_CT (0x[0-9A-F]+), it was \1: expected one less, the same step one sample later/);
    const perBurst = patched((machine) => {
      const leaveStop = machine.leaveStop.bind(machine);
      machine.leaveStop = () => {
        // the rest of the burst runs without its breakpoints, and the next one meets them again
        machine.finishBurst();
        leaveStop();
      };
    });
    const burst = await s21(perBurst);
    expect(detailOf(burst, "S21")).toMatch(/^a resume from the stop of the DSP breakpoint on step \d+ stopped at it again with MDEC_CT 0x[0-9A-F]+, it was 0x[0-9A-F]+: expected one less/);
  }, 60_000);

  it("the rules of a step of the DSP: from 127 one sample more, a first step that lets the SH4 run on, a step from a DSP stop that moves the SH4, rows that never change", async () => {
    const twice = patched((machine) => {
      const stepDsp = machine.stepDsp.bind(machine);
      machine.stepDsp = () => {
        const last = machine.suspended?.step === 127;
        stepDsp();
        if (last) {
          machine.completeSample();
          machine.refreshDsp();
        }
      };
    });
    const from127 = await s21(twice);
    expect(detailOf(from127, "S21")).toMatch(/^control\.step \{dsp\} from step 127 ended with MDEC_CT 0x[0-9A-F]+, it was 0x[0-9A-F]+: expected one less, the step completes the sample and no more$/);
    /** a first step from a pause that lets the SH4 run on, two periods behind the burst */
    const runningOn = (options?: MockDebuggerOptions) =>
      patched((machine) => {
        const stepDsp = machine.stepDsp.bind(machine);
        machine.stepDsp = () => {
          const fromPause = !machine.suspended;
          stepDsp();
          if (fromPause) machine.setCycles(machine.cycles + 2n * PERIOD);
        };
      }, options);
    const first = await s21(runningOn());
    expect(detailOf(first, "S21")).toMatch(/^control\.step \{dsp\}, from a stop that is not the DSP's: dc\.timing\.SH4_CYCLES grew by \d+; the SH4 runs to the next burst, at most one period of the AICA and the rest of a slice \(145572\)$/);
    const heldRunsOn = await s21(runningOn(ANCHORED));
    expect(firstOf(heldRunsOn, "S21")).toMatch(/^with the ARM7 held \(ENABLED reads 0\) at the first stop of S21: control\.step \{dsp\} with the ARM7 held, from a stop that is not the DSP's: dc\.timing\.SH4_CYCLES grew by /);
    const movesSh4 = patched((machine) => {
      const stepDsp = machine.stepDsp.bind(machine);
      machine.stepDsp = () => {
        const fromDspStop = machine.suspended !== undefined;
        stepDsp();
        if (fromDspStop) machine.setCycles(machine.cycles + 448n);
      };
    });
    const moved = await s21(movesSh4);
    expect(detailOf(moved, "S21")).toMatch(/^control\.step \{dsp\} from the stop of the breakpoint on step \d+, from a stop of the DSP: dc\.timing\.SH4_CYCLES moved by 448; the step stays in the sound burst suspended there, and the SH4 does not execute$/);
    const frozen = patched((machine) => {
      const refreshDsp = machine.refreshDsp.bind(machine);
      machine.refreshDsp = () => {
        refreshDsp();
        for (const [name] of M3_DSP_REGISTERS) machine.values.get("dc.aica.dsp")!.set(name, 0);
      };
    });
    const still = await s21(frozen);
    expect(detailOf(still, "S21")).toMatch(/^the nine datapath registers of dc\.aica\.dsp read the same in the paused ticks of all \d+ steps of the DSP S21 made \(0x0000000 0x000000 0x0000 0x000 0x0000 0x0000 0x0000 0x0 0x0\); a step of the DSP moves them$/);
  }, 120_000);

  it("broken server 8: a step of the DSP from the stop of its breakpoint that moves the PC of the SH4", async () => {
    const pcMoves = patched((machine) => {
      const stepDsp = machine.stepDsp.bind(machine);
      machine.stepDsp = () => {
        const fromDspStop = machine.suspended !== undefined;
        stepDsp();
        if (fromDspStop) machine.setRegisterValue("dc.sh4.cpu", "PC", ((machine.values.get("dc.sh4.cpu")!.get("PC") as number) + 2) >>> 0);
      };
    });
    const summary = await s21(pcMoves);
    expect(detailOf(summary, "S21")).toMatch(/^control\.step \{dsp\} from the stop of the breakpoint on step \d+, from a stop of the DSP: the PC of the SH4 moved from 0x[0-9A-F]{8} to 0x[0-9A-F]{8}$/);
  }, 60_000);

  it("broken server 9: DSP breakpoints that ignore their enabled flag, the category dsp, or the twin rule; one added while running that is never armed", async () => {
    const activeWhere = (keep: (breakpoint: Json & { id: number; enabled: boolean; event: string }, machine: Machine) => boolean, lowest = true) =>
      patched((machine) => {
        machine.activeDspBreakpoints = () => {
          const active = new Map<number, number>();
          for (const breakpoint of machine.breakpoints.values()) {
            if (breakpoint.kind !== "code" || breakpoint.event !== "dc.aica.dsp.step" || !keep(breakpoint, machine)) continue;
            const known = active.get(breakpoint.address!);
            if (known === undefined || (lowest ? breakpoint.id < known : breakpoint.id > known)) active.set(breakpoint.address!, breakpoint.id);
          }
          return active;
        };
      });
    const disabled = await s21(activeWhere((breakpoint, machine) => machine.isActive({ ...breakpoint, enabled: true })));
    expect(detailOf(disabled, "S21")).toMatch(/^a disabled breakpoint on step \d+ of the DSP: the target stopped \(#\d+ paused stop \d+ breakpoint bp \d+\)$/);
    const muted = await s21(activeWhere((breakpoint) => breakpoint.enabled));
    expect(detailOf(muted, "S21")).toMatch(/^a breakpoint on step \d+ of the DSP while the category dsp is muted: the target stopped /);
    const twins = await s21(activeWhere((breakpoint, machine) => machine.isActive(breakpoint), false));
    expect(detailOf(twins, "S21")).toMatch(/^a resume to two breakpoints on one step: the stop reports breakpointId (\d+), expected (\d+)$/);
    const late = patched((machine) => {
      const unarmed = new Set<number>();
      const addBreakpoint = machine.addBreakpoint.bind(machine);
      machine.addBreakpoint = (params, context) => {
        if (machine.running) unarmed.add(machine.nextBreakpointId);
        return addBreakpoint(params, context);
      };
      const activeDspBreakpoints = machine.activeDspBreakpoints.bind(machine);
      machine.activeDspBreakpoints = () => new Map(Array.from(activeDspBreakpoints()).filter(([, id]) => !unarmed.has(id)));
    });
    const never = await s21(late);
    expect(detailOf(never, "S21")).toMatch(/^a paused tick at the DSP breakpoint on step \d+ that was added while the target runs: not seen within 2000 ms/);
  }, 120_000);

  it("the refusals: step 128 accepted, a step while running accepted, step over and step out of the DSP accepted (the ARM7 clocked: asked at the end)", async () => {
    const accepting = (matches: (request: Json, running: boolean) => boolean): FaultSource => () => {
      const watch = watchingEnabled();
      return { toClient: watch.toClient, answer: (request) => (matches(request, watch.state.running) ? { jsonrpc: "2.0", id: request.id, result: {} } : undefined) };
    };
    for (const [matches, message] of [
      [(request: Json) => request.method === "breakpoints.add" && paramsOf(request).address === 128, /^breakpoints\.add \{"event":"dc\.aica\.dsp\.step","address":128\}: expected the error -32602, got the result \{\}/],
      [(request: Json, running: boolean) => request.method === "control.step" && paramsOf(request).target === "dsp" && running, /^control\.step \{"target":"dsp"\}: expected the error -32003, got the result \{\}/],
      [(request: Json) => request.method === "control.stepOver" && paramsOf(request).target === "dsp", /^control\.stepOver \{"target":"dsp"\}: expected the error -32004, got the result \{\}/],
      [(request: Json) => request.method === "control.stepOut" && paramsOf(request).target === "dsp", /^control\.stepOut \{"target":"dsp"\}: expected the error -32004, got the result \{\}/],
    ] as const) {
      const summary = await s21(undefined, accepting(matches));
      expect(detailOf(summary, "S21")).toMatch(message);
    }
  }, 120_000);

  it("a step of the DSP that makes two; 16 lines at STEP that are not the full read's, or 15 of them", async () => {
    const two = patched((machine) => {
      const stepDsp = machine.stepDsp.bind(machine);
      machine.stepDsp = () => {
        stepDsp();
        stepDsp();
      };
    });
    expect(firstOf(await s21(two), "S21")).toBe("control.step {dsp}: from step 0 it ended at step 2, expected 1");
    /** the answers to state.getDisassembly {dsp} for 16 lines, rewritten */
    const sixteen = (rewrite: (lines: Json[]) => Json[]): FaultSource => () => {
      const asked = new Set<unknown>();
      return {
        toServer: (frame) => {
          if (frame.method === "state.getDisassembly" && paramsOf(frame).target === "dsp" && paramsOf(frame).count === 16) asked.add(frame.id);
          return frame;
        },
        toClient: (frame) => (frame.method === undefined && asked.has(frame.id) ? { ...frame, result: { lines: rewrite((frame.result as { lines: Json[] }).lines) } } : frame),
      };
    };
    const emptied = sixteen((lines) => lines.map((line, position) => (position === 3 ? { ...line, bytes: "00 00 00 00 00 00 00 00", disassembly: `MPRO[${line.address as number}] = TRA:0` } : line)));
    expect(firstOf(await s21(undefined, emptied), "S21")).toMatch(/^dsp: step \d+ reads differently in two requests while the target is paused$/);
    const fifteen = sixteen((lines) => lines.slice(0, 15));
    expect(firstOf(await s21(undefined, fifteen), "S21")).toMatch(/^15 lines of DSP disassembly for count 16 at step \d+$/);
  }, 60_000);

  it("the stop of a DSP breakpoint: with another reason, at another step; a resume from it that runs the SH4 two periods; one added while running that stops otherwise", async () => {
    // reason "event" (a breakpointId may come with it: no invariant tells)
    const reason = patched((machine) => {
      const enterStop = machine.enterStop.bind(machine);
      machine.enterStop = (stop, breakpointId, fallbackStep) => enterStop(stop === "breakpoint" && machine.suspended ? "event" : stop, breakpointId, fallbackStep);
    });
    expect(firstOf(await s21(reason), "S21")).toBe('a resume: the stop has reason "event", expected "breakpoint"');
    // the paused ticks of a breakpoint's stop with STEP one on
    const shifted: Faults = {
      toClient: (frame) => {
        if (!isTick(frame) || frame.params.executionState.reason !== "breakpoint" || !frame.params.registers["dc.aica.dsp"]) return frame;
        const dsp = frame.params.registers["dc.aica.dsp"].map((register) =>
          register.name === "STEP" ? { ...register, value: `0x${(Number.parseInt(String(register.value), 16) + 1).toString(16).toUpperCase().padStart(2, "0")}` } : register,
        );
        return { ...frame, params: { ...frame.params, registers: { ...frame.params.registers, "dc.aica.dsp": dsp } } };
      },
    };
    const at = /^a resume: the stop is at step (\d+), the breakpoint at step (\d+)$/.exec(firstOf(await s21(undefined, shifted), "S21"));
    expect(at).not.toBeNull();
    expect(Number(at![1])).toBe(Number(at![2]) + 1);
    // a resume from the stop of a DSP breakpoint, the breakpoint still active, that lets the SH4 run two periods more
    const longer = patched((machine) => {
      const leaveStop = machine.leaveStop.bind(machine);
      machine.leaveStop = () => {
        const suspended = machine.suspended;
        if (!machine.running && suspended?.exempt && machine.stopBreakpointId !== undefined && machine.activeDspBreakpoints().get(suspended.step) === machine.stopBreakpointId) {
          machine.setCycles(machine.cycles + 2n * PERIOD);
          machine.nextBurst += 2n * PERIOD;
        }
        leaveStop();
      };
    });
    expect(firstOf(await s21(longer), "S21")).toMatch(
      /^a resume from the stop of a DSP breakpoint to its stop one sample later grew dc\.timing\.SH4_CYCLES by \d+; at most one period of the AICA and the rest of a slice \(145572\)$/,
    );
    // a breakpoint added while running: the server pauses at the add
    const pausesAtTheAdd = patched((machine) => {
      const addBreakpoint = machine.addBreakpoint.bind(machine);
      machine.addBreakpoint = (params, context) => {
        const running = machine.running;
        const added = addBreakpoint(params, context);
        if (running) context.afterResponse.push(() => machine.enterStop("pause"));
        return added;
      };
    });
    expect(firstOf(await s21(pausesAtTheAdd), "S21")).toMatch(/^the breakpoint on step \d+ added while running: the stop is #\d+ paused stop \d+ pause at step \d+$/);
  }, 120_000);

  it("the nine datapath registers missing from the paused ticks: from the tree and every tick alike, or from the ticks of a breakpoint's stop", async () => {
    const nine = "ACC Y_REG FRC_REG ADRS_REG LATCH LATCH_COPY MEMVAL NOFL_PIPE MIXS_BANK";
    const four = (registers: Json[]) => registers.slice(0, 4);
    const everywhere = describing(
      (result) => ({ ...result, deviceTree: mapNodes(result.deviceTree, (node) => (node.path === "dc.aica.dsp" ? { ...node, registers: four(node.registers as Json[]) } : node)) }),
      (registers) => (registers["dc.aica.dsp"] ? { ...registers, "dc.aica.dsp": four(registers["dc.aica.dsp"]) } : registers),
    );
    const consistent = await s21(undefined, everywhere);
    expect(firstOf(consistent, "S21")).toMatch(new RegExp(`^the paused tick #\\d+ paused stop \\d+ .+ has no ${nine} in dc\\.aica\\.dsp; from M3 every paused tick has the nine datapath registers \\(M3-D25\\)$`));
    // (the tree and the ticks agree: only S21 tells)
    expect(consistent.invariantViolations).toEqual([]);
    const atBreakpoints: Faults = {
      toClient: (frame) =>
        isTick(frame) && frame.params.executionState.reason === "breakpoint" && frame.params.registers["dc.aica.dsp"]
          ? { ...frame, params: { ...frame.params, registers: { ...frame.params.registers, "dc.aica.dsp": four(frame.params.registers["dc.aica.dsp"]) } } }
          : frame,
    };
    expect(firstOf(await s21(undefined, atBreakpoints), "S21")).toMatch(
      new RegExp(`^the paused tick #\\d+ paused stop \\d+ breakpoint bp \\d+ has no ${nine} in dc\\.aica\\.dsp; from M3 every paused tick has the nine datapath registers \\(M3-D25\\)$`),
    );
  }, 60_000);

  it("the text rule of S10 on the 128 steps, and the program wait taken as far as five times", async () => {
    const fabricated: Faults = {
      toClient: (frame) => {
        const lines = (frame.result as { lines?: Array<Json & { address: number; disassembly: string }> } | undefined)?.lines;
        return lines?.length === 128 ? { ...frame, result: { lines: lines.map((line) => (line.address === 3 ? { ...line, disassembly: "MPRO[3] = YSEL IWT IWA:1" } : line)) } } : frame;
      },
    };
    const text = await s21(undefined, fabricated);
    expect(detailOf(text, "S21")).toMatch(/^dsp: step 3 reads "MPRO\[3\] = YSEL IWT IWA:1"; the playground's line of its bytes 00 00 40 42 00 50 00 00 is "MPRO\[3\] = YSEL:2 IWT IWA:1 FRCL SHIFT:1"/);
    // a program that never comes: five times a second of running, and the scenario fails
    let resumes = 0;
    const never: FaultSource = () => {
      const faults = emulatorOnTheGuest();
      return {
        ...faults,
        toServer: (frame) => {
          if (frame.method === "control.runUntil") resumes++;
          return frame;
        },
      };
    };
    const empty = await s21(ANCHORED, never);
    expect(firstOf(empty, "S21")).toBe("every step of the DSP is empty (all MPRO words are zero) after five times a second of running: the DSP test program loads a DSP program");
    expect(resumes).toBe(5);
  }, 120_000);
});

describe("the runs of the gate of M3, and the options that came with it", () => {
  it("--dsp-program selects S00, S17 and S21, and S21 is in no other run", () => {
    expect(scenariosOfMilestone("M3", "emulator", true)).toEqual(["S00", "S17", "S21"]);
    expect(scenariosOfMilestone("M3", "mock", true)).toEqual(["S17", "S21"]);
    expect(scenariosOfMilestone("M3", "mock")).not.toContain("S21");
    expect(scenariosOfMilestone("M3", "mock")).toContain("S17");
    expect(selectScenarios({ profile: "emulator", milestone: "M3", dspProgram: true, only: new Set(["S00", "S21"]) })).toEqual({ selected: ["S00", "S21"], required: ["S00", "S21"] });
    expect(SCENARIOS.find((scenario) => scenario.id === "S17")?.parts).toEqual(["sgcCapture", "memoryBinary"]);
  });

  it("the mock the runner starts for --dsp-program is at its stop of the start with its ARM7 held: the two runs make their notes", async () => {
    const lines: string[] = [];
    const whole = await runContract({ profile: "mock", milestone: "M3", dspProgram: true, requireNotes: [M3_NOTES.sgcHeld], say: (line) => lines.push(line) });
    expect(lines[0]).toMatch(/^mock debugger started in this process at ws:\S+, paused at its start with its ARM7 held$/);
    expect(lines).toContain("initial state: #0 paused stop 1 start; profile mock, timeouts x1");
    // (whether S21 still meets the ARM7 held behind S17's captures depends on how many emulation
    // steps of 16 ms of real time they ran: either is right)
    expect(reportOf(whole)).toEqual([`S17 passed ${M3_NOTES.sgcHeld}`, expect.stringMatching(/^S21 passed (dsp: stepped with the arm7 held)?$/)]);
    expect(whole.ok).toBe(true);
    const alone = await runContract({ profile: "mock", milestone: "M3", dspProgram: true, only: new Set(["S00", "S21"]), requireNotes: [M3_NOTES.dspHeld] });
    expect(reportOf(alone)).toEqual([`S21 passed ${M3_NOTES.dspHeld}`]);
    expect(alone.ok).toBe(true);
  }, 120_000);

  it("npm run check runs the gate of M3 on the default mock and on m3 with the note of S16, and the two runs of --dsp-program with their notes", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    const runs = pkg.scripts.check.split(" && ").filter((step) => step.startsWith("npm run contract"));
    expect(runs).toEqual([
      'npm run contract -- --milestone M3 --require-note "arm7: bl stepped over and out"',
      'npm run contract -- --milestone M3 --mock-support m3 --require-note "arm7: bl stepped over and out"',
      `npm run contract -- --milestone M3 --dsp-program --require-note "${M3_NOTES.sgcHeld}"`,
      `npm run contract -- --milestone M3 --dsp-program --only S00,S21 --require-note "${M3_NOTES.dspHeld}"`,
    ]);
  });

  it("--mock-support m3 on the command line", async () => {
    const cli = (args: string[]): Promise<{ code: number | null; output: string }> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "--tsconfig", "tsconfig.scripts.json", "scripts/contract-test.ts", ...args], { stdio: ["ignore", "pipe", "pipe"] });
        const chunks: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
        child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, output: Buffer.concat(chunks).toString("utf8") }));
      });
    const m3 = await cli(["--mock-support", "m3", "--milestone", "M3", "--only", "S01"]);
    expect(m3.output).toMatch(/^mock debugger started in this process at ws:\S+, as a server of milestone M3$/m);
    expect(m3.code).toBe(0);
    const wrong = await cli(["--mock-support", "m4"]);
    expect(wrong.output).toMatch(/^contract: Error: --mock-support is m1, m2 or m3, not "m4"$/m);
    expect(wrong.code).toBe(2);
  }, 120_000);
});
