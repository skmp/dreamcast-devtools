import { test, expect, gotoRoute, openWorkspace, panel, addPanelFromSelector, KNOWN } from "./support/fixtures";

test("About on the home page shows the DevTools version and asks for a connection", async ({ page }) => {
  await gotoRoute(page, "/");
  await page.getByRole("button", { name: /^About\b/ }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "About nullDC DevTools" })).toBeVisible();
  await expect(dialog).toContainText(/DevTools\s*3\.0\.0/);
  await expect(dialog).toContainText("Connect to the debugger to view emulator details.");
  await expect(dialog).toContainText("Connection state: idle");
  // the dialog is part of the URL, so it can be linked and closed with Back
  await expect(page).toHaveURL(/#\/\?about=1$/);

  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/#\/$/);

  await page.getByRole("button", { name: /^About\b/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("About in a workspace shows what the emulator reported in debugger.describe", async ({ page, rpc }) => {
  await openWorkspace(page, "sh4-debugger");
  await page.getByRole("button", { name: "About", exact: true }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(/Emulator\s*mockServer/);
  await expect(dialog).toContainText(/Version\s*unspecified/);
  await expect(dialog).toContainText(/Build\s*native/);
  await expect(dialog).toContainText("Connection state: connected");
  await expect(dialog).toContainText(/DevTools\s*3\.0\.0/);
  // the dialog asks again instead of using the describe result of the session
  expect(rpc.requests("debugger.describe")).toHaveLength(2);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/#\/workspace\/sh4-debugger$/);
});

test("the About button exists on every tool page and on the docs page", async ({ page, diagnostics }) => {
  diagnostics.allow(...KNOWN.monacoCdn);
  for (const route of [
    "/docs",
    "/tool/sh4-sim",
    "/tool/dsp-playground",
    "/tool/holly-core-log-analyzer",
    "/tool/holly-ta-log-analyzer",
  ]) {
    await gotoRoute(page, route);
    await page.getByRole("button", { name: "About", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("heading", { name: "About nullDC DevTools" })).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
  }
});

test("the docs page describes scripts that exist in package.json", async ({ page }) => {
  await gotoRoute(page, "/docs");
  const text = await page.getByRole("main").innerText();
  const { default: packageJson } = await import("../package.json", { with: { type: "json" } });
  const scripts = Object.keys(packageJson.scripts);
  const mentioned = [...text.matchAll(/`npm run ([a-z0-9:]+)`/g)].map((match) => match[1]);
  expect(mentioned.length).toBeGreaterThanOrEqual(5);
  for (const script of mentioned) {
    expect(scripts, `the docs mention \`npm run ${script}\``).toContain(script);
  }
  await expect(page.getByRole("contentinfo")).toContainText("README");
});

test("the Documentation panel shows the same sections as the docs page", async ({ page }) => {
  await gotoRoute(page, "/docs");
  const pageHeadings = await page.getByRole("main").getByRole("heading").allInnerTexts();
  expect(pageHeadings).toEqual(
    expect.arrayContaining(["Overview", "Getting Started", "Launching the UI", "Workspaces & Tools", "Breakpoints", "Protocol"]),
  );

  await openWorkspace(page, "sh4-debugger");
  await addPanelFromSelector(page, 1, "Documentation");
  await expect(panel(page, "documentation").getByRole("heading", { name: "Overview" })).toBeVisible();
  expect(await panel(page, "documentation").getByRole("heading").allInnerTexts()).toEqual(pageHeadings);
});
