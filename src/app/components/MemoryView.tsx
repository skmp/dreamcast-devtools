import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Button, CircularProgress, IconButton, InputAdornment, Stack, TextField, Typography } from "@mui/material";
import { HideOnHoverTooltip as Tooltip } from "./HideOnHoverTooltip";
import RefreshIcon from "@mui/icons-material/Refresh";
import type { MemorySlice } from "../../lib/debuggerSchema";

type MemoryRow = {
  id: number;
  address: number;
  hex: string;
  ascii: string;
};

const WHEEL_PIXEL_THRESHOLD = 60;
const MEMORY_SCROLL_BYTES = 96;
const BYTES_PER_ROW = 16;

export interface MemoryViewConfig {
  /** Format an address value for display */
  formatAddress: (value: number) => string;
  /** Parse an address string from user input */
  parseAddress: (input: string) => number | undefined;
  /** The highest address a view can start at: `length` bytes from there end at the last address of the target */
  maxAddress: number;
  /** The last address of the target (default: 0xFFFFFFFF) */
  addressMax?: number;
  /** Number of bytes to fetch */
  length: number;
}

export interface MemoryViewCallbacks {
  /** Fetch memory slice starting at the given address */
  onFetchMemory: (address: number, length: number) => Promise<MemorySlice>;
  /** Handle address change (for URL sync) */
  onAddressChange?: (address: number) => void;
}

export interface MemoryViewProps {
  /** Configuration for address formatting and display */
  config: MemoryViewConfig;
  /** Callbacks for all actions */
  callbacks: MemoryViewCallbacks;
  /** Default address to start at */
  defaultAddress: number;
  /** Whether the debugger is initialized */
  initialized: boolean;
  /** Initial address from URL if any */
  initialUrlAddress?: { address: number; fromUrl: boolean };
  /** The bytes are fetched again, without moving, whenever this changes (the target stopped). */
  refreshSignal?: unknown;
}

const clampAddress = (value: number, max: number, alignment = 1) => {
  let clamped = value;
  if (clamped < 0) {
    clamped = 0;
  }
  if (clamped > max) {
    clamped = max;
  }
  // Round down to alignment boundary
  return clamped - (clamped % alignment);
};

