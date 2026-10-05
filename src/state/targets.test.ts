import { describe, expect, it } from "vitest";
import type { BreakpointDescriptor, DebuggerShape, DebuggerTarget } from "../lib/debuggerSchema";
import {
  V2_TARGETS,
  breakpointCategory,
  describeBreakpoint,
  formatAddress,
  formatAddressInput,
  hasCapability,
  isV2Server,
  parseAddress,
  programCounter,
  registerNumber,
  targetInfo,
  withContextAbove,
} from "./targets";

const arm7: DebuggerTarget = {
  id: "arm7",
  label: "ARM7 (AICA)",
  pcPath: "dc.aica.arm7",
  pcRegister: "PC",
  breakpointEvent: "dc.aica.arm7.pc",
  instructionSize: 4,
  addressMax: 0x00ffffff,
  addressRadix: 16,
  addressDigits: 6,
  defaultDisassemblyAddress: 0,
  defaultMemoryAddress: 0,
  memory: true,
  stepping: false,
};

const v3 = (targets: DebuggerTarget[], capabilities: string[] = []): DebuggerShape => ({
  emulator: { name: "nullDC", version: "3.0.0", build: "native" },
  protocol: 3,
  ui: "none",
  capabilities,
  targets,
  deviceTree: [],
});
const v2: DebuggerShape = { emulator: { name: "mockServer", version: "unspecified", build: "native" }, capabilities: ["watches", "step"], deviceTree: [] };

describe("targetInfo", () => {
  it("is what debugger.describe lists for the target", () => {
    expect(targetInfo(v3([arm7]), "arm7")).toEqual({ ...arm7, supported: true });
  });

  it("is unsupported when a v3 server lists targets and this one is not among them", () => {
    const info = targetInfo(v3([arm7]), "dsp");
    expect(info.supported).toBe(false);
    expect(info.label).toBe("DSP");
  });

  it("is the built-in values for a server without `targets` (v2), and before any server was described", () => {
    expect(targetInfo(v2, "arm7")).toEqual({ ...V2_TARGETS.arm7, supported: true });
    expect(targetInfo(undefined, "sh4")).toEqual({ ...V2_TARGETS.sh4, supported: true });
    // what the panels had built in before protocol v3
    expect(V2_TARGETS.arm7.defaultMemoryAddress).toBe(0x00200000);
    expect(V2_TARGETS.dsp).toMatchObject({ addressRadix: 10, addressDigits: 3, addressMax: 0x7f, memory: false });
  });
});

describe("capabilities", () => {
  it("are what a v3 server lists", () => {
    const shape = v3([], ["event-breakpoints", "callstack"]);
    expect(hasCapability(shape, "callstack")).toBe(true);
    expect(hasCapability(shape, "sgc-capture")).toBe(false);
  });

  it("are all assumed for a v2 server, whose list is of names of its own", () => {
    expect(isV2Server(v2)).toBe(true);
    expect(isV2Server(v3([]))).toBe(false);
    expect(isV2Server(undefined)).toBe(false);
    expect(hasCapability(v2, "sgc-capture")).toBe(true);
    expect(hasCapability(undefined, "sgc-capture")).toBe(true);
  });
});

