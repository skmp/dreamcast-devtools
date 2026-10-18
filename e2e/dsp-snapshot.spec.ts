import { readFileSync } from "node:fs";
import { test, expect, addPanelFromSelector, gotoRoute, openWorkspace, panel, statusBar, tooltipButton, type RpcFrame, type RpcLog } from "./support/fixtures";
import type { Download, Locator, Page } from "@playwright/test";
import { BinaryFrameKind, encodeBinaryFrame, parseBinaryFrame } from "../src/lib/binaryFrame";
import { MOCK_DSP_PROGRAM } from "../server/mockDebugger";
import { monacoEditor, monacoVisibleText } from "./support/monaco";
import { jsonRpcError, serveScriptedDebugger, type Json, type ScriptedDebugger, type ScriptedRegister } from "./support/scriptedDebugger";

// "Load from emulator", the playground as a dock panel of a workspace: at a stop, one state.getMemoryBinary of the
// ARM7 from 0 for 0x808000 bytes (wave memory and the AICA's register file of one moment) and the rows of
// dc.aica.dsp and dc.aica.common of the paused tick of the same stop, into the playground's core; the program as the
// Assembler tab's source; a banner that names the server, the stop and the tick's time, and says what the load
// cannot know. Against the mock (whose DSP computes nothing: what is loaded is what the server gave), and against
// scripted servers for what the mock does not do (a stop that ends during the read, a tick between a response and
// its frame). What the playground computes from a load is held against the emulator by e2e/emulator-smoke.spec.ts.

const READ = { target: "arm7", address: 0, length: 0x00808000 };
const REGISTER_FILE = 0x00800000;

const playground = (page: Page): Locator => panel(page, "dsp-playground");
const loadButton = (view: Locator): Locator => view.getByRole("button", { name: "Load from emulator", exact: true });
const banner = (view: Locator): Locator => view.getByRole("status", { name: "Snapshot from the emulator" });
const executionState = (page: Page): Locator => page.getByRole("status", { name: "Execution state" });
const runControls = (page: Page): Locator => page.locator("header").getByRole("group", { name: "Run controls" });
const control = (page: Page, name: string): Locator => runControls(page).getByRole("button", { name, exact: true });

/** The value shown next to a register name in the playground's Debugger section. */
const register = (view: Locator, name: string): Locator => view.getByText(`${name}:`, { exact: true }).locator("xpath=following-sibling::span");
const registerHex = async (view: Locator, name: string): Promise<number> => Number(await register(view, name).getAttribute("title"));
const registerValue = async (view: Locator, name: string): Promise<number> => Number((await register(view, name).innerText()).trim());

/** The playground added to the centre of the Audio Debugger, with its module loaded. */
const openPlayground = async (page: Page): Promise<Locator> => {
  await addPanelFromSelector(page, 1, "DSP: Playground");
  const view = playground(page);
  await expect(view.getByRole("button", { name: /^(Start|Stop) DSP$/ })).toBeVisible();
  return view;
};

const expandDebugger = async (view: Locator) => {
  await view.getByRole("heading", { name: "Debugger", exact: true }).locator("xpath=following-sibling::button").click();
  await expect(view.getByText("Disassembly", { exact: true })).toBeVisible();
};

interface Tick {
  timestamp: number;
  executionState: { state: string; stopId?: number; reason?: string };
  registers: Record<string, Array<{ name: string; value: string }>>;
}

/** The answer to a request, the binary frame it announced, and the first tick behind that answer. */
const readOf = (rpc: RpcLog, request: RpcFrame) => {
  const at = rpc.received.findIndex((frame) => frame.id === request.id && frame.method === undefined);
  expect(at, "the answer to state.getMemoryBinary").toBeGreaterThanOrEqual(0);
  const result = rpc.received[at].result as { binaryId: number; totalBytes: number };
  const frame = rpc.binaryFrames.map((bytes) => parseBinaryFrame(bytes)).find((parsed) => parsed.ok && parsed.header.kind === BinaryFrameKind.MEMORY && parsed.header.binaryId === result.binaryId);
  expect(frame?.ok, "the frame of the read").toBe(true);
  const memory = new Uint8Array((frame as { payload: ArrayBuffer }).payload);
  const tick = rpc.received.slice(at + 1).find((received) => received.method === "event.tick")?.params as unknown as Tick | undefined;
  return { result, memory, tick };
};

