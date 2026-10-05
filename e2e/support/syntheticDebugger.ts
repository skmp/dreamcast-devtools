import type { Page, WebSocketRoute } from "@playwright/test";

/**
 * A debugger server that lives inside the test: the page's WebSocket to /ws is answered
 * here (page.routeWebSocket) instead of by the mock. It speaks just enough of the protocol
 * for a workspace to come up, with a device tree of any size, and sends ticks on demand.
 * The static files are still served by the mock server.
 */
export interface SyntheticTree {
  /** number of nodes under the root node "dc" */
  nodes: number;
  /** registers per node */
  registersPerNode: number;
}

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
  const registersOf = (node: number) =>
    values[node].map((current, register) => ({ name: registerName(register), value: format(current), width: 32 }));

  const describe = () => ({
    emulator: { name: "synthetic", version: "e2e", build: "native" },
    deviceTree: [
      {
        path: "dc",
        label: "Synthetic",
        description: `${tree.nodes} nodes x ${tree.registersPerNode} registers`,
        children: Array.from({ length: tree.nodes }, (_, node) => ({
          path: nodePath(node),
          label: `Node ${pad(node, 3)}`,
          description: "synthetic device",
          registers: registersOf(node),
        })),
      },
    ],
  });

  let tickId = 0;
  const buildTick = () => ({
    tickId: tickId++,
    timestamp: Date.now(),
    executionState: { state: "paused" },
    registers: Object.fromEntries(Array.from({ length: tree.nodes }, (_, node) => [nodePath(node), registersOf(node)])),
    breakpoints: {},
    eventLog: [],
    watches: [],
    callstacks: { sh4: [], arm7: [] },
  });

  let socket: WebSocketRoute | undefined;
  const requests: SyntheticDebugger["requests"] = [];
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });

  const sendTick = () => {
    socket?.send(JSON.stringify({ jsonrpc: "2.0", method: "event.tick", params: buildTick() }));
  };

  await page.routeWebSocket(/\/ws$/, (route) => {
    socket = route;
    route.onMessage((message) => {
      const request = JSON.parse(String(message)) as { id: number; method: string; params: { address?: number } };
      requests.push({ method: request.method, params: request.params });
      const respond = (result: unknown) => route.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
      switch (request.method) {
        case "debugger.describe":
          respond(describe());
          sendTick();
          markReady();
          break;
        case "state.getDisassembly":
          respond({ lines: [] });
          break;
        case "state.getMemorySlice":
          respond({ baseAddress: request.params.address ?? 0, data: [], validity: "ok" });
          break;
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
    tick(change = []) {
      for (const node of change) {
        values[node][0] += 1;
      }
      sendTick();
    },
  };
};
