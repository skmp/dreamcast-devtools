import { test, expect, gotoRoute, openWorkspace, panel, statusBar, tooltipButton } from "./support/fixtures";
import type { Locator } from "@playwright/test";

const hex8 = (address: number) => `0x${address.toString(16).toUpperCase().padStart(8, "0")}`;

/** Memory rows: every row starts with its address cell. */
const memoryRows = (view: Locator): Locator =>
  view.locator("div").filter({ has: view.page().locator(":scope > span:nth-child(3)") }).filter({ hasText: /^0x[0-9A-F]{8}/ });

const rowAt = (view: Locator, address: number): Locator => memoryRows(view).filter({ hasText: hex8(address) });

for (const { name, workspace, id, base, firstRow } of [
  {
    name: "SH4",
    workspace: "sh4-debugger",
    id: "sh4-memory",
    base: 0x8c010000,
    // sha256-derived, i.e. stable content of the mock for this address
    firstRow: "45 BC 32 04 1F 4A 11 66 89 E9 C0 58 4D 3C 9B 6B",
  },
  { name: "ARM7", workspace: "arm7-debugger", id: "arm7-memory", base: 0x00200000, firstRow: undefined },
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
      await expect(cells.nth(0)).toHaveText(hex8(base));
      await expect(cells.nth(1)).toHaveText(/^([0-9A-F]{2} ){15}[0-9A-F]{2}$/);
      if (firstRow) {
        await expect(cells.nth(1)).toHaveText(firstRow);
      }
      expect((await cells.nth(2).innerText()).length).toBe(16);
      await expect(rows.nth(59).locator("span").first()).toHaveText(hex8(base + 59 * 16));

      expect(rpc.requests("state.getMemorySlice")[0].params).toEqual({
        target: name.toLowerCase(),
        address: base,
        length: 960,
      });
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
      await expect(first).toHaveText(hex8(base));

      await memoryRows(view).nth(5).hover();
      await page.mouse.wheel(0, 60);
      await expect(first).toHaveText(hex8(base + 96));
      await page.mouse.wheel(0, 120);
      await expect(first).toHaveText(hex8(base + 3 * 96));
      await page.mouse.wheel(0, -180);
      await expect(first).toHaveText(hex8(base));

      const before = rpc.requests("state.getMemorySlice").length;
      await tooltipButton(view, "Refresh").click();
      await expect.poll(() => rpc.requests("state.getMemorySlice").length).toBe(before + 1);
      expect(rpc.requests("state.getMemorySlice").at(-1)?.params).toMatchObject({ address: base, length: 960 });
      await expect(first).toHaveText(hex8(base));
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
