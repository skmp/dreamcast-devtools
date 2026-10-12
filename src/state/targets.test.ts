import { describe, expect, it } from "vitest";
import type { BreakpointDescriptor, DebuggerShape, DebuggerTarget } from "../lib/debuggerSchema";
import {
  breakpointCategory,
  describeBreakpoint,
  formatAddress,
  formatAddressInput,
  hasCapability,
  parseAddress,
  programCounter,
  registerNumber,
  targetBeforeFirstServer,
  targetInfo,
  unlistedTarget,
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
const TARGET_IDS = ["sh4", "arm7", "dsp"] as const;
const sh4: DebuggerTarget = (({ supported: _supported, ...target }) => target)(targetBeforeFirstServer("sh4"));
const dsp: DebuggerTarget = (({ supported: _supported, ...target }) => target)(targetBeforeFirstServer("dsp"));

/** A describe result with all three targets and every capability the tests ask for, to take fields away from. */
const complete = v3([sh4, arm7, dsp], ["event-breakpoints", "callstack", "register-write", "sgc-capture"]);
const without = (...keys: Array<keyof DebuggerShape>): DebuggerShape => {
  const shape: Partial<DebuggerShape> = { ...complete };
  for (const key of keys) {
    delete shape[key];
  }
  return shape as DebuggerShape;
};

describe("targetInfo", () => {
  it("is what debugger.describe lists for the target", () => {
    expect(targetInfo(v3([arm7]), "arm7")).toEqual({ ...arm7, supported: true });
    expect(targetInfo(complete, "sh4")).toEqual({ ...sh4, supported: true });
  });

  it("is unsupported when the server lists targets and this one is not among them: the notice has its label", () => {
    const info = targetInfo(v3([arm7]), "dsp");
    expect(info.supported).toBe(false);
    expect(info.label).toBe("DSP");
    expect(info).toEqual(unlistedTarget("dsp"));
    expect(TARGET_IDS.map((id) => unlistedTarget(id).label)).toEqual(["SH4", "ARM7", "DSP"]);
    expect(TARGET_IDS.map((id) => unlistedTarget(id).supported)).toEqual([false, false, false]);
  });

  it("no target is supported for a describe result without `targets`: nothing is put in its place", () => {
    for (const id of TARGET_IDS) {
      expect(targetInfo(without("targets"), id), id).toEqual(unlistedTarget(id));
      expect(targetInfo(v3([]), id).supported, id).toBe(false);
    }
  });

  it("no target is supported for a describe result without `protocol`, whatever it lists", () => {
    for (const id of TARGET_IDS) {
      expect(targetInfo(without("protocol"), id), id).toEqual(unlistedTarget(id));
      expect(targetInfo(without("protocol", "targets", "capabilities", "ui"), id).supported, id).toBe(false);
    }
    // a server that says another version is read as it describes itself
    expect(targetInfo({ ...complete, protocol: 4 }, "arm7")).toEqual({ ...arm7, supported: true });
  });

  it("before any server was described every target has the frame of its panels, with the built-in values", () => {
    expect(targetInfo(undefined, "sh4")).toEqual(targetBeforeFirstServer("sh4"));
    expect(TARGET_IDS.map((id) => targetBeforeFirstServer(id).supported)).toEqual([true, true, true]);
    expect(targetBeforeFirstServer("sh4")).toMatchObject({ label: "SH4", addressRadix: 16, addressDigits: 8, instructionSize: 2 });
    expect(targetBeforeFirstServer("arm7")).toMatchObject({ label: "ARM7", addressRadix: 16, addressDigits: 8, instructionSize: 4 });
    expect(targetBeforeFirstServer("dsp")).toMatchObject({ label: "DSP", addressRadix: 10, addressDigits: 3, addressMax: 0x7f, memory: false });
  });
});

describe("capabilities", () => {
  it("are what the server lists", () => {
    const shape = v3([], ["event-breakpoints", "callstack"]);
    expect(hasCapability(shape, "callstack")).toBe(true);
    expect(hasCapability(shape, "sgc-capture")).toBe(false);
  });

  it("are none for a describe result without `capabilities`, and none for one without `protocol`, whatever it lists", () => {
    for (const capability of complete.capabilities!) {
      expect(hasCapability(complete, capability), capability).toBe(true);
      expect(hasCapability(without("capabilities"), capability), capability).toBe(false);
      expect(hasCapability(without("protocol"), capability), capability).toBe(false);
    }
    // the list of a server without `protocol` is of names of its own, which are not read either
    const own: DebuggerShape = { emulator: complete.emulator, capabilities: ["watches", "step"], deviceTree: [] };
    expect(hasCapability(own, "watches")).toBe(false);
    expect(hasCapability({ ...complete, protocol: 4 }, "callstack")).toBe(true);
  });

  it("before any server was described every panel has its controls", () => {
    expect(hasCapability(undefined, "sgc-capture")).toBe(true);
    expect(hasCapability(undefined, "register-write")).toBe(true);
  });
});

describe("addresses", () => {

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
    expect(programCounter(registers, sh4)).toBeUndefined();
    expect(programCounter({ "dc.aica.arm7": [{ name: "PC", value: "n/a", width: 32 }] }, arm7)).toBeUndefined();
  });
});

