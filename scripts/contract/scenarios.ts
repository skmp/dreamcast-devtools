import { request as httpRequest } from "node:http";
import WebSocket from "ws";
import { BINARY_FRAME_HEADER_BYTES, BinaryFrameKind, SGC_BYTES_PER_FRAME, parseBinaryFrame } from "../../src/lib/binaryFrame";
import { CAPABILITIES, PROTOCOL_BOUNDS, PanelIdSchema, TABLE_IDS } from "../../src/lib/debuggerSchema";
import type {
  BreakpointCategoryState,
  BreakpointDescriptor,
  CallstackFrame,
  DebuggerRpcSchema,
  DebuggerShape,
  DebuggerTarget,
  DebuggerTick,
  DeviceNodeDescriptor,
  DisassemblyLine,
  TargetProcessor,
} from "../../src/lib/debuggerSchema";
import { MOCK_SH4_RING, mockNextAddress } from "../../server/mockDebugger";
import {
  AICA_CALLBACK_CYCLES,
  ANCHOR_REGISTERS,
  ARM7_ENABLED_REGISTER,
  BASE_PATHS,
  DSP_REGISTER_WIDTHS,
  M1_DEVICE_TREE,
  M2_DEVICE_TREE,
  M2_TREE_ACTION,
  MILESTONES,
  REGISTER_PANEL_IDS,
  SH4_CPU_REGISTERS,
  SH4_CPU_REGISTER_WIDTH,
  TARGET_IDS,
  TARGET_TABLE,
  VBLANK_EVENT,
  capabilitiesOfMilestone,
} from "./design";
import type { Milestone } from "./design";
import { branchTarget, isArmControlFlow, isSh4ControlFlow, isSh4DelayedBranch, mnemonicOf } from "./disasm";
import { indexDescribe, registerValuePattern } from "./invariants";
import { ContractFailure, ContractSession, check, describeState, fail, monotonicNow } from "./session";
import type { BinaryRecord, TickRecord } from "./session";
import type { ElfSymbols } from "./elfSymbols";

export type Profile = "mock" | "emulator";

/**
 * - passed: every assertion of the scenario held;
 * - failed: one did not, or an invariant was violated while it ran;
 * - not-applicable: the server does not advertise what the scenario needs (or the scenario
 *   belongs to the other profile, or to the run with the DSP test program). Never a pass;
 * - partial: some of its parts passed and the rest could not be shown: a capability that is
 *   not advertised, a program that takes no interrupt. Never a pass of the scenario as a
 *   whole.
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
  /** what the scenario noted of what it met (also in `details`): `--require-note` asks for one of these */
  notes: string[];
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
   * The milestone whose gate the run is (`--milestone`): the server claims it, so S01 also
   * requires what a server of that milestone lists and advertises.
   */
  milestone?: Milestone;
  /** the server runs the DSP test program (`--dsp-program`): the second run of the M3 gate */
  dspProgram?: boolean;
  /**
   * The parts of a scenario that are run (`--parts`), by scenario id: only these, and each of
   * them has to pass. Without an entry every part of the scenario is run.
   */
  parts?: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Every breakpoint id and watch id that any tick of the run listed, on any connection: an
   * id that is in here has been used, and the server gives it to nothing new.
   */
  seen: { breakpoints: Set<number>; watches: Set<number> };
  note: (text: string) => void;
}

export { MILESTONES };
export type { Milestone };

type Outcome = void | { notApplicable: string } | { parts: PartResult[] } | { partial: string };
type Scenario = {
  id: string;
  title: string;
  /** the first milestone whose server has to pass it; M1 when absent */
  milestone?: Milestone;
  /** it applies to the emulator profile only */
  emulatorOnly?: boolean;
  /** it needs a program that loads the DSP: it belongs to the run with the DSP test program, and to no other */
  dspProgram?: boolean;
  /** the keys of its parts, for a scenario that has parts: what `--parts` names */
  parts?: readonly string[];
  run: (context: RunContext) => Promise<Outcome>;
};

const hex = (value: number) => `0x${value.toString(16).toUpperCase().padStart(8, "0")}`;
/** SH4 code addresses are compared under this mask: the same code is reachable at 0x0C.., 0x8C.. and 0xAC.. (design 2.3.3) */
const SH4_CODE_ADDRESS_MASK = 0x1fffffff;
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

/**
 * Whether the ARM7 is clocked (true) or held in reset (false), as the register ENABLED of
 * dc.aica.arm7 says in a tick: the observable of the reset (design 2.10).
 */
const arm7Clocked = (tick: DebuggerTick): boolean => {
  const { path, name } = ARM7_ENABLED_REGISTER;
  const value = registerOf(tick, path, name);
  const read = value !== undefined && /^0x[0-9A-F]+$/.test(value) ? Number.parseInt(value, 16) : undefined;
  if (read !== 0 && read !== 1) {
    return fail(
      `${path}.${name} ${value === undefined ? "is not in the paused tick" : `reads ${JSON.stringify(value)} in the paused tick`}; ` +
        "it reads 1 while the ARM7 is clocked and 0 while it is held in reset, and the ARM7 callstack of the tick follows it (2.10)",
    );
  }
  return read === 1;
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
): Promise<BreakpointDescriptor> => (await addBreakpointShown(context, params)).breakpoint;

