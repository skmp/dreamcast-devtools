import {
  test,
  expect,
  gotoRoute,
  holdResponses,
  openWorkspace,
  panel,
  pauseFromToolbar,
  registerRow,
  tooltipButton,
  treeItemRow,
} from "./support/fixtures";
import type { Locator, Page } from "@playwright/test";
import { serveScriptedDebugger, type Json } from "./support/scriptedDebugger";
import { MOCK_M2_SUPPORT } from "../server/mockDebugger";

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

test("a rejected edit keeps the editor open and shows the server's error", async ({ page, rpc }) => {
  await openWorkspace(page, "sh4-debugger");
  await pauseFromToolbar(page);
  const watches = panel(page, "watches");
  const editor = watches.getByRole("listitem").getByRole("textbox");

  // a value the device refuses: nothing executes at an odd address (-32013)
  await watchRow(page, "dc.sh4.cpu.pc").getByText(/^0x8C0000A[0-9A-E]$/).dblclick();
  await expect(editor).toHaveAccessibleName("New value of dc.sh4.cpu.pc");
  await editor.fill("0x8C0000A1");
  await editor.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "not writable: dc.sh4.cpu.PC = 0x8C0000A1: the address is odd" })).toBeVisible();
  await expect(editor).toBeVisible();
  await expect(editor).toHaveValue("0x8C0000A1");
  await expect(editor).toHaveAttribute("aria-invalid", "true");
  // a text that is no number (-32602)
  await editor.fill("nowhere");
  await editor.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: 'invalid params: value: "nowhere" is neither 0x hex nor decimal' })).toBeVisible();
  await expect(editor).toHaveValue("nowhere");
  expect(rpc.requests("state.editWatch")).toHaveLength(2);

  await editor.press("Escape");
  await expect(editor).toHaveCount(0);
  await expect(watchRow(page, "dc.sh4.cpu.pc")).toHaveText(/dc\.sh4\.cpu\.pc = 0x8C0000A[0-9A-E]$/);
});

test("the value of a watch is an editor while the target is paused only, and one that is open goes when the target runs again", async ({ page, rpc }) => {
  await openWorkspace(page, "sh4-debugger");
  const watches = panel(page, "watches");
  const input = watches.getByPlaceholder("Enter expression");
  // a register the running target does not change
  await input.fill("dc.sh4.cpu.gbr");
  await input.press("Enter");
  const value = watchRow(page, "dc.sh4.cpu.gbr").getByText("0x8C000000", { exact: true });
  const editor = watches.getByRole("listitem").getByRole("textbox");

  // running: the value says why it is none, and a double click opens nothing
  await expect(value).toHaveAttribute("title", "Read-only while the target runs: pause it to write the register");
  await value.dblclick();
  await expect(editor).toHaveCount(0);
  // the expression is no write: it can be changed in either state
  await watches.getByText("dc.sh4.cpu.gbr", { exact: true }).dblclick();
  await expect(editor).toHaveValue("dc.sh4.cpu.gbr");
  await editor.press("Escape");

  await pauseFromToolbar(page);
  await expect(value).toHaveAttribute("title", "Double-click to write the register");
  await value.dblclick();
  await editor.fill("0x8C00FF00");
  await tooltipButton(page, "Run").click();
  await expect(tooltipButton(page, "Pause")).toBeEnabled();
  await expect(editor).toHaveCount(0);
  await pauseFromToolbar(page);
  await expect(editor).toHaveCount(0);
  await expect(watchRow(page, "dc.sh4.cpu.gbr")).toHaveText("dc.sh4.cpu.gbr = 0x8C000000");
  expect(rpc.requests("state.editWatch")).toEqual([]);
});

test("a watch on a register without a writer is no editor: free text, and a register that cannot be read", async ({ page, rpc }) => {
  await openWorkspace(page, "sh4-debugger");
  await pauseFromToolbar(page);
  const watches = panel(page, "watches");
  const input = watches.getByPlaceholder("Enter expression");
  for (const expression of ["dc.sysclk", "dc.sh4.scif.scfrdr2"]) {
    await input.fill(expression);
    await input.press("Enter");
  }
  for (const [expression, text] of [
    ["dc.sysclk", "200MHz"],
    ["dc.sh4.scif.scfrdr2", "n/a"],
  ]) {
    const value = watchRow(page, expression).getByText(text, { exact: true });
    await expect(value).toHaveAttribute("title", "Read-only: the server has no writer for this register");
    await value.dblclick();
    await expect(watches.getByRole("listitem").getByRole("textbox")).toHaveCount(0);
  }
  // the one beside them is
  await expect(watchRow(page, "dc.sh4.cpu.pc").getByText(/^0x8C0000A[0-9A-E]$/)).toHaveAttribute("title", "Double-click to write the register");
  expect(rpc.requests("state.editWatch")).toEqual([]);
});

