import {
  test,
  expect,
  addPanelFromSelector,
  currentInstructionAddress,
  disassemblyRows,
  dockTab,
  gotoRoute,
  holdResponses,
  openWorkspace,
  panel,
  pauseFromToolbar,
  registerRow as treeRegisterRow,
  saveScreenshot,
  statusBar,
  tooltipButton,
  treeItem,
  treeItemRow,
} from "./support/fixtures";
import type { Locator, Page } from "@playwright/test";
import { installLongTaskRecorder, takeLongTasks } from "./support/longTasks";
import { installRenderCounter, readRenderCounts, resetRenderCounts } from "./support/renderCounter";
import { inBandError, serveScriptedDebugger, type Json, type ScriptedDebugger } from "./support/scriptedDebugger";
import { serveSyntheticDebugger } from "./support/syntheticDebugger";
import { MOCK_M1_SUPPORT, MOCK_M2_SUPPORT } from "../server/mockDebugger";

// The register panel: one table, bound to twelve panel ids, that shows the node of the device
// tree which offers its id as an action. Names, widths and whether a register can be written
// are those of debugger.describe; the values are those of the ticks. A value is an editor for
// a register with `flags.writable`, on a server with `register-write`, while the target is
// paused.

/** The row of a register in a register panel. */
const row = (view: Locator, name: string): Locator => view.locator(`tr[data-register="${name}"]`);
/** The value of a register, as text: what a double click turns into an editor. */
const value = (view: Locator, name: string): Locator => row(view, name).locator("td.register-value span");
/** The open editor of a panel: there is one at most. */
const editor = (view: Locator): Locator => view.getByRole("textbox");
/** The three cells of a row that say something: name, value, bits. */
const cells = async (view: Locator, name: string): Promise<string[]> =>
  (await row(view, name).locator("td").allInnerTexts()).slice(0, 3).map((text) => text.trim());

/** Shows the register panel of a workspace's processor: it is a tab behind the breakpoints. */
const showRegisters = async (page: Page, target: "SH4" | "ARM7"): Promise<Locator> => {
  await dockTab(page, `${target}: Registers`).click();
  const view = panel(page, `${target.toLowerCase()}-registers`);
  await expect(view).toBeVisible();
  return view;
};

/** Double-clicks the value of a register, types into the editor that opens and presses Enter. */
const write = async (view: Locator, name: string, text: string) => {
  await value(view, name).dblclick();
  await expect(editor(view)).toHaveAccessibleName(`New value of ${name}`);
  await editor(view).fill(text);
  await editor(view).press("Enter");
};

const SH4_CPU_REGISTERS = 69;
const ARM7_REGISTERS = 39;

/** The ten panels of the on-chip modules of the SH4: their id, their title and the node the mock offers each on. */
const MODULE_PANELS = [
  ["bsc-registers", "SH4: BSC Registers", "dc.sh4.bsc", "BCR1"],
  ["ccn-registers", "SH4: CCN Registers", "dc.sh4.ccn", "PTEH"],
  ["cpg-registers", "SH4: CPG Registers", "dc.sh4.cpg", "FRQCR"],
  ["dmac-registers", "SH4: DMAC Registers", "dc.sh4.dmac", "SAR0"],
  ["intc-registers", "SH4: INTC Registers", "dc.sh4.intc", "ICR"],
  ["rtc-registers", "SH4: RTC Registers", "dc.sh4.rtc", "R64CNT"],
  ["sci-registers", "SH4: SCI Registers", "dc.sh4.sci", "SCSMR1"],
  ["scif-registers", "SH4: SCIF Registers", "dc.sh4.scif", "SCSMR2"],
  ["tmu-registers", "SH4: TMU Registers", "dc.sh4.tmu", "TOCR"],
  ["ubc-registers", "SH4: UBC Registers", "dc.sh4.ubc", "BARA"],
] as const;

