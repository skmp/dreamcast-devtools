import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ICON_DIR, PNG_DIR, PNG_SIZES, PUBLIC_DIR, PUBLIC_SIZES, ROOT, pngName } from "./build-icon";

/** Width and height from the IHDR chunk of a PNG file. */
const pngSize = (file: string): [number, number] => {
  const bytes = readFileSync(file);
  expect(bytes.subarray(0, 8).toString("hex"), file).toBe("89504e470d0a1a0a");
  expect(bytes.subarray(12, 16).toString("latin1"), file).toBe("IHDR");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};

describe("the icon", () => {
  it("has its two SVGs and a PNG of every size, that size", () => {
    expect(existsSync(join(ICON_DIR, "dreamcast-devtools.svg"))).toBe(true);
    expect(existsSync(join(ICON_DIR, "dreamcast-devtools-small.svg"))).toBe(true);
    expect(readdirSync(PNG_DIR).sort()).toEqual(PNG_SIZES.map(pngName).sort());
    for (const size of PNG_SIZES) {
      expect(pngSize(join(PNG_DIR, pngName(size))), pngName(size)).toEqual([size, size]);
    }
  });

  it("public/ has the PNGs index.html links, the same bytes as in branding/icon/png/", () => {
    expect(readdirSync(PUBLIC_DIR).filter((file) => file.endsWith(".png")).sort()).toEqual(PUBLIC_SIZES.map(pngName).sort());
    for (const size of PUBLIC_SIZES) {
      expect(readFileSync(join(PUBLIC_DIR, pngName(size))).equals(readFileSync(join(PNG_DIR, pngName(size)))), pngName(size)).toBe(true);
    }
  });

  it("index.html links every PNG of public/, each with the size it is", () => {
    const html = readFileSync(join(ROOT, "index.html"), "utf8");
    const linked = [...html.matchAll(/(?:href|content)="([^"]+\.(?:png|svg|ico))"/g)].map((match) => match[1]);
    expect(new Set(linked)).toEqual(new Set(PUBLIC_SIZES.map(pngName)));
    const sized = [...html.matchAll(/sizes="(\d+)x(\d+)" href="dreamcast-devtools-(\d+)\.png"/g)];
    expect(sized.map((match) => Number(match[3])).sort((a, b) => a - b)).toEqual([16, 32, 180, 192]);
    for (const [, width, height, size] of sized) {
      expect([width, height], `dreamcast-devtools-${size}.png`).toEqual([size, size]);
    }
  });
});
