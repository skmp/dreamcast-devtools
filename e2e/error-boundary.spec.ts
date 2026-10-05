import {
  test,
  expect,
  currentInstructionAddress,
  disassemblyRows,
  panel,
  pauseFromToolbar,
  registerRow,
  saveScreenshot,
  statusBar,
  tooltipButton,
  treeItemRow,
  type Diagnostics,
} from "./support/fixtures";
import type { Locator, Page } from "@playwright/test";

// The crash-test hook (src/app/components/CrashProbe.tsx) only exists when the page is
// loaded with ?crashTest. It makes the boundary with the given id see an exception thrown
// by one of its children, while rendering or from an effect.
const crash = (page: Page, target: string, phase: "render" | "effect") =>
  page.evaluate(
    (detail) => {
      window.dispatchEvent(new CustomEvent("nulldc:crash-test", { detail }));
    },
    { target, phase },
  );

const expectCrashLogged = (diagnostics: Diagnostics) =>
  // React reports an error caught by a boundary with console.error
  diagnostics.allow(/^console\.error: Error: crash test: /, "React logs the exception the test injected");

const openWorkspaceWithCrashTest = async (page: Page, workspace: string) => {
  await page.goto(`/?crashTest#/workspace/${workspace}`);
  await expect(statusBar(page)).toContainText("Connection: connected");
  await expect(panel(page, "device-tree").getByRole("treeitem").first()).toBeVisible();
};

const failure = (scope: Page | Locator): Locator => scope.locator("[data-error-boundary]");

for (const phase of ["render", "effect"] as const) {
  test(`an exception while a panel ${phase === "render" ? "renders" : "runs an effect"} is shown in that panel and nowhere else`, async ({
    page,
    diagnostics,
  }, testInfo) => {
    expectCrashLogged(diagnostics);
    await openWorkspaceWithCrashTest(page, "sh4-debugger");
    const watches = panel(page, "watches");
    await expect(watches).toContainText("dc.sh4.cpu.pc = 0x8C0000");

    await crash(page, "panel:watches", phase);

    // the panel shows what happened ...
    const alert = failure(watches);
    await expect(alert).toHaveAttribute("role", "alert");
    await expect(alert.getByRole("heading", { name: "The Watches panel failed" })).toBeVisible();
    await expect(alert).toContainText(`Error: crash test: ${phase} (panel:watches)`);
    await expect(watches.getByPlaceholder("Enter expression")).toHaveCount(0);
    // ... with the component stack in a <details>
    const details = alert.locator("details");
    await expect(details.locator("summary")).toHaveText("Component stack");
    await expect(details).not.toHaveAttribute("open", "");
    await details.locator("summary").click();
    await expect(details.locator("pre")).toBeVisible();
    await expect(details.locator("pre")).toHaveText(/\bat \S+/);
    await expect(alert.getByRole("button", { name: "Reload panel" })).toBeVisible();
    await saveScreenshot(page, testInfo, `error-boundary-panel-${phase}`);

    // ... and it is the only thing that stopped
    await expect(failure(page)).toHaveCount(1);
    await expect(statusBar(page)).toContainText("Connection: connected");
    for (const id of ["device-tree", "sh4-disassembly", "sh4-memory", "sh4-breakpoints", "sh4-callstack"]) {
      await expect(panel(page, id)).toBeVisible();
      await expect(failure(panel(page, id))).toHaveCount(0);
    }
    // the rest of the workspace still follows the server
    await treeItemRow(page, "dc.sh4.cpu").click();
    await pauseFromToolbar(page);
    const disassembly = panel(page, "sh4-disassembly");
    const pc = await currentInstructionAddress(disassembly);
    await tooltipButton(disassembly, "Step In").click();
    const next = 0x8c0000a0 + ((pc - 0x8c0000a0 + 2) % 16);
    await expect(disassembly.locator(".current-instruction")).toHaveAttribute("data-address", String(next));
    await expect(registerRow(page, "dc.sh4.cpu.reg.PC")).toHaveText(`PC = 0x${next.toString(16).toUpperCase()}`);
    await expect(panel(page, "sh4-callstack").getByRole("listitem").first()).toContainText(
      `0x${next.toString(16).toUpperCase()}`,
    );
    // including the watch the failed panel would show: the device tree can still add one
    await tooltipButton(registerRow(page, "dc.sh4.cpu.reg.PR"), "Add to watch").click();
    await expect(tooltipButton(registerRow(page, "dc.sh4.cpu.reg.PR"), "Already in watch")).toBeDisabled();

    // Reload panel mounts the panel again, with current data
    await alert.getByRole("button", { name: "Reload panel" }).click();
    await expect(failure(page)).toHaveCount(0);
    await expect(watches).toContainText(`dc.sh4.cpu.pc = 0x${next.toString(16).toUpperCase()}`);
    await expect(watches).toContainText("dc.sh4.cpu.pr = 0x8C00");
    const input = watches.getByPlaceholder("Enter expression");
    await input.fill("dc.aica.arm7.pc");
    await input.press("Enter");
    // the watch the server started with, PR from the device tree, and this one
    await expect(watches.getByRole("listitem")).toHaveCount(3);
  });
}

