import { describe, expect, it } from "vitest";
import type { BreakpointDescriptor, DebuggerTick, RegisterValue } from "../lib/debuggerSchema";
import { applyTick, emptyLiveState, type LiveState, type ProgramCounterRegister } from "./tickState";

const reg = (name: string, value: string, width = 32): RegisterValue => ({ name, value, width });
const unmuted = { muted: false, soloed: false };

let nextTickId = 0;
const tick = (execution: DebuggerTick["executionState"], extra: Partial<DebuggerTick> = {}): DebuggerTick => ({
  tickId: nextTickId++,
  timestamp: 1,
  executionState: execution,
  registers: {},
  breakpoints: {},
  eventLog: [],
  watches: [],
  callstacks: { sh4: [], arm7: [] },
  categories: { events: unmuted, sh4: unmuted, arm7: unmuted, dsp: unmuted },
  ...extra,
});

const run = (ticks: DebuggerTick[], from: LiveState = emptyLiveState(), programCounters?: readonly ProgramCounterRegister[]) => {
  let state = from;
  const outcomes = ticks.map((next) => {
    const outcome = applyTick(state, next, programCounters);
    state = outcome.state;
    return outcome;
  });
  return { state, outcomes };
};

const breakpoint = (id: number, address = 0x8c0000a0): BreakpointDescriptor => ({ id, event: "dc.sh4.cpu.pc", address, kind: "code", enabled: true });

describe("registers are merged per path", () => {
  it("a path that is present replaces its list, an absent path keeps its value", () => {
    const full = tick({ state: "running", stopId: 0 }, {
      registers: { "dc.sh4.cpu": [reg("PC", "0x8C0000A0"), reg("PR", "0x8C0000A2")], "dc.sh4.tmu": [reg("TCNT0", "0xFFFFFFFF")] },
    });
    const partial = tick({ state: "running", stopId: 0 }, { registers: { "dc.sh4.cpu": [reg("PC", "0x8C0000A2"), reg("PR", "0x8C0000A4")] } });
    const { state } = run([full, partial]);
    expect(state.registersByPath["dc.sh4.cpu"]).toEqual([reg("PC", "0x8C0000A2"), reg("PR", "0x8C0000A4")]);
    expect(state.registersByPath["dc.sh4.tmu"]).toEqual([reg("TCNT0", "0xFFFFFFFF")]);
    expect(state.ticks).toBe(2);
  });

  it("a path is replaced as a whole: a register its new list does not have is gone", () => {
    const { state } = run([
      tick({ state: "running", stopId: 0 }, { registers: { "dc.timing": [reg("MODE", "fast", 0), reg("SH4_CYCLES", "0x10", 64)] } }),
      tick({ state: "running", stopId: 0 }, { registers: { "dc.timing": [reg("SH4_CYCLES", "0x20", 64)] } }),
    ]);
    expect(state.registersByPath["dc.timing"]).toEqual([reg("SH4_CYCLES", "0x20", 64)]);
  });

  it("starts from nothing: an empty state has no registers and no callstack", () => {
    const empty = emptyLiveState();
    expect(empty.registersByPath).toEqual({});
    expect(empty.callstacks).toEqual({});
    expect(empty.ticks).toBe(0);
    expect(empty.stop).toBeUndefined();
    // and two empty states share nothing that a tick could change
    expect(emptyLiveState().categories).not.toBe(empty.categories);
  });

  it("with no game loaded nothing has a value: the registers of the machine that is gone do not stay", () => {
    const { state, outcomes } = run([
      tick({ state: "running", stopId: 0 }, { registers: { "dc.sh4.cpu": [reg("PC", "0x8C0000A0")] } }),
      tick({ state: "paused", stopId: 1, reason: "no-game" }),
    ]);
    expect(state.registersByPath).toEqual({});
    expect(outcomes[1].newStop).toBe(true);
    // a server that sends "n/a" lists in that state is shown as it says
    const told = run([tick({ state: "paused", stopId: 2, reason: "no-game" }, { registers: { "dc.sh4.cpu": [reg("PC", "n/a")] } })], state);
    expect(told.state.registersByPath).toEqual({ "dc.sh4.cpu": [reg("PC", "n/a")] });
  });
});

