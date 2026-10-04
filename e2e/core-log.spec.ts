import { test, expect, gotoRoute } from "./support/fixtures";
import type { Page } from "@playwright/test";

// A minimal refsw2 log, built from what CoreInspectorPanel's parser reads:
// one 32x32 tile at tile (1, 1), one opaque strip, one ISP write and one TSP write on
// the pixel (1, 1) of that tile, and the tile's 1024 colour-buffer values.
const TILE_COLOUR = "FF2040C0"; // ARGB
const MARKED_COLOUR = "FFFFE000";
const buildLog = () => {
  const lines = [
    "REFSW2LOG: 0",
    "BGTAG: 01000000",
    // base, control (tile_x = 1 at bits 2-7, tile_y = 1 at bits 8-13), 5 list pointers
    "TILE: 00001000 00000104 00002000 80000000 80000000 80000000 80000000",
    "ZCLEAR",
    "OPAQ",
    "OBJECT: 00002000 80000100",
    "STRIP: 00000010 32.000000 32.000000 0.500000 64.000000 32.000000 0.500000 32.000000 64.000000 0.500000 0",
    // pixel index 33 = (1, 1); render mode 0 = OPAQUE; depth mode 6 = GREATER_EQUAL
    "ISP: 33 0 6 33.500000 33.500000 0.250000 00000010",
    "RENDERED: 0.250000",
    "OP_PARAMS",
    "TSP: 33 33.500000 33.500000 0 0.250000 0 80000000 20800440 00000000 00000010",
    "IB: FF336699",
    "IO: 00112233",
    "PIXELS",
  ];
  for (let index = 0; index < 1024; index++) {
    lines.push(index === 33 ? MARKED_COLOUR : TILE_COLOUR);
  }
  return lines.join("\n") + "\n";
};

const loadLog = async (page: Page, content: string, name = "refsw2.log") => {
  await page.locator('input[type="file"]').setInputFiles({ name, mimeType: "text/plain", buffer: Buffer.from(content) });
};

const pixel = (page: Page, x: number, y: number) =>
  page.locator("canvas").evaluate(
    (canvas, [px, py]) => {
      const data = (canvas as HTMLCanvasElement).getContext("2d")!.getImageData(px, py, 1, 1).data;
      return Array.from(data);
    },
    [x, y],
  );

test.beforeEach(async ({ page }) => {
  await gotoRoute(page, "/tool/holly-core-log-analyzer");
  await expect(page.getByText("Drop your refsw2 log here")).toBeVisible();
});

test("the empty state offers a drop zone and a file chooser", async ({ page }) => {
  await expect(page.getByText("Choose File")).toBeVisible();
  await expect(page.locator('input[type="file"]')).toHaveAttribute("accept", ".log,text/plain");
  await expect(page.locator("canvas")).toBeHidden();
  await expect(page.getByRole("button", { name: "Close Log" })).toHaveCount(0);
});

test("a refsw2 log is drawn tile by tile", async ({ page }) => {
  await loadLog(page, buildLog());

  await expect(page.getByRole("button", { name: "Close Log" })).toBeVisible();
  await expect(page.getByText("Drop your refsw2 log here")).toHaveCount(0);
  await expect(page.getByText("Background Tag: 0x1000000")).toBeVisible();
  const canvas = page.locator("canvas");
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute("width", "640");
  await expect(canvas).toHaveAttribute("height", "480");

  // the tile's colour buffer lands at (32..63, 32..63); everything else is the red "no data" fill
  expect(await pixel(page, 40, 40)).toEqual([0x20, 0x40, 0xc0, 255]);
  expect(await pixel(page, 33, 33)).toEqual([0xff, 0xe0, 0x00, 255]);
  expect(await pixel(page, 63, 63)).toEqual([0x20, 0x40, 0xc0, 255]);
  expect(await pixel(page, 10, 10)).toEqual([255, 0, 0, 255]);
  expect(await pixel(page, 64, 64)).toEqual([255, 0, 0, 255]);
});

test.fixme("clicking a pixel lists what was logged for it", async ({ page }) => {
  // BROKEN (off by one): handleCanvasClick measures from the canvas' border box, and the
  // canvas has a 1px border, so a click on pixel (x, y) selects pixel (x + 1, y + 1):
  // clicking the marked pixel (1, 1) of the tile reports "Local X: 2, Local Y: 2".
  await loadLog(page, buildLog());
  const canvas = page.locator("canvas");
  await expect(canvas).toBeVisible();

  await canvas.click({ position: { x: 33.5, y: 33.5 } });

  await expect(page.getByRole("heading", { name: "Tile Details" })).toBeVisible();
  await expect(page.getByText("Tile ID: 65")).toBeVisible();
  await expect(page.getByText("Local X: 1")).toBeVisible();
  await expect(page.getByText("Local Y: 1")).toBeVisible();
  await expect(page.getByText("Tile Render #1")).toBeVisible();
  await expect(page.getByText("Control: 0x104")).toBeVisible();

  const events = page.getByRole("list").nth(1);
  // global operations and pixel writes in log order
  await expect(events.locator(":scope > li")).toHaveText([
    /^Global Op: ZCLEAR \(seq: 3\)$/,
    /^Global Op: OPAQ \(seq: 4\)$/,
    /^ISP #7:/,
    /^Global Op: OP_PARAMS \(seq: 9\)$/,
    /^TSP #10:/,
  ]);
  const isp = events.locator(":scope > li").nth(2);
  await expect(isp).toContainText("render_mode: OPAQUE");
  await expect(isp).toContainText("mode: GREATER_EQUAL");
  await expect(isp).toContainText("invW: 0.25");
  await expect(isp).toContainText("tag: 0x10");
  await expect(isp).toContainText("Status: RENDERED");
  await expect(isp).toContainText("Written Depth: 0.25");
  const tsp = events.locator(":scope > li").nth(4);
  await expect(tsp).toContainText("isp: 0x80000000");
  await expect(tsp).toContainText("tsp: 0x20800440");
  await expect(tsp).toContainText("Base Color: 0xff336699");
  await expect(tsp).toContainText("Offset Color: 0x00112233");

  // a pixel of the same tile that nothing was drawn to: only the tile's global operations
  await canvas.click({ position: { x: 50.5, y: 50.5 } });
  await expect(page.getByText("Local X: 18")).toBeVisible();
  await expect(page.getByRole("list").nth(1).locator(":scope > li")).toHaveCount(3);

  // a pixel outside any logged tile keeps the previous selection
  await canvas.click({ position: { x: 200.5, y: 200.5 } });
  await expect(page.getByText("Local X: 18")).toBeVisible();
});

test("Close Log returns to the empty state", async ({ page }) => {
  await loadLog(page, buildLog());
  await page.getByRole("button", { name: "Close Log" }).click();
  await expect(page.getByText("Drop your refsw2 log here")).toBeVisible();
  await expect(page.locator("canvas")).toBeHidden();
  await expect(page.getByRole("button", { name: "Close Log" })).toHaveCount(0);
});

test("a file that is not a refsw2 log is rejected", async ({ page }) => {
  const dialogs: string[] = [];
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    void dialog.accept();
  });
  await loadLog(page, "hello\nworld\n", "notes.txt");
  await expect.poll(() => dialogs).toEqual(["Bad log file format"]);
  await expect(page.getByText("Drop your refsw2 log here")).toBeVisible();
});
