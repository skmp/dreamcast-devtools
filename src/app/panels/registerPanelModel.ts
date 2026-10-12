import type { DeviceNodeDescriptor, RegisterValue } from "../../lib/debuggerSchema";
import { watchExpression } from "./deviceTreeModel";

// Pure rules of the register panel, and of every editor of a register (the panel's, and the
// value of a watch): which node a panel shows, what a row is, which registers can be edited
// and when, how a watch finds its register, and what an edit sends.
//
// What is known of a register beyond its value is in the node of the describe tree: ticks
// carry names, values and widths, and never `flags`, and the store replaces the registers of
// a path with those of the tick. So rows, widths and `flags.writable` are the described ones,
// and only the values are the ticks'.

/**
 * The node a register panel shows: the one whose `actions` name the panel's id, and the first
 * of them in the order of the describe tree (a node before its children, the children in the
 * order they are listed) when several do. Undefined when no node offers the panel: the server
 * has no such table.
 */
export const panelNode = (tree: readonly DeviceNodeDescriptor[], panelId: string): DeviceNodeDescriptor | undefined => {
  for (const node of tree) {
    if (node.actions?.includes(panelId)) {
      return node;
    }
    const below = node.children ? panelNode(node.children, panelId) : undefined;
    if (below) {
      return below;
    }
  }
  return undefined;
};

/**
 * Whether state.setRegister has a writer for a described register. Only the server knows, and
 * says so with `flags.writable`; a register of free text (width 0) has none whatever it says.
 */
export const hasWriter = (register: Pick<RegisterValue, "width" | "flags">): boolean =>
  register.width > 0 && register.flags?.writable === true;

/** What the Bits column says of a register: its width, and "text" for free text (width 0). */
export const widthLabel = (width: number): string => (width > 0 ? String(width) : "text");

/** One row of a register panel, as the node of the describe tree gives it. */
export interface RegisterRowModel {
  name: string;
  /** what the Bits column shows */
  bits: string;
  /** the server has a writer for it */
  writable: boolean;
  /** the watch expression of the register, as the server resolves it */
  watch: string;
}

export const registerRows = (node: DeviceNodeDescriptor): RegisterRowModel[] =>
  (node.registers ?? []).map((register) => ({
    name: register.name,
    bits: widthLabel(register.width),
    writable: hasWriter(register),
    watch: watchExpression(node.path, register.name),
  }));

/**
 * Whether the value of a register is an editor now, and if not, why not:
 * - "no-capability": the server has no register writes at all (`register-write`), and the
 *   request would be answered -32004;
 * - "no-writer": the register does not carry `flags.writable` (or the watch names no described
 *   register), and the request would be answered -32013;
 * - "running": register and memory editing is offered while the target is paused only;
 * - "editable".
 */
export type Editability = "editable" | "no-capability" | "no-writer" | "running";

export interface EditConditions {
  /** the server lists the capability `register-write` */
  registerWrite: boolean;
  /** the latest tick says the target is paused */
  paused: boolean;
}

export const editability = (writable: boolean, { registerWrite, paused }: EditConditions): Editability =>
  !registerWrite ? "no-capability" : !writable ? "no-writer" : !paused ? "running" : "editable";

/** What the value of a register says of itself when the pointer rests on it. */
export const EDIT_TITLES: Readonly<Record<Editability, string>> = {
  editable: "Double-click to write the register",
  "no-capability": "Read-only: this server cannot write registers",
  "no-writer": "Read-only: the server has no writer for this register",
  running: "Read-only while the target runs: pause it to write the register",
};

/** What state.setRegister is sent for an edit: the node, the register as described, and the text as it was typed. */
export interface RegisterWrite {
  path: string;
  name: string;
  value: string;
}

/**
 * The request of an edit. The value is what was typed: "0x" and hex digits or decimal digits,
 * with blanks around it, is what the server reads, and it is the server that says what else is
 * (-32602) and which value the device refuses (-32013).
 */
export const registerWrite = (path: string, name: string, text: string): RegisterWrite => ({ path, name, value: text });

/** The described registers of a tree, by the path of their node and by their name, both in lower case. */
export type RegisterIndex = ReadonlyMap<string, ReadonlyMap<string, RegisterValue>>;

export const indexRegisters = (tree: readonly DeviceNodeDescriptor[]): RegisterIndex => {
  const index = new Map<string, Map<string, RegisterValue>>();
  const visit = (nodes: readonly DeviceNodeDescriptor[]) => {
    for (const node of nodes) {
      const path = node.path.toLowerCase();
      // the first node of a path and the first register of a name, as a look-up in the tree finds them
      if (node.registers?.length && !index.has(path)) {
        const registers = new Map<string, RegisterValue>();
        for (const register of node.registers) {
          const name = register.name.toLowerCase();
          if (!registers.has(name)) {
            registers.set(name, register);
          }
        }
        index.set(path, registers);
      }
      if (node.children) {
        visit(node.children);
      }
    }
  };
  visit(tree);
  return index;
};

/**
 * The described register a watch is of: the one whose `<path>.<name>` equals the expression
 * without regard to case, the expression split at its last dot (the rule of the servers). A
 * watch is `{id, expression, value}` on the wire and says nothing else about its register.
 * Undefined when the expression names no described register.
 */
export const watchedRegister = (index: RegisterIndex, expression: string): RegisterValue | undefined => {
  const normalised = expression.toLowerCase();
  const dot = normalised.lastIndexOf(".");
  return dot > 0 ? index.get(normalised.slice(0, dot))?.get(normalised.slice(dot + 1)) : undefined;
};
