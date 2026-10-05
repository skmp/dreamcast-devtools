import {
  test,
  expect,
  openWorkspace,
  panel,
  pauseFromToolbar,
  registerRow,
  tooltipButton,
  treeItemRow,
} from "./support/fixtures";
import type { Locator, Page } from "@playwright/test";

const watchRow = (page: Page, expression: string): Locator =>
  panel(page, "watches").getByRole("listitem").filter({ hasText: `${expression} = ` });

test("the watches the server already has are listed with their values", async ({ page }) => {
  // watches belong to the server: this one was added by another client before the page connected
  await openWorkspace(page, "sh4-debugger");
  await expect(watchRow(page, "dc.sh4.cpu.pc")).toHaveText(/dc\.sh4\.cpu\.pc = 0x8C0000A[0-9A-E]/);
  await expect(panel(page, "watches").getByRole("listitem")).toHaveCount(1);
});

test("the value of a watch follows the target while it runs", async ({ page }) => {
  // watches are evaluated in every tick, and a running server sends one every 200 ms
  await openWorkspace(page, "sh4-debugger");
  const input = panel(page, "watches").getByPlaceholder("Enter expression");
  await input.fill("dc.timing.sh4_cycles");
  await input.press("Enter");
  const row = watchRow(page, "dc.timing.sh4_cycles");
  await expect(row).toHaveText(/dc\.timing\.sh4_cycles = 0x[0-9A-F]{16}$/);
  const value = async () => BigInt((await row.innerText()).split(" = ")[1]);
  const first = await value();
  await expect.poll(value).toBeGreaterThan(first);
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
  await expect(watches.getByRole("listitem")).toHaveCount(3);

  // adding an expression twice does nothing
  await input.fill("dc.holly.dmac.dmaor");
  await input.press("Enter");
  await expect(watches.getByRole("listitem")).toHaveCount(3);
});

test("the server stores an expression in lower case, and refuses one that names no register", async ({ page, rpc }) => {
  await openWorkspace(page, "sh4-debugger");
  const watches = panel(page, "watches");
  const input = watches.getByPlaceholder("Enter expression");

  // the register name is resolved whatever its case
  await input.fill("dc.sh4.cpu.FPSCR");
  await input.press("Enter");
  await expect(watchRow(page, "dc.sh4.cpu.fpscr")).toHaveText("dc.sh4.cpu.fpscr = 0x00040001");
  await expect(watches.getByRole("listitem")).toHaveCount(2);

  // not a register: in-band -32602, shown as a notice, and nothing is added
  await input.fill("dc.sh4.dmac.dmaorx");
  await input.press("Enter");
  await expect(
    page.getByRole("alert").filter({ hasText: 'invalid params: "dc.sh4.dmac.dmaorx" is not a register of the device tree' }),
  ).toBeVisible();
  const refused = rpc.received.find((frame) => frame.id === rpc.requests("state.watch").at(-1)?.id);
  expect(refused?.result).toEqual({
    error: { code: -32602, message: 'invalid params: "dc.sh4.dmac.dmaorx" is not a register of the device tree' },
  });
  await expect(watches.getByRole("listitem")).toHaveCount(2);

  // a register that cannot be read without a side effect is watched as "n/a"
  await input.fill("dc.sh4.scif.scfrdr2");
  await input.press("Enter");
  await expect(watchRow(page, "dc.sh4.scif.scfrdr2")).toHaveText("dc.sh4.scif.scfrdr2 = n/a");
});

test("the expression box suggests the register paths of the device tree", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  const input = panel(page, "watches").getByPlaceholder("Enter expression");

  await input.pressSequentially("dc.aica.dsp");
  const options = page.getByRole("option");
  await expect(options).toHaveText(["dc.aica.dsp.step", "dc.aica.dsp.mdec_ct", "dc.aica.dsp.rbp", "dc.aica.dsp.rbl"]);
});

test("pasting an expression filters the suggestions", async ({ page }) => {
  // regression: the typed text was bound to the Autocomplete's `value`, so MUI considered it
  // "the selected option" and listed every register path on the change that opens the popup
  await openWorkspace(page, "sh4-debugger");
  const input = panel(page, "watches").getByPlaceholder("Enter expression");
  await input.fill("dc.aica.dsp");
  await expect(page.getByRole("option")).toHaveText([
    "dc.aica.dsp.step",
    "dc.aica.dsp.mdec_ct",
    "dc.aica.dsp.rbp",
    "dc.aica.dsp.rbl",
  ]);
});

