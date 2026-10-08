import { request as httpRequest } from "node:http";
import WebSocket from "ws";
import { BINARY_FRAME_HEADER_BYTES, BinaryFrameKind, SGC_BYTES_PER_FRAME, parseBinaryFrame } from "../../src/lib/binaryFrame";
import { CAPABILITIES, DEBUGGER_ERROR_MESSAGES, PROTOCOL_BOUNDS, PanelIdSchema, TABLE_IDS } from "../../src/lib/debuggerSchema";
import type {
  BreakpointCategoryState,
  BreakpointDescriptor,
  DebuggerShape,
  DebuggerTarget,
  DebuggerTick,
  DeviceNodeDescriptor,
  DisassemblyLine,
  TargetProcessor,
} from "../../src/lib/debuggerSchema";
import { MOCK_SH4_RING, mockNextAddress } from "../../server/mockDebugger";
import { M1_DEVICE_TREE, TARGET_TABLE } from "./design";
import { isArmControlFlow, isSh4ControlFlow, isSh4DelayedBranch } from "./disasm";
import { indexDescribe, registerValuePattern } from "./invariants";
import { ContractFailure, ContractSession, check, describeState, fail } from "./session";
import type { BinaryRecord, TickRecord } from "./session";
import type { ElfSymbols } from "./elfSymbols";

export type Profile = "mock" | "emulator";

/**
 * - passed: every assertion of the scenario held;
 * - failed: one did not, or an invariant was violated while it ran;
 * - not-applicable: the server does not advertise what the scenario needs (or the scenario
 *   belongs to the other profile). Never a pass;
 * - partial: the server advertises only some of the capabilities of the scenario; the parts
 *   it advertises passed. Never a pass of the scenario as a whole.
 */
export type ScenarioStatus = "passed" | "failed" | "not-applicable" | "partial";

export interface PartResult {
  name: string;
  status: "passed" | "failed" | "not-applicable";
  detail?: string;
}

export interface ScenarioResult {
  id: string;
  title: string;
  status: ScenarioStatus;
  durationMs: number;
  /** why it failed or does not apply, and notes */
  details: string[];
  parts?: PartResult[];
}

export interface RunContext {
  profile: Profile;
  url: string;
  /** the current connection; S14 replaces it */
  session: ContractSession;
  openSession: () => Promise<ContractSession>;
  elf?: ElfSymbols;
  /**
   * Every breakpoint id and watch id that any tick of the run listed, on any connection: an
   * id that is in here has been used, and the server gives it to nothing new.
   */
  seen: { breakpoints: Set<number>; watches: Set<number> };
  note: (text: string) => void;
}

/** The milestones of the design: each adds scenarios to the gate of the one before it. */
export const MILESTONES = ["M1", "M2", "M3", "M4"] as const;
export type Milestone = (typeof MILESTONES)[number];

type Outcome = void | { notApplicable: string } | { parts: PartResult[] };
type Scenario = {
  id: string;
  title: string;
  /** the first milestone whose server has to pass it; M1 when absent */
  milestone?: Milestone;
  /** it applies to the emulator profile only */
  emulatorOnly?: boolean;
  run: (context: RunContext) => Promise<Outcome>;
};

const hex = (value: number) => `0x${value.toString(16).toUpperCase().padStart(8, "0")}`;
/** SH4 code addresses are compared under this mask: the same code is reachable at 0x0C.., 0x8C.. and 0xAC.. (design 2.3.3) */
const SH4_CODE_ADDRESS_MASK = 0x1fffffff;
/** The event of the vertical blank: raised by every program that runs, about sixty times a second (design 2.6). */
const VBLANK_EVENT = "dc.holly.core.vblank";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------

const targetOf = (shape: DebuggerShape, id: TargetProcessor): DebuggerTarget | undefined =>
  shape.targets?.find((target) => target.id === id);

const requireTarget = (context: RunContext, id: TargetProcessor): DebuggerTarget =>
  targetOf(context.session.shape, id) ?? fail(`debugger.describe lists no target "${id}"`);

const hasCapability = (context: RunContext, capability: string): boolean =>
  context.session.shape.capabilities?.includes(capability) ?? false;

const registerOf = (tick: DebuggerTick, path: string, name: string): string | undefined =>
  tick.registers[path]?.find((register) => register.name === name)?.value;

const numberOf = (tick: DebuggerTick, path: string, name: string): number => {
  const value = registerOf(tick, path, name);
  if (value === undefined || !/^0x[0-9A-F]+$/.test(value)) {
    return fail(`the tick has no numeric ${path}.${name} (got ${JSON.stringify(value)})`);
  }
  return Number.parseInt(value, 16);
};

const pcOf = (tick: DebuggerTick, target: DebuggerTarget): number => numberOf(tick, target.pcPath, target.pcRegister);

/** `dc.timing.SH4_CYCLES`, the scheduler time of the SH4, if the tree has it. */
const cyclesOf = (tick: DebuggerTick): bigint | undefined => {
  const value = registerOf(tick, "dc.timing", "SH4_CYCLES");
  return value !== undefined && /^0x[0-9A-F]+$/.test(value) ? BigInt(value) : undefined;
};

const isPaused = (tick: DebuggerTick) => tick.executionState.state === "paused";
const isRunning = (tick: DebuggerTick) => tick.executionState.state === "running";
const stopIdOf = (tick: DebuggerTick) => tick.executionState.stopId ?? fail("the tick has no stopId");

/**
 * The described paths a tick does not carry; none for a full tick. As in I5, a running tick
 * that says `registersStale` is full without `dc.sh4.cpu`.
 */
const missingPaths = (session: ContractSession, tick: DebuggerTick): string[] =>
  Array.from(session.index!.registers.keys()).filter(
    (path) => !(path in tick.registers) && !(path === "dc.sh4.cpu" && isRunning(tick) && tick.executionState.registersStale === true),
  );

const ensurePaused = async (context: RunContext): Promise<TickRecord> => {
  const { session } = context;
  if (isPaused(session.latestTick().tick)) {
    return session.latestTick();
  }
  const mark = session.mark();
  await session.call("control.pause", {});
  return session.waitForTick(isPaused, 2000, "a paused tick after control.pause", mark);
};

const ensureRunning = async (context: RunContext): Promise<TickRecord> => {
  const { session } = context;
  if (isRunning(session.latestTick().tick)) {
    return session.latestTick();
  }
  const mark = session.mark();
  await session.call("control.runUntil", {});
  return session.waitForTick(isRunning, 1000, "a running tick after control.runUntil", mark);
};

const disassemble = async (context: RunContext, target: TargetProcessor, address: number, count: number): Promise<DisassemblyLine[]> =>
  (await context.session.call("state.getDisassembly", { target, address, count })).lines;

/**
 * One step of a target: `{}`, then one paused tick with a new stopId and reason "step", and no
 * running tick in between. `method` is control.step, or control.stepOver on a line that is not
 * a call, which is a step.
 */
const stepOnce = async (
  context: RunContext,
  target: TargetProcessor,
  method: "control.step" | "control.stepOver" = "control.step",
): Promise<TickRecord> => {
  const { session } = context;
  const before = session.latestTick().tick;
  check(isPaused(before), "a step needs a paused target");
  const mark = session.mark();
  await session.call(method, { target });
  const stopped = await session.waitForTick(
    (tick) => isPaused(tick) && stopIdOf(tick) > stopIdOf(before),
    2000,
    `a paused tick with a new stopId after ${method} {${target}}`,
    mark,
  );
  const between = session.ticksSince(mark).filter((record) => record.seq <= stopped.seq);
  check(!between.some((record) => isRunning(record.tick)), `${method} {${target}}: a running tick arrived before the paused tick of the step`);
  check(stopped.tick.executionState.reason === "step", `${method} {${target}}: the stop has reason "${stopped.tick.executionState.reason}", expected "step"`);
  check(stopped.tick.executionState.breakpointId === undefined, `${method} {${target}}: a step stop carries no breakpointId`);
  return stopped;
};

const controlFlowOf = (target: TargetProcessor) => (target === "arm7" ? isArmControlFlow : isSh4ControlFlow);

/**
 * Leaves the target paused at a PC such that the lines at PC and PC + size are both not
 * control flow (at most 64 steps), and returns that PC: a breakpoint at PC + size is then the
 * next thing the target reaches.
 */
const findBreakpointSite = async (context: RunContext, targetId: TargetProcessor = "sh4"): Promise<number> => {
  const target = requireTarget(context, targetId);
  const controlFlow = controlFlowOf(targetId);
  let record = await ensurePaused(context);
  for (let steps = 0; steps <= 64; steps++) {
    const pc = pcOf(record.tick, target);
    if (targetId === "dsp") {
      // DSP steps have no control flow; the last step is followed by step 0
      if (pc < target.addressMax) {
        return pc;
      }
    } else {
      const lines = await disassemble(context, targetId, pc, 2);
      if (lines.length === 2 && !controlFlow(lines[0].disassembly) && !controlFlow(lines[1].disassembly)) {
        return pc;
      }
    }
    record = await stepOnce(context, targetId);
  }
  return fail(`no ${targetId} PC whose line and next line are not control flow within 64 steps`);
};

/**
 * The tick that shows the effect of a request: the first one at or after `since` (a `mark()`
 * taken before the request) in which `problem` finds nothing, within `timeoutMs`. It need
 * not be the first tick after the request: a periodic tick, or one more tick of a stop, can
 * have been built before the server handled the request and arrive after it. When no tick
 * shows the effect in time, the scenario fails with what the last tick lacked.
 */
const tickShowing = async (
  session: ContractSession,
  since: number,
  what: string,
  problem: (tick: DebuggerTick) => string | undefined,
  timeoutMs = 1000,
): Promise<TickRecord> => {
  try {
    return await session.waitForTick((tick) => problem(tick) === undefined, timeoutMs, what, since);
  } catch (error) {
    if (!(error instanceof ContractFailure)) {
      throw error;
    }
    const seen = session.ticksSince(since);
    const last = seen.at(-1);
    return fail(
      last
        ? `${what}: ${problem(last.tick)} (${seen.length} tick${seen.length === 1 ? "" : "s"} within ${session.scale(timeoutMs)} ms of the request, the last one is ${describeState(last.tick)})`
        : `${what}: no tick within ${session.scale(timeoutMs)} ms of the request`,
    );
  }
};

/**
 * Adds a breakpoint and returns its descriptor from the tick that shows it: that tick lists
 * exactly one breakpoint more, under an id that no breakpoint of the run has had.
 */
const addBreakpoint = async (
  context: RunContext,
  params: { event: string; address?: number; kind?: "code" | "event"; enabled?: boolean },
): Promise<BreakpointDescriptor> => {
  const { session } = context;
  const listed = new Set(Object.keys(session.latestTick().tick.breakpoints));
  const used = new Set(context.seen.breakpoints);
  const newIn = (tick: DebuggerTick) => Object.values(tick.breakpoints).filter((breakpoint) => !listed.has(String(breakpoint.id)));
  const mark = session.mark();
  await session.call("breakpoints.add", params);
  const next = await tickShowing(session, mark, "breakpoints.add", (tick) => (newIn(tick).length > 0 ? undefined : "no tick lists a new breakpoint"));
  const added = newIn(next.tick);
  check(added.length === 1, `breakpoints.add: the tick that shows it lists ${added.length} new breakpoints, expected the one that was added`);
  const breakpoint = added[0];
  check(
    !used.has(breakpoint.id),
    `breakpoints.add: the new breakpoint has id ${breakpoint.id}, which an earlier breakpoint of this run had; ids are never reused`,
  );
  check(breakpoint.event === params.event, `breakpoints.add: the tick lists event "${breakpoint.event}"`);
  check(breakpoint.address === params.address, `breakpoints.add: the tick lists address ${String(breakpoint.address)}, the request gave ${String(params.address)}`);
  // kind defaults to "code" when an address is given, else "event"; enabled defaults to true
  check(breakpoint.kind === (params.kind ?? (params.address === undefined ? "event" : "code")), `breakpoints.add: the tick lists kind "${breakpoint.kind}"`);
  check(breakpoint.enabled === (params.enabled ?? true), `breakpoints.add: the tick lists enabled ${breakpoint.enabled}`);
  check(breakpoint.id >= 1, "breakpoint ids are allocated from 1");
  return breakpoint;
};

const removeBreakpoint = async (context: RunContext, id: number): Promise<void> => {
  const { session } = context;
  const mark = session.mark();
  await session.call("breakpoints.remove", { id });
  await tickShowing(session, mark, "breakpoints.remove", (tick) => (String(id) in tick.breakpoints ? `breakpoint ${id} is still listed` : undefined));
};

/**
 * Adds disabled breakpoints on `event` until the server has as many as the protocol allows,
 * requires the next one to be refused, and removes what it added.
 */
