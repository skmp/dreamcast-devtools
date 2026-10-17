import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseBinaryFrame } from "../src/lib/binaryFrame";
import { decodeInst, disassembleDesc } from "../src/app/dsp/dspUtils";
import { IN_BAND_ERROR_METHODS, StrictDebuggerRpcMethodSchemas } from "../src/lib/debuggerSchema";
import type { DebuggerShape, DebuggerTick } from "../src/lib/debuggerSchema";
import {
  MOCK_ARM7_CALL,
  MOCK_ARM7_LEAF,
  MOCK_ARM7_RELEASE_STEPS,
  MOCK_ARM7_RING,
  MOCK_DSP_PROGRAM,
  MOCK_DSP_WORDS,
  MOCK_EVENTS,
  MOCK_M1_SUPPORT,
  MOCK_M2_SUPPORT,
  MOCK_M3_SUPPORT,
  MOCK_SH4_HANDLER,
  MOCK_SH4_RING,
  MOCK_SH4_VBR,
  MockDebugger,
  mockNextAddress,
  mockStoreOf,
} from "./mockDebugger";
import type { MockDebuggerOptions } from "./mockDebugger";

interface Frame {
  jsonrpc: string;
  id?: number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

const BASE_PATHS = ["dc.aica.arm7", "dc.aica.dsp", "dc.sh4.cpu", "dc.timing"];

/**
 * Real, monotonic time for the timing tests: performance.now taken at module load, before beforeEach's fake timers
 * replace it (they stop performance.now() and process.hrtime()). Not vi.getRealSystemTime(): that is the wall clock
 * (the real Date.now), which a host may step forward by seconds at any moment (a resync of the clock).
 */
const monotonicNow = performance.now.bind(performance);

/** Every text frame the mock sent in a test, as sent: for the "no null" rule. */
let wire: string[] = [];
let mocks: MockDebugger[] = [];

const createMock = (options: MockDebuggerOptions = {}) => {
  const mock = new MockDebugger(options);
  mocks.push(mock);
  mock.start();
  return mock;
};

const connect = (mock: MockDebugger) => {
  const frames: Frame[] = [];
  const binary: Uint8Array[] = [];
  const state = { queuedBytes: 0 };
  const client = mock.connect({
    sendText: (text) => {
      wire.push(text);
      frames.push(JSON.parse(text) as Frame);
    },
    sendBinary: (frame) => binary.push(frame),
    queuedBytes: () => state.queuedBytes,
  });
  let id = 0;
  const ticks = () => frames.filter((frame) => frame.method === "event.tick").map((frame) => frame.params as DebuggerTick);
  const api = {
    client,
    frames,
    binary,
    state,
    ticks,
    lastTick: () => ticks().at(-1)!,
    /** Sends a request and returns its response, which the mock sends synchronously (except state.recordSgcFrames). */
    call(method: string, params: unknown = {}): Frame {
      const requestId = ++id;
      client.receive(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }));
      return frames.find((frame) => frame.id === requestId && frame.method === undefined)!;
    },
    /** The result of a request that must succeed. */
    ok(method: string, params: unknown = {}): unknown {
      const response = api.call(method, params);
      expect(response.error, `${method}: ${JSON.stringify(response.error)}`).toBeUndefined();
      expect((response.result as { error?: unknown }).error, `${method}: ${JSON.stringify(response.result)}`).toBeUndefined();
      return response.result;
    },
    /**
     * The error of a request that must fail, checked for its channel and its code. The texts are
     * the mock's own: a message has to be there, and no test depends on what it says.
     */
    fail(method: string, params: unknown, code: number): { code: number; message: string } {
      const response = api.call(method, params);
      const inBand = IN_BAND_ERROR_METHODS.has(method) && code !== -32601;
      const error = inBand ? (response.result as { error: { code: number; message: string } }).error : response.error!;
      expect(error, `${method} should fail ${inBand ? "in-band" : "with a JSON-RPC error"}: ${JSON.stringify(response)}`).toBeDefined();
      expect(inBand ? response.error : response.result).toBeUndefined();
      expect(Object.keys(error).sort()).toEqual(["code", "message"]);
      expect(error.code).toBe(code);
      expect(typeof error.message === "string" && error.message.length > 0, `${method}: a message that is not empty`).toBe(true);
      return error;
    },
    send: (text: string) => client.receive(text),
    describe: () => api.ok("debugger.describe", { protocol: 3, client: "vitest" }) as DebuggerShape,
    pc: (tick: DebuggerTick = api.lastTick()) => Number.parseInt(tick.registers["dc.sh4.cpu"].find((register) => register.name === "PC")!.value, 16),
  };
  return api;
};

const containsNull = (value: unknown): boolean =>
  value === null || (typeof value === "object" && Object.values(value as object).some(containsNull));

const registeredPaths = (shape: DebuggerShape): string[] => {
  const paths: string[] = [];
  const visit = (nodes: DebuggerShape["deviceTree"]) => {
    for (const node of nodes) {
      if (node.registers) paths.push(node.path);
      if (node.children) visit(node.children);
    }
  };
  visit(shape.deviceTree);
  return paths.sort();
};

beforeEach(() => {
  vi.useFakeTimers();
  wire = [];
  mocks = [];
});

afterEach(() => {
  mocks.forEach((mock) => mock.stop());
  vi.useRealTimers();
  // every frame of every test: the strict schema for ticks, and no null anywhere but the id of a parse error
  for (const text of wire) {
    const frame = JSON.parse(text) as Frame;
    if (frame.method === "event.tick") {
      const parsed = StrictDebuggerRpcMethodSchemas["event.tick"].params.safeParse(frame.params);
      expect(parsed.success ? [] : parsed.error.issues, text.slice(0, 200)).toEqual([]);
    }
    if (frame.error?.code !== -32700 && frame.error?.code !== -32600) {
      expect(containsNull(frame), text.slice(0, 200)).toBe(false);
    }
  }
});

