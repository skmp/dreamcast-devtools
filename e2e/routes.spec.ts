import { test, expect, gotoRoute, openWorkspace, panel, saveScreenshot, statusBar, WORKSPACES } from "./support/fixtures";

// Every route of src/App.tsx. The `page` fixture fails the test on any console.error,
// uncaught exception, failed request, HTTP >= 400 or request to another origin.

test("/ lists the four workspaces, the four tools, documentation and about", async ({ page }) => {
  await gotoRoute(page, "/");
  await expect(page.getByRole("heading", { name: "Welcome to Dreamcast DevTools" })).toBeVisible();
  for (const title of [
    "SH4 Debugger",
    "ARM7 Debugger",
    "Mixed Mode Debugger",
    "Audio Debugger",
    "SH4 Simulator",
    "TA Log Analyzer",
    "CORE Log Analyzer",
    "DSP Playground",
    "Documentation",
    "About",
  ]) {
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  }
  await page.waitForLoadState("networkidle");
});

test("home page cards navigate to their routes", async ({ page }) => {
  const cards: Array<[string, string]> = [
    ["SH4 Debugger", "#/workspace/sh4-debugger"],
    ["ARM7 Debugger", "#/workspace/arm7-debugger"],
    ["Mixed Mode Debugger", "#/workspace/mixed-mode-debugger"],
    ["SH4 Simulator", "#/tool/sh4-sim"],
    ["TA Log Analyzer", "#/tool/holly-ta-log-analyzer"],
    ["CORE Log Analyzer", "#/tool/holly-core-log-analyzer"],
    ["DSP Playground", "#/tool/dsp-playground"],
    ["Documentation", "#/docs"],
  ];
  for (const [title, hash] of cards) {
    await gotoRoute(page, "/");
    await page.getByRole("button", { name: new RegExp(`^${title}\\b`) }).click();
    await expect(page).toHaveURL(new RegExp(`${hash.replace(/[/#]/g, "\\$&")}$`));
  }
});

test("/docs renders the documentation sections", async ({ page }) => {
  await gotoRoute(page, "/docs");
  for (const title of ["Overview", "Getting Started", "Workspaces & Tools", "Protocol"]) {
    await expect(page.getByRole("heading", { name: title, exact: true, level: 1 })).toBeVisible();
  }
  await expect(page.getByText("npm run mock:serve", { exact: false }).first()).toBeVisible();
  await page.waitForLoadState("networkidle");
});

for (const workspace of WORKSPACES) {
  test(`/workspace/${workspace} loads, connects and renders its docks`, async ({ page }, testInfo) => {
    await openWorkspace(page, workspace);
    await expect(statusBar(page)).toContainText(/Dreamcast DevTools 3\.0\.0/);
    await expect(panel(page, "device-tree")).toBeVisible();
    await expect(panel(page, "watches")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await saveScreenshot(page, testInfo, `workspace-${workspace}`);
  });
}

test("/tool/sh4-sim loads the simulator", async ({ page }, testInfo) => {
  await gotoRoute(page, "/tool/sh4-sim");
  await expect(page.getByRole("button", { name: "Share" })).toBeVisible();
  await expect(page.locator(".monaco-editor").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: /serial execution/ })).toBeVisible();
  await page.waitForLoadState("networkidle");
  await saveScreenshot(page, testInfo, "tool-sh4-sim");
});

test("/tool/dsp-playground loads the playground", async ({ page }, testInfo) => {
  await gotoRoute(page, "/tool/dsp-playground");
  await expect(page.getByRole("button", { name: "Start DSP" })).toBeVisible();
  await expect(page.locator(".monaco-editor").first()).toBeVisible();
  await page.waitForLoadState("networkidle");
  await saveScreenshot(page, testInfo, "tool-dsp-playground");
});

test("/tool/holly-core-log-analyzer shows the empty drop zone", async ({ page }, testInfo) => {
  await gotoRoute(page, "/tool/holly-core-log-analyzer");
  await expect(page.getByText("Drop your refsw2 log here")).toBeVisible();
  await expect(page.getByText("Choose File")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await saveScreenshot(page, testInfo, "tool-core-log-analyzer");
});

test("/tool/holly-ta-log-analyzer is a placeholder", async ({ page }) => {
  await gotoRoute(page, "/tool/holly-ta-log-analyzer");
  await expect(page.getByText("This view is under consideration.")).toBeVisible();
  await page.waitForLoadState("networkidle");
});

test("an unknown route redirects to the home page", async ({ page }) => {
  await gotoRoute(page, "/no/such/route");
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByRole("heading", { name: "Welcome to Dreamcast DevTools" })).toBeVisible();
});

test("the navigation dropdown switches between workspaces, tools and pages", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  const navigate = page.getByPlaceholder("Navigate to...");
  await expect(navigate).toHaveValue("SH4 Debugger");

  await navigate.click();
  await page.getByRole("option", { name: "ARM7 Debugger" }).click();
  await expect(page).toHaveURL(/#\/workspace\/arm7-debugger$/);
  await expect(panel(page, "arm7-disassembly")).toBeVisible();
  // the session survives the switch: no reconnect, the new workspace is populated
  await expect(statusBar(page)).toContainText("Connection: connected");
  // (the target runs, and a running target has no callstack)
  await expect(panel(page, "arm7-callstack")).toContainText("Empty callstack.");
  // (the view opens around the ARM7's program counter, which is in the mock's loop at 0x00200010)
  await expect(panel(page, "arm7-disassembly")).toContainText("0x00200010");

  await page.getByPlaceholder("Navigate to...").click();
  await page.getByRole("option", { name: "Documentation" }).click();
  await expect(page).toHaveURL(/#\/docs$/);
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();

  await page.getByPlaceholder("Navigate to...").click();
  await page.getByRole("option", { name: "Home" }).click();
  await expect(page).toHaveURL(/#\/$/);
});

test("the theme switch toggles dark and light mode and the choice survives a reload", async ({ page }) => {
  await openWorkspace(page, "sh4-debugger");
  // regression: the name was passed through the deprecated `inputProps`, which the MUI 7
  // Switch does not forward, so the <input role="switch"> had no accessible name
  const toggle = page.getByRole("switch", { name: "Toggle dark mode" });
  await expect(toggle).toBeChecked();
  const darkBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(darkBackground);

  await page.reload();
  await expect(page.getByRole("switch", { name: "Toggle dark mode" })).not.toBeChecked();
});
