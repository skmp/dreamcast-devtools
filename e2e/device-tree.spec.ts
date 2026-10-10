import {
  test,
  expect,
  disassemblyRows,
  gotoRoute,
  openWorkspace,
  panel,
  pauseFromToolbar,
  registerRow,
  saveScreenshot,
  statusBar,
  tooltipButton,
  treeItem,
  treeItemRow,
  treeRows,
} from "./support/fixtures";
import { serveScriptedDebugger } from "./support/scriptedDebugger";

test("the device tree shows the described nodes, expanded two levels deep", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");

  for (const path of ["dc", "dc.sh4", "dc.holly", "dc.aica", "dc.system"]) {
    await expect(treeItem(page, path)).toHaveAttribute("aria-expanded", "true");
  }
  // registers of expanded nodes, with the values of the first tick: free text, not hex
  await expect(registerRow(page, "dc.reg.SYSCLK")).toHaveText(/SYSCLK = 200MHz/);
  await expect(registerRow(page, "dc.reg.BUILD")).toHaveText(/BUILD = nullDC 3\.0\.0 mock/);
  // the nodes of the second level have no registers of their own, so these are all rows there are
  await expect(panel(page, "device-tree").locator("[data-register]")).toHaveCount(2);
  for (const path of ["dc.sh4.cpu", "dc.sh4.pbus", "dc.holly.intc", "dc.aica.arm7", "dc.aica.dsp", "dc.timing", "dc.gdrom"]) {
    await expect(treeItem(page, path)).toBeVisible();
  }
  // third level is collapsed: its registers are not mounted
  await expect(treeItem(page, "dc.sh4.cpu")).toHaveAttribute("aria-expanded", "false");
  await expect(registerRow(page, "dc.sh4.cpu.reg.PC")).toHaveCount(0);
});

test("expanding a node shows its registers and collapsing hides them", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");

  await treeItemRow(page, "dc.sh4.cpu").click();
  await expect(treeItem(page, "dc.sh4.cpu")).toHaveAttribute("aria-expanded", "true");
  await expect(registerRow(page, "dc.sh4.cpu.reg.PC")).toHaveText(/PC = 0x8C0000A[0-9A-E]/);
  for (const register of ["PR", "VBR", "SR", "FPSCR", "R0", "R15", "R7_BANK", "FR15", "XF15"]) {
    await expect(registerRow(page, `dc.sh4.cpu.reg.${register}`)).toBeVisible();
  }
  // 13 control registers, R0..R15, R0_BANK..R7_BANK, FR0..FR15, XF0..XF15
  await expect(panel(page, "device-tree").locator('[data-register^="dc.sh4.cpu.reg."]')).toHaveCount(69);

  await treeItemRow(page, "dc.sh4.cpu").click();
  await expect(treeItem(page, "dc.sh4.cpu")).toHaveAttribute("aria-expanded", "false");
  await expect(registerRow(page, "dc.sh4.cpu.reg.PC")).toHaveCount(0);

  // nested nodes: PBUS -> BSC (a node with an action), PBUS -> SCIF with a register that cannot be read
  await treeItemRow(page, "dc.sh4.pbus").click();
  await expect(treeItem(page, "dc.sh4.bsc")).toBeVisible();
  await expect(treeItem(page, "dc.sh4.bsc").getByLabel("Open SH4: BSC Registers")).toBeVisible();
  await treeItemRow(page, "dc.sh4.scif").click();
  await expect(registerRow(page, "dc.sh4.scif.reg.SCFSR2")).toHaveText(/SCFSR2 = 0x0060/);
  await expect(registerRow(page, "dc.sh4.scif.reg.SCFRDR2")).toHaveText(/SCFRDR2 = n\/a/);
});

test("register values follow the ticks", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  await treeItemRow(page, "dc.sh4.cpu").click();
  await pauseFromToolbar(page);

  const pc = registerRow(page, "dc.sh4.cpu.reg.PC");
  const before = (await pc.innerText()).trim();
  expect(before).toMatch(/^PC = 0x8C0000A[02468ACE]$/);

  // every step makes the server send a tick with the next PC of its 8-instruction loop
  const disassembly = panel(page, "sh4-disassembly");
  await tooltipButton(disassembly, "Step In").click();
  const expected = (value: string) => {
    const address = Number.parseInt(value.replace("PC = ", ""), 16);
    const next = 0x8c0000a0 + ((address - 0x8c0000a0 + 2) % 16);
    return `PC = 0x${next.toString(16).toUpperCase()}`;
  };
  await expect(pc).toHaveText(expected(before));
  await tooltipButton(disassembly, "Step In").click();
  await expect(pc).toHaveText(expected(expected(before)));
  // registers that did not change keep their value
  await expect(registerRow(page, "dc.sh4.cpu.reg.VBR")).toHaveText(/VBR = 0x8C000000/);
});

