import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, type Download, type Locator, type Page } from "@playwright/test";
import {
  Diagnostics,
  addPanelFromSelector,
  canvasStats,
  currentInstructionAddress,
  disassemblyRow,
  dockTab,
  panel,
  saveScreenshot,
  statusBar,
  tooltipButton,
  type RpcFrame,
} from "./support/fixtures";
import { DIST_DIR } from "./support/paths";
import { branchTarget, isArmControlFlow, isSh4ControlFlow, mnemonicOf } from "../scripts/contract/disasm";
import { BinaryFrameKind, parseBinaryFrame } from "../src/lib/binaryFrame";

// The UI against the emulator: the page an emulator serves (the bundle it embeds), driven
// against the debugger server of that emulator. Every other spec of this suite meets the mock
// or a server the test writes; this one is the only place where the UI meets the real one.
//
// It starts nothing. It is skipped unless E2E_EMULATOR_URL is the page URL the emulator prints
// ("Debugger: http://127.0.0.1:<port>/"), of an emulator that embeds the bundle of this
// checkout and was started headless and paused on the sounding guest of its tree, with a
// configuration and a data directory of its own (the recipe is in README.md, "The UI against
// the emulator"; every switch of the emulator has two dashes, a one-dash switch is an error):
//
//   HOME=<run>/home XDG_CONFIG_HOME=<run>/cfg XDG_DATA_HOME=<run>/data \
//   <emulator> --config config:Headless=yes , audio:backend=none , config:Dreamcast.RTC=946684800 ,
//       Debugger:Enabled=yes , Debugger:Port=0 , Debugger:Required=yes , Debugger:StartPaused=yes
//       <emulator tree>/tests/debugger/guest/dsptest/dsptest.elf
//
// The guest (tests/debugger/guest/dsptest of the emulator's tree): reios enters it at
// 0x8C010000, where it has `_start`, with its ARM7 held (`ENABLED` 0); it copies an ARM7 program
// of 352 bytes to the start of the wave memory, its DSP program of 18 steps to the DSP, and
// releases the ARM7, and then counts in a loop while the ARM7, the timer of the AICA and the DSP
// make the sound: two channels, and the two outputs of the DSP. The spec expects the machine in
// its start stop: one run per emulator process. It ends with the machine paused, which lasts as
// long as the page: ten seconds after the last client has gone the server releases the stop,
// and the guest runs until the process is ended. Whoever started the emulator ends it, by its
// pid, when Playwright has returned.
//
// The M2 part: the start stop, the entry, SH4 steps, a register and a byte written, a reset, ARM7
// steps. The M3 part, in the Audio Debugger: a DSP breakpoint and steps of the DSP from the
// toolbar; "Load from emulator" at the breakpoint's stop, and the same steps in the playground,
// which give what the emulator's give; a capture of the SGC with a channel that sounds; a load at
// a stop of the SH4, whose banner says what it cannot know; and a step of the DSP at the entry of
// the program, where the guest holds its ARM7, from the toolbar and from the DSP's view.

const EMULATOR_URL = process.env.E2E_EMULATOR_URL;

/** Where reios enters every program, and the guest has `_start`. */
const ENTRY = 0x8c010000;
/** Main memory two megabytes behind the program: nothing of the guest is there, and nothing of it reads it. */
const SCRATCH = 0x8c200000;
/** The length of the guest's ARM7 program, which is at 0 of the wave memory. */
const ARM7_PROGRAM_BYTES = 352;
/** Where the ARM7 enters its timer interrupt, which the guest's AICA asks for every 13 samples. */
const ARM7_FIQ_VECTOR = 0x1c;
/** The node of the device tree that has the registers of the ARM7. */
const ARM7_REGISTERS = "dc.aica.arm7";
/** The node of the DSP, and the rows of it a load from the emulator takes. */
const DSP_REGISTERS = "dc.aica.dsp";
const DSP_ROWS = ["STEP", "MDEC_CT", "ACC", "Y_REG", "FRC_REG", "ADRS_REG", "LATCH", "LATCH_COPY", "MEMVAL", "NOFL_PIPE", "MIXS_BANK"];
/** The step of the guest's DSP program the spec stops in front of, and how many steps it then makes: inside one sample, past every step of the program. */
const DSP_STOP_STEP = 1;
const DSP_STEPS = 17;
/** The bus whose send the guest's DSP program reads (its first channel's ISEL): MIXS[3]. */
const DSP_SEND_BUS = 3;
/** Where the ARM7 sees the AICA's register file, in the read of a load from the emulator. */
const REGISTER_FILE = 0x00800000;
/** The DSP's registers that a step writes: TEMP, MEMS and EFREG, as offsets of the register file. */
const DSP_WRITTEN = [
  ["TEMP", 0x4000, 0x4400],
  ["MEMS", 0x4400, 0x4500],
  ["EFREG", 0x4580, 0x45c0],
] as const;

