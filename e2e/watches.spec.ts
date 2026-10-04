import { test, expect, openWorkspace, panel, pauseFromToolbar, treeItemRow } from "./support/fixtures";
import type { Locator, Page } from "@playwright/test";

const watchRow = (page: Page, expression: string): Locator =>
  panel(page, "watches").getByRole("listitem").filter({ hasText: `${expression} = ` });

test("the watches the server already has are listed with their values", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  await expect(watchRow(page, "dc.sh4.cpu.pc")).toHaveText(/dc\.sh4\.cpu\.pc = 0x8C0000A[0-9A-E]/);
  // not a register of the mock (its DMAOR lives under dc.holly.dmac): unknown expressions read as zero
  await expect(watchRow(page, "dc.sh4.dmac.dmaor")).toHaveText(/dc\.sh4\.dmac\.dmaor = 0x00000000/);
  await expect(panel(page, "watches").getByRole("listitem")).toHaveCount(2);
});

test("a watch can be added with Enter and with the Add Watch button", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  const watches = panel(page, "watches");
  const input = watches.getByPlaceholder("Enter expression");

  await input.fill("dc.aica.arm7.pc");
  await input.press("Enter");
  await expect(watchRow(page, "dc.aica.arm7.pc")).toHaveText(/dc\.aica\.arm7\.pc = 0x002000[0-9A-F]{2}/);
  await expect(input).toHaveValue("");

  await input.fill("dc.holly.dmac.dmaor");
  await watches.getByRole("button", { name: "Add Watch" }).click();
  await expect(watchRow(page, "dc.holly.dmac.dmaor")).toHaveText(/dc\.holly\.dmac\.dmaor = 0x8201/);
  await expect(watches.getByRole("listitem")).toHaveCount(4);

  // adding an expression twice does nothing
  await input.fill("dc.holly.dmac.dmaor");
  await input.press("Enter");
  await expect(watches.getByRole("listitem")).toHaveCount(4);
});

test("the expression box suggests the register paths of the device tree", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  const input = panel(page, "watches").getByPlaceholder("Enter expression");

  // typed key by key: see the fixme below for what happens when the text arrives in one go
  await input.pressSequentially("dc.aica.dsp");
  const options = page.getByRole("option");
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toHaveText(/^dc\.aica\.dsp\.step$/i);
  await expect(options.nth(1)).toHaveText(/^dc\.aica\.dsp\.dsp_acc$/i);
});

test.fixme("pasting an expression filters the suggestions", async ({ page }) => {
  // BROKEN: WatchesPanel binds the typed text to the Autocomplete's `value` (not `inputValue`),
  // so MUI considers the text "the selected option" and, on the change that opens the popup,
  // lists every register path instead of the matching ones.
  await openWorkspace(page, "sh4-debugger");
  const input = panel(page, "watches").getByPlaceholder("Enter expression");
  await input.fill("dc.aica.dsp");
  await expect(page.getByRole("option")).toHaveCount(2);
});

test.fixme("a watch picked from the suggestions shows the register's live value", async ({ page }) => {
  // BROKEN: WatchesPanel offers `${path}.${NAME}` with the register name in upper case
  // ("dc.sh4.cpu.PC"), while the device tree's "+" button and the server use lower case
  // ("dc.sh4.cpu.pc"). The suggested expression resolves to nothing and reads 0x00000000.
  await openWorkspace(page, "sh4-debugger");
  const input = panel(page, "watches").getByPlaceholder("Enter expression");
  await input.pressSequentially("dc.sh4.cpu.v");
  await page.getByRole("option").first().click();
  await input.press("Enter");
  await expect(watchRow(page, "dc.sh4.cpu.vbr")).toHaveText(/dc\.sh4\.cpu\.vbr = 0x8C000000/i);
});

test("double-clicking the expression renames a watch", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  const watches = panel(page, "watches");

  await watches.getByText("dc.sh4.dmac.dmaor", { exact: true }).dblclick();
  const editor = watches.getByRole("listitem").getByRole("textbox");
  await expect(editor).toHaveValue("dc.sh4.dmac.dmaor");
  await editor.fill("dc.holly.dmac.dmaor");
  await editor.press("Enter");

  await expect(watchRow(page, "dc.holly.dmac.dmaor")).toHaveText(/dc\.holly\.dmac\.dmaor = 0x8201/);
  await expect(watchRow(page, "dc.sh4.dmac.dmaor")).toHaveCount(0);
  await expect(watches.getByRole("listitem")).toHaveCount(2);

  // Escape leaves the watch alone
  await watches.getByText("dc.holly.dmac.dmaor", { exact: true }).dblclick();
  await watches.getByRole("listitem").getByRole("textbox").fill("dc.nothing");
  await watches.getByRole("listitem").getByRole("textbox").press("Escape");
  await expect(watchRow(page, "dc.holly.dmac.dmaor")).toBeVisible();
});

test("double-clicking the value writes the register behind a watch", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  await pauseFromToolbar(page);
  await treeItemRow(page, "dc.sh4.cpu").click();
  const watches = panel(page, "watches");

  await watchRow(page, "dc.sh4.cpu.pc").getByText(/^0x8C0000A[0-9A-E]$/).dblclick();
  const editor = watches.getByRole("listitem").getByRole("textbox");
  await editor.fill("0x8C0000AC");
  await editor.press("Enter");

  await expect(watchRow(page, "dc.sh4.cpu.pc")).toHaveText(/dc\.sh4\.cpu\.pc = 0x8C0000AC/);
  await expect(treeItemRow(page, "dc.sh4.cpu.reg.PC")).toHaveText(/PC = 0x8C0000AC/);
});

test("a rejected edit keeps the editor open and shows the server's error", async ({ page, diagnostics }) => {
  diagnostics.allow(
    /^console\.error: (Failed to edit watch|handleSaveValue failed:)/,
    "debuggerDataStore.editWatch logs the server's refusal with console.error before showing it as a toast",
  );
  await openWorkspace(page, "sh4-debugger");
  const watches = panel(page, "watches");

  await watchRow(page, "dc.sh4.dmac.dmaor").getByText("0x00000000", { exact: true }).dblclick();
  const editor = watches.getByRole("listitem").getByRole("textbox");
  await editor.fill("0x1");
  await editor.press("Enter");

  await expect(page.getByRole("alert").filter({ hasText: 'Cannot edit non-register expression "dc.sh4.dmac.dmaor"' })).toBeVisible();
  await expect(editor).toBeVisible();
  await editor.press("Escape");
  await expect(watchRow(page, "dc.sh4.dmac.dmaor")).toHaveText(/= 0x00000000/);
});

test("the delete button removes a watch", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  const watches = panel(page, "watches");

  await watches.getByRole("button", { name: "Remove dc.sh4.dmac.dmaor" }).click();
  await expect(watchRow(page, "dc.sh4.dmac.dmaor")).toHaveCount(0);
  await expect(watches.getByRole("listitem")).toHaveCount(1);

  await watches.getByRole("button", { name: "Remove dc.sh4.cpu.pc" }).click();
  await expect(watches.getByText("No watches subscribed.")).toBeVisible();
});
