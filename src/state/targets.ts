import type { BreakpointCategory, BreakpointDescriptor, DebuggerShape, DebuggerTarget, RegisterValue, TargetProcessor } from "../lib/debuggerSchema";

// What the panels know about a target (SH4, ARM7, DSP): where its program counter is, how its
// addresses are written, where a view starts, and what the server can do with it. A v3
// server says all of it in `targets` of debugger.describe. A v2 server says nothing, and the
// panels then use the values they had built in before protocol v3.

export interface TargetInfo extends DebuggerTarget {
  /**
   * false: the server lists targets and this one is not among them. Its panels show a notice
   * instead of controls. The other fields are then the built-in values.
   */
  supported: boolean;
}

/** What the panels assumed before `targets` existed; used for a server that does not send it. */
export const V2_TARGETS: Readonly<Record<TargetProcessor, DebuggerTarget>> = {
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

/** A server that does not report a protocol version is a v2 server. */
export const isV2Server = (shape: DebuggerShape | undefined): boolean => shape !== undefined && shape.protocol === undefined;

export const targetInfo = (shape: DebuggerShape | undefined, id: TargetProcessor): TargetInfo => {
  const listed = shape?.targets;
  if (!listed) {
    return { ...V2_TARGETS[id], supported: true };
  }
  const target = listed.find((candidate) => candidate.id === id);
  return target ? { ...target, supported: true } : { ...V2_TARGETS[id], supported: false };
};

/**
 * Whether an optional method works. A v3 server lists what it has in `capabilities`. A v2
 * server is asked for everything, as it always was (what the v2 mock listed there are
 * names of its own).
 */
export const hasCapability = (shape: DebuggerShape | undefined, capability: string): boolean => {
  if (!shape || shape.protocol === undefined || !shape.capabilities) {
    return true;
  }
  return shape.capabilities.includes(capability);
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
 * The number a register value stands for: values are hex, with "0x" from a v3 server. "n/a"
 * (the value cannot be read) and free text are undefined.
 */
export const registerNumber = (value: string | undefined): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  const digits = /^(?:0x)?([0-9a-f]+)$/i.exec(value.trim());
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
 * target whose code breakpoints use its event. The names of the events decide for a server
 * that lists no targets, as they always did.
 */
export const breakpointCategory = (shape: DebuggerShape | undefined, breakpoint: BreakpointDescriptor): BreakpointCategory => {
  if (breakpoint.kind === "event") {
    return "events";
  }
  const target = shape?.targets?.find((candidate) => candidate.breakpointEvent === breakpoint.event);
  if (target) {
    return target.id;
  }
  const lower = breakpoint.event.toLowerCase();
  if (lower.includes("sh4")) return "sh4";
  if (lower.includes("arm7")) return "arm7";
  if (lower.includes("aica") || lower.includes("dsp")) return "dsp";
  return "events";
};

/** A breakpoint as lists and notices print it: the event, and for a code breakpoint its address in the target's format. */
export const describeBreakpoint = (shape: DebuggerShape | undefined, breakpoint: BreakpointDescriptor): string => {
  if (breakpoint.kind === "event") {
    return breakpoint.event;
  }
  if (breakpoint.address === undefined) {
    return `${breakpoint.event} == ?`;
  }
  const category = breakpointCategory(shape, breakpoint);
  const target = category === "events" ? V2_TARGETS.sh4 : targetInfo(shape, category);
  return `${breakpoint.event} == ${formatAddress(target, breakpoint.address)}`;
};
