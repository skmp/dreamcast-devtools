import {
  test,
  expect,
  currentInstructionAddress,
  disassemblyRow,
  disassemblyRows,
  gotoRoute,
  holdResponses,
  openWorkspace,
  panel,
  pauseFromToolbar,
  saveScreenshot,
  statusBar,
  tooltipButton,
} from "./support/fixtures";
import type { Locator, Page } from "@playwright/test";
import { defaultAnswer, jsonRpcError, serveScriptedDebugger, type Json } from "./support/scriptedDebugger";
import { MOCK_M1_SUPPORT, MOCK_M2_SUPPORT } from "../server/mockDebugger";

const hex8 = (address: number) => `0x${address.toString(16).toUpperCase().padStart(8, "0")}`;

/** Memory rows: every row starts with its address cell. */
const memoryRows = (view: Locator): Locator =>
  view.locator("div").filter({ has: view.page().locator(":scope > span:nth-child(3)") }).filter({ hasText: /^0x[0-9A-F]{8}/ });

const rowAt = (view: Locator, address: number): Locator => memoryRows(view).filter({ hasText: hex8(address) });

/**
 * A count of requests once no more come: read when it has held still for half a second. Under
 * a slow CPU the requests of one action can arrive in more than one turn of the page.
 */
const settledCount = async (count: () => number): Promise<number> => {
  let seen = -1;
  await expect
    .poll(
      () => {
        const now = count();
        const still = now === seen;
        seen = now;
        return still;
      },
      { intervals: [500], message: "the requests settle" },
    )
    .toBe(true);
  return seen;
};

// `start` is where the view opens: `defaultMemoryAddress` of the target in debugger.describe.
// `base` is an address in the middle of the target's memory, for the tests that type one.
for (const { name, workspace, id, start, base, firstRow } of [
  {
    name: "SH4",
    workspace: "sh4-debugger",
    id: "sh4-memory",
    start: 0x8c010000,
    base: 0x8c010000,
    // a hash of the address, i.e. stable content of the mock for this address
    firstRow: "86 4F 83 7E AE 81 E8 01 1D 47 B9 98 3A 3F 92 11",
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
  const lastAnswer = () => rpc.received.find((frame) => frame.id === rpc.sent.findLast((sent) => sent.method === "state.getMemorySlice")?.id);
  await expect.poll(() => lastAnswer()?.result).toMatchObject({ baseAddress: 0x0021ff60, unreadable: [[160, 800]] });
  const answer = lastAnswer();
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
  // the panel shows some of the sixty rows of a slice whole (sixteen in the window of the suite)
  const whole = await wholeRows(view);
  expect(whole).toBeGreaterThan(10);
  expect(whole).toBeLessThan(60);
  const end = 0x01000000 - whole * 16;

  await box.fill("0x00FFFFFF");
  await box.press("Enter");
  // The view goes as far as the place at which the last row is the panel's last whole row, and
  // no ten rows of context push it out. What is read there ends with the last address.
  await expect(memoryRows(view).first().locator("span").first()).toHaveText(hex8(end));
  await expect(memoryRows(view).last().locator("span").first()).toHaveText("0x00FFFFF0");
  await expect(memoryRows(view)).toHaveCount(whole);
  expect(await wholeRows(view)).toBe(whole);
  await expect(rowAt(view, 0x00fffff0)).toHaveClass(/target-address/);
  const settled = await settledCount(() => slices().length);
  expect(slices().at(-1)).toEqual({ target: "arm7", address: end, length: whole * 16 });

  // an address above the space, and the wheel: the view stays at the last rows, and reads nothing
  await box.fill("0x12345678");
  await box.press("Enter");
  await memoryRows(view).nth(5).hover();
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(300);
  await expect(memoryRows(view).last().locator("span").first()).toHaveText("0x00FFFFF0");
  await expect(memoryRows(view).first().locator("span").first()).toHaveText(hex8(end));
  expect(slices()).toHaveLength(settled);
  for (const { address, length } of slices()) {
    expect(address + length - 1, hex8(address)).toBeLessThanOrEqual(0x00ffffff);
  }
  // and scrolls back
  await page.mouse.wheel(0, -60);
  await expect(memoryRows(view).first().locator("span").first()).toHaveText(hex8(end - 96));
});

/**
 * Makes the window as high as it has to be for the memory panel `view` to show `rows` rows of
 * its listing whole, at the width of the suite's window. The rows the listing has are the
 * sixty of a slice, so that what is counted is the room the panel has.
 */
const panelOfRows = async (page: Page, view: Locator, rows: number) => {
  const at = async (height: number) => {
    await page.setViewportSize({ width: 1600, height });
    await page.waitForTimeout(150);
    return wholeRows(view);
  };
  // the fewest pixels at which the panel has room for that many rows
  let low = 400;
  let high = 2400;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if ((await at(middle)) >= rows) {
      high = middle;
    } else {
      low = middle;
    }
  }
  expect(await at(high), `a window in which the panel shows ${rows} rows whole`).toBe(rows);
};

test("a panel that grows at the end of an address space stays full: the view comes back up as far as the panel has room, and a move starts from there", async ({
  page,
  rpc,
}) => {
  await openWorkspace(page, "sh4-debugger");
  // (paused: the bytes are editors, see below)
  await pauseFromToolbar(page);
  const view = panel(page, "sh4-memory");
  const box = view.getByRole("textbox");
  const first = memoryRows(view).first().locator("span").first();
  await expect(memoryRows(view)).toHaveCount(60);
  await panelOfRows(page, view, 10);
  await box.fill("0xFFFFFFFF");
  await box.press("Enter");
  await expect(first).toHaveText(hex8(0xfffffff0 - 9 * 16));
  await expect(memoryRows(view)).toHaveCount(10);

  // the panel has room for twenty rows now: twenty are read, and the last row of the space is the last of them
  await panelOfRows(page, view, 20);
  await expect(first).toHaveText(hex8(0xfffffff0 - 19 * 16));
  await expect(memoryRows(view)).toHaveCount(20);
  expect(await wholeRows(view)).toBe(20);
  expect(rpc.requests("state.getMemorySlice").at(-1)?.params).toEqual({ target: "sh4", address: 0xfffffff0 - 19 * 16, length: 20 * 16 });
  // The view stands where the panel's new size lets it, not where the box took it: a byte of
  // the rows on screen opens its editor there, in the last row and in the middle of the listing,
  // and the editor stays.
  for (const address of [0xfffffff4, 0xfffffff0 - 10 * 16 + 2]) {
    await dblclickByte(view, address);
    await expect(byteEditor(view)).toHaveAccessibleName(`Bytes to write from ${hex8(address)}`);
    await expect(byteEditor(view)).toBeFocused();
    await page.waitForTimeout(300);
    await expect(byteEditor(view), `the editor of ${hex8(address)} is still open`).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(byteEditor(view)).toHaveCount(0);
  }
  expect(rpc.requests("state.writeMemory")).toEqual([]);
  // a notch of the wheel up moves the view six rows up from where it is now
  await memoryRows(view).first().hover();
  await page.mouse.wheel(0, -60);
  await expect(first).toHaveText(hex8(0xfffffff0 - 25 * 16));
});

test("a memory panel of three rows opened with ?address= shows and highlights that address: the context above it is what fits", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  await expect(memoryRows(panel(page, "sh4-memory"))).toHaveCount(60);
  await panelOfRows(page, panel(page, "sh4-memory"), 3);
  // the same window, the same layout: a page opened with an address
  await gotoRoute(page, "/workspace/sh4-debugger?address=0x8C004560");
  await page.reload();
  await expect(statusBar(page)).toContainText("Connection: connected");
  const view = panel(page, "sh4-memory");
  await expect(memoryRows(view).first().locator("span").first()).toHaveText("0x8C004540");
  await expect(rowAt(view, 0x8c004560)).toHaveClass(/target-address/);
  await expect(rowAt(view, 0x8c004560).locator("span").first()).toBeInViewport({ ratio: 1 });
  expect(await wholeRows(view)).toBe(3);
  await expect(view.getByRole("textbox")).toHaveValue("0x8C004560");
  // exactly one row is marked
  await expect(view.locator(".target-address")).toHaveCount(1);
});

/**
 * Records every flash of the mark of a row (`target-address`, whose animation starts again
 * whenever a row is marked), with the address the row shows at that moment.
 */
const recordFlashes = async (page: Page) => {
  await page.addInitScript(() => {
    const store = window as unknown as { __flashes: string[] };
    store.__flashes = [];
    document.addEventListener(
      "animationstart",
      (event) => {
        const row = event.target;
        if (row instanceof HTMLElement && row.classList.contains("target-address")) {
          store.__flashes.push(row.querySelector("span")?.textContent ?? "");
        }
      },
      true,
    );
  });
  return () => page.evaluate(() => (window as unknown as { __flashes: string[] }).__flashes.slice());
};

