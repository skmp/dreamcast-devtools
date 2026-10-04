import { test, expect, canvasStats, gotoRoute, tooltipButton, KNOWN } from "./support/fixtures";
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

test.beforeEach(async ({ page, diagnostics }) => {
  diagnostics.allow(...KNOWN.monacoCdn);
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
  // TODAY an audio buffer that was already on its way still runs after Pause (see the fixme
  // below), so let it pass and take the sample counter from the first step.
  await page.waitForTimeout(500);

  // Step: one DSP step
  await tooltipButton(page, "Step").click();
  await expect(register(page, "Step")).toHaveText(/^\s*1$/);
  await expect(page.locator(".current-instruction")).toHaveAttribute("data-address", "1");
  const sample = await registerValue(page, "Sample");
  expect(sample).toBeGreaterThanOrEqual(0);
  for (const step of [2, 3]) {
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

test.fixme("Pause stops the DSP at once", async ({ page }) => {
  // BROKEN (race): Pause calls AudioContext.suspend(), which is asynchronous, and shows the
  // paused state right away. An audio buffer that is already queued still runs 1024 samples
  // afterwards, so the Sample register shown at the pause is stale until the next step.
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

test("the keyboard input drives the input plot and the program's output plot", async ({ page }) => {
  // In 00 (MIXS[0], input 32) times COEF[0] (just under 1.0) -> Out 00 (EFREG[0])
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
