import {
  test,
  expect,
  addPanelFromSelector,
  breakpointGutter,
  dockTab,
  disassemblyRow,
  openWorkspace,
  panel,
  pauseFromToolbar,
  tooltipButton,
} from "./support/fixtures";
import { requestAsAnotherClient } from "./support/mockServer";
import { serveScriptedDebugger, V3_TARGETS } from "./support/scriptedDebugger";
import type { Locator, Page } from "@playwright/test";

const entry = (view: Locator, text: string): Locator => view.getByRole("listitem").filter({ hasText: text });

/** The header row of a category in the Events: Breakpoints panel. */
const categoryHeader = (view: Locator, label: string): Locator =>
  view.locator("div").filter({ has: view.page().getByRole("heading", { name: label, exact: true }) }).last();

/** Scrolls the DSP disassembly view to a step through its address box (decimal). */
const showDspStep = async (page: Page, step: number) => {
  const disassembly = panel(page, "dsp-disassembly");
  await disassembly.getByRole("textbox").fill(String(step));
  await disassembly.getByRole("textbox").press("Enter");
  await expect(disassemblyRow(disassembly, step)).toBeVisible();
};

const openEventsBreakpoints = async (page: Page) => {
  // main dock, bottom-right group (the one that holds the target's own breakpoints panel)
  await addPanelFromSelector(page, 3, "Events: Breakpoints");
  await expect(panel(page, "events-breakpoints")).toBeVisible();
  return panel(page, "events-breakpoints");
};

test("SH4: Breakpoints adds by address, toggles and removes", async ({ page, rpc }) => {
  await openWorkspace(page, "sh4-debugger");
  await pauseFromToolbar(page);
  const view = panel(page, "sh4-breakpoints");
  const input = view.getByPlaceholder("Address (e.g., 0x8C0000A0)");
  const add = view.getByRole("button", { name: "Add", exact: true });
  await expect(add).toBeDisabled();

  await input.fill("0x8C0000A4");
  await expect(add).toBeEnabled();
  await input.press("Enter");
  await expect(entry(view, "dc.sh4.cpu.pc == 0x8C0000A4")).toBeVisible();
  await expect(input).toHaveValue("");
  expect(rpc.requests("breakpoints.add").at(-1)?.params).toEqual({
    event: "dc.sh4.cpu.pc",
    address: 0x8c0000a4,
    kind: "code",
    enabled: true,
  });

  // without the 0x prefix, through the button
  await input.fill("8c0000a8");
  await add.click();
  await expect(entry(view, "dc.sh4.cpu.pc == 0x8C0000A8")).toBeVisible();
  await expect(view.getByRole("listitem")).toHaveCount(2);

  // the disassembly view marks both addresses
  const disassembly = panel(page, "sh4-disassembly");
  await expect(breakpointGutter(disassemblyRow(disassembly, 0x8c0000a4))).toHaveAttribute("data-breakpoint", "enabled");
  await expect(breakpointGutter(disassemblyRow(disassembly, 0x8c0000a8))).toHaveAttribute("data-breakpoint", "enabled");

  // not an address: nothing is added
  await input.fill("zz");
  await input.press("Enter");
  await expect(view.getByRole("listitem")).toHaveCount(2);
  await input.fill("");

  // toggle
  const first = entry(view, "dc.sh4.cpu.pc == 0x8C0000A4");
  await first.getByRole("switch").click();
  await expect(first.getByRole("switch")).not.toBeChecked();
  await expect(breakpointGutter(disassemblyRow(disassembly, 0x8c0000a4))).toHaveAttribute("data-breakpoint", "disabled");
  await first.getByRole("switch").click();
  await expect(first.getByRole("switch")).toBeChecked();

  // remove
  await tooltipButton(first, "Remove breakpoint").click();
  await expect(first).toHaveCount(0);
  await expect(breakpointGutter(disassemblyRow(disassembly, 0x8c0000a4))).toHaveAttribute("data-breakpoint", "none");
  await tooltipButton(entry(view, "dc.sh4.cpu.pc == 0x8C0000A8"), "Remove breakpoint").click();
  await expect(view.getByText("No breakpoints defined.")).toBeVisible();
});