test("while the target runs, the registers of an expanded node follow the periodic ticks", async ({ page, rpc }) => {
  // the server sends a tick every 200 ms while it runs; nothing has to be clicked for it
  await openWorkspace(page, "sh4-debugger");
  await treeItemRow(page, "dc.sh4.cpu").click();
  await treeItemRow(page, "dc.timing").click();
  const cycles = registerRow(page, "dc.timing.reg.SH4_CYCLES");
  await expect(cycles).toHaveText(/SH4_CYCLES = 0x[0-9A-F]{16}$/);
  const value = async () => BigInt((await cycles.innerText()).replace("SH4_CYCLES = ", ""));
  const first = await value();
  await expect.poll(value).toBeGreaterThan(first);
  const second = await value();
  await expect.poll(value).toBeGreaterThan(second);
  // PR counts up as well, and the ticks came without a request that would have caused them
  const pr = registerRow(page, "dc.sh4.cpu.reg.PR");
  const before = await pr.innerText();
  await expect(pr).not.toHaveText(before);
  const ticks = rpc.received.filter((frame) => frame.method === "event.tick");
  expect(ticks.length).toBeGreaterThan(3);
  expect(rpc.sent.map((frame) => frame.method)).not.toContain("control.pause");
});

test("the + button of a register adds a watch and then reports it as watched", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  await treeItemRow(page, "dc.sh4.cpu").click();

  const watches = panel(page, "watches");
  await expect(watches.getByText(/^dc\.sh4\.cpu\.pr = /)).toHaveCount(0);

  const row = registerRow(page, "dc.sh4.cpu.reg.PR");
  await tooltipButton(row, "Add to watch").click();

  // PR keeps counting up while the mock runs
  await expect(watches.getByText(/^dc\.sh4\.cpu\.pr = 0x8C00[0-9A-F]{4}$/)).toBeVisible();
  await expect(tooltipButton(row, "Already in watch")).toBeDisabled();
  // dc.sh4.cpu.pc is the watch the suite's server starts with
  await expect(tooltipButton(registerRow(page, "dc.sh4.cpu.reg.PC"), "Already in watch")).toBeDisabled();
});

test("the + button of a register is pressed with Enter and Space, and the node stays as it is", async ({ page }) => {
  // The tree view takes a key pressed anywhere inside a tree item for a key of that item.
  // While registers were tree items it swallowed Enter and Space on their buttons; without
  // the guard on the register list, Enter would collapse the node instead.
  await openWorkspace(page, "sh4-debugger");
  await treeItemRow(page, "dc.sh4.cpu").click();
  // the click selected the node; Space on one of its items would toggle that
  await expect(treeItem(page, "dc.sh4.cpu")).toHaveAttribute("aria-selected", "true");
  const watches = panel(page, "watches");

  await tooltipButton(registerRow(page, "dc.sh4.cpu.reg.PR"), "Add to watch").focus();
  await page.keyboard.press("Enter");
  await expect(watches.getByText(/^dc\.sh4\.cpu\.pr = 0x8C00[0-9A-F]{4}$/)).toBeVisible();

  await tooltipButton(registerRow(page, "dc.sh4.cpu.reg.SR"), "Add to watch").focus();
  await page.keyboard.press("Space");
  await expect(watches.getByText(/^dc\.sh4\.cpu\.sr = /)).toBeVisible();

  await expect(treeItem(page, "dc.sh4.cpu")).toHaveAttribute("aria-expanded", "true");
  await expect(treeItem(page, "dc.sh4.cpu")).toHaveAttribute("aria-selected", "true");
  await expect(tooltipButton(registerRow(page, "dc.sh4.cpu.reg.PR"), "Already in watch")).toBeDisabled();
  await expect(tooltipButton(registerRow(page, "dc.sh4.cpu.reg.SR"), "Already in watch")).toBeDisabled();
});

