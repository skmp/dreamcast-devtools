import { useEffect, useMemo, useRef, useState } from "react";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import SubdirectoryArrowRightIcon from "@mui/icons-material/SubdirectoryArrowRight";
import type { TargetProcessor } from "../../lib/debuggerSchema";
import { useSessionStore } from "../../state/sessionStore";
import { useDebuggerDataStore } from "../../state/debuggerDataStore";
import { useNoDataText, useProgramCounter, useRunState, useTarget } from "../../state/debuggerSelectors";
import { formatAddress, formatAddressInput, parseAddress, programCounter, withContextAbove } from "../../state/targets";
import { DisassemblyView, type DisassemblyViewConfig, type DisassemblyViewCallbacks, type DisassemblyViewRef } from "../components/DisassemblyView";
import { NoData, PanelNotice } from "../components/PanelNotice";
import { canResume } from "../../state/stopReasons";
import { Panel } from "../layout/Panel";
import { disassemblyNavigationService } from "../../state/disassemblyNavigationService";
import { generateUUID } from "../../lib/uuid";

interface DisassemblyPanelProps {
  target: TargetProcessor;
}

const DisassemblyPanel = ({ target }: DisassemblyPanelProps) => {
  // instruction size, address format, where the program counter is: what debugger.describe said
  const info = useTarget(target);
  const client = useSessionStore((state) => state.client);
  const initialized = useDebuggerDataStore((state) => state.initialized);
  const hasTick = useDebuggerDataStore((state) => state.ticks > 0);
  const epoch = useDebuggerDataStore((state) => state.epoch);
  const refresh = useDebuggerDataStore((state) => state.refresh);
  const steppable = useDebuggerDataStore((state) => canResume(state.executionState?.reason));
  const breakpoints = useDebuggerDataStore((state) => state.breakpoints);
  const categoryState = useDebuggerDataStore((state) => state.categories[target]);
  const addBreakpoint = useDebuggerDataStore((state) => state.addBreakpoint);
  const removeBreakpoint = useDebuggerDataStore((state) => state.removeBreakpoint);
  const toggleBreakpoint = useDebuggerDataStore((state) => state.toggleBreakpoint);
  const toggleCategoryMute = useDebuggerDataStore((state) => state.toggleCategoryMute);
  const toggleCategorySolo = useDebuggerDataStore((state) => state.toggleCategorySolo);
  const control = useDebuggerDataStore((state) => state.control);
  const runState = useRunState();
  const currentPc = useProgramCounter(info);
  const noDataText = useNoDataText();
  const viewRef = useRef<DisassemblyViewRef>(null);
  const panelIdRef = useRef(generateUUID());

  // Where the view opens: where the target is in the first tick this panel sees, with ten
  // instructions of context above it, or at the target's default address when that tick does
  // not say (no game loaded, or a core that does not report its registers while it runs).
  // Decided once: after that the view moves when the user moves it and when the target stops.
  // A panel that was there before the connection sees its first tick; one that is opened
  // later sees what the latest tick said.
  //
  // When that tick is of a stop (a client that connects into one; a panel opened while the
  // target is stopped), the stop is followed like every later one: the view has the line of
  // its program counter on screen, which `stopPc` asks of it.
  const [opening, setOpening] = useState<{ address: number; stopPc?: number } | undefined>(undefined);
  const firstAddress = opening?.address;
  const [waitedForConnection] = useState(() => useDebuggerDataStore.getState().ticks === 0);
  /** what the view was last brought up to date with: connection and `refresh` */
  const followed = useRef<string | undefined>(undefined);
  const ready = initialized && hasTick && info.supported;
  useEffect(() => {
    if (!ready || opening !== undefined) {
      return;
    }
    const state = useDebuggerDataStore.getState();
    const first = waitedForConnection ? state.first : undefined;
    const pc = programCounter(first ? first.registers : state.registersByPath, info);
    followed.current = `${state.epoch}:${first ? first.refresh : state.refresh}`;
    // the first tick of a connection counts a stop when it is one, and nothing else
    const stopped = first ? first.refresh > 0 : state.executionState?.state === "paused";
    const fallback = Math.min(info.defaultDisassemblyAddress, info.addressMax);
    setOpening(
      pc !== undefined
        ? { address: withContextAbove(info, pc), stopPc: stopped ? pc : undefined }
        : { address: fallback - (fallback % info.instructionSize) },
    );
  }, [ready, opening, info, waitedForConnection]);

  // A stop the client has not acted on yet (stopId changed), or a game that was just loaded:
  // fetch again, and scroll to the program counter if its line is not on screen. Ticks that are
  // not a new stop, such as the one that follows a breakpoint or a watch being added, move
  // nothing and fetch nothing.
  //
  // Not in the render of the tick, but from a timer that the next stop cancels. A server can
  // send stops faster than the page renders them (somebody steps through another client, or
  // a script does), and then their ticks are queued in the page: the timer of each is behind
  // the tick of the next, so the view goes to the latest stop only, once the queue is worked
  // off. It also keeps the render of a tick from setting state: React counts renders that
  // follow each other without a pause, and throws at the fifty-first.
  useEffect(() => {
    if (firstAddress === undefined || !initialized) {
      return;
    }
    const current = `${epoch}:${refresh}`;
    if (followed.current === current) {
      return;
    }
    const timer = setTimeout(() => {
      const view = viewRef.current;
      if (!view) {
        return;
      }
      followed.current = current;
      // A connection that has had no stop yet is a new one whose target runs: there is nothing
      // to follow, and the view keeps the place it had before the connection was lost. (It
      // reads its lines again by itself when the server has been described.)
      if (refresh === 0) {
        return;
      }
      view.followPc(programCounter(useDebuggerDataStore.getState().registersByPath, info));
    }, 0);
    return () => clearTimeout(timer);
  }, [firstAddress, refresh, epoch, initialized, info]);

  // Map addresses to breakpoints
  const breakpointsByAddress = useMemo(() => {
    const map = new Map<number, { id: number; enabled: boolean }>();
    for (const bp of breakpoints) {
      if (bp.kind === "code" && bp.event === info.breakpointEvent && bp.address !== undefined) {
        map.set(bp.address, { id: bp.id, enabled: bp.enabled });
      }
    }
    return map;
  }, [breakpoints, info.breakpointEvent]);

  // Build configuration
  const config: DisassemblyViewConfig = useMemo(() => {
    const isDsp = target === "dsp";
    // as wide as the longest address of the target, and as its bytes ("5A 89"), with a character to spare
    const addressColumn = `${formatAddress(info, info.addressMax).length + 1}ch`;
    const bytesColumn = `${info.instructionSize * 3}ch`;
    // what is left is the instruction's, and never less than twelve characters
    const instructionColumn = "minmax(12ch, 1fr)";
    return {
      instructionSize: info.instructionSize,
      maxAddress: info.addressMax,
      formatAddressInput: (value: number) => formatAddressInput(info, value),
      formatAddressDisplay: (value: number) => formatAddress(info, value),
      parseAddressInput: (input: string) => parseAddress(info, input),
      gridColumns: isDsp ? `24px ${addressColumn} ${instructionColumn}` : `24px ${addressColumn} ${bytesColumn} ${instructionColumn}`,
      stepLabel: isDsp ? "Step" : "Step Over",
      stepIcon: isDsp ? ArrowForwardIcon : SubdirectoryArrowRightIcon,
      showStepInOut: target === "sh4" || target === "arm7",
      urlParamName: isDsp ? "step" : "address",
      showBytes: !isDsp,
      steppingNotice: info.stepping
        ? undefined
        : `This server cannot step the ${info.label} or set code breakpoints on it.`,
    };
  }, [target, info]);

  // Build callbacks. They do not depend on the run state: a view that fetched again whenever
  // these changed would fetch with every pause and resume.
  const callbacks: DisassemblyViewCallbacks = useMemo(
    () => ({
      onFetchDisassembly: async (address: number, count: number) => {
        if (!client) {
          throw new Error("Client not connected");
        }
        const result = await client.fetchDisassembly({ target, address, count });
        return result.lines;
      },
      // a refusal of the server is shown by `control`
      onStep: async () => {
        await control(target === "dsp" ? "step" : "stepOver", target);
      },
      onStepIn: async () => {
        await control("step", target);
      },
      onStepOut: async () => {
        await control("stepOut", target);
      },
      onBreakpointAdd: async (address: number) => {
        await addBreakpoint(info.breakpointEvent, address, "code");
      },
      onBreakpointRemove: async (id: number) => {
        await removeBreakpoint(id);
      },
      onBreakpointToggle: async (id: number, enabled: boolean) => {
        await toggleBreakpoint(id, enabled);
      },
      onMuteToggle: () => {
        void toggleCategoryMute(target);
      },
      onSoloToggle: () => {
        void toggleCategorySolo(target);
      },
    }),
    [client, target, info.breakpointEvent, control, addBreakpoint, removeBreakpoint, toggleBreakpoint, toggleCategoryMute, toggleCategorySolo],
  );

  // Register with navigation service. The view's handle changes with its state, so what is
  // registered asks for the current one each time.
  useEffect(() => {
    const panelId = panelIdRef.current;
    disassemblyNavigationService.register(panelId, {
      scrollToAddress: (address, highlight) => viewRef.current?.scrollToAddress(address, highlight),
      focus: () => viewRef.current?.focus(),
      getSize: () => viewRef.current?.getSize() ?? { width: 0, height: 0 },
      getTarget: () => target,
    });
    return () => {
      disassemblyNavigationService.unregister(panelId);
    };
  }, [target]);

  // said for as long as that server is the one of this page, connected or not
  if (!info.supported) {
    return (
      <Panel>
        <PanelNotice>This server does not support the {info.label} target.</PanelNotice>
      </Panel>
    );
  }
  // A view has no place before a server has said where its target is. Once it has one it
  // stays, with its toolbar and where it was, through every loss of the connection.
  if (firstAddress === undefined) {
    return (
      <Panel>
        <NoData />
      </Panel>
    );
  }

  return (
    <DisassemblyView
      ref={viewRef}
      config={config}
      callbacks={callbacks}
      defaultAddress={firstAddress}
      openingStopPc={opening?.stopPc}
      currentPc={currentPc}
      breakpointsByAddress={breakpointsByAddress}
      initialized={initialized}
      executionState={runState === "paused" ? "paused" : "running"}
      categoryState={categoryState}
      target={target}
      followOnPause={false}
      refetchAfterBreakpointEdit
      canStep={steppable}
      noDataText={noDataText}
    />
  );
};

export const Sh4DisassemblyPanel = () => <DisassemblyPanel target="sh4" />;

export const Arm7DisassemblyPanel = () => <DisassemblyPanel target="arm7" />;

export const DspDisassemblyPanel = () => <DisassemblyPanel target="dsp" />;
