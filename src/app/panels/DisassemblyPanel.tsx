import { useEffect, useMemo, useRef } from "react";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import SubdirectoryArrowRightIcon from "@mui/icons-material/SubdirectoryArrowRight";
import { useSessionStore } from "../../state/sessionStore";
import { useDebuggerDataStore } from "../../state/debuggerDataStore";
import type { BreakpointCategory } from "../../state/breakpointCategoryState";
import { DisassemblyView, type DisassemblyViewConfig, type DisassemblyViewCallbacks, type DisassemblyViewRef } from "../components/DisassemblyView";
import { disassemblyNavigationService } from "../../state/disassemblyNavigationService";
import { generateUUID } from "../../lib/uuid";

const formatHexAddress = (value: number) => `0x${value.toString(16).toUpperCase().padStart(8, "0")}`;

const instructionSizeForTarget = (target: string) => {
  switch (target) {
    case "sh4":
      return 2;
    case "arm7":
      return 4;
    case "dsp":
      return 1;
    default:
      return 2;
  }
};

const maxAddressForTarget = (target: string) => (target === "dsp" ? 0x7f : 0xffffffff);

const formatAddressInput = (target: string, value: number) =>
  target === "dsp" ? value.toString() : formatHexAddress(value);

const formatAddressForDisplay = (target: string, value: number) =>
  target === "dsp" ? value.toString().padStart(3, "0") : formatHexAddress(value);

const parseAddressInput = (target: string, input: string) => {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^0x/i.test(trimmed)) {
    const parsed = Number.parseInt(trimmed.replace(/^0x/i, ""), 16);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  const base = target === "dsp" ? 10 : 16;
  const parsed = Number.parseInt(trimmed, base);
  return Number.isNaN(parsed) ? undefined : parsed;
};

interface DisassemblyPanelProps {
  target: "sh4" | "arm7" | "dsp";
  defaultAddress: number;
}

