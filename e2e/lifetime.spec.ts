import {
  test,
  expect,
  currentInstructionAddress,
  disassemblyRows,
  openWorkspace,
  panel,
  registerRow,
  saveScreenshot,
  tooltipButton,
  treeItemRow,
} from "./support/fixtures";

// What the emulator's own window does to the machine while the debugger looks at it: it is
// paused there, the program exits, or no game is loaded at all. All three are reported as
// `paused` with a reason, and in all three the server refuses run control. The mock runs in
// the test's process, so the test is that window (`machine.setLifetime`).

test.use({ mockOptions: {} });

test("a machine stopped in the emulator's window is shown as that, with run control put away", async ({ page, machine, rpc }, testInfo) => {
  await openWorkspace(page, "sh4-debugger");
  const status = page.getByRole("status", { name: "Execution state" });
  const view = panel(page, "sh4-disassembly");
  await expect(status).toHaveText("Running");
  await expect(tooltipButton(page, "Pause")).toBeEnabled();

  // --- paused in the emulator's own GUI ---
  machine.setLifetime("stopped");
  await expect(status).toHaveText("Paused · stopped in the emulator's window · stop 1");
  // it is a stop: the views show where, and the callstack of it
  const pc = await currentInstructionAddress(view);
  await expect(panel(page, "sh4-callstack").getByRole("listitem").first()).toContainText(`0x${pc.toString(16).toUpperCase()}`);
  // nothing here can resume it: the buttons that could only be refused are off
  for (const button of [tooltipButton(page, "Run"), tooltipButton(page, "Run to next breakpoint"), tooltipButton(page, "Pause")]) {
    await expect(button).toBeDisabled();
  }
  for (const label of ["Step Over", "Step In", "Step Out"]) {
    await expect(tooltipButton(view, label)).toBeDisabled();
  }
  expect(rpc.sent.filter((frame) => frame.method?.startsWith("control."))).toEqual([]);
  await saveScreenshot(page, testInfo, "session-host-stopped");
  // reading still works: Refresh reads the same lines again
  const fetches = rpc.requests("state.getDisassembly").length;
  await tooltipButton(view, "Refresh").click();
  await expect.poll(() => rpc.requests("state.getDisassembly").length).toBe(fetches + 1);
  await expect(disassemblyRows(view)).toHaveCount(64);

  // --- resumed there ---
  machine.setLifetime("running");
  await expect(status).toHaveText("Running");
  await expect(tooltipButton(page, "Pause")).toBeEnabled();
  await expect(view.locator(".current-instruction")).toHaveCount(0);

  // --- the program exits ---
  machine.setLifetime("stopped", "guest-exit");
  await expect(status).toHaveText("Paused · the program has exited · stop 2");
  await expect(tooltipButton(page, "Run")).toBeDisabled();
  await expect(tooltipButton(view, "Step In")).toBeDisabled();
  await currentInstructionAddress(view);
});

test("with no game loaded nothing has a value, and a game that is loaded brings the views back", async ({ page, machine, rpc }, testInfo) => {
  await openWorkspace(page, "sh4-debugger");
  await treeItemRow(page, "dc.sh4.cpu").click();
  const status = page.getByRole("status", { name: "Execution state" });
  const disassembly = panel(page, "sh4-disassembly");
  const memory = panel(page, "sh4-memory");
  await expect(registerRow(page, "dc.sh4.cpu.reg.VBR")).toHaveText("VBR = 0x8C000000");
  await expect(disassemblyRows(disassembly)).toHaveCount(64);

  // --- the game is closed ---
  machine.setLifetime("no-machine");
  await expect(status).toHaveText("Paused · no game loaded · stop 1");
  await expect(tooltipButton(page, "Run")).toBeDisabled();
  await expect(tooltipButton(page, "Pause")).toBeDisabled();
  // its ticks carry no registers: the values of the machine that is gone do not stay on screen
  await expect(registerRow(page, "dc.sh4.cpu.reg.VBR")).toHaveText("VBR = n/a");
  await expect(registerRow(page, "dc.sh4.cpu.reg.PC")).toHaveText("PC = n/a");
  await expect(registerRow(page, "dc.reg.SYSCLK")).toHaveText("SYSCLK = n/a");
  await expect(panel(page, "watches")).toContainText("dc.sh4.cpu.pc = n/a");
  await expect(panel(page, "sh4-callstack")).toContainText("Empty callstack.");
  // the stop made the views read again, and the server's answer is what they show
  await expect(disassembly).toContainText("no game loaded");
  await expect(memory).toContainText("no game loaded");
  await expect(disassembly.locator(".current-instruction")).toHaveCount(0);
  await saveScreenshot(page, testInfo, "session-no-game");

  // --- a game is started ---
  const fetches = { disassembly: rpc.requests("state.getDisassembly").length, memory: rpc.requests("state.getMemorySlice").length };
  machine.setLifetime("running");
  await expect(status).toHaveText("Running");
  // no stop, and still the views read again: until now there was nothing to read
  await expect(disassemblyRows(disassembly)).toHaveCount(64);
  await expect(memory).toContainText("0x8C010000");
  await expect(memory).not.toContainText("no game loaded");
  expect(rpc.requests("state.getDisassembly").length).toBe(fetches.disassembly + 1);
  expect(rpc.requests("state.getMemorySlice").length).toBe(fetches.memory + 1);
  await expect(registerRow(page, "dc.sh4.cpu.reg.VBR")).toHaveText("VBR = 0x8C000000");
  await expect(registerRow(page, "dc.reg.SYSCLK")).toHaveText("SYSCLK = 200MHz");
  await expect(tooltipButton(page, "Pause")).toBeEnabled();
});

test.describe("a server that starts paused", () => {
  // (the grace period after the client that seeds the watch is not what is tested here)
  test.use({ mockOptions: { startPaused: true, graceMs: 600_000 } });

  test("the page connects into the stop: it says why, and the views open at the program counter", async ({ page, rpc }) => {
    await openWorkspace(page, "sh4-debugger");
    await expect(page.getByRole("status", { name: "Execution state" })).toHaveText("Paused · waiting at the start · stop 1");
    const view = panel(page, "sh4-disassembly");
    // the mock's program counter at its start
    expect(await currentInstructionAddress(view)).toBe(0x8c0000a0);
    await expect(disassemblyRows(view).first()).toHaveAttribute("data-address", String(0x8c0000a0 - 20));
    await expect(panel(page, "sh4-callstack").getByRole("listitem")).toHaveCount(16);
    // one request per view: the stop the page connected into is the one the views opened on
    expect(rpc.requests("state.getDisassembly")).toHaveLength(1);
    expect(rpc.requests("state.getMemorySlice")).toHaveLength(1);

    await tooltipButton(page, "Run").click();
    await expect(page.getByRole("status", { name: "Execution state" })).toHaveText("Running");
  });
});
