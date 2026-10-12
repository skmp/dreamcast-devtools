import { useEffect, useCallback, useMemo, useState, useRef } from "react";
import { AppBar, Box, Button, Divider, IconButton, Link, Stack, Switch, Typography, Alert } from "@mui/material";
import { HideOnHoverTooltip as Tooltip } from "../components";
import { lazyImport } from "../components/lazyImport";
import { RunControlButton } from "../components/RunControlButton";
import PowerSettingsNewIcon from "@mui/icons-material/PowerSettingsNew";
import CloudDoneIcon from "@mui/icons-material/CloudDone";
import CloudOffIcon from "@mui/icons-material/CloudOff";
import SyncIcon from "@mui/icons-material/Sync";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import LightModeIcon from "@mui/icons-material/LightMode";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import PauseIcon from "@mui/icons-material/Pause";
import SkipNextIcon from "@mui/icons-material/SkipNext";
import { useSessionStore } from "../../state/sessionStore";
import { useDebuggerDataStore } from "../../state/debuggerDataStore";
import { DeviceTreePanel } from "../panels/DeviceTreePanel";
import { WatchesPanel } from "../panels/WatchesPanel";
import { EventLogPanel } from "../panels/EventLogPanel";
import { Sh4DisassemblyPanel, Arm7DisassemblyPanel, DspDisassemblyPanel } from "../panels/DisassemblyPanel";
import { Sh4MemoryPanel, Arm7MemoryPanel } from "../panels/MemoryPanel";
import CallstackPanel from "../panels/CallstackPanel";
import { TaInspectorPanel } from "../panels/TaInspectorPanel";
import { EventsBreakpointsPanel, Sh4BreakpointsPanel, Arm7BreakpointsPanel, DspBreakpointsPanel } from "../panels/BreakpointsPanel";
import { DocumentationPanel } from "../panels/DocumentationPanel";
import {
  BscRegistersPanel,
  CcnRegistersPanel,
  CpgRegistersPanel,
  DmacRegistersPanel,
  IntcRegistersPanel,
  RtcRegistersPanel,
  SciRegistersPanel,
  ScifRegistersPanel,
  TmuRegistersPanel,
  UbcRegistersPanel,
  Sh4RegistersPanel,
  Arm7RegistersPanel,
} from "../panels/Sh4RegisterPanels";
import {
  SqContentsPanel,
  IcacheContentsPanel,
  OcacheContentsPanel,
  OcramContentsPanel,
  TlbContentsPanel,
} from "../panels/Sh4CachePanels";
import { AboutDialog } from "./AboutDialog";
import { ConnectionModal } from "./ConnectionModal";
import { useAboutModal } from "./useAboutModal";
import { TopNav } from "./TopNav";
import { useThemeMode } from "../../theme/ThemeModeProvider";
import { DEBUGGER_VERSION } from "./aboutVersion";
import { DockingLayout, type PanelDefinition } from "./DockingLayout";
import { clearDockingLayout } from "./dockingLayoutStorage";
import type { DockviewApi } from "dockview";
import { PANEL_IDS, PROTOCOL_VERSION, type PanelId } from "../../lib/debuggerSchema";
import { canResume } from "../../state/stopReasons";
import { ExecutionStatus } from "./ExecutionStatus";

// Panels that are large or bring a large dependency (Monaco, the DSP WebAssembly module,
// the WebGL waveform renderer) are fetched when they are first shown. DockingLayout shows a
// placeholder in the panel meanwhile, and the error with a button that reloads the page when
// the download fails.
const AudioPanel = lazyImport(() => import("../panels/AudioPanel").then((module) => ({ default: module.AudioPanel })));
const CoreInspectorPanel = lazyImport(() =>
  import("../panels/CoreInspectorPanel").then((module) => ({ default: module.CoreInspectorPanel })),
);
const Sh4SimPanel = lazyImport(() => import("../panels/Sh4SimPanel").then((module) => ({ default: module.Sh4SimPanel })));
const DspPlaygroundPanel = lazyImport(() =>
  import("../panels/DspPlaygroundPanel").then((module) => ({ default: module.DspPlaygroundPanel })),
);

