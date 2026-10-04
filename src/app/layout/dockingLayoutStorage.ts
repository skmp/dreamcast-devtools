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