// An address of the URL near the end of an address space, in a panel that shows more than ten
// rows and fewer than a slice (sixteen in the window of the suite, or forty): the first view
// is placed for a whole slice, and the view moves once the panel has been measured. The row of
// the URL is on screen then, and it is the one row that is marked, not the row of the listing
// that showed it before the move.
for (const { name, workspace, id, target, address, tall } of [
  { name: "SH4", workspace: "sh4-debugger", id: "sh4-memory", target: "sh4", address: 0xfffffe60, tall: undefined },
  { name: "SH4, its last row,", workspace: "sh4-debugger", id: "sh4-memory", target: "sh4", address: 0xfffffff0, tall: undefined },
  { name: "ARM7", workspace: "arm7-debugger", id: "arm7-memory", target: "arm7", address: 0x00fffe60, tall: undefined },
  { name: "ARM7, 25 rows before its last row,", workspace: "arm7-debugger", id: "arm7-memory", target: "arm7", address: 0x00fffe00, tall: 40 },
] as const) {
  test(`${name} opened with ?address=${hex8(address)} in a panel of ${tall ?? "the suite's window"}${tall ? " rows" : ""}: that row is on screen, and the only row marked`, async ({
    page,
    rpc,
  }) => {
    const flashes = await recordFlashes(page);
    if (tall !== undefined) {
      await openWorkspace(page, workspace);
      await expect(memoryRows(panel(page, id))).toHaveCount(60);
      await panelOfRows(page, panel(page, id), tall);
    }
    // the same window, the same layout: a page opened with an address
    await gotoRoute(page, `/workspace/${workspace}?address=${hex8(address)}`);
    if (tall !== undefined) {
      await page.reload();
    }
    await expect(statusBar(page)).toContainText("Connection: connected");
    const view = panel(page, id);
    const slices = () => rpc.requests("state.getMemorySlice").filter((frame) => (frame.params as { target: string }).target === target);
    await expect(rowAt(view, address)).toBeVisible();
    // (the view has been placed for the panel, and has read its rows)
    await settledCount(() => slices().length);
    const whole = await wholeRows(view);
    expect(whole).toBeGreaterThan(10);
    expect(whole).toBeLessThan(60);
    if (tall !== undefined) {
      expect(whole).toBe(tall);
    }
    // ten rows of context above it, or as many as there are above the last rows of the space
    const lastRow = (target === "arm7" ? 0x00ffffff : 0xffffffff) - 15;
    const firstRow = Math.min(address - 10 * 16, lastRow - (whole - 1) * 16);
    await expect(memoryRows(view).first().locator("span").first()).toHaveText(hex8(firstRow));
    await expect(rowAt(view, address).locator("span").first()).toBeInViewport({ ratio: 1 });
    await expect(view.locator(".target-address")).toHaveCount(1);
    await expect(rowAt(view, address)).toHaveClass(/target-address/);
    expect((await flashes()).at(-1)).toBe(hex8(address));
    // the box says where the view is, as it does for a typed address: the row ten rows below the first
    await expect(view.getByRole("textbox")).toHaveValue(hex8(firstRow + 10 * 16));
  });
}

test("an address of the URL whose view does not move when the panel is measured is marked once: a later read marks nothing", async ({ page }) => {
  const flashes = await recordFlashes(page);
  await openWorkspace(page, "arm7-debugger");
  await expect(memoryRows(panel(page, "arm7-memory"))).toHaveCount(60);
  await panelOfRows(page, panel(page, "arm7-memory"), 3);
  // Near the first address the view stands at 0 whether it has ten rows of context or two: the
  // measure of the panel does not move it, and the row of the URL is marked in the rows it is in.
  await gotoRoute(page, "/workspace/arm7-debugger?address=0x00000020");
  await page.reload();
  await expect(statusBar(page)).toContainText("Connection: connected");
  const view = panel(page, "arm7-memory");
  await expect(memoryRows(view).first().locator("span").first()).toHaveText("0x00000000");
  await expect(rowAt(view, 0x20)).toHaveClass(/target-address/);
  await expect(rowAt(view, 0x20).locator("span").first()).toBeInViewport({ ratio: 1 });
  expect(await wholeRows(view)).toBe(3);
  await page.waitForTimeout(500);
  expect(await flashes()).toEqual(["0x00000020"]);
  // a stop reads the rows again, where they are: nothing is marked again
  await pauseFromToolbar(page);
  await expect(page.getByRole("status", { name: "Execution state" })).toContainText("Paused");
  await page.waitForTimeout(500);
  expect(await flashes()).toEqual(["0x00000020"]);
  await expect(view.locator(".target-address")).toHaveCount(1);
});

// In a panel that shows fewer rows than a slice holds, the last rows of an address space are
// on screen when the view stands so that the last row is the panel's last whole row: the view
// goes that far, by the wheel, by the keys and for an address typed into the box. The listing is
// cut at the edge of the panel and is not scrolled, as everywhere.
for (const { name, workspace, id, target, addressMax } of [
  { name: "SH4", workspace: "sh4-debugger", id: "sh4-memory", target: "sh4", addressMax: 0xffffffff },
  { name: "ARM7", workspace: "arm7-debugger", id: "arm7-memory", target: "arm7", addressMax: 0x00ffffff },
] as const) {
  for (const tall of [10, 3, 40]) {
    test(`${name} memory in a panel ${tall} rows tall: the last row of the address space is reached by the wheel, by the keys and by the address box`, async ({
      page,
      rpc,
    }) => {
      const last = addressMax - 15;
      // where the view stands with the last row the panel's last
      const end = last - (tall - 1) * 16;
      await openWorkspace(page, workspace);
      const view = panel(page, id);
      const box = view.getByRole("textbox");
      const first = memoryRows(view).first().locator("span").first();
      const slices = () => rpc.requests("state.getMemorySlice").map((frame) => frame.params as { target: string; address: number; length: number });
      await expect(memoryRows(view)).toHaveCount(60);
      await panelOfRows(page, view, tall);
      const top = await headerTop(view);
      /** the last row of the space is the panel's last, whole, and nothing is scrolled for it */
      const lastRowIsTheLastOnScreen = async () => {
        await expect(first).toHaveText(hex8(end));
        await expect(memoryRows(view)).toHaveCount(tall);
        await expect(memoryRows(view).last().locator("span").first()).toHaveText(hex8(last));
        expect(await wholeRows(view)).toBe(tall);
        // (in a panel narrower than a row the listing is scrolled to the side: the address of the row is on screen)
        await expect(rowAt(view, last).locator("span").first()).toBeInViewport({ ratio: 1 });
        expect(await scrolledDown(view)).toBe(0);
        expect(await headerTop(view)).toBe(top);
        // what was read there ends at the last address, and nothing was asked for above it
        expect(slices().at(-1)).toEqual({ target, address: end, length: tall * 16 });
        for (const { address, length } of slices()) {
          expect(address + length - 1, hex8(address)).toBeLessThanOrEqual(addressMax);
        }
      };
      // the listing is cut at the edge of the panel, not scrolled
      const overflow = await view
        .locator("[data-memory-hex]")
        .first()
        .evaluate((cell) => {
          let listing = cell.parentElement;
          while (listing && getComputedStyle(listing).overflowY === "visible") {
            listing = listing.parentElement;
          }
          return getComputedStyle(listing!).overflowY;
        });
      expect(overflow).toBe("clip");

      // --- the wheel, from 0x400 bytes above the last row on ---
      await box.fill(hex8(last - 0x400));
      await box.press("Enter");
      await expect(rowAt(view, last - 0x400).locator("span").first()).toBeInViewport({ ratio: 1 });
      await memoryRows(view).first().hover();
      for (let notch = 0; notch < 14; notch++) {
        await page.mouse.wheel(0, 60);
      }
      await lastRowIsTheLastOnScreen();
      // further: nothing moves, and nothing is read
      const read = await settledCount(() => slices().length);
      await page.mouse.wheel(0, 600);
      await page.waitForTimeout(300);
      await expect(first).toHaveText(hex8(end));
      expect(slices()).toHaveLength(read);

      // --- the keys: the place of the keyboard is taken down from 0x200 bytes above it ---
      await box.fill(hex8(last - 0x200));
      await box.press("Enter");
      await expect(first).not.toHaveText(hex8(end));
      await place(view).focus();
      // the rows between, and some more presses, which do nothing at the last row
      for (let press = 0; press < 0x200 / 16 + 12; press++) {
        await page.keyboard.press("ArrowDown");
      }
      await expect(hexCell(view, last)).toBeFocused();
      await expect(place(view)).toHaveAccessibleName(new RegExp(`^${hex8(last)} (\\?\\?|[0-9A-F]{2}), write$`));
      await lastRowIsTheLastOnScreen();
      await expect(view.locator(".memory-cursor")).toBeInViewport({ ratio: 1 });
      // and up again: the place goes up the rows that are on screen
      await page.keyboard.press("ArrowUp");
      await expect(hexCell(view, last - 16)).toBeFocused();
      await expect(first).toHaveText(hex8(end));

      // --- the box: the last address of the space ---
      await box.fill(hex8(last - 0x1000));
      await box.press("Enter");
      await expect(first).not.toHaveText(hex8(end));
      await box.fill(hex8(addressMax));
      await box.press("Enter");
      await lastRowIsTheLastOnScreen();
      await expect(rowAt(view, last)).toHaveClass(/target-address/);
      // the box says the row ten rows below the first, or the last whole row in a panel of ten rows or fewer
      await expect(box).toHaveValue(hex8(end + Math.min(10, tall - 1) * 16));
      expect(rpc.requests("state.writeMemory")).toEqual([]);
    });
  }
}

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

// ---------------------------------------------------------------------------------------
// Byte editing: a double click on a byte of the hex column opens an editor there, and the run
// of bytes typed into it is one state.writeMemory, from that byte on. It is offered on a
// server with `memory-write`, while the target is paused.
// ---------------------------------------------------------------------------------------

/** The hex column of the row that starts at `address`. */
const hexCell = (view: Locator, address: number): Locator => view.locator(`[data-memory-hex="${address}"]`);

/**
 * Double-clicks the byte at `address`. A row is one piece of text, and the view finds the byte
 * from where in the hex column the pointer is: here the middle of the byte's second digit.
 */
