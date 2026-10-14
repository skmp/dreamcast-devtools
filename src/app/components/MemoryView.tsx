import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, Button, CircularProgress, InputAdornment, Stack, TextField, Typography } from "@mui/material";
import { HideOnHoverTooltip as Tooltip } from "./HideOnHoverTooltip";
import { RunControlButton } from "./RunControlButton";
import RefreshIcon from "@mui/icons-material/Refresh";
import type { MemorySlice } from "../../lib/debuggerSchema";
import { BYTES_PER_ROW, HEX_COLUMN_CHARACTERS, formatByte, hexColumnByte } from "./memoryEdit";
import { opensEditor, useFocusReturn, useWriteEditor } from "./useWriteEditor";
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
/** The rows above an address typed into the box, in a panel that has room for them below the first. */
const CONTEXT_ROWS = 10;

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
/** where an arrow key takes the place of the keyboard in the hex column: by rows, by bytes */
const ARROW_STEPS: Readonly<Record<string, readonly [rows: number, bytes: number] | undefined>> = {
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
};
/** a cell of the listing: the listing's font, whatever the theme gives a text by itself */
const CELL_SX = { font: "inherit", letterSpacing: 0, flexShrink: 0 } as const;

export interface MemoryViewConfig {
  /** Format an address value for display */
  formatAddress: (value: number) => string;
  /** Parse an address string from user input */
  parseAddress: (input: string) => number | undefined;
  /**
   * The highest address a view of a whole slice can start at: `length` bytes from there end at
   * the last address of the target. In a panel that shows fewer rows than a slice has, the view
   * goes further, until the last row of the target is the panel's last whole row.
   */
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
  /**
   * The bytes can be written on this server, now or when the target is paused again: the hex
   * column then has a place for the keyboard, a byte of a row, which Enter opens the editor
   * at. While the bytes cannot be edited now it says so, and keeps the focus it has
   * (default: `editable`).
   */
  writable?: boolean;
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

/**
 * Where a view can stand, for a panel that shows `shown` rows of the listing whole (undefined:
 * not measured yet, which is taken as room for a whole slice).
 *
 * The listing is cut at the edge of its panel and is not scrolled: a row is on screen when the
 * view stands so that it is. So the view goes as far as the place at which the last row of
 * the target is the panel's last whole row, and the slice read there ends at the last address
 * of the target, with as many rows as the panel shows. In a panel with room for a whole slice
 * that is `config.maxAddress`, where the last row of a slice is the last row of the target.
 *
 * An address typed into the box is shown with ten rows of context above it, or with as many as
 * the panel has room for above it: in a panel of ten rows or fewer, that row is the last whole one.
 */
const viewLimits = (config: MemoryViewConfig, shown: number | undefined) => {
  const lastRow = (config.addressMax ?? 0xffffffff) - (BYTES_PER_ROW - 1);
  const sliceRows = Math.ceil(config.length / BYTES_PER_ROW);
  const rows = shown === undefined ? sliceRows : Math.max(1, Math.min(shown, sliceRows));
  return {
    maxStart: Math.max(config.maxAddress, lastRow - (rows - 1) * BYTES_PER_ROW),
    contextRows: Math.min(CONTEXT_ROWS, rows - 1),
  };
};

export const MemoryView = ({
  config,
  callbacks,
  defaultAddress,
  initialized,
  initialUrlAddress,
  refreshSignal,
  editable = false,
  writable = editable,
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
  /** how many rows of the listing the panel shows whole; undefined until rows have been on screen */
  const [shownRows, setShownRows] = useState<number | undefined>(undefined);
  /**
   * How many rows the panel shows whole or in part: the row the edge of the panel cuts is
   * among them, the rows below it are not. Undefined until rows have been on screen.
   */
  const [seenRows, setSeenRows] = useState<number | undefined>(undefined);
  const { maxStart, contextRows } = viewLimits(config, shownRows);

  // Initialize address from URL or default. An address from the URL is treated like a
  // submitted one: aligned to its row and shown with ten rows of context above it. (Or with
  // fewer, in a small panel: see `urlPlacement`.)
  const urlRow = initialUrlAddress ? clampAddress(initialUrlAddress.address, lastRow, BYTES_PER_ROW) : undefined;
  const initialAddress = urlRow !== undefined ? Math.max(0, urlRow - BYTES_PER_ROW * CONTEXT_ROWS) : defaultAddress;
  const [address, setAddress] = useState(initialAddress);
  // Where the view is: the address it was taken to, inside what the panel's size allows.
  const viewStart = clampAddress(address, maxStart, BYTES_PER_ROW);
  const [addressInput, setAddressInput] = useState(config.formatAddress(initialAddress));
  /**
   * The row of an address from the URL, until the rows the panel shows are known: the view is
   * placed again then, with the context that fits above the row. Nothing else moves the view
   * when the panel is measured, and a move of the user's comes first.
   */
  const urlPlacement = useRef(urlRow);

  const requestIdRef = useRef(0);
  const wheelRemainder = useRef(0);
  const pendingScrollDelta = useRef(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  /** the box that scrolls the listing to the side, in a panel narrower than a row */
  const sideScrollRef = useRef<HTMLDivElement | null>(null);
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

  // What the box says where the view is: the address 10 rows down (the intended target; fewer
  // in a panel of ten rows or fewer), not the fetch start, as the target writes its addresses.
  const shownAddress = config.formatAddress(Math.min(lastRow, viewStart + BYTES_PER_ROW * contextRows));

  // The box follows the view when the view moves (a submit, the wheel: a view that has moved
  // says another address), and the target when it writes its addresses in another way, and
  // is rewritten for no other reason. What is being typed has to survive a render in which
  // only the callbacks changed identity, which they do whenever the URL changes, and one in
  // which `config` did, which is made again from every debugger.describe: a connection that
  // is back does not move the view.
  useEffect(() => {
    setAddressInput(shownAddress);
  }, [shownAddress]);

  // (By where the view is, not by the limits: a panel that is measured, or resized, reads
  // nothing unless the view has to move for it.)
  useEffect(() => {
    if (initialized) {
      void fetchSlice(viewStart);
    }
  }, [viewStart, fetchSlice, initialized]);

  const handleRefresh = useCallback(() => {
    void fetchSlice(viewStart);
  }, [fetchSlice, viewStart]);

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

  /** The view `delta` bytes from where it is, inside what the panel's size allows. */
  const movedBy = useCallback(
    (from: number, delta: number) => clampAddress(clampAddress(from, maxStart, BYTES_PER_ROW) + delta, maxStart, BYTES_PER_ROW),
    [maxStart],
  );

  // Process pending scroll delta after loading completes
  useEffect(() => {
    if (!loading && pendingScrollDelta.current !== 0) {
      const delta = pendingScrollDelta.current;
      pendingScrollDelta.current = 0;
      setAddress((prev) => movedBy(prev, delta));
    }
  }, [loading, movedBy]);

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
      setAddress((prev) => movedBy(prev, delta));
    },
    [movedBy],
  );

  /** Moves the view by `delta` bytes; while its bytes are being read, when they are in. */
  const moveView = useCallback(
    (delta: number) => {
      // the user has the view now: it is not placed again for an address of the URL
      urlPlacement.current = undefined;
      if (loading) {
        pendingScrollDelta.current += delta;
      } else {
        adjustAddress(delta);
      }
    },
    [adjustAddress, loading],
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
        moveView(direction * MEMORY_SCROLL_BYTES);
        wheelRemainder.current -= direction * WHEEL_PIXEL_THRESHOLD;
      }
    },
    [moveView],
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

