import {
  test,
  expect,
  addPanelFromSelector,
  currentInstructionAddress,
  disassemblyRow,
  disassemblyRows,
  openWorkspace,
  panel,
  pauseFromToolbar,
  recordFlashes,
  tooltipButton,
} from "./support/fixtures";

const hex8 = (address: number) => `0x${address.toString(16).toUpperCase().padStart(8, "0")}`;

for (const { name, workspace, id, disassembly, symbol, location, caller } of [
  {
    name: "SH4",
    workspace: "sh4-debugger",
    id: "sh4-callstack",
    disassembly: "sh4-disassembly",
    symbol: "SH4_func_",
    location: "sh4.c:",
    caller: 0x8c000000,
  },
  {
    name: "ARM7",
    workspace: "arm7-debugger",
    id: "arm7-callstack",
    disassembly: "arm7-disassembly",
    symbol: "ARM7_func_",
    location: "arm7.c:",
    caller: 0x00200000,
  },
] as const) {
  test(`${name}: Callstack lists the frames of the tick, the first one at the program counter`, async ({ page }) => {
    await openWorkspace(page, workspace);
    await pauseFromToolbar(page);
    const view = panel(page, id);
    const frames = view.getByRole("listitem");
    await expect(frames).toHaveCount(16);
    await expect(frames.nth(0)).toContainText("#0");
    await expect(frames.nth(0)).toContainText(`${symbol}0`);
    await expect(frames.nth(0)).toContainText(`${location}100`);
    await expect(frames.nth(15)).toContainText("#15");
    await expect(frames.nth(15)).toContainText(`${symbol}15`);

    // frame 0 is where the disassembly view says the target stopped
    const pc = await currentInstructionAddress(panel(page, disassembly));
    await expect(frames.nth(0)).toContainText(hex8(pc));
    await expect(frames.nth(1)).toContainText(hex8(caller));

    // and it follows a step
    await tooltipButton(panel(page, disassembly), "Step In").click();
    await expect(frames.nth(0)).not.toContainText(hex8(pc));
  });

  test(`${name}: clicking a frame address scrolls the disassembly view to it`, async ({ page }) => {
    await openWorkspace(page, workspace);
    await pauseFromToolbar(page);
    const view = panel(page, id);
    const code = panel(page, disassembly);
    const size = name === "SH4" ? 2 : 4;
    const target = caller + 5 * 4; // frame #6

    // look at something else first
    await code.getByRole("textbox").fill(hex8(caller + 0x4000));
    await code.getByRole("textbox").press("Enter");
    await expect(disassemblyRows(code).first()).toHaveAttribute("data-address", String(caller + 0x4000 - 10 * size));
    await expect(disassemblyRow(code, target)).toHaveCount(0);

    const flashes = await recordFlashes(code);
    // frame #6 (frame #0, the program counter, can show the same address)
    await view.getByRole("listitem").nth(6).getByText(hex8(target), { exact: true }).click();

    await expect(disassemblyRow(code, target)).toBeVisible();
    await expect(disassemblyRows(code).first()).toHaveAttribute("data-address", String(target - 10 * size));
    // and flashes the line of the frame
    await expect.poll(flashes).toEqual([target]);
  });
}

test("Events: Log shows the event log of the latest tick, newest first, and only changes with a tick", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  await addPanelFromSelector(page, 1, "Events: Log");
  const view = panel(page, "events");
  const entries = view.getByRole("listitem");

  // the mock keeps the last 60 events and sends all of them with every tick
  await expect(entries.first()).toBeVisible();
  const count = await entries.count();
  expect(count).toBeGreaterThanOrEqual(6);
  expect(count).toBeLessThanOrEqual(60);
  // HH:MM:SS.mmm, subsystem badge, message
  for (const text of await entries.allInnerTexts()) {
    expect(text).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} (SH4|HOLLY|TA|CORE|AICA|DSP) \S/);
  }
  const stamps = async () => (await entries.allInnerTexts()).map((text) => text.slice(0, 12));
  const first = await stamps();
  // newest first
  expect(first).toEqual([...first].sort().reverse());

  // the target is running and logging, but without a tick the panel is a snapshot
  await page.waitForTimeout(700);
  expect(await stamps()).toEqual(first);

  // the next tick (here: caused by Pause) replaces the list with newer events
  await pauseFromToolbar(page);
  await expect.poll(async () => (await stamps())[0] > first[0]).toBe(true);
  const second = await stamps();
  expect(second).toEqual([...second].sort().reverse());
  expect(second.length).toBeLessThanOrEqual(60);
});

test("a breakpoint hit is written to the event log", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  await addPanelFromSelector(page, 1, "Events: Log");
  await pauseFromToolbar(page);
  const breakpoints = panel(page, "sh4-breakpoints");
  await breakpoints.getByPlaceholder("Address (e.g., 0x8C0000A0)").fill("0x8C0000A8");
  await breakpoints.getByPlaceholder("Address (e.g., 0x8C0000A0)").press("Enter");
  await expect(breakpoints.getByRole("listitem")).toHaveCount(1);

  await tooltipButton(page, "Run").click();
  await expect(page.getByRole("alert").filter({ hasText: "Breakpoint hit" })).toBeVisible();
  // the mock logs one more frame event in the same emulation step, so the hit is the second newest
  const entries = panel(page, "events").getByRole("listitem");
  await expect(entries.nth(1)).toHaveText(/^\d{2}:\d{2}:\d{2}\.\d{3} SH4 SH4 breakpoint hit at 0x8C0000A8$/);
});