const dblclickByte = async (view: Locator, address: number, options: { force?: boolean } = {}) => {
  const cell = hexCell(view, address - (address % 16));
  const box = (await cell.boundingBox())!;
  await cell.dblclick({ position: { x: ((address % 16) * 3 + 1.5) * (box.width / 47), y: box.height / 2 }, ...options });
};

/** The open editor of a memory view (its other box is the address box). */
const byteEditor = (view: Locator): Locator => view.getByRole("textbox", { name: /^Bytes to write from / });

/**
 * The place the keyboard has in the hex column of a memory view, on a server that writes
 * memory: the hex column of one row, which is the one stop of the listing for the Tab key and
 * names the byte it is on.
 */
const place = (view: Locator): Locator => view.getByRole("button", { name: /, write$/ });

/** How far down the screen the header line of a listing is: it moves when something scrolls the listing. */
const headerTop = async (view: Locator): Promise<number> => (await view.getByText("Address", { exact: true }).boundingBox())!.y;

/** The box that scrolls a listing to the side, in a panel narrower than a row. */
const sideScroll = (view: Locator, to?: "start" | "end"): Promise<number> =>
  view
    .locator("[data-memory-hex]")
    .first()
    .evaluate((cell, where) => {
      let box: HTMLElement | null = cell.parentElement;
      while (box && !/auto|scroll/.test(getComputedStyle(box).overflowX)) {
        box = box.parentElement;
      }
      if (!box) {
        throw new Error("nothing scrolls the listing to the side");
      }
      if (where) {
        box.scrollLeft = where === "end" ? box.scrollWidth : 0;
      }
      return box.scrollLeft;
    }, to);

/** By how much the listing, or anything around it up to its panel, is scrolled up or down. */
const scrolledDown = (view: Locator): Promise<number> =>
  view.evaluate((root) => {
    let total = 0;
    for (let box = root.querySelector<HTMLElement>("[data-memory-hex]"); box && box !== root.parentElement; box = box.parentElement) {
      total += box.scrollTop;
    }
    return total;
  });

/** How many rows of a listing are on screen as a whole: the listing is cut at the edge of its panel. */
const wholeRows = (view: Locator): Promise<number> =>
  view.evaluate((root) => {
    const cells = Array.from(root.querySelectorAll<HTMLElement>("[data-memory-hex]"));
    let listing = cells[0].parentElement;
    while (listing && getComputedStyle(listing).overflowY === "visible") {
      listing = listing.parentElement;
    }
    const frame = listing!.getBoundingClientRect();
    return cells.filter((cell) => cell.parentElement!.getBoundingClientRect().bottom <= frame.bottom).length;
  });

const EDIT_HINT = "Double-click a byte to write memory from there";
const RUNNING_HINT = "Read-only while the target runs: pause it to write memory";

