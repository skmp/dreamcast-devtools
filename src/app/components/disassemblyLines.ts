import type { DisassemblyLine } from "../../lib/debuggerSchema";

/**
 * The lines of an answer, each address once: the first line of an address is kept. A line is
 * known to the view by its address (its marker, its breakpoint, its place on screen), and a
 * server that lists an address twice would have two lines stand for one: the second one stays
 * on screen when the next answer no longer has it.
 */
export const uniqueLines = (lines: DisassemblyLine[]): DisassemblyLine[] => {
  const seen = new Set<number>();
  return lines.filter((line) => {
    if (seen.has(line.address)) {
      return false;
    }
    seen.add(line.address);
    return true;
  });
};