type StoredLayoutPrefs = {
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
};

const defaultLayoutPrefs: StoredLayoutPrefs = {
  leftPanelOpen: true,
  rightPanelOpen: true,
};

const getLayoutStorageKey = (workspaceId: string) => `nulldc-debugger-layout-${workspaceId}`;

const loadLayoutPrefs = (workspaceId: string): StoredLayoutPrefs => {
  if (typeof window === "undefined") {
    return defaultLayoutPrefs;
  }

  try {
    const raw = window.localStorage.getItem(getLayoutStorageKey(workspaceId));
    if (!raw) {
      return defaultLayoutPrefs;
    }
    const parsed = JSON.parse(raw) as Partial<StoredLayoutPrefs>;
    return {
      leftPanelOpen: parsed.leftPanelOpen ?? defaultLayoutPrefs.leftPanelOpen,
      rightPanelOpen: parsed.rightPanelOpen ?? defaultLayoutPrefs.rightPanelOpen,
    };
  } catch (error) {
    console.warn("Failed to read layout preferences", error);
    return defaultLayoutPrefs;
  }
};

const createLeftPanelTabs = (onOpenPanel?: (panelId: PanelId) => void): PanelDefinition[] => [
  { id: PANEL_IDS.DEVICE_TREE, title: "Device Tree", component: <DeviceTreePanel onOpenPanel={onOpenPanel} /> },
];

const mainTabs: PanelDefinition[] = [
  { id: PANEL_IDS.DOCUMENTATION, title: "Documentation", component: <DocumentationPanel /> },
  { id: PANEL_IDS.SH4_SIM, title: "SH4: Simulator", component: <Sh4SimPanel /> },
  { id: PANEL_IDS.EVENTS, title: "Events: Log", component: <EventLogPanel /> },
  { id: PANEL_IDS.EVENTS_BREAKPOINTS, title: "Events: Breakpoints", component: <EventsBreakpointsPanel /> },
  { id: PANEL_IDS.SH4_DISASSEMBLY, title: "SH4: Disassembly", component: <Sh4DisassemblyPanel /> },
  { id: PANEL_IDS.SH4_MEMORY, title: "SH4: Memory", component: <Sh4MemoryPanel /> },
  { id: PANEL_IDS.SH4_BREAKPOINTS, title: "SH4: Breakpoints", component: <Sh4BreakpointsPanel /> },
  { id: PANEL_IDS.SH4_REGISTERS, title: "SH4: Registers", component: <Sh4RegistersPanel /> },
  { id: PANEL_IDS.SH4_BSC_REGISTERS, title: "SH4: BSC Registers", component: <BscRegistersPanel /> },
  { id: PANEL_IDS.SH4_CCN_REGISTERS, title: "SH4: CCN Registers", component: <CcnRegistersPanel /> },
  { id: PANEL_IDS.SH4_CPG_REGISTERS, title: "SH4: CPG Registers", component: <CpgRegistersPanel /> },
  { id: PANEL_IDS.SH4_DMAC_REGISTERS, title: "SH4: DMAC Registers", component: <DmacRegistersPanel /> },
  { id: PANEL_IDS.SH4_INTC_REGISTERS, title: "SH4: INTC Registers", component: <IntcRegistersPanel /> },
  { id: PANEL_IDS.SH4_RTC_REGISTERS, title: "SH4: RTC Registers", component: <RtcRegistersPanel /> },
  { id: PANEL_IDS.SH4_SCI_REGISTERS, title: "SH4: SCI Registers", component: <SciRegistersPanel /> },
  { id: PANEL_IDS.SH4_SCIF_REGISTERS, title: "SH4: SCIF Registers", component: <ScifRegistersPanel /> },
  { id: PANEL_IDS.SH4_TMU_REGISTERS, title: "SH4: TMU Registers", component: <TmuRegistersPanel /> },
  { id: PANEL_IDS.SH4_UBC_REGISTERS, title: "SH4: UBC Registers", component: <UbcRegistersPanel /> },
  { id: PANEL_IDS.SH4_SQ_CONTENTS, title: "SH4: Store Queues", component: <SqContentsPanel /> },
  { id: PANEL_IDS.SH4_ICACHE_CONTENTS, title: "SH4: ICACHE", component: <IcacheContentsPanel /> },
  { id: PANEL_IDS.SH4_OCACHE_CONTENTS, title: "SH4: OCACHE", component: <OcacheContentsPanel /> },
  { id: PANEL_IDS.SH4_OCRAM_CONTENTS, title: "SH4: OC-RAM", component: <OcramContentsPanel /> },
  { id: PANEL_IDS.SH4_TLB_CONTENTS, title: "SH4: TLB", component: <TlbContentsPanel /> },
  { id: PANEL_IDS.ARM7_DISASSEMBLY, title: "ARM7: Disassembly", component: <Arm7DisassemblyPanel /> },
  { id: PANEL_IDS.ARM7_MEMORY, title: "ARM7: Memory", component: <Arm7MemoryPanel /> },
  { id: PANEL_IDS.ARM7_BREAKPOINTS, title: "ARM7: Breakpoints", component: <Arm7BreakpointsPanel /> },
  { id: PANEL_IDS.ARM7_REGISTERS, title: "ARM7: Registers", component: <Arm7RegistersPanel /> },
  { id: PANEL_IDS.CLX2_TA, title: "CLX2: TA", component: <TaInspectorPanel /> },
  { id: PANEL_IDS.CLX2_CORE, title: "CLX2: CORE", component: <CoreInspectorPanel /> },
  { id: PANEL_IDS.SGC, title: "SGC", component: <AudioPanel /> },
  { id: PANEL_IDS.DSP_DISASSEMBLY, title: "DSP: Disassembly", component: <DspDisassemblyPanel /> },
  { id: PANEL_IDS.DSP_BREAKPOINTS, title: "DSP: Breakpoints", component: <DspBreakpointsPanel /> },
  { id: PANEL_IDS.DSP_PLAYGROUND, title: "DSP: Playground", component: <DspPlaygroundPanel /> },
];