describe("tick policy", () => {
  it("answers debugger.describe and then sends a full tick to that client only", () => {
    const mock = createMock();
    const first = connect(mock);
    const second = connect(mock);
    const shape = first.describe();

    expect(first.frames.map((frame) => frame.method ?? "response")).toEqual(["response", "event.tick"]);
    expect(second.frames).toEqual([]);
    expect(StrictDebuggerRpcMethodSchemas["debugger.describe"].result.safeParse(shape).success).toBe(true);
    expect(shape.protocol).toBe(3);
    expect(shape.ui).toBe("none");
    expect(shape.capabilities).toEqual(["event-breakpoints", "callstack", "memory-write", "register-write", "reset", "sgc-capture", "memory-binary", "sh4-debug-native"]);
    expect(shape.targets!.map((target) => target.id)).toEqual(["sh4", "arm7", "dsp"]);

    const tick = first.lastTick();
    expect(Object.keys(tick.registers).sort()).toEqual(registeredPaths(shape));
    expect(tick.executionState).toEqual({ state: "running", stopId: 0 });
    expect(tick.callstacks).toEqual({ sh4: [], arm7: [] });
    expect(Object.keys(tick.categories!)).toEqual(["events", "sh4", "arm7", "dsp"]);
    // the register lists of a tick are the describe names, in describe order
    const cpu = shape.deviceTree[0].children![0].children![0];
    expect(cpu.path).toBe("dc.sh4.cpu");
    expect(tick.registers["dc.sh4.cpu"].map((register) => register.name)).toEqual(cpu.registers!.map((register) => register.name));
  });

  it("sends a tick every 200 ms while running, every fifth one full, and none while paused or without a client", async () => {
    const mock = createMock();
    await vi.advanceTimersByTimeAsync(1000);
    const session = connect(mock);
    const shape = session.describe();
    const all = registeredPaths(shape);
    session.frames.length = 0;

    await vi.advanceTimersByTimeAsync(2000);
    const ticks = session.ticks();
    expect(ticks).toHaveLength(10);
    const full = ticks.map((tick) => Object.keys(tick.registers).length === all.length);
    expect(full.filter(Boolean)).toHaveLength(2);
    expect(full.indexOf(true) + 5).toBe(full.lastIndexOf(true));
    for (const tick of ticks) {
      expect(tick.executionState).toEqual({ state: "running", stopId: 0 });
      expect(tick.callstacks).toEqual({ sh4: [], arm7: [] });
      if (Object.keys(tick.registers).length !== all.length) {
        expect(Object.keys(tick.registers).sort()).toEqual(BASE_PATHS);
      }
    }
    // tickId strictly increases, and the machine runs between the ticks
    for (let index = 1; index < ticks.length; index++) {
      expect(ticks[index].tickId).toBeGreaterThan(ticks[index - 1].tickId);
      const cycles = (tick: DebuggerTick) => BigInt(tick.registers["dc.timing"].find((register) => register.name === "SH4_CYCLES")!.value);
      expect(cycles(ticks[index])).toBeGreaterThan(cycles(ticks[index - 1]));
    }

    session.ok("control.pause");
    session.frames.length = 0;
    await vi.advanceTimersByTimeAsync(2000);
    expect(session.frames).toEqual([]);
  });

  it("pauses: {} and then one full paused tick with a new stopId and reason pause; a second pause changes nothing", () => {
    const mock = createMock();
    const session = connect(mock);
    const shape = session.describe();

    expect(session.call("control.pause", { target: "arm7" }).result).toEqual({});
    const tick = session.lastTick();
    expect(tick.executionState).toEqual({ state: "paused", stopId: 1, reason: "pause" });
    expect(Object.keys(tick.registers).sort()).toEqual(registeredPaths(shape));
    expect(tick.callstacks!.sh4[0].pc).toBe(session.pc());
    expect(tick.callstacks!.sh4[1]).toMatchObject({ index: 1, location: "pr" });
    expect(tick.callstacks!.arm7[1]).toMatchObject({ index: 1, location: "lr" });
    expect(tick.callstacks!.sh4[2].location).toBe("stack+0x0");

    const before = session.frames.length;
    expect(session.call("control.pause").result).toEqual({});
    expect(session.frames.length).toBe(before + 1); // the response, no tick
  });

  it("takes a pause for every target id, listed or not, and refuses any other string with -32602", () => {
    // there is one run state: the target of a pause is ignored when it is a target id
    for (const options of [undefined, { supports: { targets: ["sh4" as const] } }, { supports: MOCK_M1_SUPPORT }]) {
      const session = connect(createMock(options));
      session.describe();
      expect(session.call("control.pause", { target: "dsp" }).result).toEqual({});
      expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: 1, reason: "pause" });
      const ticks = session.ticks().length;
      for (const target of ["sh4", "arm7", "dsp"]) {
        expect(session.call("control.pause", { target }).result).toEqual({});
      }
      expect(session.ticks()).toHaveLength(ticks);
      session.fail("control.pause", { target: "gpu" }, -32602);
      session.fail("control.pause", { target: 4 }, -32602);
      expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: 1, reason: "pause" });
    }
  });

  it("resumes: {} and a running tick without reason; a second resume changes nothing", async () => {
    const mock = createMock();
    const session = connect(mock);
    session.describe();
    session.ok("control.pause");
    session.frames.length = 0;

    expect(session.call("control.runUntil").result).toEqual({});
    expect(session.ticks()).toHaveLength(1);
    expect(session.lastTick().executionState).toEqual({ state: "running", stopId: 1 });
    expect(session.lastTick().callstacks).toEqual({ sh4: [], arm7: [] });
    expect(Object.keys(session.lastTick().registers).sort()).toEqual(BASE_PATHS);

    const before = session.frames.length;
    expect(session.call("control.runUntil").result).toEqual({});
    expect(session.frames.length).toBe(before + 1);
  });

  it("steps: one paused tick with a new stopId and reason step, no running tick, the next address of the loop", () => {
    const mock = createMock();
    const session = connect(mock);
    session.describe();
    session.ok("control.pause");
    let pc = session.pc();
    let stopId = session.lastTick().executionState.stopId!;

    for (let index = 0; index < 9; index++) {
      session.frames.length = 0;
      expect(session.call(index % 2 ? "control.stepOver" : "control.step", { target: "sh4" }).result).toEqual({});
      expect(session.ticks()).toHaveLength(1);
      expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: stopId + 1, reason: "step" });
      expect(session.pc()).toBe(mockNextAddress("sh4", pc));
      pc = session.pc();
      stopId++;
    }
    // nine steps around a loop of eight
    expect(pc).toBeGreaterThanOrEqual(MOCK_SH4_RING.base);
    expect(pc).toBeLessThan(MOCK_SH4_RING.base + 16);

    // the other targets step on their own
    const arm7Pc = () => Number.parseInt(session.lastTick().registers["dc.aica.arm7"][0].value, 16);
    const before = arm7Pc();
    session.ok("control.step", { target: "arm7" });
    expect(arm7Pc()).toBe(mockNextAddress("arm7", before));
    expect(session.pc()).toBe(pc);
    session.ok("control.step", { target: "dsp" });
    expect(session.lastTick().registers["dc.aica.dsp"][0]).toMatchObject({ name: "STEP", value: expect.stringMatching(/^0x[0-9A-F]{2}$/) });
  });

  it("steps out: a running tick, then a paused tick with reason step at the start of the loop", async () => {
    const mock = createMock();
    const session = connect(mock);
    session.describe();
    session.ok("control.pause");
    session.ok("control.step", { target: "sh4" });
    const stopId = session.lastTick().executionState.stopId!;
    session.frames.length = 0;

    expect(session.call("control.stepOut", { target: "sh4" }).result).toEqual({});
    expect(session.lastTick().executionState).toEqual({ state: "running", stopId });
    await vi.advanceTimersByTimeAsync(8 * 16);
    expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: stopId + 1, reason: "step" });
    expect(session.pc()).toBe(MOCK_SH4_RING.base);
    expect(session.ticks().map((tick) => tick.executionState.state)).toEqual(["running", "paused"]);
  });

  it("stops at a code breakpoint with reason breakpoint, and repeats breakpointId in every paused tick of that stop", async () => {
    const mock = createMock();
    const session = connect(mock);
    session.describe();
    session.ok("control.pause");
    const address = mockNextAddress("sh4", mockNextAddress("sh4", session.pc()));

    // kind defaults to "code" when an address is given; ids count from 1 and are in the next tick
    session.ok("breakpoints.add", { event: "dc.sh4.cpu.pc", address });
    expect(session.lastTick().breakpoints).toEqual({ "1": { id: 1, event: "dc.sh4.cpu.pc", address, kind: "code", enabled: true } });
    const stopId = session.lastTick().executionState.stopId!;

    session.ok("control.runUntil");
    await vi.advanceTimersByTimeAsync(32);
    expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: stopId + 1, reason: "breakpoint", breakpointId: 1 });
    expect(session.pc()).toBe(address);

    // another paused tick of the same stop
    session.ok("state.watch", { expressions: ["dc.sh4.cpu.pr"] });
    expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: stopId + 1, reason: "breakpoint", breakpointId: 1 });

    // resuming executes the instruction once without testing it; the next arrival stops again, a lap later
    session.ok("control.runUntil");
    await vi.advanceTimersByTimeAsync(7 * 16);
    expect(session.lastTick().executionState.state).toBe("running");
    await vi.advanceTimersByTimeAsync(16);
    expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: stopId + 2, reason: "breakpoint", breakpointId: 1 });

    // removing another breakpoint changes nothing about the stop ...
    session.ok("breakpoints.add", { event: "dc.sh4.cpu.pc", address, enabled: false });
    session.ok("breakpoints.remove", { id: 2 });
    expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: stopId + 2, reason: "breakpoint", breakpointId: 1 });
    // ... and when its own breakpoint is removed, the ticks of the stop keep the reason and stop carrying the id
    session.ok("breakpoints.remove", { id: 1 });
    expect(session.lastTick().breakpoints).toEqual({});
    expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: stopId + 2, reason: "breakpoint" });
    session.ok("state.unwatch", { watchIds: [1] });
    expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: stopId + 2, reason: "breakpoint" });
  });

  describe("the interrupt of the vertical blank", () => {
    const HANDLER = MOCK_SH4_HANDLER.base;
    const register = (tick: DebuggerTick, name: string) => Number.parseInt(tick.registers["dc.sh4.cpu"].find((entry) => entry.name === name)!.value, 16);
    const inLoop = (pc: number) => pc >= MOCK_SH4_RING.base && pc < MOCK_SH4_RING.base + MOCK_SH4_RING.length * 2;

    it("has its handler at VBR + 0x600: two instructions, rte and its delay slot", () => {
      const session = connect(createMock());
      session.describe();
      expect(HANDLER).toBe(MOCK_SH4_VBR + 0x600);
      expect(register(session.lastTick(), "VBR")).toBe(MOCK_SH4_VBR);
      const { lines } = session.ok("state.getDisassembly", { target: "sh4", address: HANDLER, count: 4 }) as { lines: Array<{ address: number; disassembly: string }> };
      expect(lines.map((line) => [line.address, line.disassembly])).toEqual([
        [HANDLER, "mov.l r0, @-r15"],
        [HANDLER + 2, "mov.l @r15+, r0"],
        [HANDLER + 4, "rte"],
        [HANDLER + 6, "nop"],
      ]);
    });

    it("leaves the loop for the handler in every frame and comes back: between frames the PC is in the loop, one instruction on", async () => {
      const session = connect(createMock());
      session.describe();
      session.ok("breakpoints.add", { event: "dc.sh4.interrupt", enabled: false });
      const before = session.lastTick().eventLog.length;
      let pc = session.pc();
      for (let frame = 0; frame < 20; frame++) {
        await vi.advanceTimersByTimeAsync(16);
        session.ok("state.unwatch", { watchIds: [] });
        expect(session.pc()).toBe(mockNextAddress("sh4", pc));
        pc = session.pc();
        // back from the handler: interrupts are not blocked, and SPC is where it came back to
        expect(register(session.lastTick(), "SR") & 0x10000000).toBe(0);
        expect(register(session.lastTick(), "SPC")).toBe(pc);
      }
      // one interrupt a frame
      const accepted = session.lastTick().eventLog.slice(before).filter((entry) => (entry.metadata as { event: string }).event === "dc.sh4.interrupt");
      expect(accepted).toHaveLength(20);
      expect(session.lastTick().executionState.state).toBe("running");
    });

    it("stops at a breakpoint on the interrupt entry in the next frame, also when it is added while running; a disabled one is passed", async () => {
      const session = connect(createMock());
      session.describe();
      const sr = register(session.lastTick(), "SR");
      session.ok("breakpoints.add", { event: "dc.sh4.cpu.pc", address: HANDLER });
      expect(session.lastTick().executionState.state).toBe("running");
      await vi.advanceTimersByTimeAsync(16);
      const stop = session.lastTick();
      expect(stop.executionState).toEqual({ state: "paused", stopId: 1, reason: "breakpoint", breakpointId: 1 });
      expect(session.pc()).toBe(HANDLER);
      // the context of an accepted interrupt: where it came from, what SR was, interrupts blocked
      expect(inLoop(register(stop, "SPC"))).toBe(true);
      expect(register(stop, "SSR")).toBe(sr);
      expect(register(stop, "SR")).toBe((sr | 0x30000000) >>> 0);
      expect(stop.callstacks!.sh4[0]).toMatchObject({ pc: HANDLER, symbol: "_irq_handler+0x0" });

      // resumed, the handler is left through its rte, and the next vertical blank stops there again
      const returnTo = register(stop, "SPC");
      session.ok("control.runUntil");
      await vi.advanceTimersByTimeAsync(16);
      expect(session.lastTick().executionState).toEqual({ state: "running", stopId: 1 });
      session.ok("state.unwatch", { watchIds: [] });
      expect(session.pc()).toBe(returnTo);
      await vi.advanceTimersByTimeAsync(16);
      expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: 2, reason: "breakpoint", breakpointId: 1 });
      expect(session.pc()).toBe(HANDLER);
      expect(register(session.lastTick(), "SPC")).toBe(mockNextAddress("sh4", returnTo));

      // disabled, the target runs through its vertical blanks; enabled again while it runs, it is hit
      session.ok("breakpoints.toggle", { id: 1, enabled: false });
      session.ok("control.runUntil");
      await vi.advanceTimersByTimeAsync(10 * 16);
      expect(session.lastTick().executionState.state).toBe("running");
      session.ok("breakpoints.toggle", { id: 1, enabled: true });
      await vi.advanceTimersByTimeAsync(16);
      expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: 3, reason: "breakpoint", breakpointId: 1 });
      expect(session.pc()).toBe(HANDLER);
    });

    it("steps through the handler: rte executes with its delay slot and returns to SPC; a step out ends behind the rte", async () => {
      const session = connect(createMock());
      session.describe();
      session.ok("breakpoints.add", { event: "dc.sh4.cpu.pc", address: HANDLER });
      await vi.advanceTimersByTimeAsync(16);
      const stop = session.lastTick();
      const [spc, ssr] = [register(stop, "SPC"), register(stop, "SSR")];
      session.ok("control.step", { target: "sh4" });
      expect(session.pc()).toBe(HANDLER + 2);
      session.ok("control.stepOver", { target: "sh4" });
      expect(session.pc()).toBe(HANDLER + 4);
      session.ok("control.step", { target: "sh4" });
      expect(session.lastTick().executionState).toMatchObject({ state: "paused", reason: "step" });
      expect(session.pc()).toBe(spc);
      expect(register(session.lastTick(), "SR")).toBe(ssr);
      // no interrupt is taken in a step: the next step is the next instruction of the loop
      session.ok("control.step", { target: "sh4" });
      expect(session.pc()).toBe(mockNextAddress("sh4", spc));

      // a step out that is asked for in the handler: the return is the rte, in the next frame
      session.ok("control.runUntil");
      await vi.advanceTimersByTimeAsync(16);
      expect(session.lastTick().executionState).toMatchObject({ state: "paused", reason: "breakpoint", breakpointId: 1 });
      const back = register(session.lastTick(), "SPC");
      const stopId = session.lastTick().executionState.stopId!;
      session.ok("breakpoints.remove", { id: 1 });
      session.frames.length = 0;
      session.ok("control.stepOut", { target: "sh4" });
      await vi.advanceTimersByTimeAsync(16);
      expect(session.ticks().map((tick) => tick.executionState)).toEqual([
        { state: "running", stopId },
        { state: "paused", stopId: stopId + 1, reason: "step" },
      ]);
      expect(session.pc()).toBe(back);
    });

    it("takes no interrupt while SR.BL is set, as a program that blocks them", async () => {
      const session = connect(createMock());
      session.describe();
      session.ok("control.pause");
      const pc = session.pc();
      session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "SR", value: "0x50000000" });
      session.ok("breakpoints.add", { event: "dc.sh4.cpu.pc", address: HANDLER });
      session.ok("breakpoints.add", { event: "dc.sh4.interrupt", enabled: false });
      session.ok("control.runUntil");
      await vi.advanceTimersByTimeAsync(8 * 16);
      expect(session.lastTick().executionState.state).toBe("running");
      session.ok("control.pause");
      expect(session.pc()).toBe(pc);
      expect(session.lastTick().eventLog.filter((entry) => (entry.metadata as { event: string }).event === "dc.sh4.interrupt")).toEqual([]);
    });
  });

  it("compares SH4 code addresses masked, reports the lowest id when several match, and never reuses an id", async () => {
    const mock = createMock();
    const session = connect(mock);
    session.describe();
    session.ok("control.pause");
    const address = mockNextAddress("sh4", session.pc());
    const mirror = ((address & 0x1fffffff) | 0xa0000000) >>> 0;

    session.ok("breakpoints.add", { event: "dc.sh4.cpu.pc", address });
    session.ok("breakpoints.remove", { id: 1 });
    session.ok("breakpoints.add", { event: "dc.sh4.cpu.pc", address: mirror, kind: "code", enabled: true });
    session.ok("breakpoints.add", { event: "dc.sh4.cpu.pc", address });
    // the address is reported as the client gave it
    expect(session.lastTick().breakpoints).toEqual({
      "2": { id: 2, event: "dc.sh4.cpu.pc", address: mirror, kind: "code", enabled: true },
      "3": { id: 3, event: "dc.sh4.cpu.pc", address, kind: "code", enabled: true },
    });

    session.ok("control.runUntil");
    await vi.advanceTimersByTimeAsync(16);
    expect(session.lastTick().executionState).toMatchObject({ state: "paused", reason: "breakpoint", breakpointId: 2 });
    expect(session.pc()).toBe(address);
  });

  it("does not stop at a disabled breakpoint, nor at one of a muted or not-soloed category, and echoes the categories", async () => {
    const mock = createMock();
    const session = connect(mock);
    session.describe();
    session.ok("control.pause");
    session.ok("breakpoints.add", { event: "dc.sh4.cpu.pc", address: mockNextAddress("sh4", session.pc()) });
    const runs = async () => {
      session.ok("control.runUntil");
      await vi.advanceTimersByTimeAsync(600);
      const running = session.lastTick().executionState.state === "running";
      if (running) {
        session.ok("control.pause");
      }
      return running;
    };
    const unmuted = { muted: false, soloed: false };

    session.ok("breakpoints.toggle", { id: 1, enabled: false });
    expect(session.lastTick().breakpoints["1"].enabled).toBe(false);
    expect(await runs()).toBe(true);
    session.ok("breakpoints.toggle", { id: 1, enabled: true });

    // absent keys keep their state, unknown keys are ignored
    session.ok("breakpoints.setCategoryStates", { categories: { sh4: { muted: true, soloed: false }, gdrom: { muted: true, soloed: true } } });
    expect(session.lastTick().categories).toEqual({ events: unmuted, sh4: { muted: true, soloed: false }, arm7: unmuted, dsp: unmuted });
    expect(await runs()).toBe(true);

    session.ok("breakpoints.setCategoryStates", { categories: { sh4: unmuted, arm7: { muted: false, soloed: true } } });
    expect(session.lastTick().categories).toEqual({ events: unmuted, sh4: unmuted, arm7: { muted: false, soloed: true }, dsp: unmuted });
    expect(await runs()).toBe(true);

    session.ok("breakpoints.setCategoryStates", { categories: { arm7: unmuted } });
    expect(await runs()).toBe(false);
    expect(session.lastTick().executionState).toMatchObject({ reason: "breakpoint", breakpointId: 1 });
  });

  it("stops at a DSP code breakpoint within one emulation step: the DSP executes every sample of its time", async () => {
    const mock = createMock();
    const session = connect(mock);
    session.describe();
    session.ok("control.pause");
    session.ok("breakpoints.add", { event: "dc.aica.dsp.step", address: 100 });
    session.ok("control.runUntil");
    await vi.advanceTimersByTimeAsync(16);
    expect(session.lastTick().executionState).toMatchObject({ state: "paused", reason: "breakpoint", breakpointId: 1 });
    expect(session.lastTick().registers["dc.aica.dsp"][0]).toEqual({ name: "STEP", value: "0x64", width: 8 });
    // the widths of the DSP's registers are those of the hardware, and of the M3 round's M3-D25
    expect(session.lastTick().registers["dc.aica.dsp"].map((register) => [register.name, register.width])).toEqual([
      ["STEP", 8],
      ["MDEC_CT", 16],
      ["RBP", 16],
      ["RBL", 8],
      ["ACC", 26],
      ["Y_REG", 24],
      ["FRC_REG", 13],
      ["ADRS_REG", 12],
      ["LATCH", 16],
      ["LATCH_COPY", 16],
      ["MEMVAL", 16],
      ["NOFL_PIPE", 2],
      ["MIXS_BANK", 1],
    ]);
  });

  it("dc.aica.arm7 has the register ENABLED behind PC: width 1, and 1 in every tick while the mock's ARM7 runs", async () => {
    const mock = createMock();
    const session = connect(mock);
    const shape = session.describe();
    const arm7 = shape.deviceTree[0].children!.find((node) => node.path === "dc.aica")!.children!.find((node) => node.path === "dc.aica.arm7")!;
    // (PC has a writer and says so in debugger.describe; ENABLED has none)
    expect(arm7.registers!.slice(0, 2)).toEqual([
      { name: "PC", value: "0x00200010", width: 32, flags: { writable: true } },
      { name: "ENABLED", value: "0x1", width: 1 },
    ]);
    const enabled = () => session.lastTick().registers["dc.aica.arm7"][1];

    // a running tick that is not full carries it: dc.aica.arm7 is one of the four base paths
    await vi.advanceTimersByTimeAsync(200);
    expect(Object.keys(session.lastTick().registers).sort()).toEqual(BASE_PATHS);
    expect(enabled()).toEqual({ name: "ENABLED", value: "0x1", width: 1 });
    expect(session.lastTick().callstacks!.arm7).toEqual([]);

    // a paused tick: the ARM7 is clocked, and its callstack has the PC and the link register
    session.ok("control.pause");
    expect(enabled()).toEqual({ name: "ENABLED", value: "0x1", width: 1 });
    expect(session.lastTick().callstacks!.arm7.length).toBeGreaterThanOrEqual(2);
    expect((session.ok("state.getCallstack", { target: "arm7" }) as { frames: unknown[] }).frames.length).toBeGreaterThanOrEqual(2);

    // The guest holds or releases the ARM7, the debugger does not: the register has no writer,
    // by its name or through a watch on it, and answers -32013 as every such register does,
    // before its value is looked at.
    session.fail("state.setRegister", { path: "dc.aica.arm7", name: "ENABLED", value: "0" }, -32013);
    session.fail("state.setRegister", { path: "dc.aica.arm7", name: "ENABLED", value: "twelve" }, -32013);
    session.ok("state.watch", { expressions: ["dc.aica.arm7.enabled"] });
    expect(session.lastTick().watches).toEqual([{ id: 1, expression: "dc.aica.arm7.enabled", value: "0x1" }]);
    session.fail("state.editWatch", { watchId: 1, value: "0" }, -32013);
    expect(enabled().value).toBe("0x1");
  });

  it("lists in the device tree exactly the events it can raise, and accepts a breakpoint on each of them", () => {
    const mock = createMock();
    const session = connect(mock);
    const listed: string[] = [];
    const visit = (nodes: DebuggerShape["deviceTree"]) => {
      for (const node of nodes) {
        listed.push(...(node.events ?? []));
        if (node.children) visit(node.children);
      }
    };
    visit(session.describe().deviceTree);
    expect(listed.slice().sort()).toEqual(Object.keys(MOCK_EVENTS).sort());
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed).toContain("dc.holly.core.vblank");
    // nothing raises the forcing event, so it is neither listed nor accepted
    expect(listed).not.toContain("dc.debugger.dsp_forced");
    session.fail("breakpoints.add", { event: "dc.debugger.dsp_forced", kind: "event", enabled: false }, -32004);
    for (const event of listed) {
      session.ok("breakpoints.add", { event, kind: "event", enabled: false });
    }
    expect(Object.keys(session.lastTick().breakpoints)).toHaveLength(listed.length);
  });

  it("logs low-rate events while a client is connected, high-rate events only while a breakpoint on them exists", async () => {
    const mock = createMock();
    await vi.advanceTimersByTimeAsync(5000);
    const session = connect(mock);
    session.describe();
    // nothing was logged while nobody was connected
    expect(session.lastTick().eventLog).toEqual([]);

    await vi.advanceTimersByTimeAsync(3000);
    const log = session.lastTick().eventLog;
    expect(log.length).toBeGreaterThan(5);
    const names = new Set(log.map((entry) => (entry.metadata as { event: string }).event));
    expect([...names].sort()).toEqual(["dc.aica.channels.key_off", "dc.aica.channels.key_on", "dc.gdrom.command"]);
    for (const entry of log) {
      expect(entry).toMatchObject({ severity: "info", metadata: { cycles: expect.stringMatching(/^\d+$/) } });
    }
    // oldest first, ids unique
    expect(log.map((entry) => Number(entry.eventId))).toEqual([...log.map((entry) => Number(entry.eventId))].sort((a, b) => a - b));
    expect(new Set(log.map((entry) => entry.eventId)).size).toBe(log.length);

    // a disabled event breakpoint still makes the event worth logging
    session.ok("breakpoints.add", { event: "dc.holly.core.vblank", enabled: false });
    expect(session.lastTick().breakpoints["1"]).toEqual({ id: 1, event: "dc.holly.core.vblank", kind: "event", enabled: false });
    await vi.advanceTimersByTimeAsync(1000);
    const vblanks = session.lastTick().eventLog.filter((entry) => (entry.metadata as { event: string }).event === "dc.holly.core.vblank");
    expect(vblanks.length).toBeGreaterThan(50);
    expect(vblanks[0]).toMatchObject({ subsystem: "core", severity: "info" });
    expect(session.lastTick().executionState.state).toBe("running");

    // the ring holds 200 entries
    await vi.advanceTimersByTimeAsync(5000);
    expect(session.lastTick().eventLog).toHaveLength(200);
  });

  it("stops at an event breakpoint with reason event; a code breakpoint in the same step has priority", async () => {
    const mock = createMock();
    const session = connect(mock);
    session.describe();
    session.ok("control.pause");
    const stopId = session.lastTick().executionState.stopId!;
    session.ok("breakpoints.add", { event: "dc.aica.channels.key_on", kind: "event" });
    session.ok("control.runUntil");
    await vi.advanceTimersByTimeAsync(32 * 16);
    expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: stopId + 1, reason: "event", breakpointId: 1 });
    expect(session.lastTick().eventLog.at(-1)).toMatchObject({ subsystem: "aica", metadata: { event: "dc.aica.channels.key_on" } });

    // vblank is raised in every step, so it coincides with the code breakpoint on the next instruction
    session.ok("breakpoints.add", { event: "dc.holly.core.vblank" });
    session.ok("breakpoints.add", { event: "dc.sh4.cpu.pc", address: mockNextAddress("sh4", session.pc()) });
    session.ok("control.runUntil");
    await vi.advanceTimersByTimeAsync(16);
    expect(session.lastTick().executionState).toMatchObject({ state: "paused", reason: "breakpoint", breakpointId: 3 });
    session.ok("breakpoints.remove", { id: 3 });
    session.ok("control.runUntil");
    await vi.advanceTimersByTimeAsync(16);
    expect(session.lastTick().executionState).toMatchObject({ state: "paused", reason: "event", breakpointId: 2 });
  });

  it("broadcasts a tick to every client after a successful mutating request, and none after a read or a failure", () => {
    const mock = createMock();
    const first = connect(mock);
    const second = connect(mock);
    first.describe();
    second.describe();
    const count = () => [first.ticks().length, second.ticks().length];
    let before = count();
    const expectTicks = (delta: number, what: string) => {
      expect(count(), what).toEqual([before[0] + delta, before[1] + delta]);
      before = count();
    };

    first.ok("state.watch", { expressions: ["dc.sh4.cpu.pc"] });
    expectTicks(1, "state.watch");
    second.ok("breakpoints.add", { event: "dc.sh4.interrupt" });
    expectTicks(1, "breakpoints.add");
    first.ok("breakpoints.setCategoryStates", { categories: {} });
    expectTicks(1, "breakpoints.setCategoryStates");
    first.ok("state.getMemorySlice", { address: 0x8c010000, length: 16 });
    first.ok("state.getDisassembly", { address: 0x8c010000, count: 4 });
    first.ok("state.getCallstack", { target: "sh4" });
    expectTicks(0, "reads");
    first.fail("breakpoints.remove", { id: 99 }, -32602);
    first.fail("state.watch", { expressions: ["dc.nothing.here"] }, -32602);
    expectTicks(0, "failures");
    expect(second.lastTick().watches).toEqual([{ id: 1, expression: "dc.sh4.cpu.pc", value: expect.stringMatching(/^0x8C0000A[0-9A-F]$/) }]);
    expect(second.lastTick().breakpoints["1"]).toMatchObject({ event: "dc.sh4.interrupt", kind: "event" });
  });

  it("skips the periodic tick of a client with more than 1 MiB queued and makes its next tick full", async () => {
    const mock = createMock();
    const slow = connect(mock);
    const shape = slow.describe();
    const all = registeredPaths(shape).length;
    await vi.advanceTimersByTimeAsync(1000); // the fifth periodic tick, a full one, has just been sent
    slow.frames.length = 0;

    slow.state.queuedBytes = 1048577;
    await vi.advanceTimersByTimeAsync(400);
    expect(slow.ticks()).toEqual([]);

    slow.state.queuedBytes = 1048576;
    await vi.advanceTimersByTimeAsync(200);
    expect(slow.ticks()).toHaveLength(1);
    expect(Object.keys(slow.lastTick().registers)).toHaveLength(all);
    await vi.advanceTimersByTimeAsync(200);
    expect(Object.keys(slow.lastTick().registers).sort()).toEqual(BASE_PATHS);
  });

  it("keeps breakpoints, watches and categories across a reconnect within the grace period", async () => {
    const mock = createMock();
    const first = connect(mock);
    first.describe();
    first.ok("control.pause");
    first.ok("breakpoints.add", { event: "dc.sh4.cpu.pc", address: 0x8c0000a4, enabled: false });
    first.ok("state.watch", { expressions: ["dc.sh4.cpu.sr"] });
    first.ok("breakpoints.setCategoryStates", { categories: { dsp: { muted: true, soloed: false } } });
    const { breakpoints, watches, categories, executionState } = first.lastTick();
    first.client.close();
    expect(mock.clientCount).toBe(0);

    await vi.advanceTimersByTimeAsync(9000);
    const second = connect(mock);
    second.describe();
    expect(second.lastTick().breakpoints).toEqual(breakpoints);
    expect(second.lastTick().watches).toEqual(watches);
    expect(second.lastTick().categories).toEqual(categories);
    // still the same stop
    expect(second.lastTick().executionState).toEqual(executionState);
  });

  it("after the grace period without a client, breakpoints are inactive and a debugger stop is released", async () => {
    const mock = createMock({ graceMs: 10_000 });
    const first = connect(mock);
    first.describe();
    first.ok("control.pause");
    const stopId = first.lastTick().executionState.stopId!;
    first.ok("breakpoints.add", { event: "dc.sh4.cpu.pc", address: mockNextAddress("sh4", first.pc()) });
    first.client.close();

    await vi.advanceTimersByTimeAsync(9999);
    const peek = connect(mock);
    peek.describe();
    expect(peek.lastTick().executionState.state).toBe("paused");
    peek.client.close();

    // the timer starts again at this disconnect
    await vi.advanceTimersByTimeAsync(10_000 + 2000);
    const second = connect(mock);
    second.describe();
    // released, and it ran past the breakpoint without stopping; the breakpoint is still listed
    expect(second.lastTick().executionState).toEqual({ state: "running", stopId });
    expect(Object.keys(second.lastTick().breakpoints)).toEqual(["1"]);
    // with a client connected the breakpoint is active again
    await vi.advanceTimersByTimeAsync(8 * 16);
    expect(second.lastTick().executionState).toMatchObject({ state: "paused", reason: "breakpoint", breakpointId: 1 });
  });

  it("starts in the StartPaused stop when asked, and waits for its first client without limit", async () => {
    const mock = createMock({ startPaused: true });
    await vi.advanceTimersByTimeAsync(60_000);
    const session = connect(mock);
    session.describe();
    expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: 1, reason: "start" });
    expect(session.pc()).toBe(MOCK_SH4_RING.base);
  });

  it("without a context at the slice hook, running ticks omit dc.sh4.cpu and say registersStale", async () => {
    const mock = createMock({ sliceContext: false });
    const session = connect(mock);
    session.describe();
    expect(session.lastTick().executionState).toEqual({ state: "running", stopId: 0, registersStale: true });
    expect(session.lastTick().registers["dc.sh4.cpu"]).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(Object.keys(session.lastTick().registers).sort()).toEqual(BASE_PATHS.filter((path) => path !== "dc.sh4.cpu"));
    session.ok("control.pause");
    expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: 1, reason: "pause" });
    expect(session.lastTick().registers["dc.sh4.cpu"]).toBeDefined();
  });

  it("without a context at the slice hook, watches on dc.sh4.cpu read n/a while running, and the register once paused", async () => {
    const mock = createMock({ sliceContext: false });
    const session = connect(mock);
    session.describe();
    session.ok("state.watch", { expressions: ["dc.sh4.cpu.pc", "dc.aica.arm7.pc", "dc.sh4.cpu.r15", "dc.timing.sh4_cycles"] });
    const values = (tick: DebuggerTick) => Object.fromEntries(tick.watches!.map((watch) => [watch.expression, watch.value]));
    const live = /^0x[0-9A-F]{8}$/;
    // the tick of the request, a periodic tick, and the full one among them
    await vi.advanceTimersByTimeAsync(1000);
    const running = session.ticks().slice(-6);
    expect(running.map((tick) => tick.executionState.registersStale)).toEqual(new Array(6).fill(true));
    for (const tick of running) {
      expect(values(tick)).toEqual({
        "dc.sh4.cpu.pc": "n/a",
        "dc.sh4.cpu.r15": "n/a",
        // what is not the SH4's context is read as ever
        "dc.aica.arm7.pc": expect.stringMatching(live),
        "dc.timing.sh4_cycles": expect.stringMatching(/^0x[0-9A-F]{16}$/),
      });
    }

    // after Run() has returned the context is valid
    session.ok("control.pause");
    const paused = session.lastTick();
    expect(paused.executionState.registersStale).toBeUndefined();
    expect(values(paused)["dc.sh4.cpu.pc"]).toBe(paused.registers["dc.sh4.cpu"].find((register) => register.name === "PC")!.value);
    expect(values(paused)["dc.sh4.cpu.pc"]).toMatch(live);
    expect(values(paused)["dc.sh4.cpu.r15"]).toBe("0x8CFFF000");

    // and a mock with a context at the slice hook reads the PC while it runs
    const other = connect(createMock());
    other.describe();
    other.ok("state.watch", { expressions: ["dc.sh4.cpu.pc"] });
    await vi.advanceTimersByTimeAsync(200);
    expect(other.lastTick().executionState.state).toBe("running");
    expect(values(other.lastTick())["dc.sh4.cpu.pc"]).toMatch(live);
  });

  it("with ForceFallback, says so: capability, dc.timing, and the notice while SH4 breakpoints are active or after a step", async () => {
    const mock = createMock({ forceFallback: true });
    const session = connect(mock);
    const shape = session.describe();
    expect(shape.capabilities).toContain("sh4-debug-fallback");
    expect(shape.capabilities).not.toContain("sh4-debug-native");
    const engine = () => session.lastTick().registers["dc.timing"].find((register) => register.name === "SH4_DEBUG_ENGINE")!.value;
    expect(engine()).toBe("interpreter-fallback");
    expect(session.lastTick().executionState.notice).toBeUndefined();

    session.ok("control.pause");
    session.ok("control.step", { target: "sh4" });
    expect(session.lastTick().executionState.notice).toMatch(/^SH4 runs on the interpreter while breakpoints are armed \(JIT backend mock has no native breakpoints\)/);
    session.ok("control.runUntil");
    expect(session.lastTick().executionState.notice).toBeUndefined();

    session.ok("breakpoints.add", { event: "dc.sh4.cpu.pc", address: 0x8c010000 });
    expect(session.lastTick().executionState.notice).toBeDefined();
    expect(session.lastTick().executionState.notice!.length).toBeLessThanOrEqual(200);
    expect(session.lastTick().eventLog.at(-1)).toMatchObject({ subsystem: "debugger", metadata: { event: "dc.debugger.engine" } });
    session.ok("breakpoints.setCategoryStates", { categories: { sh4: { muted: true, soloed: false } } });
    expect(session.lastTick().executionState.notice).toBeUndefined();
  });

  it("reports what the emulator's own window does: stopped by the host, no game", () => {
    const mock = createMock();
    const session = connect(mock);
    session.describe();

    mock.setLifetime("stopped");
    expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: 1, reason: "host-stopped" });
    // reads and bookkeeping work, writing and executing do not
    session.ok("state.getMemorySlice", { address: 0x8c010000, length: 4 });
    session.ok("state.watch", { expressions: ["dc.sh4.cpu.r0"] });
    for (const [method, params] of [
      ["control.pause", {}],
      ["control.runUntil", {}],
      ["control.step", { target: "sh4" }],
      ["state.setRegister", { path: "dc.sh4.cpu", name: "R0", value: "1" }],
      ["state.recordSgcFrames", {}],
    ] as const) {
      session.fail(method, params, -32001);
    }

    mock.setLifetime("running");
    expect(session.lastTick().executionState).toEqual({ state: "running", stopId: 1 });

    mock.setLifetime("stopped", "guest-exit");
    expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: 2, reason: "guest-exit" });

    mock.setLifetime("no-machine");
    expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: 3, reason: "no-game" });
    expect(session.lastTick().registers).toEqual({});
    expect(session.lastTick().callstacks).toEqual({ sh4: [], arm7: [] });
    expect(session.lastTick().watches).toEqual([{ id: 1, expression: "dc.sh4.cpu.r0", value: "n/a" }]);
    session.fail("state.getMemorySlice", { address: 0x8c010000, length: 4 }, -32002);
    session.fail("state.getDisassembly", { address: 0x8c010000, count: 1 }, -32002);
    session.fail("control.runUntil", {}, -32002);
    // the static tree, every value "n/a"; bookkeeping still works
    const shape = session.describe();
    expect(shape.deviceTree[0].registers).toEqual([
      { name: "SYSCLK", value: "n/a", width: 0 },
      { name: "BUILD", value: "n/a", width: 0 },
    ]);
    session.ok("breakpoints.add", { event: "dc.sh4.interrupt" });
  });

  it("with no game loaded no SH4 backend is selected: neither sh4-debug capability, until a game starts", () => {
    const mock = createMock({ startPaused: true });
    const session = connect(mock);
    expect(session.describe().capabilities).toContain("sh4-debug-native");

    mock.setLifetime("no-machine");
    const without = session.describe().capabilities!;
    expect(without.filter((capability) => capability.startsWith("sh4-debug-"))).toEqual([]);
    expect(without).toContain("callstack");
    expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: 2, reason: "no-game" });

    // a game starts: StartPaused parks once per start, and the backend is selected
    mock.setLifetime("running");
    expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: 3, reason: "start" });
    expect(session.describe().capabilities).toContain("sh4-debug-native");
    session.ok("control.runUntil");
    expect(session.lastTick().executionState).toEqual({ state: "running", stopId: 3 });

    // without StartPaused the game runs
    const running = createMock();
    const other = connect(running);
    running.setLifetime("no-machine");
    running.setLifetime("running");
    other.describe();
    expect(other.lastTick().executionState).toEqual({ state: "running", stopId: 1 });

    const fallback = createMock({ forceFallback: true });
    fallback.setLifetime("no-machine");
    expect(connect(fallback).describe().capabilities!.filter((capability) => capability.startsWith("sh4-debug-"))).toEqual([]);
  });
});