test.describe("the register panels of the two processors", () => {
  test("SH4: Registers is a tab behind the breakpoints, and shows the registers of dc.sh4.cpu with their values and widths", async ({ page, rpc }) => {
    await openWorkspace(page, "sh4-debugger");
    // the breakpoints panel is the one its group shows; the register panel is behind it
    await expect(panel(page, "sh4-breakpoints")).toBeVisible();
    await expect(panel(page, "sh4-registers")).toHaveCount(0);
    const before = rpc.sent.length;

    const view = await showRegisters(page, "SH4");
    await expect(view.getByRole("table", { name: "SH4: Registers" })).toBeVisible();
    // which node it is: the one that offers "sh4-registers"
    await expect(view.locator("caption")).toHaveText("Core dc.sh4.cpu");
    await expect(view.getByRole("columnheader")).toHaveText(["Name", "Value", "Bits", ""]);
    await expect(view.locator("tbody tr")).toHaveCount(SH4_CPU_REGISTERS);
    // in the order of debugger.describe
    expect((await view.locator("tbody tr td:first-child").allInnerTexts()).slice(0, 14)).toEqual([
      "PC", "PR", "SR", "GBR", "VBR", "MACH", "MACL", "SSR", "SPC", "SGR", "DBR", "FPSCR", "FPUL", "R0",
    ]);
    expect(await cells(view, "FPSCR")).toEqual(["FPSCR", "0x00040001", "32"]);
    expect(await cells(view, "R15")).toEqual(["R15", "0x8CFFF000", "32"]);
    expect(await cells(view, "FR0")).toEqual(["FR0", "0x3F800000", "32"]);

    // the values follow the ticks of the running target
    const pc = value(view, "PC");
    await expect(pc).toHaveText(/^0x8C0000A[02468ACE]$/);
    const first = await pc.innerText();
    await expect.poll(() => pc.innerText()).not.toBe(first);

    // the panel reads the store: it asked the server for nothing
    expect(rpc.sent.slice(before).map((frame) => frame.method)).toEqual([]);
  });

  test("ARM7: Registers is the same in the ARM7 workspace, on dc.aica.arm7; the other two workspaces have no register panel", async ({ page }) => {
    await openWorkspace(page, "arm7-debugger");
    await expect(panel(page, "arm7-breakpoints")).toBeVisible();
    const view = await showRegisters(page, "ARM7");
    await expect(view.locator("caption")).toHaveText("ARM7 dc.aica.arm7");
    await expect(view.locator("tbody tr")).toHaveCount(ARM7_REGISTERS);
    expect(await cells(view, "ENABLED")).toEqual(["ENABLED", "0x1", "1"]);
    expect(await cells(view, "CPSR")).toEqual(["CPSR", "0x000000D3", "32"]);
    await expect(value(view, "PC")).toHaveText(/^0x002000[123][048C]$/);

    for (const workspace of ["audio-debugger", "mixed-mode-debugger"] as const) {
      await gotoRoute(page, `/workspace/${workspace}`);
      await expect(panel(page, "watches")).toBeVisible();
      await expect(page.locator(".dv-default-tab").filter({ hasText: "Registers" })).toHaveCount(0);
    }
  });

  test("a register is written by a double click on its value: the server reads what was typed, and the tick shows what it stored", async ({ page, rpc }, testInfo) => {
    await openWorkspace(page, "sh4-debugger");
    await pauseFromToolbar(page);
    const view = await showRegisters(page, "SH4");
    await expect(value(view, "R0")).toHaveAttribute("title", "Double-click to write the register");

    // the editor opens with the value as it is, selected: typing replaces it
    await value(view, "R0").dblclick();
    await expect(editor(view)).toBeFocused();
    await expect(editor(view)).toHaveValue("0x00000000");
    expect(await editor(view).evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([0, 10]);
    await saveScreenshot(page, testInfo, "registers-editing");
    await page.keyboard.type("0x1234abcd");
    await page.keyboard.press("Enter");
    await expect(editor(view)).toHaveCount(0);
    await expect(value(view, "R0")).toHaveText("0x1234ABCD");
    expect(rpc.requests("state.setRegister").map((frame) => frame.params)).toEqual([{ path: "dc.sh4.cpu", name: "R0", value: "0x1234abcd" }]);

    // decimal, blanks around it, and more bits than the register has: all the server's to read
    await write(view, "R1", " 4660 ");
    await expect(value(view, "R1")).toHaveText("0x00001234");
    await write(view, "R2", "0x1FFFFFFFF");
    await expect(value(view, "R2")).toHaveText("0xFFFFFFFF");
    // a register that stores under a mask reads back what was stored
    await write(view, "FPSCR", "0xFFFFFFFF");
    await expect(value(view, "FPSCR")).toHaveText("0x003FFFFF");
    expect(rpc.requests("state.setRegister").map((frame) => (frame.params as Json).value)).toEqual(["0x1234abcd", " 4660 ", "0x1FFFFFFFF", "0xFFFFFFFF"]);
    await expect(page.getByRole("alert")).toHaveCount(0);

    // every view of the register has the value: the tick carries it
    await treeItemRow(page, "dc.sh4.cpu").click();
    await expect(treeRegisterRow(page, "dc.sh4.cpu.reg.R0")).toHaveText(/R0 = 0x1234ABCD/);
  });

  test("Escape and leaving the box put the editor away, and nothing is written", async ({ page, rpc }) => {
    await openWorkspace(page, "sh4-debugger");
    await pauseFromToolbar(page);
    const view = await showRegisters(page, "SH4");

    await value(view, "R3").dblclick();
    await editor(view).fill("0x99");
    await editor(view).press("Escape");
    await expect(editor(view)).toHaveCount(0);
    await expect(value(view, "R3")).toHaveText("0x00003333");

    await value(view, "R3").dblclick();
    await editor(view).fill("0x77");
    await view.getByRole("columnheader", { name: "Name" }).click();
    await expect(editor(view)).toHaveCount(0);
    // one editor at a time: opening another closes the first with its row's value untouched
    await value(view, "R4").dblclick();
    await value(view, "R5").dblclick();
    await expect(editor(view)).toHaveCount(1);
    await expect(editor(view)).toHaveAccessibleName("New value of R5");
    await editor(view).press("Escape");
    expect(rpc.requests("state.setRegister")).toEqual([]);
  });

  test("editing is offered while the target is paused only: no editor while it runs, and one that is open goes when it runs again", async ({ page, rpc }) => {
    await openWorkspace(page, "sh4-debugger");
    const view = await showRegisters(page, "SH4");
    // running: the value says that it cannot be used now, and a double click on it all the same opens nothing
    await expect(value(view, "R0")).toHaveAttribute("title", "Read-only while the target runs: pause it to write the register");
    await expect(value(view, "R0")).toHaveAttribute("aria-disabled", "true");
    await value(view, "R0").dblclick({ force: true });
    await expect(editor(view)).toHaveCount(0);

    await pauseFromToolbar(page);
    await value(view, "R0").dblclick();
    await editor(view).fill("0x55");
    // somebody resumes the target (the toolbar; another client would do the same to this page)
    await tooltipButton(page, "Run").click();
    await expect(tooltipButton(page, "Pause")).toBeEnabled();
    await expect(editor(view)).toHaveCount(0);
    // and what was typed is gone with it: the next stop does not bring the box back
    await pauseFromToolbar(page);
    await expect(editor(view)).toHaveCount(0);
    await expect(value(view, "R0")).toHaveText("0x00000000");
    expect(rpc.requests("state.setRegister")).toEqual([]);
  });

  test("a register is written with the keyboard: its value is a stop of the Tab key, Enter, the space bar and F2 open the editor, and the value has the focus again when the editor goes", async ({
    page,
    rpc,
  }) => {
    await openWorkspace(page, "sh4-debugger");
    await pauseFromToolbar(page);
    const view = await showRegisters(page, "SH4");
    // the value of a register that can be written is a control, and says whose value it is
    const control = view.getByRole("button", { name: "R0 0x00000000, write" });
    await expect(control).toHaveCount(1);
    await expect(control).toHaveText("0x00000000");
    await expect(control).not.toHaveAttribute("aria-disabled");
    // it is the stop behind the + of the row above it
    await row(view, "FPUL").locator("button.register-watch").focus();
    await page.keyboard.press("Tab");
    await expect(value(view, "R0")).toBeFocused();
    await expect(control).toBeFocused();

    // Enter: the editor, as after a double click; the key is not the first one typed into it
    await page.keyboard.press("Enter");
    await expect(editor(view)).toBeFocused();
    await expect(editor(view)).toHaveAccessibleName("New value of R0");
    await expect(editor(view)).toHaveValue("0x00000000");
    await page.keyboard.type("0xAB");
    await page.keyboard.press("Enter");
    await expect(editor(view)).toHaveCount(0);
    // accepted: the focus is on the value again, which is the tick's
    await expect(value(view, "R0")).toHaveText("0x000000AB");
    await expect(value(view, "R0")).toBeFocused();
    await expect(view.getByRole("button", { name: "R0 0x000000AB, write" })).toBeFocused();

    // F2, and Escape: the same
    await page.keyboard.press("F2");
    await expect(editor(view)).toBeFocused();
    await page.keyboard.type("0x1");
    await page.keyboard.press("Escape");
    await expect(editor(view)).toHaveCount(0);
    await expect(value(view, "R0")).toBeFocused();
    // the space bar, which is no blank in the box and does not scroll the panel
    const scrolled = () =>
      view.locator("table").evaluate((table) => {
        let box = table.parentElement;
        while (box && !/auto|scroll/.test(getComputedStyle(box).overflowY)) {
          box = box.parentElement;
        }
        return box ? box.scrollTop : undefined;
      });
    const before = await scrolled();
    expect(before).toBeDefined();
    await page.keyboard.press("Space");
    await expect(editor(view)).toBeFocused();
    await expect(editor(view)).toHaveValue("0x000000AB");
    expect(await scrolled()).toBe(before);
    // a write that is refused leaves the focus where the text is
    await page.keyboard.type("nothing");
    await page.keyboard.press("Enter");
    await expect(editor(view)).toHaveAttribute("aria-invalid", "true");
    await expect(editor(view)).toBeFocused();

    // Tab leaves the box: the editor is put away, and the focus is where Tab took it
    await page.keyboard.press("Tab");
    await expect(editor(view)).toHaveCount(0);
    await expect(row(view, "R0").locator("button.register-watch")).toBeFocused();
    // ... and a click on something that takes no focus leaves it nowhere: it is not taken back to this panel
    await value(view, "R1").dblclick();
    await expect(editor(view)).toBeFocused();
    await view.getByRole("columnheader", { name: "Bits" }).click();
    await expect(editor(view)).toHaveCount(0);
    await page.waitForTimeout(200);
    await expect(value(view, "R1")).not.toBeFocused();
    // any other key on a value is the page's
    await value(view, "R1").focus();
    await page.keyboard.press("a");
    await page.keyboard.press("ArrowDown");
    await expect(editor(view)).toHaveCount(0);

    expect(rpc.requests("state.setRegister").map((frame) => frame.params)).toEqual([
      { path: "dc.sh4.cpu", name: "R0", value: "0xAB" },
      { path: "dc.sh4.cpu", name: "R0", value: "nothing" },
    ]);
  });

  test("a write the server refuses leaves the editor open and says why", async ({ page, rpc }) => {
    await openWorkspace(page, "sh4-debugger");
    await pauseFromToolbar(page);
    const view = await showRegisters(page, "SH4");
    const alerts = page.getByRole("alert");

    // a value the device refuses: nothing executes at an odd address (-32013)
    await write(view, "PC", "0x8C0000A1");
    await expect(alerts.filter({ hasText: "not writable: dc.sh4.cpu.PC = 0x8C0000A1: the address is odd" })).toBeVisible();
    await expect(editor(view)).toBeVisible();
    await expect(editor(view)).toHaveValue("0x8C0000A1");
    await expect(editor(view)).toHaveAttribute("aria-invalid", "true");
    await expect(editor(view)).toHaveAttribute("title", "not writable: dc.sh4.cpu.PC = 0x8C0000A1: the address is odd");
    expect(rpc.received.find((frame) => frame.id === rpc.requests("state.setRegister").at(-1)?.id)?.result).toEqual({
      error: { code: -32013, message: "not writable: dc.sh4.cpu.PC = 0x8C0000A1: the address is odd" },
    });

    // a text that is no number (-32602): the mark goes when the text is changed, and comes back with the refusal
    await editor(view).fill("somewhere");
    await expect(editor(view)).not.toHaveAttribute("aria-invalid");
    await editor(view).press("Enter");
    await expect(alerts.filter({ hasText: 'invalid params: value: "somewhere" is neither 0x hex nor decimal' })).toBeVisible();
    await expect(editor(view)).toHaveAttribute("aria-invalid", "true");
    await expect(editor(view)).toHaveValue("somewhere");

    // the box is still the editor: a value the server takes closes it
    await editor(view).fill("0x8C0000A4");
    await editor(view).press("Enter");
    await expect(editor(view)).toHaveCount(0);
    await expect(value(view, "PC")).toHaveText("0x8C0000A4");
    expect(rpc.requests("state.setRegister")).toHaveLength(3);
  });

  test("the + of a row adds the register to the watches, and is off for one that is watched", async ({ page, rpc }) => {
    await openWorkspace(page, "sh4-debugger");
    const view = await showRegisters(page, "SH4");
    // the watch every server of the suite starts with
    await expect(row(view, "PC").getByRole("button", { name: "Already in watch" })).toBeDisabled();

    await row(view, "GBR").getByRole("button", { name: "Add to watch" }).click();
    await expect(panel(page, "watches").getByRole("listitem").filter({ hasText: "dc.sh4.cpu.gbr = 0x8C000000" })).toBeVisible();
    await expect(row(view, "GBR").getByRole("button", { name: "Already in watch" })).toBeDisabled();
    expect(rpc.requests("state.watch").map((frame) => frame.params)).toEqual([{ expressions: ["dc.sh4.cpu.gbr"] }]);
    await expect(row(view, "VBR").getByRole("button", { name: "Add to watch" })).toBeEnabled();
  });

  test("a written PC moves the disassembly to it; another register, and the PC written as it is, only make it read again where it is", async ({ page, rpc }) => {
    await openWorkspace(page, "sh4-debugger");
    await pauseFromToolbar(page);
    const listing = panel(page, "sh4-disassembly");
    const view = await showRegisters(page, "SH4");
    const stopped = await currentInstructionAddress(listing);
    const listings = () => rpc.requests("state.getDisassembly").filter((frame) => (frame.params as Json).target === "sh4");
    const slices = () => rpc.requests("state.getMemorySlice");

    // the listing is moved away from the program counter, to see what brings it back
    const box = listing.getByRole("textbox");
    await box.fill("0x8C004000");
    await box.press("Enter");
    const away = 0x8c004000 - 10 * 2;
    await expect(disassemblyRows(listing).first()).toHaveAttribute("data-address", String(away));
    const settled = listings().length;
    const bytesRead = slices().length;

    // a register that is no program counter: both fetched views read again, in place
    await write(view, "R0", "0x1");
    await expect.poll(() => listings().length).toBe(settled + 1);
    expect(listings().at(-1)?.params).toMatchObject({ address: away });
    await expect(disassemblyRows(listing).first()).toHaveAttribute("data-address", String(away));
    await expect.poll(() => slices().length).toBe(bytesRead + 1);
    expect(slices().at(-1)?.params).toEqual({ target: "sh4", address: 0x8c010000, length: 960 });
    // the PC written as the value it has: no other PC, so no move either
    await write(view, "PC", `0x${stopped.toString(16)}`);
    await expect.poll(() => listings().length).toBe(settled + 2);
    await expect(disassemblyRows(listing).first()).toHaveAttribute("data-address", String(away));
    await expect(box).toHaveValue("0x8C004000");

    // another PC: the listing goes to it, with ten instructions above it, although no new stop was made
    await write(view, "PC", "0x8C008000");
    await expect(value(view, "PC")).toHaveText("0x8C008000");
    expect(await currentInstructionAddress(listing)).toBe(0x8c008000);
    await expect(listing.locator(".current-instruction")).toBeInViewport({ ratio: 1 });
    await expect(disassemblyRows(listing).first()).toHaveAttribute("data-address", String(0x8c008000 - 10 * 2));
    await expect(page.getByRole("status", { name: "Execution state" })).toHaveText("Paused · paused by the debugger · stop 1");

    // and through a watch it is the same: the tick moves the view, whoever wrote
    const watches = panel(page, "watches").getByRole("listitem");
    await watches.getByText("0x8C008000", { exact: true }).dblclick();
    await watches.getByRole("textbox").fill("0x8C00C000");
    await watches.getByRole("textbox").press("Enter");
    await expect(value(view, "PC")).toHaveText("0x8C00C000");
    expect(await currentInstructionAddress(listing)).toBe(0x8c00c000);
    await expect(listing.locator(".current-instruction")).toBeInViewport({ ratio: 1 });
  });
});

test.describe("the register panels of the on-chip modules", () => {
  test("each of the ten ids shows the node that offers it, with its registers", async ({ page }) => {
    test.slow();
    await openWorkspace(page, "sh4-debugger");
    await pauseFromToolbar(page);
    for (const [id, title, path, firstRegister] of MODULE_PANELS) {
      await addPanelFromSelector(page, 1, title);
      const view = panel(page, id);
      await expect(view, id).toBeVisible();
      await expect(view.locator("caption"), id).toContainText(path);
      await expect(view.locator("tbody tr").first().locator("td").first(), id).toHaveText(firstRegister);
      await expect(view.getByText("Coming Soon")).toHaveCount(0);
    }
    // a register that cannot be read without a side effect reads "n/a", and has no writer
    const scif = panel(page, "scif-registers");
    await dockTab(page, "SH4: SCIF Registers").click();
    expect(await cells(scif, "SCFRDR2")).toEqual(["SCFRDR2", "n/a", "8"]);
    await expect(value(scif, "SCFRDR2")).toHaveAttribute("title", "Read-only: the server has no writer for this register");
    await value(scif, "SCFRDR2").dblclick();
    await expect(editor(scif)).toHaveCount(0);
    expect(await cells(scif, "SCFSR2")).toEqual(["SCFSR2", "0x0060", "16"]);
  });

  test("the action of a device tree node opens its register panel", async ({ page }) => {
    await openWorkspace(page, "sh4-debugger");
    await treeItemRow(page, "dc.sh4.pbus").click();
    await treeItem(page, "dc.sh4.tmu").getByLabel("Open SH4: TMU Registers").click();
    const view = panel(page, "tmu-registers");
    await expect(view.locator("caption")).toHaveText("TMU dc.sh4.tmu");
    expect(await cells(view, "TCOR0")).toEqual(["TCOR0", "0xFFFFFFFF", "32"]);
    expect(await cells(view, "TSTR")).toEqual(["TSTR", "0x01", "8"]);
    // and the one of the processor, which is in the dock already, is shown
    await treeItemRow(page, "dc.sh4.cpu").getByLabel("Open SH4: Registers").click();
    await expect(panel(page, "sh4-registers").locator("tbody tr")).toHaveCount(SH4_CPU_REGISTERS);
    await expect(dockTab(page, "SH4: Registers")).toHaveCount(1);
  });
});

test.describe("what a register panel shows when there is nothing to read", () => {
  test.use({ mockOptions: {} });

  test("with no game loaded every value is n/a, and the rows are back with the machine", async ({ page, machine }) => {
    await openWorkspace(page, "sh4-debugger");
    const view = await showRegisters(page, "SH4");
    await expect(value(view, "FPSCR")).toHaveText("0x00040001");

    machine.setLifetime("no-machine");
    await expect(page.getByRole("status", { name: "Execution state" })).toContainText("no game loaded");
    await expect(view.locator("tbody tr")).toHaveCount(SH4_CPU_REGISTERS);
    await expect(view.locator("td.register-value span").filter({ hasText: /^n\/a$/ })).toHaveCount(SH4_CPU_REGISTERS);

    machine.setLifetime("running");
    await expect(value(view, "FPSCR")).toHaveText("0x00040001");
    await expect(value(view, "PC")).toHaveText(/^0x8C0000A[02468ACE]$/);
  });

  test("a write to a machine the host has stopped is refused by the server, and the editor says so", async ({ page, machine }) => {
    await openWorkspace(page, "sh4-debugger");
    await pauseFromToolbar(page);
    const view = await showRegisters(page, "SH4");
    await value(view, "R0").dblclick();
    await editor(view).fill("0x42");
    // the emulator's own window stops the machine while the box is open
    machine.setLifetime("stopped");
    await expect(page.getByRole("status", { name: "Execution state" })).toContainText("stopped in the emulator's window");
    await editor(view).press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "emulator stopped by host UI" })).toBeVisible();
    await expect(editor(view)).toHaveValue("0x42");
    await expect(editor(view)).toHaveAttribute("aria-invalid", "true");
    await expect(editor(view)).toHaveAttribute("title", "emulator stopped by host UI");
  });

  test("without a connection the panel keeps its table and says so in place of the rows", async ({ page, mock, diagnostics }) => {
    diagnostics.allow(/^console\.error: WebSocket connection to/, "the server is down on purpose");
    await openWorkspace(page, "sh4-debugger");
    const view = await showRegisters(page, "SH4");
    await expect(view.locator("tbody tr")).toHaveCount(SH4_CPU_REGISTERS);
    await mock.stop();
    await expect(statusBar(page)).toContainText("Connection: reconnecting");
    await expect(view).toContainText("Not connected");
    await expect(view.getByRole("columnheader")).toHaveText(["Name", "Value", "Bits", ""]);
    await expect(view.locator("tbody tr")).toHaveCount(0);
  });
});

