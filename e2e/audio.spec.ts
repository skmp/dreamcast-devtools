import { test, expect, canvasStats, gotoRoute, openWorkspace, panel, recordText, statusBar, tooltipButton } from "./support/fixtures";
import type { Locator, Page } from "@playwright/test";
import {
  BinaryFrameKind,
  SGC_BYTES_PER_CHANNEL,
  SGC_BYTES_PER_FRAME,
  SGC_CHANNELS_PER_FRAME,
  encodeBinaryFrame,
} from "../src/lib/binaryFrame";
import { jsonRpcError, serveScriptedDebugger, type ScriptedDebugger } from "./support/scriptedDebugger";

const RECORD = "Run the emulator and record 1024 frames";
// 8 MiB of capture are generated, sent and scanned; be generous on a busy machine
const SLOW = { timeout: 60_000 };

/**
 * The bound of a capture of 4096 frames (32 MiB) in the page: from the moment its binary frame
 * reaches the page's WebSocket to the moment the panel says it has the capture. That is the
 * payload taken from the frame, the scan of the flags of all 262144 records and the render; the
 * transfer from the scripted server to the page (seconds through page.routeWebSocket) is not in
 * it. The panel that copied a frame per frame and channel took seconds here.
 */
const CAPTURE_4096_BOUND_MS = 1_000;

/**
 * An active channel of the mock draws thousands of bar pixels (the quietest of a capture a
 * few hundred); a canvas without bars has none.
 */
const BARS = 200;

const record = async (view: Locator) => {
  await tooltipButton(view, RECORD).click();
  await expect(view.getByRole("button", { name: "Active (8)" })).toBeVisible(SLOW);
};

