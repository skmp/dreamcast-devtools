/**
 * What the contract runner has to know about a line of disassembly text: whether the
 * instruction can change the PC in a way other than "next instruction", so that scenarios
 * can pick addresses whose successor is known. It reads the mnemonic only; both servers
 * print SH4 and ARM mnemonics in lower case.
 */

/** SH4 instructions after which the next PC is not PC + 2, or that the debugger steps specially. */
const SH4_CONTROL_FLOW = new Set([
  "bra",
  "braf",
  "bsr",
  "bsrf",
  "jmp",
  "jsr",
  "rts",
  "rte",
  "bt",
  "bf",
  "bt.s",
  "bf.s",
  "bt/s",
  "bf/s",
  "trapa",
  "sleep",
  // not an instruction (or the reios trap): a step can fail or run a whole HLE call
  ".word",
]);

/** SH4 branches that execute together with the instruction after them. */
const SH4_DELAYED = new Set(["bra", "braf", "bsr", "bsrf", "jmp", "jsr", "rts", "rte", "bt.s", "bf.s", "bt/s", "bf/s"]);

const ARM_CONDITIONS = "(eq|ne|cs|hs|cc|lo|mi|pl|vs|vc|hi|ls|ge|lt|gt|le|al)?";
const ARM_BRANCH = new RegExp(`^(b|bl|bx|blx|swi|svc)${ARM_CONDITIONS}$`);

export const mnemonicOf = (disassembly: string): string => disassembly.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

const unusable = (disassembly: string): boolean => disassembly.trim() === "" || disassembly.startsWith("<");

export const isSh4ControlFlow = (disassembly: string): boolean =>
  unusable(disassembly) || SH4_CONTROL_FLOW.has(mnemonicOf(disassembly));

export const isSh4DelayedBranch = (disassembly: string): boolean => SH4_DELAYED.has(mnemonicOf(disassembly));

/** A branch, a software interrupt, or anything that names the PC as an operand (`mov pc, lr`, `ldmfd sp!, {..., pc}`). */
export const isArmControlFlow = (disassembly: string): boolean =>
  unusable(disassembly) || ARM_BRANCH.test(mnemonicOf(disassembly)) || /\b(pc|r15)\b/i.test(disassembly) || mnemonicOf(disassembly) === ".word";

/** The address a branch line names as its target (`bf 0x8C0000A0`), if it names one. */
export const branchTarget = (disassembly: string): number | undefined => {
  const match = /\b0x([0-9a-f]{1,8})\b/i.exec(disassembly.split(/\s+/).slice(1).join(" "));
  return match ? Number.parseInt(match[1], 16) : undefined;
};
