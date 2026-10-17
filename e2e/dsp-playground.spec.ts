import { test, expect, canvasStats, gotoRoute, tooltipButton } from "./support/fixtures";
import { expectMonacoReady, monacoEditor, monacoReplaceAll, monacoTokenClasses, monacoVisibleText } from "./support/monaco";
import type { Locator, Page } from "@playwright/test";

/** The status label that the source and assembly editors draw in their bottom-right corner. */
const editorStatus = (page: Page): Locator => page.locator(".monaco-editor").first().locator("xpath=../../following-sibling::div");

/** The value shown next to a register name in the Debugger section. */
const register = (page: Page, name: string): Locator =>
  page.getByText(`${name}:`, { exact: true }).locator("xpath=following-sibling::span");

const registerValue = async (page: Page, name: string) => Number((await register(page, name).innerText()).trim());

/** The plot of an input ("In 00") or output ("Out 00") channel. */
const plot = (page: Page, label: string): Locator =>
  page.getByText(label, { exact: true }).locator("xpath=ancestor::div[.//canvas][1]").locator("canvas");

const expandDebugger = async (page: Page) => {
  await page.getByRole("heading", { name: "Debugger" }).locator("xpath=following-sibling::button").click();
  await expect(page.getByText("Disassembly", { exact: true })).toBeVisible();
};

test.beforeEach(async ({ page }) => {
  await gotoRoute(page, "/tool/dsp-playground");
  await expectMonacoReady(monacoEditor(page));
});

test("the default program compiles, and the Compiled and Assembler tabs show assembly", async ({ page }) => {
  const editor = monacoEditor(page);
  expect(await monacoVisibleText(editor)).toContain("#define mLSAME 0");
  // comment, keyword, identifier, number: the aica-dsp-source tokenizer is active
  await expect.poll(async () => (await monacoTokenClasses(editor)).length).toBeGreaterThanOrEqual(3);
  await expect(editorStatus(page)).toHaveText("Compiled");

  // what the compiler produced, read-only
  await page.getByRole("tab", { name: "Compiled" }).click();
  await expect(page.getByRole("tab", { name: "Compiled" })).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => monacoVisibleText(monacoEditor(page))).toContain("MADRS[0]    = 0x1950");
  await expect(editorStatus(page)).toHaveText("Assembled");
  await expect.poll(async () => (await monacoTokenClasses(monacoEditor(page))).length).toBeGreaterThanOrEqual(3);
  await monacoEditor(page).click();
  await page.keyboard.type("x");
  await expect.poll(() => monacoVisibleText(monacoEditor(page))).toContain("MADRS[0]    = 0x1950");
  expect(await monacoVisibleText(monacoEditor(page))).not.toContain("xMADRS");

  // the hand-written program of the Assembler tab
  await page.getByRole("tab", { name: "Assembler" }).click();
  await expect.poll(() => monacoVisibleText(monacoEditor(page))).toContain("# Simple delay using the RBL/RBP");
  expect(await monacoVisibleText(monacoEditor(page))).toContain("MPRO[0] = XSEL:1 YSEL:1 IRA:32 ZERO:1");
  await expect(editorStatus(page)).toHaveText("Assembled");
});

test("a source error is reported in the status label and fixed by correcting the source", async ({ page }) => {
  await expect(editorStatus(page)).toHaveText("Compiled");
  await monacoReplaceAll(page, monacoEditor(page), "INPUT mixer:0\nOUTPUT mixer:0\nNOT A STATEMENT\n");
  await expect(editorStatus(page)).toHaveText(/^Error \(\d+ issues?\)$/);
  await expect(editorStatus(page)).toHaveAttribute("title", /Line 3: /);

  await monacoReplaceAll(page, monacoEditor(page), "INPUT mixer:0\nOUTPUT mixer:0\n");
  await expect(editorStatus(page)).toHaveText("Compiled");
  await page.getByRole("tab", { name: "Compiled" }).click();
  await expect.poll(() => monacoVisibleText(monacoEditor(page))).toMatch(/MPRO\[0\]\s+=/);
});

