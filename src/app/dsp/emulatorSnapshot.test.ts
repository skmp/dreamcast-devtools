import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadAicaDsp, REG, VIEW_WORDS } from "../../wasm/aica-dsp-core/aica_dsp_core.mjs";
import type { AicaDspCore, AicaDspModule } from "../../wasm/aica-dsp-core/aica_dsp_core.mjs";
import type { DebuggerNotification, DebuggerTick } from "../../lib/debuggerSchema";
import {
  applySnapshot,
  dspSourceFromRegisters,
  snapshotExact,
  snapshotNotes,
  snapshotOff,
  snapshotSource,
  snapshotTime,
  takeEmulatorSnapshot,
  SnapshotError,
  SNAPSHOT_READ,
  SNAPSHOT_REGISTER_FILE,
  type EmulatorSnapshot,
  type SnapshotClient,
  type SnapshotOffInput,
} from "./emulatorSnapshot";
import { assembleSource } from "./dspUtils";

// "Load from emulator" against the emulator's own DSP core: a core that stands for the emulator runs a program, a
// snapshot is made of it as the emulator's debugger gives one (its register file as a CPU reads it, wave memory, the
// rows of dc.aica.dsp and dc.aica.common of a paused tick), and a second core loaded from that snapshot has to compute
// what the first one computes, step for step, to the end of the sample. The protocol half (one read and the paused
// tick of the same stop behind it) is held against a client the test answers.

const WASM = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "wasm", "aica-dsp-core", "aica_dsp_core.wasm");
const RAM = 2 << 20;
const STEPS = 128;

let module: AicaDspModule;

beforeAll(async () => {
  module = await loadAicaDsp(readFileSync(WASM));
});

/** A small deterministic generator (xorshift32), so that a failing case can be made again. */
const random = (seed: number) => {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
};

/**
 * A core that stands for the emulator: a random program (every step's four words, COEF, MADRS), random TEMP, MEMS
 * and wave memory, RBP / RBL, and sends to every bus in every sample, as the sound generator's sweep makes them in
 * front of step 0. Its EXTS stays 0, as the CD-DA input of a guest that plays none; nothing fetches in a channel's
 * slot and nothing reads the bus, as in the emulator's fast tier.
 */
const emulatorCore = (seed: number, rbpl = 0x0040 | (1 << 13)): { core: AicaDspCore; sample: () => void } => {
  const next = random(seed);
  const core = module.create(RAM);
  for (let offset = 0; offset < 0x200; offset += 4) core.writeReg(0x3000 + offset, next() & 0xfff8);
  for (let offset = 0; offset < 0x100; offset += 4) core.writeReg(0x3200 + offset, next() & 0xffff);
  for (let offset = 0; offset < 0x800; offset += 4) core.writeReg(0x3400 + offset, next() & 0xffff);
  for (let i = 0; i < 128; i++) {
    core.pokeReg(0x4000 + i * 8, next() & 0xff);
    core.pokeReg(0x4000 + i * 8 + 4, next() & 0xffff);
  }
  for (let i = 0; i < 32; i++) {
    core.pokeReg(0x4400 + i * 8, next() & 0xff);
    core.pokeReg(0x4400 + i * 8 + 4, next() & 0xffff);
  }
  core.pokeReg(0x2804, rbpl);
  const ram = core.ram;
  for (let i = 0; i < ram.length; i += 4) {
    const word = next();
    ram[i] = word & 0xff;
    ram[i + 1] = (word >>> 8) & 0xff;
    ram[i + 2] = (word >>> 16) & 0xff;
    ram[i + 3] = word >>> 24;
  }
  // the sends of each sample: a 16 bit sample << 4 on every bus
  const sample = () => {
    const inputs = core.inputsMixs;
    for (let bus = 0; bus < 16; bus++) inputs[bus] = ((next() & 0xffff) << 16) >> 12;
    core.setInputs({ sent: 0xffff });
  };
  return { core, sample };
};

