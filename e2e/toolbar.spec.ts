import {
  test,
  expect,
  addPanelFromSelector,
  currentInstructionAddress,
  disassemblyRows,
  dockTab,
  gotoRoute,
  openWorkspace,
  panel,
  recordAlerts,
  registerRow,
  saveScreenshot,
  statusBar,
  tooltipButton,
  treeItemRow,
  KNOWN,
  WORKSPACES,
  type RpcLog,
  type WorkspaceId,
} from "./support/fixtures";
import type { Locator, Page } from "@playwright/test";
import { expectMonacoReady, monacoEditor } from "./support/monaco";
import { defaultAnswer, inBandError, jsonRpcError, serveScriptedDebugger } from "./support/scriptedDebugger";
import { MOCK_M1_SUPPORT, MOCK_M2_SUPPORT } from "../server/mockDebugger";

// The toolbar of a workspace page: Run and Pause, the three steps of the focused target with
// the name of that target in front of them, and Reset; next to them the run state. The
// function keys do what the buttons do. A control that could only be refused is off and says
// why, and nothing is sent for it, by button or by key.

/** The run controls of the toolbar, which the views have step buttons of their own beside. */
const runControls = (page: Page): Locator => page.locator("header").getByRole("group", { name: "Run controls" });
/** A button of the toolbar by its name. */
const control = (page: Page, name: string): Locator => runControls(page).getByRole("button", { name, exact: true });
/** Which target the step buttons of the toolbar and the function keys act on. */
const focusedTarget = (page: Page): Locator => runControls(page).getByRole("status", { name: "Focused target" });
const executionState = (page: Page): Locator => page.getByRole("status", { name: "Execution state" });
/** The tooltip that says exactly this (the one of the button the pointer was on before may still be going). */
const tooltip = (page: Page, text: string): Locator => page.getByRole("tooltip").getByText(text, { exact: true });

const CONTROLS = ["Run", "Pause", "Step Into", "Step Over", "Step Out", "Reset"] as const;
const STEPS = ["Step Into", "Step Over", "Step Out"] as const;

/** What a button of the toolbar says about itself when it can be used: its name, and its key. */
const USABLE: Record<(typeof CONTROLS)[number], string> = {
  Run: "Run (F5)",
  Pause: "Pause (F6)",
  "Step Into": "Step Into (F11)",
  "Step Over": "Step Over (F10)",
  "Step Out": "Step Out (Shift+F11)",
  // it has no key: its name is all there is to say
  Reset: "",
};

/** A control that can be used: not off, and described by its key. */
const expectUsable = async (page: Page, name: (typeof CONTROLS)[number]) => {
  await expect(control(page, name), name).toBeEnabled();
  await expect(control(page, name), name).toHaveAccessibleDescription(USABLE[name]);
};

/** A control that is off, and why: it says so (aria-disabled), and its description is its name and the reason. */
const expectOff = async (page: Page, name: (typeof CONTROLS)[number], reason: string) => {
  await expect(control(page, name), name).toHaveAttribute("aria-disabled", "true");
  await expect(control(page, name), name).toHaveAccessibleDescription(`${name}: ${reason}`);
};

/** Every control.* request the page has sent, as "method target". */
const controlRequests = (rpc: RpcLog): string[] =>
  rpc.sent
    .filter((frame) => frame.method?.startsWith("control."))
    .map((frame) => [frame.method, (frame.params as { target?: string } | undefined)?.target].filter(Boolean).join(" "));

/** What the server answered with one of these error codes, in the result or as a JSON-RPC error. */
const refusals = (rpc: RpcLog, ...codes: number[]) =>
  rpc.received.filter((frame) => frame.method === undefined && codes.some((code) => JSON.stringify(frame).includes(`"code":${code}`)));

interface PressedKey {
  key: string;
  shift: boolean;
  repeat: boolean;
  /** somebody took the key: the browser does not do with it what it does by itself (F5 reloads, F11 is full screen) */
  prevented: boolean;
}

/**
 * Records every key press the page gets, behind the handlers of the page: whether one of them
 * took the key. Call it before the navigation; the function it returns hands over what was
 * pressed since it was last called.
 */
const recordKeys = async (page: Page): Promise<() => Promise<PressedKey[]>> => {
  await page.addInitScript(() => {
    const store = window as unknown as { __keys: PressedKey[] };
    store.__keys = [];
    window.addEventListener("keydown", (event) => {
      store.__keys.push({ key: event.key, shift: event.shiftKey, repeat: event.repeat, prevented: event.defaultPrevented });
    });
  });
  return () => page.evaluate(() => (window as unknown as { __keys: PressedKey[] }).__keys.splice(0));
};

/** The mock's SH4 and ARM7 walk a loop; the ARM7's calls a routine behind it. One instruction on from `address`. */
const nextInstruction = (target: "sh4" | "arm7" | "dsp", address: number): number => {
  if (target === "dsp") {
    return (address + 1) % 128;
  }
  if (target === "sh4") {
    return 0x8c0000a0 + ((address - 0x8c0000a0 + 2) % 16);
  }
  if (address === 0x00200024) {
    return 0x00200030;
  }
  if (address === 0x00200038) {
    return 0x00200028;
  }
  if (address >= 0x00200030 && address < 0x00200038) {
    return address + 4;
  }
  return 0x00200010 + ((address - 0x00200010 + 4) % 32);
};

test("Run and Pause follow the execution state reported by the ticks", async ({ page, rpc }) => {
  await openWorkspace(page, "sh4-debugger");
  const run = tooltipButton(page, "Run");
  const pause = tooltipButton(page, "Pause");

  // the mock starts running
  await expect(pause).toBeEnabled();
  await expect(run).toBeDisabled();

  await pause.click();
  await expect(run).toBeEnabled();
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

test("Run runs until a breakpoint stops the target: there is no second button for that", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  await tooltipButton(page, "Pause").click();
  const breakpoints = panel(page, "sh4-breakpoints");
  await breakpoints.getByPlaceholder("Address (e.g., 0x8C0000A0)").fill("0x8C0000AA");
  await breakpoints.getByPlaceholder("Address (e.g., 0x8C0000A0)").press("Enter");
  await expect(breakpoints.getByRole("listitem")).toHaveCount(1);

  // "Run to next breakpoint" did what Run does, and is gone
  await expect(page.getByRole("button", { name: "Run to next breakpoint" })).toHaveCount(0);
  await tooltipButton(page, "Run").click();
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

  await tooltipButton(page, "Run").click();
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

  // A program counter where nothing can be read, written through the watch. (An odd one is
  // refused when it is written: the server stores no PC that nothing executes at.)
  const watches = panel(page, "watches");
  await watches.getByText(/^0x8C0000A[0-9A-E]$/).dblclick();
  await watches.getByRole("listitem").getByRole("textbox").fill("0x10000000");
  await watches.getByRole("listitem").getByRole("textbox").press("Enter");
  await expect(watches).toContainText("dc.sh4.cpu.pc = 0x10000000");

  await tooltipButton(view, "Step In").click();
  await expect(page.getByRole("alert").filter({ hasText: "Step: cannot step: pc not readable" })).toBeVisible();
  await tooltipButton(view, "Step Over").click();
  await expect(page.getByRole("alert").filter({ hasText: "Step over: cannot step: pc not readable" })).toBeVisible();
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
  await tooltipButton(page, "Run").click();
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

test("the reason of a stop can be read in a window that is not wide: it wraps beside the run controls, or is under the toolbar", async ({
  page,
}, testInfo) => {
  const server = await serveScriptedDebugger(page);
  const notice = "SH4 runs on the interpreter while breakpoints are armed: FPU results can differ from a run without breakpoints";
  server.state.execution = { state: "paused", stopId: 3, reason: "breakpoint", breakpointId: 1, notice };
  server.state.breakpoints = { "1": { id: 1, event: "dc.sh4.cpu.pc", address: 0x8c001000, kind: "code", enabled: true } };
  await gotoRoute(page, "/workspace/sh4-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");
  await server.described();
  const text = "Paused · breakpoint dc.sh4.cpu.pc == 0x8C001000 · stop 3";
  const status = page.getByRole("status", { name: "Execution state" });
  const said = page.getByRole("status", { name: "Notice from the server" });

  /** What keeps a text from being read: it is cut off, it is outside the toolbar, or it lies on a control of the toolbar. */
  const unreadable = (locator: typeof status) =>
    locator.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const problems: string[] = [];
      if (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1) {
        problems.push(`its text needs ${element.scrollWidth}x${element.scrollHeight} px and has ${element.clientWidth}x${element.clientHeight}`);
      }
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const clip = ancestor.getBoundingClientRect();
        const clips = style.overflowX !== "visible" || style.overflowY !== "visible" || ancestor === document.documentElement;
        if (clips && (box.left < clip.left - 0.5 || box.right > clip.right + 0.5 || box.top < clip.top - 0.5 || box.bottom > clip.bottom + 0.5)) {
          problems.push(`cut off by <${ancestor.tagName.toLowerCase()} class="${ancestor.className}">`);
        }
      }
      const bar = element.closest("header")?.getBoundingClientRect();
      if (!bar || box.top < bar.top || box.bottom > bar.bottom) {
        problems.push("outside the toolbar");
      }
      for (const control of Array.from(document.querySelectorAll("header button, header input"))) {
        const other = control.getBoundingClientRect();
        if (box.left < other.right && other.left < box.right && box.top < other.bottom && other.top < box.bottom) {
          problems.push(`on top of ${control.getAttribute("aria-label") ?? control.textContent}`);
        }
      }
      return problems;
    });

  // beside the run controls from 1440 px on; under the toolbar in a narrower window, which has
  // six run controls where the status was
  /** The controls of the toolbar that lie on top of one another. */
  const overlapping = (target: Page) =>
    target.evaluate(() => {
      const controls = Array.from(document.querySelectorAll("header button, header input, header [role=status]")).filter((element) => {
        const box = element.getBoundingClientRect();
        // (the buttons inside the box of the page list are part of it)
        return box.width > 0 && box.height > 0 && element.closest(".MuiAutocomplete-endAdornment") === null && element.getAttribute("role") !== "switch";
      });
      const name = (element: Element) => element.getAttribute("aria-label") ?? element.textContent ?? element.tagName;
      const problems: string[] = [];
      controls.forEach((first, index) => {
        const a = first.getBoundingClientRect();
        for (const second of controls.slice(index + 1)) {
          const b = second.getBoundingClientRect();
          if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) {
            problems.push(`${name(first)} / ${name(second)}`);
          }
        }
      });
      return problems;
    });

  for (const width of [1600, 1440, 1439, 1280, 1024]) {
    await test.step(`${width} px wide`, async () => {
      await page.setViewportSize({ width, height: 800 });
      // one status is shown, with all of its text; the title has it too
      await expect(status).toHaveText(text);
      await expect(status).toHaveAttribute("title", text);
      await expect(status).toBeInViewport({ ratio: 1 });
      expect(await unreadable(status)).toEqual([]);
      // the notice: on one line beside the controls (its title has what is cut), all of it under the toolbar
      await expect(said).toHaveText(notice);
      await expect(said).toHaveAttribute("title", notice);
      if (width < 1440) {
        expect(await unreadable(said)).toEqual([]);
        // in a line of its own, under every control of the toolbar
        const line = (await status.boundingBox())!;
        for (const button of await page.locator("header button").all()) {
          const box = (await button.boundingBox())!;
          expect(line.y, `${width}: the status is below ${await button.getAttribute("aria-label")}`).toBeGreaterThanOrEqual(box.y + box.height - 1);
        }
      } else {
        // on the line of the run controls, to their right and to the left of what is on the right of the toolbar
        const line = (await status.boundingBox())!;
        const reset = (await control(page, "Reset").boundingBox())!;
        const disconnect = (await page.getByRole("button", { name: "Disconnect", exact: true }).boundingBox())!;
        expect(line.x).toBeGreaterThanOrEqual(reset.x + reset.width);
        expect(line.x + line.width).toBeLessThanOrEqual(disconnect.x);
        expect(line.y).toBeLessThan(reset.y + reset.height);
        // it has room: 240 px at least
        expect(await status.evaluate((element) => element.parentElement!.getBoundingClientRect().width)).toBeGreaterThanOrEqual(240);
      }
      // the run controls are where they were, each of them on screen and none under another control
      await expect(tooltipButton(page, "Run")).toBeEnabled();
      for (const name of CONTROLS) {
        await expect(control(page, name), `${width}: ${name}`).toBeInViewport({ ratio: 1 });
      }
      expect(await overlapping(page), `${width}: controls of the toolbar on top of each other`).toEqual([]);
      await saveScreenshot(page, testInfo, `toolbar-status-${width}`);
    });
  }
});

