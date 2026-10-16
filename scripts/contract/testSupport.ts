import { vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { MockDebugger } from "../../server/mockDebugger";
import type { MockDebuggerOptions } from "../../server/mockDebugger";
import { listenMockDebugger } from "../../server/mockWebSocket";
import { runContract } from "./run";
import type { ContractSummary } from "./run";

/**
 * What the tests of the runner share: the mock on a WebSocket, optionally behind a proxy that
 * breaks the protocol in one way per test (a runner that passes a broken server proves
 * nothing), and what reads a summary. A test file closes what it started with `closeServers`
 * in its `afterEach`.
 */

export type Json = Record<string, unknown>;

export interface Faults {
  /** rewrites a frame of the server; undefined drops it; an array sends several */
  toClient?: (frame: Json) => Json | Json[] | undefined;
  /** rewrites a request of the client */
  toServer?: (frame: Json) => Json;
  /** frames the client receives after it has sent a request and before the server sees that request */
  beforeRequest?: (request: Json) => Json[];
  /** answers a request in the server's place: the server does not see a request this returns a frame for */
  answer?: (request: Json) => Json | undefined;
  /** the same for a frame as it arrived, before it is parsed: for what depends on its size, or is no JSON */
  answerText?: (text: string) => Json | undefined;
  /** rewrites a frame of the client as it arrived, before anything else looks at it */
  toServerText?: (text: string) => string;
  /** the largest message the front takes from a client (default: what the mock takes, 1 MiB); above it the connection is closed with 1009 */
  maxPayload?: number;
  /** the close code the client gets when the server closes the connection, in place of the server's */
  closeCode?: (code: number) => number;
  /** a frame of the client for which this is true is lost: the server does not see it, and nothing answers it */
  lose?: (request: unknown) => boolean;
  /** rewrites a binary frame of the server */
  toClientBinary?: (frame: Buffer) => Buffer;
  /** a frame of the server for which this is true is held back until the next binary frame has been sent */
  afterNextBinary?: (frame: Json) => boolean;
}

/** One set of faults for every connection, or a function that makes one per connection (faults that keep state). */
export type FaultSource = Faults | (() => Faults);

export const closers: Array<() => Promise<void>> = [];

/** Closes every server and proxy the tests started, the proxies first. */
export const closeServers = async (): Promise<void> => {
  for (const close of closers.splice(0)) {
    await close();
  }
};

/**
 * The wall clock of this process with a hand on it, until the test is over: `ahead` is how many
 * ms it reads more than it did. (The mock stamps its ticks with the same clock, as a server on
 * this machine would.) The deadlines and durations of the runner are not taken from it.
 */
export const wallClock = (): { ahead: number } => {
  const read = Date.now.bind(Date);
  const clock = { ahead: 0 };
  const spy = vi.spyOn(Date, "now").mockImplementation(() => read() + clock.ahead);
  closers.push(() => Promise.resolve(spy.mockRestore()));
  return clock;
};

/**
 * The mock on a WebSocket, optionally behind a proxy that applies `faults`. Returns the URL
 * to test, and `direct`, the URL of the mock itself (what a client sees that is not behind
 * the proxy).
 */
export const startServer = async (
  source?: FaultSource,
  options?: MockDebuggerOptions | MockDebugger,
): Promise<{ url: string; direct: string; mock: MockDebugger }> => {
  const mock = options instanceof MockDebugger ? options : new MockDebugger(options);
  const listener = await listenMockDebugger(mock);
  closers.push(() => listener.close());
  if (!source) {
    return { url: listener.url, direct: listener.url, mock };
  }

  // (the front takes any size, unless told otherwise: what is too large is the server's to refuse)
  const limits = typeof source === "function" ? source() : source;
  const proxy = new WebSocketServer({ port: 0, host: "127.0.0.1", maxPayload: limits.maxPayload ?? 64 * 1048576 });
  await new Promise<void>((resolve) => proxy.once("listening", resolve));
  closers.unshift(
    () =>
      new Promise<void>((resolve) => {
        proxy.clients.forEach((client) => client.terminate());
        proxy.close(() => resolve());
      }),
  );
  proxy.on("connection", (client) => {
    const faults = typeof source === "function" ? source() : source;
    const upstream = new WebSocket(listener.url);
    const early: string[] = [];
    const held: Json[] = [];
    client.on("message", (data) => {
      let text = faults.toServerText ? faults.toServerText(data.toString()) : data.toString();
      let answered: Json | undefined = faults.answerText?.(text);
      if (answered) {
        client.send(JSON.stringify(answered));
        return;
      }
      try {
        const request = JSON.parse(text) as Json;
        if (faults.lose?.(request)) {
          return;
        }
        faults.beforeRequest?.(request).forEach((frame) => client.send(JSON.stringify(frame)));
        answered = faults.answer?.(request);
        // (a request the fault leaves as it is goes on as it arrived: its size is part of what some rules send)
        const rewritten = faults.toServer ? faults.toServer(request) : request;
        if (rewritten !== request) {
          text = JSON.stringify(rewritten);
        }
      } catch {
        // not JSON: the runner's malformed frame goes through as it is
      }
      if (answered) {
        client.send(JSON.stringify(answered));
        return;
      }
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(text);
      } else {
        early.push(text);
      }
    });
    upstream.on("open", () => early.splice(0).forEach((text) => upstream.send(text)));
    upstream.on("message", (data, isBinary) => {
      if (isBinary) {
        const frame = Buffer.from(data as Buffer);
        client.send(faults.toClientBinary ? faults.toClientBinary(frame) : frame, { binary: true });
        held.splice(0).forEach((late) => client.send(JSON.stringify(late)));
        return;
      }
      const frame = JSON.parse(data.toString()) as Json;
      if (faults.afterNextBinary?.(frame)) {
        held.push(frame);
        return;
      }
      const rewritten = faults.toClient ? faults.toClient(frame) : frame;
      for (const out of rewritten === undefined ? [] : Array.isArray(rewritten) ? rewritten : [rewritten]) {
        client.send(JSON.stringify(out));
      }
    });
    client.on("close", () => upstream.close());
    // the client is told how the server ended the connection (1009: the message was too big)
    upstream.on("close", (code) => {
      const told = faults.closeCode ? faults.closeCode(code) : code;
      client.close(told >= 1000 && told !== 1004 && told !== 1005 && told !== 1006 ? told : undefined);
    });
    upstream.on("error", () => undefined);
    client.on("error", () => undefined);
  });
  return { url: `ws://127.0.0.1:${(proxy.address() as AddressInfo).port}/ws`, direct: listener.url, mock };
};