test("a disabled breakpoint does not stop the target, an enabled one does", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  await pauseFromToolbar(page);
  const view = panel(page, "sh4-breakpoints");
  await view.getByPlaceholder("Address (e.g., 0x8C0000A0)").fill("0x8C0000A6");
  await view.getByPlaceholder("Address (e.g., 0x8C0000A0)").press("Enter");
  const item = entry(view, "dc.sh4.cpu.pc == 0x8C0000A6");
  await item.getByRole("switch").click();
  await expect(item.getByRole("switch")).not.toBeChecked();

  await tooltipButton(page, "Run").click();
  await expect(tooltipButton(page, "Pause")).toBeEnabled();
  // the mock walks its 8-instruction loop every 128 ms; one second is several laps
  await page.waitForTimeout(1000);
  await expect(tooltipButton(page, "Pause")).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);

  await item.getByRole("switch").click();
  await expect(page.getByRole("alert").filter({ hasText: "Breakpoint hit: dc.sh4.cpu.pc == 0x8C0000A6" })).toBeVisible();
  await expect(tooltipButton(page, "Run")).toBeEnabled();
});

test("ARM7: Breakpoints adds, toggles and removes", async ({ page }) => {
  await openWorkspace(page, "arm7-debugger");
  await pauseFromToolbar(page);
  const view = panel(page, "arm7-breakpoints");
  const input = view.getByPlaceholder("Address (e.g., 0x8C0000A0)");

  await input.fill("0x00200018");
  await input.press("Enter");
  const item = entry(view, "dc.aica.arm7.pc == 0x00200018");
  await expect(item).toBeVisible();
  await expect(
    breakpointGutter(disassemblyRow(panel(page, "arm7-disassembly"), 0x00200018)),
  ).toHaveAttribute("data-breakpoint", "enabled");

  await item.getByRole("switch").click();
  await expect(item.getByRole("switch")).not.toBeChecked();
  await tooltipButton(item, "Remove breakpoint").click();
  await expect(view.getByText("No breakpoints defined.")).toBeVisible();
});

test("DSP: Breakpoints adds a step breakpoint, toggles and removes it", async ({ page }) => {
  await openWorkspace(page, "audio-debugger");
  await pauseFromToolbar(page);
  const view = panel(page, "dsp-breakpoints");
  const input = view.getByPlaceholder("Step value (e.g., 0, 5, 0x10)");

  await input.fill("5");
  await input.press("Enter");
  // a DSP step is decimal everywhere: in the box, in the list and in the disassembly view
  const item = entry(view, "dc.aica.dsp.step == 005");
  await expect(item).toBeVisible();
  // the DSP was paused at any of its 128 steps: bring step 5 into the disassembly view
  await showDspStep(page, 5);
  await expect(breakpointGutter(disassemblyRow(panel(page, "dsp-disassembly"), 5))).toHaveAttribute(
    "data-breakpoint",
    "enabled",
  );

  await item.getByRole("switch").click();
  await expect(item.getByRole("switch")).not.toBeChecked();
  await tooltipButton(item, "Remove breakpoint").click();
  await expect(view.getByText("No breakpoints defined.")).toBeVisible();
});

test("DSP: Breakpoints reads a plain number as a decimal step and 0x as hex", async ({ page }) => {
  // regression: the step was parsed with radix 16 although the placeholder ("0, 5, 0x10") and
  // the DSP disassembly view are decimal, so typing 10 set a breakpoint on step 16
  await openWorkspace(page, "audio-debugger");
  await pauseFromToolbar(page);
  const view = panel(page, "dsp-breakpoints");
  const input = view.getByPlaceholder("Step value (e.g., 0, 5, 0x10)");
  const disassembly = panel(page, "dsp-disassembly");
  // steps 10 and 16 on screen, wherever the DSP was paused
  await showDspStep(page, 10);
  await expect(disassemblyRow(disassembly, 16)).toBeVisible();

  await input.fill("10");
  await input.press("Enter");
  await expect(view.getByRole("listitem")).toHaveCount(1);
  await expect(breakpointGutter(disassemblyRow(disassembly, 10))).toHaveAttribute("data-breakpoint", "enabled");
  await expect(breakpointGutter(disassemblyRow(disassembly, 16))).toHaveAttribute("data-breakpoint", "none");

  await input.fill("0x10");
  await input.press("Enter");
  await expect(view.getByRole("listitem")).toHaveCount(2);
  await expect(breakpointGutter(disassemblyRow(disassembly, 16))).toHaveAttribute("data-breakpoint", "enabled");
});

