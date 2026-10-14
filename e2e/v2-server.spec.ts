import {
  test,
  expect,
  addPanelFromSelector,
  disassemblyRows,
  gotoRoute,
  panel,
  recordAlerts,
  registerRow,
  saveScreenshot,
  statusBar,
  tooltipButton,
  treeItem,
  treeItemRow,
  KNOWN,
  type WorkspaceId,
} from "./support/fixtures";
import type { Page } from "@playwright/test";
import { encodeBinaryFrame, BinaryFrameKind, SGC_BYTES_PER_FRAME } from "../src/lib/binaryFrame";
import { StrictDebuggerRpcMethodSchemas } from "../src/lib/debuggerSchema";
import { jsonRpcError, serveScriptedDebugger, type Json, type ScriptedDebugger } from "./support/scriptedDebugger";
import { serveSyntheticDebugger } from "./support/syntheticDebugger";

// The client no longer serves a server of protocol v2. A debugger.describe result without
// `protocol` gets the version banner and is a server that lists no target and no capability:
// the first test, and the only server without `protocol` of the suite. The tests after it are
// about servers that say `protocol: 3` and leave out a field such a server always sends. The
// field then has no meaning of its own, and nothing is inferred from its absence:
//
//   `targets` or `capabilities` of a describe result   an empty list: every panel shows its notice
//   `stopId` of a tick                                 no new stop: the views are not moved
//   `callstacks` of a tick                             no frames
//   `watches` of a tick                                none
//   `categories` of a tick                             the stored states stay
//   the header of a binary frame                       the frame is not taken
//
// (An event-log entry without `metadata` is a row without an event name: callstack-eventlog.spec.ts.)

const notSupported = (label: string) => `This server does not support the ${label} target.`;
const NO_SGC = "This server cannot capture SGC frames.";

/** What each panel of the default workspaces shows in place of its controls on a server that lists no target. */
const WITHOUT_TARGETS: Record<WorkspaceId, Record<string, string>> = {
  "sh4-debugger": {
    "sh4-disassembly": notSupported("SH4"),
    "sh4-memory": notSupported("SH4"),
    "sh4-breakpoints": notSupported("SH4"),
    "sh4-callstack": notSupported("SH4"),
  },
  "arm7-debugger": {
    "arm7-disassembly": notSupported("ARM7"),
    "arm7-memory": notSupported("ARM7"),
    "arm7-breakpoints": notSupported("ARM7"),
    "arm7-callstack": notSupported("ARM7"),
  },
  "audio-debugger": {
    "dsp-disassembly": notSupported("DSP"),
    "dsp-breakpoints": notSupported("DSP"),
  },
  "mixed-mode-debugger": {
    "sh4-disassembly": notSupported("SH4"),
    "arm7-disassembly": notSupported("ARM7"),
    "sh4-callstack": notSupported("SH4"),
    "arm7-callstack": notSupported("ARM7"),
  },
};

/**
 * Sends a tick and waits until the page has applied it: every tick sent this way changes a
 * text register of the root node, which the device tree shows.
 */
let marker = 0;
const tickAndWait = async (page: Page, server: ScriptedDebugger, options?: Parameters<ScriptedDebugger["tick"]>[0]) => {
  const value = `mark-${++marker}`;
  server.setRegister("dc", "SYSCLK", value);
  server.tick(options);
  await expect(registerRow(page, "dc.reg.SYSCLK")).toHaveText(`SYSCLK = ${value}`);
};

/** Every request the page has made but debugger.describe. */
const asked = (server: ScriptedDebugger): string[] =>
  server.requests.map((request) => request.method).filter((method) => method !== "debugger.describe");

/**
 * Opens every default workspace in turn and holds its panels to their notices; then nothing
 * but debugger.describe has been asked of the server, on any of them.
 */