/** Runs the core that stands for the emulator for `samples` samples and then up to the stop in front of `step`. */
const runTo = (emulator: { core: AicaDspCore; sample: () => void }, samples: number, step: number) => {
  for (let n = 0; n < samples; n++) {
    emulator.sample();
    emulator.core.runSample();
  }
  emulator.sample();
  while (emulator.core.currentStep !== step) emulator.core.step();
};

const hex = (value: number, width: number) => `0x${(width >= 32 ? value >>> 0 : value & (2 ** width - 1)).toString(16).toUpperCase()}`;

/** The rows of a paused tick, as the emulator's debugger makes them of its DSP: signed values as their bits under the width. */
const rowsOf = (core: AicaDspCore): DebuggerTick["registers"] => {
  const rbpl = core.peekReg(0x2804);
  return {
    "dc.aica.dsp": [
      { name: "STEP", value: hex(core.get(REG.STEP), 8), width: 8 },
      { name: "MDEC_CT", value: hex(core.get(REG.MDEC_CT), 16), width: 16 },
      { name: "RBP", value: hex(rbpl & 0xfff, 16), width: 16 },
      { name: "RBL", value: hex((rbpl >> 13) & 3, 8), width: 8 },
      { name: "ACC", value: hex(core.get(REG.ACC), 26), width: 26 },
      { name: "Y_REG", value: hex(core.get(REG.Y_REG), 24), width: 24 },
      { name: "FRC_REG", value: hex(core.get(REG.FRC_REG), 13), width: 13 },
      { name: "ADRS_REG", value: hex(core.get(REG.ADRS_REG), 12), width: 12 },
      { name: "LATCH", value: hex(core.get(REG.LATCH), 16), width: 16 },
      { name: "LATCH_COPY", value: hex(core.get(REG.LATCH_COPY), 16), width: 16 },
      { name: "MEMVAL", value: hex(core.get(REG.MEMVAL), 16), width: 16 },
      { name: "NOFL_PIPE", value: hex(core.get(REG.NOFL_PIPE), 2), width: 2 },
      { name: "MIXS_BANK", value: hex(core.get(REG.MIXS_DSP), 1), width: 1 },
    ],
    "dc.aica.common": [
      { name: "MVOL", value: "0xF", width: 4 },
      { name: "RBP", value: hex(rbpl & 0xfff, 12), width: 12 },
      { name: "RBL", value: hex((rbpl >> 13) & 3, 2), width: 2 },
      { name: "TESTB0", value: hex(rbpl >> 15, 1), width: 1 },
    ],
  };
};

/** The ARM7's view from 0 for 0x808000 bytes: wave memory mirrored by its size, then the register file as a CPU reads it. */
const memoryOf = (core: AicaDspCore): Uint8Array => {
  const memory = new Uint8Array(SNAPSHOT_READ.length);
  for (let mirror = 0; mirror < SNAPSHOT_REGISTER_FILE; mirror += RAM) memory.set(core.ram, mirror);
  for (let offset = 0; offset < 0x8000; offset += 4) {
    const value = core.readReg(offset);
    memory[SNAPSHOT_REGISTER_FILE + offset] = value & 0xff;
    memory[SNAPSHOT_REGISTER_FILE + offset + 1] = (value >> 8) & 0xff;
  }
  return memory;
};

const tick = (stopId: number | undefined, registers: DebuggerTick["registers"], state: "paused" | "running" = "paused", timestamp = 1_760_000_000_123): DebuggerTick =>
  ({
    tickId: 1,
    timestamp,
    executionState: state === "paused" ? { state, stopId, reason: "breakpoint", breakpointId: 1 } : { state },
    registers,
    breakpoints: {},
    eventLog: [],
    watches: [],
    callstacks: { sh4: [], arm7: [] },
    categories: {},
  }) as DebuggerTick;

interface FakeServer {
  client: SnapshotClient;
  reads: unknown[];
  describes: number;
  send(tick: DebuggerTick): void;
}

/**
 * A client whose server answers the read with `memory` and a describe with `behind` (the paused tick it sends behind
 * its response); `duringRead` are ticks that arrive while the read is on its way.
 */
