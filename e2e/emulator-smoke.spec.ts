import { test, expect, type Locator, type Page } from "@playwright/test";
import { Diagnostics, currentInstructionAddress, dockTab, panel, saveScreenshot, statusBar, type RpcFrame } from "./support/fixtures";

// The UI against the emulator: the page an emulator serves (the bundle it embeds), driven
// against the debugger server of that emulator. Every other spec of this suite meets the mock
// or a server the test writes; this one is the only place where the UI meets the real one.
//
// It starts nothing. It is skipped unless E2E_EMULATOR_URL is the page URL the emulator prints
// ("Debugger: http://127.0.0.1:<port>/"), of an emulator that was started headless and paused
// on the sounding guest of its tree (the recipe is in README.md, "The UI against the
// emulator"):
//
//   <emulator> -config config:Headless=yes , audio:backend=none , config:Dreamcast.RTC=946684800 ,
//       Debugger:Enabled=yes , Debugger:Port=0 , Debugger:Required=yes , Debugger:StartPaused=yes
//       <emulator tree>/tests/debugger/guest/dsptest/dsptest.elf
//
// The guest (tests/debugger/guest/dsptest of the emulator's tree): reios enters it at
// 0x8C010000, where it has `_start`; it copies an ARM7 program of 352 bytes to the start of the
// wave memory and releases the ARM7 onto it, and then counts in a loop while the ARM7 and the
// timer of the AICA make the sound. The spec expects the machine in its start stop and leaves
// it paused: one run per emulator process.

const EMULATOR_URL = process.env.E2E_EMULATOR_URL;

/** Where reios enters every program, and the guest has `_start`. */
const ENTRY = 0x8c010000;
/** Main memory two megabytes behind the program: nothing of the guest is there, and nothing of it reads it. */
const SCRATCH = 0x8c200000;
/** The length of the guest's ARM7 program, which is at 0 of the wave memory. */
const ARM7_PROGRAM_BYTES = 352;

const hex8 = (value: number) => `0x${value.toString(16).toUpperCase().padStart(8, "0")}`;

const runControls = (page: Page): Locator => page.locator("header").getByRole("group", { name: "Run controls" });
const control = (page: Page, name: string): Locator => runControls(page).getByRole("button", { name, exact: true });
const focusedTarget = (page: Page): Locator => runControls(page).getByRole("status", { name: "Focused target" });
const executionState = (page: Page): Locator => page.getByRole("status", { name: "Execution state" });

/** The number of the stop the toolbar shows. */
const stopNumber = async (page: Page): Promise<number> => {
  await expect(executionState(page)).toHaveText(/^Paused · .* · stop \d+$/);
  return Number((await executionState(page).innerText()).match(/stop (\d+)$/)![1]);
};

interface Tick {
  executionState: { state: string; stopId?: number; reason?: string };
  registers: Record<string, Array<{ name: string; value: string }>>;
}

