import { create } from "zustand";
import { PANEL_IDS, type TargetProcessor } from "../lib/debuggerSchema";

// The focused target: the one the step buttons of the toolbar and the function keys act on.
// A workspace page has three of them to choose from and one toolbar, so it is the target of
// the panel of a target that last had the focus (its disassembly, memory, breakpoints,
// callstack or registers), and until one of those had it, the target the workspace is for.
// The toolbar says which it is. The views keep step buttons of their own, for their own target.

/** The target a workspace is for, which is the focused one when its page opens. */
const WORKSPACE_TARGETS: Readonly<Record<string, TargetProcessor>> = {
  "sh4-debugger": "sh4",
  "arm7-debugger": "arm7",
  "audio-debugger": "dsp",
  "mixed-mode-debugger": "sh4",
};

export const workspaceTarget = (workspaceId: string): TargetProcessor =>
  Object.hasOwn(WORKSPACE_TARGETS, workspaceId) ? WORKSPACE_TARGETS[workspaceId] : "sh4";

/**
 * The panels of a target. The register panels of the SH4's on-chip modules are panels of the
 * SH4. Every other panel (the device tree, the watches, the events, the tools) is of no
 * target: the focus in one of them leaves the focused target as it is.
 */
const PANEL_TARGETS: Readonly<Record<string, TargetProcessor>> = {
  [PANEL_IDS.SH4_DISASSEMBLY]: "sh4",
  [PANEL_IDS.SH4_MEMORY]: "sh4",
  [PANEL_IDS.SH4_BREAKPOINTS]: "sh4",
  [PANEL_IDS.SH4_CALLSTACK]: "sh4",
  [PANEL_IDS.SH4_REGISTERS]: "sh4",
  [PANEL_IDS.SH4_BSC_REGISTERS]: "sh4",
  [PANEL_IDS.SH4_CCN_REGISTERS]: "sh4",
  [PANEL_IDS.SH4_CPG_REGISTERS]: "sh4",
  [PANEL_IDS.SH4_DMAC_REGISTERS]: "sh4",
  [PANEL_IDS.SH4_INTC_REGISTERS]: "sh4",
  [PANEL_IDS.SH4_RTC_REGISTERS]: "sh4",
  [PANEL_IDS.SH4_SCI_REGISTERS]: "sh4",
  [PANEL_IDS.SH4_SCIF_REGISTERS]: "sh4",
  [PANEL_IDS.SH4_TMU_REGISTERS]: "sh4",
  [PANEL_IDS.SH4_UBC_REGISTERS]: "sh4",
  [PANEL_IDS.ARM7_DISASSEMBLY]: "arm7",
  [PANEL_IDS.ARM7_MEMORY]: "arm7",
  [PANEL_IDS.ARM7_BREAKPOINTS]: "arm7",
  [PANEL_IDS.ARM7_CALLSTACK]: "arm7",
  [PANEL_IDS.ARM7_REGISTERS]: "arm7",
  [PANEL_IDS.DSP_DISASSEMBLY]: "dsp",
  [PANEL_IDS.DSP_BREAKPOINTS]: "dsp",
};

/** The target a panel is of; undefined for a panel of no target, and for an id this build does not know. */
export const panelTarget = (panelId: string): TargetProcessor | undefined =>
  Object.hasOwn(PANEL_TARGETS, panelId) ? PANEL_TARGETS[panelId] : undefined;

interface FocusedTargetState {
  /** the target of the panel of a target that last had the focus on this workspace page; undefined until one had it */
  byFocus?: TargetProcessor;
  /** A workspace page opens (or the page changes to another workspace): no panel of it has had the focus yet. */
  workspaceOpened: () => void;
  /** A dock panel has the focus: a click in it or on its tab, or the keyboard focus moving into it. */
  panelFocused: (panelId: string) => void;
}

export const useFocusedTargetStore = create<FocusedTargetState>()((set, get) => ({
  byFocus: undefined,

  workspaceOpened() {
    if (get().byFocus !== undefined) {
      set({ byFocus: undefined });
    }
  },

  panelFocused(panelId) {
    const target = panelTarget(panelId);
    if (target !== undefined && target !== get().byFocus) {
      set({ byFocus: target });
    }
  },
}));

/** The focused target of a workspace page. */
export const useFocusedTarget = (workspaceId: string): TargetProcessor =>
  useFocusedTargetStore((state) => state.byFocus) ?? workspaceTarget(workspaceId);