const fakeServer = (memory: Uint8Array, behind: () => DebuggerTick | undefined, options: { duringRead?: DebuggerTick[]; unreadable?: Array<[number, number]> } = {}): FakeServer => {
  const handlers = new Set<(notification: DebuggerNotification) => void>();
  const send = (sent: DebuggerTick) => handlers.forEach((handler) => handler({ topic: "tick", payload: sent }));
  const server: FakeServer = {
    reads: [],
    describes: 0,
    send,
    client: {
      async fetchMemoryBinary(params) {
        server.reads.push(params);
        await Promise.resolve();
        options.duringRead?.forEach(send);
        const data = memory.slice().buffer;
        return { baseAddress: params.address, ...(options.unreadable ? { unreadable: options.unreadable } : {}), data };
      },
      async describe() {
        server.describes++;
        const next = behind();
        // the response first, then the tick
        setTimeout(() => next && send(next), 0);
        return {};
      },
      onNotification(handler) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    },
  };
  return server;
};

const pausedAt = (stopId: number) => () => ({ state: "paused" as const, stopId, reason: "breakpoint" });

/** What a take came to: the message it was refused with, or "a snapshot" (not the snapshot itself, which is 8 MiB). */
const outcome = (taking: Promise<EmulatorSnapshot>): Promise<string> =>
  taking.then(
    () => "a snapshot",
    (error: unknown) => (error instanceof SnapshotError ? "" : "not a SnapshotError: ") + (error instanceof Error ? error.message : String(error)),
  );

/** A snapshot of the core that stands for the emulator, through the protocol half. */
const snapshotOf = async (core: AicaDspCore, stopId = 7): Promise<EmulatorSnapshot> => {
  const server = fakeServer(memoryOf(core), () => tick(stopId, rowsOf(core)));
  return takeEmulatorSnapshot({ client: server.client, execution: pausedAt(stopId), source: "nullDC @ 127.0.0.1:5000" });
};

/** What the two cores have to agree on after every step: the datapath, the arrays, wave memory, and the step's view. */
const state = (core: AicaDspCore) => ({
  step: core.currentStep,
  registers: [REG.MDEC_CT, REG.RBPL, REG.ACC, REG.Y_REG, REG.FRC_REG, REG.ADRS_REG, REG.LATCH, REG.LATCH_COPY, REG.MEMVAL, REG.NOFL_PIPE, REG.MIXS_DSP].map((index) => core.get(index)),
  temp: Array.from(core.temp),
  mems: Array.from(core.mems),
  efreg: Array.from(core.efreg),
  mixs: Array.from(core.mixs.subarray(16 * core.get(REG.MIXS_DSP), 16 * core.get(REG.MIXS_DSP) + 16)),
  exts: Array.from(core.exts),
  ram: fnv(core.ram),
});
/** FNV-1a over the 32 bit words of wave memory. */
const fnv = (bytes: Uint8Array) => {
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2);
  let hash = 2166136261;
  for (let i = 0; i < words.length; i++) hash = Math.imul(hash ^ words[i], 16777619) >>> 0;
  return hash;
};

/** A core of the playground with a state of its own that a load has to replace entirely. */
const playgroundCore = (seed: number): AicaDspCore => {
  const played = emulatorCore(seed, 0x8fff);
  runTo(played, 3, 77);
  played.core.pokeReg(0x45c0, 0x1234);
  return played.core;
};