describe("a server that implements less (the option `supports`)", () => {
  it("as milestone M1: lists the three targets, steps only the SH4, and has neither register writes nor the SGC capture", async () => {
    const mock = createMock({ supports: MOCK_M1_SUPPORT });
    const session = connect(mock);
    const shape = session.describe();
    expect(shape.targets!.map(({ id, stepping, memory }) => ({ id, stepping, memory }))).toEqual([
      { id: "sh4", stepping: true, memory: true },
      { id: "arm7", stepping: false, memory: true },
      { id: "dsp", stepping: false, memory: false },
    ]);
    expect(shape.capabilities).toEqual(["event-breakpoints", "callstack", "sh4-debug-native"]);

    session.ok("control.pause");
    // what M1 has
    session.ok("control.step", { target: "sh4" });
    session.ok("breakpoints.add", { event: "dc.sh4.cpu.pc", address: 0x8c0000a4 });
    session.ok("breakpoints.add", { event: "dc.sh4.exception" });
    session.ok("state.getDisassembly", { target: "arm7", address: 0x00200010, count: 2 });
    session.ok("state.getDisassembly", { target: "dsp", address: 0, count: 2 });
    session.ok("state.getMemorySlice", { target: "arm7", address: 0, length: 4 });
    session.ok("state.getCallstack", { target: "arm7" });
    session.ok("state.watch", { expressions: ["dc.sh4.cpu.pc"] });
    expect(session.lastTick().callstacks!.sh4.length).toBeGreaterThan(0);
    expect(session.lastTick().callstacks!.arm7.length).toBeGreaterThan(0);

    // what it has not: -32004, on the channel of the method
    for (const [method, params] of [
      ["control.step", { target: "arm7" }],
      ["control.stepOver", { target: "arm7" }],
      ["control.stepOut", { target: "arm7" }],
      ["control.step", { target: "dsp" }],
      ["breakpoints.add", { event: "dc.aica.arm7.pc", address: 0x00200010 }],
      ["breakpoints.add", { event: "dc.aica.dsp.step", address: 5 }],
      ["state.setRegister", { path: "dc.sh4.cpu", name: "R0", value: "1" }],
      ["state.editWatch", { watchId: 1, value: "1" }],
      ["state.recordSgcFrames", {}],
      ["state.getSgcFrameData", {}],
    ] as const) {
      session.fail(method, params, -32004);
    }
    expect(Object.keys(session.lastTick().breakpoints)).toHaveLength(2);

    // a step is still refused while running before anything else is looked at
    session.ok("control.runUntil");
    session.fail("control.step", { target: "arm7" }, -32003);
  });

  it("without a target: it is not listed, its requests answer -32004 and its callstack is empty", () => {
    const mock = createMock({ supports: { targets: ["sh4", "dsp"] } });
    const session = connect(mock);
    expect(session.describe().targets!.map((target) => target.id)).toEqual(["sh4", "dsp"]);
    session.ok("control.pause");
    for (const [method, params] of [
      ["state.getDisassembly", { target: "arm7", address: 0, count: 1 }],
      ["state.getMemorySlice", { target: "arm7", address: 0, length: 1 }],
      ["state.getCallstack", { target: "arm7" }],
      ["control.step", { target: "arm7" }],
      ["breakpoints.add", { event: "dc.aica.arm7.pc", address: 0x00200010 }],
    ] as const) {
      session.fail(method, params, -32004);
    }
    expect(session.lastTick().callstacks!.sh4.length).toBeGreaterThan(0);
    expect(session.lastTick().callstacks!.arm7).toEqual([]);
    // the targets it lists step as before
    session.ok("control.step", { target: "dsp" });
  });

  it("without a capability: the methods behind it answer -32004, and without callstack the ticks carry no frames", () => {
    const mock = createMock({ supports: { capabilities: ["register-write"] } });
    const session = connect(mock);
    expect(session.describe().capabilities).toEqual(["register-write", "sh4-debug-native"]);
    session.ok("control.pause");
    expect(session.lastTick().callstacks).toEqual({ sh4: [], arm7: [] });
    session.fail("state.getCallstack", { target: "sh4" }, -32004);
    session.fail("breakpoints.add", { event: "dc.sh4.exception" }, -32004);
    // code breakpoints and register writes are what it has
    session.ok("breakpoints.add", { event: "dc.sh4.cpu.pc", address: 0x8c0000a4 });
    session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "R0", value: "1" });
  });

  it("answers a method whose capability it lacks with -32004 before it looks at the parameters or at the lifetime", () => {
    const mock = createMock({ supports: MOCK_M1_SUPPORT });
    const session = connect(mock);
    session.describe();
    // a parameter is missing, or of the wrong type: still "not supported", as for a method of a later milestone
    const probes: Array<[string, unknown]> = [
      ["state.setRegister", { path: "dc.sh4.cpu", name: "R0" }],
      ["state.setRegister", {}],
      ["state.editWatch", { watchId: "one" }],
      ["state.recordSgcFrames", { frames: 0 }],
      ["state.getSgcFrameData", { anything: 1 }],
      ["state.writeMemory", { target: "sh4" }],
      ["control.reset", { target: 4 }],
    ];
    for (const [method, params] of probes) {
      session.fail(method, params, -32004);
    }
    expect(connect(createMock({ supports: { capabilities: [] } })).call("state.getCallstack", { target: "dsp", maxFrames: 0 }).error).toMatchObject({ code: -32004 });
    // with the capability the parameters are looked at
    const full = connect(createMock());
    full.fail("state.setRegister", { path: "dc.sh4.cpu", name: "R0" }, -32602);
    full.fail("state.getCallstack", { target: "dsp", maxFrames: 0 }, -32602);

    // the lifetime comes behind it too: no game loaded, and a machine the host stopped
    mock.setLifetime("no-machine");
    for (const [method, params] of probes) {
      session.fail(method, params, -32004);
    }
    session.fail("state.setRegister", { path: "dc.sh4.cpu", name: "R0", value: "1" }, -32004);
    mock.setLifetime("stopped");
    session.fail("state.setRegister", { path: "dc.sh4.cpu", name: "R0", value: "1" }, -32004);
    session.fail("state.recordSgcFrames", {}, -32004);
    // ... where a server that has the method answers with the lifetime
    const stopped = createMock();
    const other = connect(stopped);
    stopped.setLifetime("stopped");
    other.fail("state.setRegister", { path: "dc.sh4.cpu", name: "R0", value: "1" }, -32001);
    other.fail("state.setRegister", { path: "dc.sh4.cpu", name: "R0" }, -32602);
  });

  it("reports the protocol version it is told to report", () => {
    expect(connect(createMock()).call("debugger.describe").result).toMatchObject({ protocol: 3 });
    expect(connect(createMock({ protocol: 4 })).call("debugger.describe").result).toMatchObject({ protocol: 4 });
  });
});