test("a watch picked from the suggestions shows the register's live value", async ({ page }) => {
  // regression: the suggestions used the upper-case register name ("dc.sh4.cpu.VBR"), which
  // neither the device tree's "+" button nor the server use; such a watch read 0x00000000
  await openWorkspace(page, "sh4-debugger");
  const watches = panel(page, "watches");
  const input = watches.getByPlaceholder("Enter expression");

  // with the mouse
  await input.pressSequentially("dc.holly.dmac.c");
  await page.getByRole("option", { name: "dc.holly.dmac.chcr0", exact: true }).click();
  await expect(input).toHaveValue("dc.holly.dmac.chcr0");
  await input.press("Enter");
  await expect(watchRow(page, "dc.holly.dmac.chcr0")).toHaveText("dc.holly.dmac.chcr0 = 0x00000001");
  await expect(input).toHaveValue("");

  // with the keyboard: Enter on a highlighted suggestion completes the text, Enter again adds it
  await input.pressSequentially("dc.holly.dmac.d");
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(input).toHaveValue("dc.holly.dmac.dmaor");
  await expect(watches.getByRole("listitem")).toHaveCount(2);
  await input.press("Enter");
  await expect(watchRow(page, "dc.holly.dmac.dmaor")).toHaveText("dc.holly.dmac.dmaor = 0x8201");

  // the device tree agrees that both registers are watched now
  await treeItemRow(page, "dc.holly.dmac").click();
  await expect(tooltipButton(registerRow(page, "dc.holly.dmac.reg.CHCR0"), "Already in watch")).toBeDisabled();
  await expect(tooltipButton(registerRow(page, "dc.holly.dmac.reg.DMAOR"), "Already in watch")).toBeDisabled();
});

test("double-clicking the expression renames a watch", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  const watches = panel(page, "watches");

  await watches.getByText("dc.sh4.cpu.pc", { exact: true }).dblclick();
  const editor = watches.getByRole("listitem").getByRole("textbox");
  await expect(editor).toHaveValue("dc.sh4.cpu.pc");
  await editor.fill("dc.holly.dmac.dmaor");
  await editor.press("Enter");

  await expect(watchRow(page, "dc.holly.dmac.dmaor")).toHaveText(/dc\.holly\.dmac\.dmaor = 0x8201/);
  await expect(watchRow(page, "dc.sh4.cpu.pc")).toHaveCount(0);
  await expect(watches.getByRole("listitem")).toHaveCount(1);

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
  await expect(registerRow(page, "dc.sh4.cpu.reg.PC")).toHaveText(/PC = 0x8C0000AC/);
});

test("a rejected edit keeps the editor open and shows the server's error", async ({ page, diagnostics }) => {
  diagnostics.allow(
    /^console\.error: (Failed to edit watch|handleSaveValue failed:)/,
    "debuggerDataStore.editWatch logs the server's refusal with console.error before showing it as a toast",
  );
  await openWorkspace(page, "sh4-debugger");
  const watches = panel(page, "watches");
  // a text register: it can be watched, and it cannot be written
  const input = watches.getByPlaceholder("Enter expression");
  await input.fill("dc.sysclk");
  await input.press("Enter");

  await watchRow(page, "dc.sysclk").getByText("200MHz", { exact: true }).dblclick();
  const editor = watches.getByRole("listitem").getByRole("textbox");
  await editor.fill("100MHz");
  await editor.press("Enter");

  await expect(page.getByRole("alert").filter({ hasText: "not writable: dc.SYSCLK" })).toBeVisible();
  await expect(editor).toBeVisible();
  await editor.press("Escape");
  await expect(watchRow(page, "dc.sysclk")).toHaveText("dc.sysclk = 200MHz");
});

test("the delete button removes a watch", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  const watches = panel(page, "watches");

  const input = watches.getByPlaceholder("Enter expression");
  await input.fill("dc.holly.dmac.dmaor");
  await input.press("Enter");
  await expect(watches.getByRole("listitem")).toHaveCount(2);

  await watches.getByRole("button", { name: "Remove dc.holly.dmac.dmaor" }).click();
  await expect(watchRow(page, "dc.holly.dmac.dmaor")).toHaveCount(0);
  await expect(watches.getByRole("listitem")).toHaveCount(1);

  await watches.getByRole("button", { name: "Remove dc.sh4.cpu.pc" }).click();
  await expect(watches.getByText("No watches subscribed.")).toBeVisible();
});