/** The 16 bits a CPU reads at an offset of the AICA's register file, in a read of the ARM7 from 0. */
const slot = (memory: Uint8Array, offset: number): number => memory[REGISTER_FILE + offset] | (memory[REGISTER_FILE + offset + 1] << 8);
const row = (tick: Tick, path: string, name: string): number => Number(tick.registers[path].find((register) => register.name === name)!.value);

/** The register file of the playground's core, as Download Regs saves it: one 16-bit register per 32-bit slot. */
const downloadRegs = async (page: Page, view: Locator): Promise<DataView> => {
  const download: Promise<Download> = page.waitForEvent("download");
  await view.getByRole("button", { name: "Download Regs", exact: true }).click();
  const bytes = readFileSync((await (await download).path())!);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
};

/**
 * The registers of the playground after a load: every one of them is what the read or the tick gave. The datapath
 * and MDEC_CT from the rows; COEF, MADRS, TEMP, MEMS, EFREG from the register file, as a debugger writes them (COEF
 * keeps its bits 15:3); MIXS from the register file into the bank MIXS_BANK names, which is the bank the view shows.
 */
const expectLoaded = async (view: Locator, memory: Uint8Array, tick: Tick) => {
  const dsp = (name: string) => row(tick, "dc.aica.dsp", name);
  await expect(register(view, "Step")).toHaveText(new RegExp(`^\\s*${dsp("STEP")}$`));
  for (const name of ["MDEC_CT", "ACC", "Y_REG", "FRC_REG", "ADRS_REG", "LATCH", "LATCH_COPY", "MEMVAL", "NOFL_PIPE", "MIXS_BANK"]) {
    expect(await registerHex(view, name), name).toBe(dsp(name));
  }
  for (let i = 0; i < 128; i++) {
    expect(await registerHex(view, `COEF[${i}]`), `COEF[${i}]`).toBe(slot(memory, 0x3000 + 4 * i) & 0xfff8);
    expect(await registerHex(view, `TEMP[${i}]`), `TEMP[${i}]`).toBe((slot(memory, 0x4000 + 8 * i + 4) << 8) | (slot(memory, 0x4000 + 8 * i) & 0xff));
  }
  for (let i = 0; i < 64; i++) {
    expect(await registerHex(view, `MADRS[${i}]`), `MADRS[${i}]`).toBe(slot(memory, 0x3200 + 4 * i));
  }
  for (let i = 0; i < 32; i++) {
    expect(await registerHex(view, `MEMS[${i}]`), `MEMS[${i}]`).toBe((slot(memory, 0x4400 + 8 * i + 4) << 8) | (slot(memory, 0x4400 + 8 * i) & 0xff));
  }
  for (let i = 0; i < 16; i++) {
    expect(await registerHex(view, `MIXS[${i}]`), `MIXS[${i}]`).toBe((slot(memory, 0x4500 + 8 * i + 4) << 4) | (slot(memory, 0x4500 + 8 * i) & 0xf));
    expect(await registerHex(view, `EFREG[${i}]`), `EFREG[${i}]`).toBe(slot(memory, 0x4580 + 4 * i));
  }
  // EXTS has no row and reads 0 for a CPU: 0, whatever the read has there
  for (let i = 0; i < 2; i++) {
    expect(await registerHex(view, `EXTS[${i}]`), `EXTS[${i}]`).toBe(0);
  }
};

