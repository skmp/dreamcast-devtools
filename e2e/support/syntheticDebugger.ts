import type { Page, WebSocketRoute } from "@playwright/test";
import { V3_TARGETS } from "./scriptedDebugger";

/**
 * A debugger server that lives inside the test: the page's WebSocket to /ws is answered
 * here (page.routeWebSocket) instead of by the mock. It is a server of protocol v3 with a
 * device tree of any size: its describe result and its ticks carry every field such a server
 * always sends, so the page that is measured is the page of a server the UI supports, with
 * its three targets and without the banner of another protocol version. It answers the
 * reads with nothing and sends ticks on demand. The static files are still served by the
 * mock server.
 *
 * It writes registers, as a server of milestone M2 does: it lists `register-write`, every
 * register of its describe result carries `flags.writable` (and none of a tick does), and
 * state.setRegister stores the value and sends a tick. Its first node offers the panel
 * `sh4-registers`, so the register panel of the SH4 workspace shows that node: what is
 * measured there is a table whose every row is one that can be edited.
 */
export interface SyntheticTree {
  /** number of nodes under the root node "dc" */
  nodes: number;
  /** registers per node */
  registersPerNode: number;
  /**
   * Entries of the event log, which every tick carries whole (default: none). A server whose
   * log is full sends 200 of them: with some three thousand registers that is the paused tick
   * of the emulator, about 165 KB.
   */
  eventLog?: number;
}

/** The panel the first node of the synthetic tree offers as an action. */
export const SYNTHETIC_PANEL = "sh4-registers";

export interface SyntheticDebugger {
  readonly nodePath: (index: number) => string;
  readonly registerName: (index: number) => string;
  /** Current value of a register, as the ticks report it. */
  readonly value: (node: number, register: number) => string;
  /**
   * Sends one event.tick with the complete state (as the protocol does today). `change`
   * lists the nodes whose first register gets a new value in this tick.
   */
  readonly tick: (change?: number[]) => void;
  /** Resolves when the client has asked for debugger.describe and got its first tick. */
  readonly ready: Promise<void>;
  readonly requests: Array<{ method: string; params: unknown }>;
  /** Its debugger.describe result and the tick it sent last, for a test that holds them to the schema. */
  readonly sent: { describe?: unknown; tick?: unknown };
  /** How many bytes the tick it sent last is on the wire. */
  readonly tickBytes: () => number;
}

const pad = (value: number, width: number) => value.toString().padStart(width, "0");