test.describe("against the mock", () => {
  test.beforeEach(async ({ page }) => {
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

    // Record asks for what its tooltip says
    expect(rpc.requests("state.recordSgcFrames").map((frame) => frame.params)).toEqual([{ frames: 1024 }]);
    expect(rpc.requests("state.getSgcFrameData")).toHaveLength(2);
    await expect(view.getByText("1024 frames", { exact: true })).toBeVisible();
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
});

/**
 * A capture for a scripted server: `frameCount` frames of 64 records. Every record carries its
 * frame number as the play position (`ca_current`, offset 107), as the mock's do, so the header
 * says which frame it shows. A channel of `channels` gets, per frame, its flags (byte 109: bit 0
 * enabled, bits 1-2 the AEG state), its level (offset 96) and a waveform after TL (offset 82, what
 * Pre-VolPan draws); every other channel is silent and not enabled.
 */
interface ChannelScript {
  enabled?: (frame: number) => boolean;
  aegState?: (frame: number) => number;
  level?: (frame: number) => number;
  /** the sample after TL, int16; by default a square wave at half scale */
  sample?: (frame: number) => number;
}

const buildCapture = (frameCount: number, channels: Record<number, ChannelScript> = {}, others: ChannelScript = {}): Uint8Array => {
  const bytes = new Uint8Array(frameCount * SGC_BYTES_PER_FRAME);
  const view = new DataView(bytes.buffer);
  for (let frame = 0; frame < frameCount; frame++) {
    for (let channel = 0; channel < SGC_CHANNELS_PER_FRAME; channel++) {
      const base = frame * SGC_BYTES_PER_FRAME + channel * SGC_BYTES_PER_CHANNEL;
      view.setUint16(base + 107, frame & 0xffff, true);
      const script = channels[channel] ?? others;
      const enabled = script.enabled?.(frame) ?? false;
      view.setUint8(base + 109, (enabled ? 1 : 0) | ((script.aegState?.(frame) ?? 3) << 1));
      view.setUint32(base + 96, script.level?.(frame) ?? 0, true);
      if (channels[channel]) {
        view.setInt16(base + 82, script.sample?.(frame) ?? (frame % 2 === 0 ? 16000 : -16000), true);
      }
    }
  }
  return bytes;
};

interface ScriptedCaptures {
  server: ScriptedDebugger;
  /** the capture the server has from the next state.recordSgcFrames on */
  next(capture: Uint8Array): void;
  /** when each binary frame of state.getSgcFrameData was sent (performance.now of the test process) */
  readonly sentAt: number[];
}

/**
 * A scripted server with the SGC capture: state.getSgcFrameData answers the server's capture
 * (`initial`, or -32011 while it has none) and sends it as one binary frame behind the
 * response; each state.recordSgcFrames makes the capture given by `next()` the server's.
 */
const serveCaptures = async (page: Page, initial: Uint8Array | null): Promise<ScriptedCaptures> => {
  const server = await serveScriptedDebugger(page);
  (server.shape.capabilities as string[]).push("sgc-capture");
  let current = initial;
  const pending: Uint8Array[] = [];
  const sentAt: number[] = [];
  let binaryId = 0;
  server.answer("state.recordSgcFrames", () => {
    current = pending.shift() ?? current;
    return {};
  });
  server.answer("state.getSgcFrameData", () => {
    if (!current) {
      return jsonRpcError(-32011, "no capture available");
    }
    const payload = current;
    const id = ++binaryId;
    setTimeout(() => {
      sentAt.push(performance.now());
      server.sendBinary(encodeBinaryFrame(BinaryFrameKind.SGC_FRAMES, id, payload));
    }, 0);
    return {
      frameCount: payload.byteLength / SGC_BYTES_PER_FRAME,
      channelsPerFrame: SGC_CHANNELS_PER_FRAME,
      bytesPerChannel: SGC_BYTES_PER_CHANNEL,
      totalBytes: payload.byteLength,
      binaryId: id,
    };
  });
  return { server, next: (capture) => pending.push(capture), sentAt };
};

const openAudio = async (page: Page, server: ScriptedDebugger) => {
  await gotoRoute(page, "/workspace/audio-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");
  await server.described();
  return panel(page, "sgc");
};

/** The columns of a canvas that have a pixel of the Pre-VolPan waveform's blue (see canvasStats). */
const blueColumns = (canvas: Locator) =>
  canvas.evaluate((element) => {
    const source = element as HTMLCanvasElement;
    const { data } = source.getContext("2d")!.getImageData(0, 0, source.width, source.height);
    let first = -1;
    let last = -1;
    for (let x = 0; x < source.width; x++) {
      for (let y = 0; y < source.height; y++) {
        const offset = (y * source.width + x) * 4;
        const [red, green, blue, alpha] = [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]];
        if (alpha !== 0 && red <= 90 && green >= 100 && green <= 200 && blue >= 200) {
          if (first < 0) first = x;
          last = x;
          break;
        }
      }
    }
    return { width: source.width, first, last };
  });

/**
 * Where the playback cursor is, as a fraction of the canvas's width (-1 when it is not drawn): the
 * middle of the orange columns of a row at 15 % of the height, above the waveform of
 * buildCapture's channels and below no envelope (their level is 0, at the bottom).
 */
const cursorColumns = (canvas: Locator) =>
  canvas.evaluate((element) => {
    const source = element as HTMLCanvasElement;
    const y = Math.floor(source.height * 0.15);
    const { data } = source.getContext("2d")!.getImageData(0, y, source.width, 1);
    const columns: number[] = [];
    for (let x = 0; x < source.width; x++) {
      const [red, green, blue, alpha] = [data[x * 4], data[x * 4 + 1], data[x * 4 + 2], data[x * 4 + 3]];
      if (alpha !== 0 && red >= 230 && green >= 140 && green <= 200 && blue <= 60) {
        columns.push(x);
      }
    }
    return { centre: columns.length ? (columns[0] + columns[columns.length - 1]) / 2 / source.width : -1, columns: columns.length };
  });

/**
 * Records when each binary message reaches the page's WebSocket (the page's performance.now),
 * ahead of the page's own listeners. Call it before the navigation, behind serveCaptures.
 */
const recordBinaryArrivals = async (page: Page): Promise<() => Promise<number[]>> => {
  await page.addInitScript(() => {
    const store = window as unknown as { __binaryArrivals: number[] };
    store.__binaryArrivals = [];
    const Base = window.WebSocket;
    window.WebSocket = class extends Base {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener("message", (event) => {
          if (typeof event.data !== "string") {
            store.__binaryArrivals.push(performance.now());
          }
        });
      }
    };
  });
  return () => page.evaluate(() => (window as unknown as { __binaryArrivals: number[] }).__binaryArrivals);
};