test("an assembler error is reported and the edited program survives a reload", async ({ page }) => {
  await page.getByRole("tab", { name: "Assembler" }).click();
  await expect(editorStatus(page)).toHaveText("Assembled");

  await monacoReplaceAll(page, monacoEditor(page), "COEF[0] = 100\nMPRO[0] = BOGUS:1\n");
  await expect(editorStatus(page)).toHaveText("Error (1 issue)");

  await monacoReplaceAll(page, monacoEditor(page), "COEF[0] = 100\nMPRO[0] = XSEL:1 EWT:1 EWA:3\n");
  await expect(editorStatus(page)).toHaveText("Assembled");

  await page.reload();
  await expectMonacoReady(monacoEditor(page));
  // the active tab and its text come back
  await expect(page.getByRole("tab", { name: "Assembler" })).toHaveAttribute("aria-selected", "true");
  await expect.poll(() => monacoVisibleText(monacoEditor(page))).toContain("MPRO[0] = XSEL:1 EWT:1 EWA:3");
  await expect(editorStatus(page)).toHaveText("Assembled");
});

test("Start DSP runs the program; paused, the debugger steps it one step, one sample and 128 samples at a time", async ({
  page,
}) => {
  await expect(editorStatus(page)).toHaveText("Compiled");
  await page.getByRole("button", { name: "Start DSP" }).click();
  await expect(page.getByRole("button", { name: "Stop DSP" })).toBeVisible();
  await expect(page.getByText("Keyboard input active:")).toBeVisible();

  await expandDebugger(page);
  // the disassembly of the compiled program, 64 of its 128 steps
  const rows = page.locator("[data-address]");
  await expect(rows).toHaveCount(64);
  await expect(rows.first().locator("span").first()).toHaveText("000");
  await expect(rows.first().locator("span").nth(1)).toHaveText(/\S/);
  await expect(tooltipButton(page, "Step")).toBeDisabled();

  await tooltipButton(page, "Pause").click();
  await expect(tooltipButton(page, "Run")).toBeVisible();
  await expect(tooltipButton(page, "Step")).toBeEnabled();
  // the audio callback always stops at a sample boundary
  await expect(register(page, "Step")).toHaveText(/^\s*0$/);
  await expect(page.locator(".current-instruction")).toHaveAttribute("data-address", "0");
  const sample = await registerValue(page, "Sample");
  expect(sample).toBeGreaterThanOrEqual(0);

  // Step: one DSP step
  for (const step of [1, 2, 3]) {
    await tooltipButton(page, "Step").click();
    await expect(register(page, "Step")).toHaveText(new RegExp(`^\\s*${step}$`));
    await expect(page.locator(".current-instruction")).toHaveAttribute("data-address", String(step));
  }
  expect(await registerValue(page, "Sample")).toBe(sample);

  // Run to next sample: the remaining steps of this sample
  await tooltipButton(page, "Run to next sample").click();
  await expect(register(page, "Step")).toHaveText(/^\s*0$/);
  await expect(register(page, "Sample")).toHaveText(new RegExp(`^\\s*${sample + 1}$`));
  await expect(page.locator(".current-instruction")).toHaveAttribute("data-address", "0");

  // Run 128 samples
  await tooltipButton(page, "Run 128 samples").click();
  await expect(register(page, "Sample")).toHaveText(new RegExp(`^\\s*${sample + 129}$`));
  await expect(register(page, "Step")).toHaveText(/^\s*0$/);

  // a breakpoint in the gutter stops the 128-sample run at that step
  const row = page.locator('[data-address="5"]');
  await row.hover();
  await row.locator(".breakpoint-gutter").click();
  await expect(row.locator(".breakpoint-gutter")).toHaveAttribute("data-breakpoint", "enabled");
  await tooltipButton(page, "Run 128 samples").click();
  await expect(register(page, "Step")).toHaveText(/^\s*5$/);
  await expect(register(page, "Sample")).toHaveText(new RegExp(`^\\s*${sample + 129}$`));
  await expect(page.locator(".current-instruction")).toHaveAttribute("data-address", "5");

  await page.getByRole("button", { name: "Stop DSP" }).click();
  await expect(page.getByRole("button", { name: "Start DSP" })).toBeVisible();
});

