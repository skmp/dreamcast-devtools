import { createHash } from "node:crypto";
import {
  BREAKPOINT_CATEGORIES,
  CAPABILITIES,
  DebuggerErrorCode,
  DebuggerRpcMethodSchemas,
  IN_BAND_ERROR_METHODS,
  PANEL_IDS,
  PROTOCOL_BOUNDS,
  PROTOCOL_VERSION,
  RpcMethod,
} from "../src/lib/debuggerSchema";
import type {
  BreakpointCategory,
  BreakpointCategoryState,
  BreakpointDescriptor,
  CallstackFrame,
  DebuggerShape,
  DebuggerTarget,
  DebuggerTick,
  DeviceNodeDescriptor,
  DisassemblyLine,
  EventLogEntry,
  MemorySlice,
  RegisterValue,
  StopReason,
  TargetProcessor,
  WatchDescriptor,
} from "../src/lib/debuggerSchema";
import { JSON_RPC_VERSION } from "../src/lib/jsonRpc";
import { BinaryFrameKind, SGC_BYTES_PER_CHANNEL, SGC_CHANNELS_PER_FRAME, encodeBinaryFrame } from "../src/lib/binaryFrame";
import { generateMockSgcCapture } from "./mockSgc";
import type { MockSgcCapture } from "./mockSgc";

/**
 * The mock debugger: a protocol v3 server around a fabricated machine. This module is the
 * protocol core only. It has no HTTP, no WebSocket and no Vite in it, so it can run inside
 * a test or the contract runner; `server/mockWebSocket.ts` puts it on a socket and
 * `server/mockServer.ts` adds the page.
 *
 * What it implements is milestone M1 of the protocol, plus what the mock could do before
 * protocol v3: ARM7 and DSP stepping and code breakpoints, the SGC capture, and register
 * writes (state.setRegister and state.editWatch). Everything else answers -32004. The option
 * `supports` takes away from that, down to what a server of milestone M1 implements.
 *
 * The machine: each target walks a ring of instructions, one instruction per emulation
 * step (16 ms). The last instruction of the SH4 and ARM7 rings is the branch back to the
 * first one, and the disassembly says so. Memory content is a hash of the address.
 */

export interface MockDebuggerOptions {
  /** period of the running tick (Debugger:TickMs) */
  tickMs?: number;
  /** every n-th periodic tick is full (Debugger:FullTickEvery) */
  fullTickEvery?: number;
  /** real time of one emulation step, in which every target executes one instruction */
  emulationStepMs?: number;
  /** after the last client disconnected: breakpoints become inactive and a debugger stop is released */
  graceMs?: number;
  /** start in the `StartPaused` stop (reason "start") instead of running */
  startPaused?: boolean;
  /**
   * Behave like an SH4 JIT backend without native breakpoints (Debugger:ForceFallback): the
   * tick carries the notice while SH4 breakpoints are active, `dc.timing.SH4_DEBUG_ENGINE`
   * reads `interpreter-fallback` and the capability is "sh4-debug-fallback".
   */
  forceFallback?: boolean;
  /**
   * false: behave like a backend without a complete context at the slice hook; running
   * ticks omit `dc.sh4.cpu`, carry `registersStale: true`, and watches on `dc.sh4.cpu.*`
   * read "n/a" in them.
   */
  sliceContext?: boolean;
  /** `ui` of debugger.describe: "none" or the version of the bundle the host serves */
  ui?: string;
  /**
   * What debugger.describe reports as `protocol`. The mock speaks protocol 3 whatever this
   * says: another number makes it a server of another protocol version for the version check
   * of a client.
   */
  protocol?: number;
  /**
   * What the server implements; without it, everything the mock can do. For a mock of a server
   * of an earlier milestone, or of one without a target. See `MOCK_M1_SUPPORT`.
   */
  supports?: MockSupport;
  /** called with one line per connection event and per request the mock refuses to parse */
  log?: (line: string) => void;
}

export interface MockSupport {
  /**
   * The targets debugger.describe lists (default: all three). A target that is not listed is
   * unsupported: every request that names it answers -32004, and its callstack is empty.
   */
  targets?: TargetProcessor[];
  /**
   * The listed targets whose `stepping` is true (default: all of them). control.step* and the
   * code breakpoints of the others answer -32004.
   */
  stepping?: TargetProcessor[];
  /**
   * The capabilities of optional methods (default: all four the mock has): "event-breakpoints",
   * "callstack", "register-write", "sgc-capture". The methods behind a missing one answer
   * -32004, and without "callstack" the ticks carry no frames.
   */
  capabilities?: string[];
}

/** What the emulator implements in milestone M1: SH4 debugging, event breakpoints, callstack. */
export const MOCK_M1_SUPPORT: Readonly<Required<MockSupport>> = {
  targets: ["sh4", "arm7", "dsp"],
  stepping: ["sh4"],
  capabilities: [CAPABILITIES.EVENT_BREAKPOINTS, CAPABILITIES.CALLSTACK],
};

/** One client connection, as the host gives it to the mock. */
export interface MockConnection {
  sendText(text: string): void;
  sendBinary(frame: Uint8Array): void;
  /** bytes accepted for sending that have not left the process yet; absent means 0 */
  queuedBytes?(): number;
}

/** One client connection, as the mock gives it back to the host. */
export interface MockClient {
  readonly id: number;
  /** a text frame arrived */
  receive(text: string): void;
  /** the connection ended */
  close(): void;
}

export type MockLifetime = "running" | "stopped" | "no-machine";

interface Ring {
  /** address of the first instruction */
  base: number;
  /** number of instructions */
  length: number;
  instructionSize: number;
}

/** The loops the mock's targets execute. The last SH4 and ARM7 instruction branches to `base`. */
export const MOCK_SH4_RING: Readonly<Ring> = { base: 0x8c0000a0, length: 8, instructionSize: 2 };
export const MOCK_ARM7_RING: Readonly<Ring> = { base: 0x00200010, length: 8, instructionSize: 4 };
/** The DSP executes its 128 steps once per sample. */
export const MOCK_DSP_RING: Readonly<Ring> = { base: 0, length: 128, instructionSize: 1 };

const RINGS: Record<TargetProcessor, Readonly<Ring>> = { sh4: MOCK_SH4_RING, arm7: MOCK_ARM7_RING, dsp: MOCK_DSP_RING };

/** The address after `address` as the target executes: around the ring, or straight on outside of it. */
export const mockNextAddress = (target: TargetProcessor, address: number): number => {
  const ring = RINGS[target];
  const end = ring.base + ring.length * ring.instructionSize;
  if (address >= ring.base && address < end) {
    return ring.base + ((address - ring.base + ring.instructionSize) % (ring.length * ring.instructionSize));
  }
  return (address + ring.instructionSize) >>> 0;
};

const SH4_ADDRESS_MASK = 0x1fffffff;
/** scheduler cycles of one emulation step (16 ms at 200 MHz, a multiple of the 448-cycle slice) */
const CYCLES_PER_EMULATION_STEP = 448n * 7143n;
const SH4_TIMESLICE = 448n;
const SLOW_CLIENT_BYTES = 1048576;
const FALLBACK_NOTICE =
  "SH4 runs on the interpreter while breakpoints are armed (JIT backend mock has no native breakpoints): FPU results can differ from a run without breakpoints";

// ---------------------------------------------------------------------------------------
// Events (design 2.6). Low-rate events are logged whenever a client is connected, high-rate
// events only while an event breakpoint on them exists. These are the events the mock can
// raise, and exactly the events its device tree lists: a breakpoint is accepted on each.
// ---------------------------------------------------------------------------------------

interface EventSpec {
  subsystem: string;
  severity: string;
  rate: "low" | "high";
  /** emitted in the emulation steps where `step % every === phase`; absent: only on its occasion */
  every?: number;
  phase?: number;
  message: (step: number) => string;
}

export const MOCK_EVENTS: Readonly<Record<string, EventSpec>> = {
  "dc.sh4.interrupt": { subsystem: "sh4", severity: "info", rate: "high", every: 1, phase: 0, message: () => "interrupt accepted: IRL9 (HBLANK)" },
  "dc.sh4.exception": { subsystem: "sh4", severity: "warn", rate: "low", every: 512, phase: 300, message: () => "exception: TRAPA #0x20" },
  "dc.holly.dmac.transfer_start": { subsystem: "holly", severity: "info", rate: "high", every: 2, phase: 0, message: () => "ch2 DMA start: 0x0C080000, 0x4000 bytes" },
  "dc.holly.dmac.transfer_end": { subsystem: "holly", severity: "info", rate: "high", every: 2, phase: 1, message: () => "ch2 DMA end" },
  "dc.holly.ta.list_init": { subsystem: "ta", severity: "info", rate: "high", every: 2, phase: 0, message: () => "TA list init" },
  "dc.holly.ta.list_end": { subsystem: "ta", severity: "info", rate: "high", every: 2, phase: 1, message: (step) => `TA end of list ${(step >> 1) % 5}` },
  "dc.holly.core.render_start": { subsystem: "core", severity: "info", rate: "high", every: 2, phase: 1, message: () => "CORE start render" },
  "dc.holly.core.render_end": { subsystem: "core", severity: "info", rate: "high", every: 2, phase: 0, message: () => "CORE end of render" },
  "dc.holly.core.vblank": { subsystem: "core", severity: "info", rate: "high", every: 1, phase: 0, message: (step) => `vblank in, frame ${step}` },
  "dc.aica.interrupt": { subsystem: "aica", severity: "info", rate: "high", every: 4, phase: 2, message: () => "AICA interrupt: timer A" },
  "dc.aica.timer": { subsystem: "aica", severity: "info", rate: "high", every: 4, phase: 2, message: () => "timer A overflow" },
  "dc.aica.channels.key_on": { subsystem: "aica", severity: "info", rate: "low", every: 32, phase: 8, message: (step) => `key on: channel ${(step >> 5) % 64}` },
  "dc.aica.channels.key_off": { subsystem: "aica", severity: "info", rate: "low", every: 32, phase: 24, message: (step) => `key off: channel ${(step >> 5) % 64}` },
  "dc.aica.channels.loop": { subsystem: "aica", severity: "info", rate: "high", every: 8, phase: 5, message: (step) => `loop: channel ${(step >> 3) % 64}` },
  "dc.gdrom.command": { subsystem: "gdrom", severity: "info", rate: "low", every: 64, phase: 40, message: (step) => `packet command 0x30 (CD_READ), sector ${45150 + (step >> 6) * 16}` },
  "dc.maple.dma": { subsystem: "maple", severity: "info", rate: "high", every: 1, phase: 0, message: () => "maple DMA: 1 frame, port A" },
  "dc.system.reset": { subsystem: "system", severity: "info", rate: "low", message: () => "machine reset" },
  "dc.system.state": { subsystem: "system", severity: "info", rate: "low", message: () => "machine state changed" },
  "dc.debugger.engine": { subsystem: "debugger", severity: "info", rate: "low", message: () => "SH4 debug engine changed" },
  "dc.debugger.note": { subsystem: "debugger", severity: "info", rate: "low", message: () => "note" },
};

