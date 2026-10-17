import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { AICA_DSP_RAM_BYTES, AICA_DSP_STEPS, aicaDsp, REG, VIEW, VIEW_WORDS } from "./aicaDsp";

// aicaDsp, the playground's DSP: one core of the emulator's DSP with 2 MiB of wave RAM, behind the core's
// interface. Loaded here from the committed module's bytes (node's fetch takes no file: URL).

const WASM = join(dirname(fileURLToPath(import.meta.url)), "..", "wasm", "aica-dsp-core", "aica_dsp_core.wasm");

const MPRO = 0x3400;
const COEF = 0x3000;

/** A program: its COEF words and its steps as the four MPRO words of each. */
const load = (coef: Record<number, number>, steps: Record<number, number[]>) => {
  aicaDsp.reset();
  for (const [index, value] of Object.entries(coef)) {
    aicaDsp.writeReg(COEF + 4 * Number(index), value);
  }
  for (const [step, words] of Object.entries(steps)) {
    words.forEach((word, k) => aicaDsp.writeReg(MPRO + 16 * Number(step) + 4 * k, word));
  }
};

// MPRO[0] = XSEL:1 YSEL:1 IRA:32 ZERO:1 (ACC = MIXS[0] << 4 times COEF[0]), MPRO[1] = EWT:1 EWA:0 (EFREG[0] = SHIFTED[23:8])
const COPY_IN0_TO_OUT0 = { 0: [0x0000, 0xb000, 0x0002, 0x0000], 1: [0x0000, 0x0000, 0x1000, 0x0000] };

