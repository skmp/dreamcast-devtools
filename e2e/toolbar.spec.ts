import {
  test,
  expect,
  currentInstructionAddress,
  gotoRoute,
  openWorkspace,
  panel,
  recordAlerts,
  registerRow,
  saveScreenshot,
  statusBar,
  tooltipButton,
  treeItemRow,
} from "./support/fixtures";
import { inBandError, jsonRpcError, serveScriptedDebugger } from "./support/scriptedDebugger";

test("Run and Pause follow the execution state reported by the ticks", async ({ page, rpc }) => {
  await openWorkspace(page, "sh4-debugger");
  const run = tooltipButton(page, "Run");
  const pause = tooltipButton(page, "Pause");
  const runToBreakpoint = tooltipButton(page, "Run to next breakpoint");

  // the mock starts running
  await expect(pause).toBeEnabled();
  await expect(run).toBeDisabled();
  await expect(runToBreakpoint).toBeDisabled();

  await pause.click();
  await expect(run).toBeEnabled();
  await expect(runToBreakpoint).toBeEnabled();
  await expect(pause).toBeDisabled();
  expect(rpc.requests("control.pause").at(-1)?.params).toEqual({ target: "sh4" });
  // paused: the program counter is highlighted and steps are possible
  const view = panel(page, "sh4-disassembly");
  await currentInstructionAddress(view);
  await expect(tooltipButton(view, "Step In")).toBeEnabled();

  await run.click();
  await expect(pause).toBeEnabled();
  await expect(run).toBeDisabled();
  expect(rpc.requests("control.runUntil")).toHaveLength(1);
  // running: no highlight, no stepping
  await expect(view.locator(".current-instruction")).toHaveCount(0);
  await expect(tooltipButton(view, "Step In")).toBeDisabled();
});

test("the target really runs between Run and Pause", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  await treeItemRow(page, "dc.sh4.cpu").click();
  await tooltipButton(page, "Pause").click();
  await expect(tooltipButton(page, "Run")).toBeEnabled();
  const pr = registerRow(page, "dc.sh4.cpu.reg.PR");
  const before = Number.parseInt((await pr.innerText()).replace("PR = ", ""), 16);

  // paused: a tick caused by something else shows the same value
  await tooltipButton(panel(page, "sh4-disassembly"), "Refresh").click();
  await page.waitForTimeout(300);
  expect(Number.parseInt((await pr.innerText()).replace("PR = ", ""), 16)).toBe(before);

  await tooltipButton(page, "Run").click();
  await expect(tooltipButton(page, "Pause")).toBeEnabled();
  await page.waitForTimeout(300);
  await tooltipButton(page, "Pause").click();
  await expect(tooltipButton(page, "Run")).toBeEnabled();
  // PR is incremented by 2 on every emulation step of the mock
  await expect.poll(async () => Number.parseInt((await pr.innerText()).replace("PR = ", ""), 16)).toBeGreaterThan(before);
});

test("Run to next breakpoint runs until a breakpoint stops the target", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  await tooltipButton(page, "Pause").click();
  const breakpoints = panel(page, "sh4-breakpoints");
  await breakpoints.getByPlaceholder("Address (e.g., 0x8C0000A0)").fill("0x8C0000AA");
  await breakpoints.getByPlaceholder("Address (e.g., 0x8C0000A0)").press("Enter");
  await expect(breakpoints.getByRole("listitem")).toHaveCount(1);

  await tooltipButton(page, "Run to next breakpoint").click();
  await expect(page.getByRole("alert").filter({ hasText: "Breakpoint hit: dc.sh4.cpu.pc == 0x8C0000AA" })).toBeVisible();
  await expect(tooltipButton(page, "Run")).toBeEnabled();
  expect(await currentInstructionAddress(panel(page, "sh4-disassembly"))).toBe(0x8c0000aa);
});

