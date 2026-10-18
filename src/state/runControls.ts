import type { DebuggerTarget, ExecutionState, RegisterValue } from "../lib/debuggerSchema";
import { canResume, describeStopReason } from "./stopReasons";
import { registerNumber, type TargetInfo } from "./targets";

// The run controls of a workspace page: which of them can be used, and why the others cannot.
// Pure: the toolbar draws its buttons from it, the function keys ask it before they act, and
// the step buttons of a disassembly view take their state from the same rules.
//
// A control is off whenever its request could only be refused: no step is sent to a server
// that cannot step the target (-32004), to a target that runs (-32003), in a stop of the
// emulator's own window (-32001, -32002), or to an ARM7 that is held in reset (-32012); no
// reset to a server without the capability (-32004). A control that is off says why. The DSP
// is stepped while the ARM7 is held: the AICA is clocked whatever ARMRST says (`heldFor`).

export type RunControlId = "run" | "pause" | "step" | "stepOver" | "stepOut" | "reset";

/** In the order of the toolbar. */
export const RUN_CONTROL_IDS: readonly RunControlId[] = ["run", "pause", "step", "stepOver", "stepOut", "reset"];

/** What the buttons of the toolbar are called. */
export const RUN_CONTROL_NAMES: Readonly<Record<RunControlId, string>> = {
  run: "Run",
  pause: "Pause",
  step: "Step Into",
  stepOver: "Step Over",
  stepOut: "Step Out",
  reset: "Reset",
};

/** The key of each control as its tooltip names it; F8 and Shift+F8 are accepted for F11 and Shift+F11. */
export const RUN_CONTROL_KEYS: Readonly<Partial<Record<RunControlId, string>>> = {
  run: "F5",
  pause: "F6",
  step: "F11",
  stepOver: "F10",
  stepOut: "Shift+F11",
};

/** The same for assistive technology (`aria-keyshortcuts`): every key that works, separated by blanks. */
export const RUN_CONTROL_ARIA_KEYS: Readonly<Partial<Record<RunControlId, string>>> = {
  run: "F5",
  pause: "F6",
  step: "F11 F8",
  stepOver: "F10",
  stepOut: "Shift+F11 Shift+F8",
};

/**
 * The control a key press is for: F5 run, F6 pause, F10 step over, F11 step into, Shift+F11
 * step out, with F8 and Shift+F8 for the last two (F11 is the browser's full-screen key, and
 * not every browser hands it to a page). A key with Ctrl, Alt or Meta is somebody else's
 * (Ctrl+F5 reloads without the cache), and so is Shift with a key that has no use for it.
 */
export const hotkeyControl = (event: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): RunControlId | undefined => {
  if (event.ctrlKey || event.altKey || event.metaKey) {
    return undefined;
  }
  switch (event.key) {
    case "F5":
      return event.shiftKey ? undefined : "run";
    case "F6":
      return event.shiftKey ? undefined : "pause";
    case "F10":
      return event.shiftKey ? undefined : "stepOver";
    case "F11":
    case "F8":
      return event.shiftKey ? "stepOut" : "step";
    default:
      return undefined;
  }
};

/**
 * Whether the ARM7 is held in reset: `ENABLED` of its node reads 0. The node is the one its
 * program counter is in (`targets[].pcPath`), and the register is in every tick. A value that
 * is not there, or is no number ("n/a"), says nothing: the ARM7 is then not taken for held.
 */
export const arm7Held = (registersByPath: Record<string, RegisterValue[]>, arm7: Pick<DebuggerTarget, "pcPath">): boolean =>
  registerNumber(registersByPath[arm7.pcPath]?.find((register) => register.name === "ENABLED")?.value) === 0;