describe("a snapshot loaded into the core", () => {
  for (const [seed, samples, step] of [
    [1, 2, 1],
    [2, 5, 2],
    [3, 3, 17],
    [4, 1, 64],
    [5, 4, 113],
    [6, 2, 127],
  ] as const) {
    it(`continues the emulator exactly from step ${step} to the end of the sample (program ${seed})`, async () => {
      const emulator = emulatorCore(seed);
      runTo(emulator, samples, step);
      const snapshot = await snapshotOf(emulator.core);
      expect(snapshotExact(snapshot)).toBe(true);
      const playground = playgroundCore(seed + 100);
      applySnapshot(playground, snapshot);
      expect(state(playground)).toEqual(state(emulator.core));
      for (let k = step; k < STEPS; k++) {
        emulator.core.step();
        playground.step();
        expect(state(playground), `behind step ${k}`).toEqual(state(emulator.core));
        expect(Array.from(playground.view), `the view of step ${k}`).toEqual(Array.from(emulator.core.view));
      }
      expect(playground.currentStep).toBe(0);
    });
  }

  it("reads MIXS from the bank MIXS_BANK names: the other bank would give the program other inputs", async () => {
    const emulator = emulatorCore(11);
    runTo(emulator, 2, 1);
    const snapshot = await snapshotOf(emulator.core);
    const bank = emulator.core.get(REG.MIXS_DSP);
    const playground = playgroundCore(12);
    applySnapshot(playground, snapshot);
    expect(playground.get(REG.MIXS_DSP)).toBe(bank);
    expect(playground.get(REG.MIXS_FILL)).toBe(bank ^ 1);
    expect(Array.from(playground.mixs.subarray(16 * bank, 16 * bank + 16))).toEqual(Array.from(emulator.core.mixs.subarray(16 * bank, 16 * bank + 16)));
    // the bank the sound generator fills is nothing a read shows: as after power on
    expect(Array.from(playground.mixs.subarray(16 * (bank ^ 1), 16 * (bank ^ 1) + 16))).toEqual(Array(16).fill(0));
    // and the sends of the bank the DSP reads are not those of the other: a program that reads them sees the difference
    expect(Array.from(emulator.core.mixs.subarray(16 * bank, 16 * bank + 16))).not.toEqual(Array(16).fill(0));
  });

  it("takes RBP, RBL and TESTB0 into RBPL, which a CPU reads as 0: in TESTB0's test mode MDEC_CT is XORed with 0x8080 at the end of the sample", async () => {
    const emulator = emulatorCore(21, 0x0123 | (2 << 13) | 0x8000);
    runTo(emulator, 1, 100);
    expect(emulator.core.readReg(0x2804)).toBe(0);
    const snapshot = await snapshotOf(emulator.core);
    expect(snapshot.rbpl).toBe(0x0123 | (2 << 13) | 0x8000);
    const playground = playgroundCore(22);
    applySnapshot(playground, snapshot);
    expect(playground.peekReg(0x2804)).toBe(0x0123 | (2 << 13) | 0x8000);
    const mdec = playground.get(REG.MDEC_CT);
    while (playground.currentStep !== 0) playground.step();
    expect(playground.get(REG.MDEC_CT)).toBe(mdec ^ 0x8080);
    // without TESTB0 it counts down
    const plain = emulatorCore(21, 0x0123 | (2 << 13));
    runTo(plain, 1, 100);
    const counted = playgroundCore(23);
    applySnapshot(counted, await snapshotOf(plain.core));
    const before = counted.get(REG.MDEC_CT);
    while (counted.currentStep !== 0) counted.step();
    expect(counted.get(REG.MDEC_CT)).toBe((before - 1) & 0xffff);
  });

  it("loads EXTS as 0, whatever the read has there, and starts the sample counter again", async () => {
    const emulator = emulatorCore(31);
    runTo(emulator, 6, 9);
    const playground = playgroundCore(32);
    expect(Array.from(playground.exts)).not.toEqual([0, 0]);
    const snapshot = await snapshotOf(emulator.core);
    // a server whose read has something at EXTS (a CPU reads 0 there)
    snapshot.memory[SNAPSHOT_REGISTER_FILE + 0x45c0] = 0x34;
    snapshot.memory[SNAPSHOT_REGISTER_FILE + 0x45c4] = 0x12;
    applySnapshot(playground, snapshot);
    expect(Array.from(playground.exts)).toEqual([0, 0]);
    expect(playground.sampleCounter).toBe(0);
    expect(Array.from(playground.view)).toEqual(Array(VIEW_WORDS).fill(0));
  });

  it("at step 0 does not continue the emulator into the next sample: step 0 takes the bank the sound generator filled, which no read shows", async () => {
    let differs = 0;
    for (const seed of [41, 42, 43, 44]) {
      const emulator = emulatorCore(seed);
      runTo(emulator, 2, 0);
      // the sweep of the next sample, in front of its step 0
      emulator.sample();
      const snapshot = await snapshotOf(emulator.core);
      expect(snapshotExact(snapshot)).toBe(false);
      const playground = playgroundCore(seed + 100);
      applySnapshot(playground, snapshot);
      expect(state(playground)).toEqual(state(emulator.core));
      for (let k = 0; k < STEPS; k++) {
        emulator.core.step();
        playground.step();
      }
      if (JSON.stringify(state(playground)) !== JSON.stringify(state(emulator.core))) differs++;
    }
    expect(differs).toBeGreaterThan(0);
  });

  it("puts the first 2 MiB of the read into wave memory, and nothing of its mirrors", async () => {
    const emulator = emulatorCore(51);
    runTo(emulator, 1, 5);
    const memory = memoryOf(emulator.core);
    // a mirror that differs (an emulator with more wave memory than the playground) is not read
    memory.fill(0xee, RAM, 2 * RAM);
    const server = fakeServer(memory, () => tick(7, rowsOf(emulator.core)));
    const snapshot = await takeEmulatorSnapshot({ client: server.client, execution: pausedAt(7), source: "x" });
    const playground = playgroundCore(52);
    applySnapshot(playground, snapshot);
    expect(fnv(playground.ram)).toBe(fnv(emulator.core.ram));
  });
});

