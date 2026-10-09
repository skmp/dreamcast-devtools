import { test, expect, dockTab, openWorkspace, panel, saveScreenshot, KNOWN, WORKSPACES, type WorkspaceId } from "./support/fixtures";
import type { Locator, Page } from "@playwright/test";

// The default layouts in the window of a laptop. With both side docks open such a window
// leaves the centre dock 540 to 700 px, and the default layouts put two views side by side in
// it: the instruction column of a disassembly listing had no width left, the toolbar of the
// view was cut off at the edge of its panel, and the memory view showed a third of its bytes
// and no text column. A layout is readable when nothing of a panel is cut off at its sides.

// paused: the listings have a program counter to show (the grace period is not what is tested)
test.use({ mockOptions: { startPaused: true, graceMs: 600_000 } });

/** The disassembly views of each workspace's default layout, and the step buttons of each. */
const VIEWS: Record<WorkspaceId, Array<{ id: string; steps: string[] }>> = {
  "sh4-debugger": [{ id: "sh4-disassembly", steps: ["Step Over", "Step In", "Step Out"] }],
  "arm7-debugger": [{ id: "arm7-disassembly", steps: ["Step Over", "Step In", "Step Out"] }],
  "audio-debugger": [{ id: "dsp-disassembly", steps: ["Step"] }],
  "mixed-mode-debugger": [
    { id: "sh4-disassembly", steps: ["Step Over", "Step In", "Step Out"] },
    { id: "arm7-disassembly", steps: ["Step Over", "Step In", "Step Out"] },
  ],
};

/** The memory view of a workspace's default layout, where it has one. */
const MEMORY: Partial<Record<WorkspaceId, string>> = { "sh4-debugger": "sh4-memory", "arm7-debugger": "arm7-memory" };

/**
 * What the panels on screen cut off at their left or right edge: every control and every
 * piece of text of a panel that reaches beyond the panel, or beyond the window. (What is below
 * the lower edge of a panel is the rest of a list, and is not looked at.)
 */
const cutOff = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const problems: string[] = [];
    for (const frame of Array.from(document.querySelectorAll("[data-panel-id]"))) {
      const outer = frame.getBoundingClientRect();
      const right = Math.min(outer.right, window.innerWidth);
      for (const element of Array.from(frame.querySelectorAll("button, input, span, p, li, h2, h6, canvas"))) {
        const box = element.getBoundingClientRect();
        const middle = (box.top + box.bottom) / 2;
        if (box.width === 0 || box.height === 0 || middle < outer.top || middle > outer.bottom) {
          continue;
        }
        if (box.left < outer.left - 0.5 || box.right > right + 0.5) {
          const text = (element.getAttribute("aria-label") ?? element.textContent ?? "").trim().slice(0, 40);
          problems.push(`${frame.getAttribute("data-panel-id")}: <${element.tagName.toLowerCase()}> "${text}" reaches ${Math.round(box.right - right)} px beyond the panel`);
        }
      }
    }
    return problems;
  });

/** A control is there to be used: visible, and all of it on screen (nothing of it under the edge of its panel). */
const expectUsable = async (control: Locator, name: string) => {
  await expect(control, name).toBeVisible();
  await expect(control, name).toBeInViewport({ ratio: 1 });
};

/**
 * A disassembly view can be read and used: every button of its toolbar and its address box are
 * on screen, and so is the line of the program counter, with an instruction column that has
 * room for its text (twelve characters at least) and shows all of it.
 */
const expectViewReadable = async (page: Page, id: string, steps: string[]) => {
  const view = panel(page, id);
  // the toolbar of the view: every step button, and what moves the view
  for (const name of [...steps, "Go to current PC", "Refresh", "Go"]) {
    await expectUsable(view.getByRole("button", { name, exact: true }), `${id}: ${name}`);
  }
  await expectUsable(view.getByRole("textbox"), `${id}: address box`);
  // the address in the box is not cut off by the box
  const box = await view.getByRole("textbox").evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
  expect(box.scrollWidth, `${id}: the address fits its box`).toBeLessThanOrEqual(box.clientWidth + 1);

  const line = view.locator(".current-instruction");
  await expect(line, id).toHaveCount(1);
  await expect(line, id).toBeInViewport({ ratio: 1 });
  const instruction = line.locator("span").last();
  await expect(instruction, id).toHaveText(/\S/);
  await expect(instruction, id).toBeInViewport({ ratio: 1 });
  const cell = await instruction.evaluate((element) => ({
    width: element.getBoundingClientRect().width,
    character: Number.parseFloat(getComputedStyle(element).fontSize) * 0.6,
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
  }));
  expect(cell.width, `${id}: width of the instruction column`).toBeGreaterThanOrEqual(12 * cell.character);
  expect(cell.scrollWidth, `${id}: the instruction text fits its column`).toBeLessThanOrEqual(cell.clientWidth + 1);
  // and so are its address and, where the target has them, its bytes
  for (const part of await line.locator("span").all()) {
    await expect(part, id).toBeInViewport({ ratio: 1 });
  }
};