const fillBreakpointTable = async (context: RunContext, event: string): Promise<void> => {
  const { session } = context;
  const most = PROTOCOL_BOUNDS.breakpoints;
  const countOf = (tick: DebuggerTick) => Object.keys(tick.breakpoints).length;
  const tickWith = (since: number, what: string, expected: number) =>
    tickShowing(session, since, what, (tick) => (countOf(tick) === expected ? undefined : `the tick lists ${countOf(tick)} breakpoints, expected ${expected}`));
  const found = new Set(Object.keys(session.latestTick().tick.breakpoints));
  const used = new Set(context.seen.breakpoints);
  const room = most - found.size;
  if (room <= 0) {
    context.note(`the limit of ${most} breakpoints was not tried: the server has ${found.size}`);
    return;
  }
  const request = { event, kind: "event", enabled: false } as const;
  let mark = session.mark();
  for (let added = 0; added < room; added++) {
    mark = session.mark();
    await session.call("breakpoints.add", request);
    // every request is followed by a tick that lists every breakpoint: only the latest are kept
    if (added % 64 === 63) {
      session.forget(mark);
    }
  }
  const full = await tickWith(mark, `breakpoints.add, ${room} times`, most);
  const ours = Object.values(full.tick.breakpoints).filter((breakpoint) => !found.has(String(breakpoint.id)));
  const again = ours.find((breakpoint) => used.has(breakpoint.id));
  check(!again, `breakpoints.add: a new breakpoint has id ${again?.id}, which an earlier breakpoint of this run had; ids are never reused`);

  await session.expectError("breakpoints.add", request, -32602);
  const after = (await session.describe()).tick;
  check(countOf(after) === most, `the server has ${countOf(after)} breakpoints after it refused one more than ${most}`);

  for (const [position, breakpoint] of ours.entries()) {
    mark = session.mark();
    await session.call("breakpoints.remove", { id: breakpoint.id });
    if (position % 64 === 63) {
      session.forget(mark);
    }
  }
  await tickWith(mark, `breakpoints.remove, ${ours.length} times`, found.size);
};

const toggleBreakpoint = async (context: RunContext, id: number, enabled: boolean): Promise<void> => {
  const { session } = context;
  const mark = session.mark();
  await session.call("breakpoints.toggle", { id, enabled });
  await tickShowing(session, mark, "breakpoints.toggle", (tick) =>
    tick.breakpoints[String(id)]?.enabled === enabled ? undefined : `breakpoint ${id} is not listed as ${enabled ? "enabled" : "disabled"}`,
  );
};

/** A paused tick that reports the stop of a code breakpoint: its id, the reason, and the PC in front of its instruction. */
const checkBreakpointStop = (tick: DebuggerTick, target: DebuggerTarget, id: number, address: number): void => {
  check(tick.executionState.breakpointId === id, `the stop reports breakpointId ${tick.executionState.breakpointId}, expected ${id}`);
  check(tick.executionState.reason === "breakpoint", `the stop has reason "${tick.executionState.reason}", expected "breakpoint"`);
  check(pcOf(tick, target) === address, `the stop is at ${hex(pcOf(tick, target))}, the breakpoint at ${hex(address)}`);
};

/**
 * Resumes a target that is paused in front of a breakpoint on its next instruction: within
 * 2 s a paused tick with a new stopId that reports that breakpoint, at its address.
 */
const resumeToBreakpoint = async (context: RunContext, target: DebuggerTarget, id: number, address: number): Promise<TickRecord> => {
  const { session } = context;
  const before = session.latestTick().tick;
  const mark = session.mark();
  await session.call("control.runUntil", {});
  const hit = await session.waitForTick(
    (tick) => isPaused(tick) && stopIdOf(tick) > stopIdOf(before),
    2000,
    `a paused tick at the breakpoint ${hex(address)}`,
    mark,
  );
  checkBreakpointStop(hit.tick, target, id, address);
  return hit;
};

const categoriesOf = (tick: DebuggerTick): Record<string, BreakpointCategoryState> =>
  JSON.parse(JSON.stringify(tick.categories ?? fail("the tick has no categories"))) as Record<string, BreakpointCategoryState>;

const setCategories = async (context: RunContext, categories: Record<string, BreakpointCategoryState>): Promise<TickRecord> => {
  const { session } = context;
  const problem = (tick: DebuggerTick): string | undefined => {
    for (const [key, state] of Object.entries(categories)) {
      const echoed = tick.categories?.[key];
      if (echoed?.muted !== state.muted || echoed?.soloed !== state.soloed) {
        return `the tick echoes ${key} as ${JSON.stringify(echoed)}, expected ${JSON.stringify(state)}`;
      }
    }
    return undefined;
  };
  // (whether a tick follows a request that changes nothing is the server's choice)
  const changes = problem(session.latestTick().tick) !== undefined;
  const mark = session.mark();
  await session.call("breakpoints.setCategoryStates", { categories });
  return changes ? tickShowing(session, mark, "breakpoints.setCategoryStates", problem) : session.latestTick();
};

/** A register of `path` that no watch names yet, preferring the given names; as the expression `<path>.<name lower case>`. */
const unwatchedRegister = (context: RunContext, path: string, preferred: string[]): { name: string; expression: string } => {
  const { session } = context;
  const watched = new Set((session.latestTick().tick.watches ?? []).map((watch) => watch.expression));
  const names = session.index?.registers.get(path)?.map((register) => register.name) ?? fail(`describe lists no registers for ${path}`);
  const order = [...preferred.filter((name) => names.includes(name)), ...names.filter((name) => !preferred.includes(name))];
  for (const name of order) {
    const expression = `${path}.${name.toLowerCase()}`;
    if (!watched.has(expression)) {
      return { name, expression };
    }
  }
  return fail(`every register of ${path} is watched already`);
};

/** `<path>.<name in lower case>` for every register of the device tree that no watch names. */
const unwatchedExpressions = (context: RunContext): string[] => {
  const { session } = context;
  const watched = new Set((session.latestTick().tick.watches ?? []).map((watch) => watch.expression));
  return Array.from(session.index?.registers ?? [])
    .flatMap(([path, registers]) => registers.map((register) => `${path}.${register.name.toLowerCase()}`))
    .filter((expression) => !watched.has(expression));
};

const addWatch = async (context: RunContext, expression: string, expected: string): Promise<{ id: number; record: TickRecord }> => {
  const { session } = context;
  const listed = new Set((session.latestTick().tick.watches ?? []).map((watch) => watch.id));
  const used = new Set(context.seen.watches);
  const newIn = (tick: DebuggerTick) => (tick.watches ?? []).filter((watch) => !listed.has(watch.id));
  const mark = session.mark();
  await session.call("state.watch", { expressions: [expression] });
  const next = await tickShowing(session, mark, "state.watch", (tick) => (newIn(tick).length > 0 ? undefined : "no tick lists a new watch"));
  const added = newIn(next.tick);
  check(added.length === 1, `state.watch: the tick that shows it lists ${added.length} new watches, expected the one that was added`);
  check(!used.has(added[0].id), `state.watch: the new watch has id ${added[0].id}, which an earlier watch of this run had; ids are never reused`);
  // the stored expression is normalised to lower case
  check(added[0].expression === expected, `state.watch "${expression}": listed as "${added[0].expression}", expected "${expected}"`);
  check(added[0].id >= 1, "watch ids are allocated from 1");
  return { id: added[0].id, record: next };
};

const unwatch = async (context: RunContext, id: number): Promise<void> => {
  const { session } = context;
  const mark = session.mark();
  await session.call("state.unwatch", { watchIds: [id] });
  await tickShowing(session, mark, "state.unwatch", (tick) => ((tick.watches ?? []).some((watch) => watch.id === id) ? `watch ${id} is still listed` : undefined));
};

/** Resumes, expects only running ticks for 600 ms, then pauses again. */
const expectToKeepRunning = async (context: RunContext, why: string): Promise<void> => {
  const { session } = context;
  const before = stopIdOf(session.latestTick().tick);
  const mark = session.mark();
  await session.call("control.runUntil", {});
  const resumed = await session.waitForTick(isRunning, 1000, "a running tick after control.runUntil", mark);
  await session.collectTicks(600);
  const window = session.ticksSince(mark);
  // (one more tick of the stop that was left can still arrive before the running tick: that is not a stop)
  const stopped = window.find((record) => isPaused(record.tick) && (record.seq > resumed.seq || stopIdOf(record.tick) > before));
  check(!stopped, `${why}: the target stopped (${stopped ? describeState(stopped.tick) : ""})`);
  check(window.length >= 2, `${why}: only ${window.length} tick(s) in 600 ms of running; the running tick is periodic`);
  await ensurePaused(context);
};

// ---------------------------------------------------------------------------------------
// Scenarios (design 5.5)
// ---------------------------------------------------------------------------------------

const s00: Scenario = {
  id: "S00",
  title: "anchor",
  emulatorOnly: true,
  async run(context) {
    if (context.profile !== "emulator") {
      return { notApplicable: "emulator profile only: the mock has no program to anchor in" };
    }
    const { session } = context;
    const sh4 = requireTarget(context, "sh4");
    const start = session.latestTick().tick;
    check(
      isPaused(start) && start.executionState.reason === "start",
      `the emulator has to be at the StartPaused stop (Debugger:StartPaused=yes, one emulator per run); it is ${describeState(start)}`,
    );
    const entry = context.elf?.entry ?? 0x8c010000;
    const breakpoint = await addBreakpoint(context, { event: sh4.breakpointEvent, address: entry });
    const mark = session.mark();
    await session.call("control.runUntil", {});
    const hit = await session.waitForTick(
      (tick) => isPaused(tick) && stopIdOf(tick) > stopIdOf(start),
      10_000,
      `a paused tick at the ELF entry ${hex(entry)}`,
      mark,
    );
    check(hit.tick.executionState.breakpointId === breakpoint.id, `the stop reports breakpointId ${hit.tick.executionState.breakpointId}, expected ${breakpoint.id}`);
    check(hit.tick.executionState.reason === "breakpoint", `the stop has reason "${hit.tick.executionState.reason}"`);
    check(pcOf(hit.tick, sh4) === entry, `PC is ${hex(pcOf(hit.tick, sh4))}, expected the entry ${hex(entry)}`);

    const engine = registerOf(hit.tick, "dc.timing", "SH4_DEBUG_ENGINE");
    const notice = hit.tick.executionState.notice;
    if (engine === "native") {
      check(notice === undefined, `SH4_DEBUG_ENGINE is native, and the tick carries the notice "${notice}"`);
    } else if (engine === "interpreter-fallback") {
      check(notice !== undefined, "SH4_DEBUG_ENGINE is interpreter-fallback, and the tick of the breakpoint stop has no notice");
    } else {
      fail(`dc.timing.SH4_DEBUG_ENGINE is ${JSON.stringify(engine)}, expected "native" or "interpreter-fallback"`);
    }
    // The capability says the same as the register, once an SH4 backend is selected. At the
    // StartPaused stop, before the first Run(), it need not be: the SH4 has run by now, so
    // debugger.describe is asked here, and that answer is what the later scenarios read.
    await session.describe();
    const [capability, other] =
      engine === "native" ? [CAPABILITIES.SH4_DEBUG_NATIVE, CAPABILITIES.SH4_DEBUG_FALLBACK] : [CAPABILITIES.SH4_DEBUG_FALLBACK, CAPABILITIES.SH4_DEBUG_NATIVE];
    check(hasCapability(context, capability), `SH4_DEBUG_ENGINE is ${engine}, and debugger.describe at this stop does not list the capability "${capability}"`);
    check(!hasCapability(context, other), `SH4_DEBUG_ENGINE is ${engine}, and debugger.describe at this stop lists the capability "${other}"`);
    context.note(`SH4 debug engine: ${engine}`);
    await removeBreakpoint(context, breakpoint.id);
  },
};

