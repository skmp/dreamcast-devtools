import {
  test,
  expect,
  addPanelFromSelector,
  breakpointGutter,
  disassemblyRow,
  disassemblyRows,
  openWorkspace,
  panel,
  pauseFromToolbar,
  saveScreenshot,
  tooltipButton,
  treeItemRow,
} from "./support/fixtures";
import { MOCK_M1_SUPPORT } from "../server/mockDebugger";

// What a server cannot do is said in `targets` and `capabilities` of debugger.describe, and
// the panels say it in turn, in place of the controls that could only be refused. The mock
// is told what to leave out (`supports`); MOCK_M1_SUPPORT is the emulator of milestone M1.

test.describe("a server of milestone M1", () => {
  test.use({ mockOptions: { supports: MOCK_M1_SUPPORT } });

  test("the SH4 is debugged as on any server", async ({ page }) => {
    await openWorkspace(page, "sh4-debugger");
    await pauseFromToolbar(page);
    const view = panel(page, "sh4-disassembly");
    for (const label of ["Step Over", "Step In", "Step Out"]) {
      await expect(tooltipButton(view, label)).toBeEnabled();
    }
    await expect(view.getByRole("button", { name: "Mute category" })).toBeVisible();
    await expect(panel(page, "sh4-breakpoints").getByPlaceholder("Address (e.g., 0x8C0000A0)")).toBeVisible();
    await expect(panel(page, "sh4-callstack").getByRole("listitem")).toHaveCount(16);
    await expect(page.getByText(/This server (cannot|does not|has no)/)).toHaveCount(0);
  });

  test("the ARM7 is listed and read, and not stepped: its step buttons, gutter and breakpoint box give way to a notice", async ({
    page,
    rpc,
  }, testInfo) => {
    await openWorkspace(page, "arm7-debugger");
    await pauseFromToolbar(page);
    const view = panel(page, "arm7-disassembly");

    // the listing and the memory work
    await expect(disassemblyRows(view)).toHaveCount(64);
    await expect(view.locator(".current-instruction")).toHaveCount(1);
    await expect(panel(page, "arm7-memory")).toContainText(/0x00000000\s*([0-9A-F]{2} ){15}/);
    await expect(panel(page, "arm7-callstack").getByRole("listitem")).toHaveCount(16);

    // stepping and code breakpoints are M2
    await expect(view.getByRole("note")).toHaveText("This server cannot step the ARM7 or set code breakpoints on it.");
    for (const label of ["Step Over", "Step In", "Step Out", "Mute category", "Solo category"]) {
      await expect(view.getByLabel(label, { exact: true })).toHaveCount(0);
    }
    const row = disassemblyRow(view, 0x00200018);
    await expect(row).toBeVisible();
    await expect(breakpointGutter(row)).toHaveCount(0);
    // what still moves the view is there
    await expect(tooltipButton(view, "Go to current PC")).toBeEnabled();
    await expect(tooltipButton(view, "Refresh")).toBeEnabled();

    const breakpoints = panel(page, "arm7-breakpoints");
    await expect(breakpoints.getByRole("note")).toHaveText("This server cannot set code breakpoints on the ARM7.");
    await expect(breakpoints.getByRole("textbox")).toHaveCount(0);
    await expect(breakpoints.getByRole("button", { name: "Add", exact: true })).toHaveCount(0);
    await expect(breakpoints).toContainText("No breakpoints defined.");
    await saveScreenshot(page, testInfo, "m1-server-arm7-debugger");

    // nothing was asked of the server that it would have refused
    expect(rpc.received.filter((frame) => JSON.stringify(frame).includes("-32004"))).toEqual([]);
  });

  test("the DSP is listed, and the SGC capture is not asked for", async ({ page, rpc }, testInfo) => {
    await openWorkspace(page, "audio-debugger");
    await pauseFromToolbar(page);
    const view = panel(page, "dsp-disassembly");
    // the listing works: the step the DSP is at, among the lines around it
    await expect(view.locator(".current-instruction")).toHaveCount(1);
    expect(await disassemblyRows(view).count()).toBeGreaterThan(10);
    await expect(view.getByRole("note")).toHaveText("This server cannot step the DSP or set code breakpoints on it.");
    await expect(view.getByLabel("Step", { exact: true })).toHaveCount(0);
    await expect(panel(page, "dsp-breakpoints").getByRole("note")).toHaveText("This server cannot set code breakpoints on the DSP.");

    // no capability "sgc-capture": no Record button that fails, and no request on opening the panel
    const sgc = panel(page, "sgc");
    await expect(sgc.getByRole("note")).toHaveText("This server cannot capture SGC frames.");
    await expect(sgc.getByRole("button")).toHaveCount(0);
    await saveScreenshot(page, testInfo, "m1-server-audio-debugger");
    expect(rpc.requests("state.getSgcFrameData")).toEqual([]);
    expect(rpc.requests("state.recordSgcFrames")).toEqual([]);
    expect(rpc.received.filter((frame) => JSON.stringify(frame).includes("-32004"))).toEqual([]);
  });

  test("no register writes: the value of a watch is not an editor", async ({ page, rpc }) => {
    await openWorkspace(page, "sh4-debugger");
    await pauseFromToolbar(page);
    const watches = panel(page, "watches");
    const value = watches.getByText(/^0x8C0000A[0-9A-E]$/);
    await expect(value).toHaveAttribute("title", "Read-only: this server cannot write registers");
    await value.dblclick();
    await expect(watches.getByRole("listitem").getByRole("textbox")).toHaveCount(0);
    // the expression can be changed as on any server
    await watches.getByText("dc.sh4.cpu.pc", { exact: true }).dblclick();
    await expect(watches.getByRole("listitem").getByRole("textbox")).toHaveValue("dc.sh4.cpu.pc");
    await watches.getByRole("listitem").getByRole("textbox").press("Escape");
    expect(rpc.requests("state.editWatch")).toEqual([]);
  });
});

