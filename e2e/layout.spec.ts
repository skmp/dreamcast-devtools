import {
  test,
  expect,
  disassemblyRows,
  dockTab,
  gotoRoute,
  openWorkspace,
  panel,
  saveScreenshot,
  KNOWN,
  WORKSPACES,
  type WorkspaceId,
} from "./support/fixtures";
import type { Locator, Page } from "@playwright/test";
import { defaultAnswer, serveScriptedDebugger } from "./support/scriptedDebugger";

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
  // what is beside the step buttons is on their line: centred on them, whatever its height
  const centre = async (control: Locator) => {
    const box = (await control.boundingBox())!;
    return box.y + box.height / 2;
  };
  const stepLine = await centre(view.getByRole("button", { name: steps[0], exact: true }));
  for (const [name, control] of [
    ["Go to current PC", view.getByRole("button", { name: "Go to current PC", exact: true })],
    ["address box", view.getByRole("textbox")],
  ] as const) {
    const offset = Math.abs((await centre(control)) - stepLine);
    // (a control a line further down is 38 px or more below)
    if (offset < 20) {
      expect(offset, `${id}: ${name} beside ${steps[0]}`).toBeLessThanOrEqual(1);
    }
  }
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
        // and so is the register panel of the processor, behind the breakpoints
        const registers = { "sh4-debugger": "SH4: Registers", "arm7-debugger": "ARM7: Registers" }[workspace as string];
        if (registers) {
          await dockTab(page, registers).click();
          const table = panel(page, `${registers.slice(0, registers.indexOf(":")).toLowerCase()}-registers`);
          const first = table.locator("tbody tr").first();
          await expect(first.locator("td").first()).toHaveText("PC");
          for (const cell of await first.locator("td").all()) {
            await expect(cell, registers).toBeInViewport({ ratio: 1 });
          }
          await expectUsable(first.getByRole("button", { name: /watch/ }), `${registers}: watch`);
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

test.describe("in a window that got narrower under views that are side by side", () => {
  // A layout is made for the window the page opens in, and is kept after that. A window of
  // 1600 px that goes to the screen of a laptop (or a layout that was arranged or saved that
  // way) has its two views side by side in a centre dock of 630 px or less, and a listing in
  // half of that has less room than its columns need at their narrowest: the twelve characters
  // of the instruction column are kept, and are scrolled to instead of being cut off.

  /** Whether all of an element is inside the panel, and none of it clipped away by anything in the panel. */
  const whole = async (view: Locator, element: Locator): Promise<boolean> => {
    const [outer, inner] = [await view.boundingBox(), await element.boundingBox()];
    const inside =
      outer !== null &&
      inner !== null &&
      inner.x >= outer.x - 0.5 &&
      inner.x + inner.width <= outer.x + outer.width + 0.5 &&
      inner.y >= outer.y - 0.5 &&
      inner.y + inner.height <= outer.y + outer.height + 0.5;
    // what a scrolling box inside the panel clips is not on screen either
    const shown = await element.evaluate(
      (node) =>
        new Promise<number>((resolve) => {
          const observer = new IntersectionObserver((entries) => {
            observer.disconnect();
            resolve(entries[0].intersectionRatio);
          });
          observer.observe(node);
        }),
    );
    return inside && shown >= 1;
  };

  for (const size of [
    { width: 1366, height: 768 },
    { width: 1280, height: 720 },
  ]) {
    test(`${size.width}x${size.height}: a listing narrower than its columns keeps the instruction column and scrolls to it, and its toolbar is whole`, async ({
      page,
      rpc,
    }) => {
      await openWorkspace(page, "sh4-debugger");
      const view = panel(page, "sh4-disassembly");
      const line = view.locator(".current-instruction");
      await expect(line).toHaveCount(1);

      await page.setViewportSize(size);
      // still side by side, in a narrower dock: the listing has less than its columns need
      await expect.poll(async () => (await view.boundingBox())!.width).toBeLessThan(340);
      const box = (await view.boundingBox())!;
      expect((await panel(page, "sh4-memory").boundingBox())!.x).toBeGreaterThanOrEqual(box.x + box.width);

      // every control of the toolbar is inside the panel
      for (const name of ["Step Over", "Step In", "Step Out", "Mute category", "Solo category", "Go to current PC", "Go", "Refresh"]) {
        const control = view.getByRole("button", { name, exact: true });
        await expectUsable(control, name);
        expect(await whole(view, control), `${name} is inside the panel`).toBe(true);
      }
      await expectUsable(view.getByRole("textbox"), "address box");
      expect(await whole(view, view.getByRole("textbox")), "the address box is inside the panel").toBe(true);
      // The toolbar has taken a second line for the address box. The step buttons start it at
      // the left, and what does not fit beside them ends at the right, on either line.
      const placed = async (control: Locator) => {
        const at = (await control.boundingBox())!;
        return { left: at.x - box.x, right: box.x + box.width - (at.x + at.width), top: at.y, bottom: at.y + at.height };
      };
      const stepOver = await placed(view.getByRole("button", { name: "Step Over", exact: true }));
      expect(stepOver.left, "Step Over, from the left edge").toBeLessThanOrEqual(24);
      expect((await placed(view.getByRole("button", { name: "Go to current PC", exact: true }))).right, "Go to current PC, from the right edge").toBeLessThanOrEqual(24);
      expect((await placed(view.getByRole("button", { name: "Refresh", exact: true }))).right, "Refresh, from the right edge").toBeLessThanOrEqual(24);
      expect((await placed(view.getByRole("textbox"))).top, "the address box is below the step buttons").toBeGreaterThanOrEqual(stepOver.bottom);

      // the instruction of the program counter's line has its twelve characters, and its text in one line
      const address = line.locator("span").first();
      const instruction = line.locator("span").last();
      await expect(instruction).toHaveText(/\S/);
      const cell = await instruction.evaluate((element) => {
        const text = document.createRange();
        text.selectNodeContents(element);
        return {
          width: element.getBoundingClientRect().width,
          character: Number.parseFloat(getComputedStyle(element).fontSize) * 0.6,
          lines: text.getClientRects().length,
        };
      });
      expect(cell.width, "width of the instruction column").toBeGreaterThanOrEqual(12 * cell.character);
      expect(cell.lines, "lines of the instruction text").toBe(1);

      // The listing shows the start of its lines, and the rest of them when it is scrolled to
      // the side: with the wheel, which moves the listing through its addresses only when it
      // is turned up or down.
      expect(await whole(view, address), "the address is shown").toBe(true);
      expect(await whole(view, instruction), "the instruction column does not fit beside it").toBe(false);
      const first = await disassemblyRows(view).first().getAttribute("data-address");
      const listings = rpc.requests("state.getDisassembly").length;
      await address.hover();
      await page.mouse.wheel(400, 0);
      await expect.poll(() => whole(view, instruction), { message: "the instruction is scrolled to" }).toBe(true);
      // to the side only: the listing is where it was
      await expect(disassemblyRows(view).first()).toHaveAttribute("data-address", first!);
      expect(rpc.requests("state.getDisassembly").length).toBe(listings);
      // and back
      await page.mouse.wheel(-400, 0);
      await expect.poll(() => whole(view, address)).toBe(true);
    });
  }

  /** The rows of a memory view, and the three cells of its first row: address, hex, text. */
  const memoryRows = (view: Locator): Locator =>
    view.locator("div").filter({ has: view.page().locator(":scope > span:nth-child(3)") }).filter({ hasText: /^0x[0-9A-F]{8}/ });

  for (const size of [
    { width: 1366, height: 768 },
    { width: 1280, height: 720 },
  ]) {
    test(`${size.width}x${size.height}: a memory view narrower than its rows cuts no column, and scrolls to the rest of them`, async ({ page, rpc }) => {
      await openWorkspace(page, "sh4-debugger");
      const view = panel(page, "sh4-memory");
      await expect(memoryRows(view)).toHaveCount(60);

      await page.setViewportSize(size);
      // still beside the listing, in a narrower dock: less than a row needs at the smallest font it is given
      await expect.poll(async () => (await view.boundingBox())!.width).toBeLessThan(340);
      const box = (await view.boundingBox())!;
      const listing = (await panel(page, "sh4-disassembly").boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(listing.x + listing.width);

      // the toolbar is inside the panel
      for (const [name, control] of [
        ["address box", view.getByRole("textbox")],
        ["Go", view.getByRole("button", { name: "Go", exact: true })],
        ["Refresh", view.getByRole("button", { name: "Refresh", exact: true })],
      ] as const) {
        await expectUsable(control, name);
        expect(await whole(view, control), `${name} is inside the panel`).toBe(true);
      }

      // a row has its three columns at their width, in a font that can be read: nothing is squeezed for the panel
      const row = memoryRows(view).first();
      const [address, hex, text] = [row.locator("span").nth(0), row.locator("span").nth(1), row.locator("span").nth(2)];
      const measure = (cell: Locator) =>
        cell.evaluate((element) => ({
          width: element.getBoundingClientRect().width,
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          fontSize: Number.parseFloat(getComputedStyle(element).fontSize),
        }));
      const cells = { address: await measure(address), hex: await measure(hex), text: await measure(text) };
      expect(cells.hex.fontSize, "font size of the listing").toBe(10);
      // sixteen bytes and the blanks between them are 47 characters, the text sixteen (a character of a monospace font is 0.6 em wide or more)
      expect(cells.hex.width, "width of the hex column").toBeGreaterThanOrEqual(47 * 0.6 * cells.hex.fontSize - 1);
      expect(cells.text.width, "width of the text column").toBeGreaterThanOrEqual(16 * 0.6 * cells.text.fontSize - 1);
      for (const [name, cell] of Object.entries(cells)) {
        expect(cell.scrollWidth, `the ${name} fits its column`).toBeLessThanOrEqual(cell.clientWidth + 1);
      }
      await expect(hex).toHaveText(/^([0-9A-F]{2} ){15}[0-9A-F]{2}$/);
      expect((await text.innerText()).length).toBe(16);

      // The view shows the start of its rows, and the rest of them when it is scrolled to the
      // side: with the wheel, which moves the view through its addresses only when it is
      // turned up or down.
      expect(await whole(view, address), "the address is shown").toBe(true);
      expect(await whole(view, text), "the text column does not fit beside it").toBe(false);
      const first = await address.innerText();
      const slices = rpc.requests("state.getMemorySlice").length;
      await address.hover();
      await page.mouse.wheel(600, 0);
      await expect.poll(() => whole(view, text), { message: "the text column is scrolled to" }).toBe(true);
      expect(await whole(view, hex.locator("xpath=..").locator("span").nth(2))).toBe(true);
      // to the side only: the view is where it was, and has read nothing
      await expect(address).toHaveText(first);
      expect(rpc.requests("state.getMemorySlice").length).toBe(slices);
      // every row is whole there, the last one on screen too
      const rows = await memoryRows(view).all();
      expect(await whole(view, rows[5].locator("span").nth(2))).toBe(true);
      // and back
      await page.mouse.wheel(-600, 0);
      await expect.poll(() => whole(view, address)).toBe(true);
      // a turn down is still a move through the addresses
      await page.mouse.wheel(0, 60);
      await expect(memoryRows(view).first().locator("span").first()).not.toHaveText(first);
      expect(rpc.requests("state.getMemorySlice").length).toBe(slices + 1);
    });
  }

  test("what such a memory view says about its rows is in the panel, and is not scrolled away with them", async ({ page }) => {
    // a server that takes its time over the bytes when told to
    const server = await serveScriptedDebugger(page);
    let held: Array<() => void> | undefined;
    server.answer("state.getMemorySlice", (params) => {
      const answer = defaultAnswer("state.getMemorySlice", params);
      return held ? new Promise((resolve) => held!.push(() => resolve(answer))) : answer;
    });
    await gotoRoute(page, "/workspace/sh4-debugger");
    await server.described();
    const view = panel(page, "sh4-memory");
    await expect(memoryRows(view)).toHaveCount(60);
    await page.setViewportSize({ width: 1366, height: 768 });
    await expect.poll(async () => (await view.boundingBox())!.width).toBeLessThan(340);
    const row = memoryRows(view).first();

    // the bytes are read again, and the answer is late: the view says that it is reading, over the rows
    held = [];
    await view.getByRole("button", { name: "Refresh", exact: true }).click();
    const updating = view.getByText("Updating");
    await expect(updating).toBeVisible();
    expect(await whole(view, updating), '"Updating" is inside the panel').toBe(true);
    const toolbar = (await view.getByRole("textbox").boundingBox())!;
    expect((await updating.boundingBox())!.y, '"Updating" is below the toolbar').toBeGreaterThanOrEqual(toolbar.y + toolbar.height);
    // also when the rows are scrolled to the side
    await row.locator("span").first().hover();
    await page.mouse.wheel(600, 0);
    await expect.poll(() => whole(view, row.locator("span").nth(2))).toBe(true);
    expect(await whole(view, updating), '"Updating" is inside the panel, with the rows scrolled to the side').toBe(true);

    held.splice(0).forEach((answer) => answer());
    held = undefined;
    await expect(updating).toBeHidden();
    await expect(memoryRows(view)).toHaveCount(60);
  });

  test("what such a listing says about its lines is in the panel, and is not scrolled away with them", async ({ page }) => {
    // a server that takes its time over a listing when told to, and that can list an address twice
    const server = await serveScriptedDebugger(page);
    let repeating = false;
    let held: Array<() => void> | undefined = [];
    server.answer("state.getDisassembly", (params) => {
      const listing = defaultAnswer("state.getDisassembly", params) as { lines: unknown[] };
      const answer = repeating ? { lines: [...listing.lines, listing.lines[0]] } : listing;
      return held ? new Promise((resolve) => held!.push(() => resolve(answer))) : answer;
    });
    await gotoRoute(page, "/workspace/sh4-debugger");
    await server.described();
    const view = panel(page, "sh4-disassembly");
    const updating = view.getByText("Updating");
    const note = view.getByRole("note");
    // The first listing is late. There are no lines yet to say anything about: that they are
    // being read is said in their place.
    await expect(view).toContainText("Loading disassembly.");
    await expect(updating).toHaveCount(0);
    held.splice(0).forEach((answer) => answer());
    held = undefined;
    const line = view.locator(".current-instruction");
    await expect(line).toHaveCount(1);
    await page.setViewportSize({ width: 1366, height: 768 });
    await expect.poll(async () => (await view.boundingBox())!.width).toBeLessThan(340);

    // the lines are read again, and the answer is late: the view says that it is reading, over the lines
    repeating = true;
    held = [];
    await view.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(updating).toBeVisible();
    expect(await whole(view, updating), '"Updating" is inside the panel').toBe(true);
    const toolbar = (await view.getByRole("textbox").boundingBox())!;
    expect((await updating.boundingBox())!.y, '"Updating" is below the toolbar').toBeGreaterThanOrEqual(toolbar.y + toolbar.height);
    // also when the lines are scrolled to the side
    await line.locator("span").first().hover();
    await page.mouse.wheel(400, 0);
    await expect.poll(() => whole(view, line.locator("span").last())).toBe(true);
    expect(await whole(view, updating), '"Updating" is inside the panel, with the lines scrolled to the side').toBe(true);

    // the answer lists an address twice, and the view says so
    held.splice(0).forEach((answer) => answer());
    held = undefined;
    await expect(note).toHaveText("The server listed an address twice; it is shown once.");
    await expect(updating).toBeHidden();
    expect(await whole(view, note), "the note is inside the panel, with the lines scrolled to the side").toBe(true);
    await page.mouse.wheel(-400, 0);
    await expect.poll(() => whole(view, line.locator("span").first())).toBe(true);
    expect(await whole(view, note), "the note is inside the panel").toBe(true);

    // Without a connection there are no lines, and nothing is said about lines. (The server
    // does not describe itself on the next connection: the view stays without them.)
    server.answer("debugger.describe", () => new Promise(() => {}));
    server.drop();
    await expect(view).toContainText(/Not connected|No Data/);
    await expect(view.locator("[data-address]")).toHaveCount(0);
    await expect(note).toHaveCount(0);
    await expect(updating).toHaveCount(0);
  });
});
