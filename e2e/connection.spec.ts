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
import type { Page } from "@playwright/test";
import { startMockServer } from "./support/mockServer";
import { serveScriptedDebugger } from "./support/scriptedDebugger";

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

test("killing the server mid-session: nothing stays on screen as if it were live, and the session comes back by itself", async ({
  page,
  mock,
  diagnostics,
  rpc,
}, testInfo) => {
  await openWorkspace(page, "sh4-debugger");
  const tree = panel(page, "device-tree");
  await expect(tree.getByText("SYSCLK = 200MHz")).toBeVisible();
  // paused, so that the panels have a callstack to lose
  await tooltipButton(page, "Pause").click();
  await expect(panel(page, "sh4-callstack")).toContainText("_main_loop+0x");
  expect(rpc.requests("debugger.describe")).toHaveLength(1);

  // --- the emulator dies ---
  diagnostics.allow(
    /^console\.error: WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/ws' failed/,
    "the server is down on purpose, and the page keeps trying to reach it",
  );
  await mock.stop("SIGKILL");

  await expect(statusBar(page)).toContainText("Connection: reconnecting");
  await expect(page.getByLabel("Connection: reconnecting")).toBeVisible();
  // why, and what happens next
  const notice = page.getByRole("alert").filter({ hasText: "Reconnecting to" });
  await expect(notice).toContainText(/Connection closed|Could not connect to/);
  await expect(notice).toContainText(`Reconnecting to ${mock.wsURL}`);
  await expect(connectButton(page)).toBeVisible();
  // run control is disabled
  await expect(tooltipButton(page, "Pause")).toBeDisabled();
  await expect(tooltipButton(page, "Run")).toBeDisabled();
  // the data of the lost connection is gone, the callstack with it: the panels say so
  for (const id of ["device-tree", "sh4-callstack", "watches", "sh4-disassembly", "sh4-memory"]) {
    await expect(panel(page, id), id).toContainText("No Data");
  }
  await expect(tree.getByText("SYSCLK = 200MHz")).toHaveCount(0);
  await expect(panel(page, "sh4-callstack").getByRole("listitem")).toHaveCount(0);
  await expect(panel(page, "watches")).not.toContainText("dc.sh4.cpu.pc =");
  await expect(tooltipButton(panel(page, "sh4-disassembly"), "Step In")).toBeDisabled();
  await saveScreenshot(page, testInfo, "session-reconnecting");

  // with the server still down the attempts fail, and say so in words
  await expect(notice).toContainText(`Could not connect to ${mock.wsURL}: the server is not running`);
  await expect(statusBar(page)).toContainText("Connection: reconnecting");
  const attempts = rpc.sockets.length;
  expect(attempts).toBeGreaterThanOrEqual(2);

  // --- the emulator comes back on the same port: nobody has to click anything ---
  const restarted = await startMockServer({ port: mock.port });
  try {
    // the attempts are at most 10 s apart
    await expect(statusBar(page)).toContainText("Connection: connected", { timeout: 20_000 });
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(disconnectButton(page)).toBeVisible();
    expect(rpc.sockets.length).toBeGreaterThan(attempts);
    // the new connection is described again, and it is live: pausing produces a tick that the UI follows
    await expect.poll(() => rpc.requests("debugger.describe").length).toBe(2);
    await expect(tree.getByText("SYSCLK = 200MHz")).toBeVisible();
    await expect(panel(page, "watches")).toContainText("dc.sh4.cpu.pc = 0x8C0000");
    await tooltipButton(page, "Pause").click();
    await expect(tooltipButton(page, "Run")).toBeEnabled();
    await expect(panel(page, "sh4-callstack")).toContainText("_main_loop+0x");
    // the views kept their place and show the new server's bytes
    await expect(panel(page, "sh4-memory")).toContainText("0x8C010000");
    await expect(panel(page, "sh4-disassembly").locator(".current-instruction")).toHaveCount(1);
  } finally {
    await restarted.stop();
  }
});

