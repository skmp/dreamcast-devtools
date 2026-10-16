import { PROTOCOL_BOUNDS } from "../../lib/debuggerSchema";

// Pure rules of byte editing in the memory view: which byte of a row a pointer is on, what
// a typed text is as a run of bytes, and what state.writeMemory is sent for it. A run of bytes
// typed in one go is one request, and the server writes all of it or nothing.

export const BYTES_PER_ROW = 16;

/** Characters of the hex column of a full row: two digits a byte and a blank between two bytes. */
export const HEX_COLUMN_CHARACTERS = BYTES_PER_ROW * 3 - 1;

/**
 * The byte of a row that is at `x`, measured from the left edge of the row's hex column, which
 * is `width` wide (the column is `HEX_COLUMN_CHARACTERS` characters of a monospace font). The
 * blank behind a byte belongs to that byte.
 */
export const hexColumnByte = (x: number, width: number): number => {
  if (!(width > 0)) {
    return 0;
  }
  const character = Math.floor((x * HEX_COLUMN_CHARACTERS) / width);
  return Math.min(BYTES_PER_ROW - 1, Math.max(0, Math.floor(character / 3)));
};

/** A byte as the hex column prints it. */
export const formatByte = (value: number): string => value.toString(16).toUpperCase().padStart(2, "0");

export type ByteRun = { ok: true; data: number[] } | { ok: false; reason: string };

/**
 * What was typed, as a run of bytes: hex digits, two a byte, with or without blanks between
 * the bytes ("DE AD BE EF", "deadbeef", "DE ADBE EF"). A group of digits between blanks is its
 * bytes in the order typed, so it has an even number of digits; one digit alone is that byte
 * ("5" is 05). There is no "0x" and no decimal: the column the text is typed into is hex.
 */
export const parseByteRun = (text: string): ByteRun => {
  const groups = text.split(/[ \t]+/).filter((group) => group.length > 0);
  if (groups.length === 0) {
    return { ok: false, reason: "Type the bytes to write: two hex digits a byte" };
  }
  const data: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-fA-F]+$/.test(group)) {
      return { ok: false, reason: `"${group}" is not hex: a byte is two hex digits` };
    }
    if (group.length === 1) {
      data.push(Number.parseInt(group, 16));
      continue;
    }
    if (group.length % 2 !== 0) {
      return { ok: false, reason: `"${group}" has ${group.length} digits: a byte is two hex digits` };
    }
    for (let index = 0; index < group.length; index += 2) {
      data.push(Number.parseInt(group.slice(index, index + 2), 16));
    }
  }
  return { ok: true, data };
};

export type MemoryWrite = { ok: true; address: number; data: number[] } | { ok: false; reason: string };

/**
 * The request of an edit: the bytes typed at `address`, from that address on. Nothing is sent
 * for a text that is no run of bytes, for more bytes than one request takes, and for a run that
 * would pass the last address of the target: the server refuses that one whole, by rule.
 * Whether the bytes can be written where they are (ROM, a register window) is the server's
 * to say.
 */
export const memoryWrite = (
  space: { addressMax: number; formatAddress: (address: number) => string },
  address: number,
  text: string,
): MemoryWrite => {
  const run = parseByteRun(text);
  if (!run.ok) {
    return run;
  }
  const { max } = PROTOCOL_BOUNDS.writeMemoryLength;
  if (run.data.length > max) {
    return { ok: false, reason: `${run.data.length} bytes are more than one write takes (${max})` };
  }
  if (address + run.data.length - 1 > space.addressMax) {
    return {
      ok: false,
      reason: `${run.data.length} bytes from ${space.formatAddress(address)} would pass the last address, ${space.formatAddress(space.addressMax)}`,
    };
  }
  return { ok: true, address, data: run.data };
};