const expectNoticesInEveryWorkspace = async (page: Page, server: ScriptedDebugger, notices: Record<WorkspaceId, Record<string, string>>) => {
  for (const [workspace, panels] of Object.entries(notices)) {
    await gotoRoute(page, `/workspace/${workspace}`);
    await expect(statusBar(page)).toContainText("Connection: connected");
    await server.described();
    for (const [id, text] of Object.entries(panels)) {
      await expect(panel(page, id).getByRole("note"), `${workspace}: ${id}`).toHaveText(text);
      // in place of the controls: no address box, no step button, no Record
      await expect(panel(page, id).getByRole("textbox"), `${workspace}: ${id}`).toHaveCount(0);
      await expect(panel(page, id).getByRole("button"), `${workspace}: ${id}`).toHaveCount(0);
    }
    // what a view would ask for it asks for when a tick has arrived and when the target stops: both have happened
    await tickAndWait(page, server);
    await tickAndWait(page, server);
    expect(asked(server), workspace).toEqual([]);
  }
};

test("a server that reports no protocol version gets the banner, and is one that lists no target and no capability", async ({
  page,
}, testInfo) => {
  const server = await serveScriptedDebugger(page);
  // What a server of protocol v3 describes, but for the version. Its `targets` and its
  // `capabilities` are there and are not read: without `protocol` they are names of its own.
  expect(server.shape).toMatchObject({ protocol: 3, capabilities: ["event-breakpoints", "callstack"] });
  expect(server.shape.targets).toHaveLength(3);
  delete server.shape.protocol;
  server.state.callstacks = { sh4: [{ index: 0, pc: 0x8c001000, sp: 0x8cfff000, symbol: "_main+0x0" }], arm7: [] };
  server.state.watches = [{ id: 1, expression: "dc.sh4.cpu.pc", value: "0x8C001000" }];
  await gotoRoute(page, "/workspace/sh4-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");
  await server.described();

  // the page says what is wrong with the server, and what that means
  const notice = page.getByRole("alert").filter({ hasText: "protocol" });
  await expect(notice).toHaveText(
    "This server reports no debugger protocol version; this UI is built for protocol 3. " +
      "It is treated as a server that lists no target and no capability: the panels say what is missing. " +
      "Use the UI that belongs to the emulator.",
  );
  await saveScreenshot(page, testInfo, "server-without-protocol");

  // no target: every panel of one says so, in every workspace, and asks the server for nothing
  await expectNoticesInEveryWorkspace(page, server, {
    ...WITHOUT_TARGETS,
    "audio-debugger": { ...WITHOUT_TARGETS["audio-debugger"], sgc: NO_SGC },
  });
  // no capability either, although it lists two: no event breakpoints
  await gotoRoute(page, "/workspace/sh4-debugger");
  await addPanelFromSelector(page, 3, "Events: Breakpoints");
  const events = panel(page, "events-breakpoints");
  await expect(events.getByRole("note")).toHaveText("This server has no event breakpoints.");
  await expect(events.getByRole("combobox")).toHaveCount(0);
  // what its ticks carry is shown as it comes: the device tree, the watches, the run state
  await expect(treeItem(page, "dc.sh4.cpu")).toBeVisible();
  await expect(panel(page, "watches")).toContainText("dc.sh4.cpu.pc = 0x8C001000");
  await expect(page.getByRole("status", { name: "Execution state" })).toHaveText("Paused · paused by the debugger · stop 1");
  expect(asked(server)).toEqual([]);

  // the banner can be put away, and is back with the next connection
  await notice.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  const connections = server.connections();
  server.drop();
  await expect.poll(() => server.connections()).toBe(connections + 1);
  await server.described();
  await expect(notice).toContainText("This server reports no debugger protocol version");
});