describe("breakpoints", () => {
  const code = (event: string, address: number): BreakpointDescriptor => ({ id: 1, event, address, kind: "code", enabled: true });

  it("belong to the target whose breakpoint event they use, and events to the events", () => {
    const renamed = v3([{ ...arm7, breakpointEvent: "dc.sound.cpu.pc" }, { ...dsp }]);
    expect(breakpointCategory(renamed, code("dc.sound.cpu.pc", 0x10))).toBe("arm7");
    expect(breakpointCategory(renamed, code("dc.aica.dsp.step", 5))).toBe("dsp");
    expect(breakpointCategory(renamed, { id: 2, event: "dc.sh4.exception", kind: "event", enabled: true })).toBe("events");
  });

  it("of no listed target are with the events: the name of an event says nothing about its target", () => {
    const renamed = v3([{ ...arm7, breakpointEvent: "dc.sound.cpu.pc" }]);
    expect(breakpointCategory(renamed, code("dc.aica.arm7.pc", 0))).toBe("events");
    expect(breakpointCategory(renamed, code("dc.sh4.cpu.pc", 0))).toBe("events");
    for (const shape of [without("targets"), without("protocol"), undefined]) {
      expect(breakpointCategory(shape, code("dc.sh4.cpu.pc", 0))).toBe("events");
      expect(breakpointCategory(shape, code("dc.aica.arm7.pc", 0))).toBe("events");
      expect(breakpointCategory(shape, code("dc.aica.dsp.step", 0))).toBe("events");
      expect(breakpointCategory(shape, code("dc.gdrom.sector", 0))).toBe("events");
    }
  });

  it("are printed with the address in the format of their target", () => {
    expect(describeBreakpoint(complete, code("dc.sh4.cpu.pc", 0x8c0000a6))).toBe("dc.sh4.cpu.pc == 0x8C0000A6");
    expect(describeBreakpoint(complete, code("dc.aica.dsp.step", 5))).toBe("dc.aica.dsp.step == 005");
    expect(describeBreakpoint(v3([arm7]), code("dc.aica.arm7.pc", 0x200010))).toBe("dc.aica.arm7.pc == 0x200010");
    expect(describeBreakpoint(complete, { id: 2, event: "dc.holly.core.vblank", kind: "event", enabled: true })).toBe("dc.holly.core.vblank");
    expect(describeBreakpoint(complete, { id: 3, event: "dc.sh4.cpu.pc", kind: "code", enabled: true })).toBe("dc.sh4.cpu.pc == ?");
  });

  it("of no listed target are printed with the address as plain hex: no built-in format stands in", () => {
    for (const shape of [without("targets"), without("protocol"), v3([arm7]), undefined]) {
      expect(describeBreakpoint(shape, code("dc.sh4.cpu.pc", 0xa6))).toBe("dc.sh4.cpu.pc == 0xA6");
      // the DSP's steps are decimal and three digits wide only where a server says so
      expect(describeBreakpoint(shape, code("dc.aica.dsp.step", 5))).toBe("dc.aica.dsp.step == 0x5");
    }
  });
});