    // Start 10 rows before for context (fewer in a panel that would cut the row off then)
    const contextOffset = BYTES_PER_ROW * contextRows;
    const targetAddress = Math.max(0, alignedAddress - contextOffset);
    const clampedTarget = clampAddress(targetAddress, maxStart, BYTES_PER_ROW);

    urlPlacement.current = undefined;
    setAddress(clampedTarget);
    callbacks.onAddressChange?.(alignedAddress);

    // Highlight the row once it is on screen: right away when the view does not move,
    // otherwise after the new slice has been fetched and rendered (see the rows effect)
    pendingHighlightRef.current = alignedAddress;
    if (clampedTarget === viewStart) {
      applyPendingHighlight();
    }
  }, [addressInput, config, callbacks, viewStart, applyPendingHighlight, lastRow, contextRows, maxStart]);

  /** the rows are on screen, and not what is said in their place (no data, an error, a first read) */
  const listed = initialized && !error && slice !== null && rows.length > 0;
  /**
   * The rows on screen are those of the place the view is at. They are not while the slice of
   * a move is being read (the view has moved, and its rows are still those of the old place),
   * nor when a server has answered with the rows of another place.
   */
  const rowsOfView = listed && slice.baseAddress === viewStart;

  // How many rows the panel shows whole (`viewLimits`), and how many it shows at least a part
  // of (`seenRows`): measured when the rows are on screen, and again when the panel or a row
  // changes size. A row is as high as the first one.
  const rowsRef = useRef<HTMLDivElement | null>(null);
  const measuredConfig = useRef(config);
  /** where the view is, for the measure: the place the rows on screen were read at */
  const measuredView = useRef(viewStart);
  useLayoutEffect(() => {
    measuredConfig.current = config;
    measuredView.current = viewStart;
  });
  // (The panel is measured further down, where the place of the keyboard is known: a panel made
  // smaller takes the place up with its edge.)

  // The editor of a byte: which byte, and where the view was when it was opened. Its box is in
  // the row of that byte, and is there for as long as the row is: an editor whose box is not
  // on screen is put away with what was typed, like one whose box was left. That is so when
  // the view moves (the wheel is turned: the rows are other addresses then), when the rows
  // give way to an error, when the panel is made so small that the row of the editor is below
  // its edge, and when the bytes cannot be written any more (the target runs again, the
  // connection is lost). An editor that stayed open without its box would take the keyboard
  // focus, from wherever it is by then, when its row is shown again.
  const [edit, setEdit] = useState<{ at: number; view: number } | undefined>(undefined);
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
  const editAddress = edit?.at;
  /** the row of the listing the editor is in, if it is in one */
  const editRow = edit === undefined ? -1 : rows.findIndex((row) => edit.at >= row.address && edit.at < row.address + row.length);
  const editShown =
    canEdit &&
    rowsOfView &&
    edit !== undefined &&
    edit.view === viewStart &&
    editRow >= 0 &&
    // (a row the panel shows a part of is on screen; the row the edge cuts is among them)
    (seenRows === undefined || editRow < seenRows);
  const editing = editShown && editor.text !== undefined && editAddress !== undefined;
  const { text: draft, open: openEditor, close: closeEditor } = editor;
  useEffect(() => {
    if (draft !== undefined && !editShown) {
      closeEditor();
    }
  }, [draft, editShown, closeEditor]);

  // The place the keyboard has in the hex column, on a server that writes memory: a row of the
  // listing and a byte of it. It is a place on screen, not an address: the rows are the same
  // ones when the view moves, and show other addresses. The hex column of that row is the one
  // stop of the listing for the Tab key; the arrow keys move the place, Enter, the space bar
  // and F2 open the editor at its byte, and a click on a byte puts it there.
  const hasCursor = writable && initialized && onWriteMemory !== undefined;
  const [cursor, setCursor] = useState({ row: 0, byte: 0 });
  // Inside the listing and inside its row, whatever the rows are now and wherever an arrow took
  // it. (On screen as well: a panel made smaller takes the place up with its edge, to the last
  // row it shows, whole or cut by the edge, where a click can put the place too. See the measure.)
  const cursorRow = Math.max(0, Math.min(cursor.row, rows.length - 1));
  const cursorByte = Math.max(0, Math.min(cursor.byte, (rows[cursorRow]?.length ?? 1) - 1));
  const cursorCell = useRef<HTMLSpanElement | null>(null);
  const cursorMark = useRef<HTMLDivElement | null>(null);
  /** the hex column of the cursor's row takes the focus once it is rendered */
  const focusCursor = useRef(false);
  useLayoutEffect(() => {
    if (!focusCursor.current) {
      return;
    }
    focusCursor.current = false;
    // Nothing is scrolled up or down for it: the listing is cut, not scrolled. To the side the
    // listing is scrolled, in a panel narrower than a row, as far as the byte needs.
    cursorCell.current?.focus();
    const side = sideScrollRef.current;
    // the frame of the byte, which is drawn while the hex column has the focus
    const mark = cursorMark.current?.getBoundingClientRect();
    if (side && mark && mark.width > 0) {
      const left = side.getBoundingClientRect().left + side.clientLeft;
      if (mark.left < left) {
        side.scrollLeft -= left - mark.left;
      } else if (mark.right > left + side.clientWidth) {
        side.scrollLeft += mark.right - (left + side.clientWidth);
      }
    }
  });
  const placeCursor = useCallback((row: number, byte: number) => {
    setCursor({ row, byte });
    focusCursor.current = true;
  }, []);
  // the focus is on the byte again when its editor goes
  const boxFocus = useFocusReturn(editing, cursorCell);

  // The panel is measured: how many rows it shows whole (`viewLimits`) and in part (`seenRows`).
  /** the row the place of the keyboard is on, for the measure */
  const measuredPlace = useRef(cursorRow);
  useLayoutEffect(() => {
    measuredPlace.current = cursorRow;
  });
  useEffect(() => {
    const frame = containerRef.current;
    const first = rowsRef.current?.firstElementChild;
    if (!listed || !frame || !(first instanceof HTMLElement) || typeof ResizeObserver === "undefined") {
      return;
    }
    const measure = () => {
      const row = first.getBoundingClientRect();
      // (a panel that is not on screen, a dock tab behind another, has no size to go by)
      if (!(row.height > 0)) {
        return;
      }
      const room = frame.getBoundingClientRect().bottom - row.top;
      const shown = Math.max(0, Math.floor(room / row.height));
      setShownRows(shown);
      // (a row of which less than a pixel is on screen is not seen)
      const seen = Math.max(0, Math.ceil((room - 1) / row.height));
      setSeenRows(seen);
      if (measuredPlace.current > Math.max(0, seen - 1)) {
        // The place of the keyboard is on a row the panel no longer shows: it comes up with the
        // edge, to the last row the panel shows, and stays there when the panel grows again. It
        // keeps the focus it has (the hex column of the row it leaves is no stop of the Tab key
        // any more, and would let the focus go to the page).
        if (cursorCell.current !== null && cursorCell.current === document.activeElement) {
          focusCursor.current = true;
        }
        setCursor((current) => ({ ...current, row: Math.max(0, seen - 1) }));
      }
      const fromUrl = urlPlacement.current;
      urlPlacement.current = undefined;
      if (fromUrl !== undefined) {
        // A view an address of the URL placed: the row is placed where it is on screen, as a
        // typed address is, in a panel of any size. The first view was placed for a whole slice
        // and ten rows of context; in a panel that has no room for those ten rows, and at the
        // end of the space in a panel that shows fewer rows than a slice, the view moves.
        const limits = viewLimits(measuredConfig.current, shown);
        const placed = clampAddress(Math.max(0, fromUrl - BYTES_PER_ROW * limits.contextRows), limits.maxStart, BYTES_PER_ROW);
        setAddress(placed);
        if (placed !== measuredView.current) {
          // The rows on screen will show other addresses: the row of the URL is marked again
          // when the rows of the new place are in, and the mark of the first view goes (it is on
          // a row that shows another address by then). Where the view does not move, the row of
          // the URL is marked already, in the rows it stays in, and nothing is left to mark later.
          pendingHighlightRef.current = fromUrl;
        }
      }
      // (In a panel that has grown at the end of the space the view comes back as far as it has
      // to, so that the panel is full of rows: `viewStart` is inside the new limits.)
    };
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    observer.observe(first);
    return () => observer.disconnect();
  }, [listed]);

  /**
   * Opens the editor at a byte of a row, with the byte in it. A byte that could not be read
   * ("??") has no value to edit. No editor opens in rows that are not those of the view's place
   * (`rowsOfView`): while the slice of a move is being read the rows on screen are about to show
   * other addresses, and an editor opened in one of them would follow its byte into another row.
   */
  const openEditorAt = useCallback(
    (rowIndex: number, byteIndex: number): boolean => {
      const row = rows[rowIndex];
      // (behind the last byte of a short row there are no digits either)
      const byte = row?.hex.slice(byteIndex * 3, byteIndex * 3 + 2) ?? "";
      if (!canEdit || !rowsOfView || !row || !/^[0-9A-F]{2}$/.test(byte)) {
        return false;
      }
      // (the place of the keyboard is at this byte already: the keys open the editor where the
      // place is, and the first press of a double click has put it there)
      editAddressRef.current = row.address + byteIndex;
      setEdit({ at: row.address + byteIndex, view: viewStart });
      openEditor(byte);
      return true;
    },
    [canEdit, rowsOfView, rows, viewStart, openEditor],
  );

  /** The byte of the hex column a pointer is on: a row is one piece of text, so the byte is found from where in the column the pointer is. */
  const byteAtPointer = useCallback(
    (event: React.MouseEvent<HTMLElement>): { row: number; byte: number } | undefined => {
      const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-memory-hex]");
      const row = cell ? rows.findIndex((candidate) => candidate.address === Number(cell.dataset.memoryHex)) : -1;
      if (!cell || row < 0) {
        return undefined;
      }
      const box = cell.getBoundingClientRect();
      return { row, byte: hexColumnByte(event.clientX - box.left, box.width) };
    },
    [rows],
  );

  // A double click on a byte of the hex column: the editor opens at that byte.
  const handleListingDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const at = byteAtPointer(event);
      if (at && openEditorAt(at.row, at.byte)) {
        // the double click has selected the byte as text: the editor shows it selected instead
        window.getSelection()?.removeAllRanges();
      }
    },
    [byteAtPointer, openEditorAt],
  );

  // A press on a byte of the hex column, with the first button: the place of the keyboard is there.
  const handleListingMouseDown = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      const at = event.button === 0 ? byteAtPointer(event) : undefined;
      if (at) {
        placeCursor(at.row, at.byte);
      }
    },
    [byteAtPointer, placeCursor],
  );

  /** Whether there is such a row, on screen as a whole: the listing is cut at the lower edge of its panel. */
  const rowOnScreen = (index: number): boolean => {
    const row = rows[index];
    const element = row ? lineRefsMap.current.get(row.address) : undefined;
    const frame = containerRef.current?.getBoundingClientRect();
    return element !== undefined && frame !== undefined && element.getBoundingClientRect().bottom <= frame.bottom;
  };

  const handleCursorKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    // with Alt, Ctrl or the command key an arrow is the browser's (back, forward)
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    if (opensEditor(event.key)) {
      event.preventDefault();
      openEditorAt(cursorRow, cursorByte);
      return;
    }
    const step = ARROW_STEPS[event.key];
    if (!step) {
      return;
    }
    event.preventDefault();
    const [rowStep, byteStep] = step;
    // The view stands as far as it goes that way, and its rows are on screen: at the first
    // address, or with the last row of the target the panel's last whole row.
    const viewAtItsEnd = !loading && rowsOfView && (rowStep < 0 ? viewStart <= 0 : viewStart >= maxStart);
    if (rowStep === 0) {
      // (a row has its ends: see cursorByte)
      placeCursor(cursorRow, cursorByte + byteStep);
    } else if (rowOnScreen(cursorRow + rowStep) || (viewAtItsEnd && rows[cursorRow + rowStep] !== undefined)) {
      // (where the view cannot move, a row there is gone to: the last row of the target, which a
      // measure of the panel that is off by a fraction of a pixel may take for one it cuts)
      placeCursor(cursorRow + rowStep, cursorByte);
    } else {
      // The next row is cut off by the edge of the panel, or there is none: the view moves by
      // a row under the place, as a text does under a cursor in its last line.
      moveView(rowStep * BYTES_PER_ROW);
    }
  };

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
        <Box ref={sideScrollRef} sx={{ flex: 1, minHeight: 0, overflow: "auto", containerType: "inline-size" }}>
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
          ) : listed ? (
            <Box
              ref={containerRef}
              sx={{
                height: "100%",
                flex: 1,
                // Never narrower than its rows: what the panel has no room for is scrolled to,
                // and no column is cut off for it.
                minWidth: "min-content",
                // Cut at the edge of the panel, and not scrolled: the rows below the edge are
                // reached by moving the view through its addresses. ("hidden" would be a box
                // that the browser scrolls, for a focus in a row at the edge or for a search
                // in the page, and that nothing scrolls back: the wheel is the view's.)
                overflow: "clip",
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
                ref={rowsRef}
                spacing={0}
                onDoubleClick={handleListingDoubleClick}
                onMouseDown={handleListingMouseDown}
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
                  // The place of the keyboard: a frame around its byte while the hex column of
                  // its row has the focus, in place of a ring around the whole column.
                  "& [data-memory-hex]": {
                    outline: "none",
                  },
                  "& .memory-cursor": {
                    display: "none",
                    position: "absolute",
                    top: 0,
                    bottom: 0,
                    width: "calc(2ch + 4px)",
                    boxSizing: "border-box",
                    border: "1px solid",
                    borderColor: "primary.main",
                    borderRadius: "3px",
                    pointerEvents: "none",
                  },
                  "& [data-memory-hex]:focus ~ .memory-cursor": {
                    display: "block",
                  },
                  "& [data-memory-hex][aria-disabled] ~ .memory-cursor": {
                    borderColor: "action.disabled",
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
                {rows.map((row, index) => {
                  // the byte of this row that is being edited, if one is
                  const edited = editing && editAddress >= row.address && editAddress < row.address + row.length ? editAddress - row.address : undefined;
                  // the byte of this row the keyboard is on, if it is on this row
                  const cursorAt = hasCursor && index === cursorRow ? cursorByte : undefined;
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
                        {...(cursorAt !== undefined && {
                          ref: cursorCell,
                          role: "button",
                          tabIndex: 0,
                          // which byte, what it is, and what the control does
                          "aria-label": `${config.formatAddress(row.address + cursorAt)} ${row.hex.slice(cursorAt * 3, cursorAt * 3 + 2)}, write`,
                          "aria-disabled": !canEdit || undefined,
                          onKeyDown: handleCursorKeyDown,
                        })}
                        sx={{ ...CELL_SX, width: HEX_COLUMN, whiteSpace: "nowrap", mr: COLUMN_GAP, cursor: canEdit ? "text" : undefined }}
                      >
                        {row.hex}
                      </Typography>
                      <Typography component="span" sx={{ ...CELL_SX, width: ASCII_COLUMN, whiteSpace: "pre" }}>
                        {row.ascii}
                      </Typography>
                      {cursorAt !== undefined && (
                        // behind the three cells, like the editor; it is a frame and has no text
                        <div
                          ref={cursorMark}
                          className="memory-cursor"
                          aria-hidden="true"
                          style={{ left: `calc(${ADDRESS_CHARACTERS + GAP_CHARACTERS + cursorAt * 3}ch + ${ROW_PADDING_PX - 2}px)` }}
                        />
                      )}
                      {edited !== undefined && (
                        // Behind the three cells of the row, so that they stay its first three
                        // children; laid over the hex column from the byte that is edited on,
                        // with the digits where those of the byte are.
                        <WriteEditorInput
                          editor={editor}
                          label={`Bytes to write from ${config.formatAddress(row.address + edited)}`}
                          focus={boxFocus}
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
        {listed && loading && (
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