/** `addBreakpoint`, with the tick that shows the new breakpoint. */
const addBreakpointShown = async (
  context: RunContext,
  params: { event: string; address?: number; kind?: "code" | "event"; enabled?: boolean },
): Promise<{ breakpoint: BreakpointDescriptor; record: TickRecord }> => {
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
  // kind defaults to "code" when an address is given, else "event"; enabled defaults to true
  const kind = params.kind ?? (params.address === undefined ? "event" : "code");
  check(breakpoint.kind === kind, `breakpoints.add: the tick lists kind "${breakpoint.kind}"`);
  if (kind === "event") {
    // an address that is given with an event breakpoint is ignored and not stored
    check(breakpoint.address === undefined, `breakpoints.add: the tick lists the event breakpoint with address ${String(breakpoint.address)}; an event breakpoint has none`);
  } else {
    check(breakpoint.address === params.address, `breakpoints.add: the tick lists address ${String(breakpoint.address)}, the request gave ${String(params.address)}`);
  }
  check(breakpoint.enabled === (params.enabled ?? true), `breakpoints.add: the tick lists enabled ${breakpoint.enabled}`);
  check(breakpoint.id >= 1, "breakpoint ids are allocated from 1");
  return { breakpoint, record: next };
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

/**
 * A register that has a value in `tick`, of a node outside the four base paths: one a running
 * tick that is not full does not carry. A number if there is one, else a text.
 */
const registerOutsideBasePaths = (
  session: ContractSession,
  tick: DebuggerTick,
): { path: string; name: string; expression: string; value: string } | undefined => {
  const base = new Set<string>(BASE_PATHS);
  const candidates = Array.from(session.index?.registers.keys() ?? [])
    .filter((path) => !base.has(path))
    .flatMap((path) => (tick.registers[path] ?? []).map((register) => ({ path, ...register })))
    .filter((register) => register.value !== "n/a" && register.value !== "");
  const found = candidates.find((register) => register.width > 0) ?? candidates[0];
  return found && { path: found.path, name: found.name, expression: `${found.path}.${found.name.toLowerCase()}`, value: found.value };
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

/**
 * Resumes, requires that no paused tick comes for 600 ms, then pauses again. Nothing else is
 * asked of that window: how many running ticks come in it is not looked at (the period of the
 * running tick is S03's to see, and a server's to choose).
 */
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
    // ... and has the values the normative columns of the table of 3.1 give it. Its label and
    // its default addresses are the server's choice, and its stepping follows the milestone.
    const written = (value: unknown) => (typeof value === "number" && value > 255 ? hex(value) : JSON.stringify(value));
    for (const target of targets) {
      for (const [key, fixed] of Object.entries(TARGET_TABLE[target.id] ?? {})) {
        const sent = target[key as keyof DebuggerTarget];
        expectThat(sent === fixed, `target ${target.id}: ${key} is ${written(sent)}, the table of 3.1 says ${written(fixed)}`);
      }
    }

    // What is normative of the device tree (2.8): the nodes it has from milestone M1 on, the
    // node each is shown under (as the table nests them, not by the dots of the path), and the
    // panels they open.
    const nodes = new Map<string, DeviceNodeDescriptor>();
    const parents = new Map<string, string | undefined>();
    const events = new Set<string>();
    const collect = (list: DeviceNodeDescriptor[], parent?: string) =>
      list.forEach((node) => {
        nodes.set(node.path, node);
        parents.set(node.path, parent);
        (node.events ?? []).forEach((event) => events.add(event));
        collect(node.children ?? [], node.path);
      });
    collect(shape.deviceTree);
    for (const row of M1_DEVICE_TREE) {
      const node = nodes.get(row.path);
      expectThat(node, `the device tree has no node ${row.path}, which the table of 2.8 lists for milestone M1`);
      if (!node) {
        continue;
      }
      const parent = parents.get(row.path);
      expectThat(
        parent === row.parent,
        `${row.path} is ${parent === undefined ? "a root of the device tree" : `under ${parent}`}, the table of 2.8 has it ${row.parent === undefined ? "as the root" : `under ${row.parent}`}`,
      );
      for (const action of row.actions ?? []) {
        expectThat(node.actions?.includes(action), `${row.path}: the action "${action}" of the table of 2.8 is missing`);
      }
    }
    // ... the three anchor registers ...
    for (const anchor of ANCHOR_REGISTERS) {
      expectThat(
        nodes.get(anchor.path)?.registers?.some((register) => register.name === anchor.name),
        `${anchor.path} has no register ${anchor.name}, one of the three anchor registers of 2.8`,
      );
    }
    // ... and a fourth one of a server that lists the ARM7: the bit that says whether the ARM7
    // is clocked or held in reset, which S11 reads the ARM7 callstack against ...
    if (ids.includes("arm7")) {
      const { path, name, width } = ARM7_ENABLED_REGISTER;
      const enabled = nodes.get(path)?.registers?.find((register) => register.name === name);
      expectThat(enabled, `${path} has no register ${name}, the anchor register of 2.8 that says whether the ARM7 is clocked; a server that lists the target arm7 has it`);
      expectThat(!enabled || enabled.width === width, `${path}.${name} has width ${enabled?.width}, 2.8 says ${width}`);
    }
    // ... the widths of the DSP's registers, of each one the server lists (the anchor, STEP, is
    // the only one that has to be there) ...
    for (const register of nodes.get("dc.aica.dsp")?.registers ?? []) {
      const width = DSP_REGISTER_WIDTHS.get(register.name);
      expectThat(width === undefined || register.width === width, `dc.aica.dsp.${register.name} has width ${register.width}, 2.8 says ${width}`);
    }
    // ... the register list of dc.sh4.cpu: the names of 2.8 in their order, all of width 32 ...
    const cpu = nodes.get("dc.sh4.cpu")?.registers;
    if (cpu) {
      const names = cpu.map((register) => register.name);
      const missing = SH4_CPU_REGISTERS.filter((name) => !names.includes(name));
      const extra = names.filter((name) => !SH4_CPU_REGISTERS.includes(name));
      expectThat(missing.length === 0, `dc.sh4.cpu lacks ${missing.join(" ")}; its register list is that of 2.8`);
      expectThat(extra.length === 0, `dc.sh4.cpu lists ${extra.join(" ")}, which the register list of 2.8 does not have`);
      expectThat(
        missing.length > 0 || extra.length > 0 || names.join(" ") === SH4_CPU_REGISTERS.join(" "),
        `the registers of dc.sh4.cpu are not in the order of 2.8: they are ${names.join(" ")}`,
      );
      const widths = cpu.filter((register) => register.width !== SH4_CPU_REGISTER_WIDTH).map((register) => `${register.name} (${register.width})`);
      expectThat(widths.length === 0, `the registers of dc.sh4.cpu have width ${SH4_CPU_REGISTER_WIDTH}; not so ${widths.join(", ")}`);
    }
    // ... and the event of the vertical blank, which every running machine raises
    expectThat(events.has(VBLANK_EVENT), `no node of the device tree lists the event ${VBLANK_EVENT}, which every server lists (2.6)`);

    // Under the gate of a milestone the server claims that milestone: it lists the three
    // targets, and advertises the capabilities of the milestone.
    if (context.milestone) {
      for (const id of TARGET_IDS) {
        expectThat(ids.includes(id), `the gate of ${context.milestone}: the target ${id} is not listed; a server of a milestone lists sh4, arm7 and dsp (3.1)`);
      }
      for (const capability of capabilitiesOfMilestone(context.milestone)) {
        expectThat(shape.capabilities?.includes(capability), `the gate of ${context.milestone}: the capability "${capability}" is not advertised (3.1)`);
      }
      // from M2 on the ARM7 steps: without the flag the ARM7 part of S16 would only be "not applicable"
      if (MILESTONES.indexOf(context.milestone) >= MILESTONES.indexOf("M2") && ids.includes("arm7")) {
        expectThat(
          targets.find((target) => target.id === "arm7")?.stepping === true,
          `the gate of ${context.milestone}: targets: arm7.stepping is not true; a server of milestone M2 steps the ARM7 and takes its code breakpoints (3.1)`,
        );
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

    // A further pause returns {} and changes nothing, whatever target it names: there is one run
    // state, so the target is ignored when it is one of the three target ids, also when the
    // server does not list that target.
    const again = session.mark();
    for (const target of TARGET_IDS) {
      await session.call("control.pause", { target });
    }
    const later = await session.collectTicks(300);
    for (const record of [...session.ticksSince(again), ...later]) {
      check(
        isPaused(record.tick) && stopIdOf(record.tick) === stopIdOf(paused.tick),
        `a further control.pause changes nothing; a tick says ${describeState(record.tick)}`,
      );
    }
    // any other string is not a target id: in-band -32602
    await session.expectError("control.pause", { target: "gpu" }, -32602);
  },
};

const s03: Scenario = {
  id: "S03",
  title: "resume",
  async run(context) {
    const { session } = context;
    const paused = await ensurePaused(context);
    const sh4 = requireTarget(context, "sh4");
    // Three watches for the time the target runs: watches are evaluated in every tick, whatever
    // paths it carries. The invariants compare every watch of every tick with its register;
    // one of these is on the scheduler time, which moves; one on the SH4, whose context some
    // backends do not have while running (the watch then reads "n/a"); and one on a register
    // of a path that a running tick does not carry, which goes on reading its value.
    const keepWatch = async (expression: string): Promise<{ id: number; added: boolean }> => {
      const stored = (session.latestTick().tick.watches ?? []).find((watch) => watch.expression === expression);
      return stored ? { id: stored.id, added: false } : { id: (await addWatch(context, expression, expression)).id, added: true };
    };
    check(
      session.index?.registers.get("dc.timing")?.some((register) => register.name === "SH4_CYCLES"),
      "the device tree has dc.timing.SH4_CYCLES: the time of the SH4 is read from it (2.8)",
    );
    const cyclesWatch = await keepWatch("dc.timing.sh4_cycles");
    const pcWatch = await keepWatch(`${sh4.pcPath}.${sh4.pcRegister.toLowerCase()}`);
    // (some registers read "n/a" always: the one to watch is one that has a value at this stop)
    const outside = registerOutsideBasePaths(session, paused.tick);
    const outsideWatch = outside ? await keepWatch(outside.expression) : undefined;
    if (!outside) {
      context.note("no register outside the four base paths has a value at the stop: no watch was kept on a path that running ticks do not carry");
    }

    const mark = session.mark();
    await session.call("control.runUntil", {});
    const running = await session.waitForTick(isRunning, 1000, "a running tick after control.runUntil", mark);
    check(stopIdOf(running.tick) === stopIdOf(paused.tick), "a resume does not change stopId");
    const more = await session.collectTicks(1500);
    const runningTicks = [running, ...more.filter((record) => isRunning(record.tick))];
    check(runningTicks.length >= 3, `${runningTicks.length - 1} running tick(s) in 1.5 s after the first one; the running tick is periodic`);

    const kept = [cyclesWatch, pcWatch, outsideWatch].filter((watch) => watch !== undefined);
    const readingsOf = (id: number) => runningTicks.map((record) => (record.tick.watches ?? []).find((entry) => entry.id === id)?.value);
    for (const watch of kept) {
      const missing = runningTicks.find((record) => !(record.tick.watches ?? []).some((entry) => entry.id === watch.id));
      check(!missing, `watch ${watch.id} is not listed in the running tick ${missing?.tick.tickId}; watches are evaluated in every tick`);
    }
    const moving = readingsOf(cyclesWatch.id);
    check(new Set(moving).size > 1, `the watch on dc.timing.sh4_cycles reads ${JSON.stringify(moving[0])} in every running tick; watches are evaluated in every tick`);
    if (outside && outsideWatch) {
      const unread = runningTicks.find((record) => (record.tick.watches ?? []).find((entry) => entry.id === outsideWatch.id)?.value === "n/a");
      check(
        !unread,
        `the watch on ${outside.expression} reads "n/a" in the running tick ${unread?.tick.tickId}${unread && outside.path in unread.tick.registers ? "" : `, which does not carry ${outside.path}`}; ` +
          `it read ${JSON.stringify(outside.value)} at the stop before the resume, and a watch is evaluated in every tick, whatever paths the tick carries`,
      );
    }

    // the machine advances between them: the time is in every running tick, and it moves
    const cycles = runningTicks.map((record) => cyclesOf(record.tick));
    check(!cycles.includes(undefined), "dc.timing.SH4_CYCLES is in every running tick: dc.timing is one of the four base paths");
    check(new Set(cycles.map(String)).size > 1, `dc.timing.SH4_CYCLES is ${cycles[0]} in every running tick`);

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
    /** the step before the one that is being made ended at an exception vector */
    let afterVector = false;

    /** One step from where the target is, with what holds for every step; `atVector`: it ended at an exception vector. */
    const step = async (method: "control.step" | "control.stepOver" = "control.step"): Promise<{ pc0: number; pc1: number; atVector: boolean }> => {
      const pc0 = pcOf(record.tick, sh4);
      const cycles0 = cyclesOf(record.tick) ?? fail("dc.timing.SH4_CYCLES is in every paused tick (2.8)");
      record = await stepOnce(context, "sh4", method);
      const pc1 = pcOf(record.tick, sh4);
      const cycles1 = cyclesOf(record.tick) ?? fail("dc.timing.SH4_CYCLES is in every paused tick (2.8)");

      const vbr = registerOf(record.tick, sh4.pcPath, "VBR");
      const vectorBase = vbr !== undefined && /^0x[0-9A-F]+$/.test(vbr) ? Number.parseInt(vbr, 16) : undefined;
      const vectors = vectorBase === undefined ? [] : [0x100, 0x400, 0x600].map((offset) => (vectorBase + offset) >>> 0);
      const atVector = vectors.includes(pc1) || pc1 === 0xa0000000;

      check(cycles1 >= cycles0, `dc.timing.SH4_CYCLES went back from ${cycles0} to ${cycles1} in a step`);
      // a deferred interrupt can end the step before an instruction runs
      check(cycles1 > cycles0 || atVector, "dc.timing.SH4_CYCLES did not increase in a step that did not end at an exception vector");
      // One step may end that way. The step after it starts at the first instruction of the
      // handler with SR.BL set, and cannot be interrupted: a second one in a row that ends at a
      // vector is a step that does not execute.
      check(
        !(atVector && afterVector),
        `two steps in a row ended at an exception vector: the step to ${hex(pc0)}, and ${method} {sh4} from there, which ended at ${hex(pc1)}. ` +
          "One step may (a deferred interrupt is accepted before an instruction runs); the step after it starts in the handler with SR.BL set and cannot be interrupted",
      );
      afterVector = atVector;
      // Mock: its program is known. A step in its loop ends at the next address of the loop (no
      // vertical blank falls into a step); in its interrupt handler the general rule is all there is.
      if (context.profile === "mock" && pc0 >= MOCK_SH4_RING.base && pc0 < MOCK_SH4_RING.base + MOCK_SH4_RING.length * MOCK_SH4_RING.instructionSize) {
        check(pc1 === mockNextAddress("sh4", pc0), `mock: the step from ${hex(pc0)} ended at ${hex(pc1)}, the next address of its loop is ${hex(mockNextAddress("sh4", pc0))}`);
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

    // One instruction per step: from a line that is not control flow the step ends at PC + 2.
    // One step may end at an exception vector instead, which shows nothing about that. The
    // target is then in the handler, where no interrupt is accepted, and the step from the next
    // plain line has to show it.
    let text = await stepToPlainLine();
    let made = await step();
    const deferred = made.atVector;
    if (deferred) {
      text = await stepToPlainLine();
      made = await step();
    }
    check(
      made.pc1 === ((made.pc0 + 2) >>> 0),
      `"${text}" at ${hex(made.pc0)} is not control flow, and the step ended at ${hex(made.pc1)}, not at ${hex(made.pc0 + 2)}` +
        (deferred ? ": a step before it ended at an exception vector, which one step may, and the step from the next plain line has to show the instruction" : " or an exception vector"),
    );

    // control.stepOver on a line that is not a call is a step
    text = await stepToPlainLine();
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
    const { session } = context;
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

    // The breakpoint the stop reports is removed during the stop: the paused ticks of that stop
    // keep the stopId and the reason, and stop carrying its id (a breakpointId is always a key
    // of `breakpoints` in the same tick). The twin on the same address is still listed, and is
    // not what the stop reports now.
    const removing = session.mark();
    await session.call("breakpoints.remove", { id: lowest });
    const after = await tickShowing(session, removing, "breakpoints.remove", (tick) => (String(lowest) in tick.breakpoints ? `breakpoint ${lowest} is still listed` : undefined));
    check(
      isPaused(after.tick) && stopIdOf(after.tick) === stopIdOf(hit.tick),
      `removing the breakpoint of a stop does not end the stop: the tick after breakpoints.remove {${lowest}} is ${describeState(after.tick)}, the stop was ${stopIdOf(hit.tick)}`,
    );
    check(
      after.tick.executionState.breakpointId === undefined,
      `after breakpoints.remove {${lowest}} a paused tick of the same stop carries breakpointId ${after.tick.executionState.breakpointId}; the ticks of a stop stop carrying the id of a breakpoint that was removed`,
    );
    check(
      after.tick.executionState.reason === "breakpoint",
      `after breakpoints.remove {${lowest}} the paused tick of the same stop has reason "${after.tick.executionState.reason}"; the reason stays "breakpoint"`,
    );
    await removeBreakpoint(context, lowest === breakpoint.id ? twin.id : breakpoint.id);
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
      // A step from the stop of a breakpoint that is still listed executes the instruction of the
      // stop: it is a stop of its own, with reason "step", and does not carry the id of that breakpoint.
      await stepOnce(context, "sh4");
      await setCategories(context, original);
      await removeBreakpoint(context, breakpoint.id);
    } finally {
      await session.call("breakpoints.setCategoryStates", { categories: original }).catch(() => undefined);
    }
  },
};

/**
 * The interrupt entry of the SH4, `VBR + 0x600`, as a paused tick has it: where every program
 * with interrupts enabled arrives at each vertical blank.
 */
const interruptEntryOf = (tick: DebuggerTick, sh4: DebuggerTarget): number => (numberOf(tick, sh4.pcPath, "VBR") + 0x600) >>> 0;

const eventIdOf = (entry: { eventId: string }): bigint => (/^\d+$/.test(entry.eventId) ? BigInt(entry.eventId) : -1n);

/** The newest eventId in the log of a tick; -1 for an empty log. */
const newestEventId = (tick: DebuggerTick): bigint => tick.eventLog.reduce((newest, entry) => (eventIdOf(entry) > newest ? eventIdOf(entry) : newest), -1n);

/** How many entries of `event` the log of a tick has that are newer than `after`. */
const eventsSince = (tick: DebuggerTick, event: string, after: bigint): number =>
  tick.eventLog.filter((entry) => (entry.metadata as { event?: unknown } | undefined)?.event === event && eventIdOf(entry) > after).length;

const vblanksSince = (tick: DebuggerTick, after: bigint): number => eventsSince(tick, VBLANK_EVENT, after);

/** The event of the SH4 accepting an interrupt, if the server has it (2.6): each one is an arrival at `VBR + 0x600`. */
const INTERRUPT_EVENT = "dc.sh4.interrupt";

/**
 * Disabled event breakpoints that put events into the event log (high-rate events are logged
 * only while a breakpoint on them exists): on the vertical blank, and, when the device tree
 * lists it, on the interrupts the SH4 accepts.
 */
const addEventCounters = async (context: RunContext): Promise<BreakpointDescriptor[]> => {
  const counters = [await addBreakpoint(context, { event: VBLANK_EVENT, kind: "event", enabled: false })];
  if (context.session.index?.events.has(INTERRUPT_EVENT)) {
    counters.push(await addBreakpoint(context, { event: INTERRUPT_EVENT, kind: "event", enabled: false }));
  }
  return counters;
};

/** A paused tick that reports the stop of a breakpoint at the interrupt entry (the PC can be a mirror of it). */
const checkEntryStop = (tick: DebuggerTick, sh4: DebuggerTarget, id: number, entry: number): void => {
  check(tick.executionState.breakpointId === id, `the stop reports breakpointId ${tick.executionState.breakpointId}, expected ${id}`);
  check(tick.executionState.reason === "breakpoint", `the stop has reason "${tick.executionState.reason}", expected "breakpoint"`);
  check(((pcOf(tick, sh4) ^ entry) & SH4_CODE_ADDRESS_MASK) === 0, `the stop is at ${hex(pcOf(tick, sh4))}, the breakpoint at the interrupt entry ${hex(entry)}`);
};

/**
 * The breakpoint at the interrupt entry was not hit in the scenario's window. That makes the
 * scenario partial: the program takes no interrupt, and what the scenario wants to show
 * cannot be shown with it. This returns the reason. Unless the event log says otherwise: when
 * it has at least `least` entries of the SH4 accepting an interrupt that are newer than
 * `after`, the SH4 came to its interrupt entry and was not stopped, and the scenario fails.
 */
const missedInterruptEntry = (session: ContractSession, entry: number, after: bigint, least: number, notShown: string): string => {
  const accepted = eventsSince(session.latestTick().tick, INTERRUPT_EVENT, after);
  if (accepted >= least) {
    fail(
      `the breakpoint at the interrupt entry ${hex(entry)} (VBR + 0x600) was not hit within ${session.scale(2000)} ms, ` +
        `and the event log has ${accepted} entries of ${INTERRUPT_EVENT} from that time: the SH4 came there and was not stopped`,
    );
  }
  return `the target took no interrupt within ${session.scale(2000)} ms: the breakpoint at its interrupt entry ${hex(entry)} (VBR + 0x600) was not hit, so ${notShown}`;
};

/**
 * Re-enabling a breakpoint, shown where the program is certain to come again: at the interrupt
 * entry `VBR + 0x600`. From a stop that the target has run up to (not the anchor of S00,
 * where the program has not installed its vector base): a breakpoint there is hit; disabled,
 * the target runs through at least two further vertical blanks; enabled again while it runs,
 * it is hit within 2 s. Returns why this could not be shown, when the target takes no interrupt.
 */
const reenableAtInterruptEntry = async (context: RunContext, sh4: DebuggerTarget): Promise<string | undefined> => {
  const { session } = context;
  const stop = (await ensurePaused(context)).tick;
  const entry = interruptEntryOf(stop, sh4);
  // a disabled event breakpoint on the vertical blank puts its events into the event log
  const counters = await addEventCounters(context);
  const atEntry = await addBreakpoint(context, { event: sh4.breakpointEvent, address: entry, kind: "code", enabled: true });
  const armed = newestEventId(session.latestTick().tick);
  let partial: string | undefined;

  const mark = session.mark();
  await session.call("control.runUntil", {});
  const first = await session
    .waitForTick((tick) => isPaused(tick) && stopIdOf(tick) > stopIdOf(stop), 2000, `a paused tick at the interrupt entry ${hex(entry)}`, mark)
    .catch(() => undefined);
  if (!first) {
    partial = missedInterruptEntry(session, entry, armed, 1, "it was not shown that a breakpoint that is enabled again is hit");
    await ensurePaused(context);
  } else {
    checkEntryStop(first.tick, sh4, atEntry.id, entry);

    // disabled, it is passed: the target runs through its vertical blanks
    await toggleBreakpoint(context, atEntry.id, false);
    const newest = newestEventId(session.latestTick().tick);
    const resumed = session.mark();
    await session.call("control.runUntil", {});
    const stopped = (tick: DebuggerTick) => isPaused(tick) && stopIdOf(tick) > stopIdOf(first.tick);
    const ran = await session.waitForTick(
      (tick) => stopped(tick) || (isRunning(tick) && vblanksSince(tick, newest) >= 2),
      2000,
      `two further entries of ${VBLANK_EVENT} in the event log of the running target (a disabled event breakpoint on it puts them there)`,
      resumed,
    );
    check(isRunning(ran.tick), `a disabled breakpoint at the interrupt entry ${hex(entry)}: the target stopped (${describeState(ran.tick)})`);

    // enabled again while the target runs, it is hit at the next vertical blank
    const enabling = session.mark();
    await session.call("breakpoints.toggle", { id: atEntry.id, enabled: true });
    await tickShowing(session, enabling, "breakpoints.toggle", (tick) =>
      tick.breakpoints[String(atEntry.id)]?.enabled === true ? undefined : `breakpoint ${atEntry.id} is not listed as enabled`,
    );
    const again = await session.waitForTick(stopped, 2000, `a paused tick at the breakpoint ${hex(entry)} after it was enabled again`, enabling);
    checkEntryStop(again.tick, sh4, atEntry.id, entry);
  }
  await removeBreakpoint(context, atEntry.id);
  for (const counter of counters) {
    await removeBreakpoint(context, counter.id);
  }
  return partial;
};

const s07: Scenario = {
  id: "S07",
  title: "toggle, remove, events",
  async run(context) {
    const { session } = context;
    const sh4 = requireTarget(context, "sh4");
    // S07 needs what milestone M1 has: without event breakpoints it fails, it is not skipped
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

    // A disabled breakpoint is not hit (as S06) ...
    const pc = await findBreakpointSite(context);
    const address = pc + sh4.instructionSize;
    // (without kind and enabled: a breakpoint with an address is a code breakpoint, and enabled)
    const breakpoint = await addBreakpoint(context, { event: sh4.breakpointEvent, address });
    await toggleBreakpoint(context, breakpoint.id, false);
    await expectToKeepRunning(context, "a disabled breakpoint on the next instruction");
    // ... and Remove deletes it: removing again and toggling an unknown id are in-band -32602
    await removeBreakpoint(context, breakpoint.id);
    await session.expectError("breakpoints.remove", { id: breakpoint.id }, -32602);
    await session.expectError("breakpoints.toggle", { id: breakpoint.id, enabled: true }, -32602);

    // Enabled again, a breakpoint is hit again: at the interrupt entry, from the stop the first
    // part ended in, which the target has run up to.
    const partial = await reenableAtInterruptEntry(context, sh4);

    // Event breakpoints. Every event the device tree lists is in the server's table: a
    // breakpoint on each, added disabled (an enabled one stops the target when its event
    // comes) with the request the UI sends, i.e. with the kind.
    await ensurePaused(context);
    const disabled: BreakpointDescriptor[] = [];
    const others = events.filter((name) => name !== VBLANK_EVENT);
    for (const [position, event] of others.entries()) {
      // (the last one is sent with an address, which an event breakpoint does not have: it is ignored, and not listed)
      const address = position === others.length - 1 ? { address: sh4.defaultDisassemblyAddress } : {};
      disabled.push(await addBreakpoint(context, { event, kind: "event", enabled: false, ...address }));
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

    return partial === undefined ? undefined : { partial };
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
    // There is no wrap-around: a byte above the last address of the target is not readable
    // (2.7). 32 bytes from 16 below the end of the SH4's address space: a server that reads
    // something there answers with the second half unreadable and zero, one that reads
    // nothing there with -32010. What fails is a second half that reads the start of memory.
    const top = sh4.addressMax - 15;
    const across = await session.outcome("state.getMemorySlice", { target: "sh4", address: top, length: 32 });
    if ("error" in across) {
      check(
        across.error.code === -32010,
        `a read of 32 bytes at ${hex(top)}, across the last address of the sh4: the error ${across.error.code} "${across.error.message}", expected data whose second half is unreadable, or -32010`,
      );
    } else {
      const read = across.result as { data: number[]; unreadable?: Array<[number, number]> };
      check(read.data.length === 32, `a read of 32 bytes at ${hex(top)} returns ${read.data.length} bytes`);
      const unreadable = new Set((read.unreadable ?? []).flatMap(([offset, length]) => Array.from({ length }, (_, position) => offset + position)));
      const readable = Array.from({ length: 16 }, (_, position) => 16 + position).filter((offset) => !unreadable.has(offset) || read.data[offset] !== 0);
      check(
        readable.length === 0,
        `a read of 32 bytes at ${hex(top)} goes ${readable.length} byte${readable.length === 1 ? "" : "s"} past the last address of the sh4 (${hex(sh4.addressMax)}): ` +
          `it lists unreadable ${JSON.stringify(read.unreadable)}, and the bytes behind the end are ${JSON.stringify(read.data.slice(16))}; a read does not wrap, those bytes are unreadable and 0`,
      );
    }

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
        if (line.bytes !== "??") {
          // one pair for each byte of an instruction; a DSP step is its four MPRO words, each high byte first: 8 pairs
          const pairs = target.id === "dsp" ? 8 : target.instructionSize;
          check(line.bytes.split(" ").length === pairs, `${target.id}: "${line.bytes}" are not ${pairs} bytes`);
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
      // there is no wrap-around: an address above addressMax is refused
      await session.expectError("state.getDisassembly", { target: target.id, address: last + target.instructionSize, count: 1 }, -32602);
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
    check(frames[0].location === undefined, `frame 0 is the PC and has no location, this one has "${frames[0].location}"`);
    check(frames.length >= 2, `frame 1 is PR; the SH4 callstack of the tick has ${frames.length} frame`);
    check(frames[1].pc === numberOf(paused.tick, sh4.pcPath, "PR"), `frame 1 is at ${hex(frames[1].pc)}, PR is ${registerOf(paused.tick, sh4.pcPath, "PR")}`);
    check(frames[1].location === "pr", `frame 1 has location "${frames[1].location}", expected "pr"`);
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

    // The ARM7, if the server lists it. Whether it is clocked or held in reset is told by the
    // register ENABLED of dc.aica.arm7 in the same paused tick, and its callstack follows that
    // register in both directions (2.10). Clocked: at least two frames, frame 0 its PC and
    // frame 1 its link register R14, and what the stack scan finds behind them. Held in reset:
    // no frames. state.getCallstack {arm7}, asked at that stop, agrees with the register in
    // the same way.
    const arm7 = targetOf(session.shape, "arm7");
    if (arm7) {
      const clocked = arm7Clocked(paused.tick);
      const says = `${ARM7_ENABLED_REGISTER.path}.${ARM7_ENABLED_REGISTER.name} reads ${clocked ? "1 (the ARM7 is clocked)" : "0 (the ARM7 is held in reset)"}`;
      /** `frames`, of the tick or of an answer, are what the register says the ARM7 has at this stop. */
      const followsRegister = (frames: CallstackFrame[], where: string, label: string): void => {
        const count = `${frames.length} frame${frames.length === 1 ? "" : "s"}`;
        if (!clocked) {
          check(frames.length === 0, `${says}, and ${where} has ${count}; it has none then`);
          return;
        }
        check(frames.length >= 2, `${says}, and ${where} has ${count}; it has at least two then (frame 0 the PC, frame 1 the link register)`);
        check(frames[0].pc === pcOf(paused.tick, arm7), `${label}: frame 0 is at ${hex(frames[0].pc)}, the PC is ${hex(pcOf(paused.tick, arm7))}`);
        check(frames[0].location === undefined, `${label}: frame 0 is the PC and has no location, this one has "${frames[0].location}"`);
        check(
          frames[1].pc === numberOf(paused.tick, arm7.pcPath, "R14"),
          `${label}: frame 1 is at ${hex(frames[1].pc)}, R14 is ${registerOf(paused.tick, arm7.pcPath, "R14")}`,
        );
        check(frames[1].location === "lr", `${label}: frame 1 has location "${frames[1].location}", expected "lr"`);
        frames.forEach((frame, position) => check(frame.index === position, `${label}: frame ${position} has index ${frame.index}`));
        for (const frame of frames.slice(2)) {
          check(/^stack\+0x[0-9A-Fa-f]+$/.test(frame.location ?? ""), `${label}: frame ${frame.index} has location "${frame.location}", expected "stack+0x.."`);
        }
      };
      followsRegister(paused.tick.callstacks?.arm7 ?? [], "the ARM7 callstack of the same paused tick", "arm7");
      const fromArm7 = await session.call("state.getCallstack", { target: "arm7", maxFrames: 8 });
      check(fromArm7.target === "arm7", `state.getCallstack {arm7} answers for target "${fromArm7.target}"`);
      check(fromArm7.frames.length <= 8, `state.getCallstack {arm7, maxFrames: 8} returned ${fromArm7.frames.length} frames`);
      followsRegister(fromArm7.frames, "state.getCallstack {arm7, maxFrames: 8} at that stop", "state.getCallstack {arm7, maxFrames: 8}");
      // without maxFrames it works
      const whole = await session.call("state.getCallstack", { target: "arm7" });
      check(whole.frames.length <= PROTOCOL_BOUNDS.callstackMaxFrames.default, `state.getCallstack {arm7} without maxFrames returned ${whole.frames.length} frames; maxFrames defaults to 32`);
      followsRegister(whole.frames, "state.getCallstack {arm7} at that stop", "state.getCallstack {arm7}");
      if (!clocked) {
        context.note("the ARM7 is held in reset: its callstack is empty");
      }
    }

    // running ticks carry both arrays, empty
    const running = await ensureRunning(context);
    check(running.tick.callstacks?.sh4?.length === 0 && running.tick.callstacks?.arm7?.length === 0, "a running tick carries empty callstacks");
    await ensurePaused(context);
  },
};

/** What a raw WebSocket saw next: a text frame that is not a tick, or the end of the connection with its close code. */
type RawOutcome = { text: string } | { closed: number };

/**
 * A raw WebSocket (the `ws` package), for what the client classes cannot send. Ticks, which
 * every connection receives, are skipped.
 */
interface RawSocket {
  send(text: string): void;
  /** the next frame that is not a tick, or how the connection ended; undefined when neither came within `timeoutMs` */
  next(timeoutMs: number): Promise<RawOutcome | undefined>;
  close(): void;
}

const openRaw = (url: string): Promise<RawSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const seen: RawOutcome[] = [];
    let waiting: (() => void) | undefined;
    const push = (outcome: RawOutcome) => {
      seen.push(outcome);
      waiting?.();
    };
    // (after the connection is open, an error is followed by its close event: that is what is reported)
    socket.on("error", (error) => reject(new ContractFailure(`raw WebSocket: ${error.message}`)));
    socket.on("message", (data, isBinary) => {
      const text = data.toString();
      if (!isBinary && !/"method"\s*:\s*"event\.tick"/.test(text.slice(0, 200))) {
        push({ text });
      }
    });
    socket.on("close", (code) => push({ closed: code }));
    socket.once("open", () =>
      resolve({
        send: (text) => socket.send(text),
        close: () => socket.close(),
        next: (timeoutMs) =>
          new Promise((done) => {
            const take = () => {
              clearTimeout(timer);
              waiting = undefined;
              done(seen.shift());
            };
            const timer = setTimeout(take, timeoutMs);
            if (seen.length > 0) {
              take();
            } else {
              waiting = take;
            }
          }),
      }),
    );
  });

/** One exchange on a raw WebSocket: what the server answers to `text`. */
const rawExchange = async (url: string, text: string, timeoutMs: number, what: string): Promise<string> => {
  const socket = await openRaw(url);
  try {
    socket.send(text);
    const outcome = await socket.next(timeoutMs);
    if (!outcome) {
      return fail(`no answer to ${what} within ${timeoutMs} ms`);
    }
    return "text" in outcome ? outcome.text : fail(`the connection was closed (code ${outcome.closed}) in answer to ${what}`);
  } finally {
    socket.close();
  }
};

/** A JSON object as a text of exactly `bytes` bytes: padded with white space, which JSON allows between its tokens. */
const paddedTo = (message: Record<string, unknown>, bytes: number): string => {
  const text = JSON.stringify(message);
  return `${text.slice(0, -1)}${" ".repeat(bytes - Buffer.byteLength(text))}}`;
};

const parsedObject = (text: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Whether `text` is a JSON-RPC error response with `code`: the keys jsonrpc, id and error, and
 * an error of `code` and a message that is not empty (its wording is the server's, design 3.5).
 */
const isErrorAnswer = (text: string, code: number): boolean => {
  let reply: unknown;
  try {
    reply = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof reply !== "object" || reply === null || Array.isArray(reply)) {
    return false;
  }
  const { jsonrpc, error, ...rest } = reply as Record<string, unknown>;
  const { code: sent, message, ...more } = (typeof error === "object" && error !== null ? error : {}) as Record<string, unknown>;
  return (
    jsonrpc === "2.0" &&
    sent === code &&
    typeof message === "string" &&
    message.length > 0 &&
    Object.keys(more).length === 0 &&
    Object.keys(rest).every((key) => key === "id")
  );
};

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
    await session.expectError("control.stepOver", { target: "dsp" }, -32004);
    await session.expectError("control.stepOut", { target: "dsp" }, -32004);
    // a target without stepping: its steps and code breakpoints are -32004
    for (const target of session.shape.targets ?? []) {
      if (!target.stepping) {
        await session.expectError("control.step", { target: target.id }, -32004);
        await session.expectError("breakpoints.add", { event: target.breakpointEvent, address: 0 }, -32004);
      }
    }
    // A method whose capability the server does not advertise: -32004 on the method's channel.
    // That is decided before the parameters are looked at (3.0, which error wins): the same
    // request without a parameter it requires is still "not supported", not "invalid params".
    const optional: Array<{ capability: string; method: string; params: Record<string, unknown>; required?: string }> = [
      { capability: CAPABILITIES.RESET, method: "control.reset", params: {} },
      { capability: CAPABILITIES.MEMORY_WRITE, method: "state.writeMemory", params: { target: "sh4", address: 0x8c010000, data: [0] }, required: "data" },
      { capability: CAPABILITIES.MEMORY_BINARY, method: "state.getMemoryBinary", params: { target: "sh4", address: 0x8c010000, length: 16 }, required: "length" },
      { capability: CAPABILITIES.TABLES, method: "state.getTable", params: { id: "sq" }, required: "id" },
      { capability: CAPABILITIES.HOLLY_CAPTURE, method: "state.captureHolly", params: { what: "ta" }, required: "what" },
      { capability: CAPABILITIES.SGC_CAPTURE, method: "state.recordSgcFrames", params: { frames: 1 } },
      { capability: CAPABILITIES.SGC_CAPTURE, method: "state.getSgcFrameData", params: {} },
      { capability: CAPABILITIES.REGISTER_WRITE, method: "state.setRegister", params: { path: sh4.pcPath, name: "R0", value: "0" }, required: "value" },
    ];
    for (const probe of optional) {
      if (hasCapability(context, probe.capability)) {
        continue;
      }
      await session.expectError(probe.method, probe.params, -32004);
      if (probe.required) {
        const { [probe.required]: _omitted, ...incomplete } = probe.params;
        await session.expectError(probe.method, incomplete, -32004);
      }
    }
    if (!hasCapability(context, CAPABILITIES.REGISTER_WRITE)) {
      // state.editWatch is state.setRegister on the watched register, and -32004 until then. The
      // request is a valid one: a watch that exists, and the value its register has.
      const register = unwatchedRegister(context, sh4.pcPath, ["R0", "R1", "R2"]);
      const { id, record } = await addWatch(context, register.expression, register.expression);
      const value = record.tick.watches?.find((watch) => watch.id === id)?.value;
      await session.expectError("state.editWatch", { watchId: id, value: typeof value === "string" && value.startsWith("0x") ? value : "0" }, -32004);
      await session.expectError("state.editWatch", { watchId: id }, -32004);
      await unwatch(context, id);
    }

    // What follows is sent on raw sockets. A request that would leave something behind if it
    // were executed, where it must not be: a disabled code breakpoint.
    const wait = session.scale(2000);
    const leftBehind = { event: sh4.breakpointEvent, address: (sh4.defaultDisassemblyAddress & ~1) >>> 0, kind: "code", enabled: false };
    const breakpointCount = async () => Object.keys((await session.describe()).tick.breakpoints).length;
    const describe = (id: number) => ({ jsonrpc: "2.0", id, method: "debugger.describe", params: {} });

    // malformed JSON: -32700 with id null, a message, and nothing else in the answer
    const answer = await rawExchange(context.url, "{nope", wait, "malformed JSON");
    check(
      isErrorAnswer(answer, -32700) && parsedObject(answer)?.id === null,
      `the answer to malformed JSON is ${answer.slice(0, 200)}, expected {"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"..."}}`,
    );

    // What is JSON and not a request object of this protocol: -32600. There are no batches (a
    // JSON array is not executed), requests are objects with jsonrpc "2.0", a numeric id, a
    // method and, if any, params that are an object. The id of the answer echoes the id of the
    // request when that is a number, and is null otherwise: also for a malformed message
    // without an id, which is answered, not taken for a notification.
    const { jsonrpc: _version, ...withoutVersion } = describe(7);
    const { id: _id, ...withoutVersionOrId } = withoutVersion;
    const { method: _method, ...withoutMethod } = describe(8);
    const invalid: Array<[what: string, frame: unknown, id: number | null]> = [
      ["a batch (a JSON array of requests)", [describe(1)], null],
      ["a frame that is JSON and not an object (42)", 42, null],
      ["a request without the jsonrpc member", withoutVersion, 7],
      ["a message without the jsonrpc member and without an id", withoutVersionOrId, null],
      ["a request whose id is a string", { ...describe(1), id: "1" }, null],
      ["a request without a method", withoutMethod, 8],
      ["a request whose params is not an object", { ...describe(9), params: [3] }, 9],
    ];
    for (const [what, frame, id] of invalid) {
      const text = await rawExchange(context.url, JSON.stringify(frame), wait, what);
      check(isErrorAnswer(text, -32600), `${what} is answered with ${text.slice(0, 200)}, expected the JSON-RPC error -32600 with a message, and nothing else`);
      const echoed = parsedObject(text)?.id;
      check(
        echoed === id,
        `${what} is answered with id ${JSON.stringify(echoed)}, expected ${JSON.stringify(id)}: the answer echoes the id of the request when that is a number, and is null otherwise`,
      );
    }

    // A well-formed message without an id is a notification from the client: it is ignored, and
    // gets no answer. The first thing the socket hears is the answer to the request behind it.
    const before = await breakpointCount();
    const quiet = await openRaw(context.url);
    try {
      quiet.send(JSON.stringify({ jsonrpc: "2.0", method: "breakpoints.add", params: leftBehind }));
      quiet.send(JSON.stringify(describe(2)));
      const heard = await quiet.next(wait);
      const reply = heard && "text" in heard ? parsedObject(heard.text) : undefined;
      check(
        reply?.id === 2 && reply.result !== undefined,
        `a notification gets no answer; the first frame behind one, and behind a request with id 2, is ${heard ? ("text" in heard ? heard.text.slice(0, 200) : `the end of the connection (code ${heard.closed})`) : `none within ${wait} ms`}`,
      );
    } finally {
      quiet.close();
    }
    check((await breakpointCount()) === before, "a notification is ignored: breakpoints.add without an id added a breakpoint");

    // Members of a request, and keys of params, that the protocol does not name are ignored: the
    // request is answered as without them (a later client can add an optional parameter).
    const lines = { target: "sh4", address: leftBehind.address, count: 2 };
    const plain = await session.call("state.getDisassembly", lines);
    const extended = await rawExchange(
      context.url,
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "state.getDisassembly", params: { ...lines, flavour: "att" }, meta: { trace: "s12" } }),
      wait,
      "a request with an unknown top-level member and an unknown params key",
    );
    const extendedReply = parsedObject(extended);
    check(
      extendedReply?.id === 3 && JSON.stringify(sortKeys(extendedReply.result)) === JSON.stringify(sortKeys(plain)),
      `a request with an unknown top-level member and an unknown params key is answered with ${extended.slice(0, 200)}, expected the answer to the request without them`,
    );

    // An inbound message is at most 1 MiB. One of just under that is answered ...
    const limit = PROTOCOL_BOUNDS.inboundMessageBytes;
    const large = parsedObject(await rawExchange(context.url, paddedTo(describe(4), limit - 1), session.scale(5000), `a message of ${limit - 1} bytes, just under 1 MiB`));
    check(large?.id === 4 && large.result !== undefined, `a message of ${limit - 1} bytes, just under 1 MiB, is answered with ${JSON.stringify(large).slice(0, 200)}, expected its result`);
    // ... and one of 1 MiB + 1 byte closes the connection (1009) or is answered with an error.
    // Either way it is not executed, and the server answers a new connection afterwards.
    const oversized = `a text message of ${limit + 1} bytes (1 MiB + 1 byte)`;
    const big = await openRaw(context.url);
    try {
      big.send(paddedTo({ jsonrpc: "2.0", id: 5, method: "breakpoints.add", params: leftBehind }, limit + 1));
      const outcome = await big.next(session.scale(5000));
      if (!outcome) {
        fail(`${oversized} neither closed the connection nor was answered within ${session.scale(5000)} ms`);
      } else if ("closed" in outcome) {
        check(outcome.closed === 1009, `${oversized} closed the connection with code ${outcome.closed}, expected 1009 (message too big)`);
      } else {
        const reply = parsedObject(outcome.text);
        const refused = reply?.error !== undefined || (reply?.result as { error?: unknown } | undefined)?.error !== undefined;
        check(refused, `${oversized} is answered with ${outcome.text.slice(0, 200)}; it closes the connection (1009) or is answered with an error`);
      }
    } finally {
      big.close();
    }
    const alive = parsedObject(await rawExchange(context.url, JSON.stringify(describe(6)), wait, `debugger.describe on a new connection after ${oversized}`));
    check(alive?.id === 6 && alive.result !== undefined, `after ${oversized} a new connection is answered; debugger.describe got ${JSON.stringify(alive).slice(0, 200)}`);
    check((await breakpointCount()) === before, `${oversized} was executed: its breakpoints.add added a breakpoint`);
    // "no data member anywhere" and "a message that is not empty" are checked on every response of the run by the session
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

      // A write: the tick that follows it goes to every client, as that of every request that
      // changes something. The register is written with the value it reads, so nothing changes
      // in the guest, and the target is paused, so no periodic tick comes instead.
      if (hasCapability(context, CAPABILITIES.REGISTER_WRITE)) {
        const paused = await ensurePaused(context);
        const value = registerOf(paused.tick, sh4.pcPath, "R0") ?? fail(`${sh4.pcPath} has no register R0`);
        since = other.mark();
        await session.call("state.setRegister", { path: sh4.pcPath, name: "R0", value });
        await other.waitForTick(() => true, 1000, "a tick on the second connection behind the state.setRegister of the first", since);
      } else {
        context.note('no capability "register-write": the tick of a write was not looked for on the second connection');
      }

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

const s19: Scenario = {
  id: "S19",
  title: "running target: reads",
  async run(context) {
    const { session } = context;
    const running = await ensureRunning(context);
    const mark = session.mark();
    const asked = (what: string) => `${what} while the target runs`;

    // debugger.describe: valid, and followed by a full tick; the target still runs
    const described = await session.describe();
    check(session.describeProblems.length === 0, `${asked("debugger.describe")}: the result does not follow the schema: ${session.describeProblems.slice(0, 3).join("; ")}`);
    check(isRunning(described.tick), `${asked("debugger.describe")}: the tick that follows it is ${describeState(described.tick)}`);
    const missing = missingPaths(session, described.tick);
    check(missing.length === 0, `${asked("debugger.describe")}: the tick that follows it is full; it lacks ${missing.slice(0, 5).join(", ")}`);

    // the reads, for the SH4 and for the ARM7: valid answers, and none of them "not paused" or "busy"
    for (const id of ["sh4", "arm7"] as const) {
      const target = targetOf(session.shape, id);
      if (!target) {
        context.note(`the server lists no ${id}: its memory, disassembly and callstack were not read`);
        continue;
      }
      if (target.memory) {
        const address = target.defaultMemoryAddress ?? fail(`target ${id} has memory and no defaultMemoryAddress`);
        const slice = await session.call("state.getMemorySlice", { target: id, address, length: 16 });
        check(slice.baseAddress === address && slice.data.length === 16, `${asked(`state.getMemorySlice {${id}}`)}: ${slice.data.length} bytes at ${hex(slice.baseAddress)}, asked for 16 at ${hex(address)}`);
      }
      const from = target.defaultDisassemblyAddress;
      const lines = await disassemble(context, id, from, 16);
      check(lines.length === 16 && lines[0].address === from, `${asked(`state.getDisassembly {${id}}`)}: ${lines.length} lines from ${hex(lines[0]?.address ?? 0)}, asked for 16 at ${hex(from)}`);
      const stack = await session.call("state.getCallstack", { target: id, maxFrames: 8 });
      check(stack.target === id && stack.frames.length <= 8, `${asked(`state.getCallstack {${id}}`)}: ${stack.frames.length} frames for target "${stack.target}", asked for at most 8 of ${id}`);
      stack.frames.forEach((frame, position) => check(frame.index === position, `${asked(`state.getCallstack {${id}}`)}: frame ${position} has index ${frame.index}`));
    }

    // none of them stopped the target: no paused tick since, and the periodic tick goes on
    const stopped = session.ticksSince(mark).find((record) => isPaused(record.tick));
    check(!stopped, `a request to a running target stopped it: ${stopped ? describeState(stopped.tick) : ""}`);
    const still = await session.waitForTick(isRunning, 1000, "a running tick after the reads of a running target", session.mark());
    check(stopIdOf(still.tick) === stopIdOf(running.tick), `the reads of a running target made a stop: stopId is ${stopIdOf(still.tick)}, it was ${stopIdOf(running.tick)}`);
  },
};

const s20: Scenario = {
  id: "S20",
  title: "running target: bookkeeping",
  async run(context) {
    const { session } = context;
    const sh4 = requireTarget(context, "sh4");
    // S20 needs what milestone M1 has: without event breakpoints it fails, it is not skipped
    check(hasCapability(context, CAPABILITIES.EVENT_BREAKPOINTS), 'the capability "event-breakpoints" is part of milestone M1');
    const running = await ensureRunning(context);
    const original = categoriesOf(running.tick);
    let partial: string | undefined;
    /** The tick that shows the effect of a request to the running target is a running one: the request did not stop it. */
    const stillRunning = (record: TickRecord, what: string): TickRecord => {
      check(
        isRunning(record.tick) && stopIdOf(record.tick) === stopIdOf(running.tick),
        `${what} while the target runs: the tick that shows it is ${describeState(record.tick)}; the target was ${describeState(running.tick)}, and bookkeeping does not stop it`,
      );
      return record;
    };
    /** A request to the running target: `{}`, and a tick within 1 s that shows the effect, the target still running. */
    const request = async (method: keyof DebuggerRpcSchema & string, params: unknown, problem: (tick: DebuggerTick) => string | undefined): Promise<TickRecord> => {
      const mark = session.mark();
      await session.call(method, params);
      return stillRunning(await tickShowing(session, mark, method, problem), method);
    };
    const listed = (id: number, enabled?: boolean) => (tick: DebuggerTick) => {
      const breakpoint = tick.breakpoints[String(id)];
      if (enabled === undefined) {
        return breakpoint ? `breakpoint ${id} is still listed` : undefined;
      }
      return breakpoint?.enabled === enabled ? undefined : `breakpoint ${id} is not listed as ${enabled ? "enabled" : "disabled"}`;
    };

    try {
      // breakpoints.setCategoryStates: one key, echoed. Then sh4 is muted, so that the code
      // breakpoint below can be enabled without stopping anything.
      const flipped = { muted: !original.dsp.muted, soloed: original.dsp.soloed };
      stillRunning(await setCategories(context, { dsp: flipped }), "breakpoints.setCategoryStates");
      stillRunning(await setCategories(context, { dsp: original.dsp, sh4: { muted: true, soloed: false } }), "breakpoints.setCategoryStates");

      // breakpoints.add: a code breakpoint and an event breakpoint, both disabled. (The one on
      // the vertical blank also puts its events into the event log, for what follows.)
      const code = await addBreakpointShown(context, { event: sh4.breakpointEvent, address: (sh4.defaultDisassemblyAddress & ~1) >>> 0, kind: "code", enabled: false });
      stillRunning(code.record, "breakpoints.add");
      const counted = session.mark();
      const counter = await addBreakpointShown(context, { event: VBLANK_EVENT, kind: "event", enabled: false });
      stillRunning(counter.record, "breakpoints.add");
      const counters = [counter.breakpoint];
      if (session.index?.events.has(INTERRUPT_EVENT)) {
        counters.push(await addBreakpoint(context, { event: INTERRUPT_EVENT, kind: "event", enabled: false }));
      }
      // breakpoints.toggle, both ways (the category is muted), and breakpoints.remove
      await request("breakpoints.toggle", { id: code.breakpoint.id, enabled: true }, listed(code.breakpoint.id, true));
      await request("breakpoints.toggle", { id: code.breakpoint.id, enabled: false }, listed(code.breakpoint.id, false));
      await request("breakpoints.remove", { id: code.breakpoint.id }, listed(code.breakpoint.id));
      stillRunning(await setCategories(context, original), "breakpoints.setCategoryStates");

      // state.watch, state.modifyWatchExpression, state.unwatch
      const first = unwatchedRegister(context, sh4.pcPath, ["SR", "GBR", "VBR"]);
      const watch = await addWatch(context, first.expression, first.expression);
      stillRunning(watch.record, "state.watch");
      const second = unwatchedRegister(context, sh4.pcPath, ["PR", "MACH", "MACL"]);
      await request("state.modifyWatchExpression", { watchId: watch.id, newExpression: second.expression }, (tick) =>
        tick.watches?.find((entry) => entry.id === watch.id)?.expression === second.expression ? undefined : `watch ${watch.id} is not listed as "${second.expression}"`,
      );
      await request("state.unwatch", { watchIds: [watch.id] }, (tick) => ((tick.watches ?? []).some((entry) => entry.id === watch.id) ? `watch ${watch.id} is still listed` : undefined));

      // A code breakpoint that is added enabled while the target runs is armed, and hit at its
      // next arrival. Where the arrival is certain: at the interrupt entry VBR + 0x600. VBR is
      // read at a pause the scenario makes itself, and resumes from, once the vertical blank has
      // been seen in the event log (not at the anchor, where the program has not installed its
      // vector base).
      await session.waitForTick(
        (tick) => vblanksSince(tick, -1n) > 0,
        2000,
        `an entry of ${VBLANK_EVENT} in the event log of the running target (a disabled event breakpoint on it puts them there)`,
        counted,
      );
      const paused = await ensurePaused(context);
      const entry = interruptEntryOf(paused.tick, sh4);
      await ensureRunning(context);
      const adding = session.mark();
      const atEntry = await addBreakpointShown(context, { event: sh4.breakpointEvent, address: entry, kind: "code", enabled: true });
      const hit = await session
        .waitForTick((tick) => isPaused(tick) && stopIdOf(tick) > stopIdOf(paused.tick), 2000, `a paused tick at the interrupt entry ${hex(entry)}`, adding)
        .catch(() => undefined);
      if (hit) {
        checkEntryStop(hit.tick, sh4, atEntry.breakpoint.id, entry);
      } else {
        // (it is armed at the next slice end: the first interrupt behind the tick that lists it can come before that)
        const listedAt = newestEventId(atEntry.record.tick);
        partial = missedInterruptEntry(session, entry, listedAt, 2, "it was not shown that a code breakpoint that is added while the target runs is hit");
        await ensurePaused(context);
      }
      await removeBreakpoint(context, atEntry.breakpoint.id);
      for (const added of counters) {
        await removeBreakpoint(context, added.id);
      }

      // an event breakpoint on the vertical blank, added enabled while the target runs, stops it
      const resumed = await ensureRunning(context);
      const waiting = session.mark();
      const onVblank = await addBreakpoint(context, { event: VBLANK_EVENT, kind: "event", enabled: true });
      const stop = await session.waitForTick(
        (tick) => isPaused(tick) && stopIdOf(tick) > stopIdOf(resumed.tick),
        2000,
        `a paused tick at the event breakpoint on ${VBLANK_EVENT} that was added while the target runs`,
        waiting,
      );
      check(stop.tick.executionState.reason === "event", `the stop of the event breakpoint has reason "${stop.tick.executionState.reason}", expected "event"`);
      check(stop.tick.executionState.breakpointId === onVblank.id, `the stop reports breakpointId ${stop.tick.executionState.breakpointId}, expected ${onVblank.id}`);
      await removeBreakpoint(context, onVblank.id);
    } finally {
      await session.call("breakpoints.setCategoryStates", { categories: original }).catch(() => undefined);
    }
    return partial === undefined ? undefined : { partial };
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

interface Part {
  /** what `--parts` names it by */
  key: string;
  name: string;
  applicable: boolean;
  why: string;
  run: () => Promise<void>;
}

/**
 * Runs the parts of a multi-capability scenario; a part whose capability is missing is not
 * applicable. With `--parts` for the scenario only the named parts are run, and each of them
 * has to pass: one that is not applicable fails.
 */
const runParts = async (context: RunContext, scenario: string, all: Part[]): Promise<Outcome> => {
  const named = context.parts?.get(scenario);
  const parts = named ? all.filter((part) => named.has(part.key)) : all;
  const results: PartResult[] = [];
  for (const part of parts) {
    if (!part.applicable) {
      results.push(
        named
          ? { name: part.name, status: "failed", detail: `not applicable (${part.why}); a part that --parts names has to pass` }
          : { name: part.name, status: "not-applicable", detail: part.why },
      );
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

/** The exception vectors of the ARM7: where a step ends when an exception, or a pending interrupt, is entered. */
const ARM_EXCEPTION_VECTORS = [0x00, 0x04, 0x08, 0x0c, 0x10, 0x18, 0x1c];

/**
 * What the `arm7` part of S16 notes of what it met. The texts are an interface: the contract
 * targets of the emulator require them of a run with `--require-note`, so they are verbatim.
 */
export const ARM7_NOTES = {
  /** ENABLED read 0 at the start of the part: the -32012 of the three steps was probed */
  held: "arm7: held at the start",
  clocked: "arm7: clocked at the start",
  /** a call was stepped over, and a second one stepped into and out of */
  calls: "arm7: bl stepped over and out",
} as const;

/** The three steps of a target. */
const STEP_METHODS = ["control.step", "control.stepOver", "control.stepOut"] as const;

const NOT_MUTED: BreakpointCategoryState = { muted: false, soloed: false };

/** `ENABLED` of dc.aica.arm7 as a tick has it: 1, 0, or undefined when it is not there or reads neither. */
const enabledIn = (tick: DebuggerTick): 0 | 1 | undefined => {
  const value = registerOf(tick, ARM7_ENABLED_REGISTER.path, ARM7_ENABLED_REGISTER.name);
  return value === "0x1" ? 1 : value === "0x0" ? 0 : undefined;
};

/** An ARM line that is a call: `bl`, in any condition (`ble`, `blt`, `bls` and `blo` are branches). */
const isArmCall = (disassembly: string): boolean => /^bl(eq|ne|cs|hs|cc|lo|mi|pl|vs|vc|hi|ls|ge|lt|gt|le|al)?$/.test(mnemonicOf(disassembly));
/** A call that is always taken and names where it goes: what the part steps over, into and out of. */
const isPlainArmCall = (disassembly: string): boolean => /^bl(al)?$/.test(mnemonicOf(disassembly)) && branchTarget(disassembly) !== undefined;

/**
 * What the `arm7` part found while it may still start over: the ARM7 held in reset, or with a
 * PC no line can be asked for. A guest may hold and release its ARM7 more than once while it
 * starts, and the part meets that when it is run from the anchor.
 */
class Arm7Unsettled extends Error {}

/**
 * S16, part `arm7`: the ARM7 as a target that steps and has breakpoints (M2-ROUND 3.1 item 3).
 * The start (an ARM7 that is held: -32012 and a settling), a step, a breakpoint that is hit,
 * a step from that stop, the breakpoint disabled, muted, with a twin, at a mirror address and
 * added while the target runs, step over and step out, and a call stepped over and out of.
 */
const arm7Part = async (context: RunContext): Promise<void> => {
  const { session } = context;
  const arm7 = requireTarget(context, "arm7");
  const sh4 = requireTarget(context, "sh4");
  const size = arm7.instructionSize;
  const event = arm7.breakpointEvent;
  const pcIn = (tick: DebuggerTick) => pcOf(tick, arm7);
  const latest = () => session.latestTick().tick;
  /** the ARM7 is clocked and stands where a line can be asked for */
  const inReach = (tick: DebuggerTick) => arm7Clocked(tick) && pcIn(tick) <= arm7.addressMax;
  const whereItIs = (tick: DebuggerTick) => (arm7Clocked(tick) ? `the PC of the ARM7 is ${hex(pcIn(tick))}, above its last address ${hex(arm7.addressMax)}` : "ENABLED reads 0");

  /**
   * Settling: resume; wait until ENABLED has read 1 in every running tick of one second, at
   * least two of them (it has to read 1 within 5 s); pause; the paused tick has to show
   * ENABLED 1 and a PC no higher than addressMax, else once more. At most five in a part.
   */
  let settlings = 0;
  const settle = async (): Promise<TickRecord> => {
    for (;;) {
      if (settlings === 5) {
        return fail(`the ARM7 did not settle: after five settlings a paused tick still does not show it clocked at an address of its own (${whereItIs(latest())})`);
      }
      settlings++;
      const mark = session.mark();
      await session.call("control.runUntil", {});
      const released = monotonicNow() + session.scale(5000);
      let examined = 0;
      let reads = 0;
      let since: number | undefined;
      for (;;) {
        const ticks = session.ticksSince(mark);
        for (; examined < ticks.length; examined++) {
          const tick = ticks[examined].tick;
          if (!isRunning(tick)) {
            continue;
          }
          if (enabledIn(tick) === 1) {
            reads++;
            since ??= monotonicNow();
          } else {
            reads = 0;
            since = undefined;
          }
        }
        if (since !== undefined && reads >= 2 && monotonicNow() - since >= session.scale(1000)) {
          break;
        }
        if (monotonicNow() > released + (since === undefined ? 0 : session.scale(3000))) {
          await ensurePaused(context);
          return fail(
            since === undefined
              ? `the ARM7 was not released: ${ARM7_ENABLED_REGISTER.path}.${ARM7_ENABLED_REGISTER.name} did not read 1 in a running tick within ${session.scale(5000)} ms of the resume`
              : `the ARM7 was not released: ${ARM7_ENABLED_REGISTER.name} read 1 in ${reads} running tick${reads === 1 ? "" : "s"} only; it has to read 1 in every running tick of ${session.scale(1000)} ms, at least two of them`,
          );
        }
        await sleep(25);
      }
      const paused = await ensurePaused(context);
      if (inReach(paused.tick)) {
        return paused;
      }
    }
  };

  /** until the first breakpoint of the part is added, a step that finds the ARM7 held, or out of reach, makes the part start over */
  let mayStartOver = true;
  /**
   * One step of the ARM7 from where it is, with what holds for each: `{}`, one paused tick with
   * a new stopId and reason "step", no running tick in between; the time of the SH4 does not go
   * back, and across control.step it grows by two periods of the AICA callback at most; from a
   * line that is not control flow the step ends at the next instruction or at a vector.
   * `method` is control.step, or control.stepOver on a line that is not a call, which is a step.
   */
  const step = async (method: "control.step" | "control.stepOver" = "control.step"): Promise<{ record: TickRecord; pc0: number; pc1: number }> => {
    const before = latest();
    check(isPaused(before), "a step needs a paused target");
    const pc0 = pcIn(before);
    const line = pc0 <= arm7.addressMax ? (await disassemble(context, "arm7", pc0, 1)).at(0) : undefined;
    const mark = session.mark();
    const answer = await session.outcome(method, { target: "arm7" });
    if ("error" in answer) {
      if (answer.error.code === -32012 && mayStartOver) {
        throw new Arm7Unsettled(`${method} {arm7} answered -32012: the ARM7 is held in reset`);
      }
      return fail(`${method} {"target":"arm7"}: in-band error ${answer.error.code} "${answer.error.message}"`);
    }
    check(Object.keys(answer.result as object).length === 0, `${method}: the success result is {}, got ${JSON.stringify(answer.result)}`);
    const stopped = await session.waitForTick(
      (tick) => isPaused(tick) && stopIdOf(tick) > stopIdOf(before),
      2000,
      `a paused tick with a new stopId after ${method} {arm7}`,
      mark,
    );
    const between = session.ticksSince(mark).filter((record) => record.seq <= stopped.seq);
    check(!between.some((record) => isRunning(record.tick)), `${method} {arm7}: a running tick arrived before the paused tick of the step`);
    check(stopped.tick.executionState.reason === "step", `${method} {arm7}: the stop has reason "${stopped.tick.executionState.reason}", expected "step"`);
    check(stopped.tick.executionState.breakpointId === undefined, `${method} {arm7}: a step stop carries no breakpointId`);

    const cycles0 = cyclesOf(before);
    const cycles1 = cyclesOf(stopped.tick);
    if (cycles0 !== undefined && cycles1 !== undefined) {
      check(cycles1 >= cycles0, `dc.timing.SH4_CYCLES went back from ${cycles0} to ${cycles1} across a step of the ARM7`);
      check(
        method !== "control.step" || cycles1 - cycles0 <= 2n * AICA_CALLBACK_CYCLES,
        `dc.timing.SH4_CYCLES grew by ${cycles1 - cycles0} across control.step {arm7}, more than two periods of the AICA callback (2 x ${AICA_CALLBACK_CYCLES}): ` +
          "from a stop outside a sound burst the SH4 runs to the next burst and no further",
      );
    }
    if (mayStartOver && !inReach(stopped.tick)) {
      throw new Arm7Unsettled(`behind ${method} {arm7} ${whereItIs(stopped.tick)}`);
    }
    const pc1 = pcIn(stopped.tick);
    if (line && !isArmControlFlow(line.disassembly)) {
      check(
        pc1 === pc0 + size || ARM_EXCEPTION_VECTORS.includes(pc1),
        `"${line.disassembly}" at ${hex(pc0)} is not control flow, and the step of arm7 ended at ${hex(pc1)}, not at ${hex(pc0 + size)} or an exception vector`,
      );
    }
    return { record: stopped, pc0, pc1 };
  };

  /** The line the ARM7 stands at, if one can be asked for. */
  const lineAtPc = async (): Promise<DisassemblyLine | undefined> => {
    const pc = pcIn(latest());
    return pc <= arm7.addressMax ? (await disassemble(context, "arm7", pc, 1)).at(0) : undefined;
  };

  /**
   * A step, as S04 makes one for the SH4, and then on to a site: a PC whose line and next line
   * are both not control flow (at most 64 steps), so that a breakpoint behind it is the next
   * thing the ARM7 reaches. Returns that PC.
   */
  const toSite = async (): Promise<number> => {
    await step();
    for (let steps = 0; ; steps++) {
      const pc = pcIn(latest());
      const lines = pc + size <= arm7.addressMax ? await disassemble(context, "arm7", pc, 2) : [];
      if (lines.length === 2 && !isArmControlFlow(lines[0].disassembly) && !isArmControlFlow(lines[1].disassembly)) {
        return pc;
      }
      if (steps === 64) {
        return fail("no arm7 PC whose line and next line are not control flow within 64 steps");
      }
      await step();
    }
  };

  // the breakpoints of the part, so that none of them outlives it when it fails
  const mine = new Set<number>();
  const add = async (params: { address: number; enabled?: boolean }): Promise<BreakpointDescriptor> => {
    const breakpoint = await addBreakpoint(context, { event, kind: "code", ...params });
    mine.add(breakpoint.id);
    return breakpoint;
  };
  const remove = async (id: number): Promise<void> => {
    await removeBreakpoint(context, id);
    mine.delete(id);
  };
  let categories: Record<string, BreakpointCategoryState> | undefined;

  try {
    // The start. An ARM7 that is held in reset refuses its three steps with -32012, in-band, and
    // takes a breakpoint all the same (that is what stops at its first instruction).
    let startedOver = false;
    const start = await ensurePaused(context);
    if (!arm7Clocked(start.tick)) {
      for (const method of STEP_METHODS) {
        await session.expectError(method, { target: "arm7" }, -32012);
      }
      await remove((await add({ address: (arm7.defaultDisassemblyAddress - (arm7.defaultDisassemblyAddress % size)) >>> 0 })).id);
      context.note(ARM7_NOTES.held);
      await settle();
    } else {
      context.note(ARM7_NOTES.clocked);
      if (!inReach(start.tick)) {
        startedOver = true;
        await settle();
      }
    }

    let site: number;
    try {
      site = await toSite();
    } catch (error) {
      if (!(error instanceof Arm7Unsettled)) {
        throw error;
      }
      if (startedOver) {
        return fail(`${error.message}, and the part had started over from a settling once already`);
      }
      // once: the guest held its ARM7 again, or released it onto another program
      await settle();
      try {
        site = await toSite();
      } catch (again) {
        return again instanceof Arm7Unsettled ? fail(`${again.message}, also behind a second settling`) : Promise.reject(again);
      }
    }
    mayStartOver = false;
    const address = site + size;

    // a breakpoint address of the ARM7 is a multiple of 4 up to its last address
    await session.expectError("breakpoints.add", { event, address: 2 }, -32602);
    await session.expectError("breakpoints.add", { event, address: arm7.addressMax + 1 }, -32602);

    // ARM7 breakpoints are active here: nothing soloed, the category not muted
    const original = categoriesOf(latest());
    const open = Object.fromEntries(Object.entries(original).map(([key, state]) => [key, key === "arm7" ? NOT_MUTED : { muted: state.muted, soloed: false }]));
    categories = original;
    await setCategories(context, open);

    // The breakpoint behind the site is the next thing the ARM7 reaches: hit, with its id and at its address.
    const breakpoint = await add({ address, enabled: true });
    const hit = await resumeToBreakpoint(context, arm7, breakpoint.id, address);

    // A step from that stop, with the breakpoint still enabled, executes its instruction: the
    // stop is the step's, not the breakpoint's again. A sound burst is suspended at such a stop
    // and the step stays inside it: the SH4 executes nothing.
    const stepped = await step();
    check(
      cyclesOf(stepped.record.tick) === cyclesOf(hit.tick),
      `control.step {arm7} from the stop of an ARM7 breakpoint moved dc.timing.SH4_CYCLES from ${cyclesOf(hit.tick)} to ${cyclesOf(stepped.record.tick)}; the step stays inside the sound burst that is suspended there, and the SH4 does not execute`,
    );
    check(
      pcOf(stepped.record.tick, sh4) === pcOf(hit.tick, sh4),
      `control.step {arm7} from the stop of an ARM7 breakpoint moved the PC of ${sh4.pcPath} from ${hex(pcOf(hit.tick, sh4))} to ${hex(pcOf(stepped.record.tick, sh4))}; the SH4 does not execute in it`,
    );

    // disabled it is not hit, enabled again it is
    await toggleBreakpoint(context, breakpoint.id, false);
    await expectToKeepRunning(context, `a disabled breakpoint of the ARM7 at ${hex(address)}`);
    await toggleBreakpoint(context, breakpoint.id, true);
    await resumeToBreakpoint(context, arm7, breakpoint.id, address);
    // with its category muted it is not hit, unmuted it is
    await setCategories(context, { ...open, arm7: { muted: true, soloed: false } });
    await expectToKeepRunning(context, `a breakpoint of the ARM7 at ${hex(address)} while the category arm7 is muted`);
    await setCategories(context, open);
    await resumeToBreakpoint(context, arm7, breakpoint.id, address);
    // a twin on the same address: the stop reports the lower id
    const twin = await add({ address, enabled: true });
    await resumeToBreakpoint(context, arm7, Math.min(breakpoint.id, twin.id), address);
    await remove(twin.id);
    await remove(breakpoint.id);

    // ARM7 breakpoints are compared under the mask of the wave memory, which is 2 MiB or 8 MiB:
    // one at the address + 0x00800000 is a mirror of it on every server. It is hit, and the tick
    // has the PC as it is.
    if (address < 0x00800000) {
      const mirror = await add({ address: address + 0x00800000, enabled: true });
      const armed = latest();
      const mark = session.mark();
      await session.call("control.runUntil", {});
      const stop = await session.waitForTick(
        (tick) => isPaused(tick) && stopIdOf(tick) > stopIdOf(armed),
        2000,
        `a paused tick at the breakpoint ${hex(address + 0x00800000)}, which is ${hex(address)} under the mask of the wave memory`,
        mark,
      );
      check(stop.tick.executionState.breakpointId === mirror.id, `the stop reports breakpointId ${stop.tick.executionState.breakpointId}, expected ${mirror.id}`);
      check(stop.tick.executionState.reason === "breakpoint", `the stop has reason "${stop.tick.executionState.reason}", expected "breakpoint"`);
      check(
        pcIn(stop.tick) === address,
        `the stop of the breakpoint at ${hex(address + 0x00800000)} shows the PC ${hex(pcIn(stop.tick))}; a tick has the PC as it is, ${hex(address)}`,
      );
      await remove(mirror.id);
    } else {
      context.note(`arm7: the breakpoint site ${hex(address)} is at or above 0x00800000: a breakpoint at a mirror address was not tried`);
    }

    // added enabled while the target runs, a breakpoint is armed: hit at its next arrival
    const running = await ensureRunning(context);
    const adding = session.mark();
    const late = await addBreakpointShown(context, { event, address, kind: "code", enabled: true });
    mine.add(late.breakpoint.id);
    const arrived = await session.waitForTick(
      (tick) => isPaused(tick) && stopIdOf(tick) > stopIdOf(running.tick),
      2000,
      `a paused tick at the ARM7 breakpoint ${hex(address)} that was added while the target runs`,
      adding,
    );
    checkBreakpointStop(arrived.tick, arm7, late.breakpoint.id, address);
    await remove(late.breakpoint.id);
    await setCategories(context, original);
    categories = undefined;

    // a step while running is refused, in-band
    await ensureRunning(context);
    for (const method of STEP_METHODS) {
      await session.expectError(method, { target: "arm7" }, -32003);
    }
    await ensurePaused(context);

    // control.stepOver on a line that is not a call is a step
    for (let steps = 0; ; steps++) {
      const line = await lineAtPc();
      if (line && !isArmCall(line.disassembly)) {
        break;
      }
      check(steps < 64, "no arm7 line that is not a call within 64 steps");
      await step();
    }
    await step("control.stepOver");

    // control.stepOut is a resume with a temporary breakpoint at the link register. Whether and
    // when the ARM7 comes there is the program's business; and when it comes there inside the
    // sound burst the stop was in, the stop follows with no running tick at all.
    const leaving = latest();
    const out = session.mark();
    await session.call("control.stepOut", { target: "arm7" });
    const left = await session.waitForTick(
      (tick) => isRunning(tick) || stopIdOf(tick) > stopIdOf(leaving),
      1000,
      "a running tick, or a paused tick with a new stopId, after control.stepOut {arm7}",
      out,
    );
    const returned = isPaused(left.tick)
      ? left
      : await session.waitForTick((tick) => isPaused(tick) && stopIdOf(tick) > stopIdOf(leaving), 5000, "the stop of control.stepOut {arm7}", left.seq).catch(() => undefined);
    if (returned) {
      const { reason, breakpointId } = returned.tick.executionState;
      check(reason === "step" || breakpointId !== undefined, `control.stepOut {arm7}: the stop has reason "${reason}", expected "step"`);
    }
    await ensurePaused(context);

    // A call. Two arrivals at a `bl` line are looked for by single steps, each with 96 steps of
    // its own (a search may walk through an interrupt handler). At the first the call is
    // stepped over; at the second it is stepped into, and out of from its first line.
    const arrive = async (budget: { left: number }): Promise<{ pc: number; target: number } | undefined> => {
      for (;;) {
        const line = await lineAtPc();
        if (line && isPlainArmCall(line.disassembly)) {
          return { pc: line.address, target: branchTarget(line.disassembly)! };
        }
        if (budget.left === 0) {
          return undefined;
        }
        budget.left--;
        await step();
      }
    };
    /** The stop of a step-over or a step-out that resumed: a paused tick with a new stopId and reason "step", at `expected`. */
    const stopOf = async (method: "control.stepOver" | "control.stepOut", expected: number, where: string): Promise<void> => {
      const before = latest();
      const mark = session.mark();
      await session.call(method, { target: "arm7" });
      const stop = await session.waitForTick((tick) => isPaused(tick) && stopIdOf(tick) > stopIdOf(before), 2000, `the stop of ${method} {arm7} ${where}`, mark);
      const { reason, breakpointId } = stop.tick.executionState;
      check(reason === "step" && breakpointId === undefined, `${method} {arm7} ${where}: the stop is ${describeState(stop.tick)}, expected reason "step" and no breakpointId`);
      check(pcIn(stop.tick) === expected, `${method} {arm7} ${where} ended at ${hex(pcIn(stop.tick))}, not at ${hex(expected)}`);
    };

    const first = await arrive({ left: 96 });
    if (!first) {
      context.note("arm7: no bl was reached within 96 steps: a call was neither stepped over nor out of");
      return;
    }
    await stopOf("control.stepOver", first.pc + size, `on the call at ${hex(first.pc)}`);

    // (the count starts at 0 again behind the step-over)
    const budget = { left: 96 };
    let callee: TickRecord | undefined;
    for (;;) {
      const second = await arrive(budget);
      if (!second) {
        break;
      }
      const into = await step();
      if (into.pc1 === second.target) {
        callee = into.record;
        break;
      }
      // An interrupt that was pending is entered in front of the call: that step is not the step
      // into the callee. The search goes on through the handler, on the count of this arrival.
      check(
        ARM_EXCEPTION_VECTORS.includes(into.pc1),
        `the step on the call at ${hex(second.pc)} ended at ${hex(into.pc1)}, not at its target ${hex(second.target)} or an exception vector`,
      );
      budget.left = Math.max(0, budget.left - 1);
    }
    if (!callee) {
      context.note("arm7: a bl was stepped over; no second one was reached within 96 steps, and none was stepped out of");
      return;
    }
    const linkRegister = numberOf(callee.tick, arm7.pcPath, "R14");
    await stopOf("control.stepOut", linkRegister, `from the first line of the callee at ${hex(pcIn(callee.tick))} (R14 is ${hex(linkRegister)} there)`);
    // The temporary breakpoint of a step-over or a step-out goes at its stop: a loop passes its
    // address at every turn, and with no breakpoint listed the target keeps running.
    if (Object.keys(latest().breakpoints).length === 0) {
      await expectToKeepRunning(context, "behind the step-out of the ARM7, with no breakpoint listed (a temporary breakpoint goes at the stop it makes)");
    }
    context.note(ARM7_NOTES.calls);
  } finally {
    for (const id of mine) {
      await session.call("breakpoints.remove", { id }).catch(() => undefined);
    }
    if (categories) {
      await session.call("breakpoints.setCategoryStates", { categories }).catch(() => undefined);
    }
  }
};

/** `length` bytes of a target's memory that are all readable. */
const readBytes = async (context: RunContext, target: "sh4" | "arm7", address: number, length: number): Promise<number[]> => {
  const slice = await context.session.call("state.getMemorySlice", { target, address, length });
  check(slice.data.length === length, `state.getMemorySlice {${target}, ${hex(address)}, ${length}} returned ${slice.data.length} bytes`);
  check(slice.unreadable === undefined, `${length} bytes at ${hex(address)} of ${target} are readable; unreadable is ${JSON.stringify(slice.unreadable)}`);
  return slice.data;
};

/**
 * A write of memory that is accepted: `{}`, and the tick of the write, which is paused and of
 * the stop the write was made in (a write is not a new stop). The tick is the first one since
 * the request was sent: a server may send it in front of the response or behind it (design 2.9,
 * "Order"; the emulator builds it inside the call and answers when the call has returned), and
 * a paused target sends no tick of its own accord. The part reads memory in front of every
 * such write, so no tick of an earlier request is still under way when this one is sent.
 */
const writeBytes = async (context: RunContext, target: "sh4" | "arm7", address: number, data: number[]): Promise<void> => {
  const { session } = context;
  const stop = session.latestTick().tick;
  const what = `state.writeMemory {${target}, ${hex(address)}, ${data.length} byte${data.length === 1 ? "" : "s"}}`;
  const mark = session.mark();
  await session.call("state.writeMemory", { target, address, data });
  const next = await session.waitForTick(() => true, 1000, `a tick behind ${what}; every accepted write is followed by its tick`, mark);
  check(
    isPaused(next.tick) && stopIdOf(next.tick) === stopIdOf(stop),
    `the tick behind ${what} is ${describeState(next.tick)}; the target was ${describeState(stop)}, and a write is not a new stop`,
  );
};

const sameBytes = (a: number[], b: number[]): boolean => a.length === b.length && a.every((byte, position) => byte === b[position]);
const listed = (bytes: number[]): string => `[${bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" ")}]`;

/** Writes a register and returns the tick that shows what it then reads: paused, of the same stop. */
const writeRegister = async (context: RunContext, path: string, name: string, value: string, expected: string): Promise<TickRecord> => {
  const { session } = context;
  const stop = session.latestTick().tick;
  const mark = session.mark();
  await session.call("state.setRegister", { path, name, value });
  const next = await tickShowing(session, mark, "state.setRegister", (tick) =>
    registerOf(tick, path, name) === expected ? undefined : `${path}.${name} reads ${registerOf(tick, path, name)} after writing ${JSON.stringify(value)}, expected ${expected}`,
  );
  check(isPaused(next.tick) && stopIdOf(next.tick) === stopIdOf(stop), "a register write is not a new stop");
  return next;
};

/** Every node of the describe tree, by path, with the node it is shown under. */
const describedNodes = (shape: DebuggerShape): Map<string, { node: DeviceNodeDescriptor; parent?: string }> => {
  const nodes = new Map<string, { node: DeviceNodeDescriptor; parent?: string }>();
  const collect = (list: DeviceNodeDescriptor[], parent?: string) =>
    list.forEach((node) => {
      // (a path that is listed twice is S01's to report)
      if (!nodes.has(node.path)) {
        nodes.set(node.path, { node, parent });
      }
      collect(node.children ?? [], node.path);
    });
  collect(shape.deviceTree);
  return nodes;
};

const isWritable = (register: { flags?: Record<string, boolean> }): boolean => register.flags?.writable === true;

/** S16, part `writeMemory` (M2-ROUND 3.1 item 3). Nothing of it writes a pattern over memory it did not save. */
const writeMemoryPart = async (context: RunContext): Promise<void> => {
  const { session } = context;
  const sh4 = requireTarget(context, "sh4");
  const paused = await ensurePaused(context);
  // The scratch address of the part, below the stack pointer: nothing lives there while the target is paused.
  const scratch = ((numberOf(paused.tick, sh4.pcPath, "R15") - 256) & ~3) >>> 0;
  const original = await readBytes(context, "sh4", scratch, 16);
  const pattern = original.map((byte, position) => (byte ^ 0xa5 ^ position) & 0xff);
  // main memory is one memory behind 0x0C.., 0x8C.. and 0xAC..: the two regions the scratch address is not in
  const physical = scratch & 0x1fffffff;
  const mirrors = physical >>> 26 === 3 ? [physical, (0x80000000 | physical) >>> 0, (0xa0000000 | physical) >>> 0].filter((address) => address !== scratch) : [];
  try {
    await writeBytes(context, "sh4", scratch, pattern);
    const written = await readBytes(context, "sh4", scratch, 16);
    check(sameBytes(written, pattern), `16 bytes written at ${hex(scratch)} read back as ${JSON.stringify(written)}`);
    for (const mirror of mirrors) {
      const seen = await readBytes(context, "sh4", mirror, 16);
      check(sameBytes(seen, pattern), `the 16 bytes written at ${hex(scratch)} read ${listed(seen)} at ${hex(mirror)}, which maps the same main memory; they were written as ${listed(pattern)}`);
    }
    if (mirrors.length === 0) {
      context.note(`writeMemory: the scratch address ${hex(scratch)} is not in main memory: its other mappings were not read`);
    }
  } finally {
    await session.call("state.writeMemory", { target: "sh4", address: scratch, data: original });
  }
  check(sameBytes(await readBytes(context, "sh4", scratch, 16), original), "the original bytes are back");

  // All of a range or nothing: one that starts in main memory and ends above it is refused, and its first half is unchanged.
  const edge = 0x0ffffff8;
  const below = await readBytes(context, "sh4", edge, 8);
  await session.expectError("state.writeMemory", { target: "sh4", address: edge, data: [...below.map((byte) => byte ^ 0xff), ...new Array<number>(8).fill(0)] }, -32013);
  check(sameBytes(await readBytes(context, "sh4", edge, 8), below), `a refused write of 16 bytes at ${hex(edge)}, across the end of main memory, changed its first half: a range is written whole or not at all`);

  // The bound: 65536 bytes are accepted. They are read where the SH4's memory view opens, and
  // written back as they are; one byte more, and a byte that is no byte, are refused and not stored.
  const most = PROTOCOL_BOUNDS.writeMemoryLength.max;
  const large = sh4.defaultMemoryAddress ?? fail("target sh4 has memory and no defaultMemoryAddress");
  const block = await readBytes(context, "sh4", large, most);
  const behind = await readBytes(context, "sh4", large + most, 1);
  await writeBytes(context, "sh4", large, block);
  const rewritten = await readBytes(context, "sh4", large, most);
  const differing = rewritten.flatMap((byte, position) => (byte === block[position] ? [] : [position]));
  if (differing.length > 0) {
    // (what was there is put back in smaller pieces, as far as the server takes them)
    for (let position = 0; position < most; position += 4096) {
      await session.call("state.writeMemory", { target: "sh4", address: large + position, data: block.slice(position, position + 4096) }).catch(() => undefined);
    }
    fail(`${most} bytes at ${hex(large)} were written back as they read, and ${differing.length} of them read${differing.length === 1 ? "s" : ""} differently: the first one at ${hex(large + differing[0])}`);
  }
  await session.expectError("state.writeMemory", { target: "sh4", address: large, data: [...block, ...behind] }, -32602);
  await session.expectError("state.writeMemory", { target: "sh4", address: large, data: [256] }, -32602);
  await session.expectError("state.writeMemory", { target: "sh4", address: large, data: [] }, -32602);
  const after = await readBytes(context, "sh4", large, 16);
  if (!sameBytes(after, block.slice(0, 16))) {
    await session.call("state.writeMemory", { target: "sh4", address: large, data: block.slice(0, 16) }).catch(() => undefined);
    fail(`a refused state.writeMemory at ${hex(large)} was stored: the first bytes there read ${listed(after)}, they were ${listed(block.slice(0, 16))}`);
  }

  // the target is required (the reads default to sh4, a write does not), and the DSP has no
  // memory: the method's own "not supported", in-band, not an invalid parameter
  await session.expectError("state.writeMemory", { address: scratch, data: original }, -32602);
  await session.expectError("state.writeMemory", { target: "dsp", address: 0, data: [0] }, -32004);

  // Wave memory is one store behind the ARM7's X and the SH4's 0x00800000 + X: a byte written
  // through either address reads back through the other. (2 MiB is the smallest wave memory.)
  const arm7 = targetOf(session.shape, "arm7");
  if (arm7?.memory) {
    const x = (arm7.defaultMemoryAddress ?? 0) & 0x001fffff;
    const fromSh4 = 0x00800000 + x;
    const [byte] = await readBytes(context, "arm7", x, 1);
    try {
      check((await readBytes(context, "sh4", fromSh4, 1))[0] === byte, `wave memory: ${hex(x)} of the ARM7 and ${hex(fromSh4)} of the SH4 are one byte, and read differently`);
      await writeBytes(context, "arm7", x, [byte ^ 0xff]);
      const throughSh4 = (await readBytes(context, "sh4", fromSh4, 1))[0];
      check(throughSh4 === (byte ^ 0xff), `a byte of wave memory written through the ARM7's ${hex(x)} as ${byte ^ 0xff} reads ${throughSh4} through the SH4's ${hex(fromSh4)}`);
      await writeBytes(context, "sh4", fromSh4, [byte ^ 0x5a]);
      const throughArm7 = (await readBytes(context, "arm7", x, 1))[0];
      check(throughArm7 === (byte ^ 0x5a), `a byte of wave memory written through the SH4's ${hex(fromSh4)} as ${byte ^ 0x5a} reads ${throughArm7} through the ARM7's ${hex(x)}`);
    } finally {
      await session.call("state.writeMemory", { target: "arm7", address: x, data: [byte] });
    }
    check((await readBytes(context, "sh4", fromSh4, 1))[0] === byte, "the original byte of wave memory is back");
  } else {
    context.note("writeMemory: the server lists no arm7 with memory: wave memory was not written through both targets");
  }

  // Video memory, one view of it through three of its addresses (that the other view shows the
  // same bytes interleaved is the emulator's own, and not asked here).
  const video = await readBytes(context, "sh4", 0xa5000000, 16);
  const painted = video.map((byte, position) => (byte ^ 0x3c ^ (position << 4)) & 0xff);
  try {
    await writeBytes(context, "sh4", 0xa5000000, painted);
    for (const address of [0x05000000, 0x07000000]) {
      const seen = await readBytes(context, "sh4", address, 16);
      check(sameBytes(seen, painted), `16 bytes of video memory written at 0xA5000000 as ${listed(painted)} read ${listed(seen)} at ${hex(address)}`);
    }
  } finally {
    await session.call("state.writeMemory", { target: "sh4", address: 0xa5000000, data: video });
  }
  check(sameBytes(await readBytes(context, "sh4", 0x05000000, 16), video), "the original bytes of video memory are back");

  // What is not memory of that kind is not writable: the boot ROM, the flash, a register
  // window, P4 and a store queue. (Addresses a write would do no harm at, were it accepted.)
  for (const [what, address] of [
    ["the boot ROM", 0x00000000],
    ["the flash", 0x00200000],
    ["a register window", 0x005f8000],
    ["P4", 0xff000030],
    ["a store queue", 0xe0000000],
  ] as const) {
    await session.expectError("state.writeMemory", { target: "sh4", address, data: [0] }, -32013).catch((error: unknown) => {
      throw error instanceof ContractFailure ? new ContractFailure(`${what} is not writable: ${error.message}`) : error;
    });
  }
  // A write is served while the target runs. That is asked with one that is refused, so that
  // nothing is written into a running guest: "not writable", and not "not paused".
  await ensureRunning(context);
  await session.expectError("state.writeMemory", { target: "sh4", address: 0x00000000, data: [0] }, -32013);
  const stop = await ensurePaused(context);

  // The probe that executes what was written. One instruction, and that one the runner's: the PC
  // is never moved onto a line of the program. `mov #0x5A, r0` at a scratch address, the PC
  // there, one step: the PC is two further and R0 is 0x5A.
  if (!hasCapability(context, CAPABILITIES.REGISTER_WRITE)) {
    context.note('writeMemory: no capability "register-write": the instruction that was written was not executed');
    return;
  }
  const path = sh4.pcPath;
  // (the target has run since the scratch address above was taken: below the stack pointer of this stop, and what is there now)
  const probe = ((numberOf(stop.tick, path, "R15") - 256) & ~3) >>> 0;
  const saved = await readBytes(context, "sh4", probe, 2);
  const valueOf = (tick: DebuggerTick, name: string) => registerOf(tick, path, name) ?? fail(`${path} has no register ${name}`);
  const at = (address: number) => hex(address);
  const undo: Array<() => Promise<unknown>> = [];
  /** Writes a register for the probe; `back` is what puts it back when the probe is over, or fails. */
  const set = async (name: string, value: string, back?: string): Promise<TickRecord> => {
    const record = await writeRegister(context, path, name, value, value);
    if (back !== undefined) {
      undo.push(() => session.call("state.setRegister", { path, name, value: back }));
    }
    return record;
  };
  /** The step from the probe address: where it ended, and whether that is an exception vector of the program. */
  const execute = async (): Promise<{ tick: DebuggerTick; pc: number; atVector: boolean }> => {
    const tick = (await stepOnce(context, "sh4")).tick;
    const pc = pcOf(tick, sh4);
    const vbr = numberOf(tick, path, "VBR");
    return { tick, pc, atVector: [0x100, 0x400, 0x600].some((offset) => pc === (vbr + offset) >>> 0) };
  };
  const executed = (tick: DebuggerTick, pc: number, where: string): void => {
    check(pc === probe + 2, `the step from the instruction written at ${at(probe)}${where} ended at ${at(pc)}, not at ${at(probe + 2)}`);
    check(
      valueOf(tick, "R0") === "0x0000005A",
      `"mov #0x5A, r0" was written at ${at(probe)} and stepped${where}, and R0 reads ${valueOf(tick, "R0")}: what executes is what was written (0x0000005A)`,
    );
  };
  try {
    await writeBytes(context, "sh4", probe, [0x5a, 0xe0]);
    undo.push(() => session.call("state.writeMemory", { target: "sh4", address: probe, data: saved }));
    const pc0 = valueOf(stop.tick, "PC");
    const r0 = valueOf(stop.tick, "R0");
    await set("PC", at(probe), pc0);
    undo.push(() => session.call("state.setRegister", { path, name: "R0", value: r0 }));
    const first = await execute();
    if (!first.atVector) {
      executed(first.tick, first.pc, "");
    } else {
      // An interrupt that was owed is accepted before the instruction runs: the step ends at
      // its vector with nothing executed, which SPC says. The saved PC is put where the handler
      // returns to, and the probe is made once more from the vector, where SR.BL is set and no
      // interrupt is accepted.
      check(
        valueOf(first.tick, "SPC") === at(probe),
        `the step from ${at(probe)} ended at the exception vector ${at(first.pc)}, and SPC reads ${valueOf(first.tick, "SPC")}; an exception that is entered in front of the instruction returns to it`,
      );
      // (the PC and the R0 of the interrupted program are restored through SPC, and left alone)
      undo.length = 1;
      await set("SPC", pc0);
      const pcAtVector = valueOf(first.tick, "PC");
      const r0AtVector = valueOf(first.tick, "R0");
      await set("PC", at(probe), pcAtVector);
      undo.push(() => session.call("state.setRegister", { path, name: "R0", value: r0AtVector }));
      const second = await execute();
      executed(second.tick, second.pc, ", from the exception vector the first step ended at");
    }
  } finally {
    for (const action of undo.reverse()) {
      await action().catch(() => undefined);
    }
  }
  const restored = (await session.describe()).tick;
  check(sameBytes(await readBytes(context, "sh4", probe, 2), saved), "the two bytes of the probe are restored");
  check(isPaused(restored), "the target is paused behind the probe");
};

/** S16, part `setRegister` (M2-ROUND 3.1 item 3, M2-D18 to M2-D20). */
const setRegisterPart = async (context: RunContext): Promise<void> => {
  const { session } = context;
  const sh4 = requireTarget(context, "sh4");
  const cpu = sh4.pcPath;
  const paused = await ensurePaused(context);
  const original = registerOf(paused.tick, cpu, "R0") ?? fail(`${cpu} has no register R0`);
  const nodes = describedNodes(session.shape);
  const arm7 = targetOf(session.shape, "arm7");
  const arm7Path = arm7?.pcPath ?? ARM7_ENABLED_REGISTER.path;
  const described = (path: string, name: string) => nodes.get(path)?.node.registers?.find((register) => register.name === name);
  try {
    await writeRegister(context, cpu, "R0", "0x12345678", "0x12345678");
    // decimal, and truncated to the register's width
    await writeRegister(context, cpu, "R0", "255", "0x000000FF");
    await writeRegister(context, cpu, "R0", "0x1FFFFFFFF", "0xFFFFFFFF");
    // the path and the name are matched without regard to case; ASCII blanks around the value are dropped
    for (const [path, name, value, expected] of [
      [cpu, "r0", "1", "0x00000001"],
      [cpu.toUpperCase(), "R0", " 0x1f ", "0x0000001F"],
    ]) {
      const mark = session.mark();
      await session.call("state.setRegister", { path, name, value });
      await tickShowing(session, mark, "state.setRegister", (tick) =>
        registerOf(tick, cpu, "R0") === expected ? undefined : `R0 reads ${registerOf(tick, cpu, "R0")} after state.setRegister ${JSON.stringify({ path, name, value })}, expected ${expected}`,
      );
    }
    // a text that is no number: -32602, and nothing is written
    for (const value of ["twelve", "-1", "", "1.5", "0x"]) {
      await session.expectError("state.setRegister", { path: cpu, name: "R0", value }, -32602);
    }
  } finally {
    await writeRegister(context, cpu, "R0", original, original);
  }
  await session.expectError("state.setRegister", { path: cpu, name: "NO_SUCH_REGISTER", value: "0" }, -32602);
  await session.expectError("state.setRegister", { path: "dc.no.such.node", name: "R0", value: "0" }, -32602);

  // A register says in debugger.describe whether it has a writer: R0 does; a register of width
  // 0 is free text and never has one; and ENABLED of the ARM7 is the guest's to change.
  check(isWritable(described(cpu, "R0") ?? {}), `${cpu}.R0 carries no flags.writable in debugger.describe; a register that state.setRegister writes says so`);
  for (const [path, { node }] of nodes) {
    const text = node.registers?.find((register) => register.width === 0 && isWritable(register));
    check(!text, `${path}.${text?.name} has width 0 and carries flags.writable; a register of width 0 is free text and has no writer`);
  }
  const enabled = described(arm7Path, ARM7_ENABLED_REGISTER.name);
  if (arm7 && enabled) {
    check(!isWritable(enabled), `${arm7Path}.ENABLED carries flags.writable; the guest holds and releases its ARM7, not the debugger`);
    // (no writer comes before the value: a text that is no number is "not writable" there, too)
    await session.expectError("state.setRegister", { path: arm7Path, name: ARM7_ENABLED_REGISTER.name, value: "0" }, -32013);
    await session.expectError("state.setRegister", { path: arm7Path, name: ARM7_ENABLED_REGISTER.name, value: "twelve" }, -32013);
  }

  // In every node: the first register that says it has a writer takes the value it reads, and
  // the first that does not is refused.
  for (const [path, { node }] of nodes) {
    const values = session.latestTick().tick.registers[path] ?? [];
    const valueOf = (name: string) => values.find((register) => register.name === name)?.value;
    const writable = node.registers?.find((register) => isWritable(register) && valueOf(register.name) !== undefined && valueOf(register.name) !== "n/a");
    if (writable) {
      const value = valueOf(writable.name)!;
      await writeRegister(context, path, writable.name, value, value);
    }
    const readOnly = node.registers?.find((register) => !isWritable(register));
    if (readOnly) {
      await session.expectError("state.setRegister", { path, name: readOnly.name, value: "0" }, -32013);
    }
  }

  // The registers of the ARM7, and what the two processors refuse or store differently from what they are given.
  const now = () => session.latestTick().tick;
  if (arm7) {
    const r1 = registerOf(now(), arm7Path, "R1");
    if (r1 !== undefined && /^0x[0-9A-F]{8}$/.test(r1)) {
      check(isWritable(described(arm7Path, "R1") ?? {}), `${arm7Path}.R1 carries no flags.writable; the registers of the two processors are written in milestone M2`);
      const other = hex((Number.parseInt(r1, 16) ^ 0x00ff00ff) >>> 0);
      try {
        await writeRegister(context, arm7Path, "R1", other, other);
      } finally {
        await writeRegister(context, arm7Path, "R1", r1, r1);
      }
    }
    // the PC of the ARM7 is stored aligned
    if (isWritable(described(arm7Path, arm7.pcRegister) ?? {})) {
      const pc = registerOf(now(), arm7Path, arm7.pcRegister)!;
      check((Number.parseInt(pc, 16) & 3) === 0, `the PC of the ARM7 reads ${pc}; it is a multiple of 4`);
      await writeRegister(context, arm7Path, arm7.pcRegister, hex((Number.parseInt(pc, 16) | 3) >>> 0), pc).catch((error: unknown) => {
        throw error instanceof ContractFailure ? new ContractFailure(`the PC of the ARM7 is stored with bits 0 and 1 clear: ${error.message}`) : error;
      });
    }
    // a CPSR whose mode bits are no mode is refused
    const cpsr = registerOf(now(), arm7Path, "CPSR");
    if (cpsr !== undefined && isWritable(described(arm7Path, "CPSR") ?? {})) {
      await session.expectError("state.setRegister", { path: arm7Path, name: "CPSR", value: hex((Number.parseInt(cpsr, 16) & ~0x1f) >>> 0) }, -32013);
      const still = (await session.describe()).tick;
      check(registerOf(still, arm7Path, "CPSR") === cpsr, `a refused write of CPSR changed it: it reads ${registerOf(still, arm7Path, "CPSR")}, it was ${cpsr}`);
    }
  }
  // nothing executes at an odd address: a PC of the SH4 with bit 0 set is refused
  const pc = registerOf(now(), cpu, sh4.pcRegister)!;
  await session.expectError("state.setRegister", { path: cpu, name: sh4.pcRegister, value: hex((Number.parseInt(pc, 16) | 1) >>> 0) }, -32013);
  const unchanged = (await session.describe()).tick;
  check(registerOf(unchanged, cpu, sh4.pcRegister) === pc, `a refused write of the PC of the SH4 changed it: it reads ${registerOf(unchanged, cpu, sh4.pcRegister)}, it was ${pc}`);

  // SR applies its effect: with MD set, a write that flips RB exchanges R0..R7 with R0_BANK..R7_BANK
  const sr = numberOf(now(), cpu, "SR");
  if ((sr & 0x40000000) !== 0) {
    const bank = (tick: DebuggerTick, suffix: string) => Array.from({ length: 8 }, (_, index) => registerOf(tick, cpu, `R${index}${suffix}`));
    const before = now();
    try {
      const flipped = (await writeRegister(context, cpu, "SR", hex((sr ^ 0x20000000) >>> 0), hex((sr ^ 0x20000000) >>> 0))).tick;
      check(
        JSON.stringify(bank(flipped, "")) === JSON.stringify(bank(before, "_BANK")) && JSON.stringify(bank(flipped, "_BANK")) === JSON.stringify(bank(before, "")),
        `a write of SR that flips RB (MD is set) exchanges R0..R7 with R0_BANK..R7_BANK: R0..R7 read ${JSON.stringify(bank(flipped, ""))} and R0_BANK..R7_BANK ${JSON.stringify(bank(flipped, "_BANK"))}; ` +
          `before it they read ${JSON.stringify(bank(before, ""))} and ${JSON.stringify(bank(before, "_BANK"))}`,
      );
    } finally {
      await writeRegister(context, cpu, "SR", hex(sr), hex(sr));
    }
  } else {
    context.note("setRegister: MD is clear in SR at this stop: the exchange of the register banks by a write of SR.RB was not shown");
  }

  // state.editWatch is state.setRegister on the watched register
  await session.expectError("state.editWatch", { watchId: Math.max(0, ...context.seen.watches) + 100_000, value: "0" }, -32602);
  const { id } = await addWatch(context, `${cpu}.r0`, `${cpu}.r0`).catch(() => ({ id: undefined }));
  if (id !== undefined) {
    const mark = session.mark();
    await session.call("state.editWatch", { watchId: id, value: "0x00C0FFEE" });
    await tickShowing(session, mark, "state.editWatch", (tick) =>
      registerOf(tick, cpu, "R0") === "0x00C0FFEE" ? undefined : `R0 reads ${registerOf(tick, cpu, "R0")}; state.editWatch writes the watched register`,
    );
    await writeRegister(context, cpu, "R0", original, original);
    await unwatch(context, id);
  } else {
    context.note("state.editWatch not exercised: R0 is watched by somebody else");
  }
  if (arm7 && enabled) {
    const expression = `${arm7Path}.${ARM7_ENABLED_REGISTER.name.toLowerCase()}`;
    const stored = (now().watches ?? []).find((watch) => watch.expression === expression);
    const watchId = stored?.id ?? (await addWatch(context, expression, expression)).id;
    await session.expectError("state.editWatch", { watchId, value: "1" }, -32013);
    if (!stored) {
      await unwatch(context, watchId);
    }
    // A write is served while the target runs. That is asked with one that is refused: "not
    // writable", and not "not paused".
    await ensureRunning(context);
    await session.expectError("state.setRegister", { path: arm7Path, name: ARM7_ENABLED_REGISTER.name, value: "0" }, -32013);
    await ensurePaused(context);
  }
};

/** S16, part `reset` (M2-ROUND 3.1 item 3, M2-D22, M2-D23). */
const resetPart = async (context: RunContext): Promise<void> => {
  const { session } = context;
  const sh4 = requireTarget(context, "sh4");
  const arm7 = targetOf(session.shape, "arm7");
  const RESET_EVENT = "dc.system.reset";

  // While the target runs: {}, the target runs on in the same stop, nothing is published; the
  // event log gets an entry of the reset, when the server lists that event.
  const running = await ensureRunning(context);
  const newest = newestEventId(session.latestTick().tick);
  const asked = session.mark();
  await session.call("control.reset", {});
  await session.collectTicks(1000);
  for (const record of session.ticksSince(asked)) {
    check(
      isRunning(record.tick) && stopIdOf(record.tick) === stopIdOf(running.tick),
      `control.reset while the target runs: a tick is ${describeState(record.tick)}; the target was ${describeState(running.tick)}, it runs on in the same stop and nothing is published for the reset`,
    );
  }
  if (session.index?.events.has(RESET_EVENT)) {
    await session.waitForTick(
      (tick) => eventsSince(tick, RESET_EVENT, newest) > 0,
      1000,
      `an entry of ${RESET_EVENT} in the event log behind control.reset of a running target`,
      asked,
    );
  }

  // While paused. The tables are kept: so that there is something to keep, a disabled breakpoint
  // of the SH4, a watch on a register no watch names, and the category dsp flipped.
  const paused = await ensurePaused(context);
  const categories = categoriesOf(paused.tick);
  const flipped = { muted: !categories.dsp.muted, soloed: categories.dsp.soloed };
  const breakpoint = await addBreakpoint(context, { event: sh4.breakpointEvent, address: (sh4.defaultDisassemblyAddress & ~1) >>> 0, kind: "code", enabled: false });
  const register = unwatchedRegister(context, sh4.pcPath, ["GBR", "VBR", "MACH", "MACL"]);
  const { id: watchId } = await addWatch(context, register.expression, register.expression);
  const before = (await setCategories(context, { dsp: flipped })).tick;
  try {
    const mark = session.mark();
    await session.call("control.reset", {});
    const reset = await session.waitForTick((tick) => stopIdOf(tick) > stopIdOf(before), 5000, "a tick with a new stopId after control.reset", mark);
    check(isPaused(reset.tick), "a reset while paused stays paused");
    check(reset.tick.executionState.reason === "reset", `the stop has reason "${reset.tick.executionState.reason}", expected "reset"`);
    check(!session.ticksSince(mark).some((record) => record.seq < reset.seq && isRunning(record.tick)), "no running tick between control.reset and its stop");
    // breakpoints, watches and categories are what they were
    const kept = reset.tick.breakpoints[String(breakpoint.id)];
    check(
      kept !== undefined && kept.enabled === false && kept.address === breakpoint.address,
      `the tick of the reset stop lists breakpoint ${breakpoint.id} as ${JSON.stringify(kept)}; a reset keeps the breakpoints: it was ${JSON.stringify(breakpoint)}`,
    );
    const watch = (reset.tick.watches ?? []).find((entry) => entry.id === watchId);
    check(watch?.expression === register.expression, `the tick of the reset stop lists watch ${watchId} as ${JSON.stringify(watch)}; a reset keeps the watches: it was on ${register.expression}`);
    check(
      JSON.stringify(sortKeys(reset.tick.categories)) === JSON.stringify(sortKeys(before.categories)),
      `the categories are ${JSON.stringify(reset.tick.categories)} behind the reset; a reset keeps them: they were ${JSON.stringify(before.categories)}`,
    );
    // the machine is reset: its ARM7 is held, and has no frames
    if (arm7) {
      check(!arm7Clocked(reset.tick), `${ARM7_ENABLED_REGISTER.path}.${ARM7_ENABLED_REGISTER.name} reads 1 at the stop of a reset; a machine comes out of reset with its ARM7 held`);
      check((reset.tick.callstacks?.arm7 ?? []).length === 0, `the ARM7 callstack has ${reset.tick.callstacks?.arm7?.length} frames at the stop of a reset; an ARM7 that is held has none`);
      // the registers of a held ARM7 are written
      const r1 = registerOf(reset.tick, arm7.pcPath, "R1");
      if (hasCapability(context, CAPABILITIES.REGISTER_WRITE) && r1 !== undefined && /^0x[0-9A-F]{8}$/.test(r1)) {
        const other = hex((Number.parseInt(r1, 16) ^ 0x00ff00ff) >>> 0);
        await writeRegister(context, arm7.pcPath, "R1", other, other).catch((error: unknown) => {
          throw error instanceof ContractFailure ? new ContractFailure(`a register of the ARM7 is written while it is held in reset: ${error.message}`) : error;
        });
        await writeRegister(context, arm7.pcPath, "R1", r1, r1);
      }
    }
  } finally {
    await session.call("state.unwatch", { watchIds: [watchId] }).catch(() => undefined);
    await session.call("breakpoints.remove", { id: breakpoint.id }).catch(() => undefined);
    await session.call("breakpoints.setCategoryStates", { categories }).catch(() => undefined);
  }

  // The machine runs behind its reset: a resume gives a running tick, and a pause a paused one.
  const resumed = session.mark();
  await session.call("control.runUntil", {});
  await session.waitForTick(isRunning, 1000, "a running tick after control.runUntil behind a reset", resumed);
  const pausing = session.mark();
  await session.call("control.pause", {});
  await session.waitForTick(isPaused, 2000, "a paused tick after control.pause behind a reset", pausing);
};

/** S16, part `tree`: the M2 rows of the device tree (M2-ROUND 3.6.1, M2-D24). */
const treePart = async (context: RunContext): Promise<void> => {
  const nodes = describedNodes(context.session.shape);
  const findings: string[] = [];
  for (const row of M2_DEVICE_TREE) {
    const entry = nodes.get(row.path);
    if (!entry) {
      findings.push(`the device tree has no node ${row.path}, which milestone M2 adds`);
      continue;
    }
    if (entry.parent !== row.parent) {
      findings.push(`${row.path} is ${entry.parent === undefined ? "a root of the device tree" : `under ${entry.parent}`}, milestone M2 has it under ${row.parent}`);
    }
    for (const action of row.actions ?? []) {
      if (!entry.node.actions?.includes(action)) {
        findings.push(`${row.path}: the action "${action}" of milestone M2 is missing`);
      }
    }
    if (row.registers && !entry.node.registers?.length) {
      findings.push(`${row.path} lists no registers; from milestone M2 on it carries at least one`);
    }
  }
  // A register panel shows the node that offers its id: an id is the action of one node.
  for (const id of REGISTER_PANEL_IDS) {
    const offering = Array.from(nodes.values()).filter(({ node }) => node.actions?.includes(id)).map(({ node }) => node.path);
    if (offering.length > 1) {
      findings.push(`the action "${id}" is offered by ${offering.join(" and ")}; a register panel is the action of one node`);
    }
  }
  if (findings.length > 0) {
    fail(findings[0], findings.slice(1));
  }
};

const s16: Scenario = {
  id: "S16",
  title: "M2: ARM7, writes, reset",
  milestone: "M2",
  parts: ["arm7", "writeMemory", "setRegister", "reset", "tree"],
  run: (context) =>
    runParts(context, "S16", [
      {
        key: "arm7",
        name: "arm7",
        applicable: targetOf(context.session.shape, "arm7")?.stepping === true,
        why: "targets: arm7.stepping is false",
        run: () => arm7Part(context),
      },
      {
        key: "writeMemory",
        name: "writeMemory",
        applicable: hasCapability(context, CAPABILITIES.MEMORY_WRITE),
        why: 'no capability "memory-write"',
        run: () => writeMemoryPart(context),
      },
      {
        key: "setRegister",
        name: "setRegister",
        applicable: hasCapability(context, CAPABILITIES.REGISTER_WRITE),
        why: 'no capability "register-write"',
        run: () => setRegisterPart(context),
      },
      {
        key: "reset",
        name: "reset",
        applicable: hasCapability(context, CAPABILITIES.RESET),
        why: 'no capability "reset"',
        run: () => resetPart(context),
      },
      {
        key: "tree",
        name: "tree",
        // a server claims the M2 tree by offering the M2 panel
        applicable: describedNodes(context.session.shape).get(M2_TREE_ACTION.path)?.node.actions?.includes(M2_TREE_ACTION.action) === true,
        why: `${M2_TREE_ACTION.path} does not offer the action "${M2_TREE_ACTION.action}"`,
        run: () => treePart(context),
      },
    ]),
};

const s17: Scenario = {
  id: "S17",
  title: "M3: SGC capture",
  milestone: "M3",
  parts: ["sgcCapture"],
  run: (context) =>
    runParts(context, "S17", [
      {
        key: "sgcCapture",
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
    ]),
};

const s18: Scenario = {
  id: "S18",
  title: "M4: tables, Holly capture",
  milestone: "M4",
  parts: ["tables", "hollyCapture"],
  run: (context) =>
    runParts(context, "S18", [
      {
        key: "tables",
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
              // a tier with a cache model has rows, the lines of the cache; one without has none, and says so
              check(
                table.rows.length > 0 || table.note !== undefined,
                `state.getTable {${id}}: no rows and no note; the table has rows (a tier with a cache model), or no rows and a note`,
              );
            }
          }
          await context.session.expectError("state.getTable", { id: "vram" }, -32602);
        },
      },
      {
        key: "hollyCapture",
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

const s21: Scenario = {
  id: "S21",
  title: "M3: DSP",
  milestone: "M3",
  dspProgram: true,
  async run(context) {
    const { session } = context;
    if (!context.dspProgram) {
      return { notApplicable: "the run with the DSP test program only (--dsp-program): this program is not known to load the DSP" };
    }
    const dsp = targetOf(session.shape, "dsp");
    if (!dsp?.stepping) {
      return { notApplicable: dsp ? "targets: dsp.stepping is false" : 'targets: no "dsp"' };
    }
    const steps = dsp.addressMax + 1;
    const stepOf = (tick: DebuggerTick) => pcOf(tick, dsp);

    // control.step {dsp} from a stop: a paused tick with reason "step", and STEP advanced by one
    const before = await ensurePaused(context);
    const stepped = await stepOnce(context, "dsp");
    check(stepOf(stepped.tick) === (stepOf(before.tick) + 1) % steps, `a DSP step from ${stepOf(before.tick)} ended at ${stepOf(stepped.tick)}`);

    // The program the test ELF loaded: every step has its four MPRO words (8 pairs) and its line,
    // and they are not all empty. 16 lines at STEP, as the disassembly view asks for them.
    const program = await disassemble(context, "dsp", 0, steps);
    check(program.length === steps, `the DSP has ${steps} steps, state.getDisassembly {dsp} returned ${program.length} lines for them`);
    const loaded = program.filter((line) => /[1-9A-F]/.test(line.bytes));
    check(loaded.length > 0, "every step of the DSP is empty (all MPRO words are zero): the DSP test program loads a DSP program");
    const from = Math.min(stepOf(stepped.tick), steps - 16);
    const lines = await disassemble(context, "dsp", from, 16);
    check(lines.length === 16, `${lines.length} lines of DSP disassembly for count 16 at step ${from}`);
    lines.forEach((line, position) => {
      check(line.address === from + position, `dsp: line ${position} at step ${from} is step ${line.address}`);
      check(/^[0-9A-F]{2}( [0-9A-F]{2}){7}$/.test(line.bytes), `dsp: the bytes of step ${line.address} are "${line.bytes}", expected the four MPRO words as 8 pairs`);
      check(line.disassembly.length > 0, `dsp: step ${line.address} has no text`);
      check(JSON.stringify(line) === JSON.stringify(program[line.address]), `dsp: step ${line.address} reads differently in two requests while the target is paused`);
    });

    // A code breakpoint on a step of the loaded program is hit, with STEP equal to its address;
    // and one on the last step, from which a step wraps to step 0.
    const hitAt = async (address: number): Promise<TickRecord> => {
      const breakpoint = await addBreakpoint(context, { event: dsp.breakpointEvent, address });
      const armed = session.latestTick().tick;
      const mark = session.mark();
      await session.call("control.runUntil", {});
      const hit = await session.waitForTick((tick) => isPaused(tick) && stopIdOf(tick) > stopIdOf(armed), 5000, `a paused tick at the dsp breakpoint on step ${address}`, mark);
      check(hit.tick.executionState.breakpointId === breakpoint.id, `the stop reports breakpointId ${hit.tick.executionState.breakpointId}, expected ${breakpoint.id}`);
      check(hit.tick.executionState.reason === "breakpoint", `the stop has reason "${hit.tick.executionState.reason}", expected "breakpoint"`);
      check(stepOf(hit.tick) === address, `the stop is at step ${stepOf(hit.tick)}, the breakpoint at step ${address}`);
      await removeBreakpoint(context, breakpoint.id);
      return hit;
    };
    const current = stepOf(session.latestTick().tick);
    await hitAt((loaded.find((line) => line.address > current && line.address !== dsp.addressMax) ?? loaded[0]).address);
    await hitAt(dsp.addressMax);
    const wrapped = await stepOnce(context, "dsp");
    check(stepOf(wrapped.tick) === 0, `a DSP step from step ${dsp.addressMax} ended at ${stepOf(wrapped.tick)}; the last step is followed by step 0`);

    // there is nothing to step over or out of in a DSP program
    await session.expectError("control.stepOver", { target: "dsp" }, -32004);
    await session.expectError("control.stepOut", { target: "dsp" }, -32004);
  },
};

/** In the order they are run: ids are names, and S19 and S20 come behind S14. */
export const SCENARIOS: Scenario[] = [s00, s01, s02, s03, s04, s05, s06, s07, s08, s09, s10, s11, s12, s13, s14, s19, s20, s15, s16, s17, s18, s21];

/**
 * The scenarios a server of `milestone` has to pass, i.e. the gate of that milestone: those
 * of the milestone and of the ones before it, without those of the other profile. A gate
 * from M3 on is two runs: this one, with the test program of M1, has everything but what
 * needs a program that loads the DSP; the second one (`dspProgram`), against a server started
 * with the DSP test program, has the anchor and those scenarios alone.
 */
export const scenariosOfMilestone = (milestone: Milestone, profile: Profile, dspProgram = false): string[] =>
  SCENARIOS.filter(
    (scenario) =>
      MILESTONES.indexOf(scenario.milestone ?? "M1") <= MILESTONES.indexOf(milestone) &&
      (profile === "emulator" || !scenario.emulatorOnly) &&
      (dspProgram ? scenario.dspProgram === true || scenario.id === "S00" : scenario.dspProgram !== true),
  ).map((scenario) => scenario.id);

export interface Selection {
  /** the scenarios the run runs, in the order of SCENARIOS */
  selected: string[];
  /** the scenarios that have to pass: every selected one under the gate of a milestone, and those `require` names */
  required: string[];
}

/**
 * What a run runs and what of it has to pass (design 5.5.3). `milestone` selects the gate of
 * that milestone and requires each of its scenarios to pass. Without it every scenario is
 * selected (with `dspProgram`: the anchor and the scenarios of the DSP test program), and
 * none is required. `require` names further scenarios that are run and have to pass, and so
 * does `parts`, for the scenarios whose parts it names. `only`
 * narrows the selection, also inside a gate: what it leaves out is not run, and a gate
 * scenario it leaves out is not asked for. It never makes an empty result a success: that is
 * the run's verdict when nothing passed.
 */
export const selectScenarios = (options: {
  profile: Profile;
  milestone?: Milestone;
  dspProgram?: boolean;
  only?: Set<string>;
  require?: Set<string>;
  parts?: ReadonlyMap<string, ReadonlySet<string>>;
}): Selection => {
  const { profile, milestone, dspProgram = false, only } = options;
  // a scenario whose parts are named is run for them, and has to pass with them
  const require = new Set([...(options.require ?? []), ...(options.parts?.keys() ?? [])]);
  const order = SCENARIOS.map((scenario) => scenario.id);
  const gate = milestone ? scenariosOfMilestone(milestone, profile, dspProgram) : undefined;
  const base = gate ?? (dspProgram ? SCENARIOS.filter((scenario) => scenario.dspProgram || (scenario.id === "S00" && profile === "emulator")).map((scenario) => scenario.id) : order);
  const kept = (id: string) => !only || only.has(id);
  return {
    selected: order.filter((id) => (base.includes(id) || require.has(id)) && kept(id)),
    required: order.filter((id) => require.has(id) || (gate?.includes(id) && kept(id))),
  };
};

/**
 * Runs one scenario. It fails when an assertion fails, when the scenario throws, or when
 * the session recorded an invariant violation while it ran.
 */
export const runScenario = async (scenario: Scenario, context: RunContext): Promise<ScenarioResult> => {
  const started = monotonicNow();
  const details: string[] = [];
  const notes: string[] = [];
  const noteBefore = context.note;
  context.note = (text) => {
    details.push(text);
    notes.push(text);
  };
  const violationsBefore = context.session.violations.length;
  let status: ScenarioStatus = "passed";
  let parts: PartResult[] | undefined;
  try {
    const outcome = await scenario.run(context);
    if (outcome && "notApplicable" in outcome) {
      status = "not-applicable";
      details.unshift(outcome.notApplicable);
    } else if (outcome && "partial" in outcome) {
      status = "partial";
      details.unshift(outcome.partial);
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
  return { id: scenario.id, title: scenario.title, status, durationMs: Math.round(monotonicNow() - started), details, notes, ...(parts ? { parts } : {}) };
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
  const stopped = context.session.stoppedAnswering;
  if (stopped) {
    // Nothing is sent to a server that has stopped answering, so nothing can be put back. What
    // its last tick shows of the difference is reported: that much is known of what is left.
    const last = context.session.ticks.at(-1)?.tick;
    return { problems: [`nothing could be put back: ${stopped}`, ...(last ? differencesFrom(baseline, last, restoreState) : [])], tick: last };
  }
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