export const run = async (faults: FaultSource | undefined, only?: string[], options?: MockDebuggerOptions): Promise<ContractSummary> => {
  const { url } = await startServer(faults, options);
  return runContract({ url, profile: "mock", only: only ? new Set(only) : undefined });
};

/** What a new client of the server sees: the tick that follows its debugger.describe. */
export const stateOf = async (url: string): Promise<Json & { executionState: Json; breakpoints: Record<string, Json>; watches: Json[]; categories: Record<string, Json> }> => {
  const probe = new WebSocket(url);
  try {
    return await new Promise((resolve, reject) => {
      probe.on("error", reject);
      probe.on("open", () => probe.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "debugger.describe", params: {} })));
      let described = false;
      probe.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Json;
        if (frame.id === 1) {
          described = true;
        } else if (described && isTick(frame)) {
          resolve(frame.params as never);
        }
      });
    });
  } finally {
    probe.close();
  }
};

/** Sends requests to the server as another client would, and resolves when the last one is answered. */
export const request = async (url: string, requests: Array<[method: string, params: Json]>): Promise<void> => {
  const socket = new WebSocket(url);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.on("error", reject);
      socket.on("open", () => requests.forEach(([method, params], index) => socket.send(JSON.stringify({ jsonrpc: "2.0", id: index + 1, method, params }))));
      socket.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as Json;
        if (frame.id === requests.length) {
          resolve();
        }
      });
    });
  } finally {
    socket.close();
  }
};

/** One request to the mock as a client of its own (no socket), and what it answered. */
export const ask = (mock: MockDebugger, method: string, params: Json): Json => {
  const frames: Json[] = [];
  const client = mock.connect({ sendText: (text) => frames.push(JSON.parse(text) as Json), sendBinary: () => undefined });
  client.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  client.close();
  return frames.find((frame) => frame.id === 1)!;
};

export const isTick = (frame: Json): frame is Json & { params: Json & { executionState: Json; registers: Record<string, Json[]> } } =>
  frame.method === "event.tick";

/** The answers of a server that refuses a request: on the channel of the result, or as a JSON-RPC error. */
export const inBand = (request: Json, code: number, message: string): Json => ({ jsonrpc: "2.0", id: request.id, result: { error: { code, message } } });
export const rpcError = (request: Json, code: number, message: string): Json => ({ jsonrpc: "2.0", id: request.id, error: { code, message } });
export const paramsOf = (request: Json): Json => (request.params ?? {}) as Json;

