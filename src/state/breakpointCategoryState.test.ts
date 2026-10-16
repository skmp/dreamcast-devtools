import { describe, expect, it } from "vitest";
import { isCategoryActive, toggleMuted, toggleSoloed } from "./breakpointCategoryState";
import { defaultCategoryStates } from "./tickState";

describe("mute and solo", () => {
  it("mute toggles one category and takes its solo away", () => {
    const soloed = toggleSoloed(defaultCategoryStates(), "sh4");
    const muted = toggleMuted(soloed, "sh4");
    expect(muted.sh4).toEqual({ muted: true, soloed: false });
    expect(toggleMuted(muted, "sh4").sh4).toEqual({ muted: false, soloed: false });
    expect(muted.arm7).toEqual({ muted: false, soloed: false });
  });

  it("solo moves to the category that was clicked, unmutes it, and leaves the mutes of the others", () => {
    const start = toggleMuted(toggleMuted(toggleSoloed(defaultCategoryStates(), "events"), "sh4"), "dsp");
    const next = toggleSoloed(start, "sh4");
    expect(next).toEqual({
      events: { muted: false, soloed: false },
      sh4: { muted: false, soloed: true },
      arm7: { muted: false, soloed: false },
      dsp: { muted: true, soloed: false },
    });
    expect(toggleSoloed(next, "sh4").sh4).toEqual({ muted: false, soloed: false });
  });

  it("never changes the state it is given", () => {
    const start = defaultCategoryStates();
    toggleMuted(start, "sh4");
    toggleSoloed(start, "arm7");
    expect(start).toEqual(defaultCategoryStates());
  });

  it("a category is active when it is not muted, and soloed if any category is", () => {
    const start = defaultCategoryStates();
    expect(isCategoryActive(start, "sh4")).toBe(true);
    expect(isCategoryActive(toggleMuted(start, "sh4"), "sh4")).toBe(false);
    const soloed = toggleSoloed(start, "arm7");
    expect(isCategoryActive(soloed, "arm7")).toBe(true);
    expect(isCategoryActive(soloed, "sh4")).toBe(false);
  });
});
