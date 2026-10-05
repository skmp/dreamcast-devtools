import {
  test,
  expect,
  disassemblyRows,
  gotoRoute,
  panel,
  recordAlerts,
  saveScreenshot,
  statusBar,
  tooltipButton,
  type WorkspaceId,
} from "./support/fixtures";
import type { Page } from "@playwright/test";
import { loadV2Frames, serveScriptedDebugger, type CapturedFrame, type ScriptedDebugger } from "./support/scriptedDebugger";

// A server of protocol v2: no `protocol`, `targets` or `ui` in debugger.describe, no `stopId`,
// `reason` or `categories` in a tick, and `breakpointId` only in the tick of the hit. The
// frames are those the mock sent before protocol v3 (src/lib/test-fixtures): the describe
// result [0], a running tick [1], paused ticks [3] and [5], a running tick [16] and the tick
// of a breakpoint hit [17].

const frames: CapturedFrame[] = loadV2Frames();

const open = async (page: Page, workspace: WorkspaceId): Promise<ScriptedDebugger> => {
  const server = await serveScriptedDebugger(page);
  server.shape = frames[0].result!;
  // what followed the describe response in the capture: a tick of the running target
  server.afterDescribe = () => server.send(frames[1]);
  await gotoRoute(page, `/workspace/${workspace}`);
  await expect(statusBar(page)).toContainText("Connection: connected");
  await server.described();
  return server;
};

test("a v2 server is said to be one, and its panels use the values they had built in before protocol v3", async ({ page }, testInfo) => {
  const server = await open(page, "arm7-debugger");

  // the page says which protocol the server speaks, and what that means
  const notice = page.getByRole("alert").filter({ hasText: "debugger protocol 2" });
  await expect(notice).toContainText("This server speaks debugger protocol 2 (it reports no protocol version); this UI is built for protocol 3.");
  await saveScreenshot(page, testInfo, "v2-server");
  await notice.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);

  // no `targets`: the ARM7 memory view opens at 0x00200000 (a v3 server says where), the
  // disassembly ten instructions of four bytes above the program counter of the first tick
  await expect(panel(page, "arm7-memory").getByRole("textbox")).toHaveValue("0x002000A0");
  expect(server.requestsOf("state.getMemorySlice")[0]).toEqual({ target: "arm7", address: 0x00200000, length: 960 });
  await expect(disassemblyRows(panel(page, "arm7-disassembly")).first()).toHaveAttribute("data-address", String(0x00200020 - 40));
  expect(server.requestsOf("state.getDisassembly")[0]).toEqual({ target: "arm7", address: 0x00200020 - 40, count: 64 });

  // its `capabilities` are names of its own: nothing is taken for unsupported
  await expect(page.getByText(/This server (cannot|does not|has no)/)).toHaveCount(0);
  const breakpoints = panel(page, "arm7-breakpoints");
  await expect(tooltipButton(panel(page, "arm7-disassembly"), "Step In")).toBeVisible();
  await breakpoints.getByPlaceholder("Address (e.g., 0x8C0000A0)").fill("0x00200018");
  await breakpoints.getByPlaceholder("Address (e.g., 0x8C0000A0)").press("Enter");
  await expect.poll(() => server.requestsOf("breakpoints.add")).toEqual([
    { event: "dc.aica.arm7.pc", address: 0x00200018, kind: "code", enabled: true },
  ]);
  // what the ticks carry is shown as it comes: the watches, and the frames of the callstack
  await expect(panel(page, "watches")).toContainText("dc.sh4.cpu.pc = 0x8C0000A8");
  await expect(panel(page, "arm7-callstack")).toContainText("ARM7_func_0");

  // no `stopId` and no `reason`: the toolbar has the run state only
  await expect(page.getByRole("status", { name: "Execution state" })).toHaveText("Running");
  await expect(tooltipButton(page, "Pause")).toBeEnabled();
});

test("with a v2 server a stop is the change from running to paused, and a breakpoint is announced by the tick that names it", async ({
  page,
}) => {
  const alerts = await recordAlerts(page);
  const server = await open(page, "sh4-debugger");
  const view = panel(page, "sh4-disassembly");
  const rows = disassemblyRows(view);
  const fetches = () => server.requestsOf("state.getDisassembly").length;
  const announced = async () => (await alerts()).filter((text) => text.startsWith("Breakpoint hit:"));

  // running at 0x8C0000A8
  await expect(rows.first()).toHaveAttribute("data-address", String(0x8c0000a8 - 20));
  await expect(view.locator(".current-instruction")).toHaveCount(0);
  expect(fetches()).toBe(1);

  // Pause: the server answers and sends a paused tick. Running to paused is a stop.
  server.answer("control.pause", () => {
    setTimeout(() => server.send(frames[3]), 0);
    return {};
  });
  await tooltipButton(page, "Pause").click();
  await expect(view.locator(".current-instruction")).toHaveAttribute("data-address", String(0x8c0000a8));
  await expect(page.getByRole("status", { name: "Execution state" })).toHaveText("Paused");
  await expect.poll(fetches).toBe(2);

  // a paused tick after a paused tick (a breakpoint was added) is not a stop
  await view.getByRole("textbox").fill("0x8C004000");
  await view.getByRole("textbox").press("Enter");
  await expect(rows.first()).toHaveAttribute("data-address", String(0x8c004000 - 20));
  expect(fetches()).toBe(3);
  server.send(frames[5]);
  await expect(panel(page, "sh4-breakpoints").getByRole("listitem")).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute("data-address", String(0x8c004000 - 20));
  expect(fetches()).toBe(3);
  expect(await announced()).toEqual([]);

  // Run, and the breakpoint at 0x8C0000A6 is hit: the tick of the hit names it
  server.answer("control.runUntil", () => {
    setTimeout(() => {
      server.send(frames[16]);
      server.send(frames[17]);
    }, 0);
    return {};
  });
  await tooltipButton(page, "Run").click();
  await expect(page.getByRole("alert").filter({ hasText: "Breakpoint hit: dc.sh4.cpu.pc == 0x8C0000A6" })).toBeVisible();
  await expect(view.locator(".current-instruction")).toHaveAttribute("data-address", String(0x8c0000a6));
  await expect(rows.first()).toHaveAttribute("data-address", String(0x8c0000a6 - 20));
  await expect.poll(fetches).toBe(4);

  // the paused ticks that follow do not name it again, and are not stops
  const later = structuredClone(frames[17]);
  delete (later.params!.executionState as Record<string, unknown>).breakpointId;
  server.send(later);
  server.send(later);
  await expect(panel(page, "watches")).toContainText("dc.sh4.cpu.pc = 0x8C0000A6");
  expect(await announced()).toEqual(["Breakpoint hit: dc.sh4.cpu.pc == 0x8C0000A6"]);
  expect(fetches()).toBe(4);

  // no `categories` in its ticks: a mute button keeps what was clicked
  server.answer("breakpoints.setCategoryStates", () => ({}));
  await view.getByRole("button", { name: "Mute category" }).click();
  await expect(view.getByRole("button", { name: "Unmute category" })).toBeVisible();
  expect(server.requestsOf("breakpoints.setCategoryStates").at(-1)).toMatchObject({ categories: { sh4: { muted: true, soloed: false } } });
  server.send(later);
  await expect(view.getByRole("button", { name: "Unmute category" })).toBeVisible();
});
