import { readFileSync } from "node:fs";

/**
 * A small reader for the symbol table of an ELF32 file (`.symtab`), for the test program
 * the emulator runs: the contract runner resolves names like `_snd_init` with it, and takes
 * the entry point from the header.
 */
export interface ElfSymbols {
  /** e_entry */
  entry: number;
  /** function and object symbols by name (the first definition wins) */
  symbols: Map<string, number>;
}

const SHT_SYMTAB = 2;

export const parseElfSymbols = (image: Uint8Array): ElfSymbols => {
  const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const fail = (what: string): never => {
    throw new Error(`not an ELF32 file this reader understands: ${what}`);
  };
  if (image.byteLength < 52 || view.getUint32(0, false) !== 0x7f454c46) {
    fail("no ELF magic");
  }
  if (image[4] !== 1) {
    fail("not a 32-bit file");
  }
  const little = image[5] === 1;
  if (!little && image[5] !== 2) {
    fail("unknown byte order");
  }
  const u16 = (offset: number) => view.getUint16(offset, little);
  const u32 = (offset: number) => view.getUint32(offset, little);

  const entry = u32(24);
  const sectionOffset = u32(32);
  const sectionSize = u16(46);
  const sectionCount = u16(48);
  if (sectionOffset === 0 || sectionCount === 0) {
    return { entry, symbols: new Map() };
  }
  if (sectionSize < 40 || sectionOffset + sectionCount * sectionSize > image.byteLength) {
    fail("section headers outside of the file");
  }
  const section = (index: number) => {
    const base = sectionOffset + index * sectionSize;
    return { type: u32(base + 4), offset: u32(base + 16), size: u32(base + 20), link: u32(base + 24), entrySize: u32(base + 36) };
  };

  const symbols = new Map<string, number>();
  for (let index = 0; index < sectionCount; index++) {
    const table = section(index);
    if (table.type !== SHT_SYMTAB) {
      continue;
    }
    if (table.link >= sectionCount) {
      fail(".symtab without a string table");
    }
    const strings = section(table.link);
    const entrySize = table.entrySize || 16;
    if (table.offset + table.size > image.byteLength || strings.offset + strings.size > image.byteLength) {
      fail(".symtab or its string table outside of the file");
    }
    const nameAt = (offset: number): string => {
      let end = strings.offset + offset;
      const limit = strings.offset + strings.size;
      while (end < limit && image[end] !== 0) {
        end++;
      }
      return new TextDecoder("latin1").decode(image.subarray(strings.offset + offset, end));
    };
    for (let offset = 0; offset + entrySize <= table.size; offset += entrySize) {
      const base = table.offset + offset;
      const nameOffset = u32(base);
      const value = u32(base + 4);
      const type = image[base + 12] & 0x0f;
      const sectionIndex = u16(base + 14);
      // defined functions, objects and untyped labels (assembly); no sections, no files
      if (nameOffset === 0 || sectionIndex === 0 || type > 2) {
        continue;
      }
      const name = nameAt(nameOffset);
      if (name && !symbols.has(name)) {
        symbols.set(name, value);
      }
    }
  }
  return { entry, symbols };
};

export const readElfSymbols = (path: string): ElfSymbols => parseElfSymbols(readFileSync(path));

/** A number (`0x8C010000`, `2348875776`) or the name of a symbol. */
export const resolveAddress = (text: string, elf: ElfSymbols | undefined): number => {
  const trimmed = text.trim();
  if (/^0x[0-9a-f]+$/i.test(trimmed) || /^\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    if (value > 0xffffffff) {
      throw new Error(`${text} is not a 32-bit address`);
    }
    return value;
  }
  if (!elf) {
    throw new Error(`"${text}" is not a number; to use a symbol name pass --elf <path>`);
  }
  const value = elf.symbols.get(trimmed) ?? elf.symbols.get(`_${trimmed}`);
  if (value === undefined) {
    throw new Error(`the ELF file has no symbol "${text}"`);
  }
  return value >>> 0;
};
