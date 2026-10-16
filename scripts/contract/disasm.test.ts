import { describe, expect, it } from "vitest";
import { branchTarget, isArmControlFlow, isSh4ControlFlow, isSh4DelayedBranch, mnemonicOf } from "./disasm";

describe("reading disassembly text", () => {
  it("takes the first word as the mnemonic", () => {
    expect(mnemonicOf("mov.l @r4+, r5")).toBe("mov.l");
    expect(mnemonicOf("  RTS")).toBe("rts");
    expect(mnemonicOf("")).toBe("");
  });

  it("knows the SH4 instructions after which the next PC is not PC + 2", () => {
    for (const line of ["bra 0x8c010020", "bsr _snd_init+0x0", "jmp @r0", "jsr @r11", "rts", "rte", "bt 0x8c010004", "bf.s 0x8c0100f0", "bt/s 0x8c0100f0", "braf r1", "bsrf r2", "trapa #32", "sleep", ".word 0x085b", "<unreadable>", ""]) {
      expect(isSh4ControlFlow(line), line).toBe(true);
    }
    for (const line of ["mov r1, r2", "mov.l @(8,pc), r0", "add #4, r15", "nop", "cmp/eq r0, r1", "sts.l pr, @-r15", "bsel"]) {
      expect(isSh4ControlFlow(line), line).toBe(false);
    }
  });

  it("knows which SH4 branches execute with their delay slot", () => {
    for (const line of ["bra 0x8c010020", "jsr @r11", "rts", "rte", "bt.s 0x8c0100f0", "bf/s 0x8c0100f0", "braf r1"]) {
      expect(isSh4DelayedBranch(line), line).toBe(true);
    }
    for (const line of ["bt 0x8c010004", "bf 0x8C0000A0", "trapa #32", "nop"]) {
      expect(isSh4DelayedBranch(line), line).toBe(false);
    }
  });

  it("knows ARM control flow: branches, software interrupts, and anything that names the PC", () => {
    for (const line of ["b 0x00200010", "bl 0x200", "bne 0x1c", "blgt 0x400", "bx lr", "swi 0x10", "mov pc, lr", "ldmfd sp!, {r4, pc}", "ldr r15, [r0]", ".word 0xe7f000f0"]) {
      expect(isArmControlFlow(line), line).toBe(true);
    }
    for (const line of ["bic r0, r1, #255", "mov r1, #2", "ldr r0, [r1, #8]", "bics r0, r0, r1", "nop", "str r2, [r3]"]) {
      expect(isArmControlFlow(line), line).toBe(false);
    }
  });

  it("reads the target a branch names", () => {
    expect(branchTarget("bf 0x8C0000A0")).toBe(0x8c0000a0);
    expect(branchTarget("b 0x00200010")).toBe(0x00200010);
    expect(branchTarget("jmp @r0")).toBeUndefined();
  });
});