const s01: Scenario = {
  id: "S01",
  title: "describe",
  async run(context) {
    const { session } = context;
    // S01 reports everything it finds about the describe result, not the first thing
    const findings: string[] = [];
    const expectThat = (condition: unknown, message: string): void => {
      if (!condition) {
        findings.push(message);
      }
    };

    // The result is valid: the session validates it with the strict schema and keeps every
    // issue; `protocol` is 3; and the first notification after the response is a full tick
    // (response first, tick second).
    let reported = "";
    const describeWith = async (params?: { protocol?: number; client?: string }): Promise<void> => {
      const asked = params ? `debugger.describe ${JSON.stringify(params)}: ` : "";
      const response = await session.requestDescribe(params);
      const issues = session.describeProblems;
      // (what is wrong with every answer is said once)
      if (issues.length > 0 && issues.join("\n") !== reported) {
        reported = issues.join("\n");
        findings.push(
          `${asked}the debugger.describe result does not follow the schema of protocol v3 (${issues.length} issue${issues.length === 1 ? "" : "s"}):`,
          ...issues.map((issue) => `  ${issue}`),
        );
      }
      expectThat(session.shape.protocol === 3, `${asked}protocol is ${session.shape.protocol}, expected 3`);
      expectThat(Array.isArray(session.shape.targets), `${asked}targets is present`);
      try {
        const following = await session.waitForTick(() => true, 2000, `${asked}the tick that follows the debugger.describe response`, response.seq);
        const first = following.tick;
        const missing = missingPaths(session, first);
        expectThat(first.executionState.reason === "no-game" || missing.length === 0, `${asked}the tick after describe is full; it lacks ${missing.slice(0, 5).join(", ")}`);
      } catch (error) {
        if (!(error instanceof ContractFailure)) {
          throw error;
        }
        findings.push(error.message);
      }
    };
    // (A describe without a result the client can read fails here: there is nothing to look at.)
    await describeWith();
    const shape = session.shape;

    // The server answers whatever the client's protocol number is, and without one: an older
    // client, or one that sends no params at all, gets the same result and the same tick.
    for (const params of [{}, { protocol: 2, client: "contract runner, as a client of protocol 2" }]) {
      try {
        await describeWith(params);
      } catch (error) {
        if (!(error instanceof ContractFailure)) {
          throw error;
        }
        findings.push(error.message);
      }
    }
    // (what the rest of the run reads is the answer to the runner's own request)
    session.shape = shape;
    session.index = indexDescribe(shape);

    // unique paths, unique register names per node, actions within PanelId, no empty arrays
    const paths = new Set<string>();
    const panelIds = new Set<string>(PanelIdSchema.options);
    const visit = (nodes: DeviceNodeDescriptor[]) => {
      for (const node of nodes) {
        expectThat(!paths.has(node.path), `the path ${node.path} appears twice in the device tree`);
        paths.add(node.path);
        expectThat(node.path === node.path.toLowerCase(), `the path ${node.path} is not lower case`);
        const names = (node.registers ?? []).map((register) => register.name);
        expectThat(new Set(names).size === names.length, `${node.path} lists a register name twice`);
        for (const name of names) {
          expectThat(name === name.toUpperCase(), `register ${node.path}.${name} is not upper case`);
        }
        // the values of the tree are written as those of a tick (I4)
        for (const register of node.registers ?? []) {
          expectThat(
            register.width === 0 || registerValuePattern(register.width).test(register.value),
            `${node.path}.${register.name} = "${register.value}" in the describe tree is not 0x + ${Math.ceil(register.width / 4)} upper-case hex digits or "n/a"`,
          );
        }
        for (const key of ["registers", "events", "actions", "children"] as const) {
          expectThat(node[key] === undefined || node[key]!.length > 0, `${node.path}: an empty "${key}" array is omitted, not sent`);
        }
        for (const action of node.actions ?? []) {
          expectThat(panelIds.has(action), `${node.path}: action "${action}" is not a panel id`);
        }
        visit(node.children ?? []);
      }
    };
    visit(shape.deviceTree);

    // every target points into the tree
    const targets = shape.targets ?? [];
    const ids = targets.map((target) => target.id);
    expectThat(new Set(ids).size === ids.length, "a target is listed twice");
    for (const target of targets) {
      const registers = session.index!.registers.get(target.pcPath);
      expectThat(registers?.some((register) => register.name === target.pcRegister), `target ${target.id}: ${target.pcPath}.${target.pcRegister} is not in the device tree`);
    }
    expectThat(ids.includes("sh4"), "the SH4 target is listed");
    // ... and has the values the table of 3.1 gives it
    const written = (value: unknown) => (typeof value === "number" && value > 255 ? hex(value) : JSON.stringify(value));
    for (const target of targets) {
      for (const [key, fixed] of Object.entries(TARGET_TABLE[target.id] ?? {})) {
        const sent = target[key as keyof DebuggerTarget];
        expectThat(sent === fixed, `target ${target.id}: ${key} is ${written(sent)}, the table of 3.1 says ${written(fixed)}`);
      }
    }

    // the nodes the device tree has from milestone M1 on, and the panels they open (2.8)
    const nodes = new Map<string, DeviceNodeDescriptor>();
    const collect = (list: DeviceNodeDescriptor[]) =>
      list.forEach((node) => {
        nodes.set(node.path, node);
        collect(node.children ?? []);
      });
    collect(shape.deviceTree);
    for (const row of M1_DEVICE_TREE) {
      const node = nodes.get(row.path);
      expectThat(node, `the device tree has no node ${row.path}, which the table of 2.8 lists for milestone M1`);
      for (const action of node ? (row.actions ?? []) : []) {
        expectThat(node?.actions?.includes(action), `${row.path}: the action "${action}" of the table of 2.8 is missing`);
      }
    }

    if (findings.length > 0) {
      fail(findings[0], findings.slice(1));
    }
  },
};

const s02: Scenario = {
  id: "S02",
  title: "pause",
  async run(context) {
    const { session } = context;
    const running = await ensureRunning(context);
    const mark = session.mark();
    // The request as the UI sends it: with a target. There is one run state, so the target is
    // ignored. (Without a target the request is sent by every scenario that needs a paused server.)
    await session.call("control.pause", { target: "sh4" });
    const paused = await session.waitForTick(isPaused, 2000, 'a paused tick after control.pause {target: "sh4"}', mark);
    check(paused.tick.executionState.reason === "pause", `the stop has reason "${paused.tick.executionState.reason}", expected "pause"`);
    check(stopIdOf(paused.tick) > stopIdOf(running.tick), `stopId ${stopIdOf(paused.tick)} is not new (it was ${stopIdOf(running.tick)} while running)`);
    check(paused.tick.executionState.breakpointId === undefined, "a pause carries no breakpointId");

    // a second pause returns {} and changes nothing, whatever target it names
    const other = (session.shape.targets ?? []).map((target) => target.id).find((id) => id !== "sh4");
    const second = session.mark();
    await session.call("control.pause", other ? { target: other } : {});
    const later = await session.collectTicks(300);
    for (const record of [...session.ticksSince(second), ...later]) {
      check(
        isPaused(record.tick) && stopIdOf(record.tick) === stopIdOf(paused.tick),
        `a second control.pause changes nothing; a tick says ${describeState(record.tick)}`,
      );
    }
  },
};

const s03: Scenario = {
  id: "S03",
  title: "resume",
  async run(context) {
    const { session } = context;
    const paused = await ensurePaused(context);
    const sh4 = requireTarget(context, "sh4");
    // Two watches for the time the target runs: watches are evaluated in every tick, whatever
    // paths it carries. The invariants compare every watch of every tick with its register;
    // one of these is on the scheduler time, which moves, and one on the SH4, whose context
    // some backends do not have while running (the watch then reads "n/a").
    const keepWatch = async (expression: string): Promise<{ id: number; added: boolean }> => {
      const stored = (session.latestTick().tick.watches ?? []).find((watch) => watch.expression === expression);
      return stored ? { id: stored.id, added: false } : { id: (await addWatch(context, expression, expression)).id, added: true };
    };
    const hasCycles = session.index?.registers.get("dc.timing")?.some((register) => register.name === "SH4_CYCLES") ?? false;
    const cyclesWatch = hasCycles ? await keepWatch("dc.timing.sh4_cycles") : undefined;
    const pcWatch = await keepWatch(`${sh4.pcPath}.${sh4.pcRegister.toLowerCase()}`);

    const mark = session.mark();
    await session.call("control.runUntil", {});
    const running = await session.waitForTick(isRunning, 1000, "a running tick after control.runUntil", mark);
    check(stopIdOf(running.tick) === stopIdOf(paused.tick), "a resume does not change stopId");
    const more = await session.collectTicks(1500);
    const runningTicks = more.filter((record) => isRunning(record.tick));
    check(runningTicks.length >= 2, `${runningTicks.length} running tick(s) in 1.5 s after the first one; the running tick is periodic`);

    const kept = [cyclesWatch, pcWatch].filter((watch) => watch !== undefined);
    for (const watch of kept) {
      const missing = [running, ...runningTicks].find((record) => !(record.tick.watches ?? []).some((entry) => entry.id === watch.id));
      check(!missing, `watch ${watch.id} is not listed in the running tick ${missing?.tick.tickId}; watches are evaluated in every tick`);
    }
    if (cyclesWatch) {
      const readings = [running, ...runningTicks].map((record) => record.tick.watches!.find((entry) => entry.id === cyclesWatch.id)!.value);
      check(
        new Set(readings).size > 1,
        `the watch on dc.timing.sh4_cycles reads ${JSON.stringify(readings[0])} in every running tick; watches are evaluated in every tick`,
      );
    }

    // the machine advances between them
    const useCycles = cyclesOf(running.tick) !== undefined;
    if (!useCycles) {
      check(context.profile === "mock", "dc.timing.SH4_CYCLES is in every running tick");
    }
    const sample = (tick: DebuggerTick): string =>
      useCycles ? String(cyclesOf(tick)) : String(tick.executionState.registersStale ? "stale" : pcOf(tick, sh4));
    const values = [running, ...runningTicks].map((record) => sample(record.tick));
    check(new Set(values).size > 1, `${useCycles ? "dc.timing.SH4_CYCLES" : "the SH4 PC"} is ${values[0]} in every running tick`);

    // Every fifth periodic tick is full (1 s): registers outside the base paths refresh while
    // running. The 1.5 s above hold seven periodic ticks; 0.5 s more is allowed for a late one.
    const isFull = (tick: DebuggerTick) => isRunning(tick) && missingPaths(session, tick).length === 0;
    // (the tick of the resume itself is not a periodic one)
    const full = await session.waitForTick(isFull, 500, "a full running tick", running.seq + 1).catch(() => undefined);
    if (!full) {
      const last = session.ticksSince(running.seq + 1).filter((record) => isRunning(record.tick)).at(-1) ?? running;
      fail(
        `no running tick in the ${session.scale(2000)} ms after the resume carries every described path; every fifth periodic tick is full. ` +
          `The last one lacks ${missingPaths(session, last.tick).slice(0, 5).join(", ")}`,
      );
    }

    // a second resume returns {} and changes nothing
    await session.call("control.runUntil", {});
    check(isRunning(session.latestTick().tick), "a second control.runUntil changes nothing");

    for (const watch of kept) {
      if (watch.added) {
        await unwatch(context, watch.id);
      }
    }
  },
};

const s04: Scenario = {
  id: "S04",
  title: "step",
  async run(context) {
    const sh4 = requireTarget(context, "sh4");
    let record = await ensurePaused(context);

    /** One step from where the target is, with what holds for every step; `atVector`: it ended at an exception vector. */
    const step = async (method: "control.step" | "control.stepOver" = "control.step"): Promise<{ pc0: number; pc1: number; atVector: boolean }> => {
      const pc0 = pcOf(record.tick, sh4);
      const cycles0 = cyclesOf(record.tick);
      record = await stepOnce(context, "sh4", method);
      const pc1 = pcOf(record.tick, sh4);
      const cycles1 = cyclesOf(record.tick);

      const vbr = registerOf(record.tick, sh4.pcPath, "VBR");
      const vectorBase = vbr !== undefined && /^0x[0-9A-F]+$/.test(vbr) ? Number.parseInt(vbr, 16) : undefined;
      const vectors = vectorBase === undefined ? [] : [0x100, 0x400, 0x600].map((offset) => (vectorBase + offset) >>> 0);
      const atVector = vectors.includes(pc1) || pc1 === 0xa0000000;

      if (cycles0 !== undefined && cycles1 !== undefined) {
        check(cycles1 >= cycles0, `dc.timing.SH4_CYCLES went back from ${cycles0} to ${cycles1} in a step`);
        // a deferred interrupt can end the step before an instruction runs
        check(cycles1 > cycles0 || atVector, "dc.timing.SH4_CYCLES did not increase in a step that did not end at an exception vector");
      } else {
        check(context.profile === "mock", "dc.timing.SH4_CYCLES is in every paused tick");
      }
      if (context.profile === "mock") {
        check(pc1 === mockNextAddress("sh4", pc0), `mock: the step from ${hex(pc0)} ended at ${hex(pc1)}, the next address of its loop is ${hex(mockNextAddress("sh4", pc0))}`);
        check(pc0 >= MOCK_SH4_RING.base && pc0 < MOCK_SH4_RING.base + MOCK_SH4_RING.length * 2, "mock: the PC is in the loop");
      }
      return { pc0, pc1, atVector };
    };

    /**
     * Where a step ends is known only for a line that is not control flow and that is not the
     * slot of a delayed branch. The PC of a pause is anywhere, so the target is stepped to such
     * a line first (at most 64 steps, as S05 does). Returns the text of that line.
     */
    const stepToPlainLine = async (): Promise<string> => {
      for (let steps = 0; ; steps++) {
        const pc = pcOf(record.tick, sh4);
        const lines = pc >= 2 ? await disassemble(context, "sh4", pc - 2, 2) : [undefined, ...(await disassemble(context, "sh4", pc, 1))];
        const [previous, line] = lines;
        if (line && !isSh4ControlFlow(line.disassembly) && !(previous && isSh4DelayedBranch(previous.disassembly))) {
          return line.disassembly;
        }
        if (steps === 64) {
          return fail("no sh4 PC whose line is not control flow and does not follow a delayed branch within 64 steps");
        }
        await step();
      }
    };

    // One instruction per step. A step that an interrupt ended at its vector shows nothing about
    // that, so the next plain line is tried, a few times.
    const attempts = 4;
    for (let attempt = 1; ; attempt++) {
      const text = await stepToPlainLine();
      const { pc0, pc1, atVector } = await step();
      if (!atVector) {
        check(
          pc1 === ((pc0 + 2) >>> 0),
          `"${text}" at ${hex(pc0)} is not control flow, and the step ended at ${hex(pc1)}, not at ${hex(pc0 + 2)} or an exception vector`,
        );
        break;
      }
      if (attempt === attempts) {
        context.note(`${attempts} steps from lines that are not control flow ended at an exception vector each: that a step executes one instruction was not seen`);
        break;
      }
    }

    // control.stepOver on a line that is not a call is a step
    const text = await stepToPlainLine();
    const over = await step("control.stepOver");
    check(
      over.pc1 === ((over.pc0 + 2) >>> 0) || over.atVector,
      `control.stepOver: "${text}" at ${hex(over.pc0)} is not a call, and it ended at ${hex(over.pc1)}, not at ${hex(over.pc0 + 2)} or an exception vector`,
    );

    // control.stepOut is a resume until the return. Whether and when the return comes is the
    // program's business: the running tick is asserted, and after 5 s the runner pauses.
    const { session } = context;
    const mark = session.mark();
    await session.call("control.stepOut", { target: "sh4" });
    const resumed = await session.waitForTick(isRunning, 1000, "a running tick after control.stepOut {sh4}", mark);
    const returned = await session
      .waitForTick((tick) => isPaused(tick) && stopIdOf(tick) > stopIdOf(record.tick), 5000, "the stop of control.stepOut {sh4}", resumed.seq)
      .catch(() => undefined);
    if (returned) {
      // (somebody else's breakpoint can stop the target first: it has priority, and the stop then names it)
      const { reason, breakpointId } = returned.tick.executionState;
      check(reason === "step" || breakpointId !== undefined, `control.stepOut {sh4}: the stop has reason "${reason}", expected "step"`);
    }
    await ensurePaused(context);

    // a step while running is refused, in-band
    await ensureRunning(context);
    await session.expectError("control.step", { target: "sh4" }, -32003);
    await ensurePaused(context);
  },
};

