import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockDebugger } from "../../server/mockDebugger";
import type { DebuggerShape, DebuggerTick } from "../../src/lib/debuggerSchema";
import { BASE_PATHS } from "./design";
import { checkResponseEnvelope, checkTick, indexDescribe } from "./invariants";
import type { DescribeIndex, TickTracking } from "./invariants";

/**
 * The invariants as functions of one tick: real ticks of the mock, which follow them, and
 * the same ticks with one thing wrong. (That the runner applies them to every tick of every
 * connection is what run.test.ts shows.)
 */

type Json = Record<string, unknown>;

let mock: MockDebugger;
let index: DescribeIndex;
let frames: Json[];
let send: (method: string, params?: unknown) => void;

/** The latest tick of the mock, as a copy that a test may change. */
const tick = (): DebuggerTick => structuredClone(frames.filter((frame) => frame.method === "event.tick").at(-1)!.params) as DebuggerTick;
const violationsOf = (candidate: unknown, tracking: TickTracking = {}, now = Date.now()) => checkTick(candidate, index, tracking, now);

beforeEach(() => {
  vi.useFakeTimers({ now: Date.now() });
  mock = new MockDebugger();
  mock.start();
  frames = [];
  let id = 0;
  const client = mock.connect({ sendText: (text) => frames.push(JSON.parse(text) as Json), sendBinary: () => undefined });
  send = (method, params = {}) => client.receive(JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }));
  send("debugger.describe");
  index = indexDescribe(frames[0].result as DebuggerShape);
});

afterEach(() => {
  mock.stop();
  vi.useRealTimers();
});

describe("the ticks of the mock", () => {
  it("follow every invariant: running, paused, at a breakpoint, and after its breakpoint was removed", async () => {
    const tracking: TickTracking = {};
    const checked = () => frames.filter((frame) => frame.method === "event.tick").flatMap((frame) => checkTick(frame.params, index, tracking));
    send("state.watch", { expressions: ["dc.sh4.cpu.pc", "dc.timing.sh4_cycles", "dc.holly.intc.sb_istnrm"] });
    send("breakpoints.add", { event: "dc.holly.core.vblank", enabled: false });
    await vi.advanceTimersByTimeAsync(1100);
    send("breakpoints.add", { event: "dc.sh4.cpu.pc", address: 0x8c000600 });
    await vi.advanceTimersByTimeAsync(32);
    expect(tick().executionState).toMatchObject({ state: "paused", reason: "breakpoint", breakpointId: 2 });
    send("breakpoints.remove", { id: 2 });
    expect(tick().executionState).toEqual({ state: "paused", stopId: 1, reason: "breakpoint" });
    send("control.runUntil");
    await vi.advanceTimersByTimeAsync(400);
    expect(checked()).toEqual([]);
  });
});

describe("I2 and I3: the clock", () => {
  it("the timestamp of a tick is wall-clock ms, within a day of the runner's clock", () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    expect(violationsOf({ ...tick(), timestamp: now - day + 1000 }, {}, now)).toEqual([]);
    expect(violationsOf({ ...tick(), timestamp: now + day - 1000 }, {}, now)).toEqual([]);
    expect(violationsOf({ ...tick(), timestamp: Math.floor(now / 1000) }, {}, now)).toEqual([
      expect.stringMatching(/^I2: timestamp \d{10} is not the wall clock in ms; the clock of this machine reads \d{13}$/),
    ]);
    // ms since the server started
    expect(violationsOf({ ...tick(), timestamp: 5000 }, {}, now)).toEqual([expect.stringMatching(/^I2: timestamp 5000 is not the wall clock in ms/)]);
  });

  it("the timestamp of every event-log entry is wall-clock ms too", async () => {
    await vi.advanceTimersByTimeAsync(1000);
    send("state.unwatch", { watchIds: [] });
    const logged = tick();
    expect(logged.eventLog.length).toBeGreaterThan(1);
    expect(violationsOf(logged)).toEqual([]);
    const seconds = { ...logged, eventLog: logged.eventLog.map((entry) => ({ ...entry, timestamp: Math.floor(entry.timestamp / 1000) })) };
    expect(violationsOf(seconds)).toEqual([
      expect.stringMatching(/^I3: the timestamp \d{10} of the event-log entry \d+ is not the wall clock in ms; the clock of this machine reads \d{13}$/),
    ]);
    // ms since the server started, in one entry among right ones: said once, for the first one that is off
    const uptime = { ...logged, eventLog: logged.eventLog.map((entry, position) => (position === 1 ? { ...entry, timestamp: 1016 } : entry)) };
    expect(violationsOf(uptime)).toEqual([expect.stringMatching(new RegExp(`^I3: the timestamp 1016 of the event-log entry ${logged.eventLog[1].eventId} is not the wall clock in ms`))]);
  });
});

