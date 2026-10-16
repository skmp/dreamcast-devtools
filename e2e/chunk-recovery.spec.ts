import {
  test,
  expect,
  addPanelFromSelector,
  disassemblyRows,
  gotoRoute,
  openWorkspace,
  panel,
  saveScreenshot,
  statusBar,
  KNOWN,
  type Diagnostics,
} from "./support/fixtures";
import type { Locator, Page } from "@playwright/test";
import { startMockServer } from "./support/mockServer";
import { expectMonacoReady, monacoEditor, monacoTokenClasses } from "./support/monaco";

// Pages, some panels and the About dialog are downloaded when they are first shown. The
// server is the emulator: it can be closed and started again while the tab stays open, so
// such a download can fail. The browser does not ask again for a module that failed to
// load, so what failed offers "Reload page", and that button has to bring it back.

const failure = (scope: Page | Locator): Locator => scope.locator("[data-error-boundary]");
const reloadPage = (scope: Page | Locator): Locator => scope.getByRole("button", { name: "Reload page" });
const homeHeading = (page: Page) => page.getByRole("heading", { name: "Welcome to Dreamcast DevTools" });
const NO_ANSWER = "The server does not answer, so the page was not reloaded.";

interface Marked {
  __sameDocument?: boolean;
}

/** Marks the document, to tell later whether the page was reloaded. */
const markDocument = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as Marked).__sameDocument = true;
  });
const isSameDocument = (page: Page) => page.evaluate(() => (window as unknown as Marked).__sameDocument === true);

/**
 * The DSP disassembly view lists what the server has: 64 lines from where it opened (around
 * the step the DSP is at), or fewer near the last of the DSP's 128 steps.
 */
const expectDspListing = async (page: Page) => {
  const lines = disassemblyRows(panel(page, "dsp-disassembly"));
  await expect(lines.first()).toBeVisible();
  await expect(lines).toHaveCount(Math.min(64, 128 - Number(await lines.first().getAttribute("data-address"))));
};

/** Clicks a button that reloads the page and waits for the new document. */
const clickAndWaitForReload = async (page: Page, button: Locator) => {
  await markDocument(page);
  // without a timeout of its own, a button that does not reload would only fail with the test's timeout
  await Promise.all([page.waitForEvent("load", { timeout: 15_000 }), button.click()]);
  expect(await isSameDocument(page)).toBe(false);
};

/** Refuses the download of one chunk, as a server that is down does. Returns the function that lets it through again. */
const refuseChunk = async (page: Page, diagnostics: Diagnostics, name: string) => {
  const url = new RegExp(`/assets/${name}-[\\w-]+\\.js$`);
  await page.route(url, (route) => route.abort("connectionrefused"));
  diagnostics.allow(
    new RegExp(`^requestfailed: GET \\S+/assets/${name}-[\\w-]+\\.js net::ERR_CONNECTION_REFUSED`),
    `the test refuses the ${name} chunk`,
  );
  diagnostics.allow(/^console\.error: Failed to load resource: net::ERR_CONNECTION_REFUSED/, "Chromium logs the refused download");
  diagnostics.allow(
    new RegExp(`^console\\.error: TypeError: Failed to fetch dynamically imported module: \\S+/assets/${name}-`),
    "React logs the failed import that was caught",
  );
  return () => page.unroute(url);
};

