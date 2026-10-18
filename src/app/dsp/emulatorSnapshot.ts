import type { DebuggerNotification, DebuggerTarget, DebuggerTick, ExecutionState, RegisterValue } from "../../lib/debuggerSchema";
import { AICA_DSP_RAM_BYTES, AICA_DSP_STEPS, REG } from "../../lib/aicaDsp";
import { registerNumber } from "../../state/targets";
import { NO_GAME } from "../../state/tickState";
import { decodeInst, disassembleDesc } from "./dspUtils";

// "Load from emulator": the emulator's DSP, at a stop, into the playground's core (the M3 round's M3-D35).
//
// A snapshot is one read and one tick of one stop. The read is state.getMemoryBinary of the ARM7 from 0 for 0x808000
// bytes: wave memory (2 MiB, which the ARM7 sees mirrored up to 8 MiB) and, from 0x00800000 on, the AICA's register
// file as a CPU reads it (COEF with bits 2:0 0, TEMP and MEMS whole, MIXS of the bank the DSP reads, EFREG 16 bits;
// 0x2804 and EXTS read 0): both of one moment. What no CPU reads comes from the rows of the paused tick of the same
// stop: `dc.aica.dsp` (STEP, MDEC_CT and the nine registers of its datapath) and `dc.aica.common` (RBP, RBL and TESTB0,
// the word 0x2804, the DSP's RBPL). Taken while the target runs, the read and a tick would be two moments: there is no
// snapshot then.
//
// A stop sends no periodic tick, so the tick is asked for: debugger.describe is answered with a full tick behind it
// (design 3.2), and every tick that reaches the client behind the read was built behind it. When that tick is a
// paused tick of the stop the load was asked at, the stop lasted from before the read to after it, and the read and
// the rows are of the same stop. Anything else (a running tick, another stop) and there is no snapshot.
//
// What it continues: from a stop in the DSP phase behind step 0 (STEP 1 to 127: a DSP breakpoint's or a DSP step's
// stop) the core computes what the emulator computes, step for step, to the end of that sample. Step 0 changes the
// MIXS banks: the DSP then reads the bank the sound generator's sweep filled. At a stop with STEP 0 (an SH4 or ARM7
// stop, the end of a sample, a stop in front of step 0) the bank it reads next is that fill bank, which neither a
// CPU read nor MIXS_BANK shows, so MIXS of the next sample is not known. EXTS (the CD-DA pair) has no row and reads 0
// for a CPU: it is loaded as 0 at every stop. The banner says both (`snapshotNotes`).

/** The one read of a snapshot: wave memory and the AICA's register file, as the ARM7 sees them, of one moment. */
export const SNAPSHOT_READ = { target: "arm7", address: 0, length: 0x00808000 } as const;

/** Where the ARM7 sees the register file of the AICA. */
export const SNAPSHOT_REGISTER_FILE = 0x00800000;

/** The node of the DSP, and the rows of it a snapshot takes. */
export const SNAPSHOT_DSP_PATH = "dc.aica.dsp";
export const SNAPSHOT_DSP_ROWS = [
  "STEP",
  "MDEC_CT",
  "ACC",
  "Y_REG",
  "FRC_REG",
  "ADRS_REG",
  "LATCH",
  "LATCH_COPY",
  "MEMVAL",
  "NOFL_PIPE",
  "MIXS_BANK",
] as const;

/** The node of the AICA's common registers, and its rows of the word 0x2804 (RBP 11:0, RBL 14:13, TESTB0 15). */
export const SNAPSHOT_COMMON_PATH = "dc.aica.common";
export const SNAPSHOT_COMMON_ROWS = ["RBP", "RBL", "TESTB0"] as const;

/** How long the tick behind the read may take. */
const TICK_TIMEOUT_MS = 10_000;

/** The register file's offsets of what the DSP has, slot by slot (4 bytes, the register in the low 16 bits). */
const DSP_RANGES: ReadonlyArray<readonly [from: number, to: number]> = [
  [0x3000, 0x3200], // COEF
  [0x3200, 0x3300], // MADRS
  [0x3400, 0x3c00], // MPRO
  [0x4000, 0x4400], // TEMP, two slots a word
  [0x4400, 0x4500], // MEMS, two slots a word
  [0x4580, 0x45c0], // EFREG
];
// EXTS (0x45C0, 0x45C4), the CD-DA pair, has no row and reads 0 for a CPU: it is loaded as 0, whatever a server
// gives there
const MIXS_RANGE = [0x4500, 0x4580] as const;
const RBPL_OFFSET = 0x2804;

export type SnapshotDspRow = (typeof SNAPSHOT_DSP_ROWS)[number];

