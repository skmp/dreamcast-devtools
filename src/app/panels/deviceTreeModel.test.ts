import type { DeviceNodeDescriptor } from "../../lib/debuggerSchema";
import {
  countRows,
  defaultExpansion,
  liveRegisterValues,
  registerItemId,
  searchDeviceTree,
  watchExpression,
} from "./deviceTreeModel";

const register = (name: string, value = "0x0") => ({ name, value, width: 32 });

const tree: DeviceNodeDescriptor[] = [
  {
    path: "dc",
    label: "Dreamcast",
    description: "console",
    registers: [register("SYSCLK")],
    children: [
      {
        path: "dc.sh4",
        label: "SH4",
        description: "SoC",
        children: [
          {
            path: "dc.sh4.cpu",
            label: "Core",
            description: "SuperH4 CPU Core",
            registers: [register("PC"), register("PR"), register("FPSCR")],
          },
          { path: "dc.sh4.bsc", label: "BSC", description: "Bus State Controller" },
        ],
      },
      {
        path: "dc.aica",
        label: "AICA",
        description: "Sound SoC",
        registers: [register("AICA_CTRL")],
        children: [
          { path: "dc.aica.arm7", label: "ARM7", description: "ARM7DI CPU Core", registers: [register("PC")] },
        ],
      },
    ],
  },
];

const synthetic = (nodes: number, registers: number): DeviceNodeDescriptor[] => [
  {
    path: "dc",
    label: "Synthetic",
    description: "big",
    children: Array.from({ length: nodes }, (_, node) => ({
      path: `dc.n${node}`,
      label: `Node ${node}`,
      description: "device",
      registers: Array.from({ length: registers }, (_, index) => register(`R${index}`)),
    })),
  },
];

const paths = (nodes: DeviceNodeDescriptor[]): string[] =>
  nodes.flatMap((node) => [
    node.path,
    ...(node.registers ?? []).map((entry) => registerItemId(node.path, entry.name)),
    ...paths(node.children ?? []),
  ]);

describe("deviceTreeModel", () => {
  it("names watch expressions and tree items", () => {
    expect(watchExpression("dc.sh4.cpu", "FPSCR")).toBe("dc.sh4.cpu.fpscr");
    expect(registerItemId("dc.sh4.cpu", "FPSCR")).toBe("dc.sh4.cpu.reg.FPSCR");
  });

  it("counts one row per node and per register", () => {
    expect(countRows(tree)).toBe(6 + 6);
    expect(countRows(synthetic(100, 25))).toBe(1 + 100 + 2500);
  });

  describe("searchDeviceTree", () => {
    it("keeps a matching node with all of its registers and its matching ancestors", () => {
      const result = searchDeviceTree(tree, "arm7");
      expect(paths(result.nodes)).toEqual(["dc", "dc.aica", "dc.aica.arm7", "dc.aica.arm7.reg.PC"]);
      expect(result.expanded).toEqual(["dc", "dc.aica", "dc.aica.arm7"]);
      expect(result.totalRows).toBe(4);
      expect(result.shownRows).toBe(4);
    });

    it("narrows down word by word: node, then register", () => {
      const result = searchDeviceTree(tree, "sh4 core fpscr");
      expect(paths(result.nodes)).toEqual(["dc", "dc.sh4", "dc.sh4.cpu", "dc.sh4.cpu.reg.FPSCR"]);
    });

    it("matches registers by name on their own", () => {
      const result = searchDeviceTree(tree, "pc");
      expect(paths(result.nodes)).toEqual([
        "dc",
        "dc.sh4",
        "dc.sh4.cpu",
        "dc.sh4.cpu.reg.PC",
        "dc.aica",
        "dc.aica.arm7",
        "dc.aica.arm7.reg.PC",
      ]);
    });

    it("is case-insensitive and ignores surrounding blanks", () => {
      expect(paths(searchDeviceTree(tree, "  ARM7  ").nodes)).toEqual(paths(searchDeviceTree(tree, "arm7").nodes));
    });

    it("returns nothing for a query that matches nothing", () => {
      const result = searchDeviceTree(tree, "no-such-thing");
      expect(result).toEqual({ nodes: [], expanded: [], totalRows: 0, shownRows: 0 });
    });

    it("does not change the descriptors it was given", () => {
      const before = JSON.stringify(tree);
      searchDeviceTree(tree, "pc", 3);
      expect(JSON.stringify(tree)).toBe(before);
    });

    it("cuts a broad search after the row budget, in display order", () => {
      const big = synthetic(100, 25);
      const result = searchDeviceTree(big, "n", 200);
      expect(result.totalRows).toBe(2601);
      expect(result.shownRows).toBe(200);
      expect(countRows(result.nodes)).toBe(200);
      // root, then 7 complete nodes (26 rows each), then node 7 with the 16 registers that still fit
      expect(result.expanded).toEqual(["dc", ...Array.from({ length: 8 }, (_, node) => `dc.n${node}`)]);
      const nodes = result.nodes[0].children!;
      expect(nodes).toHaveLength(8);
      expect(nodes[6].registers).toHaveLength(25);
      expect(nodes[7].registers).toHaveLength(16);
    });

    it("does not cut a search that fits", () => {
      const result = searchDeviceTree(synthetic(3, 4), "n", 200);
      expect(result.totalRows).toBe(16);
      expect(result.shownRows).toBe(16);
      expect(countRows(result.nodes)).toBe(16);
    });
  });

  describe("defaultExpansion", () => {
    it("expands the first two levels of a small tree", () => {
      expect(defaultExpansion(tree)).toEqual(["dc", "dc.sh4", "dc.aica"]);
    });

    it("expands only the first level when the second would show too many rows", () => {
      expect(defaultExpansion(synthetic(100, 25))).toEqual(["dc"]);
      expect(defaultExpansion(synthetic(100, 25), 5000)).toHaveLength(101);
    });

    it("is empty for an empty tree", () => {
      expect(defaultExpansion([])).toEqual([]);
    });
  });

  describe("liveRegisterValues", () => {
    const described = [register("PC", "0x1"), register("PR", "0x2"), register("SR", "0x3")];

    it("uses the described values until a tick arrives", () => {
      expect(liveRegisterValues(described, undefined)).toEqual(["0x1", "0x2", "0x3"]);
    });

    it("takes the values of the tick by register name, in any order", () => {
      const live = [register("SR", "0x30"), register("PC", "0x10"), register("PR", "0x20")];
      expect(liveRegisterValues(described, live)).toEqual(["0x10", "0x20", "0x30"]);
    });

    it("keeps the described value of a register the tick does not carry", () => {
      expect(liveRegisterValues(described, [register("PC", "0x10")])).toEqual(["0x10", "0x2", "0x3"]);
    });

    it("works for a filtered subset of the registers", () => {
      const live = [register("PC", "0x10"), register("PR", "0x20"), register("SR", "0x30")];
      expect(liveRegisterValues([described[2]], live)).toEqual(["0x30"]);
    });
  });
});