const allowServerDown = (diagnostics: Diagnostics) => {
  diagnostics.allow(/^requestfailed: GET \S+ net::ERR_CONNECTION_REFUSED/, "the server is down on purpose");
  diagnostics.allow(/^console\.error: Failed to load resource: net::ERR_CONNECTION_REFUSED/, "the server is down on purpose");
  diagnostics.allow(
    /^console\.error: (TypeError: Failed to fetch dynamically imported module|Error: Unable to preload CSS)/,
    "React logs the failed import that was caught",
  );
  diagnostics.allow(/^console\.error: WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/ws' failed/, "the server is down on purpose");
};

test("a panel whose code could not be downloaded offers Reload page, which loads it", async ({ page, diagnostics }, testInfo) => {
  diagnostics.allow(...KNOWN.sgcNoData);
  const release = await refuseChunk(page, diagnostics, "AudioPanel");
  await gotoRoute(page, "/workspace/audio-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");

  const sgc = panel(page, "sgc");
  const alert = failure(sgc);
  await expect(alert.getByRole("heading", { name: "The SGC panel failed" })).toBeVisible();
  await expect(alert).toContainText(/TypeError: Failed to fetch dynamically imported module: \S+\/assets\/AudioPanel-/);
  await expect(alert).toContainText("The code of this panel could not be downloaded.");
  // remounting the panel cannot help, so that is not offered
  await expect(reloadPage(alert)).toBeVisible();
  await expect(alert.getByRole("button", { name: "Reload panel" })).toHaveCount(0);
  // only that panel is affected
  await expect(failure(page)).toHaveCount(1);
  await expectDspListing(page);
  await saveScreenshot(page, testInfo, "chunk-recovery-panel-failed");

  // while the download keeps failing, a reload ends where it started
  await clickAndWaitForReload(page, reloadPage(alert));
  await expect(alert.getByRole("heading", { name: "The SGC panel failed" })).toBeVisible();
  await expect(statusBar(page)).toContainText("Connection: connected");

  await release();
  await clickAndWaitForReload(page, reloadPage(alert));
  await expect(sgc).toContainText("Record some data to display here");
  await expect(statusBar(page)).toContainText("Connection: connected");
  await expectDspListing(page);
  await expect(failure(page)).toHaveCount(0);
});

test("a page whose code could not be downloaded offers Reload page, which loads it", async ({ page, diagnostics }, testInfo) => {
  const release = await refuseChunk(page, diagnostics, "DocsPage");
  await gotoRoute(page, "/");
  await page.getByRole("button", { name: /^Documentation\b/ }).click();

  const alert = failure(page);
  await expect(alert.getByRole("heading", { name: "The Documentation page failed" })).toBeVisible();
  await expect(alert).toContainText(/TypeError: Failed to fetch dynamically imported module: \S+\/assets\/DocsPage-/);
  await expect(alert).toContainText("The code of this page could not be downloaded.");
  await saveScreenshot(page, testInfo, "chunk-recovery-page-failed");

  // the other pages work meanwhile; coming back shows the failure and the button again
  await page.goBack();
  await expect(homeHeading(page)).toBeVisible();
  await expect(failure(page)).toHaveCount(0);
  await page.getByRole("button", { name: /^Documentation\b/ }).click();
  await expect(alert.getByRole("heading", { name: "The Documentation page failed" })).toBeVisible();

  await clickAndWaitForReload(page, reloadPage(alert));
  await expect(alert.getByRole("heading", { name: "The Documentation page failed" })).toBeVisible();

  await release();
  await clickAndWaitForReload(page, reloadPage(alert));
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await expect(failure(page)).toHaveCount(0);
});

for (const { route, shows } of [
  { route: "/", shows: (page: Page) => homeHeading(page) },
  { route: "/docs", shows: (page: Page) => page.getByRole("heading", { name: "Overview", exact: true }) },
  { route: "/tool/holly-core-log-analyzer", shows: (page: Page) => page.getByText("Drop your refsw2 log here") },
]) {
  test(`${route}: an About dialog whose code could not be downloaded leaves the page alone and opens after Reload page`, async ({
    page,
    diagnostics,
  }, testInfo) => {
    const release = await refuseChunk(page, diagnostics, "AboutDialog");
    await gotoRoute(page, route);
    await expect(shows(page)).toBeVisible();
    const about = page.getByRole("button", { name: route === "/" ? /^About\b/ : "About", exact: route !== "/" });
    const notice = page.locator("[data-about-failure]");

    await about.click();
    await expect(notice).toHaveAttribute("role", "alert");
    await expect(notice).toContainText("The About dialog could not be opened");
    await expect(notice).toContainText(/TypeError: Failed to fetch dynamically imported module: \S+\/assets\/AboutDialog-/);
    await expect(notice).toContainText("Its code could not be downloaded.");
    // the page is still there, and the dialog is closed: its ?about=1 is gone from the URL
    await expect(shows(page)).toBeVisible();
    await expect(failure(page)).toHaveCount(0);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).not.toHaveURL(/about=/);
    await saveScreenshot(page, testInfo, `chunk-recovery-about${route.replace(/\W+/g, "-").replace(/-$/, "")}`);

    // the notice can be dismissed, and asking for the dialog again shows it again
    await notice.getByRole("button", { name: "Dismiss" }).click();
    await expect(notice).toHaveCount(0);
    await about.click();
    await expect(notice).toContainText("The About dialog could not be opened");
    await expect(shows(page)).toBeVisible();
    await expect(failure(page)).toHaveCount(0);
    await expect(page).not.toHaveURL(/about=/);

    await release();
    await clickAndWaitForReload(page, reloadPage(notice));
    await expect(shows(page)).toBeVisible();
    await expect(notice).toHaveCount(0);
    await about.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "About Dreamcast DevTools" })).toBeVisible();
    await expect(page).toHaveURL(/\?about=1$/);
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
    await expect(shows(page)).toBeVisible();
    await expect(failure(page)).toHaveCount(0);
  });
}