describe("milestone M2", () => {
  const STEP_MS = 16;
  /** A mock with a client that has described it; `paused`: at a pause the client asked for. */
  const setup = (options: MockDebuggerOptions = {}, paused = true) => {
    const mock = createMock(options);
    const session = connect(mock);
    const shape = session.describe();
    if (paused) {
      session.ok("control.pause");
    }
    const registerOf = (path: string, name: string, tick: DebuggerTick = session.lastTick()) => tick.registers[path].find((register) => register.name === name)!.value;
    const read = (target: string, address: number, length: number) =>
      (session.ok("state.getMemorySlice", { target, address, length }) as { data: number[] }).data;
    const lines = (target: string, address: number, count: number) =>
      (session.ok("state.getDisassembly", { target, address, count }) as { lines: Array<{ address: number; bytes: string; disassembly: string }> }).lines;
    const arm7Pc = () => Number.parseInt(registerOf("dc.aica.arm7", "PC"), 16);
    return { mock, session, shape, registerOf, read, lines, arm7Pc };
  };
  const nodesOf = (shape: DebuggerShape) => {
    const nodes = new Map<string, { parent?: string; node: DebuggerShape["deviceTree"][number] }>();
    const visit = (list: DebuggerShape["deviceTree"], parent?: string) =>
      list.forEach((node) => {
        nodes.set(node.path, { parent, node });
        visit(node.children ?? [], node.path);
      });
    visit(shape.deviceTree);
    return nodes;
  };

  describe("state.writeMemory", () => {
    it("writes main memory, wave memory and video memory, each one store through every address that maps it", () => {
      const { session, read } = setup();
      // main memory: 16 MiB, area 3 through P0, P1 and P2, and mirrored by its size
      const before = read("sh4", 0x8c010000, 4);
      expect(read("sh4", 0x0c010000, 4)).toEqual(before);
      expect(read("sh4", 0xac010000, 4)).toEqual(before);
      expect(read("sh4", 0x8d010000, 4)).toEqual(before);
      session.ok("state.writeMemory", { target: "sh4", address: 0x8c010000, data: [1, 2, 3, 4] });
      for (const address of [0x8c010000, 0x0c010000, 0xac010000, 0x8d010000, 0x0f010000]) {
        expect(read("sh4", address, 4), address.toString(16)).toEqual([1, 2, 3, 4]);
      }
      expect(read("sh4", 0x8c010004, 4)).not.toEqual([1, 2, 3, 4]);

      // wave memory: 8 MiB, the SH4's 0x00800000 + X and the ARM7's X, written through either target
      expect(read("sh4", 0x00a00010, 4)).toEqual(read("arm7", 0x00200010, 4));
      session.ok("state.writeMemory", { target: "arm7", address: 0x00000100, data: [0xaa, 0xbb] });
      expect(read("sh4", 0x00800100, 2)).toEqual([0xaa, 0xbb]);
      expect(read("sh4", 0xa0800100, 2)).toEqual([0xaa, 0xbb]);
      session.ok("state.writeMemory", { target: "sh4", address: 0x80800200, data: [0xcc] });
      expect(read("arm7", 0x00000200, 1)).toEqual([0xcc]);
      // (the ARM7's ring at 0x00200010 is no mirror of anything: the store is as large as what the ARM7 reads)
      expect(mockStoreOf("arm7", 0x00200010)).toEqual({ store: "wave", offset: 0x00200010 });
      expect(mockStoreOf("arm7", 0x00800000)).toBeUndefined();

      // video memory: 8 MiB in each of two views; the mirrors of a view agree, and the views are not aliased
      const other = read("sh4", 0x04000000, 4);
      session.ok("state.writeMemory", { target: "sh4", address: 0xa5000000, data: [9, 8, 7, 6] });
      for (const address of [0x05000000, 0x07000000, 0x85000000, 0xa7000000, 0x05800000]) {
        expect(read("sh4", address, 4), address.toString(16)).toEqual([9, 8, 7, 6]);
      }
      expect(read("sh4", 0x04000000, 4)).toEqual(other);
      expect(read("sh4", 0x06000000, 4)).toEqual(other);
      session.ok("state.writeMemory", { target: "sh4", address: 0x06000000, data: [5] });
      expect(read("sh4", 0x04000000, 1)).toEqual([5]);
      expect(read("sh4", 0x05000000, 1)).toEqual([9]);

      // the bytes of a disassembly line are the bytes of memory, also when they were written
      session.ok("state.writeMemory", { target: "arm7", address: 0x00200010, data: [0x11, 0x22, 0x33, 0x44] });
      const [line] = (session.ok("state.getDisassembly", { target: "arm7", address: 0x00200010, count: 1 }) as { lines: Array<{ bytes: string }> }).lines;
      expect(line.bytes).toBe("11 22 33 44");
    });

    it("refuses everything else with -32013, and a range as a whole: nothing of it is stored", () => {
      const { session, read } = setup();
      const refused = (target: string, address: number, data: number[] = [0]) => session.fail("state.writeMemory", { target, address, data }, -32013);
      // the boot ROM, the flash, a register window, the modem, P4 and a store queue
      for (const address of [0x00000000, 0x00200000, 0x005f6900, 0x005f8000, 0x00700000, 0x00710000, 0x00600000, 0xff000000, 0xe0000000, 0x10000000]) {
        refused("sh4", address);
      }
      // the registers and the clock of the AICA as the ARM7 sees them, and what is above its address space
      for (const address of [0x00800000, 0x00810000, 0x00900000, 0x00ffffff]) {
        refused("arm7", address);
      }
      // a range that starts in main memory and ends above it: its first half is unchanged
      const first = read("sh4", 0x0ffffff8, 8);
      refused("sh4", 0x0ffffff8, new Array<number>(16).fill(0x5a));
      expect(read("sh4", 0x0ffffff8, 8)).toEqual(first);
      const wave = read("arm7", 0x007ffff8, 8);
      refused("arm7", 0x007ffff8, new Array<number>(16).fill(0x5a));
      expect(read("arm7", 0x007ffff8, 8)).toEqual(wave);
      // a write does not wrap around the end of the address space
      refused("sh4", 0xfffffffc, [1, 2, 3, 4, 5, 6, 7, 8]);
      refused("arm7", 0x00fffffc, [1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it("takes 1 to 65536 bytes of 0 to 255, needs a target, and answers -32004 for the DSP behind the lifetime", () => {
      const { mock, session, read } = setup();
      const address = 0x8c010000;
      const original = read("sh4", address, 65536);
      session.frames.length = 0;
      // 65536 bytes, written as what they read: accepted, and the tick behind it is of the same stop
      expect(session.call("state.writeMemory", { target: "sh4", address, data: original }).result).toEqual({});
      expect(session.ticks()).toHaveLength(1);
      expect(session.lastTick().executionState).toMatchObject({ state: "paused", reason: "pause" });
      expect(read("sh4", address, 65536)).toEqual(original);

      session.fail("state.writeMemory", { target: "sh4", address, data: new Array<number>(65537).fill(0) }, -32602);
      session.fail("state.writeMemory", { target: "sh4", address, data: [] }, -32602);
      session.fail("state.writeMemory", { target: "sh4", address, data: [256] }, -32602);
      session.fail("state.writeMemory", { target: "sh4", address, data: [-1] }, -32602);
      session.fail("state.writeMemory", { address, data: [0] }, -32602);
      session.fail("state.writeMemory", { target: "gpu", address, data: [0] }, -32602);
      expect(read("sh4", address, 16)).toEqual(original.slice(0, 16));

      // the DSP has no memory: the method's own -32004, in-band, and decided behind the lifetime
      session.fail("state.writeMemory", { target: "dsp", address: 0, data: [0] }, -32004);
      mock.setLifetime("stopped");
      session.fail("state.writeMemory", { target: "dsp", address: 0, data: [0] }, -32001);
      session.fail("state.writeMemory", { target: "sh4", address, data: [0] }, -32001);
      mock.setLifetime("no-machine");
      session.fail("state.writeMemory", { target: "dsp", address: 0, data: [0] }, -32002);
      // a parameter that is wrong is said before the lifetime, as for every method
      session.fail("state.writeMemory", { target: "sh4", address, data: [256] }, -32602);
    });

    it("is served while the target runs, and a tick follows every accepted write and no refused one", () => {
      const { mock, session, read } = setup({}, false);
      session.frames.length = 0;
      session.ok("state.writeMemory", { target: "sh4", address: 0x8c010000, data: [0x12] });
      expect(session.ticks()).toHaveLength(1);
      expect(session.lastTick().executionState).toEqual({ state: "running", stopId: 0 });
      expect(read("sh4", 0x8c010000, 1)).toEqual([0x12]);
      // a write that is refused is refused as not writable, not as "not paused"
      session.frames.length = 0;
      session.fail("state.writeMemory", { target: "sh4", address: 0x00000000, data: [0] }, -32013);
      expect(session.ticks()).toHaveLength(0);
      // ... and every client gets the tick of a write
      const other = connect(mock);
      session.ok("state.writeMemory", { target: "sh4", address: 0x8c010001, data: [0x34] });
      expect(other.ticks()).toHaveLength(1);
    });
  });

  describe("control.reset", () => {
    it("paused: a new stop with reason reset and no running tick; the tables are kept, the ARM7 is held and the registers are those of the start", async () => {
      const { session, registerOf } = setup({}, false);
      await vi.advanceTimersByTimeAsync(5 * STEP_MS);
      session.ok("control.pause");
      session.ok("breakpoints.add", { event: "dc.sh4.cpu.pc", address: 0x8c010000, enabled: false });
      session.ok("breakpoints.add", { event: "dc.aica.arm7.pc", address: MOCK_ARM7_RING.base });
      session.ok("breakpoints.toggle", { id: 2, enabled: false });
      session.ok("state.watch", { expressions: ["dc.sh4.cpu.r3"] });
      session.ok("breakpoints.setCategoryStates", { categories: { dsp: { muted: true, soloed: false } } });
      session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "R3", value: "0x1234" });
      session.ok("state.writeMemory", { target: "sh4", address: 0x8c010000, data: [0x77] });
      const before = session.lastTick();
      expect(registerOf("dc.sh4.cpu", "PC")).not.toBe("0x8C0000A0");
      session.frames.length = 0;

      expect(session.call("control.reset", {}).result).toEqual({});
      expect(session.ticks().map((tick) => tick.executionState)).toEqual([{ state: "paused", stopId: before.executionState.stopId! + 1, reason: "reset" }]);
      const after = session.lastTick();
      expect(after.breakpoints).toEqual(before.breakpoints);
      expect(after.watches).toEqual([{ id: 1, expression: "dc.sh4.cpu.r3", value: "0x00003333" }]);
      expect(after.categories).toEqual(before.categories);
      expect(registerOf("dc.sh4.cpu", "PC")).toBe("0x8C0000A0");
      expect(registerOf("dc.sh4.cpu", "R3")).toBe("0x00003333");
      expect(registerOf("dc.aica.arm7", "ENABLED")).toBe("0x0");
      expect(after.callstacks!.arm7).toEqual([]);
      expect(after.callstacks!.sh4.length).toBeGreaterThan(0);
      expect((session.ok("state.getCallstack", { target: "arm7" }) as { frames: unknown[] }).frames).toEqual([]);
      // time is not reset, and memory is not the reset's to change
      expect(BigInt(registerOf("dc.timing", "SH4_CYCLES"))).toBe(BigInt(registerOf("dc.timing", "SH4_CYCLES", before)));
      expect((session.ok("state.getMemorySlice", { address: 0x8c010000, length: 1 }) as { data: number[] }).data).toEqual([0x77]);
      // the event log has the reset
      expect(after.eventLog.at(-1)).toMatchObject({ subsystem: "system", message: "machine reset", metadata: { event: "dc.system.reset" } });

      // a resume behind the reset runs
      session.ok("control.runUntil");
      expect(session.lastTick().executionState).toEqual({ state: "running", stopId: after.executionState.stopId });
      await vi.advanceTimersByTimeAsync(3 * STEP_MS);
      session.ok("control.pause");
      expect(registerOf("dc.sh4.cpu", "PC")).toBe("0x8C0000A6");
    });

    it("running: {} and an event-log entry, and nothing is published: the target runs on in the same stop", async () => {
      const { session, registerOf } = setup({}, false);
      await vi.advanceTimersByTimeAsync(3 * STEP_MS);
      session.frames.length = 0;
      expect(session.call("control.reset", {}).result).toEqual({});
      expect(session.ticks()).toEqual([]);
      await vi.advanceTimersByTimeAsync(200);
      const tick = session.lastTick();
      expect(tick.executionState).toEqual({ state: "running", stopId: 0 });
      expect(tick.eventLog.filter((entry) => entry.metadata?.event === "dc.system.reset")).toHaveLength(1);
      expect(session.ticks().every((entry) => entry.executionState.state === "running")).toBe(true);
      // the machine was reset: its ARM7 was held, and is released by now
      expect(registerOf("dc.aica.arm7", "ENABLED")).toBe("0x1");
    });

    it("is refused without a machine and for a machine the host stopped, and a reset at a breakpoint stop names no breakpoint", async () => {
      const { mock, session } = setup({}, false);
      session.ok("breakpoints.add", { event: "dc.sh4.cpu.pc", address: MOCK_SH4_RING.base + 6 });
      await vi.advanceTimersByTimeAsync(8 * STEP_MS);
      expect(session.lastTick().executionState).toMatchObject({ state: "paused", reason: "breakpoint", breakpointId: 1 });
      const stopId = session.lastTick().executionState.stopId!;
      session.ok("control.reset");
      expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: stopId + 1, reason: "reset" });
      expect(Object.keys(session.lastTick().breakpoints)).toEqual(["1"]);

      mock.setLifetime("stopped");
      session.fail("control.reset", {}, -32001);
      mock.setLifetime("no-machine");
      session.fail("control.reset", {}, -32002);
    });
  });

  describe("an ARM7 that is held in reset", () => {
    it("behind a reset, by the option and by the machine: ENABLED 0, no callstack, no instruction, and a release when the machine has run for 8 steps", async () => {
      expect(MOCK_ARM7_RELEASE_STEPS).toBe(8);
      const { mock, session, registerOf, arm7Pc } = setup({ arm7Held: true }, false);
      expect(registerOf("dc.aica.arm7", "ENABLED")).toBe("0x0");
      const cycles = () => BigInt(registerOf("dc.timing", "SH4_CYCLES"));
      const start = cycles();
      await vi.advanceTimersByTimeAsync(7 * STEP_MS);
      session.ok("control.pause");
      // seven steps: the SH4 has run, the ARM7 has not, and has no frames
      expect(cycles()).toBeGreaterThan(start);
      expect(registerOf("dc.aica.arm7", "ENABLED")).toBe("0x0");
      expect(arm7Pc()).toBe(MOCK_ARM7_RING.base);
      expect(session.lastTick().callstacks!.arm7).toEqual([]);
      // a paused machine releases nothing
      await vi.advanceTimersByTimeAsync(20 * STEP_MS);
      session.ok("state.watch", { expressions: ["dc.aica.arm7.enabled"] });
      expect(session.lastTick().watches).toEqual([{ id: 1, expression: "dc.aica.arm7.enabled", value: "0x0" }]);

      // the eighth step releases it, in front of its first instruction; from the ninth on it executes
      session.ok("control.runUntil");
      await vi.advanceTimersByTimeAsync(STEP_MS);
      session.ok("control.pause");
      expect(registerOf("dc.aica.arm7", "ENABLED")).toBe("0x1");
      expect(arm7Pc()).toBe(MOCK_ARM7_RING.base);
      expect(session.lastTick().callstacks!.arm7.length).toBeGreaterThanOrEqual(2);
      session.ok("control.runUntil");
      await vi.advanceTimersByTimeAsync(2 * STEP_MS);
      session.ok("control.pause");
      expect(arm7Pc()).toBe(MOCK_ARM7_RING.base + 8);

      // the machine holds it again (a guest does that), and releases it again
      mock.holdArm7();
      session.ok("state.unwatch", { watchIds: [1] });
      expect(registerOf("dc.aica.arm7", "ENABLED")).toBe("0x0");
      expect(arm7Pc()).toBe(MOCK_ARM7_RING.base);
      session.ok("control.runUntil");
      await vi.advanceTimersByTimeAsync(8 * STEP_MS);
      session.ok("control.pause");
      expect(registerOf("dc.aica.arm7", "ENABLED")).toBe("0x1");
    });

    it("its three steps answer -32012, behind -32003 while running; code breakpoints are accepted, and one on its first instruction stops it when it is released", async () => {
      const { session, registerOf, arm7Pc } = setup({ arm7Held: true }, false);
      for (const method of ["control.step", "control.stepOver", "control.stepOut"]) {
        session.fail(method, { target: "arm7" }, -32003);
      }
      session.ok("control.pause");
      const stopId = session.lastTick().executionState.stopId!;
      for (const method of ["control.step", "control.stepOver", "control.stepOut"]) {
        session.fail(method, { target: "arm7" }, -32012);
      }
      expect(session.lastTick().executionState.stopId).toBe(stopId);
      // the SH4 steps as ever
      session.ok("control.step", { target: "sh4" });

      // breakpoints.add never answers -32012: a breakpoint on the first instruction is what stops there
      session.ok("breakpoints.add", { event: "dc.aica.arm7.pc", address: MOCK_ARM7_RING.base });
      session.ok("breakpoints.toggle", { id: 1, enabled: false });
      session.ok("breakpoints.toggle", { id: 1, enabled: true });
      // registers of a held ARM7 are written
      session.ok("state.setRegister", { path: "dc.aica.arm7", name: "R1", value: "0xCAFE" });
      expect(registerOf("dc.aica.arm7", "R1")).toBe("0x0000CAFE");

      session.ok("control.runUntil");
      await vi.advanceTimersByTimeAsync(7 * STEP_MS);
      // held: the breakpoint on the address the PC stands at does not stop anything
      expect(session.lastTick().executionState.state).toBe("running");
      await vi.advanceTimersByTimeAsync(STEP_MS);
      expect(session.lastTick().executionState).toMatchObject({ state: "paused", reason: "breakpoint", breakpointId: 1 });
      expect(registerOf("dc.aica.arm7", "ENABLED")).toBe("0x1");
      expect(arm7Pc()).toBe(MOCK_ARM7_RING.base);
      // and from there it steps
      session.ok("control.step", { target: "arm7" });
      expect(arm7Pc()).toBe(MOCK_ARM7_RING.base + 4);
    });
  });

  describe("state.setRegister and state.editWatch", () => {
    it("match the path and the name without regard to case, and take a value in the grammar of the protocol", () => {
      const { session, registerOf } = setup();
      const r0 = () => registerOf("dc.sh4.cpu", "R0");
      session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "r0", value: "1" });
      expect(r0()).toBe("0x00000001");
      session.ok("state.setRegister", { path: "DC.SH4.CPU", name: "R0", value: " 0x1f " });
      expect(r0()).toBe("0x0000001F");
      session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "R0", value: "\t0X2A" });
      expect(r0()).toBe("0x0000002A");
      session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "R0", value: "007" });
      expect(r0()).toBe("0x00000007");
      // any length, of which the low bits count
      session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "R0", value: "0x123456789ABCDEF0123456789" });
      expect(r0()).toBe("0x23456789");
      for (const value of ["-1", "", "  ", "1.5", "0x", "0x1g", "1e3", "+1", "0b11", "1 2", "\n1"]) {
        session.fail("state.setRegister", { path: "dc.sh4.cpu", name: "R0", value }, -32602);
      }
      expect(r0()).toBe("0x23456789");
    });

    it("answer in this order: unknown path or name -32602, no writer -32013, a value that is no number -32602, a value the device refuses -32013", () => {
      const { session, registerOf } = setup();
      session.fail("state.setRegister", { path: "dc.no.such.node", name: "R0", value: "twelve" }, -32602);
      session.fail("state.setRegister", { path: "dc.sh4.cpu", name: "NO_SUCH", value: "twelve" }, -32602);
      // no writer comes before the value: a text that is no number, written to such a register, is -32013
      for (const [path, name] of [["dc", "SYSCLK"], ["dc.timing", "SH4_CYCLES"], ["dc.aica.arm7", "ENABLED"], ["dc.sh4.scif", "SCFRDR2"], ["dc.holly.sb.g1", "SB_G1RRC"]]) {
        session.fail("state.setRegister", { path, name, value: "twelve" }, -32013);
        session.fail("state.setRegister", { path, name, value: "1" }, -32013);
      }
      // a value the device refuses: a PC of the SH4 with bit 0 set, and it is unchanged
      const pc = registerOf("dc.sh4.cpu", "PC");
      session.fail("state.setRegister", { path: "dc.sh4.cpu", name: "PC", value: "0x8C0000A1" }, -32013);
      session.fail("state.setRegister", { path: "dc.sh4.cpu", name: "PC", value: "zero" }, -32602);
      expect(registerOf("dc.sh4.cpu", "PC")).toBe(pc);
      session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "PC", value: pc });

      // state.editWatch is the same from "no writer" on, behind its own look-up
      session.ok("state.watch", { expressions: ["dc.aica.arm7.enabled", "dc.sh4.cpu.pc", "dc.sh4.cpu.r1"] });
      session.fail("state.editWatch", { watchId: 99, value: "1" }, -32602);
      session.fail("state.editWatch", { watchId: 99, value: "twelve" }, -32602);
      session.fail("state.editWatch", { watchId: 1, value: "twelve" }, -32013);
      session.fail("state.editWatch", { watchId: 2, value: "0x8C0000A1" }, -32013);
      session.fail("state.editWatch", { watchId: 3, value: "twelve" }, -32602);
      session.ok("state.editWatch", { watchId: 3, value: " 0x1f " });
      expect(registerOf("dc.sh4.cpu", "R1")).toBe("0x0000001F");
    });

    it("the registers read back what was stored: the ARM7's PC aligned, its CPSR and the SH4's SR and FPSCR under their masks", () => {
      const { session, registerOf } = setup();
      const write = (path: string, name: string, value: string) => session.ok("state.setRegister", { path, name, value });
      write("dc.aica.arm7", "PC", "0x00200017");
      expect(registerOf("dc.aica.arm7", "PC")).toBe("0x00200014");
      // a CPSR whose mode bits are no mode is refused; one that names a mode is stored under its mask
      for (const mode of [0x00, 0x01, 0x0f, 0x14, 0x16, 0x18, 0x1a, 0x1e]) {
        session.fail("state.setRegister", { path: "dc.aica.arm7", name: "CPSR", value: String(0x000000c0 | mode) }, -32013);
      }
      expect(registerOf("dc.aica.arm7", "CPSR")).toBe("0x000000D3");
      for (const mode of [0x10, 0x11, 0x12, 0x13, 0x17, 0x1b, 0x1f]) {
        write("dc.aica.arm7", "CPSR", `0x${((0xffffff00 | 0xc0 | mode) >>> 0).toString(16)}`);
        expect(Number.parseInt(registerOf("dc.aica.arm7", "CPSR"), 16)).toBe((0xf00000c0 | mode) >>> 0);
      }
      write("dc.aica.arm7", "CPSR", "0xD3");
      write("dc.sh4.cpu", "FPSCR", "0xFFFFFFFF");
      expect(registerOf("dc.sh4.cpu", "FPSCR")).toBe("0x003FFFFF");
      write("dc.sh4.cpu", "SR", "0xFFFFFFFF");
      expect(registerOf("dc.sh4.cpu", "SR")).toBe("0x700083F3");
      // RB is stored in privileged mode only
      write("dc.sh4.cpu", "SR", "0x30000000");
      expect(registerOf("dc.sh4.cpu", "SR")).toBe("0x10000000");
      write("dc.sh4.cpu", "SR", "0x40000000");
    });

    it("debugger.describe says which registers have a writer, and a tick never does", () => {
      const { session, shape } = setup();
      const nodes = nodesOf(shape);
      const flagged = (path: string) => nodes.get(path)!.node.registers!.filter((register) => register.flags?.writable === true).map((register) => register.name);
      const unflagged = (path: string) => nodes.get(path)!.node.registers!.filter((register) => register.flags === undefined).map((register) => register.name);
      expect(flagged("dc.sh4.cpu")).toHaveLength(69);
      expect(unflagged("dc.aica.arm7")).toEqual(["ENABLED"]);
      expect(flagged("dc.aica.arm7")).toHaveLength(38);
      expect(unflagged("dc.timing")).toEqual(["MODE", "SH4_CYCLES", "SCHED_NOW", "SH4_BACKEND", "SH4_DEBUG_ENGINE"]);
      expect(unflagged("dc")).toEqual(["SYSCLK", "BUILD"]);
      expect(unflagged("dc.sh4.scif")).toEqual(["SCFRDR2"]);
      // a flag is true or absent, on a register that has a width
      for (const { node } of nodes.values()) {
        for (const register of node.registers ?? []) {
          expect(register.flags === undefined || (register.width > 0 && JSON.stringify(register.flags) === '{"writable":true}'), `${node.path}.${register.name}`).toBe(true);
        }
      }
      // every flagged register takes the value it reads, and every other one is refused
      for (const [path, { node }] of nodes) {
        const writable = node.registers?.find((register) => register.flags?.writable && register.value !== "n/a");
        const readOnly = node.registers?.find((register) => !register.flags?.writable);
        if (writable) session.ok("state.setRegister", { path, name: writable.name, value: writable.value });
        if (readOnly) session.fail("state.setRegister", { path, name: readOnly.name, value: "0" }, -32013);
      }
      for (const tick of session.ticks()) {
        for (const registers of Object.values(tick.registers)) {
          expect(registers.every((register) => !("flags" in register))).toBe(true);
        }
      }
    });
  });

  describe("the ARM7's program has a call", () => {
    const LOOP = [0x10, 0x14, 0x18, 0x1c, 0x20, 0x24, 0x30, 0x34, 0x38, 0x28, 0x2c].map((offset) => 0x00200000 + offset);

    it("its ring calls a leaf behind it: bl, two plain instructions and the return to R14", async () => {
      const { session, lines, registerOf, arm7Pc } = setup({ startPaused: true }, false);
      expect(MOCK_ARM7_CALL).toBe(0x00200024);
      expect(MOCK_ARM7_LEAF).toEqual({ base: 0x00200030, length: 3, instructionSize: 4 });
      const text = lines("arm7", MOCK_ARM7_RING.base, 11).map((line) => line.disassembly);
      expect(text[5]).toBe("bl 0x00200030");
      expect(text[7]).toBe("b 0x00200010");
      expect(text.slice(8)).toEqual(["add r0, r0, #1", "str r0, [r1]", "mov pc, lr"]);
      for (const index of [0, 1, 2, 3, 4, 6]) {
        expect(text[index], `line ${index}`).toMatch(/^(mov|ldr|str|add|sub|nop)\b/);
        expect(text[index]).not.toMatch(/\b(pc|r15)\b/);
      }

      // step by step around the loop, twice: through the leaf and back behind the call
      const walked: number[] = [];
      for (let index = 0; index < 2 * LOOP.length; index++) {
        walked.push(arm7Pc());
        session.ok("control.step", { target: "arm7" });
      }
      expect(walked).toEqual([...LOOP, ...LOOP]);
      expect(registerOf("dc.aica.arm7", "R14")).toBe("0x00200028");
      // the return goes to R14, whatever it is: written while the ARM7 is in the leaf, it is where the leaf returns to
      while (arm7Pc() !== MOCK_ARM7_LEAF.base) session.ok("control.step", { target: "arm7" });
      session.ok("state.setRegister", { path: "dc.aica.arm7", name: "R14", value: "0x00200018" });
      for (let index = 0; index < 3; index++) session.ok("control.step", { target: "arm7" });
      expect(arm7Pc()).toBe(0x00200018);
      // running, it goes the same way: eleven instructions a lap
      session.ok("control.runUntil");
      await vi.advanceTimersByTimeAsync(11 * STEP_MS);
      session.ok("control.pause");
      expect(arm7Pc()).toBe(0x00200018);
    });

    it("a step of the ARM7 moves nothing of the SH4, and the callstack follows the call", () => {
      const { session, registerOf, arm7Pc } = setup({ startPaused: true }, false);
      const sh4 = () => [registerOf("dc.sh4.cpu", "PC"), registerOf("dc.timing", "SH4_CYCLES"), registerOf("dc.timing", "SCHED_NOW")];
      const before = sh4();
      while (arm7Pc() !== MOCK_ARM7_LEAF.base) session.ok("control.step", { target: "arm7" });
      expect(sh4()).toEqual(before);
      const frames = session.lastTick().callstacks!.arm7;
      expect(frames[0]).toMatchObject({ index: 0, pc: MOCK_ARM7_LEAF.base });
      expect(frames[1]).toMatchObject({ index: 1, pc: MOCK_ARM7_CALL + 4, location: "lr" });
    });

    it("step over on the call is a temporary breakpoint behind it and a resume; elsewhere it is a step", async () => {
      const { session, arm7Pc } = setup({ startPaused: true }, false);
      // not on the call: one paused tick with reason step, no running tick
      session.frames.length = 0;
      session.ok("control.stepOver", { target: "arm7" });
      expect(session.ticks().map((tick) => tick.executionState.state)).toEqual(["paused"]);
      expect(arm7Pc()).toBe(MOCK_ARM7_RING.base + 4);
      while (arm7Pc() !== MOCK_ARM7_CALL) session.ok("control.step", { target: "arm7" });

      const stopId = session.lastTick().executionState.stopId!;
      session.frames.length = 0;
      expect(session.call("control.stepOver", { target: "arm7" }).result).toEqual({});
      expect(session.lastTick().executionState).toEqual({ state: "running", stopId });
      // the leaf is three instructions: the fourth emulation step arrives behind the call
      await vi.advanceTimersByTimeAsync(3 * STEP_MS);
      expect(session.lastTick().executionState.state).toBe("running");
      await vi.advanceTimersByTimeAsync(STEP_MS);
      expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: stopId + 1, reason: "step" });
      expect(arm7Pc()).toBe(MOCK_ARM7_CALL + 4);

      // the temporary breakpoint went at its stop: the target runs on through that address
      session.ok("control.runUntil");
      await vi.advanceTimersByTimeAsync(40 * STEP_MS);
      expect(session.lastTick().executionState.state).toBe("running");
    });

    it("step out is a temporary breakpoint at R14 and a resume, from the leaf and from the ring", async () => {
      const { session, arm7Pc, registerOf } = setup({ startPaused: true }, false);
      while (arm7Pc() !== MOCK_ARM7_LEAF.base) session.ok("control.step", { target: "arm7" });
      const stopId = session.lastTick().executionState.stopId!;
      expect(registerOf("dc.aica.arm7", "R14")).toBe("0x00200028");
      session.frames.length = 0;
      expect(session.call("control.stepOut", { target: "arm7" }).result).toEqual({});
      expect(session.lastTick().executionState).toEqual({ state: "running", stopId });
      await vi.advanceTimersByTimeAsync(3 * STEP_MS);
      expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: stopId + 1, reason: "step" });
      expect(arm7Pc()).toBe(0x00200028);
      expect(session.ticks().map((tick) => tick.executionState.state)).toEqual(["running", "paused"]);

      // from the ring: R14 is where the last call returned to, and the loop passes it at every turn
      session.ok("control.step", { target: "arm7" });
      session.ok("control.stepOut", { target: "arm7" });
      await vi.advanceTimersByTimeAsync(9 * STEP_MS);
      expect(session.lastTick().executionState.state).toBe("running");
      await vi.advanceTimersByTimeAsync(STEP_MS);
      expect(session.lastTick().executionState).toMatchObject({ state: "paused", reason: "step" });
      expect(arm7Pc()).toBe(0x00200028);
      session.ok("control.runUntil");
      await vi.advanceTimersByTimeAsync(40 * STEP_MS);
      expect(session.lastTick().executionState.state).toBe("running");
    });

    it("the temporary breakpoint goes at any other stop as well: a breakpoint, a pause, a stop of the host", async () => {
      const { mock, session, arm7Pc } = setup({ startPaused: true }, false);
      while (arm7Pc() !== MOCK_ARM7_CALL) session.ok("control.step", { target: "arm7" });
      // a listed breakpoint in the leaf stops the step-over first, with its own reason
      session.ok("breakpoints.add", { event: "dc.aica.arm7.pc", address: MOCK_ARM7_LEAF.base + 4 });
      session.ok("control.stepOver", { target: "arm7" });
      await vi.advanceTimersByTimeAsync(2 * STEP_MS);
      expect(session.lastTick().executionState).toMatchObject({ state: "paused", reason: "breakpoint", breakpointId: 1 });
      session.ok("breakpoints.remove", { id: 1 });
      session.ok("control.runUntil");
      await vi.advanceTimersByTimeAsync(40 * STEP_MS);
      expect(session.lastTick().executionState.state).toBe("running");

      // ... and so does a pause
      session.ok("control.pause");
      session.ok("control.stepOut", { target: "arm7" });
      session.ok("control.pause");
      expect(session.lastTick().executionState).toMatchObject({ state: "paused", reason: "pause" });
      session.ok("control.runUntil");
      await vi.advanceTimersByTimeAsync(40 * STEP_MS);
      expect(session.lastTick().executionState.state).toBe("running");

      // ... and a stop of the host, which is no stop of the debugger's making: the machine the
      // host resumes runs on through the address a step-out was waiting at
      session.ok("control.pause");
      session.ok("control.stepOut", { target: "arm7" });
      mock.setLifetime("stopped");
      expect(session.lastTick().executionState).toMatchObject({ state: "paused", reason: "host-stopped" });
      mock.setLifetime("running");
      expect(session.lastTick().executionState.state).toBe("running");
      await vi.advanceTimersByTimeAsync(40 * STEP_MS);
      expect(session.lastTick().executionState.state).toBe("running");
      // the same for the step-over of a call, with the game closed and started again in between
      session.ok("control.pause");
      while (arm7Pc() !== MOCK_ARM7_CALL) session.ok("control.step", { target: "arm7" });
      session.ok("control.stepOver", { target: "arm7" });
      mock.setLifetime("no-machine");
      expect(session.lastTick().executionState).toMatchObject({ state: "paused", reason: "no-game" });
      mock.setLifetime("running");
      // (StartPaused parks the game that starts)
      expect(session.lastTick().executionState).toMatchObject({ state: "paused", reason: "start" });
      session.ok("control.runUntil");
      await vi.advanceTimersByTimeAsync(40 * STEP_MS);
      expect(session.lastTick().executionState.state).toBe("running");
    });

    it("compares ARM7 breakpoint addresses under the mask of its wave memory, and reports the PC as it is", async () => {
      const { session, arm7Pc } = setup({ startPaused: true }, false);
      const site = MOCK_ARM7_RING.base + 8;
      // a multiple of 4 up to 0x00FFFFFF, else -32602; never -32012
      session.fail("breakpoints.add", { event: "dc.aica.arm7.pc", address: 2 }, -32602);
      session.fail("breakpoints.add", { event: "dc.aica.arm7.pc", address: 0x01000000 }, -32602);
      session.fail("breakpoints.add", { event: "dc.aica.arm7.pc", address: 0x80200018 }, -32602);
      session.ok("breakpoints.add", { event: "dc.aica.arm7.pc", address: site + 0x00800000 });
      expect(session.lastTick().breakpoints["1"]).toMatchObject({ address: site + 0x00800000 });
      session.ok("control.runUntil");
      await vi.advanceTimersByTimeAsync(2 * STEP_MS);
      expect(session.lastTick().executionState).toMatchObject({ state: "paused", reason: "breakpoint", breakpointId: 1 });
      expect(arm7Pc()).toBe(site);
    });
  });

  describe("the effects of the SH4 that a client can provoke", () => {
    it("a write of SR that changes RB in privileged mode exchanges R0..R7 with R0_BANK..R7_BANK", () => {
      const { session, registerOf } = setup();
      const bank = (suffix: string) => Array.from({ length: 8 }, (_, index) => registerOf("dc.sh4.cpu", `R${index}${suffix}`));
      const live = bank("");
      const other = bank("_BANK");
      expect(live).not.toEqual(other);
      expect(registerOf("dc.sh4.cpu", "SR")).toBe("0x40000000");
      session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "SR", value: "0x60000000" });
      expect(bank("")).toEqual(other);
      expect(bank("_BANK")).toEqual(live);
      expect(registerOf("dc.sh4.cpu", "R8")).toBe("0x00008888");
      // the same value again changes nothing; RB back exchanges them back
      session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "SR", value: "0x60000000" });
      expect(bank("")).toEqual(other);
      session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "SR", value: "0x40000000" });
      expect(bank("")).toEqual(live);
      // without MD there is no other bank: RB is not stored, and nothing is exchanged
      session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "SR", value: "0x00000000" });
      session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "SR", value: "0x20000000" });
      expect(registerOf("dc.sh4.cpu", "SR")).toBe("0x00000000");
      expect(bank("")).toEqual(live);
    });

    it("the interrupt handler runs in the other bank and comes back to the first", async () => {
      const { session, registerOf } = setup({}, false);
      session.ok("breakpoints.add", { event: "dc.sh4.cpu.pc", address: MOCK_SH4_HANDLER.base });
      await vi.advanceTimersByTimeAsync(STEP_MS);
      expect(session.lastTick().executionState).toMatchObject({ reason: "breakpoint" });
      expect(registerOf("dc.sh4.cpu", "SR")).toBe("0x70000000");
      expect(registerOf("dc.sh4.cpu", "R1")).toBe("0x00000000");
      expect(registerOf("dc.sh4.cpu", "R1_BANK")).toBe("0x00001111");
      session.ok("breakpoints.remove", { id: 1 });
      session.ok("control.runUntil");
      await vi.advanceTimersByTimeAsync(STEP_MS);
      session.ok("control.pause");
      expect(registerOf("dc.sh4.cpu", "SR")).toBe("0x40000000");
      expect(registerOf("dc.sh4.cpu", "R1")).toBe("0x00001111");
    });

    it("a step from a PC outside the ring and the handler ends at PC + 2, and executes a written mov #imm, Rn", () => {
      const { session, registerOf, lines } = setup();
      const address = 0x8cffef00;
      session.ok("state.writeMemory", { target: "sh4", address, data: [0x5a, 0xe0, 0x80, 0xe3] });
      expect(lines("sh4", address, 2)).toEqual([
        { address, bytes: "5A E0", disassembly: "mov #90, r0" },
        { address: address + 2, bytes: "80 E3", disassembly: "mov #-128, r3" },
      ]);
      session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "PC", value: String(address) });
      session.ok("control.step", { target: "sh4" });
      expect(registerOf("dc.sh4.cpu", "PC")).toBe("0x8CFFEF02");
      expect(registerOf("dc.sh4.cpu", "R0")).toBe("0x0000005A");
      session.ok("control.step", { target: "sh4" });
      expect(registerOf("dc.sh4.cpu", "PC")).toBe("0x8CFFEF04");
      expect(registerOf("dc.sh4.cpu", "R3")).toBe("0xFFFFFF80");
      // through another address of the same memory it is the same instruction
      session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "R0", value: "0" });
      session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "PC", value: "0x0CFFEF00" });
      session.ok("control.step", { target: "sh4" });
      expect(registerOf("dc.sh4.cpu", "R0")).toBe("0x0000005A");
      // the bytes written back, the line is what it was and executes nothing
      const original = lines("sh4", address + 4, 1)[0];
      session.ok("state.writeMemory", { target: "sh4", address: address + 4, data: [0x11, 0xe1] });
      session.ok("state.writeMemory", { target: "sh4", address: address + 4, data: original.bytes.split(" ").map((byte) => Number.parseInt(byte, 16)) });
      expect(lines("sh4", address + 4, 1)[0]).toEqual(original);
      session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "PC", value: String(address + 4) });
      session.ok("control.step", { target: "sh4" });
      expect(registerOf("dc.sh4.cpu", "R1")).toBe("0x00001111");
      expect(registerOf("dc.sh4.cpu", "PC")).toBe("0x8CFFEF06");
    });

    it("a written mov #imm, Rn is one also where one of its two bytes is what the mock fabricates there", () => {
      const { session, registerOf, lines, read } = setup();
      // before anything is written the byte at 0x8C010094 reads 0x5A, and the one at 0x8C010229 reads 0xE0:
      // of `5A E0` written at 0x8C010094, and at 0x8C010228, the mock keeps one byte
      expect(read("sh4", 0x8c010094, 1)).toEqual([0x5a]);
      expect(read("sh4", 0x8c010229, 1)).toEqual([0xe0]);
      for (const address of [0x8c010094, 0x8c010228]) {
        const where = `0x${address.toString(16).toUpperCase()}`;
        const original = lines("sh4", address, 1)[0];
        expect(original.disassembly, where).not.toMatch(/^mov #/);
        session.ok("state.writeMemory", { target: "sh4", address, data: [0x5a, 0xe0] });
        expect(lines("sh4", address, 1), where).toEqual([{ address, bytes: "5A E0", disassembly: "mov #90, r0" }]);
        session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "R0", value: "0" });
        session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "PC", value: String(address) });
        session.ok("control.step", { target: "sh4" });
        expect(registerOf("dc.sh4.cpu", "R0"), where).toBe("0x0000005A");
        expect(registerOf("dc.sh4.cpu", "PC"), where).toBe(`0x${(address + 2).toString(16).toUpperCase()}`);
        // written back as they were, the bytes are the line they were, and it executes nothing:
        // the mock's SH4 executes what was written, not what its memory happens to read
        session.ok("state.writeMemory", { target: "sh4", address, data: original.bytes.split(" ").map((byte) => Number.parseInt(byte, 16)) });
        expect(lines("sh4", address, 1)[0], where).toEqual(original);
        session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "R0", value: "0" });
        session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "PC", value: String(address) });
        session.ok("control.step", { target: "sh4" });
        expect(registerOf("dc.sh4.cpu", "R0"), where).toBe("0x00000000");
      }
      // one byte is enough to write an instruction: `E3` behind a byte that is left as it reads
      const [low] = read("sh4", 0x8c020000, 1);
      session.ok("state.writeMemory", { target: "sh4", address: 0x8c020001, data: [0xe3] });
      const signed = low & 0x80 ? low - 256 : low;
      expect(lines("sh4", 0x8c020000, 1)[0].disassembly).toBe(`mov #${signed}, r3`);
    });
  });

  describe("the device tree", () => {
    it("has the M2 rows: 104 nodes under their parents, the two actions, registers where milestone M2 has them, and fewer than 1000 rows", () => {
      // (the default mock's tree is that of M3, which has the nodes of M2)
      const { shape } = setup();
      const nodes = nodesOf(shape);
      expect(nodes.size).toBe(104);
      const parents: Record<string, string> = {
        "dc.holly.sb": "dc.holly",
        "dc.holly.sb.g1": "dc.holly.sb",
        "dc.holly.sb.g2": "dc.holly.sb",
        "dc.holly.sb.pvr": "dc.holly.sb",
        "dc.holly.sb.misc": "dc.holly.sb",
        "dc.holly.spg": "dc.holly",
        "dc.aica.common": "dc.aica",
        "dc.aica.rtc": "dc.aica",
        ...Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`dc.aica.sgc.${index}`, "dc.aica.sgc"])),
      };
      for (const [path, parent] of Object.entries(parents)) {
        expect(nodes.get(path)?.parent, path).toBe(parent);
      }
      expect(nodes.get("dc.holly.sb")!.node.registers).toBeUndefined();
      for (const path of [
        ...["dmac", "sb.g1", "sb.g2", "sb.pvr", "sb.misc", "ta", "core", "spg"].map((name) => `dc.holly.${name}`),
        "dc.aica.common",
        "dc.aica.rtc",
        ...Array.from({ length: 64 }, (_, index) => `dc.aica.sgc.${index}`),
        "dc.gdrom",
        "dc.maple",
      ]) {
        expect(nodes.get(path)!.node.registers!.length, path).toBeGreaterThan(0);
        // (the common block has RBP, RBL and TESTB0 of 0x2804 besides its eight)
        expect(nodes.get(path)!.node.registers!.length, path).toBeLessThanOrEqual(path === "dc.aica.common" ? 11 : 8);
      }
      expect(nodes.get("dc.sh4.cpu")!.node.actions).toEqual(["sh4-disassembly", "sh4-memory", "sh4-registers"]);
      expect(nodes.get("dc.aica.arm7")!.node.actions).toEqual(["arm7-disassembly", "arm7-memory", "arm7-registers"]);
      // each of the twelve register panels is the action of one node
      const offered = Array.from(nodes.values()).flatMap(({ node }) => node.actions ?? []).filter((action) => action.endsWith("-registers"));
      expect(offered).toHaveLength(12);
      expect(new Set(offered).size).toBe(12);
      // the registers of the M1 nodes are what they were
      expect(nodes.get("dc.holly.dmac")!.node.registers!.map((register) => register.name)).toEqual(["DMAOR", "CHCR0"]);
      expect(nodes.get("dc.aica.sgc.1")!.node.registers!.map((register) => register.name)).toEqual(["VOL", "KYONB", "SA", "LSA", "LEA", "FNS", "OCT", "TL"]);
      // a write-only register reads "n/a"
      expect(nodes.get("dc.holly.sb.g1")!.node.registers![0]).toEqual({ name: "SB_G1RRC", value: "n/a", width: 32 });
      expect(nodes.get("dc.aica.common")!.node.registers!.find((register) => register.name === "SCILV0")).toEqual({ name: "SCILV0", value: "n/a", width: 8 });
      const rows = nodes.size + Array.from(nodes.values()).reduce((sum, { node }) => sum + (node.registers?.length ?? 0), 0);
      expect(rows).toBeGreaterThanOrEqual(100);
      expect(rows).toBeLessThan(1000);
    });
  });

  describe("the profiles", () => {
    it("MOCK_M1_SUPPORT also hides the memory write, the reset, the M2 rows and the two actions", () => {
      const { session, shape } = setup({ supports: MOCK_M1_SUPPORT });
      const nodes = nodesOf(shape);
      expect(shape.capabilities).toEqual(["event-breakpoints", "callstack", "sh4-debug-native"]);
      expect(nodes.size).toBe(34);
      for (const path of ["dc.holly.sb", "dc.holly.spg", "dc.aica.common", "dc.aica.rtc", "dc.aica.sgc.2", "dc.aica.sgc.63"]) {
        expect(nodes.has(path), path).toBe(false);
      }
      expect(nodes.get("dc.gdrom")!.node.registers).toBeUndefined();
      expect(nodes.get("dc.maple")!.node.registers).toBeUndefined();
      expect(nodes.get("dc.sh4.cpu")!.node.actions).toEqual(["sh4-disassembly", "sh4-memory"]);
      expect(nodes.get("dc.aica.arm7")!.node.actions).toEqual(["arm7-disassembly", "arm7-memory"]);
      // no register says it has a writer: the server writes none
      expect(Array.from(nodes.values()).flatMap(({ node }) => node.registers ?? []).some((register) => register.flags !== undefined)).toBe(false);
      session.fail("state.writeMemory", { target: "sh4", address: 0x8c010000, data: [0] }, -32004);
      session.fail("state.writeMemory", {}, -32004);
      session.fail("control.reset", {}, -32004);
      session.fail("state.setRegister", { path: "dc.sh4.cpu", name: "R0", value: "1" }, -32004);
    });

    it("MOCK_M2_SUPPORT is what the emulator of M2 can do, and no more", () => {
      const { session, shape, registerOf } = setup({ supports: MOCK_M2_SUPPORT });
      const nodes = nodesOf(shape);
      expect(shape.capabilities).toEqual(["event-breakpoints", "callstack", "memory-write", "register-write", "reset", "sh4-debug-native"]);
      expect(shape.targets!.map(({ id, stepping }) => [id, stepping])).toEqual([["sh4", true], ["arm7", true], ["dsp", false]]);
      expect(nodes.size).toBe(104);
      // the writable registers are those of the two processors, but ENABLED: 69 and 38 on the mock
      const flagged = new Map<string, string[]>();
      for (const [path, { node }] of nodes) {
        const names = (node.registers ?? []).filter((register) => register.flags?.writable).map((register) => register.name);
        if (names.length) flagged.set(path, names);
      }
      expect(Array.from(flagged.keys())).toEqual(["dc.sh4.cpu", "dc.aica.arm7"]);
      expect(flagged.get("dc.sh4.cpu")).toHaveLength(69);
      expect(flagged.get("dc.aica.arm7")).toHaveLength(38);
      expect(flagged.get("dc.aica.arm7")).not.toContain("ENABLED");

      session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "R0", value: "0x55" });
      session.ok("state.setRegister", { path: "dc.aica.arm7", name: "R1", value: "0x66" });
      expect(registerOf("dc.aica.arm7", "R1")).toBe("0x00000066");
      for (const [path, name] of [["dc.sh4.bsc", "BCR1"], ["dc.holly.dmac", "DMAOR"], ["dc.aica.sgc.0", "VOL"], ["dc.aica.dsp", "STEP"], ["dc.aica.rtc", "SECONDS"], ["dc.aica.arm7", "ENABLED"]]) {
        session.fail("state.setRegister", { path, name, value: "1" }, -32013);
      }
      session.ok("state.watch", { expressions: ["dc.aica.sgc.0.vol"] });
      session.fail("state.editWatch", { watchId: 1, value: "1" }, -32013);

      // the ARM7 steps and has breakpoints, the DSP does not; memory is written and the machine reset
      session.ok("control.step", { target: "arm7" });
      session.ok("breakpoints.add", { event: "dc.aica.arm7.pc", address: 0x00200010, enabled: false });
      session.fail("control.step", { target: "dsp" }, -32004);
      session.fail("breakpoints.add", { event: "dc.aica.dsp.step", address: 5 }, -32004);
      session.ok("state.writeMemory", { target: "arm7", address: 0, data: [1] });
      session.ok("control.reset");
      session.fail("state.recordSgcFrames", {}, -32004);
    });
  });
});

