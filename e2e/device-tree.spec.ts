import {
  test,
  expect,
  openWorkspace,
  panel,
  pauseFromToolbar,
  tooltipButton,
  treeItem,
  treeItemRow,
} from "./support/fixtures";

test("the device tree shows the described nodes, expanded two levels deep", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");

  for (const path of ["dc", "dc.sh4", "dc.holly", "dc.aica"]) {
    await expect(treeItem(page, path)).toHaveAttribute("aria-expanded", "true");
  }
  // registers of expanded nodes, with the values of the first tick
  await expect(treeItemRow(page, "dc.reg.SYSCLK")).toHaveText(/SYSCLK = 200MHz/);
  await expect(treeItemRow(page, "dc.reg.ASIC_REV")).toHaveText(/ASIC_REV = 0x0001/);
  await expect(treeItemRow(page, "dc.holly.reg.HOLLY_ID")).toHaveText(/HOLLY_ID = 0x00050000/);
  await expect(treeItemRow(page, "dc.aica.reg.AICA_CTRL")).toHaveText(/AICA_CTRL = 0x00000002/);
  // third level is collapsed: its registers are not mounted
  await expect(treeItem(page, "dc.sh4.cpu")).toHaveAttribute("aria-expanded", "false");
  await expect(treeItem(page, "dc.sh4.cpu.reg.PC")).toHaveCount(0);
});

test("expanding a node shows its registers and collapsing hides them", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");

  await treeItemRow(page, "dc.sh4.cpu").click();
  await expect(treeItem(page, "dc.sh4.cpu")).toHaveAttribute("aria-expanded", "true");
  await expect(treeItemRow(page, "dc.sh4.cpu.reg.PC")).toHaveText(/PC = 0x8C0000A[0-9A-E]/);
  for (const register of ["PR", "VBR", "SR", "FPSCR"]) {
    await expect(treeItemRow(page, `dc.sh4.cpu.reg.${register}`)).toBeVisible();
  }

  await treeItemRow(page, "dc.sh4.cpu").click();
  await expect(treeItem(page, "dc.sh4.cpu")).toHaveAttribute("aria-expanded", "false");
  await expect(treeItem(page, "dc.sh4.cpu.reg.PC")).toHaveCount(0);

  // nested nodes: PBUS -> BSC (a node with an action and no registers)
  await treeItemRow(page, "dc.sh4.pbus").click();
  await expect(treeItem(page, "dc.sh4.bsc")).toBeVisible();
  await expect(treeItem(page, "dc.sh4.bsc").getByLabel("Open SH4: BSC Registers")).toBeVisible();
});

test("register values follow the ticks", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  await treeItemRow(page, "dc.sh4.cpu").click();
  await pauseFromToolbar(page);

  const pc = treeItemRow(page, "dc.sh4.cpu.reg.PC");
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
  await expect(treeItemRow(page, "dc.sh4.cpu.reg.VBR")).toHaveText(/VBR = 0x8C000000/);
});

test("the + button of a register adds a watch and then reports it as watched", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  await treeItemRow(page, "dc.sh4.cpu").click();

  const watches = panel(page, "watches");
  await expect(watches.getByText(/^dc\.sh4\.cpu\.pr = /)).toHaveCount(0);

  const row = treeItemRow(page, "dc.sh4.cpu.reg.PR");
  await tooltipButton(row, "Add to watch").click();

  // PR keeps counting up while the mock runs
  await expect(watches.getByText(/^dc\.sh4\.cpu\.pr = 0x8C00[0-9A-F]{4}$/)).toBeVisible();
  await expect(tooltipButton(row, "Already in watch")).toBeDisabled();
  // dc.sh4.cpu.pc is one of the server's default watches
  await expect(tooltipButton(treeItemRow(page, "dc.sh4.cpu.reg.PC"), "Already in watch")).toBeDisabled();
});

test("the search box filters the tree and expands the matches", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  const search = panel(page, "device-tree").getByPlaceholder("Search components...");

  await search.fill("arm7");
  await expect(treeItem(page, "dc.aica.arm7")).toHaveAttribute("aria-expanded", "true");
  await expect(treeItemRow(page, "dc.aica.arm7.reg.PC")).toHaveText(/PC = 0x002000[0-9A-F]{2}/);
  await expect(treeItem(page, "dc.sh4")).toHaveCount(0);
  await expect(treeItem(page, "dc.holly")).toHaveCount(0);

  // words narrow down level by level: node, then register
  await search.fill("sh4 core fpscr");
  await expect(treeItemRow(page, "dc.sh4.cpu.reg.FPSCR")).toBeVisible();
  await expect(treeItem(page, "dc.sh4.cpu.reg.PC")).toHaveCount(0);

  await search.fill("no-such-component");
  await expect(panel(page, "device-tree").getByRole("treeitem")).toHaveCount(0);

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
  await expect(treeItemRow(page, "dc.sh4.cpu.reg.PC")).toBeVisible();
  await expect(treeItem(page, "dc.holly")).toHaveAttribute("aria-expanded", "false");
});
