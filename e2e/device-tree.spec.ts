import {
  test,
  expect,
  openWorkspace,
  panel,
  pauseFromToolbar,
  registerRow,
  tooltipButton,
  treeItem,
  treeItemRow,
  treeRows,
} from "./support/fixtures";

test("the device tree shows the described nodes, expanded two levels deep", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");

  for (const path of ["dc", "dc.sh4", "dc.holly", "dc.aica"]) {
    await expect(treeItem(page, path)).toHaveAttribute("aria-expanded", "true");
  }
  // registers of expanded nodes, with the values of the first tick
  await expect(registerRow(page, "dc.reg.SYSCLK")).toHaveText(/SYSCLK = 200MHz/);
  await expect(registerRow(page, "dc.reg.ASIC_REV")).toHaveText(/ASIC_REV = 0x0001/);
  await expect(registerRow(page, "dc.holly.reg.HOLLY_ID")).toHaveText(/HOLLY_ID = 0x00050000/);
  await expect(registerRow(page, "dc.aica.reg.AICA_CTRL")).toHaveText(/AICA_CTRL = 0x00000002/);
  // third level is collapsed: its registers are not mounted
  await expect(treeItem(page, "dc.sh4.cpu")).toHaveAttribute("aria-expanded", "false");
  await expect(registerRow(page, "dc.sh4.cpu.reg.PC")).toHaveCount(0);
});

test("expanding a node shows its registers and collapsing hides them", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");

  await treeItemRow(page, "dc.sh4.cpu").click();
  await expect(treeItem(page, "dc.sh4.cpu")).toHaveAttribute("aria-expanded", "true");
  await expect(registerRow(page, "dc.sh4.cpu.reg.PC")).toHaveText(/PC = 0x8C0000A[0-9A-E]/);
  for (const register of ["PR", "VBR", "SR", "FPSCR"]) {
    await expect(registerRow(page, `dc.sh4.cpu.reg.${register}`)).toBeVisible();
  }

  await treeItemRow(page, "dc.sh4.cpu").click();
  await expect(treeItem(page, "dc.sh4.cpu")).toHaveAttribute("aria-expanded", "false");
  await expect(registerRow(page, "dc.sh4.cpu.reg.PC")).toHaveCount(0);

  // nested nodes: PBUS -> BSC (a node with an action and no registers)
  await treeItemRow(page, "dc.sh4.pbus").click();
  await expect(treeItem(page, "dc.sh4.bsc")).toBeVisible();
  await expect(treeItem(page, "dc.sh4.bsc").getByLabel("Open SH4: BSC Registers")).toBeVisible();
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
  // dc.sh4.cpu.pc is one of the server's default watches
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
