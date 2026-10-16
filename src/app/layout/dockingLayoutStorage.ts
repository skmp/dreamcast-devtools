import type { SerializedDockview } from "dockview";

const getDockingLayoutStorageKey = (workspaceId?: string) =>
  workspaceId ? `nulldc-debugger-docking-layout-${workspaceId}` : "nulldc-debugger-docking-layout";

export function saveLayout(layout: SerializedDockview, workspaceId?: string) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(getDockingLayoutStorageKey(workspaceId), JSON.stringify(layout));
  } catch (error) {
    console.warn("Failed to save docking layout", error);
  }
}

export function loadLayout(workspaceId?: string): SerializedDockview | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(getDockingLayoutStorageKey(workspaceId));
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.warn("Failed to load docking layout", error);
    return null;
  }
}

export function clearDockingLayout(workspaceId?: string) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.removeItem(getDockingLayoutStorageKey(workspaceId));
  } catch (error) {
    console.warn("Failed to clear docking layout", error);
  }
}

type GridNode = SerializedDockview["grid"]["root"];
type GroupState = Extract<GridNode["data"], { views: string[] }>;

const withoutUnknownViews = (group: GroupState, known: ReadonlySet<string>): GroupState | null => {
  const views = group.views.filter((id) => known.has(id));
  if (views.length === 0) {
    return null;
  }
  return { ...group, views, activeView: group.activeView !== undefined && views.includes(group.activeView) ? group.activeView : views[0] };
};

const withoutUnknownPanels = (node: GridNode, known: ReadonlySet<string>): GridNode | null => {
  if (node.type === "leaf") {
    const group = withoutUnknownViews(node.data as GroupState, known);
    return group ? { ...node, data: group } : null;
  }
  const children = (node.data as GridNode[])
    .map((child) => withoutUnknownPanels(child, known))
    .filter((child): child is GridNode => child !== null);
  return children.length > 0 ? { ...node, data: children } : null;
};

/**
 * A saved layout without the panels this build does not have: a layout can have been saved
 * by another version of the UI on the same origin, and dockview refuses a layout as a whole
 * when it names a component it does not know. The rest of the layout is kept as it was.
 * Returns the layout itself when nothing had to go, and null when nothing is left.
 */
export function withKnownPanels(layout: SerializedDockview, knownPanelIds: Iterable<string>): SerializedDockview | null {
  const knownIds = new Set(knownPanelIds);
  const known = new Set(
    Object.entries(layout.panels ?? {})
      .filter(([, panel]) => knownIds.has(panel.contentComponent ?? panel.id))
      .map(([id]) => id),
  );
  if (known.size === Object.keys(layout.panels ?? {}).length) {
    return layout;
  }

  const root = withoutUnknownPanels(layout.grid.root, known);
  if (!root) {
    return null;
  }
  const groupIds = new Set<string>();
  const collect = (node: GridNode) => {
    if (node.type === "leaf") {
      groupIds.add((node.data as GroupState).id);
    } else {
      (node.data as GridNode[]).forEach(collect);
    }
  };
  collect(root);

  const groupsWithKnownViews = <T extends { data: GroupState }>(groups: T[] | undefined): T[] | undefined =>
    groups
      ?.map((group) => {
        const data = withoutUnknownViews(group.data, known);
        return data ? { ...group, data } : null;
      })
      .filter((group): group is T => group !== null);

  return {
    ...layout,
    grid: { ...layout.grid, root },
    panels: Object.fromEntries(Object.entries(layout.panels).filter(([id]) => known.has(id))),
    activeGroup: layout.activeGroup !== undefined && groupIds.has(layout.activeGroup) ? layout.activeGroup : undefined,
    floatingGroups: groupsWithKnownViews(layout.floatingGroups),
    popoutGroups: groupsWithKnownViews(layout.popoutGroups),
  };
}
