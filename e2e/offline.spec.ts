import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect, gotoRoute, openWorkspace, panel, statusBar, KNOWN, WORKSPACES } from "./support/fixtures";
import { expectMonacoReady, monacoEditor, monacoTokenClasses, monacoVisibleText } from "./support/monaco";
import { DIST_DIR } from "./support/paths";
import { startStaticServer } from "./support/staticServer";
import type { Page } from "@playwright/test";

// The built UI is served by the emulator and must work on a machine without internet:
// it may not ask any other origin for anything (it used to download Monaco from a CDN).

/** Aborts every request that does not go to this machine and records it. */
const blockOtherOrigins = async (page: Page) => {
  const attempted: string[] = [];
  await page.route("**/*", async (route) => {
    const { hostname } = new URL(route.request().url());
    if (hostname === "127.0.0.1" || hostname === "localhost") {
      await route.continue();
    } else {
      attempted.push(route.request().url());
      await route.abort("internetdisconnected");
    }
  });
  return attempted;
};

const typeAtEnd = async (page: Page, text: string) => {
  await monacoEditor(page).click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(text);
};

test.describe("with every other origin unreachable", () => {
  test("the SH4 simulator editor loads, highlights and accepts typing", async ({ page }) => {
    const attempted = await blockOtherOrigins(page);
    await gotoRoute(page, "/tool/sh4-sim");
    const editor = monacoEditor(page);
    await expectMonacoReady(editor);

    expect(await monacoVisibleText(editor)).toContain("SHAD R0,R1");
    await expect.poll(async () => (await monacoTokenClasses(editor)).length).toBeGreaterThanOrEqual(3);

    await typeAtEnd(page, "\n# typed offline\nADD R1,R2\n");
    await expect(page.getByRole("heading", { name: "typed offline" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "00000000 add r1,r2" })).toBeVisible();

    expect(attempted).toEqual([]);
  });

  test("the DSP source and assembly editors load, highlight and accept typing", async ({ page }) => {
    const attempted = await blockOtherOrigins(page);
    await gotoRoute(page, "/tool/dsp-playground");
    const status = page.locator(".monaco-editor").first().locator("xpath=../../following-sibling::div");

    // DSP source (Compiler tab)
    await expectMonacoReady(monacoEditor(page));
    expect(await monacoVisibleText(monacoEditor(page))).toContain("#define mLSAME 0");
    await expect.poll(async () => (await monacoTokenClasses(monacoEditor(page))).length).toBeGreaterThanOrEqual(3);
    await expect(status).toHaveText("Compiled");
    await monacoEditor(page).click();
    await page.keyboard.press("ControlOrMeta+Home");
    await page.keyboard.insertText("// typed offline\n");
    await expect.poll(() => monacoVisibleText(monacoEditor(page))).toContain("// typed offline");
    await expect(status).toHaveText("Compiled");

    // DSP assembly, read-only (Compiled tab)
    await page.getByRole("tab", { name: "Compiled" }).click();
    await expect.poll(() => monacoVisibleText(monacoEditor(page))).toContain("MADRS[0]    = 0x1950");
    await expect.poll(async () => (await monacoTokenClasses(monacoEditor(page))).length).toBeGreaterThanOrEqual(3);

    // DSP assembly (Assembler tab)
    await page.getByRole("tab", { name: "Assembler" }).click();
    await expect.poll(() => monacoVisibleText(monacoEditor(page))).toContain("# Simple delay using the RBL/RBP");
    await expect.poll(async () => (await monacoTokenClasses(monacoEditor(page))).length).toBeGreaterThanOrEqual(3);
    await monacoEditor(page).click();
    await page.keyboard.press("ControlOrMeta+Home");
    await page.keyboard.insertText("COEF[9] = 123\n");
    await expect.poll(() => monacoVisibleText(monacoEditor(page))).toContain("COEF[9] = 123");
    await expect(status).toHaveText("Assembled");

    expect(attempted).toEqual([]);
  });

  test("Monaco's worker and icon font come from the server that served the page", async ({ page, mock }) => {
    const attempted = await blockOtherOrigins(page);
    const fonts: Array<{ url: string; status: number }> = [];
    page.on("response", (response) => {
      if (/\.ttf$/.test(new URL(response.url()).pathname)) {
        fonts.push({ url: response.url(), status: response.status() });
      }
    });
    await gotoRoute(page, "/tool/sh4-sim");
    await expectMonacoReady(monacoEditor(page));

    // the editor worker is started on demand (word completion, here): typing needs it
    await typeAtEnd(page, "\nNOP");
    await expect
      .poll(() => page.workers().map((worker) => worker.url()))
      .toContainEqual(expect.stringMatching(new RegExp(`^${mock.baseURL}/assets/editor\\.worker-[\\w-]+\\.js$`)));

    // the find widget draws its buttons with the codicon font
    await monacoEditor(page).click();
    await page.keyboard.press("ControlOrMeta+F");
    await expect(page.locator(".find-widget.visible")).toBeVisible();
    await expect
      .poll(() => fonts)
      .toContainEqual({ url: expect.stringMatching(new RegExp(`^${mock.baseURL}/assets/codicon-[\\w-]+\\.ttf$`)), status: 200 });
    await expect
      .poll(() => page.evaluate(() => [...document.fonts].some((font) => font.family.includes("codicon") && font.status === "loaded")))
      .toBe(true);

    expect(attempted).toEqual([]);
  });

  test("no page of the application asks another origin for anything", async ({ page, diagnostics, rpc, mock }) => {
    test.slow();
    diagnostics.allow(...KNOWN.sgcNoData);
    const attempted = await blockOtherOrigins(page);

    await gotoRoute(page, "/");
    await expect(page.getByRole("heading", { name: "Welcome to the nullDC DevTools" })).toBeVisible();
    await gotoRoute(page, "/docs");
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    for (const workspace of WORKSPACES) {
      await openWorkspace(page, workspace);
      await page.waitForLoadState("networkidle");
    }
    await gotoRoute(page, "/tool/sh4-sim");
    await expectMonacoReady(monacoEditor(page));
    await gotoRoute(page, "/tool/dsp-playground");
    await expectMonacoReady(monacoEditor(page));
    await gotoRoute(page, "/tool/holly-core-log-analyzer");
    await expect(page.getByText("Drop your refsw2 log here")).toBeVisible();
    await gotoRoute(page, "/tool/holly-ta-log-analyzer");
    await expect(page.getByText("This view is under consideration.")).toBeVisible();
    await page.waitForLoadState("networkidle");

    expect(attempted).toEqual([]);
    // and the only WebSocket is the debugger connection to the same server
    expect([...new Set(rpc.sockets)]).toEqual([mock.wsURL]);
  });
});