describe("error table", () => {
  const setup = () => {
    const mock = createMock();
    const session = connect(mock);
    session.describe();
    session.frames.length = 0;
    return { mock, session };
  };

  it("answers a frame that is not JSON with -32700 and id null", () => {
    const { session } = setup();
    session.send("{nope");
    expect(session.frames).toEqual([{ jsonrpc: "2.0", id: null, error: { code: -32700, message: expect.stringMatching(/./) } }]);
  });

  it("answers what is not a JSON-RPC 2.0 request object, and a batch, with -32600", () => {
    const { session } = setup();
    const invalid = { code: -32600, message: expect.stringMatching(/./) };
    session.send(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "debugger.describe", params: {} }]));
    session.send("42");
    session.send(JSON.stringify({ id: 2, method: "debugger.describe", params: {} }));
    session.send(JSON.stringify({ jsonrpc: "1.0", id: 3, method: "debugger.describe", params: {} }));
    session.send(JSON.stringify({ jsonrpc: "2.0", id: 4, params: {} }));
    session.send(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "control.pause", params: [] }));
    session.send(JSON.stringify({ jsonrpc: "2.0", id: "6", method: "control.pause", params: {} }));
    expect(session.frames).toEqual([
      { jsonrpc: "2.0", id: null, error: invalid },
      { jsonrpc: "2.0", id: null, error: invalid },
      { jsonrpc: "2.0", id: 2, error: invalid },
      { jsonrpc: "2.0", id: 3, error: invalid },
      { jsonrpc: "2.0", id: 4, error: invalid },
      { jsonrpc: "2.0", id: 5, error: invalid },
      { jsonrpc: "2.0", id: null, error: invalid },
    ]);
  });

  it("does not answer a notification", () => {
    const { session } = setup();
    session.send(JSON.stringify({ jsonrpc: "2.0", method: "control.pause", params: {} }));
    expect(session.frames).toEqual([]);
  });

  it("answers an unknown method with the JSON-RPC error -32601 and the request id", () => {
    const { session } = setup();
    // the session's first request was debugger.describe, so these are requests 2 to 6
    for (const [index, method] of ["no.such.method", "event.tick", "toString", "constructor", "control.Pause"].entries()) {
      const response = session.call(method);
      expect(response).toEqual({ jsonrpc: "2.0", id: index + 2, error: { code: -32601, message: expect.stringMatching(/./) } });
    }
    expect(session.frames).toHaveLength(5);
  });

  it("reports invalid params as -32602: in-band for the RpcError methods, as a JSON-RPC error for the others", () => {
    const { session } = setup();
    session.fail("state.getMemorySlice", { address: "0x8c010000", length: 16 }, -32602);
    session.fail("state.getMemorySlice", { length: 16 }, -32602);
    session.fail("state.getDisassembly", { address: 0x8c010000 }, -32602);
    session.fail("state.getCallstack", { target: "dsp" }, -32602);
    session.fail("control.step", { target: 4 }, -32602);
    session.fail("control.step", {}, -32602);
    session.fail("breakpoints.toggle", { id: 1 }, -32602);
    session.fail("breakpoints.setCategoryStates", { categories: { sh4: { muted: "yes", soloed: false } } }, -32602);
    session.fail("state.watch", { expressions: "dc.sh4.cpu.pc" }, -32602);
    session.fail("state.setRegister", { path: "dc.sh4.cpu", name: "R0" }, -32602);
  });

  it("enforces every bound with -32602", () => {
    const { session } = setup();
    session.fail("state.getMemorySlice", { address: 0x8c010000, length: 0 }, -32602);
    session.fail("state.getMemorySlice", { address: 0x8c010000, length: 65537 }, -32602);
    expect((session.ok("state.getMemorySlice", { address: 0x8c010000, length: 65536 }) as { data: number[] }).data).toHaveLength(65536);
    session.fail("state.getMemorySlice", { address: 0x100000000, length: 1 }, -32602);
    session.fail("state.getMemorySlice", { address: -1, length: 1 }, -32602);
    session.fail("state.getDisassembly", { address: 0x8c010000, count: 0 }, -32602);
    session.fail("state.getDisassembly", { address: 0x8c010000, count: 1025 }, -32602);
    session.fail("state.getCallstack", { target: "sh4", maxFrames: 0 }, -32602);
    session.fail("state.getCallstack", { target: "sh4", maxFrames: 65 }, -32602);
    session.fail("state.recordSgcFrames", { frames: 0 }, -32602);
    session.fail("state.recordSgcFrames", { frames: 4097 }, -32602);
    session.fail("state.watch", { expressions: [`dc.sh4.cpu.${"x".repeat(250)}`] }, -32602);
    session.fail("state.watch", { expressions: Array.from({ length: 65 }, () => "dc.sh4.cpu.pc") }, -32602);
  });

  it("allows 256 watches and 1024 breakpoints", () => {
    const { session } = setup();
    // every register of the tree, in upper case and through the 64-per-call limit
    const shape = session.describe();
    const expressions: string[] = [];
    const visit = (nodes: DebuggerShape["deviceTree"]) => {
      for (const node of nodes) {
        node.registers?.forEach((register) => expressions.push(`${node.path}.${register.name}`));
        if (node.children) visit(node.children);
      }
    };
    visit(shape.deviceTree);
    expect(expressions.length).toBeGreaterThan(257);
    for (let offset = 0; offset < 256; offset += 64) {
      session.ok("state.watch", { expressions: expressions.slice(offset, offset + 64) });
    }
    expect(session.lastTick().watches).toHaveLength(256);
    session.fail("state.watch", { expressions: [expressions[256]] }, -32602);
    // a stored expression is not added twice, so this is no 257th
    session.ok("state.watch", { expressions: [expressions[0]] });
    expect(session.lastTick().watches).toHaveLength(256);

    for (let index = 0; index < 1024; index++) {
      session.client.receive(JSON.stringify({ jsonrpc: "2.0", id: 10_000 + index, method: "breakpoints.add", params: { event: "dc.sh4.interrupt", enabled: false } }));
    }
    expect(Object.keys(session.lastTick().breakpoints)).toHaveLength(1024);
    session.fail("breakpoints.add", { event: "dc.sh4.interrupt" }, -32602);
  });

  it("refuses a step while running with -32003, and what it does not implement with -32004 on the method's channel", () => {
    const { session } = setup();
    for (const method of ["control.step", "control.stepOver", "control.stepOut"]) {
      session.fail(method, { target: "sh4" }, -32003);
    }
    // later milestones: a JSON-RPC error for the methods that report failures that way, whatever the params
    session.fail("state.getTable", { id: "sq" }, -32004);
    session.fail("state.captureHolly", {}, -32004);
    // a target without memory, an event the server does not raise, DSP step over / out
    session.fail("state.getMemorySlice", { target: "dsp", address: 0, length: 16 }, -32004);
    session.fail("breakpoints.add", { event: "dc.sh4.tlb_miss" }, -32004);
    session.fail("breakpoints.add", { event: "dc.sh4.cpu.pc", kind: "event" }, -32004);
    session.fail("breakpoints.add", { event: "dc.sh4.interrupt", address: 0x8c010000 }, -32004);
    session.ok("control.pause");
    session.fail("control.stepOver", { target: "dsp" }, -32004);
    session.fail("control.stepOut", { target: "dsp" }, -32004);
  });

  it("checks a code breakpoint's address: required, aligned, in range", () => {
    const { session } = setup();
    session.fail("breakpoints.add", { event: "dc.sh4.cpu.pc", kind: "code" }, -32602);
    session.fail("breakpoints.add", { event: "dc.sh4.cpu.pc", address: 0x8c010001 }, -32602);
    session.fail("breakpoints.add", { event: "dc.aica.arm7.pc", address: 0x00200002 }, -32602);
    session.fail("breakpoints.add", { event: "dc.aica.dsp.step", address: 128 }, -32602);
    session.ok("breakpoints.add", { event: "dc.aica.dsp.step", address: 127 });
    session.ok("breakpoints.add", { event: "dc.aica.arm7.pc", address: 0x00200004 });
    // unknown ids
    session.fail("breakpoints.remove", { id: 3 }, -32602);
    session.fail("breakpoints.toggle", { id: 3, enabled: true }, -32602);
    session.ok("breakpoints.remove", { id: 1 });
    session.fail("breakpoints.remove", { id: 1 }, -32602);
  });

  it("refuses a step whose precondition fails with -32005, and makes no stop", () => {
    const { session } = setup();
    session.ok("control.pause");
    // (an odd PC is refused when it is written: the precondition that is left to fail is a PC that cannot be read)
    session.fail("state.setRegister", { path: "dc.sh4.cpu", name: "PC", value: "0x8C0000A1" }, -32013);
    session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "PC", value: "0x10000000" });
    const stopId = session.lastTick().executionState.stopId;
    for (const method of ["control.step", "control.stepOver", "control.stepOut"]) {
      session.fail(method, { target: "sh4" }, -32005);
    }
    expect(session.lastTick().executionState.stopId).toBe(stopId);
    // outside of the loop the mock goes straight on
    session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "PC", value: "0x8C010000" });
    session.ok("control.step", { target: "sh4" });
    expect(session.pc()).toBe(0x8c010002);
  });

  it("resolves watch expressions case-insensitively, stores them in lower case, skips duplicates, and is all-or-nothing", () => {
    const { session } = setup();
    session.ok("state.watch", { expressions: ["dc.sh4.cpu.PC", "dc.sh4.cpu.pc", "dc.aica.dsp.STEP"] });
    expect(session.lastTick().watches).toEqual([
      { id: 1, expression: "dc.sh4.cpu.pc", value: expect.stringMatching(/^0x8C0000A[0-9A-F]$/) },
      { id: 2, expression: "dc.aica.dsp.step", value: expect.stringMatching(/^0x[0-9A-F]{2}$/) },
    ]);
    session.ok("state.watch", { expressions: ["DC.SH4.CPU.PC"] });
    expect(session.lastTick().watches).toHaveLength(2);

    session.fail("state.watch", { expressions: ["dc.sh4.cpu.sr", "dc.sh4.cpu.nope"] }, -32602);
    session.fail("state.watch", { expressions: ["pc"] }, -32602);
    session.fail("state.watch", { expressions: ["dc.sh4.dmac.dmaor.x"] }, -32602);
    expect(session.lastTick().watches).toHaveLength(2);

    // the id is kept; unknown ids and unresolvable expressions are -32602
    session.ok("state.modifyWatchExpression", { watchId: 1, newExpression: "dc.sh4.cpu.PR" });
    expect(session.lastTick().watches![0]).toMatchObject({ id: 1, expression: "dc.sh4.cpu.pr" });
    session.fail("state.modifyWatchExpression", { watchId: 9, newExpression: "dc.sh4.cpu.pr" }, -32602);
    session.fail("state.modifyWatchExpression", { watchId: 1, newExpression: "dc.sh4.cpu.nope" }, -32602);

    // unknown ids are ignored; ids are not reused
    session.ok("state.unwatch", { watchIds: [1, 77] });
    session.ok("state.watch", { expressions: ["dc.sh4.cpu.gbr"] });
    expect(session.lastTick().watches!.map((watch) => watch.id)).toEqual([2, 3]);
    // a register that cannot be read without a side effect
    session.ok("state.watch", { expressions: ["dc.sh4.scif.scfrdr2"] });
    expect(session.lastTick().watches!.at(-1)).toEqual({ id: 4, expression: "dc.sh4.scif.scfrdr2", value: "n/a" });
  });

  it("writes registers: 0x hex or decimal, truncated to the width; -32013 for text and read-only registers", () => {
    const { session } = setup();
    session.ok("control.pause");
    const r0 = () => session.lastTick().registers["dc.sh4.cpu"].find((register) => register.name === "R0")!.value;
    session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "R0", value: "0x12345678" });
    expect(r0()).toBe("0x12345678");
    session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "R0", value: "255" });
    expect(r0()).toBe("0x000000FF");
    session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "R0", value: "0x1FFFFFFFF" });
    expect(r0()).toBe("0xFFFFFFFF");
    session.ok("state.setRegister", { path: "dc.aica.sgc.1", name: "VOL", value: "0x1234" });
    // ceil(width / 4) digits, whatever the width
    expect(session.lastTick().registers["dc.aica.sgc.1"]).toEqual([
      { name: "VOL", value: "0x34", width: 8 },
      { name: "KYONB", value: "0x1", width: 1 },
      { name: "SA", value: "0x012340", width: 23 },
      { name: "LSA", value: "0x0000", width: 16 },
      { name: "LEA", value: "0x0FFF", width: 16 },
      { name: "FNS", value: "0x155", width: 10 },
      { name: "OCT", value: "0xF", width: 4 },
      { name: "TL", value: "0x20", width: 8 },
    ]);
    session.ok("state.setRegister", { path: "dc.aica.sgc.1", name: "FNS", value: "0xFFFF" });
    expect(session.lastTick().registers["dc.aica.sgc.1"][5]).toEqual({ name: "FNS", value: "0x3FF", width: 10 });

    session.fail("state.setRegister", { path: "dc.sh4.cpu", name: "R0", value: "twelve" }, -32602);
    session.fail("state.setRegister", { path: "dc.sh4.cpu", name: "R99", value: "1" }, -32602);
    session.fail("state.setRegister", { path: "dc.sh4.nope", name: "R0", value: "1" }, -32602);
    session.fail("state.setRegister", { path: "dc", name: "SYSCLK", value: "1" }, -32013);
    session.fail("state.setRegister", { path: "dc.timing", name: "SH4_CYCLES", value: "1" }, -32013);
    session.fail("state.setRegister", { path: "dc.sh4.scif", name: "SCFRDR2", value: "1" }, -32013);

    // state.editWatch is state.setRegister on the watched register
    session.ok("state.watch", { expressions: ["dc.sh4.cpu.r0", "dc.sysclk"] });
    session.ok("state.editWatch", { watchId: 1, value: "0x8C0000AC" });
    expect(r0()).toBe("0x8C0000AC");
    expect(session.lastTick().watches![0]).toEqual({ id: 1, expression: "dc.sh4.cpu.r0", value: "0x8C0000AC" });
    session.fail("state.editWatch", { watchId: 2, value: "100MHz" }, -32013);
    session.fail("state.editWatch", { watchId: 3, value: "1" }, -32602);
  });

  it("reads memory: always `length` bytes, unreadable bytes are 0 and listed, -32010 when nothing is readable", () => {
    const { session } = setup();
    const read = (target: string, address: number, length: number) =>
      session.ok("state.getMemorySlice", { target, address, length }) as { baseAddress: number; data: number[]; validity: string; unreadable?: number[][] };

    const ram = read("sh4", 0x8c010000, 16);
    expect(ram).toEqual({ baseAddress: 0x8c010000, data: expect.any(Array), validity: "ok" });
    expect(ram.data.map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ")).toBe(
      "86 4F 83 7E AE 81 E8 01 1D 47 B9 98 3A 3F 92 11",
    );

    // the end of the flash at 0x0021FFFF
    const flash = read("sh4", 0x0021fff0, 32);
    expect(flash.data).toHaveLength(32);
    expect(flash.unreadable).toEqual([[16, 16]]);
    expect(flash.data.slice(16)).toEqual(new Array(16).fill(0));
    // the GD-ROM registers in the middle of the system bus
    expect(read("sh4", 0x005f6ff8, 0x110).unreadable).toEqual([[8, 256]]);
    // the last bytes of the address space
    expect(read("sh4", 0xfffffff8, 16).unreadable).toEqual([[8, 8]]);

    session.fail("state.getMemorySlice", { address: 0x10000000, length: 16 }, -32010);
    session.fail("state.getMemorySlice", { address: 0x00600000, length: 0x800 }, -32010);

    // ARM7: wave RAM and the AICA registers
    expect(read("arm7", 0x00200000, 16).unreadable).toBeUndefined();
    expect(read("arm7", 0x00807ff8, 16).unreadable).toEqual([[8, 8]]);
    session.fail("state.getMemorySlice", { target: "arm7", address: 0x00900000, length: 16 }, -32010);
  });

  it("disassembles exactly `count` lines of bytes that equal the memory, fewer only at the end of the address space", () => {
    const { session } = setup();
    const lines = (target: string, address: number, count: number) =>
      (session.ok("state.getDisassembly", { target, address, count }) as { lines: Array<{ address: number; bytes: string; disassembly: string }> }).lines;

    const sh4 = lines("sh4", MOCK_SH4_RING.base, 16);
    expect(sh4.map((line) => line.address)).toEqual(Array.from({ length: 16 }, (_, index) => MOCK_SH4_RING.base + index * 2));
    const memory = session.ok("state.getMemorySlice", { address: MOCK_SH4_RING.base, length: 32 }) as { data: number[] };
    expect(sh4.map((line) => line.bytes).join(" ")).toBe(memory.data.map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" "));
    // the loop: seven instructions that are not control flow, then the branch back
    for (const line of sh4.slice(0, 7)) {
      expect(line.disassembly).toMatch(/^(mov\.l|mov|sts\.l|add|cmp\/eq|nop)\b/);
    }
    expect(sh4[7].disassembly).toBe("bf 0x8C0000A0");
    expect(lines("arm7", 0x0020002c, 1)).toEqual([{ address: 0x0020002c, bytes: expect.stringMatching(/^([0-9A-F]{2} ){3}[0-9A-F]{2}$/), disassembly: "b 0x00200010" }]);

    expect(lines("sh4", 0x8c010000, 1024)).toHaveLength(1024);
    expect(lines("sh4", 0xfffffffc, 16).map((line) => line.address)).toEqual([0xfffffffc, 0xfffffffe]);
    expect(lines("arm7", 0x00fffff8, 16).map((line) => line.address)).toEqual([0x00fffff8, 0x00fffffc]);
    expect(lines("dsp", 120, 64).map((line) => line.address)).toEqual([120, 121, 122, 123, 124, 125, 126, 127]);
    expect(lines("dsp", 0, 1)[0]).toEqual({ address: 0, bytes: "00 00 B0 00 00 0A 00 00", disassembly: "MPRO[0] = XSEL YSEL:1 IRA:32 YRL ZERO" });

    // an unreadable word
    expect(lines("sh4", 0x0021fffe, 2)).toEqual([
      { address: 0x0021fffe, bytes: expect.stringMatching(/^[0-9A-F]{2} [0-9A-F]{2}$/), disassembly: expect.any(String) },
      { address: 0x00220000, bytes: "??", disassembly: "<unreadable>" },
    ]);

    // a misaligned address, and one beyond the target's address space
    session.fail("state.getDisassembly", { address: 0x8c010001, count: 1 }, -32602);
    session.fail("state.getDisassembly", { target: "arm7", address: 0x00200002, count: 1 }, -32602);
    session.fail("state.getDisassembly", { target: "arm7", address: 0x01000000, count: 1 }, -32602);
    session.fail("state.getDisassembly", { target: "dsp", address: 128, count: 1 }, -32602);
  });

  it("returns the callstack on request, at most maxFrames frames with indices from 0", () => {
    const { session } = setup();
    const result = session.ok("state.getCallstack", { target: "sh4", maxFrames: 8 }) as { target: string; frames: Array<{ index: number; pc: number; symbol?: string }> };
    expect(result.target).toBe("sh4");
    expect(result.frames.map((frame) => frame.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(result.frames[0].symbol).toMatch(/^_main_loop\+0x[0-9A-F]+$/);
    expect((session.ok("state.getCallstack", { target: "arm7" }) as { frames: unknown[] }).frames).toHaveLength(16);
    expect(StrictDebuggerRpcMethodSchemas["state.getCallstack"].result.safeParse(result).success).toBe(true);
  });

  it("answers state.getSgcFrameData with -32011 and no binary frame before the first capture", async () => {
    const { session } = setup();
    session.fail("state.getSgcFrameData", {}, -32011);
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.binary).toEqual([]);
  });

  it("records SGC frames, answers when the capture is complete, and sends it with the v3 header", async () => {
    const { mock, session } = setup();
    const other = connect(mock);
    other.describe();

    // running: the machine keeps running
    const response = session.call("state.recordSgcFrames", { frames: 64 });
    expect(response).toBeUndefined();
    expect(session.frames).toEqual([]);
    await vi.advanceTimersByTimeAsync(16);
    // 64 samples, two periods of the AICA, are in the next emulation step: the answer, and no stop
    expect(session.frames).toEqual([{ jsonrpc: "2.0", id: 2, result: {} }]);

    const info = session.ok("state.getSgcFrameData") as { frameCount: number; totalBytes: number; binaryId: number };
    expect(info).toEqual({ frameCount: 64, channelsPerFrame: 64, bytesPerChannel: 128, totalBytes: 64 * 8192, binaryId: 1 });
    expect(session.ticks().every((tick) => tick.executionState.state === "running")).toBe(true);
    // the response first, then the frame, to the requesting client only
    expect(session.binary).toHaveLength(1);
    expect(other.binary).toEqual([]);
    const parsed = parseBinaryFrame(session.binary[0]);
    expect(parsed).toMatchObject({ ok: true, header: { kind: 1, binaryId: 1, payloadBytes: 64 * 8192 } });

    // binaryId counts per connection
    expect((session.ok("state.getSgcFrameData") as { binaryId: number }).binaryId).toBe(2);
    expect((other.ok("state.getSgcFrameData") as { binaryId: number }).binaryId).toBe(1);

    // the record layout: eight channels play; byte 109 is the flags byte; bytes 110..127 are zero
    if (parsed.ok) {
      const bytes = new Uint8Array(parsed.payload);
      const view = new DataView(parsed.payload);
      const enabled = new Set<number>();
      for (let frame = 0; frame < 64; frame++) {
        for (let channel = 0; channel < 64; channel++) {
          const offset = frame * 8192 + channel * 128;
          const flags = bytes[offset + 109];
          expect(flags & ~0x07).toBe(0);
          if (flags & 1) enabled.add(channel);
          else expect(view.getUint32(offset + 96, true)).toBe(0); // a disabled channel is silent
          expect(view.getUint32(offset + 96, true)).toBeLessThanOrEqual(0x3ff);
          expect(bytes.subarray(offset + 110, offset + 128).every((byte) => byte === 0)).toBe(true);
        }
      }
      expect(enabled.size).toBe(8);
    }
  });

  it("a capture from the paused state runs for the capture and pauses again with reason capture", async () => {
    const { session } = setup();
    session.ok("control.pause");
    const stopId = session.lastTick().executionState.stopId!;
    const cycles = (tick: DebuggerTick) => BigInt(tick.registers["dc.timing"].find((register) => register.name === "SH4_CYCLES")!.value);
    const before = cycles(session.lastTick());
    session.frames.length = 0;

    session.call("state.recordSgcFrames");
    expect(session.lastTick().executionState).toEqual({ state: "running", stopId });
    // 1024 samples are 32 periods of the AICA, which the second emulation step reaches
    await vi.advanceTimersByTimeAsync(16);
    expect(session.frames.map((frame) => frame.method ?? "response")).toEqual(["event.tick"]);
    await vi.advanceTimersByTimeAsync(16);
    expect(session.frames.map((frame) => frame.method ?? "response")).toEqual(["event.tick", "response", "event.tick"]);
    expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: stopId + 1, reason: "capture" });
    expect(cycles(session.lastTick()) - before).toBe(32n * 145124n);
    expect((session.ok("state.getSgcFrameData") as { frameCount: number }).frameCount).toBe(1024);
  });

  it("never sends a data member, a stack trace or anything but {} for a success", () => {
    const { session } = setup();
    session.call("no.such.method");
    session.call("control.step", { target: "sh4" });
    session.call("state.getMemorySlice", { address: "x" });
    for (const method of ["control.pause", "control.runUntil", "state.unwatch", "breakpoints.setCategoryStates"]) {
      const params = method === "state.unwatch" ? { watchIds: [] } : method === "breakpoints.setCategoryStates" ? { categories: {} } : {};
      expect(session.call(method, params).result).toEqual({});
    }
    expect(wire.join("\n")).not.toMatch(/"data"\s*:\s*\{|"stack"/);
  });
});

