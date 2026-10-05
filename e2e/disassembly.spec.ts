import {
  test,
  expect,
  breakpointGutter,
  currentInstructionAddress,
  disassemblyRow,
  disassemblyRows,
  openWorkspace,
  panel,
  pauseFromToolbar,
  recordFlashes,
  tooltipButton,
  KNOWN,
  type WorkspaceId,
} from "./support/fixtures";
import type { Locator } from "@playwright/test";

interface Target {
  name: string;
  workspace: WorkspaceId;
  disassembly: string;
  breakpoints: string;
  /** breakpoint event of the target's program counter */
  event: string;
  /** the mock steps through `loopLength` instructions starting here */
  loopStart: number;
  loopLength: number;
  instructionSize: number;
  /** how the address column prints an address */
  format: (address: number) => string;
  /** how the address box takes an address */
  input: (address: number) => string;
  bytesPattern?: RegExp;
  stepButtons: string[];
  defaultFirstAddress: number;
  /** an address far away from the loop, for the address box */
  farAddress: number;
}

const hex8 = (address: number) => `0x${address.toString(16).toUpperCase().padStart(8, "0")}`;
const step3 = (address: number) => address.toString().padStart(3, "0");

const TARGETS: Target[] = [
  {
    name: "SH4",
    workspace: "sh4-debugger",
    disassembly: "sh4-disassembly",
    breakpoints: "sh4-breakpoints",
    event: "dc.sh4.cpu.pc",
    loopStart: 0x8c0000a0,
    loopLength: 8,
    instructionSize: 2,
    format: hex8,
    input: hex8,
    bytesPattern: /^[0-9A-F]{2} [0-9A-F]{2}$/,
    stepButtons: ["Step Over", "Step In", "Step Out"],
    defaultFirstAddress: 0x8c010000,
    farAddress: 0x8c004000,
  },
  {
    name: "ARM7",
    workspace: "arm7-debugger",
    disassembly: "arm7-disassembly",
    breakpoints: "arm7-breakpoints",
    event: "dc.aica.arm7.pc",
    loopStart: 0x00200010,
    loopLength: 8,
    instructionSize: 4,
    format: hex8,
    input: hex8,
    bytesPattern: /^([0-9A-F]{2} ){3}[0-9A-F]{2}$/,
    stepButtons: ["Step Over", "Step In", "Step Out"],
    defaultFirstAddress: 0x00200000,
    farAddress: 0x00204000,
  },
  {
    name: "DSP",
    workspace: "audio-debugger",
    disassembly: "dsp-disassembly",
    breakpoints: "dsp-breakpoints",
    event: "dc.aica.dsp.step",
    // the DSP executes its 128 steps once per sample
    loopStart: 0,
    loopLength: 128,
    instructionSize: 1,
    format: step3,
    input: (address) => String(address),
    stepButtons: ["Step"],
    defaultFirstAddress: 0,
    farAddress: 60,
  },
];

const nextInLoop = (target: Target, address: number) =>
  target.loopStart + ((address - target.loopStart + target.instructionSize) % (target.loopLength * target.instructionSize));

/** Shows `address` in the view (through the address box), wherever the view was. */
const showAddress = async (view: Locator, target: Target, address: number) => {
  await view.getByRole("textbox").fill(target.input(address));
  await view.getByRole("textbox").press("Enter");
  await expect(disassemblyRow(view, address)).toBeVisible();
};