test("the arrow keys move through the nodes of the tree", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  // dc.sh4 is expanded and has no registers of its own; its first child is dc.sh4.cpu
  await treeItemRow(page, "dc.sh4.cpu").click();
  await expect(treeItem(page, "dc.sh4.cpu")).toBeFocused();
  await expect(registerRow(page, "dc.sh4.cpu.reg.PC")).toBeVisible();

  // registers are not stops: the next node follows
  await page.keyboard.press("ArrowDown");
  await expect(treeItem(page, "dc.sh4.pbus")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(treeItem(page, "dc.sh4.cpu")).toBeFocused();
  // left collapses, right expands
  await page.keyboard.press("ArrowLeft");
  await expect(treeItem(page, "dc.sh4.cpu")).toHaveAttribute("aria-expanded", "false");
  await expect(registerRow(page, "dc.sh4.cpu.reg.PC")).toHaveCount(0);
  await page.keyboard.press("ArrowRight");
  await expect(treeItem(page, "dc.sh4.cpu")).toHaveAttribute("aria-expanded", "true");
  await expect(registerRow(page, "dc.sh4.cpu.reg.PC")).toBeVisible();
});

test("the search box filters the tree and expands the matches", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  const search = panel(page, "device-tree").getByPlaceholder("Search components...");

  await search.fill("arm7");
  await expect(treeItem(page, "dc.aica.arm7")).toHaveAttribute("aria-expanded", "true");
  await expect(registerRow(page, "dc.aica.arm7.reg.PC")).toHaveText(/PC = 0x002000[0-9A-F]{2}/);
  await expect(treeItem(page, "dc.sh4")).toHaveCount(0);
  await expect(treeItem(page, "dc.holly")).toHaveCount(0);

  // words narrow down level by level: node, then register
  await search.fill("sh4 core fpscr");
  await expect(registerRow(page, "dc.sh4.cpu.reg.FPSCR")).toBeVisible();
  await expect(registerRow(page, "dc.sh4.cpu.reg.PC")).toHaveCount(0);

  await search.fill("no-such-component");
  await expect(treeRows(page)).toHaveCount(0);

  await search.fill("");
  await expect(treeItem(page, "dc.sh4")).toHaveAttribute("aria-expanded", "true");
  await expect(treeItem(page, "dc.holly")).toHaveAttribute("aria-expanded", "true");
});

test("nodes the user expanded stay expanded after a search", async ({ page }) => {
  // regression: the expanded set was derived from the search text and the tree remounted
  // whenever it changed, so clearing a search reset the tree to "first two levels"
  await openWorkspace(page, "sh4-debugger");
  await treeItemRow(page, "dc.sh4.cpu").click();
  await treeItemRow(page, "dc.holly").click();
  await expect(treeItem(page, "dc.sh4.cpu")).toHaveAttribute("aria-expanded", "true");
  await expect(treeItem(page, "dc.holly")).toHaveAttribute("aria-expanded", "false");

  const search = panel(page, "device-tree").getByPlaceholder("Search components...");
  await search.fill("arm7");
  await expect(treeItem(page, "dc.sh4")).toHaveCount(0);
  await search.fill("");

  await expect(treeItem(page, "dc.sh4.cpu")).toHaveAttribute("aria-expanded", "true");
  await expect(registerRow(page, "dc.sh4.cpu.reg.PC")).toBeVisible();
  await expect(treeItem(page, "dc.holly")).toHaveAttribute("aria-expanded", "false");
});

test("every node shows its description, whether it has buttons or not", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  // without actions
  await expect(treeItemRow(page, "dc.sh4.pbus")).toHaveText("PBUSPeripherals Bus");
  await expect(treeItemRow(page, "dc.holly.intc")).toHaveText("INTCInterrupt Controller");
  // with actions: the description is in the row as well (it was a tooltip only), in front of the buttons
  await expect(treeItemRow(page, "dc.sh4.cpu").getByText("SuperH4 CPU Core", { exact: true })).toBeVisible();
  await expect(treeItemRow(page, "dc.sh4.cpu").getByLabel("Open SH4: Disassembly")).toBeVisible();
  await expect(treeItemRow(page, "dc.sh4.cpu").getByLabel("Open SH4: Memory")).toBeVisible();
  await expect(treeItemRow(page, "dc.aica.sgc").getByText("Sound Generation Core", { exact: true })).toBeVisible();
  await expect(treeItemRow(page, "dc.aica.sgc").getByLabel("Open SGC")).toBeVisible();
  // one that is too long for the dock is cut, and can be read in full
  await treeItemRow(page, "dc.sh4.pbus").click();
  await expect(treeItemRow(page, "dc.sh4.scif").getByText("Serial Communications Interface w/ FIFO", { exact: true })).toHaveAttribute(
    "title",
    "Serial Communications Interface w/ FIFO",
  );
  await expect(treeItemRow(page, "dc.sh4.scif").getByLabel("Open SH4: SCIF Registers")).toBeVisible();
});

