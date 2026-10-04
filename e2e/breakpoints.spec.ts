import {
  test,
  expect,
  addPanelFromSelector,
  breakpointGutter,
  disassemblyRow,
  openWorkspace,
  panel,
  pauseFromToolbar,
  tooltipButton,
  KNOWN,
} from "./support/fixtures";
import type { Locator, Page } from "@playwright/test";

const entry = (view: Locator, text: string): Locator => view.getByRole("listitem").filter({ hasText: text });

/** The header row of a category in the Events: Breakpoints panel. */
const categoryHeader = (view: Locator, label: string): Locator =>
  view.locator("div").filter({ has: view.page().getByRole("heading", { name: label, exact: true }) }).last();

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

test("DSP: Breakpoints adds a step breakpoint, toggles and removes it", async ({ page, diagnostics }) => {
  diagnostics.allow(...KNOWN.sgcNoData);
  await openWorkspace(page, "audio-debugger");
  await pauseFromToolbar(page);
  const view = panel(page, "dsp-breakpoints");
  const input = view.getByPlaceholder("Step value (e.g., 0, 5, 0x10)");

  await input.fill("5");
  await input.press("Enter");
  const item = entry(view, "dc.aica.dsp.step == 0x00000005");
  await expect(item).toBeVisible();
  await expect(breakpointGutter(disassemblyRow(panel(page, "dsp-disassembly"), 5))).toHaveAttribute(
    "data-breakpoint",
    "enabled",
  );

  await item.getByRole("switch").click();
  await expect(item.getByRole("switch")).not.toBeChecked();
  await tooltipButton(item, "Remove breakpoint").click();
  await expect(view.getByText("No breakpoints defined.")).toBeVisible();
});

test("DSP: Breakpoints reads a plain number as a decimal step and 0x as hex", async ({ page, diagnostics }) => {
  // regression: the step was parsed with radix 16 although the placeholder ("0, 5, 0x10") and
  // the DSP disassembly view are decimal, so typing 10 set a breakpoint on step 16
  diagnostics.allow(...KNOWN.sgcNoData);
  await openWorkspace(page, "audio-debugger");
  await pauseFromToolbar(page);
  const view = panel(page, "dsp-breakpoints");
  const input = view.getByPlaceholder("Step value (e.g., 0, 5, 0x10)");
  const disassembly = panel(page, "dsp-disassembly");

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
  await page.getByRole("option", { name: "dc.sh4.tlb_miss", exact: true }).click();
  await view.getByRole("button", { name: "Add", exact: true }).click();

  const eventEntry = entry(view, "dc.sh4.tlb_miss");
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

  // one SH4 code breakpoint and one event breakpoint
  const row = disassemblyRow(panel(page, "sh4-disassembly"), 0x8c0000a6);
  await row.hover();
  await breakpointGutter(row).click();
  const input = view.getByPlaceholder("Event name (e.g., dc.aica.channel[0].step)");
  await input.fill("dc.sh4.interrupt");
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
