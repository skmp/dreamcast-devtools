import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, Button, CircularProgress, InputAdornment, Stack, TextField, Typography } from "@mui/material";
import { HideOnHoverTooltip as Tooltip } from "./HideOnHoverTooltip";
import { RunControlButton } from "./RunControlButton";
import RefreshIcon from "@mui/icons-material/Refresh";
import type { MemorySlice } from "../../lib/debuggerSchema";
import { BYTES_PER_ROW, HEX_COLUMN_CHARACTERS, formatByte, hexColumnByte } from "./memoryEdit";
import { useWriteEditor } from "./useWriteEditor";
import { WriteEditorInput } from "./WriteEditorInput";

type MemoryRow = {
  id: number;
  address: number;
  hex: string;
  ascii: string;
  /** how many bytes the row has: sixteen, but for a last row at the end of what was read */
  length: number;
};

const WHEEL_PIXEL_THRESHOLD = 60;
const MEMORY_SCROLL_BYTES = 96;

// The three columns of a row, in characters: an address of up to ten ("0x8C010000"), sixteen
// bytes with the spaces between them, sixteen characters of text; two characters between
// columns. 79 characters in all, which a monospace font draws about 48 em wide.
const ADDRESS_CHARACTERS = 10;
const GAP_CHARACTERS = 2;
const ADDRESS_COLUMN = `${ADDRESS_CHARACTERS}ch`;
const HEX_COLUMN = `${HEX_COLUMN_CHARACTERS}ch`;
const ASCII_COLUMN = `${BYTES_PER_ROW}ch`;
const COLUMN_GAP = `${GAP_CHARACTERS}ch`;
const ROW_EM = 48;
/** what is around the columns of a row, in px: the padding of the listing and of the row, and the row's border */
const ROW_FRAME_PX = 36;
/**
 * The size of the listing's font: the size of the rest of the UI where a row fits at that
 * size, smaller in a narrower panel, so that the row still fits and no column is cut off, and
 * not smaller than can be read. (`cqw` is a hundredth of the width of the panel's listing.)
 * In a panel narrower than a row is at that smallest size (about 520 px) the row does not
 * fit: the listing is then scrolled to the side, and no column is squeezed or cut off for it.
 */
