import { describe, expect, it } from "vitest";
import { uniqueLines } from "./disassemblyLines";

const line = (address: number, disassembly = "nop") => ({ address, bytes: "09 00", disassembly });

describe("the lines of a listing", () => {
  it("are kept as they are when every address is listed once", () => {
    const lines = [line(0x100), line(0x102), line(0x104)];
    expect(uniqueLines(lines)).toEqual(lines);
    expect(uniqueLines([])).toEqual([]);
  });

  it("an address that is listed again is shown with its first line, wherever the repeat is", () => {
    expect(uniqueLines([line(0x100, "first"), line(0x100, "second"), line(0x102), line(0x100, "third"), line(0x102, "again")])).toEqual([
      line(0x100, "first"),
      line(0x102),
    ]);
  });
});