describe("addresses", () => {
  const sh4 = V2_TARGETS.sh4;
  const dsp = V2_TARGETS.dsp;

  it("are printed in the radix and with the digits of the target", () => {
    expect(formatAddress(sh4, 0x8c0000a0)).toBe("0x8C0000A0");
    expect(formatAddress(sh4, 0)).toBe("0x00000000");
    expect(formatAddress(arm7, 0x200010)).toBe("0x200010");
    expect(formatAddress(dsp, 5)).toBe("005");
    expect(formatAddress(dsp, 127)).toBe("127");
    // an input box does not pad decimal numbers
    expect(formatAddressInput(dsp, 5)).toBe("5");
    expect(formatAddressInput(sh4, 0x8c0000a0)).toBe("0x8C0000A0");
  });

  it("are read in the radix of the target, and as hex after 0x for every target", () => {
    expect(parseAddress(sh4, "8c0000a0")).toBe(0x8c0000a0);
    expect(parseAddress(sh4, " 0x8C0000A0 ")).toBe(0x8c0000a0);
    expect(parseAddress(sh4, "10")).toBe(0x10);
    expect(parseAddress(dsp, "10")).toBe(10);
    expect(parseAddress(dsp, "0x10")).toBe(16);
    expect(parseAddress(dsp, "005")).toBe(5);
  });

  it("are undefined for what is not a number in that radix", () => {
    for (const text of ["", "  ", "zz", "0x", "8c0000a0h", "-1", "1.5"]) {
      expect(parseAddress(sh4, text), text).toBeUndefined();
    }
    expect(parseAddress(dsp, "1f")).toBeUndefined();
  });

  it("put ten instructions of context above an address, within the address space", () => {
    expect(withContextAbove(sh4, 0x8c0000a0)).toBe(0x8c0000a0 - 20);
    expect(withContextAbove(arm7, 0x200010)).toBe(0x200010 - 40);
    expect(withContextAbove(dsp, 4)).toBe(0);
    expect(withContextAbove(sh4, 0x8c0000a1)).toBe(0x8c0000a0 - 20);
  });
});

describe("register values", () => {
  it("are hex numbers, with or without 0x", () => {
    expect(registerNumber("0x8C0000A0")).toBe(0x8c0000a0);
    expect(registerNumber("0x004")).toBe(4);
    expect(registerNumber("8c0000a0")).toBe(0x8c0000a0);
  });

  it("are no number when they cannot be read or are text", () => {
    for (const value of [undefined, "n/a", "", "200MHz", "fast", "0x", "0xFFFFFFFFFFFFFFFFFFFF"]) {
      expect(registerNumber(value), String(value)).toBeUndefined();
    }
  });

  it("the program counter is the register the target names, where the target says it is", () => {
    const registers = { "dc.aica.arm7": [{ name: "R0", value: "0x1", width: 32 }, { name: "PC", value: "0x00200010", width: 32 }] };
    expect(programCounter(registers, arm7)).toBe(0x200010);
    expect(programCounter(registers, V2_TARGETS.sh4)).toBeUndefined();
    expect(programCounter({ "dc.aica.arm7": [{ name: "PC", value: "n/a", width: 32 }] }, arm7)).toBeUndefined();
  });
});

describe("breakpoints", () => {
  const code = (event: string, address: number): BreakpointDescriptor => ({ id: 1, event, address, kind: "code", enabled: true });

  it("belong to the target whose breakpoint event they use, and events to the events", () => {
    const renamed = v3([{ ...arm7, breakpointEvent: "dc.sound.cpu.pc" }, { ...V2_TARGETS.dsp }]);
    expect(breakpointCategory(renamed, code("dc.sound.cpu.pc", 0x10))).toBe("arm7");
    expect(breakpointCategory(renamed, code("dc.aica.dsp.step", 5))).toBe("dsp");
    expect(breakpointCategory(renamed, { id: 2, event: "dc.sh4.exception", kind: "event", enabled: true })).toBe("events");
  });

  it("go by the name of the event for a server that lists no targets", () => {
    expect(breakpointCategory(v2, code("dc.sh4.cpu.pc", 0))).toBe("sh4");
    expect(breakpointCategory(v2, code("dc.aica.arm7.pc", 0))).toBe("arm7");
    expect(breakpointCategory(undefined, code("dc.aica.dsp.step", 0))).toBe("dsp");
    expect(breakpointCategory(undefined, code("dc.gdrom.sector", 0))).toBe("events");
  });

  it("are printed with the address in the format of their target", () => {
    expect(describeBreakpoint(v2, code("dc.sh4.cpu.pc", 0x8c0000a6))).toBe("dc.sh4.cpu.pc == 0x8C0000A6");
    expect(describeBreakpoint(v2, code("dc.aica.dsp.step", 5))).toBe("dc.aica.dsp.step == 005");
    expect(describeBreakpoint(v3([arm7]), code("dc.aica.arm7.pc", 0x200010))).toBe("dc.aica.arm7.pc == 0x200010");
    expect(describeBreakpoint(v2, { id: 2, event: "dc.holly.core.vblank", kind: "event", enabled: true })).toBe("dc.holly.core.vblank");
  });
});
