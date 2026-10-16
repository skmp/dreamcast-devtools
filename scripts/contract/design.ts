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
 * A node the device tree has from a milestone on: the node it is shown under (none for the
 * root), the panels it opens, and whether it has to carry registers.
 */
export interface TreeRow {
  path: string;
  parent?: string;
  actions?: string[];
  /** the node lists at least one register: which registers is the server's choice */
  registers?: boolean;
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

const withRegisters = (parent: string, paths: string[]): TreeRow[] => paths.map((path) => ({ path, parent, registers: true }));

/**
 * What milestone M2 adds to the table of 2.8 (the cut of the M2 round, 3.6.1): the nodes of the
 * system bus, the SPG, the AICA's common block and clock, the 64 channels of the sound
 * generator; the two register panels of the processors; and registers on the nodes whose
 * tables are M2's. Normative are the paths, the parents, the two actions, and that such a node
 * carries at least one register. The register lists are the server's.
 */
export const M2_DEVICE_TREE: readonly TreeRow[] = [
  { path: "dc.sh4.cpu", parent: "dc.sh4", actions: ["sh4-registers"] },
  { path: "dc.aica.arm7", parent: "dc.aica", actions: ["arm7-registers"] },
  { path: "dc.holly.sb", parent: "dc.holly" },
  ...withRegisters("dc.holly.sb", ["dc.holly.sb.g1", "dc.holly.sb.g2", "dc.holly.sb.pvr", "dc.holly.sb.misc"]),
  ...withRegisters("dc.holly", ["dc.holly.dmac", "dc.holly.ta", "dc.holly.core", "dc.holly.spg"]),
  ...withRegisters("dc.aica", ["dc.aica.common", "dc.aica.rtc"]),
  ...withRegisters(
    "dc.aica.sgc",
    Array.from({ length: 64 }, (_, channel) => `dc.aica.sgc.${channel}`),
  ),
  ...withRegisters("dc.system", ["dc.gdrom", "dc.maple"]),
];

/** The action a server claims the M2 tree with: the register panel of the SH4, offered by `dc.sh4.cpu`. */
export const M2_TREE_ACTION = { path: "dc.sh4.cpu", action: "sh4-registers" } as const;

/**
 * The twelve register panels: those of the two processors and of the ten on-chip modules of
 * the SH4. A panel shows the node that offers its id, so an id is the action of one node.
 */
export const REGISTER_PANEL_IDS: readonly string[] = ["sh4-registers", "arm7-registers", ...SH4_REGISTER_MODULES.map((name) => `${name}-registers`)];

/** One period of the AICA scheduler callback, in SH4 cycles: a sound burst of 32 samples. */
export const AICA_CALLBACK_CYCLES = 145124n;
/** The samples of one sound burst: a capture of n frames is ceil(n / 32) periods of the AICA. */
export const SAMPLES_PER_BURST = 32;
/** The SH4's time slice, in cycles: the rest of a slice is what the SH4 runs on behind a burst at most. */
export const SH4_SLICE_CYCLES = 448n;

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

/**
 * The datapath registers of the DSP's core that `dc.aica.dsp` has from milestone M3 on, behind
 * the four of M1, with their widths (the M3 round's M3-D25). Under the gate of M3 S01 requires
 * all nine.
 */
export const M3_DSP_REGISTERS: ReadonlyArray<readonly [name: string, width: number]> = [
  ["ACC", 26],
  ["Y_REG", 24],
  ["FRC_REG", 13],
  ["ADRS_REG", 12],
  ["LATCH", 16],
  ["LATCH_COPY", 16],
  ["MEMVAL", 16],
  ["NOFL_PIPE", 2],
  ["MIXS_BANK", 1],
];

/**
 * The widths of the registers of `dc.aica.dsp` (2.8 and M3-D25), for every server that lists
 * one of them: those of the hardware and of the DSP's core. Only `STEP`, the anchor, has to be
 * there, and from the gate of M3 on the nine of M3 too.
 */
export const DSP_REGISTER_WIDTHS: ReadonlyMap<string, number> = new Map([
  ["STEP", 8],
  ["MDEC_CT", 16],
  ["RBP", 16],
  ["RBL", 8],
  ...M3_DSP_REGISTERS,
]);

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