const rightPanelTabs: PanelDefinition[] = [
  { id: PANEL_IDS.WATCHES, title: "Watches", component: <WatchesPanel /> },
  { id: PANEL_IDS.SH4_CALLSTACK, title: "SH4: Callstack", component: <CallstackPanel target="sh4" showTitle={false} /> },
  { id: PANEL_IDS.ARM7_CALLSTACK, title: "ARM7: Callstack", component: <CallstackPanel target="arm7" showTitle={false} /> },
];

const connectionIcons = {
  idle: <CloudOffIcon fontSize="small" />,
  error: <CloudOffIcon fontSize="small" />,
  connecting: <SyncIcon fontSize="small" className="spin" />,
  reconnecting: <SyncIcon fontSize="small" className="spin" />,
  connected: <CloudDoneIcon fontSize="small" />,
};

/** What the server's `protocol` means for this build, when it is not the build's own. */
const protocolMismatch = (protocol: number | undefined): string =>
  protocol === undefined
    ? `This server reports no debugger protocol version; this UI is built for protocol ${PROTOCOL_VERSION}. ` +
      "It is treated as a server that lists no target and no capability: the panels say what is missing. Use the UI that belongs to the emulator."
    : `This server speaks debugger protocol ${protocol}; this UI is built for protocol ${PROTOCOL_VERSION}. ` +
      "Parts of it may not work. Use the UI that belongs to the emulator.";

interface AppLayoutProps {
  workspaceId: string;
}

