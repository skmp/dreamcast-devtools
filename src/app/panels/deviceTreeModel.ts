import type { DeviceNodeDescriptor, RegisterValue } from "../../lib/debuggerSchema";

// Pure helpers of the device tree panel: filtering, row budgets and default expansion.
// A "row" is one line of the tree on screen: a node or a register.

/** A search never mounts more rows than this; the rest is cut and the panel says so. */
export const MAX_SEARCH_ROWS = 200;

/** The second level of the tree is only expanded by default while that shows at most this many rows. */
export const MAX_DEFAULT_ROWS = 200;

/** The watch expression of a register, as the server resolves it. */
export const watchExpression = (nodePath: string, registerName: string) => `${nodePath}.${registerName.toLowerCase()}`;

/** Id of a register row (its data-register attribute). Node rows are tree items with the node path as their id. */
export const registerItemId = (nodePath: string, registerName: string) => `${nodePath}.reg.${registerName}`;

/**
 * Filters a node by the search words. Words narrow down level by level: a word that
 * matches a node (path, label or description) is consumed, its children are matched
 * against the next word, and its registers against all the words that are left.
 * Returns the node with only the matching registers and children, or null.
 */
const filterNode = (node: DeviceNodeDescriptor, words: string[], depth: number): DeviceNodeDescriptor | null => {
  // Check if this node matches the current level's query word
  const currentWord = words[depth] ?? words[words.length - 1];
  const nodeMatches =
    node.path.toLowerCase().includes(currentWord) ||
    node.label.toLowerCase().includes(currentWord) ||
    (node.description?.toLowerCase() ?? "").includes(currentWord);

  // Registers must match all remaining words
  const remainingWords = words.slice(depth + (nodeMatches ? 1 : 0));
  const registers = node.registers?.filter((register) => {
    const name = register.name.toLowerCase();
    return remainingWords.every((word) => name.includes(word));
  });

  // If this node matches, children use the next query word, otherwise the same one
  const nextDepth = nodeMatches ? depth + 1 : depth;
  const children = node.children
    ?.map((child) => filterNode(child, words, nextDepth))
    .filter((child): child is DeviceNodeDescriptor => child !== null);

  const hasRegisters = registers !== undefined && registers.length > 0;
  const hasChildren = children !== undefined && children.length > 0;
  if (!nodeMatches && !hasChildren && !hasRegisters) {
    return null;
  }
  return { ...node, registers: hasRegisters ? registers : undefined, children };
};

/** Rows of a (sub)tree when every node in it is expanded. */
export const countRows = (nodes: DeviceNodeDescriptor[]): number => {
  let rows = 0;
  for (const node of nodes) {
    rows += 1 + (node.registers?.length ?? 0) + (node.children ? countRows(node.children) : 0);
  }
  return rows;
};

/** Cuts a tree after `budget.left` rows in display order and collects the paths of the nodes that are kept. */
const takeRows = (nodes: DeviceNodeDescriptor[], budget: { left: number }, kept: string[]): DeviceNodeDescriptor[] => {
  const result: DeviceNodeDescriptor[] = [];
  for (const node of nodes) {
    if (budget.left <= 0) {
      break;
    }
    budget.left -= 1;
    kept.push(node.path);
    const registers = node.registers?.slice(0, budget.left);
    budget.left -= registers?.length ?? 0;
    const children = node.children ? takeRows(node.children, budget, kept) : undefined;
    result.push({ ...node, registers: registers && registers.length > 0 ? registers : undefined, children });
  }
  return result;
};

export interface DeviceTreeSearch {
  /** The matching part of the tree, cut after `maxRows` rows. */
  nodes: DeviceNodeDescriptor[];
  /** Every node of `nodes`: a search shows its matches expanded. */
  expanded: string[];
  /** Rows the search matched in total. */
  totalRows: number;
  /** Rows of `nodes` (at most `maxRows`). */
  shownRows: number;
}

export const searchDeviceTree = (
  tree: DeviceNodeDescriptor[],
  query: string,
  maxRows: number = MAX_SEARCH_ROWS,
): DeviceTreeSearch => {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const matches =
    words.length === 0
      ? tree
      : tree.map((node) => filterNode(node, words, 0)).filter((node): node is DeviceNodeDescriptor => node !== null);

  const totalRows = countRows(matches);
  const expanded: string[] = [];
  const budget = { left: maxRows };
  const nodes = takeRows(matches, budget, expanded);
  return { nodes, expanded, totalRows, shownRows: Math.min(totalRows, maxRows) };
};

/**
 * What is expanded before the user touches the tree: the first level, and the second level
 * as long as that does not put more than `maxRows` rows on screen.
 */
export const defaultExpansion = (tree: DeviceNodeDescriptor[], maxRows: number = MAX_DEFAULT_ROWS): string[] => {
  const firstLevel = tree.map((node) => node.path);
  const secondLevel: string[] = [];
  let rows = 0;
  for (const root of tree) {
    rows += 1 + (root.registers?.length ?? 0);
    for (const child of root.children ?? []) {
      secondLevel.push(child.path);
      rows += 1 + (child.registers?.length ?? 0) + (child.children?.length ?? 0);
    }
  }
  return rows <= maxRows ? [...firstLevel, ...secondLevel] : firstLevel;
};

/**
 * The values to show for the described registers of a node: the value of the latest tick
 * when the tick carries that register, otherwise the value from debugger.describe.
 */
export const liveRegisterValues = (described: RegisterValue[], live: RegisterValue[] | undefined): string[] =>
  described.map((register, index) => {
    if (!live) {
      return register.value;
    }
    // ticks list a node's registers in the described order; fall back to a lookup when they do not
    const candidate = live[index]?.name === register.name ? live[index] : live.find((entry) => entry.name === register.name);
    return candidate?.value ?? register.value;
  });
