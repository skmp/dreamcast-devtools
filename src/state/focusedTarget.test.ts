import { afterEach, describe, expect, it } from "vitest";
import { PANEL_IDS } from "../lib/debuggerSchema";
import { panelTarget, useFocusedTargetStore, workspaceTarget } from "./focusedTarget";

const store = () => useFocusedTargetStore.getState();
/** What a workspace page shows as its focused target (`useFocusedTarget`, without React). */
const focused = (workspaceId: string) => store().byFocus ?? workspaceTarget(workspaceId);

afterEach(() => {
  store().workspaceOpened();
});

describe("the target a workspace is for", () => {
  it("is the SH4 for the SH4 and the mixed-mode workspace, the ARM7 for the ARM7's, the DSP for the audio workspace", () => {
    expect(workspaceTarget("sh4-debugger")).toBe("sh4");
    expect(workspaceTarget("mixed-mode-debugger")).toBe("sh4");
    expect(workspaceTarget("arm7-debugger")).toBe("arm7");
    expect(workspaceTarget("audio-debugger")).toBe("dsp");
  });

  it("is the SH4 for a page this table does not know, a name of Object.prototype included", () => {
    expect(workspaceTarget("some-other-page")).toBe("sh4");
    expect(workspaceTarget("constructor")).toBe("sh4");
    expect(workspaceTarget("")).toBe("sh4");
  });
});

describe("the target of a panel", () => {
  it("is that of its disassembly, memory, breakpoints, callstack and registers", () => {
    const targets = Object.fromEntries(Object.values(PANEL_IDS).map((id) => [id, panelTarget(id)]));
    expect(targets).toEqual({
      "sh4-disassembly": "sh4",
      "sh4-memory": "sh4",
      "sh4-breakpoints": "sh4",
      "sh4-callstack": "sh4",
      "sh4-registers": "sh4",
      // the on-chip modules of the SH4
      "bsc-registers": "sh4",
      "ccn-registers": "sh4",
      "cpg-registers": "sh4",
      "dmac-registers": "sh4",
      "intc-registers": "sh4",
      "rtc-registers": "sh4",
      "sci-registers": "sh4",
      "scif-registers": "sh4",
      "tmu-registers": "sh4",
      "ubc-registers": "sh4",
      "arm7-disassembly": "arm7",
      "arm7-memory": "arm7",
      "arm7-breakpoints": "arm7",
      "arm7-callstack": "arm7",
      "arm7-registers": "arm7",
      "dsp-disassembly": "dsp",
      "dsp-breakpoints": "dsp",
      // panels of no target
      documentation: undefined,
      "sh4-sim": undefined,
      events: undefined,
      "events-breakpoints": undefined,
      "sq-contents": undefined,
      "icache-contents": undefined,
      "ocache-contents": undefined,
      "ocram-contents": undefined,
      "tlb-contents": undefined,
      "holly-ta": undefined,
      "holly-core": undefined,
      sgc: undefined,
      "dsp-playground": undefined,
      "device-tree": undefined,
      watches: undefined,
    });
  });

  it("is none for an id this build does not know", () => {
    expect(panelTarget("nothing-of-the-kind")).toBeUndefined();
    expect(panelTarget("toString")).toBeUndefined();
  });
});

describe("the focused target", () => {
  it("is the workspace's own until a panel of a target has had the focus", () => {
    expect(focused("sh4-debugger")).toBe("sh4");
    expect(focused("arm7-debugger")).toBe("arm7");
    expect(focused("audio-debugger")).toBe("dsp");
    expect(focused("mixed-mode-debugger")).toBe("sh4");
  });

  it("follows the panel of a target that last had the focus", () => {
    store().panelFocused("arm7-disassembly");
    expect(focused("mixed-mode-debugger")).toBe("arm7");
    store().panelFocused("sh4-callstack");
    expect(focused("mixed-mode-debugger")).toBe("sh4");
    store().panelFocused("dsp-breakpoints");
    expect(focused("mixed-mode-debugger")).toBe("dsp");
    store().panelFocused("arm7-registers");
    expect(focused("sh4-debugger")).toBe("arm7");
  });

  it("stays where it is while the focus is in a panel of no target", () => {
    store().panelFocused("arm7-memory");
    for (const id of ["device-tree", "watches", "events", "events-breakpoints", "sgc", "documentation", "no-such-panel"]) {
      store().panelFocused(id);
      expect(focused("sh4-debugger"), id).toBe("arm7");
    }
  });

  it("is the workspace's own again when a workspace page opens", () => {
    store().panelFocused("arm7-disassembly");
    store().workspaceOpened();
    expect(focused("mixed-mode-debugger")).toBe("sh4");
    expect(focused("audio-debugger")).toBe("dsp");
  });

  it("tells its subscribers of a change, and of nothing else", () => {
    let calls = 0;
    const unsubscribe = useFocusedTargetStore.subscribe(() => calls++);
    store().panelFocused("sh4-disassembly");
    store().panelFocused("sh4-memory");
    store().panelFocused("watches");
    expect(calls).toBe(1);
    store().workspaceOpened();
    store().workspaceOpened();
    expect(calls).toBe(2);
    unsubscribe();
  });
});
