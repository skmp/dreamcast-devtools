// The DSP of the playground: the emulator's AICA DSP core (libswirl/hw/aica/dsp_core), compiled to WebAssembly by
// the emulator's wasm/build.sh and committed in src/wasm/aica-dsp-core/ (NOTICE.md, PROVENANCE.json; regenerated
// by `npm run build:dspsim`). This is one core with the console's 2 MiB of wave RAM, behind the core's own
// interface: steps in order (step 0 starts a sample, step 127 ends it), run() up to breakpoints, the view of the
// last step, the registers by REG.*, the CPU's and a debugger's register accesses, and the arrays of the state.
//
// It runs at the console's scale: MIXS holds a 16 bit sample times 16, so the inputs of a sample are
// `inputsMixs[bus] = sample << 4` and setInputs({ sent }) once a sample; a send is read one sample later. EFREG is
// 16 bit and held from sample to sample. The core's README ("The playground: from the Rust DSP to this core") has
// what changed against the playground's old DSP.
//
// The module is located with new URL(..., import.meta.url), which Vite turns into an asset of the build and which
// every TypeScript project that includes this file (the app's, tsconfig.server.json, tsconfig.scripts.json through
// src/app/dsp/dspUtils.ts) type-checks as it is: no Vite suffix import, no vite/client types.
import { loadAicaDsp, MEM_OP, REG, VIEW, VIEW_WORDS } from "../wasm/aica-dsp-core/aica_dsp_core.mjs";
import type {
  AicaDspCore,
  AicaDspInputs,
  AicaDspModule,
  AicaDspReg,
  AicaDspSource,
} from "../wasm/aica-dsp-core/aica_dsp_core.mjs";

export { MEM_OP, REG, VIEW, VIEW_WORDS };
export type { AicaDspCore, AicaDspInputs, AicaDspModule, AicaDspReg, AicaDspSource };

/** The wave RAM of the playground's core: the console's 2 MiB. */
export const AICA_DSP_RAM_BYTES = 2 << 20;

/** Steps of a sample. */
export const AICA_DSP_STEPS = 128;

class AicaDsp {
  private module: AicaDspModule | null = null;
  private dsp: AicaDspCore | null = null;
  private loading: Promise<void> | null = null;

  /**
   * Loads the module and makes the core, once; later calls wait for the first. source: the module (its bytes, a
   * URL, ...; see loadAicaDsp), by default the committed aica_dsp_core.wasm.
   */
  initialize(source?: AicaDspSource): Promise<void> {
    if (!this.loading) {
      this.loading = (async () => {
        const module = await loadAicaDsp(source ?? new URL("../wasm/aica-dsp-core/aica_dsp_core.wasm", import.meta.url));
        this.module = module;
        this.dsp = module.create(AICA_DSP_RAM_BYTES);
      })().catch((error: unknown) => {
        this.loading = null;
        console.error("Failed to initialize the AICA DSP module:", error);
        throw error;
      });
    }
    return this.loading;
  }

  isInitialized(): boolean {
    return this.dsp !== null;
  }

  private get core(): AicaDspCore {
    if (!this.dsp) {
      throw new Error("AICA DSP WASM module not initialized");
    }
    return this.dsp;
  }

  /** The instantiated module: decode / encode of a step, the float format. */
  get wasm(): AicaDspModule {
    if (!this.module) {
      throw new Error("AICA DSP WASM module not initialized");
    }
    return this.module;
  }

  /** The state after power on (the program included); the wave RAM and the inputs stay. */
  reset(): void {
    this.core.reset();
  }

  /** As the CPU reads and writes the AICA's register area: 0x2804 and EXTS read 0, the low byte of MEMS and EXTS are not written. */
  readReg(off: number): number {
    return this.core.readReg(off);
  }

  writeReg(off: number, value: number): void {
    this.core.writeReg(off, value);
  }

  /** As a debugger reads and writes them: RBP / RBL at 0x2804 and EXTS read, the low byte of MEMS and EXTS written. */
  peekReg(off: number): number {
    return this.core.peekReg(off);
  }

  pokeReg(off: number, value: number): void {
    this.core.pokeReg(off, value);
  }

  /** Executes the step currentStep names; the view has what it computed. */
  step(): void {
    this.core.step();
  }

  /**
   * Steps until `count` are done or the step that comes next has a non-zero byte in `stops` (128 bytes): a
   * breakpoint. The step it starts at is executed whatever its byte is. Returns how many were executed; the view is
   * the last one's.
   */
  run(count: number, stops?: ArrayLike<number> | null): number {
    return this.core.run(count, stops);
  }

  /** The rest of the sample, fast; it leaves the view as it was. */
  runSample(): void {
    this.core.runSample();
  }

  /** A register that is no array (REG.*); set is a debugger's write, cut to the bits the register has. */
  get(index: AicaDspReg): number {
    return this.core.get(index);
  }

  set(index: AicaDspReg, value: number): void {
    this.core.set(index, value);
  }

  /** The step that is executed next, 0 to 127. */
  get currentStep(): number {
    return this.core.currentStep;
  }

  /** Samples completed since the reset (REG.SAMPLES). */
  get sampleCounter(): number {
    return this.core.sampleCounter;
  }

  /** The inputs of the samples from here on (inputsMixs, inputsFetchWords): sent, a bit per bus with a sum. */
  setInputs(inputs?: AicaDspInputs): void {
    this.core.setInputs(inputs);
  }

  sweepBegin(): void {
    this.core.sweepBegin();
  }

  mixsSend(bus: number, value: number): void {
    this.core.mixsSend(bus, value);
  }

  mixsSendLate(bus: number, value: number): void {
    this.core.mixsSendLate(bus, value);
  }

  channelFetch(word: number): void {
    this.core.channelFetch(word);
  }

  busRead(word: number): void {
    this.core.busRead(word);
  }

  /** VIEW_WORDS words (VIEW.*): what the last step() or run() computed. */
  get view(): Int32Array {
    return this.core.view;
  }

  /** The wave RAM, AICA_DSP_RAM_BYTES. */
  get ram(): Uint8Array {
    return this.core.ram;
  }

  get coef(): Uint16Array {
    return this.core.coef;
  }

  get madrs(): Uint16Array {
    return this.core.madrs;
  }

  get mpro(): Uint16Array {
    return this.core.mpro;
  }

  /** 128 words, 24 bit sign extended. */
  get temp(): Int32Array {
    return this.core.temp;
  }

  /** 32 words, 24 bit sign extended. */
  get mems(): Int32Array {
    return this.core.mems;
  }

  /** Both banks, 20 bit sign extended: bus i of bank b at 16 * b + i; REG.MIXS_DSP is the DSP's bank. */
  get mixs(): Int32Array {
    return this.core.mixs;
  }

  /** 16 outputs, signed 16 bit. */
  get efreg(): Int16Array {
    return this.core.efreg;
  }

  /** The CD-DA input, signed 16 bit. */
  get exts(): Int16Array {
    return this.core.exts;
  }

  /** The sums of a sample's sends, one per bus: sample << 4 for a 16 bit sample. */
  get inputsMixs(): Int32Array {
    return this.core.inputsMixs;
  }

  get inputsFetchWords(): Uint16Array {
    return this.core.inputsFetchWords;
  }

  saveState(): Uint8Array {
    return this.core.saveState();
  }

  loadState(blob: Uint8Array): boolean {
    return this.core.loadState(blob);
  }
}

// Export singleton instance
export const aicaDsp = new AicaDsp();