test("while the server is down the page tries again after 1, 2 and 5 seconds; Stop ends that, Connect starts over", async ({
  page,
  mock,
  diagnostics,
  rpc,
}) => {
  diagnostics.allow(/^console\.error: WebSocket connection to/, "the server is down on purpose");
  await openWorkspace(page, "sh4-debugger");
  await mock.stop("SIGKILL");
  const notice = page.getByRole("alert").filter({ hasText: "Reconnecting to" });
  await expect(notice).toContainText("in 1 s (attempt 1)");
  const lost = Date.now();
  const sockets = rpc.sockets.length;

  // attempt 1 at about +1 s, attempt 2 at about +3 s; attempt 3 is not before +8 s
  await expect(notice).toContainText("in 2 s (attempt 2)");
  await expect(notice).toContainText("in 5 s (attempt 3)");
  const second = Date.now() - lost;
  expect(second).toBeGreaterThanOrEqual(2500);
  expect(second).toBeLessThan(7000);
  expect(rpc.sockets.length).toBe(sockets + 2);

  // Stop: the session is over, nothing is tried any more
  await notice.getByRole("button", { name: "Stop" }).click();
  await expect(statusBar(page)).toContainText("Connection: idle");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.waitForTimeout(6000);
  expect(rpc.sockets.length).toBe(sockets + 2);

  // Connect: a new session, whose attempts start at 1 s again
  await connectButton(page).click();
  await expect(notice).toContainText("in 1 s (attempt 1)");
  await expect(statusBar(page)).toContainText("Connection: reconnecting");
  // Retry now does not wait for the timer
  const before = rpc.sockets.length;
  await notice.getByRole("button", { name: "Retry now" }).click();
  await expect.poll(() => rpc.sockets.length).toBeGreaterThan(before);
});

test("a connection the server closes is taken up again, and the server is described again", async ({ page }) => {
  // the server inside the test: it ends the connection at a known moment, and counts
  const server = await serveScriptedDebugger(page);
  await gotoRoute(page, "/workspace/sh4-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");
  await server.described();
  expect(server.connections()).toBe(1);
  await expect(panel(page, "device-tree").getByRole("treeitem").first()).toBeVisible();

  server.drop();
  await expect(statusBar(page)).toContainText("Connection: reconnecting");
  await expect(panel(page, "device-tree")).toContainText("No Data");
  // one second later the page is back, without a click
  await expect(statusBar(page)).toContainText("Connection: connected");
  await server.described();
  expect(server.connections()).toBe(2);
  expect(server.requestsOf("debugger.describe")).toHaveLength(2);
  await expect(panel(page, "device-tree").getByRole("treeitem").first()).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a failed connection attempt shows a readable error", async ({ page, mock, diagnostics }) => {
  // regression: WebSocketTransport.connect rejected with the DOM `Event` of the socket, which
  // the session store turned into the text "[object Event]"
  diagnostics.allow(/^console\.error: WebSocket connection to/, "the server is down on purpose");
  await openWorkspace(page, "sh4-debugger");
  await mock.stop("SIGKILL");
  await expect(statusBar(page)).toContainText("Connection: reconnecting");
  await connectButton(page).click();
  // the browser tells the page nothing about the failure, so the text names the endpoint and what it can be
  const alert = page.getByRole("alert").filter({ hasText: "Could not connect" });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(`Could not connect to ${mock.wsURL}: the server is not running, is not reachable or refused the connection`);
  // a refusal by the server's Host/Origin check (403) is not visible to a page: the text says that it can be one
  await expect(alert).toContainText("a refusal by the server's Host/Origin check looks the same to the page");
  await expect(page.getByRole("alert").filter({ hasText: "[object" })).toHaveCount(0);
  await expect(statusBar(page)).toContainText("Connection: reconnecting");
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

test("a manually entered WebSocket URL connects", async ({ page, mock, rpc }) => {
  const other = await startMockServer({ watches: ["dc.aica.arm7.pc"] });
  try {
    await openWorkspace(page, "sh4-debugger");
    await statusBar(page).getByText(/^Endpoint:/).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: "Enter connection string manually" }).check();
    const box = dialog.getByPlaceholder(/Enter WebSocket URL/);
    const connect = dialog.getByRole("button", { name: "Connect", exact: true });

    // only ws:// and wss:// URLs are endpoints
    await expect(connect).toBeDisabled();
    await box.fill("http://127.0.0.1:1/ws");
    await expect(dialog.getByText("Not a ws:// or wss:// URL")).toBeVisible();
    await expect(connect).toBeDisabled();

    await box.fill(other.wsURL);
    await connect.click();
    await expect(dialog).toBeHidden();
    await expect(statusBar(page)).toContainText("Connection: connected");
    await expect(statusBar(page)).toContainText(`Endpoint: ${other.wsURL}`);
    expect(mock.port).not.toBe(other.port);
    expect(rpc.sockets).toEqual([mock.wsURL, other.wsURL]);
    // the session is the other server's: described again, with its watch
    await expect(panel(page, "watches")).toContainText("dc.aica.arm7.pc = 0x002000");
    await expect(panel(page, "watches")).not.toContainText("dc.sh4.cpu.pc =");
    await expect(page.getByRole("alert")).toHaveCount(0);

    // the last manual entry is preferred to the endpoint of the page from now on: after a reload too
    await page.reload();
    await expect(statusBar(page)).toContainText("Connection: connected");
    await expect(statusBar(page)).toContainText(`Endpoint: ${other.wsURL}`);
    await expect(panel(page, "watches")).toContainText("dc.aica.arm7.pc = 0x002000");
    // the picker lists both, best first
    await statusBar(page).getByText(/^Endpoint:/).click();
    await expect(dialog.getByRole("radio", { name: /Last manual entry/ })).toBeChecked();
    await expect(dialog.getByRole("radiogroup").getByRole("radio")).toHaveCount(2);

    // picking the endpoint of the page puts the manual entry away
    await dialog.getByRole("radio", { name: new RegExp(`nullDC @ 127\\.0\\.0\\.1:${mock.port}`) }).check();
    await connect.click();
    await expect(statusBar(page)).toContainText(`Endpoint: ${mock.wsURL}`);
    await expect(panel(page, "watches")).toContainText("dc.sh4.cpu.pc = 0x8C0000");
    await page.reload();
    await expect(statusBar(page)).toContainText("Connection: connected");
    await expect(statusBar(page)).toContainText(`Endpoint: ${mock.wsURL}`);
  } finally {
    await other.stop();
  }
});

