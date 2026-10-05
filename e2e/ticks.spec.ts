import {
  test,
  expect,
  gotoRoute,
  panel,
  registerRow,
  saveScreenshot,
  statusBar,
  tooltipButton,
  treeItemRow,
  type WorkspaceId,
} from "./support/fixtures";
import type { Page } from "@playwright/test";
import { inBandError, jsonRpcError, serveScriptedDebugger, type ScriptedDebugger } from "./support/scriptedDebugger";

// What the client does with a tick, against a server that sends exactly the ticks the test
// asks for (the mock sends its own): registers are merged per path, a stop is acted on once,
// the category state is the server's, and a message the client cannot use is reported.

/** Opens a workspace on the scripted server. `prepare` changes the server before the page connects. */
const open = async (page: Page, workspace: WorkspaceId, prepare?: (server: ScriptedDebugger) => void | Promise<void>) => {
  const server = await serveScriptedDebugger(page);
  await prepare?.(server);
  await gotoRoute(page, `/workspace/${workspace}`);
  await expect(statusBar(page)).toContainText("Connection: connected");
  await server.described();
  return server;
};

/**
 * Sends a tick and waits until the page has applied it: every tick sent this way changes a
 * text register of the root node, which the device tree shows.
 */
let marker = 0;
const tickAndWait = async (page: Page, server: ScriptedDebugger, options?: Parameters<ScriptedDebugger["tick"]>[0]) => {
  const value = `mark-${++marker}`;
  server.setRegister("dc", "SYSCLK", value);
  server.tick(options ? { ...options, paths: options.paths ? [...options.paths, "dc"] : undefined } : undefined);
  await expect(registerRow(page, "dc.reg.SYSCLK")).toHaveText(`SYSCLK = ${value}`);
};

test("registers are merged per path: a path a tick does not carry keeps what it had", async ({ page }) => {
  const server = await open(page, "sh4-debugger");
  await treeItemRow(page, "dc.sh4.cpu").click();
  await treeItemRow(page, "dc.sh4.tmu").click();
  const pc = registerRow(page, "dc.sh4.cpu.reg.PC");
  const tcnt = registerRow(page, "dc.sh4.tmu.reg.TCNT0");
  await expect(pc).toHaveText("PC = 0x8C001000");
  await expect(tcnt).toHaveText("TCNT0 = 0xFFFFFFFF");

  // a running tick carries the processors and the time, and nothing else
  server.state.execution = { state: "running", stopId: 1 };
  server.setRegister("dc.sh4.cpu", "PC", "0x8C001002");
  server.setRegister("dc.sh4.tmu", "TCNT0", "0x00001234");
  await tickAndWait(page, server, { paths: ["dc.sh4.cpu", "dc.aica.arm7", "dc.aica.dsp", "dc.timing"] });
  await expect(pc).toHaveText("PC = 0x8C001002");
  // the timer was not in that tick: it shows what the last tick that carried it said
  await expect(tcnt).toHaveText("TCNT0 = 0xFFFFFFFF");

  // a tick with only the timer: the processor keeps its value in turn
  server.setRegister("dc.sh4.cpu", "PC", "0x8C001004");
  await tickAndWait(page, server, { paths: ["dc.sh4.tmu"] });
  await expect(tcnt).toHaveText("TCNT0 = 0x00001234");
  await expect(pc).toHaveText("PC = 0x8C001002");

  // a path that is present replaces its list: a full tick updates everything
  await tickAndWait(page, server);
  await expect(pc).toHaveText("PC = 0x8C001004");
  await expect(tcnt).toHaveText("TCNT0 = 0x00001234");
});

test("nothing of a connection is left in the next one: registers and callstack start empty", async ({ page }) => {
  const server = await open(page, "sh4-debugger", (scripted) => {
    scripted.state.callstacks = { sh4: [{ index: 0, pc: 0x8c001000, symbol: "_first_session+0x0" }], arm7: [] };
  });
  await treeItemRow(page, "dc.sh4.tmu").click();
  server.setRegister("dc.sh4.tmu", "TCNT0", "0x11111111");
  await tickAndWait(page, server);
  await expect(registerRow(page, "dc.sh4.tmu.reg.TCNT0")).toHaveText("TCNT0 = 0x11111111");
  await expect(panel(page, "sh4-callstack")).toContainText("_first_session+0x0");

  // The next connection is to a server that describes the timer with another value and then
  // sends a tick without the timer and without callstacks. What the client shows for both is
  // what this connection said, not what the last one left behind.
  server.setRegister("dc.sh4.tmu", "TCNT0", "0x22222222");
  server.describeAgain();
  server.afterDescribe = { paths: ["dc", "dc.sh4.cpu"], patch: { callstacks: undefined } };
  server.drop();
  await expect(statusBar(page)).toContainText("Connection: reconnecting");
  await expect(statusBar(page)).toContainText("Connection: connected");
  await server.described();
  expect(server.connections()).toBe(2);

  await expect(registerRow(page, "dc.sh4.tmu.reg.TCNT0")).toHaveText("TCNT0 = 0x22222222");
  await expect(panel(page, "sh4-callstack")).toContainText("Empty callstack.");
  await expect(panel(page, "sh4-callstack")).not.toContainText("_first_session");
});