test("a breakpoint on the step a run starts from is passed, one on the step behind it stops the run", async ({ page }) => {
  await expect(editorStatus(page)).toHaveText("Compiled");
  await page.getByRole("button", { name: "Start DSP" }).click();
  await expandDebugger(page);
  await tooltipButton(page, "Pause").click();
  await expect(tooltipButton(page, "Step")).toBeEnabled();
  await expect(register(page, "Step")).toHaveText(/^\s*0$/);
  await tooltipButton(page, "Step").click();
  await expect(register(page, "Step")).toHaveText(/^\s*1$/);
  const sample = await registerValue(page, "Sample");

  for (const step of [1, 2]) {
    const row = page.locator(`[data-address="${step}"]`);
    await row.hover();
    await row.locator(".breakpoint-gutter").click();
    await expect(row.locator(".breakpoint-gutter")).toHaveAttribute("data-breakpoint", "enabled");
  }

  // from step 1: its breakpoint is passed, the one on step 2 stops the run
  await tooltipButton(page, "Run to next sample").click();
  await expect(register(page, "Step")).toHaveText(/^\s*2$/);
  expect(await registerValue(page, "Sample")).toBe(sample);
  // from step 2, the same: the run ends at step 1 of the next sample
  await tooltipButton(page, "Run 128 samples").click();
  await expect(register(page, "Step")).toHaveText(/^\s*1$/);
  await expect(register(page, "Sample")).toHaveText(new RegExp(`^\\s*${sample + 1}$`));
  // and the DSP running with the audio: Run passes step 1 and stops at step 2
  await tooltipButton(page, "Run").click();
  await expect(tooltipButton(page, "Step")).toBeEnabled();
  await expect(register(page, "Step")).toHaveText(/^\s*2$/);
  await expect(register(page, "Sample")).toHaveText(new RegExp(`^\\s*${sample + 1}$`));
  await expect(page.locator(".current-instruction")).toHaveAttribute("data-address", "2");

  await page.getByRole("button", { name: "Stop DSP" }).click();
});

