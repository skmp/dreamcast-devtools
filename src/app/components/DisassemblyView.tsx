import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Box, Button, CircularProgress, IconButton, InputAdornment, Paper, Stack, TextField, Typography } from "@mui/material";
import { HideOnHoverTooltip as Tooltip } from "./HideOnHoverTooltip";
import { RunControlButton } from "./RunControlButton";
import CircleIcon from "@mui/icons-material/Circle";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import RadioButtonCheckedIcon from "@mui/icons-material/RadioButtonChecked";
import MyLocationIcon from "@mui/icons-material/MyLocation";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import ArrowDownwardRoundedIcon from "@mui/icons-material/ArrowDownwardRounded";
import ArrowUpwardRoundedIcon from "@mui/icons-material/ArrowUpwardRounded";
import VolumeOffIcon from "@mui/icons-material/VolumeOff";
import VolumeUpIcon from "@mui/icons-material/VolumeUp";
import RefreshIcon from "@mui/icons-material/Refresh";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import PauseIcon from "@mui/icons-material/Pause";
import type { DisassemblyLine } from "../../lib/debuggerSchema";
import { uniqueLines } from "./disassemblyLines";

const WHEEL_PIXEL_THRESHOLD = 60;
const INSTRUCTIONS_PER_TICK = 6;
/** How many lines a view asks for, from the address it starts at. */
const LINES_PER_FETCH = 64;

export interface DisassemblyViewConfig {
  /** Instruction size in bytes (e.g., 2 for SH4, 4 for ARM7, 1 for DSP) */
  instructionSize: number;
  /** Maximum address value for this target */
  maxAddress: number;
  /** Format an address value for input field display */
  formatAddressInput: (value: number) => string;
  /** Format an address value for disassembly line display */
  formatAddressDisplay: (value: number) => string;
  /** Parse an address string from user input */
  parseAddressInput: (input: string) => number | undefined;
  /**
   * Column widths for the grid layout. The columns in front of the instruction are as wide as
   * what they hold, and the instruction column has a minimum: in a narrow panel it is the
   * instruction that has to stay readable.
   */
  gridColumns: string;
  /** Label for the primary step button */
  stepLabel: string;
  /** Icon for the primary step button */
  stepIcon: typeof ArrowForwardIcon;
  /** Whether to show step in/out buttons */
  showStepInOut: boolean;
  /** URL parameter name for address (e.g., "address" or "step") */
  urlParamName: string;
  /** Whether to show the opcode/bytes column (default: true) */
  showBytes?: boolean;
  /** Whether to show mute/solo buttons (default: true) */
  showMuteSolo?: boolean;
  /**
   * The server cannot step this target or set code breakpoints on it: this is said in place
   * of the step buttons, the mute/solo buttons and the breakpoint gutter. The listing works.
   */
  steppingNotice?: string;
  /** Icon for the run/pause button */
  runPauseIcon?: { paused: typeof ArrowForwardIcon; running: typeof ArrowForwardIcon };
  /** Label for the run/pause button */
  runPauseLabel?: { paused: string; running: string };
  /** Prefix action buttons to show before step buttons (after run/pause) */
  prefixActions?: Array<{
    key: string;
    icon: typeof ArrowForwardIcon;
    label: string;
    disabled?: boolean;
    onClick: () => void;
  }>;
  /** Extra action buttons to show after step buttons */
  extraActions?: Array<{
    key: string;
    icon: typeof ArrowForwardIcon;
    label: string;
    disabled?: boolean;
    onClick: () => void;
  }>;
}

export interface DisassemblyViewCallbacks {
  /** Fetch disassembly lines starting at the given address */
  onFetchDisassembly: (address: number, count: number) => Promise<DisassemblyLine[]>;
  /** Handle primary step action (Step or Step Over depending on target) */
  onStep: () => Promise<void>;
  /** Handle step in action */
  onStepIn?: () => Promise<void>;
  /** Handle step out action */
  onStepOut?: () => Promise<void>;
  /** Add a breakpoint at the given address */
  onBreakpointAdd: (address: number) => Promise<void>;
  /** Remove a breakpoint by ID */
  onBreakpointRemove: (id: number) => Promise<void>;
  /** Toggle a breakpoint's enabled state */
  onBreakpointToggle: (id: number, enabled: boolean) => Promise<void>;
  /** Handle mute toggle for this view's category */
  onMuteToggle: () => void;
  /** Handle solo toggle for this view's category */
  onSoloToggle: () => void;
  /** Handle run/pause toggle (if provided, run/pause button will be shown) */
  onRunPauseToggle?: () => void;
}