test.describe("byte editing", () => {
  test("a run of bytes typed in one go is one request, from the byte that was double-clicked; the views read again where they are", async ({
    page,
    rpc,
  }, testInfo) => {
    await openWorkspace(page, "sh4-debugger");
    await pauseFromToolbar(page);
    const view = panel(page, "sh4-memory");
    const listing = panel(page, "sh4-disassembly");
    const hex = (address: number) => rowAt(view, address).locator("span").nth(1);
    await expect(hex(0x8c010000)).toHaveText("86 4F 83 7E AE 81 E8 01 1D 47 B9 98 3A 3F 92 11");
    await expect(hexCell(view, 0x8c010000)).toHaveAttribute("title", EDIT_HINT);
    const slices = () => rpc.requests("state.getMemorySlice").length;
    const listings = () => rpc.requests("state.getDisassembly").length;
    const firstLine = await disassemblyRows(listing).first().getAttribute("data-address");
    const before = { slices: slices(), listings: listings() };

    // the editor opens over the byte, with the byte in it, selected: typing replaces it
    await dblclickByte(view, 0x8c010004);
    const editor = byteEditor(view);
    await expect(editor).toBeFocused();
    await expect(editor).toHaveAccessibleName("Bytes to write from 0x8C010004");
    await expect(editor).toHaveValue("AE");
    expect(await editor.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([0, 2]);
    // ... where the byte is: its digits are where those of the byte were
    const cell = (await hexCell(view, 0x8c010000).boundingBox())!;
    const box = (await editor.boundingBox())!;
    expect(Math.abs(box.x + 4 - (cell.x + 4 * 3 * (cell.width / 47)))).toBeLessThan(1.5);
    expect(box.x + box.width).toBeLessThanOrEqual(cell.x + cell.width + 9);
    // the row is what it was while the box is open
    await expect(hex(0x8c010000)).toHaveText("86 4F 83 7E AE 81 E8 01 1D 47 B9 98 3A 3F 92 11");

    await page.keyboard.type("DE AD be ef");
    await saveScreenshot(page, testInfo, "memory-editing");
    await page.keyboard.press("Enter");
    await expect(editor).toHaveCount(0);
    await expect(hex(0x8c010000)).toHaveText("86 4F 83 7E DE AD BE EF 1D 47 B9 98 3A 3F 92 11");
    expect(rpc.requests("state.writeMemory").map((frame) => frame.params)).toEqual([
      { target: "sh4", address: 0x8c010004, data: [0xde, 0xad, 0xbe, 0xef] },
    ]);
    // the text column follows: what was written is no printable text
    await expect(rowAt(view, 0x8c010000).locator("span").nth(2)).toHaveText(/^.{4}\.{4}/);

    // both views read again, once, and where they are; nothing moved, and it was no stop
    await expect.poll(slices).toBe(before.slices + 1);
    await expect.poll(listings).toBe(before.listings + 1);
    expect(rpc.requests("state.getMemorySlice").at(-1)?.params).toEqual({ target: "sh4", address: 0x8c010000, length: 960 });
    await expect(disassemblyRows(listing).first()).toHaveAttribute("data-address", firstLine!);
    await expect(memoryRows(view).first().locator("span").first()).toHaveText("0x8C010000");
    await expect(page.getByRole("status", { name: "Execution state" })).toHaveText("Paused · paused by the debugger · stop 1");

    // a run is not cut at the end of its row; digits need no blanks between them, and one digit alone is a byte
    await dblclickByte(view, 0x8c01000e);
    await byteEditor(view).fill("0011 2233 7");
    await byteEditor(view).press("Enter");
    await expect(hex(0x8c010000)).toHaveText("86 4F 83 7E DE AD BE EF 1D 47 B9 98 3A 3F 00 11");
    await expect(hex(0x8c010010)).toHaveText(/^22 33 07 /);
    expect(rpc.requests("state.writeMemory").at(-1)?.params).toEqual({ target: "sh4", address: 0x8c01000e, data: [0x00, 0x11, 0x22, 0x33, 0x07] });
    // the last byte of a row, and the first
    await dblclickByte(view, 0x8c01002f);
    await expect(byteEditor(view)).toHaveAccessibleName("Bytes to write from 0x8C01002F");
    await byteEditor(view).press("Escape");
    await dblclickByte(view, 0x8c010030);
    await expect(byteEditor(view)).toHaveAccessibleName("Bytes to write from 0x8C010030");
    await byteEditor(view).press("Escape");
    expect(rpc.requests("state.writeMemory")).toHaveLength(2);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("code that is written is what the disassembly shows, where it was", async ({ page }) => {
    await openWorkspace(page, "sh4-debugger");
    await pauseFromToolbar(page);
    const view = panel(page, "sh4-memory");
    const listing = panel(page, "sh4-disassembly");
    const pc = await currentInstructionAddress(listing);
    const firstLine = await disassemblyRows(listing).first().getAttribute("data-address");

    // the memory view is taken to the code the SH4 is in
    await view.getByRole("textbox").fill(hex8(pc));
    await view.getByRole("textbox").press("Enter");
    await expect(rowAt(view, pc - (pc % 16))).toBeVisible();
    // `mov #42, r1` at the program counter
    await dblclickByte(view, pc);
    await byteEditor(view).fill("2A E1");
    await byteEditor(view).press("Enter");
    await expect(byteEditor(view)).toHaveCount(0);

    const line = disassemblyRow(listing, pc);
    await expect(line).toContainText("2A E1");
    await expect(line).toContainText("mov #42, r1");
    // the listing did not move for it, and the line is still the current one
    await expect(disassemblyRows(listing).first()).toHaveAttribute("data-address", firstLine!);
    expect(await currentInstructionAddress(listing)).toBe(pc);
  });

  test("editing is offered while the target is paused only; Escape, leaving the box and a target that runs again put the editor away", async ({
    page,
    rpc,
  }) => {
    await openWorkspace(page, "sh4-debugger");
    const view = panel(page, "sh4-memory");
    await expect(memoryRows(view)).toHaveCount(60);
    // running: the bytes say that they cannot be written now, and a double click on one all the same opens nothing
    await expect(hexCell(view, 0x8c010000)).toHaveAttribute("title", RUNNING_HINT);
    await expect(hexCell(view, 0x8c010000)).toHaveAttribute("aria-disabled", "true");
    await dblclickByte(view, 0x8c010002, { force: true });
    await dblclickByte(view, 0x8c010012);
    await expect(byteEditor(view)).toHaveCount(0);

    await pauseFromToolbar(page);
    await expect(hexCell(view, 0x8c010000)).toHaveAttribute("title", EDIT_HINT);
    await dblclickByte(view, 0x8c010002);
    await byteEditor(view).fill("AA");
    await byteEditor(view).press("Escape");
    await expect(byteEditor(view)).toHaveCount(0);

    await dblclickByte(view, 0x8c010002);
    await byteEditor(view).fill("BB");
    await view.getByText("ASCII", { exact: true }).click();
    await expect(byteEditor(view)).toHaveCount(0);

    await dblclickByte(view, 0x8c010002);
    await byteEditor(view).fill("CC");
    await tooltipButton(page, "Run").click();
    await expect(tooltipButton(page, "Pause")).toBeEnabled();
    await expect(byteEditor(view)).toHaveCount(0);
    await pauseFromToolbar(page);
    await expect(byteEditor(view)).toHaveCount(0);

    expect(rpc.requests("state.writeMemory")).toEqual([]);
    await expect(rowAt(view, 0x8c010000).locator("span").nth(1)).toHaveText("86 4F 83 7E AE 81 E8 01 1D 47 B9 98 3A 3F 92 11");
  });

  test("what is no run of bytes is not sent, and what the server refuses is not written: the editor stays open and says why", async ({ page, rpc }) => {
    await openWorkspace(page, "sh4-debugger");
    await pauseFromToolbar(page);
    const view = panel(page, "sh4-memory");
    const alerts = page.getByRole("alert");

    await dblclickByte(view, 0x8c010008);
    const editor = byteEditor(view);
    // three digits are no bytes
    await editor.fill("ABC");
    await editor.press("Enter");
    await expect(alerts.filter({ hasText: '"ABC" has 3 digits: a byte is two hex digits' })).toBeVisible();
    await expect(editor).toHaveValue("ABC");
    await expect(editor).toHaveAttribute("aria-invalid", "true");
    await expect(editor).toHaveAttribute("title", '"ABC" has 3 digits: a byte is two hex digits');
    // the column is hex: no "0x", no decimal
    await editor.fill("0x12");
    await expect(editor).not.toHaveAttribute("aria-invalid");
    await editor.press("Enter");
    await expect(alerts.filter({ hasText: '"0x12" is not hex: a byte is two hex digits' })).toBeVisible();
    await editor.fill("");
    await editor.press("Enter");
    await expect(alerts.filter({ hasText: "Type the bytes to write: two hex digits a byte" })).toBeVisible();
    await expect(editor).toBeVisible();
    expect(rpc.requests("state.writeMemory")).toEqual([]);
    await editor.press("Escape");

    // The boot ROM can be read and not written (-32013), and a range is refused whole. The
    // flash ROM of the mock ends at 0x0021FFFF; what follows is not mapped.
    const box = view.getByRole("textbox").first();
    await box.fill("0x0021FFF0");
    await box.press("Enter");
    await expect(rowAt(view, 0x0021fff0)).toBeVisible();
    const rom = await rowAt(view, 0x0021fff0).locator("span").nth(1).innerText();
    await dblclickByte(view, 0x0021fff4);
    await editor.fill("00 01");
    await editor.press("Enter");
    await expect(alerts.filter({ hasText: "not writable: sh4 0x0021FFF4..0x0021FFF5" })).toBeVisible();
    await expect(editor).toHaveValue("00 01");
    await expect(editor).toHaveAttribute("aria-invalid", "true");
    expect(rpc.received.find((frame) => frame.id === rpc.requests("state.writeMemory").at(-1)?.id)?.result).toEqual({
      error: { code: -32013, message: "not writable: sh4 0x0021FFF4..0x0021FFF5" },
    });
    await editor.press("Escape");
    await expect(rowAt(view, 0x0021fff0).locator("span").nth(1)).toHaveText(rom);

    // a byte that could not be read has no value to edit: no editor opens on "??"
    await expect(rowAt(view, 0x00220000).locator("span").nth(1)).toHaveText("?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ?? ??");
    await dblclickByte(view, 0x00220003);
    await expect(editor).toHaveCount(0);
    expect(rpc.requests("state.writeMemory")).toHaveLength(1);
  });

  test("a run that would pass the last address of the target is not sent", async ({ page, rpc }) => {
    // The last sixty rows of an address space are one view, which moves no further. Its last
    // row is on screen in a panel that has room for sixty rows: the listing is cut at the edge
    // of its panel, and nothing scrolls it.
    await page.setViewportSize({ width: 1600, height: 2800 });
    await openWorkspace(page, "sh4-debugger");
    await pauseFromToolbar(page);
    const view = panel(page, "sh4-memory");
    const box = view.getByRole("textbox").first();
    // the last row of the SH4's address space: on-chip registers, which are read
    await box.fill("0xFFFFFFFF");
    await box.press("Enter");
    await expect(memoryRows(view).last().locator("span").first()).toHaveText("0xFFFFFFF0");
    await expect(memoryRows(view).last().locator("span").first()).toBeInViewport({ ratio: 1 });
    await dblclickByte(view, 0xffffffff);
    const editor = byteEditor(view);
    await expect(editor).toHaveAccessibleName("Bytes to write from 0xFFFFFFFF");
    await editor.fill("01 02");
    await editor.press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "2 bytes from 0xFFFFFFFF would pass the last address, 0xFFFFFFFF" })).toBeVisible();
    await expect(editor).toHaveValue("01 02");
    await expect(editor).toHaveAttribute("aria-invalid", "true");
    expect(rpc.requests("state.writeMemory")).toEqual([]);
    // the last byte alone is a run inside the space: it is sent, and it is the server that says what is there
    await editor.fill("01");
    await editor.press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "not writable: sh4 0xFFFFFFFF..0xFFFFFFFF" })).toBeVisible();
    expect(rpc.requests("state.writeMemory").map((frame) => frame.params)).toEqual([{ target: "sh4", address: 0xffffffff, data: [1] }]);
  });

  test("a run that ends in what cannot be written is refused whole by the server", async ({ page, rpc }) => {
    await openWorkspace(page, "arm7-debugger");
    await pauseFromToolbar(page);
    const view = panel(page, "arm7-memory");
    const box = view.getByRole("textbox").first();
    // wave memory ends at 0x007FFFFF; behind it are the registers of the AICA
    await box.fill("0x007FFFF0");
    await box.press("Enter");
    await expect(rowAt(view, 0x007ffff0)).toBeVisible();
    const last = await rowAt(view, 0x007ffff0).locator("span").nth(1).innerText();
    await dblclickByte(view, 0x007fffff);
    await byteEditor(view).fill("01 02");
    await byteEditor(view).press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "not writable: arm7 0x007FFFFF..0x00800000" })).toBeVisible();
    await expect(byteEditor(view)).toBeVisible();
    // nothing of the run was written: the first byte is what it was
    await expect(rowAt(view, 0x007ffff0).locator("span").nth(1)).toHaveText(last);
    // ... and the last byte of wave memory alone is written
    await byteEditor(view).fill("5A");
    await byteEditor(view).press("Enter");
    await expect(byteEditor(view)).toHaveCount(0);
    await expect(rowAt(view, 0x007ffff0).locator("span").nth(1)).toHaveText(/ 5A$/);
    expect(rpc.requests("state.writeMemory").map((frame) => frame.params)).toEqual([
      { target: "arm7", address: 0x007fffff, data: [1, 2] },
      { target: "arm7", address: 0x007fffff, data: [0x5a] },
    ]);
  });

  test("an answer that is late: the editor waits with what was typed, sends nothing more, and closes when the server has accepted", async ({ page }) => {
    const held = await holdResponses(page, "state.writeMemory");
    await openWorkspace(page, "arm7-debugger");
    await pauseFromToolbar(page);
    const view = panel(page, "arm7-memory");
    await expect(memoryRows(view)).toHaveCount(60);

    await dblclickByte(view, 0x00000021);
    const editor = byteEditor(view);
    await expect(editor).toHaveAccessibleName("Bytes to write from 0x00000021");
    await editor.fill("C0 FF EE");
    await editor.press("Enter");
    await expect.poll(held.held).toBe(1);
    await expect(editor).toHaveValue("C0 FF EE");
    await expect(editor).toHaveAttribute("aria-busy", "true");
    await editor.press("Enter");
    await editor.press("Enter");
    await page.waitForTimeout(300);
    expect(held.requests("state.writeMemory")).toHaveLength(1);
    expect(held.requests("state.writeMemory")[0].params).toEqual({ target: "arm7", address: 0x21, data: [0xc0, 0xff, 0xee] });

    held.release();
    await expect(editor).toHaveCount(0);
    await expect(rowAt(view, 0x20).locator("span").nth(1)).toHaveText(/^[0-9A-F]{2} C0 FF EE /);
    expect(held.requests("state.writeMemory")).toHaveLength(1);
  });
});

