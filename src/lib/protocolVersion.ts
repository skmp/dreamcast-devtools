/**
 * Version of the debugger protocol this UI speaks. The client sends it in `debugger.describe`,
 * a v3 server reports its own in the result, and the build writes it into `bundle-info.json`,
 * where the emulator's build compares it with its `dbg::kProtocolVersion`.
 *
 * This module has no imports on purpose: the Vite config loads it.
 */
export const PROTOCOL_VERSION = 3;