const s05: Scenario = {
  id: "S05",
  title: "breakpoint hit",
  async run(context) {
    const sh4 = requireTarget(context, "sh4");
    const pc = await findBreakpointSite(context);
    const address = pc + sh4.instructionSize;
    // the request as the UI sends it: every member given
    const request = { event: sh4.breakpointEvent, address, kind: "code", enabled: true } as const;
    const breakpoint = await addBreakpoint(context, request);
    // Every breakpoints.add creates a breakpoint: the same request again gives a second one
    // with an id of its own, and when both match, the stop reports the lower id.
    const twin = await addBreakpoint(context, request);
    const lowest = Math.min(breakpoint.id, twin.id);
    const hit = await resumeToBreakpoint(context, sh4, lowest, address);

    // the next paused tick of the same stop repeats breakpointId and stopId
    const register = unwatchedRegister(context, sh4.pcPath, ["PR", "SR", "GBR"]);
    const { id: watchId, record } = await addWatch(context, register.expression, register.expression);
    check(isPaused(record.tick), "adding a watch does not resume the target");
    check(stopIdOf(record.tick) === stopIdOf(hit.tick), `a later tick of the same stop has stopId ${stopIdOf(record.tick)}, the stop was ${stopIdOf(hit.tick)}`);
    check(record.tick.executionState.breakpointId === lowest, "a later paused tick of the same stop repeats breakpointId");
    check(record.tick.executionState.reason === "breakpoint", "a later paused tick of the same stop repeats the reason");

    await unwatch(context, watchId);
    await removeBreakpoint(context, breakpoint.id);
    await removeBreakpoint(context, twin.id);
  },
};

const s06: Scenario = {
  id: "S06",
  title: "mute",
  async run(context) {
    const { session } = context;
    const sh4 = requireTarget(context, "sh4");
    await ensurePaused(context);
    const original = categoriesOf(session.latestTick().tick);
    const same = (tick: DebuggerTick, expected: Record<string, BreakpointCategoryState>) =>
      JSON.stringify(sortKeys(tick.categories)) === JSON.stringify(sortKeys(expected));
    try {
      // A request names the keys it changes: the others keep their state. Two requests of one
      // key each, so that the second one finds a key that is not in its default state.
      const flipped = (key: string) => ({ muted: !original[key].muted, soloed: original[key].soloed });
      let expected: Record<string, BreakpointCategoryState> = { ...original, events: flipped("events") };
      const first = await setCategories(context, { events: expected.events });
      check(same(first.tick, expected), `breakpoints.setCategoryStates {events}: the categories are ${JSON.stringify(first.tick.categories)}, expected ${JSON.stringify(expected)}`);
      expected = { ...expected, dsp: flipped("dsp") };
      const second = await setCategories(context, { dsp: expected.dsp });
      check(
        same(second.tick, expected),
        `breakpoints.setCategoryStates {dsp} changed a key it does not name: the categories are ${JSON.stringify(second.tick.categories)}, expected ${JSON.stringify(expected)}`,
      );
      // a key the server does not know is ignored: `{}`, and nothing changes
      const unknown = session.mark();
      await session.call("breakpoints.setCategoryStates", { categories: { "no-such-category": { muted: true, soloed: true } } });
      for (const record of [...session.ticksSince(unknown), ...(await session.collectTicks(200))]) {
        check(same(record.tick, expected), `breakpoints.setCategoryStates with an unknown key: the categories are ${JSON.stringify(record.tick.categories)}, expected ${JSON.stringify(expected)}`);
      }
      await setCategories(context, original);

      for (const [key, state, why] of [
        ["sh4", { muted: true, soloed: false }, "sh4 is muted"],
        ["arm7", { muted: false, soloed: true }, "arm7 is soloed, so sh4 breakpoints are inactive"],
      ] as const) {
        const pc = await findBreakpointSite(context);
        const breakpoint = await addBreakpoint(context, { event: sh4.breakpointEvent, address: pc + sh4.instructionSize });
        await setCategories(context, { ...original, sh4: { muted: false, soloed: false }, arm7: { muted: false, soloed: false }, [key]: state });
        await expectToKeepRunning(context, `a breakpoint on the next instruction while ${why}`);
        await setCategories(context, original);
        await removeBreakpoint(context, breakpoint.id);
      }

      // a soloed category keeps its own breakpoints active: with sh4 soloed the breakpoint is hit
      const address = (await findBreakpointSite(context)) + sh4.instructionSize;
      const breakpoint = await addBreakpoint(context, { event: sh4.breakpointEvent, address });
      await setCategories(context, { ...original, sh4: { muted: false, soloed: true } });
      await resumeToBreakpoint(context, sh4, breakpoint.id, address);
      await setCategories(context, original);
      await removeBreakpoint(context, breakpoint.id);
    } finally {
      await session.call("breakpoints.setCategoryStates", { categories: original }).catch(() => undefined);
    }
  },
};

const s07: Scenario = {
  id: "S07",
  title: "toggle and remove",
  async run(context) {
    const { session } = context;
    const sh4 = requireTarget(context, "sh4");
    const pc = await findBreakpointSite(context);
    const address = pc + sh4.instructionSize;
    // (without kind and enabled: a breakpoint with an address is a code breakpoint, and enabled)
    const breakpoint = await addBreakpoint(context, { event: sh4.breakpointEvent, address });

    await toggleBreakpoint(context, breakpoint.id, false);
    await expectToKeepRunning(context, "a disabled breakpoint on the next instruction");

    // Enabled again, it is listed as enabled, and it is hit when the program comes to it.
    await toggleBreakpoint(context, breakpoint.id, true);
    const armed = session.latestTick().tick;
    const mark = session.mark();
    await session.call("control.runUntil", {});
    const back = await session
      .waitForTick((tick) => isPaused(tick) && stopIdOf(tick) > stopIdOf(armed), 2000, `a paused tick at the breakpoint ${hex(address)}`, mark)
      .catch(() => undefined);
    if (back) {
      const { breakpointId, reason } = back.tick.executionState;
      check(breakpointId === breakpoint.id, `the stop after the breakpoint was enabled again reports breakpointId ${breakpointId}, expected ${breakpoint.id}`);
      check(reason === "breakpoint", `the stop after the breakpoint was enabled again has reason "${reason}", expected "breakpoint"`);
      // (the program can come back to that code through another mirror of it)
      check(
        ((pcOf(back.tick, sh4) ^ address) & SH4_CODE_ADDRESS_MASK) === 0,
        `the stop after the breakpoint was enabled again is at ${hex(pcOf(back.tick, sh4))}, the breakpoint at ${hex(address)}`,
      );
      await removeBreakpoint(context, breakpoint.id);
    } else {
      // The program has run for 600 ms since it was in front of that address, and whether it
      // comes back there is its business. The same is then shown where the arrival is certain,
      // as in S05: with a breakpoint on the next instruction that is disabled and enabled again.
      await ensurePaused(context);
      await removeBreakpoint(context, breakpoint.id);
      const site = (await findBreakpointSite(context)) + sh4.instructionSize;
      const again = await addBreakpoint(context, { event: sh4.breakpointEvent, address: site });
      await toggleBreakpoint(context, again.id, false);
      await toggleBreakpoint(context, again.id, true);
      await resumeToBreakpoint(context, sh4, again.id, site);
      await removeBreakpoint(context, again.id);
      context.note(
        `the program did not come back to ${hex(address)} within ${session.scale(2000)} ms of the breakpoint there being enabled again; ` +
          "a breakpoint on the next instruction that was disabled and enabled again was hit",
      );
    }

    // removing again and toggling an unknown id: in-band -32602
    await session.expectError("breakpoints.remove", { id: breakpoint.id }, -32602);
    await session.expectError("breakpoints.toggle", { id: breakpoint.id, enabled: true }, -32602);

    // Event breakpoints. Every event the device tree lists is in the server's table: a
    // breakpoint on each, added disabled (an enabled one stops the target when its event
    // comes) with the request the UI sends, i.e. with the kind.
    check(hasCapability(context, CAPABILITIES.EVENT_BREAKPOINTS), 'the capability "event-breakpoints" is part of milestone M1');
    const events: string[] = [];
    const visit = (nodes: DeviceNodeDescriptor[]) =>
      nodes.forEach((node) => {
        events.push(...(node.events ?? []));
        visit(node.children ?? []);
      });
    visit(session.shape.deviceTree);
    check(events.length > 0, "the device tree lists no events");
    check(events.includes(VBLANK_EVENT), `the device tree lists the event ${VBLANK_EVENT}, which every running program raises`);
    await ensurePaused(context);
    const disabled: BreakpointDescriptor[] = [];
    for (const event of events.filter((name) => name !== VBLANK_EVENT)) {
      disabled.push(await addBreakpoint(context, { event, kind: "event", enabled: false }));
    }
    // The one on the vertical blank is sent without kind and enabled: without an address the
    // kind is "event", and it is enabled. (Nothing raises an event while the target is paused.)
    const vblank = await addBreakpoint(context, { event: VBLANK_EVENT });
    await toggleBreakpoint(context, vblank.id, false);
    // while they are disabled none of them stops the target ...
    await expectToKeepRunning(context, "a disabled event breakpoint on every event of the device tree");
    // ... and the enabled one stops it when its event is raised
    await toggleBreakpoint(context, vblank.id, true);
    const waiting = session.latestTick().tick;
    const resumed = session.mark();
    await session.call("control.runUntil", {});
    const stop = await session.waitForTick(
      (tick) => isPaused(tick) && stopIdOf(tick) > stopIdOf(waiting),
      2000,
      `a paused tick at the event breakpoint on ${VBLANK_EVENT}`,
      resumed,
    );
    check(stop.tick.executionState.reason === "event", `the stop of the event breakpoint has reason "${stop.tick.executionState.reason}", expected "event"`);
    check(stop.tick.executionState.breakpointId === vblank.id, `the stop reports breakpointId ${stop.tick.executionState.breakpointId}, expected ${vblank.id}`);
    for (const added of [vblank, ...disabled]) {
      await removeBreakpoint(context, added.id);
    }

    // At most 1024 breakpoints. Those that fill the table are event breakpoints, disabled:
    // nothing is armed by them, and nothing is compiled again.
    await fillBreakpointTable(context, events.includes("dc.system.reset") ? "dc.system.reset" : events[0]);
  },
};