/** What `dist-native/bundle-info.json` says of a build (scripts/bundle-info.ts). */
interface BundleInfo {
  version: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
}

/**
 * Where one step of the ARM7 ends, by the line it stands on: `ends`, or anywhere in the
 * program when the line takes the PC from somewhere this spec does not follow.
 *
 * A step executes one instruction: it ends at the next one, or where a branch goes. It ends
 * at the vector of the interrupt instead when the timer's request is entered, behind the
 * instruction or in front of it (the step is complete there with nothing executed).
 * `lr` is R14 of the mode the ARM7 is in, for the two ways the guest's program goes back:
 * `mov pc, lr` from its routine, `subs pc, lr, #4` from its interrupt.
 */
const arm7StepEnds = (pc: number, line: string, lr: number | undefined): { ends?: number[]; why: string } => {
  if (!isArmControlFlow(line)) {
    return { ends: [pc + 4, ARM7_FIQ_VECTOR], why: "no control flow" };
  }
  const branch = /^bl?(eq|ne|cs|hs|cc|lo|mi|pl|vs|vc|hi|ls|ge|lt|gt|le|al)?$/.exec(mnemonicOf(line));
  const target = branchTarget(line);
  if (branch !== null && target !== undefined) {
    const always = branch[1] === undefined || branch[1] === "al";
    return { ends: always ? [target, ARM7_FIQ_VECTOR] : [target, pc + 4, ARM7_FIQ_VECTOR], why: always ? "a branch" : "a conditional branch" };
  }
  const back = /^(?:mov|subs)\s+pc,\s*lr(?:,\s*#(\d+))?$/.exec(line.trim().toLowerCase());
  if (back !== null && lr !== undefined) {
    return { ends: [(lr - Number(back[1] ?? 0)) & ~3, ARM7_FIQ_VECTOR], why: "the PC from lr" };
  }
  return { why: "the PC from somewhere this spec does not follow" };
};

const hex8 = (value: number) => `0x${value.toString(16).toUpperCase().padStart(8, "0")}`;

/** The text of the line a listing shows at `address`. */
const lineAt = async (view: Locator, address: number): Promise<string> => {
  const row = disassemblyRow(view, address);
  await expect(row, `the line at ${hex8(address)}`).toHaveCount(1);
  return (await row.locator("span").last().innerText()).trim();
};

/** The 16 bits a CPU reads at an offset of the AICA's register file, in a read of the ARM7 from 0. */
const fileWord = (memory: Uint8Array, offset: number): number => memory[REGISTER_FILE + offset] | (memory[REGISTER_FILE + offset + 1] << 8);

/** The value of a register in the playground's Debugger section, from its title (hex). */
const playgroundRegister = async (view: Locator, name: string): Promise<number> =>
  Number(await view.getByText(`${name}:`, { exact: true }).locator("xpath=following-sibling::span").getAttribute("title"));

/** The register file of the playground's core, as its Download Regs saves it: one 16-bit register in each 32-bit slot. */
const playgroundFile = async (page: Page, view: Locator): Promise<Uint8Array> => {
  const download: Promise<Download> = page.waitForEvent("download");
  await view.getByRole("button", { name: "Download Regs", exact: true }).click();
  return new Uint8Array(readFileSync((await (await download).path())!));
};

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

  test("connects at the start stop, runs to the program, steps the SH4, writes a register and a byte, resets, and steps the ARM7; and the DSP: its breakpoint and steps, a load into the playground that steps as the emulator does, a capture, its steps while the ARM7 is held", async ({ page }, testInfo) => {
    test.setTimeout(420_000);
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
    const binaries: Buffer[] = [];
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
        } else {
          binaries.push(payload);
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
    /** The last tick of the stop with this number, once it is there. */
    const pausedTick = async (stopId: number): Promise<Tick> => {
      const of = (tick: Tick) => tick.executionState.state === "paused" && tick.executionState.stopId === stopId;
      await expect.poll(() => ticks().some(of), { message: `a paused tick of stop ${stopId}` }).toBe(true);
      return ticks().findLast(of)!;
    };
    /** A register of the ARM7 as a tick has it. */
    const arm7Register = (tick: Tick, name: string): number | undefined => {
      const value = tick.registers[ARM7_REGISTERS]?.find((register) => register.name === name)?.value;
      return value === undefined ? undefined : Number(value);
    };
    /** A register of the DSP as a tick has it. */
    const dspRegister = (tick: Tick, name: string): number | undefined => {
      const value = tick.registers[DSP_REGISTERS]?.find((register) => register.name === name)?.value;
      return value === undefined ? undefined : Number(value);
    };
    /** The read of the latest load from the emulator: its request, its answer, and the bytes of its binary frame. */
    const lastLoad = async (): Promise<{ request: RpcFrame; memory: Uint8Array }> => {
      const request = requests("state.getMemoryBinary").at(-1)!;
      expect(request.params, "a load is one read of the ARM7 from 0 for 0x808000 bytes").toEqual({ target: "arm7", address: 0, length: 0x00808000 });
      const answer = await answerTo(request);
      const { binaryId, totalBytes } = answer.result as { binaryId: number; totalBytes: number };
      expect(totalBytes).toBe(0x00808000);
      let frame: ReturnType<typeof parseBinaryFrame> | undefined;
      await expect
        .poll(() => {
          frame = binaries.map((bytes) => parseBinaryFrame(bytes)).find((parsed) => parsed.ok && parsed.header.kind === BinaryFrameKind.MEMORY && parsed.header.binaryId === binaryId);
          return frame !== undefined;
        }, { message: `the frame of binaryId ${binaryId}` })
        .toBe(true);
      return { request, memory: new Uint8Array((frame as { payload: ArrayBuffer }).payload) };
    };
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
      await expect(statusBar(page)).toContainText(`Dreamcast DevTools ${described.ui}`);
      // the page the emulator serves is the UI of this name, and names the emulator nullDC
      await expect(page).toHaveTitle("Dreamcast DevTools");
      expect(described.emulator.name).toMatch(/^nullDC\b/);
      // And that bundle is the build of this checkout: the one in dist-native/, which the
      // set-up of the suite has just made the build of this tree. `ui` is its version, and
      // what the emulator serves is its files, byte for byte (a tree with changes keeps one
      // version for different contents). An emulator that was built before the sources
      // changed, or that serves a directory of its configuration, is not under test here.
      const bundle = JSON.parse(readFileSync(resolve(DIST_DIR, "bundle-info.json"), "utf8")) as BundleInfo;
      expect(described.ui, "`ui` of the emulator is the version of this checkout's dist-native: the emulator was built with another bundle").toBe(bundle.version);
      expect(bundle.files.map((file) => file.path)).toContain("index.html");
      const served: string[] = [];
      for (const file of bundle.files) {
        // (the page is what the emulator answers for "/")
        const response = await page.request.get(`${origin}/${file.path === "index.html" ? "" : file.path}`);
        const body = response.ok() ? await response.body() : Buffer.alloc(0);
        if (response.status() !== 200 || createHash("sha256").update(body).digest("hex") !== file.sha256) {
          served.push(`${file.path}: HTTP ${response.status()}, ${body.byteLength} bytes for ${file.bytes}`);
        }
      }
      expect(served, "files the emulator serves that are not the files of this checkout's dist-native: it was built with another bundle, or serves a directory").toEqual([]);
      note(`the bundle: ${bundle.files.length} files, each served as dist-native has it`);
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
      // `_start` begins with two instructions that are no branch (it loads a constant and
      // writes SR with it): the listing says so, and a step from each ends two bytes on.
      const first = await lineAt(sh4, ENTRY);
      const second = await lineAt(sh4, ENTRY + 2);
      expect(isSh4ControlFlow(first), `"${first}" at ${hex8(ENTRY)} is no control flow`).toBe(false);
      expect(isSh4ControlFlow(second), `"${second}" at ${hex8(ENTRY + 2)} is no control flow`).toBe(false);

      await control(page, "Step Into").click();
      await expect(state).toHaveText(`Paused · step completed · stop ${stop + 1}`);
      // one instruction of `_start` was executed, and no more: the program counter is at the next one, on screen
      await expect(sh4.locator(".current-instruction")).toHaveAttribute("data-address", String(ENTRY + 2));
      await expect(sh4.locator(".current-instruction")).toBeInViewport({ ratio: 1 });
      expect(requests("control.step").map((frame) => frame.params)).toEqual([{ target: "sh4" }]);
      await expectAccepted("control.step", 1);
      // and with the key
      await page.keyboard.press("F11");
      await expect(state).toHaveText(`Paused · step completed · stop ${stop + 2}`);
      await expect(sh4.locator(".current-instruction")).toHaveAttribute("data-address", String(ENTRY + 4));
      await expectAccepted("control.step", 2);
      note(`SH4 steps: ${hex8(ENTRY)} "${first}" -> ${hex8(ENTRY + 2)} "${second}" (Step Into) -> ${hex8(await currentInstructionAddress(sh4))} (F11)`);
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
      expect(arm7Register(await pausedTick(stop), "PC"), "the listing marks the PC of the tick").toBe(pc);

      /**
       * One step of the ARM7 from `from`, asked for by `ask`: one request, for the ARM7, that
       * is accepted; a new stop; and one instruction of the program was executed, and no
       * more. Returns where the ARM7 is then, and the line it left.
       */
      const stepArm7 = async (from: number, stopId: number, ask: () => Promise<void>): Promise<{ to: number; line: string; why: string }> => {
        const line = await lineAt(arm7, from);
        const lr = arm7Register(await pausedTick(stopId), "R14");
        const steps = requests("control.step").length;
        await ask();
        await expect(state).toHaveText(`Paused · step completed · stop ${stopId + 1}`);
        expect(requests("control.step")).toHaveLength(steps + 1);
        expect(requests("control.step").at(-1)?.params).toEqual({ target: "arm7" });
        expect((await answerTo(requests("control.step").at(-1)!)).result).toEqual({});
        // where the server says the ARM7 is, which is where the listing shows it, on screen
        const to = arm7Register(await pausedTick(stopId + 1), "PC");
        expect(to, "the PC of the ARM7 in the tick of the step").toBeDefined();
        await expect(arm7.locator(".current-instruction")).toHaveAttribute("data-address", String(to));
        await expect(arm7.locator(".current-instruction")).toBeInViewport({ ratio: 1 });
        // in the program, and where one instruction takes it
        expect(to).toBeLessThan(ARM7_PROGRAM_BYTES);
        expect(to! % 4).toBe(0);
        const { ends, why } = arm7StepEnds(from, line, lr);
        if (ends !== undefined) {
          expect(
            ends.map(hex8),
            `one step of the ARM7 from ${hex8(from)} "${line}" (${why}) ends at one of these, and it ended at ${hex8(to!)}`,
          ).toContain(hex8(to!));
        }
        return { to: to!, line, why };
      };

      const first = await stepArm7(pc, stop, () => control(page, "Step Into").click());
      // and once more with the key, which acts on the focused target
      const second = await stepArm7(first.to, stop + 1, () => page.keyboard.press("F11"));
      note(
        `ARM7 steps: ${hex8(pc)} "${first.line}" (${first.why}) -> ${hex8(first.to)} (Step Into); ` +
          `"${second.line}" (${second.why}) -> ${hex8(second.to)} (F11); ${await state.innerText()}`,
      );
      await saveScreenshot(page, testInfo, "emulator-7-arm7-step");
    });

    // --- the M3 part: the DSP, in the Audio Debugger ---
    const audio = (path = "/workspace/audio-debugger") => page.goto(route(path));
    const dspView = panel(page, "dsp-disassembly");
    const playground = panel(page, "dsp-playground");
    const loadButton = playground.getByRole("button", { name: "Load from emulator", exact: true });
    const banner = playground.getByRole("status", { name: "Snapshot from the emulator" });
    /** One step of the DSP, asked for by `ask` at a stop of the DSP: one accepted request, a new stop, the step after. */
    const stepDsp = async (ask: () => Promise<void>): Promise<number> => {
      const stop = await stopNumber(page);
      const step = dspRegister(await pausedTick(stop), "STEP")!;
      const steps = requests("control.step").length;
      await ask();
      await expect(state).toHaveText(`Paused · step completed · stop ${stop + 1}`);
      expect(requests("control.step")).toHaveLength(steps + 1);
      expect(requests("control.step").at(-1)?.params).toEqual({ target: "dsp" });
      expect((await answerTo(requests("control.step").at(-1)!)).result).toEqual({});
      const to = dspRegister(await pausedTick(stop + 1), "STEP");
      expect(to, `a step of the DSP from step ${step}`).toBe((step + 1) % 128);
      await expect(dspView.locator(".current-instruction")).toHaveAttribute("data-address", String(to));
      return to!;
    };

    let breakpointStop = 0;
    await test.step("the Audio Debugger: a DSP breakpoint stops the DSP in front of its step, in a sample of the guest's program", async () => {
      await audio();
      await expect(statusBar(page)).toContainText("Connection: connected");
      await expect(focusedTarget(page)).toHaveText("DSP");
      // the guest has loaded its program: the step is one of it, no empty one
      const line = await lineAt(dspView, DSP_STOP_STEP);
      expect(line, `the DSP's step ${DSP_STOP_STEP} is the guest's`).not.toMatch(/= TRA:0$/);
      const breakpoints = panel(page, "dsp-breakpoints");
      await breakpoints.getByRole("textbox").fill(String(DSP_STOP_STEP));
      await breakpoints.getByRole("textbox").press("Enter");
      await expect(breakpoints.getByRole("listitem")).toHaveCount(1);
      const stop = await stopNumber(page);
      await control(page, "Run").click();
      const hit = `Paused · breakpoint dc.aica.dsp.step == ${String(DSP_STOP_STEP).padStart(3, "0")} · stop ${stop + 1}`;
      await expect(state).toHaveText(hit);
      expect(dspRegister(await pausedTick(stop + 1), "STEP")).toBe(DSP_STOP_STEP);
      await expect(dspView.locator(".current-instruction")).toHaveAttribute("data-address", String(DSP_STOP_STEP));
      breakpointStop = stop + 1;
      note(`DSP breakpoint: ${await state.innerText()}, step ${DSP_STOP_STEP} "${line}"`);
      await saveScreenshot(page, testInfo, "emulator-8-dsp-breakpoint");
    });

    await test.step(`Load from emulator at the breakpoint's stop, and ${DSP_STEPS} steps in the playground and from the toolbar: the same rows and the same TEMP, MEMS and EFREG`, async () => {
      await addPanelFromSelector(page, 1, "DSP: Playground");
      await expect(playground.getByRole("button", { name: "Start DSP" })).toBeVisible();
      await expect(loadButton).not.toHaveAttribute("aria-disabled");
      // a sample whose send the program reads is not 0: else a load into the other bank of MIXS would read the same
      let first!: Uint8Array;
      for (let attempt = 0; ; attempt++) {
        await loadButton.click();
        await expect(banner).toContainText(`, stop ${breakpointStop}, `);
        first = (await lastLoad()).memory;
        const send = (fileWord(first, 0x4500 + 8 * DSP_SEND_BUS + 4) << 4) | (fileWord(first, 0x4500 + 8 * DSP_SEND_BUS) & 0xf);
        if (send !== 0) {
          note(`MIXS[${DSP_SEND_BUS}] of the load is 0x${send.toString(16).toUpperCase()} (attempt ${attempt + 1})`);
          break;
        }
        expect(attempt, `a sample whose MIXS[${DSP_SEND_BUS}] is not 0`).toBeLessThan(8);
        // the breakpoint is reached in every sample: Run stops at it one sample later
        await control(page, "Run").click();
        await expect(state).toHaveText(new RegExp(` · stop ${breakpointStop + 1}$`));
        breakpointStop++;
      }
      const at = await pausedTick(breakpointStop);
      const host = new URL(EMULATOR_URL!).host;
      await expect(banner).toContainText(new RegExp(`^Loaded from nullDC\\S* @ ${host.replace(/\./g, "\\.")}, stop ${breakpointStop}, `));
      await expect(banner.locator("time")).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);
      await expect(banner).toContainText(`At step ${DSP_STOP_STEP}, in the DSP phase of a sample`);
      await expect(banner).not.toContainText("not known");
      await expect(banner).toContainText("loaded as 0");
      // the playground stands at the step, paused
      await playground.getByRole("heading", { name: "Debugger", exact: true }).locator("xpath=following-sibling::button").click();
      await expect(playground.getByText("Step:", { exact: true }).locator("xpath=following-sibling::span")).toHaveText(new RegExp(`^\\s*${DSP_STOP_STEP}$`));
      for (const name of DSP_ROWS.filter((row) => row !== "STEP")) {
        expect(await playgroundRegister(playground, name), `${name} as loaded`).toBe(dspRegister(at, name));
      }
      // MIXS as the read has it, in the bank the DSP reads
      const loaded = await playgroundFile(page, playground);
      const word = (bytes: Uint8Array, offset: number) => bytes[offset] | (bytes[offset + 1] << 8);
      for (let offset = 0x4500; offset < 0x4580; offset += 4) {
        expect(word(loaded, offset), `MIXS at 0x${offset.toString(16)}`).toBe(fileWord(first, offset));
      }

      // the steps in the playground
      const playgroundStep = tooltipButton(playground, "Step");
      for (let k = 0; k < DSP_STEPS; k++) {
        await playgroundStep.click();
        await expect(playground.getByText("Step:", { exact: true }).locator("xpath=following-sibling::span")).toHaveText(new RegExp(`^\\s*${DSP_STOP_STEP + k + 1}$`));
      }
      const rows: Record<string, number> = {};
      for (const name of DSP_ROWS.filter((row) => row !== "STEP")) {
        rows[name] = await playgroundRegister(playground, name);
      }
      const computed = await playgroundFile(page, playground);

      // the same steps of the emulator, from the toolbar
      for (let k = 0; k < DSP_STEPS; k++) {
        await stepDsp(() => control(page, "Step Into").click());
      }
      const after = await pausedTick(await stopNumber(page));
      expect(dspRegister(after, "STEP")).toBe(DSP_STOP_STEP + DSP_STEPS);
      // the rows the steps changed, and those they did not: every one is the playground's
      const changed: string[] = [];
      for (const name of DSP_ROWS.filter((row) => row !== "STEP")) {
        expect(rows[name], `${name}: ${DSP_STEPS} steps of the playground and of the emulator`).toBe(dspRegister(after, name));
        if (dspRegister(after, name) !== dspRegister(at, name)) changed.push(name);
      }
      expect(changed.length, "the steps changed rows of the datapath").toBeGreaterThan(0);
      // read back: a load at the stop behind the steps, and its read is the emulator's
      await loadButton.click();
      await expect(banner).toContainText(new RegExp(`, stop ${await stopNumber(page)}, `));
      const emulator = (await lastLoad()).memory;
      let words = 0;
      const written: string[] = [];
      for (const [name, from, to] of DSP_WRITTEN) {
        for (let offset = from; offset < to; offset += 4) {
          words++;
          expect(word(computed, offset), `${name} at 0x${offset.toString(16)}: the playground's ${DSP_STEPS} steps and the emulator's`).toBe(fileWord(emulator, offset));
          if (fileWord(emulator, offset) !== fileWord(first, offset)) written.push(`${name}@0x${offset.toString(16)}`);
        }
      }
      expect(written.length, "the steps wrote TEMP, MEMS or EFREG").toBeGreaterThan(0);
      note(`playground and emulator after ${DSP_STEPS} steps from step ${DSP_STOP_STEP}: ${DSP_ROWS.length - 1} rows equal (changed: ${changed.join(", ")}), ${words} words of TEMP, MEMS and EFREG equal (${written.length} written)`);
      await saveScreenshot(page, testInfo, "emulator-9-dsp-load");
    });

    await test.step("a capture of the SGC, in which a channel sounds", async () => {
      // the DSP breakpoint would stop the capture's run in every sample
      const breakpoints = panel(page, "dsp-breakpoints");
      await breakpoints.getByRole("listitem").getByRole("button", { name: "Remove breakpoint" }).click();
      await expect(breakpoints.getByRole("listitem")).toHaveCount(0);
      await dockTab(page, "SGC").click();
      const sgc = panel(page, "sgc");
      const stop = await stopNumber(page);
      await tooltipButton(sgc, "Run the emulator and record 1024 frames").click();
      await expect(state).toHaveText(`Paused · capture finished · stop ${stop + 1}`, { timeout: 30_000 });
      await expect(sgc.getByText("1024 frames", { exact: true })).toBeVisible({ timeout: 30_000 });
      const active = sgc.getByRole("button", { name: /^Active \(\d+\)$/ });
      await expect(active).toBeVisible();
      const count = Number((await active.innerText()).match(/\((\d+)\)/)![1]);
      expect(count, "channels that sound in the capture").toBeGreaterThan(0);
      // each of them has its view, and the first sounds: its output to the left and the right (Post-VolPan, bytes 84
      // and 86 of its records, which the emulator's fast tier fills; the Pre-VolPan sample of bytes 76 to 83 it does
      // not) is no flat line
      const canvases = sgc.locator("canvas");
      await expect(canvases).toHaveCount(count);
      await tooltipButton(sgc, "Post-VolPan (L/R/DSP)").first().click();
      await expect
        .poll(async () => {
          const { bars } = await canvasStats(canvases.first());
          return bars.blue + bars.pink;
        }, { message: "the output of the first active channel, drawn" })
        .toBeGreaterThan(100);
      expect((await answerTo(requests("state.recordSgcFrames").at(-1)!)).result).toEqual({});
      note(`capture: ${count} channels active, ${await state.innerText()}`);
      await saveScreenshot(page, testInfo, "emulator-10-sgc");
    });

    await test.step("a load at a stop of the SH4: the banner says that MIXS of the next sample is not known, and that EXTS is loaded as 0", async () => {
      await page.goto(route("/workspace/sh4-debugger"));
      await expect(statusBar(page)).toContainText("Connection: connected");
      await expect(focusedTarget(page)).toHaveText("SH4");
      const stop = await stopNumber(page);
      await control(page, "Step Into").click();
      await expect(state).toHaveText(`Paused · step completed · stop ${stop + 1}`);
      expect(dspRegister(await pausedTick(stop + 1), "STEP")).toBe(0);
      await audio();
      await expect(statusBar(page)).toContainText("Connection: connected");
      await dockTab(page, "DSP: Playground").click();
      await expect(loadButton).not.toHaveAttribute("aria-disabled");
      await loadButton.click();
      await expect(banner).toContainText(`, stop ${stop + 1}, `);
      await expect(banner).toContainText("At step 0: MIXS of the next sample is not known.");
      await expect(banner).toContainText("EXTS (the CD-DA input) is no register a CPU reads: it is loaded as 0.");
      await lastLoad();
      note(`load at the SH4's step: ${await banner.innerText()}`);
      await saveScreenshot(page, testInfo, "emulator-11-sh4-load");
    });

    /**
     * The entry of the program behind a reset: the guest holds its ARM7 there (`ENABLED` 0), and
     * the DSP is clocked all the same. Returns the stop.
     */
    const toTheEntry = async (): Promise<number> => {
      const stop = await stopNumber(page);
      await control(page, "Reset").click();
      await expect(state).toHaveText(`Paused · reset · stop ${stop + 1}`);
      await control(page, "Run").click();
      await expect(state).toHaveText(`Paused · breakpoint dc.sh4.cpu.pc == ${hex8(ENTRY)} · stop ${stop + 2}`);
      expect(arm7Register(await pausedTick(stop + 2), "ENABLED"), "the ARM7 at the entry").toBe(0);
      return stop + 2;
    };

    await test.step("at the entry, where the guest holds its ARM7, a step of the DSP from the toolbar; behind a reset, again, one from the DSP's view", async () => {
      // the breakpoint at the entry, for the two runs from a reset
      await page.goto(route("/workspace/sh4-debugger"));
      await expect(statusBar(page)).toContainText("Connection: connected");
      const breakpoints = panel(page, "sh4-breakpoints");
      await breakpoints.getByRole("textbox").fill(hex8(ENTRY));
      await breakpoints.getByRole("textbox").press("Enter");
      await expect(breakpoints.getByRole("listitem")).toHaveCount(1);
      await audio();
      await expect(statusBar(page)).toContainText("Connection: connected");
      await expect(focusedTarget(page)).toHaveText("DSP");

      // the toolbar
      const first = await toTheEntry();
      await expect(control(page, "Step Into")).toBeEnabled();
      await expect(control(page, "Step Into")).toHaveAccessibleDescription("Step Into (F11)");
      await stepDsp(() => control(page, "Step Into").click());
      note(`the DSP stepped from the toolbar at the entry (stop ${first}, ENABLED 0): ${await state.innerText()}`);
      await saveScreenshot(page, testInfo, "emulator-12-dsp-held-toolbar");

      // the view
      const second = await toTheEntry();
      const viewStep = tooltipButton(dspView, "Step");
      await expect(viewStep).toBeEnabled();
      await expect(viewStep).toHaveAccessibleDescription("");
      await stepDsp(() => viewStep.click());
      note(`the DSP stepped from its view at the entry (stop ${second}, ENABLED 0): ${await state.innerText()}`);
      // never refused as held: the DSP has no such state
      expect(received.filter((frame) => frame.method === undefined && JSON.stringify(frame).includes('"code":-32012'))).toEqual([]);
      await saveScreenshot(page, testInfo, "emulator-13-dsp-held-view");
    });

    // Nothing the emulator answered was a refusal of a control request or of a write: the UI
    // asked for nothing it could have known to be refused.
    const refused = [...sent]
      .filter(
        (frame) =>
          frame.method?.startsWith("control.") ||
          frame.method === "state.setRegister" ||
          frame.method === "state.writeMemory" ||
          frame.method === "state.getMemoryBinary" ||
          frame.method === "state.recordSgcFrames",
      )
      .map((frame) => ({ method: frame.method, answer: received.find((answer) => answer.id === frame.id && answer.method === undefined) }))
      .filter(({ answer }) => answer?.error !== undefined || (answer?.result as { error?: unknown } | undefined)?.error !== undefined);
    expect(refused).toEqual([]);
    expect(diagnostics.unexpected(), "console.error / uncaught exception / failed, HTTP >= 400 or external request during the spec").toEqual([]);
  });
});
