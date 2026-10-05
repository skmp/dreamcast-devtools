import {
  test,
  expect,
  breakpointGutter,
  disassemblyRow,
  disassemblyRows,
  gotoRoute,
  panel,
  recordAlerts,
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

const hex8 = (address: number) => `0x${address.toString(16).toUpperCase().padStart(8, "0")}`;

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

test("a stop is acted on once: the views follow it, read again and announce its breakpoint; other ticks do none of that", async ({
  page,
}) => {
  let alerts: () => Promise<string[]> = async () => [];
  const server = await open(page, "sh4-debugger", async (scripted) => {
    // the server is stopped at a breakpoint when the page connects
    scripted.state.execution = { state: "paused", stopId: 4, reason: "breakpoint", breakpointId: 7 };
    scripted.state.breakpoints = { "7": { id: 7, event: "dc.sh4.cpu.pc", address: 0x8c001000, kind: "code", enabled: true } };
    alerts = await recordAlerts(page);
  });
  /** every announcement of a breakpoint the page has made so far (a notice leaves the screen after five seconds) */
  const announced = async () => (await alerts()).filter((text) => text.startsWith("Breakpoint hit:"));
  const view = panel(page, "sh4-disassembly");
  const rows = disassemblyRows(view);
  const fetches = () => ({
    disassembly: server.requestsOf("state.getDisassembly").filter((params) => params.target === "sh4").length,
    memory: server.requestsOf("state.getMemorySlice").length,
  });
  const hits = (address: number) => page.getByRole("alert").filter({ hasText: `Breakpoint hit: dc.sh4.cpu.pc == ${hex8(address)}` });

  // the first paused tick of a connection counts as a stop: the client learns why the target is stopped
  await expect(hits(0x8c001000)).toBeVisible();
  expect(await announced()).toEqual(["Breakpoint hit: dc.sh4.cpu.pc == 0x8C001000"]);
  await expect(rows.first()).toHaveAttribute("data-address", String(0x8c001000 - 20));
  await expect(view.locator(".current-instruction")).toHaveAttribute("data-address", String(0x8c001000));
  await expect(panel(page, "sh4-memory")).toContainText("0x8C010000");
  expect(fetches()).toEqual({ disassembly: 1, memory: 1 });

  // paused ticks of the same stop: what follows a breakpoint or a watch being added, by anyone
  await tickAndWait(page, server);
  await tickAndWait(page, server);
  expect(await announced()).toHaveLength(1);
  expect(fetches()).toEqual({ disassembly: 1, memory: 1 });

  // the user looks at something else; a tick of the same stop does not take the view back
  await view.getByRole("textbox").fill("0x8C004000");
  await view.getByRole("textbox").press("Enter");
  await expect(rows.first()).toHaveAttribute("data-address", String(0x8c004000 - 20));
  expect(fetches()).toEqual({ disassembly: 2, memory: 1 });
  await tickAndWait(page, server);
  await expect(rows.first()).toHaveAttribute("data-address", String(0x8c004000 - 20));
  expect(fetches()).toEqual({ disassembly: 2, memory: 1 });

  // a new stop (a step): the view goes to the program counter, and both views read again
  server.state.execution = { state: "paused", stopId: 5, reason: "step" };
  server.setRegister("dc.sh4.cpu", "PC", "0x8C002000");
  await tickAndWait(page, server);
  await expect(rows.first()).toHaveAttribute("data-address", String(0x8c002000 - 20));
  await expect(view.locator(".current-instruction")).toHaveAttribute("data-address", String(0x8c002000));
  await expect.poll(fetches).toEqual({ disassembly: 3, memory: 2 });
  // a step is not a breakpoint: nothing is announced
  expect(await announced()).toHaveLength(1);

  // the next stop is on a line that is on screen: the view stays where it is, and reads again
  server.state.execution = { state: "paused", stopId: 6, reason: "breakpoint", breakpointId: 8 };
  server.state.breakpoints = {
    ...server.state.breakpoints,
    "8": { id: 8, event: "dc.sh4.cpu.pc", address: 0x8c002002, kind: "code", enabled: true },
  };
  server.setRegister("dc.sh4.cpu", "PC", "0x8C002002");
  await tickAndWait(page, server);
  await expect(view.locator(".current-instruction")).toHaveAttribute("data-address", String(0x8c002002));
  await expect(rows.first()).toHaveAttribute("data-address", String(0x8c002000 - 20));
  await expect.poll(fetches).toEqual({ disassembly: 4, memory: 3 });
  await expect(hits(0x8c002002)).toBeVisible();
  // the stop is repeated in every paused tick of it, and announced once
  await tickAndWait(page, server);
  await tickAndWait(page, server);
  expect(await announced()).toEqual([
    "Breakpoint hit: dc.sh4.cpu.pc == 0x8C001000",
    "Breakpoint hit: dc.sh4.cpu.pc == 0x8C002002",
  ]);
  expect(fetches()).toEqual({ disassembly: 4, memory: 3 });

  // running: five ticks, each with another program counter, and nothing is fetched or marked
  server.state.execution = { state: "running", stopId: 6 };
  for (let step = 1; step <= 5; step++) {
    server.setRegister("dc.sh4.cpu", "PC", hex8(0x8c002002 + 2 * step));
    await tickAndWait(page, server);
  }
  await expect(view.locator(".current-instruction")).toHaveCount(0);
  await expect(rows.first()).toHaveAttribute("data-address", String(0x8c002000 - 20));
  expect(fetches()).toEqual({ disassembly: 4, memory: 3 });

  // stopped again, somewhere else
  server.state.execution = { state: "paused", stopId: 7, reason: "pause" };
  server.setRegister("dc.sh4.cpu", "PC", "0x8C008000");
  await tickAndWait(page, server);
  await expect(rows.first()).toHaveAttribute("data-address", String(0x8c008000 - 20));
  await expect(view.locator(".current-instruction")).toHaveAttribute("data-address", String(0x8c008000));
  await expect.poll(fetches).toEqual({ disassembly: 5, memory: 4 });
  expect(await announced()).toHaveLength(2);
});

test("a breakpoint set or removed in a disassembly view makes it read again, where it is", async ({ page }) => {
  const server = await open(page, "sh4-debugger");
  const view = panel(page, "sh4-disassembly");
  const rows = disassemblyRows(view);
  await expect(rows.first()).toHaveAttribute("data-address", String(0x8c001000 - 20));
  const fetches = () => server.requestsOf("state.getDisassembly").filter((params) => params.target === "sh4").length;
  expect(fetches()).toBe(1);

  // the server lists the breakpoint in the tick that follows the request, like a real one
  server.answer("breakpoints.add", (params) => {
    server.state.breakpoints = { "1": { id: 1, event: params.event, address: params.address, kind: "code", enabled: true } };
    setTimeout(() => server.tick(), 0);
    return {};
  });
  server.answer("breakpoints.remove", () => {
    server.state.breakpoints = {};
    setTimeout(() => server.tick(), 0);
    return {};
  });

  const row = disassemblyRow(view, 0x8c001008);
  await row.hover();
  await breakpointGutter(row).click();
  await expect(breakpointGutter(row)).toHaveAttribute("data-breakpoint", "enabled");
  await expect.poll(fetches).toBe(2);
  expect(server.requestsOf("state.getDisassembly").at(-1)).toEqual({ target: "sh4", address: 0x8c001000 - 20, count: 64 });
  await expect(rows.first()).toHaveAttribute("data-address", String(0x8c001000 - 20));

  await breakpointGutter(row).click();
  await expect(breakpointGutter(row)).toHaveAttribute("data-breakpoint", "none");
  await expect.poll(fetches).toBe(3);
  await expect(rows.first()).toHaveAttribute("data-address", String(0x8c001000 - 20));
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