test("the registers are the core's: whole TEMP and MEMS words, EFREG as signed 16 bits, the read latch, its copy and MEMVAL", async ({
  page,
}) => {
  // MEMS[0] = -0x100000, MEMS[1] = 0x12345A, MEMS[2] = 0x400000, written as MEMS_H (bits 23:8) and MEMS_L (bits 7:0,
  // which the CPU cannot write). Steps 0, 2, 4 multiply them by COEF (4095 / 4096); steps 1, 3, 5 write the products,
  // SHIFTED[23:8] (NOFL), to the wave RAM words MADRS[0..2] (TABLE 1: no MDEC_CT, the same words every sample):
  // 0xF001, 0x1233, 0x3FFC. Step 1 also writes the first product to EFREG[0] (SHIFTED[23:8], -4095) and whole to
  // TEMP[0 + MDEC_CT] (SHIFTED, -1048320 = 0xF00100, whose low byte alone is 0). Steps 8, 10, 12 read the three words
  // back in the other order: in front of step 13 the read latch has the last (0xF001), its copy of the end of step 11
  // the one before (0x1233), and MEMVAL, the copy as it was at the start of step 11, the first (0x3FFC)
  await page.getByRole("tab", { name: "Assembler" }).click();
  await expect(editorStatus(page)).toHaveText("Assembled");
  await monacoReplaceAll(
    page,
    monacoEditor(page),
    [
      "COEF[0] = 32760",
      "COEF[2] = 32760",
      "COEF[4] = 32760",
      "MADRS[0] = 0x100",
      "MADRS[1] = 0x200",
      "MADRS[2] = 0x300",
      "MEMS_L[0] = 0x00",
      "MEMS_H[0] = 0xF000",
      "MEMS_L[1] = 0x5A",
      "MEMS_H[1] = 0x1234",
      "MEMS_L[2] = 0x00",
      "MEMS_H[2] = 0x4000",
      "MPRO[0] = XSEL:1 YSEL:1 IRA:0 ZERO:1",
      "MPRO[1] = EWT:1 EWA:0 TWT:1 TWA:0 MWT:1 NOFL:1 TABLE:1 MASA:0",
      "MPRO[2] = XSEL:1 YSEL:1 IRA:1 ZERO:1",
      "MPRO[3] = MWT:1 NOFL:1 TABLE:1 MASA:1",
      "MPRO[4] = XSEL:1 YSEL:1 IRA:2 ZERO:1",
      "MPRO[5] = MWT:1 NOFL:1 TABLE:1 MASA:2",
      "MPRO[8] = MRD:1 NOFL:1 TABLE:1 MASA:2",
      "MPRO[10] = MRD:1 NOFL:1 TABLE:1 MASA:1",
      "MPRO[12] = MRD:1 NOFL:1 TABLE:1 MASA:0",
      "",
    ].join("\n"),
  );
  await expect(editorStatus(page)).toHaveText("Assembled");

  await page.getByRole("button", { name: "Start DSP" }).click();
  await expandDebugger(page);
  await tooltipButton(page, "Pause").click();
  await expect(tooltipButton(page, "Step")).toBeEnabled();
  await expect(register(page, "Step")).toHaveText(/^\s*0$/);
  const row = page.locator('[data-address="13"]');
  await row.hover();
  await row.locator(".breakpoint-gutter").click();
  await expect(row.locator(".breakpoint-gutter")).toHaveAttribute("data-breakpoint", "enabled");
  await tooltipButton(page, "Run to next sample").click();
  await expect(register(page, "Step")).toHaveText(/^\s*13$/);

  await expect(register(page, "MEMS[0]")).toHaveText(/^\s*-1048576$/);
  await expect(register(page, "MEMS[0]")).toHaveAttribute("title", "0xF00000");
  await expect(register(page, "MEMS[1]")).toHaveText(/^\s*1193050$/);
  await expect(register(page, "MEMS[1]")).toHaveAttribute("title", "0x12345A");
  await expect(register(page, "EFREG[0]")).toHaveText(/^\s*-4095$/);
  await expect(register(page, "EFREG[0]")).toHaveAttribute("title", "0xF001");
  await expect(register(page, "COEF[0]")).toHaveAttribute("title", "0x7FF8");
  // TEMP whole: the TWT of this sample, at TWA + MDEC_CT
  const mdec = await registerValue(page, "MDEC_CT");
  await expect(register(page, `TEMP[${mdec % 128}]`)).toHaveText(/^\s*-1048320$/);
  await expect(register(page, `TEMP[${mdec % 128}]`)).toHaveAttribute("title", "0xF00100");
  // one read latch, its copy and MEMVAL, three words, in place of MEMVAL[0..3]
  await expect(register(page, "LATCH")).toHaveText(/^\s*61441$/);
  await expect(register(page, "LATCH")).toHaveAttribute("title", "0xF001");
  await expect(register(page, "LATCH_COPY")).toHaveText(/^\s*4659$/);
  await expect(register(page, "LATCH_COPY")).toHaveAttribute("title", "0x1233");
  await expect(register(page, "MEMVAL")).toHaveText(/^\s*16380$/);
  await expect(register(page, "MEMVAL")).toHaveAttribute("title", "0x3FFC");
  for (const name of ["MIXS_BANK", "ACC", "INPUTS"]) {
    await expect(register(page, name)).toBeVisible();
  }
  await expect(page.getByText("MEMVAL[0]:", { exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Stop DSP" }).click();
});

test("Pause stops the DSP at once", async ({ page }) => {
  // regression (race): Pause calls AudioContext.suspend(), which is asynchronous. An audio
  // buffer that was already queued used to run 1024 more samples after the debugger showed
  // the paused state, so the Sample register shown at the pause was stale.
  await expect(editorStatus(page)).toHaveText("Compiled");
  await page.getByRole("button", { name: "Start DSP" }).click();
  await expandDebugger(page);
  for (let round = 0; round < 5; round++) {
    await tooltipButton(page, "Pause").click();
    await expect(tooltipButton(page, "Step")).toBeEnabled();
    const shown = await registerValue(page, "Sample");
    await page.waitForTimeout(300);
    await tooltipButton(page, "Step").click();
    await expect(register(page, "Step")).toHaveText(/^\s*1$/);
    expect(await registerValue(page, "Sample"), `round ${round}`).toBe(shown);
    await tooltipButton(page, "Run").click();
    await expect(tooltipButton(page, "Step")).toBeDisabled();
    await page.waitForTimeout(100);
  }
});

test("the keyboard input drives the input plot and the program's output plot, at the console's scale", async ({ page }) => {
  // In 00 times COEF[0] (just under 1.0) -> Out 00 (EFREG[0]). The input goes to MIXS[0] as the console's
  // sound generator sends it, its 16-bit sample << 4, the DSP reads it as INPUTS 32 (MIXS << 4) and EWT writes
  // SHIFTED[23:8]: the output is the input, one sample later, as tall in its plot. An input written to MIXS at
  // the old playground's scale, the sample itself, would come out 16 times lower: a flat line
  await page.getByRole("tab", { name: "Assembler" }).click();
  await expect(editorStatus(page)).toHaveText("Assembled");
  await monacoReplaceAll(
    page,
    monacoEditor(page),
    "COEF[0] = 32760\nMPRO[0] = XSEL:1 YSEL:1 IRA:32 ZERO:1\nMPRO[1] = EWT:1 EWA:0\n",
  );
  await expect(editorStatus(page)).toHaveText("Assembled");

  const input = plot(page, "In 00");
  const silentInput = plot(page, "In 01");
  const output = plot(page, "Out 00");
  // nothing has run: every plot is a flat line, a couple of pixel rows high
  expect((await canvasStats(input)).inkRows).toBeGreaterThan(0);
  expect((await canvasStats(input)).inkRows).toBeLessThan(5);
  expect((await canvasStats(output)).inkRows).toBeLessThan(5);

  await page.getByRole("button", { name: "Start DSP" }).click();
  await expect(page.getByRole("button", { name: "Stop DSP" })).toBeVisible();
  // leave the editor: the note keys only play when no text field has the focus
  await page.getByRole("heading", { name: "Waveforms" }).click();
  await page.keyboard.down("z");
  try {
    // a 130 Hz sine instead of the flat line, on the input and on the output it is copied to
    await expect.poll(async () => (await canvasStats(input)).inkRows).toBeGreaterThan(15);
    await expect.poll(async () => (await canvasStats(output)).inkRows).toBeGreaterThan(15);
    // the two plots show the same samples, one apart: the output is about as tall as the input
    await expect
      .poll(async () => {
        const [inputRows, outputRows] = [(await canvasStats(input)).inkRows, (await canvasStats(output)).inkRows];
        return inputRows > 15 && outputRows >= 0.75 * inputRows && outputRows <= 1.25 * inputRows;
      })
      .toBe(true);
    // an input without a source stays flat
    expect((await canvasStats(silentInput)).inkRows).toBeLessThan(5);
  } finally {
    await page.keyboard.up("z");
  }
  await page.getByRole("button", { name: "Stop DSP" }).click();
});

test("Share copies a link with the compiled program and Download Regs saves the register file", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await expect(editorStatus(page)).toHaveText("Compiled");

  // the help says where the link goes: the original online playground, whose DSP is not this one
  await page.getByRole("button", { name: "Share" }).hover();
  await expect(page.getByRole("tooltip")).toContainText("the original online AICA DSP playground");
  await expect(page.getByRole("tooltip")).toContainText("Its DSP is not this one");
  await page.getByRole("button", { name: "Share" }).click();
  await expect(page.getByRole("button", { name: "Copied!" })).toBeVisible();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  expect(url).toMatch(/^https:\/\/skmp\.gitlab\.io\/aica-dsp-playground\/\?source=.+/);
  await expect(page).toHaveURL(/#\/tool\/dsp-playground$/);

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download Regs" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("dsp_memory_dump.bin");
  const stream = await file.createReadStream();
  let size = 0;
  for await (const chunk of stream) {
    size += (chunk as Buffer).length;
  }
  expect(size).toBe(0x8000);
});