test("the home page loads without the workspace, tool and editor code", async ({ page, mock }) => {
  const scripts = new Map<string, number>();
  page.on("response", async (response) => {
    const { pathname } = new URL(response.url());
    if (pathname.endsWith(".js")) {
      scripts.set(pathname, (await response.body()).length);
    }
  });
  await gotoRoute(page, "/");
  await expect(page.getByRole("heading", { name: "Welcome to the nullDC DevTools" })).toBeVisible();
  await page.waitForLoadState("networkidle");

  const names = [...scripts.keys()];
  const total = [...scripts.values()].reduce((sum, size) => sum + size, 0);
  // the single bundle used to be 1,253 kB; the initial load must stay well below that
  expect(total, `initial JavaScript: ${names.join(", ")}`).toBeLessThan(500 * 1024);
  expect(names.filter((name) => /monaco|AppLayout|Playground|Sh4Sim|editor\.worker/.test(name))).toEqual([]);

  // a workspace then brings its own chunk, and still no editor
  await openWorkspace(page, "sh4-debugger");
  await page.waitForLoadState("networkidle");
  expect([...scripts.keys()].some((name) => /AppLayout/.test(name))).toBe(true);
  expect([...scripts.keys()].filter((name) => /monaco|editor\.worker/.test(name))).toEqual([]);

  // the editor arrives with the first page that shows one
  await gotoRoute(page, "/tool/sh4-sim");
  await expectMonacoReady(monacoEditor(page));
  expect([...scripts.keys()].some((name) => /monaco/.test(name))).toBe(true);
  expect(mock.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
});

test("index.html references its assets relatively", () => {
  const html = readFileSync(resolve(DIST_DIR, "index.html"), "utf8");
  const references = [...html.matchAll(/\s(?:src|href|content)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((value) => /\.(js|css|png|ico|svg|wasm|ttf)$/.test(value));
  expect(references.length).toBeGreaterThanOrEqual(3);
  for (const reference of references) {
    expect(reference, "no absolute path and no other origin").toMatch(/^(\.\/)?[\w.-]+(\/[\w.-]+)*$/);
  }
});

test.describe("served as plain files from a sub-path (python3 -m http.server)", () => {
  test("the pages, the editors and the DSP module work, with the right content types", async ({ page, diagnostics }) => {
    test.slow();
    const server = await startStaticServer("ui");
    diagnostics.serveFrom(server.origin);
    const responses: Array<{ path: string; status: number; type: string }> = [];
    page.on("response", (response) => {
      responses.push({
        path: new URL(response.url()).pathname,
        status: response.status(),
        type: response.headers()["content-type"] ?? "",
      });
    });
    try {
      await page.goto(server.url);
      await expect(page.getByRole("heading", { name: "Welcome to the nullDC DevTools" })).toBeVisible();

      await page.goto(`${server.url}#/docs`);
      await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();

      // SH4 simulator: Monaco, its worker and its font
      await page.goto(`${server.url}#/tool/sh4-sim`);
      await expectMonacoReady(monacoEditor(page));
      await expect.poll(async () => (await monacoTokenClasses(monacoEditor(page))).length).toBeGreaterThanOrEqual(3);
      await expect(page.getByRole("heading", { name: /serial execution/ })).toBeVisible();
      await typeAtEnd(page, "\nNOP");
      await expect
        .poll(() => page.workers().map((worker) => new URL(worker.url()).pathname))
        .toContainEqual(expect.stringMatching(/^\/ui\/assets\/editor\.worker-[\w-]+\.js$/));
      await monacoEditor(page).click();
      await page.keyboard.press("ControlOrMeta+F");
      await expect(page.locator(".find-widget.visible")).toBeVisible();
      await expect.poll(() => responses.some((response) => response.path.endsWith(".ttf"))).toBe(true);

      // DSP playground: the WebAssembly module is instantiated from a streamed response,
      // which the browser only accepts as application/wasm
      await page.goto(`${server.url}#/tool/dsp-playground`);
      await expectMonacoReady(monacoEditor(page));
      await expect(page.locator(".monaco-editor").first().locator("xpath=../../following-sibling::div")).toHaveText(
        "Compiled",
      );

      await page.goto(`${server.url}#/tool/holly-core-log-analyzer`);
      await expect(page.getByText("Drop your refsw2 log here")).toBeVisible();

      // a workspace renders too; there is no debugger behind a file server, so it reports
      // the failed connection (and keeps trying) and shows empty panels
      diagnostics.allow(/^console\.error: WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/ws' failed/, "a file server has no /ws");
      await page.goto(`${server.url}#/workspace/sh4-debugger`);
      await expect(statusBar(page)).toContainText("Connection: reconnecting");
      await expect(page.getByRole("alert").filter({ hasText: "Could not connect to ws://127.0.0.1" })).toBeVisible();
      await expect(panel(page, "sh4-disassembly")).toContainText("Not connected");
      await expect(panel(page, "device-tree")).toContainText("Not connected");
      // the boxes and the toolbars are there all the same, for when a server is
      await expect(panel(page, "device-tree").getByPlaceholder("Search components...")).toBeVisible();
      await expect(panel(page, "watches").getByPlaceholder("Enter expression")).toBeVisible();
      await expect(panel(page, "sh4-disassembly").getByRole("button", { name: "Step In", exact: true })).toBeVisible();
      await expect(panel(page, "sh4-memory").getByRole("button", { name: "Refresh", exact: true })).toBeVisible();
      // A page that has had no server yet has every capability: no panel says that the server
      // lacks one. The callstack has no such note, and the SGC panel has its Record button.
      const callstack = panel(page, "sh4-callstack");
      await expect(callstack).toContainText("Not connected");
      await expect(callstack.getByRole("note")).toHaveCount(0);
      await expect(callstack).not.toContainText("This server has no callstack");
      await page.goto(`${server.url}#/workspace/audio-debugger`);
      await expect(statusBar(page)).toContainText("Connection: reconnecting");
      const sgc = panel(page, "sgc");
      await expect(sgc.getByRole("button", { name: "Run the emulator and record 1024 frames", exact: true })).toBeVisible();
      await expect(sgc.getByRole("note")).toHaveCount(0);
      await expect(sgc).not.toContainText("This server cannot capture SGC frames");
      await page.waitForLoadState("networkidle");
    } finally {
      await server.stop();
    }

    // everything was found under the sub-path, first try
    expect(responses.filter((response) => response.status !== 200 && response.status !== 304)).toEqual([]);
    expect(responses.filter((response) => !response.path.startsWith("/ui/"))).toEqual([]);

    const typeOf = (pattern: RegExp) => [...new Set(responses.filter((response) => pattern.test(response.path)).map((response) => response.type))];
    expect(typeOf(/\/assets\/[\w.-]+\.js$/)).toEqual([expect.stringMatching(/^(text|application)\/javascript\b/)]);
    expect(typeOf(/\/assets\/editor\.worker-[\w-]+\.js$/)).toEqual([expect.stringMatching(/^(text|application)\/javascript\b/)]);
    expect(typeOf(/\.css$/)).toEqual([expect.stringMatching(/^text\/css\b/)]);
    expect(typeOf(/\.wasm$/)).toEqual(["application/wasm"]);
    expect(typeOf(/\.ttf$/)).toEqual([expect.stringMatching(/^font\/(ttf|sfnt)$|^application\/(x-font-ttf|font-sfnt)$/)]);
    expect(typeOf(/\/ui\/$/)).toEqual([expect.stringMatching(/^text\/html\b/)]);
  });
});