const CODE_BREAKPOINT_EVENTS: Record<string, TargetProcessor> = {
  "dc.sh4.cpu.pc": "sh4",
  "dc.aica.arm7.pc": "arm7",
  "dc.aica.dsp.step": "dsp",
};

// ---------------------------------------------------------------------------------------
// Device tree (design 2.8, the M1 rows; the registers of dc.holly.dmac, .ta, .core and of the
// two SGC channels are the mock's own and stand in for the M2 tables).
// ---------------------------------------------------------------------------------------

type RegisterContent = number | bigint | string;

interface RegisterSpec {
  name: string;
  /** bits; 0 for free text */
  width: number;
  initial: RegisterContent;
  /** false: state.setRegister refuses it with -32013 */
  writable?: boolean;
}

interface NodeSpec {
  path: string;
  label: string;
  description: string;
  registers?: RegisterSpec[];
  events?: string[];
  actions?: string[];
  children?: NodeSpec[];
}

const reg = (name: string, width: number, initial: RegisterContent = 0, writable = true): RegisterSpec => ({
  name,
  width,
  initial,
  writable: width === 0 ? false : writable,
});
const regs = (width: number, names: string, initial: RegisterContent = 0): RegisterSpec[] =>
  names.split(" ").map((name) => reg(name, width, initial));
const numbered = (prefix: string, count: number, width: number, suffix = "", initial: (index: number) => number = () => 0): RegisterSpec[] =>
  Array.from({ length: count }, (_, index) => reg(`${prefix}${index}${suffix}`, width, initial(index)));

const SH4_CPU_REGISTERS: RegisterSpec[] = [
  reg("PC", 32, MOCK_SH4_RING.base),
  reg("PR", 32, 0x8c0000a2),
  reg("SR", 32, 0x400000f0),
  reg("GBR", 32, 0x8c000000),
  reg("VBR", 32, 0x8c000000),
  reg("MACH", 32),
  reg("MACL", 32),
  reg("SSR", 32, 0x40000000),
  reg("SPC", 32, 0x8c0000a0),
  reg("SGR", 32, 0x8cfff000),
  reg("DBR", 32),
  reg("FPSCR", 32, 0x00040001),
  reg("FPUL", 32),
  ...numbered("R", 16, 32, "", (index) => (index === 15 ? 0x8cfff000 : index * 0x1111)),
  ...numbered("R", 8, 32, "_BANK"),
  ...numbered("FR", 16, 32, "", (index) => (index === 0 ? 0x3f800000 : 0)),
  ...numbered("XF", 16, 32),
];

const SH4_PERIPHERALS: Array<{ id: string; label: string; description: string; action: string; registers: RegisterSpec[] }> = [
  { id: "bsc", label: "BSC", description: "Bus State Controller", action: PANEL_IDS.SH4_BSC_REGISTERS, registers: [...regs(32, "BCR1"), ...regs(16, "BCR2"), ...regs(32, "WCR1 WCR2 WCR3 MCR"), ...regs(16, "PCR RTCSR RTCNT RTCOR RFCR"), ...regs(32, "PCTRA"), ...regs(16, "PDTRA"), ...regs(32, "PCTRB"), ...regs(16, "PDTRB GPIOIC")] },
  { id: "ccn", label: "CCN", description: "Cache Controller", action: PANEL_IDS.SH4_CCN_REGISTERS, registers: [...regs(32, "PTEH PTEL TTB TEA MMUCR"), ...regs(8, "BASRA BASRB"), reg("CCR", 32, 0x00000909), ...regs(32, "TRA EXPEVT INTEVT PTEA QACR0 QACR1")] },
  { id: "cpg", label: "CPG", description: "Clock Pulse Generator", action: PANEL_IDS.SH4_CPG_REGISTERS, registers: [reg("FRQCR", 16, 0x0e0a), ...regs(8, "STBCR WTCNT WTCSR STBCR2")] },
  { id: "dmac", label: "DMAC", description: "Direct Memory Access Controller", action: PANEL_IDS.SH4_DMAC_REGISTERS, registers: [...[0, 1, 2, 3].flatMap((channel) => regs(32, `SAR${channel} DAR${channel} DMATCR${channel} CHCR${channel}`)), reg("DMAOR", 32, 0x8201)] },
  { id: "intc", label: "INTC", description: "Interrupt Controller", action: PANEL_IDS.SH4_INTC_REGISTERS, registers: regs(16, "ICR IPRA IPRB IPRC") },
  { id: "rtc", label: "RTC", description: "Real Time Clock", action: PANEL_IDS.SH4_RTC_REGISTERS, registers: [...regs(8, "R64CNT RSECCNT RMINCNT RHRCNT RWKCNT RDAYCNT RMONCNT"), ...regs(16, "RYRCNT"), ...regs(8, "RSECAR RMINAR RHRAR RWKAR RDAYAR RMONAR RCR1 RCR2")] },
  { id: "sci", label: "SCI", description: "Serial Communications Interface", action: PANEL_IDS.SH4_SCI_REGISTERS, registers: regs(8, "SCSMR1 SCBRR1 SCSCR1 SCTDR1 SCSSR1 SCRDR1 SCSCMR1 SCSPTR1") },
  // SCFRDR2 pops the receive FIFO when read, so it has no side-effect-free reader: "n/a"
  { id: "scif", label: "SCIF", description: "Serial Communications Interface w/ FIFO", action: PANEL_IDS.SH4_SCIF_REGISTERS, registers: [...regs(16, "SCSMR2"), ...regs(8, "SCBRR2"), ...regs(16, "SCSCR2"), ...regs(8, "SCFTDR2"), reg("SCFSR2", 16, 0x0060), reg("SCFRDR2", 8, "n/a", false), ...regs(16, "SCFCR2 SCFDR2 SCSPTR2 SCLSR2")] },
  { id: "tmu", label: "TMU", description: "Timer Unit", action: PANEL_IDS.SH4_TMU_REGISTERS, registers: [...regs(8, "TOCR"), reg("TSTR", 8, 0x01), ...[0, 1, 2].flatMap((timer) => [reg(`TCOR${timer}`, 32, 0xffffffff), reg(`TCNT${timer}`, 32, 0xffffffff), reg(`TCR${timer}`, 16)]), ...regs(32, "TCPR2")] },
  { id: "ubc", label: "UBC", description: "User Break Controller", action: PANEL_IDS.SH4_UBC_REGISTERS, registers: [...regs(32, "BARA"), ...regs(8, "BAMRA"), ...regs(16, "BBRA"), ...regs(32, "BARB"), ...regs(8, "BAMRB"), ...regs(16, "BBRB"), ...regs(32, "BDRB BDMRB"), ...regs(16, "BRCR")] },
];

const SH4_CONTENTS: Array<{ id: string; label: string; description: string; action: string }> = [
  { id: "sq", label: "SQ", description: "Store Queues", action: PANEL_IDS.SH4_SQ_CONTENTS },
  { id: "icache", label: "ICACHE", description: "Instruction Cache", action: PANEL_IDS.SH4_ICACHE_CONTENTS },
  { id: "ocache", label: "OCACHE", description: "Operand Cache", action: PANEL_IDS.SH4_OCACHE_CONTENTS },
  { id: "ocram", label: "OCRAM", description: "Operand RAM", action: PANEL_IDS.SH4_OCRAM_CONTENTS },
  { id: "tlb", label: "TLB", description: "Translation Lookaside Buffer", action: PANEL_IDS.SH4_TLB_CONTENTS },
];

/** A few fields of a channel; their widths are not multiples of four on purpose. */
const sgcChannelRegisters = (volume: number): RegisterSpec[] => [
  reg("VOL", 8, volume),
  reg("KYONB", 1, 1),
  reg("SA", 23, 0x012340),
  reg("LSA", 16, 0),
  reg("LEA", 16, 0x0fff),
  reg("FNS", 10, 0x155),
  reg("OCT", 4, 0xf),
  reg("TL", 8, 0x20),
];