describe("the source of a snapshot", () => {
  it("is what Load Regs makes of the registers, and assembles to the program the snapshot has", async () => {
    const emulator = emulatorCore(61);
    runTo(emulator, 1, 3);
    const snapshot = await snapshotOf(emulator.core);
    const source = snapshotSource(snapshot);
    expect(source).toBe(dspSourceFromRegisters((offset) => emulator.core.peekReg(offset)));
    expect(source.split("\n").slice(0, 3)).toEqual(["# AICA-DSP", "", "# COEF"]);
    // a playground that loads it as its program, and the snapshot behind it, computes what the emulator computes:
    // what the text leaves out of a step's words is no field of it
    const parsed = assembleSource(source.split("\n"));
    const playground = playgroundCore(62);
    applySnapshot(playground, snapshot);
    for (const { index, encoded } of parsed.MPRO) encoded.forEach((word, k) => playground.writeReg(0x3400 + index * 16 + k * 4, word));
    for (const { index, value } of parsed.COEF) playground.writeReg(0x3000 + index * 4, value);
    for (const { index, value } of parsed.MADRS) playground.writeReg(0x3200 + index * 4, value);
    for (const { index, low, high } of parsed.MEMS) {
      if (low !== undefined) playground.pokeReg(0x4400 + index * 8, low);
      if (high !== undefined) playground.writeReg(0x4400 + index * 8 + 4, high);
    }
    for (let k = 3; k < STEPS; k++) {
      emulator.core.step();
      playground.step();
      expect(state(playground), `behind step ${k}`).toEqual(state(emulator.core));
    }
  });
});

