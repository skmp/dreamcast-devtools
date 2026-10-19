import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { aicaDsp } from "../../lib/aicaDsp";
import { assembleSource, writeRegisters } from "./dspUtils";

// writeRegisters puts an assembled program into the playground's core: COEF, MADRS, MPRO and MEMS_H as the CPU
// writes them, MEMS_L (bits 7:0 of a MEMS word, which the CPU cannot write) as a debugger does.

const WASM = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "wasm", "aica-dsp-core", "aica_dsp_core.wasm");

describe("writeRegisters", () => {
  beforeAll(async () => {
    await aicaDsp.initialize(readFileSync(WASM));
  });

  it("writes the MEMS_L and MEMS_H lines into MEMS, both bytes of the low part included", () => {
    aicaDsp.reset();
    writeRegisters(aicaDsp, assembleSource(["MEMS_L[3] = 0x5A", "MEMS_H[3] = 0x1234", "MEMS_L[31] = 0xFF", "MEMS_H[31] = 0xFFFF"]));
    expect(aicaDsp.mems[3]).toBe(0x12345a);
    expect(aicaDsp.readReg(0x4400 + 3 * 8)).toBe(0x5a);
    expect(aicaDsp.readReg(0x4400 + 3 * 8 + 4)).toBe(0x1234);
    // 24 bit, sign extended
    expect(aicaDsp.mems[31]).toBe(-1);
  });

  it("clears every MEMS word, its low byte too, before the program's lines", () => {
    aicaDsp.reset();
    for (let i = 0; i < 32; i++) {
      aicaDsp.pokeReg(0x4400 + i * 8, 0xa5);
      aicaDsp.writeReg(0x4400 + i * 8 + 4, 0x5aa5);
    }
    writeRegisters(aicaDsp, assembleSource(["MEMS_L[1] = 7"]));
    expect(Array.from(aicaDsp.mems)).toEqual(Array.from({ length: 32 }, (_, i) => (i === 1 ? 7 : 0)));
  });

  it("writes COEF, MADRS and MPRO as the CPU does, and clears the rest of them", () => {
    aicaDsp.reset();
    aicaDsp.writeReg(0x3000 + 4 * 5, 0x1230);
    writeRegisters(
      aicaDsp,
      assembleSource(["COEF[0] = 0x7FFF", "MADRS[2] = 0x1950", "MPRO[1] = XSEL:1 YSEL:1 IRA:32 ZERO:1", "MPRO[127] = EWT:1 EWA:3"]),
    );
    // COEF keeps bits 15:3
    expect(aicaDsp.coef[0]).toBe(0x7ff8);
    expect(aicaDsp.coef[5]).toBe(0);
    expect(aicaDsp.madrs[2]).toBe(0x1950);
    expect(Array.from(aicaDsp.mpro.subarray(4, 8))).toEqual([0x0000, 0xb000, 0x0002, 0x0000]);
    expect(Array.from(aicaDsp.mpro.subarray(127 * 4, 128 * 4))).toEqual([0x0000, 0x0000, 0x1300, 0x0000]);
  });
});