export interface DisassemblyViewProps {
  /** Configuration for address formatting and display */
  config: DisassemblyViewConfig;
  /** Callbacks for all actions */
  callbacks: DisassemblyViewCallbacks;
  /** Default address to start at */
  defaultAddress: number;
  /**
   * The view opens in a stop of the target, at this program counter: like the program counter
   * of every later stop (`followPc`), its line has to be on screen once the first lines are
   * in. Ten instructions above it are where the view starts, and in a short panel, or one
   * whose lines wrap, that leaves the line itself below what the panel shows.
   */
  openingStopPc?: number;
  /** Current program counter value */
  currentPc?: number;
  /** Map of addresses to breakpoint info */
  breakpointsByAddress: Map<number, { id: number; enabled: boolean }>;
  /** Whether the debugger is initialized */
  initialized: boolean;
  /** Current execution state */
  executionState: "running" | "paused";
  /** Category state (muted/soloed) */
  categoryState?: { muted: boolean; soloed: boolean };
  /** Target CPU type for registration in navigation service */
  target?: "sh4" | "arm7" | "dsp";
  /**
   * Scroll to the program counter whenever the state changes from running to paused
   * (default: true). A caller that knows the stops of its target turns this off and calls
   * `followPc` for each of them instead.
   */
  followOnPause?: boolean;
  /** Fetch the lines again, without moving, after a breakpoint was added, removed or toggled here (default: false). */
  refetchAfterBreakpointEdit?: boolean;
  /** false: the step buttons are disabled although the target is paused (default: true). */
  canStep?: boolean;
  /** What is said in place of the lines while the view is not `initialized` (default: "No Data"). */
  noDataText?: string;
  /**
   * The view has no place yet: no server has said where its target is. It is the frame of the
   * view and nothing else: the toolbar, with a box that is empty and controls that cannot be
   * used, and `noDataText` where the lines will be.
   */
  unplaced?: boolean;
}

export interface DisassemblyViewRef {
  /**
   * The target stopped at `pc`: fetch the lines again, and scroll to it (ten instructions of
   * context above) unless its line is already on screen.
   */
  followPc: (pc: number | undefined) => void;
  scrollToAddress: (address: number, highlight?: boolean) => void;
  focus: () => void;
  getSize: () => { width: number; height: number };
  getTarget: () => string;
}

const normalizeAddress = (value: number, max: number, step: number) => {
  const clamped = Math.min(Math.max(0, value), max);
  if (step <= 1) {
    return clamped;
  }
  return clamped - (clamped % step);
};

interface DisassemblyLineItemProps {
  line: DisassemblyLine;
  breakpoint?: { id: number; enabled: boolean };
  config: DisassemblyViewConfig;
  onBreakpointClick: (address: number) => void;
  onBreakpointToggle: (address: number, event: React.MouseEvent) => void;
  lineRef: (address: number, el: HTMLDivElement | null) => void;
}

// A line renders again only when its text or its breakpoint changes. The marker of the current
// instruction is a class the view sets on the element (see the effect on `currentPc`), so a
// program counter that moves five times a second renders nothing.
const DisassemblyLineItem = memo(({
  line,
  breakpoint,
  config,
  onBreakpointClick,
  onBreakpointToggle,
  lineRef,
}: DisassemblyLineItemProps) => {
  const hasBreakpoint = !!breakpoint;
  const breakpointEnabled = breakpoint?.enabled ?? false;
  const gutter = config.steppingNotice === undefined;

  return (
    <Box
      ref={(el: HTMLDivElement | null) => lineRef(line.address, el)}
      data-address={line.address}
      sx={{
        // the font of the cells, so that a `ch` in the column widths is a character of theirs
        typography: "body1",
        display: "grid",
        gridTemplateColumns: config.gridColumns,
        gap: 1,
        alignItems: "stretch",
        px: 0.5,
        py: 0,
        border: "2px solid transparent",
        borderRadius: 1,
        "&:hover": {
          borderBottomColor: "primary.main",
        },
        "&:hover .breakpoint-gutter": {
          opacity: 1,
        },
      }}
    >
      {gutter ? (
        <Box
          className="breakpoint-gutter"
          data-breakpoint={hasBreakpoint ? (breakpointEnabled ? "enabled" : "disabled") : "none"}
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: hasBreakpoint ? 1 : 0,
            cursor: "pointer",
            transition: "opacity 0.1s",
            alignSelf: "stretch",
          }}
          onClick={(e) => {
            if ((e.shiftKey || e.ctrlKey || e.metaKey) && hasBreakpoint) {
              onBreakpointToggle(line.address, e);
            } else {
              onBreakpointClick(line.address);
            }
          }}
        >
          {hasBreakpoint ? (
            breakpointEnabled ? (
              <CircleIcon sx={{ fontSize: 16, color: "error.main" }} />
            ) : (
              <RadioButtonUncheckedIcon sx={{ fontSize: 16, color: "error.main" }} />
            )
          ) : (
            <RadioButtonUncheckedIcon sx={{ fontSize: 16, color: "text.disabled", opacity: 0.3 }} />
          )}
        </Box>
      ) : (
        // no breakpoints on this target: the column stays, for the alignment of the others
        <span />
      )}
      <Typography component="span" sx={{ color: "text.secondary" }}>
        {config.formatAddressDisplay(line.address)}
      </Typography>
      {(config.showBytes ?? true) && (
        <Typography component="span" sx={{ color: "text.secondary" }}>
          {line.bytes}
        </Typography>
      )}
      <Typography component="span" sx={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {line.disassembly}
      </Typography>
    </Box>
  );
});

