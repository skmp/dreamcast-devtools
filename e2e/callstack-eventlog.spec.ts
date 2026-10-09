import {
  test,
  expect,
  addPanelFromSelector,
  currentInstructionAddress,
  disassemblyRow,
  disassemblyRows,
  gotoRoute,
  openWorkspace,
  panel,
  pauseFromToolbar,
  recordFlashes,
  registerRow,
  statusBar,
  tooltipButton,
  treeItemRow,
} from "./support/fixtures";

import { serveScriptedDebugger } from "./support/scriptedDebugger";

const hex8 = (address: number) => `0x${address.toString(16).toUpperCase().padStart(8, "0")}`;

for (const { name, workspace, id, disassembly, symbol, node, linkRegister, linkLocation, caller } of [
  {
    name: "SH4",
    workspace: "sh4-debugger",
    id: "sh4-callstack",
    disassembly: "sh4-disassembly",
    symbol: "_main_loop+0x",
    node: "dc.sh4.cpu",
    linkRegister: "PR",
    linkLocation: "pr",
    caller: 0x8c000000,
  },
  {
    name: "ARM7",
    workspace: "arm7-debugger",
    id: "arm7-callstack",
    disassembly: "arm7-disassembly",
    symbol: "arm7_main_loop+0x",
    node: "dc.aica.arm7",
    linkRegister: "R14",
    linkLocation: "lr",
    caller: 0x00200000,
  },
] as const) {
  test(`${name}: Callstack is empty while the target runs and lists the frames of the tick once it is paused`, async ({ page }) => {
    await openWorkspace(page, workspace);
    const view = panel(page, id);
    // running ticks carry no frames
    await expect(view.getByText("Empty callstack.")).toBeVisible();
    await expect(view.getByRole("listitem")).toHaveCount(0);

    await pauseFromToolbar(page);
    const frames = view.getByRole("listitem");
    await expect(frames).toHaveCount(16);

    // frame 0 is where the disassembly view says the target stopped, with its symbol and no location
    const pc = await currentInstructionAddress(panel(page, disassembly));
    await expect(frames.nth(0)).toContainText("#0");
    await expect(frames.nth(0)).toContainText(hex8(pc));
    await expect(frames.nth(0)).toContainText(symbol);
    // frame 1 is the link register, labelled as such
    await treeItemRow(page, node).click();
    const link = (await registerRow(page, `${node}.reg.${linkRegister}`).innerText()).replace(`${linkRegister} = `, "").trim();
    await expect(frames.nth(1)).toContainText("#1");
    await expect(frames.nth(1)).toContainText(link);
    await expect(frames.nth(1).getByText(linkLocation, { exact: true })).toBeVisible();
    // the rest was found on the stack
    await expect(frames.nth(2)).toContainText(hex8(caller + 4));
    await expect(frames.nth(2).getByText("stack+0x0", { exact: true })).toBeVisible();
    await expect(frames.nth(15)).toContainText("#15");
    await expect(frames.nth(15).getByText("stack+0x34", { exact: true })).toBeVisible();

    // and it follows a step
    await tooltipButton(panel(page, disassembly), "Step In").click();
    await expect(frames.nth(0)).not.toContainText(hex8(pc));
    await expect(frames).toHaveCount(16);

    // running again: empty again
    await tooltipButton(page, "Run").click();
    await expect(view.getByText("Empty callstack.")).toBeVisible();
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

/** "HH:MM:SS.mmm SUBSYSTEM @cycles event message": when (wall clock), who, when (SH4 cycles), which event, what */
const LOG_LINE =
  /^\d{2}:\d{2}:\d{2}\.\d{3} (SH4|HOLLY|TA|CORE|AICA|DSP|ARM7|GDROM|MAPLE|SYSTEM|DEBUGGER) @\d+ dc\.[a-z0-9_.]+ \S/;

test("Events: Log follows the target while it runs, newest first, and stands still while it is paused", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  await addPanelFromSelector(page, 1, "Events: Log");
  const view = panel(page, "events");
  const entries = view.getByRole("listitem");

  // the server logs for as long as a client is connected, and sends its log with every tick:
  // the list grows without anything being clicked
  await expect.poll(() => entries.count()).toBeGreaterThanOrEqual(3);
  const stamps = async () => (await entries.allInnerTexts()).map((text) => text.slice(0, 12));
  const first = await stamps();
  await expect.poll(() => entries.count()).toBeGreaterThan(first.length);

  await pauseFromToolbar(page);
  const paused = await entries.allInnerTexts();
  expect(paused.length).toBeGreaterThan(first.length);
  expect(paused.length).toBeLessThanOrEqual(200);
  for (const text of paused) {
    expect(text).toMatch(LOG_LINE);
  }
  // what the mock raises without a breakpoint: key on / key off and GD-ROM commands, the low-rate events
  // each with the name of its event (what an event breakpoint takes) and the SH4 cycle it was raised in
  expect(paused.some((text) => /AICA @\d+ dc\.aica\.channels\.key_on key on: channel \d+$/.test(text))).toBe(true);
  for (const text of paused) {
    expect(text).toMatch(
      /(AICA @\d+ dc\.aica\.channels\.key_(on|off) key (on|off): channel \d+|GDROM @\d+ dc\.gdrom\.command packet command 0x30 \(CD_READ\), sector \d+|SH4 @\d+ dc\.sh4\.exception exception: TRAPA #0x20)$/,
    );
  }
  // the cycles do not go back: the list is newest first
  const cycles = paused.map((text) => BigInt(/ @(\d+) /.exec(text)![1]));
  expect(cycles).toEqual([...cycles].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)));
  // newest first
  const pausedStamps = paused.map((text) => text.slice(0, 12));
  expect(pausedStamps).toEqual([...pausedStamps].sort().reverse());
  expect(pausedStamps.at(-1)).toBe(first.at(-1));

  // a paused target raises nothing, and a paused server sends no periodic tick
  await page.waitForTimeout(1200);
  expect(await entries.allInnerTexts()).toEqual(paused);
});

test("a high-rate event is logged only while a breakpoint on it exists, and such a breakpoint stops the target", async ({
  page,
}) => {
  await openWorkspace(page, "sh4-debugger");
  await addPanelFromSelector(page, 1, "Events: Log");
  await addPanelFromSelector(page, 3, "Events: Breakpoints");
  const log = panel(page, "events").getByRole("listitem");
  const breakpoints = panel(page, "events-breakpoints");
  await expect.poll(() => log.count()).toBeGreaterThanOrEqual(2);
  // vblank happens sixty times a second, and none of them is in the log
  await expect(log.filter({ hasText: "vblank" })).toHaveCount(0);

  await pauseFromToolbar(page);
  const input = breakpoints.getByPlaceholder("Event name (e.g., dc.aica.channel[0].step)");
  await input.fill("dc.holly.core.vblank");
  await input.press("Enter");
  await expect(breakpoints.getByRole("listitem")).toHaveCount(1);

  await tooltipButton(page, "Run").click();
  await expect(page.getByRole("alert").filter({ hasText: "Breakpoint hit: dc.holly.core.vblank" })).toBeVisible();
  await expect(tooltipButton(page, "Run")).toBeEnabled();
  // the one vblank that was raised while the breakpoint existed is in the log, among the newest
  // entries (a low-rate event of the same emulation step can be newer)
  const vblank = log.filter({ hasText: "vblank" });
  await expect(vblank).toHaveCount(1);
  await expect(vblank).toHaveText(/^\d{2}:\d{2}:\d{2}\.\d{3} CORE @\d+ dc\.holly\.core\.vblank vblank in, frame \d+$/);
  const newest = (await log.allInnerTexts()).slice(0, 3);
  expect(newest.some((text) => text.includes("vblank"))).toBe(true);
});

test("the callstack says how it was found: frame by frame, and as a whole", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  const view = panel(page, "sh4-callstack");
  // nothing to explain while there are no frames
  await expect(view.getByText("Empty callstack. The target is running.")).toBeVisible();
  await expect(view.getByRole("note")).toHaveCount(0);

  await pauseFromToolbar(page);
  const frames = view.getByRole("listitem");
  await expect(frames).toHaveCount(16);
  // the unwinder guesses, and the panel says so
  await expect(view.getByRole("note")).toHaveText(
    "Heuristic unwind. #0 is the program counter and #1 the link register (PR), which is not always the caller; the frames after it are return addresses found on the stack and can be stale.",
  );
  // each frame is labelled with where it comes from, and the label explains itself
  await expect(frames.nth(0).getByText(/^(pr|stack\+0x)/)).toHaveCount(0);
  await expect(frames.nth(1).getByText("pr", { exact: true })).toHaveAttribute(
    "title",
    "The link register (PR). In a function that has made a call it points into that function, not to its caller.",
  );
  await expect(frames.nth(2).getByText("stack+0x0", { exact: true })).toHaveAttribute(
    "title",
    "A value on the stack that looks like a return address: the instruction before it is a call.",
  );

  // without a connection there are no frames, and nothing that looks like them
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(view).toContainText("Not connected");
  await expect(frames).toHaveCount(0);
});

