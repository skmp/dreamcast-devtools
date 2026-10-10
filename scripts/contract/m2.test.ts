import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { MOCK_ARM7_CALL, MOCK_ARM7_LEAF, MOCK_ARM7_RING, MOCK_M1_SUPPORT, MOCK_M2_SUPPORT, MockDebugger, mockStoreOf } from "../../server/mockDebugger";
import type { MockDebuggerOptions } from "../../server/mockDebugger";
import { M2_DEVICE_TREE, REGISTER_PANEL_IDS } from "./design";
import { isArmControlFlow } from "./disasm";
import { runContract } from "./run";
import type { ContractOptions, ContractSummary } from "./run";
import { ARM7_NOTES, SCENARIOS, scenariosOfMilestone, selectScenarios } from "./scenarios";
import { ask, closeServers, describing, inBand, isTick, mapNodes, noTickAfter, paramsOf, reportOf, rpcError, startServer, tickBeforeResponse } from "./testSupport";
import type { FaultSource, Faults, Json } from "./testSupport";

/**
 * The rules milestone M2 added to the runner (the cut of the M2 round, 3.1 item 3). Each has a
 * server that breaks it, which the runner has to fail with the line that says so, and where
 * the rule leaves a server a choice, a server that takes the other one and has to pass. A
 * broken server is the mock with one method patched, or the mock behind a proxy.
 */

afterEach(closeServers);

/** What the tests reach into of the mock's machine. */
interface Machine {
  running: boolean;
  cycles: bigint;
  stopBreakpointId: number | undefined;
  arm7Temporary: number | undefined;
  arm7HeldFor: number | undefined;
  nextBreakpointId: number;
  values: Map<string, Map<string, unknown>>;
  breakpoints: Map<number, Json & { id: number; event: string; enabled: boolean; address?: number }>;
  watches: Map<number, unknown>;
  categories: Map<string, { muted: boolean; soloed: boolean }>;
  written: Map<number, number>;
  clients: Map<number, unknown>;
  memoryByte(target: string, address: number): number;
  advance(target: string): { wrapped: boolean; returned?: boolean };
  setCycles(cycles: bigint): void;
  setSh4Sr(value: number): void;
  setRegisterValue(path: string, name: string, value: unknown): void;
  acceptSh4Interrupt(): unknown;
  enterStop(reason: string, breakpointId?: number, fallbackStep?: boolean): void;
  leaveStop(): void;
  isActive(breakpoint: { id: number; event: string; enabled: boolean }): boolean;
  codeBreakpointAtPc(target: string): number | undefined;
  sameAddress(target: string, a: number, b: number): boolean;
  step(kind: string, params: { target?: string }, context: RequestContext): unknown;
  setRegister(params: Json, context: RequestContext): unknown;
  writeRegister(path: string, register: { name: string; width: number }, text: string): void;
  writeMemory(params: { target: string; address: number; data: number[] }, context: RequestContext): unknown;
  writtenSh4Instruction(address: number): unknown;
  addBreakpoint(params: Json, context: RequestContext): unknown;
  reset(context: RequestContext): unknown;
  callstack(target: string, maxFrames: number): Json[];
  registersOf(path: string): Json[];
  describedRegistersOf(path: string): Json[];
  buildTick(full: boolean): Json;
  sendTick(client: unknown, tick: Json): void;
  emulationStep(): void;
}
interface RequestContext {
  client: unknown;
  afterResponse: Array<() => void>;
}

/** The mock with its machine patched: a server that does one thing wrong, or one thing its own way. */
const patched = (patch: (machine: Machine, mock: MockDebugger) => void, options: MockDebuggerOptions = {}): MockDebugger => {
  const mock = new MockDebugger(options);
  patch(mock as unknown as Machine, mock);
  return mock;
};
const arm7Pc = (machine: Machine) => machine.values.get("dc.aica.arm7")!.get("PC") as number;
const sh4Pc = (machine: Machine) => machine.values.get("dc.sh4.cpu")!.get("PC") as number;

/** One part of S16 against a server: its result, and what the scenario noted. */
const part = async (key: string, server?: MockDebugger | MockDebuggerOptions, faults?: FaultSource, more: Partial<ContractOptions> = {}) => {
  const { url, mock } = await startServer(faults, server);
  const summary = await runContract({ url, profile: "mock", only: new Set(["S16"]), parts: new Map([["S16", new Set([key])]]), ...more });
  const scenario = summary.scenarios[0];
  return { summary, mock, result: scenario.parts?.[0], notes: scenario.notes, detail: scenario.parts?.[0]?.detail ?? "" };
};
const passed = (key: string) => ({ name: key, status: "passed" });
const HEX = "0x[0-9A-F]{8}";

describe("S16, part arm7: the start", () => {
  it("the three notes of the part are an interface to the emulator's contract targets: verbatim", () => {
    expect(ARM7_NOTES).toEqual({
      held: "arm7: held at the start",
      clocked: "arm7: clocked at the start",
      calls: "arm7: bl stepped over and out",
    });
  });

  it("the mock passes: clocked at the start, and a call stepped over and out of", async () => {
    const { result, notes } = await part("arm7");
    expect(result).toEqual(passed("arm7"));
    expect(notes).toEqual(["arm7: clocked at the start", "arm7: bl stepped over and out"]);
  }, 60_000);

  it("an ARM7 that is held at the start: its three steps are probed for -32012, a breakpoint is accepted, and the part settles", async () => {
    const asked: string[] = [];
    const watching: Faults = {
      toServer: (frame) => {
        if (/^control\.step/.test(String(frame.method)) && paramsOf(frame).target === "arm7") asked.push(String(frame.method));
        return frame;
      },
    };
    const { result, notes } = await part("arm7", { arm7Held: true, startPaused: true }, watching);
    expect(result).toEqual(passed("arm7"));
    expect(notes).toEqual(["arm7: held at the start", "arm7: bl stepped over and out"]);
    // the three probes come first, in front of every other step of the part
    expect(asked.slice(0, 3)).toEqual(["control.step", "control.stepOver", "control.stepOut"]);

    // a held ARM7 whose step is answered {}: the -32012 half is not passed over
    const lenient = await part("arm7", { arm7Held: true, startPaused: true }, {
      answer: (request) => (request.method === "control.stepOver" && paramsOf(request).target === "arm7" ? { jsonrpc: "2.0", id: request.id, result: {} } : undefined),
    });
    expect(lenient.detail).toBe('control.stepOver {"target":"arm7"}: expected the error -32012, got the result {}');
    // ... and one that refuses a breakpoint while it is held (the code is for the steps alone)
    const noBreakpoint = await part(
      "arm7",
      patched((machine) => {
        const add = machine.addBreakpoint.bind(machine);
        machine.addBreakpoint = (params, context) => {
          if (params.event === "dc.aica.arm7.pc" && machine.arm7HeldFor !== undefined) throw Object.assign(new Error("held"), { code: -32012 });
          return add(params, context);
        };
      }, { arm7Held: true, startPaused: true }),
    );
    expect(noBreakpoint.result?.status).toBe("failed");
    expect(noBreakpoint.detail).toMatch(/^breakpoints\.add \{"event":"dc\.aica\.arm7\.pc","kind":"code","address":0\}: in-band error /);
  }, 90_000);

  it("an ARM7 that is never released fails the part, which says so", async () => {
    const never = patched((machine) => {
      machine.arm7HeldFor = Number.POSITIVE_INFINITY;
    }, { arm7Held: true });
    const { result, notes } = await part("arm7", never);
    expect(result).toEqual({
      name: "arm7",
      status: "failed",
      detail: "the ARM7 was not released: dc.aica.arm7.ENABLED did not read 1 in a running tick within 5000 ms of the resume",
    });
    expect(notes).toEqual(["arm7: held at the start"]);
  }, 60_000);

  it("an ARM7 that is released, held and released again while the guest starts: the part settles behind it", async () => {
    // held once more a few steps behind its first release: ENABLED reads 1, 0 and 1 in the running ticks of the settling
    const twice = patched((machine, mock) => {
      const emulationStep = machine.emulationStep.bind(machine);
      let again = 6;
      machine.emulationStep = () => {
        const held = machine.arm7HeldFor !== undefined;
        emulationStep();
        if (machine.running && !held && again > 0 && --again === 0) mock.holdArm7();
      };
      // (released for 250 ms, and then held for as long again)
      const hold = mock.holdArm7.bind(mock);
      mock.holdArm7 = () => {
        hold();
        machine.arm7HeldFor = 16;
      };
    }, { arm7Held: true, startPaused: true });
    const settled = await part("arm7", twice);
    expect(settled.result).toEqual(passed("arm7"));
    expect(settled.notes).toEqual(["arm7: held at the start", "arm7: bl stepped over and out"]);

    // Held again when the part has settled and makes its first step: the step answers -32012,
    // and the part starts over from a settling, once.
    const heldAtStep = (times: number) =>
      patched((machine, mock) => {
        const step = machine.step.bind(machine);
        let left = times;
        machine.step = (kind, params, context) => {
          if (params.target === "arm7" && !machine.running && machine.arm7HeldFor === undefined && left > 0) {
            left--;
            mock.holdArm7();
          }
          return step(kind, params, context);
        };
      });
    const once = await part("arm7", heldAtStep(1));
    expect(once.result).toEqual(passed("arm7"));
    expect(once.notes).toEqual(["arm7: clocked at the start", "arm7: bl stepped over and out"]);
    const more = await part("arm7", heldAtStep(2));
    expect(more.detail).toBe("control.step {arm7} answered -32012: the ARM7 is held in reset, also behind a second settling");
  }, 120_000);

  it("a PC of the ARM7 above its last address is no place to step from: the part settles, and fails when that does not help", async () => {
    // The ARM7 of a guest that runs through the top of its address space for a while (2ndmix
    // does): the PC reads 0xFFFFFFE8, where no line can be asked for. It comes back to its loop
    // a few steps into the settling.
    const through = (steps: number) =>
      patched((machine) => {
        machine.values.get("dc.aica.arm7")!.set("PC", 0xffffffe8);
        const advance = machine.advance.bind(machine);
        let left = steps;
        machine.advance = (target) => {
          if (target !== "arm7" || arm7Pc(machine) < 0x01000000) return advance(target);
          if (machine.running && --left <= 0) machine.values.get("dc.aica.arm7")!.set("PC", MOCK_ARM7_RING.base);
          return { wrapped: false };
        };
      }, { startPaused: true });
    const back = await part("arm7", through(4));
    expect(back.result).toEqual(passed("arm7"));
    expect(back.notes).toEqual(["arm7: clocked at the start", "arm7: bl stepped over and out"]);

    const stays = await part("arm7", through(Number.POSITIVE_INFINITY));
    expect(stays.detail).toBe(
      "the ARM7 did not settle: after five settlings a paused tick still does not show it clocked at an address of its own (the PC of the ARM7 is 0xFFFFFFE8, above its last address 0x00FFFFFF)",
    );
  }, 120_000);
});

