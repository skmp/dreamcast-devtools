import { ConformanceSchemas, PROTOCOL_BOUNDS } from "../../src/lib/debuggerSchema";
import type { DebuggerShape, DebuggerTick, DeviceNodeDescriptor } from "../../src/lib/debuggerSchema";
import { ARM7_ENABLED_REGISTER, BASE_PATHS, TARGET_TABLE } from "./design";

/**
 * The invariants of the contract (design 5.5, I1 to I8), applied to every tick of every
 * connection of a run: the strict schema and no null (I1); tickId and the timestamp, which
 * is the wall clock in ms (I2); breakpoint keys, and an event log whose eventIds ascend and
 * name the same entry in every tick, with wall-clock timestamps (I3); register lists that
 * are the describe lists (I4); full paused ticks, four base paths while running, a stopId
 * that never goes back (I5); watches in id order that read what their registers read (I6);
 * a breakpointId that comes with its reason and names a breakpoint the tick lists (I7); ids
 * that are never used again (I8). And two that came with milestone M2: no register of a tick
 * says that it has a writer (I4: `flags` is describe's), and the ARM7 callstack of a paused
 * tick follows the register ENABLED of dc.aica.arm7 in that tick (2.10). Pure functions: the
 * session feeds them what arrived.
 */

/** The path a running tick omits, with `registersStale: true`, on a backend without a context at the slice hook. */
const SH4_CONTEXT_PATH = "dc.sh4.cpu";

export interface DescribeIndex {
  /** node path -> its register names (in describe order) and widths; only nodes with registers */
  registers: Map<string, Array<{ name: string; width: number }>>;
  /** every node path */
  paths: Set<string>;
  /** every event a node lists */
  events: Set<string>;
  /** the describe lists the target arm7 */
  arm7: boolean;
  /** the describe advertises the capability "callstack": paused ticks carry frames */
  callstack: boolean;
}

export const indexDescribe = (shape: DebuggerShape): DescribeIndex => {
  const index: DescribeIndex = {
    registers: new Map(),
    paths: new Set(),
    events: new Set(),
    arm7: shape.targets?.some((target) => target.id === "arm7") ?? false,
    callstack: shape.capabilities?.includes("callstack") ?? false,
  };
  const visit = (nodes: DeviceNodeDescriptor[]) => {
    for (const node of nodes) {
      index.paths.add(node.path);
      (node.events ?? []).forEach((event) => index.events.add(event));
      if (node.registers?.length) {
        index.registers.set(
          node.path,
          node.registers.map((register) => ({ name: register.name, width: register.width })),
        );
      }
      if (node.children) {
        visit(node.children);
      }
    }
  };
  visit(shape.deviceTree);
  return index;
};