test("next to the run controls: whether the target runs, why it is stopped and which stop it is", async ({ page }, testInfo) => {
  await openWorkspace(page, "sh4-debugger");
  const status = page.getByRole("status", { name: "Execution state" });
  await expect(status).toHaveText("Running");

  await tooltipButton(page, "Pause").click();
  await expect(status).toHaveText("Paused · paused by the debugger · stop 1");

  const view = panel(page, "sh4-disassembly");
  await tooltipButton(view, "Step In").click();
  await expect(status).toHaveText("Paused · step completed · stop 2");

  // a breakpoint two instructions ahead: the stop names it, in the address format of its target
  const start = await currentInstructionAddress(view);
  const address = 0x8c0000a0 + ((start - 0x8c0000a0 + 4) % 16);
  const row = view.locator(`[data-address="${address}"]`);
  await row.hover();
  await row.locator(".breakpoint-gutter").click();
  await expect(row.locator(".breakpoint-gutter")).toHaveAttribute("data-breakpoint", "enabled");
  // the tick that lists the new breakpoint is of the same stop: nothing about the stop changes
  await expect(status).toHaveText("Paused · step completed · stop 2");
  await tooltipButton(page, "Run").click();
  await expect(status).toHaveText(`Paused · breakpoint dc.sh4.cpu.pc == 0x${address.toString(16).toUpperCase()} · stop 3`);
  await saveScreenshot(page, testInfo, "toolbar-paused-at-breakpoint");

  await tooltipButton(page, "Run to next breakpoint").click();
  await expect(status).toHaveText(`Paused · breakpoint dc.sh4.cpu.pc == 0x${address.toString(16).toUpperCase()} · stop 4`);
});

test("a control request the server refuses says so; nothing is silently ignored", async ({ page }) => {
  // the mock refuses a step whose precondition fails (-32005), in-band
  await openWorkspace(page, "sh4-debugger");
  await tooltipButton(page, "Pause").click();
  const view = panel(page, "sh4-disassembly");
  await expect(tooltipButton(view, "Step In")).toBeEnabled();
  const status = page.getByRole("status", { name: "Execution state" });
  await expect(status).toHaveText("Paused · paused by the debugger · stop 1");

  // an odd program counter, written through the watch
  const watches = panel(page, "watches");
  await watches.getByText(/^0x8C0000A[0-9A-E]$/).dblclick();
  await watches.getByRole("listitem").getByRole("textbox").fill("0x8C0000A1");
  await watches.getByRole("listitem").getByRole("textbox").press("Enter");
  await expect(watches).toContainText("dc.sh4.cpu.pc = 0x8C0000A1");

  await tooltipButton(view, "Step In").click();
  await expect(page.getByRole("alert").filter({ hasText: "Step: cannot step: pc is odd" })).toBeVisible();
  await tooltipButton(view, "Step Over").click();
  await expect(page.getByRole("alert").filter({ hasText: "Step over: cannot step: pc is odd" })).toBeVisible();
  // no stop was made
  await expect(status).toHaveText("Paused · paused by the debugger · stop 1");
});

test("the reason of a stop is an open string, and the notice of the server is shown with it", async ({ page }, testInfo) => {
  // a server inside the test: it sends the ticks the test asks for
  const server = await serveScriptedDebugger(page);
  await gotoRoute(page, "/workspace/sh4-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");
  const status = page.getByRole("status", { name: "Execution state" });
  const notice = page.getByRole("status", { name: "Notice from the server" });
  await expect(status).toHaveText("Paused · paused by the debugger · stop 1");
  await expect(notice).toHaveCount(0);

  // every reason a v3 server sends has its words
  for (const [reason, text] of [
    ["start", "waiting at the start"],
    ["event", "event breakpoint"],
    ["reset", "reset"],
    ["capture", "capture finished"],
    ["host-stopped", "stopped in the emulator's window"],
    ["guest-exit", "the program has exited"],
    ["no-game", "no game loaded"],
  ] as const) {
    server.state.execution = { state: "paused", stopId: 2, reason };
    server.tick();
    await expect(status).toHaveText(`Paused · ${text} · stop 2`);
  }
  // one it does not know is shown as it came
  server.state.execution = { state: "paused", stopId: 3, reason: "cosmic-ray" };
  server.tick();
  await expect(status).toHaveText("Paused · cosmic-ray · stop 3");
  await expect(tooltipButton(page, "Run")).toBeEnabled();

  // a notice: one line per statement
  const lines = [
    "SH4 runs on the interpreter while breakpoints are armed: FPU results can differ from a run without breakpoints",
    "DSP runs per sample while a DSP breakpoint exists",
  ];
  server.state.execution = { state: "running", stopId: 3, notice: lines.join("\n") };
  server.tick();
  await expect(status).toHaveText("Running");
  await expect(notice).toHaveText(lines.join(" · "));
  // all of it can be read where there is no room for it
  await expect(notice).toHaveAttribute("title", lines.join("\n"));
  await expect(notice).toBeVisible();
  await saveScreenshot(page, testInfo, "toolbar-notice");
  // it is a statement, not an alarm
  await expect(page.getByRole("alert")).toHaveCount(0);

  server.state.execution = { state: "running", stopId: 3 };
  server.tick();
  await expect(notice).toHaveCount(0);
});