describe("taking a snapshot", () => {
  const core = () => {
    const emulator = emulatorCore(71);
    runTo(emulator, 1, 12);
    return emulator.core;
  };

  it("is one read of the ARM7 from 0 for 0x808000 bytes and the paused tick of the same stop behind it", async () => {
    const emulator = core();
    const server = fakeServer(memoryOf(emulator), () => tick(9, rowsOf(emulator), "paused", 1_760_000_123_456));
    const snapshot = await takeEmulatorSnapshot({ client: server.client, execution: pausedAt(9), source: "nullDC @ 127.0.0.1:5000" });
    expect(server.reads).toEqual([{ target: "arm7", address: 0, length: 0x00808000 }]);
    expect(server.describes).toBe(1);
    expect(snapshot).toMatchObject({ source: "nullDC @ 127.0.0.1:5000", stopId: 9, reason: "breakpoint", timestamp: 1_760_000_123_456 });
    expect(snapshot.dsp.STEP).toBe(12);
    expect(snapshot.dsp.ACC).toBe(emulator.get(REG.ACC) & (2 ** 26 - 1));
    expect(snapshot.dsp.MIXS_BANK).toBe(emulator.get(REG.MIXS_DSP));
    expect(snapshot.memory.byteLength).toBe(0x00808000);
  });

  it("has the rows of the tick behind the read, not of a tick before it", async () => {
    const emulator = core();
    const server = fakeServer(memoryOf(emulator), () => tick(9, rowsOf(emulator), "paused", 2222));
    const execution = pausedAt(9);
    // a paused tick of the stop that the client got before the read: its time is not the snapshot's
    server.send(tick(9, rowsOf(emulator), "paused", 1111));
    const snapshot = await takeEmulatorSnapshot({ client: server.client, execution, source: "x" });
    expect(snapshot.timestamp).toBe(2222);
  });

  it("is not taken while the target runs: there is no read", async () => {
    const emulator = core();
    const server = fakeServer(memoryOf(emulator), () => tick(9, rowsOf(emulator)));
    expect(await outcome(takeEmulatorSnapshot({ client: server.client, execution: () => ({ state: "running" }), source: "x" }))).toBe("the target is running: a snapshot is taken at a stop");
    expect(await outcome(takeEmulatorSnapshot({ client: server.client, execution: () => undefined, source: "x" }))).not.toBe("a snapshot");
    expect(server.reads).toEqual([]);
  });

  it("is not taken when the target runs while the read is on its way: two moments are no snapshot", async () => {
    const emulator = core();
    const running = fakeServer(memoryOf(emulator), () => tick(10, rowsOf(emulator)), { duringRead: [tick(undefined, {}, "running")] });
    expect(await outcome(takeEmulatorSnapshot({ client: running.client, execution: pausedAt(9), source: "x" }))).toBe(
      "the target ran while the snapshot was taken (stop 9 ended): load again at a stop",
    );
    // the tick behind the read is of another stop
    const other = fakeServer(memoryOf(emulator), () => tick(10, rowsOf(emulator)));
    expect(await outcome(takeEmulatorSnapshot({ client: other.client, execution: pausedAt(9), source: "x" }))).toContain("stop 9 ended");
    // or the tick behind the read says the target runs
    const behindRunning = fakeServer(memoryOf(emulator), () => tick(undefined, rowsOf(emulator), "running"));
    expect(await outcome(takeEmulatorSnapshot({ client: behindRunning.client, execution: pausedAt(9), source: "x" }))).toContain("stop 9 ended");
  });

  it("is not taken at a stop without a game", async () => {
    const emulator = core();
    const server = fakeServer(memoryOf(emulator), () => tick(9, rowsOf(emulator)));
    expect(await outcome(takeEmulatorSnapshot({ client: server.client, execution: () => ({ state: "paused", stopId: 9, reason: "no-game" }), source: "x" }))).toContain("no game loaded");
    expect(server.reads).toEqual([]);
  });

  it("needs every row of M3: a server without the datapath rows, or without TESTB0, gives no snapshot", async () => {
    const emulator = core();
    const rows = rowsOf(emulator);
    const withoutDatapath = { ...rows, "dc.aica.dsp": rows["dc.aica.dsp"].filter((register) => ["STEP", "MDEC_CT", "RBP", "RBL"].includes(register.name)) };
    const m2 = fakeServer(memoryOf(emulator), () => tick(9, withoutDatapath));
    expect(await outcome(takeEmulatorSnapshot({ client: m2.client, execution: pausedAt(9), source: "x" }))).toContain("the paused tick has no ACC, Y_REG, FRC_REG, ADRS_REG, LATCH, LATCH_COPY, MEMVAL, NOFL_PIPE, MIXS_BANK in dc.aica.dsp");
    const withoutTestb0 = { ...rows, "dc.aica.common": rows["dc.aica.common"].filter((register) => register.name !== "TESTB0") };
    const noTestb0 = fakeServer(memoryOf(emulator), () => tick(9, withoutTestb0));
    expect(await outcome(takeEmulatorSnapshot({ client: noTestb0.client, execution: pausedAt(9), source: "x" }))).toContain("no TESTB0 in dc.aica.common");
  });

  it("is refused when what it loads was not readable", async () => {
    const emulator = core();
    const wave = fakeServer(memoryOf(emulator), () => tick(9, rowsOf(emulator)), { unreadable: [[0x100000, 16]] });
    expect(await outcome(takeEmulatorSnapshot({ client: wave.client, execution: pausedAt(9), source: "x" }))).toContain("the server could not read 16 bytes at 0x100000 of the ARM7's memory");
    // a mirror of wave memory, or a register of the channels, is not loaded
    const mirror = fakeServer(memoryOf(emulator), () => tick(9, rowsOf(emulator)), { unreadable: [[0x400000, 0x1000], [0x00800000, 0x100]] });
    expect(await outcome(takeEmulatorSnapshot({ client: mirror.client, execution: pausedAt(9), source: "x" }))).toBe("a snapshot");
  });
});

