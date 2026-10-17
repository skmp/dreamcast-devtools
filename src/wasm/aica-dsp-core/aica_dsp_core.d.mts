/*
	The declarations of aica_dsp_core.mjs, the loader of the emulator's AICA DSP core (aica_dsp_core.wasm), written
	by hand: the loader is the emulator's (libswirl/hw/aica/dsp_core/wasm/aica_dsp_core.mjs), copied here verbatim
	by `npm run build:dspsim`, and it has no declarations of its own. What each call does is in the loader's
	comments and in the core's aica_dsp_core.h and README.md; NOTICE.md says where the files come from.

	AicaDspCore and AicaDspModule are the loader's classes AicaDsp and AicaDspModule, which it does not export: they
	are types here, made by loadAicaDsp() and AicaDspModule.create(), never constructed.
*/

/** The version of the C interface this loader is written for; loadAicaDsp() refuses a module of another. */
export declare const AICA_DSP_API_VERSION: 1;

/** The indices of AicaDspCore.get() and set(): the registers that are no arrays. */
export declare const REG: Readonly<{
  /** the step that is executed next, 0 to 127 */
  STEP: 0;
  /** samples completed since the reset */
  SAMPLES: 1;
  /** 16 bit, counts down once a sample */
  MDEC_CT: 2;
  /** register 0x2804 as it was written: RBP 11:0, RBL 14:13, bit 15 the test mode of MDEC_CT */
  RBPL: 3;
  /** 26 bit, signed */
  ACC: 4;
  /** 24 bit, signed */
  Y_REG: 5;
  /** 13 bit */
  FRC_REG: 6;
  /** 12 bit */
  ADRS_REG: 7;
  /** the wave RAM read latch */
  LATCH: 8;
  /** its copy at the end of the last odd step */
  LATCH_COPY: 9;
  /** what IWT stores */
  MEMVAL: 10;
  /** bit 0: NOFL of the last step, bit 1: of the one before */
  NOFL_PIPE: 11;
  /** the MIXS bank the DSP and the CPU have */
  MIXS_DSP: 12;
  /** the MIXS bank the sound generator fills */
  MIXS_FILL: 13;
}>;

export type AicaDspReg = (typeof REG)[keyof typeof REG];

/** The words of AicaDspCore.view: what the last step() or run() computed (runSample() leaves it). */
export declare const VIEW: Readonly<{
  /** the step that was executed */
  step: 0;
  /** as the step used it */
  MDEC_CT: 1;
  /** 24 bit */
  INPUTS: 2;
  /** 24 bit, from the ACC the step before left */
  SHIFTED: 3;
  /** 24 bit */
  X: 4;
  /** 13 bit */
  Y: 5;
  /** 26 bit */
  B: 6;
  /** 26 bit, what the step leaves */
  ACC: 7;
  FRC_REG: 8;
  Y_REG: 9;
  ADRS_REG: 10;
  /** what an IWT of this step stores, before its conversion */
  memval: 11;
  /** 1: that conversion is << 8, 0: it is the float format's */
  memval_nofl: 12;
  /** the read latch after the step */
  latch: 13;
  /** its copy, taken at the end of the last odd step */
  latch_copy: 14;
  /** MEM_OP */
  mem_op: 15;
  /** byte address in the wave RAM, when mem_op is not NONE */
  mem_addr: 16;
  /** the word that was read or written */
  mem_data: 17;
  /** 1: a channel had the wave RAM slot of this step */
  slot_taken: 18;
  /** the MIXS bank the DSP reads in this sample */
  mixs_bank: 19;
}>;

export declare const VIEW_WORDS: 20;

/** view[VIEW.mem_op] */
export declare const MEM_OP: Readonly<{ NONE: 0; READ: 1; WRITE: 2; WRITE_NO_READ: 3; LOST: 4 }>;

export type AicaDspFieldName =
  | "TRA" | "TWT" | "TWA" | "XSEL" | "YSEL" | "IRA" | "IWT" | "IWA" | "TABLE" | "MWT" | "MRD" | "EWT" | "EWA"
  | "ADRL" | "FRCL" | "SHIFT" | "YRL" | "NEGB" | "ZERO" | "BSEL" | "NOFL" | "MASA" | "ADREB" | "NXADR";

/** The fields of a step in the order decode() and encode() have them. */
export declare const FIELDS: readonly AicaDspFieldName[];

export type AicaDspFields = Record<AicaDspFieldName, number>;

