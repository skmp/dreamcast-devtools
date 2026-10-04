import { inflateSync } from "node:zlib";
import { test, expect, gotoRoute, KNOWN } from "./support/fixtures";
import { expectMonacoReady, monacoEditor, monacoReplaceAll, monacoTokenClasses, monacoVisibleText } from "./support/monaco";
import type { Locator, Page } from "@playwright/test";

/** The table of the simulated fragment whose heading is `title`. */
const fragment = (page: Page, title: string | RegExp): Locator =>
  page
    .locator("div")
    .filter({ has: page.getByRole("heading", { name: title }) })
    .filter({ has: page.getByRole("table") })
    .last();

/** The error box of the simulator (Monaco has role="alert" live regions of its own). */
const assembleError = (page: Page): Locator => page.locator(".MuiAlert-root");

// src/app/sh4Sim/sim.ts reports every line it cannot assemble with console.error, i.e.
// once per keystroke while an instruction is being typed. The panel shows the same text.
const TYPING = [/^console\.error: Unknown instruction: /, "sim.ts logs assemble errors of the text being typed"] as const;

const decodeShareToken = (url: string): string => {
  const token = new URL(url).searchParams.get("source");
  if (!token) throw new Error(`no source parameter in ${url}`);
  return inflateSync(Buffer.from(token, "base64")).toString("utf8");
};

test.beforeEach(async ({ page, diagnostics, context }) => {
  diagnostics.allow(...KNOWN.monacoCdn);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await gotoRoute(page, "/tool/sh4-sim");
  await expectMonacoReady(monacoEditor(page));
});

test("the default source is shown highlighted and simulated into one pipeline table per fragment", async ({ page }) => {
  const editor = monacoEditor(page);
  expect(await monacoVisibleText(editor)).toContain("; Basic examples from the manual");
  expect(await monacoVisibleText(editor)).toContain("SHAD R0,R1");
  // comment, mnemonic, register, ... : the sh4asm tokenizer is active
  expect((await monacoTokenClasses(editor)).length).toBeGreaterThanOrEqual(3);

  const serial = fragment(page, "serial execution: non-parallel-executable instructions");
  await expect(serial).toContainText("6 cycles");
  await expect(serial.getByRole("row").nth(0)).toHaveText("inst\\cycle012345");
  await expect(serial.getByRole("row").nth(1)).toHaveText("00000000 shad r0,r1IDEXNAS");
  // the second instruction cannot issue with the first: one stall cycle
  await expect(serial.getByRole("row").nth(2)).toHaveText("00000002 add r2,r3IDD!EXEXNAS");

  const parallel = fragment(page, "parallel execution: parallel-executable and no dependency");
  await expect(parallel).toContainText("5 cycles");
  await expect(parallel.getByRole("row").nth(2)).toHaveText("00000002 mov.l @r4,r5IDEXMAS");

  // one table per "#"/"##" fragment of the default source
  await expect(page.getByRole("table")).toHaveCount(23);
  await expect(assembleError(page)).toHaveCount(0);
});

test("editing the source simulates again", async ({ page, diagnostics }) => {
  diagnostics.allow(...TYPING);
  const editor = monacoEditor(page);
  await monacoReplaceAll(page, editor, "# my fragment\nADD R1,R2\nADD R2,R3\n");

  await expect(page.getByRole("table")).toHaveCount(1);
  const mine = fragment(page, "my fragment");
  await expect(mine.getByRole("row").nth(1)).toContainText("00000000 add r1,r2");
  await expect(mine.getByRole("row").nth(2)).toContainText("00000002 add r2,r3");
  await expect(mine).toContainText(/\d+ cycles/);
  expect(await monacoVisibleText(editor)).toContain("ADD R1,R2");

  // typing appends to what is there
  await page.keyboard.type("NOP");
  await expect(mine.getByRole("row").nth(3)).toContainText("00000004 nop");
});

test("an instruction the assembler does not know is reported and the last good tables stay", async ({
  page,
  diagnostics,
}) => {
  diagnostics.allow(...TYPING);
  await monacoReplaceAll(page, monacoEditor(page), "# broken\nADD R1,R2\n");
  await expect(fragment(page, "broken")).toBeVisible();
  await expect(assembleError(page)).toHaveCount(0);

  await page.keyboard.type("FROB R1,R2");
  await expect(assembleError(page)).toHaveText("Unknown instruction: frob r1,r2");
  await expect(fragment(page, "broken").getByRole("row").nth(1)).toContainText("00000000 add r1,r2");

  // fixing the line clears the error
  for (let index = 0; index < "FROB R1,R2".length; index++) {
    await page.keyboard.press("Backspace");
  }
  await page.keyboard.type("NOP");
  await expect(assembleError(page)).toHaveCount(0);
  await expect(fragment(page, "broken").getByRole("row").nth(2)).toContainText("00000002 nop");
});

