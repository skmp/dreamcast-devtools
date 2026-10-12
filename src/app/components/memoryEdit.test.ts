import { describe, expect, it } from "vitest";
import { HEX_COLUMN_CHARACTERS, formatByte, hexColumnByte, memoryWrite, parseByteRun } from "./memoryEdit";

const bytes = (text: string) => {
  const run = parseByteRun(text);
  return run.ok ? run.data : run.reason;
};

describe("the byte of a row a pointer is on", () => {
  // a hex column of 47 characters that are 10 px wide
  const WIDTH = HEX_COLUMN_CHARACTERS * 10;

  it("is the byte whose two digits, or the blank behind them, it is on", () => {
    expect(HEX_COLUMN_CHARACTERS).toBe(47);
    // "45 BC 32 ...": characters 0 and 1 are byte 0, character 2 the blank behind it
    expect([0, 9, 10, 19, 20, 29].map((x) => hexColumnByte(x, WIDTH))).toEqual([0, 0, 0, 0, 0, 0]);
    expect([30, 45, 59].map((x) => hexColumnByte(x, WIDTH))).toEqual([1, 1, 1]);
    expect(hexColumnByte(60, WIDTH)).toBe(2);
    // the last byte has no blank behind it
    expect([449.9, 450, 469.9].map((x) => hexColumnByte(x, WIDTH))).toEqual([14, 15, 15]);
    // every byte, from the middle of its first digit
    expect(Array.from({ length: 16 }, (_, index) => hexColumnByte(index * 30 + 5, WIDTH))).toEqual(Array.from({ length: 16 }, (_, index) => index));
  });

  it("is the same in a column of any width: the font of the listing follows its panel", () => {
    for (const width of [47 * 6, 47 * 7.2, 47 * 9.6]) {
      const character = width / 47;
      expect(hexColumnByte(character * 3 * 7 + character * 0.5, width)).toBe(7);
      expect(hexColumnByte(character * 3 * 7 - character * 0.5, width)).toBe(6);
    }
  });

  it("is a byte of the row for a pointer at its edges, and for a column that has no width", () => {
    expect(hexColumnByte(-3, WIDTH)).toBe(0);
    expect(hexColumnByte(WIDTH, WIDTH)).toBe(15);
    expect(hexColumnByte(WIDTH + 40, WIDTH)).toBe(15);
    expect(hexColumnByte(12, 0)).toBe(0);
  });
});

describe("what is typed as a run of bytes", () => {
  it("is two hex digits a byte, in either case, with or without blanks between the bytes", () => {
    expect(bytes("DE AD BE EF")).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(bytes("deadbeef")).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(bytes("  De aDBE\tef  ")).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(bytes("00")).toEqual([0]);
    expect(bytes("FF 00 7f")).toEqual([0xff, 0, 0x7f]);
  });

  it("takes one digit alone as that byte", () => {
    expect(bytes("5")).toEqual([5]);
    expect(bytes("5 a 0")).toEqual([5, 10, 0]);
    expect(bytes("5 AB")).toEqual([5, 0xab]);
  });

  it("is refused, with what is wrong, when it is no run of bytes", () => {
    expect(bytes("")).toBe("Type the bytes to write: two hex digits a byte");
    expect(bytes("   ")).toBe("Type the bytes to write: two hex digits a byte");
    expect(bytes("ABC")).toBe('"ABC" has 3 digits: a byte is two hex digits');
    expect(bytes("DE ADB")).toBe('"ADB" has 3 digits: a byte is two hex digits');
    expect(bytes("0x12")).toBe('"0x12" is not hex: a byte is two hex digits');
    expect(bytes("12 zz")).toBe('"zz" is not hex: a byte is two hex digits');
    expect(bytes("12,34")).toBe('"12,34" is not hex: a byte is two hex digits');
    expect(bytes("-1")).toBe('"-1" is not hex: a byte is two hex digits');
    // nothing of a text is taken when a part of it is refused
    expect(parseByteRun("DE AD ?")).toEqual({ ok: false, reason: '"?" is not hex: a byte is two hex digits' });
  });

  it("prints a byte as the column does", () => {
    expect([0, 5, 0x7f, 0xab, 0xff].map(formatByte)).toEqual(["00", "05", "7F", "AB", "FF"]);
  });
});

describe("what an edit sends", () => {
  const hex8 = (address: number) => `0x${address.toString(16).toUpperCase().padStart(8, "0")}`;
  const sh4 = { addressMax: 0xffffffff, formatAddress: hex8 };
  const arm7 = { addressMax: 0x00ffffff, formatAddress: hex8 };

  it("is the run as one write, from the address of the byte it was typed at", () => {
    expect(memoryWrite(sh4, 0x8c010004, "DE AD BE EF")).toEqual({ ok: true, address: 0x8c010004, data: [0xde, 0xad, 0xbe, 0xef] });
    expect(memoryWrite(arm7, 0x00200000, "1f")).toEqual({ ok: true, address: 0x00200000, data: [0x1f] });
    // a run is not cut at the end of its row
    const long = memoryWrite(sh4, 0x8c01000e, "00112233445566778899");
    expect(long).toMatchObject({ ok: true, address: 0x8c01000e });
    expect(long.ok && long.data).toHaveLength(10);
  });

  it("is nothing for a text that is no run of bytes", () => {
    expect(memoryWrite(sh4, 0x8c010000, "xyz")).toEqual({ ok: false, reason: '"xyz" is not hex: a byte is two hex digits' });
    expect(memoryWrite(sh4, 0x8c010000, "")).toMatchObject({ ok: false });
  });

  it("is nothing for a run that would pass the last address of the target: the server refuses it whole", () => {
    expect(memoryWrite(arm7, 0x00fffffe, "01 02")).toEqual({ ok: true, address: 0x00fffffe, data: [1, 2] });
    expect(memoryWrite(arm7, 0x00fffffe, "01 02 03")).toEqual({
      ok: false,
      reason: "3 bytes from 0x00FFFFFE would pass the last address, 0x00FFFFFF",
    });
    expect(memoryWrite(sh4, 0xffffffff, "01")).toMatchObject({ ok: true });
    expect(memoryWrite(sh4, 0xffffffff, "01 02")).toMatchObject({ ok: false });
  });

  it("is nothing for more bytes than one request takes", () => {
    expect(memoryWrite(sh4, 0x8c000000, "00".repeat(65536))).toMatchObject({ ok: true });
    expect(memoryWrite(sh4, 0x8c000000, "00".repeat(65537))).toEqual({ ok: false, reason: "65537 bytes are more than one write takes (65536)" });
  });
});