test("a panel the server names and this build does not have is no button, and breaks nothing", async ({ page }) => {
  // `actions` are open strings: a newer server may name panels of a newer UI
  const server = await serveScriptedDebugger(page);
  const core = ((server.shape.deviceTree as Array<{ children: Array<{ children: Array<{ path: string; actions: string[] }> }> }>)[0]
    .children[0].children).find((node) => node.path === "dc.sh4.cpu")!;
  core.actions = ["sh4-pipeline", "sh4-disassembly", "hologram-viewer"];
  await gotoRoute(page, "/workspace/sh4-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");

  const row = treeItemRow(page, "dc.sh4.cpu");
  await expect(row.getByLabel("Open SH4: Disassembly")).toBeVisible();
  await expect(row.getByRole("button")).toHaveCount(1);
  await expect(row.getByText("Core of the scripted server", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test.describe("a core that does not report its registers while it runs", () => {
  test.use({ mockOptions: { sliceContext: false } });

  test("the SH4 registers are dimmed while they are stale, and the disassembly opens at the default address", async ({
    page,
    rpc,
  }, testInfo) => {
    await openWorkspace(page, "sh4-debugger");
    // no tick so far carried dc.sh4.cpu, so nobody knows where the SH4 is: the view opens at
    // `defaultDisassemblyAddress` of the target
    const view = panel(page, "sh4-disassembly");
    await expect(disassemblyRows(view).first()).toHaveAttribute("data-address", String(0x8c010000));
    const firstTick = rpc.received.find((frame) => frame.method === "event.tick")?.params as {
      registers: Record<string, unknown>;
      executionState: Record<string, unknown>;
    };
    expect(firstTick.executionState).toMatchObject({ state: "running", registersStale: true });
    expect(Object.keys(firstTick.registers)).not.toContain("dc.sh4.cpu");

    // the registers of the node are those of debugger.describe, and marked as not live
    await treeItemRow(page, "dc.sh4.cpu").click();
    await treeItemRow(page, "dc.aica.arm7").click();
    const stale = panel(page, "device-tree").locator(".device-tree-registers[data-stale]");
    await expect(stale).toHaveCount(1);
    await expect(stale.locator('[data-register="dc.sh4.cpu.reg.PC"]')).toBeVisible();
    await expect(stale).toHaveCSS("opacity", "0.45");
    await expect(stale).toHaveAttribute("title", "Values of the last stop: the running core does not report its registers");
    // the ARM7 is reported as ever
    await expect(registerRow(page, "dc.aica.arm7.reg.PC").locator("xpath=..")).not.toHaveAttribute("data-stale");
    // and a watch on such a register reads n/a meanwhile
    await expect(panel(page, "watches")).toContainText("dc.sh4.cpu.pc = n/a");
    await saveScreenshot(page, testInfo, "device-tree-stale-registers");

    // stopped, the context is complete: live again, and the view goes where the SH4 is
    await pauseFromToolbar(page);
    await expect(panel(page, "device-tree").locator(".device-tree-registers[data-stale]")).toHaveCount(0);
    await expect(registerRow(page, "dc.sh4.cpu.reg.PC")).toHaveText(/PC = 0x8C0000A[02468ACE]/);
    await expect(panel(page, "watches")).toContainText(/dc\.sh4\.cpu\.pc = 0x8C0000A/);
    await expect(view.locator(".current-instruction")).toHaveCount(1);

    // running again: dimmed again, with the values of that stop
    await tooltipButton(page, "Run").click();
    await expect(panel(page, "device-tree").locator(".device-tree-registers[data-stale]")).toHaveCount(1);
    await expect(registerRow(page, "dc.sh4.cpu.reg.PC")).toHaveText(/PC = 0x8C0000A[02468ACE]/);
  });
});

test("a search that matches most of the tree shows its first 200 rows, and says how many there are", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  const tree = panel(page, "device-tree");
  const search = tree.getByPlaceholder("Search components...");

  // every node of the mock is under "dc": all of the tree matches
  await search.fill("dc");
  await expect(tree.getByRole("status")).toHaveText(/^Showing the first 200 of \d{3} matching rows\. Refine your search to see the rest\.$/);
  await expect(treeRows(page)).toHaveCount(200);
  // the values of what is shown are live
  await expect(registerRow(page, "dc.sh4.cpu.reg.PC")).toHaveText(/PC = 0x8C0000A[0-9A-E]/);

  // a search that matches less has no such notice
  await search.fill("arm7");
  await expect(tree.getByRole("status")).toHaveCount(0);
  expect(await treeRows(page).count()).toBeLessThan(200);
});
