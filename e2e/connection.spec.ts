import { test, expect, gotoRoute, openWorkspace, panel, statusBar, tooltipButton } from "./support/fixtures";
import type { Page } from "@playwright/test";
import { startMockServer } from "./support/mockServer";

const connectButton = (page: Page) => page.getByRole("button", { name: "Connect", exact: true });
const disconnectButton = (page: Page) => page.getByRole("button", { name: "Disconnect", exact: true });

test("a workspace connects by itself to /ws on the origin that served the page", async ({ page, mock, rpc }) => {
  await gotoRoute(page, "/workspace/sh4-debugger");

  await expect(statusBar(page)).toContainText("Connection: connected");
  await expect(statusBar(page)).toContainText(`Endpoint: ${mock.wsURL}`);
  await expect(page.getByLabel("Connection: connected")).toBeVisible();
  await expect(disconnectButton(page)).toBeVisible();
  // no connection picker when there is exactly one candidate
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(rpc.sockets).toEqual([mock.wsURL]);
});

test("the first request is debugger.describe and the tick that follows populates the panels", async ({ page, rpc }) => {
  await openWorkspace(page, "sh4-debugger");
  await expect(panel(page, "watches")).toContainText("dc.sh4.cpu.pc = 0x8C0000");

  // wire order: describe request, its response, then the event.tick notification
  // the client says which protocol it speaks and who it is
  expect(rpc.sent[0]).toEqual({
    jsonrpc: "2.0",
    id: 1,
    method: "debugger.describe",
    params: { protocol: 3, client: expect.stringMatching(/^nullDC DevTools 3\.\d+\.\d+/) },
  });
  // A running server sends its periodic tick to every connection, so one can arrive before
  // the response. The tick that follows the response is the one for this client, a full one.
  const response = rpc.received.findIndex((frame) => frame.id === 1);
  expect(response).toBeGreaterThanOrEqual(0);
  expect(rpc.received.slice(0, response).map((frame) => frame.method)).toEqual(new Array(response).fill("event.tick"));
  expect(rpc.received[response].method).toBeUndefined();
  expect(rpc.received[response].result).toMatchObject({ protocol: 3, emulator: { name: "nullDC (mock)" }, ui: expect.stringMatching(/^3\./) });
  expect(rpc.received[response + 1]).toMatchObject({ method: "event.tick" });
  const firstTick = rpc.received[response + 1].params as { registers: Record<string, unknown>; executionState: unknown };
  expect(Object.keys(firstTick.registers)).toEqual(expect.arrayContaining(["dc", "dc.sh4.cpu", "dc.sh4.bsc", "dc.holly.intc", "dc.timing"]));
  expect(firstTick.executionState).toEqual({ state: "running", stopId: 0 });

  // describe -> device tree structure
  const tree = panel(page, "device-tree");
  await expect(tree.getByRole("treeitem", { name: "Dreamcast beloved console" })).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: "SH4 SH7750-alike SoC" })).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: "AICA Sound SoC" })).toBeVisible();
  // tick -> registers, watches, callstack; describe+tick -> disassembly and memory fetches
  await expect(tree.getByText("SYSCLK = 200MHz")).toBeVisible();
  await expect(tree.getByText("BUILD = nullDC 3.0.0 mock")).toBeVisible();
  // a running target has no callstack
  await expect(panel(page, "sh4-callstack")).toContainText("Empty callstack.");
  await expect(panel(page, "sh4-disassembly")).toContainText("0x8C010000");
  await expect(panel(page, "sh4-memory")).toContainText("0x8C010000");
  expect(rpc.sent.map((frame) => frame.method)).toEqual(
    expect.arrayContaining(["debugger.describe", "state.getDisassembly", "state.getMemorySlice"]),
  );

  // the mock starts in the running state: Pause is offered, Run is not
  await expect(tooltipButton(page, "Pause")).toBeEnabled();
  await expect(tooltipButton(page, "Run")).toBeDisabled();
});

test("Disconnect goes idle and Connect reconnects", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");

  await disconnectButton(page).click();
  await expect(statusBar(page)).toContainText("Connection: idle");
  await expect(page.getByLabel("Connection: idle")).toBeVisible();
  await expect(connectButton(page)).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(tooltipButton(page, "Pause")).toBeDisabled();
  await expect(tooltipButton(page, "Run")).toBeDisabled();

  await connectButton(page).click();
  await expect(statusBar(page)).toContainText("Connection: connected");
  await expect(disconnectButton(page)).toBeVisible();
  await expect(tooltipButton(page, "Pause")).toBeEnabled();
});