const DisassemblyPanel = ({ target, defaultAddress }: DisassemblyPanelProps) => {
  const client = useSessionStore((state) => state.client);
  // what the last tick said; a target of which nothing is known yet is not stepped
  const executionState = useDebuggerDataStore((state) => state.executionState?.state ?? "running");
  const initialized = useDebuggerDataStore((state) => state.initialized);
  const breakpoints = useDebuggerDataStore((state) => state.breakpoints);
  const registersByPath = useDebuggerDataStore((state) => state.registersByPath);
  const addBreakpoint = useDebuggerDataStore((state) => state.addBreakpoint);
  const removeBreakpoint = useDebuggerDataStore((state) => state.removeBreakpoint);
  const toggleBreakpoint = useDebuggerDataStore((state) => state.toggleBreakpoint);
  const toggleCategoryMute = useDebuggerDataStore((state) => state.toggleCategoryMute);
  const toggleCategorySolo = useDebuggerDataStore((state) => state.toggleCategorySolo);
  const control = useDebuggerDataStore((state) => state.control);
  const viewRef = useRef<DisassemblyViewRef>(null);
  const panelIdRef = useRef(generateUUID());

  // Get current PC/STEP value
  const currentPc = useMemo(() => {
    const cpuPath = target === "dsp" ? "dc.aica.dsp" : target === "sh4" ? "dc.sh4.cpu" : "dc.aica.arm7";
    const counterName = target === "dsp" ? "STEP" : "PC";
    const registers = registersByPath[cpuPath];
    const pcReg = registers?.find((r) => r.name === counterName);

    if (pcReg?.value) {
      const parsed = Number.parseInt(pcReg.value.replace(/^0x/i, ""), 16);
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    return undefined;
  }, [registersByPath, target]);

  // Map addresses to breakpoints
  const breakpointsByAddress = useMemo(() => {
    const map = new Map<number, { id: number; enabled: boolean }>();
    const cpuPath = target === "dsp" ? "dc.aica.dsp" : target === "sh4" ? "dc.sh4.cpu" : "dc.aica.arm7";
    const counterName = target === "dsp" ? "step" : "pc";
    const expectedEvent = `${cpuPath}.${counterName}`;

    for (const bp of breakpoints) {
      if (bp.kind === "code" && bp.event === expectedEvent && bp.address !== undefined) {
        map.set(bp.address, { id: bp.id, enabled: bp.enabled });
      }
    }
    return map;
  }, [breakpoints, target]);

  // Mute and solo of the category are the server's state: the store has what the last tick
  // said, and sends what a button asks for on the connection of the session.
  const category: BreakpointCategory = target === "sh4" ? "sh4" : target === "arm7" ? "arm7" : "dsp";
  const categoryState = useDebuggerDataStore((state) => state.categories[category]);

  // Build configuration
  const config: DisassemblyViewConfig = useMemo(() => {
    const isDsp = target === "dsp";
    return {
      instructionSize: instructionSizeForTarget(target),
      maxAddress: maxAddressForTarget(target),
      formatAddressInput: (value: number) => formatAddressInput(target, value),
      formatAddressDisplay: (value: number) => formatAddressForDisplay(target, value),
      parseAddressInput: (input: string) => parseAddressInput(target, input),
      gridColumns: isDsp ? "24px 80px 1fr" : "24px 140px 140px 1fr",
      stepLabel: isDsp ? "Step" : "Step Over",
      stepIcon: isDsp ? ArrowForwardIcon : SubdirectoryArrowRightIcon,
      showStepInOut: target === "sh4" || target === "arm7",
      urlParamName: isDsp ? "step" : "address",
      showBytes: !isDsp,
    };
  }, [target]);

  // Build callbacks
  const callbacks: DisassemblyViewCallbacks = useMemo(
    () => ({
      onFetchDisassembly: async (address: number, count: number) => {
        if (!client) {
          throw new Error("Client not connected");
        }
        const result = await client.fetchDisassembly({ target, address, count });
        return result.lines;
      },
      // the answer of the server is checked by `control`, which shows a refusal
      onStep: async () => {
        if (executionState !== "paused") {
          return;
        }
        await control(target === "dsp" ? "step" : "stepOver", target);
      },
      onStepIn: async () => {
        if (executionState !== "paused") {
          return;
        }
        await control("step", target);
      },
      onStepOut: async () => {
        if (executionState !== "paused") {
          return;
        }
        await control("stepOut", target);
      },
      onBreakpointAdd: async (address: number) => {
        const cpuPath = target === "dsp" ? "dc.aica.dsp" : target === "sh4" ? "dc.sh4.cpu" : "dc.aica.arm7";
        const counterName = target === "dsp" ? "step" : "pc";
        const event = `${cpuPath}.${counterName}`;
        await addBreakpoint(event, address, "code");
      },
      onBreakpointRemove: async (id: number) => {
        await removeBreakpoint(id);
      },
      onBreakpointToggle: async (id: number, enabled: boolean) => {
        await toggleBreakpoint(id, enabled);
      },
      onMuteToggle: () => {
        void toggleCategoryMute(category);
      },
      onSoloToggle: () => {
        void toggleCategorySolo(category);
      },
    }),
    [client, target, executionState, control, addBreakpoint, removeBreakpoint, toggleBreakpoint, toggleCategoryMute, toggleCategorySolo, category],
  );

  // Register with navigation service
  useEffect(() => {
    const panelId = panelIdRef.current;
    if (viewRef.current) {
      disassemblyNavigationService.register(panelId, viewRef.current);
    }
    return () => {
      disassemblyNavigationService.unregister(panelId);
    };
  }, []);

  return (
    <DisassemblyView
      ref={viewRef}
      config={config}
      callbacks={callbacks}
      defaultAddress={defaultAddress}
      currentPc={currentPc}
      breakpointsByAddress={breakpointsByAddress}
      initialized={initialized}
      executionState={executionState}
      categoryState={categoryState}
      target={target}
    />
  );
};

export const Sh4DisassemblyPanel = () => {
  const registersByPath = useDebuggerDataStore((state) => state.registersByPath);
  const registers = registersByPath["dc.sh4.cpu"];
  const pcReg = registers?.find((r) => r.name === "PC");

  let defaultAddress = 0x8c010000;
  if (pcReg?.value) {
    const pc = Number.parseInt(pcReg.value.replace(/^0x/i, ""), 16);
    if (!Number.isNaN(pc)) {
      defaultAddress = Math.max(0, pc - 2 * 10); // 10 instructions before
    }
  }

  return <DisassemblyPanel target="sh4" defaultAddress={defaultAddress} />;
};

export const Arm7DisassemblyPanel = () => {
  const registersByPath = useDebuggerDataStore((state) => state.registersByPath);
  const registers = registersByPath["dc.aica.arm7"];
  const pcReg = registers?.find((r) => r.name === "PC");

  let defaultAddress = 0x00200000;
  if (pcReg?.value) {
    const pc = Number.parseInt(pcReg.value.replace(/^0x/i, ""), 16);
    if (!Number.isNaN(pc)) {
      defaultAddress = Math.max(0, pc - 4 * 10); // 10 instructions before
    }
  }

  return <DisassemblyPanel target="arm7" defaultAddress={defaultAddress} />;
};

export const DspDisassemblyPanel = () => {
  const registersByPath = useDebuggerDataStore((state) => state.registersByPath);
  const registers = registersByPath["dc.aica.dsp"];
  const stepReg = registers?.find((r) => r.name === "STEP");

  let defaultAddress = 0x00000000;
  if (stepReg?.value) {
    const step = Number.parseInt(stepReg.value.replace(/^0x/i, ""), 16);
    if (!Number.isNaN(step)) {
      defaultAddress = Math.max(0, step - 10); // 10 steps before
    }
  }

  return <DisassemblyPanel target="dsp" defaultAddress={defaultAddress} />;
};