test("the source survives a reload", async ({ page }) => {
  await monacoReplaceAll(page, monacoEditor(page), "# kept\nSHAD R0,R1\n");
  await expect(fragment(page, "kept")).toBeVisible();

  await page.reload();
  await expectMonacoReady(monacoEditor(page));
  await expect(fragment(page, "kept")).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(1);
  expect(await monacoVisibleText(monacoEditor(page))).toContain("SHAD R0,R1");
});

test("hovering a cell highlights its row and cycle; the options change the rendering", async ({ page }) => {
  await monacoReplaceAll(page, monacoEditor(page), "# hover\nSHAD R0,R1\nADD R2,R3\n");
  const table = fragment(page, "hover").getByRole("table");
  const cell = table.getByRole("row").nth(1).getByRole("cell").nth(2);

  await cell.hover();
  await expect(table.locator(".sh4-sim__cell--row")).toHaveCount(7);
  await expect(table.locator(".sh4-sim__cell--cycle")).toHaveCount(3);

  await page.getByRole("checkbox", { name: "Hide Crosshairs" }).check();
  await cell.hover();
  await expect(table.locator(".sh4-sim__cell--row")).toHaveCount(0);
  await expect(table.locator(".sh4-sim__cell--cycle")).toHaveCount(0);

  const stall = table.getByRole("cell", { name: "D!EX" });
  const solid = await stall.evaluate((element) => getComputedStyle(element).backgroundColor);
  await page.getByRole("checkbox", { name: "Plain Format" }).check();
  await expect.poll(() => stall.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(solid);

  const bordered = await stall.evaluate((element) => getComputedStyle(element).borderTopColor);
  await page.getByRole("checkbox", { name: "Less Borders" }).check();
  await expect.poll(() => stall.evaluate((element) => getComputedStyle(element).borderTopColor)).not.toBe(bordered);
});

test.fixme("Share copies a link to the source and stays on the simulator", async ({ page }) => {
  // BROKEN: handleCopyShare assigns window.location.hash ("" for Share, "#<block id>" for a
  // fragment link). Under the HashRouter that hash IS the route: "" is the home page and
  // "#<block id>" matches no route and redirects there. Clicking Share leaves the tool.
  await monacoReplaceAll(page, monacoEditor(page), "# shared\nADD R1,R2\n");
  await expect(fragment(page, "shared")).toBeVisible();

  await page.getByRole("button", { name: "Share" }).click();
  await expect(page.getByRole("tooltip", { name: "Copied!" })).toBeVisible();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  expect(url).toMatch(/^https:\/\/sh4-sim\.dreamcast\.wiki\?source=/);
  expect(decodeShareToken(url)).toBe("# shared\nADD R1,R2\n");

  await expect(page).toHaveURL(/#\/tool\/sh4-sim$/);
  await expect(fragment(page, "shared")).toBeVisible();
});

test.fixme("the copy-link button of a fragment copies a link to that fragment and stays on the simulator", async ({
  page,
}) => {
  // BROKEN: same cause as Share: the fragment id is written to window.location.hash.
  await monacoReplaceAll(page, monacoEditor(page), "# first\nADD R1,R2\n# second\nADD R3,R4\n");
  const second = fragment(page, "second");
  await expect(second).toBeVisible();
  const id = await page.getByRole("heading", { name: "second" }).getAttribute("id");
  expect(id).toBeTruthy();

  await second.getByRole("button").first().click();
  await expect(page.getByRole("tooltip", { name: "Copied!" })).toBeVisible();
  const url = await page.evaluate(() => navigator.clipboard.readText());
  expect(new URL(url).hash).toBe(`#${id}`);
  expect(decodeShareToken(url)).toBe("# first\nADD R1,R2\n# second\nADD R3,R4\n");

  await expect(page).toHaveURL(/#\/tool\/sh4-sim$/);
  await expect(second).toBeVisible();
});

test("a ?source= link opens the simulator with the shared source", async ({ page }) => {
  // base64(deflate("# from a link\nMOV R1,R2\n"))
  const token = await page.evaluate(async () => {
    const stream = new Blob(["# from a link\nMOV R1,R2\n"]).stream().pipeThrough(new CompressionStream("deflate"));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    return btoa(String.fromCharCode(...bytes));
  });
  await page.goto(`/?source=${encodeURIComponent(token)}#/tool/sh4-sim`);
  await expectMonacoReady(monacoEditor(page));
  await expect(fragment(page, "from a link")).toBeVisible();
  await expect(fragment(page, "from a link").getByRole("row").nth(1)).toContainText("00000000 mov r1,r2");
});