/**
 * Whether `target` is held in reset, so that its steps are off (`StepInput.held`): the ARM7
 * alone, while `ENABLED` of its node reads 0 (`arm7Held`). No other target is ever held. The
 * DSP is not: the emulator clocks the AICA whatever ARMRST says, so a step of the DSP and a
 * breakpoint on it work while the ARM7 is held, and only the ARM7's steps are refused then
 * (-32012). The toolbar and every disassembly view ask this, for the target they step.
 */
export const heldFor = (target: Pick<DebuggerTarget, "id" | "pcPath">, registersByPath: Record<string, RegisterValue[]>): boolean =>
  target.id === "arm7" && arm7Held(registersByPath, target);

export const NOT_CONNECTED = "not connected";
export const NO_SERVER_YET = "waiting for the server";
export const TARGET_RUNS = "the target is running";
export const TARGET_PAUSED = "the target is paused";
export const NO_RESET = "this server cannot reset the machine";
export const heldInReset = (label: string): string => `the ${label} is held in reset`;

export interface StepInput {
  /** the session has a connection */
  connected: boolean;
  /** the server of this connection has described itself: `target` is what it said */
  initialized: boolean;
  /** of the latest tick */
  execution?: Pick<ExecutionState, "state" | "reason">;
  /** the target the steps are for */
  target: Pick<TargetInfo, "id" | "label" | "supported" | "stepping">;
  /** `target` is held in reset: `heldFor(target, ...)`, which is the ARM7 alone (never the DSP) */
  held: boolean;
}

export interface RunControlsInput extends StepInput {
  /** the server has the capability "reset" */
  canReset: boolean;
}

/**
 * Why a target cannot be stepped now; undefined when it can. The words are what the tooltip
 * of a step button says behind its name ("Step Over: the target is running").
 *
 * What the server cannot do at all comes before what is so for the moment: a DSP this server
 * cannot step is not "running".
 */
export const stepOff = ({ connected, initialized, execution, target, held }: StepInput): string | undefined => {
  if (!connected) {
    return NOT_CONNECTED;
  }
  if (!initialized || execution === undefined) {
    return NO_SERVER_YET;
  }
  if (!target.supported) {
    return `this server does not support the ${target.label} target`;
  }
  if (!target.stepping) {
    return `this server cannot step the ${target.label}`;
  }
  if (execution.state !== "paused") {
    return TARGET_RUNS;
  }
  if (!canResume(execution.reason)) {
    return describeStopReason(execution.reason ?? "");
  }
  if (held) {
    return heldInReset(target.label);
  }
  return undefined;
};

/** For each control of the toolbar: why it is off, or undefined when it can be used. */
export const runControlsOff = (input: RunControlsInput): Record<RunControlId, string | undefined> => {
  const { connected, initialized, execution, target, canReset } = input;
  const step = stepOff(input);
  // Run and Pause go by the ticks alone, as they did before the server said what it can do:
  // every server runs and pauses.
  const runState = connected ? execution?.state : undefined;
  const waiting = !connected ? NOT_CONNECTED : NO_SERVER_YET;
  const hostStop = runState === "paused" && !canResume(execution?.reason) ? describeStopReason(execution?.reason ?? "") : undefined;
  // The DSP runs its steps one behind the other, and none of them is a call: a server answers
  // control.stepOver and control.stepOut for it with -32004, always.
  const noCalls = target.id === "dsp" && target.supported && target.stepping ? `the ${target.label} has no calls to step over or out of` : undefined;
  const callStep = step === NOT_CONNECTED || step === NO_SERVER_YET ? step : (noCalls ?? step);
  return {
    run: runState === undefined ? waiting : runState === "running" ? TARGET_RUNS : hostStop,
    pause: runState === undefined ? waiting : runState === "paused" ? (hostStop ?? TARGET_PAUSED) : undefined,
    step,
    stepOver: callStep,
    stepOut: callStep,
    reset: !connected ? NOT_CONNECTED : !initialized || execution === undefined ? NO_SERVER_YET : !canReset ? NO_RESET : hostStop,
  };
};