test("mute and solo are the server's state: the buttons show what the ticks say, whoever changed it", async ({ page }) => {
  const server = await open(page, "mixed-mode-debugger", (scripted) => {
    // somebody muted the SH4 category before this page connected
    (scripted.state.categories as Record<string, unknown>).sh4 = { muted: true, soloed: false };
  });
  const sh4 = panel(page, "sh4-disassembly");
  const arm7 = panel(page, "arm7-disassembly");
  await expect(sh4.getByRole("button", { name: "Unmute category" })).toBeVisible();
  await expect(arm7.getByRole("button", { name: "Mute category" })).toBeVisible();

  // another client solos ARM7 (which unmutes nothing): a tick says so, and both views follow
  server.state.categories = {
    events: { muted: false, soloed: false },
    sh4: { muted: true, soloed: false },
    arm7: { muted: false, soloed: true },
    dsp: { muted: false, soloed: false },
    // a key this client does not know is not its business
    netplay: { muted: true, soloed: false },
  };
  server.tick();
  await expect(arm7.getByRole("button", { name: "Unsolo category" })).toBeVisible();
  await expect(sh4.getByRole("button", { name: "Unmute category" })).toBeVisible();

  // a click sends the state the button asks for, for all four categories; the tick confirms it
  server.answer("breakpoints.setCategoryStates", (params) => {
    server.state.categories = params.categories as Record<string, unknown>;
    setTimeout(() => server.tick(), 0);
    return {};
  });
  await sh4.getByRole("button", { name: "Unmute category" }).click();
  await expect(sh4.getByRole("button", { name: "Mute category" })).toBeVisible();
  expect(server.requestsOf("breakpoints.setCategoryStates").at(-1)).toEqual({
    categories: {
      events: { muted: false, soloed: false },
      sh4: { muted: false, soloed: false },
      arm7: { muted: false, soloed: true },
      dsp: { muted: false, soloed: false },
    },
  });

  // a refusal is shown, and the button goes back to what the server has
  server.answer("breakpoints.setCategoryStates", () => inBandError(-32000, "emulator busy"));
  await sh4.getByRole("button", { name: "Solo category" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "emulator busy" })).toBeVisible();
  await expect(sh4.getByRole("button", { name: "Solo category" })).toBeVisible();
  await expect(arm7.getByRole("button", { name: "Unsolo category" })).toBeVisible();
});

test("a tick the client cannot use is dropped, and the page says so with the place that is wrong", async ({
  page,
  diagnostics,
}, testInfo) => {
  diagnostics.allow(/^console\.error: Notification validation failed for event\.tick/, "the client logs the tick it drops");
  const server = await open(page, "sh4-debugger");
  await expect(page.getByRole("alert")).toHaveCount(0);
  const dropped = page.getByRole("alert").filter({ hasText: "could not use" });

  // a subsystem has to be a string; this entry has a number
  server.setRegister("dc", "SYSCLK", "from the bad tick");
  server.tick({ patch: { eventLog: [{ eventId: "1", timestamp: 1, subsystem: 5, severity: "info", message: "x" }] } });
  await expect(dropped).toContainText("The server sent a message this UI could not use, and it was dropped");
  await expect(dropped).toContainText("event.tick: eventLog.0.subsystem:");
  // nothing of that tick was applied
  await expect(registerRow(page, "dc.reg.SYSCLK")).toHaveText("SYSCLK = 200MHz");

  // the next one is counted, and the place is that of the last one
  server.tick({ patch: { executionState: { state: "halted" } } });
  await expect(dropped).toContainText("The server sent 2 messages this UI could not use, and they were dropped");
  await expect(dropped).toContainText("event.tick: executionState.state:");
  await saveScreenshot(page, testInfo, "dropped-ticks");

  // the connection is fine, and a tick that is right is applied
  await tickAndWait(page, server);
  await expect(statusBar(page)).toContainText("Connection: connected");

  // the notice can be put away; the next dropped message brings it back, counting from one
  await dropped.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  server.tick({ patch: { tickId: "seven" } });
  await expect(dropped).toContainText("The server sent a message this UI could not use");
  await expect(dropped).toContainText("event.tick: tickId:");
});

test("a debugger.describe the client cannot use, or that the server refuses, is reported instead of an empty page", async ({
  page,
  diagnostics,
}) => {
  diagnostics.allow(/^console\.error: Failed to initialize debugger data/, "the store logs the failed initialisation");
  const server = await serveScriptedDebugger(page);
  // no version, and no device tree
  server.shape = { emulator: { name: "half a server", build: "native" } };
  await gotoRoute(page, "/workspace/sh4-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");

  const failed = page.getByRole("alert").filter({ hasText: "debugger.describe failed" });
  await expect(failed).toContainText("debugger.describe failed: Response validation failed for debugger.describe: emulator.version:");
  await expect(failed).toContainText("deviceTree:");
  for (const id of ["device-tree", "sh4-disassembly", "sh4-memory", "watches"]) {
    await expect(panel(page, id), id).toContainText("No Data");
  }
  await expect(tooltipButton(page, "Run")).toBeDisabled();
  await expect(tooltipButton(page, "Pause")).toBeDisabled();

  // the next attempt is refused by the server
  server.answer("debugger.describe", () => jsonRpcError(-32603, "internal error"));
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "debugger.describe failed: internal error" })).toBeVisible();
  await expect(panel(page, "device-tree")).toContainText("No Data");
});