describe("aicaDsp, the playground's DSP core", () => {
  beforeAll(async () => {
    await aicaDsp.initialize(readFileSync(WASM));
  });

  it("is one core with the console's 2 MiB of wave RAM, and initialize() makes it once", async () => {
    expect(aicaDsp.isInitialized()).toBe(true);
    expect(AICA_DSP_RAM_BYTES).toBe(2 << 20);
    expect(aicaDsp.ram.length).toBe(2 << 20);
    aicaDsp.ram[0x1ffffe] = 0x5a;
    await aicaDsp.initialize(readFileSync(WASM));
    expect(aicaDsp.ram[0x1ffffe]).toBe(0x5a);
    aicaDsp.ram[0x1ffffe] = 0;
  });

  it("has the core's registers by index, MIXS_DSP, MIXS_FILL and RBPL among them, and its views", () => {
    expect(REG).toMatchObject({ STEP: 0, SAMPLES: 1, MDEC_CT: 2, RBPL: 3, LATCH: 8, LATCH_COPY: 9, MEMVAL: 10, MIXS_DSP: 12, MIXS_FILL: 13 });
    expect(VIEW_WORDS).toBe(20);
    expect(aicaDsp.view.length).toBe(VIEW_WORDS);
    expect(aicaDsp.temp.length).toBe(128);
    expect(aicaDsp.mems.length).toBe(32);
    expect(aicaDsp.mixs.length).toBe(32);
    expect(aicaDsp.efreg.length).toBe(16);
    aicaDsp.reset();
    // the two banks: the sound generator fills the one the DSP does not read
    expect(aicaDsp.get(REG.MIXS_FILL)).toBe(1 - aicaDsp.get(REG.MIXS_DSP));
    aicaDsp.set(REG.MIXS_DSP, 1);
    aicaDsp.set(REG.MIXS_FILL, 0);
    aicaDsp.mixs[16 + 3] = -5;
    expect(aicaDsp.readReg(0x4500 + 8 * 3 + 0)).toBe(0xb); // bits 3:0 of -5 in the DSP's bank
    aicaDsp.reset();
  });

  it("reads and writes as the CPU does, and peeks and pokes as a debugger does", () => {
    aicaDsp.reset();
    // 0x2804 (RBP, RBL) and EXTS read 0 for the CPU
    aicaDsp.writeReg(0x2804, 0x2345);
    expect(aicaDsp.readReg(0x2804)).toBe(0);
    expect(aicaDsp.peekReg(0x2804)).toBe(0x2345);
    expect(aicaDsp.get(REG.RBPL)).toBe(0x2345);
    // the low byte of MEMS and EXTS are not the CPU's to write
    aicaDsp.writeReg(0x4400, 0x12);
    aicaDsp.writeReg(0x45c0, 0x1234);
    expect(aicaDsp.mems[0]).toBe(0);
    expect(aicaDsp.peekReg(0x45c0)).toBe(0);
    aicaDsp.pokeReg(0x4400, 0x12);
    aicaDsp.pokeReg(0x45c0, 0x1234);
    expect(aicaDsp.mems[0]).toBe(0x12);
    expect(aicaDsp.exts[0]).toBe(0x1234);
    expect(aicaDsp.readReg(0x45c0)).toBe(0);
    // COEF keeps bits 15:3
    aicaDsp.writeReg(COEF, 0xffff);
    expect(aicaDsp.readReg(COEF)).toBe(0xfff8);
    // reset() is power on: the program and the registers go, MDEC_CT is 1
    aicaDsp.reset();
    expect(aicaDsp.readReg(COEF)).toBe(0);
    expect(aicaDsp.get(REG.RBPL)).toBe(0);
    expect(aicaDsp.get(REG.MDEC_CT)).toBe(1);
  });

  it("steps in order: step 0 starts a sample, step 127 ends it, and the view is the last step's", () => {
    load({}, {});
    expect(aicaDsp.currentStep).toBe(0);
    aicaDsp.step();
    expect(aicaDsp.currentStep).toBe(1);
    expect(aicaDsp.view[VIEW.step]).toBe(0);
    expect(aicaDsp.run(AICA_DSP_STEPS)).toBe(AICA_DSP_STEPS);
    expect(aicaDsp.currentStep).toBe(1);
    expect(aicaDsp.view[VIEW.step]).toBe(0);
    expect(aicaDsp.sampleCounter).toBe(1);
    aicaDsp.set(REG.STEP, 0);
    aicaDsp.set(REG.SAMPLES, 0);
    aicaDsp.runSample();
    expect(aicaDsp.currentStep).toBe(0);
    expect(aicaDsp.sampleCounter).toBe(1);
    // MDEC_CT is a 16 bit counter that counts down once a sample, from 1 at power on, through 0
    expect(aicaDsp.get(REG.MDEC_CT)).toBe(0xffff);
  });

  it("runs up to a breakpoint: the step the run starts at is executed whatever its breakpoint, the next one stops it", () => {
    load({}, {});
    const stops = new Uint8Array(AICA_DSP_STEPS);
    stops[0] = 1;
    stops[1] = 1;
    expect(aicaDsp.run(AICA_DSP_STEPS, stops)).toBe(1);
    expect(aicaDsp.currentStep).toBe(1);
    expect(aicaDsp.run(AICA_DSP_STEPS - 1, stops)).toBe(AICA_DSP_STEPS - 1);
    expect(aicaDsp.currentStep).toBe(0);
    expect(aicaDsp.sampleCounter).toBe(1);
  });

  it("is at the console's scale: an input sent as sample << 4 comes out of EFREG as the sample, one sample later", () => {
    // COEF[0] = 0x7FF8: Y = 4095, X = INPUTS = MIXS << 4, ACC = floor(X * Y / 4096), EFREG = SHIFTED[23:8]
    const efregOf = (mixs: number) => Math.floor(Math.floor(((mixs * 16) * 4095) / 4096) / 256);
    load({ 0: 0x7ff8 }, COPY_IN0_TO_OUT0);
    const output = (sample: number, scale: number) => {
      aicaDsp.inputsMixs[0] = sample * scale;
      aicaDsp.setInputs({ sent: 1 });
      // the sample whose step 0 sends it, then the one that reads it
      aicaDsp.run(AICA_DSP_STEPS);
      const before = aicaDsp.efreg[0];
      aicaDsp.run(AICA_DSP_STEPS);
      return { before, after: aicaDsp.efreg[0] };
    };
    const full = output(10000, 1 << 4);
    expect(full.before).toBe(0);
    expect(full.after).toBe(efregOf(10000 << 4));
    expect(full.after).toBe(9997);
    expect(output(-20000, 1 << 4).after).toBe(-19996);
    // the old playground's scale: 16 times quieter
    expect(output(10000, 1).after).toBe(624);
    // EFREG is held from sample to sample
    aicaDsp.setInputs({ sent: 0 });
    load({ 0: 0x7ff8 }, {});
    aicaDsp.efreg[0] = 1234;
    aicaDsp.run(AICA_DSP_STEPS);
    expect(aicaDsp.efreg[0]).toBe(1234);
  });
});
