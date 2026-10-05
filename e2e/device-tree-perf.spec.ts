import { writeFileSync } from "node:fs";
import { test, expect, panel, registerRow, treeItem, treeItemRow, treeRows } from "./support/fixtures";
import { installLongTaskRecorder, takeLongTasks } from "./support/longTasks";
import { installRenderCounter, readRenderCounts, resetRenderCounts, type RenderCounts } from "./support/renderCounter";
import { serveSyntheticDebugger } from "./support/syntheticDebugger";

// Cost of the device tree on a synthetic tree of 100 nodes with 25 registers each (2500
// registers), served by the test itself: what a tick re-renders, and for how long the page
// is blocked when most of the tree is mounted or removed at once.
//
//   E2E_DEVICETREE_REPORT=<file>  also write the numbers as JSON
//   E2E_MEASURE_ONLY=1            measure without asserting (used to measure older builds)
const NODES = 100;
const REGISTERS = 25;
const ALL_ROWS = 1 + NODES + NODES * REGISTERS;
const MEASURE_ONLY = !!process.env.E2E_MEASURE_ONLY;

/** Mounting or removing most of the tree may not block the page for longer than this (its longest task). */
const BLOCK_LIMIT_MS = 1000;
/**
 * Every such step is measured this often and the best attempt counts: the suite runs four
 * tests in parallel, which can make a single measurement several times slower. An attempt
 * that is ten times over the limit is not that, and fails at once.
 */
const ATTEMPTS = MEASURE_ONLY ? 1 : 3;
/** Builds measured with E2E_MEASURE_ONLY need a minute for one step. */
const STEP_TIMEOUT_MS = MEASURE_ONLY ? 300_000 : 30_000;

interface TickCost {
  rendered: number;
  mounted: number;
  commits: number;
  messageToCommitMs: number | null;
}

interface Blocking {
  /** from the input until the tree showed the result, as the test saw it */
  elapsedMs: number;
  /** the longest of `longTasks`, 0 when no task took 50 ms */
  longestTaskMs: number;
  longTasks: number[];
}

const summarise = (counts: RenderCounts): TickCost => ({
  rendered: counts.rendered,
  mounted: counts.mounted,
  commits: counts.commits,
  messageToCommitMs: counts.messageToCommitMs.length
    ? Math.round(Math.max(...counts.messageToCommitMs) * 10) / 10
    : null,
});

const best = (attempts: Blocking[]) => Math.min(...attempts.map((attempt) => attempt.longestTaskMs));