test.describe("byte editing: the box of an editor is in a row of the listing", () => {
  test("a view that moves is leaving the box: the wheel puts an open editor away, and it is not back when its row is", async ({ page, rpc }) => {
    await openWorkspace(page, "sh4-debugger");
    await pauseFromToolbar(page);
    const view = panel(page, "sh4-memory");
    const first = memoryRows(view).first().locator("span").first();
    await expect(memoryRows(view)).toHaveCount(60);

    // an editor in one of the first six rows: a notch of the wheel takes its row out of the listing
    await dblclickByte(view, 0x8c010004);
    await byteEditor(view).fill("AA");
    await memoryRows(view).nth(5).hover();
    await expect(byteEditor(view)).toBeFocused();
    await page.mouse.wheel(0, 60);
    await expect(first).toHaveText(hex8(0x8c010000 + 96));
    await expect(byteEditor(view)).toHaveCount(0);
    // the focus the box had is on the hex column, which is no box: what is typed next goes nowhere
    await expect(place(view)).toBeFocused();
    await page.keyboard.type("8C020000");
    // the row is back: the editor is not, and nothing takes the focus
    await page.mouse.wheel(0, -60);
    await expect(first).toHaveText(hex8(0x8c010000));
    await expect(rowAt(view, 0x8c010000)).toBeVisible();
    await page.waitForTimeout(300);
    await expect(byteEditor(view)).toHaveCount(0);
    await expect(view.getByRole("textbox")).toHaveCount(1);
    await expect(place(view)).toBeFocused();

    // an editor in a row that stays in the listing when the view moves is put away as well: its
    // row is another one then, and the box would be made again there, with what was typed selected
    await dblclickByte(view, 0x8c0100a4);
    await byteEditor(view).fill("BB");
    await page.mouse.wheel(0, 60);
    await expect(first).toHaveText(hex8(0x8c010000 + 96));
    await expect(rowAt(view, 0x8c0100a0)).toBeVisible();
    await page.waitForTimeout(300);
    await expect(byteEditor(view)).toHaveCount(0);
    await page.keyboard.type("CC");
    await page.keyboard.press("Escape");

    expect(rpc.requests("state.writeMemory")).toEqual([]);
    await expect(rowAt(view, 0x8c0100a0).locator("span").nth(1)).toHaveText(/^([0-9A-F]{2} ){15}[0-9A-F]{2}$/);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("no editor opens while the bytes of a move are being read: the rows on screen are about to be other addresses", async ({ page }) => {
    // the bytes of every read are held back until the test lets them through
    const held = await holdResponses(page, "state.getMemorySlice");
    const releasing = setInterval(() => held.release(), 50);
    await openWorkspace(page, "sh4-debugger");
    await pauseFromToolbar(page);
    const view = panel(page, "sh4-memory");
    const first = memoryRows(view).first().locator("span").first();
    await expect(memoryRows(view)).toHaveCount(60);
    await settledCount(() => held.requests("state.getMemorySlice").length);
    clearInterval(releasing);
    held.release();
    expect(held.held()).toBe(0);
    const before = held.requests("state.getMemorySlice").length;

    // a notch of the wheel moves the view by six rows: its bytes are being read, and the rows on
    // screen are still those of the old place
    await memoryRows(view).nth(5).hover();
    await page.mouse.wheel(0, 60);
    await expect.poll(() => held.requests("state.getMemorySlice").length).toBe(before + 1);
    expect(held.requests("state.getMemorySlice").at(-1)?.params).toEqual({ target: "sh4", address: 0x8c010060, length: 960 });
    await expect.poll(held.held).toBe(1);
    await expect(first).toHaveText(hex8(0x8c010000));
    // a double click on a byte of them opens nothing, and neither do the keys at the place of the keyboard
    await dblclickByte(view, 0x8c010084);
    await expect(byteEditor(view)).toHaveCount(0);
    await expect(hexCell(view, 0x8c010080)).toBeFocused();
    for (const key of ["Enter", "F2", "Space"]) {
      await page.keyboard.press(key);
    }
    await page.waitForTimeout(300);
    await expect(byteEditor(view)).toHaveCount(0);
    await expect(first).toHaveText(hex8(0x8c010000));

    // the bytes of the new place are in: there is no editor in their rows either
    held.release();
    await expect(first).toHaveText(hex8(0x8c010060));
    await page.waitForTimeout(300);
    await expect(byteEditor(view)).toHaveCount(0);
    expect(held.requests("state.writeMemory")).toEqual([]);

    // the byte is edited in its row of the new place, where the view now is
    await dblclickByte(view, 0x8c010084);
    await expect(byteEditor(view)).toHaveAccessibleName("Bytes to write from 0x8C010084");
    const row = (await rowAt(view, 0x8c010080).boundingBox())!;
    const box = (await byteEditor(view).boundingBox())!;
    expect(box.y + box.height / 2).toBeGreaterThan(row.y);
    expect(box.y + box.height / 2).toBeLessThan(row.y + row.height);
    await page.keyboard.type("AB");
    await page.keyboard.press("Enter");
    await expect.poll(() => held.requests("state.writeMemory").length).toBe(1);
    expect(held.requests("state.writeMemory")[0].params).toEqual({ target: "sh4", address: 0x8c010084, data: [0xab] });
    // (the bytes read again for the write)
    await expect.poll(held.held).toBe(1);
    held.release();
    await expect(byteEditor(view)).toHaveCount(0);
    await expect(rowAt(view, 0x8c010080).locator("span").nth(1)).toHaveText(/^([0-9A-F]{2} ){4}AB /);
  });

  test("the wheel over the memory view takes the focus out of no other box: an address typed elsewhere is not written to memory", async ({ page, rpc }) => {
    await openWorkspace(page, "sh4-debugger");
    await pauseFromToolbar(page);
    const view = panel(page, "sh4-memory");
    const listing = panel(page, "sh4-disassembly");
    const first = memoryRows(view).first().locator("span").first();
    await expect(memoryRows(view)).toHaveCount(60);

    await dblclickByte(view, 0x8c010004);
    await byteEditor(view).fill("AA");
    await memoryRows(view).nth(5).hover();
    await page.mouse.wheel(0, 60);
    await expect(first).toHaveText(hex8(0x8c010000 + 96));

    // an address is being typed into the box of the disassembly, without "0x": a run of bytes, if it were one
    const box = listing.getByRole("textbox");
    await box.click();
    await box.fill("8C02");
    // the memory view is moved back to the row that was edited
    await memoryRows(view).nth(5).hover();
    await page.mouse.wheel(0, -60);
    await expect(first).toHaveText(hex8(0x8c010000));
    await page.waitForTimeout(300);
    await expect(box).toBeFocused();
    await expect(byteEditor(view)).toHaveCount(0);
    await page.keyboard.type("0000");
    await page.keyboard.press("Enter");
    // the listing went there, and no memory was written
    await expect(disassemblyRows(listing).first()).toHaveAttribute("data-address", String(0x8c020000 - 10 * 2));
    expect(rpc.requests("state.writeMemory")).toEqual([]);
    await expect(rowAt(view, 0x8c010000).locator("span").nth(1)).toHaveText("86 4F 83 7E AE 81 E8 01 1D 47 B9 98 3A 3F 92 11");
  });

  test("rows that give way to an error take an open editor with them: it is not back, with the focus, when the bytes are read again", async ({ page }) => {
    const server = await serveScriptedDebugger(page);
    server.shape.capabilities = ["event-breakpoints", "callstack", "memory-write"];
    let failing = false;
    let elsewhere = 0;
    server.answer("state.getMemorySlice", (params) =>
      failing ? jsonRpcError(-32000, "emulator busy") : defaultAnswer("state.getMemorySlice", { ...params, address: Number(params.address) + elsewhere }),
    );
    await gotoRoute(page, "/workspace/sh4-debugger");
    await server.described();
    const view = panel(page, "sh4-memory");
    await expect(memoryRows(view)).toHaveCount(60);

    await dblclickByte(view, 0x8c010004);
    await byteEditor(view).fill("AA");
    await expect(byteEditor(view)).toBeFocused();
    // another client steps the target: a new stop, for which the bytes are read again, and the read fails
    failing = true;
    server.state.execution = { state: "paused", stopId: 2, reason: "pause" };
    server.tick();
    await expect(view.getByText("emulator busy")).toBeVisible();
    await expect(memoryRows(view)).toHaveCount(0);
    await expect(byteEditor(view)).toHaveCount(0);
    // the next stop reads them: the rows are back, and the editor is not
    failing = false;
    server.state.execution = { state: "paused", stopId: 3, reason: "pause" };
    server.tick();
    await expect(memoryRows(view)).toHaveCount(60);
    await page.waitForTimeout(300);
    await expect(byteEditor(view)).toHaveCount(0);
    await expect(view.getByRole("textbox")).toHaveCount(1);
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("INPUT");

    // The same for rows that are other addresses than the view asked for (a server that answers
    // with another base): the byte of the editor is in none of them.
    await dblclickByte(view, 0x8c010004);
    await byteEditor(view).fill("BB");
    elsewhere = 0x400;
    server.state.execution = { state: "paused", stopId: 4, reason: "pause" };
    server.tick();
    await expect(memoryRows(view).first().locator("span").first()).toHaveText(hex8(0x8c010400));
    await expect(byteEditor(view)).toHaveCount(0);
    elsewhere = 0;
    server.state.execution = { state: "paused", stopId: 5, reason: "pause" };
    server.tick();
    await expect(memoryRows(view).first().locator("span").first()).toHaveText(hex8(0x8c010000));
    await page.waitForTimeout(300);
    await expect(byteEditor(view)).toHaveCount(0);
    expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("INPUT");

    // And for rows of another place that hold the byte of the editor (a server that answers a
    // row earlier): they are not the rows of the view, and the editor does not follow its byte
    // into another row of them.
    await dblclickByte(view, 0x8c010004);
    await byteEditor(view).fill("CC");
    elsewhere = -0x10;
    server.state.execution = { state: "paused", stopId: 6, reason: "pause" };
    server.tick();
    await expect(memoryRows(view).first().locator("span").first()).toHaveText(hex8(0x8c00fff0));
    await expect(rowAt(view, 0x8c010000)).toBeVisible();
    await page.waitForTimeout(300);
    await expect(byteEditor(view)).toHaveCount(0);
    // nor does one open in them
    await dblclickByte(view, 0x8c010004);
    await expect(byteEditor(view)).toHaveCount(0);
    expect(server.requestsOf("state.writeMemory")).toEqual([]);
  });

  test("another client resumes the target while the focus is in the editor of a byte: the editor goes, and the next stop does not bring it back", async ({
    page,
  }) => {
    // The toolbar's Run would take the focus out of the box, and leaving the box puts an editor
    // away by itself. Here nothing is clicked: the ticks say that the target runs, and stops again.
    const server = await serveScriptedDebugger(page);
    server.shape.capabilities = ["event-breakpoints", "callstack", "memory-write"];
    await gotoRoute(page, "/workspace/sh4-debugger");
    await server.described();
    const view = panel(page, "sh4-memory");
    const status = page.getByRole("status", { name: "Execution state" });
    await expect(memoryRows(view)).toHaveCount(60);

    await dblclickByte(view, 0x8c010006);
    await byteEditor(view).fill("5A");
    await expect(byteEditor(view)).toBeFocused();

    server.state.execution = { state: "running", stopId: 1 };
    server.tick();
    await expect(status).toContainText("Running");
    // no box while the target runs; the byte has the focus the box had, and cannot be written
    await expect(byteEditor(view)).toHaveCount(0);
    await expect(place(view)).toBeFocused();
    await expect(place(view)).toHaveAccessibleName("0x8C010006 06, write");
    await expect(place(view)).toHaveAttribute("aria-disabled", "true");
    for (const key of ["Enter", "F2", "Space"]) {
      await page.keyboard.press(key);
    }
    await expect(byteEditor(view)).toHaveCount(0);
    // the arrows move the place all the same: that reads, and writes nothing
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    await expect(hexCell(view, 0x8c010010)).toBeFocused();
    await expect(place(view)).toHaveAccessibleName("0x8C010017 17, write");

    // a new stop: the box is not back, and what was typed is gone with it
    server.state.execution = { state: "paused", stopId: 2, reason: "pause" };
    server.tick();
    await expect(status).toContainText("stop 2");
    await expect.poll(() => server.requestsOf("state.getMemorySlice").length).toBe(2);
    await page.waitForTimeout(300);
    await expect(byteEditor(view)).toHaveCount(0);
    // the byte can be written again, where the focus still is
    await expect(place(view)).toBeFocused();
    await expect(place(view)).not.toHaveAttribute("aria-disabled");
    await page.keyboard.press("Enter");
    await expect(byteEditor(view)).toHaveAccessibleName("Bytes to write from 0x8C010017");
    await expect(byteEditor(view)).toHaveValue("17");
    await byteEditor(view).press("Escape");
    expect(server.requestsOf("state.writeMemory")).toEqual([]);
  });

  test("the listing is cut at the edge of its panel and is not scrolled: an editor in the row that is cut there leaves the rows where they are", async ({
    page,
    rpc,
  }) => {
    await openWorkspace(page, "sh4-debugger");
    await pauseFromToolbar(page);
    const view = panel(page, "sh4-memory");
    await expect(memoryRows(view)).toHaveCount(60);

    // The row the edge of the panel cuts: its upper part is on screen, the rest is not. (The
    // window is given a height at which about half of that row is, whatever the layout is.)
    type CutRow = { address: number; x: number; y: number };
    let cut: CutRow | undefined;
    for (let height = 1000; height <= 1040 && !cut; height += 4) {
      await page.setViewportSize({ width: 1600, height });
      await page.waitForTimeout(150);
      cut = await view.evaluate((root): CutRow | undefined => {
        const cells = Array.from(root.querySelectorAll<HTMLElement>("[data-memory-hex]"));
        let listing = cells[0].parentElement;
        while (listing && getComputedStyle(listing).overflowY === "visible") {
          listing = listing.parentElement;
        }
        const edge = listing!.getBoundingClientRect().bottom;
        for (const cell of cells) {
          const box = cell.getBoundingClientRect();
          const shown = edge - box.top;
          if (box.top < edge && box.bottom > edge && shown >= 7 && shown <= box.height - 4) {
            // the fourth byte of the row, in the part of it that is on screen
            return { address: Number(cell.dataset.memoryHex) + 3, x: box.left + (3 * 3 + 1.5) * (box.width / 47), y: box.top + shown / 2 };
          }
        }
        return undefined;
      });
    }
    expect(cut, "a row that the edge of the panel cuts").toBeDefined();
    const top = await headerTop(view);
    expect(await scrolledDown(view)).toBe(0);

    // The box of the editor takes the focus, and reaches below the edge. A browser brings what
    // has the focus on screen by scrolling whatever can be scrolled; the listing cannot be.
    await page.mouse.dblclick(cut!.x, cut!.y);
    await expect(byteEditor(view)).toBeFocused();
    await expect(byteEditor(view)).toHaveAccessibleName(`Bytes to write from ${hex8(cut!.address)}`);
    await page.keyboard.type("5A");
    expect(await scrolledDown(view)).toBe(0);
    expect(await headerTop(view)).toBe(top);
    await expect(memoryRows(view).first().locator("span").first()).toBeInViewport({ ratio: 1 });
    await page.keyboard.press("Enter");
    await expect(byteEditor(view)).toHaveCount(0);
    expect(rpc.requests("state.writeMemory").map((frame) => frame.params)).toEqual([{ target: "sh4", address: cut!.address, data: [0x5a] }]);
    // the focus is on the byte again, and that scrolls nothing either
    await expect(place(view)).toBeFocused();
    expect(await scrolledDown(view)).toBe(0);
    expect(await headerTop(view)).toBe(top);

    // nor does what a search in the page does for a row far below the edge: it is brought on screen by nothing
    await memoryRows(view).last().evaluate((row) => row.scrollIntoView());
    await hexCell(view, 0x8c010000 + 59 * 16).evaluate((cell) => cell.scrollIntoView({ block: "center" }));
    expect(await scrolledDown(view)).toBe(0);
    expect(await headerTop(view)).toBe(top);
    await expect(memoryRows(view).first().locator("span").first()).toBeInViewport({ ratio: 1 });
    await expect(memoryRows(view).last()).not.toBeInViewport();
  });
});

test.describe("byte editing with the keyboard", () => {
  test("the hex column of one row is the stop of the Tab key; the arrows move the place, Enter, the space bar and F2 open the editor at its byte, and the place has the focus again when the editor goes", async ({
    page,
    rpc,
  }) => {
    await openWorkspace(page, "sh4-debugger");
    await pauseFromToolbar(page);
    const view = panel(page, "sh4-memory");
    await expect(memoryRows(view)).toHaveCount(60);
    await expect(hexCell(view, 0x8c010000)).toHaveText("86 4F 83 7E AE 81 E8 01 1D 47 B9 98 3A 3F 92 11");
    const mark = view.locator(".memory-cursor");
    const editor = byteEditor(view);

    // one stop in the whole listing, behind Refresh: the first byte of the first row
    await expect(place(view)).toHaveCount(1);
    await expect(view.locator("[data-memory-hex][tabindex]")).toHaveCount(1);
    await expect(mark).toBeHidden();
    await view.getByRole("button", { name: "Refresh", exact: true }).focus();
    await page.keyboard.press("Tab");
    await expect(hexCell(view, 0x8c010000)).toBeFocused();
    await expect(place(view)).toBeFocused();
    await expect(place(view)).toHaveAccessibleName("0x8C010000 86, write");
    await expect(place(view)).not.toHaveAttribute("aria-disabled");
    // the byte is framed, where its digits are
    const frameOf = async (address: number) => {
      const cell = (await hexCell(view, address - (address % 16)).boundingBox())!;
      const frame = (await mark.boundingBox())!;
      const character = cell.width / 47;
      return { left: frame.x - (cell.x + (address % 16) * 3 * character), width: frame.width - 2 * character };
    };
    await expect(mark).toBeVisible();
    expect(Math.abs((await frameOf(0x8c010000)).left + 2)).toBeLessThan(1);
    expect(Math.abs((await frameOf(0x8c010000)).width - 4)).toBeLessThan(1);

    // the arrows: along the row, and from row to row
    await page.keyboard.press("ArrowRight");
    await expect(place(view)).toHaveAccessibleName("0x8C010001 4F, write");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowLeft");
    await expect(place(view)).toHaveAccessibleName("0x8C010002 83, write");
    expect(Math.abs((await frameOf(0x8c010002)).left + 2)).toBeLessThan(1);
    await page.keyboard.press("ArrowDown");
    await expect(hexCell(view, 0x8c010010)).toBeFocused();
    await expect(place(view)).toHaveAccessibleName(/^0x8C010012 [0-9A-F]{2}, write$/);
    await expect(place(view)).toHaveCount(1);
    await expect(view.locator("[data-memory-hex][tabindex]")).toHaveCount(1);
    expect(Math.abs((await frameOf(0x8c010012)).left + 2)).toBeLessThan(1);
    await page.keyboard.press("ArrowUp");
    await expect(hexCell(view, 0x8c010000)).toBeFocused();
    // a row has sixteen bytes: the place stops at its ends
    for (let press = 0; press < 20; press++) {
      await page.keyboard.press("ArrowRight");
    }
    await expect(place(view)).toHaveAccessibleName("0x8C01000F 11, write");
    for (let press = 0; press < 20; press++) {
      await page.keyboard.press("ArrowLeft");
    }
    await expect(place(view)).toHaveAccessibleName("0x8C010000 86, write");
    // with Ctrl an arrow is not the listing's, and no other key is
    await page.keyboard.press("Control+ArrowRight");
    await page.keyboard.press("a");
    await page.keyboard.press("5");
    await expect(place(view)).toHaveAccessibleName("0x8C010000 86, write");
    await expect(editor).toHaveCount(0);

    // Enter: the editor at that byte, as after a double click there
    for (let press = 0; press < 4; press++) {
      await page.keyboard.press("ArrowRight");
    }
    await page.keyboard.press("Enter");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveAccessibleName("Bytes to write from 0x8C010004");
    await expect(editor).toHaveValue("AE");
    await expect(mark).toBeHidden();
    await page.keyboard.type("DE AD");
    await page.keyboard.press("Enter");
    await expect(editor).toHaveCount(0);
    await expect(hexCell(view, 0x8c010000)).toHaveText("86 4F 83 7E DE AD E8 01 1D 47 B9 98 3A 3F 92 11");
    // accepted: the focus is on the byte again, which is the one that was read again
    await expect(place(view)).toBeFocused();
    await expect(place(view)).toHaveAccessibleName("0x8C010004 DE, write");
    await expect(mark).toBeVisible();

    // F2, and Escape: the same
    await page.keyboard.press("F2");
    await expect(editor).toBeFocused();
    await page.keyboard.type("00");
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
    await expect(place(view)).toBeFocused();
    // the space bar, which is no blank in the box
    await page.keyboard.press("Space");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue("DE");
    // Tab leaves the box: the editor is put away, and the focus is not taken back
    await page.keyboard.press("Tab");
    await expect(editor).toHaveCount(0);
    await expect(place(view)).not.toBeFocused();

    // a press on a byte puts the place there, and a double click does: the editor it opens gives the focus back to that byte
    const cell = (await hexCell(view, 0x8c010020).boundingBox())!;
    await page.mouse.click(cell.x + (7 * 3 + 1.5) * (cell.width / 47), cell.y + cell.height / 2);
    await expect(hexCell(view, 0x8c010020)).toBeFocused();
    await expect(place(view)).toHaveAccessibleName(/^0x8C010027 [0-9A-F]{2}, write$/);
    await expect(mark).toBeVisible();
    expect(Math.abs((await frameOf(0x8c010027)).left + 2)).toBeLessThan(1);
    // (with the first button: another one is the browser's)
    await page.mouse.click(cell.x + (2 * 3 + 1.5) * (cell.width / 47), cell.y + cell.height / 2, { button: "right" });
    await page.keyboard.press("Escape");
    await expect(place(view)).toHaveAccessibleName(/^0x8C010027 [0-9A-F]{2}, write$/);
    await dblclickByte(view, 0x8c010039);
    await expect(editor).toHaveAccessibleName("Bytes to write from 0x8C010039");
    await editor.press("Escape");
    await expect(hexCell(view, 0x8c010030)).toBeFocused();
    await expect(place(view)).toHaveAccessibleName(/^0x8C010039 [0-9A-F]{2}, write$/);

    expect(rpc.requests("state.writeMemory").map((frame) => frame.params)).toEqual([{ target: "sh4", address: 0x8c010004, data: [0xde, 0xad] }]);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("the place stays on screen: at the last row that is whole, and at the first, an arrow moves the view by a row under it", async ({ page, rpc }) => {
    await openWorkspace(page, "sh4-debugger");
    await pauseFromToolbar(page);
    const view = panel(page, "sh4-memory");
    const first = memoryRows(view).first().locator("span").first();
    await expect(memoryRows(view)).toHaveCount(60);
    const slices = () => rpc.requests("state.getMemorySlice").map((frame) => frame.params?.address);
    const top = await headerTop(view);
    // the panel has room for some of the sixty rows, and cuts the one behind them
    const whole = await wholeRows(view);
    expect(whole).toBeGreaterThan(3);
    expect(whole).toBeLessThan(50);
    const last = 0x8c010000 + (whole - 1) * 16;
    await expect(hexCell(view, last)).toBeInViewport({ ratio: 1 });
    await expect(hexCell(view, last + 16)).not.toBeInViewport({ ratio: 1 });
    const read = slices().length;

    await place(view).focus();
    for (let row = 1; row < whole; row++) {
      await page.keyboard.press("ArrowDown");
    }
    // down to the last whole row the view stays where it is
    await expect(hexCell(view, last)).toBeFocused();
    await expect(first).toHaveText(hex8(0x8c010000));
    expect(slices()).toHaveLength(read);

    // one more: the row behind it is not gone to; it comes to the place
    await page.keyboard.press("ArrowDown");
    await expect(first).toHaveText(hex8(0x8c010010));
    expect(slices().at(-1)).toBe(0x8c010010);
    await expect(place(view)).toBeFocused();
    await expect(place(view)).toHaveAccessibleName(new RegExp(`^${hex8(last + 16)} [0-9A-F]{2}, write$`));
    await expect(place(view)).toBeInViewport({ ratio: 1 });
    await expect(view.locator(".memory-cursor")).toBeInViewport({ ratio: 1 });
    expect(await scrolledDown(view)).toBe(0);
    expect(await headerTop(view)).toBe(top);

    // and up again: to the first row, and from there the view moves the other way
    for (let row = 1; row < whole; row++) {
      await page.keyboard.press("ArrowUp");
    }
    await expect(hexCell(view, 0x8c010010)).toBeFocused();
    await expect(first).toHaveText(hex8(0x8c010010));
    await page.keyboard.press("ArrowUp");
    await expect(first).toHaveText(hex8(0x8c010000));
    await expect(hexCell(view, 0x8c010000)).toBeFocused();
    await expect(place(view)).toHaveAccessibleName("0x8C010000 86, write");
    expect(slices().slice(read)).toEqual([0x8c010010, 0x8c010000]);
    expect(await headerTop(view)).toBe(top);
  });

  test("a panel that is made smaller takes the place up with its edge, and puts away an editor whose row it no longer shows", async ({ page, rpc }) => {
    await openWorkspace(page, "sh4-debugger");
    await pauseFromToolbar(page);
    const view = panel(page, "sh4-memory");
    const box = view.getByRole("textbox");
    const first = memoryRows(view).first().locator("span").first();
    await expect(memoryRows(view)).toHaveCount(60);
    await panelOfRows(page, view, 40);
    await expect(first).toHaveText(hex8(0x8c010000));

    // the place on the fourth byte of the thirty-first row, and its editor open with a byte typed
    const row30 = 0x8c010000 + 30 * 16;
    const cell = hexCell(view, row30);
    const cellBox = (await cell.boundingBox())!;
    await cell.click({ position: { x: (3 * 3 + 1.5) * (cellBox.width / 47), y: cellBox.height / 2 } });
    await expect(place(view)).toHaveAccessibleName(new RegExp(`^${hex8(row30 + 3)} [0-9A-F]{2}, write$`));
    await expect(place(view)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(byteEditor(view)).toHaveAccessibleName(`Bytes to write from ${hex8(row30 + 3)}`);
    await page.keyboard.type("5A");

    // Ten rows: the row of the editor is far below the edge of the panel. The editor is put
    // away with what was typed, the place is on a row the panel shows, and has the focus (the
    // editor went with the focus in it).
    await panelOfRows(page, view, 10);
    await expect(first).toHaveText(hex8(0x8c010000));
    await expect(byteEditor(view)).toHaveCount(0);
    await expect(place(view)).toBeInViewport();
    await expect(place(view)).toBeFocused();
    const at = Number(await place(view).getAttribute("data-memory-hex"));
    expect(at, "the place is on a row the panel shows").toBeLessThanOrEqual(0x8c010000 + 10 * 16);
    await expect(place(view)).toHaveAccessibleName(new RegExp(`^${hex8(at + 3)} [0-9A-F]{2}, write$`));

    // The place stays there when the panel grows again, with the focus, and the editor is not back.
    await panelOfRows(page, view, 40);
    await expect(place(view)).toHaveAccessibleName(new RegExp(`^${hex8(at + 3)} [0-9A-F]{2}, write$`));
    await expect(place(view)).toBeFocused();
    await expect(byteEditor(view)).toHaveCount(0);
    await panelOfRows(page, view, 10);
    await expect(place(view)).toHaveAccessibleName(new RegExp(`^${hex8(at + 3)} [0-9A-F]{2}, write$`));

    // Tab from the address box comes to the place, on screen
    await box.focus();
    for (let press = 0; press < 6 && !(await place(view).evaluate((element) => element === document.activeElement)); press++) {
      await page.keyboard.press("Tab");
    }
    await expect(place(view)).toBeFocused();
    await expect(place(view)).toBeInViewport();
    // an arrow up moves the place up a row, and not the view
    await page.keyboard.press("ArrowUp");
    await expect(place(view)).toHaveAccessibleName(new RegExp(`^${hex8(at - 16 + 3)} [0-9A-F]{2}, write$`));
    await expect(place(view)).toBeFocused();
    await expect(place(view)).toBeInViewport({ ratio: 1 });
    await expect(first).toHaveText(hex8(0x8c010000));
    // and Enter opens the editor there, on screen
    await page.keyboard.press("Enter");
    await expect(byteEditor(view)).toHaveAccessibleName(`Bytes to write from ${hex8(at - 16 + 3)}`);
    await expect(byteEditor(view)).toBeInViewport();
    await page.keyboard.press("Escape");
    expect(rpc.requests("state.writeMemory")).toEqual([]);
  });

  test("the place is inside the rows there are: fewer rows, and a last row of fewer bytes, take it along", async ({ page }) => {
    // a server that answers with fewer bytes than the view asked for, when told to
    const server = await serveScriptedDebugger(page);
    server.shape.capabilities = ["event-breakpoints", "callstack", "memory-write"];
    let bytes = 960;
    server.answer("state.getMemorySlice", (params) => defaultAnswer("state.getMemorySlice", { ...params, length: Math.min(bytes, Number(params.length)) }));
    await gotoRoute(page, "/workspace/sh4-debugger");
    await server.described();
    const view = panel(page, "sh4-memory");
    await expect(memoryRows(view)).toHaveCount(60);

    // the place: the tenth byte of the sixth row
    await place(view).focus();
    for (let press = 0; press < 5; press++) {
      await page.keyboard.press("ArrowDown");
    }
    for (let press = 0; press < 9; press++) {
      await page.keyboard.press("ArrowRight");
    }
    await expect(place(view)).toHaveAccessibleName("0x8C010059 59, write");

    // the next stop reads two rows and eight bytes of a third
    bytes = 40;
    server.state.execution = { state: "paused", stopId: 2, reason: "pause" };
    server.tick();
    await expect(memoryRows(view)).toHaveCount(3);
    await expect(hexCell(view, 0x8c010020)).toHaveText("20 21 22 23 24 25 26 27");
    // one stop of the Tab key, as before: in the last row there is, on its last byte
    await expect(place(view)).toHaveCount(1);
    await expect(view.locator("[data-memory-hex][tabindex]")).toHaveCount(1);
    await expect(place(view)).toHaveAccessibleName("0x8C010027 27, write");
    // behind the last byte of that row there is none: a double click there edits nothing
    await dblclickByte(view, 0x8c01002c);
    await expect(byteEditor(view)).toHaveCount(0);
    await place(view).focus();
    await page.keyboard.press("ArrowRight");
    await expect(place(view)).toHaveAccessibleName("0x8C010027 27, write");
    // there is no row below it to go to: the view moves by a row under the place, as at the edge of the panel
    await page.keyboard.press("ArrowDown");
    await expect(memoryRows(view).first().locator("span").first()).toHaveText(hex8(0x8c010010));
    await expect(place(view)).toHaveAccessibleName("0x8C010037 37, write");
    // and that byte is the one Enter edits
    await page.keyboard.press("Enter");
    await expect(byteEditor(view)).toHaveAccessibleName("Bytes to write from 0x8C010037");
    await expect(byteEditor(view)).toHaveValue("37");
    await byteEditor(view).press("Escape");
    await expect(place(view)).toBeFocused();
    expect(server.requestsOf("state.writeMemory")).toEqual([]);
  });

  test("in a panel narrower than its rows the listing is scrolled to the side for the place of the keyboard, and never up or down", async ({ page }) => {
    await openWorkspace(page, "sh4-debugger");
    await pauseFromToolbar(page);
    const view = panel(page, "sh4-memory");
    await expect(memoryRows(view)).toHaveCount(60);
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect.poll(async () => (await view.boundingBox())!.width).toBeLessThan(340);
    const mark = view.locator(".memory-cursor");
    const top = await headerTop(view);

    await place(view).focus();
    await sideScroll(view, "start");
    // a place that is on screen moves nothing: the hex column of a row is wider than this panel,
    // and is not brought on screen as a whole when the focus goes from row to row
    await page.keyboard.press("ArrowDown");
    await expect(hexCell(view, 0x8c010010)).toBeFocused();
    expect(await sideScroll(view)).toBe(0);
    await page.keyboard.press("ArrowUp");
    await expect(hexCell(view, 0x8c010000)).toBeFocused();
    expect(await sideScroll(view)).toBe(0);
    for (let press = 0; press < 15; press++) {
      await page.keyboard.press("ArrowRight");
    }
    await expect(place(view)).toHaveAccessibleName("0x8C01000F 11, write");
    // the last byte of a row is outside a panel this narrow, until the listing is scrolled to it
    // (all of its frame is on screen then, but for the fraction of a pixel a scroll position is rounded by)
    await expect(mark).toBeInViewport({ ratio: 0.9 });
    expect(await sideScroll(view)).toBeGreaterThan(0);

    await sideScroll(view, "end");
    for (let press = 0; press < 15; press++) {
      await page.keyboard.press("ArrowLeft");
    }
    await expect(place(view)).toHaveAccessibleName("0x8C010000 86, write");
    await expect(mark).toBeInViewport({ ratio: 0.9 });
    expect(await scrolledDown(view)).toBe(0);
    expect(await headerTop(view)).toBe(top);
  });
});

test.describe("byte editing on a server that can do what the emulator of milestone M2 can", () => {
  test.use({ mockOptions: { supports: MOCK_M2_SUPPORT } });

  test("the memory of both processors is written", async ({ page, rpc }) => {
    await openWorkspace(page, "sh4-debugger");
    await pauseFromToolbar(page);
    const view = panel(page, "sh4-memory");
    await dblclickByte(view, 0x8c010000);
    await byteEditor(view).fill("01 02 03");
    await byteEditor(view).press("Enter");
    await expect(rowAt(view, 0x8c010000).locator("span").nth(1)).toHaveText(/^01 02 03 7E /);

    await gotoRoute(page, "/workspace/arm7-debugger");
    const arm7 = panel(page, "arm7-memory");
    await expect(memoryRows(arm7)).toHaveCount(60);
    await dblclickByte(arm7, 0x00000010);
    await byteEditor(arm7).fill("7f");
    await byteEditor(arm7).press("Enter");
    await expect(rowAt(arm7, 0x10).locator("span").nth(1)).toHaveText(/^7F /);
    expect(rpc.requests("state.writeMemory").map((frame) => frame.params)).toEqual([
      { target: "sh4", address: 0x8c010000, data: [1, 2, 3] },
      { target: "arm7", address: 0x10, data: [0x7f] },
    ]);
    expect(rpc.received.filter((frame) => /-320(13|04)/.test(JSON.stringify(frame)))).toEqual([]);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});

test.describe("a server of milestone M1", () => {
  test.use({ mockOptions: { supports: MOCK_M1_SUPPORT } });

  test("no memory writes: the bytes are no editor, and nothing is sent", async ({ page, rpc }) => {
    await openWorkspace(page, "sh4-debugger");
    await pauseFromToolbar(page);
    const view = panel(page, "sh4-memory");
    await expect(memoryRows(view)).toHaveCount(60);
    await expect(hexCell(view, 0x8c010000)).toHaveAttribute("title", "Read-only: this server cannot write memory");
    // the bytes are text: no stop of the Tab key, and no control
    await expect(place(view)).toHaveCount(0);
    await expect(view.locator("[data-memory-hex][tabindex], [data-memory-hex][role], .memory-cursor")).toHaveCount(0);
    await dblclickByte(view, 0x8c010004);
    await expect(byteEditor(view)).toHaveCount(0);
    await expect(view.getByRole("textbox")).toHaveCount(1);
    // ... also after a press on one of them
    await expect(place(view)).toHaveCount(0);
    await expect(view.locator("[data-memory-hex][tabindex], [data-memory-hex][role], .memory-cursor")).toHaveCount(0);
    expect(rpc.requests("state.writeMemory")).toEqual([]);
    expect(rpc.received.filter((frame) => JSON.stringify(frame).includes("-32004"))).toEqual([]);
  });
});

// The tick a write caused reaches the client in front of its response or behind it. A byte
// edit moves the disassembly in neither order: the lines are read again where the view is.
for (const order of ["the tick in front of the response", "the tick behind the response"] as const) {
  test(`a byte edit with ${order}: the disassembly reads again and does not move`, async ({ page }) => {
    const server = await serveScriptedDebugger(page);
    server.shape.capabilities = ["event-breakpoints", "callstack", "memory-write"];
    const written = new Map<number, number>();
    server.answer("state.getMemorySlice", (params) => ({
      baseAddress: Number(params.address),
      data: Array.from({ length: Number(params.length) }, (_, index) => written.get(Number(params.address) + index) ?? (Number(params.address) + index) & 0xff),
      validity: "ok",
    }));
    server.answer("state.writeMemory", (params: Json) => {
      (params.data as number[]).forEach((byte, index) => written.set(Number(params.address) + index, byte));
      if (order === "the tick in front of the response") {
        // a paused tick of the same stop, with the registers as they were
        server.tick();
        return new Promise((resolve) => setTimeout(() => resolve({}), 400));
      }
      setTimeout(() => server.tick(), 400);
      return {};
    });
    await gotoRoute(page, "/workspace/sh4-debugger");
    await server.described();
    const listing = panel(page, "sh4-disassembly");
    const view = panel(page, "sh4-memory");
    expect(await currentInstructionAddress(listing)).toBe(0x8c001000);

    // the listing is somewhere else than the program counter: a view that followed it would be seen to move
    await listing.getByRole("textbox").fill("0x8C005000");
    await listing.getByRole("textbox").press("Enter");
    const away = String(0x8c005000 - 10 * 2);
    await expect(disassemblyRows(listing).first()).toHaveAttribute("data-address", away);
    await expect(listing.locator(".current-instruction")).toHaveCount(0);
    const listings = () => server.requestsOf("state.getDisassembly").length;
    const settled = listings();

    await expect(memoryRows(view)).toHaveCount(60);
    await dblclickByte(view, 0x8c010003);
    await byteEditor(view).fill("AB CD");
    await byteEditor(view).press("Enter");
    await expect(byteEditor(view)).toHaveCount(0);
    await expect(rowAt(view, 0x8c010000).locator("span").nth(1)).toHaveText(/^00 01 02 AB CD 05 /);
    expect(server.requestsOf("state.writeMemory")).toEqual([{ target: "sh4", address: 0x8c010003, data: [0xab, 0xcd] }]);

    // read again once, in place; and still there when the tick and the response are both in
    await expect.poll(listings).toBe(settled + 1);
    expect(server.requestsOf("state.getDisassembly").at(-1)).toMatchObject({ target: "sh4", address: Number(away) });
    await page.waitForTimeout(700);
    expect(listings()).toBe(settled + 1);
    await expect(disassemblyRows(listing).first()).toHaveAttribute("data-address", away);
    await expect(listing.getByRole("textbox")).toHaveValue("0x8C005000");
    await expect(memoryRows(view).first().locator("span").first()).toHaveText("0x8C010000");
  });
}