export const AppLayout = ({ workspaceId }: AppLayoutProps) => {
  const connect = useSessionStore((state) => state.connect);
  const disconnect = useSessionStore((state) => state.disconnect);
  const startDiscovery = useSessionStore((state) => state.startDiscovery);
  const stopDiscovery = useSessionStore((state) => state.stopDiscovery);
  const connectionState = useSessionStore((state) => state.connectionState);
  const connectionError = useSessionStore((state) => state.connectionError);
  const endpoint = useSessionStore((state) => state.endpoint);
  const retry = useSessionStore((state) => state.retry);
  const showConnectionModal = useSessionStore((state) => state.showConnectionModal);
  const setShowConnectionModal = useSessionStore((state) => state.setShowConnectionModal);
  const execution = useDebuggerDataStore((state) => state.executionState);
  const control = useDebuggerDataStore((state) => state.control);
  const toasts = useDebuggerDataStore((state) => state.toasts);
  const dismissToast = useDebuggerDataStore((state) => state.dismissToast);
  const initError = useDebuggerDataStore((state) => state.initError);
  const describeRetry = useDebuggerDataStore((state) => state.describeRetry);
  const retryDescribe = useDebuggerDataStore((state) => state.retryDescribe);
  const invalidMessages = useDebuggerDataStore((state) => state.invalidMessages);
  const dismissInvalidMessages = useDebuggerDataStore((state) => state.dismissInvalidMessages);
  const epoch = useDebuggerDataStore((state) => state.epoch);
  const initialized = useDebuggerDataStore((state) => state.initialized);
  const serverProtocol = useDebuggerDataStore((state) => state.shape?.protocol);
  const [leftPanelOpen, setLeftPanelOpen] = useState(() => loadLayoutPrefs(workspaceId).leftPanelOpen);
  const [rightPanelOpen, setRightPanelOpen] = useState(() => loadLayoutPrefs(workspaceId).rightPanelOpen);
  const [isNarrow, setIsNarrow] = useState(window.innerWidth < 1200);
  const { open: aboutOpen, show: showAbout, hide: hideAbout } = useAboutModal();
  const { mode, toggleMode } = useThemeMode();
  const isDarkMode = mode === "dark";
  // the protocol notice of a connection can be put away; the next connection shows its own
  const [protocolNoticeDismissed, setProtocolNoticeDismissed] = useState<number | null>(null);
  const [mainPanelApiState, setMainPanelApiState] = useState<DockviewApi | null>(null);

  // Use a ref to avoid stale closures
  const mainPanelApiRef = useRef<DockviewApi | null>(null);

  useEffect(() => {
    mainPanelApiRef.current = mainPanelApiState;
  }, [mainPanelApiState]);

  const handleOpenPanelInMain = useCallback((panelId: PanelId) => {
    const api = mainPanelApiRef.current;
    if (!api) {
      return;
    }

    // Find panel definition
    const panelDef = mainTabs.find(p => p.id === panelId) || rightPanelTabs.find(p => p.id === panelId);
    if (!panelDef) {
      return;
    }

    // Check if panel already exists
    const existingPanel = api.getPanel(panelId);
    if (existingPanel) {
      // Focus the existing panel
      existingPanel.api.setActive();
      return;
    }

    // Get the currently active group to add the panel next to it
    const activeGroup = api.activeGroup;

    // Add the panel to the main view
    if (activeGroup) {
      api.addPanel({
        id: panelId,
        component: panelId,
        title: panelDef.title,
        position: {
          referenceGroup: activeGroup,
          direction: 'within',
        },
      });
    } else {
      api.addPanel({
        id: panelId,
        component: panelId,
        title: panelDef.title,
      });
    }
  }, []);

  const leftPanelTabs = useMemo(() => createLeftPanelTabs(handleOpenPanelInMain), [handleOpenPanelInMain]);

  const allPanels = useMemo(() => {
    return [...leftPanelTabs, ...mainTabs, ...rightPanelTabs];
  }, [leftPanelTabs]);

  const workspaceTabs = useMemo(() => {
    // Custom initial panels based on workspace
    if (workspaceId === 'sh4-debugger') {
      return [
        { id: PANEL_IDS.SH4_DISASSEMBLY, title: "SH4: Disassembly", component: <Sh4DisassemblyPanel /> },
        { id: PANEL_IDS.SH4_MEMORY, title: "SH4: Memory", component: <Sh4MemoryPanel /> },
        { id: PANEL_IDS.SH4_BREAKPOINTS, title: "SH4: Breakpoints", component: <Sh4BreakpointsPanel /> },
        // a tab behind the breakpoints, which stay the panel their group shows
        { id: PANEL_IDS.SH4_REGISTERS, title: "SH4: Registers", component: <Sh4RegistersPanel /> },
      ];
    }

    if (workspaceId === 'arm7-debugger') {
      return [
        { id: PANEL_IDS.ARM7_DISASSEMBLY, title: "ARM7: Disassembly", component: <Arm7DisassemblyPanel /> },
        { id: PANEL_IDS.ARM7_MEMORY, title: "ARM7: Memory", component: <Arm7MemoryPanel /> },
        { id: PANEL_IDS.ARM7_BREAKPOINTS, title: "ARM7: Breakpoints", component: <Arm7BreakpointsPanel /> },
        { id: PANEL_IDS.ARM7_REGISTERS, title: "ARM7: Registers", component: <Arm7RegistersPanel /> },
      ];
    }

    if (workspaceId === 'audio-debugger') {
      return [
        { id: PANEL_IDS.SGC, title: "SGC", component: <AudioPanel /> },
        { id: PANEL_IDS.DSP_DISASSEMBLY, title: "DSP: Disassembly", component: <DspDisassemblyPanel /> },
        { id: PANEL_IDS.DSP_BREAKPOINTS, title: "DSP: Breakpoints", component: <DspBreakpointsPanel /> },
      ];
    }

    if (workspaceId === 'mixed-mode-debugger') {
      return [
        { id: PANEL_IDS.SH4_DISASSEMBLY, title: "SH4: Disassembly", component: <Sh4DisassemblyPanel /> },
        { id: PANEL_IDS.ARM7_DISASSEMBLY, title: "ARM7: Disassembly", component: <Arm7DisassemblyPanel /> },
      ];
    }

    return mainTabs;
  }, [workspaceId]);

  const rightPanelTabsForWorkspace = useMemo(() => {
    if (workspaceId === 'sh4-debugger') {
      return [
        { id: PANEL_IDS.WATCHES, title: "Watches", component: <WatchesPanel /> },
        { id: PANEL_IDS.SH4_CALLSTACK, title: "SH4: Callstack", component: <CallstackPanel target="sh4" showTitle={false} /> },
      ];
    }
    if (workspaceId === 'arm7-debugger') {
      return [
        { id: PANEL_IDS.WATCHES, title: "Watches", component: <WatchesPanel /> },
        { id: PANEL_IDS.ARM7_CALLSTACK, title: "ARM7: Callstack", component: <CallstackPanel target="arm7" showTitle={false} /> },
      ];
    }
    if (workspaceId === 'audio-debugger') {
      return [
        { id: PANEL_IDS.WATCHES, title: "Watches", component: <WatchesPanel /> },
      ];
    }
    if (workspaceId === 'mixed-mode-debugger') {
      return [
        { id: PANEL_IDS.WATCHES, title: "Watches", component: <WatchesPanel /> },
        { id: PANEL_IDS.SH4_CALLSTACK, title: "SH4: Callstack", component: <CallstackPanel target="sh4" showTitle={false} /> },
        { id: PANEL_IDS.ARM7_CALLSTACK, title: "ARM7: Callstack", component: <CallstackPanel target="arm7" showTitle={false} /> },
      ];
    }
    return rightPanelTabs;
  }, [workspaceId]);

  const showLeftPanel = !isNarrow && leftPanelOpen;
  const showRightPanel = !isNarrow && rightPanelOpen;
  const showLeftToggle = !isNarrow;
  const showRightToggle = !isNarrow;

  // Load layout preferences when workspaceId changes
  useEffect(() => {
    const prefs = loadLayoutPrefs(workspaceId);
    setLeftPanelOpen(prefs.leftPanelOpen);
    setRightPanelOpen(prefs.rightPanelOpen);
  }, [workspaceId]);

  useEffect(() => {
    const handleResize = () => {
      setIsNarrow(window.innerWidth < 1200);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const prefs: StoredLayoutPrefs = {
      leftPanelOpen,
      rightPanelOpen,
    };

    try {
      window.localStorage.setItem(getLayoutStorageKey(workspaceId), JSON.stringify(prefs));
    } catch (error) {
      console.warn("Failed to persist layout preferences", error);
    }
  }, [leftPanelOpen, rightPanelOpen, workspaceId]);

  // Start discovery on mount
  useEffect(() => {
    startDiscovery();
    return () => {
      stopDiscovery();
    };
  }, [startDiscovery, stopDiscovery]);

  // Connect to the endpoint of this page: ?ws=, the last manual entry, VITE_WS_URL, same-origin
  // /ws. The session store describes the server whenever a connection opens.
  useEffect(() => {
    void connect();
  }, [connect]);

  const handleToggleConnection = useCallback(() => {
    if (connectionState === "connected") {
      disconnect();
    } else {
      void connect({ force: true });
    }
  }, [connectionState, disconnect, connect]);

  const handleToggleTheme = useCallback(() => {
    toggleMode();
  }, [toggleMode]);

  const handleResetLayout = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      // Clear all layout storage (including narrow/wide variants)
      window.localStorage.removeItem(getLayoutStorageKey(workspaceId));
      clearDockingLayout(workspaceId); // Center panel (wide)
      clearDockingLayout(`${workspaceId}-narrow`); // Center panel (narrow)
      clearDockingLayout(`${workspaceId}-left`); // Left panel
      clearDockingLayout(`${workspaceId}-right`); // Right panel

      // Reset panel state to defaults before reload
      const prefs: StoredLayoutPrefs = defaultLayoutPrefs;
      window.localStorage.setItem(getLayoutStorageKey(workspaceId), JSON.stringify(prefs));

      // Reload to reset docking layout
      window.location.reload();
    } catch (error) {
      console.warn("Failed to clear layout preferences", error);
    }
  }, [workspaceId]);

  // The server answers a control request as soon as it is armed; the ticks report what then
  // happens. A refusal (no game loaded, stopped in the emulator's window, ...) is shown.
  const handleRun = useCallback(() => void control("run"), [control]);
  const handlePause = useCallback(() => void control("pause", "sh4"), [control]);

  const connected = connectionState === "connected";
  const runState = connected ? execution?.state : undefined;
  const resumable = runState === "paused" && canResume(execution?.reason);

  return (
    <Box sx={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <AppBar position="static" elevation={1} color="default">
        <TopNav
          onAboutClick={showAbout}
          onResetLayout={handleResetLayout}
          currentPage={workspaceId}
          centerSection={
            <Box sx={{ position: "relative" }}>
              <Stack direction="row" spacing={1} alignItems="center">
                {/* The tooltip is on the button itself: its title is the button's name. (A button
                    that cannot be used is not `disabled`, so it needs no element around it to
                    carry the tooltip.) */}
                <Tooltip title="Run">
                  <RunControlButton size="small" color="success" disabled={!resumable} onClick={handleRun}>
                    <PlayArrowIcon />
                  </RunControlButton>
                </Tooltip>
                <Tooltip title="Pause">
                  <RunControlButton size="small" color="warning" disabled={runState !== "running"} onClick={handlePause}>
                    <PauseIcon />
                  </RunControlButton>
                </Tooltip>
                <Tooltip title="Run to next breakpoint">
                  <RunControlButton size="small" color="primary" disabled={!resumable} onClick={handleRun}>
                    <SkipNextIcon />
                  </RunControlButton>
                </Tooltip>
              </Stack>
              {/* next to the run controls: why the target is stopped, and what the server has to say */}
              {connected && initialized && <ExecutionStatus placement="beside" />}
            </Box>
          }
          rightSection={
            <Stack direction="row" spacing={1.5} alignItems="center">
              <Stack direction="row" spacing={0.5} alignItems="center">
                {isDarkMode ? (
                  <DarkModeIcon fontSize="small" color="primary" />
                ) : (
                  <LightModeIcon fontSize="small" color="warning" />
                )}
                <Tooltip title={isDarkMode ? "Dark mode" : "Light mode"}>
                  <Switch
                    size="small"
                    checked={isDarkMode}
                    onChange={handleToggleTheme}
                    // MUI 7 replaces its own { role: "switch" } with slotProps.input and
                    // drops the deprecated inputProps, so both have to be given here
                    slotProps={{ input: { role: "switch", "aria-label": "Toggle dark mode" } }}
                  />
                </Tooltip>
              </Stack>
              <Tooltip title={`Connection: ${connectionState}`}>
                <IconButton color={connected ? "primary" : "inherit"}>
                  {connectionIcons[connectionState]}
                </IconButton>
              </Tooltip>
              <Button
                variant="outlined"
                color="inherit"
                onClick={handleToggleConnection}
                startIcon={<PowerSettingsNewIcon fontSize="small" />}
              >
                {connected ? "Disconnect" : "Connect"}
              </Button>
            </Stack>
          }
        />
        {/* the same, for a window in which the toolbar has no room for it */}
        {connected && initialized && <ExecutionStatus placement="below" />}
      </AppBar>
      {connectionState === "reconnecting" ? (
        <Alert
          severity="warning"
          sx={{ borderRadius: 0 }}
          action={
            <>
              <Button color="inherit" size="small" onClick={() => void connect({ force: true })}>
                Retry now
              </Button>
              <Button color="inherit" size="small" onClick={disconnect}>
                Stop
              </Button>
            </>
          }
        >
          {connectionError ?? "Connection lost"}.{" "}
          {retry?.waitingForAnnouncement
            ? "Waiting for the emulator to announce itself."
            : retry?.delayMs !== undefined
              ? `Reconnecting to ${endpoint ?? "the server"} in ${retry.delayMs / 1000} s (attempt ${retry.attempt}).`
              : `Reconnecting to ${endpoint ?? "the server"} (attempt ${retry?.attempt ?? 1}).`}
        </Alert>
      ) : (
        connectionError && (
          <Alert severity="error" sx={{ borderRadius: 0 }}>
            {connectionError}
          </Alert>
        )
      )}
      {initError && (
        // the connection is there and the server could not be described: it is asked again
        <Alert
          severity="error"
          sx={{ borderRadius: 0 }}
          action={
            describeRetry && (
              <Button color="inherit" size="small" onClick={retryDescribe}>
                Retry now
              </Button>
            )
          }
        >
          {initError}.{" "}
          {describeRetry
            ? `Asking again in ${describeRetry.delayMs / 1000} s (attempt ${describeRetry.attempt}).`
            : "Asking again."}
        </Alert>
      )}
      {connected && initialized && serverProtocol !== PROTOCOL_VERSION && protocolNoticeDismissed !== epoch && (
        <Alert severity="warning" sx={{ borderRadius: 0 }} onClose={() => setProtocolNoticeDismissed(epoch)}>
          {protocolMismatch(serverProtocol)}
        </Alert>
      )}
      {invalidMessages && (
        <Alert severity="warning" sx={{ borderRadius: 0 }} onClose={dismissInvalidMessages}>
          {invalidMessages.count === 1
            ? "The server sent a message this UI could not use, and it was dropped"
            : `The server sent ${invalidMessages.count} messages this UI could not use, and they were dropped`}
          : {invalidMessages.last.message}
        </Alert>
      )}
      <Box sx={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <Box
          sx={{
            flex: 1,
            overflow: "hidden",
            display: "flex",
            gap: 1,
            p: 1,
            position: "relative",
          }}
        >
          {showLeftPanel && (
            <Box sx={{ minHeight: 0, width: 280 }}>
              <DockingLayout
                key={`${workspaceId}-left`}
                panels={leftPanelTabs}
                allPanels={allPanels}
                workspaceId={`${workspaceId}-left`}
              />
            </Box>
          )}
          {showLeftToggle && (
            <Box sx={{ display: "flex", alignItems: "center" }}>
              <Tooltip title={leftPanelOpen ? "Hide left panel" : "Show left panel"}>
                <IconButton onClick={() => setLeftPanelOpen(!leftPanelOpen)} size="small">
                  {leftPanelOpen ? <ChevronLeftIcon /> : <ChevronRightIcon />}
                </IconButton>
              </Tooltip>
            </Box>
          )}
          <Box
            sx={{
              minHeight: 0,
              minWidth: 0,
              flex: 1,
            }}
          >
            <DockingLayout
              key={`${workspaceId}${isNarrow ? '-narrow' : ''}`}
              panels={workspaceTabs}
              allPanels={allPanels}
              workspaceId={`${workspaceId}${isNarrow ? '-narrow' : ''}`}
              onReady={setMainPanelApiState}
              defaultLayoutMode={
                workspaceId === 'mixed-mode-debugger' ? 'mixed-mode-debugger-layout' :
                workspaceId === 'sh4-debugger' || workspaceId === 'arm7-debugger' || workspaceId === 'audio-debugger' ? 'sh4-layout' :
                'tabs'
              }
            />
          </Box>
          {showRightToggle && (
            <Box sx={{ display: "flex", alignItems: "center" }}>
              <Tooltip title={rightPanelOpen ? "Hide right panel" : "Show right panel"}>
                <IconButton onClick={() => setRightPanelOpen(!rightPanelOpen)} size="small">
                  {rightPanelOpen ? <ChevronRightIcon /> : <ChevronLeftIcon />}
                </IconButton>
              </Tooltip>
            </Box>
          )}
          {showRightPanel && (
            <Box sx={{ minHeight: 0, width: 340 }}>
              <DockingLayout
                key={`${workspaceId}-right`}
                panels={rightPanelTabsForWorkspace}
                allPanels={allPanels}
                workspaceId={`${workspaceId}-right`}
                defaultLayoutMode="vertical-stack"
              />
            </Box>
          )}
        </Box>
      </Box>
      <Divider />
      <Box
        component="footer"
        sx={{
          px: 2,
          py: 0.75,
          display: "flex",
          alignItems: "center",
          gap: 2,
          typography: "caption",
          color: "text.secondary",
        }}
      >
        <Typography variant="caption">Connection: {connectionState}</Typography>
        <Divider orientation="vertical" flexItem />
        {/* A button: the connection picker behind it is the only way to the box for another
            endpoint, and has to open from the keyboard too. The tooltip describes it; its name
            is what it shows. */}
        <Tooltip title="Click to change connection" describeChild>
          <Link
            component="button"
            type="button"
            variant="caption"
            color="inherit"
            underline="hover"
            onClick={() => setShowConnectionModal(true)}
          >
            Endpoint: {endpoint ?? "-"}
          </Link>
        </Tooltip>
        <Box sx={{ flexGrow: 1 }} />
        <Typography variant="caption">nullDC Debugger {DEBUGGER_VERSION}</Typography>
      </Box>
      <AboutDialog open={aboutOpen} onClose={hideAbout} />
      <ConnectionModal open={showConnectionModal} onClose={() => setShowConnectionModal(false)} />
      <Box
        sx={{
          position: "fixed",
          bottom: 16,
          right: 16,
          zIndex: 9999,
          display: "flex",
          flexDirection: "column-reverse",
          gap: 1,
          pointerEvents: "none",
        }}
      >
        {toasts.map((toast) => (
          <Alert
            key={toast.id}
            severity={toast.type}
            variant="filled"
            onClose={() => dismissToast(toast.id)}
            sx={{ pointerEvents: "auto" }}
          >
            {toast.message}
            {/* raised again while it was up: counted here instead of shown again */}
            {toast.count > 1 && ` (×${toast.count})`}
          </Alert>
        ))}
      </Box>
    </Box>
  );
};