test("a describe result without `targets` lists none: every panel of a target says so, and nothing is asked of the server", async ({
  page,
}) => {
  const server = await serveScriptedDebugger(page);
  delete server.shape.targets;
  // A stop with a breakpoint in it, as a server sends one: there is nothing to follow it with.
  // Their addresses print otherwise in the format of any target (0x00001000 for the SH4, 005
  // for the DSP), which is not taken for a target the server does not list.
  server.state.execution = { state: "paused", stopId: 4, reason: "breakpoint", breakpointId: 7 };
  server.state.breakpoints = {
    "7": { id: 7, event: "dc.sh4.cpu.pc", address: 0x1000, kind: "code", enabled: true },
    "8": { id: 8, event: "dc.aica.dsp.step", address: 5, kind: "code", enabled: true },
  };
  server.state.callstacks = { sh4: [{ index: 0, pc: 0x8c001000, sp: 0x8cfff000, symbol: "_main+0x0" }], arm7: [] };

  await expectNoticesInEveryWorkspace(page, server, {
    ...WITHOUT_TARGETS,
    // the scripted server has no SGC capture among its capabilities
    "audio-debugger": { ...WITHOUT_TARGETS["audio-debugger"], sgc: NO_SGC },
  });
  // it says `protocol: 3`: there is no banner, and no other notice of the page
  await expect(page.getByRole("alert").filter({ hasText: "protocol" })).toHaveCount(0);

  // Its capabilities are read: the events panel has its box. A code breakpoint is of no
  // target here: it is listed with the events, its address as plain hex ("0x" and the digits).
  await gotoRoute(page, "/workspace/sh4-debugger");
  await addPanelFromSelector(page, 3, "Events: Breakpoints");
  const events = panel(page, "events-breakpoints");
  await expect(events.getByRole("note")).toHaveCount(0);
  await expect(events.getByRole("combobox")).toBeVisible();
  await expect(events.getByRole("listitem")).toHaveText([/^dc\.sh4\.cpu\.pc == 0x1000code/, /^dc\.aica\.dsp\.step == 0x5code/]);
  // and so does the stop it is in
  await expect(page.getByRole("status", { name: "Execution state" })).toHaveText("Paused · breakpoint dc.sh4.cpu.pc == 0x1000 · stop 4");
  await expect(events.getByRole("heading", { name: "Events", exact: true })).toBeVisible();
  await expect(events.getByRole("heading", { name: "SH4", exact: true })).toHaveCount(0);
  expect(asked(server)).toEqual([]);
});

// A running tick that says `registersStale` is about the registers of the SH4, whose node is
// `pcPath` of the SH4 in `targets`: the device tree dims them. A server that does not list the
// SH4 names no such node, and nothing is dimmed for a node the client knows of by itself.
for (const listed of [true, false]) {
  test(`a stale running tick dims the SH4's registers in the device tree ${listed ? "of a server that lists the SH4" : "only on a server that lists the SH4"}`, async ({
    page,
  }) => {
    const server = await serveScriptedDebugger(page);
    if (!listed) {
      server.shape.targets = (server.shape.targets as Json[]).filter((target) => target.id !== "sh4");
    }
    server.state.execution = { state: "running", stopId: 1, registersStale: true };
    await gotoRoute(page, "/workspace/arm7-debugger");
    await expect(statusBar(page)).toContainText("Connection: connected");
    await server.described();
    await treeItemRow(page, "dc.sh4.cpu").click();
    await expect(registerRow(page, "dc.sh4.cpu.reg.PC")).toBeVisible();
    // a tick of the stale run is in, and shown
    await tickAndWait(page, server);
    await expect(page.getByRole("status", { name: "Execution state" })).toContainText("Running");
    const stale = panel(page, "device-tree").locator(".device-tree-registers[data-stale]");
    await expect(stale).toHaveCount(listed ? 1 : 0);
    if (listed) {
      await expect(stale.locator('[data-register="dc.sh4.cpu.reg.PC"]')).toBeVisible();
    } else {
      await expect(registerRow(page, "dc.sh4.cpu.reg.PC").locator("xpath=..")).not.toHaveAttribute("data-stale");
    }
  });
}

