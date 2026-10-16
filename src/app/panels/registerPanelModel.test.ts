import type { DeviceNodeDescriptor, RegisterValue } from "../../lib/debuggerSchema";
import {
  EDIT_TITLES,
  controlName,
  editability,
  hasWriter,
  indexRegisters,
  isControl,
  panelNode,
  registerRows,
  registerWrite,
  watchedRegister,
  widthLabel,
} from "./registerPanelModel";

const register = (name: string, width = 32, writable = false): RegisterValue => ({
  name,
  value: width > 0 ? "0x0" : "text",
  width,
  ...(writable ? { flags: { writable: true } } : {}),
});

const node = (path: string, extra: Partial<DeviceNodeDescriptor> = {}): DeviceNodeDescriptor => ({
  path,
  label: path.split(".").at(-1)!.toUpperCase(),
  description: `the node ${path}`,
  ...extra,
});

// the shape of the tree of a server of milestone M2: the two processors can be written, the rest cannot
const tree: DeviceNodeDescriptor[] = [
  node("dc", {
    registers: [register("SYSCLK", 0)],
    children: [
      node("dc.sh4", {
        children: [
          node("dc.sh4.cpu", {
            registers: [register("PC", 32, true), register("SR", 32, true), register("FR0", 32, true)],
            actions: ["sh4-disassembly", "sh4-memory", "sh4-registers"],
          }),
          node("dc.sh4.pbus", {
            children: [
              node("dc.sh4.tmu", { registers: [register("TSTR", 8), register("TCNT0")], actions: ["tmu-registers"] }),
              node("dc.sh4.sq", { actions: ["sq-contents"] }),
            ],
          }),
        ],
      }),
      node("dc.aica", {
        children: [
          node("dc.aica.arm7", {
            registers: [register("PC", 32, true), register("ENABLED", 1), register("R0", 32, true)],
            actions: ["arm7-disassembly", "arm7-memory", "arm7-registers"],
          }),
        ],
      }),
    ],
  }),
];

describe("the node a register panel shows", () => {
  it("is the node whose actions name the panel's id, wherever it is in the tree", () => {
    expect(panelNode(tree, "sh4-registers")?.path).toBe("dc.sh4.cpu");
    expect(panelNode(tree, "arm7-registers")?.path).toBe("dc.aica.arm7");
    expect(panelNode(tree, "tmu-registers")?.path).toBe("dc.sh4.tmu");
    // any action of the node, not its first
    expect(panelNode(tree, "sh4-memory")?.path).toBe("dc.sh4.cpu");
  });

  it("is none when no node offers the id: a server of milestone M1 has no arm7-registers", () => {
    const m1 = [node("dc", { children: [node("dc.aica.arm7", { registers: [register("PC")], actions: ["arm7-disassembly", "arm7-memory"] })] })];
    expect(panelNode(m1, "arm7-registers")).toBeUndefined();
    expect(panelNode(tree, "bsc-registers")).toBeUndefined();
    expect(panelNode([], "sh4-registers")).toBeUndefined();
    // a path is no id, and neither is a part of one
    expect(panelNode(tree, "dc.sh4.cpu")).toBeUndefined();
    expect(panelNode(tree, "registers")).toBeUndefined();
  });

  it("is the first in the order of the describe tree when several nodes offer the id: a node before its children, a subtree before the next", () => {
    const offered = (path: string, extra: Partial<DeviceNodeDescriptor> = {}) => node(path, { actions: ["tmu-registers"], ...extra });
    // a node deep in the first subtree comes before a node at the top of the second
    expect(
      panelNode([node("a", { children: [node("a.x", { children: [offered("a.x.deep")] })] }), offered("b")], "tmu-registers")?.path,
    ).toBe("a.x.deep");
    // a node comes before the nodes below it
    expect(panelNode([offered("a", { children: [offered("a.child")] })], "tmu-registers")?.path).toBe("a");
    // and of two siblings the one that is listed first
    expect(panelNode([node("dc", { children: [offered("dc.second"), offered("dc.first")] })], "tmu-registers")?.path).toBe("dc.second");
  });
});

describe("the rows of a register panel", () => {
  it("are the described registers of the node, in their order, with their width and whether the server writes them", () => {
    expect(registerRows(panelNode(tree, "arm7-registers")!)).toEqual([
      { name: "PC", bits: "32", writable: true, watch: "dc.aica.arm7.pc" },
      { name: "ENABLED", bits: "1", writable: false, watch: "dc.aica.arm7.enabled" },
      { name: "R0", bits: "32", writable: true, watch: "dc.aica.arm7.r0" },
    ]);
    expect(registerRows(tree[0])).toEqual([{ name: "SYSCLK", bits: "text", writable: false, watch: "dc.sysclk" }]);
    // a node without registers has no rows
    expect(registerRows(panelNode(tree, "sq-contents")!)).toEqual([]);
  });

  it("say a width in bits, and text for a register of free text", () => {
    expect([64, 32, 23, 1, 0].map(widthLabel)).toEqual(["64", "32", "23", "1", "text"]);
  });
});

describe("a register has a writer", () => {
  it("when the describe tree says so with flags.writable, and only then", () => {
    expect(hasWriter(register("PC", 32, true))).toBe(true);
    expect(hasWriter(register("TCNT0"))).toBe(false);
    expect(hasWriter({ width: 32, flags: {} })).toBe(false);
    expect(hasWriter({ width: 32, flags: { writable: false } })).toBe(false);
    // another flag is not that one
    expect(hasWriter({ width: 32, flags: { volatile: true } })).toBe(false);
  });

  it("never when it is free text: the server refuses a register of width 0 whatever its flags say", () => {
    expect(hasWriter({ width: 0, flags: { writable: true } })).toBe(false);
  });
});