export const serveSyntheticDebugger = async (page: Page, tree: SyntheticTree): Promise<SyntheticDebugger> => {
  const nodePath = (index: number) => `dc.n${pad(index, 3)}`;
  const registerName = (index: number) => `R${pad(index, 2)}`;
  // values[node][register]
  const values = Array.from({ length: tree.nodes }, (_, node) =>
    Array.from({ length: tree.registersPerNode }, (_, register) => node * 0x100 + register),
  );
  const format = (value: number) => `0x${value.toString(16).toUpperCase().padStart(8, "0")}`;
  const value = (node: number, register: number) => format(values[node][register]);
  // as a tick carries them; debugger.describe adds what is said of a register once
  const registersOf = (node: number) =>
    values[node].map((current, register) => ({ name: registerName(register), value: format(current), width: 32 }));
  const describedRegistersOf = (node: number) => registersOf(node).map((register) => ({ ...register, flags: { writable: true } }));
  const eventLog = Array.from({ length: tree.eventLog ?? 0 }, (_, index) => ({
    eventId: String(index + 1),
    timestamp: 1_700_000_000_000 + index,
    subsystem: "sh4",
    severity: "info",
    message: "interrupt accepted: vblank in",
    metadata: { event: "dc.sh4.interrupt", cycles: String(1_000_000_000 + index * 448) },
  }));

  const describe = () => ({
    emulator: { name: "synthetic", version: "e2e", build: "native" },
    protocol: 3,
    ui: "none",
    capabilities: ["event-breakpoints", "callstack", "register-write"],
    targets: V3_TARGETS.map((target) => ({ ...target })),
    deviceTree: [
      {
        path: "dc",
        label: "Synthetic",
        description: `${tree.nodes} nodes x ${tree.registersPerNode} registers`,
        children: Array.from({ length: tree.nodes }, (_, node) => ({
          path: nodePath(node),
          label: `Node ${pad(node, 3)}`,
          description: "synthetic device",
          registers: describedRegistersOf(node),
          ...(node === 0 ? { actions: [SYNTHETIC_PANEL] } : {}),
        })),
      },
    ],
  });

  let tickId = 0;
  const unmuted = { muted: false, soloed: false };
  // paused in one stop from the first tick to the last: no tick after the first moves a view
  const buildTick = () => ({
    tickId: tickId++,
    timestamp: Date.now(),
    executionState: { state: "paused", stopId: 1, reason: "pause" },
    registers: Object.fromEntries(Array.from({ length: tree.nodes }, (_, node) => [nodePath(node), registersOf(node)])),
    breakpoints: {},
    eventLog,
    watches: [],
    callstacks: { sh4: [], arm7: [] },
    categories: { events: unmuted, sh4: unmuted, arm7: unmuted, dsp: unmuted },
  });

  let socket: WebSocketRoute | undefined;
  const requests: SyntheticDebugger["requests"] = [];
  const sent: SyntheticDebugger["sent"] = {};
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  let tickBytes = 0;
  const sendTick = () => {
    sent.tick = buildTick();
    const frame = JSON.stringify({ jsonrpc: "2.0", method: "event.tick", params: sent.tick });
    tickBytes = Buffer.byteLength(frame);
    socket?.send(frame);
  };

  /**
   * state.setRegister as a server of protocol v3 answers it: the path and the name without
   * regard to case, the value "0x" hex or decimal of which the low 32 bits count, and a tick
   * behind the answer.
   */
  const setRegister = (params: { path?: string; name?: string; value?: string }): unknown => {
    const node = Array.from({ length: tree.nodes }, (_, index) => index).find((index) => nodePath(index) === params.path?.toLowerCase());
    const register = Array.from({ length: tree.registersPerNode }, (_, index) => index).find(
      (index) => registerName(index).toLowerCase() === params.name?.toLowerCase(),
    );
    if (node === undefined || register === undefined) {
      return { error: { code: -32602, message: `invalid params: ${params.path} has no register ${params.name}` } };
    }
    const text = (params.value ?? "").trim();
    if (!/^(0[xX][0-9a-fA-F]+|[0-9]+)$/.test(text)) {
      return { error: { code: -32602, message: `invalid params: value: "${params.value}" is neither 0x hex nor decimal` } };
    }
    values[node][register] = Number(BigInt(text) & 0xffffffffn);
    return {};
  };

  await page.routeWebSocket(/\/ws$/, (route) => {
    socket = route;
    route.onMessage((message) => {
      const request = JSON.parse(String(message)) as {
        id: number;
        method: string;
        params: { address?: number; path?: string; name?: string; value?: string };
      };
      requests.push({ method: request.method, params: request.params });
      const respond = (result: unknown) => route.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
      switch (request.method) {
        case "debugger.describe":
          sent.describe = describe();
          respond(sent.describe);
          sendTick();
          markReady();
          break;
        case "state.getDisassembly":
          respond({ lines: [] });
          break;
        case "state.getMemorySlice":
          respond({ baseAddress: request.params.address ?? 0, data: [], validity: "ok" });
          break;
        case "state.setRegister": {
          const answer = setRegister(request.params);
          respond(answer);
          if (!(answer as { error?: unknown }).error) {
            sendTick();
          }
          break;
        }
        default:
          respond({});
          break;
      }
    });
  });

  return {
    nodePath,
    registerName,
    value,
    ready,
    requests,
    sent,
    tickBytes: () => tickBytes,
    tick(change = []) {
      for (const node of change) {
        values[node][0] += 1;
      }
      sendTick();
    },
  };
};
