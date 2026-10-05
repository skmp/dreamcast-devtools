import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { startMockServer, type MockServer } from "./mockServer";

/**
 * Everything the browser reports as wrong while a test runs: console.error,
 * uncaught exceptions, failed requests, HTTP >= 400 responses and requests to
 * any origin other than the server under test. A test fails when one of them
 * is not covered by an allowance, and an allowance always carries its reason.
 */
export class Diagnostics {
  private readonly problems: string[] = [];
  private readonly allowances: Array<{ pattern: RegExp; reason: string }> = [];
  private readonly origins: string[] = [];

  /** Declares an origin the page is served from; requests to any other origin are problems. */
  serveFrom(origin: string) {
    this.origins.push(origin.replace(/\/$/, ""));
  }

  isExternal(url: string): boolean {
    if (/^(data|blob|about):/.test(url)) {
      return false;
    }
    return !this.origins.some((origin) => url === origin || url.startsWith(`${origin}/`));
  }

  record(problem: string) {
    this.problems.push(problem);
  }

  /** Accept problems matching `pattern` for the rest of this test. `reason` says why they are expected. */
  allow(pattern: RegExp, reason: string) {
    if (!reason.trim()) {
      throw new Error("an allowance needs a reason");
    }
    this.allowances.push({ pattern, reason });
  }

  /** Every recorded problem, allowed or not. */
  all(): readonly string[] {
    return this.problems;
  }

  unexpected(): string[] {
    return this.problems.filter((problem) => !this.allowances.some(({ pattern }) => pattern.test(problem)));
  }
}

/**
 * Messages that were investigated and are expected with today's code. Tests opt
 * in with `diagnostics.allow(...KNOWN.x)`; nothing is allowed globally.
 */
export const KNOWN = {
  /**
   * Before the first recording the server answers state.getSgcFrameData with the JSON-RPC
   * error -32011; AudioPanel (src/app/panels/AudioPanel.tsx) reports that expected empty
   * state through console.error and then renders "Record some data to display here".
   */
  sgcNoData: [
    /^console\.error: Failed to fetch SGC frame data: JsonRpcException: no capture available/,
    "SGC panel logs the expected 'nothing recorded yet' answer of the server with console.error",
  ],
} as const satisfies Record<string, readonly [RegExp, string]>;

