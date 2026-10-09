import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseBinaryFrame } from "../src/lib/binaryFrame";
import { IN_BAND_ERROR_METHODS, StrictDebuggerRpcMethodSchemas } from "../src/lib/debuggerSchema";
import type { DebuggerShape, DebuggerTick } from "../src/lib/debuggerSchema";
import { MOCK_M1_SUPPORT, MOCK_SH4_RING, MockDebugger, mockNextAddress } from "./mockDebugger";
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
    expect(shape.capabilities).toEqual(["event-breakpoints", "callstack", "register-write", "sgc-capture", "sh4-debug-native"]);
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

  it("stops at ARM7 and DSP code breakpoints, which the mock has ahead of the emulator's milestones", async () => {
    const mock = createMock();
    const session = connect(mock);
    session.describe();
    session.ok("control.pause");
    session.ok("breakpoints.add", { event: "dc.aica.dsp.step", address: 100 });
    session.ok("control.runUntil");
    await vi.advanceTimersByTimeAsync(128 * 16);
    expect(session.lastTick().executionState).toMatchObject({ state: "paused", reason: "breakpoint", breakpointId: 1 });
    expect(session.lastTick().registers["dc.aica.dsp"][0]).toEqual({ name: "STEP", value: "0x64", width: 8 });
    // the widths of the DSP's registers are those of the hardware
    expect(session.lastTick().registers["dc.aica.dsp"].map((register) => [register.name, register.width])).toEqual([
      ["STEP", 8],
      ["MDEC_CT", 16],
      ["RBP", 16],
      ["RBL", 8],
    ]);
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

  it("reports the protocol version it is told to report", () => {
    expect(connect(createMock()).call("debugger.describe").result).toMatchObject({ protocol: 3 });
    expect(connect(createMock({ protocol: 4 })).call("debugger.describe").result).toMatchObject({ protocol: 4 });
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
    // later milestones: in-band for the RpcError methods ...
    session.fail("control.reset", {}, -32004);
    session.fail("state.writeMemory", { target: "sh4", address: 0x8c010000, data: [0] }, -32004);
    // ... a JSON-RPC error for the others, whatever the params
    session.fail("state.getMemoryBinary", { address: 0x8c010000, length: 16 }, -32004);
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
    session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "PC", value: "0x8C0000A1" });
    const stopId = session.lastTick().executionState.stopId;
    session.fail("control.step", { target: "sh4" }, -32005);
    session.ok("state.setRegister", { path: "dc.sh4.cpu", name: "PC", value: "0x10000000" });
    session.fail("control.step", { target: "sh4" }, -32005);
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
    session.fail("state.setRegister", { path: "dc.sh4.cpu", name: "r0", value: "1" }, -32602);
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
      "45 BC 32 04 1F 4A 11 66 89 E9 C0 58 4D 3C 9B 6B",
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
    expect(lines("dsp", 0, 1)[0].disassembly).toMatch(/^TWT TWA YSEL/);

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
    await vi.advanceTimersByTimeAsync(2);
    // 64 samples at 44.1 kHz later: the answer, and no stop
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
    session.frames.length = 0;

    session.call("state.recordSgcFrames");
    expect(session.lastTick().executionState).toEqual({ state: "running", stopId });
    await vi.advanceTimersByTimeAsync(24);
    expect(session.frames.map((frame) => frame.method ?? "response")).toEqual(["event.tick", "response", "event.tick"]);
    expect(session.lastTick().executionState).toEqual({ state: "paused", stopId: stopId + 1, reason: "capture" });
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