export interface EmulatorSnapshot {
  /** who: `<emulator name> @ <host>`, as the connection picker names the endpoint */
  source: string;
  /** the stop it is of */
  stopId: number;
  reason?: string;
  /** `timestamp` of the paused tick whose rows it has (the server's clock, ms) */
  timestamp: number;
  /** the rows of `dc.aica.dsp`, as numbers: the bits under their widths */
  dsp: Record<SnapshotDspRow, number>;
  /** the DSP's RBPL, from RBP, RBL and TESTB0 of `dc.aica.common` */
  rbpl: number;
  /** the read: wave memory from 0, the register file from SNAPSHOT_REGISTER_FILE */
  memory: Uint8Array;
}

/** A load that could not be made, and why: shown as it is. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SnapshotError";
  }
}

/** What a snapshot needs of the session: the client of its connection. */
export interface SnapshotClient {
  fetchMemoryBinary(params: { target: "arm7"; address: number; length: number }): Promise<{
    baseAddress: number;
    unreadable?: Array<[number, number]>;
    data: ArrayBuffer;
  }>;
  describe(): Promise<unknown>;
  onNotification(handler: (notification: DebuggerNotification) => void): () => void;
}

export interface SnapshotSession {
  client: SnapshotClient;
  /** the run state of the latest tick, as the store has it now */
  execution: () => Pick<ExecutionState, "state" | "stopId" | "reason"> | undefined;
  /** `<emulator name> @ <host>` */
  source: string;
}

/** The text of a register file's slot: the 16 bits a CPU reads there. */
const slot = (memory: Uint8Array, offset: number): number => {
  const at = SNAPSHOT_REGISTER_FILE + offset;
  return memory[at] | (memory[at + 1] << 8) | (memory[at + 2] << 16) | (memory[at + 3] << 24);
};

const rowsOf = <N extends string>(tick: DebuggerTick, path: string, names: readonly N[]): Record<N, number> => {
  const registers: RegisterValue[] | undefined = tick.registers[path];
  const missing: string[] = [];
  const values = {} as Record<N, number>;
  for (const name of names) {
    const value = registerNumber(registers?.find((register) => register.name === name)?.value);
    if (value === undefined) {
      missing.push(name);
    } else {
      values[name] = value;
    }
  }
  if (missing.length > 0) {
    throw new SnapshotError(
      `the paused tick has no ${missing.join(", ")} in ${path}: the load needs the registers a server of milestone M3 has there`,
    );
  }
  return values;
};

/** Whether a run of unreadable bytes `[offset, length]` takes something a load uses. */
const touchesUsed = ([offset, length]: [number, number]): boolean => {
  const end = offset + length;
  const overlaps = (from: number, to: number) => offset < to && end > from;
  return (
    overlaps(0, AICA_DSP_RAM_BYTES) ||
    overlaps(SNAPSHOT_REGISTER_FILE + RBPL_OFFSET, SNAPSHOT_REGISTER_FILE + RBPL_OFFSET + 4) ||
    overlaps(SNAPSHOT_REGISTER_FILE + 0x3000, SNAPSHOT_REGISTER_FILE + 0x45c8)
  );
};

/**
 * Takes a snapshot at the stop the target is in: one read and the paused tick behind it, of the same stop. Rejects
 * with a SnapshotError when the target runs, when the stop ends while it is taken, or when the server lacks a row; and
 * with the server's error when it refuses the read.
 */