describe("what did not change keeps its identity", () => {
  it("a tick that says the same again changes nothing a component could select", () => {
    const content = {
      registers: { "dc.sh4.cpu": [reg("PC", "0x8C0000A0")], "dc.timing": [reg("SH4_CYCLES", "0x10", 64)] },
      breakpoints: { "1": breakpoint(1) },
      eventLog: [{ eventId: "5", timestamp: 1, subsystem: "sh4", severity: "info", message: "x", metadata: { event: "dc.sh4.exception", cycles: "1" } }],
      watches: [{ id: 1, expression: "dc.sh4.cpu.pc", value: "0x8C0000A0" }],
      callstacks: { sh4: [{ index: 0, pc: 0x8c0000a0 }], arm7: [] },
    };
    const first = applyTick(emptyLiveState(), tick({ state: "paused", stopId: 1, reason: "pause" }, structuredClone(content))).state;
    const second = applyTick(first, tick({ state: "paused", stopId: 1, reason: "pause" }, structuredClone(content))).state;
    for (const key of ["executionState", "registersByPath", "breakpoints", "eventLog", "watches", "callstacks", "categories", "stop"] as const) {
      expect(second[key], key).toBe(first[key]);
    }
    expect(second.ticks).toBe(first.ticks + 1);
  });

  it("only the path whose values changed gets a new list", () => {
    const first = applyTick(
      emptyLiveState(),
      tick({ state: "running", stopId: 0 }, { registers: { "dc.sh4.cpu": [reg("PC", "0x8C0000A0")], "dc.aica.arm7": [reg("PC", "0x00200010")] } }),
    ).state;
    const second = applyTick(
      first,
      tick({ state: "running", stopId: 0 }, { registers: { "dc.sh4.cpu": [reg("PC", "0x8C0000A2")], "dc.aica.arm7": [reg("PC", "0x00200010")] } }),
    ).state;
    expect(second.registersByPath).not.toBe(first.registersByPath);
    expect(second.registersByPath["dc.aica.arm7"]).toBe(first.registersByPath["dc.aica.arm7"]);
    expect(second.registersByPath["dc.sh4.cpu"]).not.toBe(first.registersByPath["dc.sh4.cpu"]);
  });

  it("a changed watch value, a new log entry and a toggled breakpoint are new", () => {
    const first = applyTick(
      emptyLiveState(),
      tick({ state: "running", stopId: 0 }, { breakpoints: { "1": breakpoint(1) }, watches: [{ id: 1, expression: "dc.sh4.cpu.pc", value: "0x1" }] }),
    ).state;
    const second = applyTick(
      first,
      tick(
        { state: "running", stopId: 0 },
        {
          breakpoints: { "1": { ...breakpoint(1), enabled: false } },
          watches: [{ id: 1, expression: "dc.sh4.cpu.pc", value: "0x2" }],
          eventLog: [{ eventId: "1", timestamp: 1, subsystem: "sh4", severity: "info", message: "x" }],
        },
      ),
    ).state;
    expect(second.breakpoints).toEqual([{ ...breakpoint(1), enabled: false }]);
    expect(second.watches).not.toBe(first.watches);
    expect(second.eventLog).toHaveLength(1);
  });
});

