import {
  test,
  expect,
  addPanelFromSelector,
  dockTab,
  gotoRoute,
  openWorkspace,
  panel,
  pauseFromToolbar,
  statusBar,
  tooltipButton,
  treeItem,
  treeItemRow,
  KNOWN,
  WORKSPACES,
} from "./support/fixtures";
import type { Locator, Page } from "@playwright/test";

/**
 * Default dock contents of every workspace: panel id -> something the mock makes it show.
 * The mock starts running, and a running target has no callstack; CALLSTACKS is what those
 * panels show once the target is paused.
 */
const DEFAULT_PANELS: Record<(typeof WORKSPACES)[number], Record<string, RegExp>> = {
  "sh4-debugger": {
    "device-tree": /SYSCLK = 200MHz/,
    // a disassembly view opens where its target is: around the mock's loop
    "sh4-disassembly": /0x8C0000A0/,
    "sh4-memory": /0x8C010000\s*45 BC 32 04/,
    "sh4-breakpoints": /No breakpoints defined\./,
    watches: /dc\.sh4\.cpu\.pc = 0x8C0000A/,
    "sh4-callstack": /Empty callstack\./,
  },
  "arm7-debugger": {
    "device-tree": /SYSCLK = 200MHz/,
    "arm7-disassembly": /0x00200010/,
    // a memory view opens at the default address of its target, which the server says
    "arm7-memory": /0x00000000\s*([0-9A-F]{2} ){15}/,
    "arm7-breakpoints": /No breakpoints defined\./,
    watches: /dc\.sh4\.cpu\.pc = 0x8C0000A/,
    "arm7-callstack": /Empty callstack\./,
  },
  "audio-debugger": {
    "device-tree": /SYSCLK = 200MHz/,
    sgc: /Record some data to display here/,
    // the DSP is at any of its 128 steps: some lines of the mock's program, numbered in decimal
    "dsp-disassembly": /\d{3}(TWT|YSEL|XSEL) [A-Z]+.*\d{3}(TWT|YSEL|XSEL) /,
    "dsp-breakpoints": /No breakpoints defined\./,
    watches: /dc\.sh4\.cpu\.pc = 0x8C0000A/,
  },
  "mixed-mode-debugger": {
    "device-tree": /SYSCLK = 200MHz/,
    "sh4-disassembly": /0x8C0000A0/,
    "arm7-disassembly": /0x00200010/,
    watches: /dc\.sh4\.cpu\.pc = 0x8C0000A/,
    "sh4-callstack": /Empty callstack\./,
    "arm7-callstack": /Empty callstack\./,
  },
};

/** Frame 0 of a paused target: the program counter in the mock's loop, with its symbol. */
const CALLSTACKS: Record<string, RegExp> = {
  "sh4-callstack": /#0\s*0x8C0000A[02468ACE]\s*_main_loop\+0x[0-9A-E]\b/,
  "arm7-callstack": /#0\s*0x002000[12][048C]\s*arm7_main_loop\+0x[0-9A-F]+\b/,
};

for (const workspace of WORKSPACES) {
  test(`${workspace}: every default panel is mounted and shows data from the server`, async ({ page, diagnostics }) => {
    if (workspace === "audio-debugger") {
      diagnostics.allow(...KNOWN.sgcNoData);
    }
    await openWorkspace(page, workspace);
    const expected = DEFAULT_PANELS[workspace];
    for (const [id, content] of Object.entries(expected)) {
      await expect(panel(page, id), `panel ${id}`).toBeVisible();
      await expect(panel(page, id), `panel ${id}`).toContainText(content);
    }
    // nothing else is open
    const mounted = await page.locator("[data-panel-id]").evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-panel-id")),
    );
    expect(mounted.sort()).toEqual(Object.keys(expected).sort());

    // paused: the callstack panels of the workspace show the frames of the tick
    await pauseFromToolbar(page);
    for (const id of Object.keys(expected).filter((panelId) => panelId in CALLSTACKS)) {
      await expect(panel(page, id), `panel ${id}`).toContainText(CALLSTACKS[id]);
      await expect(panel(page, id).getByRole("listitem")).toHaveCount(16);
    }
  });
}