test.describe("a core that does not report its registers while it runs", () => {
  test.use({ mockOptions: { sliceContext: false } });

  test("the SH4 registers are dimmed while they are stale, and no others are", async ({ page }) => {
    await openWorkspace(page, "sh4-debugger");
    const view = await showRegisters(page, "SH4");
    const stale = view.locator("tbody[data-stale]");
    await expect(stale).toHaveCount(1);
    await expect(stale).toHaveAttribute("title", "Values of the last stop: the running core does not report its registers");
    await expect(stale).toHaveCSS("opacity", "0.45");
    // the values are those of debugger.describe until a stop reports them
    await expect(view.locator("tbody tr")).toHaveCount(SH4_CPU_REGISTERS);

    // the ARM7 reports its registers in every full tick: its panel is not dimmed
    await treeItemRow(page, "dc.aica.arm7").getByLabel("Open ARM7: Registers").click();
    await expect(panel(page, "arm7-registers").locator("tbody tr")).toHaveCount(ARM7_REGISTERS);
    await expect(panel(page, "arm7-registers").locator("tbody[data-stale]")).toHaveCount(0);

    // paused: the tick has the registers of the SH4
    await pauseFromToolbar(page);
    await dockTab(page, "SH4: Registers").click();
    await expect(view.locator("tbody[data-stale]")).toHaveCount(0);
    await expect(view.locator("tbody")).toHaveCSS("opacity", "1");
    await expect(value(view, "PC")).toHaveText(/^0x8C0000A[02468ACE]$/);
  });
});