test("panels fail and recover independently of each other", async ({ page, diagnostics }) => {
  expectCrashLogged(diagnostics);
  await openWorkspaceWithCrashTest(page, "sh4-debugger");

  await crash(page, "panel:sh4-disassembly", "effect");
  await crash(page, "panel:device-tree", "render");
  await expect(failure(panel(page, "sh4-disassembly"))).toContainText("crash test: effect (panel:sh4-disassembly)");
  await expect(failure(panel(page, "device-tree"))).toContainText("crash test: render (panel:device-tree)");
  await expect(failure(page)).toHaveCount(2);
  await expect(panel(page, "sh4-memory")).toContainText("0x8C010000");
  await expect(panel(page, "watches")).toContainText("dc.sh4.cpu.pc");

  await failure(panel(page, "sh4-disassembly")).getByRole("button", { name: "Reload panel" }).click();
  await expect(disassemblyRows(panel(page, "sh4-disassembly"))).toHaveCount(64);
  await expect(failure(panel(page, "device-tree"))).toBeVisible();
  await expect(failure(page)).toHaveCount(1);

  await failure(panel(page, "device-tree")).getByRole("button", { name: "Reload panel" }).click();
  await expect(panel(page, "device-tree")).toContainText("SYSCLK = 200MHz");
  await expect(failure(page)).toHaveCount(0);

  // a panel can fail again after a reload
  await crash(page, "panel:sh4-disassembly", "render");
  await expect(failure(panel(page, "sh4-disassembly"))).toContainText("crash test: render (panel:sh4-disassembly)");
});

test("an exception outside the dock panels replaces the workspace page and Reload page brings it back", async ({
  page,
  diagnostics,
}) => {
  expectCrashLogged(diagnostics);
  await openWorkspaceWithCrashTest(page, "sh4-debugger");

  await crash(page, "route:workspace", "render");
  const alert = failure(page);
  await expect(alert.getByRole("heading", { name: "The SH4 Debugger page failed" })).toBeVisible();
  await expect(alert).toContainText("Error: crash test: render (route:workspace)");
  await expect(alert.locator("details summary")).toHaveText("Component stack");
  await expect(page.locator("[data-panel-id]")).toHaveCount(0);

  await alert.getByRole("button", { name: "Reload page" }).click();
  await expect(failure(page)).toHaveCount(0);
  await expect(statusBar(page)).toContainText("Connection: connected");
  await expect(panel(page, "watches")).toContainText("dc.sh4.cpu.pc = 0x8C0000");
  await expect(disassemblyRows(panel(page, "sh4-disassembly"))).toHaveCount(64);
});

test("a failed page does not block navigation", async ({ page, diagnostics }) => {
  expectCrashLogged(diagnostics);
  await page.goto("/?crashTest#/docs");
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();

  await crash(page, "route:docs", "effect");
  await expect(failure(page).getByRole("heading", { name: "The Documentation page failed" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toHaveCount(0);

  // leaving the route dismisses the error; the other pages work
  await page.evaluate(() => {
    window.location.hash = "#/";
  });
  await expect(page.getByRole("heading", { name: "Welcome to the nullDC DevTools" })).toBeVisible();
  await expect(failure(page)).toHaveCount(0);

  await page.getByRole("button", { name: /^Documentation\b/ }).click();
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await expect(failure(page)).toHaveCount(0);
});

test("without ?crashTest the crash-test hook does not exist", async ({ page }) => {
  await page.goto("/#/workspace/sh4-debugger");
  await expect(statusBar(page)).toContainText("Connection: connected");
  await expect(panel(page, "watches")).toContainText("dc.sh4.cpu.pc");

  await crash(page, "panel:watches", "render");
  await crash(page, "route:workspace", "render");
  await page.waitForTimeout(500);
  await expect(failure(page)).toHaveCount(0);
  await expect(panel(page, "watches")).toContainText("dc.sh4.cpu.pc");
});