describe("stops (stopId)", () => {
  it("the first paused tick of a connection is a stop", () => {
    const { outcomes, state } = run([tick({ state: "paused", stopId: 7, reason: "start" })]);
    expect(outcomes[0].newStop).toBe(true);
    expect(state.stop).toEqual({ serial: 1, stopId: 7, reason: "start", breakpointId: undefined });
    expect(state.refresh).toBe(1);
  });

  it("a paused tick with the stopId already acted on is not a stop", () => {
    const stop = { state: "paused", stopId: 3, reason: "pause" } as const;
    const { outcomes, state } = run([tick(stop), tick(stop), tick(stop, { watches: [{ id: 1, expression: "dc.sh4.cpu.pc", value: "0x1" }] })]);
    expect(outcomes.map((outcome) => outcome.newStop)).toEqual([true, false, false]);
    expect(state.stop?.serial).toBe(1);
    expect(state.refresh).toBe(1);
  });

  it("a step is a stop although the state stays paused; running ticks are never one", () => {
    const { outcomes, state } = run([
      tick({ state: "paused", stopId: 1, reason: "pause" }),
      tick({ state: "paused", stopId: 2, reason: "step" }),
      tick({ state: "running", stopId: 2 }),
      tick({ state: "running", stopId: 2 }),
      tick({ state: "paused", stopId: 3, reason: "breakpoint", breakpointId: 4 }, { breakpoints: { "4": breakpoint(4) } }),
    ]);
    expect(outcomes.map((outcome) => outcome.newStop)).toEqual([true, true, false, false, true]);
    expect(state.stop).toEqual({ serial: 3, stopId: 3, reason: "breakpoint", breakpointId: 4 });
    // the stop that was acted on last stays known while the target runs
    expect(run([tick({ state: "running", stopId: 3 })], state).state.stop).toBe(state.stop);
  });

  it("announces the breakpoint of a stop once, with its descriptor, although every paused tick of the stop repeats it", () => {
    const hit = { state: "paused", stopId: 5, reason: "breakpoint", breakpointId: 2 } as const;
    const { outcomes } = run([
      tick({ state: "running", stopId: 4 }),
      tick(hit, { breakpoints: { "2": breakpoint(2, 0x8c0000a6) } }),
      tick(hit, { breakpoints: { "2": breakpoint(2, 0x8c0000a6) } }),
      tick(hit, { breakpoints: { "2": breakpoint(2, 0x8c0000a6), "3": breakpoint(3) } }),
    ]);
    expect(outcomes.map((outcome) => outcome.hit)).toEqual([undefined, breakpoint(2, 0x8c0000a6), undefined, undefined]);
  });

  it("a client that connects into a breakpoint stop learns of it; breakpoint id 0 is an id", () => {
    const { outcomes } = run([tick({ state: "paused", stopId: 9, reason: "event", breakpointId: 0 }, { breakpoints: { "0": breakpoint(0) } })]);
    expect(outcomes[0].hit).toEqual(breakpoint(0));
    // a breakpoint the tick does not list is announced by its id
    expect(run([tick({ state: "paused", stopId: 9, reason: "breakpoint", breakpointId: 12 })]).outcomes[0].hit).toEqual({ id: 12 });
  });

  it("the first tick is remembered: where a view that waited for the connection opens", () => {
    const first = tick({ state: "paused", stopId: 1, reason: "start" }, { registers: { "dc.sh4.cpu": [reg("PC", "0xA0000000")] } });
    const { state } = run([first, tick({ state: "paused", stopId: 2, reason: "step" }, { registers: { "dc.sh4.cpu": [reg("PC", "0xA0000002")] } })]);
    expect(state.first).toEqual({ registers: first.registers, refresh: 1 });
    expect(state.refresh).toBe(2);
    expect(run([tick({ state: "running", stopId: 0 })]).state.first).toEqual({ registers: {}, refresh: 0 });
  });

  it("a game that is loaded where there was none is a moment to read again, although it is no stop", () => {
    const { state, outcomes } = run([tick({ state: "paused", stopId: 1, reason: "no-game" }), tick({ state: "running", stopId: 1 })]);
    expect(outcomes[1].newStop).toBe(false);
    expect(state.refresh).toBe(2);
    expect(state.stop?.serial).toBe(1);
    // and the tick after that is nothing special
    expect(run([tick({ state: "running", stopId: 1 })], state).state.refresh).toBe(2);
  });
});