test("a describe result without `capabilities` has none: no callstack, no event breakpoints, no SGC capture, and the targets as listed", async ({
  page,
}) => {
  const server = await serveScriptedDebugger(page);
  delete server.shape.capabilities;
  server.state.callstacks = { sh4: [{ index: 0, pc: 0x8c001000, sp: 0x8cfff000, symbol: "_main+0x0" }], arm7: [] };
  await gotoRoute(page, "/workspace/sh4-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");
  await server.described();

  // the frames are in the tick, and the server has not said that it has a callstack
  const callstack = panel(page, "sh4-callstack");
  await expect(callstack.getByRole("note")).toHaveText("This server has no callstack.");
  await expect(callstack.getByRole("listitem")).toHaveCount(0);
  await expect(callstack).not.toContainText("_main");

  // the targets are listed, and their panels are those of any server
  const view = panel(page, "sh4-disassembly");
  await expect(view.locator(".current-instruction")).toHaveAttribute("data-address", String(0x8c001000));
  await expect(tooltipButton(view, "Step In")).toBeEnabled();
  await expect(panel(page, "sh4-memory")).toContainText("0x8C010000");
  await expect(panel(page, "sh4-breakpoints").getByPlaceholder("Address (e.g., 0x8C0000A0)")).toBeVisible();
  await expect(page.getByRole("note")).toHaveCount(1);

  // (the events panel is a tab of the group the SH4's breakpoints are in)
  await addPanelFromSelector(page, 3, "Events: Breakpoints");
  const events = panel(page, "events-breakpoints");
  await expect(events.getByRole("note")).toHaveText("This server has no event breakpoints.");
  await expect(events.getByRole("combobox")).toHaveCount(0);

  await gotoRoute(page, "/workspace/audio-debugger");
  const sgc = panel(page, "sgc");
  await expect(sgc.getByRole("note")).toHaveText(NO_SGC);
  await expect(sgc.getByRole("button")).toHaveCount(0);
  await expect(panel(page, "dsp-disassembly").locator(".current-instruction")).toHaveCount(1);
  await tickAndWait(page, server);
  expect(asked(server).filter((method) => method !== "state.getDisassembly" && method !== "state.getMemorySlice")).toEqual([]);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a paused tick without `stopId` is no stop: nothing is followed, read again or announced", async ({ page }) => {
  const alerts = await recordAlerts(page);
  const announced = async () => (await alerts()).filter((text) => text.startsWith("Breakpoint hit:"));
  const server = await serveScriptedDebugger(page);
  server.state.execution = { state: "running", stopId: 0 };
  await gotoRoute(page, "/workspace/sh4-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");
  await server.described();
  const view = panel(page, "sh4-disassembly");
  const rows = disassemblyRows(view);
  const status = page.getByRole("status", { name: "Execution state" });
  const fetches = () => ({
    disassembly: server.requestsOf("state.getDisassembly").filter((params) => params.target === "sh4").length,
    memory: server.requestsOf("state.getMemorySlice").length,
  });

  // running at 0x8C001000: the view is there
  await expect(rows.first()).toHaveAttribute("data-address", String(0x8c001000 - 20));
  await expect(status).toHaveText("Running");
  await expect.poll(fetches).toEqual({ disassembly: 1, memory: 1 });

  // Running, then paused, at a breakpoint that is somewhere else: the tick has no stopId.
  // The run state is shown as the tick says; no stop is made from its change.
  const breakpoint = { id: 7, event: "dc.sh4.cpu.pc", address: 0x8c002000, kind: "code", enabled: true };
  server.state.breakpoints = { "7": breakpoint };
  server.state.execution = { state: "paused", reason: "breakpoint", breakpointId: 7 };
  server.setRegister("dc.sh4.cpu", "PC", "0x8C002000");
  await tickAndWait(page, server);
  await expect(status).toHaveText("Paused · breakpoint dc.sh4.cpu.pc == 0x8C002000");
  await expect(panel(page, "sh4-breakpoints").getByRole("listitem")).toHaveCount(1);
  await tickAndWait(page, server);
  await expect(rows.first()).toHaveAttribute("data-address", String(0x8c001000 - 20));
  await expect(view.locator(".current-instruction")).toHaveCount(0);
  expect(fetches()).toEqual({ disassembly: 1, memory: 1 });
  expect(await announced()).toEqual([]);

  // the same tick with a stopId is a stop: the view goes there, both views read again, the breakpoint is announced
  server.state.execution = { state: "paused", stopId: 1, reason: "breakpoint", breakpointId: 7 };
  await tickAndWait(page, server);
  await expect(rows.first()).toHaveAttribute("data-address", String(0x8c002000 - 20));
  await expect(view.locator(".current-instruction")).toHaveAttribute("data-address", String(0x8c002000));
  await expect.poll(fetches).toEqual({ disassembly: 2, memory: 2 });
  await expect.poll(announced).toEqual(["Breakpoint hit: dc.sh4.cpu.pc == 0x8C002000"]);

  // and again: running, then paused without a stopId, somewhere else
  server.state.execution = { state: "running", stopId: 1 };
  await tickAndWait(page, server);
  await expect(status).toHaveText("Running");
  server.state.execution = { state: "paused", reason: "breakpoint", breakpointId: 7 };
  server.setRegister("dc.sh4.cpu", "PC", "0x8C003000");
  await tickAndWait(page, server);
  await tickAndWait(page, server);
  await expect(rows.first()).toHaveAttribute("data-address", String(0x8c002000 - 20));
  expect(fetches()).toEqual({ disassembly: 2, memory: 2 });
  expect(await announced()).toHaveLength(1);

  // The first paused tick of a connection is a stop when it has a stopId, and not without one:
  // the page is back by itself, and nothing is announced for where the server is paused.
  const connections = server.connections();
  server.drop();
  await expect.poll(() => server.connections()).toBe(connections + 1);
  await server.described();
  await expect(statusBar(page)).toContainText("Connection: connected");
  await tickAndWait(page, server);
  await tickAndWait(page, server);
  await expect(status).toHaveText("Paused · breakpoint dc.sh4.cpu.pc == 0x8C002000");
  await expect(rows.first()).toHaveAttribute("data-address", String(0x8c002000 - 20));
  expect(await announced()).toHaveLength(1);
});