const DEVICE_TREE: NodeSpec[] = [
  {
    path: "dc",
    label: "Dreamcast",
    description: "beloved console",
    registers: [reg("SYSCLK", 0, "200MHz"), reg("BUILD", 0, "nullDC 3.0.0 mock")],
    // a server lists the events it can raise: nothing raises dc.debugger.dsp_forced
    events: ["dc.system.reset", "dc.system.state", "dc.debugger.engine", "dc.debugger.note"],
    children: [
      {
        path: "dc.sh4",
        label: "SH4",
        description: "SH7750-alike SoC",
        events: ["dc.sh4.interrupt", "dc.sh4.exception"],
        children: [
          {
            path: "dc.sh4.cpu",
            label: "Core",
            description: "SuperH4 CPU Core",
            registers: SH4_CPU_REGISTERS,
            actions: [PANEL_IDS.SH4_DISASSEMBLY, PANEL_IDS.SH4_MEMORY],
          },
          {
            path: "dc.sh4.pbus",
            label: "PBUS",
            description: "Peripherals Bus",
            children: [
              ...SH4_PERIPHERALS.map(({ id, label, description, action, registers }) => ({
                path: `dc.sh4.${id}`,
                label,
                description,
                registers,
                actions: [action],
              })),
              ...SH4_CONTENTS.map(({ id, label, description, action }) => ({
                path: `dc.sh4.${id}`,
                label,
                description,
                actions: [action],
              })),
            ],
          },
        ],
      },
      {
        path: "dc.holly",
        label: "Holly",
        description: "System ASIC",
        children: [
          {
            path: "dc.holly.intc",
            label: "INTC",
            description: "Interrupt Controller",
            registers: [
              reg("SB_ISTNRM", 32, 0x00000008),
              ...regs(32, "SB_ISTEXT SB_ISTERR"),
              ...["2", "4", "6"].flatMap((level) => regs(32, `SB_IML${level}NRM SB_IML${level}EXT SB_IML${level}ERR`)),
            ],
          },
          {
            path: "dc.holly.dmac",
            label: "DMA Controller",
            description: "peripheral",
            registers: [reg("DMAOR", 16, 0x8201), reg("CHCR0", 32, 0x00000001)],
            events: ["dc.holly.dmac.transfer_start", "dc.holly.dmac.transfer_end"],
          },
          {
            path: "dc.holly.ta",
            label: "TA",
            description: "Tile Accelerator",
            registers: [reg("TA_LIST_BASE", 32, 0x0c000000), reg("TA_STATUS", 32)],
            events: ["dc.holly.ta.list_init", "dc.holly.ta.list_end"],
            actions: [PANEL_IDS.CLX2_TA],
          },
          {
            path: "dc.holly.core",
            label: "CORE",
            description: "Depth and Shading Engine",
            registers: [reg("PVR_CTRL", 32, 0x00000001), reg("PVR_STATUS", 32, 0x00010000)],
            events: ["dc.holly.core.render_start", "dc.holly.core.render_end", "dc.holly.core.vblank"],
            actions: [PANEL_IDS.CLX2_CORE],
          },
        ],
      },
      {
        path: "dc.aica",
        label: "AICA",
        description: "Sound SoC",
        events: ["dc.aica.interrupt", "dc.aica.timer"],
        children: [
          {
            path: "dc.aica.arm7",
            label: "ARM7",
            description: "ARM7DI CPU Core",
            registers: [
              reg("PC", 32, MOCK_ARM7_RING.base),
              ...numbered("R", 15, 32, "", (index) => (index === 13 ? 0x00280000 : index === 14 ? 0x0020000c : index * 0x101)),
              reg("CPSR", 32, 0x000000d3),
              reg("SPSR", 32, 0x00000010),
              // the banked registers of the other modes
              ...regs(32, "R8_FIQ R9_FIQ R10_FIQ R11_FIQ R12_FIQ R13_FIQ R14_FIQ SPSR_FIQ"),
              ...["IRQ", "SVC", "ABT", "UND"].flatMap((mode) => regs(32, `R13_${mode} R14_${mode} SPSR_${mode}`)),
            ],
            actions: [PANEL_IDS.ARM7_DISASSEMBLY, PANEL_IDS.ARM7_MEMORY],
          },
          {
            path: "dc.aica.sgc",
            label: "SGC",
            description: "Sound Generation Core",
            events: ["dc.aica.channels.key_on", "dc.aica.channels.key_off", "dc.aica.channels.loop"],
            actions: [PANEL_IDS.SGC],
            children: [
              { path: "dc.aica.sgc.0", label: "Channel 0", description: "SGC Channel 0", registers: sgcChannelRegisters(0x7f) },
              { path: "dc.aica.sgc.1", label: "Channel 1", description: "SGC Channel 1", registers: sgcChannelRegisters(0x6a) },
            ],
          },
          {
            path: "dc.aica.dsp",
            label: "DSP",
            description: "DSP VLIW Core",
            // the widths of design 2.8: a step is 0..127
            registers: [reg("STEP", 8, 0), reg("MDEC_CT", 16, 0x1fff), reg("RBP", 16, 0x0400), reg("RBL", 8, 0x03)],
            actions: [PANEL_IDS.DSP_DISASSEMBLY],
          },
        ],
      },
      {
        path: "dc.system",
        label: "System",
        description: "Peripherals and timing",
        children: [
          { path: "dc.gdrom", label: "GD-ROM", description: "GD-ROM drive", events: ["dc.gdrom.command"] },
          { path: "dc.maple", label: "Maple", description: "Maple bus", events: ["dc.maple.dma"] },
          {
            path: "dc.timing",
            label: "Timing",
            description: "Scheduler time and timing mode",
            registers: [
              reg("MODE", 0, "fast"),
              reg("SH4_CYCLES", 64, 0n, false),
              reg("SCHED_NOW", 64, 0n, false),
              reg("SH4_BACKEND", 0, "mock"),
              reg("SH4_DEBUG_ENGINE", 0, "native"),
            ],
          },
        ],
      },
    ],
  },
];

/** The paths a running tick carries (design 2.8): the PC of every target, and the time. */
const BASE_PATHS = ["dc.sh4.cpu", "dc.aica.arm7", "dc.aica.dsp", "dc.timing"];