describe("a game that is started where there was none (the ticks of the emulator, design 2.3.1)", () => {
  const cpu = (pc: string) => ({ "dc.sh4.cpu": [reg("PC", pc)] });

  it("a machine that comes up parked: host-stopped, the running tick of its thread, then the start stop", () => {
    const { state, outcomes } = run([
      tick({ state: "running", stopId: 0 }, { registers: cpu("0x8C0000A0") }),
      // the game is closed: no machine, and its ticks carry no registers
      tick({ state: "paused", stopId: 1, reason: "no-game" }),
      tick({ state: "paused", stopId: 1, reason: "no-game" }),
      // a game is started: the machine exists, its thread starts, and it parks at its start
      tick({ state: "paused", stopId: 2, reason: "host-stopped" }, { registers: cpu("n/a") }),
      tick({ state: "running", stopId: 2 }),
      tick({ state: "paused", stopId: 3, reason: "start" }, { registers: cpu("0x8C010000") }),
    ]);
    // nothing has a value while there is no game, however long that lasts
    expect(outcomes[1].state.registersByPath).toEqual({});
    expect(outcomes[2].state.registersByPath).toEqual({});
    expect(outcomes[2].state.refresh).toBe(outcomes[1].state.refresh);
    // The reason leaves no-game with the host-stopped tick: the views read again there (once: it
    // is a stop as well), and again for the start stop. The running tick between them is no moment.
    expect(outcomes.map((outcome) => outcome.state.refresh)).toEqual([0, 1, 1, 2, 2, 3]);
    expect(outcomes.map((outcome) => outcome.newStop)).toEqual([false, true, false, true, false, true]);
    expect(state.registersByPath).toEqual(cpu("0x8C010000"));
    expect(state.stop).toMatchObject({ stopId: 3, reason: "start" });
  });

  it("a machine that comes up running: the views read again although no stop follows", () => {
    const { outcomes } = run([
      tick({ state: "paused", stopId: 1, reason: "no-game" }),
      tick({ state: "paused", stopId: 2, reason: "host-stopped" }, { registers: cpu("n/a") }),
      tick({ state: "running", stopId: 2 }, { registers: cpu("0x8C010000") }),
      tick({ state: "running", stopId: 2 }, { registers: cpu("0x8C010002") }),
    ]);
    expect(outcomes.map((outcome) => outcome.state.refresh)).toEqual([1, 2, 2, 2]);
    expect(outcomes[3].state.registersByPath).toEqual(cpu("0x8C010002"));
  });
});