const s08: Scenario = {
  id: "S08",
  title: "watches",
  async run(context) {
    const { session } = context;
    const sh4 = requireTarget(context, "sh4");
    await ensurePaused(context);
    const initial = (session.latestTick().tick.watches ?? []).map((watch) => `${watch.id}:${watch.expression}`);

    // the PC, unless the server already watches it: the initial list is not assumed empty
    const first = unwatchedRegister(context, sh4.pcPath, [sh4.pcRegister, "SR"]);
    const { id, record } = await addWatch(context, first.expression, first.expression);
    const listed = record.tick.watches!.find((watch) => watch.id === id)!;
    check(
      listed.value === registerOf(record.tick, sh4.pcPath, first.name),
      `the watch on ${first.expression} reads ${JSON.stringify(listed.value)}, the register in the same tick ${registerOf(record.tick, sh4.pcPath, first.name)}`,
    );

    // Adding a stored expression again adds nothing, and still returns {}. Whether a tick
    // follows a request that changed nothing is the server's choice: the count is read from
    // the tick of the rename below.
    await session.call("state.watch", { expressions: [first.expression.toUpperCase().replace(sh4.pcPath.toUpperCase(), sh4.pcPath)] });

    // rename, with the register name in upper case: same id, lower-case expression, the other register's value
    const second = unwatchedRegister(context, sh4.pcPath, ["PR", "GBR", "VBR"]);
    const renameMark = session.mark();
    await session.call("state.modifyWatchExpression", { watchId: id, newExpression: `${sh4.pcPath}.${second.name}` });
    const renamed = await tickShowing(session, renameMark, "state.modifyWatchExpression", (tick) =>
      tick.watches?.find((watch) => watch.id === id)?.expression === first.expression ? `watch ${id} is still listed as "${first.expression}"` : undefined,
    );
    check(renamed.tick.watches!.length === record.tick.watches!.length, "an expression that is already stored is not added twice");
    const after = renamed.tick.watches!.find((watch) => watch.id === id);
    check(after !== undefined, "state.modifyWatchExpression keeps the id");
    check(after!.expression === second.expression, `the renamed watch is listed as "${after!.expression}", expected "${second.expression}"`);
    check(after!.value === registerOf(renamed.tick, sh4.pcPath, second.name), `the renamed watch reads ${JSON.stringify(after!.value)}, not the value of ${second.name}`);

    // an expression that resolves to no register: in-band -32602, and nothing is added (all-or-nothing)
    const count = renamed.tick.watches!.length;
    await session.expectError("state.watch", { expressions: ["dc.no.such.node.reg"] }, -32602);
    const third = unwatchedRegister(context, sh4.pcPath, ["SR", "GBR", "VBR", "MACH"]);
    await session.expectError("state.watch", { expressions: [third.expression, "dc.no.such.node.reg"] }, -32602);
    await session.expectError("state.modifyWatchExpression", { watchId: id, newExpression: "dc.no.such.node.reg" }, -32602);
    const probe = unwatchedRegister(context, sh4.pcPath, ["MACL", "MACH"]);
    const { id: probeId, record: probed } = await addWatch(context, probe.expression, probe.expression);
    check(probed.tick.watches!.length === count + 1, "a refused state.watch added nothing");
    await unwatch(context, probeId);

    await unwatch(context, id);
    // an id that is not there (any more) is ignored: `{}`
    await session.call("state.unwatch", { watchIds: [id] });

    // Bounds: at most 64 expressions in a call, at most 256 characters in an expression. The
    // 65 expressions are registers of the SH4, so that their number is all that is wrong.
    const names = session.index!.registers.get(sh4.pcPath)!.map((register) => register.name.toLowerCase());
    const many = Array.from({ length: PROTOCOL_BOUNDS.watchExpressionsPerCall + 1 }, (_, position) => `${sh4.pcPath}.${names[position % names.length]}`);
    await session.expectError("state.watch", { expressions: many }, -32602);
    const long = `${sh4.pcPath}.${"r".repeat(PROTOCOL_BOUNDS.watchExpressionLength + 1 - sh4.pcPath.length - 1)}`;
    await session.expectError("state.watch", { expressions: [long] }, -32602);
    // ... and 64 expressions in a call are accepted, and so are 64 ids in a call that removes
    // them. There are at most 256 watches: the calls go on until that many are stored (if the
    // device tree has that many registers), and one more is refused.
    const stored = session.latestTick().tick.watches ?? [];
    const free = unwatchedExpressions(context);
    const perCall = PROTOCOL_BOUNDS.watchExpressionsPerCall;
    const most = PROTOCOL_BOUNDS.watches;
    const countOf = (tick: DebuggerTick) => (tick.watches ?? []).length;
    const tickWith = (since: number, what: string, expected: number) =>
      tickShowing(session, since, what, (tick) => (countOf(tick) === expected ? undefined : `the tick lists ${countOf(tick)} watches, expected ${expected}`));
    if (free.length >= perCall && stored.length + perCall <= most) {
      const kept = new Set(stored.map((watch) => watch.id));
      const reachable = free.length > most - stored.length;
      let sent = 0;
      let latest: TickRecord;
      do {
        const expressions = free.slice(sent, sent + Math.min(perCall, most - stored.length - sent));
        const adding = session.mark();
        await session.call("state.watch", { expressions });
        sent += expressions.length;
        latest = await tickWith(adding, `state.watch of ${expressions.length} expressions`, stored.length + sent);
      } while (reachable && stored.length + sent < most);
      if (reachable) {
        await session.expectError("state.watch", { expressions: [free[sent]] }, -32602);
        latest = await session.describe();
        check(countOf(latest.tick) === most, `the server has ${countOf(latest.tick)} watches after it refused one more than ${most}`);
      } else {
        context.note(`the limit of ${most} watches was not reached: ${stored.length} watches exist, and the device tree has ${free.length} more registers`);
      }
      const ours = latest.tick.watches!.map((watch) => watch.id).filter((watchId) => !kept.has(watchId));
      let removing = session.mark();
      for (let position = 0; position < ours.length; position += perCall) {
        removing = session.mark();
        await session.call("state.unwatch", { watchIds: ours.slice(position, position + perCall) });
      }
      await tickWith(removing, `state.unwatch of ${ours.length} ids`, stored.length);
    } else {
      context.note(`${perCall} expressions in one state.watch were not tried: ${stored.length} watches exist, and ${free.length} registers are not watched`);
    }

    // none of the refused requests added anything (a tick follows the describe)
    const final = ((await session.describe()).tick.watches ?? []).map((watch) => `${watch.id}:${watch.expression}`);
    check(JSON.stringify(final) === JSON.stringify(initial), `the watches are ${JSON.stringify(final)}, before the scenario they were ${JSON.stringify(initial)}`);
  },
};

const s09: Scenario = {
  id: "S09",
  title: "memory",
  async run(context) {
    const { session } = context;
    const sh4 = requireTarget(context, "sh4");
    const paused = await ensurePaused(context);
    const pc = pcOf(paused.tick, sh4);

    const slice = await session.call("state.getMemorySlice", { target: "sh4", address: pc, length: 64 });
    check(slice.baseAddress === pc, `baseAddress is ${slice.baseAddress}, the request asked for ${pc}`);
    check(slice.data.length === 64, `data has ${slice.data.length} entries, the request asked for 64`);
    check(slice.unreadable === undefined, `64 bytes at the PC are readable; unreadable is ${JSON.stringify(slice.unreadable)}`);
    const lines = await disassemble(context, "sh4", pc, 32);
    const fromLines = lines.map((line) => line.bytes).join(" ");
    const fromMemory = slice.data.map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ");
    check(fromLines === fromMemory, `the bytes of 32 disassembly lines at the PC differ from the memory there:\n      lines:  ${fromLines}\n      memory: ${fromMemory}`);

    // target defaults to sh4
    const byDefault = await session.call("state.getMemorySlice", { address: pc, length: 4 });
    check(JSON.stringify(byDefault.data) === JSON.stringify(slice.data.slice(0, 4)), "without a target the read is an SH4 read");

    // the end of the flash at 0x0021FFFF: 32 bytes, the second half unreadable and zero
    const flash = await session.call("state.getMemorySlice", { target: "sh4", address: 0x0021fff0, length: 32 });
    check(flash.data.length === 32, `a read across 0x00220000 returns ${flash.data.length} bytes, expected 32`);
    check(JSON.stringify(flash.unreadable) === "[[16,16]]", `a read of 32 bytes at 0x0021FFF0 lists unreadable ${JSON.stringify(flash.unreadable)}, expected [[16,16]]`);
    check(flash.data.slice(16).every((byte) => byte === 0), "unreadable bytes are 0");
    // nothing readable: JSON-RPC -32010
    await session.expectError("state.getMemorySlice", { target: "sh4", address: 0x10000000, length: 16 }, -32010);

    // a target without memory: -32004; one with memory is read at its default address
    for (const target of session.shape.targets ?? []) {
      if (!target.memory) {
        await session.expectError("state.getMemorySlice", { target: target.id, address: 0, length: 16 }, -32004);
      } else if (target.id !== "sh4") {
        const address = target.defaultMemoryAddress ?? fail(`target ${target.id} has memory and no defaultMemoryAddress`);
        const read = await session.call("state.getMemorySlice", { target: target.id, address, length: 16 });
        check(read.baseAddress === address, `${target.id}: baseAddress is ${read.baseAddress}, the request asked for ${address}`);
        check(read.data.length === 16, `${target.id}: data has ${read.data.length} entries, the request asked for 16`);
        // what is readable there is what the disassembly shows there
        const count = Math.ceil(16 / target.instructionSize);
        const text = (await disassemble(context, target.id, address, count)).map((line) => line.bytes).join(" ");
        if (!text.includes("??") && read.unreadable === undefined) {
          const bytes = read.data.map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ");
          check(text === bytes, `${target.id}: the bytes of ${count} disassembly lines at ${hex(address)} differ from the memory there:\n      lines:  ${text}\n      memory: ${bytes}`);
        }
      }
    }
    // bounds: 1 to 65536 bytes
    await session.expectError("state.getMemorySlice", { target: "sh4", address: pc, length: 0 }, -32602);
    await session.expectError("state.getMemorySlice", { target: "sh4", address: pc, length: 65537 }, -32602);
    const longest = PROTOCOL_BOUNDS.memorySliceLength.max;
    const most = await session.call("state.getMemorySlice", { target: "sh4", address: Math.min(pc, PROTOCOL_BOUNDS.addressMax - longest + 1), length: longest });
    check(most.data.length === longest, `a read of ${longest} bytes, the longest there is, returns ${most.data.length} bytes`);
  },
};

const s10: Scenario = {
  id: "S10",
  title: "disassembly",
  async run(context) {
    const { session } = context;
    const paused = await ensurePaused(context);
    for (const target of session.shape.targets ?? []) {
      const pc = pcOf(paused.tick, target);
      const start = pc + 15 * target.instructionSize <= target.addressMax ? pc : target.defaultDisassemblyAddress;
      const lines = await disassemble(context, target.id, start, 16);
      check(lines.length === 16, `${target.id}: ${lines.length} lines for count 16 at ${hex(start)}`);
      lines.forEach((line, position) => {
        check(line.address === start + position * target.instructionSize, `${target.id}: line ${position} is at ${hex(line.address)}; addresses step by ${target.instructionSize}`);
        check(line.disassembly.length > 0, `${target.id}: the line at ${hex(line.address)} has no text`);
        check(
          line.bytes === "??" || /^[0-9A-F]{2}( [0-9A-F]{2})*$/.test(line.bytes),
          `${target.id}: bytes "${line.bytes}" are not space-separated upper-case hex`,
        );
        if (target.id !== "dsp" && line.bytes !== "??") {
          check(line.bytes.split(" ").length === target.instructionSize, `${target.id}: "${line.bytes}" are not ${target.instructionSize} bytes`);
        }
        check((line.bytes === "??") === (line.disassembly === "<unreadable>"), `${target.id}: an unreadable word is bytes "??" and text "<unreadable>"`);
      });
      // `context` is ignored: the lines are those of the request without it
      const withContext = (await session.call("state.getDisassembly", { target: target.id, address: start, count: 16, context: 8 })).lines;
      check(
        JSON.stringify(withContext) === JSON.stringify(lines),
        `${target.id}: with context 8 the ${withContext.length} lines start at ${hex(withContext[0]?.address ?? 0)}, without it the 16 lines start at ${hex(start)}; context is ignored`,
      );
      // fewer lines only at the end of the address space
      const last = target.addressMax - (target.addressMax % target.instructionSize);
      const tail = await disassemble(context, target.id, last - target.instructionSize, 16);
      check(tail.length === 2, `${target.id}: ${tail.length} lines for count 16 at the second-to-last address, expected 2`);
      if (target.instructionSize > 1) {
        await session.expectError("state.getDisassembly", { target: target.id, address: start + 1, count: 1 }, -32602);
      }
    }
    // an unreadable word is still a line: bytes "??", text "<unreadable>" (nothing is mapped at 0x10000000)
    const unreadable = await disassemble(context, "sh4", 0x10000000, 2);
    check(unreadable.length === 2, `sh4: ${unreadable.length} lines for count 2 at the unreadable ${hex(0x10000000)}, expected 2`);
    unreadable.forEach((line, position) => {
      check(line.address === 0x10000000 + position * 2, `sh4: line ${position} of the unreadable range is at ${hex(line.address)}`);
      check(
        line.bytes === "??" && line.disassembly === "<unreadable>",
        `sh4: the unreadable word at ${hex(line.address)} is bytes "${line.bytes}" and text "${line.disassembly}", expected "??" and "<unreadable>"`,
      );
    });

    // bounds: 1 to 1024 lines
    await session.expectError("state.getDisassembly", { target: "sh4", address: 0x8c010000, count: 0 }, -32602);
    await session.expectError("state.getDisassembly", { target: "sh4", address: 0x8c010000, count: 1025 }, -32602);
    const sh4 = requireTarget(context, "sh4");
    const most = PROTOCOL_BOUNDS.disassemblyCount.max;
    const pc = pcOf(paused.tick, sh4);
    const from = pc + (most - 1) * sh4.instructionSize <= sh4.addressMax ? pc : sh4.defaultDisassemblyAddress;
    const longest = await disassemble(context, "sh4", from, most);
    check(longest.length === most, `sh4: ${longest.length} lines for count ${most}, the largest there is, at ${hex(from)}`);
    // target defaults to sh4
    const byDefault = (await session.call("state.getDisassembly", { address: from, count: 16 })).lines;
    check(JSON.stringify(byDefault) === JSON.stringify(longest.slice(0, 16)), "without a target the disassembly is that of the SH4");
  },
};