/** Every panel of the selector that is not part of the SH4 workspace's centre dock: title -> content. */
const SELECTOR_PANELS: Array<{ title: string; id: string; content: RegExp | ((view: Locator) => Promise<void>) }> = [
  { title: "Documentation", id: "documentation", content: /Getting Started/ },
  { title: "SH4: Simulator", id: "sh4-sim", content: /Hide Crosshairs/ },
  { title: "Events: Log", id: "events", content: /\d{2}:\d{2}:\d{2}\.\d{3}/ },
  { title: "Events: Breakpoints", id: "events-breakpoints", content: /No breakpoints defined\./ },
  { title: "SH4: BSC Registers", id: "bsc-registers", content: /Bus State Controller Registers - Coming Soon/ },
  { title: "SH4: CCN Registers", id: "ccn-registers", content: /Cache Controller Registers - Coming Soon/ },
  { title: "SH4: CPG Registers", id: "cpg-registers", content: /Clock Pulse Generator Registers - Coming Soon/ },
  { title: "SH4: DMAC Registers", id: "dmac-registers", content: /Direct Memory Access Controller Registers - Coming Soon/ },
  { title: "SH4: INTC Registers", id: "intc-registers", content: /Interrupt Controller Registers - Coming Soon/ },
  { title: "SH4: RTC Registers", id: "rtc-registers", content: /Real Time Clock Registers - Coming Soon/ },
  { title: "SH4: SCI Registers", id: "sci-registers", content: /Serial Communications Interface Registers - Coming Soon/ },
  { title: "SH4: SCIF Registers", id: "scif-registers", content: /Serial Communications Interface w\/ FIFO Registers - Coming Soon/ },
  { title: "SH4: TMU Registers", id: "tmu-registers", content: /Timer Unit Registers - Coming Soon/ },
  { title: "SH4: UBC Registers", id: "ubc-registers", content: /User Break Controller Registers - Coming Soon/ },
  { title: "SH4: Store Queues", id: "sq-contents", content: /Store Queues Contents\s*Memory contents \(all zeros\)/ },
  { title: "SH4: ICACHE", id: "icache-contents", content: /Instruction Cache Contents - Coming Soon/ },
  { title: "SH4: OCACHE", id: "ocache-contents", content: /Operand Cache Contents - Coming Soon/ },
  { title: "SH4: OC-RAM", id: "ocram-contents", content: /Operand RAM Contents\s*Memory contents \(all zeros\)/ },
  { title: "SH4: TLB", id: "tlb-contents", content: /TLB Contents - Coming Soon/ },
  // opened after the first tick, a disassembly view starts ten instructions before the PC
  { title: "ARM7: Disassembly", id: "arm7-disassembly", content: /0x(001FFF|002000)[0-9A-F]{2}/ },
  { title: "ARM7: Memory", id: "arm7-memory", content: /0x00000000/ },
  { title: "ARM7: Breakpoints", id: "arm7-breakpoints", content: /No breakpoints defined\./ },
  { title: "CLX2: TA", id: "holly-ta", content: /This view is under consideration\./ },
  { title: "CLX2: CORE", id: "holly-core", content: /Drop your refsw2 log here/ },
  { title: "SGC", id: "sgc", content: /Record some data to display here/ },
  // ... and the DSP is at any of its 128 steps: some lines of the mock's program, numbered in decimal
  { title: "DSP: Disassembly", id: "dsp-disassembly", content: /\d{3}(TWT|YSEL|XSEL) [A-Z]+.*\d{3}(TWT|YSEL|XSEL) / },
  { title: "DSP: Breakpoints", id: "dsp-breakpoints", content: /No breakpoints defined\./ },
  { title: "DSP: Playground", id: "dsp-playground", content: /Start DSP/ },
  { title: "Device Tree", id: "device-tree", content: /SYSCLK = 200MHz/ },
  { title: "Watches", id: "watches", content: /dc\.sh4\.cpu\.pc = 0x8C0000A/ },
  // the target is paused when these are opened
  { title: "SH4: Callstack", id: "sh4-callstack", content: CALLSTACKS["sh4-callstack"] },
  { title: "ARM7: Callstack", id: "arm7-callstack", content: CALLSTACKS["arm7-callstack"] },
];