/** The path of the first `null` in a JSON value, or undefined. */
export const findNull = (value: unknown, path = "$"): string | undefined => {
  if (value === null) {
    return path;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = findNull(value[index], `${path}[${index}]`);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const found = findNull(entry, `${path}.${key}`);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
};

/** How a register value of the given width is written: "0x" + ceil(width / 4) upper-case hex digits, or "n/a". */
export const registerValuePattern = (width: number): RegExp => new RegExp(`^(0x[0-9A-F]{${Math.ceil(width / 4)}}|n/a)$`);

/** What the invariants remember from one tick to the next, per connection. */
export interface TickTracking {
  lastTickId?: number;
  lastStopId?: number;
  /** eventId -> the entry it named when a tick of this connection first carried it */
  events?: Map<string, string>;
  /** the breakpoint ids and the watch ids the last tick listed, and those an earlier tick listed and a later one did not */
  breakpoints?: IdHistory;
  watches?: IdHistory;
}

interface IdHistory {
  listed: Set<number>;
  gone: Set<number>;
}

/**
 * I8 for one kind of id: an id that a tick of the connection listed and a later tick did
 * not is gone for good. Returns the ids of `now` that had gone.
 */
const idsThatCameBack = (history: IdHistory, now: number[]): number[] => {
  const current = new Set(now);
  const back = now.filter((id) => history.gone.has(id));
  // (said for the tick in which it comes back, not for every tick that lists it from then on)
  back.forEach((id) => history.gone.delete(id));
  for (const id of history.listed) {
    if (!current.has(id)) {
      history.gone.add(id);
    }
  }
  history.listed = current;
  return back;
};

/** `timestamp` is wall-clock ms: it is this far from the runner's clock at most (two machines, two clocks). */
const CLOCK_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/**
 * Checks one tick as it arrived (`raw` is the parsed `params` of the notification, before
 * any schema touched it). Returns the violations, each starting with the invariant it
 * breaks; an empty list means the tick is fine. `index` is undefined until the describe
 * result is known, and I4 / I5 are skipped then. `now` is the runner's clock when the tick
 * arrived.
 */
export const checkTick = (raw: unknown, index: DescribeIndex | undefined, tracking: TickTracking, now: number = Date.now()): string[] => {
  const violations: string[] = [];

  // I1: the strict copy of the schema, and no null
  const nullAt = findNull(raw);
  if (nullAt) {
    violations.push(`I1: the tick contains null at ${nullAt}`);
  }
  const parsed = ConformanceSchemas.DebuggerTickSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 8)) {
      violations.push(`I1: tick.${issue.path.map(String).join(".")}: ${issue.message}`);
    }
    if (parsed.error.issues.length > 8) {
      violations.push(`I1: ... and ${parsed.error.issues.length - 8} more schema issues in the same tick`);
    }
    // the remaining invariants read fields the schema just rejected
    return violations;
  }
  const tick = raw as DebuggerTick;
  const state = tick.executionState;

  // I2: tickId strictly increases per connection, and the timestamp is wall-clock ms
  if (tracking.lastTickId !== undefined && tick.tickId <= tracking.lastTickId) {
    violations.push(`I2: tickId ${tick.tickId} follows tickId ${tracking.lastTickId}`);
  }
  tracking.lastTickId = tick.tickId;
  if (Math.abs(tick.timestamp - now) > CLOCK_TOLERANCE_MS) {
    violations.push(`I2: timestamp ${tick.timestamp} is not the wall clock in ms; the clock of this machine reads ${now}`);
  }

  // I3: breakpoint keys, event ids, size of the event log
  for (const [key, breakpoint] of Object.entries(tick.breakpoints)) {
    if (key !== String(breakpoint.id)) {
      violations.push(`I3: breakpoints["${key}"] has id ${breakpoint.id}`);
    }
  }
  const eventIds = new Set<string>();
  for (const entry of tick.eventLog) {
    if (eventIds.has(entry.eventId)) {
      violations.push(`I3: eventId ${entry.eventId} appears twice in the event log`);
    }
    eventIds.add(entry.eventId);
  }
  // 2.6: an eventId is a sequence number of the process. The log is oldest first, so the ids
  // ascend in it; and an id names one entry, the same one in every tick that carries it.
  const known = (tracking.events ??= new Map<string, string>());
  let descending = false;
  let renamed = false;
  let offClock = false;
  let unlisted = false;
  tick.eventLog.forEach((entry, position) => {
    // the timestamp of an entry is wall-clock ms, like the tick's: the UI shows it as a time of day
    if (Math.abs(entry.timestamp - now) > CLOCK_TOLERANCE_MS && !offClock) {
      offClock = true;
      violations.push(
        `I3: the timestamp ${entry.timestamp} of the event-log entry ${entry.eventId} is not the wall clock in ms; the clock of this machine reads ${now}`,
      );
    }
    // 2.6: a server lists in the events of its device tree exactly the events it can raise
    const event = (entry.metadata as { event?: unknown } | undefined)?.event;
    if (index && typeof event === "string" && !index.events.has(event) && !unlisted) {
      unlisted = true;
      violations.push(`2.6: the event log has an entry of ${event} (eventId ${entry.eventId}), which no node of the device tree lists; a server lists the events it can raise`);
    }
    const before = position > 0 ? tick.eventLog[position - 1].eventId : undefined;
    if (before !== undefined && BigInt(entry.eventId) < BigInt(before) && !descending) {
      descending = true;
      violations.push(`I3: the event log is oldest first and its eventIds ascend; eventId ${entry.eventId} follows eventId ${before}`);
    }
    const said = JSON.stringify([entry.timestamp, entry.subsystem, entry.severity, entry.message, entry.metadata?.event, entry.metadata?.cycles]);
    const first = known.get(entry.eventId);
    if (first === undefined) {
      known.set(entry.eventId, said);
    } else if (first !== said && !renamed) {
      renamed = true;
      violations.push(`I3: eventId ${entry.eventId} named another entry in an earlier tick: it is ${said} now and was ${first}`);
    }
  });
  if (tick.eventLog.length > PROTOCOL_BOUNDS.eventLogEntries) {
    violations.push(`I3: the event log has ${tick.eventLog.length} entries`);
  }

  if (index) {
    // I4: register lists are the describe lists; values are formatted to their width
    for (const [path, registers] of Object.entries(tick.registers)) {
      const described = index.registers.get(path);
      if (!described) {
        violations.push(
          index.paths.has(path)
            ? `I4: registers["${path}"]: the describe tree lists no registers for this node`
            : `I4: registers["${path}"] is not a path of the describe tree`,
        );
        continue;
      }
      const names = registers.map((register) => register.name);
      const expected = described.map((register) => register.name);
      if (names.length !== expected.length || names.some((name, position) => name !== expected[position])) {
        violations.push(`I4: registers["${path}"] carries [${names.join(" ")}], describe lists [${expected.join(" ")}]`);
        continue;
      }
      // `flags` is what debugger.describe says of a register (that it has a writer); a tick carries values
      const flagged = registers.find((register) => "flags" in register);
      if (flagged) {
        violations.push(`I4: ${path}.${flagged.name} carries flags in a tick; flags are debugger.describe's, a register of a tick has name, value and width`);
      }
      registers.forEach((register, position) => {
        const width = described[position].width;
        if (register.width !== width) {
          violations.push(`I4: ${path}.${register.name} has width ${register.width} in the tick and ${width} in describe`);
        } else if (width > 0 && !registerValuePattern(width).test(register.value)) {
          violations.push(`I4: ${path}.${register.name} = "${register.value}" is not 0x + ${Math.ceil(width / 4)} upper-case hex digits or "n/a"`);
        }
      });
    }

    // I5: a paused tick is full; a running tick has at least the four base paths
    if (state.state === "paused") {
      // with no game loaded there is no machine to read: ticks carry `registers: {}`
      if (state.reason === "no-game") {
        if (Object.keys(tick.registers).length > 0) {
          violations.push(`I5: a tick with reason "no-game" carries registers {}, this one carries ${Object.keys(tick.registers).slice(0, 3).join(", ")}`);
        }
      } else {
        const missing = Array.from(index.registers.keys()).filter((path) => !(path in tick.registers));
        if (missing.length > 0) {
          violations.push(`I5: a paused tick is full, this one lacks ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""}`);
        }
      }
    } else {
      for (const path of BASE_PATHS) {
        if (path in tick.registers) {
          continue;
        }
        if (path === SH4_CONTEXT_PATH && state.registersStale === true) {
          continue;
        }
        violations.push(`I5: a running tick carries ${path}${path === SH4_CONTEXT_PATH ? " (or says registersStale)" : ""}`);
      }
      if (state.registersStale === true && SH4_CONTEXT_PATH in tick.registers) {
        violations.push("I5: registersStale is set although the tick carries dc.sh4.cpu");
      }
    }
  }

  // I5 / 2.2.8: registersStale says that a running tick omits dc.sh4.cpu. A paused tick is
  // full, and at a stop the SH4 context is complete.
  if (state.state === "paused" && state.registersStale === true) {
    violations.push("I5: registersStale in a paused tick; a paused tick is full, and the SH4 context is complete at a stop");
  }

  // I5: stopId never decreases
  const stopId = state.stopId!;
  if (tracking.lastStopId !== undefined && stopId < tracking.lastStopId) {
    violations.push(`I5: stopId ${stopId} follows stopId ${tracking.lastStopId}`);
  }
  tracking.lastStopId = stopId;

  // I5: running ticks carry empty callstacks (and, by the strict schema, neither reason nor breakpointId)
  if (state.state === "running" && ((tick.callstacks?.sh4?.length ?? 0) > 0 || (tick.callstacks?.arm7?.length ?? 0) > 0)) {
    violations.push("I5: a running tick carries callstack frames");
  }
  // 2.10: the ARM7 callstack of a paused tick follows the register ENABLED of dc.aica.arm7 in
  // that tick, in every stop of the debugger: of a server that lists the ARM7 and has the
  // capability "callstack". (The stops of the host carry what the host left: not looked at.)
  const hostStop = state.reason === "host-stopped" || state.reason === "guest-exit" || state.reason === "no-game";
  if (index?.arm7 && index.callstack && state.state === "paused" && !hostStop) {
    violations.push(...checkArm7Pairing(tick));
  }
  // I7: a breakpointId comes with the reason of a breakpoint stop, and it is a key of
  // `breakpoints` in the same tick: in every tick that carries one, not only in the first tick
  // of a stop. When the breakpoint of a stop is removed, the later ticks of that stop keep the
  // reason and stop carrying the id (2.3.1), so the two reasons can come without one.
  if (state.breakpointId !== undefined) {
    if (!(String(state.breakpointId) in tick.breakpoints)) {
      violations.push(`I7: breakpointId ${state.breakpointId} is not a key of breakpoints in the same tick (stop ${stopId}); a tick stops carrying the id of a breakpoint that was removed`);
    }
    if (state.reason !== "breakpoint" && state.reason !== "event") {
      violations.push(`I7: breakpointId with reason "${state.reason}"`);
    }
  }
  // I8: ids are never reused. Every tick lists every breakpoint and every watch, so an id that
  // a tick listed and a later tick did not has been removed, and nothing new gets it.
  const breakpointIds = Object.values(tick.breakpoints).map((breakpoint) => breakpoint.id);
  for (const id of idsThatCameBack((tracking.breakpoints ??= { listed: new Set(), gone: new Set() }), breakpointIds)) {
    violations.push(`I8: breakpoint id ${id} is listed again after a tick that did not list it; ids are never reused`);
  }
  // I6: watches in id order
  const watchIds = (tick.watches ?? []).map((watch) => watch.id);
  if (watchIds.some((id, position) => position > 0 && id <= watchIds[position - 1])) {
    violations.push(`I6: watches are not in id order: ${watchIds.join(", ")}`);
  }
  for (const id of idsThatCameBack((tracking.watches ??= { listed: new Set(), gone: new Set() }), watchIds)) {
    violations.push(`I8: watch id ${id} is listed again after a tick that did not list it; ids are never reused`);
  }
  // I6: watches are evaluated in every tick. A watch on <path>.<name> reads what that register
  // reads in the same tick, when the tick carries the path; while the SH4 context is stale
  // (2.2.8) a watch on it reads "n/a".
  for (const watch of tick.watches ?? []) {
    const dot = watch.expression.lastIndexOf(".");
    const path = watch.expression.slice(0, dot);
    const name = watch.expression.slice(dot + 1);
    if (state.registersStale === true && path === SH4_CONTEXT_PATH) {
      if (watch.value !== "n/a") {
        violations.push(`I6: watch ${watch.id} (${watch.expression}) reads ${JSON.stringify(watch.value)} in a tick that says registersStale, expected "n/a"`);
      }
      continue;
    }
    const register = dot > 0 ? tick.registers[path]?.find((candidate) => candidate.name.toLowerCase() === name) : undefined;
    if (register && watch.value !== register.value) {
      violations.push(`I6: watch ${watch.id} (${watch.expression}) reads ${JSON.stringify(watch.value)}, the register in the same tick reads "${register.value}"`);
    }
  }

  return violations;
};