const attachDiagnostics = (page: Page, diagnostics: Diagnostics) => {
  page.on("console", (message) => {
    if (message.type() === "error") {
      diagnostics.record(`console.error: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => {
    diagnostics.record(`pageerror: ${error.message}`);
  });
  page.on("requestfailed", (request) => {
    diagnostics.record(`requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`);
  });
  page.on("request", (request) => {
    if (diagnostics.isExternal(request.url())) {
      diagnostics.record(`external request: ${request.url()}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      diagnostics.record(`http ${response.status()}: ${response.url()}`);
    }
  });
};

/** One JSON-RPC text frame on the debugger WebSocket. */
export interface RpcFrame {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

/** The JSON-RPC traffic of the page, recorded from before the first navigation. */
export interface RpcLog {
  /** client -> server */
  readonly sent: RpcFrame[];
  /** server -> client (responses and event.tick notifications) */
  readonly received: RpcFrame[];
  /** binary frames, server -> client, with their protocol v3 header */
  readonly binaryFrames: Buffer[];
  /** URLs of every WebSocket the page opened */
  readonly sockets: string[];
  /** Requests sent so far with this method. */
  readonly requests: (method: string) => RpcFrame[];
}

interface Fixtures {
  /** A fresh mock server per test: its state (breakpoints, watches, run state) is shared by all clients. */
  mock: MockServer;
  diagnostics: Diagnostics;
  rpc: RpcLog;
}

export const test = base.extend<Fixtures>({
  mock: async ({}, use) => {
    const mock = await startMockServer();
    await use(mock);
    await mock.stop();
  },

  baseURL: async ({ mock }, use) => {
    await use(mock.baseURL);
  },

  diagnostics: async ({}, use) => {
    await use(new Diagnostics());
  },

  // auto: the listeners must be attached before a beforeEach hook opens the workspace
  rpc: [
    async ({ page }, use) => {
      const sent: RpcFrame[] = [];
      const received: RpcFrame[] = [];
      const binaryFrames: Buffer[] = [];
      const sockets: string[] = [];
      page.on("websocket", (socket) => {
        sockets.push(socket.url());
        socket.on("framesent", ({ payload }) => {
          if (typeof payload === "string") sent.push(JSON.parse(payload) as RpcFrame);
        });
        socket.on("framereceived", ({ payload }) => {
          if (typeof payload === "string") received.push(JSON.parse(payload) as RpcFrame);
          else binaryFrames.push(payload);
        });
      });
      await use({ sent, received, binaryFrames, sockets, requests: (method) => sent.filter((frame) => frame.method === method) });
    },
    { auto: true },
  ],

  page: async ({ page, mock, diagnostics }, use) => {
    diagnostics.serveFrom(mock.baseURL);
    attachDiagnostics(page, diagnostics);
    // E2E_CPU_THROTTLE=4 gives the page a quarter of the CPU (Chromium's own throttling): what a
    // loaded machine or a slow CI runner does to a test, on demand. A test that only passes on
    // an idle machine fails with it.
    const throttle = Number(process.env.E2E_CPU_THROTTLE ?? 1);
    if (throttle > 1) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
    }
    await use(page);
    expect(
      diagnostics.unexpected(),
      "console.error / uncaught exception / failed, HTTP >= 400 or external request during the test",
    ).toEqual([]);
  },
});

export { expect };

export const WORKSPACES = ["sh4-debugger", "arm7-debugger", "audio-debugger", "mixed-mode-debugger"] as const;
export type WorkspaceId = (typeof WORKSPACES)[number];

/** The dock panel with the given PANEL_IDS value (the wrapper DockingLayout renders around every panel). */
export const panel = (page: Page, panelId: string): Locator => page.locator(`[data-panel-id="${panelId}"]`);

/** The dockview tab (header) of a panel, by its title. */
export const dockTab = (page: Page, title: string): Locator =>
  page.locator(".dv-default-tab").filter({ has: page.getByText(title, { exact: true }) });

export const statusBar = (page: Page): Locator => page.locator("footer");

/** The icon button behind an MUI tooltip. Tooltips of possibly-disabled buttons label a wrapping <span>. */
export const tooltipButton = (scope: Page | Locator, label: string): Locator =>
  scope.getByLabel(label, { exact: true }).locator("xpath=descendant-or-self::button");

export const gotoRoute = async (page: Page, route: string) => {
  await page.goto(`/#${route}`);
};

/** Opens a workspace and waits until it is connected and the first tick has populated the device tree. */
export const openWorkspace = async (page: Page, workspace: WorkspaceId) => {
  await gotoRoute(page, `/workspace/${workspace}`);
  await expect(statusBar(page)).toContainText("Connection: connected");
  await expect(panel(page, "device-tree").getByRole("treeitem").first()).toBeVisible();
};

/**
 * Adds a panel to a dock group through its "+" button and the panel selector.
 * `addButtonIndex` is the 0-based index of the "Add Panel" button on the page: the left
 * dock's group first, then the groups of the centre dock, then those of the right dock.
 */
export const addPanelFromSelector = async (page: Page, addButtonIndex: number, title: string) => {
  await page.getByLabel("Add Panel", { exact: true }).nth(addButtonIndex).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByPlaceholder("Type to search panels...").fill(title);
  await dialog.getByRole("button", { name: title }).first().click();
  await expect(dialog).toBeHidden();
};

/** Saves a screenshot to $E2E_SCREENSHOT_DIR when set, otherwise to the test's output directory. */
export const saveScreenshot = async (page: Page, testInfo: TestInfo, name: string) => {
  const directory = process.env.E2E_SCREENSHOT_DIR ?? testInfo.outputPath("screens");
  mkdirSync(directory, { recursive: true });
  await page.screenshot({ path: join(directory, `${name}.png`) });
};

/** A node of the device tree by its path, e.g. "dc.sh4.cpu". */
export const treeItem = (page: Page, itemId: string): Locator =>
  panel(page, "device-tree").locator(`[role="treeitem"][id$="-${itemId}"]`);

/** The clickable row (label + buttons) of a node, without its registers and child nodes. */
export const treeItemRow = (page: Page, itemId: string): Locator =>
  treeItem(page, itemId).locator(".MuiTreeItem-content").first();

/**
 * A register row of the device tree (text and "+" button) by the path of its node, ".reg."
 * and its name, e.g. "dc.sh4.cpu.reg.PC". Registers are not items of the tree view.
 */
export const registerRow = (page: Page, registerId: string): Locator =>
  panel(page, "device-tree").locator(`[data-register="${registerId}"]`);

/** Every row the device tree has mounted: nodes and registers. */
export const treeRows = (page: Page): Locator =>
  panel(page, "device-tree").locator('[role="treeitem"], [data-register]');

/** Rows of a disassembly view (DisassemblyLineItem renders `data-address` with the numeric address). */
export const disassemblyRows = (view: Locator): Locator => view.locator("[data-address]");

/** The row of a disassembly view for a numeric address. */
export const disassemblyRow = (view: Locator, address: number): Locator => view.locator(`[data-address="${address}"]`);

/** The breakpoint gutter of a row; its `data-breakpoint` is "none", "enabled" or "disabled". */
export const breakpointGutter = (row: Locator): Locator => row.locator(".breakpoint-gutter");

/** The numeric address of the row that is marked as the current instruction (paused PC / STEP). */
export const currentInstructionAddress = async (view: Locator): Promise<number> => {
  const row = view.locator(".current-instruction");
  await expect(row).toHaveCount(1);
  return Number(await row.getAttribute("data-address"));
};

export const pauseFromToolbar = async (page: Page) => {
  await tooltipButton(page, "Pause").click();
  await expect(tooltipButton(page, "Run")).toBeEnabled();
};

export interface CanvasStats {
  width: number;
  height: number;
  /** pixels that differ from the most frequent colour of the canvas (its background) */
  nonBackground: number;
  /** rows that contain at least one non-background pixel: a flat line covers a few, a waveform many */
  inkRows: number;
  /** number of distinct RGBA values */
  colours: number;
  /** FNV-1a hash of the pixel data, to tell two drawings apart */
  hash: number;
  /**
   * Pixels in the colours of the SGC waveform bars (SgcWaveformCanvas.tsx), which nothing else
   * on that canvas uses: the envelope curves are green and yellow, the cursor is orange.
   * - blue: the Pre-VolPan waveform, and the left channel of Post-VolPan
   * - pink: the right channel of Post-VolPan
   * - purple: the Input waveform
   * A canvas whose bars were not drawn has 0 of each, whatever else is on it.
   */
  bars: { blue: number; pink: number; purple: number };
}

/** Reads back a 2D canvas. A cleared or never-drawn canvas has `nonBackground === 0` and `colours === 1`. */
export const canvasStats = (canvas: Locator): Promise<CanvasStats> =>
  canvas.evaluate((element) => {
    const source = element as HTMLCanvasElement;
    const context = source.getContext("2d");
    if (!context) {
      throw new Error("canvas has no 2d context");
    }
    if (source.width === 0 || source.height === 0) {
      return { width: source.width, height: source.height, nonBackground: 0, inkRows: 0, colours: 0, hash: 0, bars: { blue: 0, pink: 0, purple: 0 } };
    }
    const bytes = context.getImageData(0, 0, source.width, source.height).data;
    // Measured on the drawn canvas (alpha varies with the overlap of the bars): blue is about
    // (31, 147, 255), pink (255, 31, 149), purple (196, 50, 221). The envelopes are (112, 247, 112)
    // and (255, 215, 0), the cursor (255, 172, 0).
    const bars = { blue: 0, pink: 0, purple: 0 };
    for (let offset = 0; offset < bytes.length; offset += 4) {
      const [red, green, blue, alpha] = [bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]];
      if (alpha === 0) {
        continue;
      }
      if (red <= 90 && green >= 100 && green <= 200 && blue >= 200) {
        bars.blue++;
      } else if (red >= 200 && green <= 90 && blue >= 100 && blue <= 200) {
        bars.pink++;
      } else if (red >= 150 && red <= 235 && green <= 100 && blue >= 180) {
        bars.purple++;
      }
    }
    const pixels = new Uint32Array(bytes.buffer);
    const histogram = new Map<number, number>();
    let hash = 0x811c9dc5;
    for (const pixel of pixels) {
      histogram.set(pixel, (histogram.get(pixel) ?? 0) + 1);
      hash = Math.imul(hash ^ pixel, 0x01000193) >>> 0;
    }
    const [background, backgroundCount] = [...histogram.entries()].reduce((best, entry) => (entry[1] > best[1] ? entry : best));
    let inkRows = 0;
    for (let y = 0; y < source.height; y++) {
      const row = pixels.subarray(y * source.width, (y + 1) * source.width);
      if (row.some((pixel) => pixel !== background)) {
        inkRows++;
      }
    }
    return {
      width: source.width,
      height: source.height,
      nonBackground: pixels.length - backgroundCount,
      inkRows,
      colours: histogram.size,
      hash,
      bars,
    };
  });

/**
 * Starts recording which disassembly rows flash (the "fadeOutTarget" animation of the
 * "target-address" class, which is removed again after two seconds, so it is recorded
 * instead of polled). Returns a reader for the `data-address` values flashed so far.
 */
export const recordFlashes = async (view: Locator): Promise<() => Promise<number[]>> => {
  await view.evaluate((root) => {
    const store = window as unknown as { __flashes: number[] };
    store.__flashes = [];
    root.addEventListener("animationstart", (event) => {
      const row = (event.target as HTMLElement).closest("[data-address]");
      if ((event as AnimationEvent).animationName === "fadeOutTarget" && row) {
        store.__flashes.push(Number(row.getAttribute("data-address")));
      }
    });
  });
  return () => view.page().evaluate(() => (window as unknown as { __flashes: number[] }).__flashes);
};
