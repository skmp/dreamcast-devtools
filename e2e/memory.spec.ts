import {
  test,
  expect,
  gotoRoute,
  openWorkspace,
  panel,
  pauseFromToolbar,
  saveScreenshot,
  statusBar,
  tooltipButton,
} from "./support/fixtures";
import type { Locator } from "@playwright/test";

const hex8 = (address: number) => `0x${address.toString(16).toUpperCase().padStart(8, "0")}`;

/** Memory rows: every row starts with its address cell. */
const memoryRows = (view: Locator): Locator =>
  view.locator("div").filter({ has: view.page().locator(":scope > span:nth-child(3)") }).filter({ hasText: /^0x[0-9A-F]{8}/ });

const rowAt = (view: Locator, address: number): Locator => memoryRows(view).filter({ hasText: hex8(address) });

// `start` is where the view opens: `defaultMemoryAddress` of the target in debugger.describe.
// `base` is an address in the middle of the target's memory, for the tests that type one.
for (const { name, workspace, id, start, base, firstRow } of [
  {
    name: "SH4",
    workspace: "sh4-debugger",
    id: "sh4-memory",
    start: 0x8c010000,
    base: 0x8c010000,
    // sha256-derived, i.e. stable content of the mock for this address
    firstRow: "45 BC 32 04 1F 4A 11 66 89 E9 C0 58 4D 3C 9B 6B",
  },
  { name: "ARM7", workspace: "arm7-debugger", id: "arm7-memory", start: 0, base: 0x00200000, firstRow: undefined },
] as const) {
  test.describe(`${name} memory`, () => {
    test.beforeEach(async ({ page }) => {
      await openWorkspace(page, workspace);
    });

    test("shows 60 rows of 16 bytes with an ASCII column from the default address", async ({ page, rpc }) => {
      const view = panel(page, id);
      await expect(view.getByText("Address", { exact: true })).toBeVisible();
      await expect(view.getByText("Hex", { exact: true })).toBeVisible();
      await expect(view.getByText("ASCII", { exact: true })).toBeVisible();

      const rows = memoryRows(view);
      await expect(rows).toHaveCount(60);
      const cells = rows.first().locator("span");
      await expect(cells.nth(0)).toHaveText(hex8(start));
      await expect(cells.nth(1)).toHaveText(/^([0-9A-F]{2} ){15}[0-9A-F]{2}$/);
      if (firstRow) {
        await expect(cells.nth(1)).toHaveText(firstRow);
      }
      expect((await cells.nth(2).innerText()).length).toBe(16);
      await expect(rows.nth(59).locator("span").first()).toHaveText(hex8(start + 59 * 16));

      expect(rpc.requests("state.getMemorySlice")[0].params).toEqual({
        target: name.toLowerCase(),
        address: start,
        length: 960,
      });
      // a running target sends five ticks a second, and none of them makes the view read again
      await page.waitForTimeout(1000);
      expect(rpc.received.filter((frame) => frame.method === "event.tick").length).toBeGreaterThan(3);
      expect(rpc.requests("state.getMemorySlice")).toHaveLength(1);
    });

    test("entering an address aligns it to a row and shows it with ten rows of context", async ({ page }) => {
      const view = panel(page, id);
      const box = view.getByRole("textbox");
      const typed = base - 0x8000 + 0x37;
      const aligned = base - 0x8000 + 0x30;

      await box.fill(hex8(typed));
      await box.press("Enter");

      await expect(memoryRows(view).first().locator("span").first()).toHaveText(hex8(aligned - 10 * 16));
      await expect(rowAt(view, aligned)).toBeVisible();
      await expect(box).toHaveValue(hex8(aligned));
      // the address is mirrored into the URL
      await expect(page).toHaveURL(new RegExp(`\\?address=${hex8(aligned)}$`));

      // the Go button does the same, without the 0x prefix
      await box.fill((base + 0x100).toString(16));
      await view.getByRole("button", { name: "Go", exact: true }).click();
      await expect(memoryRows(view).first().locator("span").first()).toHaveText(hex8(base + 0x100 - 10 * 16));
      await expect(box).toHaveValue(hex8(base + 0x100));
    });

    test("the mouse wheel scrolls six rows per notch and Refresh re-reads the same range", async ({ page, rpc }) => {
      const view = panel(page, id);
      const first = memoryRows(view).first().locator("span").first();
      await expect(first).toHaveText(hex8(start));

      await memoryRows(view).nth(5).hover();
      await page.mouse.wheel(0, 60);
      await expect(first).toHaveText(hex8(start + 96));
      await page.mouse.wheel(0, 120);
      await expect(first).toHaveText(hex8(start + 3 * 96));
      await page.mouse.wheel(0, -180);
      await expect(first).toHaveText(hex8(start));

      const before = rpc.requests("state.getMemorySlice").length;
      await tooltipButton(view, "Refresh").click();
      await expect.poll(() => rpc.requests("state.getMemorySlice").length).toBe(before + 1);
      expect(rpc.requests("state.getMemorySlice").at(-1)?.params).toMatchObject({ address: start, length: 960 });
      await expect(first).toHaveText(hex8(start));
    });
  });
}