test.describe("a server without the ARM7", () => {
  test.use({ mockOptions: { supports: { targets: ["sh4", "dsp"] } } });

  test("every ARM7 panel says so, and asks the server for nothing", async ({ page, rpc }, testInfo) => {
    await openWorkspace(page, "arm7-debugger");
    for (const id of ["arm7-disassembly", "arm7-memory", "arm7-breakpoints", "arm7-callstack"]) {
      await expect(panel(page, id).getByRole("note"), id).toHaveText("This server does not support the ARM7 target.");
    }
    for (const id of ["arm7-disassembly", "arm7-memory", "arm7-breakpoints"]) {
      await expect(panel(page, id).getByRole("textbox"), id).toHaveCount(0);
      await expect(panel(page, id).getByRole("button"), id).toHaveCount(0);
    }
    // the rest of the workspace is that of any server
    await expect(panel(page, "watches")).toContainText("dc.sh4.cpu.pc = 0x8C0000");
    await saveScreenshot(page, testInfo, "server-without-arm7");
    await pauseFromToolbar(page);
    await expect(panel(page, "arm7-callstack").getByRole("listitem")).toHaveCount(0);
    expect(rpc.sent.filter((frame) => frame.params?.target === "arm7")).toEqual([]);
    expect(rpc.received.filter((frame) => JSON.stringify(frame).includes("-32004"))).toEqual([]);

    // the SH4 panels, opened in the same workspace, work
    await treeItemRow(page, "dc.sh4.cpu").getByLabel("Open SH4: Disassembly").click();
    await expect(panel(page, "sh4-disassembly").locator(".current-instruction")).toHaveCount(1);
  });
});

test.describe("a server without event breakpoints and without a callstack", () => {
  test.use({ mockOptions: { supports: { capabilities: ["register-write", "sgc-capture"] } } });

  test("the event box and the frames give way to notices; code breakpoints are listed as ever", async ({ page }) => {
    await openWorkspace(page, "sh4-debugger");
    await pauseFromToolbar(page);
    await addPanelFromSelector(page, 3, "Events: Breakpoints");
    const events = panel(page, "events-breakpoints");
    await expect(events.getByRole("note")).toHaveText("This server has no event breakpoints.");
    await expect(events.getByRole("combobox")).toHaveCount(0);
    await expect(events.getByRole("button", { name: "Add", exact: true })).toHaveCount(0);

    const row = disassemblyRow(panel(page, "sh4-disassembly"), 0x8c0000a6);
    await row.hover();
    await breakpointGutter(row).click();
    await expect(events.getByRole("listitem").filter({ hasText: "dc.sh4.cpu.pc == 0x8C0000A6" })).toBeVisible();
    await expect(events.getByRole("heading", { name: "SH4", exact: true })).toBeVisible();

    await expect(panel(page, "sh4-callstack").getByRole("note")).toHaveText("This server has no callstack.");
    await expect(panel(page, "sh4-callstack").getByRole("listitem")).toHaveCount(0);
  });
});