const s11: Scenario = {
  id: "S11",
  title: "callstack",
  async run(context) {
    const { session } = context;
    check(hasCapability(context, CAPABILITIES.CALLSTACK), 'the capability "callstack" is part of milestone M1');
    const sh4 = requireTarget(context, "sh4");
    const paused = await ensurePaused(context);
    const frames = paused.tick.callstacks?.sh4 ?? [];
    check(frames.length >= 1, "a paused tick carries the SH4 callstack");
    check(frames[0].pc === pcOf(paused.tick, sh4), `frame 0 is at ${hex(frames[0].pc)}, the PC is ${hex(pcOf(paused.tick, sh4))}`);
    frames.forEach((frame, position) => check(frame.index === position, `frame ${position} of the tick has index ${frame.index}`));
    check(frames.length <= 32, `a tick carries at most 32 frames, this one ${frames.length}`);
    if (context.profile === "emulator" || frames.length > 1) {
      check(frames.length >= 2, "frame 1 is PR");
      check(frames[1].pc === numberOf(paused.tick, sh4.pcPath, "PR"), `frame 1 is at ${hex(frames[1].pc)}, PR is ${registerOf(paused.tick, sh4.pcPath, "PR")}`);
      check(frames[1].location === "pr", `frame 1 has location "${frames[1].location}", expected "pr"`);
    }
    for (const frame of frames.slice(2)) {
      check(/^stack\+0x[0-9A-Fa-f]+$/.test(frame.location ?? ""), `frame ${frame.index} has location "${frame.location}", expected "stack+0x.."`);
    }

    const requested = await session.call("state.getCallstack", { target: "sh4", maxFrames: 8 });
    check(requested.target === "sh4", "state.getCallstack echoes the target");
    check(requested.frames.length <= 8, `state.getCallstack {maxFrames: 8} returned ${requested.frames.length} frames`);
    requested.frames.forEach((frame, position) => check(frame.index === position, `frame ${position} has index ${frame.index}`));
    check(requested.frames[0]?.pc === frames[0].pc, "frame 0 of state.getCallstack is the PC");
    // bounds: 1 to 64 frames, 32 when the request does not say
    await session.expectError("state.getCallstack", { target: "sh4", maxFrames: 65 }, -32602);
    await session.expectError("state.getCallstack", { target: "sh4", maxFrames: 0 }, -32602);
    const deepest = await session.call("state.getCallstack", { target: "sh4", maxFrames: PROTOCOL_BOUNDS.callstackMaxFrames.max });
    check(deepest.frames.length <= PROTOCOL_BOUNDS.callstackMaxFrames.max, `state.getCallstack {maxFrames: 64} returned ${deepest.frames.length} frames`);
    deepest.frames.forEach((frame, position) => check(frame.index === position, `frame ${position} has index ${frame.index}`));
    const byDefault = await session.call("state.getCallstack", { target: "sh4" });
    const named = await session.call("state.getCallstack", { target: "sh4", maxFrames: PROTOCOL_BOUNDS.callstackMaxFrames.default });
    check(
      JSON.stringify(byDefault.frames) === JSON.stringify(named.frames),
      `state.getCallstack without maxFrames returned ${byDefault.frames.length} frames, with maxFrames 32 ${named.frames.length}; maxFrames defaults to 32`,
    );

    // the ARM7, if the server lists it: frame 0 is its PC, frame 1 its link register
    const arm7 = targetOf(session.shape, "arm7");
    if (arm7) {
      const arm7Frames = paused.tick.callstacks?.arm7 ?? [];
      check(arm7Frames.length >= 2, `a paused tick carries the ARM7 callstack (frame 0 the PC, frame 1 the link register); this one has ${arm7Frames.length} frame(s)`);
      check(arm7Frames[0].pc === pcOf(paused.tick, arm7), `arm7: frame 0 is at ${hex(arm7Frames[0].pc)}, the PC is ${hex(pcOf(paused.tick, arm7))}`);
      check(
        arm7Frames[1].pc === numberOf(paused.tick, arm7.pcPath, "R14"),
        `arm7: frame 1 is at ${hex(arm7Frames[1].pc)}, R14 is ${registerOf(paused.tick, arm7.pcPath, "R14")}`,
      );
      check(arm7Frames[1].location === "lr", `arm7: frame 1 has location "${arm7Frames[1].location}", expected "lr"`);
      arm7Frames.forEach((frame, position) => check(frame.index === position, `arm7: frame ${position} of the tick has index ${frame.index}`));
      for (const frame of arm7Frames.slice(2)) {
        check(/^stack\+0x[0-9A-Fa-f]+$/.test(frame.location ?? ""), `arm7: frame ${frame.index} has location "${frame.location}", expected "stack+0x.."`);
      }
      const fromArm7 = await session.call("state.getCallstack", { target: "arm7", maxFrames: 8 });
      check(fromArm7.target === "arm7", `state.getCallstack {arm7} answers for target "${fromArm7.target}"`);
      check(fromArm7.frames.length <= 8, `state.getCallstack {arm7, maxFrames: 8} returned ${fromArm7.frames.length} frames`);
      fromArm7.frames.forEach((frame, position) => check(frame.index === position, `arm7: frame ${position} has index ${frame.index}`));
      check(fromArm7.frames[0]?.pc === arm7Frames[0].pc, "arm7: frame 0 of state.getCallstack is the PC");
    }

    // running ticks carry both arrays, empty
    const running = await ensureRunning(context);
    check(running.tick.callstacks?.sh4?.length === 0 && running.tick.callstacks?.arm7?.length === 0, "a running tick carries empty callstacks");
    await ensurePaused(context);
  },
};

/**
 * One exchange on a raw WebSocket (the `ws` package, for what the client classes cannot
 * send): what the server answers to `text`. Ticks, which every connection receives, are
 * skipped.
 */
const rawExchange = (url: string, text: string, timeoutMs: number, what: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new ContractFailure(`no answer to ${what} within ${timeoutMs} ms`));
    }, timeoutMs);
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(new ContractFailure(`raw WebSocket: ${error.message}`));
    });
    socket.once("open", () => socket.send(text));
    socket.on("message", (data, isBinary) => {
      const answer = data.toString();
      if (isBinary || /"method"\s*:\s*"event\.tick"/.test(answer.slice(0, 200))) {
        return;
      }
      clearTimeout(timer);
      socket.close();
      resolve(answer);
    });
  });

const s12: Scenario = {
  id: "S12",
  title: "errors",
  async run(context) {
    const { session } = context;
    const sh4 = requireTarget(context, "sh4");

    // an unknown method: -32601, with the request id
    const mark = session.mark();
    await session.expectError("no.such.method", {}, -32601);
    const response = session.frames.find((frame) => frame.seq >= mark && frame.kind === "response");
    check(typeof response?.json.id === "number", "the -32601 response echoes the numeric request id");

    // a mistyped parameter: a JSON-RPC error for a read, in-band for a control method
    await session.expectError("state.getMemorySlice", { target: "sh4", address: "0x8c010000", length: 16 }, -32602);
    await session.expectError("control.step", { target: 4 }, -32602);
    await session.expectError("breakpoints.toggle", { id: "one", enabled: true }, -32602);
    // a missing or invalid address of a code breakpoint
    await session.expectError("breakpoints.add", { event: sh4.breakpointEvent, kind: "code" }, -32602);
    await session.expectError("breakpoints.add", { event: sh4.breakpointEvent, address: 0x8c010001 }, -32602);
    // an event the server does not raise: -32004
    await session.expectError("breakpoints.add", { event: "dc.no.such.event" }, -32004);

    // a step while running: in-band -32003
    await ensureRunning(context);
    await session.expectError("control.step", { target: "sh4" }, -32003);
    await session.expectError("control.stepOver", { target: "sh4" }, -32003);
    await session.expectError("control.stepOut", { target: "sh4" }, -32003);
    // DSP step over / out: -32004 always (checked while paused, where it is not -32003)
    await ensurePaused(context);
    if (targetOf(session.shape, "dsp")) {
      await session.expectError("control.stepOver", { target: "dsp" }, -32004);
      await session.expectError("control.stepOut", { target: "dsp" }, -32004);
    }
    // a target without stepping: its steps and code breakpoints are -32004
    for (const target of session.shape.targets ?? []) {
      if (!target.stepping) {
        await session.expectError("control.step", { target: target.id }, -32004);
        await session.expectError("breakpoints.add", { event: target.breakpointEvent, address: 0 }, -32004);
      }
    }
    // methods of a milestone the server does not advertise: -32004 on the method's channel
    if (!hasCapability(context, CAPABILITIES.RESET)) {
      await session.expectError("control.reset", {}, -32004);
    }
    if (!hasCapability(context, CAPABILITIES.MEMORY_WRITE)) {
      await session.expectError("state.writeMemory", { target: "sh4", address: 0x8c010000, data: [0] }, -32004);
    }
    if (!hasCapability(context, CAPABILITIES.MEMORY_BINARY)) {
      await session.expectError("state.getMemoryBinary", { target: "sh4", address: 0x8c010000, length: 16 }, -32004);
    }
    if (!hasCapability(context, CAPABILITIES.TABLES)) {
      await session.expectError("state.getTable", { id: "sq" }, -32004);
    }
    if (!hasCapability(context, CAPABILITIES.HOLLY_CAPTURE)) {
      await session.expectError("state.captureHolly", { what: "ta" }, -32004);
    }
    if (!hasCapability(context, CAPABILITIES.SGC_CAPTURE)) {
      await session.expectError("state.recordSgcFrames", { frames: 1 }, -32004);
      await session.expectError("state.getSgcFrameData", {}, -32004);
    }
    if (!hasCapability(context, CAPABILITIES.REGISTER_WRITE)) {
      await session.expectError("state.setRegister", { path: sh4.pcPath, name: "R0", value: "0" }, -32004);
      // state.editWatch is state.setRegister on the watched register, and -32004 until then. The
      // request is a valid one: a watch that exists, and the value its register has.
      const register = unwatchedRegister(context, sh4.pcPath, ["R0", "R1", "R2"]);
      const { id, record } = await addWatch(context, register.expression, register.expression);
      const value = record.tick.watches?.find((watch) => watch.id === id)?.value;
      await session.expectError("state.editWatch", { watchId: id, value: typeof value === "string" && value.startsWith("0x") ? value : "0" }, -32004);
      await unwatch(context, id);
    }

    // malformed JSON: -32700 with id null, and nothing else in the answer
    const answer = await rawExchange(context.url, "{nope", session.scale(2000), "malformed JSON");
    let parsed: unknown;
    try {
      parsed = JSON.parse(answer);
    } catch {
      fail(`the answer to malformed JSON is not JSON: ${answer.slice(0, 120)}`);
    }
    const expected = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } };
    check(
      JSON.stringify(sortKeys(parsed)) === JSON.stringify(sortKeys(expected)),
      `the answer to malformed JSON is ${answer.slice(0, 200)}, expected ${JSON.stringify(expected)}`,
    );

    // What is JSON and not a request object of this protocol: -32600. There are no batches (a
    // JSON array is not executed), requests are objects with jsonrpc "2.0", and their id is a
    // number. What the id of such an answer is, the design does not say: it is not looked at.
    const request = { jsonrpc: "2.0", id: 1, method: "debugger.describe", params: {} };
    const { jsonrpc: _version, ...withoutVersion } = request;
    const invalid: Array<[what: string, frame: unknown]> = [
      ["a batch (a JSON array of requests)", [request]],
      ["a frame that is JSON and not an object (42)", 42],
      ["a request without the jsonrpc member", withoutVersion],
      ["a request whose id is a string", { ...request, id: "1" }],
    ];
    for (const [what, frame] of invalid) {
      const text = await rawExchange(context.url, JSON.stringify(frame), session.scale(2000), what);
      let reply: unknown;
      try {
        reply = JSON.parse(text);
      } catch {
        fail(`the answer to ${what} is not JSON: ${text.slice(0, 120)}`);
      }
      const { jsonrpc, error, ...rest } = (typeof reply === "object" && reply !== null && !Array.isArray(reply) ? reply : {}) as Record<string, unknown>;
      const { code, message, ...more } = (typeof error === "object" && error !== null ? error : {}) as Record<string, unknown>;
      check(
        jsonrpc === "2.0" && code === -32600 && typeof message === "string" && DEBUGGER_ERROR_MESSAGES[-32600].test(message),
        `${what} is answered with ${text.slice(0, 200)}, expected the JSON-RPC error -32600 "invalid request"`,
      );
      check(
        Object.keys(more).length === 0 && Object.keys(rest).every((key) => key === "id"),
        `the answer to ${what} is ${text.slice(0, 200)}: a response has jsonrpc, id and error, and an error code and message only`,
      );
    }
    // "no data member anywhere" is checked on every response of the run by the session
  },
};

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  }
  return value;
};

const s13: Scenario = {
  id: "S13",
  title: "two clients",
  async run(context) {
    const { session } = context;
    const sh4 = requireTarget(context, "sh4");
    const other = await context.openSession();
    try {
      // Every successful mutating request is followed by a tick to every client. That is
      // seen while the target is paused: while it runs, the periodic tick shows the same
      // change to the second client 200 ms later, whether or not the request was broadcast.
      await ensurePaused(context);
      let since = other.mark();
      const breakpoint = await addBreakpoint(context, { event: sh4.breakpointEvent, address: sh4.defaultDisassemblyAddress, enabled: false });
      await other.waitForTick(
        (tick) => String(breakpoint.id) in tick.breakpoints,
        1000,
        `a tick on the second connection that lists breakpoint ${breakpoint.id}`,
        since,
      );
      since = other.mark();
      await removeBreakpoint(context, breakpoint.id);
      await other.waitForTick((tick) => !(String(breakpoint.id) in tick.breakpoints), 1000, "a tick on the second connection without the removed breakpoint", since);

      // a watch
      const register = unwatchedRegister(context, sh4.pcPath, ["SR", "GBR", "VBR"]);
      const lists = (id: number) => (tick: DebuggerTick) => (tick.watches ?? []).some((watch) => watch.id === id);
      since = other.mark();
      const { id: watchId } = await addWatch(context, register.expression, register.expression);
      await other.waitForTick(lists(watchId), 1000, `a tick on the second connection that lists watch ${watchId}`, since);
      since = other.mark();
      await unwatch(context, watchId);
      await other.waitForTick((tick) => !lists(watchId)(tick), 1000, "a tick on the second connection without the removed watch", since);

      // a category
      const original = categoriesOf(session.latestTick().tick).events;
      for (const state of [{ muted: !original.muted, soloed: original.soloed }, original]) {
        since = other.mark();
        await setCategories(context, { events: state });
        await other.waitForTick(
          (tick) => tick.categories?.events?.muted === state.muted,
          1000,
          `a tick on the second connection with the category events ${state.muted ? "muted" : "not muted"}`,
          since,
        );
      }
    } finally {
      other.close();
      // what the invariants found on the second connection fails this scenario too
      session.violations.push(...other.violations);
    }
  },
};