describe("S16, part arm7: steps and breakpoints", () => {
  it("a disabled or a muted breakpoint of the ARM7 that stops the target, and a twin that is reported under the higher id", async () => {
    const ignoring = (what: "enabled" | "muted") =>
      patched((machine) => {
        const isActive = machine.isActive.bind(machine);
        machine.isActive = (breakpoint) => {
          if (breakpoint.event !== "dc.aica.arm7.pc") return isActive(breakpoint);
          return what === "enabled" ? true : breakpoint.enabled;
        };
      });
    expect((await part("arm7", ignoring("enabled"))).detail).toMatch(new RegExp(`^a disabled breakpoint of the ARM7 at ${HEX}: the target stopped \\(#\\d+ paused stop \\d+ breakpoint bp \\d+\\)$`));
    expect((await part("arm7", ignoring("muted"))).detail).toMatch(
      new RegExp(`^a breakpoint of the ARM7 at ${HEX} while the category arm7 is muted: the target stopped \\(#\\d+ paused stop \\d+ breakpoint bp \\d+\\)$`),
    );
    const highest = patched((machine) => {
      const hit = machine.codeBreakpointAtPc.bind(machine);
      machine.codeBreakpointAtPc = (target) => {
        const lowest = hit(target);
        if (target !== "arm7" || lowest === undefined) return lowest;
        const address = machine.breakpoints.get(lowest)!.address;
        return Math.max(...Array.from(machine.breakpoints.values()).filter((breakpoint) => breakpoint.event === "dc.aica.arm7.pc" && breakpoint.address === address && breakpoint.enabled).map((breakpoint) => breakpoint.id));
      };
    });
    expect((await part("arm7", highest)).detail).toMatch(/^the stop reports breakpointId (\d+), expected (\d+)$/);
  }, 120_000);

  it("a breakpoint address of the ARM7 is a multiple of 4 up to 0x00FFFFFF: one that is accepted beyond that fails", async () => {
    const accepting = (address: number): Faults => ({
      answer: (request) => (request.method === "breakpoints.add" && paramsOf(request).address === address ? { jsonrpc: "2.0", id: request.id, result: {} } : undefined),
    });
    expect((await part("arm7", undefined, accepting(2))).detail).toBe('breakpoints.add {"event":"dc.aica.arm7.pc","address":2}: expected the error -32602, got the result {}');
    expect((await part("arm7", undefined, accepting(0x01000000))).detail).toBe(
      'breakpoints.add {"event":"dc.aica.arm7.pc","address":16777216}: expected the error -32602, got the result {}',
    );
  }, 60_000);

  it("the time of the SH4 across a step of the ARM7: it does not go back, and grows by two periods of the AICA callback at most", async () => {
    /** The mock whose paused step of the ARM7 moves the time of the SH4 by `by(n)` cycles, n counting those steps. */
    const moving = (by: (n: number, machine: Machine) => bigint, pc = false) =>
      patched((machine) => {
        const advance = machine.advance.bind(machine);
        let steps = 0;
        machine.advance = (target) => {
          if (target === "arm7" && !machine.running) {
            machine.setCycles(machine.cycles + by(++steps, machine));
            if (pc) advance("sh4");
          }
          return advance(target);
        };
      });
    expect((await part("arm7", moving(() => -448n))).detail).toMatch(/^dc\.timing\.SH4_CYCLES went back from \d+ to \d+ across a step of the ARM7$/);
    expect((await part("arm7", moving(() => 3n * 145124n))).detail).toBe(
      "dc.timing.SH4_CYCLES grew by 435372 across control.step {arm7}, more than two periods of the AICA callback (2 x 145124): from a stop outside a sound burst the SH4 runs to the next burst and no further",
    );
    // Two periods are what a step from a stop outside a sound burst may take (the SH4 runs to the
    // next burst) ... but not a step from the stop of an ARM7 breakpoint: a burst is suspended
    // there, the step stays inside it, and the SH4 executes nothing.
    const atBreakpoint = (machine: Machine) => machine.stopBreakpointId !== undefined;
    expect((await part("arm7", moving((_n, machine) => (atBreakpoint(machine) ? 0n : 2n * 145124n)))).result).toEqual(passed("arm7"));
    expect((await part("arm7", moving(() => 448n))).detail).toMatch(
      /^control\.step \{arm7\} from the stop of an ARM7 breakpoint moved dc\.timing\.SH4_CYCLES from \d+ to \d+; the step stays inside the sound burst that is suspended there, and the SH4 does not execute$/,
    );
    expect((await part("arm7", moving(() => 0n, true))).detail).toMatch(
      new RegExp(`^control\\.step \\{arm7\\} from the stop of an ARM7 breakpoint moved the PC of dc\\.sh4\\.cpu from ${HEX} to ${HEX}; the SH4 does not execute in it$`),
    );
  }, 180_000);

  it("a step from the stop of an ARM7 breakpoint that reports the breakpoint again", async () => {
    const again = patched((machine) => {
      const step = machine.step.bind(machine);
      machine.step = (kind, params, context) => {
        const id = machine.stopBreakpointId;
        if (params.target !== "arm7" || kind !== "step" || machine.running || id === undefined) return step(kind, params, context);
        // nothing executes: the breakpoint the target stands at stops it once more
        context.afterResponse.push(() => machine.enterStop("breakpoint", id));
        return {};
      };
    });
    expect((await part("arm7", again)).detail).toBe('control.step {arm7}: the stop has reason "breakpoint", expected "step"');
  }, 60_000);

  it("a breakpoint of the ARM7 that is added while the target runs and never arms", async () => {
    const unarmed = patched((machine) => {
      const late = new Set<number>();
      const add = machine.addBreakpoint.bind(machine);
      machine.addBreakpoint = (params, context) => {
        if (machine.running && params.event === "dc.aica.arm7.pc") late.add(machine.nextBreakpointId);
        return add(params, context);
      };
      const isActive = machine.isActive.bind(machine);
      machine.isActive = (breakpoint) => !late.has(breakpoint.id) && isActive(breakpoint);
    });
    expect((await part("arm7", unarmed)).detail).toMatch(
      new RegExp(`^a paused tick at the ARM7 breakpoint ${HEX} that was added while the target runs: not seen within 2000 ms; ticks since then: \\d+`),
    );
  }, 60_000);

  it("breakpoints of the ARM7 that are compared without the mask of the wave memory, and a stop that shows the breakpoint's address as the PC", async () => {
    const exact = patched((machine) => {
      const same = machine.sameAddress.bind(machine);
      machine.sameAddress = (target, a, b) => (target === "arm7" ? a === b : same(target, a, b));
    });
    expect((await part("arm7", exact)).detail).toMatch(
      new RegExp(`^a paused tick at the breakpoint (0x00A0[0-9A-F]{4}), which is ${HEX} under the mask of the wave memory: not seen within 2000 ms; `),
    );
    // the PC of the tick is the PC as it is, not the address the breakpoint was given
    const asGiven: Faults = {
      toClient: (frame) => {
        if (!isTick(frame)) return frame;
        const id = frame.params.executionState.breakpointId as number | undefined;
        const address = id === undefined ? undefined : ((frame.params.breakpoints as Record<string, Json>)[String(id)]?.address as number | undefined);
        if (address === undefined || address < 0x00800000 || address > 0x00ffffff) return frame;
        const value = `0x${address.toString(16).toUpperCase().padStart(8, "0")}`;
        const registers = { ...frame.params.registers, "dc.aica.arm7": frame.params.registers["dc.aica.arm7"].map((register) => (register.name === "PC" ? { ...register, value } : register)) };
        const callstacks = frame.params.callstacks as { sh4: Json[]; arm7: Json[] };
        return { ...frame, params: { ...frame.params, registers, callstacks: { ...callstacks, arm7: callstacks.arm7.map((entry) => (entry.index === 0 ? { ...entry, pc: address } : entry)) } } };
      },
    };
    expect((await part("arm7", undefined, asGiven)).detail).toMatch(
      new RegExp(`^the stop of the breakpoint at (0x00A0[0-9A-F]{4}) shows the PC \\1; a tick has the PC as it is, ${HEX}$`),
    );
  }, 60_000);

  it("a step of the ARM7 while the target runs is -32003, and control.stepOver on a line that is no call is a step", async () => {
    const whileRunning: Faults = (() => {
      let running = false;
      return {
        toClient: (frame) => {
          if (isTick(frame)) running = frame.params.executionState.state === "running";
          return frame;
        },
        answer: (request) => (running && request.method === "control.stepOut" && paramsOf(request).target === "arm7" ? inBand(request, -32012, "arm7 held in reset") : undefined),
      } satisfies Faults;
    })();
    expect((await part("arm7", undefined, whileRunning)).detail).toBe('control.stepOut {"target":"arm7"}: expected the error -32003, got -32012 "arm7 held in reset"');

    // a step-over that resumes on a line that is no call: the running tick says so
    const resumes = patched((machine) => {
      const step = machine.step.bind(machine);
      machine.step = (kind, params, context) => {
        if (params.target !== "arm7" || kind !== "stepOver" || machine.running || arm7Pc(machine) === MOCK_ARM7_CALL) return step(kind, params, context);
        context.afterResponse.push(() => {
          machine.leaveStop();
          machine.arm7Temporary = arm7Pc(machine) + 4;
        });
        return {};
      };
    });
    expect((await part("arm7", resumes)).detail).toBe("control.stepOver {arm7}: a running tick arrived before the paused tick of the step");
  }, 60_000);

  it("control.stepOut of the ARM7: a running tick or its stop within 1 s; a stop that is neither a step's nor a breakpoint's fails; no stop at all is the program's business", async () => {
    // nothing follows the request
    const silent = patched((machine) => {
      const step = machine.step.bind(machine);
      machine.step = (kind, params, context) => (params.target === "arm7" && kind === "stepOut" && !machine.running ? {} : step(kind, params, context));
    });
    expect((await part("arm7", silent)).detail).toMatch(/^a running tick, or a paused tick with a new stopId, after control\.stepOut \{arm7\}: not seen within 1000 ms; /);
    // its stop comes with another reason
    const paused = patched((machine) => {
      const step = machine.step.bind(machine);
      machine.step = (kind, params, context) => {
        if (params.target !== "arm7" || kind !== "stepOut" || machine.running) return step(kind, params, context);
        context.afterResponse.push(() => machine.enterStop("pause"));
        return {};
      };
    });
    expect((await part("arm7", paused)).detail).toBe('control.stepOut {arm7}: the stop has reason "pause", expected "step"');
  }, 60_000);

  it("a call: a step-over that stops in the callee, a step-out that stops elsewhere than at R14, and a temporary breakpoint that outlives its stop", async () => {
    const stepsInto = patched((machine) => {
      const step = machine.step.bind(machine);
      machine.step = (kind, params, context) => step(params.target === "arm7" && kind === "stepOver" ? "step" : kind, params, context);
    });
    expect((await part("arm7", stepsInto)).detail).toBe("control.stepOver {arm7} on the call at 0x00200024 ended at 0x00200030, not at 0x00200028");

    // (the step-out from the ring stops where it likes: where the program returns to is not known there)
    const elsewhere = patched((machine) => {
      const step = machine.step.bind(machine);
      machine.step = (kind, params, context) => {
        const result = step(kind, params, context);
        if (params.target === "arm7" && kind === "stepOut" && arm7Pc(machine) === MOCK_ARM7_LEAF.base) {
          context.afterResponse.push(() => {
            machine.arm7Temporary = MOCK_ARM7_CALL + 8;
          });
        }
        return result;
      };
    });
    expect((await part("arm7", elsewhere)).detail).toBe(
      "control.stepOut {arm7} from the first line of the callee at 0x00200030 (R14 is 0x00200028 there) ended at 0x0020002C, not at 0x00200028",
    );

    const outlives = patched((machine) => {
      const enterStop = machine.enterStop.bind(machine);
      machine.enterStop = (reason, breakpointId, fallbackStep) => {
        const temporary = machine.arm7Temporary;
        enterStop(reason, breakpointId, fallbackStep);
        machine.arm7Temporary = temporary;
      };
    });
    const { detail, notes } = await part("arm7", outlives);
    expect(detail).toMatch(/^behind the step-out of the ARM7, with no breakpoint listed \(a temporary breakpoint goes at the stop it makes\): the target stopped \(#\d+ paused stop \d+ step\)$/);
    expect(notes).not.toContain(ARM7_NOTES.calls);
  }, 120_000);

  /** The mock's disassembly with some of its ARM7 lines rewritten. */
  const withLines = (text: (address: number, line: string) => string): Faults => ({
    toClient: (frame) => {
      const lines = (frame.result as { lines?: Array<{ address: number; disassembly: string }> } | undefined)?.lines;
      const arm7 = lines?.every((line) => line.address % 4 === 0 && line.address < 0x01000000 && /^([0-9A-F]{2} ){3}[0-9A-F]{2}$|^\?\?$/.test(String((line as Json).bytes)));
      return lines && arm7 ? { ...frame, result: { lines: lines.map((line) => ({ ...line, disassembly: text(line.address, line.disassembly) })) } } : frame;
    },
  });

  it("a program without a call passes, and says that no bl was reached: a gate that requires the note fails on it", async () => {
    // the mock's ring without its call: the line is a nop, executed as one
    const noCall = () =>
      patched((machine) => {
        const advance = machine.advance.bind(machine);
        machine.advance = (target) => {
          if (target !== "arm7" || arm7Pc(machine) !== MOCK_ARM7_CALL) return advance(target);
          machine.values.get("dc.aica.arm7")!.set("PC", MOCK_ARM7_CALL + 4);
          return { wrapped: false };
        };
        const step = machine.step.bind(machine);
        machine.step = (kind, params, context) => step(params.target === "arm7" && kind === "stepOver" ? "step" : kind, params, context);
      });
    const nop = withLines((address, line) => (address === MOCK_ARM7_CALL ? "nop" : line));
    const { result, notes, summary } = await part("arm7", noCall(), nop);
    expect(result).toEqual(passed("arm7"));
    expect(notes).toEqual(["arm7: clocked at the start", "arm7: no bl was reached within 96 steps: a call was neither stepped over nor out of"]);
    expect(summary).toMatchObject({ ok: true, requiredNotes: [], requiredNotesMissing: [] });

    const lines: string[] = [];
    const required = await part("arm7", noCall(), nop, { requireNotes: [ARM7_NOTES.calls, ARM7_NOTES.clocked], say: (line) => lines.push(line) });
    expect(required.result).toEqual(passed("arm7"));
    expect(required.summary).toMatchObject({ ok: false, passed: 1, failed: 0, requiredNotes: [ARM7_NOTES.calls, ARM7_NOTES.clocked], requiredNotesMissing: [ARM7_NOTES.calls] });
    expect(lines.slice(-3)).toEqual(['required note: no selected scenario noted "arm7: bl stepped over and out"', expect.stringMatching(/^1 passed, 0 failed, /), "contract: FAILED"]);
  }, 120_000);

  it("each arrival at a call has 96 steps of its own: a loop of 81 instructions passes, and an interrupt entered in front of the call is not the step into the callee", async () => {
    // The mock's loop with 70 more instructions behind its branch: 81 a lap, so that each of the
    // two arrivals is some 80 steps from where its search starts. (4 ms a step: a lap is 0.3 s.)
    const STRETCH = 0x00200040;
    const END = STRETCH + 69 * 4;
    const long = patched((machine) => {
      const advance = machine.advance.bind(machine);
      machine.advance = (target) => {
        const pc = arm7Pc(machine);
        if (target !== "arm7" || (pc !== MOCK_ARM7_RING.base + 28 && (pc < STRETCH || pc > END))) return advance(target);
        machine.values.get("dc.aica.arm7")!.set("PC", pc === END ? MOCK_ARM7_RING.base : pc === MOCK_ARM7_RING.base + 28 ? STRETCH : pc + 4);
        return { wrapped: pc === END };
      };
    }, { emulationStepMs: 4 });
    const stretched = withLines((address, line) => (address === MOCK_ARM7_RING.base + 28 ? "b 0x00200040" : address === END ? "b 0x00200010" : address >= STRETCH && address < END ? "nop" : line));
    const far = await part("arm7", long, stretched);
    expect(far.result).toEqual(passed("arm7"));
    expect(far.notes).toContain(ARM7_NOTES.calls);

    // An interrupt that is pending when the ARM7 stands on the call is entered in front of it:
    // the step ends at the vector, the handler returns to the call, and the search goes on.
    const VECTOR = 0x1c;
    const text = (address: number) => (ask(new MockDebugger(), "state.getDisassembly", { target: "arm7", address, count: 1 }).result as { lines: Array<{ disassembly: string }> }).lines[0].disassembly;
    expect([text(VECTOR), text(VECTOR + 4)].map((line) => /^bl\b/.test(line))).toEqual([false, false]);
    const interrupted = patched((machine) => {
      const advance = machine.advance.bind(machine);
      let entries = 2;
      machine.advance = (target) => {
        const pc = arm7Pc(machine);
        if (target !== "arm7") return advance(target);
        // (only in a step that is asked for from the call, and not in the step-over of the first arrival)
        if (pc === MOCK_ARM7_CALL && !machine.running && machine.arm7Temporary === undefined && entries > 0 && entries-- === 1) {
          machine.values.get("dc.aica.arm7")!.set("PC", VECTOR);
          return { wrapped: false };
        }
        if (pc === VECTOR + 4) {
          machine.values.get("dc.aica.arm7")!.set("PC", MOCK_ARM7_CALL);
          return { wrapped: false };
        }
        return advance(target);
      };
    });
    const entered = await part("arm7", interrupted);
    expect(entered.result).toEqual(passed("arm7"));
    expect(entered.notes).toContain(ARM7_NOTES.calls);

    // a step on the call that ends neither in the callee nor at a vector
    const astray = patched((machine) => {
      // (the step that is asked for from the call once the call has been stepped over)
      let steppedOver = false;
      const step = machine.step.bind(machine);
      machine.step = (kind, params, context) => {
        steppedOver ||= params.target === "arm7" && kind === "stepOver" && arm7Pc(machine) === MOCK_ARM7_CALL;
        return step(kind, params, context);
      };
      const advance = machine.advance.bind(machine);
      machine.advance = (target) => {
        if (target !== "arm7" || arm7Pc(machine) !== MOCK_ARM7_CALL || machine.running || !steppedOver) return advance(target);
        machine.values.get("dc.aica.arm7")!.set("PC", MOCK_ARM7_CALL + 4);
        return { wrapped: false };
      };
    });
    expect((await part("arm7", astray)).detail).toBe("the step on the call at 0x00200024 ended at 0x00200028, not at its target 0x00200030 or an exception vector");
  }, 180_000);

  it("an ARM7 step is its stop; where it ends is compared only on a line that is not control flow", async () => {
    /** The mock at its StartPaused stop; `first` is what the first paused step of its ARM7 does in place of executing one instruction. */
    const firstStep = (first: (advance: () => { wrapped: boolean }, machine: Machine) => { wrapped: boolean }) =>
      patched((machine) => {
        const advance = machine.advance.bind(machine);
        let steps = 0;
        machine.advance = (target) => (target === "arm7" && !machine.running && ++steps === 1 ? first(() => advance(target), machine) : advance(target));
      }, { startPaused: true });
    const line = (ask(new MockDebugger(), "state.getDisassembly", { target: "arm7", address: MOCK_ARM7_RING.base, count: 1 }).result as { lines: Array<{ disassembly: string }> }).lines[0].disassembly;
    expect(isArmControlFlow(line)).toBe(false);
    // ... at the next instruction, or at an exception vector: the interrupt that was pending is entered
    const vector = firstStep((_advance, machine) => {
      machine.values.get("dc.aica.arm7")!.set("PC", 0x18);
      // (the handler of this program is one instruction long, a branch, and comes back to the loop)
      const advance = machine.advance.bind(machine);
      machine.advance = (target) => {
        if (target !== "arm7" || arm7Pc(machine) !== 0x18) return advance(target);
        machine.values.get("dc.aica.arm7")!.set("PC", MOCK_ARM7_RING.base);
        return { wrapped: false };
      };
      return { wrapped: false };
    });
    expect((await part("arm7", vector)).result).toEqual(passed("arm7"));
    // a step that executes two instructions, and one that executes none
    const twice = firstStep((advance) => {
      advance();
      return advance();
    });
    expect((await part("arm7", twice)).detail).toBe(`"${line}" at 0x00200010 is not control flow, and the step of arm7 ended at 0x00200018, not at 0x00200014 or an exception vector`);
    expect((await part("arm7", firstStep(() => ({ wrapped: false })))).detail).toBe(
      `"${line}" at 0x00200010 is not control flow, and the step of arm7 ended at 0x00200010, not at 0x00200014 or an exception vector`,
    );
  }, 120_000);
});

describe("S16, part writeMemory", () => {
  const writesTo = (matches: (params: { target: string; address: number; data: number[] }) => boolean, code: number): Faults => ({
    answer: (request) =>
      request.method === "state.writeMemory" && matches(paramsOf(request) as never) ? inBand(request, code, code === -32013 ? "not writable" : "refused") : undefined,
  });

  it("the mock passes, and what the part wrote is back as it was", async () => {
    const { result, mock, notes } = await part("writeMemory", { startPaused: true });
    expect(result).toEqual(passed("writeMemory"));
    expect(notes).toEqual([]);
    // nothing is left of the pattern, the instruction or the 64 KiB: every byte reads what it is fabricated to be
    expect((mock as unknown as Machine).written.size).toBe(0);
    expect((mock as unknown as Machine).values.get("dc.sh4.cpu")!.get("PC")).toBe(0x8c0000a0);
    expect((mock as unknown as Machine).values.get("dc.sh4.cpu")!.get("R0")).toBe(0);
  }, 60_000);

  it("the tick of a write may come in front of its response: the emulator's order passes, in every part that writes and on the second connection of S13", async () => {
    // (the mock sends the tick behind the response, the emulator builds it inside the call and answers behind it)
    for (const key of ["writeMemory", "setRegister", "reset", "arm7"]) {
      const count = { reordered: 0 };
      const { result, notes } = await part(key, { startPaused: true }, () => tickBeforeResponse(count));
      expect(result, key).toEqual(passed(key));
      expect(notes.filter((note) => !note.startsWith("arm7: ")), key).toEqual([]);
      expect(count.reordered, key).toBeGreaterThan(5);
    }
    const count = { reordered: 0 };
    const { url } = await startServer(() => tickBeforeResponse(count));
    expect(reportOf(await runContract({ url, profile: "mock", only: new Set(["S13"]) }))).toEqual(["S13 passed "]);
    expect(count.reordered).toBeGreaterThan(5);
  }, 120_000);

  it("a write without a tick behind it, and a write whose tick is a new stop", async () => {
    const noTick = await part("writeMemory", undefined, () => noTickAfter((request) => request.method === "state.writeMemory"));
    expect(noTick.detail).toMatch(new RegExp(`^a tick behind state\\.writeMemory \\{sh4, ${HEX}, 16 bytes\\}; every accepted write is followed by its tick: not seen within 1000 ms`));
    const newStop = patched((machine) => {
      const write = machine.writeMemory.bind(machine);
      machine.writeMemory = (params, context) => {
        const result = write(params, context);
        context.afterResponse.unshift(() => machine.enterStop("pause"));
        return result;
      };
    });
    expect((await part("writeMemory", newStop)).detail).toMatch(/^the tick behind state\.writeMemory \{sh4, 0x[0-9A-F]{8}, 16 bytes\} is #\d+ paused stop \d+ pause; the target was #\d+ paused stop \d+ pause, and a write is not a new stop$/);
  }, 60_000);

  it("a range is written whole or not at all: a server that stores before it has checked the range", async () => {
    const eager = patched((machine) => {
      const write = machine.writeMemory.bind(machine);
      const key = (MockDebugger as unknown as { storeKey(at: unknown): number }).storeKey;
      machine.writeMemory = (params, context) => {
        params.data.forEach((byte, offset) => {
          const at = mockStoreOf(params.target as "sh4", params.address + offset);
          if (at) machine.written.set(key(at), byte);
        });
        return write(params, context);
      };
    });
    expect((await part("writeMemory", eager)).detail).toBe(
      "a refused write of 16 bytes at 0x0FFFFFF8, across the end of main memory, changed its first half: a range is written whole or not at all",
    );
    // ... and one that accepts the range
    expect((await part("writeMemory", undefined, { answer: (request) => (request.method === "state.writeMemory" && paramsOf(request).address === 0x0ffffff8 ? { jsonrpc: "2.0", id: request.id, result: {} } : undefined) })).detail).toMatch(
      /^state\.writeMemory \{"target":"sh4","address":268435448,"data":\[.*\]\}: expected the error -32013, got the result \{\}$/,
    );
  }, 60_000);

  it("65536 bytes are accepted and change nothing; one more, and a byte that is no byte, are refused", async () => {
    expect((await part("writeMemory", undefined, writesTo((params) => params.data.length === 65536, -32602))).detail).toMatch(/^state\.writeMemory \{"target":"sh4","address":2348875776,"data":\[.{100,}\]\}: in-band error -32602 "refused"$/s);
    const changes: Faults = {
      toServer: (frame) => {
        const data = paramsOf(frame).data as number[] | undefined;
        return frame.method === "state.writeMemory" && data?.length === 65536 ? { ...frame, params: { ...paramsOf(frame), data: data.map((byte, index) => (index === 40000 ? byte ^ 1 : byte)) } } : frame;
      },
    };
    expect((await part("writeMemory", undefined, changes)).detail).toBe("65536 bytes at 0x8C010000 were written back as they read, and 1 of them reads differently: the first one at 0x8C019C40");
    for (const [length, what] of [[65537, /"data":\[.{100,}\]\}: expected the error -32602, got the result \{\}$/s], [1, /"data":\[256\]\}: expected the error -32602, got the result \{\}$/]] as const) {
      const lenient: Faults = {
        answer: (request) => {
          const data = paramsOf(request).data as number[] | undefined;
          return request.method === "state.writeMemory" && data?.length === length && (length > 1 || data[0] === 256) ? { jsonrpc: "2.0", id: request.id, result: {} } : undefined;
        },
      };
      expect((await part("writeMemory", undefined, lenient)).detail).toMatch(what);
    }
  }, 120_000);

  it("the target is required, and dsp is the method's own -32004: a server that answers -32602 for it, or writes without a target", async () => {
    expect((await part("writeMemory", undefined, writesTo((params) => params.target === "dsp", -32602))).detail).toBe(
      'state.writeMemory {"target":"dsp","address":0,"data":[0]}: expected the error -32004, got -32602 "refused"',
    );
    const defaults: Faults = { toServer: (frame) => (frame.method === "state.writeMemory" && paramsOf(frame).target === undefined ? { ...frame, params: { ...paramsOf(frame), target: "sh4" } } : frame) };
    expect((await part("writeMemory", undefined, defaults)).detail).toMatch(/^state\.writeMemory \{"address":\d+,"data":\[.*\]\}: expected the error -32602, got the result \{\}$/);
  }, 60_000);

  it("wave memory is one store behind both targets, and video memory one view behind its addresses: refused, or stored at one address only", async () => {
    expect((await part("writeMemory", undefined, writesTo((params) => params.target === "sh4" && params.address === 0x00800000, -32013))).detail).toBe(
      'state.writeMemory {"target":"sh4","address":8388608,"data":[' + String((new MockDebugger() as unknown as Machine).memoryByte("arm7", 0) ^ 0x5a) + ']}: in-band error -32013 "not writable"',
    );
    expect((await part("writeMemory", undefined, writesTo((params) => params.target === "arm7", -32013))).detail).toMatch(/^state\.writeMemory \{"target":"arm7","address":0,"data":\[\d+\]\}: in-band error -32013 "not writable"$/);
    // two memories where there is one: what the ARM7 wrote is not what the SH4 reads
    const apart = patched((machine) => {
      const read = machine.memoryByte.bind(machine);
      const untouched = (new MockDebugger() as unknown as Machine).memoryByte("arm7", 0);
      (machine as { memoryByte: Machine["memoryByte"] }).memoryByte = (target, address) => (target === "sh4" && (address & 0x1fffffff) === 0x00800000 ? untouched : read(target, address));
    });
    expect((await part("writeMemory", apart)).detail).toMatch(/^a byte of wave memory written through the ARM7's 0x00000000 as \d+ reads \d+ through the SH4's 0x00800000$/);

    expect((await part("writeMemory", undefined, writesTo((params) => params.address === 0xa5000000, -32013))).detail).toMatch(/^state\.writeMemory \{"target":"sh4","address":2768240640,"data":\[.*\]\}: in-band error -32013 "not writable"$/);
    const oneAddress = patched((machine) => {
      const read = machine.memoryByte.bind(machine);
      (machine as { memoryByte: Machine["memoryByte"] }).memoryByte = (target, address) => (target === "sh4" && address >>> 24 === 0x07 ? 0 : read(target, address));
    });
    expect((await part("writeMemory", oneAddress)).detail).toMatch(/^16 bytes of video memory written at 0xA5000000 as \[[0-9A-F ]+\] read \[00( 00){15}\] at 0x07000000$/);
    // main memory behind its three regions
    const noMirror = patched((machine) => {
      const read = machine.memoryByte.bind(machine);
      (machine as { memoryByte: Machine["memoryByte"] }).memoryByte = (target, address) => (target === "sh4" && address >>> 24 === 0x0c ? 0 : read(target, address));
    });
    expect((await part("writeMemory", noMirror)).detail).toMatch(/^the 16 bytes written at 0x8CFFEF00 read \[00( 00){15}\] at 0x0CFFEF00, which maps the same main memory; they were written as \[[0-9A-F ]+\]$/);
  }, 180_000);

  it("what is not such memory is refused, and a write to a running target is not answered with -32003", async () => {
    const accepting = (address: number): Faults => ({ answer: (request) => (request.method === "state.writeMemory" && paramsOf(request).address === address ? { jsonrpc: "2.0", id: request.id, result: {} } : undefined) });
    expect((await part("writeMemory", undefined, accepting(0x00200000))).detail).toBe(
      'the flash is not writable: state.writeMemory {"target":"sh4","address":2097152,"data":[0]}: expected the error -32013, got the result {}',
    );
    expect((await part("writeMemory", undefined, accepting(0xe0000000))).detail).toBe(
      'a store queue is not writable: state.writeMemory {"target":"sh4","address":3758096384,"data":[0]}: expected the error -32013, got the result {}',
    );
    const notPaused: Faults = (() => {
      let running = false;
      return {
        toClient: (frame) => {
          if (isTick(frame)) running = frame.params.executionState.state === "running";
          return frame;
        },
        answer: (request) => (running && request.method === "state.writeMemory" ? inBand(request, -32003, "not paused") : undefined),
      } satisfies Faults;
    })();
    expect((await part("writeMemory", undefined, notPaused)).detail).toBe('state.writeMemory {"target":"sh4","address":0,"data":[0]}: expected the error -32013, got -32003 "not paused"');
  }, 60_000);

  it("the probe that executes what was written: an instruction that does not execute, a step that ends elsewhere, and a step that ends at a vector first", async () => {
    const stale = patched((machine) => {
      machine.writtenSh4Instruction = () => undefined;
    });
    expect((await part("writeMemory", stale)).detail).toBe(
      '"mov #0x5A, r0" was written at 0x8CFFEF00 and stepped, and R0 reads 0x00000000: what executes is what was written (0x0000005A)',
    );
    const far = patched((machine) => {
      const advance = machine.advance.bind(machine);
      machine.advance = (target) => (target === "sh4" && !machine.running && sh4Pc(machine) === 0x8cffef00 ? (advance(target), advance(target)) : advance(target));
    });
    expect((await part("writeMemory", far)).detail).toBe("the step from the instruction written at 0x8CFFEF00 ended at 0x8CFFEF04, not at 0x8CFFEF02");

    /** The mock whose n-th step from the scratch address accepts an interrupt instead of executing; `spc`: what the entry leaves in SPC. */
    const interrupted = (which: (n: number) => boolean, spc?: number) =>
      patched((machine) => {
        const step = machine.step.bind(machine);
        let steps = 0;
        machine.step = (kind, params, context) => {
          if (params.target !== "sh4" || machine.running || sh4Pc(machine) !== 0x8cffef00 || !which(++steps)) return step(kind, params, context);
          context.afterResponse.push(() => {
            machine.acceptSh4Interrupt();
            if (spc !== undefined) machine.values.get("dc.sh4.cpu")!.set("SPC", spc);
            machine.enterStop("step");
          });
          return {};
        };
      }, { startPaused: true });
    // One step may: the interrupt is entered in front of the instruction, SPC says so, and the
    // probe is made once more from the vector. Everything is put back: the program goes on
    // where it was, in its handler, with the registers it had.
    const once = await part("writeMemory", interrupted((n) => n === 1));
    expect(once.result).toEqual(passed("writeMemory"));
    const machine = once.mock as unknown as Machine;
    expect(machine.written.size).toBe(0);
    expect(machine.values.get("dc.sh4.cpu")!.get("PC")).toBe(0x8c000600);
    expect(machine.values.get("dc.sh4.cpu")!.get("SPC")).toBe(0x8c0000a0);
    expect(machine.values.get("dc.sh4.cpu")!.get("R0")).toBe(0);
    expect(machine.values.get("dc.sh4.cpu")!.get("R0_BANK")).toBe(0);
    // an entry that does not return to the instruction it was entered in front of
    expect((await part("writeMemory", interrupted((n) => n === 1, 0x8cffef02))).detail).toBe(
      "the step from 0x8CFFEF00 ended at the exception vector 0x8C000600, and SPC reads 0x8CFFEF02; an exception that is entered in front of the instruction returns to it",
    );
    // from the vector no interrupt is accepted: a second step that executes nothing fails
    expect((await part("writeMemory", interrupted(() => true))).detail).toBe(
      "the step from the instruction written at 0x8CFFEF00, from the exception vector the first step ended at ended at 0x8C000600, not at 0x8CFFEF02",
    );
  }, 180_000);

  it("without register-write the probe is not made, and the part says so", async () => {
    const { result, notes } = await part("writeMemory", { supports: { capabilities: ["event-breakpoints", "callstack", "memory-write"] } });
    expect(result).toEqual(passed("writeMemory"));
    expect(notes).toEqual(['writeMemory: no capability "register-write": the instruction that was written was not executed']);
  }, 60_000);
});

describe("S16, part setRegister", () => {
  const answering = (matches: (params: { path: string; name: string; value: string }) => boolean, answer: (request: Json) => Json): Faults => ({
    answer: (request) => (request.method === "state.setRegister" && matches(paramsOf(request) as never) ? answer(request) : undefined),
  });
  const accepted = (request: Json): Json => ({ jsonrpc: "2.0", id: request.id, result: {} });

  it("the mock passes, as everything it can do and as what the emulator of M2 does", async () => {
    for (const options of [{ startPaused: true }, { startPaused: true, supports: MOCK_M2_SUPPORT }]) {
      const { result, notes, mock } = await part("setRegister", options);
      expect(result).toEqual(passed("setRegister"));
      expect(notes).toEqual([]);
      expect((mock as unknown as Machine).values.get("dc.sh4.cpu")!.get("R0")).toBe(0);
      expect((mock as unknown as Machine).values.get("dc.sh4.cpu")!.get("SR")).toBe(0x40000000);
    }
  }, 60_000);

  it("the name and the path without regard to case, and the grammar of the value", async () => {
    expect((await part("setRegister", undefined, answering((params) => params.name === "r0", (request) => inBand(request, -32602, "no register r0")))).detail).toBe(
      'state.setRegister {"path":"dc.sh4.cpu","name":"r0","value":"1"}: in-band error -32602 "no register r0"',
    );
    expect((await part("setRegister", undefined, answering((params) => params.path === "DC.SH4.CPU", (request) => inBand(request, -32602, "no node")))).detail).toBe(
      'state.setRegister {"path":"DC.SH4.CPU","name":"R0","value":" 0x1f "}: in-band error -32602 "no node"',
    );
    for (const value of ["-1", "", "1.5", "0x"]) {
      expect((await part("setRegister", undefined, answering((params) => params.value === value, accepted))).detail, JSON.stringify(value)).toBe(
        `state.setRegister {"path":"dc.sh4.cpu","name":"R0","value":${JSON.stringify(value)}}: expected the error -32602, got the result {}`,
      );
    }
  }, 120_000);

  it("flags.writable: on R0, not on ENABLED, on no register of width 0; and the order of the answers for ENABLED", async () => {
    const flagging = (rewrite: (path: string, register: Json) => Json): Faults =>
      describing((result) => ({ ...result, deviceTree: mapNodes(result.deviceTree, (node) => (node.registers ? { ...node, registers: (node.registers as Json[]).map((register) => rewrite(String(node.path), register)) } : node)) }));
    const without = (register: Json) => {
      const { flags: _flags, ...rest } = register;
      return rest;
    };
    expect((await part("setRegister", undefined, flagging((path, register) => (path === "dc.sh4.cpu" && register.name === "R0" ? without(register) : register)))).detail).toBe(
      "dc.sh4.cpu.R0 carries no flags.writable in debugger.describe; a register that state.setRegister writes says so",
    );
    expect((await part("setRegister", undefined, flagging((path, register) => (path === "dc.aica.arm7" && register.name === "ENABLED" ? { ...register, flags: { writable: true } } : register)))).detail).toBe(
      "dc.aica.arm7.ENABLED carries flags.writable; the guest holds and releases its ARM7, not the debugger",
    );
    expect((await part("setRegister", undefined, flagging((path, register) => (path === "dc" && register.name === "SYSCLK" ? { ...register, flags: { writable: true } } : register)))).detail).toBe(
      "dc.SYSCLK has width 0 and carries flags.writable; a register of width 0 is free text and has no writer",
    );
    // no writer comes before the value: "twelve" for ENABLED is -32013, not -32602
    expect((await part("setRegister", undefined, answering((params) => params.name === "ENABLED" && params.value === "twelve", (request) => inBand(request, -32602, "no number")))).detail).toBe(
      'state.setRegister {"path":"dc.aica.arm7","name":"ENABLED","value":"twelve"}: expected the error -32013, got -32602 "no number"',
    );
    // a register that says it has a writer and refuses the value it reads; one that says nothing and is written
    expect((await part("setRegister", undefined, answering((params) => params.path === "dc.aica.rtc" && params.name === "SECONDS", (request) => inBand(request, -32013, "not writable")))).detail).toMatch(
      /^state\.setRegister \{"path":"dc\.aica\.rtc","name":"SECONDS","value":"0x5BFC8900"\}: in-band error -32013 "not writable"$/,
    );
    expect((await part("setRegister", undefined, answering((params) => params.path === "dc.timing" && params.name === "MODE", accepted))).detail).toBe(
      'state.setRegister {"path":"dc.timing","name":"MODE","value":"0"}: expected the error -32013, got the result {}',
    );
  }, 180_000);

  it("the two processors: an odd PC of the SH4 that is accepted, a PC of the ARM7 that is stored as given, a CPSR that names no mode", async () => {
    expect((await part("setRegister", { startPaused: true }, answering((params) => params.path === "dc.sh4.cpu" && params.name === "PC" && (Number(params.value) & 1) === 1, accepted))).detail).toBe(
      'state.setRegister {"path":"dc.sh4.cpu","name":"PC","value":"0x8C0000A1"}: expected the error -32013, got the result {}',
    );
    const asGiven = patched((machine) => {
      const write = machine.writeRegister.bind(machine);
      machine.writeRegister = (path, register, text) => (path === "dc.aica.arm7" && register.name === "PC" ? machine.setRegisterValue(path, "PC", Number(text)) : write(path, register, text));
    }, { startPaused: true });
    expect((await part("setRegister", asGiven)).detail).toMatch(
      /^the PC of the ARM7 is stored with bits 0 and 1 clear: state\.setRegister: dc\.aica\.arm7\.PC reads 0x00200013 after writing "0x00200013", expected 0x00200010 \(1 tick within 1000 ms of the request, /,
    );
    expect((await part("setRegister", { startPaused: true }, answering((params) => params.name === "CPSR" && (Number(params.value) & 0x1f) === 0, accepted))).detail).toBe(
      'state.setRegister {"path":"dc.aica.arm7","name":"CPSR","value":"0x000000C0"}: expected the error -32013, got the result {}',
    );
    // the registers of the two processors are written in M2: an ARM7 whose R1 says nothing of a writer
    const silent = describing((result) => ({
      ...result,
      deviceTree: mapNodes(result.deviceTree, (node) =>
        node.path === "dc.aica.arm7" ? { ...node, registers: (node.registers as Json[]).map((register) => (register.name === "R1" ? { name: "R1", value: register.value, width: 32 } : register)) } : node,
      ),
    }));
    expect((await part("setRegister", undefined, silent)).detail).toBe("dc.aica.arm7.R1 carries no flags.writable; the registers of the two processors are written in milestone M2");
  }, 120_000);

  it("the two processors: a PC that says nothing of a writer and has none, an R1 that is refused or not stored, a refused value that is stored all the same", async () => {
    // The PC of a processor without the flag, and refused as a register without a writer is:
    // the refusal of its odd value, and of the first register of the node without the flag,
    // are the same answer, and say nothing of the PC.
    for (const node of ["dc.aica.arm7", "dc.sh4.cpu"]) {
      const noWriter: Faults = {
        ...describing((result) => ({
          ...result,
          deviceTree: mapNodes(result.deviceTree, (entry) =>
            entry.path === node ? { ...entry, registers: (entry.registers as Json[]).map((register) => (register.name === "PC" ? { name: "PC", value: register.value, width: 32 } : register)) } : entry,
          ),
        })),
        answer: (request) => (request.method === "state.setRegister" && paramsOf(request).path === node && paramsOf(request).name === "PC" ? inBand(request, -32013, "not writable") : undefined),
      };
      expect((await part("setRegister", { startPaused: true }, noWriter)).detail, node).toBe(`${node}.PC carries no flags.writable; the registers of the two processors are written in milestone M2`);
    }

    // R1 of the clocked ARM7 makes its round trip: refused, and accepted without being stored
    const refused = answering((params) => params.path === "dc.aica.arm7" && params.name === "R1", (request) => inBand(request, -32013, "not writable"));
    // (the line is that of the write that puts R1 back, which is refused as the first one was)
    expect((await part("setRegister", { startPaused: true }, refused)).detail).toBe('state.setRegister {"path":"dc.aica.arm7","name":"R1","value":"0x00000101"}: in-band error -32013 "not writable"');
    const dropped = patched((machine) => {
      const write = machine.writeRegister.bind(machine);
      machine.writeRegister = (path, register, text) => (path === "dc.aica.arm7" && register.name === "R1" ? undefined : write(path, register, text));
    }, { startPaused: true });
    expect((await part("setRegister", dropped)).detail).toMatch(
      /^state\.setRegister: dc\.aica\.arm7\.R1 reads 0x00000101 after writing "0x00FF01FE", expected 0x00FF01FE \(1 tick within 1000 ms of the request, /,
    );

    // "refused" is "not stored": a server that answers -32013 for the odd PC of the SH4, or for
    // the CPSR that names no mode, and stores the value
    const storing = (node: string, name: string) =>
      patched((machine) => {
        const write = machine.writeRegister.bind(machine);
        machine.writeRegister = (path, register, text) => {
          try {
            write(path, register, text);
          } catch (error) {
            if (path === node && register.name === name && (error as { code?: number }).code === -32013) machine.setRegisterValue(path, name, Number(text));
            throw error;
          }
        };
      }, { startPaused: true });
    expect((await part("setRegister", storing("dc.sh4.cpu", "PC"))).detail).toBe("a refused write of the PC of the SH4 changed it: it reads 0x8C0000A1, it was 0x8C0000A0");
    expect((await part("setRegister", storing("dc.aica.arm7", "CPSR"))).detail).toBe("a refused write of CPSR changed it: it reads 0x000000C0, it was 0x000000D3");
  }, 120_000);

  it("a write of a register is no new stop", async () => {
    const newStop = patched((machine) => {
      const setRegister = machine.setRegister.bind(machine);
      machine.setRegister = (params, context) => {
        const result = setRegister(params, context);
        context.afterResponse.unshift(() => machine.enterStop("pause"));
        return result;
      };
    }, { startPaused: true });
    expect((await part("setRegister", newStop)).detail).toMatch(
      /^the tick behind state\.setRegister \{dc\.sh4\.cpu, R0\} is #\d+ paused stop (\d+) pause; the target was #\d+ paused stop (?!\1 )\d+ \w+, and a register write is not a new stop$/,
    );
  }, 60_000);

  it("a write of SR.RB that does not exchange the register banks; without MD the exchange is not asked for", async () => {
    const stored = patched((machine) => {
      machine.setSh4Sr = (value) => machine.setRegisterValue("dc.sh4.cpu", "SR", (value & 0x700083f3) >>> 0);
    }, { startPaused: true });
    expect((await part("setRegister", stored)).detail).toMatch(
      /^a write of SR that flips RB \(MD is set\) exchanges R0\.\.R7 with R0_BANK\.\.R7_BANK: R0\.\.R7 read \["0x5A5A5A5A","0x00001111",.*\] and R0_BANK\.\.R7_BANK \["0x00000000","0x00000000",.*\]; before it they read /,
    );
    // A machine whose two banks read the same (one that has not run yet: both are as its reset
    // left them). The exchange is seen there all the same, in R0, which the part sets apart
    // first; and a server that exchanges nothing does not pass because nothing would show.
    const equal = (machine: Machine) => {
      for (let index = 0; index < 8; index++) machine.values.get("dc.sh4.cpu")!.set(`R${index}`, 0);
    };
    const same = await part("setRegister", patched(equal, { startPaused: true }));
    expect(same.result).toEqual(passed("setRegister"));
    expect(same.notes).toEqual([]);
    const cpu = (same.mock as unknown as Machine).values.get("dc.sh4.cpu")!;
    expect([cpu.get("R0"), cpu.get("R0_BANK"), cpu.get("SR")]).toEqual([0, 0, 0x40000000]);
    const nothing = patched((machine) => {
      equal(machine);
      machine.setSh4Sr = (value) => machine.setRegisterValue("dc.sh4.cpu", "SR", (value & 0x700083f3) >>> 0);
    }, { startPaused: true });
    expect((await part("setRegister", nothing)).detail).toMatch(
      /^a write of SR that flips RB \(MD is set\) exchanges R0\.\.R7 with R0_BANK\.\.R7_BANK: R0\.\.R7 read \["0x5A5A5A5A"(,"0x00000000"){7}\] and R0_BANK\.\.R7_BANK \["0x00000000"(,"0x00000000"){7}\]; before it they read \["0x5A5A5A5A"(,"0x00000000"){7}\] and \["0x00000000"(,"0x00000000"){7}\]$/,
    );
    const user = patched((machine) => {
      machine.values.get("dc.sh4.cpu")!.set("SR", 0);
      machine.values.get("dc.sh4.cpu")!.set("SSR", 0);
    }, { startPaused: true });
    const { result, notes } = await part("setRegister", user);
    expect(result).toEqual(passed("setRegister"));
    expect(notes).toEqual(["setRegister: MD is clear in SR at this stop: the exchange of the register banks by a write of SR.RB was not shown"]);
  }, 60_000);

  it("state.editWatch: an id that is not used, a watch on ENABLED; and a write to a running target that is answered with -32003", async () => {
    const edits = (matches: (params: { watchId: number; value: string }) => boolean, answer: (request: Json) => Json): Faults => ({
      answer: (request) => (request.method === "state.editWatch" && matches(paramsOf(request) as never) ? answer(request) : undefined),
    });
    expect((await part("setRegister", undefined, edits((params) => params.watchId >= 100_000, accepted))).detail).toMatch(/^state\.editWatch \{"watchId":10\d{4},"value":"0"\}: expected the error -32602, got the result \{\}$/);
    expect((await part("setRegister", undefined, edits((params) => params.value === "1", (request) => inBand(request, -32004, "not supported")))).detail).toMatch(
      /^state\.editWatch \{"watchId":\d+,"value":"1"\}: expected the error -32013, got -32004 "not supported"$/,
    );
    const notPaused: Faults = (() => {
      let running = false;
      return {
        toClient: (frame) => {
          if (isTick(frame)) running = frame.params.executionState.state === "running";
          return frame;
        },
        answer: (request) => (running && request.method === "state.setRegister" ? inBand(request, -32003, "not paused") : undefined),
      } satisfies Faults;
    })();
    expect((await part("setRegister", undefined, notPaused)).detail).toBe('state.setRegister {"path":"dc.aica.arm7","name":"ENABLED","value":"0"}: expected the error -32013, got -32003 "not paused"');
  }, 60_000);
});

describe("S16, part reset", () => {
  /** The mock whose control.reset does something more, or something else, when the target is in the given state. */
  const resetting = (when: "paused" | "running", behind: (machine: Machine) => void, instead = false, options: MockDebuggerOptions = {}) =>
    patched((machine) => {
      const reset = machine.reset.bind(machine);
      machine.reset = (context) => {
        if ((when === "running") !== machine.running) return reset(context);
        const result = instead ? {} : reset(context);
        context.afterResponse.unshift(() => behind(machine));
        return result;
      };
    }, options);

  it("the mock passes: it is left running behind its reset, with the tables it had", async () => {
    const { result, notes, mock } = await part("reset");
    expect(result).toEqual(passed("reset"));
    expect(notes).toEqual([]);
    const machine = mock as unknown as Machine;
    expect(machine.breakpoints.size).toBe(0);
    expect(machine.watches.size).toBe(0);
    expect(machine.categories.get("dsp")).toEqual({ muted: false, soloed: false });
    // a server without the capability is not asked: the part is not applicable to it, which fails a run that names it
    const without = await part("reset", { supports: { capabilities: ["event-breakpoints", "callstack", "memory-write", "register-write"] } });
    expect(without.result).toEqual({ name: "reset", status: "failed", detail: 'not applicable (no capability "reset"); a part that --parts names has to pass' });
    expect(without.summary.ok).toBe(false);
  }, 60_000);

  it("while running: a reset that stops the target, publishes a stop, or leaves no entry in the event log", async () => {
    expect((await part("reset", resetting("running", (machine) => machine.enterStop("reset")))).detail).toMatch(
      /^control\.reset while the target runs: a tick is #\d+ paused stop 1 reset; the target was #\d+ running stop 0, it runs on in the same stop and nothing is published for the reset$/,
    );
    const noEntry = await part("reset", resetting("running", () => undefined, true));
    expect(noEntry.detail).toMatch(/^an entry of dc\.system\.reset in the event log behind control\.reset of a running target: not seen within 1000 ms; /);
    // a server that does not list the event is not asked for the entry
    const unlisted = describing((result) => ({
      ...result,
      deviceTree: mapNodes(result.deviceTree, (node) => (node.path === "dc" ? { ...node, events: (node.events as string[]).filter((event) => event !== "dc.system.reset") } : node)),
    }));
    const quiet: Faults = {
      toClient: (frame) => {
        if (!isTick(frame)) return unlisted.toClient!(frame);
        return { ...frame, params: { ...frame.params, eventLog: (frame.params.eventLog as Json[]).filter((entry) => (entry.metadata as Json).event !== "dc.system.reset") } };
      },
    };
    expect((await part("reset", undefined, quiet)).result).toEqual(passed("reset"));
  }, 90_000);

  it("while paused: a reset that publishes running, keeps its reason, leaves the ARM7 clocked, or loses a table", async () => {
    // a running tick in front of the stop of the reset
    const publishes = resetting("paused", (machine) => {
      const tick = machine.buildTick(true) as Json & { executionState: { stopId: number } };
      for (const client of machine.clients.values()) {
        machine.sendTick(client, { ...tick, executionState: { state: "running", stopId: tick.executionState.stopId }, callstacks: { sh4: [], arm7: [] } });
      }
    });
    expect((await part("reset", publishes)).detail).toBe("no running tick between control.reset and its stop");
    // a reset that leaves the target running
    const runs: Faults = {
      toClient: (frame) =>
        isTick(frame) && frame.params.executionState.reason === "reset"
          ? { ...frame, params: { ...frame.params, executionState: { state: "running", stopId: frame.params.executionState.stopId }, callstacks: { sh4: [], arm7: [] } } }
          : frame,
    };
    expect((await part("reset", undefined, runs)).detail).toBe("a reset while paused stays paused");
    const sameReason = patched((machine) => {
      const enterStop = machine.enterStop.bind(machine);
      machine.enterStop = (reason, id, fallback) => enterStop(reason === "reset" ? "pause" : reason, id, fallback);
    });
    expect((await part("reset", sameReason)).detail).toBe('the stop has reason "pause", expected "reset"');

    const clocked = patched((_machine, mock) => {
      mock.holdArm7 = () => undefined;
    });
    expect((await part("reset", clocked)).detail).toBe("dc.aica.arm7.ENABLED reads 1 at the stop of a reset; a machine comes out of reset with its ARM7 held");

    expect((await part("reset", resetting("paused", (machine) => machine.breakpoints.clear()))).detail).toMatch(
      /^the tick of the reset stop lists breakpoint \d+ as undefined; a reset keeps the breakpoints: it was \{.*"enabled":false.*\}$/,
    );
    expect((await part("reset", resetting("paused", (machine) => machine.watches.clear()))).detail).toMatch(
      /^the tick of the reset stop lists watch \d+ as undefined; a reset keeps the watches: it was on dc\.sh4\.cpu\.gbr$/,
    );
    expect((await part("reset", resetting("paused", (machine) => machine.categories.set("dsp", { muted: false, soloed: false })))).detail).toMatch(
      /^the categories are \{.*"dsp":\{"muted":false,"soloed":false\}.*\} behind the reset; a reset keeps them: they were \{.*"dsp":\{"muted":true,"soloed":false\}.*\}$/,
    );
  }, 180_000);

  it("behind a reset: a register of the held ARM7 that is refused, and a machine that does not run on", async () => {
    const refused: Faults = (() => {
      let held = false;
      return {
        toClient: (frame) => {
          if (isTick(frame)) held = frame.params.registers["dc.aica.arm7"]?.find((register) => register.name === "ENABLED")?.value === "0x0";
          return frame;
        },
        answer: (request) => (held && request.method === "state.setRegister" && paramsOf(request).path === "dc.aica.arm7" ? inBand(request, -32013, "not writable: the ARM7 is held") : undefined),
      } satisfies Faults;
    })();
    expect((await part("reset", undefined, refused)).detail).toMatch(
      /^a register of the ARM7 is written while it is held in reset: state\.setRegister \{"path":"dc\.aica\.arm7","name":"R1","value":"0x[0-9A-F]{8}"\}: in-band error -32013 "not writable: the ARM7 is held"$/,
    );
    const parked = patched((machine) => {
      let reset = false;
      const enterStop = machine.enterStop.bind(machine);
      machine.enterStop = (reason, id, fallback) => {
        reset = reason === "reset";
        enterStop(reason, id, fallback);
      };
      const leaveStop = machine.leaveStop.bind(machine);
      machine.leaveStop = () => (reset ? undefined : leaveStop());
    });
    expect((await part("reset", parked)).detail).toMatch(/^a running tick after control\.runUntil behind a reset: not seen within 1000 ms; /);
  }, 60_000);
});

describe("S16, part tree", () => {
  it("the table of milestone M2: 87 rows, 70 of them new nodes; and twelve register panels", () => {
    expect(M2_DEVICE_TREE).toHaveLength(2 + 1 + 4 + 4 + 2 + 64 + 2);
    expect(new Set(M2_DEVICE_TREE.map((row) => row.path)).size).toBe(M2_DEVICE_TREE.length);
    expect(M2_DEVICE_TREE.filter((row) => row.registers).length).toBe(76);
    expect(REGISTER_PANEL_IDS).toEqual([
      "sh4-registers",
      "arm7-registers",
      ...["bsc", "ccn", "cpg", "dmac", "intc", "rtc", "sci", "scif", "tmu", "ubc"].map((name) => `${name}-registers`),
    ]);
  });

  it("the mock passes; the register lists are the server's; a server that does not offer sh4-registers on dc.sh4.cpu does not claim the tree", async () => {
    expect((await part("tree")).result).toEqual(passed("tree"));
    // other names and other numbers of registers on the nodes of M2
    const others = describing(
      (result) => ({
        ...result,
        deviceTree: mapNodes(result.deviceTree, (node) =>
          /^dc\.(holly\.(sb\.|spg)|aica\.(common|rtc|sgc\.)|gdrom|maple)/.test(String(node.path)) ? { ...node, registers: [{ name: "ONLY", value: "0x00", width: 8 }] } : node,
        ),
      }),
      (all) => Object.fromEntries(Object.entries(all).map(([path, registers]) => [path, /^dc\.(holly\.(sb\.|spg)|aica\.(common|rtc|sgc\.)|gdrom|maple)/.test(path) ? [{ name: "ONLY", value: "0x00", width: 8 }] : registers])),
    );
    expect((await part("tree", undefined, others)).result).toEqual(passed("tree"));

    const m1 = await part("tree", { supports: MOCK_M1_SUPPORT });
    expect(m1.result).toEqual({ name: "tree", status: "failed", detail: 'not applicable (dc.sh4.cpu does not offer the action "sh4-registers"); a part that --parts names has to pass' });
    // without --parts it is one part that cannot be shown: S16 is partial on such a server, and no failure of a run that looks at it
    const { url } = await startServer(undefined, { supports: { deviceTree: "m1" } });
    const looked = await runContract({ url, profile: "mock", only: new Set(["S01", "S16"]) });
    expect(looked.scenarios[1].parts?.at(-1)).toEqual({ name: "tree", status: "not-applicable", detail: 'dc.sh4.cpu does not offer the action "sh4-registers"' });
    expect(looked.scenarios[1].status).toBe("partial");
    expect(looked.ok).toBe(true);
  }, 120_000);

  it("a node that is missing or elsewhere, an action that is missing, a node without registers, and a register panel that two nodes offer", async () => {
    const tree = (rewrite: (node: Json) => Json | undefined, registers?: (all: Record<string, Json[]>) => Record<string, Json[]>) =>
      part("tree", undefined, describing((result) => ({ ...result, deviceTree: mapNodes(result.deviceTree, rewrite) }), registers));
    const without = (path: string) => (all: Record<string, Json[]>) => Object.fromEntries(Object.entries(all).filter(([key]) => key !== path && !key.startsWith(`${path}.`)));

    const missing = await tree((node) => (node.path === "dc.holly.spg" || node.path === "dc.aica.sgc.63" ? undefined : node), (all) => without("dc.holly.spg")(without("dc.aica.sgc.63")(all)));
    expect(missing.summary.scenarios[0].details).toEqual([
      "tree: the device tree has no node dc.holly.spg, which milestone M2 adds",
    ]);
    expect(missing.detail).toBe("the device tree has no node dc.holly.spg, which milestone M2 adds");

    // the nodes of the system bus as children of dc.holly, by the dots of their paths
    const flat = await tree((node) => {
      if (node.path === "dc.holly.sb") return { ...node, children: undefined };
      if (node.path !== "dc.holly") return node;
      const children = node.children as Json[];
      const sb = children.find((child) => child.path === "dc.holly.sb")!;
      return { ...node, children: [...children, ...(sb.children as Json[])] };
    });
    expect(flat.detail).toBe("dc.holly.sb.g1 is under dc.holly, milestone M2 has it under dc.holly.sb");

    expect((await tree((node) => (node.path === "dc.aica.arm7" ? { ...node, actions: ["arm7-disassembly", "arm7-memory"] } : node))).detail).toBe(
      'dc.aica.arm7: the action "arm7-registers" of milestone M2 is missing',
    );
    const empty = await tree(
      (node) => {
        if (node.path !== "dc.gdrom") return node;
        const { registers: _dropped, ...rest } = node;
        return rest;
      },
      without("dc.gdrom"),
    );
    expect(empty.detail).toBe("dc.gdrom lists no registers; from milestone M2 on it carries at least one");
    // S01 asks that the listed node has the action, which a second node with it passes: the panel would not know its node
    const twice = await tree((node) => (node.path === "dc.sh4.bsc" ? { ...node, actions: ["bsc-registers", "sh4-registers"] } : node));
    expect(twice.detail).toBe('the action "sh4-registers" is offered by dc.sh4.cpu and dc.sh4.bsc; a register panel is the action of one node');
    expect((await tree((node) => (node.path === "dc.sh4.ccn" ? { ...node, actions: ["ccn-registers", "ubc-registers"] } : node))).detail).toBe(
      'the action "ubc-registers" is offered by dc.sh4.ccn and dc.sh4.ubc; a register panel is the action of one node',
    );
  }, 120_000);
});

describe("the M1 scenarios that milestone M2 changed", () => {
  it("S01 at the gate of M2: the ARM7 steps", async () => {
    const m2 = async (options: MockDebuggerOptions) =>
      (await runContract({ url: (await startServer(undefined, options)).url, profile: "mock", milestone: "M2", only: new Set(["S01"]) })).scenarios[0];
    expect((await m2({})).status).toBe("passed");
    expect((await m2({ supports: MOCK_M2_SUPPORT })).status).toBe("passed");
    const noStepping = await m2({ supports: { ...MOCK_M2_SUPPORT, stepping: ["sh4"] } });
    expect(noStepping.details).toEqual(["the gate of M2: targets: arm7.stepping is not true; a server of milestone M2 steps the ARM7 and takes its code breakpoints (3.1)"]);
    // the gate of M1 does not ask for it
    const { url } = await startServer(undefined, { supports: MOCK_M1_SUPPORT });
    expect(reportOf(await runContract({ url, profile: "mock", milestone: "M1", only: new Set(["S01"]) }))).toEqual(["S01 passed "]);
  }, 60_000);

  it("S09: a read across the last address of the SH4 does not wrap: the bytes behind it are unreadable, or nothing is readable there", async () => {
    const s09 = async (faults?: Faults) => reportOf(await runContract({ url: (await startServer(faults)).url, profile: "mock", only: new Set(["S09"]) }));
    const atTop = (rewrite: (request: Json, result?: Json) => Json | undefined): Faults => {
      const ids = new Set<unknown>();
      return {
        toServer: (frame) => {
          if (frame.method === "state.getMemorySlice" && paramsOf(frame).address === 0xfffffff0) ids.add(frame.id);
          return frame;
        },
        toClient: (frame) => (ids.delete(frame.id) ? (rewrite(frame, frame.result as Json) ?? frame) : frame),
      };
    };
    // the mock reads the registers at the top of P4, and lists what is behind the end as unreadable ...
    expect(await s09()).toEqual(["S09 passed "]);
    // ... the emulator reads nothing there
    expect(await s09(atTop((frame) => rpcError(frame, -32010, "address not readable")))).toEqual(["S09 passed "]);
    // a server that goes on at address 0
    const wrapped = await s09(atTop((frame, result) => ({ ...frame, result: { baseAddress: result!.baseAddress, validity: "ok", data: (result!.data as number[]).map((byte, index) => (index < 16 ? byte : 0xab)) } })));
    expect(wrapped[0]).toMatch(
      /^S09 failed a read of 32 bytes at 0xFFFFFFF0 goes 16 bytes past the last address of the sh4 \(0xFFFFFFFF\): it lists unreadable undefined, and the bytes behind the end are \[171(,171){15}\]; a read does not wrap, those bytes are unreadable and 0$/,
    );
    // ... and one that refuses the read for another reason
    expect((await s09(atTop((frame) => rpcError(frame, -32602, "invalid params: address"))))[0]).toBe(
      'S09 failed a read of 32 bytes at 0xFFFFFFF0, across the last address of the sh4: the error -32602 "invalid params: address", expected data whose second half is unreadable, or -32010',
    );
  }, 60_000);

  it("S13: the tick of a write goes to every client; a server that sends it to the writing client only", async () => {
    const toWriter = patched((machine) => {
      const setRegister = machine.setRegister.bind(machine);
      machine.setRegister = (params, context) => {
        const result = setRegister(params, context);
        // (in place of the broadcast that was queued)
        context.afterResponse.pop();
        context.afterResponse.push(() => machine.sendTick(context.client, machine.buildTick(true)));
        return result;
      };
    });
    const { url } = await startServer(undefined, toWriter);
    expect(reportOf(await runContract({ url, profile: "mock", only: new Set(["S13"]) }))[0]).toMatch(
      /^S13 failed a tick on the second connection behind the state\.setRegister of the first: not seen within 1000 ms; ticks since then: 0$/,
    );
    // a server without register writes is not asked, and S13 says so
    const m1 = await runContract({ url: (await startServer(undefined, { supports: MOCK_M1_SUPPORT })).url, profile: "mock", only: new Set(["S13"]) });
    expect(reportOf(m1)).toEqual(['S13 passed no capability "register-write": the tick of a write was not looked for on the second connection']);
  }, 60_000);

  it("the invariants: no register of a tick carries flags, and the ARM7 callstack of every paused tick follows ENABLED", async () => {
    const flags = patched((machine) => {
      machine.registersOf = (path) => machine.describedRegistersOf(path);
    });
    const flagged = await runContract({ url: (await startServer(undefined, flags)).url, profile: "mock", only: new Set(["S02"]) });
    expect(flagged.ok).toBe(false);
    expect(flagged.invariantViolations[0]).toMatch(/^I4: dc\.sh4\.cpu\.PC carries flags in a tick; flags are debugger\.describe's, a register of a tick has name, value and width \(tick \d+\)$/);

    // S02 does not look at callstacks: the pairing is held in every paused tick of every scenario
    const s02 = async (mock: MockDebugger) =>
      Array.from(new Set((await runContract({ url: (await startServer(undefined, mock)).url, profile: "mock", only: new Set(["S02"]) })).invariantViolations.map((line) => line.replace(/ \(tick \d+\)$/, ""))));
    const stack = (rewrite: (frames: Json[]) => Json[], enabled: 0 | 1 = 1) =>
      patched((machine) => {
        machine.values.get("dc.aica.arm7")!.set("ENABLED", enabled);
        const callstack = machine.callstack.bind(machine);
        machine.callstack = (target, maxFrames) => (target === "arm7" ? rewrite(callstack(target, 64)).slice(0, maxFrames) : callstack(target, maxFrames));
      });
    expect(await s02(stack((frames) => frames))).toEqual([]);
    expect(await s02(stack(() => [], 0))).toEqual([]);
    expect(await s02(stack(() => []))).toEqual([
      "2.10: dc.aica.arm7.ENABLED reads 1 (the ARM7 is clocked), and the ARM7 callstack of the paused tick has 0 frames; it has at least two then (frame 0 the PC, frame 1 the link register)",
    ]);
    expect(await s02(stack((frames) => frames, 0))).toEqual(["2.10: dc.aica.arm7.ENABLED reads 0 (the ARM7 is held in reset), and the ARM7 callstack of the paused tick has 16 frames; it has none then"]);
    expect(await s02(stack((frames) => frames.map((frame) => (frame.index === 1 ? { ...frame, pc: 0x00200000 } : frame))))).toEqual([
      "2.10: frame 1 of the ARM7 callstack is at 0x00200000, R14 of dc.aica.arm7 in the same paused tick is 0x00200028",
    ]);
    expect(await s02(stack((frames) => frames.map((frame) => (frame.index === 1 ? { ...frame, location: "stack+0x0" } : frame.index === 0 ? { ...frame, location: "pc", pc: 4 } : frame))))).toEqual([
      expect.stringMatching(/^2\.10: frame 0 of the ARM7 callstack is at 0x00000004, the PC of dc\.aica\.arm7 in the same paused tick is 0x002000[0-9A-F]{2}$/),
      '2.10: frame 0 of the ARM7 callstack is the PC and has no location, this one has "pc"',
      '2.10: frame 1 of the ARM7 callstack has location "stack+0x0", expected "lr"',
    ]);
    // a server without the capability "callstack", and one that does not list the ARM7, carry no ARM7 frames: nothing to pair
    for (const supports of [{ capabilities: ["event-breakpoints"] }, { targets: ["sh4" as const, "dsp" as const] }]) {
      const { url } = await startServer(undefined, { supports });
      expect((await runContract({ url, profile: "mock", only: new Set(["S02"]) })).invariantViolations).toEqual([]);
    }
  }, 120_000);
});

describe("the gate of M2, and the options that came with it", () => {
  const gate = async (options: Partial<ContractOptions>): Promise<ContractSummary> => runContract({ profile: "mock", milestone: "M2", requireNotes: [ARM7_NOTES.calls], ...options });

  it("the mock passes the gate of M2, as everything it can do and as what the emulator of M2 does: 17 scenarios, none partial, none not applicable", async () => {
    for (const mockSupport of [undefined, "m2"] as const) {
      const lines: string[] = [];
      const summary = await gate({ mockSupport, say: (line) => lines.push(line) });
      expect(reportOf(summary).filter((line) => !/^S\d\d passed /.test(line)), String(mockSupport)).toEqual([]);
      expect(summary).toMatchObject({ ok: true, milestone: "M2", passed: 17, failed: 0, partial: 0, notApplicable: 0, requiredNotPassed: [], requiredNotesMissing: [], invariantViolations: [], cleanUpProblems: [] });
      expect(summary.selected).toEqual(scenariosOfMilestone("M2", "mock"));
      expect(summary.scenarios.at(-1)).toMatchObject({
        id: "S16",
        parts: ["arm7", "writeMemory", "setRegister", "reset", "tree"].map(passed),
        notes: ["arm7: clocked at the start", "arm7: bl stepped over and out"],
      });
      expect(lines[0]).toMatch(mockSupport ? /^mock debugger started in this process at ws:\S+, as a server of milestone M2$/ : /^mock debugger started in this process at ws:\S+$/);
      expect(summary.server.capabilities).toEqual(
        mockSupport ? ["event-breakpoints", "callstack", "memory-write", "register-write", "reset", "sh4-debug-native"] : ["event-breakpoints", "callstack", "memory-write", "register-write", "reset", "sgc-capture", "sh4-debug-native"],
      );
      expect(lines.at(-1)).toBe("contract: OK");
    }
  }, 240_000);

  it("the gate of M2 passes a server that sends the tick of a request in front of the response to it, as the emulator does", async () => {
    // The mock answers first and sends the tick behind: no run against it has the other order,
    // which is the emulator's for every request that changes a table or writes (design 2.9).
    const count = { reordered: 0 };
    const { url } = await startServer(() => tickBeforeResponse(count));
    const summary = await gate({ url });
    expect(reportOf(summary).filter((line) => !/^S\d\d passed /.test(line))).toEqual([]);
    expect(summary).toMatchObject({ ok: true, milestone: "M2", passed: 17, failed: 0, partial: 0, notApplicable: 0, requiredNotPassed: [], requiredNotesMissing: [], invariantViolations: [], cleanUpProblems: [] });
    expect(count.reordered).toBeGreaterThan(1000);
  }, 240_000);

  it("the mock as an M1 server fails the gate of M2, and passes that of M1", async () => {
    const m2 = await gate({ mockSupport: "m1", only: new Set(["S01", "S16"]), requireNotes: [] });
    expect(m2.ok).toBe(false);
    expect(m2.requiredNotPassed).toEqual([
      { id: "S01", status: "failed" },
      { id: "S16", status: "not-applicable" },
    ]);
    const m1 = await runContract({ profile: "mock", milestone: "M1", mockSupport: "m1", only: new Set(["S01", "S02", "S12"]) });
    expect(m1).toMatchObject({ ok: true, passed: 3 });
    expect(m1.server.capabilities).toEqual(["event-breakpoints", "callstack", "sh4-debug-native"]);
  }, 60_000);

  it("--parts: only the named parts run, each has to pass, and the scenario is required", async () => {
    const { url } = await startServer();
    const parts = new Map([["S16", new Set(["tree", "setRegister"])]]);
    expect(selectScenarios({ profile: "mock", only: new Set(["S01", "S16"]), parts })).toEqual({ selected: ["S01", "S16"], required: ["S16"] });
    expect(selectScenarios({ profile: "mock", parts })).toMatchObject({ required: ["S16"] });
    const summary = await runContract({ url, profile: "mock", only: new Set(["S16"]), parts });
    // (in the order of the scenario, not of the option)
    expect(summary.scenarios[0]).toMatchObject({ status: "passed", parts: [passed("setRegister"), passed("tree")] });
    expect(summary).toMatchObject({ ok: true, required: ["S16"], requiredNotPassed: [] });
    // every scenario that has parts names them
    expect(SCENARIOS.filter((scenario) => scenario.parts).map((scenario) => [scenario.id, scenario.parts])).toEqual([
      ["S16", ["arm7", "writeMemory", "setRegister", "reset", "tree"]],
      ["S17", ["sgcCapture"]],
      ["S18", ["tables", "hollyCapture"]],
    ]);
    // a named part that is not applicable fails the scenario, where without --parts it would be partial
    const m1 = (await startServer(undefined, { supports: { capabilities: ["event-breakpoints", "callstack", "register-write"] } })).url;
    const named = await runContract({ url: m1, profile: "mock", only: new Set(["S16"]), parts: new Map([["S16", new Set(["setRegister", "reset"])]]) });
    expect(named.scenarios[0]).toMatchObject({
      status: "failed",
      parts: [passed("setRegister"), { name: "reset", status: "failed", detail: 'not applicable (no capability "reset"); a part that --parts names has to pass' }],
    });
    expect(named.ok).toBe(false);
    expect((await runContract({ url: m1, profile: "mock", only: new Set(["S16"]) })).scenarios[0].status).toBe("partial");
  }, 60_000);

  it("--require-note: a note of a selected scenario, to the letter", async () => {
    const { url } = await startServer();
    const noted = (requireNotes: string[]) => runContract({ url, profile: "mock", only: new Set(["S16"]), parts: new Map([["S16", new Set(["arm7"])]]), requireNotes });
    expect(await noted([ARM7_NOTES.clocked, ARM7_NOTES.calls])).toMatchObject({ ok: true, requiredNotesMissing: [] });
    // the mock's ARM7 runs at the start: it was not held
    expect(await noted([ARM7_NOTES.held])).toMatchObject({ ok: false, passed: 1, failed: 0, requiredNotesMissing: ["arm7: held at the start"] });
    // a text that differs from a note by a character is another text
    for (const text of ["arm7: bl stepped over and out.", "arm7: bl stepped over and out ", "Arm7: bl stepped over and out", "bl stepped over and out", "arm7: bl stepped over"]) {
      expect(await noted([text]), text).toMatchObject({ ok: false, requiredNotesMissing: [text] });
    }
    // the note of a scenario that was not selected is no note of the run
    expect(await runContract({ url, profile: "mock", only: new Set(["S02"]), requireNotes: [ARM7_NOTES.clocked] })).toMatchObject({ ok: false, passed: 1, requiredNotesMissing: [ARM7_NOTES.clocked] });
  }, 120_000);
});

describe("the command line of milestone M2", () => {
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

  it("--parts and --require-note: 0 when the part passed and the note is there, 1 when not, 2 for an option that is wrong", async () => {
    // the mock the runner starts itself, as what the emulator of M2 does
    const shown = await cli(["--mock-support", "m2", "--only", "S16", "--parts", "S16:arm7+tree", "--require-note", "arm7: bl stepped over and out", "--require-note", "arm7: clocked at the start"]);
    expect(shown.output).toMatch(/^mock debugger started in this process at ws:\S+, as a server of milestone M2$/m);
    expect(shown.output).toMatch(/^S16 M2: ARM7, writes, reset\.* passed \[arm7: passed; tree: passed\] /m);
    expect(shown.output).toMatch(/\ncontract: OK\n$/);
    expect(shown.code).toBe(0);

    // a note that was not made, and one that differs by a character
    for (const text of ["arm7: held at the start", "arm7: bl stepped over and out."]) {
      const missing = await cli(["--only", "S16", "--parts", "S16:tree+arm7", "--require-note", text]);
      expect(missing.output, text).toContain(`required note: no selected scenario noted "${text}"\n`);
      expect(missing.output, text).toMatch(/^1 passed, 0 failed, .*\ncontract: FAILED\n$/m);
      expect(missing.code, text).toBe(1);
    }
    // a named part that is not applicable
    const notApplicable = await cli(["--mock-support", "m1", "--only", "S16", "--parts", "S16:tree"]);
    expect(notApplicable.output).toMatch(/^ {6}tree: not applicable \(dc\.sh4\.cpu does not offer the action "sh4-registers"\); a part that --parts names has to pass$/m);
    expect(notApplicable.code).toBe(1);

    // what is no run: a part that does not exist, a scenario without parts, --parts inside a gate or beside an --only that leaves it out
    for (const [args, message] of [
      [["--parts", "S16:arm"], /^contract: Error: --parts S16: it has no part "arm"; its parts are arm7, writeMemory, setRegister, reset, tree$/m],
      [["--parts", "S16"], /^contract: Error: --parts is <scenario>:<part>\[\+<part>\.\.\.\], e\.g\. --parts S16:arm7\+tree$/m],
      [["--parts", "S02:pause"], /^contract: Error: --parts S02: that scenario has no parts$/m],
      [["--parts", "S99:x"], /^contract: Error: --parts: there is no scenario S99$/m],
      [["--milestone", "M2", "--parts", "S16:arm7"], /^contract: Error: --parts with --milestone: the gate of M2 is its scenarios whole; /m],
      [["--only", "S01", "--parts", "S16:arm7"], /^contract: Error: --parts S16: --only leaves that scenario out$/m],
      [["--require-note"], /^contract: Error: --require-note needs the text of a note$/m],
      [["--mock-support", "m3"], /^contract: Error: --mock-support is m1 or m2, not "m3"$/m],
      [["--mock-support", "m2", "--url", "ws://127.0.0.1:1/ws"], /^contract: Error: --mock-support is for the mock the runner starts itself: not with --url$/m],
    ] as const) {
      const wrong = await cli([...args]);
      expect(wrong.output, args.join(" ")).toMatch(message);
      expect(wrong.code, args.join(" ")).toBe(2);
    }
    // --list names the parts
    expect((await cli(["--list"])).output).toMatch(/^S16 M2: ARM7, writes, reset \(M2, parts: arm7, writeMemory, setRegister, reset, tree\)$/m);
  }, 240_000);

  it("the gate that npm run check runs requires the note of the call, with --milestone", async () => {
    // (one scenario of the gate is enough to show that the note is asked for inside a gate)
    const gate = await cli(["--milestone", "M2", "--only", "S16", "--require-note", "arm7: bl stepped over and out"]);
    expect(gate.output).toMatch(/^1 passed, 0 failed, 0 partial, 0 not applicable; /m);
    expect(gate.code).toBe(0);
    const held = await cli(["--milestone", "M2", "--only", "S16", "--require-note", "arm7: held at the start"]);
    expect(held.code).toBe(1);
  }, 120_000);
});
