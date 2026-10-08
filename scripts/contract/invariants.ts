import { ConformanceSchemas, PROTOCOL_BOUNDS } from "../../src/lib/debuggerSchema";
import type { DebuggerShape, DebuggerTick, DeviceNodeDescriptor } from "../../src/lib/debuggerSchema";

/**
 * The invariants of the contract (design 5.5, I1 to I5), applied to every tick of every
 * connection of a run. Pure functions: the session feeds them what arrived.
 */

/** The three paths every running tick carries: the PC of every target. */
export const HARD_WIRED_PATHS = ["dc.sh4.cpu", "dc.aica.arm7", "dc.aica.dsp"] as const;
/** The path a running tick omits, with `registersStale: true`, on a backend without a context at the slice hook. */
const SH4_CONTEXT_PATH = "dc.sh4.cpu";

export interface DescribeIndex {
  /** node path -> its register names (in describe order) and widths; only nodes with registers */
  registers: Map<string, Array<{ name: string; width: number }>>;
  /** every node path */
  paths: Set<string>;
}

export const indexDescribe = (shape: DebuggerShape): DescribeIndex => {
  const index: DescribeIndex = { registers: new Map(), paths: new Set() };
  const visit = (nodes: DeviceNodeDescriptor[]) => {
    for (const node of nodes) {
      index.paths.add(node.path);
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
}

/**
 * Checks one tick as it arrived (`raw` is the parsed `params` of the notification, before
 * any schema touched it). Returns the violations, each starting with the invariant it
 * breaks; an empty list means the tick is fine. `index` is undefined until the describe
 * result is known, and I4 / I5 are skipped then.
 */
export const checkTick = (raw: unknown, index: DescribeIndex | undefined, tracking: TickTracking): string[] => {
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

  // I2: tickId strictly increases per connection
  if (tracking.lastTickId !== undefined && tick.tickId <= tracking.lastTickId) {
    violations.push(`I2: tickId ${tick.tickId} follows tickId ${tracking.lastTickId}`);
  }
  tracking.lastTickId = tick.tickId;

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
      registers.forEach((register, position) => {
        const width = described[position].width;
        if (register.width !== width) {
          violations.push(`I4: ${path}.${register.name} has width ${register.width} in the tick and ${width} in describe`);
        } else if (width > 0 && !registerValuePattern(width).test(register.value)) {
          violations.push(`I4: ${path}.${register.name} = "${register.value}" is not 0x + ${Math.ceil(width / 4)} upper-case hex digits or "n/a"`);
        }
      });
    }

    // I5: a paused tick is full; a running tick has at least the hard-wired paths
    if (state.state === "paused") {
      // with no game loaded there is no machine to read: ticks carry `registers: {}`
      if (state.reason !== "no-game") {
        const missing = Array.from(index.registers.keys()).filter((path) => !(path in tick.registers));
        if (missing.length > 0) {
          violations.push(`I5: a paused tick is full, this one lacks ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""}`);
        }
      }
    } else {
      for (const path of HARD_WIRED_PATHS) {
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

  // I5: stopId never decreases
  const stopId = state.stopId!;
  if (tracking.lastStopId !== undefined && stopId < tracking.lastStopId) {
    violations.push(`I5: stopId ${stopId} follows stopId ${tracking.lastStopId}`);
  }
  // (the first tick of a connection can belong to a stop that is older than the connection)
  const newStop = tracking.lastStopId !== undefined && stopId > tracking.lastStopId;
  tracking.lastStopId = stopId;

  // 2.9 / 2.10: running ticks carry empty callstacks
  if (state.state === "running" && ((tick.callstacks?.sh4?.length ?? 0) > 0 || (tick.callstacks?.arm7?.length ?? 0) > 0)) {
    violations.push("2.9: a running tick carries callstack frames");
  }
  // 3.2: a breakpointId comes with a breakpoint reason, and the tick that reports the hit lists
  // the breakpoint (later ticks of the same stop repeat the id, also after it has been removed)
  if (state.breakpointId !== undefined) {
    if (newStop && !(String(state.breakpointId) in tick.breakpoints)) {
      violations.push(`3.2: the first tick of stop ${stopId} reports breakpointId ${state.breakpointId}, which is not in its breakpoints`);
    }
    if (state.reason !== "breakpoint" && state.reason !== "event") {
      violations.push(`3.2: breakpointId with reason "${state.reason}"`);
    }
  } else if (state.reason === "breakpoint" || state.reason === "event") {
    violations.push(`3.2: reason "${state.reason}" without a breakpointId`);
  }
  // 2.8: watches in id order
  const watchIds = (tick.watches ?? []).map((watch) => watch.id);
  if (watchIds.some((id, position) => position > 0 && id <= watchIds[position - 1])) {
    violations.push(`2.8: watches are not in id order: ${watchIds.join(", ")}`);
  }
  // 2.8: watches are evaluated in every tick. A watch on <path>.<name> reads what that register
  // reads in the same tick, when the tick carries the path; while the SH4 context is stale
  // (2.2.8) a watch on it reads "n/a".
  for (const watch of tick.watches ?? []) {
    const dot = watch.expression.lastIndexOf(".");
    const path = watch.expression.slice(0, dot);
    const name = watch.expression.slice(dot + 1);
    if (state.registersStale === true && path === SH4_CONTEXT_PATH) {
      if (watch.value !== "n/a") {
        violations.push(`2.2.8: watch ${watch.id} (${watch.expression}) reads ${JSON.stringify(watch.value)} in a tick that says registersStale, expected "n/a"`);
      }
      continue;
    }
    const register = dot > 0 ? tick.registers[path]?.find((candidate) => candidate.name.toLowerCase() === name) : undefined;
    if (register && watch.value !== register.value) {
      violations.push(`2.8: watch ${watch.id} (${watch.expression}) reads ${JSON.stringify(watch.value)}, the register in the same tick reads "${register.value}"`);
    }
  }

  return violations;
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