const s14: Scenario = {
  id: "S14",
  title: "reconnect",
  async run(context) {
    const old = context.session;
    const sh4 = requireTarget(context, "sh4");
    await ensurePaused(context);
    const original = categoriesOf(old.latestTick().tick);
    // something of each kind to find again
    const breakpoint = await addBreakpoint(context, { event: sh4.breakpointEvent, address: sh4.defaultDisassemblyAddress, enabled: false });
    const register = unwatchedRegister(context, sh4.pcPath, ["GBR", "VBR", "SR"]);
    const { id: watchId } = await addWatch(context, register.expression, register.expression);
    const changed = await setCategories(context, { ...original, dsp: { muted: !original.dsp.muted, soloed: false } });
    const before = changed.tick;
    check(isPaused(before), "the target is paused before the reconnect");

    // A reconnect: the server has no client in between. The new connection is opened only
    // after the old socket has finished closing, and after a moment for the server to notice
    // (the close event can reach the client first); all of it well inside the grace period.
    check(await old.closeAndWait(3000), "the server did not finish closing the connection within 3 s of the client's close frame");
    await sleep(old.scale(200));
    const fresh = await context.openSession();
    // the scenario's violations are counted from the session it started with
    fresh.violations.unshift(...old.violations);
    context.session = fresh;
    const first = fresh.ticks[0].tick;

    const summary = (tick: DebuggerTick) =>
      JSON.stringify({
        breakpoints: sortKeys(tick.breakpoints),
        watches: (tick.watches ?? []).map((watch) => [watch.id, watch.expression]),
        categories: sortKeys(tick.categories),
      });
    check(summary(first) === summary(before), `after the reconnect the first tick has\n      ${summary(first)}\n    before it the last tick had\n      ${summary(before)}`);
    // the debugger stop is still in force: the same stop, not a new one and not released
    check(
      isPaused(first) && stopIdOf(first) === stopIdOf(before),
      `after the reconnect the first tick is ${describeState(first)}; before it the target was ${describeState(before)}, and a stop outlives a reconnect within the grace period`,
    );

    await setCategories(context, original);
    await unwatch(context, watchId);
    await removeBreakpoint(context, breakpoint.id);
  },
};

const httpGet = (
  url: URL,
  options: { method?: string; path: string; host?: string },
): Promise<{ status: number; type: string; body: string }> =>
  new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: options.path,
        method: options.method ?? "GET",
        headers: options.host ? { Host: options.host } : undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, type: String(response.headers["content-type"] ?? ""), body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    request.on("error", (error) => reject(new ContractFailure(`${options.method ?? "GET"} ${options.path}: ${error.message}`)));
    request.end();
  });

/** The HTTP status of a WebSocket upgrade with the given Origin: 101 when it is accepted. */
const upgradeStatus = (url: string, origin: string | undefined): Promise<number> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url, origin === undefined ? {} : { headers: { Origin: origin } });
    socket.once("open", () => {
      socket.close();
      resolve(101);
    });
    socket.once("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once("error", (error) => reject(new ContractFailure(`upgrade with Origin ${origin}: ${error.message}`)));
  });

const s15: Scenario = {
  id: "S15",
  title: "HTTP, Host and Origin",
  emulatorOnly: true,
  async run(context) {
    if (context.profile !== "emulator") {
      return { notApplicable: "emulator profile only: the mock's host is Express, not the emulator's HTTP server" };
    }
    const url = new URL(context.url);
    const root = await httpGet(url, { path: "/" });
    check(root.status === 200 && /text\/html/.test(root.type), `GET / is ${root.status} ${root.type}, expected 200 text/html`);
    const query = await httpGet(url, { path: "/?ws=x" });
    check(query.status === 200 && /text\/html/.test(query.type), `GET /?ws=x is ${query.status} ${query.type}; the query string is ignored`);
    const missing = await httpGet(url, { path: "/assets/no-such-file-0123abcd.js" });
    check(missing.status === 404, `a missing asset is ${missing.status}, expected 404`);
    const post = await httpGet(url, { path: "/", method: "POST" });
    check(post.status === 405, `POST / is ${post.status}, expected 405`);
    const evilHost = await httpGet(url, { path: "/", host: `evil.example:${url.port}` });
    check(evilHost.status === 403, `GET / with Host: evil.example is ${evilHost.status}, expected 403`);

    check((await upgradeStatus(context.url, "http://evil.example")) === 403, "an upgrade with Origin: http://evil.example is refused with 403");
    check((await upgradeStatus(context.url, "null")) === 403, "an upgrade with Origin: null is refused with 403");
    check((await upgradeStatus(context.url, "http://localhost:5173")) === 101, "an upgrade with Origin: http://localhost:5173 is accepted");
  },
};

/** Runs the parts of a multi-capability scenario; a part whose capability is missing is not applicable. */
const runParts = async (parts: Array<{ name: string; applicable: boolean; why: string; run: () => Promise<void> }>): Promise<Outcome> => {
  const results: PartResult[] = [];
  for (const part of parts) {
    if (!part.applicable) {
      results.push({ name: part.name, status: "not-applicable", detail: part.why });
      continue;
    }
    try {
      await part.run();
      results.push({ name: part.name, status: "passed" });
    } catch (error) {
      if (!(error instanceof ContractFailure)) {
        throw error;
      }
      results.push({ name: part.name, status: "failed", detail: error.message });
    }
  }
  if (results.every((result) => result.status === "not-applicable")) {
    return { notApplicable: results.map((result) => result.detail).join("; ") };
  }
  return { parts: results };
};

/** The JSON response is sent first, the binary frame second. `request` is a `mark()` taken before the request. */
const checkBinaryAfterResponse = (session: ContractSession, request: number, binary: BinaryRecord, method: string): void => {
  const response = session.responseSince(request) ?? fail(`the ${method} response was not recorded`);
  check(binary.seq > response.seq, `the binary frame of ${method} arrived before its JSON response; the response is sent first, the binary frame second`);
};

/** A step and a code breakpoint of a target other than the SH4. */
const stepAndBreakpoint = async (context: RunContext, targetId: "arm7" | "dsp"): Promise<void> => {
  const { session } = context;
  const target = requireTarget(context, targetId);
  const before = await ensurePaused(context);
  const pc0 = pcOf(before.tick, target);
  const stepped = await stepOnce(context, targetId);
  if (targetId === "dsp") {
    check(pcOf(stepped.tick, target) === (pc0 + 1) % (target.addressMax + 1), `a DSP step from ${pc0} ended at ${pcOf(stepped.tick, target)}`);
  } else {
    check(pcOf(stepped.tick, target) !== pc0, `a step of ${targetId} left its PC at ${hex(pc0)}`);
  }

  const pc = await findBreakpointSite(context, targetId);
  const address = pc + target.instructionSize;
  const breakpoint = await addBreakpoint(context, { event: target.breakpointEvent, address });
  const armed = session.latestTick().tick;
  const mark = session.mark();
  await session.call("control.runUntil", {});
  const hit = await session.waitForTick(
    (tick) => isPaused(tick) && stopIdOf(tick) > stopIdOf(armed),
    2000,
    `a paused tick at the ${targetId} breakpoint ${address}`,
    mark,
  );
  check(hit.tick.executionState.breakpointId === breakpoint.id, `the stop reports breakpointId ${hit.tick.executionState.breakpointId}, expected ${breakpoint.id}`);
  check(hit.tick.executionState.reason === "breakpoint", `the stop has reason "${hit.tick.executionState.reason}"`);
  check(pcOf(hit.tick, target) === address, `the stop is at ${pcOf(hit.tick, target)}, the breakpoint at ${address}`);
  await removeBreakpoint(context, breakpoint.id);
};

const s16: Scenario = {
  id: "S16",
  title: "M2: ARM7, writes, reset",
  milestone: "M2",
  run: (context) =>
    runParts([
      {
        name: "arm7 step and breakpoint",
        applicable: targetOf(context.session.shape, "arm7")?.stepping === true,
        why: "targets: arm7.stepping is false",
        run: () => stepAndBreakpoint(context, "arm7"),
      },
      {
        name: "writeMemory",
        applicable: hasCapability(context, CAPABILITIES.MEMORY_WRITE),
        why: 'no capability "memory-write"',
        async run() {
          const { session } = context;
          const sh4 = requireTarget(context, "sh4");
          const paused = await ensurePaused(context);
          // below the stack pointer: nothing lives there while the target is paused
          const address = ((numberOf(paused.tick, sh4.pcPath, "R15") - 256) & ~3) >>> 0;
          const original = (await session.call("state.getMemorySlice", { target: "sh4", address, length: 16 })).data;
          const pattern = original.map((byte, position) => (byte ^ 0xa5 ^ position) & 0xff);
          try {
            await session.call("state.writeMemory", { target: "sh4", address, data: pattern });
            const written = (await session.call("state.getMemorySlice", { target: "sh4", address, length: 16 })).data;
            check(JSON.stringify(written) === JSON.stringify(pattern), `16 bytes written at ${hex(address)} read back as ${JSON.stringify(written)}`);
          } finally {
            await session.call("state.writeMemory", { target: "sh4", address, data: original });
          }
          const restored = (await session.call("state.getMemorySlice", { target: "sh4", address, length: 16 })).data;
          check(JSON.stringify(restored) === JSON.stringify(original), "the original bytes are back");
          // the BIOS is not writable, and the range is checked as a whole
          await session.expectError("state.writeMemory", { target: "sh4", address: 0x00000000, data: [0] }, -32013);
          await session.expectError("state.writeMemory", { target: "sh4", address, data: [] }, -32602);
        },
      },
      {
        name: "setRegister",
        applicable: hasCapability(context, CAPABILITIES.REGISTER_WRITE),
        why: 'no capability "register-write"',
        async run() {
          const { session } = context;
          const sh4 = requireTarget(context, "sh4");
          const paused = await ensurePaused(context);
          const original = registerOf(paused.tick, sh4.pcPath, "R0") ?? fail(`${sh4.pcPath} has no register R0`);
          const write = async (value: string, expected: string) => {
            const mark = session.mark();
            await session.call("state.setRegister", { path: sh4.pcPath, name: "R0", value });
            const next = await tickShowing(session, mark, "state.setRegister", (tick) =>
              registerOf(tick, sh4.pcPath, "R0") === expected ? undefined : `R0 reads ${registerOf(tick, sh4.pcPath, "R0")} after writing ${value}, expected ${expected}`,
            );
            check(isPaused(next.tick) && stopIdOf(next.tick) === stopIdOf(paused.tick), "a register write is not a new stop");
          };
          try {
            await write("0x12345678", "0x12345678");
            // decimal, and truncated to the register's width
            await write("255", "0x000000FF");
            await write("0x1FFFFFFFF", "0xFFFFFFFF");
          } finally {
            await write(original, original);
          }
          await session.expectError("state.setRegister", { path: sh4.pcPath, name: "NO_SUCH_REGISTER", value: "0" }, -32602);
          await session.expectError("state.setRegister", { path: "dc.no.such.node", name: "R0", value: "0" }, -32602);
          await session.expectError("state.setRegister", { path: sh4.pcPath, name: "R0", value: "twelve" }, -32602);
          // a register with width 0 is free text and read-only
          for (const [path, registers] of session.index!.registers) {
            const text = registers.find((register) => register.width === 0);
            if (text) {
              await session.expectError("state.setRegister", { path, name: text.name, value: "1" }, -32013);
              break;
            }
          }
          // state.editWatch is state.setRegister on the watched register
          const { id } = await addWatch(context, `${sh4.pcPath}.r0`, `${sh4.pcPath}.r0`).catch(() => ({ id: undefined }));
          if (id !== undefined) {
            const mark = session.mark();
            await session.call("state.editWatch", { watchId: id, value: "0x00C0FFEE" });
            await tickShowing(session, mark, "state.editWatch", (tick) =>
              registerOf(tick, sh4.pcPath, "R0") === "0x00C0FFEE" ? undefined : `R0 reads ${registerOf(tick, sh4.pcPath, "R0")}; state.editWatch writes the watched register`,
            );
            await write(original, original);
            await unwatch(context, id);
          } else {
            context.note("state.editWatch not exercised: R0 is watched by somebody else");
          }
        },
      },
      {
        name: "reset",
        applicable: hasCapability(context, CAPABILITIES.RESET),
        why: 'no capability "reset"',
        async run() {
          const { session } = context;
          const paused = await ensurePaused(context);
          const mark = session.mark();
          await session.call("control.reset", {});
          const reset = await session.waitForTick((tick) => stopIdOf(tick) > stopIdOf(paused.tick), 5000, "a tick with a new stopId after control.reset", mark);
          check(isPaused(reset.tick), "a reset while paused stays paused");
          check(reset.tick.executionState.reason === "reset", `the stop has reason "${reset.tick.executionState.reason}", expected "reset"`);
          check(!session.ticksSince(mark).some((record) => record.seq < reset.seq && isRunning(record.tick)), "no running tick between control.reset and its stop");
        },
      },
    ]),
};