test("?ws= in front of the # selects the endpoint, and survives what the panels do to the URL", async ({ page, mock, rpc }) => {
  const other = await startMockServer({ watches: ["dc.aica.arm7.pc"] });
  try {
    // the page comes from one server, the debugger connection goes to the other
    await page.goto(`/?ws=${encodeURIComponent(other.wsURL)}#/workspace/sh4-debugger`);
    await expect(statusBar(page)).toContainText("Connection: connected");
    await expect(statusBar(page)).toContainText(`Endpoint: ${other.wsURL}`);
    expect(rpc.sockets).toEqual([other.wsURL]);
    await expect(panel(page, "watches")).toContainText("dc.aica.arm7.pc = 0x002000");

    // the memory panel rewrites the query of the hash route; ?ws= is not part of that
    const memory = panel(page, "sh4-memory");
    await memory.getByRole("textbox").fill("0x8C008120");
    await memory.getByRole("textbox").press("Enter");
    await expect(page).toHaveURL(/\?ws=.*#\/workspace\/sh4-debugger\?address=0x8C008120$/);
    await page.reload();
    await expect(statusBar(page)).toContainText(`Endpoint: ${other.wsURL}`);
    await expect(statusBar(page)).toContainText("Connection: connected");

    // the picker says where each endpoint comes from; ?ws= is first, the page's own /ws last
    await statusBar(page).getByText(/^Endpoint:/).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("radio", { name: /From the address bar \(\?ws=\)/ })).toBeChecked();
    await expect(dialog.getByRole("radio", { name: new RegExp(`nullDC @ 127\\.0\\.0\\.1:${mock.port}`) })).not.toBeChecked();
    await expect(dialog.getByRole("radiogroup").getByRole("radio")).toHaveCount(2);

    // something that is not a WebSocket URL is not an endpoint: the page's own is used
    await page.goto(`/?ws=nonsense#/workspace/sh4-debugger`);
    await page.reload();
    await expect(statusBar(page)).toContainText(`Endpoint: ${mock.wsURL}`);
    await expect(statusBar(page)).toContainText("Connection: connected");
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

test.describe("a server of another protocol version", () => {
  test.use({ mockOptions: { protocol: 4 } });

  test("the page says which, and goes on with what it understands", async ({ page }, testInfo) => {
    await openWorkspace(page, "sh4-debugger");
    const notice = page.getByRole("alert").filter({ hasText: "debugger protocol" });
    await expect(notice).toHaveText(
      "This server speaks debugger protocol 4; this UI is built for protocol 3. Parts of it may not work. Use the UI that belongs to the emulator.",
    );
    await saveScreenshot(page, testInfo, "session-protocol-mismatch");
    // the session works as far as the two agree
    await expect(panel(page, "watches")).toContainText("dc.sh4.cpu.pc = 0x8C0000");
    await pauseFromToolbar(page);
    await expect(panel(page, "sh4-disassembly").locator(".current-instruction")).toHaveCount(1);

    // put away, it stays away for this connection
    await notice.getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await tooltipButton(page, "Run").click();
    await expect(tooltipButton(page, "Pause")).toBeEnabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});
