import type { Page } from "@playwright/test";
import { test, expect, gotoRoute, panel, statusBar, tooltipButton } from "./support/fixtures";
import { startMockServer } from "./support/mockServer";
import { expectMonacoReady, monacoEditor, monacoVisibleText } from "./support/monaco";

// What a browser saved before the UI was called Dreamcast DevTools: the localStorage keys and
// values exactly as the build of d59336b wrote them (taken from a run of that build), with the
// light theme, the left dock hidden, the event log added to the centre dock, an endpoint
// entered by hand, a program in each tab of the DSP playground (the assembler tab active) and
// one in the SH4 simulator. The rename changed no key: a key renamed would lose this state for
// everyone who has used the UI, and this test fails.

const DOCKING_LAYOUT = {
  grid: {
    root: {
      type: "branch",
      data: [
        { type: "leaf", data: { views: ["sh4-disassembly", "events"], activeView: "events", id: "1" }, size: 576 },
        {
          type: "branch",
          data: [
            { type: "leaf", data: { views: ["sh4-memory"], activeView: "sh4-memory", id: "2" }, size: 443 },
            { type: "leaf", data: { views: ["sh4-breakpoints", "sh4-registers"], activeView: "sh4-breakpoints", id: "3" }, size: 444.09375 },
          ],
          size: 576,
        },
      ],
      size: 887.09375,
    },
    width: 1152,
    height: 887.09375,
    orientation: "HORIZONTAL",
  },
  panels: {
    "sh4-disassembly": { id: "sh4-disassembly", contentComponent: "sh4-disassembly", title: "SH4: Disassembly" },
    events: { id: "events", contentComponent: "events", title: "Events: Log" },
    "sh4-memory": { id: "sh4-memory", contentComponent: "sh4-memory", title: "SH4: Memory" },
    "sh4-breakpoints": { id: "sh4-breakpoints", contentComponent: "sh4-breakpoints", title: "SH4: Breakpoints" },
    "sh4-registers": { id: "sh4-registers", contentComponent: "sh4-registers", title: "SH4: Registers" },
  },
  activeGroup: "1",
};

/** The saved state of d59336b; the endpoint entered by hand is filled in by the test. */
const savedBefore = (endpoint: string): Record<string, string> => ({
  "nulldc-debugger-docking-layout-sh4-debugger": JSON.stringify(DOCKING_LAYOUT),
  "nulldc-debugger-dsp-active-tab": "assembly",
  "nulldc-debugger-dsp-assembly": "COEF[0] = 100\nMPRO[0] = XSEL:1 EWT:1 EWA:3\n",
  "nulldc-debugger-dsp-source": "#define mKEPT 1\nINPUT mixer:0\nOUTPUT mixer:0\n",
  "nulldc-debugger-endpoint": endpoint,
  "nulldc-debugger-layout-sh4-debugger": JSON.stringify({ leftPanelOpen: false, rightPanelOpen: true }),
  "nulldc-debugger-sh4-sim-source": "# kept\nSHAD R0,R1\n",
  "nulldc-theme-mode": "light",
});

const storage = (page: Page) =>
  page.evaluate(() => Object.fromEntries(Object.keys(window.localStorage).map((key) => [key, window.localStorage.getItem(key)!])));

test("the state a browser saved before the rename is the state this build starts with", async ({ page }) => {
  const other = await startMockServer();
  try {
    const saved = savedBefore(other.wsURL);
    // put in place before the first script of the page runs, once: a reload finds what the page made of it
    await page.addInitScript((entries: Record<string, string>) => {
      if (window.sessionStorage.getItem("saved-state-seeded") === null) {
        window.sessionStorage.setItem("saved-state-seeded", "1");
        window.localStorage.clear();
        Object.entries(entries).forEach(([key, value]) => window.localStorage.setItem(key, value));
      }
    }, saved);

    // the workspace: the endpoint entered by hand, the light theme, the left dock hidden, the event log
    await gotoRoute(page, "/workspace/sh4-debugger");
    await expect(statusBar(page)).toContainText("Connection: connected");
    await expect(statusBar(page)).toContainText(`Endpoint: ${other.wsURL}`);
    await expect(statusBar(page)).toContainText(/Dreamcast DevTools 3\.0\.0/);
    await expect(page.getByRole("switch", { name: "Toggle dark mode" })).not.toBeChecked();
    await expect(panel(page, "sh4-memory")).toBeVisible();
    await expect(panel(page, "device-tree")).toHaveCount(0);
    await expect(tooltipButton(page, "Show left panel")).toBeVisible();
    await expect(panel(page, "events")).toBeVisible();
    await expect(panel(page, "watches")).toBeVisible();

    // the DSP playground: the assembler tab with its program, and the compiler's program
    await gotoRoute(page, "/tool/dsp-playground");
    await expectMonacoReady(monacoEditor(page));
    await expect(page.getByRole("tab", { name: "Assembler" })).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => monacoVisibleText(monacoEditor(page))).toContain("MPRO[0] = XSEL:1 EWT:1 EWA:3");

    // the SH4 simulator's program
    await gotoRoute(page, "/tool/sh4-sim");
    await expectMonacoReady(monacoEditor(page));
    await expect.poll(() => monacoVisibleText(monacoEditor(page))).toContain("SHAD R0,R1");
    await expect.poll(() => monacoVisibleText(monacoEditor(page))).toContain("# kept");

    // nothing was saved again under another key, and what this build wrote back is what it found
    // (but the docking layout, which dockview writes again in its own form)
    const after = await storage(page);
    expect(Object.keys(after).sort()).toEqual(Object.keys(saved).sort());
    for (const [key, value] of Object.entries(saved)) {
      if (key !== "nulldc-debugger-docking-layout-sh4-debugger") {
        expect(after[key], key).toBe(value);
      }
    }
    expect(JSON.parse(after["nulldc-debugger-docking-layout-sh4-debugger"]).panels).toHaveProperty("events");

    // the compiler's program is the one that was saved
    await gotoRoute(page, "/tool/dsp-playground");
    await expectMonacoReady(monacoEditor(page));
    await page.getByRole("tab", { name: "Compiler", exact: true }).click();
    await expect.poll(() => monacoVisibleText(monacoEditor(page))).toContain("#define mKEPT 1");
  } finally {
    await other.stop();
  }
});