test("an answer that is late: the editor waits with what was typed, sends nothing more, and closes when the server has accepted", async ({ page }) => {
  const held = await holdResponses(page, "state.editWatch");
  await openWorkspace(page, "sh4-debugger");
  await pauseFromToolbar(page);
  const watches = panel(page, "watches");
  const editor = watches.getByRole("listitem").getByRole("textbox");

  await watchRow(page, "dc.sh4.cpu.pc").getByText(/^0x8C0000A[0-9A-E]$/).dblclick();
  await editor.fill("0x8C0000A8");
  await editor.press("Enter");
  await expect.poll(held.held).toBe(1);
  await expect(editor).toHaveValue("0x8C0000A8");
  await expect(editor).toHaveAttribute("aria-busy", "true");
  await editor.press("Enter");
  await editor.press("Enter");
  await page.waitForTimeout(300);
  expect(held.requests("state.editWatch")).toHaveLength(1);

  held.release();
  await expect(editor).toHaveCount(0);
  await expect(watchRow(page, "dc.sh4.cpu.pc")).toHaveText("dc.sh4.cpu.pc = 0x8C0000A8");
  expect(held.requests("state.editWatch")).toHaveLength(1);
});

test.describe("a server that can do what the emulator of milestone M2 can, and no more", () => {
  test.use({ mockOptions: { supports: MOCK_M2_SUPPORT, startPaused: true, graceMs: 600_000 } });

  test("a watch on a register of the two processors is an editor; one on any other register is not, and nothing is sent that the server refuses by rule", async ({
    page,
    rpc,
  }) => {
    await openWorkspace(page, "sh4-debugger");
    const watches = panel(page, "watches");
    const input = watches.getByPlaceholder("Enter expression");
    const editor = watches.getByRole("listitem").getByRole("textbox");
    const WRITTEN = ["dc.sh4.cpu.r4", "dc.aica.arm7.r2"];
    // ENABLED of the ARM7, an on-chip module, the system bus, a channel, the DSP and the time
    const READ = ["dc.aica.arm7.enabled", "dc.sh4.tmu.tcor0", "dc.holly.sb.g2.sb_g2id", "dc.aica.sgc.5.vol", "dc.aica.dsp.rbl", "dc.timing.sh4_cycles"];
    for (const expression of [...WRITTEN, ...READ]) {
      await input.fill(expression);
      await input.press("Enter");
      await expect(watchRow(page, expression)).toBeVisible();
    }

    for (const expression of READ) {
      const value = watchRow(page, expression).locator("span[title]");
      await expect(value, expression).toHaveAttribute("title", "Read-only: the server has no writer for this register");
      await value.dblclick();
      await expect(editor, expression).toHaveCount(0);
    }
    for (const expression of WRITTEN) {
      const value = watchRow(page, expression).locator("span[title]");
      await expect(value, expression).toHaveAttribute("title", "Double-click to write the register");
      await value.dblclick();
      await editor.fill("0xBEEF");
      await editor.press("Enter");
      await expect(editor, expression).toHaveCount(0);
      await expect(watchRow(page, expression)).toHaveText(`${expression} = 0x0000BEEF`);
    }
    expect(rpc.requests("state.editWatch")).toHaveLength(WRITTEN.length);
    expect(rpc.received.filter((frame) => /-320(13|04)/.test(JSON.stringify(frame)))).toEqual([]);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});

test("a watch finds its register by its expression, without regard to case; one that names no described register is no editor", async ({ page }) => {
  const server = await serveScriptedDebugger(page);
  server.shape.capabilities = ["event-breakpoints", "callstack", "register-write"];
  // the registers of dc.sh4.cpu have a writer, and no other register has
  const cpu = (((server.shape.deviceTree as Json[])[0].children as Json[])[0].children as Json[])[0];
  expect(cpu.path).toBe("dc.sh4.cpu");
  cpu.registers = (cpu.registers as Json[]).map((register) => ({ ...register, flags: { writable: true } }));
  // What the ticks list as watches is the server's: an expression in another case than the
  // tree's, one of a register without a writer, and three that name nothing the tree describes.
  server.state.watches = [
    { id: 1, expression: "DC.SH4.CPU.Pr", value: "0x8C000F00" },
    { id: 2, expression: "dc.sh4.tmu.tcnt0", value: "0xFFFFFFFF" },
    { id: 3, expression: "dc.sh4.cpu.nothing", value: "0x00000001" },
    { id: 4, expression: "dc.sh4.cpu", value: "0x00000002" },
    { id: 5, expression: "pr", value: "0x00000003" },
  ];
  await gotoRoute(page, "/workspace/sh4-debugger");
  await server.described();
  const watches = panel(page, "watches");
  const editor = watches.getByRole("listitem").getByRole("textbox");
  await expect(watches.getByRole("listitem")).toHaveCount(5);

  for (const expression of ["dc.sh4.tmu.tcnt0", "dc.sh4.cpu.nothing", "dc.sh4.cpu", "pr"]) {
    const value = watches.getByRole("listitem").filter({ hasText: new RegExp(`^${expression.replaceAll(".", "\\.")} = `) }).locator("span[title]");
    await expect(value, expression).toHaveAttribute("title", "Read-only: the server has no writer for this register");
    await value.dblclick();
    await expect(editor, expression).toHaveCount(0);
  }
  const value = watches.getByRole("listitem").filter({ hasText: "DC.SH4.CPU.Pr = " }).locator("span[title]");
  await expect(value).toHaveAttribute("title", "Double-click to write the register");
  await value.dblclick();
  await editor.fill("0x8C000F02");
  await editor.press("Enter");
  await expect(editor).toHaveCount(0);
  expect(server.requestsOf("state.editWatch")).toEqual([{ watchId: 1, value: "0x8C000F02" }]);
  expect(server.requestsOf("state.setRegister")).toEqual([]);
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

test("an expression is sent in lower case, whichever way it was added, and one that is watched is not sent again", async ({
  page,
  rpc,
}) => {
  await openWorkspace(page, "sh4-debugger");
  const watches = panel(page, "watches");
  const input = watches.getByPlaceholder("Enter expression");
  const sent = () => rpc.requests("state.watch").map((frame) => frame.params);

  // typed with the register name as the device tree prints it
  await input.fill("  dc.sh4.cpu.VBR ");
  await input.press("Enter");
  await expect(watchRow(page, "dc.sh4.cpu.vbr")).toHaveText("dc.sh4.cpu.vbr = 0x8C000000");
  expect(sent()).toEqual([{ expressions: ["dc.sh4.cpu.vbr"] }]);

  // the + button of the device tree
  await treeItemRow(page, "dc.sh4.cpu").click();
  await tooltipButton(registerRow(page, "dc.sh4.cpu.reg.GBR"), "Add to watch").click();
  await expect(watchRow(page, "dc.sh4.cpu.gbr")).toBeVisible();
  expect(sent().at(-1)).toEqual({ expressions: ["dc.sh4.cpu.gbr"] });

  // what the server has is not asked for again, in any case: dc.sh4.cpu.pc is the watch it started with
  for (const again of ["DC.SH4.CPU.PC", "dc.sh4.cpu.Vbr", "dc.sh4.cpu.gbr"]) {
    await input.fill(again);
    await input.press("Enter");
    await expect(input).toHaveValue("");
  }
  expect(sent()).toHaveLength(2);
  await expect(watches.getByRole("listitem")).toHaveCount(3);
  // and the device tree knows all three as watched
  for (const register of ["PC", "VBR", "GBR"]) {
    await expect(tooltipButton(registerRow(page, `dc.sh4.cpu.reg.${register}`), "Already in watch")).toBeDisabled();
  }

  // renaming sends lower case too, and keeps the place of the watch in the list
  await watches.getByText("dc.sh4.cpu.vbr", { exact: true }).dblclick();
  await watches.getByRole("listitem").getByRole("textbox").fill("dc.sh4.cpu.SR");
  await watches.getByRole("listitem").getByRole("textbox").press("Enter");
  await expect(watchRow(page, "dc.sh4.cpu.sr")).toBeVisible();
  expect(rpc.requests("state.modifyWatchExpression").at(-1)?.params).toMatchObject({ newExpression: "dc.sh4.cpu.sr" });
  await expect(watches.getByRole("listitem").nth(1)).toContainText("dc.sh4.cpu.sr = ");
});

test("the suggestions are the best fifty matches, and typing narrows them", async ({ page }) => {
  // the popup is not virtualised, and a real machine has thousands of registers
  await openWorkspace(page, "sh4-debugger");
  const input = panel(page, "watches").getByPlaceholder("Enter expression");
  await input.fill("dc.");
  const options = page.getByRole("option");
  await expect(options).toHaveCount(50);
  await expect(options.first()).toHaveText("dc.sysclk");

  // the SH4 core alone has 69 registers
  await input.fill("dc.sh4.cpu.");
  await expect(options).toHaveCount(50);
  await input.fill("dc.sh4.cpu.xf1");
  await expect(options).toHaveText(["dc.sh4.cpu.xf1", "dc.sh4.cpu.xf10", "dc.sh4.cpu.xf11", "dc.sh4.cpu.xf12", "dc.sh4.cpu.xf13", "dc.sh4.cpu.xf14", "dc.sh4.cpu.xf15"]);
});