test("a panel first opened while the server is down is loaded by Reload page once the server is back", async ({
  page,
  mock,
  diagnostics,
}, testInfo) => {
  allowServerDown(diagnostics);
  diagnostics.allow(...KNOWN.sgcNoData);
  await openWorkspace(page, "sh4-debugger");
  await expect(panel(page, "watches")).toContainText("dc.sh4.cpu.pc = 0x8C0000");

  // --- the emulator is closed; the SGC panel was never shown in this tab ---
  await mock.stop("SIGKILL");
  await expect(statusBar(page)).toContainText("Connection: reconnecting");
  await addPanelFromSelector(page, 1, "SGC");
  const sgc = panel(page, "sgc");
  const alert = failure(sgc);
  await expect(alert.getByRole("heading", { name: "The SGC panel failed" })).toBeVisible();
  await expect(alert).toContainText("The code of this panel could not be downloaded.");

  // a reload now would replace the application with the browser's error page, so it is not done
  await markDocument(page);
  await reloadPage(alert).click();
  await expect(alert.getByRole("status")).toHaveText(NO_ANSWER);
  await expect(reloadPage(alert)).toBeEnabled();
  expect(await isSameDocument(page)).toBe(true);
  // the other panels are as they were: without a connection, they have no data
  await expect(panel(page, "watches")).toContainText("Not connected");
  await expect(panel(page, "watches").getByRole("button", { name: "Add Watch" })).toBeVisible();
  await expect(failure(page)).toHaveCount(1);
  await saveScreenshot(page, testInfo, "chunk-recovery-server-down-panel");

  // --- the emulator is started again on the same port ---
  const restarted = await startMockServer({ port: mock.port });
  try {
    await clickAndWaitForReload(page, reloadPage(alert));
    await expect(statusBar(page)).toContainText("Connection: connected");
    // the dock layout was saved with the new panel in it
    await expect(sgc).toContainText("Record some data to display here");
    await expect(panel(page, "watches")).toContainText("dc.sh4.cpu.pc = 0x8C0000");
    await expect(failure(page)).toHaveCount(0);
  } finally {
    await restarted.stop();
  }
});

test("a page first opened while the server is down is loaded by Reload page once the server is back", async ({
  page,
  mock,
  diagnostics,
}, testInfo) => {
  allowServerDown(diagnostics);
  await gotoRoute(page, "/");
  await expect(homeHeading(page)).toBeVisible();
  await page.waitForLoadState("networkidle");

  // --- the emulator is closed; neither the About dialog nor the simulator (and Monaco with its style sheet) was
  // opened in this tab before ---
  await mock.stop("SIGKILL");
  await page.getByRole("button", { name: /^About\b/ }).click();
  const notice = page.locator("[data-about-failure]");
  await expect(notice).toContainText("The About dialog could not be opened");
  await expect(homeHeading(page)).toBeVisible();
  await expect(failure(page)).toHaveCount(0);
  await reloadPage(notice).click();
  await expect(notice.getByRole("status")).toHaveText(NO_ANSWER);
  await expect(homeHeading(page)).toBeVisible();
  await notice.getByRole("button", { name: "Dismiss" }).click();
  await expect(notice).toHaveCount(0);

  await page.getByRole("button", { name: /^SH4 Simulator\b/ }).click();
  const alert = failure(page);
  await expect(alert.getByRole("heading", { name: "The SH4 Simulator page failed" })).toBeVisible();
  await expect(alert).toContainText(/Unable to preload CSS|Failed to fetch dynamically imported module/);
  await expect(alert).toContainText("The code of this page could not be downloaded.");

  await markDocument(page);
  await reloadPage(alert).click();
  await expect(alert.getByRole("status")).toHaveText(NO_ANSWER);
  expect(await isSameDocument(page)).toBe(true);
  await saveScreenshot(page, testInfo, "chunk-recovery-server-down-page");
  // the pages that are already loaded keep working
  await page.goBack();
  await expect(homeHeading(page)).toBeVisible();
  await page.goForward();
  await expect(alert.getByRole("heading", { name: "The SH4 Simulator page failed" })).toBeVisible();

  // --- the emulator is started again on the same port ---
  const restarted = await startMockServer({ port: mock.port });
  try {
    await clickAndWaitForReload(page, reloadPage(alert));
    await expectMonacoReady(monacoEditor(page));
    await expect.poll(async () => (await monacoTokenClasses(monacoEditor(page))).length).toBeGreaterThanOrEqual(3);
    await expect(page.getByRole("heading", { name: /serial execution/ })).toBeVisible();
    // Monaco is laid out by its style sheet
    await expect(monacoEditor(page).locator(".view-line").first()).toHaveCSS("position", "absolute");
    await expect(failure(page)).toHaveCount(0);
  } finally {
    await restarted.stop();
  }
});
