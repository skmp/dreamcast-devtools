import { describe, expect, it } from "vitest";
import type { SerializedDockview } from "dockview";
import { withKnownPanels } from "./dockingLayoutStorage";

const leaf = (id: string, views: string[], activeView = views[0], size = 400) => ({ type: "leaf" as const, data: { views, activeView, id }, size });
const branch = (children: unknown[], size = 800) => ({ type: "branch" as const, data: children, size });
const panel = (id: string, contentComponent: string = id) => ({ id, contentComponent, title: id });

const layout = (root: unknown, panels: string[], extra: Partial<SerializedDockview> = {}): SerializedDockview =>
  ({
    grid: { root, height: 800, width: 1200, orientation: "HORIZONTAL" },
    panels: Object.fromEntries(panels.map((id) => [id, panel(id)])),
    activeGroup: "1",
    ...extra,
  }) as SerializedDockview;

const KNOWN = ["sh4-disassembly", "sh4-memory", "sh4-breakpoints", "events"];

describe("withKnownPanels", () => {
  it("returns the layout itself when every panel is known", () => {
    const saved = layout(branch([leaf("1", ["sh4-disassembly", "events"]), leaf("2", ["sh4-memory"])]), ["sh4-disassembly", "events", "sh4-memory"]);
    expect(withKnownPanels(saved, KNOWN)).toBe(saved);
  });

  it("takes an unknown panel out of its group and keeps the group", () => {
    const saved = layout(branch([leaf("1", ["sh4-disassembly", "hologram"], "hologram"), leaf("2", ["sh4-memory"])]), [
      "sh4-disassembly",
      "hologram",
      "sh4-memory",
    ]);
    const cleaned = withKnownPanels(saved, KNOWN)!;
    expect(Object.keys(cleaned.panels)).toEqual(["sh4-disassembly", "sh4-memory"]);
    expect(cleaned.grid.root).toEqual(branch([leaf("1", ["sh4-disassembly"], "sh4-disassembly"), leaf("2", ["sh4-memory"])]));
    expect(cleaned.activeGroup).toBe("1");
    // the saved object is not changed
    expect(Object.keys(saved.panels)).toHaveLength(3);
  });

  it("drops a group that has nothing left, the branch around it, and the active group if that was it", () => {
    const saved = layout(
      branch([leaf("1", ["sh4-disassembly"]), branch([leaf("2", ["hologram"]), branch([leaf("3", ["telepathy"])])])]),
      ["sh4-disassembly", "hologram", "telepathy"],
      { activeGroup: "2" },
    );
    const cleaned = withKnownPanels(saved, KNOWN)!;
    expect(cleaned.grid.root).toEqual(branch([leaf("1", ["sh4-disassembly"])]));
    expect(cleaned.activeGroup).toBeUndefined();
  });

  it("goes by the component of a panel, not by its key", () => {
    const saved = layout(leaf("1", ["a", "b"]), []);
    saved.panels = { a: panel("a", "sh4-memory"), b: panel("b", "hologram") };
    const cleaned = withKnownPanels(saved, KNOWN)!;
    expect(Object.keys(cleaned.panels)).toEqual(["a"]);
    expect(cleaned.grid.root).toEqual(leaf("1", ["a"], "a"));
  });

  it("cleans floating groups too", () => {
    const saved = layout(leaf("1", ["sh4-disassembly"]), ["sh4-disassembly", "hologram", "events"], {
      floatingGroups: [
        { data: { views: ["hologram"], activeView: "hologram", id: "9" }, position: { left: 0, top: 0, width: 100, height: 100 } },
        { data: { views: ["events", "hologram"], activeView: "hologram", id: "10" }, position: { left: 0, top: 0, width: 100, height: 100 } },
      ],
    } as Partial<SerializedDockview>);
    const cleaned = withKnownPanels(saved, KNOWN)!;
    expect(cleaned.floatingGroups).toEqual([
      { data: { views: ["events"], activeView: "events", id: "10" }, position: { left: 0, top: 0, width: 100, height: 100 } },
    ]);
  });

  it("returns null when no known panel is left: the default layout is used", () => {
    expect(withKnownPanels(layout(branch([leaf("1", ["hologram"])]), ["hologram"]), KNOWN)).toBeNull();
  });
});