const LISTING_FONT_SIZE = `clamp(10px, calc((100cqw - ${ROW_FRAME_PX}px) / ${ROW_EM}), 1rem)`;
/** the padding of a row at its left, in px (`px: 0.5` of the theme) */
const ROW_PADDING_PX = 4;
/** a cell of the listing: the listing's font, whatever the theme gives a text by itself */
const CELL_SX = { font: "inherit", letterSpacing: 0, flexShrink: 0 } as const;

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
  /**
   * Writes what was typed into the editor of the byte at `address`, from that byte on: what
   * the text is as bytes is the caller's to say. Rejects, with why, when nothing was written:
   * the editor then stays open. Without it the view has no editor.
   */
  onWriteMemory?: (address: number, text: string) => Promise<void>;
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
  /**
   * The bytes are fetched again, without moving, whenever this changes (the target stopped,
   * or this client wrote to it).
   */
  refreshSignal?: unknown;
  /**
   * The bytes can be edited now: a double click on a byte of the hex column opens an editor
   * there, and the run of bytes typed into it is written from that byte on (default: false).
   */
  editable?: boolean;
  /** What the hex column says of editing when the pointer rests on it: how to, or why not now. */
  editHint?: string;
  /** What is said in place of the bytes while the view is not `initialized` (default: "No Data"). */
  noDataText?: string;
  /**
   * The view has no place yet: no server has said where the memory of its target is read. It
   * is the frame of the view and nothing else: the toolbar, with a box that is empty and
   * controls that cannot be used, and `noDataText` where the bytes will be.
   */
  unplaced?: boolean;
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
  editable = false,
  editHint,
  noDataText = "No Data",
  unplaced = false,
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

  // What the box says where the view is: the address 10 rows down (the intended target), not
  // the fetch start, as the target writes its addresses.
  const shownAddress = config.formatAddress(Math.min(lastRow, clampAddress(address, config.maxAddress, BYTES_PER_ROW) + BYTES_PER_ROW * 10));

  // The box follows the view when the view moves (a submit, the wheel: a view that has moved
  // says another address), and the target when it writes its addresses in another way, and
  // is rewritten for no other reason. What is being typed has to survive a render in which
  // only the callbacks changed identity, which they do whenever the URL changes, and one in
  // which `config` did, which is made again from every debugger.describe: a connection that
  // is back does not move the view.
  useEffect(() => {
    setAddressInput(shownAddress);
  }, [shownAddress]);

  useEffect(() => {
    if (initialized) {
      void fetchSlice(clampAddress(address, config.maxAddress, BYTES_PER_ROW));
    }
  }, [address, fetchSlice, config.maxAddress, initialized]);

  const handleRefresh = useCallback(() => {
    void fetchSlice(clampAddress(address, config.maxAddress, BYTES_PER_ROW));
  }, [fetchSlice, address, config.maxAddress]);

  // What a timer calls: the view as it is when the timer runs, not as it was when it was set.
  const latest = useRef({ initialized, refresh: handleRefresh });
  useLayoutEffect(() => {
    latest.current = { initialized, refresh: handleRefresh };
  });

  // The target stopped somewhere new: what is on screen is read again, where it is. Ticks do
  // not do that; a stop and the panel's own buttons do.
  //
  // Not in the render of the tick, but from a timer that the next stop cancels: when stops
  // arrive faster than the page renders them, their ticks are queued, the timer of each is
  // behind the tick of the next, and the bytes are read once, for the latest. The render of a
  // tick then sets no state either (React throws at the fifty-first render in a row).
  const seenRefreshSignal = useRef(refreshSignal);
  useEffect(() => {
    if (seenRefreshSignal.current === refreshSignal) {
      return;
    }
    const timer = setTimeout(() => {
      seenRefreshSignal.current = refreshSignal;
      if (latest.current.initialized) {
        latest.current.refresh();
      }
    }, 0);
    return () => clearTimeout(timer);
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
      const hex = chunk.map((b, index) => (unreadable[offset + index] ? "??" : formatByte(b))).join(" ");
      const ascii = chunk
        .map((byte, index) => {
          if (unreadable[offset + index]) {
            return "?";
          }
          const char = String.fromCharCode(byte);
          return /[\x20-\x7E]/.test(char) ? char : ".";
        })
        .join("");
      result.push({ id: offset, address: rowAddress, hex, ascii, length: chunk.length });
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
      // A turn to the side is not a move through the addresses: it is left to the box around
      // the listing, which scrolls to the rest of the rows in a panel narrower than they are.
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        return;
      }
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

  // The editor of a byte: where it is, and what is typed into it. The row of its address shows
  // it, wherever the view has been moved to in the meantime.
  const [editAddress, setEditAddress] = useState<number | undefined>(undefined);
  const editAddressRef = useRef<number | undefined>(undefined);
  const { onWriteMemory } = callbacks;
  const writeTyped = useCallback(
    (text: string) => {
      const at = editAddressRef.current;
      if (at === undefined || !onWriteMemory) {
        return Promise.reject(new Error("Nothing is being edited"));
      }
      return onWriteMemory(at, text);
    },
    [onWriteMemory],
  );
  const editor = useWriteEditor(writeTyped);
  const canEdit = editable && initialized && onWriteMemory !== undefined;
  const editing = canEdit && editor.text !== undefined && editAddress !== undefined;
  // An editor is offered while the bytes can be written: one that is open when the target runs
  // again, or the connection is lost, is not shown any more and is put away with what was typed.
  const { text: draft, open: openEditor, close: closeEditor } = editor;
  useEffect(() => {
    if (draft !== undefined && !canEdit) {
      closeEditor();
    }
  }, [draft, canEdit, closeEditor]);

  // A double click on a byte of the hex column: the editor opens at that byte, with the byte
  // in it. A row is one piece of text, so the byte is found from where in the column the
  // pointer is. A byte that could not be read ("??") has no value to edit.
  const handleListingDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-memory-hex]");
      if (!canEdit || !cell) {
        return;
      }
      const row = rows.find((candidate) => candidate.address === Number(cell.dataset.memoryHex));
      if (!row) {
        return;
      }
      const box = cell.getBoundingClientRect();
      const index = hexColumnByte(event.clientX - box.left, box.width);
      const byte = row.hex.slice(index * 3, index * 3 + 2);
      if (index >= row.length || !/^[0-9A-F]{2}$/.test(byte)) {
        return;
      }
      // the double click has selected the byte as text: the editor shows it selected instead
      window.getSelection()?.removeAllRanges();
      editAddressRef.current = row.address + index;
      setEditAddress(row.address + index);
      openEditor(byte);
    },
    [canEdit, rows, openEditor],
  );

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
            value={unplaced ? "" : addressInput}
            disabled={unplaced}
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
      </Box>
      {/* The frame of the listing. What is said about the rows (that they are being read
          again) is said here, and stays where it is when the rows are scrolled to the side. */}
      <Box sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", position: "relative" }}>
        {/* This box scrolls to the side when the panel is narrower than a row of the listing, and
            the listing's font is sized by its width (LISTING_FONT_SIZE). */}
        <Box sx={{ flex: 1, minHeight: 0, overflow: "auto", containerType: "inline-size" }}>
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
                // Never narrower than its rows: what the panel has no room for is scrolled to,
                // and no column is cut off for it.
                minWidth: "min-content",
                overflow: "hidden",
                typography: "body1",
                fontSize: LISTING_FONT_SIZE,
                p: 1.5,
                position: "relative",
              }}
            >
              <Box sx={{ display: "flex", mb: 1, px: "6px", color: "text.secondary", fontWeight: 600 }}>
                <Typography component="span" sx={{ ...CELL_SX, width: ADDRESS_COLUMN, mr: COLUMN_GAP }}>
                  Address
                </Typography>
                <Typography component="span" sx={{ ...CELL_SX, width: HEX_COLUMN, mr: COLUMN_GAP }}>
                  Hex
                </Typography>
                <Typography component="span" sx={{ ...CELL_SX, width: ASCII_COLUMN }}>
                  ASCII
                </Typography>
              </Box>
              <Stack
                spacing={0}
                onDoubleClick={handleListingDoubleClick}
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
                  // the box of an open editor: over the bytes it starts at, in their font
                  "& .memory-editor": {
                    position: "absolute",
                    top: "-1px",
                    bottom: "-1px",
                    zIndex: 1,
                    boxSizing: "border-box",
                    margin: 0,
                    padding: "0 3px",
                    font: "inherit",
                    letterSpacing: 0,
                    color: "text.primary",
                    backgroundColor: "background.default",
                    border: "1px solid",
                    borderColor: "primary.main",
                    borderRadius: "3px",
                    outline: "none",
                    "&[aria-invalid]": {
                      borderColor: "error.main",
                    },
                    "&[aria-busy]": {
                      opacity: 0.6,
                    },
                  },
                }}
              >
                {rows.map((row) => {
                  // the byte of this row that is being edited, if one is
                  const edited = editing && editAddress >= row.address && editAddress < row.address + row.length ? editAddress - row.address : undefined;
                  return (
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
                        alignItems: "baseline",
                        border: "2px solid transparent",
                        borderRadius: 1,
                        px: 0.5,
                        py: 0,
                        position: "relative",
                        "&:hover": {
                          borderBottomColor: "primary.main",
                        },
                      }}
                    >
                      <Typography component="span" sx={{ ...CELL_SX, width: ADDRESS_COLUMN, mr: COLUMN_GAP }}>
                        {config.formatAddress(row.address)}
                      </Typography>
                      <Typography
                        component="span"
                        data-memory-hex={row.address}
                        title={editHint}
                        sx={{ ...CELL_SX, width: HEX_COLUMN, whiteSpace: "nowrap", mr: COLUMN_GAP, cursor: canEdit ? "text" : undefined }}
                      >
                        {row.hex}
                      </Typography>
                      <Typography component="span" sx={{ ...CELL_SX, width: ASCII_COLUMN, whiteSpace: "pre" }}>
                        {row.ascii}
                      </Typography>
                      {edited !== undefined && (
                        // Behind the three cells of the row, so that they stay its first three
                        // children; laid over the hex column from the byte that is edited on,
                        // with the digits where those of the byte are.
                        <WriteEditorInput
                          editor={editor}
                          label={`Bytes to write from ${config.formatAddress(row.address + edited)}`}
                          className="memory-editor"
                          style={{
                            left: `calc(${ADDRESS_CHARACTERS + GAP_CHARACTERS + edited * 3}ch + ${ROW_PADDING_PX - 4}px)`,
                            // to the end of the hex column, and never less than a few bytes wide
                            width: `calc(${Math.max(HEX_COLUMN_CHARACTERS - edited * 3, 14)}ch + 8px)`,
                          }}
                        />
                      )}
                    </Box>
                  );
                })}
              </Stack>
            </Box>
          ) : (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>
              Memory slice unavailable.
            </Typography>
          )}
        </Box>
        {initialized && !error && loading && slice && rows.length > 0 && (
          <Stack direction="row" spacing={1} alignItems="center" sx={{ position: "absolute", top: 8, right: 16 }}>
            <CircularProgress size={12} thickness={5} />
            <Typography variant="caption" color="text.secondary">
              Updating
            </Typography>
          </Stack>
        )}
      </Box>
    </Box>
  );
};
