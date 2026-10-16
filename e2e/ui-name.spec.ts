import type { Locator, Page } from "@playwright/test";
import { test, expect, gotoRoute, openWorkspace, saveScreenshot, statusBar } from "./support/fixtures";

// The UI is called "Dreamcast DevTools": the document title (and the titles of a shared link),
// the home page's heading, the About dialog's title, the status bar and the documentation.
// The emulator it talks to keeps its name, nullDC. The longer name has to fit where the old one
// did: on one line and inside its box, at every window width the suite uses.

/** The old names of the UI (scripts/uiName.test.ts holds the sources to the same pattern). */
const OLD_UI_NAME = /\bnull\s*dc\s+(?:dev\s*tools|debugger|contract\s+runner)\b/i;

/** The window widths of the suite: playwright.config.ts, layout.spec.ts, toolbar.spec.ts, docking.spec.ts. */
const WINDOWS = [
  { width: 1600, height: 1000 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1280, height: 720 },
  { width: 1100, height: 800 },
  { width: 1024, height: 800 },
];

/**
 * How a piece of text is laid out: on how many lines (the line boxes of its text), whether
 * its element cuts it off, and whether it reaches beyond `container` or the window.
 */
const fit = async (text: Locator, container: Locator) =>
  text.evaluate((element, outer) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const lines = new Set(
      Array.from(range.getClientRects())
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .map((rect) => Math.round(rect.top)),
    ).size;
    const box = range.getBoundingClientRect();
    const frame = (outer as Element).getBoundingClientRect();
    return {
      lines,
      clipped: element.scrollWidth > element.clientWidth + 0.5,
      outside:
        box.left < Math.max(frame.left, 0) - 0.5 ||
        box.right > Math.min(frame.right, window.innerWidth) + 0.5 ||
        box.top < frame.top - 0.5 ||
        box.bottom > frame.bottom + 0.5,
    };
  }, await container.elementHandle());

const expectOneLineInside = async (text: Locator, container: Locator, what: string) => {
  expect(await fit(text, container), what).toEqual({ lines: 1, clipped: false, outside: false });
};

/** No text of the page, its title or its link titles calls the UI by an old name. */
const expectNoOldName = async (page: Page) => {
  expect(await page.title()).not.toMatch(OLD_UI_NAME);
  expect(await page.locator("body").innerText()).not.toMatch(OLD_UI_NAME);
  for (const meta of await page.locator("meta[content]").all()) {
    expect(await meta.getAttribute("content")).not.toMatch(OLD_UI_NAME);
  }
};

test("the UI is called Dreamcast DevTools: the document title, the home page, the About dialog and the status bar", async ({ page }, testInfo) => {
  for (const size of WINDOWS) {
    await test.step(`${size.width}x${size.height}`, async () => {
      await page.setViewportSize(size);

      // the document title, and the titles a shared link shows
      await gotoRoute(page, "/");
      await expect(page).toHaveTitle("Dreamcast DevTools");
      await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", "Dreamcast DevTools");
      await expect(page.locator('meta[name="twitter:title"]')).toHaveAttribute("content", "Dreamcast DevTools");

      // the home page's heading
      const heading = page.getByRole("heading", { name: "Welcome to Dreamcast DevTools", exact: true });
      await expect(heading).toBeVisible();
      await expectOneLineInside(heading, page.locator("body"), `the home page's heading at ${size.width} px`);
      await expectNoOldName(page);
      await saveScreenshot(page, testInfo, `ui-name-home-${size.width}`);

      // the About dialog's title
      await page.getByRole("button", { name: /^About\b/ }).click();
      const dialog = page.getByRole("dialog");
      const title = dialog.getByRole("heading", { name: "About Dreamcast DevTools", exact: true });
      await expect(title).toBeVisible();
      await expect(dialog).toContainText(/DevTools\s*3\.0\.0/);
      await expectOneLineInside(title, dialog, `the About dialog's title at ${size.width} px`);
      await expectNoOldName(page);
      // (the screenshot when the dialog has faded in)
      await expect(page.locator(".MuiDialog-container")).toHaveCSS("opacity", "1");
      await saveScreenshot(page, testInfo, `ui-name-about-${size.width}`);
      await dialog.getByRole("button", { name: "Close" }).click();
      await expect(dialog).toBeHidden();

      // the status bar of a workspace, beside the connection and the endpoint (below 1200 px
      // the side docks, and with them the device tree, are hidden)
      await gotoRoute(page, "/workspace/sh4-debugger");
      await expect(statusBar(page)).toContainText("Connection: connected");
      const name = statusBar(page).getByText(/^Dreamcast DevTools 3\.0\.0/);
      await expect(name).toBeVisible();
      await expect(statusBar(page)).toContainText(/Connection: connected.*Endpoint: ws:\/\/.*Dreamcast DevTools 3\.0\.0/);
      await expectOneLineInside(name, statusBar(page), `the status bar's name at ${size.width} px`);
      for (const other of [statusBar(page).getByText(/^Connection:/), statusBar(page).getByText(/^Endpoint:/)]) {
        await expectOneLineInside(other, statusBar(page), `the rest of the status bar at ${size.width} px`);
      }
      // the bar is one line high: its three parts side by side
      const tops = await Promise.all(
        [name, statusBar(page).getByText(/^Connection:/), statusBar(page).getByText(/^Endpoint:/)].map(async (part) => Math.round((await part.boundingBox())!.y)),
      );
      expect(new Set(tops).size, `the status bar at ${size.width} px`).toBe(1);
      await expectNoOldName(page);
      await saveScreenshot(page, testInfo, `ui-name-status-${size.width}`);
    });
  }
});

test("the documentation names the UI and the emulator it is for; no page of a tool calls the UI by an old name", async ({ page }) => {
  await gotoRoute(page, "/docs");
  await expect(page.getByRole("main")).toContainText("Dreamcast DevTools is the web debugger UI for nullDC 3.0.0, the Dreamcast emulator.");
  await expectNoOldName(page);

  for (const [route, shown] of [
    ["/tool/sh4-sim", page.locator(".monaco-editor").first()],
    ["/tool/dsp-playground", page.getByRole("button", { name: "Start DSP" })],
    ["/tool/holly-core-log-analyzer", page.getByText("Drop your refsw2 log here")],
    ["/tool/holly-ta-log-analyzer", page.getByText("This view is under consideration.")],
  ] as const) {
    await gotoRoute(page, route);
    await expect(shown, route).toBeVisible();
    await expect(page, route).toHaveTitle("Dreamcast DevTools");
    await expectNoOldName(page);
  }
});

test("where the UI names the emulator it says what the emulator calls itself: nullDC (mock)", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  await page.getByRole("button", { name: "About", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(/Emulator\s*nullDC \(mock\)/);
  await expect(dialog.getByRole("heading", { name: "About Dreamcast DevTools", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();

  await statusBar(page).getByText(/^Endpoint:/).click();
  const picker = page.getByRole("dialog");
  await expect(picker.getByRole("radio", { name: /^nullDC \(mock\) @ 127\.0\.0\.1:\d+/ })).toBeChecked();
});
