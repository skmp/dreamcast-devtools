import { decodeInst, disassembleDesc } from "../../src/app/dsp/dspUtils";
import { elfBytes } from "./elfSymbols";
import type { ElfSymbols } from "./elfSymbols";

/**
 * What the contract holds of a line of `state.getDisassembly {dsp}` (design 3.3): `bytes` are
 * the step's four MPRO words in register order, each word high byte first, and the text is the
 * line of the DSP playground's assembler for them, with the playground's own functions
 * (src/app/dsp/dspUtils.ts, which the emulator's debugger.disasm.dsp_playground holds its
 * disassembler to as well).
 */

/** The four MPRO words of a line's `bytes` ("01 23 45 67 89 AB CD EF": 0x0123 0x4567 0x89AB 0xCDEF); undefined unless it is 8 pairs. */
export const dspWordsOf = (bytes: string): number[] | undefined => {
  if (!/^[0-9A-F]{2}( [0-9A-F]{2}){7}$/.test(bytes)) {
    return undefined;
  }
  const pairs = bytes.split(" ").map((pair) => Number.parseInt(pair, 16));
  return [0, 1, 2, 3].map((word) => (pairs[word * 2] << 8) | pairs[word * 2 + 1]);
};

/** The `bytes` of a step whose MPRO words are `words`. */
export const dspBytesOf = (words: readonly number[]): string =>
  words.map((word) => `${((word >> 8) & 0xff).toString(16).toUpperCase().padStart(2, "0")} ${(word & 0xff).toString(16).toUpperCase().padStart(2, "0")}`).join(" ");

/** The text of the line of step `step`: "MPRO[" + step + "] = " and the playground's disassembly of its words, "TRA:0" for an empty step. */
export const dspLineText = (step: number, words: readonly number[]): string => `MPRO[${step}] = ${disassembleDesc(decodeInst([...words])) || "TRA:0"}`;

/** What is wrong with a DSP line by the text rule, or undefined. */
export const dspLineProblem = (line: { address: number; bytes: string; disassembly: string }): string | undefined => {
  const words = dspWordsOf(line.bytes);
  if (!words) {
    return `dsp: the bytes of step ${line.address} are "${line.bytes}", not its four MPRO words as 8 pairs`;
  }
  const text = dspLineText(line.address, words);
  return line.disassembly === text ? undefined : `dsp: step ${line.address} reads "${line.disassembly}"; the playground's line of its bytes ${line.bytes} is "${text}" (design 3.3)`;
};

/** The symbols of the sounding guest around its DSP program (the M3 round's 2.4). */
export const DSP_PROGRAM_SYMBOLS = { start: "g_dsp_mpro", end: "g_dsp_mpro_end" } as const;

/**
 * The `bytes` of the 128 steps as the ELF loads its DSP program: between g_dsp_mpro and
 * g_dsp_mpro_end one 32-bit little-endian word for each 16-bit word of MPRO (the word in the low
 * half), four for each step from step 0; the steps behind the block are empty. Undefined, with
 * why, when the ELF does not have the block.
 */
export const dspProgramOfElf = (elf: ElfSymbols, steps = 128): { bytes: string[] } | { missing: string } => {
  const start = elf.symbols.get(DSP_PROGRAM_SYMBOLS.start) ?? elf.symbols.get(`_${DSP_PROGRAM_SYMBOLS.start}`);
  const end = elf.symbols.get(DSP_PROGRAM_SYMBOLS.end) ?? elf.symbols.get(`_${DSP_PROGRAM_SYMBOLS.end}`);
  if (start === undefined || end === undefined) {
    return { missing: `the ELF has no symbols ${DSP_PROGRAM_SYMBOLS.start} and ${DSP_PROGRAM_SYMBOLS.end}` };
  }
  const length = end - start;
  if (length < 0 || length % 16 !== 0 || length > steps * 16) {
    return { missing: `${DSP_PROGRAM_SYMBOLS.start} to ${DSP_PROGRAM_SYMBOLS.end} is ${length} bytes, not four words of 32 bits for each of at most ${steps} steps` };
  }
  const block = elfBytes(elf, start, length);
  if (!block) {
    return { missing: `the ELF loads nothing at ${DSP_PROGRAM_SYMBOLS.start} (0x${start.toString(16).toUpperCase()}) to ${DSP_PROGRAM_SYMBOLS.end}` };
  }
  const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
  return {
    bytes: Array.from({ length: steps }, (_, step) =>
      dspBytesOf([0, 1, 2, 3].map((word) => (step * 16 + word * 4 < length ? view.getUint32(step * 16 + word * 4, true) & 0xffff : 0))),
    ),
  };
};
