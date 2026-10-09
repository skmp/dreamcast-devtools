import { CAPABILITIES } from "../../src/lib/debuggerSchema";
import type { DebuggerTarget, TargetProcessor } from "../../src/lib/debuggerSchema";

/**
 * What the design fixes beyond the shape of the messages, as tables: the milestones and
 * their capabilities, the normative columns of the target table of section 3.1, and the
 * normative parts of the device tree of section 2.8. Every v3 server sends these values,
 * whichever server it is; S01 compares. What is not in here is the server's own choice:
 * labels, default addresses, the register lists of the other nodes.
 */

/** The milestones of the design: each adds scenarios to the gate of the one before it. */
export const MILESTONES = ["M1", "M2", "M3", "M4"] as const;
export type Milestone = (typeof MILESTONES)[number];

/** The capabilities each milestone adds (3.1). A server that claims a milestone advertises those of it and of the ones before. */
const CAPABILITIES_ADDED: Readonly<Record<Milestone, readonly string[]>> = {
  M1: [CAPABILITIES.EVENT_BREAKPOINTS, CAPABILITIES.CALLSTACK],
  M2: [CAPABILITIES.MEMORY_WRITE, CAPABILITIES.REGISTER_WRITE, CAPABILITIES.RESET],
  M3: [CAPABILITIES.SGC_CAPTURE, CAPABILITIES.MEMORY_BINARY],
  M4: [CAPABILITIES.TABLES, CAPABILITIES.HOLLY_CAPTURE],
};

export const capabilitiesOfMilestone = (milestone: Milestone): string[] =>
  MILESTONES.slice(0, MILESTONES.indexOf(milestone) + 1).flatMap((earlier) => CAPABILITIES_ADDED[earlier]);

/** The targets a server of any milestone lists (3.1: an M1 emulator lists all three). */
export const TARGET_IDS: readonly TargetProcessor[] = ["sh4", "arm7", "dsp"];

/**
 * The normative columns of the target table of 3.1. `label`, `defaultDisassemblyAddress`
 * and `defaultMemoryAddress` are the server's choice, and `stepping` follows the milestone.
 */
export type NormativeTarget = Pick<
  DebuggerTarget,
  "pcPath" | "pcRegister" | "breakpointEvent" | "instructionSize" | "addressMax" | "addressRadix" | "addressDigits" | "memory"
>;

export const TARGET_TABLE: Readonly<Record<TargetProcessor, NormativeTarget>> = {
  sh4: {
    pcPath: "dc.sh4.cpu",
    pcRegister: "PC",
    breakpointEvent: "dc.sh4.cpu.pc",
    instructionSize: 2,
    addressMax: 0xffffffff,
    addressRadix: 16,
    addressDigits: 8,
    memory: true,
  },
  arm7: {
    pcPath: "dc.aica.arm7",
    pcRegister: "PC",
    breakpointEvent: "dc.aica.arm7.pc",
    instructionSize: 4,
    addressMax: 0x00ffffff,
    addressRadix: 16,
    addressDigits: 8,
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
    memory: false,
  },
};

/**
 * A node the device tree has from milestone M1 on: the node it is shown under (none for the
 * root), and the panels it opens.
 */
export interface TreeRow {
  path: string;
  parent?: string;
  actions?: string[];
}

const SH4_REGISTER_MODULES = ["bsc", "ccn", "cpg", "dmac", "intc", "rtc", "sci", "scif", "tmu", "ubc"];
const SH4_CONTENT_NODES = ["sq", "icache", "ocache", "ocram", "tlb"];

/**
 * The rows of the table of 2.8 whose "From" column says M1 (for a node that gets its
 * registers later: the node). The nesting is the table's, not that of the dots of the path:
 * the SH4 modules are under `dc.sh4.pbus`, and `dc.gdrom`, `dc.maple` and `dc.timing` under
 * `dc.system`.
 */
export const M1_DEVICE_TREE: readonly TreeRow[] = [
  { path: "dc" },
  { path: "dc.sh4", parent: "dc" },
  { path: "dc.sh4.cpu", parent: "dc.sh4", actions: ["sh4-disassembly", "sh4-memory"] },
  { path: "dc.sh4.pbus", parent: "dc.sh4" },
  ...SH4_REGISTER_MODULES.map((name) => ({ path: `dc.sh4.${name}`, parent: "dc.sh4.pbus", actions: [`${name}-registers`] })),
  ...SH4_CONTENT_NODES.map((name) => ({ path: `dc.sh4.${name}`, parent: "dc.sh4.pbus", actions: [`${name}-contents`] })),
  { path: "dc.holly", parent: "dc" },
  { path: "dc.holly.intc", parent: "dc.holly" },
  { path: "dc.holly.dmac", parent: "dc.holly" },
  { path: "dc.holly.ta", parent: "dc.holly", actions: ["holly-ta"] },
  { path: "dc.holly.core", parent: "dc.holly", actions: ["holly-core"] },
  { path: "dc.aica", parent: "dc" },
  { path: "dc.aica.arm7", parent: "dc.aica", actions: ["arm7-disassembly", "arm7-memory"] },
  { path: "dc.aica.sgc", parent: "dc.aica", actions: ["sgc"] },
  { path: "dc.aica.sgc.0", parent: "dc.aica.sgc" },
  { path: "dc.aica.sgc.1", parent: "dc.aica.sgc" },
  { path: "dc.aica.dsp", parent: "dc.aica", actions: ["dsp-disassembly"] },
  { path: "dc.system", parent: "dc" },
  { path: "dc.gdrom", parent: "dc.system" },
  { path: "dc.maple", parent: "dc.system" },
  { path: "dc.timing", parent: "dc.system" },
];

/** The three registers the targets are anchored in: where the PC of each, or the step, is read. */
export const ANCHOR_REGISTERS: ReadonlyArray<{ path: string; name: string }> = [
  { path: "dc.sh4.cpu", name: "PC" },
  { path: "dc.aica.arm7", name: "PC" },
  { path: "dc.aica.dsp", name: "STEP" },
];

/**
 * The fourth anchor register, of a server that lists the target `arm7`: whether the ARM7 is
 * clocked (1) or held in reset (0). It is in every tick of a machine (`dc.aica.arm7` is one of
 * the base paths), and tells which callstack the ARM7 has in a paused tick (2.10).
 */
export const ARM7_ENABLED_REGISTER = { path: "dc.aica.arm7", name: "ENABLED", width: 1 } as const;

const numbered = (prefix: string, count: number, suffix = ""): string[] => Array.from({ length: count }, (_, index) => `${prefix}${index}${suffix}`);

/** The register list of `dc.sh4.cpu` (2.8): these names, in this order, all of width 32. */
export const SH4_CPU_REGISTERS: readonly string[] = [
  ...["PC", "PR", "SR", "GBR", "VBR", "MACH", "MACL", "SSR", "SPC", "SGR", "DBR", "FPSCR", "FPUL"],
  ...numbered("R", 16),
  ...numbered("R", 8, "_BANK"),
  ...numbered("FR", 16),
  ...numbered("XF", 16),
];
export const SH4_CPU_REGISTER_WIDTH = 32;

/** The paths every running tick carries (2.8); `dc.sh4.cpu` is absent exactly when the tick says `registersStale`. */
export const BASE_PATHS = ["dc.sh4.cpu", "dc.aica.arm7", "dc.aica.dsp", "dc.timing"] as const;

/** The event of the vertical blank: raised by every running machine, and listed by every server (2.6). */
export const VBLANK_EVENT = "dc.holly.core.vblank";