export const MemoryView = ({
  config,
  callbacks,
  defaultAddress,
  initialized,
  initialUrlAddress,
  refreshSignal,
}: MemoryViewProps) => {
  const addressMax = config.addressMax ?? 0xffffffff;
  /** the first address of the last row */
  const lastRow = addressMax - (BYTES_PER_ROW - 1);
  const [slice, setSlice] = useState<MemorySlice | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // Initialize address from URL or default. An address from the URL is treated like a
  // submitted one: aligned to its row and shown with ten rows of context above it.
  const initialAddress = initialUrlAddress
    ? Math.max(
        0,
        clampAddress(initialUrlAddress.address, lastRow, BYTES_PER_ROW) - BYTES_PER_ROW * 10,
      )
    : defaultAddress;
  const [address, setAddress] = useState(initialAddress);
  const [addressInput, setAddressInput] = useState(config.formatAddress(initialAddress));

  const requestIdRef = useRef(0);
  const wheelRemainder = useRef(0);
  const pendingScrollDelta = useRef(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pendingHighlightRef = useRef<number | undefined>(undefined);
  const lineRefsMap = useRef<Map<number, HTMLDivElement>>(new Map());
  const urlHighlightTriggeredRef = useRef(false);

  // Flash the row of the requested address. The row may not exist yet (its slice is still
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
    // Rows are reused for other addresses when the view scrolls: drop stale markers
    lineRefsMap.current.forEach((row) => row.classList.remove("target-address"));
    // Force reflow to restart animation
    void element.offsetWidth;
    element.classList.add("target-address");
  }, []);

  const fetchSlice = useCallback(
    async (addr: number) => {
      const requestId = ++requestIdRef.current;
      setLoading(true);
      setError(undefined);
      try {
        // Calculate how many bytes can fit before hitting max address
        const remainingAddressSpace = addressMax - addr;
        const adjustedLength = Math.min(config.length, Math.max(1, remainingAddressSpace + 1));

        const result = await callbacks.onFetchMemory(addr, adjustedLength);
        if (requestIdRef.current !== requestId) {
          return;
        }
        setSlice(result);
      } catch (err) {
        if (requestIdRef.current === requestId) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (requestIdRef.current === requestId) {
          setLoading(false);
        }
      }
    },
    [callbacks, config.length, addressMax],
  );

  // The box follows the view when the view moves (a submit, the wheel) and is rewritten for
  // no other reason: what is being typed has to survive a render in which only the callbacks
  // changed identity, which they do whenever the URL changes.
  useEffect(() => {
    const normalized = clampAddress(address, config.maxAddress, BYTES_PER_ROW);
    // Display the address 10 rows down (the intended target), not the fetch start
    const displayAddress = Math.min(lastRow, normalized + BYTES_PER_ROW * 10);
    setAddressInput(config.formatAddress(displayAddress));
  }, [address, config, lastRow]);

  useEffect(() => {
    if (initialized) {
      void fetchSlice(clampAddress(address, config.maxAddress, BYTES_PER_ROW));
    }
  }, [address, fetchSlice, config.maxAddress, initialized]);

  // The target stopped somewhere new: what is on screen is read again, where it is. Ticks do
  // not do that; a stop and the panel's own buttons do.
  const seenRefreshSignal = useRef(refreshSignal);
  useEffect(() => {
    if (seenRefreshSignal.current === refreshSignal) {
      return;
    }
    seenRefreshSignal.current = refreshSignal;
    if (initialized) {
      void fetchSlice(clampAddress(address, config.maxAddress, BYTES_PER_ROW));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new signal fetches here; a new address or connection is the effect above
  }, [refreshSignal]);

  // Trigger highlight effect when loaded from URL
  useEffect(() => {
    if (!initialUrlAddress?.fromUrl || !initialized || !slice || urlHighlightTriggeredRef.current) {
      return;
    }

    // Mark as triggered immediately to prevent re-triggering on scroll
    urlHighlightTriggeredRef.current = true;

    // Align the address to row boundary for proper highlighting
    pendingHighlightRef.current = clampAddress(initialUrlAddress.address, lastRow, BYTES_PER_ROW);
    applyPendingHighlight();
  }, [initialUrlAddress, initialized, slice, applyPendingHighlight, lastRow]);

  // Process pending scroll delta after loading completes
  useEffect(() => {
    if (!loading && pendingScrollDelta.current !== 0) {
      const delta = pendingScrollDelta.current;
      pendingScrollDelta.current = 0;
      setAddress((prev) => clampAddress(prev + delta, config.maxAddress, BYTES_PER_ROW));
    }
  }, [loading, config.maxAddress]);

  const rows = useMemo<MemoryRow[]>(() => {
    if (!slice) {
      return [];
    }
    const bytes = slice.data;
    // Bytes the debugger could not read are 0 in the data and listed as [offset, length]
    // runs: they are shown as "??", not as the zero they are not.
    const unreadable = new Uint8Array(bytes.length);
    for (const [offset, length] of slice.unreadable ?? []) {
      unreadable.fill(1, Math.max(0, offset), Math.min(bytes.length, offset + length));
    }
    const result: MemoryRow[] = [];
    for (let offset = 0; offset < bytes.length; offset += BYTES_PER_ROW) {
      const chunk = bytes.slice(offset, offset + BYTES_PER_ROW);
      const rowAddress = slice.baseAddress + offset;
      const hex = chunk.map((b, index) => (unreadable[offset + index] ? "??" : b.toString(16).toUpperCase().padStart(2, "0"))).join(" ");
      const ascii = chunk
        .map((byte, index) => {
          if (unreadable[offset + index]) {
            return "?";
          }
          const char = String.fromCharCode(byte);
          return /[\x20-\x7E]/.test(char) ? char : ".";
        })
        .join("");
      result.push({ id: offset, address: rowAddress, hex, ascii });
    }
    return result;
  }, [slice]);

  // A fetched slice has just been rendered: highlight the requested row if it is in there
  useEffect(() => {
    applyPendingHighlight();
  }, [rows, applyPendingHighlight]);

  const adjustAddress = useCallback(
    (delta: number) => {
      setAddress((prev) => clampAddress(prev + delta, config.maxAddress, BYTES_PER_ROW));
    },
    [config.maxAddress],
  );

  const handleWheel = useCallback(
    (event: WheelEvent) => {
      event.preventDefault();
      wheelRemainder.current += event.deltaY;

      while (Math.abs(wheelRemainder.current) >= WHEEL_PIXEL_THRESHOLD) {
        const direction = wheelRemainder.current > 0 ? 1 : -1;
        const delta = direction * MEMORY_SCROLL_BYTES;

        if (loading) {
          // Queue the scroll while loading
          pendingScrollDelta.current += delta;
        } else {
          adjustAddress(delta);
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
    const parsed = config.parseAddress(addressInput);
    if (parsed === undefined) {
      return;
    }
    // Align down to row boundary
    const alignedAddress = clampAddress(parsed, lastRow, BYTES_PER_ROW);

    // Update the input field to show the aligned address
    setAddressInput(config.formatAddress(alignedAddress));

    // Start 10 rows before for context
    const contextOffset = BYTES_PER_ROW * 10;
    const targetAddress = Math.max(0, alignedAddress - contextOffset);
    const clampedTarget = clampAddress(targetAddress, config.maxAddress, BYTES_PER_ROW);

    setAddress(clampedTarget);
    callbacks.onAddressChange?.(alignedAddress);

    // Highlight the row once it is on screen: right away when the view does not move,
    // otherwise after the new slice has been fetched and rendered (see the rows effect)
    pendingHighlightRef.current = alignedAddress;
    if (clampedTarget === address) {
      applyPendingHighlight();
    }
  }, [addressInput, config, callbacks, address, applyPendingHighlight, lastRow]);

  const handleRefresh = useCallback(() => {
    void fetchSlice(clampAddress(address, config.maxAddress, BYTES_PER_ROW));
  }, [fetchSlice, address, config.maxAddress]);

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        height: "100%",
      }}
    >
      <Box
        sx={{
          px: 2,
          py: 1,
          display: "flex",
          alignItems: "center",
          gap: 1,
          borderBottom: "1px solid",
          borderColor: "divider",
        }}
      >
        <Stack direction="row" spacing={1} alignItems="center" sx={{ flex: 1 }}>
          <TextField
            size="small"
            value={addressInput}
            onChange={(event) => setAddressInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                handleAddressSubmit();
              }
            }}
            sx={{ flex: 1 }}
            slotProps={{
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    <Button size="small" onClick={handleAddressSubmit} sx={{ minWidth: "auto", px: 1 }}>
                      Go
                    </Button>
                  </InputAdornment>
                ),
              },
            }}
          />
          <Tooltip title="Refresh">
            <IconButton size="small" onClick={handleRefresh} disabled={loading}>
              <RefreshIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Stack>
      </Box>
      <Box sx={{ flex: 1, overflow: "auto" }}>
        {!initialized ? (
          <Stack alignItems="center" justifyContent="center" sx={{ height: "100%" }}>
            <Typography variant="body2" color="text.secondary">
              No Data
            </Typography>
          </Stack>
        ) : error ? (
          <Typography variant="body2" color="error" sx={{ p: 2 }}>
            {error}
          </Typography>
        ) : loading && !slice ? (
          <Stack alignItems="center" justifyContent="center" sx={{ height: "100%" }} spacing={1}>
            <CircularProgress size={18} />
            <Typography variant="body2" color="text.secondary">
              Loading memory.
            </Typography>
          </Stack>
        ) : slice && rows.length > 0 ? (
          <Box
            ref={containerRef}
            sx={{
              height: "100%",
              flex: 1,
              overflow: "hidden",
              fontFamily: "monospace",
              fontSize: 13,
              p: 1.5,
              position: "relative",
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
            <Box sx={{ display: "flex", mb: 1, color: "text.secondary", fontWeight: 600, fontFamily: "monospace", fontSize: 13 }}>
              <Typography component="span" sx={{ width: 100, flexShrink: 0, mr: "1.5em" }}>
                Address
              </Typography>
              <Typography component="span" sx={{ width: 380, flexShrink: 0, mr: "4em" }}>
                Hex
              </Typography>
              <Typography component="span" sx={{ width: 130, flexShrink: 0 }}>
                ASCII
              </Typography>
            </Box>
            <Stack
              spacing={0}
              sx={{
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
              {rows.map((row) => (
                <Box
                  key={row.id}
                  ref={(el: HTMLDivElement | null) => {
                    if (el) {
                      lineRefsMap.current.set(row.address, el);
                    } else {
                      lineRefsMap.current.delete(row.address);
                    }
                  }}
                  sx={{
                    display: "flex",
                    fontFamily: "monospace",
                    fontSize: 13,
                    alignItems: "baseline",
                    border: "2px solid transparent",
                    borderRadius: 1,
                    px: 0.5,
                    py: 0,
                    "&:hover": {
                      borderBottomColor: "primary.main",
                    },
                  }}
                >
                  <Typography component="span" sx={{ width: 100, flexShrink: 0, mr: "1.5em" }}>
                    {config.formatAddress(row.address)}
                  </Typography>
                  <Typography component="span" sx={{ width: 380, flexShrink: 0, whiteSpace: "nowrap", letterSpacing: 0, mr: "4em" }}>
                    {row.hex}
                  </Typography>
                  <Typography component="span" sx={{ width: 130, flexShrink: 0, whiteSpace: "pre", letterSpacing: "0.05em" }}>
                    {row.ascii}
                  </Typography>
                </Box>
              ))}
            </Stack>
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
            Memory slice unavailable.
          </Typography>
        )}
      </Box>
    </Box>
  );
};
