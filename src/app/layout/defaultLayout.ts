// Which default layout a dock gets. Apart from the dock itself (DockingLayout.tsx), so that
// the rule can be tested without one.

/** How the panels of a dock are laid out when there is no saved layout. */
export type DefaultLayoutMode = "tabs" | "vertical-stack" | "sh4-layout" | "mixed-mode-debugger-layout";

/**
 * The width in px from which a centre dock has room for two views side by side. Each half is
 * then 430 px or more: a listing of the ARM7 with its address, its four bytes and twelve
 * characters or more of every instruction. Below it (a window of 1280 to 1440 px with both
 * side docks open leaves the centre 540 to 700 px) the halves are too narrow to be read: the
 * instruction column is gone and the memory view shows a third of its bytes.
 */
export const SIDE_BY_SIDE_MIN_WIDTH = 860;

/**
 * Whether the default layout of a dock is the stacked one: for the layouts that put views side
 * by side, in a dock that is narrower than that takes. A dock that has not been measured
 * (width 0) gets the layout it always had.
 */
export const isCompactDock = (mode: DefaultLayoutMode, width: number): boolean =>
  (mode === "sh4-layout" || mode === "mixed-mode-debugger-layout") && width > 0 && width < SIDE_BY_SIDE_MIN_WIDTH;