test.describe("the UI the emulator serves, against that emulator", () => {
  test.skip(!EMULATOR_URL, "E2E_EMULATOR_URL is not set: this spec needs the page URL of a running emulator (README.md)");

  test("connects at the start stop, runs to the program, steps the SH4, writes a register and a byte, resets, and steps the ARM7", async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    /** What the run met, for whoever reads its log: one line each. */
    const note = (line: string) => console.log(`[emulator-smoke] ${line}`);
    const origin = new URL(EMULATOR_URL!).origin;
    const route = (path: string) => `${origin}/#${path}`;

    // what the browser reports as wrong fails the spec, as in every other spec of the suite
    const diagnostics = new Diagnostics();
    diagnostics.serveFrom(origin);
    page.on("console", (message) => {
      if (message.type() === "error") {
        diagnostics.record(`console.error: ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => diagnostics.record(`pageerror: ${error.message}`));
    page.on("requestfailed", (request) => diagnostics.record(`requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`));
    page.on("request", (request) => {
      if (diagnostics.isExternal(request.url())) {
        diagnostics.record(`external request: ${request.url()}`);
      }
    });
    page.on("response", (response) => {
      if (response.status() >= 400) {
        diagnostics.record(`http ${response.status()}: ${response.url()}`);
      }
    });

    // the JSON-RPC traffic of the page
    const sent: RpcFrame[] = [];
    const received: RpcFrame[] = [];
    const sockets: string[] = [];
    page.on("websocket", (socket) => {
      sockets.push(socket.url());
      socket.on("framesent", ({ payload }) => {
        if (typeof payload === "string") {
          sent.push(JSON.parse(payload) as RpcFrame);
        }
      });
      socket.on("framereceived", ({ payload }) => {
        if (typeof payload === "string") {
          received.push(JSON.parse(payload) as RpcFrame);
        }
      });
    });
    const requests = (method: string) => sent.filter((frame) => frame.method === method);
    /** The answer to a request of the page, once it is there. */
    const answerTo = async (request: RpcFrame): Promise<RpcFrame> => {
      await expect.poll(() => received.some((frame) => frame.id === request.id && frame.method === undefined)).toBe(true);
      return received.find((frame) => frame.id === request.id && frame.method === undefined)!;
    };
    const ticks = () => received.filter((frame) => frame.method === "event.tick").map((frame) => frame.params as unknown as Tick);
    /** Every control request was accepted: none of them could only be refused. */
    const expectAccepted = async (method: string, count: number) => {
      await expect.poll(() => requests(method).length, { message: method }).toBe(count);
      for (const request of requests(method)) {
        expect((await answerTo(request)).result, method).toEqual({});
      }
    };

    const state = executionState(page);
    const sh4 = panel(page, "sh4-disassembly");

    await test.step("connects at the start stop, to the server of the emulator that serves the page", async () => {
      await page.goto(route("/workspace/sh4-debugger"));
      await expect(statusBar(page)).toContainText("Connection: connected");
      await expect(state).toHaveText(/^Paused · waiting at the start · stop \d+$/);
      // one socket, on the host that served the page
      expect(sockets).toEqual([`${origin.replace(/^http/, "ws")}/ws`]);
      // The server describes itself as protocol 3, and the bundle it embeds is the one this
      // page is: `ui` is the version the page shows of itself.
      const described = (await answerTo(requests("debugger.describe")[0])).result as {
        emulator: { name: string; version: string; build: string };
        protocol: number;
        ui: string;
        capabilities: string[];
        targets: Array<{ id: string; stepping: boolean }>;
      };
      note(`${EMULATOR_URL}: ${described.emulator.name} ${described.emulator.version} (${described.emulator.build}), protocol ${described.protocol}, ui ${described.ui}`);
      expect(described.protocol).toBe(3);
      expect(described.ui).not.toBe("none");
      await expect(statusBar(page)).toContainText(`nullDC Debugger ${described.ui}`);
      // what this spec uses of milestone M2
      expect(described.capabilities).toEqual(expect.arrayContaining(["memory-write", "register-write", "reset"]));
      expect(described.targets.filter((target) => target.stepping).map((target) => target.id)).toEqual(expect.arrayContaining(["sh4", "arm7"]));
      // no banner of another protocol version, and nothing the page could not use
      await expect(page.getByRole("alert")).toHaveCount(0);
      // the SH4 is the focused target of its workspace, and can be run, stepped and reset
      await expect(focusedTarget(page)).toHaveText("SH4");
      for (const name of ["Run", "Step Into", "Step Over", "Step Out", "Reset"]) {
        await expect(control(page, name), name).toBeEnabled();
      }
      await expect(control(page, "Pause")).toBeDisabled();
      // the stop is followed: the program counter of the start stop is on screen
      await expect(sh4.locator(".current-instruction")).toHaveCount(1);
      note(`start stop: ${await state.innerText()}, SH4 at ${hex8(await currentInstructionAddress(sh4))}`);
      await saveScreenshot(page, testInfo, "emulator-1-start");
    });

    await test.step("runs to the entry of the program: a breakpoint at 0x8C010000", async () => {
      const start = await stopNumber(page);
      const breakpoints = panel(page, "sh4-breakpoints");
      await breakpoints.getByRole("textbox").fill(hex8(ENTRY));
      await breakpoints.getByRole("textbox").press("Enter");
      await expect(breakpoints.getByRole("listitem")).toHaveCount(1);
      await expect(breakpoints.getByRole("listitem")).toContainText(hex8(ENTRY));
      // (no step at the start stop: the machine is in front of its first instruction there)
      await control(page, "Run").click();
      await expect(state).toHaveText(`Paused · breakpoint dc.sh4.cpu.pc == ${hex8(ENTRY)} · stop ${start + 1}`);
      await expect(page.getByRole("alert").filter({ hasText: `Breakpoint hit: dc.sh4.cpu.pc == ${hex8(ENTRY)}` })).toBeVisible();
      expect(await currentInstructionAddress(sh4)).toBe(ENTRY);
      await expect(sh4.locator(".current-instruction")).toBeInViewport({ ratio: 1 });
      await expectAccepted("control.runUntil", 1);
      note(`entry: ${await state.innerText()}`);
      await saveScreenshot(page, testInfo, "emulator-2-entry");
    });

    await test.step("steps the SH4 from the toolbar", async () => {
      const stop = await stopNumber(page);
      await control(page, "Step Into").click();
      await expect(state).toHaveText(`Paused · step completed · stop ${stop + 1}`);
      // one instruction of `_start` was executed: the program counter is another one, and on screen
      await expect(sh4.locator(".current-instruction")).not.toHaveAttribute("data-address", String(ENTRY));
      const pc = await currentInstructionAddress(sh4);
      expect(pc).toBeGreaterThan(ENTRY);
      expect(pc).toBeLessThan(ENTRY + 0x1000);
      await expect(sh4.locator(".current-instruction")).toBeInViewport({ ratio: 1 });
      expect(requests("control.step").map((frame) => frame.params)).toEqual([{ target: "sh4" }]);
      await expectAccepted("control.step", 1);
      // and with the key
      await page.keyboard.press("F11");
      await expect(state).toHaveText(`Paused · step completed · stop ${stop + 2}`);
      await expect(sh4.locator(".current-instruction")).not.toHaveAttribute("data-address", String(pc));
      await expectAccepted("control.step", 2);
      note(`SH4 steps: ${hex8(ENTRY)} -> ${hex8(pc)} (Step Into) -> ${hex8(await currentInstructionAddress(sh4))} (F11)`);
    });

    await test.step("writes R0 in the register panel, and sees it in the tick", async () => {
      await dockTab(page, "SH4: Registers").click();
      const registers = panel(page, "sh4-registers");
      const value = registers.locator('tr[data-register="R0"] td.register-value span');
      await expect(value).toHaveText(/^0x[0-9A-F]{8}$/);
      const before = await value.innerText();
      const written = before === "0x00C0FFEE" ? "0x00C0FFE0" : "0x00C0FFEE";
      const seen = ticks().length;
      const stop = await stopNumber(page);

      await value.dblclick();
      const editor = registers.getByRole("textbox", { name: "New value of R0" });
      await expect(editor).toBeFocused();
      await editor.fill(written);
      await editor.press("Enter");
      await expect(editor).toHaveCount(0);
      await expect(value).toHaveText(written);
      expect(requests("state.setRegister").map((frame) => frame.params)).toEqual([{ path: "dc.sh4.cpu", name: "R0", value: written }]);
      expect((await answerTo(requests("state.setRegister")[0])).result).toEqual({});
      // the tick the write caused carries the value, and is no new stop
      const after = ticks().slice(seen);
      expect(after.length).toBeGreaterThan(0);
      const tick = after.at(-1)!;
      expect(tick.registers["dc.sh4.cpu"].find((register) => register.name === "R0")?.value).toBe(written);
      expect(tick.executionState).toMatchObject({ state: "paused", stopId: stop });
      await expect(state).toHaveText(`Paused · step completed · stop ${stop}`);
      await expect(page.getByRole("alert").filter({ hasText: /^(?!Breakpoint hit)/ })).toHaveCount(0);
      note(`R0: ${before} -> ${written}, in a tick of stop ${stop}`);
      await saveScreenshot(page, testInfo, "emulator-3-register");
    });

    await test.step("writes a byte of memory, and reads it back", async () => {
      const memory = panel(page, "sh4-memory");
      await memory.getByRole("textbox").fill(hex8(SCRATCH));
      await memory.getByRole("textbox").press("Enter");
      const hex = memory.locator(`[data-memory-hex="${SCRATCH}"]`);
      await expect(hex).toBeVisible();
      await expect(hex).toHaveText(/^([0-9A-F]{2} ){15}[0-9A-F]{2}$/);
      const before = (await hex.innerText()).split(" ");
      // two bytes that are not there now, from the fourth byte of the row on
      const written = before[3] === "A5" && before[4] === "5A" ? ["5A", "A5"] : ["A5", "5A"];
      const box = (await hex.boundingBox())!;
      await hex.dblclick({ position: { x: (3 * 3 + 1.5) * (box.width / 47), y: box.height / 2 } });
      const editor = memory.getByRole("textbox", { name: `Bytes to write from ${hex8(SCRATCH + 3)}` });
      await expect(editor).toBeFocused();
      await editor.fill(written.join(" "));
      await editor.press("Enter");
      await expect(editor).toHaveCount(0);
      expect(requests("state.writeMemory").map((frame) => frame.params)).toEqual([
        { target: "sh4", address: SCRATCH + 3, data: written.map((byte) => Number.parseInt(byte, 16)) },
      ]);
      expect((await answerTo(requests("state.writeMemory")[0])).result).toEqual({});
      // the view reads again by itself, and shows the two bytes among the ones that were there
      const expected = [...before.slice(0, 3), ...written, ...before.slice(5)].join(" ");
      await expect(hex).toHaveText(expected);

      // read back: a slice the emulator is asked for now has them
      const slices = requests("state.getMemorySlice").length;
      await memory.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect.poll(() => requests("state.getMemorySlice").length).toBeGreaterThan(slices);
      const slice = (await answerTo(requests("state.getMemorySlice").at(-1)!)).result as { baseAddress: number; data: number[] };
      const offset = SCRATCH + 3 - slice.baseAddress;
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(slice.data.slice(offset, offset + 2)).toEqual(written.map((byte) => Number.parseInt(byte, 16)));
      await expect(hex).toHaveText(expected);
      note(`memory ${hex8(SCRATCH + 3)}: ${before.slice(3, 5).join(" ")} -> ${written.join(" ")}, read back`);
      await saveScreenshot(page, testInfo, "emulator-4-memory");
    });

    await test.step("resets: a new stop that says so, which the views follow", async () => {
      const stop = await stopNumber(page);
      const listings = requests("state.getDisassembly").length;
      // (the breakpoint at the entry would stop the machine there again; it has done its work)
      const breakpoints = panel(page, "sh4-breakpoints");
      await dockTab(page, "SH4: Breakpoints").click();
      await breakpoints.getByRole("listitem").getByRole("button", { name: "Remove breakpoint" }).click();
      await expect(breakpoints.getByRole("listitem")).toHaveCount(0);
      await expect(state).toHaveText(new RegExp(` · stop ${stop}$`));
      const seen = ticks().length;

      // one click, and no question
      await control(page, "Reset").click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(state).toHaveText(`Paused · reset · stop ${stop + 1}`);
      await expectAccepted("control.reset", 1);
      // a paused machine stays paused: no running tick came between the two stops
      expect(ticks().slice(seen).map((tick) => tick.executionState.state)).not.toContain("running");
      expect(ticks().at(-1)?.executionState).toMatchObject({ state: "paused", reason: "reset", stopId: stop + 1 });
      // the machine is in front of its reset vector, not in the program, and the listing shows where
      await expect(sh4.locator(".current-instruction")).toHaveCount(1);
      const pc = await currentInstructionAddress(sh4);
      expect(pc < ENTRY || pc >= ENTRY + 0x1000, `the program counter behind the reset, ${hex8(pc)}`).toBe(true);
      await expect(sh4.locator(".current-instruction")).toBeInViewport({ ratio: 1 });
      expect(requests("state.getDisassembly").length).toBeGreaterThan(listings);
      note(`reset: ${await state.innerText()}, SH4 at ${hex8(pc)}`);
      await saveScreenshot(page, testInfo, "emulator-5-reset");
    });

    await test.step("and after a resume steps the ARM7", async () => {
      // the workspace of the ARM7: the same session, and the ARM7 is the focused target
      await page.goto(route("/workspace/arm7-debugger"));
      await expect(statusBar(page)).toContainText("Connection: connected");
      await expect(state).toHaveText(/^Paused · reset · stop \d+$/);
      await expect(focusedTarget(page)).toHaveText("ARM7");
      const arm7 = panel(page, "arm7-disassembly");
      // A reset leaves the ARM7 held, until the program releases it: it cannot be stepped, and
      // the toolbar and the view say so instead of asking for a refusal.
      for (const name of ["Step Into", "Step Over", "Step Out"]) {
        await expect(control(page, name), name).toHaveAttribute("aria-disabled", "true");
        await expect(control(page, name), name).toHaveAccessibleDescription(`${name}: the ARM7 is held in reset`);
      }
      await expect(arm7.getByRole("button", { name: "Step In", exact: true })).toHaveAccessibleDescription("Step In: the ARM7 is held in reset");
      await saveScreenshot(page, testInfo, "emulator-6-arm7-held");

      // The machine runs: the guest is entered again, sets the sound up and releases the ARM7.
      // Paused behind that, the ARM7 is in its program.
      await control(page, "Run").click();
      await expect(state).toHaveText("Running");
      await expect
        .poll(
          async () => {
            await page.waitForTimeout(500);
            await control(page, "Pause").click();
            await expect(state).toHaveText(/^Paused · paused by the debugger · stop \d+$/);
            if ((await control(page, "Step Into").getAttribute("aria-disabled")) === "true") {
              // still held: the machine has not come to the program yet
              await control(page, "Run").click();
              await expect(state).toHaveText("Running");
              return false;
            }
            return true;
          },
          { message: "the guest releases its ARM7", timeout: 60_000 },
        )
        .toBe(true);
      for (const name of ["Step Into", "Step Over", "Step Out"]) {
        await expect(control(page, name), name).toBeEnabled();
      }
      const stop = await stopNumber(page);
      const pc = await currentInstructionAddress(arm7);
      expect(pc).toBeLessThan(ARM7_PROGRAM_BYTES);
      expect(pc % 4).toBe(0);

      const steps = requests("control.step").length;
      await control(page, "Step Into").click();
      await expect(state).toHaveText(`Paused · step completed · stop ${stop + 1}`);
      expect(requests("control.step").at(-1)?.params).toEqual({ target: "arm7" });
      expect((await answerTo(requests("control.step").at(-1)!)).result).toEqual({});
      expect(requests("control.step")).toHaveLength(steps + 1);
      // one instruction of the ARM7's program: its program counter is another one, in the program, and on screen
      await expect(arm7.locator(".current-instruction")).not.toHaveAttribute("data-address", String(pc));
      const next = await currentInstructionAddress(arm7);
      expect(next).toBeLessThan(ARM7_PROGRAM_BYTES);
      expect(next % 4).toBe(0);
      await expect(arm7.locator(".current-instruction")).toBeInViewport({ ratio: 1 });
      // and once more with the key, which acts on the focused target
      await page.keyboard.press("F11");
      await expect(state).toHaveText(`Paused · step completed · stop ${stop + 2}`);
      expect(requests("control.step").at(-1)?.params).toEqual({ target: "arm7" });
      expect((await answerTo(requests("control.step").at(-1)!)).result).toEqual({});
      await expect(arm7.locator(".current-instruction")).not.toHaveAttribute("data-address", String(next));
      note(`ARM7 steps: ${hex8(pc)} -> ${hex8(next)} (Step Into) -> ${hex8(await currentInstructionAddress(arm7))} (F11); ${await state.innerText()}`);
      await saveScreenshot(page, testInfo, "emulator-7-arm7-step");
    });

    // Nothing the emulator answered was a refusal of a control request or of a write: the UI
    // asked for nothing it could have known to be refused.
    const refused = [...sent]
      .filter((frame) => frame.method?.startsWith("control.") || frame.method === "state.setRegister" || frame.method === "state.writeMemory")
      .map((frame) => ({ method: frame.method, answer: received.find((answer) => answer.id === frame.id && answer.method === undefined) }))
      .filter(({ answer }) => answer?.error !== undefined || (answer?.result as { error?: unknown } | undefined)?.error !== undefined);
    expect(refused).toEqual([]);
    expect(diagnostics.unexpected(), "console.error / uncaught exception / failed, HTTP >= 400 or external request during the spec").toEqual([]);
  });
});