test("the panel selector offers every panel that is not in the dock, and each one mounts with content", async ({
  page,
  diagnostics,
  rpc,
}) => {
  test.slow();
  diagnostics.allow(...KNOWN.sgcNoData);
  await openWorkspace(page, "sh4-debugger");

  // The mock starts running and sends a tick five times a second, and every tick renders every
  // mounted panel again: with 35 panels in the dock a slow machine has nothing left between two
  // ticks, and the test would measure that instead of the selector. Nothing here needs a target
  // that runs, so it is paused (a paused server sends no periodic tick), as soon as the event
  // log has an entry for "Events: Log" to show.
  await expect
    .poll(() => rpc.received.some((frame) => frame.method === "event.tick" && (frame.params?.eventLog as unknown[]).length > 0))
    .toBe(true);
  await pauseFromToolbar(page);

  // the first group of the centre dock ("SH4: Disassembly")
  const addPanel = page.getByLabel("Add Panel", { exact: true }).nth(1);
  await addPanel.click();
  const dialog = page.getByRole("dialog");
  // the centre dock already has its three default panels; the other 32 are offered, with their ids
  await expect(dialog.getByRole("listitem")).toHaveCount(SELECTOR_PANELS.length);
  for (const { title, id } of SELECTOR_PANELS) {
    await expect(dialog.getByRole("button", { name: `${title} ${id}`, exact: true })).toBeVisible();
  }
  await expect(dialog.getByRole("button", { name: /^SH4: Disassembly / })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  const centre = page.locator(".dv-dockview").nth(1);
  for (const { title, id, content } of SELECTOR_PANELS) {
    await addPanelFromSelector(page, 1, title);
    // the new panel is the active tab of the group; panels of other docks keep their own instance
    const view = centre.locator(`[data-panel-id="${id}"]`);
    await expect(view, `panel ${id}`).toBeVisible();
    if (content instanceof RegExp) {
      await expect(view, `panel ${id}`).toContainText(content);
    }
    await expect(dockTab(page, title).first()).toBeVisible();
  }

  // now that everything is open in this dock, the selector has nothing left to offer
  await addPanel.click();
  await expect(dialog.getByText("All panels are already open")).toBeVisible();
  await page.keyboard.press("Escape");
});

test("the panel selector filters as you type and is driven by the keyboard", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  await page.getByLabel("Add Panel", { exact: true }).nth(1).click();
  const dialog = page.getByRole("dialog");
  const search = dialog.getByPlaceholder("Type to search panels...");
  await expect(search).toBeFocused();

  await search.fill("callstack");
  await expect(dialog.getByRole("listitem")).toHaveCount(2);
  await search.fill("no such panel");
  await expect(dialog.getByText("No panels found")).toBeVisible();

  // matches ids as well as titles
  await search.fill("holly-");
  await expect(dialog.getByRole("listitem")).toHaveText([/CLX2: TA/, /CLX2: CORE/]);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(panel(page, "holly-core")).toContainText("Drop your refsw2 log here");

  // Escape closes without adding
  await page.getByLabel("Add Panel", { exact: true }).nth(1).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(panel(page, "holly-ta")).toHaveCount(0);
});

test("the action buttons of a device tree node open that panel in the centre dock", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  await expect(panel(page, "holly-ta")).toHaveCount(0);

  await treeItemRow(page, "dc.holly.ta").getByLabel("Open CLX2: TA").click();
  await expect(panel(page, "holly-ta")).toContainText("This view is under consideration.");
  await expect(dockTab(page, "CLX2: TA")).toBeVisible();

  // a panel that is already open is focused, not opened twice
  await treeItemRow(page, "dc.sh4.cpu").getByLabel("Open SH4: Memory").click();
  await expect(dockTab(page, "SH4: Memory")).toHaveCount(1);
  await treeItemRow(page, "dc.holly.ta").getByLabel("Open CLX2: TA").click();
  await expect(dockTab(page, "CLX2: TA")).toHaveCount(1);

  // nested node: PBUS -> BSC opens a register panel
  await treeItemRow(page, "dc.sh4.pbus").click();
  await treeItem(page, "dc.sh4.bsc").getByLabel("Open SH4: BSC Registers").click();
  await expect(panel(page, "bsc-registers")).toContainText("Bus State Controller Registers - Coming Soon");

  // a debugger panel of another target works in this workspace too
  await treeItemRow(page, "dc.aica.arm7").getByLabel("Open ARM7: Disassembly").click();
  await expect(panel(page, "arm7-disassembly")).toContainText(/0x(001FFF|002000)[0-9A-F]{2}/);
});

const tabTitles = (page: Page) =>
  page.locator(".dv-default-tab").evaluateAll((tabs) => tabs.map((tab) => (tab.textContent ?? "").trim()));