test("killing the server mid-session shows an error state; after a restart Connect brings the session back", async ({
  page,
  mock,
  diagnostics,
}) => {
  await openWorkspace(page, "sh4-debugger");
  const tree = panel(page, "device-tree");
  await expect(tree.getByText("SYSCLK = 200MHz")).toBeVisible();
  // paused, so that the panels have a callstack to keep
  await tooltipButton(page, "Pause").click();
  await expect(panel(page, "sh4-callstack")).toContainText("_main_loop+0x");

  // --- the emulator dies ---
  await mock.stop("SIGKILL");

  await expect(statusBar(page)).toContainText("Connection: error");
  await expect(page.getByLabel("Connection: error")).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Connection closed" })).toBeVisible();
  await expect(connectButton(page)).toBeVisible();
  // run control is disabled
  await expect(tooltipButton(page, "Pause")).toBeDisabled();
  await expect(tooltipButton(page, "Run")).toBeDisabled();
  // TODAY: the data store is not reset, so every panel keeps showing the last
  // values as if they were live, and the per-panel buttons stay enabled.
  await expect(tree.getByText("SYSCLK = 200MHz")).toBeVisible();
  await expect(panel(page, "sh4-callstack")).toContainText("_main_loop+0x");
  await expect(panel(page, "watches")).toContainText("dc.sh4.cpu.pc = 0x8C0000");
  await expect(tooltipButton(panel(page, "sh4-disassembly"), "Refresh")).toBeEnabled();

  // TODAY: there is no automatic reconnect. With the server still down, Connect fails.
  diagnostics.allow(
    /^console\.error: WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/ws' failed/,
    "the server is down on purpose",
  );
  diagnostics.allow(/^console\.error: Failed to connect/, "sessionStore logs the failed attempt while the server is down");
  await connectButton(page).click();
  await expect(statusBar(page)).toContainText("Connection: error");
  await expect(page.getByRole("alert")).toBeVisible();

  // --- the emulator comes back on the same port ---
  const restarted = await startMockServer({ port: mock.port });
  try {
    // TODAY: nothing happens until the user asks for it
    await page.waitForTimeout(1500);
    await expect(statusBar(page)).toContainText("Connection: error");

    await connectButton(page).click();
    await expect(statusBar(page)).toContainText("Connection: connected");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(disconnectButton(page)).toBeVisible();
    // the new session is described again and live: pausing produces a tick that the UI follows
    await tooltipButton(page, "Pause").click();
    await expect(tooltipButton(page, "Run")).toBeEnabled();
    await expect(panel(page, "watches")).toContainText("dc.sh4.cpu.pc = 0x8C0000");
  } finally {
    await restarted.stop();
  }
});

test("a failed connection attempt shows a readable error", async ({ page, mock, diagnostics }) => {
  // regression: WebSocketTransport.connect rejected with the DOM `Event` of the socket, which
  // the session store turned into the text "[object Event]"
  diagnostics.allow(/^console\.error: (WebSocket connection to|Failed to connect)/, "the server is down on purpose");
  await openWorkspace(page, "sh4-debugger");
  await mock.stop("SIGKILL");
  await expect(statusBar(page)).toContainText("Connection: error");
  await connectButton(page).click();
  // the browser tells the page nothing about the failure, so the text names the endpoint and what it can be
  const alert = page.getByRole("alert").filter({ hasText: "Could not connect" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(`Could not connect to ${mock.wsURL}: the server is not running, is not reachable or refused the connection`);
  await expect(page.getByRole("alert").filter({ hasText: "[object" })).toHaveCount(0);
  await expect(statusBar(page)).toContainText("Connection: error");
});

test("the endpoint in the status bar opens the connection picker with the same-origin endpoint", async ({ page, mock }) => {
  await openWorkspace(page, "sh4-debugger");
  await statusBar(page).getByText(/^Endpoint:/).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Select Connection" })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: new RegExp(`nullDC @ 127\\.0\\.0\\.1:${mock.port}`) })).toBeChecked();
  await expect(dialog).toContainText(mock.wsURL);

  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(statusBar(page)).toContainText("Connection: connected");
});

test.fixme("a manually entered WebSocket URL connects", async ({ page, mock }) => {
  // BROKEN: ConnectionModal passes the typed URL as `connectionId`, and sessionStore.connect
  // (src/state/sessionStore.ts) only accepts ids that are already in `availableConnections`,
  // so any manual entry ends in "Selected connection not found". Not fixed here: the
  // session store is out of scope.
  const other = await startMockServer();
  try {
    await openWorkspace(page, "sh4-debugger");
    await statusBar(page).getByText(/^Endpoint:/).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: "Enter connection string manually" }).check();
    await dialog.getByPlaceholder(/Enter WebSocket URL/).fill(other.wsURL);
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(statusBar(page)).toContainText("Connection: connected");
    await expect(statusBar(page)).toContainText(`Endpoint: ${other.wsURL}`);
    expect(mock.port).not.toBe(other.port);
  } finally {
    await other.stop();
  }
});

test("the tool pages do not open a debugger connection", async ({ page, rpc }) => {
  for (const route of ["/", "/docs", "/tool/sh4-sim", "/tool/dsp-playground", "/tool/holly-core-log-analyzer"]) {
    await gotoRoute(page, route);
    await page.waitForLoadState("networkidle");
  }
  expect(rpc.sockets).toEqual([]);
});