test.describe("against the mock", () => {
  test.use({ mockOptions: { startPaused: true, graceMs: 600_000 } });

  test("at the start stop: one read and the paused tick behind it, everything they hold in the core, the program in the Assembler tab, and a banner that warns of MIXS", async ({ page, rpc, mock }) => {
    await openWorkspace(page, "audio-debugger");
    await expect(executionState(page)).toHaveText("Paused · waiting at the start · stop 1");
    const view = await openPlayground(page);
    await expect(loadButton(view)).not.toHaveAttribute("aria-disabled");
    await expect(banner(view)).toHaveCount(0);

    await loadButton(view).click();
    await expect(banner(view)).toBeVisible();
    // one read, of the ARM7 from 0: wave memory and the register file of one moment
    expect(rpc.requests("state.getMemoryBinary").map((frame) => frame.params)).toEqual([READ]);
    const { result, memory, tick } = readOf(rpc, rpc.requests("state.getMemoryBinary")[0]);
    expect(result.totalBytes).toBe(READ.length);
    expect(memory.byteLength).toBe(READ.length);
    expect(tick?.executionState).toMatchObject({ state: "paused", stopId: 1, reason: "start" });

    // where it is from: the server as the connection picker names it, the stop, the time of the tick
    const host = new URL(mock.baseURL).host;
    await expect(banner(view)).toContainText(`Loaded from nullDC (mock) @ ${host}, stop 1`);
    await expect(banner(view).locator("time")).toHaveAttribute("datetime", new Date(tick!.timestamp).toISOString());
    await expect(banner(view).locator("time")).toHaveText(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
    // the start stop is at step 0: what the DSP reads in the next sample is not known, and EXTS is 0
    await expect(banner(view)).toContainText("At step 0: MIXS of the next sample is not known.");
    await expect(banner(view)).toContainText("EXTS (the CD-DA input) is no register a CPU reads: it is loaded as 0.");

    // the program, as the Assembler tab's source: the mock's, line for line
    await expect(view.getByRole("tab", { name: "Assembler" })).toHaveAttribute("aria-selected", "true");
    const editor = monacoEditor(view);
    await expect.poll(() => monacoVisibleText(editor)).toMatch(/^# AICA-DSP\n\n# COEF\n/);
    await expect(editor.locator("xpath=../../following-sibling::div")).toHaveText("Assembled");
    await expandDebugger(view);
    await expectLoaded(view, memory, tick!);
    // the playground stands at the loaded step, paused: its disassembly marks it, and its steps can be used
    await expect(view.getByRole("button", { name: "Stop DSP" })).toBeVisible();
    await expect(tooltipButton(view, "Step")).toBeEnabled();
    await expect(view.locator(".current-instruction")).toHaveAttribute("data-address", "0");
    for (const [step, line] of MOCK_DSP_PROGRAM.map((text) => [Number(/^MPRO\[(\d+)\]/.exec(text)![1]), text] as const)) {
      await expect(view.locator(`[data-address="${step}"]`).locator("span").nth(1), `step ${step}`).toHaveText(line.replace(/^MPRO\[\d+\] = /, ""));
    }

    // RBPL from the rows (a CPU reads 0x2804 as 0), and EXTS 0
    const regs = await downloadRegs(page, view);
    const common = (name: string) => row(tick!, "dc.aica.common", name);
    expect(regs.getUint32(0x2804, true)).toBe(common("RBP") | (common("RBL") << 13) | (common("TESTB0") << 15));
    expect(common("TESTB0")).toBe(0);
    expect([regs.getUint32(0x45c0, true), regs.getUint32(0x45c4, true)]).toEqual([0, 0]);
    // without TESTB0 the end of the sample counts MDEC_CT down
    const mdec = row(tick!, "dc.aica.dsp", "MDEC_CT");
    await tooltipButton(view, "Run to next sample").click();
    await expect(register(view, "Sample")).toHaveText(/^\s*1$/);
    expect(await registerHex(view, "MDEC_CT")).toBe((mdec - 1) & 0xffff);
    // nothing was refused
    await expect(view.getByRole("alert").filter({ hasText: "Load from emulator:" })).toHaveCount(0);
  });

  test("at a DSP breakpoint's stop: the step it stopped in front of, and no warning, for the load is exact to the end of the sample", async ({ page, rpc }) => {
    await openWorkspace(page, "audio-debugger");
    const breakpoints = panel(page, "dsp-breakpoints");
    await breakpoints.getByRole("textbox").fill("5");
    await breakpoints.getByRole("textbox").press("Enter");
    await expect(breakpoints.getByRole("listitem")).toHaveCount(1);
    await control(page, "Run").click();
    await expect(executionState(page)).toHaveText("Paused · breakpoint dc.aica.dsp.step == 005 · stop 2");
    const view = await openPlayground(page);
    await loadButton(view).click();
    await expect(banner(view)).toContainText("stop 2");
    const { memory, tick } = readOf(rpc, rpc.requests("state.getMemoryBinary")[0]);
    expect(row(tick!, "dc.aica.dsp", "STEP")).toBe(5);
    await expect(banner(view)).toContainText("At step 5, in the DSP phase of a sample: up to the end of that sample (step 127) the playground computes what the emulator computes");
    await expect(banner(view)).not.toContainText("not known");
    await expect(banner(view)).toContainText("loaded as 0");
    await expandDebugger(view);
    await expectLoaded(view, memory, tick!);
    await expect(view.locator(".current-instruction")).toHaveAttribute("data-address", "5");
    // the steps from there: the step it stands at first, whatever breakpoint the playground has there
    await tooltipButton(view, "Step").click();
    await expect(register(view, "Step")).toHaveText(/^\s*6$/);
    await expect(view.locator(".current-instruction")).toHaveAttribute("data-address", "6");
  });

  test("the banner is of the stop it was loaded at: a load at a later stop names that one", async ({ page, rpc }) => {
    await openWorkspace(page, "audio-debugger");
    const view = await openPlayground(page);
    await loadButton(view).click();
    await expect(banner(view)).toContainText("stop 1");
    // two DSP steps: stops 2 and 3
    await control(page, "Step Into").click();
    await expect(executionState(page)).toHaveText("Paused · step completed · stop 2");
    await control(page, "Step Into").click();
    await expect(executionState(page)).toHaveText("Paused · step completed · stop 3");
    await loadButton(view).click();
    await expect(banner(view)).toContainText(/, stop 3, /);
    await expect(banner(view)).not.toContainText("stop 1");
    const reads = rpc.requests("state.getMemoryBinary");
    expect(reads).toHaveLength(2);
    const { tick } = readOf(rpc, reads[1]);
    expect(tick?.executionState).toMatchObject({ state: "paused", stopId: 3, reason: "step" });
    await expect(banner(view).locator("time")).toHaveAttribute("datetime", new Date(tick!.timestamp).toISOString());
    // a DSP step's stop is behind step 0: no warning
    expect(row(tick!, "dc.aica.dsp", "STEP")).toBe(2);
    await expect(banner(view)).not.toContainText("not known");
    await expandDebugger(view);
    await expect(register(view, "Step")).toHaveText(/^\s*2$/);
  });
});

test.describe("against the mock with TESTB0 set", () => {
  test.use({ mockOptions: { startPaused: true, testb0: true, graceMs: 600_000 } });

  test("RBPL has bit 15 from TESTB0, and the end of the sample XORs MDEC_CT with 0x8080", async ({ page, rpc }) => {
    await openWorkspace(page, "audio-debugger");
    const view = await openPlayground(page);
    await loadButton(view).click();
    await expect(banner(view)).toBeVisible();
    const { tick } = readOf(rpc, rpc.requests("state.getMemoryBinary")[0]);
    const common = (name: string) => row(tick!, "dc.aica.common", name);
    expect(common("TESTB0")).toBe(1);
    const regs = await downloadRegs(page, view);
    expect(regs.getUint32(0x2804, true)).toBe(common("RBP") | (common("RBL") << 13) | 0x8000);
    await expandDebugger(view);
    const mdec = row(tick!, "dc.aica.dsp", "MDEC_CT");
    expect(await registerHex(view, "MDEC_CT")).toBe(mdec);
    await tooltipButton(view, "Run to next sample").click();
    await expect(register(view, "Sample")).toHaveText(/^\s*1$/);
    expect(await registerHex(view, "MDEC_CT")).toBe(mdec ^ 0x8080);
  });
});

test.describe("the button", () => {
  test("is off while the target runs and says why; nothing is read until the target stops", async ({ page, rpc }) => {
    await openWorkspace(page, "audio-debugger");
    await expect(executionState(page)).toHaveText("Running");
    const view = await openPlayground(page);
    await expect(loadButton(view)).toHaveAttribute("aria-disabled", "true");
    await expect(loadButton(view)).toHaveAccessibleDescription("Load from emulator: the target is running: a snapshot is taken at a stop");
    await loadButton(view).click({ force: true });
    await page.waitForTimeout(300);
    expect(rpc.requests("state.getMemoryBinary")).toEqual([]);
    await expect(banner(view)).toHaveCount(0);

    await control(page, "Pause").click();
    await expect(executionState(page)).toHaveText(/^Paused · paused by the debugger · stop \d+$/);
    await expect(loadButton(view)).not.toHaveAttribute("aria-disabled");
    await expect(loadButton(view)).toHaveAccessibleDescription(/^Loads the emulator's DSP, at the stop it is in, into the playground/);
    await loadButton(view).click();
    await expect(banner(view)).toBeVisible();
    expect(rpc.requests("state.getMemoryBinary")).toHaveLength(1);
    // and off again when it runs
    await control(page, "Run").click();
    await expect(executionState(page)).toHaveText("Running");
    await expect(loadButton(view)).toHaveAttribute("aria-disabled", "true");
  });

  test("on the playground's tool page it is off, says where it works, and no connection is opened", async ({ page, rpc }) => {
    await gotoRoute(page, "/tool/dsp-playground");
    const button = page.getByRole("button", { name: "Load from emulator", exact: true });
    await expect(button).toHaveAttribute("aria-disabled", "true");
    await expect(button).toHaveAccessibleDescription(/^Load from emulator: the playground has no emulator connection on its tool page; it has the session of a workspace in a workspace's dock panel/);
    await button.click({ force: true });
    await page.waitForTimeout(500);
    expect(rpc.sockets).toEqual([]);
  });
});

/** The rows of dc.aica.dsp and dc.aica.common of a server of milestone M3, the datapath as given. */
const m3Rows = (values: Partial<Record<string, number>> = {}): Record<string, ScriptedRegister[]> => {
  const value = (name: string, fallback: number) => `0x${(values[name] ?? fallback).toString(16).toUpperCase()}`;
  return {
    "dc.aica.dsp": [
      ["STEP", 8, 9],
      ["MDEC_CT", 16, 0x1234],
      ["RBP", 16, 0x40],
      ["RBL", 8, 1],
      ["ACC", 26, 0x2abcdef],
      ["Y_REG", 24, 0x812345],
      ["FRC_REG", 13, 0x1fff],
      ["ADRS_REG", 12, 0x987],
      ["LATCH", 16, 0xbeef],
      ["LATCH_COPY", 16, 0xcafe],
      ["MEMVAL", 16, 0x1357],
      ["NOFL_PIPE", 2, 2],
      ["MIXS_BANK", 1, 1],
    ].map(([name, width, fallback]) => ({ name: name as string, value: value(name as string, fallback as number), width: width as number })),
    "dc.aica.common": [
      { name: "RBP", value: value("RBP", 0x40), width: 12 },
      { name: "RBL", value: value("RBL", 1), width: 2 },
      { name: "TESTB0", value: value("TESTB0", 0), width: 1 },
    ],
  };
};

/** A read of the ARM7 from 0 whose register file has COEF[0] = coef and nothing else. */
const memoryWith = (coef: number): Uint8Array => {
  const memory = new Uint8Array(READ.length);
  memory[REGISTER_FILE + 0x3000] = coef & 0xff;
  memory[REGISTER_FILE + 0x3001] = coef >> 8;
  return memory;
};

/**
 * A scripted server of milestone M3 that is paused in stop 1 and answers state.getMemoryBinary by `read`: the
 * response first, then whatever `between` sends, then the frames `frames` gives (by default the one of the read).
 */
const serveSnapshots = async (
  page: Page,
  read: { memory: Uint8Array; between?: (server: ScriptedDebugger) => void; frames?: (id: number, payload: Uint8Array) => Uint8Array[] },
): Promise<ScriptedDebugger> => {
  const server = await serveScriptedDebugger(page);
  Object.assign(server.state.registers, m3Rows());
  server.describeAgain();
  (server.shape.capabilities as string[]).push("memory-binary");
  let binaryId = 0;
  server.answer("state.getMemoryBinary", (params: Json) => {
    const id = ++binaryId;
    const payload = read.memory.slice(Number(params.address), Number(params.address) + Number(params.length));
    setTimeout(() => {
      read.between?.(server);
      for (const frame of read.frames?.(id, payload) ?? [encodeBinaryFrame(BinaryFrameKind.MEMORY, id, payload)]) {
        server.sendBinary(frame);
      }
    }, 0);
    return { baseAddress: Number(params.address), totalBytes: payload.byteLength, binaryId: id };
  });
  return server;
};

const openScripted = async (page: Page, server: ScriptedDebugger): Promise<Locator> => {
  await gotoRoute(page, "/workspace/audio-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");
  await server.described();
  return openPlayground(page);
};

test.describe("scripted servers", () => {
  test("a stop that ends while the read is on its way gives no snapshot: two moments are none, and the panel says why", async ({ page }) => {
    const server = await serveSnapshots(page, {
      memory: memoryWith(0x7ff8),
      // the target runs before the frame is sent: the read and any tick from here on are of different moments
      between: (scripted) => {
        scripted.state.execution = { state: "running" };
        scripted.tick({ paths: ["dc.sh4.cpu", "dc.aica.arm7", "dc.aica.dsp", "dc.timing"] });
      },
    });
    const view = await openScripted(page, server);
    await loadButton(view).click();
    const failure = view.getByRole("alert").filter({ hasText: "Load from emulator:" });
    await expect(failure).toHaveText("Load from emulator: the target ran while the snapshot was taken (stop 1 ended): load again at a stop");
    await expect(banner(view)).toHaveCount(0);
    // nothing of it is in the playground: it was not started, and its program is its own
    await expect(view.getByRole("button", { name: "Start DSP" })).toBeVisible();
    await expect(view.getByRole("tab", { name: "Compiler" })).toHaveAttribute("aria-selected", "true");
    expect(server.requestsOf("state.getMemoryBinary")).toEqual([READ]);
  });

  test("the tick behind the read is of another stop: no snapshot", async ({ page }) => {
    const server = await serveSnapshots(page, {
      memory: memoryWith(0x7ff8),
      // a stop and another one, between the response and the frame: the describe's tick is of stop 3
      between: (scripted) => {
        scripted.state.execution = { state: "paused", stopId: 3, reason: "step" };
      },
    });
    const view = await openScripted(page, server);
    await loadButton(view).click();
    await expect(view.getByRole("alert").filter({ hasText: "Load from emulator:" })).toHaveText(/stop 1 ended/);
    await expect(banner(view)).toHaveCount(0);
  });

  test("a tick between the response and its frame, and a frame of another binaryId in front of it: the load takes the frame the read announced", async ({ page }) => {
    const server = await serveSnapshots(page, {
      memory: memoryWith(0x1238),
      between: (scripted) => scripted.tick(),
      // the frame of another request first (a binaryId the read did not announce), then the read's
      frames: (id, payload) => [encodeBinaryFrame(BinaryFrameKind.MEMORY, id + 100, memoryWith(0x4448)), encodeBinaryFrame(BinaryFrameKind.MEMORY, id, payload)],
    });
    server.state.execution = { state: "paused", stopId: 1, reason: "breakpoint", breakpointId: 1 };
    const view = await openScripted(page, server);
    await loadButton(view).click();
    await expect(banner(view)).toContainText("Loaded from scripted @ ");
    await expect(banner(view)).toContainText(", stop 1, ");
    await expandDebugger(view);
    expect(await registerHex(view, "COEF[0]")).toBe(0x1238);
    // the rows of the tick: STEP 9 and the datapath as the server gave them
    await expect(register(view, "Step")).toHaveText(/^\s*9$/);
    expect(await registerHex(view, "ACC")).toBe(0x2abcdef);
    expect(await registerValue(view, "ACC")).toBe(0x2abcdef - (1 << 26));
    expect(await registerHex(view, "Y_REG")).toBe(0x812345);
    expect(await registerHex(view, "FRC_REG")).toBe(0x1fff);
    expect(await registerHex(view, "ADRS_REG")).toBe(0x987);
    expect(await registerHex(view, "LATCH")).toBe(0xbeef);
    expect(await registerHex(view, "LATCH_COPY")).toBe(0xcafe);
    expect(await registerHex(view, "MEMVAL")).toBe(0x1357);
    expect(await registerHex(view, "NOFL_PIPE")).toBe(2);
    expect(await registerHex(view, "MIXS_BANK")).toBe(1);
    expect(await registerHex(view, "MDEC_CT")).toBe(0x1234);
  });

  test("the banner's time is the tick's, and its stop the stop's", async ({ page }) => {
    const server = await serveSnapshots(page, { memory: memoryWith(0) });
    server.state.execution = { state: "paused", stopId: 41, reason: "breakpoint", breakpointId: 1 };
    // the tick behind the describe of the load: a time of its own
    let describes = 0;
    server.afterDescribe = () => server.tick({ patch: { timestamp: ++describes === 1 ? 1_700_000_000_000 : 1_760_000_123_456 } });
    const view = await openScripted(page, server);
    await expect(executionState(page)).toHaveText(/ · stop 41$/);
    await loadButton(view).click();
    await expect(banner(view)).toContainText("stop 41");
    await expect(banner(view).locator("time")).toHaveAttribute("datetime", new Date(1_760_000_123_456).toISOString());
    expect(server.requestsOf("debugger.describe")).toHaveLength(2);
  });

  test("a server without the datapath rows of M3 gives no snapshot, and says which rows are missing", async ({ page }) => {
    const server = await serveSnapshots(page, { memory: memoryWith(0) });
    server.state.registers["dc.aica.dsp"] = server.state.registers["dc.aica.dsp"].filter((register) => ["STEP", "MDEC_CT", "RBP", "RBL"].includes(register.name));
    server.describeAgain();
    (server.shape.capabilities as string[]).push("memory-binary");
    const view = await openScripted(page, server);
    await loadButton(view).click();
    await expect(view.getByRole("alert").filter({ hasText: "Load from emulator:" })).toHaveText(
      "Load from emulator: the paused tick has no ACC, Y_REG, FRC_REG, ADRS_REG, LATCH, LATCH_COPY, MEMVAL, NOFL_PIPE, MIXS_BANK in dc.aica.dsp: the load needs the registers a server of milestone M3 has there",
    );
    await expect(banner(view)).toHaveCount(0);
  });

  test("a read the server refuses is the panel's message", async ({ page }) => {
    const server = await serveSnapshots(page, { memory: memoryWith(0) });
    server.answer("state.getMemoryBinary", () => jsonRpcError(-32010, "nothing in the range is readable"));
    const view = await openScripted(page, server);
    await loadButton(view).click();
    await expect(view.getByRole("alert").filter({ hasText: "Load from emulator:" })).toHaveText("Load from emulator: nothing in the range is readable");
  });

  test("a server without memory-binary: the button is off and says why", async ({ page }) => {
    const server = await serveScriptedDebugger(page);
    Object.assign(server.state.registers, m3Rows());
    server.describeAgain();
    const view = await openScripted(page, server);
    await expect(loadButton(view)).toHaveAttribute("aria-disabled", "true");
    await expect(loadButton(view)).toHaveAccessibleDescription("Load from emulator: this server cannot read memory into a binary frame (capability memory-binary)");
  });
});

// Left by F4c: a -32011 from the fetch behind a successful Record is no "no capture yet" there: the server has just
// said that it has one. The SGC panel says so in its alert, and shows no capture.
test("the SGC panel: a Record whose fetch behind it answers -32011 is the alert \"Record: no capture available\"", async ({ page, diagnostics }) => {
  const logged = /^console\.error: Failed to record SGC frame data: Error: no capture available/;
  diagnostics.allow(logged, "the SGC panel logs a record whose fetch found no capture");
  const server = await serveScriptedDebugger(page);
  (server.shape.capabilities as string[]).push("sgc-capture");
  server.answer("state.recordSgcFrames", () => ({}));
  server.answer("state.getSgcFrameData", () => jsonRpcError(-32011, "no capture available"));
  await gotoRoute(page, "/workspace/audio-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");
  await server.described();
  const sgc = panel(page, "sgc");
  // before a record, -32011 is "none yet": no alert
  await expect(sgc.getByText("Record some data to display here")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await tooltipButton(sgc, "Run the emulator and record 1024 frames").click();
  const alert = page.getByRole("alert");
  await expect(alert).toHaveCount(1);
  await expect(alert).toContainText("Record: no capture available");
  await expect.poll(() => diagnostics.all().filter((problem) => logged.test(problem))).toHaveLength(1);
  expect(server.requestsOf("state.recordSgcFrames")).toEqual([{ frames: 1024 }]);
  expect(server.requestsOf("state.getSgcFrameData")).toHaveLength(2);
  await expect(sgc.locator("canvas")).toHaveCount(0);
  await expect(sgc.getByText("Record some data to display here")).toBeVisible();
});