for (const target of TARGETS) {
  test.describe(`${target.name} disassembly`, () => {
    test.beforeEach(async ({ page, diagnostics }) => {
      if (target.workspace === "audio-debugger") {
        diagnostics.allow(...KNOWN.sgcNoData);
      }
      await openWorkspace(page, target.workspace);
    });

    test("shows 64 disassembled lines from the default address", async ({ page }) => {
      const view = panel(page, target.disassembly);
      const rows = disassemblyRows(view);
      await expect(rows).toHaveCount(64);
      await expect(rows.first()).toHaveAttribute("data-address", String(target.defaultFirstAddress));

      const cells = rows.first().locator("span");
      await expect(cells.nth(0)).toHaveText(target.format(target.defaultFirstAddress));
      if (target.bytesPattern) {
        // address, opcode bytes, mnemonic
        await expect(cells.nth(1)).toHaveText(target.bytesPattern);
        await expect(cells.nth(2)).toHaveText(/\S/);
      } else {
        await expect(cells.nth(1)).toHaveText(/\S/);
      }
      // consecutive instructions
      await expect(rows.nth(63)).toHaveAttribute(
        "data-address",
        String(target.defaultFirstAddress + 63 * target.instructionSize),
      );

      // nothing is highlighted and nothing can be stepped while the target runs
      await expect(view.locator(".current-instruction")).toHaveCount(0);
      for (const label of target.stepButtons) {
        await expect(tooltipButton(view, label)).toBeDisabled();
      }
    });

    test("pausing scrolls to the program counter and highlights it; every step button advances it", async ({ page }) => {
      const view = panel(page, target.disassembly);
      await pauseFromToolbar(page);

      let address = await currentInstructionAddress(view);
      expect(address).toBeGreaterThanOrEqual(target.loopStart);
      expect(address).toBeLessThan(target.loopStart + target.loopLength * target.instructionSize);
      await expect(view.locator(".current-instruction").locator("span").first()).toHaveText(target.format(address));

      for (const label of target.stepButtons) {
        await expect(tooltipButton(view, label)).toBeEnabled();
        await tooltipButton(view, label).click();
        // Step Over and Step In execute one instruction (the mock's loop has no calls). Step Out
        // resumes until the return, which for the mock is the branch at the end of its loop.
        const wrapped = label !== "Step Out" && nextInLoop(target, address) < address;
        address = label === "Step Out" ? target.loopStart : nextInLoop(target, address);
        if (wrapped && target.loopLength > 64) {
          // TODAY a step does not scroll the view, and the first of the DSP's 128 steps is not
          // among the 64 lines around the last one
          await tooltipButton(view, "Go to current PC").click();
        }
        await expect(view.locator(".current-instruction")).toHaveAttribute("data-address", String(address));
        await expect(tooltipButton(page, "Run")).toBeEnabled();
      }
      // exactly one row is highlighted
      await expect(view.locator(".current-instruction")).toHaveCount(1);
    });

    if (target.stepButtons.includes("Step Out")) {
      test("Step Out resumes the target and stops it again after the return", async ({ page, rpc }) => {
        const view = panel(page, target.disassembly);
        await pauseFromToolbar(page);
        const paused = await currentInstructionAddress(view);
        await tooltipButton(view, "Step In").click();
        // the tick of that step has arrived when the highlight has moved
        await expect(view.locator(".current-instruction")).toHaveAttribute("data-address", String(nextInLoop(target, paused)));
        const before = rpc.received.filter((frame) => frame.method === "event.tick").length;

        await tooltipButton(view, "Step Out").click();
        await expect(view.locator(".current-instruction")).toHaveAttribute("data-address", String(target.loopStart));
        await expect(tooltipButton(page, "Run")).toBeEnabled();
        // a running tick, then the paused tick of the new stop, which says that a step ended it
        const states = rpc.received
          .filter((frame) => frame.method === "event.tick")
          .slice(before)
          .map((frame) => (frame.params as { executionState: { state: string; reason?: string } }).executionState);
        expect(states[0]).toMatchObject({ state: "running" });
        expect(states.at(-1)).toMatchObject({ state: "paused", reason: "step" });
        expect(rpc.requests("control.stepOut").at(-1)?.params).toEqual({ target: target.name.toLowerCase() });
      });
    }

    test("clicking the gutter adds a breakpoint that the breakpoints panel lists; clicking again removes it", async ({
      page,
    }) => {
      const view = panel(page, target.disassembly);
      const breakpoints = panel(page, target.breakpoints);
      await pauseFromToolbar(page);
      await expect(breakpoints.getByText("No breakpoints defined.")).toBeVisible();

      const address = target.loopStart + 3 * target.instructionSize;
      await showAddress(view, target, address);
      const row = disassemblyRow(view, address);
      const gutter = breakpointGutter(row);
      await expect(gutter).toHaveAttribute("data-breakpoint", "none");
      await row.hover();
      await gutter.click();

      // enabled breakpoint: marker in the gutter, entry in the panel
      await expect(gutter).toHaveAttribute("data-breakpoint", "enabled");
      const entry = breakpoints.getByRole("listitem").filter({ hasText: `${target.event} == ${hex8(address)}` });
      await expect(entry).toBeVisible();
      await expect(entry.getByText("code", { exact: true })).toBeVisible();
      await expect(entry.getByRole("switch")).toBeChecked();
      await expect(breakpoints.getByRole("listitem")).toHaveCount(1);

      // ctrl+click and shift+click toggle it
      await gutter.click({ modifiers: ["Control"] });
      await expect(gutter).toHaveAttribute("data-breakpoint", "disabled");
      await expect(entry.getByRole("switch")).not.toBeChecked();
      await gutter.click({ modifiers: ["Shift"] });
      await expect(gutter).toHaveAttribute("data-breakpoint", "enabled");
      await expect(entry.getByRole("switch")).toBeChecked();

      // a plain click removes it
      await gutter.click();
      await expect(gutter).toHaveAttribute("data-breakpoint", "none");
      await expect(breakpoints.getByText("No breakpoints defined.")).toBeVisible();
    });

    test("Run stops at a breakpoint set in the gutter and reports it", async ({ page }) => {
      const view = panel(page, target.disassembly);
      await pauseFromToolbar(page);
      // two instructions ahead of where we are, so the stop is caused by the breakpoint
      const start = await currentInstructionAddress(view);
      const address = nextInLoop(target, nextInLoop(target, start));

      await showAddress(view, target, address);
      const row = disassemblyRow(view, address);
      await row.hover();
      await breakpointGutter(row).click();
      await expect(breakpointGutter(row)).toHaveAttribute("data-breakpoint", "enabled");

      await tooltipButton(page, "Run").click();
      await expect(
        page.getByRole("alert").filter({ hasText: `Breakpoint hit: ${target.event} == ${hex8(address)}` }),
      ).toBeVisible();
      await expect(tooltipButton(page, "Run")).toBeEnabled();
      await expect(view.locator(".current-instruction")).toHaveAttribute("data-address", String(address));
    });

    test("entering an address flashes its line", async ({ page }) => {
      // regression (race): the flash was applied from a 0 ms timer started on submit, before
      // the lines of the new range had been fetched; it only showed when the server won
      const view = panel(page, target.disassembly);
      const box = view.getByRole("textbox");
      const flashes = await recordFlashes(view);
      const size = target.instructionSize;
      const addresses = [target.farAddress, target.farAddress - 40 * size, target.farAddress + 20 * size];

      for (const [index, address] of addresses.entries()) {
        await box.fill(target.input(address));
        await box.press("Enter");
        await expect(disassemblyRow(view, address)).toBeVisible();
        await expect.poll(flashes).toEqual(addresses.slice(0, index + 1));
      }
    });

    test("the address box, the mouse wheel, Refresh and Go to current PC move the view", async ({ page, rpc }) => {
      const view = panel(page, target.disassembly);
      const rows = disassemblyRows(view);
      const box = view.getByRole("textbox");
      const size = target.instructionSize;

      // typing an address shows it with ten instructions of context above it
      await box.fill(target.input(target.farAddress));
      await box.press("Enter");
      await expect(rows.first()).toHaveAttribute("data-address", String(target.farAddress - 10 * size));
      await expect(disassemblyRow(view, target.farAddress)).toBeVisible();
      await expect(box).toHaveValue(target.input(target.farAddress));

      // the Go button does the same
      const second = target.farAddress - 8 * size;
      await box.fill(target.input(second));
      await view.getByRole("button", { name: "Go", exact: true }).click();
      await expect(rows.first()).toHaveAttribute("data-address", String(second - 10 * size));

      // one wheel notch scrolls six instructions, and the address box follows
      await rows.nth(5).hover();
      await page.mouse.wheel(0, 60);
      await expect(rows.first()).toHaveAttribute("data-address", String(second - 4 * size));
      await expect(box).toHaveValue(target.input(second + 6 * size));
      await page.mouse.wheel(0, -60);
      await expect(rows.first()).toHaveAttribute("data-address", String(second - 10 * size));

      // Refresh asks the server for the same range again
      const fetchesBefore = rpc.requests("state.getDisassembly").length;
      await tooltipButton(view, "Refresh").click();
      await expect.poll(() => rpc.requests("state.getDisassembly").length).toBe(fetchesBefore + 1);
      expect(rpc.requests("state.getDisassembly").at(-1)?.params).toEqual({
        target: target.name.toLowerCase(),
        address: second - 10 * size,
        count: 64,
      });
      await expect(rows).toHaveCount(64);
      await expect(rows.first()).toHaveAttribute("data-address", String(second - 10 * size));

      // Go to current PC brings the paused instruction back into view
      await pauseFromToolbar(page);
      const paused = await currentInstructionAddress(view);
      // somewhere the paused instruction is not among the 64 lines: the DSP can be at any of its 128 steps
      const away = target.name === "DSP" ? (paused < 64 ? paused + 21 : 10) : target.farAddress;
      await box.fill(target.input(away));
      await box.press("Enter");
      await expect(rows.first()).toHaveAttribute("data-address", String(away - 10 * size));
      await expect(view.locator(".current-instruction")).toHaveCount(0);
      await tooltipButton(view, "Go to current PC").click();
      await expect(view.locator(".current-instruction")).toHaveCount(1);
    });
  });
}