export interface AicaDspInputs {
  /** false: the steps run without inputs, every event is a call (sweepBegin, mixsSend, channelFetch, busRead) */
  on?: boolean;
  /** a bit per bus that inputsMixs has a sum for */
  sent?: number;
  /** a bit per channel that fetches and leaves inputsFetchWords[channel]: a BigInt, or its two 32 bit halves */
  fetch?: bigint | number | readonly [number, number];
}

/**
 * One core with its wave RAM (the loader's class AicaDsp). The arrays are views of the module's memory: reads and
 * writes go straight to the core. They are made anew when the memory grows, so take them from the object when they
 * are used.
 */
export interface AicaDspCore {
  readonly ramSize: number;

  /** Gives the core's memory back; the object and its arrays are not to be used after it. */
  destroy(): void;
  /** The state after power on; the wave RAM and the inputs stay. */
  reset(): void;

  /** As the CPU reads and writes: offsets from the start of the AICA's register area. */
  readReg(off: number): number;
  writeReg(off: number, value: number): void;

  /** As a debugger does: what the hardware has, also where its CPU reads 0 (0x2804, EXTS) or cannot write (the low byte of MEMS, EXTS). */
  peekReg(off: number): number;
  pokeReg(off: number, value: number): void;

  /** One step, the one currentStep names: step 0 starts a sample, step 127 ends it. */
  step(): void;
  /** The steps up to the end of the sample, without updating the view. */
  runSample(): void;
  /**
   * Steps until `count` are done or the step that comes next is a breakpoint: stops is null or 128 bytes, non zero
   * where a step is one. The step it starts at is executed whatever its byte is. Returns the number of steps executed.
   */
  run(count: number, stops?: ArrayLike<number> | null): number;

  /** A register that is no array, REG.*; set is a debugger's write. */
  get(index: AicaDspReg): number;
  set(index: AicaDspReg, value: number): void;
  readonly currentStep: number;
  readonly sampleCounter: number;

  /** The inputs of the samples from here on: they stay until they are changed. */
  setInputs(inputs?: AicaDspInputs): void;
  sweepBegin(): void;
  mixsSend(bus: number, value: number): void;
  mixsSendLate(bus: number, value: number): void;
  channelFetch(word: number): void;
  busRead(word: number): void;

  /** the wave RAM, ramSize bytes */
  readonly ram: Uint8Array;
  /** 128, bits 15:3 */
  readonly coef: Uint16Array;
  /** 64 */
  readonly madrs: Uint16Array;
  /** 128 x 4 */
  readonly mpro: Uint16Array;
  /** 128, sign extended 24 bit */
  readonly temp: Int32Array;
  /** 32, sign extended 24 bit */
  readonly mems: Int32Array;
  /** 2 banks x 16, sign extended 20 bit: bank b, bus i at 16 b + i */
  readonly mixs: Int32Array;
  /** 16 */
  readonly efreg: Int16Array;
  /** 2: the CD-DA input */
  readonly exts: Int16Array;
  /** VIEW_WORDS words, VIEW.* */
  readonly view: Int32Array;
  /** the sums of the sends of a sample, 16, sign extended 20 bit: sample << 4 for a 16 bit sample */
  readonly inputsMixs: Int32Array;
  /** 64 */
  readonly inputsFetchWords: Uint16Array;

  /** The state as bytes, without the wave RAM, and back; loadState is false for bytes that are no state. */
  saveState(): Uint8Array;
  loadState(blob: Uint8Array): boolean;
}

/** The instantiated module (the loader's class AicaDspModule). */
export interface AicaDspModule {
  readonly exports: WebAssembly.Exports;
  readonly memory: WebAssembly.Memory;

  /** A core after power on. ramSize: bytes of wave RAM, a power of two (the hardware has 2 MB or 8 MB), or 0. */
  create(ramSize?: number): AicaDspCore;

  /** The fields of a step, from its four MPRO words, and back. */
  decode(words: ArrayLike<number>): AicaDspFields;
  encode(fields: Partial<AicaDspFields>): number[];

  /** The 16 bit float format of the wave RAM. */
  pack(value24: number): number;
  unpack(word: number): number;
}

/**
 * Where the module is: nothing (aica_dsp_core.wasm next to the loader, fetched), a URL or a string (fetched), a
 * Response or a promise of one, the bytes of the file, or a WebAssembly.Module.
 */
export type AicaDspSource =
  | string
  | URL
  | Response
  | PromiseLike<Response>
  | BufferSource
  | WebAssembly.Module;

export declare function loadAicaDsp(source?: AicaDspSource): Promise<AicaDspModule>;