test.describe("the run controls, the step buttons and Go to current PC", () => {
  test.use({ mockOptions: { startPaused: true, graceMs: 600_000 } });

  test("are buttons with names: what the tooltip says is what the button is called", async ({ page, diagnostics }) => {
    // The tooltip of an icon button is its only text. On an element around the button it names
    // that element, and the button, which is what has the focus and what is announced, has no
    // name: by role and name it is then not found.
    await openWorkspace(page, "sh4-debugger");
    const named = (scope: Page | Locator, name: string) => scope.getByRole("button", { name, exact: true });
    for (const name of CONTROLS) {
      await expect(named(page.locator("header"), name), name).toHaveCount(1);
    }
    // the six of them, in this order, and no other button among them
    await expect(runControls(page).getByRole("button")).toHaveCount(6);
    expect(await runControls(page).getByRole("button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")))).toEqual([...CONTROLS]);
    const view = panel(page, "sh4-disassembly");
    for (const name of ["Step Over", "Step In", "Step Out", "Go to current PC", "Refresh"]) {
      await expect(named(view, name), name).toHaveCount(1);
    }
    // the button itself has the name, and it is the one the keyboard reaches
    for (const [scope, name] of [
      [page.locator("header"), "Run"],
      [page.locator("header"), "Step Into"],
      [page.locator("header"), "Reset"],
      [view, "Step In"],
      [view, "Go to current PC"],
    ] as const) {
      const button = named(scope, name);
      await expect(button).toHaveAttribute("aria-label", name);
      expect(await button.evaluate((element) => element.tagName)).toBe("BUTTON");
      await button.focus();
      await expect(button).toBeFocused();
    }

    // a button that cannot be used keeps its name: Pause while the target is stopped,
    // and the step buttons while it runs
    await expect(named(page.locator("header"), "Pause")).toHaveAttribute("aria-disabled", "true");
    await named(page.locator("header"), "Run").click();
    await expect(page.getByRole("status", { name: "Execution state" })).toHaveText("Running");
    for (const name of ["Step Over", "Step In", "Step Out"]) {
      await expect(named(view, name), name).toHaveAttribute("aria-disabled", "true");
      // and says why it cannot be used, beside its name
      await expect(named(view, name), name).toHaveAccessibleDescription(`${name}: the target is running`);
    }
    await expect(named(page.locator("header"), "Run")).toHaveAttribute("aria-disabled", "true");
    for (const name of STEPS) {
      await expect(named(page.locator("header"), name), name).toHaveAttribute("aria-disabled", "true");
    }
    // a button that is off keeps the keyboard focus: it is not `disabled`
    await named(page.locator("header"), "Step Over").focus();
    await expect(named(page.locator("header"), "Step Over")).toBeFocused();

    // the step button of the DSP view is called Step
    diagnostics.allow(...KNOWN.sgcNoData);
    await openWorkspace(page, "audio-debugger");
    const dsp = panel(page, "dsp-disassembly");
    for (const name of ["Step", "Go to current PC", "Refresh"]) {
      await expect(named(dsp, name), name).toHaveCount(1);
    }
  });
});