test("the dock layout survives a reload and Reset layout restores the default", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  const initial = await tabTitles(page);
  expect(initial).toEqual([
    "Device Tree",
    "SH4: Disassembly",
    "SH4: Memory",
    "SH4: Breakpoints",
    "Watches",
    "SH4: Callstack",
  ]);

  // open one panel, close another
  await treeItemRow(page, "dc.holly.core").getByLabel("Open CLX2: CORE").click();
  await expect(panel(page, "holly-core")).toBeVisible();
  await dockTab(page, "SH4: Callstack").locator(".dv-default-tab-action").click();
  await expect(panel(page, "sh4-callstack")).toHaveCount(0);
  const changed = await tabTitles(page);
  expect(changed).toContain("CLX2: CORE");
  expect(changed).not.toContain("SH4: Callstack");

  await page.reload();
  await expect(statusBar(page)).toContainText("Connection: connected");
  await expect(panel(page, "holly-core")).toContainText("Drop your refsw2 log here");
  await expect(panel(page, "sh4-callstack")).toHaveCount(0);
  expect(await tabTitles(page)).toEqual(changed);

  // layouts are per workspace
  await gotoRoute(page, "/workspace/arm7-debugger");
  await expect(panel(page, "arm7-callstack")).toContainText("Empty callstack.");
  await expect(panel(page, "holly-core")).toHaveCount(0);

  await gotoRoute(page, "/workspace/sh4-debugger");
  await expect(panel(page, "holly-core")).toBeVisible();
  await page.getByRole("button", { name: "Reset layout" }).click();
  await expect(panel(page, "sh4-callstack")).toContainText("Empty callstack.");
  await expect(panel(page, "holly-core")).toHaveCount(0);
  expect(await tabTitles(page)).toEqual(initial);
});

test("the side docks can be hidden; the choice survives a reload and Reset layout shows them again", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");

  await tooltipButton(page, "Hide left panel").click();
  await expect(panel(page, "device-tree")).toHaveCount(0);
  await tooltipButton(page, "Hide right panel").click();
  await expect(panel(page, "watches")).toHaveCount(0);
  await expect(panel(page, "sh4-disassembly")).toBeVisible();

  await page.reload();
  await expect(statusBar(page)).toContainText("Connection: connected");
  await expect(panel(page, "sh4-disassembly")).toContainText("0x8C0000A0");
  await expect(panel(page, "device-tree")).toHaveCount(0);
  await expect(panel(page, "watches")).toHaveCount(0);

  await tooltipButton(page, "Show left panel").click();
  await expect(panel(page, "device-tree")).toContainText("SYSCLK = 200MHz");

  await page.getByRole("button", { name: "Reset layout" }).click();
  await expect(panel(page, "watches")).toContainText("dc.sh4.cpu.pc");
  await expect(panel(page, "device-tree")).toContainText("SYSCLK = 200MHz");
});

test("below 1200px the side docks are hidden and the centre dock keeps working", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  await gotoRoute(page, "/workspace/sh4-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");

  await expect(panel(page, "sh4-disassembly")).toContainText("0x8C0000A0");
  await expect(panel(page, "sh4-memory")).toBeVisible();
  await expect(panel(page, "device-tree")).toHaveCount(0);
  await expect(panel(page, "watches")).toHaveCount(0);
  await expect(page.getByLabel("Hide left panel")).toHaveCount(0);

  // widening the window brings the side docks back
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(panel(page, "device-tree")).toContainText("SYSCLK = 200MHz");
  await expect(panel(page, "watches")).toContainText("dc.sh4.cpu.pc");
});

test("a panel of a saved layout that this build does not have is left out, and the rest of the layout is kept", async ({ page }) => {
  // a layout saved by a newer UI on the same origin, or by an older one whose panel is gone
  await openWorkspace(page, "sh4-debugger");
  await addPanelFromSelector(page, 1, "Events: Log");
  await expect(panel(page, "events")).toBeVisible();
  await expect.poll(() => tabTitles(page)).toContain("Events: Log");
  const key = "nulldc-debugger-docking-layout-sh4-debugger";
  await expect
    .poll(() => page.evaluate((storageKey) => window.localStorage.getItem(storageKey)?.includes('"events"') ?? false, key))
    .toBe(true);

  // the saved layout now names a panel "hologram-viewer" where it had the event log
  await page.evaluate((storageKey) => {
    const rename = (name: string, from: string, to: string) => {
      const saved = window.localStorage.getItem(name)!;
      window.localStorage.setItem(name, saved.replaceAll(`"${from}"`, `"${to}"`));
    };
    rename(storageKey, "events", "hologram-viewer");
  }, key);
  await page.reload();
  await expect(statusBar(page)).toContainText("Connection: connected");

  // what the build knows is where it was
  for (const id of ["sh4-disassembly", "sh4-memory", "sh4-breakpoints", "sh4-callstack", "device-tree"]) {
    await expect(panel(page, id), id).toBeVisible();
  }
  await expect(panel(page, "sh4-disassembly")).toContainText("0x8C0000A0");
  // what it does not know is not a tab, not an empty panel and not an error
  expect(await tabTitles(page)).toEqual(["Device Tree", "SH4: Disassembly", "SH4: Memory", "SH4: Breakpoints", "Watches", "SH4: Callstack"]);
  await expect(page.locator("[data-error-boundary]")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  // and the panels that went missing can be opened again
  await addPanelFromSelector(page, 1, "Events: Log");
  await expect(panel(page, "events")).toBeVisible();
});