test("a tick without `callstacks` has no frames, one without `watches` no watches, and one without `categories` leaves the mute buttons as they are", async ({
  page,
}) => {
  const server = await serveScriptedDebugger(page);
  const frames = { sh4: [{ index: 0, pc: 0x8c001000, sp: 0x8cfff000, symbol: "_main+0x0" }], arm7: [] };
  const unmuted = { muted: false, soloed: false };
  server.state.callstacks = frames;
  server.state.watches = [{ id: 1, expression: "dc.sh4.cpu.pc", value: "0x8C001000" }];
  server.state.categories = { events: unmuted, sh4: { muted: true, soloed: false }, arm7: unmuted, dsp: unmuted };
  await gotoRoute(page, "/workspace/sh4-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");
  await server.described();
  const callstack = panel(page, "sh4-callstack");
  const watches = panel(page, "watches");
  const view = panel(page, "sh4-disassembly");
  await expect(callstack.getByRole("listitem")).toHaveCount(1);
  await expect(callstack).toContainText("_main+0x0");
  await expect(watches.getByRole("listitem")).toHaveCount(1);
  await expect(watches).toContainText("dc.sh4.cpu.pc = 0x8C001000");
  await expect(view.getByRole("button", { name: "Unmute category" })).toBeVisible();

  // The next tick of the same stop has none of the three. The frames of the tick before are
  // not kept, although the target is still stopped where they were found.
  await tickAndWait(page, server, { patch: { callstacks: undefined, watches: undefined, categories: undefined } });
  await expect(callstack.getByRole("listitem")).toHaveCount(0);
  await expect(callstack).toContainText("Empty callstack.");
  await expect(callstack).not.toContainText("_main");
  await expect(watches.getByRole("listitem")).toHaveCount(0);
  await expect(watches).not.toContainText("dc.sh4.cpu.pc");
  // the category was muted and still is: the tick did not say otherwise
  await expect(view.getByRole("button", { name: "Unmute category" })).toBeVisible();
  await expect(view.getByRole("button", { name: "Mute category", exact: true })).toHaveCount(0);

  // a tick that carries one category changes that one; the SH4's keeps its state
  await tickAndWait(page, server, { patch: { categories: { arm7: { muted: true, soloed: false } } } });
  await expect(view.getByRole("button", { name: "Unmute category" })).toBeVisible();
  // and a tick that has all three again is shown as it comes
  server.state.categories = { events: unmuted, sh4: unmuted, arm7: unmuted, dsp: unmuted };
  await tickAndWait(page, server);
  await expect(callstack).toContainText("_main+0x0");
  await expect(watches).toContainText("dc.sh4.cpu.pc = 0x8C001000");
  await expect(view.getByRole("button", { name: "Mute category", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("a binary frame without the header is not taken: the capture it was announced with does not arrive", async ({ page, diagnostics }) => {
  // the client waits ten seconds for the frame
  test.slow();
  diagnostics.allow(...KNOWN.sgcNoData);
  diagnostics.allow(/^console\.error: Failed to record SGC frame data: Error: The binary frame /, "the SGC panel logs a capture that failed");
  const server = await serveScriptedDebugger(page);
  (server.shape.capabilities as string[]).push("sgc-capture");
  const payload = new Uint8Array(SGC_BYTES_PER_FRAME).fill(0x11);
  let captures = 0;
  server.answer("state.getSgcFrameData", () => {
    captures++;
    if (captures === 1) {
      // the panel asks when it opens: nothing has been recorded
      return jsonRpcError(-32011, "no capture available");
    }
    const binaryId = captures;
    setTimeout(() => {
      if (captures === 2) {
        // the bare payload, with exactly the bytes that were announced
        server.sendBinary(payload);
      } else {
        // a frame with the header of this request, and half the bytes
        server.sendBinary(encodeBinaryFrame(BinaryFrameKind.SGC_FRAMES, binaryId, payload.subarray(0, SGC_BYTES_PER_FRAME / 2)));
      }
    }, 0);
    return { frameCount: 1, channelsPerFrame: 64, bytesPerChannel: 128, totalBytes: SGC_BYTES_PER_FRAME, binaryId };
  });
  await gotoRoute(page, "/workspace/audio-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");
  await server.described();
  const view = panel(page, "sgc");
  await expect(view.getByText("Record some data to display here")).toBeVisible();

  const record = tooltipButton(view, "Run the emulator and record 1024 frames");
  const startedAt = Date.now();
  await record.click();
  await expect(page.getByRole("alert").filter({ hasText: "Record: The binary frame announced by the server did not arrive within 10 s" })).toBeVisible({
    timeout: 30_000,
  });
  // it was waited for, for as long as for any frame
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(10_000);
  expect(server.requestsOf("state.getSgcFrameData")).toHaveLength(2);
  await expect(view.locator("canvas")).toHaveCount(0);

  // A frame with the header is looked at, and held to what was announced: the bare one before
  // it did reach the page, and was not taken for what it is not.
  await record.click();
  await expect(page.getByRole("alert").filter({ hasText: "Record: The binary frame carries 4096 bytes, the server announced 8192" })).toBeVisible();
  expect(server.requestsOf("state.getSgcFrameData")).toHaveLength(3);
});

test("the synthetic server of the performance spec is a server of protocol v3: no banner on the page it is measured on", async ({ page }) => {
  const synthetic = await serveSyntheticDebugger(page, { nodes: 4, registersPerNode: 3 });
  await gotoRoute(page, "/workspace/sh4-debugger");
  await synthetic.ready;
  await expect(statusBar(page)).toContainText("Connection: connected");
  await expect(treeItem(page, synthetic.nodePath(3))).toBeVisible();
  await expect(page.getByRole("status", { name: "Execution state" })).toHaveText("Paused · paused by the debugger · stop 1");
  synthetic.tick([1]);
  await treeItem(page, synthetic.nodePath(1)).locator(".MuiTreeItem-content").first().click();
  await expect(registerRow(page, `${synthetic.nodePath(1)}.reg.R00`)).toHaveText(`R00 = ${synthetic.value(1, 0)}`);

  // no banner, no dropped message, and no panel that has to say what the server does not have
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("note")).toHaveCount(0);
  await expect(panel(page, "sh4-breakpoints").getByPlaceholder("Address (e.g., 0x8C0000A0)")).toBeVisible();
  await expect(panel(page, "sh4-callstack")).toContainText("Empty callstack.");
  // its targets are listed, so its views ask for their lines and bytes
  expect(synthetic.requests.map((request) => request.method)).toEqual(
    expect.arrayContaining(["debugger.describe", "state.getDisassembly", "state.getMemorySlice"]),
  );

  // and what it sends is what the contract runner holds a server of protocol v3 to
  expect(StrictDebuggerRpcMethodSchemas["debugger.describe"].result.safeParse(synthetic.sent.describe).error?.issues ?? []).toEqual([]);
  expect(StrictDebuggerRpcMethodSchemas["event.tick"].params.safeParse(synthetic.sent.tick).error?.issues ?? []).toEqual([]);
});
