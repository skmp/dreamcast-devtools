import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { elfBytes, parseElfSymbols, readElfSymbols, resolveAddress } from "./elfSymbols";

/** A minimal little-endian ELF32 file: header, .strtab, .symtab and three section headers. */
const buildElf = (entry: number, symbols: Array<{ name: string; value: number; type: number; section: number }>): Uint8Array => {
  const names = ["", ...symbols.map((symbol) => symbol.name)];
  const strtab = new TextEncoder().encode(`${names.join("\0")}\0`);
  const nameOffsets = new Map<string, number>();
  let cursor = 1;
  for (const symbol of symbols) {
    nameOffsets.set(symbol.name, cursor);
    cursor += symbol.name.length + 1;
  }
  const symtab = new Uint8Array((symbols.length + 1) * 16);
  const symView = new DataView(symtab.buffer);
  symbols.forEach((symbol, index) => {
    const base = (index + 1) * 16;
    symView.setUint32(base, nameOffsets.get(symbol.name)!, true);
    symView.setUint32(base + 4, symbol.value, true);
    symtab[base + 12] = (1 << 4) | symbol.type; // STB_GLOBAL
    symView.setUint16(base + 14, symbol.section, true);
  });

  const strtabOffset = 52;
  const symtabOffset = strtabOffset + strtab.length;
  const sectionOffset = symtabOffset + symtab.length;
  const image = new Uint8Array(sectionOffset + 3 * 40);
  const view = new DataView(image.buffer);
  image.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1], 0); // ELF, 32-bit, little-endian
  view.setUint16(16, 2, true); // ET_EXEC
  view.setUint16(18, 42, true); // EM_SH
  view.setUint32(24, entry, true);
  view.setUint32(32, sectionOffset, true);
  view.setUint16(46, 40, true);
  view.setUint16(48, 3, true);
  image.set(strtab, strtabOffset);
  image.set(symtab, symtabOffset);
  const section = (index: number, type: number, offset: number, size: number, link: number, entrySize: number) => {
    const base = sectionOffset + index * 40;
    view.setUint32(base + 4, type, true);
    view.setUint32(base + 16, offset, true);
    view.setUint32(base + 20, size, true);
    view.setUint32(base + 24, link, true);
    view.setUint32(base + 36, entrySize, true);
  };
  section(1, 3, strtabOffset, strtab.length, 0, 0); // SHT_STRTAB
  section(2, 2, symtabOffset, symtab.length, 1, 16); // SHT_SYMTAB, linked to section 1
  return image;
};

describe("ELF32 symbol table reader", () => {
  const image = buildElf(0x8c010000, [
    { name: "_start", value: 0x8c010000, type: 2, section: 1 },
    { name: "_snd_init", value: 0x8c012344, type: 2, section: 1 },
    { name: "_sound_state", value: 0x8c0a0000, type: 1, section: 2 },
    { name: "local_label", value: 0x8c010010, type: 0, section: 1 },
    { name: "_undefined", value: 0, type: 2, section: 0 },
    { name: "a_section", value: 0x8c010000, type: 3, section: 1 },
    { name: "_start", value: 0xdeadbeef, type: 2, section: 1 },
  ]);

  it("reads the entry point and the defined function, object and label symbols", () => {
    const elf = parseElfSymbols(image);
    expect(elf.entry).toBe(0x8c010000);
    expect(Object.fromEntries(elf.symbols)).toEqual({
      _start: 0x8c010000,
      _snd_init: 0x8c012344,
      _sound_state: 0x8c0a0000,
      local_label: 0x8c010010,
    });
  });

  it("resolves numbers and symbol names, with or without the leading underscore of C symbols", () => {
    const elf = parseElfSymbols(image);
    expect(resolveAddress("0x8C010000", undefined)).toBe(0x8c010000);
    expect(resolveAddress("2348875776", undefined)).toBe(0x8c010000);
    expect(resolveAddress("_snd_init", elf)).toBe(0x8c012344);
    expect(resolveAddress("snd_init", elf)).toBe(0x8c012344);
    expect(() => resolveAddress("snd_init", undefined)).toThrow("pass --elf");
    expect(() => resolveAddress("no_such_symbol", elf)).toThrow('the ELF file has no symbol "no_such_symbol"');
    expect(() => resolveAddress("0x100000000", undefined)).toThrow("not a 32-bit address");
  });

  it("refuses what is not an ELF32 file", () => {
    expect(() => parseElfSymbols(new Uint8Array(64))).toThrow("no ELF magic");
    const wide = image.slice();
    wide[4] = 2;
    expect(() => parseElfSymbols(wide)).toThrow("not a 32-bit file");
    const truncated = image.slice(0, image.length - 60);
    expect(() => parseElfSymbols(truncated)).toThrow("section headers outside of the file");
  });

  it("accepts a file without section headers", () => {
    const stripped = image.slice(0, 52);
    new DataView(stripped.buffer).setUint32(32, 0, true);
    expect(parseElfSymbols(stripped)).toEqual({ entry: 0x8c010000, symbols: new Map(), segments: [] });
  });

  it("reads what the loadable segments put in memory, by virtual address: what a program loads between two of its symbols", () => {
    // the image above with one program header behind it: PT_LOAD of 8 bytes of the file at 0x8C010000
    const data = [0x12, 0x34, 0x00, 0x00, 0xcd, 0xab, 0x00, 0x00];
    const withSegment = new Uint8Array(image.length + 32 + data.length);
    withSegment.set(image, 0);
    const view = new DataView(withSegment.buffer);
    const header = image.length;
    view.setUint32(28, header, true); // e_phoff
    view.setUint16(42, 32, true); // e_phentsize
    view.setUint16(44, 1, true); // e_phnum
    view.setUint32(header, 1, true); // PT_LOAD
    view.setUint32(header + 4, header + 32, true); // p_offset
    view.setUint32(header + 8, 0x8c010000, true); // p_vaddr
    view.setUint32(header + 16, data.length, true); // p_filesz
    withSegment.set(data, header + 32);
    const elf = parseElfSymbols(withSegment);
    expect(elf.segments).toEqual([{ address: 0x8c010000, data: new Uint8Array(data) }]);
    expect(Array.from(elfBytes(elf, 0x8c010004, 4)!)).toEqual([0xcd, 0xab, 0x00, 0x00]);
    // nothing outside of a segment, nor across its end
    expect(elfBytes(elf, 0x8c010006, 4)).toBeUndefined();
    expect(elfBytes(elf, 0x8c00fffc, 4)).toBeUndefined();
    expect(elfBytes(parseElfSymbols(image), 0x8c010000, 4)).toBeUndefined();
  });

  // NULLDC_TEST_ELF=<path to 2ndmix.elf>, the program the emulator runs for the contract
  const testProgram = process.env.NULLDC_TEST_ELF ?? "";
  it.skipIf(!testProgram || !existsSync(testProgram))("reads the emulator's test program, 2ndmix.elf", () => {
    const elf = readElfSymbols(testProgram);
    expect(elf.entry).toBe(0x8c010000);
    expect(elf.symbols.size).toBeGreaterThan(100);
    expect(elf.symbols.get("_snd_init")).toBeGreaterThanOrEqual(0x8c010000);
    expect(resolveAddress("_snd_init", elf)).toBe(elf.symbols.get("_snd_init"));
  });
});