test("Events: Breakpoints suggests the events of the device tree and lists every breakpoint by category", async ({
  page,
}) => {
  await openWorkspace(page, "sh4-debugger");
  await pauseFromToolbar(page);
  const view = await openEventsBreakpoints(page);
  await expect(view.getByText("No breakpoints defined.")).toBeVisible();

  const input = view.getByPlaceholder("Event name (e.g., dc.aica.channel[0].step)");
  await input.pressSequentially("dc.sh4.");
  await expect(page.getByRole("option", { name: "dc.sh4.interrupt", exact: true })).toBeVisible();
  await page.getByRole("option", { name: "dc.sh4.exception", exact: true }).click();
  await view.getByRole("button", { name: "Add", exact: true }).click();

  const eventEntry = entry(view, "dc.sh4.exception");
  await expect(eventEntry).toBeVisible();
  await expect(eventEntry.getByText("event", { exact: true })).toBeVisible();
  await expect(view.getByRole("heading", { name: "Events", exact: true })).toBeVisible();

  // a code breakpoint set elsewhere shows up under its own category
  const disassembly = panel(page, "sh4-disassembly");
  const row = disassemblyRow(disassembly, 0x8c0000a2);
  await row.hover();
  await breakpointGutter(row).click();
  await expect(view.getByRole("heading", { name: "SH4", exact: true })).toBeVisible();
  await expect(entry(view, "dc.sh4.cpu.pc == 0x8C0000A2")).toBeVisible();
  await expect(view.getByRole("listitem")).toHaveCount(2);

  // toggle and remove work from here too
  await eventEntry.getByRole("switch").click();
  await expect(eventEntry.getByRole("switch")).not.toBeChecked();
  await tooltipButton(eventEntry, "Remove breakpoint").click();
  await expect(eventEntry).toHaveCount(0);
  await expect(view.getByRole("heading", { name: "Events", exact: true })).toHaveCount(0);
});

test("an event breakpoint stops the target when its event is raised; the server refuses an event it does not raise", async ({
  page,
  rpc,
}) => {
  await openWorkspace(page, "sh4-debugger");
  await pauseFromToolbar(page);
  const view = await openEventsBreakpoints(page);
  const input = view.getByPlaceholder("Event name (e.g., dc.aica.channel[0].step)");

  // free text is accepted by the panel, and refused by the server: -32004, in-band
  await input.fill("dc.sh4.tlb_miss");
  await input.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "not supported: event dc.sh4.tlb_miss" })).toBeVisible();
  await expect(view.getByText("No breakpoints defined.")).toBeVisible();
  const refused = rpc.received.find((frame) => frame.id === rpc.requests("breakpoints.add").at(-1)?.id);
  expect(refused?.result).toEqual({ error: { code: -32004, message: "not supported: event dc.sh4.tlb_miss" } });

  // the mock keys a channel on about twice a second
  await input.fill("dc.aica.channels.key_on");
  await input.press("Enter");
  await expect(entry(view, "dc.aica.channels.key_on")).toBeVisible();
  expect(rpc.requests("breakpoints.add").at(-1)?.params).toEqual({ event: "dc.aica.channels.key_on", kind: "event", enabled: true });

  await tooltipButton(page, "Run").click();
  await expect(page.getByRole("alert").filter({ hasText: "Breakpoint hit: dc.aica.channels.key_on" })).toBeVisible();
  await expect(tooltipButton(page, "Run")).toBeEnabled();
  // the tick of the stop says why, and which breakpoint
  const stop = rpc.received.filter((frame) => frame.method === "event.tick").at(-1)?.params as {
    executionState: { state: string; reason: string; breakpointId: number; stopId: number };
    breakpoints: Record<string, { event: string }>;
  };
  expect(stop.executionState).toMatchObject({ state: "paused", reason: "event" });
  expect(stop.breakpoints[String(stop.executionState.breakpointId)].event).toBe("dc.aica.channels.key_on");

  // disabled, it does not stop the target
  await entry(view, "dc.aica.channels.key_on").getByRole("switch").click();
  await expect(entry(view, "dc.aica.channels.key_on").getByRole("switch")).not.toBeChecked();
  await tooltipButton(page, "Run").click();
  await expect(tooltipButton(page, "Pause")).toBeEnabled();
  await page.waitForTimeout(1500);
  await expect(tooltipButton(page, "Pause")).toBeEnabled();
});