test("device tree render and blocking cost on 100 nodes x 25 registers", async ({ page }) => {
  // Takes under a minute. A build that renders every register as a tree item (measured
  // with E2E_MEASURE_ONLY) mounts 2500 of them in some 6 s and needs a minute to remove them.
  test.setTimeout(MEASURE_ONLY ? 1_200_000 : 300_000);
  const synthetic = await serveSyntheticDebugger(page, { nodes: NODES, registersPerNode: REGISTERS });
  await installRenderCounter(page, '[data-panel-id="device-tree"]');
  await installLongTaskRecorder(page);
  await page.goto("/#/workspace/sh4-debugger");
  await synthetic.ready;

  const tree = panel(page, "device-tree");
  const rows = treeRows(page);
  await expect(treeItem(page, "dc")).toBeVisible();
  await expect(treeItem(page, synthetic.nodePath(NODES - 1))).toBeVisible();

  /**
   * Waits until the tree has stopped rendering by itself: mounting thousands of rows takes
   * a moment, and a tooltip under the mouse pointer opens and closes with a delay.
   */
  const settle = async () => {
    await page.mouse.move(1, 1);
    await expect
      .poll(
        async () => {
          await resetRenderCounts(page);
          await page.waitForTimeout(400);
          const counts = await readRenderCounts(page);
          return counts.rendered + counts.mounted;
        },
        { timeout: 60_000, message: "the device tree keeps rendering without input" },
      )
      .toBe(0);
  };

  /** Sends one tick that changes the first register of `change` nodes and returns what the tree re-rendered for it. */
  const measureTick = async (change: number[], visible: boolean): Promise<TickCost> => {
    await settle();
    await resetRenderCounts(page);
    synthetic.tick(change);
    if (visible) {
      for (const node of change) {
        const register = `${synthetic.nodePath(node)}.reg.R00`;
        // builds before the register rows became plain rows (E2E_MEASURE_ONLY) render a tree item
        await expect(registerRow(page, register).or(treeItem(page, register))).toHaveText(
          new RegExp(`R00 = ${synthetic.value(node, 0)}`),
        );
      }
    }
    await page.waitForTimeout(500);
    return summarise(await readRenderCounts(page));
  };
  const measureTicks = async (visible: boolean) => ({
    unchanged: await measureTick([], visible),
    oneNodeChanged: await measureTick([40], visible),
    tenNodesChanged: await measureTick([0, 10, 20, 30, 40, 50, 60, 70, 80, 90], visible),
  });

  /**
   * Does `input`, waits until the tree shows `expectedRows` rows and reports how long the
   * page was blocked on the way. The render counts start at zero with the input.
   */
  const measureBlocking = async (
    step: string,
    input: () => Promise<void>,
    expectedRows?: number,
  ): Promise<Blocking> => {
    await settle();
    await takeLongTasks(page);
    const startedAt = Date.now();
    await input();
    if (expectedRows !== undefined) {
      await expect(rows).toHaveCount(expectedRows, { timeout: STEP_TIMEOUT_MS });
    }
    const elapsedMs = Date.now() - startedAt;
    // a long task is reported after it has ended
    await page.waitForTimeout(500);
    const longTasks = await takeLongTasks(page);
    const blocking = { elapsedMs, longestTaskMs: Math.max(0, ...longTasks), longTasks };
    if (!MEASURE_ONLY) {
      expect(blocking.longestTaskMs, `"${step}" blocked the page: ${JSON.stringify(blocking)}`).toBeLessThan(
        10 * BLOCK_LIMIT_MS,
      );
    }
    return blocking;
  };

  // --- 1. as opened ---
  const defaultRows = await rows.count();
  const defaultState = await measureTicks(defaultRows === ALL_ROWS);

  // --- 2. every node expanded: all 2500 register rows are mounted ---
  let expandAll: Blocking | null = null;
  if (defaultRows !== ALL_ROWS) {
    // "*" expands all siblings of the focused tree item
    await treeItemRow(page, synthetic.nodePath(0)).click();
    expandAll = await measureBlocking("expand every node", () => page.keyboard.press("*"), ALL_ROWS);
  }
  await expect(rows).toHaveCount(ALL_ROWS);
  const allExpanded = await measureTicks(true);

  // --- 3. a search that matches every node, typed while all 2601 rows are mounted, and back ---
  const search = tree.getByPlaceholder("Search components...");
  const searchFromAllExpanded: Blocking[] = [];
  const clearSearch: Blocking[] = [];
  let searchRows = 0;
  let searchCost: TickCost | null = null;
  let refineNotice = 0;
  let searchTicks: Awaited<ReturnType<typeof measureTicks>> | null = null;
  let rowsAfterSearch = 0;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    // the input event is handled, and the tree rendered, before fill() returns
    searchFromAllExpanded.push(
      await measureBlocking("search from the fully expanded tree", () => search.fill("n0")),
    );
    await expect(treeItem(page, synthetic.nodePath(0))).toBeVisible();
    if (attempt === 0) {
      await page.waitForTimeout(1000);
      searchRows = await rows.count();
      searchCost = summarise(await readRenderCounts(page));
      refineNotice = await tree.getByText(/refine your search/i).count();
      searchTicks = await measureTicks(false);
    }

    clearSearch.push(await measureBlocking("clear the search", () => search.fill("")));
    await expect(treeItem(page, synthetic.nodePath(NODES - 1))).toBeVisible();
    if (attempt === 0) {
      await page.waitForTimeout(1000);
      rowsAfterSearch = await rows.count();
    }
  }

  // --- 4. the root collapsed, which removes every other row, and expanded again ---
  const collapseRoot: Blocking[] = [];
  const expandRoot: Blocking[] = [];
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    // the rows are removed when the collapse animation is over
    collapseRoot.push(await measureBlocking("collapse the root", () => treeItemRow(page, "dc").click(), 1));
    expandRoot.push(
      await measureBlocking("expand the root", () => treeItemRow(page, "dc").click(), rowsAfterSearch),
    );
  }

  // --- 5. the watch expression suggestions ---
  const watchInput = panel(page, "watches").getByPlaceholder("Enter expression");
  await watchInput.pressSequentially("dc.n");
  await expect(page.getByRole("option").first()).toBeVisible();
  await page.waitForTimeout(500);
  const watchOptions = await page.getByRole("option").count();
  await watchInput.press("Escape");

  const report = {
    label: process.env.E2E_MEASURE_LABEL ?? "working tree",
    tree: { nodes: NODES, registersPerNode: REGISTERS, rowsWhenFullyExpanded: ALL_ROWS },
    rows: { asOpened: defaultRows, duringSearchForN0: searchRows, afterClearingTheSearch: rowsAfterSearch },
    refineNoticeShown: refineNotice > 0,
    watchSuggestionsForDcN: watchOptions,
    searchCost,
    componentRendersPerTick: { asOpened: defaultState, allNodesExpanded: allExpanded, duringSearch: searchTicks },
    blocking: {
      limitMs: BLOCK_LIMIT_MS,
      attempts: ATTEMPTS,
      expandEveryNode: expandAll,
      searchFromAllExpanded,
      clearSearch,
      collapseRoot,
      expandRoot,
    },
  };
  console.log(JSON.stringify(report, null, 2));
  if (process.env.E2E_DEVICETREE_REPORT) {
    writeFileSync(process.env.E2E_DEVICETREE_REPORT, JSON.stringify(report, null, 2) + "\n");
  }
  if (MEASURE_ONLY) {
    return;
  }

  // A tick that changes nothing renders nothing in the tree, however much of it is mounted
  expect(allExpanded.unchanged.rendered).toBe(0);
  expect(defaultState.unchanged.rendered).toBe(0);
  // One changed node: its register list and the row that changed, not its other 24 rows
  // and not the other 99 nodes
  expect(allExpanded.oneNodeChanged.rendered).toBe(2);
  expect(allExpanded.tenNodesChanged.rendered).toBe(10 * 2);
  expect(allExpanded.oneNodeChanged.mounted).toBe(0);
  // A tree this big is not expanded two levels deep when it is opened
  expect(defaultRows).toBeLessThanOrEqual(1 + NODES);
  // A search that matches everything mounts a bounded number of rows and says so
  expect(searchRows).toBeLessThanOrEqual(250);
  expect(refineNotice).toBe(1);
  // Clearing the search restores what the user had expanded (everything, in step 2)
  expect(rowsAfterSearch).toBe(ALL_ROWS);
  // The suggestions are capped
  expect(watchOptions).toBeLessThanOrEqual(50);
  // Removing 2400 or all 2600 rows, and mounting them again, does not block the page
  for (const [step, attempts] of Object.entries({ searchFromAllExpanded, clearSearch, collapseRoot, expandRoot })) {
    expect(best(attempts), `${step}: longest task in ms, best of ${ATTEMPTS} attempts`).toBeLessThan(BLOCK_LIMIT_MS);
  }
});
