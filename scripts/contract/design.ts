import type { DebuggerTarget, TargetProcessor } from "../../src/lib/debuggerSchema";

/**
 * What the design fixes beyond the shape of the messages, as tables: the targets of
 * section 3.1 and the milestone M1 rows of the device tree of section 2.8. A v3 server sends
 * these values, whichever server it is; S01 compares.
 */

/** A row of the target table of 3.1: every column that does not depend on the milestone. */
export type FixedTarget = Pick<
  DebuggerTarget,
  | "pcPath"
  | "pcRegister"
  | "breakpointEvent"
  | "instructionSize"
  | "addressMax"
  | "addressRadix"
  | "addressDigits"
  | "defaultDisassemblyAddress"
  | "defaultMemoryAddress"
  | "memory"
> & {
  /** only where the table gives one value for every milestone: the ARM7 steps from M2, the DSP from M3 */
  stepping?: boolean;
};

export const TARGET_TABLE: Readonly<Record<TargetProcessor, FixedTarget>> = {
  sh4: {
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
    pcPath: "dc.aica.arm7",
    pcRegister: "PC",
    breakpointEvent: "dc.aica.arm7.pc",
    instructionSize: 4,
    addressMax: 0x00ffffff,
    addressRadix: 16,
    addressDigits: 8,
    defaultDisassemblyAddress: 0x00000000,
    defaultMemoryAddress: 0x00000000,
    memory: true,
  },
  dsp: {
    pcPath: "dc.aica.dsp",
    pcRegister: "STEP",
    breakpointEvent: "dc.aica.dsp.step",
    instructionSize: 1,
    addressMax: 127,
    addressRadix: 10,
    addressDigits: 3,
    defaultDisassemblyAddress: 0,
    // the DSP has no memory
    defaultMemoryAddress: undefined,
    memory: false,
  },
};

/** A node the device tree has from milestone M1 on, with the panels it opens. */
export interface TreeRow {
  path: string;
  actions?: string[];
}

const SH4_REGISTER_MODULES = ["bsc", "ccn", "cpg", "dmac", "intc", "rtc", "sci", "scif", "tmu", "ubc"];
const SH4_CONTENT_NODES = ["sq", "icache", "ocache", "ocram", "tlb"];

/**
 * The rows of the table of 2.8 whose "From" column says M1 (for a node that gets its
 * registers later: the node). Paths and actions only: the registers of a node are what
 * debugger.describe says they are.
 */
export const M1_DEVICE_TREE: readonly TreeRow[] = [
  { path: "dc" },
  { path: "dc.sh4" },
  { path: "dc.sh4.cpu", actions: ["sh4-disassembly", "sh4-memory"] },
  { path: "dc.sh4.pbus" },
  ...SH4_REGISTER_MODULES.map((name) => ({ path: `dc.sh4.${name}`, actions: [`${name}-registers`] })),
  ...SH4_CONTENT_NODES.map((name) => ({ path: `dc.sh4.${name}`, actions: [`${name}-contents`] })),
  { path: "dc.holly" },
  { path: "dc.holly.intc" },
  { path: "dc.holly.dmac" },
  { path: "dc.holly.ta", actions: ["holly-ta"] },
  { path: "dc.holly.core", actions: ["holly-core"] },
  { path: "dc.aica" },
  { path: "dc.aica.arm7", actions: ["arm7-disassembly", "arm7-memory"] },
  { path: "dc.aica.sgc", actions: ["sgc"] },
  { path: "dc.aica.sgc.0" },
  { path: "dc.aica.sgc.1" },
  { path: "dc.aica.dsp", actions: ["dsp-disassembly"] },
  { path: "dc.system" },
  { path: "dc.gdrom" },
  { path: "dc.maple" },
  { path: "dc.timing" },
];