describe("a program counter that is written while the target is stopped", () => {
  // what `targets` of debugger.describe says about where the program counters are
  const SH4 = { pcPath: "dc.sh4.cpu", pcRegister: "PC" };
  const ARM7 = { pcPath: "dc.aica.arm7", pcRegister: "PC" };
  const DSP = { pcPath: "dc.aica.dsp", pcRegister: "STEP" };
  const LISTED = [SH4, ARM7, DSP];
  const stop = { state: "paused", stopId: 4, reason: "pause" } as const;
  const machine = (sh4: string, arm7 = "0x00200010", step = "0x05") => ({
    "dc.sh4.cpu": [reg("PC", sh4), reg("PR", "0x8C0000A2")],
    "dc.aica.arm7": [reg("PC", arm7), reg("R0", "0x00000000")],
    "dc.aica.dsp": [reg("STEP", step, 8)],
  });
  const refreshes = (ticks: DebuggerTick[], programCounters: readonly ProgramCounterRegister[] = LISTED) =>
    run(ticks, emptyLiveState(), programCounters).outcomes.map((outcome) => outcome.state.refresh);

  it("a paused tick of the stored stop with another PC moves the views; it is no stop", () => {
    const { outcomes, state } = run(
      [tick(stop, { registers: machine("0x8C0000A0") }), tick(stop, { registers: machine("0x8C0000AC") })],
      emptyLiveState(),
      LISTED,
    );
    expect(outcomes.map((outcome) => outcome.state.refresh)).toEqual([1, 2]);
    expect(outcomes.map((outcome) => outcome.newStop)).toEqual([true, false]);
    expect(state.stop).toMatchObject({ serial: 1, stopId: 4 });
    expect(outcomes[1].hit).toBeUndefined();
  });

  it("the PC of every listed target counts, whichever register it is said to be", () => {
    expect(refreshes([tick(stop, { registers: machine("0x8C0000A0") }), tick(stop, { registers: machine("0x8C0000A0", "0x00200030") })])).toEqual([1, 2]);
    expect(refreshes([tick(stop, { registers: machine("0x8C0000A0") }), tick(stop, { registers: machine("0x8C0000A0", "0x00200010", "0x06") })])).toEqual([1, 2]);
    // two of them in one tick are one moment
    expect(refreshes([tick(stop, { registers: machine("0x8C0000A0") }), tick(stop, { registers: machine("0x8C0000A2", "0x00200014") })])).toEqual([1, 2]);
    // a server that says its PC is in another register: that one counts, and `PC` does not
    const elsewhere = [{ pcPath: "dc.sh4.cpu", pcRegister: "PR" }];
    expect(refreshes([tick(stop, { registers: machine("0x8C0000A0") }), tick(stop, { registers: machine("0x8C0000AC") })], elsewhere)).toEqual([1, 1]);
    expect(
      refreshes(
        [tick(stop, { registers: machine("0x8C0000A0") }), tick(stop, { registers: { "dc.sh4.cpu": [reg("PC", "0x8C0000A0"), reg("PR", "0x8C000100")] } })],
        elsewhere,
      ),
    ).toEqual([1, 2]);
  });

  it("the same PC again, and another register that changed, move nothing", () => {
    const written = { ...machine("0x8C0000A0"), "dc.aica.arm7": [reg("PC", "0x00200010"), reg("R0", "0x00001234")] };
    expect(refreshes([tick(stop, { registers: machine("0x8C0000A0") }), tick(stop, { registers: machine("0x8C0000A0") }), tick(stop, { registers: written })])).toEqual([1, 1, 1]);
    // the same number written another way is the same PC
    expect(refreshes([tick(stop, { registers: machine("0x8C0000A0") }), tick(stop, { registers: machine("0x8c0000a0") })])).toEqual([1, 1]);
  });

  it("a new stop is one moment, also when its PC is another one", () => {
    expect(
      refreshes([tick(stop, { registers: machine("0x8C0000A0") }), tick({ state: "paused", stopId: 5, reason: "step" }, { registers: machine("0x8C0000A2") })]),
    ).toEqual([1, 2]);
  });

  it("a running tick moves nothing, whatever its PC; the stop that ends the run does, once", () => {
    expect(
      refreshes([
        tick(stop, { registers: machine("0x8C0000A0") }),
        tick({ state: "running", stopId: 4 }, { registers: machine("0x8C0000A4") }),
        tick({ state: "running", stopId: 4 }, { registers: machine("0x8C0000A8") }),
        tick({ state: "paused", stopId: 5, reason: "pause" }, { registers: machine("0x8C0000AC") }),
      ]),
    ).toEqual([1, 1, 1, 2]);
  });

  it("a tick without a stopId is of no stop: its PC moves nothing", () => {
    expect(refreshes([tick(stop, { registers: machine("0x8C0000A0") }), tick({ state: "paused", reason: "pause" }, { registers: machine("0x8C0000AC") })])).toEqual([1, 1]);
  });

  it("a tick that does not carry the register, or carries no number in it, shows no other PC", () => {
    expect(
      refreshes([
        tick(stop, { registers: machine("0x8C0000A0") }),
        // the node of another device alone
        tick(stop, { registers: { "dc.sh4.tmu": [reg("TCNT0", "0x00000001")] } }),
        // the node without its PC
        tick(stop, { registers: { "dc.sh4.cpu": [reg("PR", "0x8C0000A2")] } }),
        tick(stop, { registers: machine("n/a") }),
        // behind "n/a" nothing is stored that a PC could be another one than
        tick(stop, { registers: machine("0x8C0000AC") }),
        tick(stop, { registers: machine("0x8C0000AE") }),
      ]),
    ).toEqual([1, 1, 1, 1, 1, 2]);
  });

  it("only the PCs of listed targets count: a server that lists none moves no view this way", () => {
    const ticks = () => [tick(stop, { registers: machine("0x8C0000A0") }), tick(stop, { registers: machine("0x8C0000AC", "0x00200030") })];
    expect(refreshes(ticks(), [])).toEqual([1, 1]);
    // (and so does a caller that names none)
    expect(run(ticks()).outcomes.map((outcome) => outcome.state.refresh)).toEqual([1, 1]);
    expect(refreshes(ticks(), [DSP])).toEqual([1, 1]);
    expect(refreshes(ticks(), [ARM7])).toEqual([1, 2]);
  });

  it("no tick advances the counter of this client's writes, and a tick keeps it", () => {
    const written = { ...emptyLiveState(), reread: 3 };
    const { outcomes } = run(
      [tick(stop, { registers: machine("0x8C0000A0") }), tick(stop, { registers: machine("0x8C0000AC") }), tick({ state: "running", stopId: 4 })],
      written,
      LISTED,
    );
    expect(outcomes.map((outcome) => outcome.state.reread)).toEqual([3, 3, 3]);
    expect(emptyLiveState().reread).toBe(0);
  });
});

