import type { BreakpointCategory } from "../lib/debuggerSchema";
import type { CategoryStates } from "./tickState";

// Mute and solo of the four breakpoint categories. The state belongs to the server: every
// tick of a v3 server carries it, the store keeps the latest (debuggerDataStore), and a
// button sends the whole state it wants with breakpoints.setCategoryStates. These are the
// rules the buttons apply.

export type { BreakpointCategory, CategoryStates };

export interface CategoryState {
  muted: boolean;
  soloed: boolean;
}

/** Mute or unmute a category. A category cannot be muted and soloed at once. */
export const toggleMuted = (states: CategoryStates, category: BreakpointCategory): CategoryStates => {
  const muted = !states[category].muted;
  return { ...states, [category]: { muted, soloed: muted ? false : states[category].soloed } };
};

/** Solo or unsolo a category. At most one category is soloed, and it is not muted. */
export const toggleSoloed = (states: CategoryStates, category: BreakpointCategory): CategoryStates => {
  const soloed = !states[category].soloed;
  if (!soloed) {
    return { ...states, [category]: { muted: states[category].muted, soloed: false } };
  }
  const next = { ...states };
  for (const key of Object.keys(states) as BreakpointCategory[]) {
    next[key] = key === category ? { muted: false, soloed: true } : { muted: states[key].muted, soloed: false };
  }
  return next;
};

/** Whether the breakpoints of a category can stop the target: not muted, and soloed if any category is. */
export const isCategoryActive = (states: CategoryStates, category: BreakpointCategory): boolean => {
  const state = states[category];
  if (state.muted) {
    return false;
  }
  const anySoloed = Object.values(states).some((candidate) => candidate.soloed);
  return anySoloed ? state.soloed : true;
};