test.describe("the step buttons of the toolbar", () => {
  test.use({ mockOptions: { startPaused: true, graceMs: 600_000 } });

  /** The focused target of each workspace when its page opens, and the disassembly view of that target. */
  const OWN: Record<WorkspaceId, { target: "sh4" | "arm7" | "dsp"; label: string; view: string }> = {
    "sh4-debugger": { target: "sh4", label: "SH4", view: "sh4-disassembly" },
    "arm7-debugger": { target: "arm7", label: "ARM7", view: "arm7-disassembly" },
    "audio-debugger": { target: "dsp", label: "DSP", view: "dsp-disassembly" },
    "mixed-mode-debugger": { target: "sh4", label: "SH4", view: "sh4-disassembly" },
  };

  for (const workspace of WORKSPACES) {
    const own = OWN[workspace];
    test(`${workspace}: they act on the ${own.label}, the target the workspace is for, and the toolbar says so`, async ({ page, rpc, diagnostics }) => {
      if (workspace === "audio-debugger") {
        diagnostics.allow(...KNOWN.sgcNoData);
      }
      await openWorkspace(page, workspace);
      await expect(executionState(page)).toHaveText("Paused · waiting at the start · stop 1");
      await expect(focusedTarget(page)).toHaveText(own.label);
      await expect(focusedTarget(page)).toHaveAttribute("title", new RegExp(`act on the ${own.label}: the target of the panel that last had the focus`));
      const view = panel(page, own.view);
      const start = await currentInstructionAddress(view);

      // Step Into: one instruction of that target, and a new stop
      await expectUsable(page, "Step Into");
      await control(page, "Step Into").click();
      await expect(executionState(page)).toHaveText("Paused · step completed · stop 2");
      await expect(view.locator(".current-instruction")).toHaveAttribute("data-address", String(nextInstruction(own.target, start)));
      expect(controlRequests(rpc)).toEqual([`control.step ${own.target}`]);

      if (own.target === "dsp") {
        // the DSP has its 128 steps and no calls: there is nothing to step over or out of, on any server
        for (const name of ["Step Over", "Step Out"] as const) {
          await expectOff(page, name, "the DSP has no calls to step over or out of");
          await control(page, name).click({ force: true });
        }
        await control(page, "Step Into").click();
        await expect(executionState(page)).toHaveText("Paused · step completed · stop 3");
        expect(controlRequests(rpc)).toEqual(["control.step dsp", "control.step dsp"]);
      } else {
        // Step Over: on a line that is no call it is one instruction too
        await expectUsable(page, "Step Over");
        await control(page, "Step Over").click();
        await expect(executionState(page)).toHaveText("Paused · step completed · stop 3");
        await expect(view.locator(".current-instruction")).toHaveAttribute(
          "data-address",
          String(nextInstruction(own.target, nextInstruction(own.target, start))),
        );
        // Step Out: the target runs to its return, and stops there
        await expectUsable(page, "Step Out");
        await control(page, "Step Out").click();
        await expect(executionState(page)).toHaveText("Paused · step completed · stop 4");
        expect(controlRequests(rpc)).toEqual([`control.step ${own.target}`, `control.stepOver ${own.target}`, `control.stepOut ${own.target}`]);
      }
      // nothing was asked that the server refused
      expect(refusals(rpc, -32003, -32004, -32012)).toEqual([]);
      await expect(page.getByRole("alert")).toHaveCount(0);
    });
  }

  test("Pause names the focused target, as the steps do, when the server lists it", async ({ page, rpc }) => {
    await openWorkspace(page, "arm7-debugger");
    await control(page, "Run").click();
    await expect(executionState(page)).toHaveText("Running");
    await expectUsable(page, "Pause");
    await control(page, "Pause").click();
    await expect(executionState(page)).toHaveText("Paused · paused by the debugger · stop 2");
    expect(controlRequests(rpc)).toEqual(["control.runUntil", "control.pause arm7"]);
  });

  test("in the mixed-mode workspace the focused target follows the panels: the one of a target that last had the focus", async ({ page, rpc }, testInfo) => {
    await openWorkspace(page, "mixed-mode-debugger");
    const target = focusedTarget(page);
    const sh4 = panel(page, "sh4-disassembly");
    const arm7 = panel(page, "arm7-disassembly");
    await expect(target).toHaveText("SH4");
    const sh4Start = await currentInstructionAddress(sh4);
    const arm7Start = await currentInstructionAddress(arm7);

    // a click in the listing of the ARM7
    await arm7.locator(".current-instruction span").first().click();
    await expect(target).toHaveText("ARM7");
    await saveScreenshot(page, testInfo, "toolbar-focused-arm7");
    // the toolbar steps the ARM7 now, and the SH4 stays where it is
    await control(page, "Step Into").click();
    await expect(arm7.locator(".current-instruction")).toHaveAttribute("data-address", String(nextInstruction("arm7", arm7Start)));
    await expect(sh4.locator(".current-instruction")).toHaveAttribute("data-address", String(sh4Start));
    expect(controlRequests(rpc)).toEqual(["control.step arm7"]);
    // a click on the toolbar is no panel: the target is still the ARM7's
    await expect(target).toHaveText("ARM7");

    // the callstack of the SH4, in the dock on the right
    await panel(page, "sh4-callstack").click({ position: { x: 150, y: 12 } });
    await expect(target).toHaveText("SH4");
    await control(page, "Step Over").click();
    await expect(sh4.locator(".current-instruction")).toHaveAttribute("data-address", String(nextInstruction("sh4", sh4Start)));
    expect(controlRequests(rpc)).toEqual(["control.step arm7", "control.stepOver sh4"]);

    // and the callstack of the ARM7
    await panel(page, "arm7-callstack").click({ position: { x: 150, y: 12 } });
    await expect(target).toHaveText("ARM7");

    // a panel that is of no target leaves it as it is: the watches, the device tree
    await panel(page, "watches").getByPlaceholder("Enter expression").click();
    await expect(panel(page, "watches").getByPlaceholder("Enter expression")).toBeFocused();
    await expect(target).toHaveText("ARM7");
    await panel(page, "device-tree").getByPlaceholder("Search components...").click();
    await expect(target).toHaveText("ARM7");

    // The pointer goes down in a panel and the keyboard focus stays where it is (a scroll bar
    // takes none): that panel is the one in use all the same.
    const focusedBefore = await page.evaluate(() => document.activeElement?.getAttribute("placeholder"));
    await panel(page, "sh4-callstack").dispatchEvent("pointerdown");
    await expect(target).toHaveText("SH4");
    await arm7.locator("[data-address]").first().dispatchEvent("pointerdown");
    await expect(target).toHaveText("ARM7");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("placeholder"))).toBe(focusedBefore);

    // the keyboard: the focus moves into a panel without a click
    await sh4.getByRole("textbox").focus();
    await expect(target).toHaveText("SH4");
    // and from the last control of the SH4's view on, with the Tab key, to the group of the ARM7's
    await tooltipButton(sh4, "Refresh").focus();
    const inArm7Group = () =>
      page.evaluate(() => document.activeElement?.closest(".dv-groupview")?.querySelector('[data-panel-id="arm7-disassembly"]') != null);
    for (let presses = 0; presses < 8 && !(await inArm7Group()); presses++) {
      await expect(target).toHaveText("SH4");
      await page.keyboard.press("Tab");
    }
    expect(await inArm7Group()).toBe(true);
    await expect(target).toHaveText("ARM7");
    await page.keyboard.press("F11");
    await expect(arm7.locator(".current-instruction")).toHaveAttribute("data-address", String(nextInstruction("arm7", nextInstruction("arm7", arm7Start))));
    expect(controlRequests(rpc)).toEqual(["control.step arm7", "control.stepOver sh4", "control.step arm7"]);
  });

  test("a click on the tab of a panel is the focus of that panel, and a panel that is added has it", async ({ page }) => {
    await openWorkspace(page, "sh4-debugger");
    const target = focusedTarget(page);
    await expect(target).toHaveText("SH4");
    // the listing of the ARM7 as a tab beside the SH4's: it is the one its group shows now
    await addPanelFromSelector(page, 1, "ARM7: Disassembly");
    await expect(panel(page, "arm7-disassembly")).toBeVisible();
    await expect(target).toHaveText("ARM7");
    await dockTab(page, "SH4: Disassembly").click();
    await expect(panel(page, "sh4-disassembly")).toBeVisible();
    await expect(target).toHaveText("SH4");
    await dockTab(page, "ARM7: Disassembly").click();
    await expect(target).toHaveText("ARM7");
    // the tabs of another group: the registers of the SH4 behind its breakpoints
    await dockTab(page, "SH4: Registers").click();
    await expect(target).toHaveText("SH4");
    // a register panel of an on-chip module is a panel of the SH4
    await dockTab(page, "ARM7: Disassembly").click();
    await expect(target).toHaveText("ARM7");
    await addPanelFromSelector(page, 2, "SH4: TMU Registers");
    await expect(panel(page, "tmu-registers")).toBeVisible();
    await expect(target).toHaveText("SH4");
  });

  test("every workspace page starts with its own target, whatever had the focus on the page before", async ({ page, diagnostics }) => {
    diagnostics.allow(...KNOWN.sgcNoData);
    await openWorkspace(page, "mixed-mode-debugger");
    await panel(page, "arm7-disassembly").locator(".current-instruction span").first().click();
    await expect(focusedTarget(page)).toHaveText("ARM7");
    for (const [workspace, label] of [
      ["sh4-debugger", "SH4"],
      ["audio-debugger", "DSP"],
      ["arm7-debugger", "ARM7"],
      ["mixed-mode-debugger", "SH4"],
    ] as const) {
      await gotoRoute(page, `/workspace/${workspace}`);
      await expect(panel(page, OWN[workspace].view).locator(".current-instruction")).toHaveCount(1);
      await expect(focusedTarget(page), workspace).toHaveText(label);
    }
    // and after a reload of the page
    await panel(page, "arm7-disassembly").locator(".current-instruction span").first().click();
    await expect(focusedTarget(page)).toHaveText("ARM7");
    await page.reload();
    await expect(panel(page, "sh4-disassembly").locator(".current-instruction")).toHaveCount(1);
    await expect(focusedTarget(page)).toHaveText("SH4");
  });
});