describe("the banner of a snapshot", () => {
  const at = (step: number) => ({ dsp: { STEP: step } as EmulatorSnapshot["dsp"], source: "nullDC @ 127.0.0.1:5000", stopId: 12 });

  it("names where and which stop", () => {
    expect(snapshotNotes(at(5)).title).toBe("Loaded from nullDC @ 127.0.0.1:5000, stop 12");
  });

  it("says that a load behind step 0 is exact to the end of the sample, and that EXTS is loaded as 0", () => {
    for (const step of [1, 64, 127]) {
      const { exact, notes } = snapshotNotes(at(step));
      expect(exact).toBe(true);
      expect(notes[0]).toContain(`At step ${step}, in the DSP phase of a sample: up to the end of that sample (step 127) the playground computes what the emulator computes`);
      expect(notes).toContain("EXTS (the CD-DA input) is no register a CPU reads: it is loaded as 0.");
      expect(notes.join(" ")).not.toContain("not known");
    }
  });

  it("says at step 0 that MIXS of the next sample is not known, and that EXTS is loaded as 0", () => {
    const { exact, notes } = snapshotNotes(at(0));
    expect(exact).toBe(false);
    expect(notes[0]).toContain("At step 0: MIXS of the next sample is not known.");
    expect(notes).toContain("EXTS (the CD-DA input) is no register a CPU reads: it is loaded as 0.");
  });

  it("shows the tick's time on the local clock, to the millisecond", () => {
    const at = new Date(2026, 9, 18, 7, 5, 3, 45).getTime();
    expect(snapshotTime(at)).toBe("07:05:03.045");
  });
});

describe("the button", () => {
  const usable: SnapshotOffInput = {
    inWorkspace: true,
    connected: true,
    initialized: true,
    execution: { state: "paused", reason: "breakpoint" },
    arm7: { label: "ARM7", supported: true },
    memoryBinary: true,
    loading: false,
  };

  it("can be used at a stop of a server that reads memory into a binary frame", () => {
    expect(snapshotOff(usable)).toBeUndefined();
    expect(snapshotOff({ ...usable, execution: { state: "paused", reason: "host-stopped" } })).toBeUndefined();
  });

  it("is off while the target runs, and says why", () => {
    expect(snapshotOff({ ...usable, execution: { state: "running" } })).toBe("the target is running: a snapshot is taken at a stop");
  });

  it("is off on the tool page, which has no connection", () => {
    expect(snapshotOff({ ...usable, inWorkspace: false })).toContain("no emulator connection on its tool page");
    expect(snapshotOff({ ...usable, inWorkspace: false, connected: false })).toContain("no emulator connection on its tool page");
  });

  it("is off without a connection, before the server has described itself, without a game, and while a load is made", () => {
    expect(snapshotOff({ ...usable, connected: false })).toBe("not connected");
    expect(snapshotOff({ ...usable, initialized: false })).toBe("waiting for the server");
    expect(snapshotOff({ ...usable, execution: undefined })).toBe("waiting for the server");
    expect(snapshotOff({ ...usable, execution: { state: "paused", reason: "no-game" } })).toBe("no game loaded");
    expect(snapshotOff({ ...usable, loading: true })).toBe("a snapshot is being loaded");
  });

  it("is off for a server that cannot make the read", () => {
    expect(snapshotOff({ ...usable, memoryBinary: false })).toBe("this server cannot read memory into a binary frame (capability memory-binary)");
    expect(snapshotOff({ ...usable, arm7: { label: "ARM7", supported: false } })).toContain("this server does not support the ARM7 target");
  });
});
