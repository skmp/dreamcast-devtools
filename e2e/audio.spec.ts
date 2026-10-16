import { test, expect, canvasStats, openWorkspace, panel, tooltipButton, KNOWN } from "./support/fixtures";
import type { Locator } from "@playwright/test";

const RECORD = "Run the emulator and record 1024 frames";
// 8 MiB of capture are generated, sent and scanned; be generous on a busy machine
const SLOW = { timeout: 60_000 };

/**
 * An active channel of the mock draws thousands of bar pixels (the quietest of a capture a
 * few hundred); a canvas without bars has none.
 */
const BARS = 200;

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
  // the panel asked the server once and got "no capture": a JSON-RPC error, followed by no binary frame
  expect(rpc.requests("state.getSgcFrameData")).toHaveLength(1);
  const answer = rpc.received.find((frame) => frame.id === rpc.requests("state.getSgcFrameData")[0].id);
  expect(answer?.error).toEqual({ code: -32011, message: "no capture available" });
  expect(answer?.result).toBeUndefined();
  expect(rpc.binaryFrames).toEqual([]);
});

test("without a connection the SGC panel keeps its bar, and says \"Not connected\" where a capture would be", async ({ page }) => {
  const view = panel(page, "sgc");
  await expect(view.getByText("Record some data to display here")).toBeVisible();
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(view.getByText("Not connected")).toBeVisible();
  await expect(view.getByText("Record some data to display here")).toHaveCount(0);
  await expect(tooltipButton(view, RECORD)).toBeVisible();
  await expect(view.getByRole("button", { name: "All (64)" })).toBeVisible();
  // and asks for a recording again when a server is there
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(view.getByText("Record some data to display here")).toBeVisible();
});

test("Record captures 1024 frames while the target keeps running and draws a waveform for every active channel", async ({
  page,
  rpc,
}) => {
  const view = panel(page, "sgc");
  await record(view);

  expect(rpc.requests("state.recordSgcFrames")).toHaveLength(1);
  expect(rpc.requests("state.getSgcFrameData")).toHaveLength(2);
  const response = rpc.received.find((frame) => frame.id === rpc.requests("state.getSgcFrameData")[1].id);
  expect(response?.result).toEqual({
    frameCount: 1024,
    channelsPerFrame: 64,
    bytesPerChannel: 128,
    totalBytes: 8388608,
    binaryId: 1,
  });
  // the capture arrives in one binary frame: the 16-byte header of protocol v3 ("NDB3", kind 1,
  // the binaryId and payload size of the response), then the frames
  expect(rpc.binaryFrames).toHaveLength(1);
  expect(rpc.binaryFrames[0].length).toBe(16 + 8388608);
  expect(rpc.binaryFrames[0].subarray(0, 4).toString("latin1")).toBe("NDB3");
  expect([4, 8, 12].map((offset) => rpc.binaryFrames[0].readUInt32LE(offset))).toEqual([1, 1, 8388608]);

  // a running target keeps running through a capture, and the toolbar says so
  await expect(tooltipButton(page, "Pause")).toBeEnabled();
  await expect(tooltipButton(page, "Run")).toBeDisabled();
  const states = rpc.received
    .filter((frame) => frame.method === "event.tick")
    .map((frame) => (frame.params as { executionState: { state: string } }).executionState.state);
  expect(new Set(states)).toEqual(new Set(["running"]));

  // one channel view per active channel, each with a header and a drawn canvas
  const canvases = view.locator("canvas");
  await expect(canvases).toHaveCount(8);
  await expect(view.getByText(/^HEAD:/)).toHaveCount(8);
  await expect(view.getByText(/^ENV:/)).toHaveCount(8);

  for (let index = 0; index < 8; index++) {
    await canvases.nth(index).scrollIntoViewIfNeeded();
    // The waveform bars themselves, by their colour: the two envelope curves and the playback
    // cursor are on the canvas as well, and with them alone a canvas has more than a thousand
    // pixels that are not background.
    await expect
      .poll(async () => (await canvasStats(canvases.nth(index))).bars.blue, { message: `canvas ${index} has no waveform bars` })
      .toBeGreaterThan(BARS);
    const stats = await canvasStats(canvases.nth(index));
    expect(stats.width).toBeGreaterThan(100);
    expect(stats.height).toBeGreaterThan(50);
    expect(stats.colours).toBeGreaterThan(10);
    // Pre-VolPan is the default view: no bar of another view
    expect(stats.bars.pink).toBe(0);
    expect(stats.bars.purple).toBe(0);
    // and the rest of the drawing is there too: envelopes and cursor
    expect(stats.nonBackground).toBeGreaterThan(stats.bars.blue + 300);
  }
});

