import {
  test,
  expect,
  addPanelFromSelector,
  breakpointGutter,
  disassemblyRow,
  disassemblyRows,
  gotoRoute,
  openWorkspace,
  panel,
  pauseFromToolbar,
  saveScreenshot,
  statusBar,
  tooltipButton,
  treeItemRow,
} from "./support/fixtures";
import { serveScriptedDebugger, V3_TARGETS, type Json, type ScriptedDebugger } from "./support/scriptedDebugger";
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

test.describe("a server of milestone M1, when its connection is lost", () => {
  test.use({ mockOptions: { supports: MOCK_M1_SUPPORT } });

  test("the panels keep their frame: what the server cannot do stays said, the boxes stay as they were, and only the data goes", async ({
    page,
    mock,
    diagnostics,
  }, testInfo) => {
    diagnostics.allow(/^console\.error: WebSocket connection to/, "the server is down on purpose");
    await openWorkspace(page, "arm7-debugger");
    const view = panel(page, "arm7-disassembly");
    const memory = panel(page, "arm7-memory");
    const breakpoints = panel(page, "arm7-breakpoints");
    await expect(disassemblyRows(view)).toHaveCount(64);
    // the user has been somewhere: a search in the tree, the memory view at an address of their own
    const search = panel(page, "device-tree").getByPlaceholder("Search components...");
    await search.fill("arm7");
    await memory.getByRole("textbox").fill("0x00200100");
    await memory.getByRole("textbox").press("Enter");
    await expect(memory).toContainText(/0x00200100\s*([0-9A-F]{2} ){15}/);
    const listedFrom = await view.getByRole("textbox").inputValue();
    expect(listedFrom).toMatch(/^0x002000[0-9A-F]{2}$/);

    // --- the emulator goes ---
    await mock.stop();
    await expect(statusBar(page)).toContainText("Connection: reconnecting");
    // where the data was, each panel says that there is no connection
    for (const id of ["device-tree", "arm7-disassembly", "arm7-memory", "arm7-breakpoints", "watches", "arm7-callstack"]) {
      await expect(panel(page, id), id).toContainText("Not connected");
    }
    await expect(disassemblyRows(view)).toHaveCount(0);
    await expect(memory).not.toContainText("0x00200100 ");

    // The frame of each is the one this server gave it. Its ARM7 is not stepped: the notice is
    // where the step buttons would be, and no step button comes back because nobody is there to refuse it.
    await expect(view.getByRole("note")).toHaveText("This server cannot step the ARM7 or set code breakpoints on it.");
    for (const label of ["Step Over", "Step In", "Step Out", "Mute category", "Solo category"]) {
      await expect(view.getByLabel(label, { exact: true }), label).toHaveCount(0);
    }
    await expect(breakpoints.getByRole("note")).toHaveText("This server cannot set code breakpoints on the ARM7.");
    await expect(breakpoints.getByRole("textbox")).toHaveCount(0);
    // the toolbars and the boxes are there, and say what they said
    await expect(search).toHaveValue("arm7");
    await expect(view.getByRole("textbox")).toHaveValue(listedFrom);
    await expect(memory.getByRole("textbox")).toHaveValue("0x00200100");
    for (const button of [tooltipButton(view, "Go to current PC"), tooltipButton(view, "Refresh"), tooltipButton(memory, "Refresh")]) {
      await expect(button).toBeVisible();
    }
    await expect(panel(page, "watches").getByPlaceholder("Enter expression")).toBeVisible();
    await saveScreenshot(page, testInfo, "m1-server-arm7-debugger-not-connected");
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

test("a target whose memory the server cannot read: its memory panel says so, and asks the server for nothing", async ({ page }) => {
  // The mock reads the memory of every target that has a memory panel, so this server is
  // written by the test: the ARM7 is listed, and `memory` is false (then there is no default
  // memory address either).
  const server = await serveScriptedDebugger(page);
  const arm7 = (server.shape.targets as Json[]).find((target) => target.id === "arm7")!;
  arm7.memory = false;
  delete arm7.defaultMemoryAddress;
  await gotoRoute(page, "/workspace/arm7-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");
  await server.described();

  const memory = panel(page, "arm7-memory");
  await expect(memory.getByRole("note")).toHaveText("This server cannot read the memory of the ARM7.");
  await expect(memory.getByRole("textbox")).toHaveCount(0);
  await expect(memory.getByRole("button")).toHaveCount(0);

  // the rest of the target is as on any server: it is listed, stepped and has its breakpoints
  const view = panel(page, "arm7-disassembly");
  await expect(view.locator(".current-instruction")).toHaveAttribute("data-address", String(0x100));
  await expect(tooltipButton(view, "Step In")).toBeEnabled();
  await expect(panel(page, "arm7-breakpoints").getByPlaceholder("Address (e.g., 0x8C0000A0)")).toBeVisible();
  await expect(page.getByRole("note")).toHaveCount(1);

  // a stop makes the views read again; this panel has nothing to read
  const listings = () => server.requestsOf("state.getDisassembly").length;
  const before = listings();
  server.state.execution = { state: "paused", stopId: 2, reason: "step" };
  server.setRegister("dc.aica.arm7", "PC", "0x00000104");
  server.tick();
  await expect(view.locator(".current-instruction")).toHaveAttribute("data-address", String(0x104));
  await expect.poll(listings).toBe(before + 1);
  await expect(memory.getByRole("note")).toHaveText("This server cannot read the memory of the ARM7.");
  expect(server.requestsOf("state.getMemorySlice")).toEqual([]);
});

test("a memory panel that had a notice to show opens where the next server says, not at an address of its own", async ({ page }) => {
  // The emulator is restarted as another one, three times. The page reconnects by itself, and
  // each server says in `targets` whether the memory of the ARM7 can be read, and from where.
  const server = await serveScriptedDebugger(page);
  const memory = panel(page, "arm7-memory");
  const firstRow = memory.locator("span").filter({ hasText: /^0x[0-9A-F]{8}$/ }).first();
  const slices = () => server.requestsOf("state.getMemorySlice").filter((params) => params.target === "arm7");
  /** The ARM7 as the next server describes it; undefined: that server has no ARM7. */
  const describeArm7 = (scripted: ScriptedDebugger, arm7: { memory: boolean; defaultMemoryAddress?: number } | undefined) => {
    scripted.shape.targets = V3_TARGETS.flatMap((target): Json[] => {
      if (target.id !== "arm7") {
        return [{ ...target }];
      }
      if (!arm7) {
        return [];
      }
      const { defaultMemoryAddress: _builtIn, ...rest } = target;
      return [{ ...rest, ...arm7 }];
    });
  };
  let connections = 1;
  const restartAs = async (arm7: Parameters<typeof describeArm7>[1]) => {
    describeArm7(server, arm7);
    server.drop();
    // one second later the page is back by itself
    await expect.poll(() => server.connections()).toBe(++connections);
    await server.described();
    await expect(statusBar(page)).toContainText("Connection: connected");
  };

  // 1. a server without the ARM7
  describeArm7(server, undefined);
  await gotoRoute(page, "/workspace/arm7-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");
  await server.described();
  await expect(memory.getByRole("note")).toHaveText("This server does not support the ARM7 target.");

  // 2. one that has it: the view opens at the address this server names
  await restartAs({ memory: true, defaultMemoryAddress: 0x1000 });
  await expect(firstRow).toHaveText("0x00001000");
  expect(slices()).toEqual([{ target: "arm7", address: 0x1000, length: 960 }]);
  await expect(memory.getByRole("textbox")).toHaveValue("0x000010A0");

  // 3. one that cannot read its memory
  await restartAs({ memory: false });
  await expect(memory.getByRole("note")).toHaveText("This server cannot read the memory of the ARM7.");
  await expect(memory.getByRole("textbox")).toHaveCount(0);

  // 4. one that can, from another address: neither the built-in one nor that of the server before the notice
  await restartAs({ memory: true, defaultMemoryAddress: 0x2000 });
  await expect(firstRow).toHaveText("0x00002000");
  expect(slices().at(-1)).toEqual({ target: "arm7", address: 0x2000, length: 960 });
  expect(slices()).toHaveLength(2);
  await expect(memory.getByRole("textbox")).toHaveValue("0x000020A0");
  await expect(page.getByRole("alert")).toHaveCount(0);
});