describe("2.6: the events of the log are events the tree lists", () => {
  it("an entry of an event that no node lists", async () => {
    await vi.advanceTimersByTimeAsync(1000);
    send("state.unwatch", { watchIds: [] });
    const logged = tick();
    const first = logged.eventLog[0];
    expect((first.metadata as { event: string }).event).toBe("dc.aica.channels.key_on");
    // a tree that lists the vertical blank and nothing else: said once, for the first such entry
    const fewer: DescribeIndex = { ...index, events: new Set(["dc.holly.core.vblank"]) };
    expect(checkTick(logged, fewer, {})).toEqual([
      `2.6: the event log has an entry of dc.aica.channels.key_on (eventId ${first.eventId}), which no node of the device tree lists; a server lists the events it can raise`,
    ]);
    expect(checkTick(logged, index, {})).toEqual([]);
  });
});

describe("I5: what a tick carries", () => {
  it("a running tick has the four base paths; dc.sh4.cpu is absent exactly when the tick says registersStale", async () => {
    await vi.advanceTimersByTimeAsync(200);
    const running = tick();
    expect(Object.keys(running.registers).sort()).toEqual([...BASE_PATHS].sort());
    expect(violationsOf(running)).toEqual([]);
    for (const path of BASE_PATHS) {
      const { [path]: _dropped, ...registers } = running.registers;
      expect(violationsOf({ ...running, registers }), path).toEqual([
        path === "dc.sh4.cpu" ? "I5: a running tick carries dc.sh4.cpu (or says registersStale)" : `I5: a running tick carries ${path}`,
      ]);
    }
    const { "dc.sh4.cpu": _cpu, ...withoutCpu } = running.registers;
    const stale = { ...running, registers: withoutCpu, executionState: { ...running.executionState, registersStale: true } };
    expect(violationsOf(stale)).toEqual([]);
    expect(violationsOf({ ...stale, registers: running.registers })).toEqual(["I5: registersStale is set although the tick carries dc.sh4.cpu"]);
  });

  it("a paused tick is full and never says registersStale; with no game loaded it carries registers {}", () => {
    send("control.pause");
    const paused = tick();
    expect(violationsOf(paused)).toEqual([]);
    const { "dc.holly.intc": _intc, ...registers } = paused.registers;
    expect(violationsOf({ ...paused, registers })).toEqual(["I5: a paused tick is full, this one lacks dc.holly.intc"]);
    expect(violationsOf({ ...paused, executionState: { ...paused.executionState, registersStale: true } })).toEqual([
      "I5: registersStale in a paused tick; a paused tick is full, and the SH4 context is complete at a stop",
    ]);

    mock.setLifetime("no-machine");
    const noGame = tick();
    expect(noGame.executionState.reason).toBe("no-game");
    expect(noGame.registers).toEqual({});
    expect(violationsOf(noGame)).toEqual([]);
    expect(violationsOf({ ...noGame, registers: { "dc.timing": paused.registers["dc.timing"] } })).toEqual(['I5: a tick with reason "no-game" carries registers {}, this one carries dc.timing']);
  });

  it("a running tick carries no callstack frames, and stopId never goes back", () => {
    send("control.pause");
    const paused = tick();
    send("control.runUntil");
    const running = tick();
    expect(violationsOf({ ...running, callstacks: paused.callstacks })).toEqual(["I5: a running tick carries callstack frames"]);
    const tracking: TickTracking = {};
    expect(violationsOf(running, tracking)).toEqual([]);
    expect(violationsOf({ ...running, tickId: running.tickId + 1, executionState: { ...running.executionState, stopId: 0 } }, tracking)).toEqual(["I5: stopId 0 follows stopId 1"]);
  });
});