/** A frame of the server with the message of every error it carries, on either channel, replaced by `text(code, message)`. */
export const worded = (frame: Json, text: (code: number, message: string) => string): Json => {
  const reword = (error: Json) => ({ ...error, message: text(error.code as number, error.message as string) });
  if (frame.error) {
    return { ...frame, error: reword(frame.error as Json) };
  }
  const inBandError = (frame.result as Json | undefined)?.error as Json | undefined;
  return inBandError && typeof inBandError === "object" ? { ...frame, result: { ...(frame.result as Json), error: reword(inBandError) } } : frame;
};

export const statusOf = (summary: ContractSummary, id: string) => summary.scenarios.find((scenario) => scenario.id === id)?.status;
export const detailsOf = (summary: ContractSummary, id: string) => summary.scenarios.find((scenario) => scenario.id === id)?.details.join("\n") ?? "";

export const statusesOf = (summary: ContractSummary) => Object.fromEntries(summary.scenarios.map((scenario) => [scenario.id, scenario.status]));
/** One line per scenario that did not pass as a whole, for a readable failure of a test. */
export const reportOf = (summary: ContractSummary) => summary.scenarios.map((scenario) => `${scenario.id} ${scenario.status} ${scenario.details.join(" | ")}`);


/** Drops the one tick that follows the response to a request for which `matches` is true. One per connection. */
export const noTickAfter = (matches: (request: Json) => boolean): Faults => {
  const ids = new Set<unknown>();
  let drop = false;
  return {
    toServer: (frame) => {
      if (matches(frame)) ids.add(frame.id);
      return frame;
    },
    toClient: (frame) => {
      if (isTick(frame)) {
        const dropped = drop;
        drop = false;
        return dropped ? undefined : frame;
      }
      drop = ids.delete(frame.id);
      return frame;
    },
  };
};

/**
 * The requests whose success the mock follows with a tick: the tables and the writes (a tick to
 * every client, design 2.9), and the run control that changes the state. (Not control.pause: a
 * target that is paused already answers it with no tick behind.)
 */
const TICKED_METHODS = new Set([
  "breakpoints.add",
  "breakpoints.remove",
  "breakpoints.toggle",
  "breakpoints.setCategoryStates",
  "state.watch",
  "state.unwatch",
  "state.modifyWatchExpression",
  "state.editWatch",
  "state.setRegister",
  "state.writeMemory",
  "control.runUntil",
  "control.step",
  "control.stepOver",
  "control.stepOut",
  "control.reset",
]);

/**
 * A server that sends the tick of such a request in front of the response to it, where the
 * mock sends it behind: the emulator's order for the tables (it builds the tick inside the
 * call and answers when the call has returned), and as legal as the mock's for every request
 * (design 2.9, "Order"). The response waits for the next tick, which for a request that
 * changed nothing in a running target is the periodic one. One per connection;
 * `count.reordered` is how many responses went behind a tick.
 */
export const tickBeforeResponse = (count: { reordered: number } = { reordered: 0 }): Faults => {
  const ids = new Set<unknown>();
  let held: Json | undefined;
  return {
    toServer: (frame) => {
      if (TICKED_METHODS.has(String(frame.method))) ids.add(frame.id);
      return frame;
    },
    toClient: (frame) => {
      if (held) {
        const response = held;
        held = undefined;
        // (the mock sends the tick directly behind the response; anything else keeps its order)
        if (!isTick(frame)) return [response, frame];
        count.reordered++;
        return [frame, response];
      }
      const succeeded = !isTick(frame) && frame.error === undefined && (frame.result as Json | undefined)?.error === undefined;
      if (ids.delete(frame.id) && succeeded) {
        held = frame;
        return undefined;
      }
      return frame;
    },
  };
};

/** A server whose debugger.describe result is rewritten, and whose ticks are (for a tree that lists other registers). */
export const describing = (
  rewrite: (result: Json & { targets: Array<Json & { id: string }>; deviceTree: Json[] }) => Json,
  registers?: (registers: Record<string, Json[]>) => Record<string, Json[]>,
): Faults => ({
  toClient: (frame) => {
    if (isTick(frame)) {
      return registers ? { ...frame, params: { ...frame.params, registers: registers(frame.params.registers) } } : frame;
    }
    const result = frame.result as (Json & { targets: Array<Json & { id: string }>; deviceTree: Json[] }) | undefined;
    return result?.deviceTree ? { ...frame, result: rewrite(result) } : frame;
  },
});
/** Every node of a tree, rewritten (undefined: the node is left out). */
export const mapNodes = (nodes: Json[], rewrite: (node: Json) => Json | undefined): Json[] =>
  nodes.flatMap((node) => {
    const rewritten = rewrite(node);
    if (!rewritten) return [];
    const children = rewritten.children as Json[] | undefined;
    return [children ? { ...rewritten, children: mapNodes(children, rewrite) } : rewritten];
  });