describe("ticks without a stopId", () => {
  it("are no stop: none is made from the first paused tick, nor from running, then paused", () => {
    const { outcomes, state } = run([
      tick({ state: "paused" }),
      tick({ state: "paused" }),
      tick({ state: "running" }),
      tick({ state: "paused" }),
      tick({ state: "paused", reason: "breakpoint" }),
    ]);
    expect(outcomes.map((outcome) => outcome.newStop)).toEqual([false, false, false, false, false]);
    expect(state.stop).toBeUndefined();
    // the views are not moved: `refresh` is what makes them read again and follow the PC
    expect(outcomes.map((outcome) => outcome.state.refresh)).toEqual([0, 0, 0, 0, 0]);
    expect(state.first).toEqual({ registers: {}, refresh: 0 });
    // what the tick says is still shown
    expect(state.executionState).toEqual({ state: "paused", reason: "breakpoint" });
  });

  it("announce no breakpoint: a breakpoint is announced with its stop", () => {
    const { outcomes } = run([
      tick({ state: "running" }),
      tick({ state: "paused", breakpointId: 1 }, { breakpoints: { "1": breakpoint(1) } }),
      tick({ state: "paused" }, { breakpoints: { "1": breakpoint(1) } }),
    ]);
    expect(outcomes.map((outcome) => outcome.hit)).toEqual([undefined, undefined, undefined]);
  });

  it("leave the stop that was acted on as it is, and the next tick with its stopId is not a stop again", () => {
    const stopped = run([tick({ state: "paused", stopId: 4, reason: "breakpoint", breakpointId: 1 }, { breakpoints: { "1": breakpoint(1) } })]);
    const { outcomes, state } = run(
      [
        tick({ state: "running" }),
        tick({ state: "paused", breakpointId: 1 }, { breakpoints: { "1": breakpoint(1) } }),
        tick({ state: "paused", stopId: 4, reason: "breakpoint", breakpointId: 1 }, { breakpoints: { "1": breakpoint(1) } }),
        tick({ state: "paused", stopId: 5, reason: "step" }),
      ],
      stopped.state,
    );
    expect(outcomes.map((outcome) => outcome.newStop)).toEqual([false, false, false, true]);
    expect(outcomes.map((outcome) => outcome.hit)).toEqual([undefined, undefined, undefined, undefined]);
    expect(outcomes[1].state.stop).toBe(stopped.state.stop);
    expect(state.stop).toEqual({ serial: 2, stopId: 5, reason: "step", breakpointId: undefined });
    expect(state.refresh).toBe(2);
  });

  it("a running tick with a stopId that was not acted on is no stop either; stopId 0 of a paused tick is one", () => {
    const { outcomes, state } = run([tick({ state: "running", stopId: 3 }), tick({ state: "paused", stopId: 0, reason: "pause" })]);
    expect(outcomes.map((outcome) => outcome.newStop)).toEqual([false, true]);
    expect(state.stop).toEqual({ serial: 1, stopId: 0, reason: "pause", breakpointId: undefined });
  });
});