describe("the value of a register is an editor", () => {
  const all = { registerWrite: true, paused: true };

  it("for a register with a writer, on a server with register writes, while the target is paused", () => {
    expect(editability(true, all)).toBe("editable");
  });

  it("and not otherwise, for the first reason that holds: no capability, no writer, running", () => {
    expect(editability(true, { ...all, paused: false })).toBe("running");
    expect(editability(false, all)).toBe("no-writer");
    expect(editability(true, { ...all, registerWrite: false })).toBe("no-capability");
    // a server that cannot write registers: that is what is said, of every register and in either state
    expect(editability(false, { registerWrite: false, paused: false })).toBe("no-capability");
    expect(editability(false, { registerWrite: true, paused: false })).toBe("no-writer");
  });

  it("says which of them it is", () => {
    expect(EDIT_TITLES.editable).toBe("Double-click to write the register");
    expect(new Set(Object.values(EDIT_TITLES)).size).toBe(4);
    for (const reason of ["no-capability", "no-writer", "running"] as const) {
      expect(EDIT_TITLES[reason]).toMatch(/^Read-only/);
    }
  });
});

describe("the value of a register is a control for the keyboard", () => {
  it("when this server writes the register: while it can be edited, and while the target runs", () => {
    expect(isControl("editable")).toBe(true);
    // it keeps the focus it has over a run, and says that it cannot be used
    expect(isControl("running")).toBe(true);
  });

  it("and is text when the register is never an editor on this server", () => {
    expect(isControl("no-writer")).toBe(false);
    expect(isControl("no-capability")).toBe(false);
  });

  it("is named with whose value it is, the value and what it does", () => {
    expect(controlName("R0", "0x00000042")).toBe("R0 0x00000042, write");
    expect(controlName("dc.sh4.cpu.pc", "0x8C0000A0")).toBe("dc.sh4.cpu.pc 0x8C0000A0, write");
  });
});

describe("what an edit sends", () => {
  it("is the path of the node, the name as described and the text as it was typed", () => {
    expect(registerWrite("dc.sh4.cpu", "FR0", "0x3F800000")).toEqual({ path: "dc.sh4.cpu", name: "FR0", value: "0x3F800000" });
    // the server is the one that reads the value: blanks, decimal, and what is no number at all
    expect(registerWrite("dc.aica.arm7", "R0", " 4660 ").value).toBe(" 4660 ");
    expect(registerWrite("dc.aica.arm7", "R0", "twelve").value).toBe("twelve");
    expect(registerWrite("dc.aica.arm7", "R0", "").value).toBe("");
  });
});

describe("the register of a watch", () => {
  const index = indexRegisters(tree);

  it("is the described register whose path and name the expression is, without regard to case", () => {
    expect(watchedRegister(index, "dc.sh4.cpu.pc")).toBe(tree[0].children![0].children![0].registers![0]);
    expect(watchedRegister(index, "DC.SH4.CPU.Fr0")?.name).toBe("FR0");
    expect(watchedRegister(index, "dc.aica.arm7.enabled")?.name).toBe("ENABLED");
    expect(watchedRegister(index, "dc.sysclk")?.name).toBe("SYSCLK");
    // and it carries what the describe tree says of it: the flag that no tick has
    expect(hasWriter(watchedRegister(index, "dc.sh4.cpu.sr")!)).toBe(true);
    expect(hasWriter(watchedRegister(index, "dc.sh4.tmu.tcnt0")!)).toBe(false);
  });

  it("is none for an expression that names no described register", () => {
    for (const expression of ["dc.sh4.cpu.nothing", "dc.sh4.cpu", "dc.sh4.dmac.dmaor", "pc", ".pc", "dc.sh4.cpu.", "", "dc.sh4.cpu.pc.x"]) {
      expect(watchedRegister(index, expression), expression).toBeUndefined();
    }
  });

  it("is found by splitting the expression at its last dot, as the servers do", () => {
    // a register whose name has a dot in it cannot be named by an expression: the split takes its last part for the name
    const dotted = indexRegisters([node("dc.a", { registers: [register("b.c", 32, true)] }), node("dc.a.b", { registers: [register("C")] })]);
    expect(watchedRegister(dotted, "dc.a.b.c")?.name).toBe("C");
    expect(indexRegisters([node("dc.a", { registers: [register("b.c", 32, true)] })]).get("dc.a")?.has("b.c")).toBe(true);
    expect(watchedRegister(indexRegisters([node("dc.a", { registers: [register("b.c", 32, true)] })]), "dc.a.b.c")).toBeUndefined();
  });

  it("is the first of a name, in the first node of a path, as a look-up in the tree finds it", () => {
    const twice = indexRegisters([
      node("dc.x", { registers: [{ ...register("PC", 32, true), value: "first" }, { ...register("pc"), value: "second" }] }),
      node("DC.X", { registers: [{ ...register("PC"), value: "third" }, register("LATER", 32, true)] }),
    ]);
    expect(watchedRegister(twice, "dc.x.pc")?.value).toBe("first");
    expect(watchedRegister(twice, "dc.x.later")).toBeUndefined();
  });
});