for (const size of [
  { width: 1366, height: 768 },
  { width: 1280, height: 720 },
  { width: 1440, height: 900 },
]) {
  test.describe(`in a window of ${size.width}x${size.height}`, () => {
    test.use({ viewport: size });

    for (const workspace of WORKSPACES) {
      test(`${workspace}: the default layout can be read, and every run control is there`, async ({ page, diagnostics }, testInfo) => {
        if (workspace === "audio-debugger") {
          diagnostics.allow(...KNOWN.sgcNoData);
        }
        await openWorkspace(page, workspace);
        await expect(page.getByRole("status", { name: "Execution state" })).toHaveText("Paused · waiting at the start · stop 1");

        // the run controls of the toolbar
        for (const name of ["Run", "Pause", "Run to next breakpoint"]) {
          await expectUsable(page.locator("header").getByRole("button", { name, exact: true }), name);
        }

        for (const { id, steps } of VIEWS[workspace]) {
          await expectViewReadable(page, id, steps);
        }

        const memory = MEMORY[workspace];
        if (memory) {
          // the memory view has its three columns: sixteen bytes and their text in every row
          const view = panel(page, memory);
          for (const title of ["Address", "Hex", "ASCII"]) {
            await expect(view.getByText(title, { exact: true }), `${memory}: ${title}`).toBeInViewport({ ratio: 1 });
          }
          const row = view.locator("div").filter({ has: page.locator(":scope > span:nth-child(3)") }).filter({ hasText: /^0x[0-9A-F]{8}/ }).first();
          await expect(row.locator("span").nth(1)).toHaveText(/^([0-9A-F]{2} ){15}[0-9A-F]{2}$/);
          expect((await row.locator("span").nth(2).innerText()).length).toBe(16);
          for (const part of await row.locator("span").all()) {
            await expect(part, memory).toBeInViewport({ ratio: 1 });
          }
          await expectUsable(view.getByRole("textbox"), `${memory}: address box`);
          await expectUsable(view.getByRole("button", { name: "Refresh", exact: true }), `${memory}: Refresh`);
          // text that can be read: not smaller than ten pixels
          expect(await row.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(10);
        }

        // nothing of any panel of the layout is cut off at its sides
        expect(await cutOff(page)).toEqual([]);
        await saveScreenshot(page, testInfo, `layout-${size.width}x${size.height}-${workspace}`);

        // the panel that shares a group with another is behind its tab, and whole when it is shown
        const behind = { "sh4-debugger": "SH4: Breakpoints", "arm7-debugger": "ARM7: Breakpoints", "audio-debugger": "DSP: Breakpoints" }[workspace as string];
        if (behind) {
          await dockTab(page, behind).click();
          const breakpoints = panel(page, behind.startsWith("DSP") ? "dsp-breakpoints" : `${behind.slice(0, behind.indexOf(":")).toLowerCase()}-breakpoints`);
          await expectUsable(breakpoints.getByRole("textbox"), `${behind}: box`);
          await expect(breakpoints.getByRole("button", { name: "Add", exact: true })).toBeInViewport({ ratio: 1 });
          expect(await cutOff(page)).toEqual([]);
        }
      });
    }
  });
}

test.describe("in a window of 1600x1000, where the views are side by side", () => {
  // The default viewport of this suite. Two listings share 864 px here: each has to make do
  // with half, which is where the minimum of the instruction column and the second line of
  // the toolbar are needed.
  for (const workspace of ["sh4-debugger", "arm7-debugger", "mixed-mode-debugger"] as const) {
    test(`${workspace}: a listing in half the centre dock keeps its instruction column, and its toolbar is whole`, async ({ page }) => {
      await openWorkspace(page, workspace);
      const boxes = await Promise.all(VIEWS[workspace].map(({ id }) => panel(page, id).boundingBox()));
      for (const box of boxes) {
        expect(box!.width).toBeLessThan(440);
      }
      // side by side: the memory view, or the other listing, is to the right of the first
      const neighbour = panel(page, workspace === "mixed-mode-debugger" ? "arm7-disassembly" : MEMORY[workspace]!);
      expect((await neighbour.boundingBox())!.x).toBeGreaterThanOrEqual(boxes[0]!.x + boxes[0]!.width);
      for (const { id, steps } of VIEWS[workspace]) {
        await expectViewReadable(page, id, steps);
      }
    });
  }
});