test("a capture started while the target is paused runs it for the capture and pauses it again", async ({ page, rpc }) => {
  const view = panel(page, "sgc");
  await tooltipButton(page, "Pause").click();
  await expect(tooltipButton(page, "Run")).toBeEnabled();
  const ticksBefore = rpc.received.filter((frame) => frame.method === "event.tick").length;
  const stop = (rpc.received.filter((frame) => frame.method === "event.tick").at(-1)?.params as {
    executionState: { stopId: number };
  }).executionState.stopId;

  await record(view);
  await expect(view.locator("canvas")).toHaveCount(8);
  await expect(tooltipButton(page, "Run")).toBeEnabled();

  // a running tick, then the paused tick of a new stop whose reason is the capture
  const states = rpc.received
    .filter((frame) => frame.method === "event.tick")
    .slice(ticksBefore)
    .map((frame) => (frame.params as { executionState: { state: string; reason?: string; stopId: number } }).executionState);
  expect(states[0]).toEqual({ state: "running", stopId: stop });
  expect(states.at(-1)).toEqual({ state: "paused", stopId: stop + 1, reason: "capture" });
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

  expect(active.bars.blue).toBeGreaterThan(BARS);

  // find a silent channel: envelope 000, drawn as flat lines only
  const all = await Promise.all(Array.from({ length: 8 }, (_, index) => canvasStats(canvases.nth(index))));
  const silent = all.filter((stats) => stats.bars.blue === 0);
  expect(silent.length).toBeGreaterThan(0);
  for (const stats of silent) {
    // not blank: the flat envelope lines and the cursor, and not a single bar
    expect(stats.nonBackground).toBeGreaterThan(100);
    expect(stats.bars).toEqual({ blue: 0, pink: 0, purple: 0 });
    expect(stats.nonBackground).toBeLessThan(active.nonBackground / 2);
  }
  // the first eight of all 64 channels are not all silent only if one of them is active
  const quietest = Math.min(...all.map((stats) => stats.nonBackground));
  expect(quietest).toBeGreaterThan(0);

  await view.getByRole("button", { name: "Active (8)" }).click();
  await expect(canvases).toHaveCount(8);
});

test("the view-mode buttons redraw a channel and fullscreen shows it alone", async ({ page }) => {
  const view = panel(page, "sgc");
  await record(view);
  const canvases = view.locator("canvas");
  await expect(canvases).toHaveCount(8);
  const canvas = canvases.first();
  await expect.poll(async () => (await canvasStats(canvas)).bars.blue).toBeGreaterThan(BARS);
  const preVolPan = await canvasStats(canvas);
  expect(preVolPan.bars).toMatchObject({ pink: 0, purple: 0 });

  // Post-VolPan: three stacked waveforms (left in blue, right in pink, DSP send in orange)
  await tooltipButton(view, "Post-VolPan (L/R/DSP)").first().click();
  await expect.poll(async () => (await canvasStats(canvas)).hash).not.toBe(preVolPan.hash);
  await expect.poll(async () => (await canvasStats(canvas)).bars.pink).toBeGreaterThan(20);
  const postVolPan = await canvasStats(canvas);
  expect(postVolPan.bars.blue).toBeGreaterThan(20);
  expect(postVolPan.bars.purple).toBe(0);
  // each of the three is a third as tall as the single waveform was
  expect(postVolPan.bars.blue).toBeLessThan(preVolPan.bars.blue);

  // Input: the unprocessed samples, in purple, louder than after the envelope and the volume
  await tooltipButton(view, "Input Waveform").first().click();
  await expect.poll(async () => (await canvasStats(canvas)).hash).not.toBe(postVolPan.hash);
  await expect.poll(async () => (await canvasStats(canvas)).bars.purple).toBeGreaterThan(preVolPan.bars.blue);
  const input = await canvasStats(canvas);
  expect(input.hash).not.toBe(preVolPan.hash);
  expect(input.bars.blue).toBe(0);
  // (where a purple bar crosses the orange cursor or envelope, a few pixels blend into pink)
  expect(input.bars.pink).toBeLessThan(input.bars.purple / 20);

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
  await expect.poll(async () => (await canvasStats(canvas)).bars.blue).toBeGreaterThan(BARS);
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