describe("milestone M3", () => {
  const STEP_MS = 16;
  /** an AICA period in SH4 cycles: a sound burst of 32 samples */
  const PERIOD = 145124n;
  const DATAPATH = ["ACC", "Y_REG", "FRC_REG", "ADRS_REG", "LATCH", "LATCH_COPY", "MEMVAL", "NOFL_PIPE", "MIXS_BANK"];
  /** A mock with a client that has described it; `paused`: at a pause the client asked for (unless it starts paused). */
  const setup = (options: MockDebuggerOptions = {}, paused = true) => {
    const mock = createMock(options);
    const session = connect(mock);
    const shape = session.describe();
    if (paused && !options.startPaused) {
      session.ok("control.pause");
    }
    const tick = () => session.lastTick();
    const value = (path: string, name: string, at: DebuggerTick = tick()) => at.registers[path].find((register) => register.name === name)!.value;
    const number = (path: string, name: string, at: DebuggerTick = tick()) => Number.parseInt(value(path, name, at), 16);
    const cycles = (at: DebuggerTick = tick()) => BigInt(value("dc.timing", "SH4_CYCLES", at));
    const step = (at: DebuggerTick = tick()) => number("dc.aica.dsp", "STEP", at);
    const mdecCt = (at: DebuggerTick = tick()) => number("dc.aica.dsp", "MDEC_CT", at);
    const datapath = (at: DebuggerTick = tick()) => DATAPATH.map((name) => value("dc.aica.dsp", name, at));
    const stopId = (at: DebuggerTick = tick()) => at.executionState.stopId!;
    /** the states of the ticks that came since `from` (an index into the ticks) */
    const statesSince = (from: number) => session.ticks().slice(from).map((at) => at.executionState.state);
    return { mock, session, shape, value, number, cycles, step, mdecCt, datapath, stopId, statesSince };
  };
  const nodesOf = (shape: DebuggerShape) => {
    const nodes = new Map<string, DebuggerShape["deviceTree"][number]>();
    const visit = (list: DebuggerShape["deviceTree"]) =>
      list.forEach((node) => {
        nodes.set(node.path, node);
        visit(node.children ?? []);
      });
    visit(shape.deviceTree);
    return nodes;
  };
  const hexPairs = (bytes: ArrayLike<number>) => Array.from(bytes, (byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ");

  describe("the profile and the device tree", () => {
    it("MOCK_M3_SUPPORT is what the emulator of M3 can do, and no more", () => {
      const { session, shape } = setup({ supports: MOCK_M3_SUPPORT });
      const nodes = nodesOf(shape);
      expect(shape.capabilities).toEqual(["event-breakpoints", "callstack", "memory-write", "register-write", "reset", "sgc-capture", "memory-binary", "sh4-debug-native"]);
      expect(shape.targets!.map(({ id, stepping }) => [id, stepping])).toEqual([["sh4", true], ["arm7", true], ["dsp", true]]);
      expect(nodes.size).toBe(104);
      // the writable registers are those of the two processors, but ENABLED: no device write in M3
      const flagged = new Map<string, string[]>();
      for (const [path, node] of nodes) {
        const names = (node.registers ?? []).filter((register) => register.flags?.writable).map((register) => register.name);
        if (names.length) flagged.set(path, names);
      }
      expect(Array.from(flagged.keys())).toEqual(["dc.sh4.cpu", "dc.aica.arm7"]);
      expect(flagged.get("dc.sh4.cpu")).toHaveLength(69);
      expect(flagged.get("dc.aica.arm7")).toHaveLength(38);
      expect(flagged.get("dc.aica.arm7")).not.toContain("ENABLED");
      for (const [path, name] of [["dc.aica.dsp", "STEP"], ["dc.aica.dsp", "ACC"], ["dc.aica.common", "RBP"], ["dc.aica.common", "TESTB0"], ["dc.aica.sgc.0", "VOL"], ["dc.aica.arm7", "ENABLED"]]) {
        session.fail("state.setRegister", { path, name, value: "1" }, -32013);
      }
    });

    it("dc.aica.dsp has the thirteen registers of M3 and none has a writer; dc.aica.common has RBP, RBL and TESTB0 of the same word", () => {
      for (const supports of [undefined, MOCK_M3_SUPPORT]) {
        const { session, shape, value } = setup({ supports });
        const nodes = nodesOf(shape);
        const dsp = nodes.get("dc.aica.dsp")!.registers!;
        expect(dsp.map((register) => [register.name, register.width])).toEqual([
          ["STEP", 8],
          ["MDEC_CT", 16],
          ["RBP", 16],
          ["RBL", 8],
          ["ACC", 26],
          ["Y_REG", 24],
          ["FRC_REG", 13],
          ["ADRS_REG", 12],
          ["LATCH", 16],
          ["LATCH_COPY", 16],
          ["MEMVAL", 16],
          ["NOFL_PIPE", 2],
          ["MIXS_BANK", 1],
        ]);
        // read-only on every server: even the default mock, which writes the registers of every other node
        expect(dsp.some((register) => register.flags !== undefined)).toBe(false);
        session.fail("state.setRegister", { path: "dc.aica.dsp", name: "MDEC_CT", value: "1" }, -32013);
        const common = nodes.get("dc.aica.common")!.registers!;
        expect(common.filter((register) => ["RBP", "RBL", "TESTB0"].includes(register.name)).map((register) => [register.name, register.width, register.value])).toEqual([
          ["RBP", 12, "0x400"],
          ["RBL", 2, "0x3"],
          ["TESTB0", 1, "0x0"],
        ]);
        expect(Number.parseInt(value("dc.aica.dsp", "RBP"), 16)).toBe(0x400);
        expect(Number.parseInt(value("dc.aica.dsp", "RBL"), 16)).toBe(3);
      }
      // the tree of M2 has the four of M2
      const { shape } = setup({ supports: MOCK_M2_SUPPORT });
      expect(nodesOf(shape).get("dc.aica.dsp")!.registers!.map((register) => register.name)).toEqual(["STEP", "MDEC_CT", "RBP", "RBL"]);
    });

    it("the option testb0 sets TESTB0, and MDEC_CT is then XORed with 0x8080 in every sample instead of counting down", () => {
      const { session, value, mdecCt } = setup({ testb0: true });
      expect(value("dc.aica.common", "TESTB0")).toBe("0x1");
      // a step from 127 ends the sample
      session.ok("breakpoints.add", { event: "dc.aica.dsp.step", address: 127 });
      session.ok("control.runUntil");
      expect(session.lastTick().executionState.reason).toBe(undefined);
      return vi.advanceTimersByTimeAsync(STEP_MS).then(() => {
        expect(session.lastTick().executionState).toMatchObject({ state: "paused", reason: "breakpoint" });
        const before = mdecCt();
        session.ok("breakpoints.remove", { id: 1 });
        session.ok("control.step", { target: "dsp" });
        expect(mdecCt()).toBe(before ^ 0x8080);
        expect(value("dc.aica.common", "TESTB0")).toBe("0x1");
      });
    });
  });

  describe("state.getMemoryBinary", () => {
    /** a client of its own whose frames, text and binary, are kept in the order they came */
    const ordered = (mock: MockDebugger) => {
      const log: Array<Frame | Uint8Array> = [];
      const client = mock.connect({ sendText: (text) => log.push(JSON.parse(text) as Frame), sendBinary: (frame) => log.push(frame) });
      let id = 100;
      const call = (method: string, params: unknown) => {
        const requestId = ++id;
        const from = log.length;
        client.receive(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }));
        const since = log.slice(from);
        return { response: since.find((frame): frame is Frame => !(frame instanceof Uint8Array) && frame.id === requestId)!, since };
      };
      return { client, log, call };
    };

    it("is state.getMemorySlice with a frame of kind 2 behind the response, to the requesting client only", () => {
      const { mock, session } = setup();
      const other = connect(mock);
      other.describe();
      const own = ordered(mock);
      own.call("debugger.describe", {});
      const slice = (address: number, length: number, target = "sh4") =>
        session.ok("state.getMemorySlice", { target, address, length }) as { baseAddress: number; data: number[]; unreadable?: number[][] };

      for (const [target, address, length] of [["sh4", 0x8c010000, 64], ["sh4", 0x0021fff0, 32], ["arm7", 0x00200000, 100], ["sh4", 0x00703400, 64]] as const) {
        const { response, since } = own.call("state.getMemoryBinary", { target, address, length });
        const result = response.result as { baseAddress: number; totalBytes: number; unreadable?: number[][]; binaryId: number };
        const expected = slice(address, length, target);
        expect(result).toEqual({ baseAddress: address, totalBytes: length, ...(expected.unreadable ? { unreadable: expected.unreadable } : {}), binaryId: result.binaryId });
        // the response, then the frame, and nothing else in between
        expect(since.length).toBe(2);
        expect(since[0]).toBe(response);
        const parsed = parseBinaryFrame(since[1] as Uint8Array);
        expect(parsed).toMatchObject({ ok: true, header: { kind: 2, binaryId: result.binaryId, payloadBytes: length } });
        expect(parsed.ok && Array.from(new Uint8Array(parsed.payload))).toEqual(expected.data);
      }
      // across the end of the flash: the unreadable run, and zeros there
      const across = own.call("state.getMemoryBinary", { address: 0x0021fff0, length: 32 });
      expect((across.response.result as { unreadable: number[][] }).unreadable).toEqual([[16, 16]]);
      const payload = parseBinaryFrame(across.since[1] as Uint8Array);
      expect(payload.ok && Array.from(new Uint8Array(payload.payload).subarray(16))).toEqual(new Array(16).fill(0));
      // the other clients receive no frame
      expect(session.binary).toEqual([]);
      expect(other.binary).toEqual([]);
    });

    it("binaryId counts per connection from 1, one counter for kinds 1 and 2", async () => {
      const { session } = setup();
      session.call("state.recordSgcFrames", { frames: 32 });
      await vi.advanceTimersByTimeAsync(STEP_MS);
      expect((session.ok("state.getMemoryBinary", { address: 0x8c010000, length: 16 }) as { binaryId: number }).binaryId).toBe(1);
      expect((session.ok("state.getSgcFrameData") as { binaryId: number }).binaryId).toBe(2);
      expect((session.ok("state.getMemoryBinary", { target: "arm7", address: 0, length: 16 }) as { binaryId: number }).binaryId).toBe(3);
      expect(session.binary.map((frame) => parseBinaryFrame(frame)).map((parsed) => parsed.ok && [parsed.header.kind, parsed.header.binaryId])).toEqual([
        [2, 1],
        [1, 2],
        [2, 3],
      ]);
    });

    it("-32010 when nothing is readable, -32004 for dsp, -32602 outside 1..16777216; no frame behind an error", () => {
      const { session } = setup();
      session.fail("state.getMemoryBinary", { address: 0x10000000, length: 16 }, -32010);
      session.fail("state.getMemoryBinary", { target: "arm7", address: 0x00900000, length: 16 }, -32010);
      session.fail("state.getMemoryBinary", { target: "dsp", address: 0, length: 16 }, -32004);
      session.fail("state.getMemoryBinary", { address: 0x8c010000, length: 0 }, -32602);
      session.fail("state.getMemoryBinary", { address: 0x8c010000, length: 16777217 }, -32602);
      session.fail("state.getMemoryBinary", { address: 0x8c010000 }, -32602);
      expect(session.binary).toEqual([]);
      // without the capability: -32004 whatever the params
      const m2 = setup({ supports: MOCK_M2_SUPPORT }).session;
      m2.fail("state.getMemoryBinary", { address: 0x8c010000, length: 16 }, -32004);
      m2.fail("state.getMemoryBinary", {}, -32004);
    });

    it("reads 16 MiB of main memory within 2 s, and wave memory is one store behind both targets", () => {
      const { session } = setup();
      // in real time, on the monotonic clock (monotonicNow): the fake timers of this file stop performance.now()
      const started = monotonicNow();
      const result = session.ok("state.getMemoryBinary", { address: 0x0c000000, length: 16777216 }) as { totalBytes: number; unreadable?: unknown };
      const elapsed = Math.round(monotonicNow() - started);
      expect(elapsed, `${elapsed} ms`).toBeLessThan(2000);
      expect(result.totalBytes).toBe(16777216);
      expect(result.unreadable).toBeUndefined();
      const frame = parseBinaryFrame(session.binary[0]);
      const tail = (session.ok("state.getMemorySlice", { address: 0x0cffffc0, length: 64 }) as { data: number[] }).data;
      expect(frame.ok && Array.from(new Uint8Array(frame.payload).subarray(16777216 - 64))).toEqual(tail);
      // what the frame carries is not zeros beyond its first 64 KiB
      expect(frame.ok && new Uint8Array(frame.payload).subarray(0x10000, 0x10100).some((byte) => byte !== 0)).toBe(true);

      // the ARM7's wave memory at 0 is the SH4's at 0x00800000, over 2 MiB
      session.ok("state.getMemoryBinary", { target: "arm7", address: 0, length: 0x200000 });
      session.ok("state.getMemoryBinary", { target: "sh4", address: 0x00800000, length: 0x200000 });
      const [arm7, sh4] = session.binary.slice(1).map((bytes) => parseBinaryFrame(bytes));
      expect(arm7.ok && sh4.ok && Buffer.compare(Buffer.from(arm7.payload), Buffer.from(sh4.payload))).toBe(0);
    });
  });

  describe("the DSP's program", () => {
    it("is one thing: the words of the register file at 0x3400 of both views, the bytes of state.getDisassembly {dsp}, and the playground's line of them", () => {
      const { session } = setup();
      const read = (target: string, address: number, length: number) => (session.ok("state.getMemorySlice", { target, address, length }) as { data: number[] }).data;
      const sh4 = read("sh4", 0x00703400, 2048);
      expect(read("arm7", 0x00803400, 2048)).toEqual(sh4);
      // a register of the file is a word of 16 bits in the low half of four bytes
      const words = Array.from({ length: 512 }, (_, index) => sh4[index * 4] | (sh4[index * 4 + 1] << 8));
      expect(sh4.filter((_, offset) => offset & 2).every((byte) => byte === 0)).toBe(true);
      expect(words).toEqual(Array.from(MOCK_DSP_WORDS));

      const lines = (session.ok("state.getDisassembly", { target: "dsp", address: 0, count: 128 }) as { lines: Array<{ address: number; bytes: string; disassembly: string }> }).lines;
      expect(lines.map((line) => line.address)).toEqual(Array.from({ length: 128 }, (_, step) => step));
      for (const line of lines) {
        const own = words.slice(line.address * 4, line.address * 4 + 4);
        expect(line.bytes).toBe(own.map((word) => hexPairs([word >> 8, word & 0xff])).join(" "));
        expect(line.disassembly).toBe(`MPRO[${line.address}] = ${disassembleDesc(decodeInst(own)) || "TRA:0"}`);
      }
      // loaded steps from 0, well below 127; the steps behind them, 127 among them, empty
      expect(lines.slice(0, MOCK_DSP_PROGRAM.length).map((line) => line.disassembly)).toEqual(MOCK_DSP_PROGRAM);
      expect(MOCK_DSP_PROGRAM.length).toBeLessThan(64);
      for (const line of lines.slice(MOCK_DSP_PROGRAM.length)) {
        expect(line).toEqual({ address: line.address, bytes: "00 00 00 00 00 00 00 00", disassembly: `MPRO[${line.address}] = TRA:0` });
      }
      // RBPL, at 0x2804, reads 0 for a CPU
      expect(read("sh4", 0x00702804, 4)).toEqual([0, 0, 0, 0]);
      expect(read("arm7", 0x00802804, 4)).toEqual([0, 0, 0, 0]);
    });
  });

  describe("the AICA is clocked whatever the ARM7 does", () => {
    it("with the ARM7 held, a DSP step is a step, a DSP breakpoint is reached and a capture records and completes; only the ARM7's three steps answer -32012", async () => {
      const { session, value, step, stopId } = setup({ arm7Held: true, startPaused: true });
      expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: 1, reason: "start" });
      expect(value("dc.aica.arm7", "ENABLED")).toBe("0x0");

      session.ok("control.step", { target: "dsp" });
      expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: 2, reason: "step" });
      expect(step()).toBe(1);
      for (const method of ["control.step", "control.stepOver", "control.stepOut"]) {
        session.fail(method, { target: "arm7" }, -32012);
      }

      const from = session.frames.length;
      session.call("state.recordSgcFrames", { frames: 64 });
      await vi.advanceTimersByTimeAsync(STEP_MS);
      expect(session.frames.slice(from).map((frame) => frame.method ?? JSON.stringify(frame.result))).toEqual(["event.tick", "{}", "event.tick"]);
      expect(session.lastTick().executionState).toMatchObject({ state: "paused", reason: "capture" });
      expect((session.ok("state.getSgcFrameData") as { frameCount: number }).frameCount).toBe(64);
      expect(value("dc.aica.arm7", "ENABLED")).toBe("0x0");

      session.ok("breakpoints.add", { event: "dc.aica.dsp.step", address: 3 });
      const before = stopId();
      session.ok("control.runUntil");
      await vi.advanceTimersByTimeAsync(STEP_MS);
      expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: before + 1, reason: "breakpoint", breakpointId: 1 });
      expect(step()).toBe(3);
      expect(value("dc.aica.arm7", "ENABLED")).toBe("0x0");
    });
  });

  describe("a step of the DSP", () => {
    it("is one step and never running: from a pause the SH4 runs to the next burst first, from a stop of the DSP not at all; the datapath moves", async () => {
      const { session, cycles, step, stopId, datapath, statesSince } = setup({}, false);
      await vi.advanceTimersByTimeAsync(3 * STEP_MS + 5);
      session.ok("control.pause");
      const paused = session.lastTick();
      expect(step(paused)).toBe(0);
      const from = session.ticks().length;
      session.ok("control.step", { target: "dsp" });
      const first = session.lastTick();
      expect(statesSince(from)).toEqual(["paused"]);
      expect(first.executionState).toEqual({ state: "paused", stopId: stopId(paused) + 1, reason: "step" });
      expect(step(first)).toBe(1);
      // the SH4 ran to the next burst, and no further
      expect(cycles(first) - cycles(paused)).toBeGreaterThan(0n);
      expect(cycles(first) - cycles(paused)).toBeLessThanOrEqual(PERIOD);
      expect(cycles(first) % PERIOD).toBe(0n);

      session.ok("control.step", { target: "dsp" });
      const second = session.lastTick();
      expect(step(second)).toBe(2);
      expect(cycles(second)).toBe(cycles(first));
      expect(datapath(second)).not.toEqual(datapath(first));
      expect(statesSince(from)).toEqual(["paused", "paused"]);
    });

    it("from 127 it ends at 0 at the end of the sample, MDEC_CT one less; while running -32003; step over and out -32004", async () => {
      const { session, step, mdecCt, cycles } = setup();
      session.ok("breakpoints.add", { event: "dc.aica.dsp.step", address: 127 });
      session.ok("control.runUntil");
      await vi.advanceTimersByTimeAsync(STEP_MS);
      expect(session.lastTick().executionState).toMatchObject({ reason: "breakpoint", breakpointId: 1 });
      expect(step()).toBe(127);
      const at = { mdecCt: mdecCt(), cycles: cycles() };
      session.ok("control.step", { target: "dsp" });
      expect(session.lastTick().executionState.reason).toBe("step");
      expect(step()).toBe(0);
      expect(mdecCt()).toBe((at.mdecCt - 1) & 0xffff);
      expect(cycles()).toBe(at.cycles);
      session.fail("control.stepOver", { target: "dsp" }, -32004);
      session.fail("control.stepOut", { target: "dsp" }, -32004);
      session.ok("breakpoints.remove", { id: 1 });
      session.ok("control.runUntil");
      session.fail("control.step", { target: "dsp" }, -32003);
    });
  });

  describe("the breakpoints of the DSP", () => {
    it("are reached in every sample: a resume stops in front of the same step one sample later, with no running tick in the burst and with one into the next", async () => {
      const { session, step, mdecCt, cycles, stopId, statesSince } = setup();
      session.ok("breakpoints.add", { event: "dc.aica.dsp.step", address: 5 });
      session.ok("control.runUntil");
      await vi.advanceTimersByTimeAsync(STEP_MS);
      const hit = session.lastTick();
      expect(hit.executionState).toMatchObject({ state: "paused", reason: "breakpoint", breakpointId: 1 });
      expect(step(hit)).toBe(5);
      expect(cycles(hit) % PERIOD).toBe(0n);
      // the 31 other samples of the burst: one stop each, with no running tick, the SH4 not moving
      for (let sample = 1; sample < 32; sample++) {
        const from = session.ticks().length;
        const before = session.lastTick();
        session.ok("control.runUntil");
        expect(statesSince(from)).toEqual(["paused"]);
        expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: stopId(before) + 1, reason: "breakpoint", breakpointId: 1 });
        expect(step()).toBe(5);
        expect(mdecCt()).toBe((mdecCt(before) - 1) & 0xffff);
        expect(cycles()).toBe(cycles(hit));
      }
      // the first sample of the next burst: the machine runs to it, one period on
      const before = session.lastTick();
      const from = session.ticks().length;
      session.ok("control.runUntil");
      await vi.advanceTimersByTimeAsync(STEP_MS);
      expect(statesSince(from)).toEqual(["running", "paused"]);
      expect(session.lastTick().executionState).toMatchObject({ reason: "breakpoint", breakpointId: 1 });
      expect(mdecCt()).toBe((mdecCt(before) - 1) & 0xffff);
      expect(cycles() - cycles(hit)).toBe(PERIOD);
    });

    it("two on one step stop with the lower id; one disabled, or of the muted category dsp, is not reached; one added while running is", async () => {
      const { session, step } = setup();
      session.ok("breakpoints.add", { event: "dc.aica.dsp.step", address: 9, enabled: false });
      session.ok("control.runUntil");
      await vi.advanceTimersByTimeAsync(5 * STEP_MS);
      expect(session.lastTick().executionState.state).toBe("running");
      session.ok("breakpoints.toggle", { id: 1, enabled: true });
      await vi.advanceTimersByTimeAsync(STEP_MS);
      expect(session.lastTick().executionState).toMatchObject({ state: "paused", reason: "breakpoint", breakpointId: 1 });
      session.ok("breakpoints.add", { event: "dc.aica.dsp.step", address: 9 });
      session.ok("breakpoints.add", { event: "dc.aica.dsp.step", address: 12 });
      session.ok("control.runUntil");
      // in the same sample, the step behind it; then step 9 of the next sample, with the lower id
      expect(session.lastTick().executionState).toMatchObject({ reason: "breakpoint", breakpointId: 3 });
      expect(step()).toBe(12);
      session.ok("control.runUntil");
      expect(session.lastTick().executionState).toMatchObject({ reason: "breakpoint", breakpointId: 1 });
      expect(step()).toBe(9);
      session.ok("breakpoints.setCategoryStates", { categories: { dsp: { muted: true, soloed: false } } });
      session.ok("control.runUntil");
      await vi.advanceTimersByTimeAsync(5 * STEP_MS);
      expect(session.lastTick().executionState.state).toBe("running");
      expect(step()).toBe(0);
    });
  });

  describe("a step of the SH4 or of the ARM7 from a stop of the DSP", () => {
    /** the default mock at the stop of a DSP breakpoint on step 5 (and on `more`), in the first sample of a burst */
    const atBreakpoint = async (more: number[] = []) => {
      const machine = setup();
      for (const address of [5, ...more]) {
        machine.session.ok("breakpoints.add", { event: "dc.aica.dsp.step", address });
      }
      machine.session.ok("control.runUntil");
      await vi.advanceTimersByTimeAsync(STEP_MS);
      expect(machine.session.lastTick().executionState).toMatchObject({ state: "paused", reason: "breakpoint", breakpointId: 1 });
      expect(machine.step()).toBe(5);
      return machine;
    };

    it("the SH4's: the suspended burst runs on first; when it meets the breakpoint again that is the stop and the step is dropped, else the burst ends and the SH4 steps", async () => {
      const { session, step, mdecCt, cycles, stopId, statesSince } = await atBreakpoint();
      const hit = session.lastTick();
      const from = session.ticks().length;
      session.ok("control.step", { target: "sh4" });
      expect(statesSince(from)).toEqual(["paused"]);
      expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: stopId(hit) + 1, reason: "breakpoint", breakpointId: 1 });
      expect(step()).toBe(5);
      expect(mdecCt()).toBe((mdecCt(hit) - 1) & 0xffff);
      expect(session.pc()).toBe(session.pc(hit));
      expect(cycles()).toBe(cycles(hit));
      // disabled: the 31 samples left of the burst, then the SH4's instruction
      session.ok("breakpoints.toggle", { id: 1, enabled: false });
      const before = session.lastTick();
      session.ok("control.step", { target: "sh4" });
      expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: stopId(before) + 1, reason: "step" });
      expect(step()).toBe(0);
      expect(mdecCt()).toBe((mdecCt(before) - 31) & 0xffff);
      expect(session.pc()).not.toBe(session.pc(before));
      expect(cycles()).toBe(cycles(before) + 1n);
    });

    it("the ARM7's: the rest of the sample runs first; a breakpoint behind the step in that sample is the stop and the step is dropped, else the step is in the next sample", async () => {
      const { session, number, step, mdecCt, stopId, statesSince } = await atBreakpoint([9]);
      const arm7Pc = (at?: DebuggerTick) => number("dc.aica.arm7", "PC", at);
      const hit = session.lastTick();
      session.ok("control.step", { target: "arm7" });
      expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: stopId(hit) + 1, reason: "breakpoint", breakpointId: 2 });
      expect(step()).toBe(9);
      expect(mdecCt()).toBe(mdecCt(hit));
      expect(arm7Pc()).toBe(arm7Pc(hit));
      // from step 9: the sample ends (STEP 0, MDEC_CT one less) and the ARM7 executes its instruction
      const at9 = session.lastTick();
      session.ok("control.step", { target: "arm7" });
      expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: stopId(at9) + 1, reason: "step" });
      expect(step()).toBe(0);
      expect(mdecCt()).toBe((mdecCt(at9) - 1) & 0xffff);
      expect(arm7Pc()).not.toBe(arm7Pc(at9));
      // the burst is suspended in front of the DSP of the next sample: a resume meets step 5 there
      const from = session.ticks().length;
      session.ok("control.runUntil");
      expect(statesSince(from)).toEqual(["paused"]);
      expect(session.lastTick().executionState).toMatchObject({ reason: "breakpoint", breakpointId: 1 });
      expect(mdecCt()).toBe((mdecCt(at9) - 1) & 0xffff);
    });

    it("a step-out of the ARM7 that the run-on ends at the DSP breakpoint again leaves no temporary breakpoint behind", async () => {
      const { session, stopId, statesSince } = await atBreakpoint();
      const hit = session.lastTick();
      session.ok("control.stepOut", { target: "arm7" });
      expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: stopId(hit) + 1, reason: "breakpoint", breakpointId: 1 });
      // the breakpoint removed, a resume runs, and nothing stops it
      session.ok("breakpoints.remove", { id: 1 });
      const from = session.ticks().length;
      session.ok("control.runUntil");
      await vi.advanceTimersByTimeAsync(40 * STEP_MS);
      expect(statesSince(from).filter((state) => state !== "running")).toEqual([]);
    });
  });

  describe("the capture", () => {
    it("armed at a stop advances SH4_CYCLES by exactly ceil(frames / 32) periods of the AICA; armed while running it stops nothing", async () => {
      const { session, cycles } = setup();
      for (const frames of [1, 64, 65, 4096]) {
        const before = session.lastTick();
        const from = session.frames.length;
        session.call("state.recordSgcFrames", { frames });
        await vi.advanceTimersByTimeAsync(10 * STEP_MS);
        const after = session.frames.slice(from);
        expect(after.map((frame) => frame.method ?? "response")).toEqual(["event.tick", "response", "event.tick"]);
        expect(session.lastTick().executionState).toMatchObject({ state: "paused", reason: "capture", stopId: before.executionState.stopId! + 1 });
        expect(cycles() - cycles(before)).toBe(BigInt(Math.ceil(frames / 32)) * PERIOD);
        expect((session.ok("state.getSgcFrameData") as { frameCount: number }).frameCount).toBe(frames);
      }
      session.ok("control.runUntil");
      const from = session.frames.length;
      session.call("state.recordSgcFrames", { frames: 2048 });
      await vi.advanceTimersByTimeAsync(5 * STEP_MS);
      expect(session.frames.slice(from).some((frame) => frame.method === undefined)).toBe(true);
      expect(session.ticks().slice(-1)[0].executionState.state).toBe("running");
      expect((session.ok("state.getSgcFrameData") as { frameCount: number }).frameCount).toBe(2048);
    });

    /** Sends state.recordSgcFrames with a request id of its own; the response is looked for by that id. */
    const record = (session: ReturnType<typeof connect>, id: number, frames?: number) => {
      session.send(JSON.stringify({ jsonrpc: "2.0", id, method: "state.recordSgcFrames", params: frames === undefined ? {} : { frames } }));
      return () => session.frames.find((frame) => frame.id === id && frame.method === undefined);
    };

    it("held open at a DSP breakpoint: the response waits, a second request is -32003, the server's capture is the one before; the resume completes it", async () => {
      const { session } = setup();
      const first = record(session, 9001, 64);
      await vi.advanceTimersByTimeAsync(STEP_MS);
      expect(first()).toEqual({ jsonrpc: "2.0", id: 9001, result: {} });
      expect(session.lastTick().executionState.reason).toBe("capture");

      session.ok("breakpoints.add", { event: "dc.aica.dsp.step", address: 0 });
      const held = record(session, 9002, 4096);
      await vi.advanceTimersByTimeAsync(STEP_MS);
      // the breakpoint's stop, and no response
      expect(session.lastTick().executionState).toMatchObject({ state: "paused", reason: "breakpoint", breakpointId: 1 });
      expect(held()).toBeUndefined();
      session.fail("state.recordSgcFrames", { frames: 16 }, -32003);
      expect((session.ok("state.getSgcFrameData") as { frameCount: number }).frameCount).toBe(64);
      // a step of the DSP keeps it recording, and so does one of the SH4: the burst suspended
      // there runs on first and meets the breakpoint, still active, one sample later, which drops
      // the step (M3-D22)
      session.ok("control.step", { target: "dsp" });
      const stepped = session.lastTick();
      session.ok("control.step", { target: "sh4" });
      expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: stepped.executionState.stopId! + 1, reason: "breakpoint", breakpointId: 1 });
      expect(session.pc()).toBe(session.pc(stepped));
      expect(held()).toBeUndefined();

      session.ok("breakpoints.remove", { id: 1 });
      session.ok("control.runUntil");
      await vi.advanceTimersByTimeAsync(10 * STEP_MS);
      expect(held()).toEqual({ jsonrpc: "2.0", id: 9002, result: {} });
      expect(session.lastTick().executionState).toMatchObject({ state: "paused", reason: "capture" });
      expect((session.ok("state.getSgcFrameData") as { frameCount: number }).frameCount).toBe(4096);
    });

    it("with the target stopped it is answered -32014 5 s after the request and cancelled; a reset answers -32014 at once; a host stop -32001", async () => {
      const { session, mock } = setup();
      const codeOf = (answer: () => Frame | undefined) => (answer()?.result as { error?: { code: number } } | undefined)?.error?.code;
      session.ok("breakpoints.add", { event: "dc.aica.dsp.step", address: 7 });
      const timedOut = record(session, 9101, 128);
      await vi.advanceTimersByTimeAsync(STEP_MS);
      expect(session.lastTick().executionState.reason).toBe("breakpoint");
      await vi.advanceTimersByTimeAsync(4900);
      expect(timedOut()).toBeUndefined();
      await vi.advanceTimersByTimeAsync(200);
      expect(codeOf(timedOut)).toBe(-32014);
      // cancelled: no capture came of it, and another one may be armed
      session.fail("state.getSgcFrameData", {}, -32011);

      const reset = record(session, 9102, 128);
      await vi.advanceTimersByTimeAsync(STEP_MS);
      expect(reset()).toBeUndefined();
      session.ok("control.reset");
      expect(codeOf(reset)).toBe(-32014);

      session.ok("breakpoints.add", { event: "dc.aica.dsp.step", address: 7 });
      const hostStop = record(session, 9103, 128);
      await vi.advanceTimersByTimeAsync(STEP_MS);
      expect(hostStop()).toBeUndefined();
      mock.setLifetime("stopped");
      expect(codeOf(hostStop)).toBe(-32001);
      session.fail("state.getSgcFrameData", {}, -32011);
    });
  });

  describe("the sound clock", () => {
    it("never goes back: a step of the SH4 from the stop of a capture at a burst's time, then a step of the DSP or a DSP breakpoint", async () => {
      for (const then of ["a step of the DSP", "a DSP breakpoint"] as const) {
        const { session, cycles } = setup({ startPaused: true });
        session.call("state.recordSgcFrames", { frames: 64 });
        await vi.advanceTimersByTimeAsync(STEP_MS);
        expect(session.lastTick().executionState).toMatchObject({ state: "paused", reason: "capture" });
        const captured = cycles();
        // (the stop is at the time of a burst that has not run)
        expect(captured).toBe(2n * PERIOD);
        session.ok("control.step", { target: "sh4" });
        expect(cycles()).toBe(captured + 1n);
        if (then === "a step of the DSP") {
          session.ok("control.step", { target: "dsp" });
          expect(session.lastTick().executionState.reason).toBe("step");
        } else {
          session.ok("breakpoints.add", { event: "dc.aica.dsp.step", address: 3 });
          session.ok("control.runUntil");
          await vi.advanceTimersByTimeAsync(STEP_MS);
          expect(session.lastTick().executionState).toMatchObject({ state: "paused", reason: "breakpoint" });
        }
        expect(cycles(), then).toBe(captured + 1n);
      }
    });

    it("MDEC_CT counts down once a sample, 32 samples a burst, a burst every 145124 cycles", async () => {
      const { session, mdecCt, cycles } = setup();
      const before = session.lastTick();
      session.ok("control.runUntil");
      await vi.advanceTimersByTimeAsync(5 * STEP_MS);
      session.ok("control.pause");
      const bursts = cycles() / PERIOD - cycles(before) / PERIOD;
      expect(bursts).toBeGreaterThanOrEqual(5n * 22n);
      expect((mdecCt(before) - mdecCt()) & 0xffff).toBe(Number((bursts * 32n) & 0xffffn));
    });
  });
});