test.describe("the function keys", () => {
  test.use({ mockOptions: { startPaused: true, graceMs: 600_000 } });

  /** Presses a key and says what became of it: whether the page took it. */
  const press = async (page: Page, keys: () => Promise<PressedKey[]>, key: string): Promise<PressedKey[]> => {
    await keys();
    await page.keyboard.press(key);
    return (await keys()).filter((pressed) => !["Shift", "Control", "Alt", "Meta"].includes(pressed.key));
  };
  const taken = (key: string, shift = false): PressedKey[] => [{ key, shift, repeat: false, prevented: true }];
  const left = (key: string, shift = false): PressedKey[] => [{ key, shift, repeat: false, prevented: false }];

  test("F5 runs, F6 pauses, F10 steps over, F11 steps into and Shift+F11 out, with F8 and Shift+F8 for the last two", async ({ page, rpc }) => {
    const keys = await recordKeys(page);
    await openWorkspace(page, "sh4-debugger");
    const view = panel(page, "sh4-disassembly");
    const state = executionState(page);
    await expect(state).toHaveText("Paused · waiting at the start · stop 1");
    let address = await currentInstructionAddress(view);
    // the focus is on the page: nothing was clicked
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("BODY");

    expect(await press(page, keys, "F11")).toEqual(taken("F11"));
    await expect(state).toHaveText("Paused · step completed · stop 2");
    address = nextInstruction("sh4", address);
    await expect(view.locator(".current-instruction")).toHaveAttribute("data-address", String(address));

    expect(await press(page, keys, "F10")).toEqual(taken("F10"));
    await expect(state).toHaveText("Paused · step completed · stop 3");
    address = nextInstruction("sh4", address);
    await expect(view.locator(".current-instruction")).toHaveAttribute("data-address", String(address));

    expect(await press(page, keys, "F8")).toEqual(taken("F8"));
    await expect(state).toHaveText("Paused · step completed · stop 4");
    await expect(view.locator(".current-instruction")).toHaveAttribute("data-address", String(nextInstruction("sh4", address)));

    expect(await press(page, keys, "Shift+F11")).toEqual(taken("F11", true));
    await expect(state).toHaveText("Paused · step completed · stop 5");
    expect(await press(page, keys, "Shift+F8")).toEqual(taken("F8", true));
    await expect(state).toHaveText("Paused · step completed · stop 6");

    expect(await press(page, keys, "F5")).toEqual(taken("F5"));
    await expect(state).toHaveText("Running");
    expect(await press(page, keys, "F6")).toEqual(taken("F6"));
    await expect(state).toHaveText("Paused · paused by the debugger · stop 7");

    expect(controlRequests(rpc)).toEqual([
      "control.step sh4",
      "control.stepOver sh4",
      "control.step sh4",
      "control.stepOut sh4",
      "control.stepOut sh4",
      "control.runUntil",
      "control.pause sh4",
    ]);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("they act on the focused target", async ({ page, rpc }) => {
    await openWorkspace(page, "mixed-mode-debugger");
    await expect(executionState(page)).toHaveText("Paused · waiting at the start · stop 1");
    await page.keyboard.press("F11");
    await expect(executionState(page)).toHaveText("Paused · step completed · stop 2");
    await panel(page, "arm7-disassembly").locator(".current-instruction span").first().click();
    await expect(focusedTarget(page)).toHaveText("ARM7");
    await page.keyboard.press("F10");
    await expect(executionState(page)).toHaveText("Paused · step completed · stop 3");
    await page.keyboard.press("Shift+F11");
    await expect(executionState(page)).toHaveText("Paused · step completed · stop 4");
    expect(controlRequests(rpc)).toEqual(["control.step sh4", "control.stepOver arm7", "control.stepOut arm7"]);
  });

  test("a key whose control is off sends nothing, and is still not the browser's", async ({ page, rpc, diagnostics }) => {
    diagnostics.allow(...KNOWN.sgcNoData);
    const keys = await recordKeys(page);
    const loads: string[] = [];
    page.on("load", () => loads.push(page.url()));
    await openWorkspace(page, "audio-debugger");
    await expect(executionState(page)).toHaveText("Paused · waiting at the start · stop 1");
    expect(loads).toHaveLength(1);
    // paused: Pause is off; the DSP is never stepped over or out of
    for (const [key, shift] of [
      ["F6", false],
      ["F10", false],
      ["Shift+F11", true],
      ["Shift+F8", true],
    ] as const) {
      expect(await press(page, keys, key), key).toEqual(taken(key.replace("Shift+", ""), shift));
    }
    expect(controlRequests(rpc)).toEqual([]);

    // running: no step, and no second Run
    expect(await press(page, keys, "F5")).toEqual(taken("F5"));
    await expect(executionState(page)).toHaveText("Running");
    for (const key of ["F5", "F11", "F8", "F10"]) {
      expect(await press(page, keys, key), key).toEqual(taken(key));
    }
    await expect(executionState(page)).toHaveText("Running");
    expect(controlRequests(rpc)).toEqual(["control.runUntil"]);
    // the page is the one that was loaded: F5 did not load it again
    expect(loads).toHaveLength(1);
    expect(refusals(rpc, -32003, -32004)).toEqual([]);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("a key that is held down is used once", async ({ page, rpc }) => {
    const keys = await recordKeys(page);
    await openWorkspace(page, "sh4-debugger");
    const view = panel(page, "sh4-disassembly");
    await expect(executionState(page)).toHaveText("Paused · waiting at the start · stop 1");
    const address = await currentInstructionAddress(view);
    await keys();

    await page.keyboard.down("F11");
    await page.keyboard.down("F11");
    await page.keyboard.down("F11");
    await page.keyboard.down("F11");
    await page.keyboard.up("F11");
    // every one of them was taken from the browser, and the target was stepped once
    expect(await keys()).toEqual([
      { key: "F11", shift: false, repeat: false, prevented: true },
      { key: "F11", shift: false, repeat: true, prevented: true },
      { key: "F11", shift: false, repeat: true, prevented: true },
      { key: "F11", shift: false, repeat: true, prevented: true },
    ]);
    await expect(executionState(page)).toHaveText("Paused · step completed · stop 2");
    await expect(view.locator(".current-instruction")).toHaveAttribute("data-address", String(nextInstruction("sh4", address)));
    // the target is paused all the while: nothing but the rule keeps the repeats from stepping it
    await page.waitForTimeout(300);
    expect(controlRequests(rpc)).toEqual(["control.step sh4"]);
    await expect(executionState(page)).toHaveText("Paused · step completed · stop 2");

    // pressed again it steps again
    await page.keyboard.press("F11");
    await expect(executionState(page)).toHaveText("Paused · step completed · stop 3");
    expect(controlRequests(rpc)).toEqual(["control.step sh4", "control.step sh4"]);
  });

  test("with the focus in an address box: F5 runs the target and does not load the page again", async ({ page, rpc }) => {
    const keys = await recordKeys(page);
    const loads: string[] = [];
    page.on("load", () => loads.push(page.url()));
    await openWorkspace(page, "sh4-debugger");
    await expect(executionState(page)).toHaveText("Paused · waiting at the start · stop 1");
    for (const box of [panel(page, "sh4-disassembly").getByRole("textbox"), panel(page, "sh4-memory").getByRole("textbox"), panel(page, "watches").getByPlaceholder("Enter expression")]) {
      await box.click();
      await box.fill("0x8C0000");
      await expect(box).toBeFocused();
      const before = controlRequests(rpc).length;
      const stop = Number((await executionState(page).innerText()).match(/stop (\d+)$/)![1]);

      expect(await press(page, keys, "F11")).toEqual(taken("F11"));
      await expect(executionState(page)).toHaveText(`Paused · step completed · stop ${stop + 1}`);
      expect(await press(page, keys, "F5")).toEqual(taken("F5"));
      await expect(executionState(page)).toHaveText("Running");
      expect(await press(page, keys, "F6")).toEqual(taken("F6"));
      await expect(executionState(page)).toHaveText(`Paused · paused by the debugger · stop ${stop + 2}`);
      expect(controlRequests(rpc).slice(before)).toEqual(["control.step sh4", "control.runUntil", "control.pause sh4"]);
      // the box has the focus and what was typed into it, which was sent nowhere
      await expect(box).toBeFocused();
      await expect(box).toHaveValue("0x8C0000");
    }
    expect(loads).toHaveLength(1);
  });

  test("with the focus on a value, and in the editor of one: a resume from the editor puts it away", async ({ page, rpc }) => {
    const keys = await recordKeys(page);
    await openWorkspace(page, "sh4-debugger");
    await expect(executionState(page)).toHaveText("Paused · waiting at the start · stop 1");
    await dockTab(page, "SH4: Registers").click();
    const registers = panel(page, "sh4-registers");
    const value = registers.locator('tr[data-register="R0"] td.register-value span');
    await value.focus();
    await expect(registers.getByRole("button", { name: /^R0 0x[0-9A-F]{8}, write$/ })).toBeFocused();

    // on the value: a step, and the focus stays on it
    expect(await press(page, keys, "F10")).toEqual(taken("F10"));
    await expect(executionState(page)).toHaveText("Paused · step completed · stop 2");
    await expect(value).toBeFocused();

    // in its editor: the keys of the editor are the editor's (F2 opened it), the function keys the toolbar's
    await page.keyboard.press("F2");
    const editor = registers.getByRole("textbox", { name: "New value of R0" });
    await expect(editor).toBeFocused();
    await page.keyboard.type("0x77");
    expect(await press(page, keys, "F11")).toEqual(taken("F11"));
    await expect(executionState(page)).toHaveText("Paused · step completed · stop 3");
    // a step leaves the target paused, and the editor open with what was typed
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue(/0x77$/);

    expect(await press(page, keys, "F5")).toEqual(taken("F5"));
    await expect(executionState(page)).toHaveText("Running");
    // the target runs again: the editor goes, with its draft, and the focus is on the value
    await expect(editor).toHaveCount(0);
    await expect(value).toBeFocused();
    expect(rpc.requests("state.setRegister")).toEqual([]);
    expect(await press(page, keys, "F6")).toEqual(taken("F6"));
    await expect(executionState(page)).toHaveText("Paused · paused by the debugger · stop 4");

    // a byte of the memory view, and its editor
    const memory = panel(page, "sh4-memory");
    const place = memory.locator("[data-memory-hex][tabindex='0']");
    await place.focus();
    await expect(place).toBeFocused();
    expect(await press(page, keys, "F8")).toEqual(taken("F8"));
    await expect(executionState(page)).toHaveText("Paused · step completed · stop 5");
    await expect(place).toBeFocused();
    await page.keyboard.press("Enter");
    const bytes = memory.getByRole("textbox", { name: /^Bytes to write from/ });
    await expect(bytes).toBeFocused();
    expect(await press(page, keys, "F5")).toEqual(taken("F5"));
    await expect(executionState(page)).toHaveText("Running");
    await expect(bytes).toHaveCount(0);
    expect(rpc.requests("state.writeMemory")).toEqual([]);

    expect(controlRequests(rpc)).toEqual([
      "control.stepOver sh4",
      "control.step sh4",
      "control.runUntil",
      "control.pause sh4",
      "control.step sh4",
      "control.runUntil",
    ]);
  });

  test("in Monaco the keys are the editor's: nothing is run or stepped from there", async ({ page, rpc }) => {
    const keys = await recordKeys(page);
    await openWorkspace(page, "sh4-debugger");
    await expect(executionState(page)).toHaveText("Paused · waiting at the start · stop 1");
    await addPanelFromSelector(page, 1, "SH4: Simulator");
    const editor = monacoEditor(panel(page, "sh4-sim"));
    await expectMonacoReady(editor);
    await editor.click();
    expect(await page.evaluate(() => document.activeElement?.closest(".monaco-editor") !== null)).toBe(true);

    // (what Monaco does with a key is Monaco's: F5 is none of its keys)
    expect(await press(page, keys, "F5")).toEqual(left("F5"));
    for (const key of ["F10", "F11", "F8", "Shift+F11", "Shift+F8"]) {
      await page.keyboard.press(key);
    }
    await page.waitForTimeout(300);
    expect(controlRequests(rpc)).toEqual([]);
    await expect(executionState(page)).toHaveText("Paused · waiting at the start · stop 1");

    // with the focus out of the editor again they are the toolbar's
    await panel(page, "sh4-memory").getByRole("textbox").click();
    expect(await press(page, keys, "F5")).toEqual(taken("F5"));
    await expect(executionState(page)).toHaveText("Running");
    // and running, F6 in the editor pauses nothing
    await editor.click();
    await page.keyboard.press("F6");
    await page.waitForTimeout(300);
    await expect(executionState(page)).toHaveText("Running");
    expect(controlRequests(rpc)).toEqual(["control.runUntil"]);
  });

  // Monaco makes the Find box of an editor at the first Ctrl+F, gives it the role of a dialog,
  // and keeps it in the document from then on: closed, it is moved out of sight above the
  // editor, with a place on the page still. It is a part of its editor, open or closed.
  for (const [workspace, title, id, target, label] of [
    ["sh4-debugger", "SH4: Simulator", "sh4-sim", "sh4", "SH4"],
    ["audio-debugger", "DSP: Playground", "dsp-playground", "dsp", "DSP"],
  ] as const) {
    test(`the Find box of an editor is no dialog of the page: open or closed, the keys are the toolbar's outside the editor (${title})`, async ({ page, rpc, diagnostics }) => {
      if (workspace === "audio-debugger") {
        diagnostics.allow(...KNOWN.sgcNoData);
      }
      const keys = await recordKeys(page);
      const loads: string[] = [];
      page.on("load", () => loads.push(page.url()));
      await openWorkspace(page, workspace);
      await expect(executionState(page)).toHaveText("Paused · waiting at the start · stop 1");
      await addPanelFromSelector(page, 1, title);
      const editor = monacoEditor(panel(page, id));
      await expectMonacoReady(editor);
      const find = editor.locator(".find-widget");
      /** Whether the box has a place on the page, as far as the document says. */
      const hasPlace = () => find.evaluate((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
      // a box of another dock, which the editor's panel is not in front of
      const outside = panel(page, "watches").getByPlaceholder("Enter expression");
      await expect(focusedTarget(page)).toHaveText(label);
      // no editor has been searched yet: there is no box
      await expect(find).toHaveCount(0);

      // Find: the focus is in the box, and what is pressed there is the editor's
      await editor.click();
      await page.keyboard.press("ControlOrMeta+F");
      await expect(find).toHaveClass(/(^| )visible( |$)/);
      await expect(find).toHaveAttribute("role", "dialog");
      expect(await page.evaluate(() => document.activeElement?.closest(".find-widget") !== null)).toBe(true);
      expect(await press(page, keys, "F5")).toEqual(left("F5"));
      await page.keyboard.press("F11");
      await page.waitForTimeout(300);
      expect(controlRequests(rpc)).toEqual([]);

      // closed: it is in the document, a dialog still, and has a place there
      await page.keyboard.press("Escape");
      await expect(find).not.toHaveClass(/(^| )visible( |$)/);
      await expect(find).toHaveAttribute("aria-hidden", "true");
      await expect(find).toHaveAttribute("role", "dialog");
      // (it has gone where it goes: above the top of its editor)
      await expect(find).not.toBeInViewport();
      expect(await hasPlace()).toBe(true);
      await outside.click();
      await expect(outside).toBeFocused();
      expect(await press(page, keys, "F11")).toEqual(taken("F11"));
      await expect(executionState(page)).toHaveText("Paused · step completed · stop 2");
      expect(controlRequests(rpc)).toEqual([`control.step ${target}`]);

      // open, with the focus out of the editor: the box is in front of its editor, and of nothing else
      await editor.click();
      await page.keyboard.press("ControlOrMeta+F");
      await expect(find).toHaveClass(/(^| )visible( |$)/);
      await expect(find).toBeInViewport();
      await outside.click();
      await expect(outside).toBeFocused();
      await expect(find).toHaveClass(/(^| )visible( |$)/);
      await expect(find).not.toHaveAttribute("aria-hidden", "true");
      expect(await press(page, keys, "F11")).toEqual(taken("F11"));
      await expect(executionState(page)).toHaveText("Paused · step completed · stop 3");
      // F5 runs the target, and does not load the page again
      expect(await press(page, keys, "F5")).toEqual(taken("F5"));
      await expect(executionState(page)).toHaveText("Running");
      expect(await press(page, keys, "F6")).toEqual(taken("F6"));
      await expect(executionState(page)).toHaveText("Paused · paused by the debugger · stop 4");
      expect(controlRequests(rpc)).toEqual([`control.step ${target}`, `control.step ${target}`, "control.runUntil", `control.pause ${target}`]);
      expect(loads).toHaveLength(1);
    });
  }

  test("while a dialog is open the keys are not the toolbar's", async ({ page, rpc }) => {
    const keys = await recordKeys(page);
    await openWorkspace(page, "sh4-debugger");
    await expect(executionState(page)).toHaveText("Paused · waiting at the start · stop 1");
    const dialog = page.getByRole("dialog");

    // the About dialog, the connection picker and the list of panels to add
    for (const [name, open] of [
      ["About", () => page.getByRole("button", { name: "About", exact: true }).click()],
      ["connection picker", () => statusBar(page).getByRole("button", { name: /^Endpoint: / }).click()],
      ["panel list", () => page.getByLabel("Add Panel", { exact: true }).nth(1).click()],
    ] as const) {
      await open();
      await expect(dialog, name).toBeVisible();
      for (const [key, shift] of [
        ["F5", false],
        ["F10", false],
        ["F11", false],
        ["F8", false],
        ["Shift+F11", true],
      ] as const) {
        expect(await press(page, keys, key), `${name}: ${key}`).toEqual(left(key.replace("Shift+", ""), shift));
      }
      await page.keyboard.press("Escape");
      await expect(dialog, name).toHaveCount(0);
    }
    await page.waitForTimeout(300);
    expect(controlRequests(rpc)).toEqual([]);
    await expect(executionState(page)).toHaveText("Paused · waiting at the start · stop 1");

    // closed, they are the toolbar's again
    expect(await press(page, keys, "F11")).toEqual(taken("F11"));
    await expect(executionState(page)).toHaveText("Paused · step completed · stop 2");
    expect(controlRequests(rpc)).toEqual(["control.step sh4"]);

    // A dialog is open when it is on screen. One that is kept in the document while it is
    // closed is not; one that is on screen is, whoever put it there and whatever kind it is.
    const putDialog = (role: string, css: string) =>
      page.evaluate(
        ([dialogRole, style]) => {
          const element = document.createElement("div");
          element.id = "a-dialog-of-the-test";
          element.setAttribute("role", dialogRole);
          element.style.cssText = style;
          element.textContent = "a dialog";
          document.body.append(element);
        },
        [role, css],
      );
    const removeDialog = () => page.evaluate(() => document.getElementById("a-dialog-of-the-test")!.remove());
    let stop = 2;
    for (const css of ["display: none", "visibility: hidden"]) {
      await putDialog("dialog", css);
      expect(await press(page, keys, "F11"), css).toEqual(taken("F11"));
      await expect(executionState(page)).toHaveText(`Paused · step completed · stop ${++stop}`);
      await removeDialog();
    }
    for (const role of ["dialog", "alertdialog"]) {
      await putDialog(role, "position: fixed; top: 0; left: 0");
      expect(await press(page, keys, "F11"), role).toEqual(left("F11"));
      expect(await press(page, keys, "F5"), role).toEqual(left("F5"));
      // Kept from assistive technology, it is on screen all the same: that is what a dialog
      // is while a menu that was opened from it is up (the library says so of everything
      // behind its topmost layer).
      await page.evaluate(() => document.getElementById("a-dialog-of-the-test")!.setAttribute("aria-hidden", "true"));
      expect(await press(page, keys, "F11"), `${role}, aria-hidden`).toEqual(left("F11"));
      expect(await press(page, keys, "F5"), `${role}, aria-hidden`).toEqual(left("F5"));
      await removeDialog();
    }
    await page.waitForTimeout(200);
    await expect(executionState(page)).toHaveText(`Paused · step completed · stop ${stop}`);
    expect(controlRequests(rpc)).toEqual(["control.step sh4", "control.step sh4", "control.step sh4"]);
  });

  test("a dialog that is closing is closed: a key right behind Escape is the toolbar's, while the dialog fades out", async ({ page, rpc }) => {
    const keys = await recordKeys(page);
    // how many dialogs of the page are in the document when a key goes down, before anybody has handled it
    await page.addInitScript(() => {
      const store = window as unknown as { __dialogsAtKey: Array<{ key: string; dialogs: number }> };
      store.__dialogsAtKey = [];
      window.addEventListener(
        "keydown",
        (event) => {
          const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter((dialog) => dialog.closest(".monaco-editor") === null);
          store.__dialogsAtKey.push({ key: event.key, dialogs: dialogs.length });
        },
        true,
      );
    });
    const dialogsAt = (key: string) =>
      page.evaluate((pressed) => (window as unknown as { __dialogsAtKey: Array<{ key: string; dialogs: number }> }).__dialogsAtKey.filter((entry) => entry.key === pressed).map((entry) => entry.dialogs), key);
    await openWorkspace(page, "sh4-debugger");
    await expect(executionState(page)).toHaveText("Paused · waiting at the start · stop 1");
    const dialog = page.getByRole("dialog");

    // the About dialog, the connection picker and the list of panels to add; a key each
    for (const [name, open, key, state, request] of [
      ["About", () => page.getByRole("button", { name: "About", exact: true }).click(), "F11", "Paused · step completed · stop 2", "control.step sh4"],
      ["connection picker", () => statusBar(page).getByRole("button", { name: /^Endpoint: / }).click(), "F5", "Running", "control.runUntil"],
      ["panel list", () => page.getByLabel("Add Panel", { exact: true }).nth(1).click(), "F6", "Paused · paused by the debugger · stop 3", "control.pause sh4"],
    ] as const) {
      await open();
      await expect(dialog, name).toBeVisible();
      // open, the key is left to the browser
      expect(await press(page, keys, key), `${name}: ${key} while the dialog is open`).toEqual(left(key));
      // Closed with Escape, and fading out (its exit transition takes what is around the dialog
      // to transparent, and the dialog is in the document until it is over): the key is the
      // toolbar's. (The key goes down as soon as the dialog is fading, as one right behind
      // Escape does: a page that is busy may render the close a little after the Escape.)
      await keys();
      await page.keyboard.press("Escape");
      await page.waitForFunction(
        () => {
          const shown = document.querySelector('[role="dialog"]');
          for (let node = shown; node !== null && node !== document.body; node = node.parentElement) {
            if (node instanceof HTMLElement && node.style.opacity === "0") {
              return true;
            }
          }
          return false;
        },
        undefined,
        { polling: "raf" },
      );
      await page.keyboard.press(key);
      expect((await keys()).filter((pressed) => pressed.key === key), `${name}: ${key} right behind Escape`).toEqual(taken(key));
      expect((await dialogsAt(key)).at(-1), `${name}: the dialog was still in the document when ${key} went down`).toBeGreaterThanOrEqual(1);
      await expect(dialog, name).toHaveCount(0);
      await expect(executionState(page), name).toContainText(state);
      expect(controlRequests(rpc).at(-1), name).toBe(request);
    }
    expect(controlRequests(rpc)).toEqual(["control.step sh4", "control.runUntil", "control.pause sh4"]);
  });

  test("a key with Ctrl is somebody else's, and so is every other key", async ({ page, rpc }) => {
    const keys = await recordKeys(page);
    await openWorkspace(page, "sh4-debugger");
    await expect(executionState(page)).toHaveText("Paused · waiting at the start · stop 1");
    for (const [key, name, shift] of [
      ["Control+F10", "F10", false],
      ["Control+Shift+F11", "F11", true],
      ["Shift+F10", "F10", true],
      ["Shift+F6", "F6", true],
      ["F7", "F7", false],
      ["F9", "F9", false],
    ] as const) {
      expect(await press(page, keys, key), key).toEqual(left(name, shift));
    }
    await page.waitForTimeout(200);
    expect(controlRequests(rpc)).toEqual([]);
  });

  test("on the pages that are no workspace they are the browser's", async ({ page, rpc }) => {
    const keys = await recordKeys(page);
    for (const route of ["/", "/docs", "/tool/holly-core-log-analyzer"]) {
      await gotoRoute(page, route);
      await expect(page.locator("#root")).not.toBeEmpty();
      await page.locator("body").click({ position: { x: 5, y: 300 } });
      for (const key of ["F5", "F6", "F10", "F11"]) {
        expect(await press(page, keys, key), `${route}: ${key}`).toEqual(left(key));
      }
    }
    expect(controlRequests(rpc)).toEqual([]);

    // and after a workspace page was left: its keys go with it
    await openWorkspace(page, "sh4-debugger");
    await expect(executionState(page)).toHaveText("Paused · waiting at the start · stop 1");
    expect(await press(page, keys, "F11")).toEqual(taken("F11"));
    await expect(executionState(page)).toHaveText("Paused · step completed · stop 2");
    await gotoRoute(page, "/docs");
    await expect(page.getByRole("status", { name: "Execution state" })).toHaveCount(0);
    expect(await press(page, keys, "F11")).toEqual(left("F11"));
    expect(controlRequests(rpc)).toEqual(["control.step sh4"]);
  });
});

test.describe("a control that is off says why", () => {
  test.use({ mockOptions: { startPaused: true, graceMs: 600_000 } });

  test("while the target runs: Run and the steps; while it is paused: Pause", async ({ page, rpc }) => {
    await openWorkspace(page, "sh4-debugger");
    await expect(executionState(page)).toHaveText("Paused · waiting at the start · stop 1");
    for (const name of ["Run", "Step Into", "Step Over", "Step Out", "Reset"] as const) {
      await expectUsable(page, name);
    }
    await expectOff(page, "Pause", "the target is paused");
    await control(page, "Pause").click({ force: true });

    await control(page, "Run").click();
    await expect(executionState(page)).toHaveText("Running");
    await expectUsable(page, "Pause");
    await expectUsable(page, "Reset");
    for (const name of ["Run", ...STEPS] as const) {
      await expectOff(page, name, "the target is running");
      // a click on it does nothing
      await control(page, name).click({ force: true });
    }
    // the step buttons of the view say the same
    const view = panel(page, "sh4-disassembly");
    for (const name of ["Step Over", "Step In", "Step Out"]) {
      await expect(tooltipButton(view, name)).toHaveAttribute("aria-disabled", "true");
      await expect(tooltipButton(view, name)).toHaveAccessibleDescription(`${name}: the target is running`);
    }
    await page.waitForTimeout(200);
    expect(controlRequests(rpc)).toEqual(["control.runUntil"]);
    expect(refusals(rpc, -32003)).toEqual([]);
  });

  test("in a stop of the emulator's own window: all of them, the server refuses everything there", async ({ page, machine, rpc }, testInfo) => {
    await openWorkspace(page, "sh4-debugger");
    await expect(executionState(page)).toHaveText("Paused · waiting at the start · stop 1");
    const view = panel(page, "sh4-disassembly");

    for (const [lifetime, reason, text] of [
      ["stopped", undefined, "stopped in the emulator's window"],
      ["stopped", "guest-exit", "the program has exited"],
      ["no-machine", undefined, "no game loaded"],
    ] as const) {
      if (reason === "guest-exit") {
        // (the window resumed the machine in between, and the program ran to its end)
        machine.setLifetime("running");
        await expect(executionState(page)).toHaveText("Running");
      }
      machine.setLifetime(lifetime, reason);
      await expect(executionState(page)).toHaveText(new RegExp(`^Paused · ${text} · stop \\d+$`));
      for (const name of CONTROLS) {
        await expectOff(page, name, text);
        await control(page, name).click({ force: true });
      }
      for (const name of ["Step Over", "Step In", "Step Out"]) {
        await expect(tooltipButton(view, name)).toHaveAccessibleDescription(`${name}: ${text}`);
      }
      // and the keys
      for (const key of ["F5", "F6", "F10", "F11", "Shift+F11"]) {
        await page.keyboard.press(key);
      }
      if (lifetime === "stopped" && reason === undefined) {
        await control(page, "Reset").hover();
        await expect(tooltip(page, "Reset: stopped in the emulator's window")).toBeVisible();
        await saveScreenshot(page, testInfo, "toolbar-host-stopped");
        await page.mouse.move(0, 0);
      }
    }
    // nothing was sent that the server could only refuse (-32001, -32002)
    await page.waitForTimeout(200);
    expect(controlRequests(rpc)).toEqual([]);

    // a game is loaded, and parks at its start: the controls are back
    machine.setLifetime("running");
    await expect(executionState(page)).toHaveText(/^Paused · waiting at the start · stop \d+$/);
    for (const name of ["Run", ...STEPS, "Reset"] as const) {
      await expectUsable(page, name);
    }
    await control(page, "Step Into").click();
    await expect(executionState(page)).toHaveText(/^Paused · step completed · stop \d+$/);
    expect(controlRequests(rpc)).toEqual(["control.step sh4"]);
  });

  test("without a connection: all of them", async ({ page, mock, diagnostics }) => {
    await openWorkspace(page, "sh4-debugger");
    await expect(executionState(page)).toHaveText("Paused · waiting at the start · stop 1");
    diagnostics.allow(/^console\.error: WebSocket connection to/, "the server is down on purpose");
    await mock.stop();
    await expect(statusBar(page)).toContainText("Connection: reconnecting");
    for (const name of CONTROLS) {
      await expectOff(page, name, "not connected");
    }
    // what the toolbar steps is still said: the frame stays
    await expect(focusedTarget(page)).toHaveText("SH4");
    for (const name of ["Step Over", "Step In", "Step Out"]) {
      await expect(tooltipButton(panel(page, "sh4-disassembly"), name)).toHaveAccessibleDescription(`${name}: not connected`);
    }
  });

  test("the tooltip of a control is what it says about itself: its key, or why it is off", async ({ page }) => {
    await openWorkspace(page, "sh4-debugger");
    await expect(executionState(page)).toHaveText("Paused · waiting at the start · stop 1");
    for (const [name, text] of [
      ["Run", "Run (F5)"],
      ["Pause", "Pause: the target is paused"],
      ["Step Into", "Step Into (F11)"],
      ["Step Over", "Step Over (F10)"],
      ["Step Out", "Step Out (Shift+F11)"],
      ["Reset", "Reset"],
    ] as const) {
      await control(page, name).hover();
      await expect(tooltip(page, text), name).toBeVisible();
      // the name of the button is its name, with the tooltip open and without
      await expect(control(page, name)).toHaveAttribute("aria-label", name);
      await page.mouse.move(0, 0);
      await expect(page.getByRole("tooltip"), name).toHaveCount(0);
    }
    // the keys, for what reads them from the button
    await expect(control(page, "Run")).toHaveAttribute("aria-keyshortcuts", "F5");
    await expect(control(page, "Pause")).toHaveAttribute("aria-keyshortcuts", "F6");
    await expect(control(page, "Step Into")).toHaveAttribute("aria-keyshortcuts", "F11 F8");
    await expect(control(page, "Step Over")).toHaveAttribute("aria-keyshortcuts", "F10");
    await expect(control(page, "Step Out")).toHaveAttribute("aria-keyshortcuts", "Shift+F11 Shift+F8");
    await expect(control(page, "Reset")).not.toHaveAttribute("aria-keyshortcuts");
  });
});

test.describe("an ARM7 that is held in reset", () => {
  // as a guest holds it, and as a reset leaves it: ENABLED reads 0 until the machine has run for a while
  test.use({ mockOptions: { startPaused: true, arm7Held: true, graceMs: 600_000 } });

  test("is not stepped: the three steps of the toolbar are off while it is the focused target, and so are those of its view", async ({ page, rpc }, testInfo) => {
    await openWorkspace(page, "arm7-debugger");
    await expect(executionState(page)).toHaveText("Paused · waiting at the start · stop 1");
    await expect(focusedTarget(page)).toHaveText("ARM7");
    const view = panel(page, "arm7-disassembly");
    await dockTab(page, "ARM7: Registers").click();
    await expect(panel(page, "arm7-registers").locator('tr[data-register="ENABLED"] td.register-value')).toHaveText("0x0");

    for (const name of STEPS) {
      await expectOff(page, name, "the ARM7 is held in reset");
      await control(page, name).click({ force: true });
    }
    for (const name of ["Step Over", "Step In", "Step Out"]) {
      await expect(tooltipButton(view, name)).toHaveAttribute("aria-disabled", "true");
      await expect(tooltipButton(view, name)).toHaveAccessibleDescription(`${name}: the ARM7 is held in reset`);
      await tooltipButton(view, name).click({ force: true });
    }
    for (const key of ["F10", "F11", "F8", "Shift+F11", "Shift+F8"]) {
      await page.keyboard.press(key);
    }
    await control(page, "Step Into").hover();
    await expect(tooltip(page, "Step Into: the ARM7 is held in reset")).toBeVisible();
    await saveScreenshot(page, testInfo, "toolbar-arm7-held");
    await page.mouse.move(0, 0);
    // Run, Pause and Reset are the machine's
    await expectUsable(page, "Run");
    await expectUsable(page, "Reset");
    await page.waitForTimeout(200);
    expect(controlRequests(rpc)).toEqual([]);

    // the machine runs, and releases it: it is stepped like any target
    await control(page, "Run").click();
    await expect(panel(page, "arm7-registers").locator('tr[data-register="ENABLED"] td.register-value')).toHaveText("0x1");
    await control(page, "Pause").click();
    await expect(executionState(page)).toHaveText("Paused · paused by the debugger · stop 2");
    for (const name of STEPS) {
      await expectUsable(page, name);
    }
    for (const name of ["Step Over", "Step In", "Step Out"]) {
      await expect(tooltipButton(view, name)).toBeEnabled();
      await expect(tooltipButton(view, name)).toHaveAccessibleDescription("");
    }
    await control(page, "Step Into").click();
    await expect(executionState(page)).toHaveText("Paused · step completed · stop 3");
    await tooltipButton(view, "Step In").click();
    await expect(executionState(page)).toHaveText("Paused · step completed · stop 4");
    expect(controlRequests(rpc)).toEqual(["control.runUntil", "control.pause arm7", "control.step arm7", "control.step arm7"]);
    // the server never had to say that the ARM7 is not clocked
    expect(refusals(rpc, -32012)).toEqual([]);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("keeps no other target from being stepped: the toolbar is off for the ARM7 alone", async ({ page, rpc }) => {
    await openWorkspace(page, "mixed-mode-debugger");
    await expect(executionState(page)).toHaveText("Paused · waiting at the start · stop 1");
    const sh4 = panel(page, "sh4-disassembly");
    const arm7 = panel(page, "arm7-disassembly");
    // the SH4 is the focused target
    for (const name of STEPS) {
      await expectUsable(page, name);
    }
    await expect(tooltipButton(sh4, "Step In")).toBeEnabled();
    // the view of the ARM7 has its own buttons off all the same
    await expect(tooltipButton(arm7, "Step In")).toHaveAccessibleDescription("Step In: the ARM7 is held in reset");
    await control(page, "Step Into").click();
    await expect(executionState(page)).toHaveText("Paused · step completed · stop 2");

    // the ARM7 gets the focus: now the toolbar cannot step
    await arm7.getByRole("textbox").click();
    await expect(focusedTarget(page)).toHaveText("ARM7");
    for (const name of STEPS) {
      await expectOff(page, name, "the ARM7 is held in reset");
    }
    await page.keyboard.press("F11");
    // and back
    await sh4.getByRole("textbox").click();
    await expect(focusedTarget(page)).toHaveText("SH4");
    await expectUsable(page, "Step Over");
    await page.keyboard.press("F10");
    await expect(executionState(page)).toHaveText("Paused · step completed · stop 3");
    expect(controlRequests(rpc)).toEqual(["control.step sh4", "control.stepOver sh4"]);
    expect(refusals(rpc, -32012)).toEqual([]);
  });
});

test.describe("Reset", () => {
  test.use({ mockOptions: { startPaused: true, graceMs: 600_000 } });

  test("of a paused machine: one click, a new stop that says so, and the views are where the machine is again", async ({ page, rpc }, testInfo) => {
    await openWorkspace(page, "sh4-debugger");
    const state = executionState(page);
    const view = panel(page, "sh4-disassembly");
    await expect(state).toHaveText("Paused · waiting at the start · stop 1");
    const start = await currentInstructionAddress(view);
    // somewhere else than where the machine starts
    await control(page, "Step Into").click();
    await control(page, "Step Into").click();
    await expect(state).toHaveText("Paused · step completed · stop 3");
    await expect(view.locator(".current-instruction")).not.toHaveAttribute("data-address", String(start));
    const fetched = { listings: rpc.requests("state.getDisassembly").length, slices: rpc.requests("state.getMemorySlice").length };

    // no question is asked
    await control(page, "Reset").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(state).toHaveText("Paused · reset · stop 4");
    expect(rpc.requests("control.reset").map((frame) => frame.params)).toEqual([{}]);
    // the stop is followed like any other: the program counter of the reset is on screen, and the views have read again
    await expect(view.locator(".current-instruction")).toHaveAttribute("data-address", String(start));
    await expect(view.locator(".current-instruction")).toBeInViewport({ ratio: 1 });
    await expect.poll(() => rpc.requests("state.getDisassembly").length).toBeGreaterThan(fetched.listings);
    await expect.poll(() => rpc.requests("state.getMemorySlice").length).toBeGreaterThan(fetched.slices);
    await saveScreenshot(page, testInfo, "toolbar-reset-paused");
    // it is a stop of the debugger: the machine can be run and stepped from it
    await expectUsable(page, "Run");
    await expectUsable(page, "Step Into");
    await expectUsable(page, "Reset");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("leaves the ARM7 held: its steps are off behind a reset, until the machine has run", async ({ page, rpc }) => {
    await openWorkspace(page, "arm7-debugger");
    await expect(executionState(page)).toHaveText("Paused · waiting at the start · stop 1");
    for (const name of STEPS) {
      await expectUsable(page, name);
    }
    await control(page, "Reset").click();
    await expect(executionState(page)).toHaveText("Paused · reset · stop 2");
    for (const name of STEPS) {
      await expectOff(page, name, "the ARM7 is held in reset");
    }
    await expect(tooltipButton(panel(page, "arm7-disassembly"), "Step In")).toHaveAccessibleDescription("Step In: the ARM7 is held in reset");
    await page.keyboard.press("F11");
    await control(page, "Run").click();
    await expect(executionState(page)).toHaveText("Running");
    // released by the running machine; paused, it is stepped
    await expect.poll(async () => {
      await control(page, "Pause").click();
      await expect(executionState(page)).toHaveText(/^Paused · paused by the debugger/);
      if ((await control(page, "Step Into").getAttribute("aria-disabled")) === "true") {
        await control(page, "Run").click();
        await expect(executionState(page)).toHaveText("Running");
        return false;
      }
      return true;
    }).toBe(true);
    await control(page, "Step Into").click();
    await expect(executionState(page)).toHaveText(/^Paused · step completed · stop \d+$/);
    expect(controlRequests(rpc).filter((request) => request.startsWith("control.step"))).toEqual(["control.step arm7"]);
    expect(refusals(rpc, -32012)).toEqual([]);
  });

  test("while the target runs no tick says so: the disassembly and the memory view read again by the answer alone, where they are", async ({ page }) => {
    // A server that answers control.reset and sends nothing: a machine that runs is reset and
    // runs on, and nothing is published (the scripted server sends no tick it is not asked for).
    const server = await serveScriptedDebugger(page);
    (server.shape.capabilities as string[]).push("reset");
    server.state.execution = { state: "running", stopId: 4 };
    // what memory and code are behind the reset is another thing
    let generation = 0;
    server.answer("state.getDisassembly", (params) => {
      const listing = defaultAnswer("state.getDisassembly", params) as { lines: Array<{ disassembly: string }> };
      return { lines: listing.lines.map((line) => ({ ...line, disassembly: generation === 0 ? "nop" : "rts" })) };
    });
    server.answer("state.getMemorySlice", (params) => {
      const slice = defaultAnswer("state.getMemorySlice", params) as { data: number[] };
      return { ...slice, data: slice.data.map((byte) => (generation === 0 ? byte : 0xee)) };
    });
    let resets = 0;
    let held: (() => void) | undefined;
    server.answer("control.reset", () => {
      resets++;
      generation = 1;
      return new Promise((resolve) => {
        held = () => resolve({});
      });
    });
    await gotoRoute(page, "/workspace/sh4-debugger");
    await expect(statusBar(page)).toContainText("Connection: connected");
    await server.described();
    const state = executionState(page);
    const view = panel(page, "sh4-disassembly");
    const memory = panel(page, "sh4-memory");
    await expect(state).toHaveText("Running");
    await expect(disassemblyRows(view)).toHaveCount(64);
    await expect(disassemblyRows(view).first().locator("span").last()).toHaveText("nop");
    const memoryRow = memory.locator("[data-memory-hex]").first();
    await expect(memoryRow).not.toHaveText(/^(EE ){15}EE$/);
    // the views are somewhere the user put them
    await view.getByRole("textbox").fill("0x8C004000");
    await view.getByRole("textbox").press("Enter");
    await expect(view.locator(`[data-address="${0x8c004000}"]`)).toBeVisible();
    await memory.getByRole("textbox").fill("0x8C008000");
    await memory.getByRole("textbox").press("Enter");
    await expect(memory.locator(`[data-memory-hex="${0x8c008000}"]`)).toBeVisible();
    // (each starts some lines above the address it was sent to)
    const listingAt = Number(await disassemblyRows(view).first().getAttribute("data-address"));
    const memoryAt = Number(await memoryRow.getAttribute("data-memory-hex"));
    expect(listingAt).toBeGreaterThan(0x8c003000);
    expect(memoryAt).toBeGreaterThan(0x8c007000);
    // What the views read by themselves is over before the reset is asked for. A view that was
    // sent somewhere reads its bytes there, and reads them once more when the page has caught
    // up with the address it wrote into its URL: how long that takes is how busy the page is.
    // The two counts are taken when they have stood still over a time in which the page came
    // to rest, so that nothing a view was going to read anyway is taken for an answer to the
    // reset.
    const reads = () => ({
      listings: server.requestsOf("state.getDisassembly").length,
      slices: server.requestsOf("state.getMemorySlice").length,
    });
    /** The page has nothing left to do: what its renders and their effects ask for has been asked for. */
    const atRest = () => page.evaluate(() => new Promise<void>((resolve) => requestIdleCallback(() => resolve(), { timeout: 10_000 })));
    let before = reads();
    await expect
      .poll(
        async () => {
          const earlier = before;
          await page.waitForTimeout(600);
          await atRest();
          before = reads();
          return before.listings === earlier.listings && before.slices === earlier.slices;
        },
        { message: "the views have stopped reading by themselves", intervals: [0], timeout: 60_000 },
      )
      .toBe(true);

    await expectUsable(page, "Reset");
    await control(page, "Reset").click();
    await expect.poll(() => resets).toBe(1);
    // not before the server has answered: nothing is read again for a request that may be refused
    await page.waitForTimeout(300);
    expect(server.requestsOf("state.getDisassembly")).toHaveLength(before.listings);
    expect(server.requestsOf("state.getMemorySlice")).toHaveLength(before.slices);
    await expect(disassemblyRows(view).first().locator("span").last()).toHaveText("nop");

    held!();
    // answered {}: both views read again, once each, where they are
    await expect(disassemblyRows(view).first().locator("span").last()).toHaveText("rts");
    await expect(memoryRow).toHaveText(/^(EE ){15}EE$/);
    await expect(disassemblyRows(view).first()).toHaveAttribute("data-address", String(listingAt));
    await expect(memoryRow).toHaveAttribute("data-memory-hex", String(memoryAt));
    expect(server.requestsOf("state.getDisassembly")).toHaveLength(before.listings + 1);
    expect(server.requestsOf("state.getDisassembly").at(-1)).toMatchObject({ target: "sh4", address: listingAt });
    expect(server.requestsOf("state.getMemorySlice")).toHaveLength(before.slices + 1);
    expect(server.requestsOf("state.getMemorySlice").at(-1)).toMatchObject({ target: "sh4", address: memoryAt });
    // nothing else was said: the target runs, and the stop that is stored is none of this
    await expect(state).toHaveText("Running");
    await expect(view.locator(".current-instruction")).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);

    // a reset the server refuses is said, and nothing is read again for it
    server.answer("control.reset", () => inBandError(-32000, "emulator busy"));
    await control(page, "Reset").click();
    await expect(page.getByRole("alert").filter({ hasText: "Reset: emulator busy" })).toBeVisible();
    await page.waitForTimeout(300);
    expect(server.requestsOf("state.getDisassembly")).toHaveLength(before.listings + 1);
    expect(server.requestsOf("state.getMemorySlice")).toHaveLength(before.slices + 1);
  });

  test("of the running mock: it runs on, its event log says that it was reset, and the views read again", async ({ page, rpc }) => {
    await openWorkspace(page, "sh4-debugger");
    await addPanelFromSelector(page, 1, "Events: Log");
    await dockTab(page, "SH4: Disassembly").click();
    await control(page, "Run").click();
    const state = executionState(page);
    await expect(state).toHaveText("Running");
    const view = panel(page, "sh4-disassembly");
    await expect(disassemblyRows(view)).toHaveCount(64);
    await expect(panel(page, "sh4-memory").locator("[data-memory-hex]")).toHaveCount(60);
    const first = await disassemblyRows(view).first().getAttribute("data-address");
    const fetched = { listings: rpc.requests("state.getDisassembly").length, slices: rpc.requests("state.getMemorySlice").length };

    await control(page, "Reset").click();
    await expect.poll(() => rpc.requests("state.getDisassembly").length).toBe(fetched.listings + 1);
    await expect.poll(() => rpc.requests("state.getMemorySlice").length).toBe(fetched.slices + 1);
    // no stop: the target runs, and the listing is where it was
    await expect(state).toHaveText("Running");
    await expect(disassemblyRows(view).first()).toHaveAttribute("data-address", first!);
    expect(rpc.requests("control.reset")).toHaveLength(1);
    await dockTab(page, "Events: Log").click();
    await expect(panel(page, "events")).toContainText("machine reset");
    // once each: the ticks of a running target read nothing
    await page.waitForTimeout(500);
    expect(rpc.requests("state.getDisassembly")).toHaveLength(fetched.listings + 1);
    expect(rpc.requests("state.getMemorySlice")).toHaveLength(fetched.slices + 1);
  });
});

test.describe("a server of milestone M2, which is what the emulator of M2 is", () => {
  test.use({ mockOptions: { supports: MOCK_M2_SUPPORT, startPaused: true, graceMs: 600_000 } });

  test("no step of the DSP is offered, by button or by key; Reset is", async ({ page, rpc }, testInfo) => {
    await openWorkspace(page, "audio-debugger");
    await expect(executionState(page)).toHaveText("Paused · waiting at the start · stop 1");
    await expect(focusedTarget(page)).toHaveText("DSP");
    for (const name of STEPS) {
      await expectOff(page, name, "this server cannot step the DSP");
      await control(page, name).click({ force: true });
    }
    for (const key of ["F10", "F11", "F8", "Shift+F11", "Shift+F8"]) {
      await page.keyboard.press(key);
    }
    // the view of the DSP says it in place of its step button, as it did
    await expect(panel(page, "dsp-disassembly").getByRole("note")).toHaveText("This server cannot step the DSP or set code breakpoints on it.");
    await control(page, "Step Into").hover();
    await expect(tooltip(page, "Step Into: this server cannot step the DSP")).toBeVisible();
    await saveScreenshot(page, testInfo, "toolbar-m2-server-dsp");
    await page.mouse.move(0, 0);
    await page.waitForTimeout(200);
    expect(controlRequests(rpc)).toEqual([]);

    // Run, Pause and Reset are not the DSP's
    await expectUsable(page, "Run");
    await expectUsable(page, "Reset");
    await control(page, "Reset").click();
    await expect(executionState(page)).toHaveText("Paused · reset · stop 2");
    await control(page, "Run").click();
    await expect(executionState(page)).toHaveText("Running");
    await expectUsable(page, "Reset");
    await control(page, "Reset").click();
    await expect.poll(() => rpc.requests("control.reset").length).toBe(2);
    await expect(executionState(page)).toHaveText("Running");
    await control(page, "Pause").click();
    await expect(executionState(page)).toHaveText(/^Paused · paused by the debugger · stop \d+$/);
    expect(controlRequests(rpc)).toEqual(["control.reset", "control.runUntil", "control.reset", "control.pause dsp"]);
    // nothing was sent that this server answers with "not supported"
    expect(refusals(rpc, -32004)).toEqual([]);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

  test("the SH4 and the ARM7 are stepped from the toolbar, each in its workspace", async ({ page, rpc }) => {
    for (const [workspace, target, view] of [
      ["sh4-debugger", "sh4", "sh4-disassembly"],
      ["arm7-debugger", "arm7", "arm7-disassembly"],
    ] as const) {
      await gotoRoute(page, `/workspace/${workspace}`);
      await expect(statusBar(page)).toContainText("Connection: connected");
      const listing = panel(page, view);
      const address = await currentInstructionAddress(listing);
      const stop = Number((await executionState(page).innerText()).match(/stop (\d+)$/)![1]);
      for (const name of CONTROLS.filter((candidate) => candidate !== "Pause")) {
        await expectUsable(page, name);
      }
      await control(page, "Step Into").click();
      await expect(executionState(page)).toHaveText(`Paused · step completed · stop ${stop + 1}`);
      await expect(listing.locator(".current-instruction")).toHaveAttribute("data-address", String(nextInstruction(target, address)));
      await page.keyboard.press("F10");
      await expect(executionState(page)).toHaveText(`Paused · step completed · stop ${stop + 2}`);
    }
    expect(controlRequests(rpc)).toEqual(["control.step sh4", "control.stepOver sh4", "control.step arm7", "control.stepOver arm7"]);
    expect(refusals(rpc, -32004, -32012)).toEqual([]);
  });
});

test.describe("a server of milestone M1", () => {
  test.use({ mockOptions: { supports: MOCK_M1_SUPPORT, startPaused: true, graceMs: 600_000 } });

  test("has no reset and steps the SH4 alone: Reset is shown, off, and so are the steps of the other two targets", async ({ page, rpc }) => {
    await openWorkspace(page, "sh4-debugger");
    await expect(executionState(page)).toHaveText("Paused · waiting at the start · stop 1");
    await expectOff(page, "Reset", "this server cannot reset the machine");
    await control(page, "Reset").click({ force: true });
    for (const name of STEPS) {
      await expectUsable(page, name);
    }
    await control(page, "Step Into").click();
    await expect(executionState(page)).toHaveText("Paused · step completed · stop 2");

    for (const [workspace, label] of [
      ["arm7-debugger", "ARM7"],
      ["audio-debugger", "DSP"],
    ] as const) {
      await gotoRoute(page, `/workspace/${workspace}`);
      await expect(focusedTarget(page)).toHaveText(label);
      for (const name of STEPS) {
        await expectOff(page, name, `this server cannot step the ${label}`);
        await control(page, name).click({ force: true });
      }
      await expectOff(page, "Reset", "this server cannot reset the machine");
      for (const key of ["F10", "F11", "Shift+F11"]) {
        await page.keyboard.press(key);
      }
      // Run and Pause are every server's
      await expectUsable(page, "Run");
    }
    // running, Reset says the same: it is not for the moment
    await control(page, "Run").click();
    await expect(executionState(page)).toHaveText("Running");
    await expectOff(page, "Reset", "this server cannot reset the machine");
    await page.waitForTimeout(200);
    expect(controlRequests(rpc)).toEqual(["control.step sh4", "control.runUntil"]);
    expect(refusals(rpc, -32004)).toEqual([]);
  });
});

test("a server that lists no target: Run and Pause work, and no step is offered", async ({ page }) => {
  // what a describe result without `targets` is: the focused target is the workspace's own all the same
  const server = await serveScriptedDebugger(page);
  delete server.shape.targets;
  (server.shape.capabilities as string[]).push("reset");
  await gotoRoute(page, "/workspace/arm7-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");
  await server.described();
  await expect(executionState(page)).toHaveText("Paused · paused by the debugger · stop 1");
  await expect(focusedTarget(page)).toHaveText("ARM7");
  for (const name of STEPS) {
    await expectOff(page, name, "this server does not support the ARM7 target");
    await control(page, name).click({ force: true });
  }
  for (const key of ["F10", "F11", "Shift+F11"]) {
    await page.keyboard.press(key);
  }
  await expectUsable(page, "Run");
  await expectUsable(page, "Reset");
  await control(page, "Run").click();
  await expect.poll(() => server.requestsOf("control.runUntil").length).toBe(1);
  server.state.execution = { state: "running", stopId: 1 };
  server.tick();
  await expect(executionState(page)).toHaveText("Running");
  // Pause names no target here: the focused one is not this server's, and nothing is asked about it
  await control(page, "Pause").click();
  await expect.poll(() => server.requestsOf("control.pause")).toEqual([{}]);
  expect(server.requests.filter((request) => request.method.startsWith("control.step"))).toEqual([]);
  expect(server.requests.filter((request) => request.params.target === "arm7")).toEqual([]);
});

test("the documentation says what the run controls and the keys do, and what a write can do", async ({ page }) => {
  await gotoRoute(page, "/docs");
  const text = page.getByRole("main");
  await expect(text.getByRole("heading", { name: "Run Control", exact: true })).toBeVisible();
  for (const statement of [
    "Run, Pause, Step Into, Step Over, Step Out and Reset",
    "`Run to next breakpoint` is gone",
    "the SH4 in the SH4 Debugger and the Mixed Mode Debugger, the ARM7 in the ARM7 Debugger, the DSP in the Audio Debugger",
    "F5 run, F6 pause, F10 step over, F11 step into, Shift+F11 step out; F8 and Shift+F8 do what F11 and Shift+F11 do",
    "A key that is held down is used once",
    "F5 does not load the page again here; Ctrl+R and Ctrl+F5 do",
    "the ARM7 is held in reset",
    "Reset resets the machine at once, without a question",
    // M2-D42: the help says it, since nothing keeps a write from doing it
    "a program counter, or bytes of code, written so that the guest reaches what is no instruction ends the emulator in its default build, as it does for a guest that gets there by itself",
    "one of the SH4 with bit 0 set is refused",
  ]) {
    await expect(text, statement).toContainText(statement);
  }
  // the Documentation panel of a workspace has the same text
  await openWorkspace(page, "sh4-debugger");
  await addPanelFromSelector(page, 1, "Documentation");
  await expect(panel(page, "documentation").getByRole("heading", { name: "Run Control", exact: true })).toBeVisible();
  await expect(panel(page, "documentation")).toContainText("ends the emulator in its default build");
  await expect(panel(page, "documentation")).toContainText("F5 run, F6 pause, F10 step over, F11 step into, Shift+F11 step out");
});
