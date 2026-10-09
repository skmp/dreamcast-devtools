import {
  test,
  expect,
  breakpointGutter,
  currentInstructionAddress,
  disassemblyRow,
  disassemblyRows,
  holdResponses,
  openWorkspace,
  panel,
  pauseFromToolbar,
  recordFlashes,
  tooltipButton,
  KNOWN,
  type HeldResponses,
  type WorkspaceId,
} from "./support/fixtures";
import { requestAsAnotherClient } from "./support/mockServer";
import { defaultAnswer, serveScriptedDebugger, V3_TARGETS } from "./support/scriptedDebugger";
import type { Locator } from "@playwright/test";

interface Target {
  name: string;
  workspace: WorkspaceId;
  disassembly: string;
  breakpoints: string;
  /** breakpoint event of the target's program counter */
  event: string;
  /** where the device tree has the program counter */
  pcPath: string;
  pcRegister: string;
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
    pcPath: "dc.sh4.cpu",
    pcRegister: "PC",
    loopStart: 0x8c0000a0,
    loopLength: 8,
    instructionSize: 2,
    format: hex8,
    input: hex8,
    bytesPattern: /^[0-9A-F]{2} [0-9A-F]{2}$/,
    stepButtons: ["Step Over", "Step In", "Step Out"],
    farAddress: 0x8c004000,
  },
  {
    name: "ARM7",
    workspace: "arm7-debugger",
    disassembly: "arm7-disassembly",
    breakpoints: "arm7-breakpoints",
    event: "dc.aica.arm7.pc",
    pcPath: "dc.aica.arm7",
    pcRegister: "PC",
    loopStart: 0x00200010,
    loopLength: 8,
    instructionSize: 4,
    format: hex8,
    input: hex8,
    bytesPattern: /^([0-9A-F]{2} ){3}[0-9A-F]{2}$/,
    stepButtons: ["Step Over", "Step In", "Step Out"],
    farAddress: 0x00204000,
  },
  {
    name: "DSP",
    workspace: "audio-debugger",
    disassembly: "dsp-disassembly",
    breakpoints: "dsp-breakpoints",
    event: "dc.aica.dsp.step",
    pcPath: "dc.aica.dsp",
    pcRegister: "STEP",
    // the DSP executes its 128 steps once per sample
    loopStart: 0,
    loopLength: 128,
    instructionSize: 1,
    format: step3,
    input: (address) => String(address),
    stepButtons: ["Step"],
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

    test("shows 64 disassembled lines around where the target is in the first tick", async ({ page, rpc }) => {
      const view = panel(page, target.disassembly);
      const rows = disassemblyRows(view);
      await expect(rows.first()).toBeVisible();
      // the first tick the page got on this connection says where the target is: the view
      // opens with ten instructions of context above that
      const firstTick = rpc.received.find((frame) => frame.method === "event.tick")?.params as {
        registers: Record<string, Array<{ name: string; value: string }>>;
      };
      const pc = Number.parseInt(firstTick.registers[target.pcPath].find((register) => register.name === target.pcRegister)!.value, 16);
      expect(pc).toBeGreaterThanOrEqual(target.loopStart);
      const firstAddress = Math.max(0, pc - 10 * target.instructionSize);
      await expect(rows.first()).toHaveAttribute("data-address", String(firstAddress));
      await expect(disassemblyRow(view, pc)).toBeVisible();
      // 64 lines; fewer only where the address space of the target ends (the DSP has 128 steps)
      const count = target.name === "DSP" ? Math.min(64, target.loopLength - firstAddress) : 64;
      await expect(rows).toHaveCount(count);

      const cells = rows.first().locator("span");
      await expect(cells.nth(0)).toHaveText(target.format(firstAddress));
      if (target.bytesPattern) {
        // address, opcode bytes, mnemonic
        await expect(cells.nth(1)).toHaveText(target.bytesPattern);
        await expect(cells.nth(2)).toHaveText(/\S/);
      } else {
        await expect(cells.nth(1)).toHaveText(/\S/);
      }
      // consecutive instructions
      await expect(rows.nth(count - 1)).toHaveAttribute("data-address", String(firstAddress + (count - 1) * target.instructionSize));

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
        // The view follows every stop: the first of the DSP's 128 steps is not among the 64
        // lines around the last one, and is shown without anything being clicked.
        address = label === "Step Out" ? target.loopStart : nextInLoop(target, address);
        await expect(view.locator(".current-instruction")).toHaveAttribute("data-address", String(address));
        await expect(view.locator(".current-instruction")).toBeInViewport({ ratio: 1 });
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
      // in the address format of the target
      const entry = breakpoints.getByRole("listitem").filter({ hasText: `${target.event} == ${target.format(address)}` });
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
        page.getByRole("alert").filter({ hasText: `Breakpoint hit: ${target.event} == ${target.format(address)}` }),
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

test("a word the debugger cannot read is listed as ?? <unreadable>, between the lines that can be read", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  const view = panel(page, "sh4-disassembly");
  // the flash ROM of the mock ends at 0x0021FFFF; what follows is not mapped
  await view.getByRole("textbox").fill("0x00220000");
  await view.getByRole("textbox").press("Enter");
  const rows = disassemblyRows(view);
  await expect(rows.first()).toHaveAttribute("data-address", String(0x00220000 - 20));
  await expect(rows).toHaveCount(64);

  const readable = disassemblyRow(view, 0x0021fffe).locator("span");
  await expect(readable.nth(1)).toHaveText(/^[0-9A-F]{2} [0-9A-F]{2}$/);
  await expect(readable.nth(2)).not.toHaveText("<unreadable>");
  for (const address of [0x00220000, 0x00220002, 0x00220000 + 53 * 2]) {
    const cells = disassemblyRow(view, address).locator("span");
    await expect(cells.nth(0)).toHaveText(hex8(address));
    await expect(cells.nth(1)).toHaveText("??");
    await expect(cells.nth(2)).toHaveText("<unreadable>");
  }
});

test.describe("where the address space of a target ends (addressMax of debugger.describe)", () => {
  test("ARM7: the last line is 0x00FFFFFC; the address box and the wheel ask for nothing beyond it", async ({ page, rpc }) => {
    await openWorkspace(page, "arm7-debugger");
    const view = panel(page, "arm7-disassembly");
    const rows = disassemblyRows(view);
    const box = view.getByRole("textbox");
    const LAST = 0x00fffffc;
    const listings = () =>
      rpc.requests("state.getDisassembly").map((frame) => frame.params as { target: string; address: number; count: number });

    // the last instruction of the ARM7, with ten of context: eleven lines, and not 64
    await box.fill(hex8(LAST));
    await box.press("Enter");
    await expect(rows.last()).toHaveAttribute("data-address", String(LAST));
    await expect(rows).toHaveCount(11);
    await expect(rows.first()).toHaveAttribute("data-address", String(LAST - 40));
    expect(listings().at(-1)).toEqual({ target: "arm7", address: LAST - 40, count: 11 });
    await expect(box).toHaveValue(hex8(LAST));

    // an address above the space is brought back into it
    await box.fill("0x01000000");
    await box.press("Enter");
    await expect(rows.first()).toHaveAttribute("data-address", String(0x01000000 - 40));
    await expect(rows.last()).toHaveAttribute("data-address", String(LAST));
    expect(listings().at(-1)).toEqual({ target: "arm7", address: 0x01000000 - 40, count: 10 });

    // the wheel stops at the last instruction: forty notches down from there end on it
    await rows.first().hover();
    await page.mouse.wheel(0, 2400);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute("data-address", String(LAST));
    expect(listings().at(-1)).toEqual({ target: "arm7", address: LAST, count: 1 });
    const settled = listings().length;
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(300);
    expect(listings()).toHaveLength(settled);
    // nothing the view asked for goes past the end
    for (const { address, count } of listings()) {
      expect(address + (count - 1) * 4, `${hex8(address)} x ${count}`).toBeLessThanOrEqual(LAST);
    }
    // and it scrolls back out of it
    await page.mouse.wheel(0, -60);
    await expect(rows.first()).toHaveAttribute("data-address", String(LAST - 24));
    await expect(rows).toHaveCount(7);
  });

  test("DSP: the last line is step 127, whatever step is asked for", async ({ page, rpc, diagnostics }) => {
    diagnostics.allow(...KNOWN.sgcNoData);
    await openWorkspace(page, "audio-debugger");
    const view = panel(page, "dsp-disassembly");
    const rows = disassemblyRows(view);
    const box = view.getByRole("textbox");
    await expect(rows.first()).toBeVisible();
    const listings = () =>
      rpc.requests("state.getDisassembly").map((frame) => frame.params as { target: string; address: number; count: number });

    for (const { typed, first, count } of [
      { typed: "128", first: 118, count: 10 },
      { typed: "999", first: 127, count: 1 },
      { typed: "0x7F", first: 117, count: 11 },
    ]) {
      await box.fill(typed);
      await box.press("Enter");
      await expect(rows.first(), typed).toHaveAttribute("data-address", String(first));
      await expect(rows, typed).toHaveCount(count);
      await expect(rows.last(), typed).toHaveAttribute("data-address", "127");
      expect(listings().at(-1), typed).toEqual({ target: "dsp", address: first, count });
      await expect(box, typed).toHaveValue("127");
    }
    for (const { address, count } of listings()) {
      expect(address + count - 1, `${address} x ${count}`).toBeLessThanOrEqual(127);
    }
  });
});

test("a target is what debugger.describe says it is: where its views open and end, its instruction size, its digits, its breakpoint event", async ({
  page,
}) => {
  // A server whose SH4 is none of what this UI has built in for a server that says nothing:
  // 24-bit addresses printed with six digits, instructions of four bytes, other defaults, the
  // program counter in another register and another event for its code breakpoints.
  const server = await serveScriptedDebugger(page);
  const targets = V3_TARGETS.map((target) => ({ ...target }));
  Object.assign(targets[0], {
    pcRegister: "PR",
    breakpointEvent: "cpu.fetch",
    instructionSize: 4,
    addressMax: 0x00ffffff,
    addressDigits: 6,
    defaultDisassemblyAddress: 0x00001000,
    defaultMemoryAddress: 0x00fffc00,
  });
  server.shape.targets = targets;
  server.state.registers["dc.sh4.cpu"].find((register) => register.name === "PR")!.value = "n/a";
  server.answer("state.getDisassembly", (params) => ({
    lines: Array.from({ length: Number(params.count) }, (_, index) => ({
      address: Number(params.address) + index * 4,
      bytes: "00 00 A0 E1",
      disassembly: "nop",
    })),
  }));
  server.answer("breakpoints.add", (params) => {
    server.state.breakpoints = { "1": { id: 1, event: params.event, address: params.address, kind: "code", enabled: true } };
    setTimeout(() => server.tick(), 0);
    return {};
  });
  await page.goto("/#/workspace/sh4-debugger");
  await expect(panel(page, "sh4-disassembly").locator("[data-address]").first()).toBeVisible();
  await server.described();
  const view = panel(page, "sh4-disassembly");
  const rows = disassemblyRows(view);
  const box = view.getByRole("textbox");
  const listings = () => server.requestsOf("state.getDisassembly");

  // the first tick does not say where the target is (PR is "n/a", and PC is not asked): the default address
  await expect(rows.first()).toHaveAttribute("data-address", String(0x1000));
  await expect(rows.first().locator("span").first()).toHaveText("0x001000");
  expect(listings()[0]).toEqual({ target: "sh4", address: 0x1000, count: 64 });
  await expect(rows.nth(1)).toHaveAttribute("data-address", String(0x1004));
  await expect(view.locator(".current-instruction")).toHaveCount(0);

  // a stop: the program counter is the register the server named
  server.setRegister("dc.sh4.cpu", "PR", "0x00001010");
  server.state.execution = { state: "paused", stopId: 2, reason: "step" };
  server.tick();
  await expect(view.locator(".current-instruction")).toHaveAttribute("data-address", String(0x1010));

  // a notch of the wheel is six instructions of four bytes
  await rows.nth(3).hover();
  await page.mouse.wheel(0, 60);
  await expect(rows.first()).toHaveAttribute("data-address", String(0x1000 + 24));
  await page.mouse.wheel(0, -60);
  await expect(rows.first()).toHaveAttribute("data-address", String(0x1000));

  // a breakpoint in the gutter is one of the event the server named, and is listed with six digits
  const row = disassemblyRow(view, 0x1008);
  await row.hover();
  await breakpointGutter(row).click();
  await expect(breakpointGutter(row)).toHaveAttribute("data-breakpoint", "enabled");
  expect(server.requestsOf("breakpoints.add")).toEqual([{ event: "cpu.fetch", address: 0x1008, kind: "code", enabled: true }]);
  await expect(panel(page, "sh4-breakpoints").getByRole("listitem")).toHaveText(/cpu\.fetch == 0x001008/);

  // the listing ends at the last instruction of 24 bits
  await box.fill("0xFFFFFC");
  await box.press("Enter");
  await expect(rows.last()).toHaveAttribute("data-address", String(0xfffffc));
  await expect(rows).toHaveCount(11);
  expect(listings().at(-1)).toEqual({ target: "sh4", address: 0xfffffc - 40, count: 11 });
  await expect(box).toHaveValue("0xFFFFFC");

  // the memory view opens where the server said, and ends with the address space
  const memory = panel(page, "sh4-memory");
  const slices = () => server.requestsOf("state.getMemorySlice");
  expect(slices()[0]).toEqual({ target: "sh4", address: 0xfffc00, length: 960 });
  await expect(memory.getByText("0xFFFC00", { exact: true })).toBeVisible();
  await memory.getByRole("textbox").fill("0xFFFFFF");
  await memory.getByRole("textbox").press("Enter");
  await expect(memory.getByText("0xFFFFF0", { exact: true })).toBeVisible();
  expect(slices().at(-1)).toEqual({ target: "sh4", address: 0xfffc40, length: 960 });
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("ticks do not make a disassembly view read again or move; a stop does both", async ({ page, rpc }) => {
  await openWorkspace(page, "sh4-debugger");
  const view = panel(page, "sh4-disassembly");
  const rows = disassemblyRows(view);
  await expect(rows).toHaveCount(64);
  const fetches = () => rpc.requests("state.getDisassembly").length;
  expect(fetches()).toBe(1);
  const opened = await rows.first().getAttribute("data-address");

  // running: the program counter moves with every tick, and the view stays as it opened
  await page.waitForTimeout(1200);
  expect(rpc.received.filter((frame) => frame.method === "event.tick").length).toBeGreaterThan(4);
  expect(fetches()).toBe(1);
  await expect(rows.first()).toHaveAttribute("data-address", opened!);

  // looking elsewhere, then a stop: the view comes to the program counter and reads again
  await view.getByRole("textbox").fill("0x8C004000");
  await view.getByRole("textbox").press("Enter");
  await expect(rows.first()).toHaveAttribute("data-address", String(0x8c004000 - 20));
  expect(fetches()).toBe(2);
  await pauseFromToolbar(page);
  const pc = await currentInstructionAddress(view);
  await expect(rows.first()).toHaveAttribute("data-address", String(pc - 20));
  await expect.poll(fetches).toBe(3);

  // a step whose line is on screen: read again, not moved
  await tooltipButton(view, "Step In").click();
  await expect(view.locator(".current-instruction")).not.toHaveAttribute("data-address", String(pc));
  await expect(rows.first()).toHaveAttribute("data-address", String(pc - 20));
  await expect.poll(fetches).toBe(4);
  expect(rpc.requests("state.getDisassembly").at(-1)?.params).toEqual({ target: "sh4", address: pc - 20, count: 64 });

  // the user scrolls away while it is paused; a watch is added (a paused tick of the same stop): nothing moves
  await view.getByRole("textbox").fill("0x8C004000");
  await view.getByRole("textbox").press("Enter");
  await expect(rows.first()).toHaveAttribute("data-address", String(0x8c004000 - 20));
  const watches = panel(page, "watches");
  await watches.getByPlaceholder("Enter expression").fill("dc.sh4.cpu.pr");
  await watches.getByPlaceholder("Enter expression").press("Enter");
  await expect(watches.getByRole("listitem")).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute("data-address", String(0x8c004000 - 20));
  expect(fetches()).toBe(5);

  // the next step is a stop off screen: the view follows it
  await tooltipButton(view, "Step In").click();
  await expect(view.locator(".current-instruction")).toHaveCount(1);
  await expect(view.locator(".current-instruction")).toBeInViewport({ ratio: 1 });
  await expect.poll(fetches).toBe(6);
});

test("an answer that lists an address twice shows it once, and leaves no line behind in the next listing", async ({ page }) => {
  // A server that breaks the protocol here: the lines of a listing ascend. The view knows a line
  // by its address, and two lines of one address used to leave one of them on screen for good.
  const server = await serveScriptedDebugger(page);
  let repeating = false;
  server.answer("state.getDisassembly", (params) => {
    const listing = defaultAnswer("state.getDisassembly", params) as { lines: Array<{ address: number; bytes: string; disassembly: string }> };
    if (!repeating) {
      return listing;
    }
    // every address a second time, with another text
    return { lines: listing.lines.flatMap((line, index) => [line, { ...line, disassembly: `odd ${index}` }]) };
  });
  await page.goto("/#/workspace/sh4-debugger");
  await server.described();
  const view = panel(page, "sh4-disassembly");
  const rows = disassemblyRows(view);
  const start = 0x8c001000 - 20;
  await expect(rows).toHaveCount(64);
  await expect(view.getByRole("note")).toHaveCount(0);

  repeating = true;
  await tooltipButton(view, "Refresh").click();
  // 128 lines for 64 addresses: each address once, with its first line, and the view says so
  await expect(view.getByRole("note")).toHaveText(
    "The server listed 64 lines for addresses it had already listed; each address is shown once.",
  );
  await expect(rows).toHaveCount(64);
  await expect(view).not.toContainText("odd");
  expect(await rows.evaluateAll((elements) => elements.map((element) => Number(element.getAttribute("data-address"))))).toEqual(
    Array.from({ length: 64 }, (_, index) => start + index * 2),
  );
  // the line of the stop is one line, and is marked
  await expect(view.locator(".current-instruction")).toHaveCount(1);

  // a correct listing again: its 64 lines and nothing else, here and after the view has moved
  repeating = false;
  await tooltipButton(view, "Refresh").click();
  await expect(view.getByRole("note")).toHaveCount(0);
  await expect(rows).toHaveCount(64);
  await rows.nth(3).hover();
  await page.mouse.wheel(0, 60);
  await expect(rows.first()).toHaveAttribute("data-address", String(start + 12));
  await expect(rows).toHaveCount(64);
  await expect(view).not.toContainText("odd");
});

test.describe("a breakpoint request that is answered late", () => {
  // The server answers breakpoints.add, toggle and remove when it has done what they ask, and
  // a busy emulator takes its time. The view reads its lines again when the answer is in:
  // where it is then, which need not be where it was at the click.

  /** The request for lines the view sent last has been answered, and the answer is on screen. */
  const linesRead = async (view: Locator, connection: HeldResponses) => {
    const request = connection.requests("state.getDisassembly").at(-1)!;
    await expect.poll(() => connection.answered(request)).toBe(true);
    await expect(view.getByText("Updating")).toBeHidden();
  };

  test("the target stops in the meantime: the view stays at the stop it followed", async ({ page, mock }) => {
    const connection = await holdResponses(page, "breakpoints.add");
    await openWorkspace(page, "sh4-debugger");
    const view = panel(page, "sh4-disassembly");
    const rows = disassemblyRows(view);
    const fetches = () => connection.requests("state.getDisassembly");

    // the user looks at code far from where the target runs, and sets a breakpoint there
    const away = 0x8c010000;
    await view.getByRole("textbox").fill(hex8(away));
    await view.getByRole("textbox").press("Enter");
    await expect(rows.first()).toHaveAttribute("data-address", String(away - 20));
    const row = disassemblyRow(view, away + 8);
    await row.hover();
    await breakpointGutter(row).click();
    await expect.poll(connection.held).toBe(1);

    // while that request is out, the breakpoint of somebody else stops the target in its loop
    const stop = 0x8c0000a4;
    await requestAsAnotherClient(mock.wsURL, "breakpoints.add", { event: "dc.sh4.cpu.pc", address: stop, kind: "code" });
    await expect(view.locator(".current-instruction")).toHaveAttribute("data-address", String(stop));
    await expect(rows.first()).toHaveAttribute("data-address", String(stop - 20));
    await linesRead(view, connection);
    const before = fetches().length;

    // the answer arrives: the lines are read again where the view is now
    connection.release();
    await expect.poll(() => fetches().length).toBe(before + 1);
    expect(fetches().at(-1)?.params).toEqual({ target: "sh4", address: stop - 20, count: 64 });
    await linesRead(view, connection);
    await expect(rows.first()).toHaveAttribute("data-address", String(stop - 20));
    await expect(view.locator(".current-instruction")).toHaveAttribute("data-address", String(stop));
    await expect(view.getByRole("textbox")).toHaveValue(hex8(stop));

    // the breakpoint the user asked for is there
    await view.getByRole("textbox").fill(hex8(away + 8));
    await view.getByRole("textbox").press("Enter");
    await expect(breakpointGutter(disassemblyRow(view, away + 8))).toHaveAttribute("data-breakpoint", "enabled");
  });

  test("a second click on the gutter while the first is unanswered sends nothing: one breakpoint, not two", async ({ page }) => {
    // The server makes a breakpoint for every breakpoints.add, two for two on one address: it is
    // the client that keeps a double click from leaving two behind one mark.
    const connection = await holdResponses(page, /^breakpoints\.(add|remove)$/);
    await openWorkspace(page, "sh4-debugger");
    const view = panel(page, "sh4-disassembly");
    const list = panel(page, "sh4-breakpoints").getByRole("listitem");
    const address = 0x8c0000a8;
    const row = disassemblyRow(view, address);
    const gutter = breakpointGutter(row);
    await row.hover();

    await gutter.dblclick();
    await expect.poll(connection.held).toBe(1);
    await gutter.click();
    // nothing more is on its way: the answer to the listing the page asks for next comes after them
    await tooltipButton(view, "Refresh").click();
    await linesRead(view, connection);
    expect(connection.requests("breakpoints.add").map((request) => request.params)).toEqual([
      { event: "dc.sh4.cpu.pc", address, kind: "code", enabled: true },
    ]);

    connection.release();
    await expect(gutter).toHaveAttribute("data-breakpoint", "enabled");
    await expect(list).toHaveCount(1);

    // the same for taking it away: one request, and the breakpoint is gone with it
    await gutter.dblclick();
    await expect.poll(connection.held).toBe(1);
    await tooltipButton(view, "Refresh").click();
    await linesRead(view, connection);
    expect(connection.requests("breakpoints.remove")).toHaveLength(1);
    connection.release();
    await expect(gutter).toHaveAttribute("data-breakpoint", "none");
    await expect(list).toHaveCount(0);
    expect(connection.requests("breakpoints.add")).toHaveLength(1);

    // answered, the gutter takes clicks again
    await gutter.click();
    await expect.poll(connection.held).toBe(1);
    connection.release();
    await expect(gutter).toHaveAttribute("data-breakpoint", "enabled");
    expect(connection.requests("breakpoints.add")).toHaveLength(2);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test.describe("with the view scrolled in the meantime", () => {
    test.use({ mockOptions: { startPaused: true } });

    test("adding, toggling and removing: the lines are read again where the view was scrolled to", async ({ page }) => {
      const connection = await holdResponses(page, /^breakpoints\.(add|toggle|remove)$/);
      await openWorkspace(page, "sh4-debugger");
      const view = panel(page, "sh4-disassembly");
      const rows = disassemblyRows(view);
      const fetches = () => connection.requests("state.getDisassembly");
      const opened = 0x8c0000a0 - 20;
      const scrolled = opened + 4 * 6 * 2;
      const row = disassemblyRow(view, 0x8c0000a8);
      const gutter = breakpointGutter(row);

      for (const edit of [
        { method: "breakpoints.add", click: () => gutter.click(), marker: "enabled" },
        { method: "breakpoints.toggle", click: () => gutter.click({ modifiers: ["Shift"] }), marker: "disabled" },
        { method: "breakpoints.remove", click: () => gutter.click(), marker: "none" },
      ]) {
        await test.step(edit.method, async () => {
          await expect(rows.first()).toHaveAttribute("data-address", String(opened));
          await linesRead(view, connection);
          await row.hover();
          await edit.click();
          await expect.poll(connection.held).toBe(1);
          expect(connection.requests(edit.method)).toHaveLength(1);

          // the user scrolls on: four notches of the wheel, 24 instructions
          await page.mouse.wheel(0, 240);
          await expect(rows.first()).toHaveAttribute("data-address", String(scrolled));
          await linesRead(view, connection);
          const box = await view.getByRole("textbox").inputValue();
          const before = fetches().length;

          connection.release();
          await expect.poll(() => fetches().length).toBe(before + 1);
          expect(fetches().at(-1)?.params).toEqual({ target: "sh4", address: scrolled, count: 64 });
          await linesRead(view, connection);
          // the listing is where the address box says it is
          await expect(rows.first()).toHaveAttribute("data-address", String(scrolled));
          await expect(view.getByRole("textbox")).toHaveValue(box);

          await page.mouse.wheel(0, -240);
          await expect(rows.first()).toHaveAttribute("data-address", String(opened));
          await expect(gutter).toHaveAttribute("data-breakpoint", edit.marker);
        });
      }
    });
  });
});