DisassemblyLineItem.displayName = "DisassemblyLineItem";

export const DisassemblyView = forwardRef<DisassemblyViewRef, DisassemblyViewProps>(({
  config,
  callbacks,
  defaultAddress,
  openingStopPc,
  currentPc,
  breakpointsByAddress,
  initialized,
  executionState,
  categoryState,
  target,
  followOnPause = true,
  refetchAfterBreakpointEdit = false,
  canStep = true,
  noDataText = "No Data",
  unplaced = false,
}, ref) => {
  const [lines, setLines] = useState<DisassemblyLine[]>([]);
  // how many lines of the answer on screen repeated an address, and were left out
  const [repeated, setRepeated] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // The request whose answer (lines, or an error) is on screen, and the address it asked for.
  const [answered, setAnswered] = useState<{ requestId: number; address: number } | undefined>(undefined);

  // Initialize address from default
  const [address, setAddress] = useState(defaultAddress);
  const [addressInput, setAddressInput] = useState(config.formatAddressInput(defaultAddress));
  // Where the view is, or is going: a move sets it at once, and the state follows with the next
  // render. What runs later than the render it was made in (the answer to a request, a timer)
  // reads the place of the view from here, not from the `address` it was made with.
  const targetRef = useRef(defaultAddress);
  const moveTo = useCallback((next: number) => {
    targetRef.current = next;
    setAddress(next);
  }, []);

  const requestIdRef = useRef(0);
  const wheelRemainder = useRef(0);
  const pendingScrollSteps = useRef(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  // the same element as state, for the effect that watches its size
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const attachContainer = useCallback((node: HTMLDivElement | null) => {
    containerRef.current = node;
    setContainer(node);
  }, []);
  const currentPcRef = useRef<number | undefined>(currentPc);
  const pendingHighlightRef = useRef<number | undefined>(undefined);
  const lineRefsMap = useRef<Map<number, HTMLDivElement>>(new Map());
  // what the line elements are marked from when they mount (see handleLineRef)
  const markerRef = useRef({ currentPc, executionState });
  /**
   * The program counter of a stop that is being followed: its line has to end up on screen.
   * Moving the view by hand ends that. What has been done for it so far:
   * - "read": the view stayed where it was and reads its lines again;
   * - "moved": the view went to ten instructions above it;
   * - "adjusted": that did not show the line, and the view went to where it fits.
   */
  const revealRef = useRef<{ pc: number; stage: "read" | "moved" | "adjusted" } | undefined>(
    // the stop the view opens in: the view is already where a followed stop would have moved it
    openingStopPc !== undefined ? { pc: openingStopPc, stage: "moved" } : undefined,
  );

  // Track previous execution state for detecting pauses
  const prevExecutionStateRef = useRef(executionState);

  // Flash the line of the requested address. The line may not exist yet (it is still
  // being fetched), so the request stays pending until a render contains it.
  const applyPendingHighlight = useCallback(() => {
    const target = pendingHighlightRef.current;
    if (target === undefined) {
      return;
    }
    const element = lineRefsMap.current.get(target);
    if (!element) {
      return;
    }
    pendingHighlightRef.current = undefined;
    element.classList.remove("target-address");
    // Force reflow to restart animation
    void element.offsetWidth;
    element.classList.add("target-address");

    // Remove class after animation completes (2s animation duration)
    setTimeout(() => {
      element.classList.remove("target-address");
    }, 2000);
  }, []);

  // Helper to apply highlight with auto-removal
  const applyHighlight = useCallback(
    (targetAddr: number) => {
      pendingHighlightRef.current = normalizeAddress(targetAddr, config.maxAddress, config.instructionSize);
      applyPendingHighlight();
    },
    [applyPendingHighlight, config.maxAddress, config.instructionSize],
  );

  // Fetched lines have just been rendered: highlight the requested one if it is among them
  useEffect(() => {
    applyPendingHighlight();
  }, [lines, applyPendingHighlight]);

  // Update DOM directly when PC or execution state changes
  useEffect(() => {
    const isPaused = executionState === "paused";
    const oldPc = currentPcRef.current;
    const newPc = currentPc;
    const wasRunning = prevExecutionStateRef.current === "running";

    if (oldPc !== newPc) {
      // Remove current styling from old PC
      if (oldPc !== undefined) {
        const oldElement = lineRefsMap.current.get(oldPc);
        if (oldElement) {
          oldElement.classList.remove("current-instruction");
        }
      }

      // Add current styling to new PC only if paused
      if (newPc !== undefined && isPaused) {
        const newElement = lineRefsMap.current.get(newPc);
        if (newElement) {
          newElement.classList.add("current-instruction");
        }
      }

      // Update ref after processing
      currentPcRef.current = newPc;
    } else if (oldPc !== undefined) {
      // If PC hasn't changed but execution state changed, update styling
      const element = lineRefsMap.current.get(oldPc);
      if (element) {
        if (isPaused) {
          element.classList.add("current-instruction");
        } else {
          element.classList.remove("current-instruction");
        }
      }
    }

    // Auto-scroll to current PC when transitioning from running to paused
    if (followOnPause && isPaused && wasRunning && newPc !== undefined) {
      const contextOffset = config.instructionSize * 10;
      const targetAddress = Math.max(0, newPc - contextOffset);
      const normalizedTarget = normalizeAddress(targetAddress, config.maxAddress, config.instructionSize);
      moveTo(normalizedTarget);
    }

    // Update previous execution state
    prevExecutionStateRef.current = executionState;
    markerRef.current = { currentPc, executionState };
  }, [currentPc, executionState, config.instructionSize, config.maxAddress, followOnPause, moveTo]);

  const fetchDisassembly = useCallback(
    async (addr: number) => {
      const requestId = ++requestIdRef.current;
      setLoading(true);
      setError(undefined);
      try {
        // Calculate how many instructions can fit before hitting max address
        const remainingAddressSpace = config.maxAddress - addr;
        const maxPossibleInstructions = Math.floor(remainingAddressSpace / config.instructionSize) + 1;
        const count = Math.min(LINES_PER_FETCH, Math.max(1, maxPossibleInstructions));

        const result = await callbacks.onFetchDisassembly(addr, count);
        if (requestIdRef.current !== requestId) {
          return;
        }
        const unique = uniqueLines(result);
        setLines(unique);
        setRepeated(result.length - unique.length);
        setAnswered({ requestId, address: addr });
      } catch (err) {
        if (requestIdRef.current === requestId) {
          setError(err instanceof Error ? err.message : String(err));
          setAnswered({ requestId, address: addr });
        }
      } finally {
        if (requestIdRef.current === requestId) {
          setLoading(false);
        }
      }
    },
    [callbacks, config.maxAddress, config.instructionSize],
  );

  useEffect(() => {
    const normalized = normalizeAddress(address, config.maxAddress, config.instructionSize);
    // Display the address 10 instructions down (the intended target), not the fetch start
    const displayAddress = Math.min(config.maxAddress, normalized + config.instructionSize * 10);
    setAddressInput(config.formatAddressInput(displayAddress));

    if (initialized) {
      void fetchDisassembly(normalized);
    }
  }, [address, fetchDisassembly, config, initialized]);

  // Process pending scroll steps after loading completes
  useEffect(() => {
    if (!loading && pendingScrollSteps.current !== 0) {
      const steps = pendingScrollSteps.current;
      pendingScrollSteps.current = 0;
      moveTo(normalizeAddress(targetRef.current + steps * config.instructionSize, config.maxAddress, config.instructionSize));
    }
  }, [loading, config.instructionSize, config.maxAddress, moveTo]);

  const adjustAddress = useCallback(
    (steps: number) => {
      revealRef.current = undefined;
      moveTo(normalizeAddress(targetRef.current + steps * config.instructionSize, config.maxAddress, config.instructionSize));
    },
    [config.instructionSize, config.maxAddress, moveTo],
  );

  const handleWheel = useCallback(
    (event: WheelEvent) => {
      event.preventDefault();
      wheelRemainder.current += event.deltaY;

      while (Math.abs(wheelRemainder.current) >= WHEEL_PIXEL_THRESHOLD) {
        const direction = wheelRemainder.current > 0 ? 1 : -1;
        const steps = direction * INSTRUCTIONS_PER_TICK;

        if (loading) {
          // Queue the scroll while loading
          pendingScrollSteps.current += steps;
        } else {
          adjustAddress(steps);
        }

        wheelRemainder.current -= direction * WHEEL_PIXEL_THRESHOLD;
      }
    },
    [adjustAddress, loading],
  );

  useEffect(() => {
    const node = containerRef.current;
    if (!node) {
      return;
    }

    const listener = (event: WheelEvent) => {
      handleWheel(event);
    };

    node.addEventListener("wheel", listener, { passive: false });

    return () => {
      node.removeEventListener("wheel", listener);
    };
  }, [handleWheel]);

  const handleAddressSubmit = useCallback(() => {
    const parsed = config.parseAddressInput(addressInput);
    if (parsed === undefined) {
      return;
    }
    // Start 10 instructions before for context
    const contextOffset = config.instructionSize * 10;
    const targetAddress = Math.max(0, parsed - contextOffset);
    const normalizedTarget = normalizeAddress(targetAddress, config.maxAddress, config.instructionSize);

    revealRef.current = undefined;
    moveTo(normalizedTarget);

    // Flash the line once it is on screen (now, or after the fetch)
    applyHighlight(parsed);
  }, [addressInput, config, applyHighlight, moveTo]);

  // Reads the lines again where the view is when this is called. The answer to a breakpoint
  // request calls it some time after the click, and the view may have moved since.
  const handleRefresh = useCallback(() => {
    void fetchDisassembly(normalizeAddress(targetRef.current, config.maxAddress, config.instructionSize));
  }, [fetchDisassembly, config.maxAddress, config.instructionSize]);

  /**
   * Whether the lines are rendered and have no place on the page. That is the case while the
   * panel is a dock tab behind another: the dock takes such a panel out of the document, and
   * every rectangle in it then measures as nothing, at 0. (A view that shows an error, or
   * "No Data", in place of its lines is not that: it has no lines, and is there to be seen.)
   */
  const isOffPage = useCallback(() => {
    const node = containerRef.current;
    return node !== null && !(node.isConnected && node.getBoundingClientRect().height > 0);
  }, []);

  // Counts the times the lines got their place back: what could not be seen until then is
  // looked at again (the effect on `revealRef`).
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!container || typeof ResizeObserver === "undefined") {
      return;
    }
    let offPage = isOffPage();
    const observer = new ResizeObserver(() => {
      const now = isOffPage();
      if (offPage && !now) {
        setShown((count) => count + 1);
      }
      offPage = now;
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [container, isOffPage]);

  /**
   * Whether the line of an address is rendered and entirely inside what the panel shows.
   * No line is while the lines have no place on the page (two rectangles of nothing would
   * compare as "inside").
   */
  const isLineOnScreen = useCallback(
    (lineAddress: number) => {
      const element = lineRefsMap.current.get(lineAddress);
      const node = containerRef.current;
      if (!element || !node || isOffPage()) {
        return false;
      }
      const line = element.getBoundingClientRect();
      const visible = node.getBoundingClientRect();
      return line.top >= visible.top && line.bottom <= visible.bottom;
    },
    [isOffPage],
  );

  /**
   * Whether the lines on screen are the ones the view asked for last. They are not while a
   * request is out, and not from the moment the view is moved until the lines of its new
   * place are rendered: until then the screen shows lines that are about to be replaced.
   */
  const isUpToDate = useCallback(
    () =>
      answered !== undefined &&
      answered.requestId === requestIdRef.current &&
      answered.address === normalizeAddress(targetRef.current, config.maxAddress, config.instructionSize),
    [answered, config.maxAddress, config.instructionSize],
  );

  const followPc = useCallback(
    (pc: number | undefined) => {
      revealRef.current = undefined;
      if (pc !== undefined) {
        const size = config.instructionSize;
        const at = normalizeAddress(targetRef.current, config.maxAddress, size);
        // Whether the line of the stop is on screen can be seen on the screen only while it
        // shows the lines the view asked for last. When others are on their way (the view is
        // still reading for the stop before this one), what they replace says nothing: then
        // the line is not going to be on screen if it is not among the lines asked for, and
        // if it is, that is seen when they are in. The same goes for a view that is a dock
        // tab behind another: it is seen when the tab is shown.
        const seen = isUpToDate() && !isOffPage();
        const away = seen ? !isLineOnScreen(pc) : pc < at || pc >= at + size * LINES_PER_FETCH;
        if (away) {
          revealRef.current = { pc, stage: "moved" };
          const start = normalizeAddress(Math.max(0, pc - size * 10), config.maxAddress, size);
          if (start !== at) {
            // the effect on `address` fetches
            moveTo(start);
            return;
          }
        } else if (!seen) {
          revealRef.current = { pc, stage: "read" };
        }
      }
      // what the lines say can have changed with the stop (code that was just loaded or written)
      handleRefresh();
    },
    [config.instructionSize, config.maxAddress, handleRefresh, isOffPage, isLineOnScreen, isUpToDate, moveTo],
  );

  // The lines of a followed stop have been rendered. A view that stayed where it was goes to
  // the program counter if its line is not on screen after all. Ten instructions of context
  // do not fit above it in a panel that is short, or whose lines wrap: then as many as fit
  // are shown above it, and none if even that leaves it outside.
  //
  // All of that is measured, so it waits while the lines have no place on the page, and is
  // done when they have one again (`shown`).
  useEffect(() => {
    const reveal = revealRef.current;
    if (!reveal || loading || !isUpToDate() || isOffPage()) {
      return;
    }
    if (isLineOnScreen(reveal.pc)) {
      revealRef.current = undefined;
      return;
    }
    const size = config.instructionSize;
    if (reveal.stage === "read") {
      revealRef.current = { pc: reveal.pc, stage: "moved" };
      const start = normalizeAddress(Math.max(0, reveal.pc - size * 10), config.maxAddress, size);
      if (start !== normalizeAddress(targetRef.current, config.maxAddress, size)) {
        moveTo(start);
        return;
      }
    }
    const index = lines.findIndex((line) => line.address === reveal.pc);
    if (index < 0) {
      return;
    }
    const fitting = lines.filter((line) => isLineOnScreen(line.address)).length;
    const adjusted = reveal.stage === "adjusted";
    const context = adjusted ? 0 : Math.min(index, Math.max(0, Math.floor((fitting - 1) / 2)));
    revealRef.current = adjusted ? undefined : { pc: reveal.pc, stage: "adjusted" };
    moveTo(normalizeAddress(reveal.pc - context * size, config.maxAddress, size));
  }, [lines, loading, shown, isOffPage, isLineOnScreen, isUpToDate, config.instructionSize, config.maxAddress, moveTo]);

  // Expose methods via ref
  useImperativeHandle(ref, () => ({
    followPc,
    scrollToAddress: (targetAddr: number, highlight: boolean = true) => {
      const contextOffset = config.instructionSize * 10;
      const scrollAddr = Math.max(0, targetAddr - contextOffset);
      const normalizedAddr = normalizeAddress(scrollAddr, config.maxAddress, config.instructionSize);
      revealRef.current = undefined;
      moveTo(normalizedAddr);

      if (highlight) {
        applyHighlight(targetAddr);
      }
    },
    focus: () => {
      containerRef.current?.focus();
    },
    getSize: () => {
      const rect = containerRef.current?.getBoundingClientRect();
      return {
        width: rect?.width ?? 0,
        height: rect?.height ?? 0,
      };
    },
    getTarget: () => target ?? "unknown",
  }), [config.instructionSize, config.maxAddress, target, applyHighlight, followPc, moveTo]);

  // The addresses whose breakpoint request is out. A click on the gutter of one of them does
  // nothing: the server makes a breakpoint for every add it is sent, two for two on one
  // address, so the second click of a double click, made before the first is answered, would
  // leave two breakpoints behind one mark. A busy emulator answers late enough for that.
  const breakpointRequests = useRef(new Set<number>());
  const editBreakpoint = useCallback(
    async (lineAddress: number, request: () => Promise<void>) => {
      if (breakpointRequests.current.has(lineAddress)) {
        return;
      }
      breakpointRequests.current.add(lineAddress);
      try {
        await request();
      } finally {
        breakpointRequests.current.delete(lineAddress);
      }
      if (refetchAfterBreakpointEdit) {
        handleRefresh();
      }
    },
    [refetchAfterBreakpointEdit, handleRefresh],
  );

  const handleBreakpointClick = useCallback(
    (lineAddress: number) => {
      const existing = breakpointsByAddress.get(lineAddress);
      void editBreakpoint(lineAddress, () =>
        existing ? callbacks.onBreakpointRemove(existing.id) : callbacks.onBreakpointAdd(lineAddress),
      );
    },
    [breakpointsByAddress, callbacks, editBreakpoint],
  );

  const handleBreakpointToggle = useCallback(
    (lineAddress: number, event: React.MouseEvent) => {
      event.stopPropagation();
      const existing = breakpointsByAddress.get(lineAddress);
      if (existing) {
        void editBreakpoint(lineAddress, () => callbacks.onBreakpointToggle(existing.id, !existing.enabled));
      }
    },
    [breakpointsByAddress, callbacks, editBreakpoint],
  );

  // Stable: a line element is marked from what the view knew when the element mounted, and
  // the effect on `currentPc` keeps the marker where it belongs after that.
  const handleLineRef = useCallback((lineAddress: number, el: HTMLDivElement | null) => {
    if (el) {
      lineRefsMap.current.set(lineAddress, el);
      const marker = markerRef.current;
      el.classList.toggle("current-instruction", marker.currentPc === lineAddress && marker.executionState === "paused");
    } else {
      lineRefsMap.current.delete(lineAddress);
    }
  }, []);

  const handleGotoPC = useCallback(() => {
    if (currentPc !== undefined) {
      // Start 10 instructions before for context
      const contextOffset = config.instructionSize * 10;
      const targetAddress = Math.max(0, currentPc - contextOffset);
      revealRef.current = undefined;
      moveTo(targetAddress);
    }
  }, [currentPc, config.instructionSize, moveTo]);

  const handleStep = useCallback(async () => {
    if (executionState !== "paused") {
      return;
    }
    try {
      await callbacks.onStep();
    } catch (error) {
      console.error("Failed to step", error);
    }
  }, [callbacks, executionState]);

  const handleStepIn = useCallback(async () => {
    if (executionState !== "paused" || !callbacks.onStepIn) {
      return;
    }
    try {
      await callbacks.onStepIn();
    } catch (error) {
      console.error("Failed to step in", error);
    }
  }, [callbacks, executionState]);

  const handleStepOut = useCallback(async () => {
    if (executionState !== "paused" || !callbacks.onStepOut) {
      return;
    }
    try {
      await callbacks.onStepOut();
    } catch (error) {
      console.error("Failed to step out", error);
    }
  }, [callbacks, executionState]);

  const handleMuteToggle = useCallback(() => {
    callbacks.onMuteToggle();
  }, [callbacks]);

  const handleSoloToggle = useCallback(() => {
    callbacks.onSoloToggle();
  }, [callbacks]);

  const handleRunPauseToggle = useCallback(() => {
    if (callbacks.onRunPauseToggle) {
      callbacks.onRunPauseToggle();
    }
  }, [callbacks]);

  const stepDisabled = executionState !== "paused" || !canStep;
  const stepping = config.steppingNotice === undefined;
  const StepIcon = config.stepIcon;

  const RunPausedIcon = config.runPauseIcon?.paused ?? PlayArrowIcon;
  const RunRunningIcon = config.runPauseIcon?.running ?? PauseIcon;
  const runPausedLabel = config.runPauseLabel?.paused ?? "Run";
  const runRunningLabel = config.runPauseLabel?.running ?? "Pause";

  return (
    <Paper
      elevation={0}
      sx={{
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        height: "100%",
      }}
    >
      {/* In a panel too narrow for it in one line the toolbar takes a second one, for the
          address box and Refresh: nothing of it is cut off. */}
      <Box
        sx={{
          px: 2,
          py: 1,
          display: "flex",
          // the step buttons stay on the first line when the other half takes two
          alignItems: "flex-start",
          gap: 1,
          borderBottom: "1px solid",
          borderColor: "divider",
        }}
      >
        <Stack direction="row" spacing={0.5} alignItems="center">
          {callbacks.onRunPauseToggle && (
            <Tooltip title={executionState === "paused" ? runPausedLabel : runRunningLabel}>
              <span>
                <IconButton
                  size="small"
                  onClick={handleRunPauseToggle}
                  disabled={!initialized}
                >
                  {executionState === "paused" ? (
                    <RunPausedIcon fontSize="small" />
                  ) : (
                    <RunRunningIcon fontSize="small" />
                  )}
                </IconButton>
              </span>
            </Tooltip>
          )}
          {config.prefixActions?.map((action) => {
            const ActionIcon = action.icon;
            return (
              <Tooltip key={action.key} title={action.label}>
                <span>
                  <IconButton
                    size="small"
                    onClick={action.onClick}
                    disabled={action.disabled ?? !initialized}
                  >
                    <ActionIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            );
          })}
          {stepping ? (
            // the tooltips of the step buttons are on the buttons: the title is the button's name
            <Tooltip title={config.stepLabel}>
              <RunControlButton size="small" onClick={handleStep} disabled={stepDisabled || !initialized}>
                <StepIcon fontSize="small" />
              </RunControlButton>
            </Tooltip>
          ) : (
            <Typography variant="caption" color="text.secondary" role="note" sx={{ maxWidth: 260, lineHeight: 1.2 }}>
              {config.steppingNotice}
            </Typography>
          )}
          {stepping && config.showStepInOut && (
            <>
              <Tooltip title="Step In">
                <RunControlButton size="small" onClick={handleStepIn} disabled={stepDisabled || !initialized}>
                  <ArrowDownwardRoundedIcon fontSize="small" />
                </RunControlButton>
              </Tooltip>
              <Tooltip title="Step Out">
                <RunControlButton size="small" onClick={handleStepOut} disabled={stepDisabled || !initialized}>
                  <ArrowUpwardRoundedIcon fontSize="small" />
                </RunControlButton>
              </Tooltip>
            </>
          )}
          {config.extraActions?.map((action) => {
            const ActionIcon = action.icon;
            return (
              <Tooltip key={action.key} title={action.label}>
                <span>
                  <IconButton
                    size="small"
                    onClick={action.onClick}
                    disabled={action.disabled ?? !initialized}
                  >
                    <ActionIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            );
          })}
        </Stack>
        <Stack direction="row" spacing={1} useFlexGap alignItems="center" sx={{ flex: 1, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <Stack direction="row" spacing={1} alignItems="center">
          {stepping && (config.showMuteSolo ?? true) && (
            <>
              <Tooltip title={categoryState?.muted ? "Unmute category" : "Mute category"}>
                <IconButton size="small" onClick={handleMuteToggle} color={categoryState?.muted ? "warning" : "default"}>
                  {categoryState?.muted ? <VolumeOffIcon fontSize="small" /> : <VolumeUpIcon fontSize="small" />}
                </IconButton>
              </Tooltip>
              <Tooltip title={categoryState?.soloed ? "Unsolo category" : "Solo category"}>
                <IconButton size="small" onClick={handleSoloToggle} color={categoryState?.soloed ? "primary" : "default"}>
                  {categoryState?.soloed ? <RadioButtonCheckedIcon fontSize="small" /> : <RadioButtonUncheckedIcon fontSize="small" />}
                </IconButton>
              </Tooltip>
            </>
          )}
          <Tooltip title="Go to current PC">
            <RunControlButton size="small" onClick={handleGotoPC} disabled={currentPc === undefined}>
              <MyLocationIcon fontSize="small" />
            </RunControlButton>
          </Tooltip>
          </Stack>
          <Stack direction="row" spacing={1} alignItems="center">
          <TextField
            size="small"
            value={unplaced ? "" : addressInput}
            disabled={unplaced}
            onChange={(event) => setAddressInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                handleAddressSubmit();
              }
            }}
            // wide enough for an address of eight digits next to its button
            sx={{ width: 180 }}
            slotProps={{
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <Button size="small" onClick={handleAddressSubmit} disabled={unplaced} sx={{ minWidth: "auto", px: 1 }}>
                      Go
                    </Button>
                  </InputAdornment>
                ),
              },
            }}
          />
          <Tooltip title="Refresh">
            <RunControlButton size="small" onClick={handleRefresh} disabled={loading || unplaced}>
              <RefreshIcon fontSize="small" />
            </RunControlButton>
          </Tooltip>
          </Stack>
        </Stack>
      </Box>
      <Box sx={{ flex: 1, overflow: "auto" }}>
        {!initialized ? (
          <Stack alignItems="center" justifyContent="center" sx={{ height: "100%" }}>
            <Typography variant="body2" color="text.secondary">
              {noDataText}
            </Typography>
          </Stack>
        ) : error ? (
          <Typography variant="body2" color="error" sx={{ p: 2 }}>
            {error}
          </Typography>
        ) : lines.length === 0 && loading ? (
          <Stack alignItems="center" justifyContent="center" sx={{ height: "100%" }} spacing={1}>
            <CircularProgress size={18} />
            <Typography variant="body2" color="text.secondary">
              Loading disassembly.
            </Typography>
          </Stack>
        ) : (
          <Box
            ref={attachContainer}
            sx={{
              flex: 1,
              height: "100%",
              overflow: "hidden",
              fontFamily: "monospace",
              fontSize: "13px",
              p: 1.5,
              position: "relative",
              cursor: "default",
            }}
          >
            {loading && (
              <Stack direction="row" spacing={1} alignItems="center" sx={{ position: "absolute", top: 8, right: 16 }}>
                <CircularProgress size={12} thickness={5} />
                <Typography variant="caption" color="text.secondary">
                  Updating
                </Typography>
              </Stack>
            )}
            {repeated > 0 && (
              <Typography variant="caption" color="warning.main" role="note" sx={{ display: "block", mb: 0.5 }}>
                {repeated === 1
                  ? "The server listed an address twice; it is shown once."
                  : `The server listed ${repeated} lines for addresses it had already listed; each address is shown once.`}
              </Typography>
            )}
            {lines.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No disassembly returned.
              </Typography>
            ) : (
              <Stack
                spacing={0}
                sx={{
                  "& .current-instruction": {
                    color: "primary.main",
                    fontWeight: 600,
                    border: "2px solid",
                    borderColor: "success.main",
                    "&:hover": {
                      borderColor: "success.main !important",
                    },
                  },
                  "& .target-address": {
                    border: "2px solid",
                    borderColor: "warning.main",
                    animation: "fadeOutTarget 2s forwards",
                    "&:hover": {
                      borderColor: "inherit !important",
                    },
                  },
                  "@keyframes fadeOutTarget": {
                    "0%": {
                      borderColor: "warning.main",
                    },
                    "100%": {
                      borderColor: "transparent",
                    },
                  },
                }}
              >
                {lines.map((line) => (
                  <DisassemblyLineItem
                    key={line.address}
                    line={line}
                    breakpoint={breakpointsByAddress.get(line.address)}
                    config={config}
                    onBreakpointClick={handleBreakpointClick}
                    onBreakpointToggle={handleBreakpointToggle}
                    lineRef={handleLineRef}
                  />
                ))}
              </Stack>
            )}
          </Box>
        )}
      </Box>
    </Paper>
  );
});

DisassemblyView.displayName = "DisassemblyView";