const TARGETS: DebuggerTarget[] = [
  {
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
  {
    id: "arm7",
    label: "ARM7",
    pcPath: "dc.aica.arm7",
    pcRegister: "PC",
    breakpointEvent: "dc.aica.arm7.pc",
    instructionSize: 4,
    addressMax: 0x00ffffff,
    addressRadix: 16,
    addressDigits: 8,
    defaultDisassemblyAddress: 0,
    defaultMemoryAddress: 0,
    memory: true,
    // M2 in the emulator; the mock could always do it
    stepping: true,
  },
  {
    id: "dsp",
    label: "DSP",
    pcPath: "dc.aica.dsp",
    pcRegister: "STEP",
    breakpointEvent: "dc.aica.dsp.step",
    instructionSize: 1,
    addressMax: 127,
    addressRadix: 10,
    addressDigits: 3,
    defaultDisassemblyAddress: 0,
    memory: false,
    // M3 in the emulator; the mock could always do it
    stepping: true,
  },
];

const targetById = (id: TargetProcessor): DebuggerTarget => TARGETS.find((target) => target.id === id)!;

/** The capabilities of optional methods the mock has: M1's, and what it could do before protocol v3. */
const OPTIONAL_CAPABILITIES: string[] = [
  CAPABILITIES.EVENT_BREAKPOINTS,
  CAPABILITIES.CALLSTACK,
  CAPABILITIES.REGISTER_WRITE,
  CAPABILITIES.SGC_CAPTURE,
];

// ---------------------------------------------------------------------------------------
// Memory and disassembly
// ---------------------------------------------------------------------------------------

const sha256Byte = (input: string): number => createHash("sha256").update(input).digest()[0];

/** Whether the debugger can read a byte of the SH4 address space (design 2.7). */
export const mockSh4Readable = (address: number): boolean => {
  if (address >= 0xe0000000) {
    // P4: the store queues and the on-chip registers
    return address <= 0xe3ffffff || address >= 0xff000000;
  }
  const masked = address & SH4_ADDRESS_MASK;
  const area = masked >>> 26;
  switch (area) {
    case 0: {
      const offset = masked & 0x01ffffff;
      if (offset <= 0x0021ffff) return true; // BIOS, flash
      if (offset >= 0x005f7000 && offset <= 0x005f70ff) return false; // GD-ROM: its reads have side effects
      if (offset >= 0x005f6800 && offset <= 0x005f7cff) return true; // system bus
      if (offset >= 0x005f8000 && offset <= 0x005f9fff) return true; // PVR registers
      if (offset >= 0x00700000 && offset <= 0x00707fff) return true; // AICA registers
      if (offset >= 0x00710000 && offset <= 0x0071000b) return true; // RTC
      if (offset >= 0x00800000 && offset <= 0x00ffffff) return true; // AICA RAM
      return false; // the modem at 0x00600000 included
    }
    case 1: // VRAM, both views
    case 3: // main RAM
      return true;
    case 7: // on-chip registers
      return masked >= 0x1f000000;
    default:
      return false;
  }
};

/** Wave RAM below 0x00800000, the AICA registers and the RTC above it. */
export const mockArm7Readable = (address: number): boolean =>
  address < 0x00800000 || (address >= 0x00800000 && address <= 0x00807fff) || (address >= 0x00810000 && address <= 0x0081000b);

const memoryByte = (target: "sh4" | "arm7", address: number): number =>
  sha256Byte(`${target === "sh4" ? "SH4" : "ARM7"}:${address.toString(16)}`);

const isReadable = (target: "sh4" | "arm7", address: number): boolean =>
  address <= targetById(target).addressMax && (target === "sh4" ? mockSh4Readable(address) : mockArm7Readable(address));

type Operands = (r1: number, r2: number, r3: number, value: number, offset: number) => string;

const sh4Instructions: Array<{ mnemonic: string; operands: Operands; branch?: boolean }> = [
  { mnemonic: "mov.l", operands: (r1, r2) => `@r${r1}+, r${r2}` },
  { mnemonic: "mov", operands: (r1, r2) => `r${r1}, r${r2}` },
  { mnemonic: "sts.l", operands: (r1) => `pr, @-r${r1}` },
  { mnemonic: "add", operands: (r1, r2) => `r${r1}, r${r2}` },
  { mnemonic: "cmp/eq", operands: (r1, r2) => `r${r1}, r${r2}` },
  { mnemonic: "bf", operands: (_r1, _r2, _r3, _value, offset) => `0x${offset.toString(16)}`, branch: true },
  { mnemonic: "jmp", operands: (r1) => `@r${r1}`, branch: true },
  { mnemonic: "nop", operands: () => "" },
];

const arm7Instructions: Array<{ mnemonic: string; operands: Operands; branch?: boolean }> = [
  { mnemonic: "mov", operands: (r1, _r2, _r3, value) => `r${r1}, #${value}` },
  { mnemonic: "ldr", operands: (r1, r2, _r3, _value, offset) => `r${r1}, [r${r2}, #${offset}]` },
  { mnemonic: "str", operands: (r1, r2) => `r${r1}, [r${r2}]` },
  { mnemonic: "add", operands: (r1, r2, r3) => `r${r1}, r${r2}, r${r3}` },
  { mnemonic: "sub", operands: (r1, r2, r3) => `r${r1}, r${r2}, r${r3}` },
  { mnemonic: "bx", operands: (r1) => `r${r1}`, branch: true },
  { mnemonic: "bl", operands: (_r1, _r2, _r3, _value, offset) => `0x${offset.toString(16)}`, branch: true },
  { mnemonic: "nop", operands: () => "" },
];

const dspSampleProgram = [
  "TWT TWA YSEL BSELXSEL YSEL IRA:2 ZERO NOFL MASA:6 NXADRTRA YSEL BSEL",
  "YSEL IWT IWA:6 MWT BSEL NOFL",
  "YSEL BSEL",
  "YSEL MRD BSEL NOFL MASA:7",
  "YSEL BSEL",
  "YSEL IWT IWA:7 MRD BSEL NOFL MASA:8",
  "YSEL BSEL",
  "YSEL IWT IWA:8 MRD BSEL NOFL MASA:9",
  "YSEL BSEL",
  "YSEL IWT IWA:9 MRD BSEL NOFL MASA:10XSEL YSEL IRA:2 ZERO",
  "TWT YSEL IWT IWA:10 MRD BSEL NOFL MASA:11XSEL YSEL IRA:3 NEGB BSELXSEL YSEL IRA:33 IWT IWA:11 MRD BSEL NOFL MASA:12",
  "TWT TWA YSEL BSELXSEL YSEL IRA:2 IWT IWA:12 MRD ZERO NOFL MASA:13TRA YSEL BSEL",
  "YSEL IWT IWA:13 MWT BSEL NOFL MASA:2",
  "YSEL BSEL",
  "YSEL MRD BSEL NOFL MASA:14",
  "YSEL BSEL",
  "YSEL IWT IWA:14 MRD BSEL NOFL MASA:15",
  "YSEL BSEL",
  "YSEL IWT IWA:15 MRD BSEL NOFL MASA:17",
  "YSEL BSEL",
  "YSEL IWT IWA:17 MRD BSEL NOFL MASA:19XSEL YSEL IRA:4 ZERO",
  "TWT YSEL IWT IWA:19 MRD BSEL NOFL MASA:21XSEL YSEL IRA:5 NEGB BSELXSEL YSEL IRA:32 IWT IWA:21 MRD BSEL NOFL MASA:23",
  "TWT TWA YSEL BSELXSEL YSEL IRA:4 IWT IWA:23 ZEROTRA YSEL BSEL",
  "YSEL BSELXSEL YSEL IRA:6 ZERO",
  "TWT YSEL BSELXSEL YSEL IRA:7 NEGB BSELXSEL YSEL IRA:33 BSEL",
  "TWT TWA YSEL BSELXSEL YSEL IRA:6 ZEROTRA YSEL BSEL",
  "YSEL BSELXSEL YSEL IRA:8 ZEROXSEL YSEL IRA:9 BSEL",
  "XSEL YSEL IRA:10 BSEL",
  "XSEL YSEL IRA:11 BSEL",
  "TWT TWA:2 YSEL BSEL",
  "YSEL BSELXSEL YSEL IRA:12 ZEROXSEL YSEL IRA:13 BSEL",
  "XSEL YSEL IRA:14 BSEL",
  "XSEL YSEL IRA:15 BSEL",
  "TWT TWA:3 YSEL BSEL",
  "YSEL BSELTRA:2 XSEL YSEL IRA:17",
  "TWT TWA:2 YSEL BSEL",
  "YSEL BSEL",
  "YSEL MWT BSEL NOFL MASA:16XSEL YSEL IRA:17 ZEROTRA:2 YSEL BSEL",
  "TWT TWA:2 YSEL BSEL",
  "YSEL BSELTRA:3 XSEL YSEL IRA:19",
  "TWT TWA:3 YSEL BSEL",
  "YSEL BSEL",
  "YSEL MWT BSEL NOFL MASA:18XSEL YSEL IRA:19 ZEROTRA:3 YSEL BSEL",
  "TWT TWA:3 YSEL BSEL",
  "YSEL BSELTRA:2 XSEL YSEL IRA:21",
  "TWT TWA:2 YSEL BSEL",
  "YSEL BSEL",
  "YSEL MWT BSEL NOFL MASA:20XSEL YSEL IRA:21 ZEROTRA:2 YSEL BSEL",
  "YSEL EWT BSEL",
  "YSEL BSELTRA:3 XSEL YSEL IRA:23",
  "TWT TWA:3 YSEL BSEL",
  "YSEL BSEL",
  "YSEL MWT BSEL NOFL MASA:22XSEL YSEL IRA:23 ZEROTRA:3 YSEL BSEL",
  "YSEL EWT EWA BSEL",
];

const hexByte = (value: number) => value.toString(16).toUpperCase().padStart(2, "0");
const hex8 = (value: number) => `0x${value.toString(16).toUpperCase().padStart(8, "0")}`;

const disassembleLine = (target: TargetProcessor, address: number): DisassemblyLine => {
  if (target === "dsp") {
    const bytes = Array.from({ length: 8 }, (_, index) => hexByte(sha256Byte(`dsp:${address}:${index}`))).join(" ");
    return { address, bytes, disassembly: dspSampleProgram[address % dspSampleProgram.length] };
  }

  const ring = RINGS[target];
  const size = ring.instructionSize;
  for (let offset = 0; offset < size; offset++) {
    if (!isReadable(target, address + offset)) {
      return { address, bytes: "??", disassembly: "<unreadable>" };
    }
  }
  // the bytes of an instruction are the bytes state.getMemorySlice returns for its address
  const bytes = Array.from({ length: size }, (_, offset) => hexByte(memoryByte(target, address + offset))).join(" ");

  const instructions = target === "sh4" ? sh4Instructions : arm7Instructions;
  const hash = sha256Byte(`${target}:${address.toString(16)}`);
  const inRing = address >= ring.base && address < ring.base + ring.length * size;
  if (inRing && address === ring.base + (ring.length - 1) * size) {
    // what the target does here: back to the start of the loop. "bf" is the SH4 branch without a delay slot.
    return { address, bytes, disassembly: `${target === "sh4" ? "bf" : "b"} ${hex8(ring.base)}` };
  }
  const candidates = inRing ? instructions.filter((instruction) => !instruction.branch) : instructions;
  const instruction = candidates[hash % candidates.length];
  const operands = instruction.operands((hash >> 4) % 16, (hash >> 2) % 16, hash % 16, (hash * 3) & 0xff, (hash * 7) & 0xfff);
  return { address, bytes, disassembly: operands ? `${instruction.mnemonic} ${operands}` : instruction.mnemonic };
};

const SYMBOLS: Record<"sh4" | "arm7", Array<{ address: number; name: string }>> = {
  sh4: [
    { address: 0x8c000000, name: "_start" },
    { address: MOCK_SH4_RING.base, name: "_main_loop" },
    { address: 0x8c010000, name: "_main" },
  ],
  arm7: [
    { address: 0x00200000, name: "arm7_reset" },
    { address: MOCK_ARM7_RING.base, name: "arm7_main_loop" },
  ],
};

/** `name+0xOFF` for the nearest symbol at or below the address, within 64 KiB. */
const symbolize = (target: "sh4" | "arm7", address: number): string | undefined => {
  let best: { address: number; name: string } | undefined;
  for (const symbol of SYMBOLS[target]) {
    if (symbol.address <= address && (!best || symbol.address > best.address)) {
      best = symbol;
    }
  }
  if (!best || address - best.address >= 0x10000) {
    return undefined;
  }
  return `${best.name}+0x${(address - best.address).toString(16).toUpperCase()}`;
};

// ---------------------------------------------------------------------------------------

/** A failure of a request; the dispatcher puts it on the channel of the method. */
class MockRpcError extends Error {
  public readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const invalidParams = (what: string) => new MockRpcError(DebuggerErrorCode.INVALID_PARAMS, `invalid params: ${what}`);
const notSupported = (what: string) => new MockRpcError(DebuggerErrorCode.NOT_SUPPORTED, `not supported: ${what}`);

type CallClass = "describe" | "read" | "table" | "write" | "exec";

/**
 * The capability behind a method. A server without it answers the method with -32004 before
 * it looks at the parameters or at the lifetime, exactly as it answers a method of a later
 * milestone (design 3.0, which error wins).
 */
const METHOD_CAPABILITY: Readonly<Record<string, string>> = {
  [RpcMethod.STATE_GET_CALLSTACK]: CAPABILITIES.CALLSTACK,
  [RpcMethod.STATE_SET_REGISTER]: CAPABILITIES.REGISTER_WRITE,
  [RpcMethod.STATE_EDIT_WATCH]: CAPABILITIES.REGISTER_WRITE,
  [RpcMethod.STATE_RECORD_SGC_FRAMES]: CAPABILITIES.SGC_CAPTURE,
  [RpcMethod.STATE_GET_SGC_FRAME_DATA]: CAPABILITIES.SGC_CAPTURE,
};

interface ClientState {
  id: number;
  connection: MockConnection;
  /** binary frames sent on this connection so far */
  binaryId: number;
  /** a periodic tick was skipped for this client, so its next tick is full */
  needsFull: boolean;
}

interface WatchEntry {
  id: number;
  /** lower case */
  expression: string;
  path: string;
  register: RegisterSpec;
}

interface RequestContext {
  client: ClientState;
  id: number;
  /** runs after the response has been sent */
  afterResponse: Array<() => void>;
  /** set by a handler that answers later; the dispatcher then sends nothing */
  deferred: boolean;
}

type Handler = (params: Record<string, unknown>, context: RequestContext) => unknown;

const CATEGORY_KEYS: readonly BreakpointCategory[] = BREAKPOINT_CATEGORIES;

const categorize = (breakpoint: BreakpointDescriptor): BreakpointCategory => {
  if (breakpoint.kind === "event") {
    return "events";
  }
  const lower = breakpoint.event.toLowerCase();
  if (lower.includes("sh4")) return "sh4";
  if (lower.includes("arm7")) return "arm7";
  if (lower.includes("aica") || lower.includes("dsp")) return "dsp";
  return "events";
};

export class MockDebugger {
  private readonly options: Required<Omit<MockDebuggerOptions, "log" | "supports">> & Pick<MockDebuggerOptions, "log">;
  /** the targets debugger.describe lists, with what this server implements of them */
  private readonly targets: DebuggerTarget[];
  /** the capabilities of optional methods this server has */
  private readonly optionalCapabilities: string[];
  private readonly nodes = new Map<string, NodeSpec>();
  private readonly values = new Map<string, Map<string, RegisterContent>>();
  private readonly clients = new Map<number, ClientState>();
  private nextClientId = 1;

  private lifetime: MockLifetime = "running";
  private running = true;
  private stopId = 0;
  private reason: StopReason | undefined;
  private stopBreakpointId: number | undefined;
  /** the stop in force was made by a step on the fallback engine */
  private fallbackStep = false;
  private pendingStepOut: TargetProcessor | undefined;
  private emulationSteps = 0;
  private cycles = 0n;

  private readonly breakpoints = new Map<number, BreakpointDescriptor>();
  private nextBreakpointId = 1;
  private readonly categories = new Map<BreakpointCategory, BreakpointCategoryState>(
    CATEGORY_KEYS.map((key) => [key, { muted: false, soloed: false }]),
  );
  private readonly watches = new Map<number, WatchEntry>();
  private nextWatchId = 1;
  private readonly eventLog: EventLogEntry[] = [];
  private nextEventId = 1;
  private tickId = 0;
  private periodicTicks = 0;
  private fallbackSelected = false;

  private capture: MockSgcCapture | undefined;
  private captureSeed = 0;

  private emulationTimer: ReturnType<typeof setInterval> | undefined;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly captureTimers = new Set<ReturnType<typeof setTimeout>>();
  private graceExpired = false;

  private readonly handlers: Record<string, { cls: CallClass; run: Handler } | undefined>;

  constructor(options: MockDebuggerOptions = {}) {
    this.options = {
      tickMs: options.tickMs ?? 200,
      fullTickEvery: options.fullTickEvery ?? 5,
      emulationStepMs: options.emulationStepMs ?? 16,
      graceMs: options.graceMs ?? 10_000,
      startPaused: options.startPaused ?? false,
      forceFallback: options.forceFallback ?? false,
      sliceContext: options.sliceContext ?? true,
      ui: options.ui ?? "none",
      protocol: options.protocol ?? PROTOCOL_VERSION,
      log: options.log,
    };
    const listed = options.supports?.targets;
    const stepping = options.supports?.stepping;
    this.targets = TARGETS.filter((target) => !listed || listed.includes(target.id)).map((target) => ({
      ...target,
      stepping: stepping ? stepping.includes(target.id) : target.stepping,
    }));
    this.optionalCapabilities = OPTIONAL_CAPABILITIES.filter(
      (capability) => !options.supports?.capabilities || options.supports.capabilities.includes(capability),
    );

    const visit = (node: NodeSpec) => {
      this.nodes.set(node.path, node);
      if (node.registers) {
        this.values.set(node.path, new Map(node.registers.map((register) => [register.name, register.initial])));
      }
      node.children?.forEach(visit);
    };
    DEVICE_TREE.forEach(visit);
    if (this.options.forceFallback) {
      this.values.get("dc.timing")!.set("SH4_DEBUG_ENGINE", "interpreter-fallback");
    }
    if (this.options.startPaused) {
      this.running = false;
      this.stopId = 1;
      this.reason = "start";
    }

    this.handlers = {
      [RpcMethod.DEBUGGER_DESCRIBE]: { cls: "describe", run: (_params, context) => this.describe(context) },
      [RpcMethod.STATE_GET_MEMORY_SLICE]: { cls: "read", run: (params) => this.getMemorySlice(params) },
      [RpcMethod.STATE_GET_DISASSEMBLY]: { cls: "read", run: (params) => this.getDisassembly(params) },
      [RpcMethod.STATE_GET_CALLSTACK]: { cls: "read", run: (params) => this.getCallstack(params) },
      [RpcMethod.STATE_WATCH]: { cls: "table", run: (params, context) => this.watch(params, context) },
      [RpcMethod.STATE_UNWATCH]: { cls: "table", run: (params, context) => this.unwatch(params, context) },
      [RpcMethod.STATE_MODIFY_WATCH_EXPRESSION]: { cls: "table", run: (params, context) => this.modifyWatchExpression(params, context) },
      [RpcMethod.STATE_EDIT_WATCH]: { cls: "write", run: (params, context) => this.editWatch(params, context) },
      [RpcMethod.STATE_SET_REGISTER]: { cls: "write", run: (params, context) => this.setRegister(params, context) },
      [RpcMethod.CONTROL_PAUSE]: { cls: "exec", run: (_params, context) => this.pause(context) },
      [RpcMethod.CONTROL_RUN_UNTIL]: { cls: "exec", run: (_params, context) => this.resume(context) },
      [RpcMethod.CONTROL_STEP]: { cls: "exec", run: (params, context) => this.step("step", params, context) },
      [RpcMethod.CONTROL_STEP_OVER]: { cls: "exec", run: (params, context) => this.step("stepOver", params, context) },
      [RpcMethod.CONTROL_STEP_OUT]: { cls: "exec", run: (params, context) => this.step("stepOut", params, context) },
      [RpcMethod.BREAKPOINTS_ADD]: { cls: "table", run: (params, context) => this.addBreakpoint(params, context) },
      [RpcMethod.BREAKPOINTS_REMOVE]: { cls: "table", run: (params, context) => this.removeBreakpoint(params, context) },
      [RpcMethod.BREAKPOINTS_TOGGLE]: { cls: "table", run: (params, context) => this.toggleBreakpoint(params, context) },
      [RpcMethod.BREAKPOINTS_SET_CATEGORY_STATES]: { cls: "table", run: (params, context) => this.setCategoryStates(params, context) },
      [RpcMethod.STATE_RECORD_SGC_FRAMES]: { cls: "exec", run: (params, context) => this.recordSgcFrames(params, context) },
      [RpcMethod.STATE_GET_SGC_FRAME_DATA]: { cls: "read", run: (_params, context) => this.getSgcFrameData(context) },
      // later milestones, not implemented by the mock
      [RpcMethod.STATE_GET_MEMORY_BINARY]: undefined,
      [RpcMethod.STATE_WRITE_MEMORY]: undefined,
      [RpcMethod.CONTROL_RESET]: undefined,
      [RpcMethod.STATE_GET_TABLE]: undefined,
      [RpcMethod.STATE_CAPTURE_HOLLY]: undefined,
    };
  }

  // -------------------------------------------------------------------------------------
  // Host side
  // -------------------------------------------------------------------------------------

  /** Starts the machine and the periodic tick. */
  start(): void {
    if (this.emulationTimer !== undefined) {
      return;
    }
    this.emulationTimer = setInterval(() => this.emulationStep(), this.options.emulationStepMs);
    this.tickTimer = setInterval(() => this.periodicTick(), this.options.tickMs);
  }

  /** Stops every timer of the mock. Connections stay as they are. */
  stop(): void {
    if (this.emulationTimer !== undefined) {
      clearInterval(this.emulationTimer);
      this.emulationTimer = undefined;
    }
    if (this.tickTimer !== undefined) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    if (this.graceTimer !== undefined) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
    this.captureTimers.forEach((timer) => clearTimeout(timer));
    this.captureTimers.clear();
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** `debugger.describe` capabilities of this mock, at the moment of the call. */
  get capabilities(): string[] {
    return [
      ...this.optionalCapabilities,
      // neither of the two before an SH4 backend is selected, i.e. while no game is loaded
      ...(this.lifetime === "no-machine" ? [] : [this.options.forceFallback ? CAPABILITIES.SH4_DEBUG_FALLBACK : CAPABILITIES.SH4_DEBUG_NATIVE]),
    ];
  }

  connect(connection: MockConnection): MockClient {
    const client: ClientState = { id: this.nextClientId++, connection, binaryId: 0, needsFull: false };
    this.clients.set(client.id, client);
    if (this.graceTimer !== undefined) {
      clearTimeout(this.graceTimer);
      this.graceTimer = undefined;
    }
    this.graceExpired = false;
    this.options.log?.(`client ${client.id} connected`);
    return {
      id: client.id,
      receive: (text) => this.receive(client, text),
      close: () => this.disconnect(client),
    };
  }

  /**
   * What the emulator's own window does to the machine: "stopped" is its pause or the guest's
   * exit, "no-machine" is no game loaded, "running" resumes a stopped machine or starts a
   * game. Run control is refused while the machine is not running (-32001 / -32002).
   */
  setLifetime(lifetime: MockLifetime, reason: "host-stopped" | "guest-exit" = "host-stopped"): void {
    if (lifetime === this.lifetime) {
      return;
    }
    const gameStarts = lifetime === "running" && this.lifetime === "no-machine";
    this.lifetime = lifetime;
    this.pendingStepOut = undefined;
    this.stopBreakpointId = undefined;
    this.fallbackStep = false;
    if (gameStarts && this.options.startPaused) {
      // StartPaused parks once per start of a game
      this.running = false;
      this.stopId++;
      this.reason = "start";
    } else if (lifetime === "running") {
      // a debugger pause that was in force before the host stop is not re-applied
      this.running = true;
      this.reason = undefined;
    } else {
      this.running = false;
      this.stopId++;
      this.reason = lifetime === "no-machine" ? "no-game" : reason;
    }
    this.emitEvent("dc.system.state", `machine state: ${lifetime}`);
    this.broadcastTick();
  }

  // -------------------------------------------------------------------------------------
  // The machine
  // -------------------------------------------------------------------------------------

  private register(path: string, name: string): RegisterContent {
    return this.values.get(path)!.get(name)!;
  }

  private setRegisterValue(path: string, name: string, value: RegisterContent): void {
    this.values.get(path)!.set(name, value);
  }

  private pc(target: TargetProcessor): number {
    const { pcPath, pcRegister } = targetById(target);
    return this.register(pcPath, pcRegister) as number;
  }

  private advance(target: TargetProcessor): { wrapped: boolean } {
    const { pcPath, pcRegister } = targetById(target);
    const before = this.pc(target);
    const after = mockNextAddress(target, before);
    this.setRegisterValue(pcPath, pcRegister, after);
    return { wrapped: after === RINGS[target].base && before !== after };
  }

  private setCycles(cycles: bigint): void {
    this.cycles = cycles;
    this.setRegisterValue("dc.timing", "SH4_CYCLES", cycles);
    this.setRegisterValue("dc.timing", "SCHED_NOW", (cycles / SH4_TIMESLICE) * SH4_TIMESLICE);
  }

  /** One emulation step: every target executes one instruction, and what is due happens. */
  private emulationStep(): void {
    if (this.lifetime !== "running" || !this.running) {
      return;
    }
    this.emulationSteps++;
    const wrapped: Partial<Record<TargetProcessor, boolean>> = {};
    for (const target of ["sh4", "arm7", "dsp"] as const) {
      wrapped[target] = this.advance(target).wrapped;
    }
    this.setRegisterValue("dc.sh4.cpu", "PR", (((this.register("dc.sh4.cpu", "PR") as number) + 2) & 0xffffffff) >>> 0);
    this.setRegisterValue("dc.aica.sgc.0", "VOL", ((this.register("dc.aica.sgc.0", "VOL") as number) + 1) & 0xff);
    this.setRegisterValue("dc.aica.dsp", "MDEC_CT", ((this.register("dc.aica.dsp", "MDEC_CT") as number) - 1) & 0xffff);
    this.setCycles(this.cycles + CYCLES_PER_EMULATION_STEP);

    // event breakpoints: a hit requests a pause that is honoured at the end of the step
    let eventHit: number | undefined;
    for (const [name, spec] of Object.entries(MOCK_EVENTS)) {
      if (spec.every !== undefined && this.emulationSteps % spec.every === (spec.phase ?? 0)) {
        const hit = this.emitEvent(name, spec.message(this.emulationSteps));
        if (hit !== undefined && (eventHit === undefined || hit < eventHit)) {
          eventHit = hit;
        }
      }
    }

    // code breakpoints: the stop is in front of the instruction the PC is at now
    let codeHit: number | undefined;
    for (const breakpoint of this.breakpoints.values()) {
      if (breakpoint.kind !== "code" || !this.isActive(breakpoint)) {
        continue;
      }
      const target = CODE_BREAKPOINT_EVENTS[breakpoint.event];
      if (target && this.sameAddress(target, breakpoint.address!, this.pc(target))) {
        codeHit = codeHit === undefined ? breakpoint.id : Math.min(codeHit, breakpoint.id);
      }
    }

    // if several causes coincide, the priority is breakpoint, event, step
    if (codeHit !== undefined) {
      this.enterStop("breakpoint", codeHit);
    } else if (eventHit !== undefined) {
      this.enterStop("event", eventHit);
    } else if (this.pendingStepOut && wrapped[this.pendingStepOut]) {
      // the branch at the end of the loop is what the mock takes for the return
      this.enterStop("step");
    }
  }

  private sameAddress(target: TargetProcessor, a: number, b: number): boolean {
    // the same SH4 code is reachable at 0x0C.., 0x8C.. and 0xAC..
    return target === "sh4" ? (a & SH4_ADDRESS_MASK) === (b & SH4_ADDRESS_MASK) : a === b;
  }

  private isActive(breakpoint: BreakpointDescriptor): boolean {
    if (!breakpoint.enabled || (this.clients.size === 0 && this.graceExpired)) {
      return false;
    }
    const state = this.categories.get(categorize(breakpoint))!;
    if (state.muted) {
      return false;
    }
    const anySoloed = Array.from(this.categories.values()).some((category) => category.soloed);
    return anySoloed ? state.soloed : true;
  }

  /** Every transition into a state reported as paused, and every completed step, is a new stop. */
  private enterStop(reason: StopReason, breakpointId?: number, fallbackStep = false): void {
    this.running = false;
    this.stopId++;
    this.reason = reason;
    this.stopBreakpointId = breakpointId;
    this.pendingStepOut = undefined;
    this.fallbackStep = fallbackStep;
    this.updateFallback();
    this.broadcastTick();
  }

  /**
   * Logs an event if it is due to be logged and returns the id of the lowest active event
   * breakpoint on it, if any.
   */
  private emitEvent(name: string, message: string): number | undefined {
    const spec = MOCK_EVENTS[name];
    let hit: number | undefined;
    let hasBreakpoint = false;
    for (const breakpoint of this.breakpoints.values()) {
      if (breakpoint.kind === "event" && breakpoint.event === name) {
        hasBreakpoint = true;
        if (this.isActive(breakpoint) && (hit === undefined || breakpoint.id < hit)) {
          hit = breakpoint.id;
        }
      }
    }
    if (this.clients.size > 0 && (spec.rate === "low" || hasBreakpoint)) {
      this.eventLog.push({
        eventId: String(this.nextEventId++),
        timestamp: Date.now(),
        subsystem: spec.subsystem,
        severity: spec.severity,
        message,
        metadata: { event: name, cycles: this.cycles.toString() },
      });
      if (this.eventLog.length > PROTOCOL_BOUNDS.eventLogEntries) {
        this.eventLog.splice(0, this.eventLog.length - PROTOCOL_BOUNDS.eventLogEntries);
      }
    }
    return hit;
  }

  /** With ForceFallback: whether the interpreter loop is selected, i.e. an SH4 breakpoint is active or a step-out is pending. */
  private updateFallback(): void {
    if (!this.options.forceFallback) {
      return;
    }
    const selected =
      this.pendingStepOut === "sh4" ||
      Array.from(this.breakpoints.values()).some(
        (breakpoint) => breakpoint.kind === "code" && CODE_BREAKPOINT_EVENTS[breakpoint.event] === "sh4" && this.isActive(breakpoint),
      );
    if (selected !== this.fallbackSelected) {
      this.fallbackSelected = selected;
      this.emitEvent("dc.debugger.engine", selected ? "SH4 engine: interpreter fallback" : "SH4 engine: mock JIT");
    }
  }

  // -------------------------------------------------------------------------------------
  // Ticks (design 2.9)
  // -------------------------------------------------------------------------------------

  private get paused(): boolean {
    return this.lifetime !== "running" || !this.running;
  }

  private formatRegister(path: string, register: RegisterSpec): RegisterValue {
    const content = this.lifetime === "no-machine" ? "n/a" : this.register(path, register.name);
    let value: string;
    if (typeof content === "string") {
      value = content;
    } else {
      value = `0x${content.toString(16).toUpperCase().padStart(Math.ceil(register.width / 4), "0")}`;
    }
    return { name: register.name, value, width: register.width };
  }

  private registersOf(path: string): RegisterValue[] {
    return this.nodes.get(path)!.registers!.map((register) => this.formatRegister(path, register));
  }

  private callstack(target: "sh4" | "arm7", maxFrames: number): CallstackFrame[] {
    const sh4 = target === "sh4";
    const path = sh4 ? "dc.sh4.cpu" : "dc.aica.arm7";
    const sp = this.register(path, sh4 ? "R15" : "R13") as number;
    const linkRegister = this.register(path, sh4 ? "PR" : "R14") as number;
    const base = sh4 ? 0x8c000000 : 0x00200000;
    const frames: CallstackFrame[] = [];
    const push = (pc: number, frameSp: number, location?: string) => {
      const symbol = symbolize(target, pc);
      frames.push({ index: frames.length, pc, sp: frameSp, ...(symbol ? { symbol } : {}), ...(location ? { location } : {}) });
    };
    // frame 0 is the PC, frame 1 the link register, the rest is what the stack scan finds
    push(this.pc(target), sp);
    push(linkRegister, sp, sh4 ? "pr" : "lr");
    for (let index = 2; index < 16; index++) {
      const offset = (index - 2) * 4;
      push(base + (index - 1) * 4, sp + offset, `stack+0x${offset.toString(16).toUpperCase()}`);
    }
    return frames.slice(0, maxFrames);
  }

  private buildTick(full: boolean): DebuggerTick {
    const paused = this.paused;
    const stale = !paused && !this.options.sliceContext;
    const registers: Record<string, RegisterValue[]> = {};
    if (this.lifetime !== "no-machine") {
      const paths = full || paused ? Array.from(this.values.keys()) : BASE_PATHS;
      for (const path of paths) {
        if (stale && path === "dc.sh4.cpu") {
          continue;
        }
        registers[path] = this.registersOf(path);
      }
    }

    const breakpoints: Record<string, BreakpointDescriptor> = {};
    for (const [id, breakpoint] of this.breakpoints) {
      breakpoints[String(id)] = { ...breakpoint };
    }

    // evaluated in every tick, whatever paths it carries; what cannot be read is "n/a", and
    // without a context at the slice hook that is the SH4's registers while it runs
    const watches: WatchDescriptor[] = Array.from(this.watches.values())
      .sort((a, b) => a.id - b.id)
      .map((watch) => ({
        id: watch.id,
        expression: watch.expression,
        value: stale && watch.path === "dc.sh4.cpu" ? "n/a" : this.formatRegister(watch.path, watch.register).value,
      }));

    const categories: Record<string, BreakpointCategoryState> = {};
    for (const key of CATEGORY_KEYS) {
      categories[key] = { ...this.categories.get(key)! };
    }

    const notice = this.options.forceFallback && (this.fallbackSelected || this.fallbackStep) ? FALLBACK_NOTICE : undefined;
    const showCallstacks = paused && this.lifetime !== "no-machine" && this.has(CAPABILITIES.CALLSTACK);
    const listed = (target: TargetProcessor) => this.targets.some((candidate) => candidate.id === target);

    return {
      tickId: this.tickId++,
      timestamp: Date.now(),
      executionState: {
        state: paused ? "paused" : "running",
        stopId: this.stopId,
        ...(paused && this.reason ? { reason: this.reason } : {}),
        ...(paused && this.stopBreakpointId !== undefined ? { breakpointId: this.stopBreakpointId } : {}),
        ...(stale ? { registersStale: true } : {}),
        ...(notice ? { notice } : {}),
      },
      registers,
      breakpoints,
      eventLog: this.eventLog.slice(),
      watches,
      callstacks: {
        sh4: showCallstacks && listed("sh4") ? this.callstack("sh4", PROTOCOL_BOUNDS.callstackFramesPerTick) : [],
        arm7: showCallstacks && listed("arm7") ? this.callstack("arm7", PROTOCOL_BOUNDS.callstackFramesPerTick) : [],
      },
      categories,
    };
  }

  private sendTick(client: ClientState, tick: DebuggerTick): void {
    client.needsFull = false;
    client.connection.sendText(JSON.stringify({ jsonrpc: JSON_RPC_VERSION, method: RpcMethod.EVENT_TICK, params: tick }));
  }

  /** To every client, after a state change or a successful mutating request. Never dropped. */
  private broadcastTick(): void {
    if (this.clients.size === 0) {
      return;
    }
    const full = Array.from(this.clients.values()).some((client) => client.needsFull);
    const tick = this.buildTick(full);
    for (const client of this.clients.values()) {
      this.sendTick(client, tick);
    }
  }

  /** Every `tickMs` while running and a client is connected; every `fullTickEvery`-th is full. */
  private periodicTick(): void {
    if (this.paused || this.clients.size === 0) {
      return;
    }
    this.periodicTicks++;
    const recipients: ClientState[] = [];
    for (const client of this.clients.values()) {
      // a slow client is skipped, and makes up for it with a full tick
      if ((client.connection.queuedBytes?.() ?? 0) > SLOW_CLIENT_BYTES) {
        client.needsFull = true;
      } else {
        recipients.push(client);
      }
    }
    if (recipients.length === 0) {
      return;
    }
    const full = this.periodicTicks % this.options.fullTickEvery === 0 || recipients.some((client) => client.needsFull);
    const tick = this.buildTick(full);
    for (const client of recipients) {
      this.sendTick(client, tick);
    }
  }

  // -------------------------------------------------------------------------------------
  // Connections and dispatch
  // -------------------------------------------------------------------------------------

  private disconnect(client: ClientState): void {
    if (!this.clients.delete(client.id)) {
      return;
    }
    this.options.log?.(`client ${client.id} disconnected`);
    if (this.clients.size === 0) {
      // the grace period starts only at a disconnect: a StartPaused stop waits for its first client
      this.graceTimer = setTimeout(() => {
        this.graceTimer = undefined;
        this.graceExpired = true;
        this.updateFallback();
        if (this.lifetime === "running" && !this.running) {
          this.running = true;
          this.reason = undefined;
          this.stopBreakpointId = undefined;
        }
      }, this.options.graceMs);
    }
  }

  private send(client: ClientState, message: unknown): void {
    if (this.clients.has(client.id)) {
      client.connection.sendText(JSON.stringify(message));
    }
  }

  private sendError(client: ClientState, id: number | null, code: number, message: string): void {
    // `error` objects have `code` and `message` only
    this.send(client, { jsonrpc: JSON_RPC_VERSION, id, error: { code, message } });
  }

  private receive(client: ClientState, text: string): void {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      // the one response whose id is null
      this.sendError(client, null, DebuggerErrorCode.PARSE_ERROR, "parse error");
      return;
    }

    const request = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    const isObject = typeof message === "object" && message !== null && !Array.isArray(message);
    const hasId = isObject && "id" in request;
    const validId = hasId && typeof request.id === "number" && Number.isFinite(request.id);
    const paramsOk =
      isObject && (request.params === undefined || (typeof request.params === "object" && request.params !== null && !Array.isArray(request.params)));
    if (!isObject || request.jsonrpc !== JSON_RPC_VERSION || typeof request.method !== "string" || !paramsOk || (hasId && !validId)) {
      // not a JSON-RPC 2.0 request object, or a batch
      this.sendError(client, validId ? (request.id as number) : null, DebuggerErrorCode.INVALID_REQUEST, "invalid request");
      return;
    }
    if (!hasId) {
      // a notification: the server has none to receive, and a notification gets no answer
      return;
    }
    this.dispatch(client, request.id as number, request.method, (request.params ?? {}) as Record<string, unknown>);
  }

  private dispatch(client: ClientState, id: number, method: string, params: Record<string, unknown>): void {
    if (!Object.hasOwn(this.handlers, method)) {
      this.sendError(client, id, DebuggerErrorCode.METHOD_NOT_FOUND, `method not found: ${method}`);
      return;
    }

    const context: RequestContext = { client, id, afterResponse: [], deferred: false };
    let result: unknown;
    try {
      const handler = this.handlers[method];
      // A method of a later milestone, and one whose capability this server was configured
      // without: -32004, whatever the parameters are and whatever the lifetime is.
      const capability = METHOD_CAPABILITY[method];
      if (!handler || (capability !== undefined && !this.has(capability))) {
        throw notSupported(method);
      }
      const schema = DebuggerRpcMethodSchemas[method as keyof typeof DebuggerRpcMethodSchemas];
      const parsed = schema.params.safeParse(params);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const path = issue.path.map(String).join(".");
        throw invalidParams(path ? `${path}: ${issue.message}` : issue.message);
      }
      this.checkLifetime(handler.cls);
      result = handler.run(parsed.data as Record<string, unknown>, context);
    } catch (error) {
      const failure =
        error instanceof MockRpcError ? error : new MockRpcError(DebuggerErrorCode.INTERNAL_ERROR, "internal error");
      if (!(error instanceof MockRpcError)) {
        this.options.log?.(`${method} threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
      }
      // one convention: a method whose result type is RpcError reports every failure in-band
      if (IN_BAND_ERROR_METHODS.has(method)) {
        this.send(client, { jsonrpc: JSON_RPC_VERSION, id, result: { error: { code: failure.code, message: failure.message } } });
      } else {
        this.sendError(client, id, failure.code, failure.message);
      }
      return;
    }

    if (context.deferred) {
      return;
    }
    this.send(client, { jsonrpc: JSON_RPC_VERSION, id, result });
    context.afterResponse.forEach((action) => action());
  }

  private checkLifetime(cls: CallClass): void {
    if (this.lifetime === "no-machine" && cls !== "describe" && cls !== "table") {
      throw new MockRpcError(DebuggerErrorCode.NO_GAME, "no game loaded");
    }
    if (this.lifetime === "stopped" && (cls === "write" || cls === "exec")) {
      throw new MockRpcError(DebuggerErrorCode.STOPPED_BY_HOST, "emulator stopped by host UI");
    }
  }

  /** The target as this server lists it; -32004 when it does not. */
  private supportedTarget(id: TargetProcessor): DebuggerTarget {
    const target = this.targets.find((candidate) => candidate.id === id);
    if (!target) {
      throw notSupported(`target ${id}`);
    }
    return target;
  }

  private has(capability: string): boolean {
    return this.optionalCapabilities.includes(capability);
  }

  private requireCapability(capability: string, what: string): void {
    if (!this.has(capability)) {
      throw notSupported(what);
    }
  }

  /** Queues the tick that follows a successful mutating request. */
  private tickAfter(context: RequestContext): void {
    context.afterResponse.push(() => this.broadcastTick());
  }

  // -------------------------------------------------------------------------------------
  // Methods
  // -------------------------------------------------------------------------------------

  private describe(context: RequestContext): DebuggerShape {
    const build = (node: NodeSpec): DeviceNodeDescriptor => ({
      path: node.path,
      label: node.label,
      description: node.description,
      // empty arrays are omitted
      ...(node.registers?.length ? { registers: this.registersOf(node.path) } : {}),
      ...(node.events?.length ? { events: node.events.slice() } : {}),
      ...(node.actions?.length ? { actions: node.actions.slice() } : {}),
      ...(node.children?.length ? { children: node.children.map(build) } : {}),
    });
    // response first, then a full tick to this client only
    context.afterResponse.push(() => {
      if (this.clients.has(context.client.id)) {
        this.sendTick(context.client, this.buildTick(true));
      }
    });
    return {
      emulator: { name: "nullDC (mock)", version: "3.0.0", build: "native" },
      protocol: this.options.protocol,
      ui: this.options.ui,
      capabilities: this.capabilities,
      targets: this.targets.map((target) => ({ ...target })),
      deviceTree: DEVICE_TREE.map(build),
    };
  }

  private memoryTarget(params: Record<string, unknown>): "sh4" | "arm7" {
    const target = (params.target as TargetProcessor | undefined) ?? "sh4";
    if (target === "dsp") {
      throw notSupported("target dsp has no memory");
    }
    this.supportedTarget(target);
    return target;
  }

  private getMemorySlice(params: Record<string, unknown>): MemorySlice {
    const target = this.memoryTarget(params);
    const address = params.address as number;
    const length = params.length as number;
    const data: number[] = new Array<number>(length);
    const unreadable: Array<[number, number]> = [];
    for (let offset = 0; offset < length; offset++) {
      const readable = isReadable(target, address + offset);
      data[offset] = readable ? memoryByte(target, address + offset) : 0;
      if (!readable) {
        const last = unreadable.at(-1);
        if (last && last[0] + last[1] === offset) {
          last[1]++;
        } else {
          unreadable.push([offset, 1]);
        }
      }
    }
    if (unreadable.length === 1 && unreadable[0][1] === length) {
      throw new MockRpcError(DebuggerErrorCode.NOT_READABLE, "address not readable");
    }
    return { baseAddress: address, data, validity: "ok", ...(unreadable.length ? { unreadable } : {}) };
  }

  private getDisassembly(params: Record<string, unknown>): { lines: DisassemblyLine[] } {
    const targetId = (params.target as TargetProcessor | undefined) ?? "sh4";
    const target = this.supportedTarget(targetId);
    const address = params.address as number;
    const count = params.count as number;
    if (address % target.instructionSize !== 0) {
      throw invalidParams(`address: ${hex8(address)} is not a multiple of ${target.instructionSize}`);
    }
    if (address > target.addressMax) {
      throw invalidParams(`address: above the last address of ${targetId}`);
    }
    const lines: DisassemblyLine[] = [];
    // exactly `count` lines, fewer only at the end of the address space
    for (let index = 0; index < count; index++) {
      const lineAddress = address + index * target.instructionSize;
      if (lineAddress + target.instructionSize - 1 > target.addressMax) {
        break;
      }
      lines.push(disassembleLine(targetId, lineAddress));
    }
    return { lines };
  }

  private getCallstack(params: Record<string, unknown>): { target: "sh4" | "arm7"; frames: CallstackFrame[] } {
    const target = params.target as "sh4" | "arm7";
    this.supportedTarget(target);
    const maxFrames = (params.maxFrames as number | undefined) ?? PROTOCOL_BOUNDS.callstackMaxFrames.default;
    return { target, frames: this.callstack(target, maxFrames) };
  }

  /** `<node path>.<register name>`; the last component is resolved case-insensitively. */
  private resolveExpression(expression: string): { expression: string; path: string; register: RegisterSpec } {
    const normalised = expression.toLowerCase();
    const dot = normalised.lastIndexOf(".");
    const path = normalised.slice(0, dot);
    const name = normalised.slice(dot + 1);
    const register = dot > 0 ? this.nodes.get(path)?.registers?.find((candidate) => candidate.name.toLowerCase() === name) : undefined;
    if (!register) {
      throw invalidParams(`"${expression}" is not a register of the device tree`);
    }
    return { expression: normalised, path, register };
  }

  private watch(params: Record<string, unknown>, context: RequestContext): Record<string, never> {
    // all-or-nothing: every expression is resolved before the first one is stored
    const resolved = (params.expressions as string[]).map((expression) => this.resolveExpression(expression));
    const stored = new Set(Array.from(this.watches.values()).map((watch) => watch.expression));
    const added = resolved.filter((entry, index) => !stored.has(entry.expression) && resolved.findIndex((other) => other.expression === entry.expression) === index);
    if (this.watches.size + added.length > PROTOCOL_BOUNDS.watches) {
      throw invalidParams(`at most ${PROTOCOL_BOUNDS.watches} watches`);
    }
    for (const entry of added) {
      const id = this.nextWatchId++;
      this.watches.set(id, { id, ...entry });
    }
    this.tickAfter(context);
    return {};
  }

  private unwatch(params: Record<string, unknown>, context: RequestContext): Record<string, never> {
    // unknown ids are ignored
    (params.watchIds as number[]).forEach((id) => this.watches.delete(id));
    this.tickAfter(context);
    return {};
  }

  private watchById(id: number): WatchEntry {
    const watch = this.watches.get(id);
    if (!watch) {
      throw invalidParams(`unknown watch id ${id}`);
    }
    return watch;
  }

  private modifyWatchExpression(params: Record<string, unknown>, context: RequestContext): Record<string, never> {
    const watch = this.watchById(params.watchId as number);
    // the id is kept
    this.watches.set(watch.id, { id: watch.id, ...this.resolveExpression(params.newExpression as string) });
    this.tickAfter(context);
    return {};
  }

  private editWatch(params: Record<string, unknown>, context: RequestContext): Record<string, never> {
    const watch = this.watchById(params.watchId as number);
    this.writeRegister(watch.path, watch.register, params.value as string);
    this.tickAfter(context);
    return {};
  }

  private setRegister(params: Record<string, unknown>, context: RequestContext): Record<string, never> {
    const path = params.path as string;
    const name = params.name as string;
    const register = this.nodes.get(path)?.registers?.find((candidate) => candidate.name === name);
    if (!register) {
      throw invalidParams(`${path} has no register ${name}`);
    }
    this.writeRegister(path, register, params.value as string);
    this.tickAfter(context);
    return {};
  }

  private writeRegister(path: string, register: RegisterSpec, text: string): void {
    if (register.width === 0 || register.writable === false) {
      throw new MockRpcError(DebuggerErrorCode.NOT_WRITABLE, `not writable: ${path}.${register.name}`);
    }
    const trimmed = text.trim();
    if (!/^(0x[0-9a-f]+|\d+)$/i.test(trimmed)) {
      throw invalidParams(`value: "${text}" is neither 0x hex nor decimal`);
    }
    // truncated to the register's width
    const value = BigInt(trimmed) & ((1n << BigInt(register.width)) - 1n);
    this.setRegisterValue(path, register.name, register.width > 32 ? value : Number(value));
  }

  private pause(context: RequestContext): Record<string, never> {
    if (!this.running) {
      // already paused: nothing changes
      return {};
    }
    context.afterResponse.push(() => {
      if (this.running && this.lifetime === "running") {
        this.enterStop("pause");
      }
    });
    return {};
  }

  private resume(context: RequestContext): Record<string, never> {
    if (this.running) {
      return {};
    }
    context.afterResponse.push(() => this.leaveStop());
    return {};
  }

  private leaveStop(): void {
    if (this.running || this.lifetime !== "running") {
      return;
    }
    this.running = true;
    this.reason = undefined;
    this.stopBreakpointId = undefined;
    this.fallbackStep = false;
    this.updateFallback();
    this.broadcastTick();
  }

  private step(kind: "step" | "stepOver" | "stepOut", params: Record<string, unknown>, context: RequestContext): Record<string, never> {
    const targetId = params.target as TargetProcessor;
    if (this.running) {
      throw new MockRpcError(DebuggerErrorCode.NOT_PAUSED, "not paused");
    }
    if (!this.supportedTarget(targetId).stepping) {
      throw notSupported(`stepping target ${targetId}`);
    }
    if (targetId === "dsp" && kind !== "step") {
      throw notSupported(`control.${kind} for target dsp`);
    }
    if (targetId === "sh4") {
      // preconditions, checked before anything executes
      const pc = this.pc("sh4");
      if (pc % 2 !== 0) {
        throw new MockRpcError(DebuggerErrorCode.CANNOT_STEP, "cannot step: pc is odd");
      }
      if (!mockSh4Readable(pc) || !mockSh4Readable(pc + 1)) {
        throw new MockRpcError(DebuggerErrorCode.CANNOT_STEP, "cannot step: pc not readable");
      }
    }

    if (kind === "stepOut") {
      // a resume until the return: tick running now, tick paused with reason "step" later
      context.afterResponse.push(() => {
        this.pendingStepOut = targetId;
        this.leaveStop();
      });
      return {};
    }

    // step, and step over (the loop has no calls): one instruction, one paused tick, no running tick
    context.afterResponse.push(() => {
      this.advance(targetId);
      if (targetId === "sh4") {
        this.setCycles(this.cycles + 1n);
      }
      // the tick of a step on the fallback engine carries the notice
      this.enterStop("step", undefined, this.options.forceFallback && targetId === "sh4");
    });
    return {};
  }

  private breakpointById(id: number): BreakpointDescriptor {
    const breakpoint = this.breakpoints.get(id);
    if (!breakpoint) {
      throw invalidParams(`unknown breakpoint id ${id}`);
    }
    return breakpoint;
  }

  private afterBreakpointChange(context: RequestContext): void {
    this.updateFallback();
    this.tickAfter(context);
  }

  private addBreakpoint(params: Record<string, unknown>, context: RequestContext): Record<string, never> {
    const event = params.event as string;
    const address = params.address as number | undefined;
    const kind = (params.kind as BreakpointDescriptor["kind"] | undefined) ?? (address === undefined ? "event" : "code");
    const enabled = (params.enabled as boolean | undefined) ?? true;

    let breakpoint: Omit<BreakpointDescriptor, "id">;
    if (kind === "event") {
      this.requireCapability(CAPABILITIES.EVENT_BREAKPOINTS, "event breakpoints");
      // the event has to be one the server raises
      if (!(event in MOCK_EVENTS)) {
        throw notSupported(`event ${event}`);
      }
      breakpoint = { event, kind, enabled };
    } else {
      const targetId = CODE_BREAKPOINT_EVENTS[event];
      if (!targetId) {
        throw notSupported(`code breakpoints on ${event}`);
      }
      const target = this.supportedTarget(targetId);
      if (!target.stepping) {
        throw notSupported(`code breakpoints of target ${targetId}`);
      }
      if (address === undefined) {
        throw invalidParams("address: a code breakpoint needs one");
      }
      if (address % target.instructionSize !== 0) {
        throw invalidParams(`address: ${hex8(address)} is not a multiple of ${target.instructionSize}`);
      }
      if (targetId === "dsp" && address > target.addressMax) {
        throw invalidParams(`address: DSP steps are 0..${target.addressMax}`);
      }
      breakpoint = { event, address, kind, enabled };
    }
    if (this.breakpoints.size >= PROTOCOL_BOUNDS.breakpoints) {
      throw invalidParams(`at most ${PROTOCOL_BOUNDS.breakpoints} breakpoints`);
    }
    // ids are never reused; no de-duplication
    const id = this.nextBreakpointId++;
    this.breakpoints.set(id, { id, ...breakpoint });
    this.afterBreakpointChange(context);
    return {};
  }

  private removeBreakpoint(params: Record<string, unknown>, context: RequestContext): Record<string, never> {
    const { id } = this.breakpointById(params.id as number);
    this.breakpoints.delete(id);
    if (this.stopBreakpointId === id) {
      // the stop in force was this breakpoint's: its later ticks keep the reason and stop carrying the id
      this.stopBreakpointId = undefined;
    }
    this.afterBreakpointChange(context);
    return {};
  }

  private toggleBreakpoint(params: Record<string, unknown>, context: RequestContext): Record<string, never> {
    this.breakpointById(params.id as number).enabled = params.enabled as boolean;
    this.afterBreakpointChange(context);
    return {};
  }

  private setCategoryStates(params: Record<string, unknown>, context: RequestContext): Record<string, never> {
    const categories = params.categories as Record<string, BreakpointCategoryState>;
    // unknown keys are ignored, absent keys keep their state
    for (const key of CATEGORY_KEYS) {
      const state = categories[key];
      if (state) {
        this.categories.set(key, { muted: state.muted, soloed: state.soloed });
      }
    }
    this.afterBreakpointChange(context);
    return {};
  }

  /**
   * The capture is the next `frames` AICA samples; the answer is sent when it is complete.
   * A running machine keeps running. A paused one runs for the capture and pauses again
   * with reason "capture".
   */
  private recordSgcFrames(params: Record<string, unknown>, context: RequestContext): void {
    const frames = (params.frames as number | undefined) ?? PROTOCOL_BOUNDS.sgcFrames.default;
    const wasPaused = !this.running;
    context.deferred = true;
    if (wasPaused) {
      this.leaveStop();
    }
    // 44100 samples per second, and never in the same turn as the request
    const duration = Math.max(1, Math.ceil((frames * 1000) / 44100));
    const timer = setTimeout(() => {
      this.captureTimers.delete(timer);
      this.capture = generateMockSgcCapture(frames, ++this.captureSeed);
      this.send(context.client, { jsonrpc: JSON_RPC_VERSION, id: context.id, result: {} });
      if (wasPaused && this.running && this.lifetime === "running") {
        this.enterStop("capture");
      }
    }, duration);
    this.captureTimers.add(timer);
  }

  private getSgcFrameData(context: RequestContext): unknown {
    const capture = this.capture;
    if (!capture) {
      throw new MockRpcError(DebuggerErrorCode.NO_CAPTURE, "no capture available");
    }
    const binaryId = ++context.client.binaryId;
    // the JSON response first, the binary frame second, to the requesting client only
    context.afterResponse.push(() => {
      if (this.clients.has(context.client.id)) {
        context.client.connection.sendBinary(encodeBinaryFrame(BinaryFrameKind.SGC_FRAMES, binaryId, capture.data));
      }
    });
    return {
      frameCount: capture.frameCount,
      channelsPerFrame: SGC_CHANNELS_PER_FRAME,
      bytesPerChannel: SGC_BYTES_PER_CHANNEL,
      totalBytes: capture.data.byteLength,
      binaryId,
    };
  }
}
