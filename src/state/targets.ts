import type { BreakpointCategory, BreakpointDescriptor, DebuggerShape, DebuggerTarget, RegisterValue, TargetProcessor } from "../lib/debuggerSchema";

// What the panels know about a target (SH4, ARM7, DSP): where its program counter is, how its
// addresses are written, where a view starts, and what the server can do with it. The server
// says all of it in `targets` of debugger.describe, and what it can do beyond that in
// `capabilities`. What a server does not list it does not have: nothing is assumed for a
// describe result that leaves a list out, and one without `protocol` lists nothing at all.

export interface TargetInfo extends DebuggerTarget {
  /**
   * false: the server does not list this target. Its panels show a notice instead of
   * controls, and the notice names the target by `label` (`unlistedTarget`).
   */
  supported: boolean;
}

/**
 * The values of a target that no server gave. They have two uses, `targetBeforeFirstServer`
 * and `unlistedTarget`, and are never a stand-in for what a server left out.
 */
const BUILT_IN_TARGETS: Readonly<Record<TargetProcessor, DebuggerTarget>> = {
  sh4: {
    id: "sh4",
    label: "SH4",
    pcPath: "dc.sh4.cpu",
    pcRegister: "PC",
    breakpointEvent: "dc.sh4.cpu.pc",
    instructionSize: 2,
    addressMax: 0xffffffff,
    addressRadix: 16,
    addressDigits: 8,
    defaultDisassemblyAddress: 0x8c010000,
    defaultMemoryAddress: 0x8c010000,
    memory: true,
    stepping: true,
  },
  arm7: {
    id: "arm7",
    label: "ARM7",
    pcPath: "dc.aica.arm7",
    pcRegister: "PC",
    breakpointEvent: "dc.aica.arm7.pc",
    instructionSize: 4,
    addressMax: 0xffffffff,
    addressRadix: 16,
    addressDigits: 8,
    defaultDisassemblyAddress: 0x00200000,
    defaultMemoryAddress: 0x00200000,
    memory: true,
    stepping: true,
  },
  dsp: {
    id: "dsp",
    label: "DSP",
    pcPath: "dc.aica.dsp",
    pcRegister: "STEP",
    breakpointEvent: "dc.aica.dsp.step",
    instructionSize: 1,
    addressMax: 0x7f,
    addressRadix: 10,
    addressDigits: 3,
    defaultDisassemblyAddress: 0,
    memory: false,
    stepping: true,
  },
};

/**
 * A target on a page that has had no server yet. Every panel shows its frame then, with its
 * toolbar and its boxes, and a frame needs a label and a way to write an address. Nothing is
 * requested with these values: there is nobody to ask.
 */
export const targetBeforeFirstServer = (id: TargetProcessor): TargetInfo => ({ ...BUILT_IN_TARGETS[id], supported: true });

/**
 * A target the server does not list. Its panels say so in place of their controls ("This
 * server does not support the ARM7 target"), which takes the label. A panel that shows the
 * notice asks the server for nothing, so the other fields reach no request.
 */
export const unlistedTarget = (id: TargetProcessor): TargetInfo => ({ ...BUILT_IN_TARGETS[id], supported: false });

/**
 * Whether the lists of a describe result are read. A result without `protocol` gets the
 * version banner and is a server that lists no target and no capability, whatever it carries
 * under those names.
 */
const listsAnything = (shape: DebuggerShape): boolean => shape.protocol !== undefined;

/** The targets the server lists; none when its describe result has no `targets`. */
const listedTargets = (shape: DebuggerShape | undefined): readonly DebuggerTarget[] =>
  shape !== undefined && listsAnything(shape) ? (shape.targets ?? []) : [];

export const targetInfo = (shape: DebuggerShape | undefined, id: TargetProcessor): TargetInfo => {
  if (shape === undefined) {
    return targetBeforeFirstServer(id);
  }
  const target = listedTargets(shape).find((candidate) => candidate.id === id);
  return target ? { ...target, supported: true } : unlistedTarget(id);
};

/**
 * Whether an optional method works: the server lists what it has in `capabilities`, and has
 * nothing when its describe result has no such list. A page that has had no server yet has
 * every panel with its controls (see `targetBeforeFirstServer`).
 */
