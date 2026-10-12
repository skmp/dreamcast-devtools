import { BREAKPOINT_CATEGORIES } from "../lib/debuggerSchema";
import type {
  BreakpointCategory,
  BreakpointCategoryState,
  BreakpointDescriptor,
  CallstackFrame,
  DebuggerTick,
  EventLogEntry,
  ExecutionState,
  RegisterValue,
  WatchDescriptor,
} from "../lib/debuggerSchema";

// What the client knows from the ticks of one connection, and how a tick changes it. Pure:
// the store applies it, the tests call it directly.
//
// A tick is a snapshot of everything except `registers`, which is merged per path: a path
// that is present carries its complete register list and replaces the stored one, an absent
// path keeps its value. A running server sends five ticks a second and most of what they
// carry is what the previous one carried, so every part of the state keeps its identity when
// its content did not change: a component that selects one part renders again only when
// that part is different.

export type CategoryStates = Record<BreakpointCategory, BreakpointCategoryState>;

/** A stop of the target that the client has acted on: followed the PC, fetched again, announced. */
export interface StopInfo {
  /** counts the stops of this connection, from 1; what follows a stop is keyed on it */
  serial: number;
  /** `executionState.stopId` of its tick */
  stopId: number;
  reason?: string;
  breakpointId?: number;
}

export interface LiveState {
  /** ticks applied since the connection was initialised */
  ticks: number;
  /** of the latest tick; undefined before the first one */
  executionState?: ExecutionState;
  registersByPath: Record<string, RegisterValue[]>;
  breakpoints: BreakpointDescriptor[];
  eventLog: EventLogEntry[];
  watches: WatchDescriptor[];
  callstacks: Record<string, CallstackFrame[]>;
  categories: CategoryStates;
  /** the last stop acted on; stays while the target runs again */
  stop?: StopInfo;
  /**
   * Counts the moments at which what a view fetched (disassembly, memory) is out of date:
   * every new stop, and a game being loaded where there was none. Never a tick as such.
   */
  refresh: number;
  /**
   * The first tick of the connection: its registers, and `refresh` after it. A view that
   * was waiting for the connection opens where the target was then.
   */
  first?: { registers: Record<string, RegisterValue[]>; refresh: number };
}

/** `reason` of the stop that is not one: no game is loaded, and there is no machine to have a state. */
export const NO_GAME = "no-game";

export const defaultCategoryStates = (): CategoryStates => ({
  events: { muted: false, soloed: false },
  sh4: { muted: false, soloed: false },
  arm7: { muted: false, soloed: false },
  dsp: { muted: false, soloed: false },
});

/** The state of a connection before its first tick. */
export const emptyLiveState = (): LiveState => ({
  ticks: 0,
  executionState: undefined,
  registersByPath: {},
  breakpoints: [],
  eventLog: [],
  watches: [],
  callstacks: {},
  categories: defaultCategoryStates(),
  stop: undefined,
  refresh: 0,
  first: undefined,
});

export interface TickOutcome {
  state: LiveState;
  /** the tick reports a stop that has not been acted on yet */
  newStop: boolean;
  /** the breakpoint to announce: its descriptor, or its id when the tick does not list it */
  hit?: BreakpointDescriptor | { id: number };
}

const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) {
    return true;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let index = 0; index < a.length; index++) {
      if (!sameValue(a[index], b[index])) {
        return false;
      }
    }
    return true;
  }
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) {
    return false;
  }
  for (const key of keysA) {
    if (!Object.hasOwn(b, key) || !sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) {
      return false;
    }
  }
  return true;
};

/** `next`, or `previous` itself when they say the same. */
const keep = <T>(previous: T, next: T): T => (sameValue(previous, next) ? previous : next);

/** Event ids are unique per server process: two logs with the same ids are the same log. */
const sameEventLog = (a: EventLogEntry[], b: EventLogEntry[]): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = a.length - 1; index >= 0; index--) {
    if (a[index].eventId !== b[index].eventId) {
      return false;
    }
  }
  return true;
};

const mergeRegisters = (
  stored: Record<string, RegisterValue[]>,
  incoming: Record<string, RegisterValue[]>,
): Record<string, RegisterValue[]> => {
  let merged = stored;
  for (const path of Object.keys(incoming)) {
    const list = incoming[path];
    if (Object.hasOwn(stored, path) && sameValue(stored[path], list)) {
      continue;
    }
    if (merged === stored) {
      merged = { ...stored };
    }
    merged[path] = list;
  }
  return merged;
};

/** The client reads only the keys it knows; a key the tick does not carry keeps its state. */
const mergeCategories = (stored: CategoryStates, incoming: DebuggerTick["categories"]): CategoryStates => {
  if (!incoming) {
    return stored;
  }
  const merged = { ...stored };
  for (const key of BREAKPOINT_CATEGORIES) {
    const state = incoming[key];
    if (state) {
      merged[key] = { muted: state.muted, soloed: state.soloed };
    }
  }
  return keep(stored, merged);
};

export const applyTick = (previous: LiveState, tick: DebuggerTick): TickOutcome => {
  const execution = tick.executionState;
  const paused = execution.state === "paused";

  // The server counts its stops: a stop is new when its stopId is not the one acted on last,
  // and the first paused tick of a connection counts. A paused tick that merely arrives (after
  // a breakpoint or a watch was added, say) is not a stop, and neither is a paused tick
  // without a stopId: no stop is made from the run state changing to paused.
  const stopId = paused ? execution.stopId : undefined;
  const stop: StopInfo | undefined =
    stopId !== undefined && previous.stop?.stopId !== stopId
      ? {
          serial: (previous.stop?.serial ?? 0) + 1,
          stopId,
          reason: execution.reason,
          breakpointId: execution.breakpointId,
        }
      : previous.stop;
  const newStop = stop !== previous.stop;

  const breakpoints = keep(previous.breakpoints, Object.values(tick.breakpoints));
  // The frames are those of the tick, and a tick without `callstacks` has none: nothing is
  // kept from the stop before.
  const callstacks = tick.callstacks ?? {};

  // With no game loaded there is no machine, and its ticks carry no registers: under the
  // merge the values of the machine that is gone would stay. Nothing has a value then.
  const noMachine = paused && execution.reason === NO_GAME;
  const registersByPath = noMachine
    ? keep(previous.registersByPath, mergeRegisters({}, tick.registers))
    : mergeRegisters(previous.registersByPath, tick.registers);

  // a stop moves the views, and so does a game that has just been loaded: until then they had nothing to read
  const appeared = previous.executionState?.reason === NO_GAME && !noMachine;
  const refresh = previous.refresh + (newStop || appeared ? 1 : 0);

  const state: LiveState = {
    ticks: previous.ticks + 1,
    executionState: keep(previous.executionState, execution),
    registersByPath,
    breakpoints,
    eventLog: sameEventLog(previous.eventLog, tick.eventLog) ? previous.eventLog : tick.eventLog,
    watches: keep(previous.watches, tick.watches ?? []),
    callstacks: keep(previous.callstacks, callstacks),
    categories: mergeCategories(previous.categories, tick.categories),
    stop,
    refresh,
    first: previous.first ?? { registers: tick.registers, refresh },
  };

  // every paused tick of a stop names its breakpoint; it is announced once, with the stop
  const hit =
    newStop && execution.breakpointId !== undefined
      ? (tick.breakpoints[String(execution.breakpointId)] ?? { id: execution.breakpointId })
      : undefined;
  return { state, newStop, hit };
};
