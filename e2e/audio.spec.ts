import { test, expect, canvasStats, openWorkspace, panel, tooltipButton, KNOWN } from "./support/fixtures";
import type { Locator } from "@playwright/test";

const RECORD = "Run the emulator and record 1024 frames";
// 8 MiB of capture are generated, sent and scanned; be generous on a busy machine
const SLOW = { timeout: 60_000 };

const record = async (view: Locator) => {
  await tooltipButton(view, RECORD).click();
  await expect(view.getByRole("button", { name: "Active (8)" })).toBeVisible(SLOW);
};

test.beforeEach(async ({ page, diagnostics }) => {
  diagnostics.allow(...KNOWN.sgcNoData);
  await openWorkspace(page, "audio-debugger");
});

test("before the first recording the SGC panel asks for one", async ({ page, rpc }) => {
  const view = panel(page, "sgc");
  await expect(view.getByText("Record some data to display here")).toBeVisible();
  await expect(view.getByRole("button", { name: "All (64)" })).toBeVisible();
  await expect(view.getByRole("button", { name: "Active (0)" })).toHaveAttribute("aria-pressed", "true");
  await expect(view.locator("canvas")).toHaveCount(0);
  // the panel asked the server once and got the in-band "nothing recorded" error
  expect(rpc.requests("state.getSgcFrameData")).toHaveLength(1);
});

test("Record captures 1024 frames, pauses the target and draws a waveform for every active channel", async ({
  page,
  rpc,
}) => {
  const view = panel(page, "sgc");
  await record(view);

  expect(rpc.requests("state.recordSgcFrames")).toHaveLength(1);
  expect(rpc.requests("state.getSgcFrameData")).toHaveLength(2);
  const response = rpc.received.find((frame) => frame.id === rpc.requests("state.getSgcFrameData")[1].id);
  expect(response?.result).toEqual({ frameCount: 1024, channelsPerFrame: 64, bytesPerChannel: 128, totalBytes: 8388608 });

  // the mock pauses after a recording and the toolbar follows
  await expect(tooltipButton(page, "Run")).toBeEnabled();

  // one channel view per active channel, each with a header and a drawn canvas
  const canvases = view.locator("canvas");
  await expect(canvases).toHaveCount(8);
  await expect(view.getByText(/^HEAD:/)).toHaveCount(8);
  await expect(view.getByText(/^ENV:/)).toHaveCount(8);

  for (let index = 0; index < 8; index++) {
    await canvases.nth(index).scrollIntoViewIfNeeded();
    // waveform bars, two envelope curves and the playback cursor. A blank canvas has 0
    // non-background pixels, a silent channel (flat lines only) about 500.
    await expect
      .poll(async () => (await canvasStats(canvases.nth(index))).nonBackground, { message: `canvas ${index} has no waveform` })
      .toBeGreaterThan(1000);
    const stats = await canvasStats(canvases.nth(index));
    expect(stats.width).toBeGreaterThan(100);
    expect(stats.height).toBeGreaterThan(50);
    expect(stats.colours).toBeGreaterThan(10);
  }
});

test("All (64) also lists the silent channels, whose waveform is flat", async ({ page }) => {
  const view = panel(page, "sgc");
  await record(view);
  const canvases = view.locator("canvas");
  await expect(canvases).toHaveCount(8);
  const active = await canvasStats(canvases.first());

  await view.getByRole("button", { name: "All (64)" }).click();
  await expect(canvases).toHaveCount(64);
  await expect(view.getByRole("button", { name: "All (64)" })).toHaveAttribute("aria-pressed", "true");

  // find a silent channel: envelope 000, drawn as flat lines only
  const all = await Promise.all(Array.from({ length: 8 }, (_, index) => canvasStats(canvases.nth(index))));
  const quietest = Math.min(...all.map((stats) => stats.nonBackground));
  expect(quietest).toBeGreaterThan(0); // not blank: flat envelope lines and the cursor
  expect(quietest).toBeLessThan(active.nonBackground / 2);

  await view.getByRole("button", { name: "Active (8)" }).click();
  await expect(canvases).toHaveCount(8);
});

test("the view-mode buttons redraw a channel and fullscreen shows it alone", async ({ page }) => {
  const view = panel(page, "sgc");
  await record(view);
  const canvases = view.locator("canvas");
  await expect(canvases).toHaveCount(8);
  const canvas = canvases.first();
  await expect.poll(async () => (await canvasStats(canvas)).nonBackground).toBeGreaterThan(1000);
  const preVolPan = await canvasStats(canvas);

  // Post-VolPan: three stacked waveforms (left, right, DSP send)
  await tooltipButton(view, "Post-VolPan (L/R/DSP)").first().click();
  await expect.poll(async () => (await canvasStats(canvas)).hash).not.toBe(preVolPan.hash);
  const postVolPan = await canvasStats(canvas);
  expect(postVolPan.nonBackground).toBeGreaterThan(1000);

  // Input: the unprocessed samples
  await tooltipButton(view, "Input Waveform").first().click();
  await expect.poll(async () => (await canvasStats(canvas)).hash).not.toBe(postVolPan.hash);
  expect((await canvasStats(canvas)).hash).not.toBe(preVolPan.hash);

  await tooltipButton(view, "Pre-VolPan").first().click();
  await expect.poll(async () => (await canvasStats(canvas)).hash).toBe(preVolPan.hash);

  await tooltipButton(view, "Fullscreen").first().click();
  await expect(canvases).toHaveCount(1);
  await expect.poll(async () => (await canvasStats(canvases.first())).height).toBeGreaterThan(preVolPan.height * 2);
  await tooltipButton(view, "Exit Fullscreen").click();
  await expect(canvases).toHaveCount(8);
});

test("hovering and clicking a waveform moves the cursor and the header follows the frame under it", async ({ page }) => {
  const view = panel(page, "sgc");
  await record(view);
  const canvas = view.locator("canvas").first();
  await expect.poll(async () => (await canvasStats(canvas)).nonBackground).toBeGreaterThan(1000);
  const head = view.getByText(/^HEAD:/).first();
  // the mock stores the frame number in the channel's play position
  await expect(head).toHaveText(/HEAD:\s+0:/);

  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(head).toHaveText(/HEAD:\s+51[0-9]:/);

  await page.mouse.click(box.x + box.width / 4, box.y + box.height / 2);
  await page.mouse.move(box.x + box.width / 2, box.y - 40);
  // hover is gone: the header shows the frame of the clicked (playback) position
  await expect(head).toHaveText(/HEAD:\s+25[0-9]:/);
});

test("a second recording replaces the first", async ({ page, rpc }) => {
  const view = panel(page, "sgc");
  await record(view);
  const firstHeaders = await view.getByText(/^\d{2}$/).allInnerTexts();
  expect(firstHeaders).toHaveLength(8);

  await tooltipButton(view, RECORD).click();
  await expect.poll(() => rpc.requests("state.recordSgcFrames").length).toBe(2);
  // the mock picks another 8 active channels for every recording
  await expect
    .poll(async () => (await view.getByText(/^\d{2}$/).allInnerTexts()).join(","), SLOW)
    .not.toBe(firstHeaders.join(","));
  await expect(view.locator("canvas")).toHaveCount(8);
});