test("the event log shows what it does not know as it comes: a new subsystem, a new severity, no metadata", async ({ page }) => {
  // a server inside the test, which logs what the mock would not
  const server = await serveScriptedDebugger(page);
  server.state.eventLog = [
    { eventId: "1", timestamp: 1_700_000_000_000, subsystem: "sh4", severity: "info", message: "known", metadata: { event: "dc.sh4.interrupt", cycles: "448" } },
    { eventId: "2", timestamp: 1_700_000_000_001, subsystem: "netplay", severity: "fatal", message: "from the future", metadata: { event: "dc.netplay.desync", cycles: "18446744073709551615", extra: 1 } },
    // a v2 server sends no metadata
    { eventId: "3", timestamp: 1_700_000_000_002, subsystem: "holly", severity: "warn", message: "bare" },
  ];
  await gotoRoute(page, "/workspace/sh4-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");
  await addPanelFromSelector(page, 1, "Events: Log");
  const entries = panel(page, "events").getByRole("listitem");

  // newest first
  await expect(entries).toHaveText([
    /^\d{2}:\d{2}:\d{2}\.002 HOLLY bare$/,
    // the cycle count is a 64-bit decimal string and is printed as it is
    /^\d{2}:\d{2}:\d{2}\.001 NETPLAY @18446744073709551615 dc\.netplay\.desync from the future$/,
    /^\d{2}:\d{2}:\d{2}\.000 SH4 @448 dc\.sh4\.interrupt known$/,
  ]);
  await expect(entries.nth(1).getByText("@18446744073709551615")).toHaveAttribute("title", "SH4 cycles when the event was raised");
  await expect(entries.nth(1).getByText("dc.netplay.desync")).toHaveAttribute("title", "Event (the name an event breakpoint takes)");
  await expect(page.getByRole("alert")).toHaveCount(0);

  // without a connection there is no log: the panel says that, not that nothing has happened yet
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(panel(page, "events")).toHaveText("Not connected");
  await expect(entries).toHaveCount(0);
});