const hex8 = (value: number) => `0x${value.toString(16).toUpperCase().padStart(8, "0")}`;

/**
 * The pairing of 2.10 in one paused tick: ENABLED of dc.aica.arm7 reads 0 or 1; with 0 the
 * ARM7 has no frames; with 1 it has at least two, frame 0 at its PC without a location and
 * frame 1 at R14 with location "lr".
 */
const checkArm7Pairing = (tick: DebuggerTick): string[] => {
  const { path, name } = ARM7_ENABLED_REGISTER;
  const registers = tick.registers[path];
  if (!registers) {
    // (a paused tick that lacks the path is I5's to report)
    return [];
  }
  const valueOf = (register: string): number | undefined => {
    const value = registers.find((candidate) => candidate.name === register)?.value;
    return value !== undefined && /^0x[0-9A-F]+$/.test(value) ? Number.parseInt(value, 16) : undefined;
  };
  const enabled = valueOf(name);
  const frames = tick.callstacks?.arm7 ?? [];
  const count = `${frames.length} frame${frames.length === 1 ? "" : "s"}`;
  if (enabled !== 0 && enabled !== 1) {
    const read = registers.find((candidate) => candidate.name === name)?.value;
    return [`2.10: ${path}.${name} ${read === undefined ? "is not in the paused tick" : `reads ${JSON.stringify(read)} in the paused tick`}; it reads 1 while the ARM7 is clocked and 0 while it is held in reset`];
  }
  if (enabled === 0) {
    return frames.length === 0 ? [] : [`2.10: ${path}.${name} reads 0 (the ARM7 is held in reset), and the ARM7 callstack of the paused tick has ${count}; it has none then`];
  }
  if (frames.length < 2) {
    return [`2.10: ${path}.${name} reads 1 (the ARM7 is clocked), and the ARM7 callstack of the paused tick has ${count}; it has at least two then (frame 0 the PC, frame 1 the link register)`];
  }
  const found: string[] = [];
  const pc = valueOf(TARGET_TABLE.arm7.pcRegister);
  const linkRegister = valueOf("R14");
  if (pc !== undefined && frames[0].pc !== pc) {
    found.push(`2.10: frame 0 of the ARM7 callstack is at ${hex8(frames[0].pc)}, the PC of ${path} in the same paused tick is ${hex8(pc)}`);
  }
  if (frames[0].location !== undefined) {
    found.push(`2.10: frame 0 of the ARM7 callstack is the PC and has no location, this one has "${frames[0].location}"`);
  }
  if (linkRegister !== undefined && frames[1].pc !== linkRegister) {
    found.push(`2.10: frame 1 of the ARM7 callstack is at ${hex8(frames[1].pc)}, R14 of ${path} in the same paused tick is ${hex8(linkRegister)}`);
  }
  if (frames[1].location !== "lr") {
    found.push(`2.10: frame 1 of the ARM7 callstack has location "${frames[1].location}", expected "lr"`);
  }
  return found;
};

