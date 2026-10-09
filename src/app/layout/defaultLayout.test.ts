import { describe, expect, it } from "vitest";
import { isCompactDock, SIDE_BY_SIDE_MIN_WIDTH } from "./defaultLayout";

// What the centre dock has in a window with both side docks open (280 and 340 px, the two
// buttons that hide them, the gaps between them): the width of the window less 736 px.
const centre = (windowWidth: number) => windowWidth - 736;

describe("the default layout of a centre dock", () => {
  it("stacks its views in the window of a laptop, where two side by side cannot be read", () => {
    for (const width of [1280, 1366, 1440, 1536]) {
      expect(isCompactDock("sh4-layout", centre(width)), `${width}`).toBe(true);
      expect(isCompactDock("mixed-mode-debugger-layout", centre(width)), `${width}`).toBe(true);
    }
  });

  it("puts them side by side from 1600 px on, and in a window without side docks", () => {
    for (const width of [1600, 1680, 1920, 2560]) {
      expect(isCompactDock("sh4-layout", centre(width)), `${width}`).toBe(false);
      expect(isCompactDock("mixed-mode-debugger-layout", centre(width)), `${width}`).toBe(false);
    }
    // below 1200 px the side docks are hidden, and the centre dock has the window
    expect(isCompactDock("sh4-layout", 1100 - 16)).toBe(false);
    expect(SIDE_BY_SIDE_MIN_WIDTH).toBeGreaterThan(centre(1536));
    expect(SIDE_BY_SIDE_MIN_WIDTH).toBeLessThanOrEqual(centre(1600));
  });

  it("is not changed for the docks that have nothing side by side, or that could not be measured", () => {
    expect(isCompactDock("tabs", 300)).toBe(false);
    expect(isCompactDock("vertical-stack", 300)).toBe(false);
    expect(isCompactDock("sh4-layout", 0)).toBe(false);
  });
});