describe("I6: watches", () => {
  it("are in id order and read what their register reads in the same tick; n/a under registersStale", () => {
    send("state.watch", { expressions: ["dc.sh4.cpu.pc", "dc.aica.dsp.step"] });
    const watched = tick();
    expect(violationsOf(watched)).toEqual([]);
    expect(violationsOf({ ...watched, watches: watched.watches!.slice().reverse() })).toEqual(["I6: watches are not in id order: 2, 1"]);
    const other = { ...watched, watches: watched.watches!.map((watch) => (watch.id === 2 ? { ...watch, value: "0x7F" } : watch)) };
    expect(violationsOf(other)).toEqual([expect.stringMatching(/^I6: watch 2 \(dc\.aica\.dsp\.step\) reads "0x7F", the register in the same tick reads "0x[0-9A-F]{2}"$/)]);
    const { "dc.sh4.cpu": _cpu, ...registers } = watched.registers;
    const stale = { ...watched, registers, executionState: { ...watched.executionState, registersStale: true } };
    expect(violationsOf(stale)).toEqual([expect.stringMatching(/^I6: watch 1 \(dc\.sh4\.cpu\.pc\) reads "0x8C0000A[0-9A-E]" in a tick that says registersStale, expected "n\/a"$/)]);
  });
});

describe("I7: breakpointId", () => {
  it("comes with reason breakpoint or event, and is a key of breakpoints in the same tick, in every tick that carries one", async () => {
    send("breakpoints.add", { event: "dc.sh4.cpu.pc", address: 0x8c0000a4 });
    await vi.advanceTimersByTimeAsync(8 * 16);
    const hit = tick();
    expect(hit.executionState).toMatchObject({ state: "paused", reason: "breakpoint", breakpointId: 1 });
    const tracking: TickTracking = {};
    expect(violationsOf(hit, tracking)).toEqual([]);
    // a later tick of the same stop, after the breakpoint was removed, that still carries the id
    const later = { ...hit, tickId: hit.tickId + 1, breakpoints: {} };
    expect(violationsOf(later, tracking)).toEqual([
      "I7: breakpointId 1 is not a key of breakpoints in the same tick (stop 1); a tick stops carrying the id of a breakpoint that was removed",
    ]);
    // ... and the one a server sends then: the reason stays, the id is gone
    const { breakpointId: _id, ...withoutId } = hit.executionState;
    expect(violationsOf({ ...later, tickId: hit.tickId + 2, executionState: withoutId }, tracking)).toEqual([]);
    expect(violationsOf({ ...hit, executionState: { ...hit.executionState, reason: "pause" } })).toEqual(['I7: breakpointId with reason "pause"']);
  });
});

describe("I8: ids are never reused", () => {
  it("a breakpoint id, or a watch id, that a tick listed and a later tick did not does not come back", () => {
    send("breakpoints.add", { event: "dc.sh4.cpu.pc", address: 0x8c010000, enabled: false });
    send("state.watch", { expressions: ["dc.sh4.cpu.pc"] });
    const listed = tick();
    send("breakpoints.remove", { id: 1 });
    send("state.unwatch", { watchIds: [1] });
    const removed = tick();
    send("breakpoints.add", { event: "dc.sh4.cpu.pc", address: 0x8c010002, enabled: false });
    send("state.watch", { expressions: ["dc.sh4.cpu.pr"] });
    const added = tick();
    // the mock gives the new ones the next ids
    expect([Object.keys(added.breakpoints), added.watches!.map((watch) => watch.id)]).toEqual([["2"], [2]]);
    const tracking: TickTracking = {};
    expect([listed, removed, added].flatMap((entry) => violationsOf(entry, tracking))).toEqual([]);

    // a server that gives them the lowest free id
    const reused = {
      ...added,
      breakpoints: { "1": { ...added.breakpoints["2"], id: 1 } },
      watches: added.watches!.map((watch) => ({ ...watch, id: 1 })),
    };
    const again: TickTracking = {};
    expect([listed, removed, reused].flatMap((entry) => violationsOf(entry, again))).toEqual([
      "I8: breakpoint id 1 is listed again after a tick that did not list it; ids are never reused",
      "I8: watch id 1 is listed again after a tick that did not list it; ids are never reused",
    ]);
    // said when it happens, not in every tick after it
    expect(violationsOf({ ...reused, tickId: reused.tickId + 1 }, again)).toEqual([]);
  });
});

describe("the envelope of a response", () => {
  it("an error has a code and a message that is not empty, and nothing else", () => {
    expect(checkResponseEnvelope({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "no such method" } })).toEqual([]);
    expect(checkResponseEnvelope({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "?" } })).toEqual([]);
    expect(checkResponseEnvelope({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "" } })).toEqual([
      "3.5: the error -32601 has an empty message; error.message is a non-empty string",
    ]);
    expect(checkResponseEnvelope({ jsonrpc: "2.0", id: null, error: { code: -32601, message: "no such method" } })).toEqual(["3.0: id null in a response with code -32601"]);
    expect(checkResponseEnvelope({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "no such method", data: {} } })).toEqual([
      "3.5: an error object has code and message only, this one has code,data,message",
    ]);
  });
});