const s17: Scenario = {
  id: "S17",
  title: "M3: SGC capture, DSP",
  milestone: "M3",
  run: (context) =>
    runParts([
      {
        name: "sgc capture",
        applicable: hasCapability(context, CAPABILITIES.SGC_CAPTURE),
        why: 'no capability "sgc-capture"',
        async run() {
          const { session } = context;
          const paused = await ensurePaused(context);

          // an error result is followed by no binary frame
          const binaryBefore = session.binary.length;
          let hadCapture = false;
          try {
            await session.expectError("state.getSgcFrameData", {}, -32011);
          } catch (error) {
            if (!(error instanceof ContractFailure) || !/got the result/.test(error.message)) {
              throw error;
            }
            hadCapture = true;
          }
          if (hadCapture) {
            context.note("a capture existed already, so \"no binary frame after an error\" was not exercised");
            check((await session.waitForBinary(binaryBefore, session.scale(10_000))) !== undefined, "the binary frame of the existing capture");
          } else {
            check((await session.waitForBinary(binaryBefore, 500)) === undefined, "a binary frame followed the error -32011");
          }

          // from the paused state: the target runs for exactly the capture and pauses again
          const mark = session.mark();
          await session.call("state.recordSgcFrames", { frames: 64 });
          const stopped = await session.waitForTick(
            (tick) => isPaused(tick) && stopIdOf(tick) > stopIdOf(paused.tick),
            5000,
            'a paused tick with reason "capture" after state.recordSgcFrames',
            mark,
          );
          check(stopped.tick.executionState.reason === "capture", `the stop after the capture has reason "${stopped.tick.executionState.reason}", expected "capture"`);
          check(session.ticksSince(mark).some((record) => record.seq < stopped.seq && isRunning(record.tick)), "a running tick while the capture runs");

          const from = session.binary.length;
          const request = session.mark();
          const info = await session.call("state.getSgcFrameData", {});
          if ("error" in info) {
            return fail("state.getSgcFrameData answered with an in-band error object");
          }
          check(info.frameCount === 64, `frameCount is ${info.frameCount}, 64 frames were recorded`);
          check(info.totalBytes === 64 * SGC_BYTES_PER_FRAME, `totalBytes is ${info.totalBytes}, expected ${64 * SGC_BYTES_PER_FRAME}`);
          const binary = (await session.waitForBinary(from, session.scale(10_000))) ?? fail("no binary frame within 10 s of the state.getSgcFrameData response");
          checkBinaryAfterResponse(session, request, binary, "state.getSgcFrameData");
          const frame = binary.data;
          check(frame.byteLength === BINARY_FRAME_HEADER_BYTES + info.totalBytes, `the binary frame has ${frame.byteLength} bytes, expected 16 + ${info.totalBytes}`);
          const parsed = parseBinaryFrame(frame);
          if (!parsed.ok) {
            return fail(`the binary frame: ${parsed.reason}`);
          }
          check(parsed.header.kind === BinaryFrameKind.SGC_FRAMES, `kind is ${parsed.header.kind}, expected 1`);
          check(parsed.header.binaryId === info.binaryId, `binaryId is ${parsed.header.binaryId} in the header and ${info.binaryId} in the result`);
          check(parsed.header.payloadBytes === 64 * SGC_BYTES_PER_FRAME, `payloadBytes is ${parsed.header.payloadBytes}`);
          check(info.binaryId! >= 1, "binaryId is allocated per connection from 1");

          // the record layout: byte 109 is the flags byte, bytes 110..127 are zero, the level is at most 0x3FF
          const bytes = new Uint8Array(parsed.payload);
          const view = new DataView(parsed.payload);
          for (let offset = 0; offset < bytes.length; offset += 128) {
            check((bytes[offset + 109] & ~0x07) === 0, `record at ${offset}: flags byte ${bytes[offset + 109]} has bits above bit 2`);
            check(view.getUint32(offset + 96, true) <= 0x3ff, `record at ${offset}: aeg_value ${view.getUint32(offset + 96, true)} is above 0x3FF`);
            for (let pad = 110; pad < 128; pad++) {
              check(bytes[offset + pad] === 0, `record at ${offset}: byte ${pad} is not zero`);
            }
          }
          await session.expectError("state.recordSgcFrames", { frames: 4097 }, -32602);
        },
      },
      {
        name: "dsp step and breakpoint",
        applicable: targetOf(context.session.shape, "dsp")?.stepping === true,
        why: "targets: dsp.stepping is false",
        run: () => stepAndBreakpoint(context, "dsp"),
      },
    ]),
};

const s18: Scenario = {
  id: "S18",
  title: "M4: tables, Holly capture",
  milestone: "M4",
  run: (context) =>
    runParts([
      {
        name: "tables",
        applicable: hasCapability(context, CAPABILITIES.TABLES),
        why: 'no capability "tables"',
        async run() {
          for (const id of TABLE_IDS) {
            const table = await context.session.call("state.getTable", { id });
            table.rows.forEach((row, position) =>
              check(row.length === table.columns.length, `state.getTable {${id}}: row ${position} has ${row.length} cells, the table ${table.columns.length} columns`),
            );
            if (id === "icache" || id === "ocache") {
              check(table.rows.length === 0 && table.note !== undefined, `state.getTable {${id}}: no rows and a note (there is no cache model)`);
            }
          }
          await context.session.expectError("state.getTable", { id: "vram" }, -32602);
        },
      },
      {
        name: "holly capture",
        applicable: hasCapability(context, CAPABILITIES.HOLLY_CAPTURE),
        why: 'no capability "holly-capture"',
        async run() {
          const { session } = context;
          const from = session.binary.length;
          const request = session.mark();
          const info = await session.call("state.captureHolly", { what: "ta" });
          check(info.what === "ta" && info.format === "taframe4", `state.captureHolly {ta} answered ${JSON.stringify(info)}`);
          const binary = (await session.waitForBinary(from, session.scale(10_000))) ?? fail("no binary frame within 10 s of the state.captureHolly response");
          checkBinaryAfterResponse(session, request, binary, "state.captureHolly");
          const parsed = parseBinaryFrame(binary.data);
          if (!parsed.ok) {
            return fail(`the binary frame: ${parsed.reason}`);
          }
          check(parsed.header.kind === BinaryFrameKind.TA_CAPTURE, `kind is ${parsed.header.kind}, expected 4`);
          check(parsed.header.binaryId === info.binaryId, "binaryId of the header is the binaryId of the result");
          check(parsed.header.payloadBytes === info.totalBytes, "payloadBytes of the header is totalBytes of the result");
          check(new TextDecoder("latin1").decode(parsed.payload.slice(0, 8)) === "TAFRAME4", "the payload starts with TAFRAME4");
        },
      },
    ]),
};

export const SCENARIOS: Scenario[] = [s00, s01, s02, s03, s04, s05, s06, s07, s08, s09, s10, s11, s12, s13, s14, s15, s16, s17, s18];

/**
 * The scenarios a server of `milestone` has to pass, i.e. the gate of that milestone: those
 * of the milestone and of the ones before it, without those of the other profile.
 */
export const scenariosOfMilestone = (milestone: Milestone, profile: Profile): string[] =>
  SCENARIOS.filter(
    (scenario) => MILESTONES.indexOf(scenario.milestone ?? "M1") <= MILESTONES.indexOf(milestone) && (profile === "emulator" || !scenario.emulatorOnly),
  ).map((scenario) => scenario.id);

/**
 * Runs one scenario. It fails when an assertion fails, when the scenario throws, or when
 * the session recorded an invariant violation while it ran.
 */
export const runScenario = async (scenario: Scenario, context: RunContext): Promise<ScenarioResult> => {
  const started = Date.now();
  const details: string[] = [];
  const noteBefore = context.note;
  context.note = (text) => details.push(text);
  const violationsBefore = context.session.violations.length;
  let status: ScenarioStatus = "passed";
  let parts: PartResult[] | undefined;
  try {
    const outcome = await scenario.run(context);
    if (outcome && "notApplicable" in outcome) {
      status = "not-applicable";
      details.unshift(outcome.notApplicable);
    } else if (outcome && "parts" in outcome) {
      parts = outcome.parts;
      if (parts.some((part) => part.status === "failed")) {
        status = "failed";
        details.unshift(...parts.filter((part) => part.status === "failed").map((part) => `${part.name}: ${part.detail}`));
      } else if (parts.some((part) => part.status === "not-applicable")) {
        status = "partial";
      }
    }
  } catch (error) {
    status = "failed";
    if (error instanceof ContractFailure) {
      details.unshift(error.message, ...error.more);
    } else {
      details.unshift(`the runner failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
  } finally {
    context.note = noteBefore;
  }
  // S14 replaces the session and carries the old violations over to the front of the new one
  const fresh = context.session.violations.slice(violationsBefore);
  if (fresh.length > 0) {
    status = "failed";
    const distinct = Array.from(new Set(fresh));
    details.push(...distinct.slice(0, 12).map((violation) => `invariant: ${violation}`));
    if (distinct.length > 12) {
      details.push(`invariant: ... and ${distinct.length - 12} more`);
    }
  }
  return { id: scenario.id, title: scenario.title, status, durationMs: Date.now() - started, details, ...(parts ? { parts } : {}) };
};

/** What the run compares the server with when it cleans up: the state it found. */
export interface Baseline {
  state: "running" | "paused";
  breakpoints: BreakpointDescriptor[];
  watches: Array<{ id: number; expression: string }>;
  categories: Record<string, BreakpointCategoryState> | undefined;
}

export const baselineOf = (tick: DebuggerTick): Baseline =>
  JSON.parse(
    JSON.stringify({
      state: tick.executionState.state,
      breakpoints: Object.values(tick.breakpoints ?? {}),
      watches: (tick.watches ?? []).map((watch) => ({ id: watch.id, expression: watch.expression })),
      categories: tick.categories,
    }),
  ) as Baseline;

/** How a tick differs from the state the run found; the run state counts only when `withState` is set. */
const differencesFrom = (baseline: Baseline, tick: DebuggerTick, withState: boolean): string[] => {
  const differences: string[] = [];
  // a tick that does not say what the server has cannot show that nothing is left
  if (typeof tick.breakpoints !== "object" || tick.breakpoints === null) {
    differences.push("the tick lists no breakpoints: what is left of them is not known");
  }
  if (!Array.isArray(tick.watches)) {
    differences.push("the tick lists no watches: what is left of them is not known");
  }
  // (by the id of the descriptor, not by the key it is listed under: I3 is somebody else's check)
  const breakpoints = new Map(Object.values(tick.breakpoints ?? {}).map((breakpoint) => [breakpoint.id, breakpoint]));
  const known = new Map(baseline.breakpoints.map((breakpoint) => [breakpoint.id, breakpoint]));
  for (const [id, breakpoint] of breakpoints) {
    const was = known.get(id);
    if (!was) {
      differences.push(`breakpoint ${id} (${breakpoint.event}${breakpoint.address === undefined ? "" : ` at ${hex(breakpoint.address)}`}) is left behind`);
    } else if (JSON.stringify(sortKeys(breakpoint)) !== JSON.stringify(sortKeys(was))) {
      differences.push(`breakpoint ${id} is ${JSON.stringify(breakpoint)}, it was ${JSON.stringify(was)}`);
    }
  }
  for (const id of known.keys()) {
    if (!breakpoints.has(id)) {
      differences.push(`breakpoint ${id}, which the run found, is gone`);
    }
  }
  const watches = new Map((tick.watches ?? []).map((watch) => [watch.id, watch.expression]));
  const found = new Map(baseline.watches.map((watch) => [watch.id, watch.expression]));
  for (const [id, expression] of watches) {
    if (!found.has(id)) {
      differences.push(`watch ${id} (${expression}) is left behind`);
    } else if (found.get(id) !== expression) {
      differences.push(`watch ${id} is ${expression}, it was ${found.get(id)}`);
    }
  }
  for (const [id, expression] of found) {
    if (!watches.has(id)) {
      differences.push(`watch ${id} (${expression}), which the run found, is gone`);
    }
  }
  if (baseline.categories && JSON.stringify(sortKeys(tick.categories)) !== JSON.stringify(sortKeys(baseline.categories))) {
    differences.push(`the categories are ${JSON.stringify(tick.categories)}, they were ${JSON.stringify(baseline.categories)}`);
  }
  if (withState && tick.executionState?.state !== baseline.state) {
    differences.push(`the target is ${tick.executionState?.state}, it was ${baseline.state}`);
  }
  return differences;
};

/**
 * Puts the server back as the run found it, by difference: every breakpoint and every watch
 * that `baseline` does not list is removed, whoever added it and whether or not a tick ever
 * confirmed it to a scenario; the categories are restored; with `restoreState` (the end of
 * the run) so is the run state. Then a fresh tick is compared with the baseline. Returns
 * what could not be done and what still differs, and that tick.
 */
export const cleanUp = async (
  context: RunContext,
  baseline: Baseline,
  restoreState: boolean,
): Promise<{ problems: string[]; tick: DebuggerTick | undefined }> => {
  const problems: string[] = [];
  if (context.session.isClosed) {
    // a scenario lost the connection (S14 closes one on purpose): clean up on a new one
    try {
      context.session = await context.openSession();
    } catch (error) {
      return { problems: [`the connection is closed and a new one failed, nothing could be cleaned up: ${error instanceof Error ? error.message : String(error)}`], tick: undefined };
    }
  }
  const { session } = context;
  const attempt = async (what: string, action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      problems.push(`${what}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // what the server has now: the tick that follows a describe, not the last tick a scenario happened to see
  let current: DebuggerTick | undefined;
  await attempt("reading the state of the server", async () => {
    current = (await session.describe()).tick;
  });
  if (!current) {
    return { problems, tick: session.ticks.at(-1)?.tick };
  }
  const now: DebuggerTick = current;
  const known = new Set(baseline.breakpoints.map((breakpoint) => breakpoint.id));
  for (const { id } of Object.values(now.breakpoints ?? {})) {
    if (!known.has(id)) {
      await attempt(`removing breakpoint ${id}`, () => session.call("breakpoints.remove", { id }));
    }
  }
  const found = new Set(baseline.watches.map((watch) => watch.id));
  const watchIds = (now.watches ?? []).map((watch) => watch.id).filter((id) => !found.has(id));
  if (watchIds.length > 0) {
    await attempt(`removing the watches ${watchIds.join(", ")}`, () => session.call("state.unwatch", { watchIds }));
  }
  if (baseline.categories) {
    const categories = baseline.categories;
    await attempt("restoring the categories", () => session.call("breakpoints.setCategoryStates", { categories }));
  }
  if (restoreState && now.executionState?.state !== baseline.state) {
    await attempt("restoring the run state", () => session.call(baseline.state === "paused" ? "control.pause" : "control.runUntil", {}));
  }

  // the proof: a tick, newer than all of the above, that shows the state the run found
  const after = session.mark();
  await attempt("reading the state of the server after the clean-up", () => session.describe());
  const clean = await session
    .waitForTick((tick) => differencesFrom(baseline, tick, restoreState).length === 0, 2000, "a tick with the state the run found", after)
    .catch(() => undefined);
  const final = clean?.tick ?? session.latestTick().tick;
  problems.push(...differencesFrom(baseline, final, restoreState));
  return { problems, tick: final };
};