/**
 * Checks a response frame's envelope: JSON-RPC 2.0, a numeric id (null only for a parse
 * error), exactly one of result and error, and an error object of `code` and `message` only.
 */
export const checkResponseEnvelope = (frame: Record<string, unknown>): string[] => {
  const violations: string[] = [];
  const keys = Object.keys(frame).sort().join(",");
  const hasResult = "result" in frame;
  const hasError = "error" in frame;
  if (frame.jsonrpc !== "2.0") {
    violations.push(`3.0: a response without jsonrpc "2.0"`);
  }
  if (hasResult === hasError) {
    violations.push(`3.0: a response has exactly one of result and error, this one has the keys ${keys}`);
  }
  if (keys !== "id,jsonrpc,result" && keys !== "error,id,jsonrpc") {
    violations.push(`3.0: a response has the keys jsonrpc, id and result or error, this one has ${keys}`);
  }
  if (hasError) {
    const error = frame.error as Record<string, unknown> | null;
    if (!error || typeof error !== "object") {
      violations.push("3.5: error is not an object");
    } else {
      const errorKeys = Object.keys(error).sort().join(",");
      if (errorKeys !== "code,message") {
        violations.push(`3.5: an error object has code and message only, this one has ${errorKeys}`);
      }
      if (!Number.isInteger(error.code) || typeof error.message !== "string") {
        violations.push("3.5: error.code is an integer and error.message a string");
      } else if (error.message.length === 0) {
        violations.push(`3.5: the error ${String(error.code)} has an empty message; error.message is a non-empty string`);
      }
      if (frame.id === null && error.code !== -32700 && error.code !== -32600) {
        violations.push(`3.0: id null in a response with code ${String(error.code)}`);
      }
    }
  }
  if (typeof frame.id !== "number" && frame.id !== null) {
    violations.push(`3.0: the id of a response is a JSON number, this one is ${JSON.stringify(frame.id)}`);
  }
  if (hasResult) {
    const nullAt = findNull(frame.result, "result");
    if (nullAt) {
      violations.push(`3.0: null at ${nullAt}`);
    }
  }
  return violations;
};
