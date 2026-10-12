import { useMemo } from "react";
import type { TargetProcessor } from "../lib/debuggerSchema";
import { useDebuggerDataStore } from "./debuggerDataStore";
import { useSessionStore } from "./sessionStore";
import { hasCapability, programCounter, targetInfo, type TargetInfo } from "./targets";

// What panels select from the store. Each of these changes only when what it stands for
// changes, so a panel that uses them does not render again for every tick.

/**
 * What the server said about a target in debugger.describe; a target it does not list is not
 * supported. While the connection is away it is what the server of the last one said: a panel
 * keeps the frame that server gave it. Before any server has described itself the built-in
 * values stand in, with every target supported.
 */
export const useTarget = (id: TargetProcessor): TargetInfo => {
  const shape = useDebuggerDataStore((state) => state.shape);
  return useMemo(() => targetInfo(shape, id), [shape, id]);
};

/**
 * What a panel says in place of the data it does not have: "Not connected" while the session
 * has no connection, "No Data" while it has one whose server has not described itself (yet).
 */
export const useNoDataText = (): string =>
  useSessionStore((state) => (state.connectionState === "connected" ? "No Data" : "Not connected"));

/**
 * Whether the server has an optional method (`capabilities` of debugger.describe); before any
 * server has described itself every panel has its controls.
 */
export const useCapability = (capability: string): boolean =>
  useDebuggerDataStore((state) => hasCapability(state.shape, capability));

/** The program counter (or step) of a target as the last tick that carried it reported it. */
export const useProgramCounter = (target: Pick<TargetInfo, "pcPath" | "pcRegister">): number | undefined =>
  useDebuggerDataStore((state) => programCounter(state.registersByPath, target));

/** "running" or "paused" once a tick has said so. */
export const useRunState = (): "running" | "paused" | undefined => useDebuggerDataStore((state) => state.executionState?.state);