export const takeEmulatorSnapshot = async ({ client, execution, source }: SnapshotSession): Promise<EmulatorSnapshot> => {
  const at = execution();
  if (at?.state !== "paused" || at.stopId === undefined) {
    throw new SnapshotError("the target is running: a snapshot is taken at a stop");
  }
  if (at.reason === NO_GAME) {
    throw new SnapshotError("no game loaded");
  }
  const stopId = at.stopId;

  // every tick from here on, and which of them came behind the read
  const ticks: Array<{ tick: DebuggerTick; behindRead: boolean }> = [];
  let readDone = false;
  let wake: (() => void) | undefined;
  const unsubscribe = client.onNotification((notification) => {
    if (notification.topic === "tick") {
      ticks.push({ tick: notification.payload, behindRead: readDone });
      wake?.();
    }
  });
  const ofTheStop = (tick: DebuggerTick) => tick.executionState.state === "paused" && tick.executionState.stopId === stopId;
  const ended = () =>
    new SnapshotError(`the target ran while the snapshot was taken (stop ${stopId} ended): load again at a stop`);

  try {
    const read = await client.fetchMemoryBinary({ ...SNAPSHOT_READ });
    readDone = true;
    if (ticks.some(({ tick }) => !ofTheStop(tick))) {
      throw ended();
    }

    // the paused tick behind the read, which a describe makes the server send
    let timer: ReturnType<typeof setTimeout> | undefined;
    const behind = new Promise<DebuggerTick>((resolve, reject) => {
      const look = () => {
        const first = ticks.find(({ behindRead }) => behindRead);
        if (first) {
          resolve(first.tick);
        }
      };
      wake = look;
      timer = setTimeout(() => reject(new SnapshotError(`no tick came within ${TICK_TIMEOUT_MS / 1000} s of the read`)), TICK_TIMEOUT_MS);
      look();
    });
    try {
      await client.describe();
      const tick = await behind;
      if (!ofTheStop(tick) || ticks.some(({ tick: other }) => !ofTheStop(other))) {
        throw ended();
      }

      const memory = new Uint8Array(read.data);
      if (read.baseAddress !== SNAPSHOT_READ.address || memory.byteLength !== SNAPSHOT_READ.length) {
        throw new SnapshotError(
          `the read gave ${memory.byteLength} bytes from 0x${read.baseAddress.toString(16)}, not ${SNAPSHOT_READ.length} from 0`,
        );
      }
      const unreadable = (read.unreadable ?? []).filter(touchesUsed);
      if (unreadable.length > 0) {
        const [offset, length] = unreadable[0];
        throw new SnapshotError(`the server could not read ${length} bytes at 0x${offset.toString(16).toUpperCase()} of the ARM7's memory`);
      }
      const dsp = rowsOf(tick, SNAPSHOT_DSP_PATH, SNAPSHOT_DSP_ROWS);
      const common = rowsOf(tick, SNAPSHOT_COMMON_PATH, SNAPSHOT_COMMON_ROWS);
      return {
        source,
        stopId,
        reason: tick.executionState.reason,
        timestamp: tick.timestamp,
        dsp,
        rbpl: (common.RBP & 0xfff) | ((common.RBL & 3) << 13) | ((common.TESTB0 & 1) << 15),
        memory,
      };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  } finally {
    unsubscribe();
  }
};

/** What a load writes into: the playground's core (`aicaDsp`), or a core of the module itself. */
export interface SnapshotCore {
  reset(): void;
  pokeReg(off: number, value: number): void;
  set(index: (typeof REG)[keyof typeof REG], value: number): void;
  readonly ram: Uint8Array;
}

/**
 * Loads a snapshot into a core: the state after power on first, then the registers as the read has them, written
 * as a debugger writes them (`pokeReg`: also the low bytes of MEMS), MIXS into the bank MIXS_BANK names, RBPL from
 * the rows, STEP, MDEC_CT and the datapath (`set`), and the first 2 MiB of the read as wave memory. EXTS is 0. The
 * sample counter starts again. What the core has beyond that (the bank the sound generator fills, whether its sweep
 * came) is as after power on: nothing the emulator shows.
 */
export const applySnapshot = (core: SnapshotCore, snapshot: EmulatorSnapshot): void => {
  const { memory, dsp } = snapshot;
  core.reset();
  // the bank first: a write of MIXS goes to the bank the DSP reads
  core.set(REG.MIXS_DSP, dsp.MIXS_BANK & 1);
  core.set(REG.MIXS_FILL, (dsp.MIXS_BANK & 1) ^ 1);
  for (const [from, to] of [...DSP_RANGES, MIXS_RANGE]) {
    for (let offset = from; offset < to; offset += 4) {
      core.pokeReg(offset, slot(memory, offset));
    }
  }
  core.pokeReg(RBPL_OFFSET, snapshot.rbpl);
  core.set(REG.STEP, dsp.STEP);
  core.set(REG.MDEC_CT, dsp.MDEC_CT);
  core.set(REG.ACC, dsp.ACC);
  core.set(REG.Y_REG, dsp.Y_REG);
  core.set(REG.FRC_REG, dsp.FRC_REG);
  core.set(REG.ADRS_REG, dsp.ADRS_REG);
  core.set(REG.LATCH, dsp.LATCH);
  core.set(REG.LATCH_COPY, dsp.LATCH_COPY);
  core.set(REG.MEMVAL, dsp.MEMVAL);
  core.set(REG.NOFL_PIPE, dsp.NOFL_PIPE);
  core.set(REG.SAMPLES, 0);
  const ram = core.ram;
  ram.set(memory.subarray(0, Math.min(ram.byteLength, AICA_DSP_RAM_BYTES)));
};

/**
 * The source of the Assembler tab for a register file: COEF, MADRS, MEMS (as MEMS_L and MEMS_H) and MPRO, the
 * registers that are not 0, in the playground's syntax. `peek` reads a register as a debugger does (offsets from the
 * start of the AICA's register area). "Load Regs" and "Load from emulator" make the source the same way.
 */
export const dspSourceFromRegisters = (peek: (offset: number) => number): string => {
  const lines: string[] = ["# AICA-DSP", "", "# COEF"];
  for (let i = 0; i < 128; i++) {
    const value = peek(0x3000 + i * 4);
    if (value) {
      lines.push(`COEF[${i}] = ${value}`);
    }
  }
  lines.push("", "# MADRS");
  for (let i = 0; i < 64; i++) {
    const value = peek(0x3200 + i * 4);
    if (value) {
      lines.push(`MADRS[${i}] = ${value}`);
    }
  }
  lines.push("", "# MEMS");
  for (let i = 0; i < 32; i++) {
    const low = peek(0x4400 + i * 8);
    const high = peek(0x4400 + i * 8 + 4);
    if (low || high) {
      lines.push(`MEMS_L[${i}] = ${low}`, `MEMS_H[${i}] = ${high}`);
    }
  }
  lines.push("", "# MPRO");
  for (let i = 0; i < 128; i++) {
    const words = [0, 4, 8, 12].map((offset) => peek(0x3400 + i * 16 + offset));
    const text = disassembleDesc(decodeInst(words));
    if (text) {
      lines.push(`MPRO[${i}] = ${text}`);
    }
  }
  return lines.join("\n");
};

/** The source of the Assembler tab for a snapshot: its register file, as "Load Regs" makes one. */
export const snapshotSource = (snapshot: EmulatorSnapshot): string =>
  dspSourceFromRegisters((offset) => slot(snapshot.memory, offset & 0x7ffc) & 0xffff);

/** Whether the load continues the emulator: a stop behind step 0 of a sample, in its DSP phase. */
export const snapshotExact = (snapshot: Pick<EmulatorSnapshot, "dsp">): boolean => snapshot.dsp.STEP >= 1 && snapshot.dsp.STEP < AICA_DSP_STEPS;

/** The tick's time as the banner shows it: the hours, minutes, seconds and milliseconds of the local clock. */
export const snapshotTime = (timestamp: number): string => {
  const at = new Date(timestamp);
  const two = (value: number) => value.toString().padStart(2, "0");
  return `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}.${at.getMilliseconds().toString().padStart(3, "0")}`;
};

/** The banner's texts of a snapshot: where and when it was taken, and what it can and cannot continue. */
export const snapshotNotes = (snapshot: Pick<EmulatorSnapshot, "dsp" | "source" | "stopId">): { title: string; exact: boolean; notes: string[] } => {
  const step = snapshot.dsp.STEP;
  const exact = snapshotExact(snapshot);
  const notes = exact
    ? [
        `At step ${step}, in the DSP phase of a sample: up to the end of that sample (step 127) the playground computes what the emulator computes, step for step. From the next sample on the inputs are the playground's own.`,
      ]
    : [
        "At step 0: MIXS of the next sample is not known. Step 0 hands the DSP the MIXS bank the sound generator's sweep filled a sample before, which neither a CPU's read nor MIXS_BANK shows (they show the other bank, at an SH4 or ARM7 stop, at the end of a sample and in front of step 0); the playground goes on with a bank of zeros. The stop of a DSP breakpoint or of a DSP step is behind step 0, and is continued exactly.",
      ];
  notes.push("EXTS (the CD-DA input) is no register a CPU reads: it is loaded as 0.");
  return { title: `Loaded from ${snapshot.source}, stop ${snapshot.stopId}`, exact, notes };
};

export interface SnapshotOffInput {
  /** the playground is a panel of a workspace, which has the session (its tool page has none) */
  inWorkspace: boolean;
  connected: boolean;
  /** the server of this connection has described itself */
  initialized: boolean;
  execution?: Pick<ExecutionState, "state" | "reason">;
  /** the ARM7 as the server lists it: the read is the ARM7's */
  arm7: Pick<DebuggerTarget, "label"> & { supported: boolean };
  /** the server has the capability "memory-binary" */
  memoryBinary: boolean;
  /** a load is being made */
  loading: boolean;
}

/** Why "Load from emulator" cannot be used now; undefined when it can. The words follow "Load from emulator: ". */
export const snapshotOff = ({ inWorkspace, connected, initialized, execution, arm7, memoryBinary, loading }: SnapshotOffInput): string | undefined => {
  if (!inWorkspace) {
    return "the playground has no emulator connection on its tool page; it has the session of a workspace in a workspace's dock panel (DSP: Playground)";
  }
  if (!connected) {
    return "not connected";
  }
  if (!initialized || execution === undefined) {
    return "waiting for the server";
  }
  if (!arm7.supported) {
    return `this server does not support the ${arm7.label} target, through which the wave memory and the registers are read`;
  }
  if (!memoryBinary) {
    return "this server cannot read memory into a binary frame (capability memory-binary)";
  }
  if (execution.state !== "paused") {
    return "the target is running: a snapshot is taken at a stop";
  }
  if (execution.reason === NO_GAME) {
    return "no game loaded";
  }
  if (loading) {
    return "a snapshot is being loaded";
  }
  return undefined;
};