test("entering an address highlights its row", async ({ page }) => {
  // regression (race): the highlight class was added from a 0 ms timer started on submit,
  // before the slice with that row had been fetched; it only showed when the server won
  await openWorkspace(page, "sh4-debugger");
  const view = panel(page, "sh4-memory");
  for (const address of [0x8c008030, 0x8c00a040, 0x8c00c050]) {
    await view.getByRole("textbox").fill(hex8(address));
    await view.getByRole("textbox").press("Enter");
    await expect(rowAt(view, address)).toBeVisible();
    await expect(rowAt(view, address)).toHaveClass(/target-address/);
    // exactly one row is marked
    await expect(view.locator(".target-address")).toHaveCount(1);
  }
  // an address that is already on screen: nothing is fetched, the row is marked right away
  await view.getByRole("textbox").fill(hex8(0x8c00c050 + 0x40));
  await view.getByRole("textbox").press("Enter");
  await expect(rowAt(view, 0x8c00c050 + 0x40)).toHaveClass(/target-address/);
  await expect(view.locator(".target-address")).toHaveCount(1);
});

test("what is being typed into the address box survives a change of the URL", async ({ page }) => {
  // regression: the box was rewritten with the address on screen whenever the panel's
  // callbacks changed identity, which they do with every change of the URL. The URL of a
  // submitted address is committed late while ticks arrive (5 per second from a running
  // server), i.e. while the next address is being typed: Enter then submitted the old one.
  // Here the URL changes for another reason, at a known moment: the About dialog is part of it.
  await openWorkspace(page, "sh4-debugger");
  const view = panel(page, "sh4-memory");
  const box = view.getByRole("textbox");
  await expect(box).toHaveValue(hex8(0x8c010000 + 10 * 16));

  await box.fill(hex8(0x8c00a040));
  await page.getByRole("button", { name: "About", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page).toHaveURL(/\?about=1$/);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page).toHaveURL(/#\/workspace\/sh4-debugger$/);
  // two changes of the URL later the box still holds what was typed, and Enter submits it
  await expect(box).toHaveValue(hex8(0x8c00a040));
  await box.press("Enter");
  await expect(rowAt(view, 0x8c00a040)).toHaveClass(/target-address/);
  await expect(page).toHaveURL(/\?address=0x8C00A040$/);
});

test("an address in the URL is shown again after a reload", async ({ page }) => {
  // regression: on load the ?address= value was used as the first fetched row while the box
  // still printed "first row + 10 rows": 0x8C0081C0 for ?address=0x8C008120, without context
  await openWorkspace(page, "sh4-debugger");
  const view = panel(page, "sh4-memory");
  const box = view.getByRole("textbox");
  await box.fill("0x8C008120");
  await box.press("Enter");
  await expect(page).toHaveURL(/\?address=0x8C008120$/);
  await expect(rowAt(view, 0x8c008120)).toBeVisible();

  await page.reload();
  await expect(statusBar(page)).toContainText("Connection: connected");
  await expect(rowAt(panel(page, "sh4-memory"), 0x8c008120)).toBeVisible();
  await expect(panel(page, "sh4-memory").getByRole("textbox")).toHaveValue("0x8C008120");
  await expect(memoryRows(panel(page, "sh4-memory")).first().locator("span").first()).toHaveText("0x8C008080");
});

test("a memory panel opened with ?address= shows and highlights that address", async ({ page }) => {
  await gotoRoute(page, "/workspace/sh4-debugger?address=0x8C004560");
  await expect(statusBar(page)).toContainText("Connection: connected");
  const view = panel(page, "sh4-memory");
  await expect(rowAt(view, 0x8c004560)).toBeVisible();
  await expect(rowAt(view, 0x8c004560)).toHaveClass(/target-address/);
  await expect(view.getByRole("textbox")).toHaveValue("0x8C004560");
  // ten rows of context above it, as after typing the address
  await expect(memoryRows(view).first().locator("span").first()).toHaveText("0x8C0044C0");
});

test("bytes the debugger cannot read are shown as ??, not as the zeros they are sent as", async ({ page, rpc }, testInfo) => {
  await openWorkspace(page, "sh4-debugger");
  const view = panel(page, "sh4-memory");
  const box = view.getByRole("textbox");
  // the flash ROM of the mock ends at 0x0021FFFF; what follows is not mapped
  await box.fill("0x00220000");
  await box.press("Enter");
  await expect(rowAt(view, 0x00220000)).toBeVisible();

  // ten rows of context that can be read ...
  const before = rowAt(view, 0x0021fff0).locator("span");
  await expect(before.nth(1)).toHaveText(/^([0-9A-F]{2} ){15}[0-9A-F]{2}$/);
  // ... and the row of the address and everything after it, which cannot
  for (const address of [0x00220000, 0x00220010, 0x00220000 + 49 * 16]) {
    const cells = rowAt(view, address).locator("span");
    await expect(cells.nth(1)).toHaveText("?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ??");
    await expect(cells.nth(2)).toHaveText("????????????????");
  }
  await expect(memoryRows(view)).toHaveCount(60);
  await saveScreenshot(page, testInfo, "memory-unreadable");
  // that is what the server said: 960 bytes, and the run that could not be read
  const answer = rpc.received.find((frame) => frame.id === rpc.sent.findLast((sent) => sent.method === "state.getMemorySlice")?.id);
  expect(answer?.result).toMatchObject({ baseAddress: 0x0021ff60, unreadable: [[160, 800]] });
  expect((answer?.result as { data: number[] }).data.slice(160)).toEqual(new Array(800).fill(0));

  // a range of which nothing can be read is refused by the server (-32010): the view shows that, and stays a view
  await memoryRows(view).nth(5).hover();
  await page.mouse.wheel(0, 120);
  await expect(memoryRows(view).first().locator("span").first()).toHaveText(hex8(0x0021ff60 + 2 * 96));
  await page.mouse.wheel(0, 60);
  await expect(memoryRows(view).first().locator("span").first()).toHaveText(hex8(0x00220000 + 0x80));
  await expect(memoryRows(view)).toHaveCount(60);
  await expect(memoryRows(view).nth(0).locator("span").nth(1)).toHaveText("?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ??");
  await expect(memoryRows(view).nth(59).locator("span").nth(1)).toHaveText("?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ??");
  const refused = rpc.received.find((frame) => frame.id === rpc.sent.findLast((sent) => sent.method === "state.getMemorySlice")?.id);
  expect(refused?.error).toEqual({ code: -32010, message: "address not readable" });
  // and it scrolls back out of it
  await page.mouse.wheel(0, -180);
  await expect(memoryRows(view).first().locator("span").first()).toHaveText(hex8(0x0021ff60));
  await expect(memoryRows(view).nth(0).locator("span").nth(1)).toHaveText(/^([0-9A-F]{2} ){15}[0-9A-F]{2}$/);
});

test("ARM7 memory ends where the address space of the ARM7 ends: its last row is 0x00FFFFF0", async ({ page, rpc }) => {
  // `addressMax` of the target in debugger.describe is 0x00FFFFFF: the view asks for nothing above it
  await openWorkspace(page, "arm7-debugger");
  const view = panel(page, "arm7-memory");
  const box = view.getByRole("textbox");
  const slices = () => rpc.requests("state.getMemorySlice").map((frame) => frame.params as { target: string; address: number; length: number });
  await expect(memoryRows(view)).toHaveCount(60);

  await box.fill("0x00FFFFFF");
  await box.press("Enter");
  // sixty rows that end with the last one, and no ten rows of context that would push it out
  await expect(memoryRows(view).first().locator("span").first()).toHaveText("0x00FFFC40");
  await expect(memoryRows(view).last().locator("span").first()).toHaveText("0x00FFFFF0");
  await expect(memoryRows(view)).toHaveCount(60);
  expect(slices().at(-1)).toEqual({ target: "arm7", address: 0x00fffc40, length: 960 });
  await expect(rowAt(view, 0x00fffff0)).toHaveClass(/target-address/);
  const settled = slices().length;

  // an address above the space, and the wheel: the view stays on the last sixty rows, and reads nothing
  await box.fill("0x12345678");
  await box.press("Enter");
  await memoryRows(view).nth(5).hover();
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(300);
  await expect(memoryRows(view).last().locator("span").first()).toHaveText("0x00FFFFF0");
  expect(slices()).toHaveLength(settled);
  for (const { address, length } of slices()) {
    expect(address + length - 1, hex8(address)).toBeLessThanOrEqual(0x00ffffff);
  }
  // and scrolls back
  await page.mouse.wheel(0, -60);
  await expect(memoryRows(view).first().locator("span").first()).toHaveText(hex8(0x00fffc40 - 96));
});

test("the memory is read again when the target stops, and not for any other tick", async ({ page, rpc }) => {
  await openWorkspace(page, "sh4-debugger");
  const view = panel(page, "sh4-memory");
  await expect(memoryRows(view)).toHaveCount(60);
  const fetches = () => rpc.requests("state.getMemorySlice").length;
  expect(fetches()).toBe(1);

  // a pause is a stop
  await pauseFromToolbar(page);
  await expect.poll(fetches).toBe(2);
  expect(rpc.requests("state.getMemorySlice").at(-1)?.params).toEqual({ target: "sh4", address: 0x8c010000, length: 960 });

  // a watch and a breakpoint are added: paused ticks of the same stop follow, and nothing is read
  const watches = panel(page, "watches");
  await watches.getByPlaceholder("Enter expression").fill("dc.sh4.cpu.pr");
  await watches.getByPlaceholder("Enter expression").press("Enter");
  await expect(watches.getByRole("listitem")).toHaveCount(2);
  const breakpoints = panel(page, "sh4-breakpoints");
  await breakpoints.getByPlaceholder("Address (e.g., 0x8C0000A0)").fill("0x8C0000AC");
  await breakpoints.getByPlaceholder("Address (e.g., 0x8C0000A0)").press("Enter");
  await expect(breakpoints.getByRole("listitem")).toHaveCount(1);
  await breakpoints.getByRole("switch").click();
  await expect(breakpoints.getByRole("switch")).not.toBeChecked();
  expect(fetches()).toBe(2);

  // every step is a stop
  const disassembly = panel(page, "sh4-disassembly");
  await tooltipButton(disassembly, "Step In").click();
  await expect.poll(fetches).toBe(3);
  await tooltipButton(disassembly, "Step Over").click();
  await expect.poll(fetches).toBe(4);

  // running: ticks five times a second, no reads; the stop that ends it reads once
  await tooltipButton(page, "Run").click();
  await expect(tooltipButton(page, "Pause")).toBeEnabled();
  await page.waitForTimeout(1000);
  expect(fetches()).toBe(4);
  await pauseFromToolbar(page);
  await expect.poll(fetches).toBe(5);
  // where the user had the view
  expect(rpc.requests("state.getMemorySlice").at(-1)?.params).toEqual({ target: "sh4", address: 0x8c010000, length: 960 });
});