describe("callstacks", () => {
  const frames = { sh4: [{ index: 0, pc: 0x8c0000a0 }], arm7: [{ index: 0, pc: 0x00200010 }] };

  it("are what the tick says: the server sends empty arrays while the target runs", () => {
    const { state } = run([tick({ state: "paused", stopId: 1, reason: "pause" }, { callstacks: frames }), tick({ state: "running", stopId: 1 })]);
    expect(state.callstacks).toEqual({ sh4: [], arm7: [] });
  });

  it("a tick without `callstacks` has no frames: none are kept from the stop before, paused or running", () => {
    const stop = { state: "paused", stopId: 1, reason: "pause" } as const;
    const paused = run([tick(stop, { callstacks: frames }), tick(stop, { callstacks: undefined })]);
    expect(paused.outcomes[0].state.callstacks).toEqual(frames);
    expect(paused.state.callstacks).toEqual({});
    const running = run([tick(stop, { callstacks: frames }), tick({ state: "running", stopId: 1 }, { callstacks: undefined })]);
    expect(running.state.callstacks).toEqual({});
    // and the frames of a later tick are shown again
    expect(run([tick(stop, { callstacks: frames })], paused.state).state.callstacks).toEqual(frames);
  });
});

describe("watches", () => {
  it("are those of the tick, and none when the tick has no `watches`", () => {
    const watch = { id: 1, expression: "dc.sh4.cpu.pc", value: "0x8C0000A0" };
    const watched = run([tick({ state: "running", stopId: 0 }, { watches: [watch] })]);
    expect(watched.state.watches).toEqual([watch]);
    expect(run([tick({ state: "running", stopId: 0 }, { watches: undefined })], watched.state).state.watches).toEqual([]);
  });
});

describe("category states", () => {
  it("are taken from the tick, for the keys the client knows", () => {
    const { state } = run([
      tick({ state: "running", stopId: 0 }, {
        categories: { events: unmuted, sh4: { muted: true, soloed: false }, arm7: { muted: false, soloed: true }, dsp: unmuted, netplay: { muted: true, soloed: true } },
      }),
    ]);
    expect(state.categories).toEqual({ events: unmuted, sh4: { muted: true, soloed: false }, arm7: { muted: false, soloed: true }, dsp: unmuted });
  });

  it("keep their state when a tick has no `categories`, or lacks a key", () => {
    const muted = run([tick({ state: "running", stopId: 0 }, { categories: { sh4: { muted: true, soloed: false } } })]);
    expect(muted.state.categories.sh4).toEqual({ muted: true, soloed: false });
    expect(muted.state.categories.dsp).toEqual(unmuted);
    const after = run([tick({ state: "running", stopId: 0 }, { categories: undefined })], muted.state);
    expect(after.state.categories).toBe(muted.state.categories);
    // per key: the tick carries one key, and the other three keep what they had
    const soloed = run([tick({ state: "running", stopId: 0 }, { categories: { arm7: { muted: false, soloed: true } } })], after.state);
    expect(soloed.state.categories).toEqual({ events: unmuted, sh4: { muted: true, soloed: false }, arm7: { muted: false, soloed: true }, dsp: unmuted });
  });
});
