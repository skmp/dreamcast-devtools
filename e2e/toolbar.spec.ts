import {
  test,
  expect,
  currentInstructionAddress,
  gotoRoute,
  openWorkspace,
  panel,
  registerRow,
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

test("every control request is checked: an in-band error and a JSON-RPC error are both shown", async ({ page }) => {
  const server = await serveScriptedDebugger(page);
  await gotoRoute(page, "/workspace/sh4-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");
  const view = panel(page, "sh4-disassembly");
  const shown = (text: string) => page.getByRole("alert").filter({ hasText: text });
  await expect(tooltipButton(view, "Step In")).toBeEnabled();

  server.answer("control.runUntil", () => inBandError(-32000, "emulator busy"));
  await tooltipButton(page, "Run").click();
  await expect(shown("Run: emulator busy")).toBeVisible();
  await tooltipButton(page, "Run to next breakpoint").click();
  await expect(shown("Run: emulator busy")).toHaveCount(2);

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
});
