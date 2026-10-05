import { useMemo } from "react";
import type { TargetProcessor } from "../lib/debuggerSchema";
import { useDebuggerDataStore } from "./debuggerDataStore";
import { hasCapability, programCounter, targetInfo, type TargetInfo } from "./targets";

// What panels select from the store. Each of these changes only when what it stands for
// changes, so a panel that uses them does not render again for every tick.

/** What the server said about a target in debugger.describe (or the built-in values for a v2 server). */
export const useTarget = (id: TargetProcessor): TargetInfo => {
  const shape = useDebuggerDataStore((state) => state.shape);
  return useMemo(() => targetInfo(shape, id), [shape, id]);
};

/** Whether the server has an optional method (`capabilities` of debugger.describe). */
export const useCapability = (capability: string): boolean =>
  useDebuggerDataStore((state) => hasCapability(state.shape, capability));

/** The program counter (or step) of a target as the last tick that carried it reported it. */
export const useProgramCounter = (target: Pick<TargetInfo, "pcPath" | "pcRegister">): number | undefined =>
  useDebuggerDataStore((state) => programCounter(state.registersByPath, target));

/** "running" or "paused" once a tick has said so. */
export const useRunState = (): "running" | "paused" | undefined => useDebuggerDataStore((state) => state.executionState?.state);
