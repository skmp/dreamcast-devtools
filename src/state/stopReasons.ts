// `executionState.reason` of a paused tick: why the target is stopped. The server may send a
// reason this build does not know (the field is an open string); it is then shown as it came.

const REASONS: Record<string, string> = {
  pause: "paused by the debugger",
  step: "step completed",
  breakpoint: "breakpoint",
  event: "event breakpoint",
  reset: "reset",
  start: "waiting at the start",
  capture: "capture finished",
  "host-stopped": "stopped in the emulator's window",
  "guest-exit": "the program has exited",
  "no-game": "no game loaded",
};

/** Stops that are not the debugger's: the machine is stopped by its host, or there is none. */
const HOST_REASONS = new Set(["host-stopped", "guest-exit", "no-game"]);

export const describeStopReason = (reason: string): string => REASONS[reason] ?? reason;

/**
 * Whether Run and the step buttons can do anything in a stop with this reason. In the stops
 * of the host the server refuses every control request (-32001, -32002): resuming is done
 * in the emulator's own window.
 */
export const canResume = (reason: string | undefined): boolean => reason === undefined || !HOST_REASONS.has(reason);