/** Moves the mouse to a fraction of a canvas's width, at half its height. */
const pointAt = async (page: Page, canvas: Locator, fraction: number) => {
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + Math.min(box.width - 1, box.width * fraction), box.y + box.height / 2);
};

const clickAt = async (page: Page, canvas: Locator, fraction: number) => {
  const box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + Math.min(box.width - 1, box.width * fraction), box.y + box.height / 2);
};

/** Takes the mouse off the canvases: the header then shows the playback position. */
const leaveCanvas = async (page: Page, canvas: Locator) => {
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y - 40);
};

test.describe("captures of a scripted server", () => {
  test("a capture of 64 frames is the panel's when the page loads: its length, the channels whose flags say they play, positions inside its frames", async ({ page }) => {
    const sgc = await serveCaptures(
      page,
      buildCapture(64, {
        5: { enabled: () => true, aegState: (frame) => frame >> 4, level: (frame) => frame * 16 },
        20: { enabled: () => true, aegState: () => 0, level: () => 0x3ff },
      }),
    );
    const view = await openAudio(page, sgc.server);
    await expect(view.getByText("64 frames", { exact: true })).toBeVisible();
    await expect(view.getByRole("button", { name: "Active (2)" })).toHaveAttribute("aria-pressed", "true");
    await expect(view.getByText(/^\d{2}$/)).toHaveText(["05", "20"]);
    const canvas = view.locator("canvas").first();
    const head = view.getByText(/^HEAD:/).first();
    const aegState = view.getByLabel("AEG State", { exact: true }).first();
    await expect(head).toHaveText(/HEAD:\s+0:/);
    await expect(aegState).toHaveText(/^attack/);

    // the 64 frames fill the canvas's width: bars from the left edge to the right one
    await expect.poll(async () => (await blueColumns(canvas)).last).toBeGreaterThan(0);
    const columns = await blueColumns(canvas);
    expect(columns.first).toBeLessThan(columns.width * 0.05);
    expect(columns.last).toBeGreaterThan(columns.width * 0.95);

    // a fraction of the canvas is that fraction of the 64 frames (aegState: 16 frames per state)
    await pointAt(page, canvas, 0.55);
    await expect(head).toHaveText(/HEAD:\s+3[456]:/);
    await expect(aegState).toHaveText(/^decay 2/);
    await pointAt(page, canvas, 1 / 8);
    await expect(head).toHaveText(/HEAD:\s+[789]:/);
    await expect(aegState).toHaveText(/^attack/);
    await pointAt(page, canvas, 0.3);
    await expect(head).toHaveText(/HEAD:\s+(1[89]|20):/);
    await expect(aegState).toHaveText(/^decay 1/);
    // clicked: the playback position, shown when the mouse leaves
    await clickAt(page, canvas, 0.8);
    await leaveCanvas(page, canvas);
    await expect(head).toHaveText(/HEAD:\s+5[012]:/);
    await expect(aegState).toHaveText(/^release/);
    // the far right is the last frame
    await clickAt(page, canvas, 1);
    await leaveCanvas(page, canvas);
    await expect(head).toHaveText(/HEAD:\s+63:/);
    expect(sgc.server.requestsOf("state.getSgcFrameData")).toHaveLength(1);
  });

  test("a capture of one frame is shown and drawn, and every position of the mouse is that frame", async ({ page }) => {
    const sgc = await serveCaptures(page, buildCapture(1, { 0: { enabled: () => true, aegState: () => 1, level: () => 0x200 } }));
    const view = await openAudio(page, sgc.server);
    await expect(view.getByText("1 frame", { exact: true })).toBeVisible();
    await expect(view.getByRole("button", { name: "Active (1)" })).toBeVisible();
    const canvas = view.locator("canvas");
    await expect(canvas).toHaveCount(1);
    await expect.poll(async () => (await canvasStats(canvas)).bars.blue).toBeGreaterThan(200);
    const head = view.getByText(/^HEAD:/);
    await expect(view.getByLabel("AEG State", { exact: true })).toHaveText(/^decay 1/);
    for (const fraction of [0, 0.5, 1]) {
      await pointAt(page, canvas, fraction);
      await expect(head).toHaveText(/HEAD:\s+0:/);
    }
    await clickAt(page, canvas, 1);
    await leaveCanvas(page, canvas);
    await expect(head).toHaveText(/HEAD:\s+0:/);
  });

  test("a capture of 0 frames is an empty one: nothing to draw, behind a longer capture and in front of one", async ({ page }) => {
    const sgc = await serveCaptures(page, buildCapture(0));
    const view = await openAudio(page, sgc.server);
    await expect(view.getByText("The capture has no frames")).toBeVisible();
    await expect(view.getByText("0 frames", { exact: true })).toBeVisible();
    await expect(view.getByRole("button", { name: "Active (0)" })).toBeVisible();
    await view.getByRole("button", { name: "All (64)" }).click();
    await expect(view.getByText("The capture has no frames")).toBeVisible();
    await expect(view.locator("canvas")).toHaveCount(0);
    await view.getByRole("button", { name: "Active (0)" }).click();

    // a capture of 64 frames, a position in it, and the empty one behind it
    sgc.next(buildCapture(64, { 2: { enabled: () => true } }));
    sgc.next(buildCapture(0));
    await tooltipButton(view, RECORD).click();
    await expect(view.getByText("64 frames", { exact: true })).toBeVisible();
    const canvas = view.locator("canvas");
    await expect(canvas).toHaveCount(1);
    await clickAt(page, canvas, 0.55);
    await leaveCanvas(page, canvas);
    await expect(view.getByText(/^HEAD:/)).toHaveText(/HEAD:\s+3[456]:/);
    await tooltipButton(view, RECORD).click();
    await expect(view.getByText("0 frames", { exact: true })).toBeVisible();
    await expect(view.getByText("The capture has no frames")).toBeVisible();
    await expect(view.getByRole("button", { name: "Active (0)" })).toBeVisible();
    await expect(view.locator("canvas")).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("a shorter capture behind a longer one: the playback position and the hover are kept inside it", async ({ page }) => {
    const long = buildCapture(1024, { 3: { enabled: () => true } });
    const short = buildCapture(64, { 3: { enabled: () => true } });
    const sgc = await serveCaptures(page, long);
    const view = await openAudio(page, sgc.server);
    await expect(view.getByText("1024 frames", { exact: true })).toBeVisible();
    const canvas = view.locator("canvas");
    await expect(canvas).toHaveCount(1);
    const head = view.getByText(/^HEAD:/);
    const record = tooltipButton(view, RECORD);

    await clickAt(page, canvas, 0.9);
    await leaveCanvas(page, canvas);
    await expect(head).toHaveText(/HEAD:\s+9[12]\d:/);

    // the playback position past the end of the 64 frames is their last frame, and the cursor is drawn there
    sgc.next(short);
    await record.click();
    await expect(view.getByText("64 frames", { exact: true })).toBeVisible();
    await expect(head).toHaveText(/HEAD:\s+63:/);
    await expect.poll(async () => (await cursorColumns(canvas)).centre).toBeGreaterThan(0.96);
    // and it was clamped when the short capture arrived: a long one behind it does not bring frame 92x back
    sgc.next(long);
    await record.click();
    await expect(view.getByText("1024 frames", { exact: true })).toBeVisible();
    await expect(head).toHaveText(/HEAD:\s+63:/);
    // frame 63 of 1024: the cursor at 6 % of the width
    await expect.poll(async () => (await cursorColumns(canvas)).centre).toBeLessThan(0.08);
    expect((await cursorColumns(canvas)).centre).toBeGreaterThan(0.04);

    // the hover: the mouse rests over frame 97x while Record is pressed from the keyboard
    await pointAt(page, canvas, 0.95);
    await expect(head).toHaveText(/HEAD:\s+9[67]\d:/);
    sgc.next(short);
    await record.focus();
    await page.keyboard.press("Enter");
    await expect(view.getByText("64 frames", { exact: true })).toBeVisible();
    // a frame of the 64 (the last one, or the one under the mouse if the browser moved it again)
    await expect(head).toHaveText(/HEAD:\s+6[0-3]:/);
    await expect(view.locator("canvas")).toHaveCount(1);
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(sgc.server.requestsOf("state.recordSgcFrames")).toEqual([{ frames: 1024 }, { frames: 1024 }, { frames: 1024 }]);
  });

  test(`a capture of 4096 frames is scanned and shown within ${CAPTURE_4096_BOUND_MS} ms of reaching the page, and its positions run to its last frame`, async ({ page }) => {
    // every channel loud and not enabled in every frame; channel 9 enabled in the last frame only:
    // the scan reads the flags of every record of the capture
    const sgc = await serveCaptures(page, null);
    const arrivals = await recordBinaryArrivals(page);
    const lengths = await recordText(page, '[data-panel-id="sgc"] [role="status"][aria-label="Capture length"]');
    const view = await openAudio(page, sgc.server);
    await expect(view.getByText("Record some data to display here")).toBeVisible();
    sgc.next(buildCapture(4096, { 9: { enabled: (frame) => frame === 4095, level: () => 0x3ff, aegState: () => 3 } }, { level: () => 0x3ff, aegState: () => 3 }));
    await tooltipButton(view, RECORD).click();
    await expect(view.getByRole("status", { name: "Capture length" })).toHaveText("4096 frames", SLOW);
    await expect(view.getByRole("button", { name: "Active (1)" })).toBeVisible();
    // both times are the page's performance.now
    const [arrived] = await arrivals();
    const shown = (await lengths()).find(({ text }) => text === "4096 frames")!.at;
    const elapsed = Math.round(shown - arrived);
    expect(sgc.sentAt).toHaveLength(1);
    expect(elapsed, `${elapsed} ms from the binary frame's arrival to the capture shown`).toBeLessThan(CAPTURE_4096_BOUND_MS);
    expect(elapsed).toBeGreaterThanOrEqual(0);
    console.log(`a capture of 4096 frames: shown ${elapsed} ms after its binary frame reached the page`);
    await expect(view.getByText(/^\d{2}$/)).toHaveText(["09"]);

    const canvas = view.locator("canvas");
    await expect.poll(async () => (await blueColumns(canvas)).last).toBeGreaterThan(0);
    const columns = await blueColumns(canvas);
    expect(columns.first).toBeLessThan(columns.width * 0.05);
    expect(columns.last).toBeGreaterThan(columns.width * 0.95);
    const head = view.getByText(/^HEAD:/);
    await pointAt(page, canvas, 0.75);
    await expect(head).toHaveText(/HEAD:\s+30[67]\d:/);
    // the right edge: the last frames (a pixel of the canvas is about ten of them)
    await clickAt(page, canvas, 1);
    await leaveCanvas(page, canvas);
    await expect(head).toHaveText(/HEAD:\s+40[89]\d:/);
  });

  test("a channel with a level above 0 and flags bit 0 clear is not active; one enabled at level 0 is", async ({ page }) => {
    const sgc = await serveCaptures(
      page,
      buildCapture(64, {
        // loud, in release, not enabled: it has run to its end
        12: { enabled: () => false, aegState: () => 3, level: () => 0x300 },
        // enabled and in its attack, still silent
        30: { enabled: () => true, aegState: () => 0, level: () => 0 },
      }),
    );
    const view = await openAudio(page, sgc.server);
    await expect(view.getByText("64 frames", { exact: true })).toBeVisible();
    await expect(view.getByRole("button", { name: "Active (1)" })).toBeVisible();
    await expect(view.getByText(/^\d{2}$/)).toHaveText(["30"]);
    await expect(view.getByLabel("AEG State", { exact: true })).toHaveText(/^attack/);
    await expect(view.getByLabel("AEG", { exact: true })).toHaveText("000");

    await view.getByRole("button", { name: "All (64)" }).click();
    await expect(view.locator("canvas")).toHaveCount(64);
    const header = (channel: string) => view.locator("div").filter({ has: page.getByText(channel, { exact: true }) }).filter({ has: page.getByText(/^HEAD:/) }).last();
    await expect(header("12").getByLabel("AEG", { exact: true })).toHaveText("300");
    await expect(header("12").getByLabel("AEG State", { exact: true })).toHaveText(/^release/);
    await expect(header("30").getByLabel("AEG State", { exact: true })).toHaveText(/^attack/);
  });
});
