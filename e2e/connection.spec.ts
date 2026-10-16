import {
  test,
  expect,
  disassemblyRows,
  gotoRoute,
  openWorkspace,
  panel,
  pauseFromToolbar,
  recordText,
  saveScreenshot,
  statusBar,
  tooltipButton,
  treeItem,
} from "./support/fixtures";
import type { Locator, Page } from "@playwright/test";
import { findFreePort, startMockServer } from "./support/mockServer";
import { defaultAnswer, serveScriptedDebugger } from "./support/scriptedDebugger";

const connectButton = (page: Page) => page.getByRole("button", { name: "Connect", exact: true });
const disconnectButton = (page: Page) => page.getByRole("button", { name: "Disconnect", exact: true });

/**
 * The entry of the connection picker that is labelled `label`: the host of the endpoint, or
 * "<emulator> @ <host>" once the emulator there has described itself. The URL of the endpoint,
 * and where it comes from, follow the label in the name of the entry.
 */
const pickerEntry = (dialog: Locator, label: string) =>
  dialog.getByRole("radio", { name: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\d.:])`) });

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
    params: { protocol: 3, client: expect.stringMatching(/^Dreamcast DevTools 3\.\d+\.\d+/) },
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
  // the disassembly opens where the target is in the first tick, the memory at the target's default address
  await expect(panel(page, "sh4-disassembly")).toContainText("0x8C0000A0");
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
  // something typed and not sent yet, in the boxes of four panels
  const watchBox = panel(page, "watches").getByPlaceholder("Enter expression");
  const breakpointBox = panel(page, "sh4-breakpoints").getByPlaceholder("Address (e.g., 0x8C0000A0)");
  const disassemblyBox = panel(page, "sh4-disassembly").getByRole("textbox");
  const memoryBox = panel(page, "sh4-memory").getByRole("textbox");
  await watchBox.fill("dc.sh4.cpu.pr");
  await breakpointBox.fill("0x8C0000A8");
  // the address boxes say where their views are until somebody types into them
  await expect(disassemblyBox).toHaveValue(/^0x8C0000[0-9A-F]{2}$/);
  await expect(memoryBox).toHaveValue("0x8C0100A0");
  await disassemblyBox.fill("0x8C00");
  await memoryBox.fill("0x8C01");

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
  // the data of the lost connection is gone, the callstack with it: where it was, each panel says that there is no connection
  for (const id of ["device-tree", "sh4-callstack", "watches", "sh4-disassembly", "sh4-memory", "sh4-breakpoints"]) {
    await expect(panel(page, id), id).toContainText("Not connected");
    await expect(panel(page, id), id).not.toContainText("No Data");
  }
  await expect(tree.getByText("SYSCLK = 200MHz")).toHaveCount(0);
  await expect(panel(page, "sh4-callstack").getByRole("listitem")).toHaveCount(0);
  await expect(panel(page, "watches")).not.toContainText("dc.sh4.cpu.pc =");
  await expect(panel(page, "sh4-breakpoints")).not.toContainText("No breakpoints defined.");
  await expect(tooltipButton(panel(page, "sh4-disassembly"), "Step In")).toBeDisabled();
  // Only the data: the boxes are there, with what was typed. Nothing can be added now, and
  // trying leaves the text where it is.
  await expect(watchBox).toHaveValue("dc.sh4.cpu.pr");
  await expect(breakpointBox).toHaveValue("0x8C0000A8");
  // the views have not moved: their boxes are not written over with where they are
  await expect(disassemblyBox).toHaveValue("0x8C00");
  await expect(memoryBox).toHaveValue("0x8C01");
  await watchBox.press("Enter");
  await breakpointBox.press("Enter");
  for (const button of [
    panel(page, "watches").getByRole("button", { name: "Add Watch" }),
    panel(page, "sh4-breakpoints").getByRole("button", { name: "Add", exact: true }),
  ]) {
    await expect(button).toHaveAttribute("aria-disabled", "true");
    await button.click({ force: true });
  }
  await expect(watchBox).toHaveValue("dc.sh4.cpu.pr");
  await expect(breakpointBox).toHaveValue("0x8C0000A8");
  await expect(disassemblyBox).toHaveValue("0x8C00");
  await expect(memoryBox).toHaveValue("0x8C01");
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
    // The views kept their place and read the new server's lines and bytes there. Their boxes
    // still say what was being typed: a server that is described again (the same addresses, in
    // the same format) is no reason to write over it.
    await expect(disassemblyRows(panel(page, "sh4-disassembly"))).toHaveCount(64);
    await expect(panel(page, "sh4-memory")).toContainText("0x8C010000");
    await expect(disassemblyBox).toHaveValue("0x8C00");
    await expect(memoryBox).toHaveValue("0x8C01");
    await tooltipButton(page, "Pause").click();
    await expect(tooltipButton(page, "Run")).toBeEnabled();
    await expect(panel(page, "sh4-callstack")).toContainText("_main_loop+0x");
    // the views kept their place and show the new server's bytes
    await expect(panel(page, "sh4-memory")).toContainText("0x8C010000");
    await expect(panel(page, "sh4-disassembly").locator(".current-instruction")).toHaveCount(1);
    // what was typed while the server was away is sent now
    await expect(watchBox).toHaveValue("dc.sh4.cpu.pr");
    await watchBox.press("Enter");
    await expect(panel(page, "watches")).toContainText("dc.sh4.cpu.pr = 0x8C000");
    await expect(watchBox).toHaveValue("");
    await expect(breakpointBox).toHaveValue("0x8C0000A8");
    await panel(page, "sh4-breakpoints").getByRole("button", { name: "Add", exact: true }).click();
    await expect(panel(page, "sh4-breakpoints").getByRole("listitem")).toHaveText(/dc\.sh4\.cpu\.pc == 0x8C0000A8/);
    await expect(breakpointBox).toHaveValue("");
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
  // what the notice says changes within a second: it is recorded, not looked for
  const said = await recordText(page, '[role="alert"]');
  const announced = async () =>
    (await said()).flatMap(({ at, text }) => {
      const attempt = /Reconnecting to \S+ in (\d+) s \(attempt (\d+)\)/.exec(text);
      return attempt ? [{ at, wait: Number(attempt[1]), attempt: Number(attempt[2]) }] : [];
    });
  await openWorkspace(page, "sh4-debugger");
  const sockets = rpc.sockets.length;
  await mock.stop("SIGKILL");
  const notice = page.getByRole("alert").filter({ hasText: "Reconnecting to" });

  // the third attempt is announced when the first two have failed, and waits five seconds
  await expect(notice).toContainText("in 5 s (attempt 3)");
  const attempts = await announced();
  expect(attempts.map(({ wait, attempt }) => ({ wait, attempt }))).toEqual([
    { wait: 1, attempt: 1 },
    { wait: 2, attempt: 2 },
    { wait: 5, attempt: 3 },
  ]);
  // each was announced when the one before it had waited its time and failed (the times are
  // those at which the page showed the text, a few milliseconds after the timer was set)
  expect(attempts[1].at - attempts[0].at).toBeGreaterThanOrEqual(900);
  expect(attempts[2].at - attempts[1].at).toBeGreaterThanOrEqual(1900);
  expect(rpc.sockets.length).toBe(sockets + 2);

  // Stop: the session is over, nothing is tried any more
  await notice.getByRole("button", { name: "Stop" }).click();
  await expect(statusBar(page)).toContainText("Connection: idle");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.waitForTimeout(6000);
  expect(rpc.sockets.length).toBe(sockets + 2);

  // Connect: a new session, whose attempts start at 1 s again
  await connectButton(page).click();
  await expect(statusBar(page)).toContainText("Connection: reconnecting");
  await expect.poll(async () => (await announced()).slice(attempts.length)[0]).toMatchObject({ wait: 1, attempt: 1 });
  // Retry now does not wait for the timer
  const before = rpc.sockets.length;
  await notice.getByRole("button", { name: "Retry now" }).click();
  await expect.poll(() => rpc.sockets.length).toBeGreaterThan(before);
});

test("a connection the server closes is taken up again, and the server is described again", async ({ page }) => {
  // the server inside the test: it ends the connection at a known moment, and counts
  const server = await serveScriptedDebugger(page);
  const states = await recordText(page, "footer");
  const tree = await recordText(page, '[data-panel-id="device-tree"]');
  await gotoRoute(page, "/workspace/sh4-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");
  await server.described();
  expect(server.connections()).toBe(1);
  await expect(panel(page, "device-tree").getByRole("treeitem").first()).toBeVisible();

  server.drop();
  // one second later the page is back, without a click
  await expect.poll(() => server.connections()).toBe(2);
  await server.described();
  await expect(statusBar(page)).toContainText("Connection: connected");
  expect(server.requestsOf("debugger.describe")).toHaveLength(2);
  // in between it said that it was reconnecting, and that there was no connection where the data had been
  // (textContent runs the cells of the status bar together: "Connection: connectedEndpoint: ws://...")
  const sequence = (await states()).map(({ text }) => /Connection: ([a-z]+)/.exec(text)?.[1]).filter(Boolean);
  expect(sequence.slice(-3)).toEqual(["connected", "reconnecting", "connected"]);
  expect((await tree()).some(({ text }) => text.includes("Not connected"))).toBe(true);
  const lost = (await states()).find(({ text }) => text.includes("Connection: reconnecting"))!.at;
  const back = (await states()).findLast(({ text }) => text.includes("Connection: connected"))!.at;
  expect(back - lost).toBeGreaterThanOrEqual(900);
  await expect(panel(page, "device-tree").getByRole("treeitem").first()).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("when a lost connection is back the disassembly is where it was, unless the new connection starts in a stop", async ({ page }) => {
  const server = await serveScriptedDebugger(page);
  server.state.execution = { state: "running", stopId: 0 };
  await gotoRoute(page, "/workspace/sh4-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");
  await server.described();
  const view = panel(page, "sh4-disassembly");
  const rows = disassemblyRows(view);
  const box = view.getByRole("textbox");
  const pc = 0x8c001000;
  const listings = () => server.requestsOf("state.getDisassembly").map((params) => params.address);
  // it opened where the target runs; the user looks at code elsewhere
  await expect(rows.first()).toHaveAttribute("data-address", String(pc - 20));
  const away = 0x8c004000;
  await box.fill("0x8C004000");
  await box.press("Enter");
  await expect(rows.first()).toHaveAttribute("data-address", String(away - 20));
  expect(listings()).toEqual([pc - 20, away - 20]);

  // --- the connection is lost and comes back, the target still running ---
  server.drop();
  await expect.poll(() => server.connections()).toBe(2);
  await server.described();
  await expect(statusBar(page)).toContainText("Connection: connected");
  // the view reads its lines again, where it was: a running target is not followed
  await expect.poll(listings).toEqual([pc - 20, away - 20, away - 20]);
  await expect(rows).toHaveCount(64);
  await page.waitForTimeout(500);
  expect(listings()).toEqual([pc - 20, away - 20, away - 20]);
  await expect(rows.first()).toHaveAttribute("data-address", String(away - 20));
  await expect(box).toHaveValue("0x8C004000");

  // --- lost again; this time the server is in a stop when the page is back: that one is followed ---
  server.state.execution = { state: "paused", stopId: 1, reason: "pause" };
  server.drop();
  await expect.poll(() => server.connections()).toBe(3);
  await server.described();
  await expect(view.locator(".current-instruction")).toHaveAttribute("data-address", String(pc));
  await expect(view.locator(".current-instruction")).toBeInViewport({ ratio: 1 });
  await expect(rows.first()).toHaveAttribute("data-address", String(pc - 20));
});

test("an address box keeps what is typed into it when the connection is back, and follows a server that writes its addresses in another way", async ({
  page,
}) => {
  const server = await serveScriptedDebugger(page);
  // running: a new connection has no stop to follow, and the views stay where they are
  server.state.execution = { state: "running", stopId: 0 };
  await gotoRoute(page, "/workspace/sh4-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");
  await server.described();
  const view = panel(page, "sh4-disassembly");
  const memory = panel(page, "sh4-memory");
  const disassemblyBox = view.getByRole("textbox");
  const memoryBox = memory.getByRole("textbox");
  // the boxes say where the views are
  await expect(disassemblyBox).toHaveValue("0x8C001000");
  await expect(memoryBox).toHaveValue("0x8C0100A0");
  // typed, and not sent: the user is still typing in the second
  await disassemblyBox.fill("0x8C00");
  await memoryBox.fill("0x8C01");

  // --- the page's connection ends, and the same server describes itself again ---
  server.drop();
  await expect.poll(() => server.connections()).toBe(2);
  await server.described();
  await expect(statusBar(page)).toContainText("Connection: connected");
  await expect(disassemblyRows(view)).toHaveCount(64);
  await expect(memory).toContainText("0x8C010000");
  // nothing has moved: the boxes are not written over with where the views are
  await expect(disassemblyBox).toHaveValue("0x8C00");
  await expect(memoryBox).toHaveValue("0x8C01");
  await expect(memoryBox).toBeFocused();

  // --- the next server writes the addresses of the SH4 with ten digits ---
  (server.shape.targets as Array<Record<string, unknown>>)[0].addressDigits = 10;
  server.drop();
  await expect.poll(() => server.connections()).toBe(3);
  await server.described();
  // what was typed is an address as the last server wrote them: the boxes say where the
  // views are, as this one does
  await expect(disassemblyBox).toHaveValue("0x008C001000");
  await expect(memoryBox).toHaveValue("0x008C0100A0");
  await expect(disassemblyRows(view).first()).toContainText("0x008C000FEC");
});

test("the keyboard focus is where it was when a lost connection is back", async ({ page }) => {
  // the scripted server is paused, so Run and the step buttons can be used
  const server = await serveScriptedDebugger(page);
  // the server has a breakpoint and a watch, and keeps them over a reconnect, as servers do
  server.state.breakpoints = { "1": { id: 1, event: "dc.sh4.cpu.pc", address: 0x8c001004, kind: "code", enabled: true } };
  server.state.watches = [{ id: 1, expression: "dc.sh4.cpu.pc", value: "0x8C001000" }];
  const treeTexts = await recordText(page, '[data-panel-id="device-tree"]');
  await gotoRoute(page, "/workspace/sh4-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");
  await server.described();
  const view = panel(page, "sh4-disassembly");
  await expect(view.locator(".current-instruction")).toHaveCount(1);
  const search = panel(page, "device-tree").getByPlaceholder("Search components...");
  const breakpoint = panel(page, "sh4-breakpoints").getByRole("listitem");
  await expect(breakpoint).toHaveText(/dc\.sh4\.cpu\.pc == 0x8C001004/);

  const places: Array<[string, Locator]> = [
    ["the search box of the device tree", search],
    ["a node of the device tree", treeItem(page, "dc.sh4")],
    ["Step In", tooltipButton(view, "Step In")],
    ["Run", tooltipButton(page, "Run")],
    // cannot be used while the connection is away: there is no program counter then
    ["Go to current PC", tooltipButton(view, "Go to current PC")],
    // cannot be used while the view reads, which it does when the connection is back
    ["Refresh of the disassembly", tooltipButton(view, "Refresh")],
    ["Refresh of the memory", tooltipButton(panel(page, "sh4-memory"), "Refresh")],
    // the boxes of the panels, and the buttons next to them
    ["the address box of the disassembly", view.getByRole("textbox")],
    ["the address box of the memory", panel(page, "sh4-memory").getByRole("textbox")],
    ["the expression box of the watches", panel(page, "watches").getByPlaceholder("Enter expression")],
    ["Add Watch", panel(page, "watches").getByRole("button", { name: "Add Watch" })],
    ["the address box of the breakpoints", panel(page, "sh4-breakpoints").getByPlaceholder("Address (e.g., 0x8C0000A0)")],
    // The rows of the lists are the server's: they go with the connection and are back with
    // it. A control in a row that had the focus has it again.
    ["the enable switch of a breakpoint", breakpoint.getByRole("switch")],
    ["Remove of a breakpoint", tooltipButton(breakpoint, "Remove breakpoint")],
    ["Remove of a watch", panel(page, "watches").getByRole("button", { name: "Remove dc.sh4.cpu.pc" })],
  ];
  let connections = 1;
  for (const [name, place] of places) {
    await test.step(name, async () => {
      await place.focus();
      await expect(place).toBeFocused();
      if (place === search) {
        await page.keyboard.type("tmu");
      }

      server.drop();
      // one second later the page is back by itself
      await expect.poll(() => server.connections()).toBe(++connections);
      await server.described();
      await expect(statusBar(page)).toContainText("Connection: connected");
      await expect(view.locator(".current-instruction")).toHaveCount(1);
      await expect(treeItem(page, "dc.sh4")).toBeVisible();

      await expect(place).toBeFocused();
      if (place === search) {
        // what was typed is still there, and is still what the tree shows
        await expect(search).toHaveValue("tmu");
        await expect(treeItem(page, "dc.sh4.tmu")).toBeVisible();
        await expect(treeItem(page, "dc.aica")).toHaveCount(0);
        await search.fill("");
      }
    });
  }
  // every time the tree had gone in between, with the data of the lost connection
  const without = (await treeTexts()).filter(({ text }) => text.includes("Not connected"));
  expect(without.length).toBeGreaterThanOrEqual(places.length);

  // A control of a row gets the focus back only when the focus is nowhere (on the page body).
  // Where the user has put it while the connection was away it stays: taken back to "Remove",
  // the next Enter or Space in the search box would remove a breakpoint.
  await test.step("the focus is moved while the connection is away: it stays where it was put", async () => {
    const remove = tooltipButton(breakpoint, "Remove breakpoint");
    await remove.focus();
    await expect(remove).toBeFocused();
    // the server takes its time to describe itself on the next connection: until it has,
    // the page has no rows, and the user is somewhere else
    let describe = () => {};
    const asked = new Promise<void>((resolve) => {
      describe = resolve;
    });
    server.answer("debugger.describe", async () => {
      await asked;
      // the tick of a new connection, behind the answer
      setTimeout(() => server.tick(), 0);
      return server.shape;
    });
    server.drop();
    await expect(breakpoint).toHaveCount(0);
    await search.focus();
    await expect(search).toBeFocused();
    await expect.poll(() => server.requestsOf("debugger.describe").length).toBe(connections + 1);
    describe();

    // the rows are back, and what keeps their focus has had the sixty frames it looks during
    await expect(breakpoint).toHaveText(/dc\.sh4\.cpu\.pc == 0x8C001004/);
    await expect(remove).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(search).toBeFocused();
    await expect(remove).not.toBeFocused();
  });
});

test("a step button that cannot be used keeps the focus and does nothing: stepping with the keyboard goes on from where it is", async ({
  page,
}) => {
  const server = await serveScriptedDebugger(page);
  // like a real server: the target runs for a moment, and stops again one instruction on
  let pc = 0x8c001000;
  let stopId = 1;
  server.answer("control.step", () => {
    server.state.execution = { state: "running", stopId };
    server.tick();
    return {};
  });
  await gotoRoute(page, "/workspace/sh4-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");
  await server.described();
  const view = panel(page, "sh4-disassembly");
  const marked = view.locator(".current-instruction");
  await expect(marked).toHaveAttribute("data-address", String(pc));
  const stepIn = tooltipButton(view, "Step In");
  const status = page.getByRole("status", { name: "Execution state" });

  await stepIn.focus();
  await page.keyboard.press("Enter");
  await expect(status).toHaveText("Running");
  expect(server.requestsOf("control.step")).toHaveLength(1);
  // while the target runs the button cannot be used, says so, and still has the focus
  await expect(stepIn).toBeDisabled();
  await expect(stepIn).toHaveAttribute("aria-disabled", "true");
  await expect(stepIn).toBeFocused();
  // pressing it now asks the server for nothing
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  await stepIn.click({ force: true });

  // the step is done: the same key steps again, without a Tab back to the button
  pc += 2;
  server.state.execution = { state: "paused", stopId: ++stopId, reason: "step" };
  server.setRegister("dc.sh4.cpu", "PC", `0x${pc.toString(16).toUpperCase()}`);
  server.tick();
  await expect(marked).toHaveAttribute("data-address", String(pc));
  await expect(stepIn).toBeEnabled();
  await expect(stepIn).not.toHaveAttribute("aria-disabled");
  await expect(stepIn).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(status).toHaveText("Running");
  expect(server.requestsOf("control.step")).toHaveLength(2);

  // the same for the run controls of the toolbar: Run cannot be used while the target runs
  const run = tooltipButton(page, "Run");
  await expect(run).toBeDisabled();
  await run.focus();
  await page.keyboard.press("Enter");
  await run.click({ force: true });
  server.state.execution = { state: "paused", stopId: ++stopId, reason: "step" };
  server.tick();
  await expect(run).toBeEnabled();
  await expect(run).toBeFocused();
  expect(server.requestsOf("control.runUntil")).toEqual([]);
  await page.keyboard.press("Enter");
  await expect.poll(() => server.requestsOf("control.runUntil")).toHaveLength(1);
});

test("Refresh keeps the focus while its view reads: refreshing with the keyboard goes on from where it is", async ({ page }) => {
  // a server that takes its time to read: its answers wait for `release`
  const server = await serveScriptedDebugger(page);
  let holding = false;
  const held: Array<() => void> = [];
  const release = () => {
    holding = false;
    held.splice(0).forEach((answer) => answer());
  };
  for (const method of ["state.getDisassembly", "state.getMemorySlice"] as const) {
    server.answer(method, (params) =>
      holding ? new Promise((resolve) => held.push(() => resolve(defaultAnswer(method, params)))) : defaultAnswer(method, params),
    );
  }
  await gotoRoute(page, "/workspace/sh4-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");
  await server.described();
  await expect(panel(page, "sh4-disassembly").locator(".current-instruction")).toHaveCount(1);
  await expect(panel(page, "sh4-memory")).toContainText("0x8C010000");

  for (const [id, method] of [
    ["sh4-disassembly", "state.getDisassembly"],
    ["sh4-memory", "state.getMemorySlice"],
  ] as const) {
    await test.step(`Refresh of ${id}`, async () => {
      const refresh = tooltipButton(panel(page, id), "Refresh");
      const reads = () => server.requestsOf(method).length;
      await expect(refresh).toBeEnabled();
      const before = reads();

      await refresh.focus();
      holding = true;
      await page.keyboard.press("Enter");
      await expect.poll(reads).toBe(before + 1);
      // while the view reads the button cannot be used, says so, and still has the focus
      await expect(refresh).toBeDisabled();
      await expect(refresh).toHaveAttribute("aria-disabled", "true");
      await expect(refresh).toBeFocused();
      // pressing it now asks the server for nothing
      await page.keyboard.press("Enter");
      await page.keyboard.press("Space");
      await refresh.click({ force: true });
      expect(reads()).toBe(before + 1);

      // the answer is in: the same key reads again, without a Tab back to the button
      release();
      await expect(refresh).toBeEnabled();
      await expect(refresh).not.toHaveAttribute("aria-disabled");
      await expect(refresh).toBeFocused();
      await page.keyboard.press("Enter");
      await expect.poll(reads).toBe(before + 2);
      await expect(refresh).toBeEnabled();
      await expect(refresh).toBeFocused();

      // a stop makes the view read by itself: that does not take the focus either
      holding = true;
      server.state.execution = { state: "paused", stopId: (server.state.execution.stopId as number) + 1, reason: "step" };
      server.tick();
      await expect.poll(reads).toBe(before + 3);
      await expect(refresh).toBeDisabled();
      await expect(refresh).toBeFocused();
      release();
      await expect(refresh).toBeEnabled();
      await expect(refresh).toBeFocused();
    });
  }
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
  // the emulator there has described itself: the entry has the name it gave, in front of the host
  await expect(pickerEntry(dialog, `nullDC (mock) @ 127.0.0.1:${mock.port}`)).toBeChecked();
  await expect(dialog).toContainText(mock.wsURL);

  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(statusBar(page)).toContainText("Connection: connected");
});

test("an endpoint in the picker is its host until the emulator there has described itself, then <the name it gave> @ <host>", async ({
  page,
  mock,
}) => {
  // an emulator that is not called nullDC, and answers debugger.describe when the test says so
  const server = await serveScriptedDebugger(page);
  const describedAs = (name: string) => {
    server.shape = { ...server.shape, emulator: { name, version: "e2e", build: "native" } };
  };
  describedAs("Other Emu");
  const held: Array<() => void> = [];
  server.answer("debugger.describe", () => new Promise((resolve) => held.push(() => resolve(server.shape))));
  const host = `127.0.0.1:${mock.port}`;

  await gotoRoute(page, "/workspace/sh4-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");
  await expect.poll(() => held.length).toBe(1);
  await statusBar(page).getByText(/^Endpoint:/).click();
  const dialog = page.getByRole("dialog");
  // connected, and the emulator has not answered yet: the host alone
  await expect(pickerEntry(dialog, host)).toBeChecked();
  await expect(dialog.getByRole("radiogroup").getByRole("radio")).toHaveCount(1);
  await expect(dialog).not.toContainText("Other Emu");

  // its answer names it, in the picker that is open
  held.shift()?.();
  await expect(pickerEntry(dialog, `Other Emu @ ${host}`)).toBeChecked();
  await expect(dialog.getByRole("radiogroup").getByRole("radio")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // The connection is lost, and the page is back on its own. The server there now is another
  // one: until it has answered, the name of the one before is not shown.
  describedAs("Another Emu");
  server.drop();
  await expect.poll(() => held.length).toBe(1);
  expect(server.connections()).toBe(2);
  await expect(statusBar(page)).toContainText("Connection: connected");
  await statusBar(page).getByText(/^Endpoint:/).click();
  await expect(pickerEntry(dialog, host)).toBeChecked();
  await expect(dialog).not.toContainText(" @ ");
  held.shift()?.();
  await expect(pickerEntry(dialog, `Another Emu @ ${host}`)).toBeChecked();
  await page.keyboard.press("Escape");

  // disconnected: nobody is known to be there
  await disconnectButton(page).click();
  await expect(statusBar(page)).toContainText("Connection: idle");
  await statusBar(page).getByText(/^Endpoint:/).click();
  await expect(pickerEntry(dialog, host)).toBeChecked();
  await expect(dialog).not.toContainText(" @ ");
});

test("the endpoint in the status bar is a button: the connection picker opens from the keyboard", async ({ page, mock }) => {
  await openWorkspace(page, "sh4-debugger");
  // its name is what it shows, and Tab stops at it
  const endpoint = statusBar(page).getByRole("button", { name: `Endpoint: ${mock.wsURL}`, exact: true });
  await expect(endpoint).toBeVisible();
  expect(await endpoint.evaluate((element) => (element as HTMLElement).tabIndex)).toBe(0);
  const dialog = page.getByRole("dialog");

  for (const key of ["Enter", "Space"]) {
    await endpoint.focus();
    await page.keyboard.press(key);
    await expect(dialog.getByRole("heading", { name: "Select Connection" })).toBeVisible();
    // the way to the box for another endpoint, without a mouse
    await dialog.getByRole("radio", { name: "Enter connection string manually" }).check();
    await expect(dialog.getByPlaceholder(/Enter WebSocket URL/)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(endpoint).toBeFocused();
  }
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
    // the one the session is connected to has the emulator's name; the page's own, where the
    // session is not connected, its host alone
    await expect(pickerEntry(dialog, `nullDC (mock) @ 127.0.0.1:${other.port}`)).toBeChecked();
    await expect(dialog.getByRole("radio", { name: /Last manual entry/ })).toBeChecked();
    await expect(pickerEntry(dialog, `127.0.0.1:${mock.port}`)).not.toBeChecked();
    await expect(dialog.getByRole("radiogroup").getByRole("radio")).toHaveCount(2);

    // picking the endpoint of the page puts the manual entry away
    await pickerEntry(dialog, `127.0.0.1:${mock.port}`).check();
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
    await expect(pickerEntry(dialog, `nullDC (mock) @ 127.0.0.1:${other.port}`)).toBeChecked();
    await expect(pickerEntry(dialog, `127.0.0.1:${mock.port}`)).not.toBeChecked();
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

test("an endpoint named by ?ws= that does not answer is tried again, and the page's own is not taken in its place", async ({
  page,
  mock,
  rpc,
  diagnostics,
}) => {
  // The endpoints of a page are a priority, not a chain to fall down. The server that served
  // this page has a debugger at /ws and would answer; the page was told to use another.
  diagnostics.allow(/^console\.error: WebSocket connection to/, "nothing listens at the endpoint the page was given");
  const named = `ws://127.0.0.1:${await findFreePort()}/ws`;
  await page.goto(`/?ws=${encodeURIComponent(named)}#/workspace/sh4-debugger`);
  await expect(statusBar(page)).toContainText("Connection: reconnecting");
  await expect(statusBar(page)).toContainText(`Endpoint: ${named}`);
  const notice = page.getByRole("alert").filter({ hasText: "Reconnecting to" });
  await expect(notice).toContainText(`Reconnecting to ${named}`);
  await expect(panel(page, "device-tree")).toContainText("Not connected");

  // No server has been there yet, and every panel has its frame all the same. The views have
  // their toolbars: nothing in the box, since no server has said where they open, and nothing
  // that can be used yet.
  const disassembly = panel(page, "sh4-disassembly");
  const memory = panel(page, "sh4-memory");
  for (const view of [disassembly, memory]) {
    await expect(view).toContainText("Not connected");
    await expect(view.getByRole("textbox")).toBeDisabled();
    await expect(view.getByRole("textbox")).toHaveValue("");
    await expect(view.getByRole("button", { name: "Go", exact: true })).toBeDisabled();
    await expect(view.getByRole("button", { name: "Refresh", exact: true })).toHaveAttribute("aria-disabled", "true");
  }
  for (const name of ["Step Over", "Step In", "Step Out", "Go to current PC"]) {
    await expect(disassembly.getByRole("button", { name, exact: true }), name).toHaveAttribute("aria-disabled", "true");
  }
  await expect(panel(page, "device-tree").getByPlaceholder("Search components...")).toBeVisible();
  await expect(panel(page, "watches").getByPlaceholder("Enter expression")).toBeVisible();
  await expect(panel(page, "sh4-breakpoints").getByPlaceholder("Address (e.g., 0x8C0000A0)")).toBeVisible();

  // the first attempt and the two after 1 and 2 seconds have failed: the next is for the same endpoint
  await expect(notice).toContainText(`Reconnecting to ${named} in 5 s (attempt 3)`);
  expect(rpc.sockets).toEqual([named, named, named]);
  // and so is the one of Retry now
  await notice.getByRole("button", { name: "Retry now" }).click();
  await expect.poll(() => rpc.sockets.length).toBe(4);
  expect(rpc.sockets).not.toContain(mock.wsURL);
  expect(new Set(rpc.sockets)).toEqual(new Set([named]));
  await expect(statusBar(page)).toContainText(`Endpoint: ${named}`);

  // the page's own endpoint is there to be picked, by the user
  await statusBar(page).getByText(/^Endpoint:/).click();
  const dialog = page.getByRole("dialog");
  // nothing has answered at either endpoint: each entry is its host alone
  const namedHost = new URL(named).host;
  await expect(dialog.getByRole("radio", { name: /From the address bar \(\?ws=\)/ })).toBeChecked();
  await expect(pickerEntry(dialog, namedHost)).toBeChecked();
  await expect(pickerEntry(dialog, `127.0.0.1:${mock.port}`)).not.toBeChecked();
  await expect(dialog).not.toContainText(" @ ");
  await pickerEntry(dialog, `127.0.0.1:${mock.port}`).check();
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(statusBar(page)).toContainText("Connection: connected");
  await expect(statusBar(page)).toContainText(`Endpoint: ${mock.wsURL}`);
  // now the page's own has answered, and the one of ?ws= still has not
  await statusBar(page).getByText(/^Endpoint:/).click();
  await expect(pickerEntry(dialog, `nullDC (mock) @ 127.0.0.1:${mock.port}`)).toBeChecked();
  await expect(pickerEntry(dialog, namedHost)).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();

  // with a server the views open where it says, and their toolbars are there to be used
  await expect(disassemblyRows(disassembly)).toHaveCount(64);
  await expect(disassembly.getByRole("textbox")).toHaveValue(/^0x8C0000[0-9A-F]{2}$/);
  await expect(memory.getByRole("textbox")).toHaveValue("0x8C0100A0");
  await expect(memory).toContainText(/0x8C010000\s*([0-9A-F]{2} ){15}/);
  for (const view of [disassembly, memory]) {
    await expect(view.getByRole("textbox")).toBeEnabled();
    await expect(view.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
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
