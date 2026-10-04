import { test, expect, gotoRoute, openWorkspace, panel, statusBar, tooltipButton, KNOWN } from "./support/fixtures";
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
  expect(rpc.sent[0]).toMatchObject({ jsonrpc: "2.0", id: 1, method: "debugger.describe", params: {} });
  expect(rpc.received[0]).toMatchObject({ id: 1 });
  expect(rpc.received[0].method).toBeUndefined();
  expect(rpc.received[1]).toMatchObject({ method: "event.tick" });

  // describe -> device tree structure
  const tree = panel(page, "device-tree");
  await expect(tree.getByRole("treeitem", { name: "Dreamcast beloved console" })).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: "SH4 SH7750-alike SoC" })).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: "AICA Sound SoC" })).toBeVisible();
  // tick -> registers, watches, callstack; describe+tick -> disassembly and memory fetches
  await expect(tree.getByText("SYSCLK = 200MHz")).toBeVisible();
  await expect(panel(page, "sh4-callstack")).toContainText("SH4_func_0");
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
  await expect(panel(page, "sh4-callstack")).toContainText("SH4_func_0");
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

test.fixme("a failed connection attempt shows a readable error", async ({ page, mock, diagnostics }) => {
  // BROKEN: WebSocketTransport.connect (src/services/transport.ts) rejects with the DOM
  // `Event`, and sessionStore.connect (src/state/sessionStore.ts) does String(error), so
  // the alert reads "[object Event]". Not fixed here: transport/session are out of scope.
  diagnostics.allow(/^console\.error: (WebSocket connection to|Failed to connect)/, "the server is down on purpose");
  await openWorkspace(page, "sh4-debugger");
  await mock.stop("SIGKILL");
  await expect(statusBar(page)).toContainText("Connection: error");
  await connectButton(page).click();
  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible();
  await expect(alert).not.toContainText("[object Event]");
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

test("the tool pages do not open a debugger connection", async ({ page, diagnostics, rpc }) => {
  diagnostics.allow(...KNOWN.monacoCdn);
  for (const route of ["/", "/docs", "/tool/sh4-sim", "/tool/dsp-playground", "/tool/holly-core-log-analyzer"]) {
    await gotoRoute(page, route);
    await page.waitForLoadState("networkidle");
  }
  expect(rpc.sockets).toEqual([]);
});