test("muting a category keeps its breakpoints from stopping the target; unmuting restores them", async ({ page, rpc }) => {
  await openWorkspace(page, "sh4-debugger");
  await pauseFromToolbar(page);
  const view = await openEventsBreakpoints(page);

  const row = disassemblyRow(panel(page, "sh4-disassembly"), 0x8c0000a6);
  await row.hover();
  await breakpointGutter(row).click();
  await expect(entry(view, "dc.sh4.cpu.pc == 0x8C0000A6")).toBeVisible();

  const header = categoryHeader(view, "SH4");
  await header.getByRole("button", { name: "Mute category" }).click();
  await expect(header.getByRole("button", { name: "Unmute category" })).toBeVisible();
  expect(rpc.requests("breakpoints.setCategoryStates").at(-1)?.params).toMatchObject({
    categories: { sh4: { muted: true, soloed: false } },
  });

  await tooltipButton(page, "Run").click();
  await expect(tooltipButton(page, "Pause")).toBeEnabled();
  await page.waitForTimeout(1000);
  await expect(tooltipButton(page, "Pause")).toBeEnabled();

  await header.getByRole("button", { name: "Unmute category" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Breakpoint hit: dc.sh4.cpu.pc == 0x8C0000A6" })).toBeVisible();
  await expect(tooltipButton(page, "Run")).toBeEnabled();
});

test("soloing a category disables the breakpoints of the others", async ({ page, rpc }) => {
  await openWorkspace(page, "sh4-debugger");
  await pauseFromToolbar(page);
  const view = await openEventsBreakpoints(page);

  // one SH4 code breakpoint and one event breakpoint, on an event the mock does not raise by itself
  const row = disassemblyRow(panel(page, "sh4-disassembly"), 0x8c0000a6);
  await row.hover();
  await breakpointGutter(row).click();
  const input = view.getByPlaceholder("Event name (e.g., dc.aica.channel[0].step)");
  await input.fill("dc.system.reset");
  await input.press("Enter");
  await expect(view.getByRole("listitem")).toHaveCount(2);

  await categoryHeader(view, "Events").getByRole("button", { name: "Solo category" }).click();
  await expect(categoryHeader(view, "Events").getByRole("button", { name: "Unsolo category" })).toBeVisible();
  expect(rpc.requests("breakpoints.setCategoryStates").at(-1)?.params).toMatchObject({
    categories: { events: { muted: false, soloed: true }, sh4: { muted: false, soloed: false } },
  });

  // the SH4 breakpoint is not soloed, so running does not stop on it
  await tooltipButton(page, "Run").click();
  await expect(tooltipButton(page, "Pause")).toBeEnabled();
  await page.waitForTimeout(1000);
  await expect(tooltipButton(page, "Pause")).toBeEnabled();

  // soloing SH4 instead moves the solo and lets the breakpoint fire
  await categoryHeader(view, "SH4").getByRole("button", { name: "Solo category" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Breakpoint hit: dc.sh4.cpu.pc == 0x8C0000A6" })).toBeVisible();
  await expect(categoryHeader(view, "SH4").getByRole("button", { name: "Unsolo category" })).toBeVisible();
  await expect(categoryHeader(view, "Events").getByRole("button", { name: "Solo category" })).toBeVisible();
});

test("the mute and solo buttons of a disassembly view work without a breakpoints panel", async ({ page, rpc }) => {
  // regression: only the breakpoints panels told breakpointCategoryState which client to use.
  // The mixed-mode workspace has none by default, so these buttons changed their icon and
  // sent nothing to the server.
  await openWorkspace(page, "mixed-mode-debugger");
  await pauseFromToolbar(page);
  const disassembly = panel(page, "sh4-disassembly");
  const row = disassemblyRow(disassembly, 0x8c0000a6);
  await row.hover();
  await breakpointGutter(row).click();
  await expect(breakpointGutter(row)).toHaveAttribute("data-breakpoint", "enabled");

  await disassembly.getByRole("button", { name: "Mute category" }).click();
  await expect(disassembly.getByRole("button", { name: "Unmute category" })).toBeVisible();
  await expect.poll(() => rpc.requests("breakpoints.setCategoryStates").length).toBe(1);
  expect(rpc.requests("breakpoints.setCategoryStates")[0].params).toMatchObject({
    categories: { sh4: { muted: true, soloed: false } },
  });

  // muted: the breakpoint does not stop the target
  await tooltipButton(page, "Run").click();
  await expect(tooltipButton(page, "Pause")).toBeEnabled();
  await page.waitForTimeout(1000);
  await expect(tooltipButton(page, "Pause")).toBeEnabled();

  // soloing the ARM7 category from the other view keeps SH4 breakpoints inactive
  await disassembly.getByRole("button", { name: "Unmute category" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Breakpoint hit: dc.sh4.cpu.pc == 0x8C0000A6" })).toBeVisible();
  await panel(page, "arm7-disassembly").getByRole("button", { name: "Solo category" }).click();
  await expect.poll(() => rpc.requests("breakpoints.setCategoryStates").at(-1)?.params).toMatchObject({
    categories: { arm7: { muted: false, soloed: true }, sh4: { muted: false, soloed: false } },
  });
  await tooltipButton(page, "Run").click();
  await expect(tooltipButton(page, "Pause")).toBeEnabled();
  await page.waitForTimeout(1000);
  await expect(tooltipButton(page, "Pause")).toBeEnabled();
});

test("mute and solo are kept by the server: a reload shows them again, and so does a change made elsewhere", async ({
  page,
  mock,
  rpc,
}) => {
  // The workspace has no breakpoints panel: nothing but the session itself tells the
  // category buttons which connection to use, or what the server's state is.
  await openWorkspace(page, "mixed-mode-debugger");
  const sh4 = panel(page, "sh4-disassembly");
  const arm7 = panel(page, "arm7-disassembly");
  await sh4.getByRole("button", { name: "Mute category" }).click();
  await expect(sh4.getByRole("button", { name: "Unmute category" })).toBeVisible();
  await arm7.getByRole("button", { name: "Solo category" }).click();
  await expect(arm7.getByRole("button", { name: "Unsolo category" })).toBeVisible();
  // every request names all four categories, so that the server ends up with what the buttons show
  expect(rpc.requests("breakpoints.setCategoryStates").at(-1)?.params).toEqual({
    categories: {
      events: { muted: false, soloed: false },
      sh4: { muted: true, soloed: false },
      arm7: { muted: false, soloed: true },
      dsp: { muted: false, soloed: false },
    },
  });

  // a new page of the same server: the buttons are as they were left, from its first tick
  await page.reload();
  await expect(panel(page, "sh4-disassembly").getByRole("button", { name: "Unmute category" })).toBeVisible();
  await expect(panel(page, "arm7-disassembly").getByRole("button", { name: "Unsolo category" })).toBeVisible();
  await expect(panel(page, "sh4-disassembly").getByRole("button", { name: "Solo category" })).toBeVisible();
  expect(rpc.requests("breakpoints.setCategoryStates")).toHaveLength(2);

  // another client unmutes the SH4 category and moves the solo to it: this page follows the tick
  expect(
    await requestAsAnotherClient(mock.wsURL, "breakpoints.setCategoryStates", {
      categories: { sh4: { muted: false, soloed: true }, arm7: { muted: false, soloed: false } },
    }),
  ).toEqual({});
  await expect(panel(page, "sh4-disassembly").getByRole("button", { name: "Mute category" })).toBeVisible();
  await expect(panel(page, "sh4-disassembly").getByRole("button", { name: "Unsolo category" })).toBeVisible();
  await expect(panel(page, "arm7-disassembly").getByRole("button", { name: "Solo category" })).toBeVisible();
  // the page sent nothing for that
  expect(rpc.requests("breakpoints.setCategoryStates")).toHaveLength(2);
});

test("the list of a target has that target's code breakpoints, each in the address format of its target", async ({
  page,
  mock,
}) => {
  await openWorkspace(page, "audio-debugger");
  await pauseFromToolbar(page);
  const dsp = panel(page, "dsp-breakpoints");
  const step = dsp.getByPlaceholder("Step value (e.g., 0, 5, 0x10)");

  // a DSP step, in hex ...
  await step.fill("0x7F");
  await step.press("Enter");
  // ... is listed in decimal, three digits: as the DSP disassembly view numbers its steps
  await expect(entry(dsp, "dc.aica.dsp.step == 127")).toBeVisible();
  // a step that is not a number in the DSP's radix is not sent
  await step.fill("1f");
  await step.press("Enter");
  await expect(dsp.getByRole("listitem")).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await step.fill("");

  // two events whose names say "sh4" and "aica", in the panel of all breakpoints (a tab of the same group)
  const events = await openEventsBreakpoints(page);
  const input = events.getByPlaceholder("Event name (e.g., dc.aica.channel[0].step)");
  for (const event of ["dc.sh4.exception", "dc.aica.timer"]) {
    await input.fill(event);
    await input.press("Enter");
    await expect(entry(events, event)).toBeVisible();
  }
  await expect(events.getByRole("listitem")).toHaveCount(3);
  await expect(entry(events, "dc.aica.dsp.step == 127")).toBeVisible();
  await expect(events.getByRole("heading", { name: "DSP", exact: true })).toBeVisible();
  await expect(events.getByRole("heading", { name: "Events", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  // the panel of the DSP lists the code breakpoints of the DSP, and events are not that
  await dockTab(page, "DSP: Breakpoints").click();
  await expect(dsp.getByRole("listitem")).toHaveCount(1);
  await expect(entry(dsp, "dc.aica.dsp.step == 127")).toBeVisible();

  // Nor are the code breakpoints of the other targets. Somebody else sets one on the SH4 and
  // one on the ARM7; the panel of all breakpoints has them when their tick is in.
  await requestAsAnotherClient(mock.wsURL, "breakpoints.add", { event: "dc.sh4.cpu.pc", address: 0x8c0000a4, kind: "code" });
  await requestAsAnotherClient(mock.wsURL, "breakpoints.add", { event: "dc.aica.arm7.pc", address: 0x00200014, kind: "code" });
  await dockTab(page, "Events: Breakpoints").click();
  await expect(events.getByRole("listitem")).toHaveCount(5);
  await expect(entry(events, "dc.sh4.cpu.pc == 0x8C0000A4")).toBeVisible();
  await expect(entry(events, "dc.aica.arm7.pc == 0x00200014")).toBeVisible();
  await dockTab(page, "DSP: Breakpoints").click();
  await expect(dsp.getByRole("listitem")).toHaveCount(1);
  await expect(entry(dsp, "dc.aica.dsp.step == 127")).toBeVisible();
  // and the panel of the SH4 lists the one of the SH4: not the DSP step, not the ARM7's
  await addPanelFromSelector(page, 3, "SH4: Breakpoints");
  const sh4 = panel(page, "sh4-breakpoints");
  await expect(sh4.getByRole("listitem")).toHaveCount(1);
  await expect(entry(sh4, "dc.sh4.cpu.pc == 0x8C0000A4")).toBeVisible();
  await addPanelFromSelector(page, 3, "ARM7: Breakpoints");
  const arm7 = panel(page, "arm7-breakpoints");
  await expect(arm7.getByRole("listitem")).toHaveCount(1);
  await expect(entry(arm7, "dc.aica.arm7.pc == 0x00200014")).toBeVisible();
});

test("the address box, the hit notice and the reason of a stop write addresses as debugger.describe says the target does", async ({
  page,
}) => {
  // A server none of whose targets writes addresses the way this UI has built in for a server
  // that says nothing: an SH4 of 24 bits and six digits, an ARM7 whose addresses are decimal,
  // a DSP whose steps are hex. A client that formats or reads with its own table passes every
  // test against a server that agrees with the table.
  const server = await serveScriptedDebugger(page);
  server.setRegister("dc.sh4.cpu", "PC", "0x00001000");
  server.describeAgain();
  const targets = V3_TARGETS.map((target) => ({ ...target }));
  Object.assign(targets[0], { addressMax: 0x00ffffff, addressDigits: 6 });
  Object.assign(targets[1], { addressRadix: 10, addressDigits: 7 });
  Object.assign(targets[2], { addressRadix: 16, addressDigits: 2 });
  server.shape.targets = targets;
  let ids = 0;
  server.answer("breakpoints.add", (params) => {
    const id = ++ids;
    server.state.breakpoints = { ...server.state.breakpoints, [String(id)]: { id, event: params.event, address: params.address, kind: params.kind, enabled: true } };
    setTimeout(() => server.tick(), 0);
    return {};
  });
  await page.goto("/#/workspace/sh4-debugger");
  await server.described();
  await expect(panel(page, "sh4-disassembly").locator(".current-instruction")).toHaveCount(1);
  const status = page.getByRole("status", { name: "Execution state" });
  const alerts = page.getByRole("alert");
  await expect(status).toHaveText("Paused · paused by the debugger · stop 1");

  // --- the box of each panel reads what is typed in the radix of its target ---
  const sh4 = panel(page, "sh4-breakpoints");
  await sh4.getByRole("textbox").fill("1008");
  await sh4.getByRole("textbox").press("Enter");
  await expect(sh4.getByRole("listitem")).toHaveText(/dc\.sh4\.cpu\.pc == 0x001008/);

  // decimal: "2097168" is that number, not 0x2097168; and what is no decimal number is not sent
  await addPanelFromSelector(page, 3, "ARM7: Breakpoints");
  const arm7 = panel(page, "arm7-breakpoints");
  await arm7.getByRole("textbox").fill("20001f");
  await arm7.getByRole("textbox").press("Enter");
  await arm7.getByRole("textbox").fill("2097168");
  await arm7.getByRole("textbox").press("Enter");
  await expect(arm7.getByRole("listitem")).toHaveText(/dc\.aica\.arm7\.pc == 2097168/);

  // hex: "1f" is 31, and "10" is 16
  await addPanelFromSelector(page, 3, "DSP: Breakpoints");
  const dsp = panel(page, "dsp-breakpoints");
  await dsp.getByRole("textbox").fill("1f");
  await dsp.getByRole("textbox").press("Enter");
  await expect(dsp.getByRole("listitem")).toHaveText(/dc\.aica\.dsp\.step == 0x1F/);
  await dsp.getByRole("textbox").fill("10");
  await dsp.getByRole("textbox").press("Enter");
  await expect(dsp.getByRole("listitem")).toHaveText([/dc\.aica\.dsp\.step == 0x1F/, /dc\.aica\.dsp\.step == 0x10/]);

  expect(server.requestsOf("breakpoints.add")).toEqual([
    { event: "dc.sh4.cpu.pc", address: 0x1008, kind: "code", enabled: true },
    { event: "dc.aica.arm7.pc", address: 2097168, kind: "code", enabled: true },
    { event: "dc.aica.dsp.step", address: 0x1f, kind: "code", enabled: true },
    { event: "dc.aica.dsp.step", address: 0x10, kind: "code", enabled: true },
  ]);
  await expect(alerts).toHaveCount(0);

  // --- a hit of each: the notice and the reason next to the run controls say where, the same way ---
  let stopId = 1;
  for (const [breakpointId, text] of [
    [1, "dc.sh4.cpu.pc == 0x001008"],
    [2, "dc.aica.arm7.pc == 2097168"],
    [3, "dc.aica.dsp.step == 0x1F"],
  ] as const) {
    server.state.execution = { state: "paused", stopId: ++stopId, reason: "breakpoint", breakpointId };
    server.tick();
    await expect(status).toHaveText(`Paused · breakpoint ${text} · stop ${stopId}`);
    await expect(alerts.filter({ hasText: "Breakpoint hit" }).last()).toHaveText(`Breakpoint hit: ${text}`);
  }
});