test.describe("a server that can do what the emulator of milestone M2 can, and no more", () => {
  test.use({ mockOptions: { supports: MOCK_M2_SUPPORT } });

  test("the registers of the two processors have editors, ENABLED has none", async ({ page, rpc }) => {
    await openWorkspace(page, "sh4-debugger");
    await pauseFromToolbar(page);
    const sh4 = await showRegisters(page, "SH4");
    // every register of dc.sh4.cpu has a writer
    await expect(sh4.locator("td.register-value [data-editable]")).toHaveCount(SH4_CPU_REGISTERS);
    await write(sh4, "R7", "0xCAFE");
    await expect(value(sh4, "R7")).toHaveText("0x0000CAFE");

    await treeItemRow(page, "dc.aica.arm7").getByLabel("Open ARM7: Registers").click();
    const arm7 = panel(page, "arm7-registers");
    // all of dc.aica.arm7 but ENABLED
    await expect(arm7.locator("td.register-value [data-editable]")).toHaveCount(ARM7_REGISTERS - 1);
    // ... and those are the stops of the Tab key: a value that is never an editor is text
    await expect(arm7.getByRole("button", { name: /, write$/ })).toHaveCount(ARM7_REGISTERS - 1);
    await expect(value(arm7, "ENABLED")).not.toHaveAttribute("tabindex");
    await expect(value(arm7, "ENABLED")).not.toHaveAttribute("role");
    await expect(value(arm7, "ENABLED")).toHaveAttribute("title", "Read-only: the server has no writer for this register");
    await value(arm7, "ENABLED").dblclick();
    await expect(editor(arm7)).toHaveCount(0);
    // the PC of the ARM7 is stored aligned: the row shows what the tick says, not what was typed
    await write(arm7, "PC", "0x00200033");
    await expect(value(arm7, "PC")).toHaveText("0x00200030");

    expect(rpc.requests("state.setRegister").map((frame) => frame.params)).toEqual([
      { path: "dc.sh4.cpu", name: "R7", value: "0xCAFE" },
      { path: "dc.aica.arm7", name: "PC", value: "0x00200033" },
    ]);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("the ten on-chip module panels have no editor, and nothing is sent that the server refuses by rule", async ({ page, rpc }) => {
    test.slow();
    await openWorkspace(page, "sh4-debugger");
    await pauseFromToolbar(page);
    for (const [id, title, path, firstRegister] of MODULE_PANELS) {
      await addPanelFromSelector(page, 1, title);
      const view = panel(page, id);
      await expect(view.locator("caption"), id).toContainText(path);
      // rows with values, and not one of them an editor
      await expect(view.locator("tbody tr").first(), id).toBeVisible();
      await expect(view.locator("td.register-value [data-editable]"), id).toHaveCount(0);
      await expect(view.locator("td.register-value [tabindex]"), id).toHaveCount(0);
      await expect(value(view, firstRegister), id).toHaveAttribute("title", "Read-only: the server has no writer for this register");
      await value(view, firstRegister).dblclick();
      await expect(editor(view), id).toHaveCount(0);
      // watching is no write: the + is there
      await expect(row(view, firstRegister).getByRole("button", { name: "Add to watch" }), id).toBeEnabled();
    }
    expect(rpc.requests("state.setRegister")).toEqual([]);
    expect(rpc.requests("state.editWatch")).toEqual([]);
    expect(rpc.received.filter((frame) => /-320(13|04)/.test(JSON.stringify(frame)))).toEqual([]);
  });
});

test.describe("a server of milestone M1", () => {
  test.use({ mockOptions: { supports: MOCK_M1_SUPPORT } });

  test("no node offers the panels of the two processors: each says so, and asks for nothing", async ({ page, rpc }, testInfo) => {
    await openWorkspace(page, "arm7-debugger");
    await pauseFromToolbar(page);
    const before = rpc.sent.length;
    const arm7 = await showRegisters(page, "ARM7");
    await expect(arm7.getByRole("note")).toHaveText("This server has no ARM7: Registers.");
    await expect(arm7.getByRole("table")).toHaveCount(0);
    await saveScreenshot(page, testInfo, "registers-m1-notice");

    await addPanelFromSelector(page, 1, "SH4: Registers");
    await expect(panel(page, "sh4-registers").getByRole("note")).toHaveText("This server has no SH4: Registers.");
    expect(rpc.sent.slice(before).map((frame) => frame.method)).toEqual([]);
  });

  test("the on-chip modules are read and not written: rows without an editor, and nothing that is answered -32004", async ({ page, rpc }) => {
    await openWorkspace(page, "sh4-debugger");
    await pauseFromToolbar(page);
    await addPanelFromSelector(page, 1, "SH4: TMU Registers");
    const view = panel(page, "tmu-registers");
    expect(await cells(view, "TCOR0")).toEqual(["TCOR0", "0xFFFFFFFF", "32"]);
    await expect(view.locator("td.register-value [data-editable]")).toHaveCount(0);
    await expect(view.locator("td.register-value [tabindex]")).toHaveCount(0);
    await expect(view.getByRole("button", { name: /, write$/ })).toHaveCount(0);
    await expect(value(view, "TCOR0")).toHaveAttribute("title", "Read-only: this server cannot write registers");
    await value(view, "TCOR0").dblclick();
    await expect(editor(view)).toHaveCount(0);
    expect(rpc.requests("state.setRegister")).toEqual([]);
    expect(rpc.received.filter((frame) => JSON.stringify(frame).includes("-32004"))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// Scripted servers: an exact tree, an exact order of answer and tick, an answer that is late.
// ---------------------------------------------------------------------------------------

/** Makes the scripted server one that writes registers: the capability, and `flags.writable` on the registers of the nodes named. */
const withRegisterWrites = (server: ScriptedDebugger, writableNodes: string[]) => {
  server.shape.capabilities = ["event-breakpoints", "callstack", "register-write", "memory-write"];
  const visit = (nodes: Json[]) => {
    for (const node of nodes) {
      if (writableNodes.includes(node.path as string)) {
        node.registers = (node.registers as Json[]).map((register) => ({ ...register, flags: { writable: true } }));
      }
      visit((node.children as Json[] | undefined) ?? []);
    }
  };
  visit(server.shape.deviceTree as Json[]);
};

/** The node of the scripted server's describe tree with this path. */
const describedNode = (server: ScriptedDebugger, path: string): Json => {
  const find = (nodes: Json[]): Json | undefined => {
    for (const node of nodes) {
      if (node.path === path) {
        return node;
      }
      const below = find((node.children as Json[] | undefined) ?? []);
      if (below) {
        return below;
      }
    }
    return undefined;
  };
  const node = find(server.shape.deviceTree as Json[]);
  if (!node) {
    throw new Error(`the scripted server has no node ${path}`);
  }
  return node;
};

test("when several nodes offer a panel's id, the panel shows the first of them in the order of the describe tree", async ({ page }) => {
  const server = await serveScriptedDebugger(page);
  // dc.sh4.tmu offers "tmu-registers"; so do a node behind it in the tree and one in front of it
  describedNode(server, "dc.aica.dsp").actions = ["dsp-disassembly", "tmu-registers"];
  await gotoRoute(page, "/workspace/sh4-debugger");
  await server.described();
  await addPanelFromSelector(page, 1, "SH4: TMU Registers");
  const view = panel(page, "tmu-registers");
  await expect(view.locator("caption")).toHaveText("TMU dc.sh4.tmu");
  expect(await cells(view, "TCNT0")).toEqual(["TCNT0", "0xFFFFFFFF", "32"]);

  // the next server offers it on a node in front of dc.sh4.tmu as well: that one is shown
  describedNode(server, "dc.sh4.cpu").actions = ["sh4-disassembly", "tmu-registers", "sh4-memory"];
  server.drop();
  await server.described();
  await expect(view.locator("caption")).toHaveText("Core dc.sh4.cpu");
  await expect(view.locator("tbody tr td:first-child")).toHaveText(["PC", "PR", "R15"]);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a register without the flag has no editor on a server that writes registers, and one with it sends what was typed", async ({ page }) => {
  const server = await serveScriptedDebugger(page);
  withRegisterWrites(server, ["dc.sh4.cpu"]);
  describedNode(server, "dc.sh4.cpu").actions = ["sh4-disassembly", "sh4-memory", "sh4-registers"];
  // one register of the node has no writer
  (describedNode(server, "dc.sh4.cpu").registers as Json[])[1].flags = undefined;
  await gotoRoute(page, "/workspace/sh4-debugger");
  await server.described();
  const view = await showRegisters(page, "SH4");
  await expect(view.locator("td.register-value [data-editable]")).toHaveCount(2);
  await value(view, "PR").dblclick();
  await expect(editor(view)).toHaveCount(0);

  await write(view, "R15", "12");
  await expect(editor(view)).toHaveCount(0);
  expect(server.requestsOf("state.setRegister")).toEqual([{ path: "dc.sh4.cpu", name: "R15", value: "12" }]);
});

test("an answer that is late: the editor waits with what was typed, sends nothing more, and closes when the server has accepted", async ({ page }) => {
  const held = await holdResponses(page, "state.setRegister");
  await openWorkspace(page, "sh4-debugger");
  await pauseFromToolbar(page);
  const view = await showRegisters(page, "SH4");

  await write(view, "R0", "0xABCD");
  await expect.poll(held.held).toBe(1);
  // open, busy, and not to be typed into; the value is the old one
  await expect(editor(view)).toHaveValue("0xABCD");
  await expect(editor(view)).toHaveAttribute("aria-busy", "true");
  await expect(editor(view)).toHaveAttribute("readonly", "");
  // a second and a third Enter are not a second and a third write
  await editor(view).press("Enter");
  await editor(view).press("Enter");
  await page.waitForTimeout(300);
  expect(held.requests("state.setRegister")).toHaveLength(1);

  held.release();
  await expect(editor(view)).toHaveCount(0);
  await expect(value(view, "R0")).toHaveText("0x0000ABCD");
  expect(held.requests("state.setRegister")).toHaveLength(1);
});

test("an editor that was put away while its answer was late is not closed, or marked, by that answer when it is opened again", async ({ page }) => {
  const server = await serveScriptedDebugger(page);
  withRegisterWrites(server, ["dc.sh4.cpu"]);
  describedNode(server, "dc.sh4.cpu").actions = ["sh4-disassembly", "sh4-memory", "sh4-registers"];
  const answers: Array<(answer: unknown) => void> = [];
  server.answer("state.setRegister", () => new Promise((resolve) => answers.push(resolve)));
  await gotoRoute(page, "/workspace/sh4-debugger");
  await server.described();
  const view = await showRegisters(page, "SH4");

  await write(view, "R15", "0x1");
  await expect.poll(() => answers.length).toBe(1);
  await editor(view).press("Escape");
  await expect(editor(view)).toHaveCount(0);
  // the same register is edited again while the first write is still out
  await value(view, "R15").dblclick();
  await editor(view).fill("0x2");
  // the first write is refused: the notice says so, and the box that is open now is not that write's
  answers[0](inBandError(-32000, "emulator busy"));
  await expect(page.getByRole("alert").filter({ hasText: "emulator busy" })).toBeVisible();
  await expect(editor(view)).toHaveValue("0x2");
  await expect(editor(view)).not.toHaveAttribute("aria-invalid");
  // and it sends its own
  await editor(view).press("Enter");
  await expect.poll(() => answers.length).toBe(2);
  answers[1]({});
  await expect(editor(view)).toHaveCount(0);
  expect(server.requestsOf("state.setRegister").map((params) => params.value)).toEqual(["0x1", "0x2"]);
});

test("an editor that was put away while its answer was late is not closed by that answer when the write is accepted: the box opened since keeps what is typed into it", async ({
  page,
}) => {
  // the three editors: of a register, of a watch, of a byte
  const server = await serveScriptedDebugger(page);
  withRegisterWrites(server, ["dc.sh4.cpu"]);
  describedNode(server, "dc.sh4.cpu").actions = ["sh4-disassembly", "sh4-memory", "sh4-registers"];
  server.state.watches = [{ id: 4, expression: "dc.sh4.cpu.pr", value: "0x8C000F00" }];
  const answers: Array<(answer: unknown) => void> = [];
  for (const method of ["state.setRegister", "state.editWatch", "state.writeMemory"]) {
    server.answer(method, () => new Promise((resolve) => answers.push(resolve)));
  }
  await gotoRoute(page, "/workspace/sh4-debugger");
  await server.described();
  const memory = panel(page, "sh4-memory");
  await expect(memory.locator("[data-memory-hex]")).toHaveCount(60);

  // a register: the first write is given up with Escape, and the register is edited again
  const view = await showRegisters(page, "SH4");
  await write(view, "R15", "0x1");
  await expect.poll(() => answers.length).toBe(1);
  await editor(view).press("Escape");
  await expect(editor(view)).toHaveCount(0);
  await value(view, "R15").dblclick();
  await editor(view).fill("0x2");
  // the server accepts the first write now: that is not this box's answer
  answers[0]({});
  await page.waitForTimeout(300);
  await expect(editor(view)).toHaveValue("0x2");
  await expect(editor(view)).toBeFocused();
  await expect(editor(view)).not.toHaveAttribute("aria-busy");
  await expect(editor(view)).not.toHaveAttribute("readonly");
  // ... and the box sends its own, once
  await editor(view).press("Enter");
  await expect.poll(() => answers.length).toBe(2);
  await expect(editor(view)).toHaveAttribute("aria-busy", "true");
  answers[1]({});
  await expect(editor(view)).toHaveCount(0);
  expect(server.requestsOf("state.setRegister").map((params) => params.value)).toEqual(["0x1", "0x2"]);

  // the register of a watch
  const watches = panel(page, "watches").getByRole("listitem");
  await watches.getByText("0x8C000F00", { exact: true }).dblclick();
  await watches.getByRole("textbox").fill("0x3");
  await watches.getByRole("textbox").press("Enter");
  await expect.poll(() => answers.length).toBe(3);
  await watches.getByRole("textbox").press("Escape");
  await expect(watches.getByRole("textbox")).toHaveCount(0);
  await watches.getByText("0x8C000F00", { exact: true }).dblclick();
  await watches.getByRole("textbox").fill("0x4");
  answers[2]({});
  await page.waitForTimeout(300);
  await expect(watches.getByRole("textbox")).toHaveValue("0x4");
  await expect(watches.getByRole("textbox")).not.toHaveAttribute("aria-busy");
  await watches.getByRole("textbox").press("Enter");
  await expect.poll(() => answers.length).toBe(4);
  answers[3]({});
  await expect(watches.getByRole("textbox")).toHaveCount(0);
  expect(server.requestsOf("state.editWatch")).toEqual([
    { watchId: 4, value: "0x3" },
    { watchId: 4, value: "0x4" },
  ]);

  // a byte of memory: another byte is being edited when the answer for the first arrives
  const byteAt = async (address: number) => {
    const hex = memory.locator(`[data-memory-hex="${address - (address % 16)}"]`);
    const box = (await hex.boundingBox())!;
    await hex.dblclick({ position: { x: ((address % 16) * 3 + 1.5) * (box.width / 47), y: box.height / 2 } });
  };
  const bytes = memory.getByRole("textbox", { name: /^Bytes to write from / });
  await byteAt(0x8c010002);
  await bytes.fill("AA");
  await bytes.press("Enter");
  await expect.poll(() => answers.length).toBe(5);
  await bytes.press("Escape");
  await expect(bytes).toHaveCount(0);
  await byteAt(0x8c010008);
  await bytes.fill("BB");
  answers[4]({});
  await page.waitForTimeout(300);
  await expect(bytes).toHaveValue("BB");
  await expect(bytes).toHaveAccessibleName("Bytes to write from 0x8C010008");
  await expect(bytes).not.toHaveAttribute("aria-busy");
  await bytes.press("Enter");
  await expect.poll(() => answers.length).toBe(6);
  answers[5]({});
  await expect(bytes).toHaveCount(0);
  expect(server.requestsOf("state.writeMemory")).toEqual([
    { target: "sh4", address: 0x8c010002, data: [0xaa] },
    { target: "sh4", address: 0x8c010008, data: [0xbb] },
  ]);
});

test("another client resumes the target while the focus is in the editor of a register: the editor goes, and the next stop does not bring it back", async ({
  page,
}) => {
  // The toolbar's Run would take the focus out of the box, and leaving the box puts an editor
  // away by itself. Here nothing is clicked: the ticks say that the target runs, and stops again.
  const server = await serveScriptedDebugger(page);
  withRegisterWrites(server, ["dc.sh4.cpu"]);
  describedNode(server, "dc.sh4.cpu").actions = ["sh4-disassembly", "sh4-memory", "sh4-registers"];
  await gotoRoute(page, "/workspace/sh4-debugger");
  await server.described();
  const view = await showRegisters(page, "SH4");
  const status = page.getByRole("status", { name: "Execution state" });

  await value(view, "R15").dblclick();
  await editor(view).fill("0x5A");
  await expect(editor(view)).toBeFocused();

  server.state.execution = { state: "running", stopId: 1 };
  server.tick();
  await expect(status).toContainText("Running");
  // no box while the target runs; the value has the focus the box had, and cannot be used
  await expect(editor(view)).toHaveCount(0);
  await expect(value(view, "R15")).toBeFocused();
  await expect(value(view, "R15")).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Enter");
  await page.keyboard.press("F2");
  await expect(editor(view)).toHaveCount(0);

  // a new stop: the box is not back, and what was typed is gone with it
  server.state.execution = { state: "paused", stopId: 2, reason: "pause" };
  server.tick();
  await expect(status).toContainText("stop 2");
  await page.waitForTimeout(300);
  await expect(editor(view)).toHaveCount(0);
  await expect(value(view, "R15")).toHaveText("0x8CFFF000");
  // the value is a control again, where the focus still is
  await expect(value(view, "R15")).toBeFocused();
  await expect(value(view, "R15")).not.toHaveAttribute("aria-disabled");
  await page.keyboard.press("Enter");
  await expect(editor(view)).toHaveValue("0x8CFFF000");
  await editor(view).press("Escape");
  expect(server.requestsOf("state.setRegister")).toEqual([]);
});

test("an emulator that is busy refuses a write (-32000): each of the three editors stays open with what was typed, and the notice says why", async ({ page }) => {
  const server = await serveScriptedDebugger(page);
  withRegisterWrites(server, ["dc.sh4.cpu"]);
  describedNode(server, "dc.sh4.cpu").actions = ["sh4-disassembly", "sh4-memory", "sh4-registers"];
  server.state.watches = [{ id: 4, expression: "dc.sh4.cpu.pr", value: "0x8C000F00" }];
  for (const method of ["state.setRegister", "state.editWatch", "state.writeMemory"]) {
    server.answer(method, () => inBandError(-32000, "emulator busy"));
  }
  await gotoRoute(page, "/workspace/sh4-debugger");
  await server.described();
  const busy = page.getByRole("alert").filter({ hasText: "emulator busy" });

  // a register
  const view = await showRegisters(page, "SH4");
  await write(view, "R15", "0x8CFFE000");
  await expect(busy).toBeVisible();
  await expect(editor(view)).toHaveValue("0x8CFFE000");
  await expect(editor(view)).toHaveAttribute("aria-invalid", "true");
  await expect(editor(view)).toHaveAttribute("title", "emulator busy");
  await expect(editor(view)).not.toHaveAttribute("aria-busy");
  // ... and again, from the same box: the notice that is up counts it
  await editor(view).press("Enter");
  await expect(busy).toContainText("×2");
  await expect(editor(view)).toHaveValue("0x8CFFE000");
  await editor(view).press("Escape");

  // the register of a watch
  const watches = panel(page, "watches").getByRole("listitem");
  await watches.getByText("0x8C000F00", { exact: true }).dblclick();
  await watches.getByRole("textbox").fill("0x8C000F04");
  await watches.getByRole("textbox").press("Enter");
  await expect(busy).toContainText("×3");
  await expect(watches.getByRole("textbox")).toHaveValue("0x8C000F04");
  await expect(watches.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
  await watches.getByRole("textbox").press("Escape");

  // a byte of memory
  const memory = panel(page, "sh4-memory");
  const hex = memory.locator(`[data-memory-hex="${0x8c010000}"]`);
  const box = (await hex.boundingBox())!;
  await hex.dblclick({ position: { x: 1.5 * (box.width / 47), y: box.height / 2 } });
  const bytes = memory.getByRole("textbox", { name: "Bytes to write from 0x8C010000" });
  await bytes.fill("AA BB");
  await bytes.press("Enter");
  await expect(busy).toContainText("×4");
  await expect(bytes).toHaveValue("AA BB");
  await expect(bytes).toHaveAttribute("aria-invalid", "true");
  await expect(bytes).toHaveAttribute("title", "emulator busy");

  // nothing was written, so nothing is read again: the views are as they were
  expect(server.requestsOf("state.setRegister")).toHaveLength(2);
  expect(server.requestsOf("state.editWatch")).toHaveLength(1);
  expect(server.requestsOf("state.writeMemory")).toEqual([{ target: "sh4", address: 0x8c010000, data: [0xaa, 0xbb] }]);
  expect(server.requestsOf("state.getMemorySlice")).toHaveLength(1);
  expect(server.requestsOf("state.getDisassembly")).toHaveLength(1);
});

// The tick a write caused reaches the client in front of its response or behind it, and is no
// new stop. The disassembly follows the new PC in both orders.
for (const order of ["the tick in front of the response", "the tick behind the response"] as const) {
  test(`a PC write with ${order}: the disassembly follows the new PC`, async ({ page }) => {
    const server = await serveScriptedDebugger(page);
    withRegisterWrites(server, ["dc.sh4.cpu"]);
    describedNode(server, "dc.sh4.cpu").actions = ["sh4-disassembly", "sh4-memory", "sh4-registers"];
    const tickOfTheWrite = (params: Json) => {
      server.setRegister("dc.sh4.cpu", String(params.name), String(params.value));
      // a paused tick of the same stop: stop 1, as every tick of this server
      server.tick();
    };
    server.answer("state.setRegister", (params) => {
      if (order === "the tick in front of the response") {
        tickOfTheWrite(params);
        return new Promise((resolve) => setTimeout(() => resolve({}), 400));
      }
      setTimeout(() => tickOfTheWrite(params), 400);
      return {};
    });
    await gotoRoute(page, "/workspace/sh4-debugger");
    await server.described();
    const listing = panel(page, "sh4-disassembly");
    expect(await currentInstructionAddress(listing)).toBe(0x8c001000);
    const view = await showRegisters(page, "SH4");

    // far from where the listing is: it has to move to show it
    await write(view, "PC", "0x8C009000");
    await expect(editor(view)).toHaveCount(0);
    await expect(value(view, "PC")).toHaveText("0x8C009000");
    expect(await currentInstructionAddress(listing)).toBe(0x8c009000);
    await expect(listing.locator(".current-instruction")).toBeInViewport({ ratio: 1 });
    await expect(disassemblyRows(listing).first()).toHaveAttribute("data-address", String(0x8c009000 - 10 * 2));
    await expect(listing.getByRole("textbox")).toHaveValue("0x8C009000");
    // it is where it went when everything has been answered, too
    await page.waitForTimeout(600);
    await expect(disassemblyRows(listing).first()).toHaveAttribute("data-address", String(0x8c009000 - 10 * 2));
    await expect(page.getByRole("status", { name: "Execution state" })).toHaveText("Paused · paused by the debugger · stop 1");

    // a PC another client wrote arrives as a tick alone, and moves the view the same way
    server.setRegister("dc.sh4.cpu", "PC", "0x8C00B000");
    server.tick();
    await expect.poll(() => currentInstructionAddress(listing)).toBe(0x8c00b000);
    await expect(listing.locator(".current-instruction")).toBeInViewport({ ratio: 1 });
  });
}

// ---------------------------------------------------------------------------------------
// The size of a real machine: some three thousand registers, a tick of about 165 KB.
// ---------------------------------------------------------------------------------------

test("a tree of 3,000 registers at five ticks a second: the register panel renders what changed, and nothing else", async ({ page }) => {
  test.setTimeout(240_000);
  const NODES = 120;
  const REGISTERS = 25;
  const SCOPE = '[data-panel-id="sh4-registers"]';
  // the paused tick of the emulator: every register, and a full event log
  const synthetic = await serveSyntheticDebugger(page, { nodes: NODES, registersPerNode: REGISTERS, eventLog: 200 });
  await installRenderCounter(page, SCOPE);
  await installLongTaskRecorder(page);
  await page.goto("/#/workspace/sh4-debugger");
  await synthetic.ready;
  await expect(treeItem(page, synthetic.nodePath(NODES - 1))).toBeVisible();
  // not smaller than the 165 KB of the emulator's, and within what a tick may be (192 KiB)
  expect(synthetic.tickBytes(), "bytes of a tick").toBeGreaterThan(165_000);
  expect(synthetic.tickBytes(), "bytes of a tick").toBeLessThan(192 * 1024);

  // the panel shows the node that offers it: the first of the tree, 25 rows that can all be edited
  const view = await showRegisters(page, "SH4");
  await expect(view.locator("caption")).toHaveText(`Node 000 ${synthetic.nodePath(0)}`);
  await expect(view.locator("tbody tr")).toHaveCount(REGISTERS);
  await expect(view.locator("td.register-value [data-editable]")).toHaveCount(REGISTERS);
  // the page that is measured is the page of a server the UI supports: nothing has to be said
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("note")).toHaveCount(0);

  /** Waits until the panel has stopped rendering by itself (a tooltip under the pointer opens and closes with a delay). */
  const settle = async () => {
    await page.mouse.move(1, 1);
    await expect
      .poll(
        async () => {
          await resetRenderCounts(page);
          await page.waitForTimeout(400);
          const counts = await readRenderCounts(page);
          return counts.rendered + counts.mounted;
        },
        { timeout: 60_000, message: "the register panel keeps rendering without input" },
      )
      .toBe(0);
  };

  /** Sends `ticks` ticks, one every 200 ms, each changing the first register of `change(index)` nodes; returns what the panel rendered. */
  const run = async (ticks: number, change: (index: number) => number[]) => {
    await settle();
    await takeLongTasks(page);
    await resetRenderCounts(page);
    for (let index = 0; index < ticks; index++) {
      synthetic.tick(change(index));
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(500);
    return { counts: await readRenderCounts(page), longTasks: await takeLongTasks(page) };
  };

  const TICKS = 15;
  // three seconds of ticks that say the same again
  const unchanged = await run(TICKS, () => []);
  // ... that change ten registers, none of them in the panel's node
  const elsewhere = await run(TICKS, (index) => Array.from({ length: 10 }, (_, node) => 1 + ((index * 10 + node) % (NODES - 1))));
  // ... and that change one register of the panel's node, and ten others
  const own = await run(TICKS, (index) => [0, ...Array.from({ length: 10 }, (_, node) => 1 + ((index * 10 + node) % (NODES - 1)))]);
  await expect(value(view, synthetic.registerName(0))).toHaveText(synthetic.value(0, 0));

  const report = {
    tree: { nodes: NODES, registersPerNode: REGISTERS, registers: NODES * REGISTERS },
    tickBytes: synthetic.tickBytes(),
    ticksPerPhase: TICKS,
    unchanged,
    elsewhere,
    own,
  };
  console.log(JSON.stringify(report));

  // a tick that changes nothing of the node renders nothing in the panel
  expect(unchanged.counts.rendered, "ticks that change nothing").toBe(0);
  expect(elsewhere.counts.rendered, "ticks that change other nodes").toBe(0);
  // a tick that changes one register renders the list and that row: not the other 24 rows
  expect(own.counts.rendered, "ticks that change one register of the node").toBe(TICKS * 2);
  for (const phase of [unchanged, elsewhere, own]) {
    expect(phase.counts.mounted).toBe(0);
  }
  // and the page keeps up with five ticks a second: no tick blocks it for as long as a tick lasts
  for (const [name, phase] of Object.entries({ unchanged, elsewhere, own })) {
    expect(Math.max(0, ...phase.longTasks), `${name}: longest task in ms (${JSON.stringify(phase.longTasks)})`).toBeLessThan(200);
  }

  // an open editor is state of its row: ticks that change its neighbours, and its own value, leave it as it is
  await value(view, synthetic.registerName(1)).dblclick();
  await editor(view).fill("0xFEED");
  for (let index = 0; index < 5; index++) {
    synthetic.tick([0, 1 + index]);
    await page.waitForTimeout(100);
  }
  await expect(editor(view)).toBeFocused();
  await expect(editor(view)).toHaveValue("0xFEED");
  await editor(view).press("Enter");
  await expect(editor(view)).toHaveCount(0);
  await expect(value(view, synthetic.registerName(1))).toHaveText("0x0000FEED");
  expect(synthetic.requests.filter((request) => request.method === "state.setRegister").map((request) => request.params)).toEqual([
    { path: synthetic.nodePath(0), name: synthetic.registerName(1), value: "0xFEED" },
  ]);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

// ---------------------------------------------------------------------------------------
// The window of a laptop: the register panel is part of two default layouts.
// ---------------------------------------------------------------------------------------

test.describe("in a window of 1366x768", () => {
  test.use({ viewport: { width: 1366, height: 768 }, mockOptions: { startPaused: true, graceMs: 600_000 } });

  for (const [workspace, target] of [
    ["sh4-debugger", "SH4"],
    ["arm7-debugger", "ARM7"],
  ] as const) {
    test(`${workspace}: the register panel can be read, and its editor is whole`, async ({ page }, testInfo) => {
      await openWorkspace(page, workspace);
      const view = await showRegisters(page, target);
      const frame = (await view.boundingBox())!;
      // every cell of the rows on screen is inside the panel: no column is cut off
      const inside = async (cell: Locator) => {
        const box = (await cell.boundingBox())!;
        return box.x >= frame.x - 0.5 && box.x + box.width <= frame.x + frame.width + 0.5;
      };
      // (the first rows: in this window the panel has a third of the height of the dock)
      const second = (await view.locator("tbody tr").nth(1).getAttribute("data-register"))!;
      for (const name of ["PC", second]) {
        for (const cell of await row(view, name).locator("td").all()) {
          await expect(cell).toBeVisible();
          expect(await inside(cell), `${name}: ${await cell.innerText()}`).toBe(true);
        }
        // (the + of the row: the value of a register that can be written is a button as well)
        await expect(row(view, name).locator("button.register-watch")).toBeInViewport({ ratio: 1 });
      }
      for (const header of await view.getByRole("columnheader").all()) {
        expect(await inside(header)).toBe(true);
      }
      // text that can be read
      expect(await value(view, "PC").evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(12);

      await value(view, "PC").dblclick();
      await expect(editor(view)).toBeInViewport({ ratio: 1 });
      expect(await inside(editor(view))).toBe(true);
      // the whole value fits its box
      const box = await editor(view).evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
      expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
      await saveScreenshot(page, testInfo, `registers-1366x768-${workspace}`);
    });
  }
});