export const hasCapability = (shape: DebuggerShape | undefined, capability: string): boolean => {
  if (shape === undefined) {
    return true;
  }
  return listsAnything(shape) && (shape.capabilities ?? []).includes(capability);
};

/** An address as lists, the disassembly column and notices print it: "0x8C0000A0", "005". */
export const formatAddress = (target: Pick<DebuggerTarget, "addressRadix" | "addressDigits">, value: number): string =>
  target.addressRadix === 10
    ? value.toString(10).padStart(target.addressDigits, "0")
    : `0x${value.toString(16).toUpperCase().padStart(target.addressDigits, "0")}`;

/** An address as an input box holds it: decimal addresses are not padded there. */
export const formatAddressInput = (target: Pick<DebuggerTarget, "addressRadix" | "addressDigits">, value: number): string =>
  target.addressRadix === 10 ? value.toString(10) : formatAddress(target, value);

/**
 * What the user typed as an address of this target: digits in the target's radix, or hex
 * after "0x" whatever the radix. Undefined when it is not a number.
 */
export const parseAddress = (target: Pick<DebuggerTarget, "addressRadix">, input: string): number | undefined => {
  const trimmed = input.trim();
  const hex = /^0x([0-9a-f]+)$/i.exec(trimmed);
  if (hex) {
    return Number.parseInt(hex[1], 16);
  }
  if (target.addressRadix === 10) {
    return /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : undefined;
  }
  return /^[0-9a-f]+$/i.test(trimmed) ? Number.parseInt(trimmed, 16) : undefined;
};

/**
 * The number a register value stands for: hex digits after "0x", which is how every server of
 * protocol v3 sends a value. "n/a" (the value cannot be read), free text and digits without
 * "0x" (which only the mock of protocol v2 sent; "01" among them, a 0 alone is no prefix) are
 * undefined.
 */
export const registerNumber = (value: string | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const digits = /^0x([0-9a-f]+)$/i.exec(value.trim());
  if (!digits) {
    return undefined;
  }
  const parsed = Number.parseInt(digits[1], 16);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

/** Where the target is: its program counter (or step) in the registers the ticks delivered. */
export const programCounter = (
  registersByPath: Record<string, RegisterValue[]>,
  target: Pick<DebuggerTarget, "pcPath" | "pcRegister">,
): number | undefined =>
  registerNumber(registersByPath[target.pcPath]?.find((register) => register.name === target.pcRegister)?.value);

/** The address a view starts at to show `address` with ten instructions of context above it. */
export const withContextAbove = (target: Pick<DebuggerTarget, "instructionSize" | "addressMax">, address: number): number => {
  const start = Math.min(Math.max(0, address - target.instructionSize * 10), target.addressMax);
  return start - (start % target.instructionSize);
};

/**
 * The mute / solo category of a breakpoint: "events" for an event breakpoint, otherwise the
 * target whose code breakpoints use its event. A code breakpoint whose event is of no listed
 * target has no target to belong to, and is listed with the events.
 */
export const breakpointCategory = (shape: DebuggerShape | undefined, breakpoint: BreakpointDescriptor): BreakpointCategory => {
  if (breakpoint.kind === "event") {
    return "events";
  }
  return listedTargets(shape).find((candidate) => candidate.breakpointEvent === breakpoint.event)?.id ?? "events";
};

/**
 * A breakpoint as lists and notices print it: the event, and for a code breakpoint its address
 * in the format of its target. No target, no format: the address is then plain hex.
 */
export const describeBreakpoint = (shape: DebuggerShape | undefined, breakpoint: BreakpointDescriptor): string => {
  if (breakpoint.kind === "event") {
    return breakpoint.event;
  }
  if (breakpoint.address === undefined) {
    return `${breakpoint.event} == ?`;
  }
  const target = listedTargets(shape).find((candidate) => candidate.breakpointEvent === breakpoint.event);
  const address = target ? formatAddress(target, breakpoint.address) : `0x${breakpoint.address.toString(16).toUpperCase()}`;
  return `${breakpoint.event} == ${address}`;
};