test("every control request is checked: an in-band error and a JSON-RPC error are both shown", async ({ page }) => {
  const server = await serveScriptedDebugger(page);
  // every notice the page shows (one stays for five seconds)
  const notices = await recordAlerts(page);
  await gotoRoute(page, "/workspace/sh4-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");
  const view = panel(page, "sh4-disassembly");
  const shown = (text: string) => page.getByRole("alert").filter({ hasText: text });
  await expect(tooltipButton(view, "Step In")).toBeEnabled();

  server.answer("control.runUntil", () => inBandError(-32000, "emulator busy"));
  await tooltipButton(page, "Run").click();
  await expect.poll(notices).toEqual(["Run: emulator busy"]);
  await expect(shown("Run: emulator busy")).toHaveText("Run: emulator busy");
  // the same refusal while its notice is up: that notice counts it
  await tooltipButton(page, "Run to next breakpoint").click();
  await expect(shown("Run: emulator busy")).toHaveText("Run: emulator busy (×2)");
  expect(await notices()).toEqual(["Run: emulator busy"]);

  server.answer("control.step", () => inBandError(-32005, "cannot step: undefined opcode"));
  await tooltipButton(view, "Step In").click();
  await expect(shown("Step: cannot step: undefined opcode")).toBeVisible();

  server.answer("control.stepOver", () => jsonRpcError(-32603, "internal error"));
  await tooltipButton(view, "Step Over").click();
  await expect(shown("Step over: internal error")).toBeVisible();

  server.answer("control.stepOut", () => inBandError(-32004, "not supported: control.stepOut"));
  await tooltipButton(view, "Step Out").click();
  await expect(shown("Step out: not supported: control.stepOut")).toBeVisible();
  expect(server.requestsOf("control.stepOut")).toEqual([{ target: "sh4" }]);

  server.state.execution = { state: "running", stopId: 1 };
  server.tick();
  server.answer("control.pause", () => inBandError(-32001, "emulator stopped by host UI"));
  await tooltipButton(page, "Pause").click();
  await expect(shown("Pause: emulator stopped by host UI")).toBeVisible();
  // the buttons are as the ticks say: nothing was assumed to have worked
  await expect(tooltipButton(page, "Pause")).toBeEnabled();
  await expect(tooltipButton(page, "Run")).toBeDisabled();
  // one notice per refusal that was not on screen already, and none for anything else
  expect(await notices()).toEqual([
    "Run: emulator busy",
    "Step: cannot step: undefined opcode",
    "Step over: internal error",
    "Step out: not supported: control.stepOut",
    "Pause: emulator stopped by host UI",
  ]);
});

test("a refusal that is repeated is one notice that counts, not a column of them", async ({ page }) => {
  const server = await serveScriptedDebugger(page);
  server.answer("control.step", () => inBandError(-32005, "cannot step: undefined opcode"));
  server.answer("control.stepOut", () => inBandError(-32005, "cannot step: undefined opcode"));
  await gotoRoute(page, "/workspace/sh4-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");
  await server.described();
  const view = panel(page, "sh4-disassembly");
  await expect(view.locator(".current-instruction")).toHaveCount(1);
  const alerts = page.getByRole("alert");

  // somebody in a hurry: two hundred clicks on a button the server refuses
  await tooltipButton(view, "Step In").evaluate((button) => {
    for (let index = 0; index < 200; index++) {
      (button as HTMLButtonElement).click();
    }
  });
  await expect.poll(() => server.requestsOf("control.step").length).toBe(200);
  await expect(alerts).toHaveText(["Step: cannot step: undefined opcode (×200)"]);
  // it is in the corner of the page, and the page is not covered
  const box = (await alerts.boundingBox())!;
  expect(box.height).toBeLessThan(80);
  expect(box.y).toBeGreaterThan(900);
  await expect(page.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();

  // another refusal is another notice, and the first goes on counting
  await tooltipButton(view, "Step Out").click();
  await expect(alerts).toHaveText(["Step: cannot step: undefined opcode (×200)", "Step out: cannot step: undefined opcode"]);
  await tooltipButton(view, "Step In").click();
  await expect(alerts).toHaveText(["Step: cannot step: undefined opcode (×201)", "Step out: cannot step: undefined opcode"]);

  // put away, it starts again at one
  await alerts.first().getByRole("button", { name: "Close" }).click();
  await expect(alerts).toHaveText(["Step out: cannot step: undefined opcode"]);
  await tooltipButton(view, "Step In").click();
  await expect(alerts).toHaveText(["Step out: cannot step: undefined opcode", "Step: cannot step: undefined opcode"]);
});
