import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page, WebSocketRoute } from "@playwright/test";
import { REPO_ROOT } from "./paths";

/**
 * A debugger server that the test writes: the page's WebSocket to /ws is answered here
 * (page.routeWebSocket), and nothing is sent that the test did not ask for. The page itself
 * is still served by the mock server.
 *
 * It exists for what the mock cannot be asked to do: send exactly this tick and no other,
 * answer a request with an error, send a message that breaks the schema, or be a server of
 * protocol v2. The test changes `shape` (what debugger.describe answers) and `state` (what
 * the next tick is built from) and calls `tick()`.
 */

export type Json = Record<string, unknown>;

export interface ScriptedRegister {
  name: string;
  value: string;
  width: number;
}

export interface ScriptedState {
  /** `executionState` of the next tick, as it is */
  execution: Json;
  /** every register the server has, by path; a tick carries all of them unless told otherwise */
  registers: Record<string, ScriptedRegister[]>;
  breakpoints: Record<string, Json>;
  eventLog: Json[];
  /** undefined: the tick has no such key (protocol v2 had it optional) */
  watches: Json[] | undefined;
  callstacks: Json | undefined;
  categories: Json | undefined;
}

const JSON_RPC_ERROR = Symbol("JSON-RPC error");

/** A JSON-RPC error as the answer of a handler. Anything else a handler returns is the result. */
export interface JsonRpcErrorAnswer {
  [JSON_RPC_ERROR]: { code: number; message: string };
}

/** What a handler returns to answer with a JSON-RPC error (the top-level `error` member). */
export const jsonRpcError = (code: number, message: string): JsonRpcErrorAnswer => ({ [JSON_RPC_ERROR]: { code, message } });

/** What a handler returns to answer in-band: the result `{ error }` of the methods whose success is `{}`. */
export const inBandError = (code: number, message: string) => ({ error: { code, message } });

export interface ScriptedDebugger {
  /** The result of debugger.describe. Change it before the page connects. */
  shape: Json;
  /** Builds `shape` again as a protocol v3 description of the registers `state` has now. */
  describeAgain(): void;
  /**
   * What follows the debugger.describe response: by default a tick with everything; the
   * options of a tick to send instead; or a function that sends whatever it wants.
   */
  afterDescribe: { paths?: string[]; patch?: Json } | (() => void) | undefined;
  state: ScriptedState;
  /** Sets the value of one register in `state` (the next tick carries it). */
  setRegister(path: string, name: string, value: string): void;
  /**
   * Sends one event.tick built from `state`. `paths` limits its registers to those paths (a
   * running tick of a v3 server carries only some); `patch` replaces top-level members of the
   * tick, and a member set to undefined is left out.
   */
  tick(options?: { paths?: string[]; patch?: Json }): void;
  /** Sends any JSON message, or any text, as a frame. */
  send(message: unknown): void;
  /**
   * How a method is answered from now on: the handler returns the result, or `jsonRpcError()`,
   * or a promise of either, and the request is then answered when the promise resolves (a
   * server that takes its time). Without a handler debugger.describe answers `shape` and
   * sends a tick, the three reads answer generated data (`defaultAnswer`), and everything
   * else answers {}.
   */
  answer(method: string, handler: (params: Json) => unknown): void;
  /** Every request received, in order. */
  readonly requests: Array<{ method: string; params: Json }>;
  requestsOf(method: string): Json[];
  /** How many WebSockets the page has opened here. */
  readonly connections: () => number;
  /** Ends the current connection from the server's side. */
  drop(): void;
  /** Resolves when debugger.describe has been answered (and the tick after it sent) on the current connection. */
  described(): Promise<void>;
}

/** `targets` of a protocol v3 server (design 3.1). */
export const V3_TARGETS: Json[] = [
  {
    id: "sh4",
    label: "SH4",
    pcPath: "dc.sh4.cpu",
    pcRegister: "PC",
    breakpointEvent: "dc.sh4.cpu.pc",
    instructionSize: 2,
    addressMax: 0xffffffff,
    addressRadix: 16,
    addressDigits: 8,
    defaultDisassemblyAddress: 0x8c010000,
    defaultMemoryAddress: 0x8c010000,
    memory: true,
    stepping: true,
  },
  {
    id: "arm7",
    label: "ARM7",
    pcPath: "dc.aica.arm7",
    pcRegister: "PC",
    breakpointEvent: "dc.aica.arm7.pc",
    instructionSize: 4,
    addressMax: 0x00ffffff,
    addressRadix: 16,
    addressDigits: 8,
    defaultDisassemblyAddress: 0,
    defaultMemoryAddress: 0,
    memory: true,
    stepping: true,
  },
  {
    id: "dsp",
    label: "DSP",
    pcPath: "dc.aica.dsp",
    pcRegister: "STEP",
    breakpointEvent: "dc.aica.dsp.step",
    instructionSize: 1,
    addressMax: 127,
    addressRadix: 10,
    addressDigits: 3,
    defaultDisassemblyAddress: 0,
    memory: false,
    stepping: true,
  },
];

const INSTRUCTION_SIZES: Record<string, number> = { sh4: 2, arm7: 4, dsp: 1 };

const DEFAULT_ANSWERS: Record<string, (params: Json) => unknown> = {
  "state.getDisassembly": (params) => {
    const size = INSTRUCTION_SIZES[String(params.target ?? "sh4")] ?? 2;
    const address = Number(params.address);
    return {
      lines: Array.from({ length: Number(params.count) }, (_, index) => ({
        address: address + index * size,
        bytes: size === 1 ? "00" : size === 2 ? "09 00" : "00 00 A0 E1",
        // short enough for one line of a narrow panel
        disassembly: "nop",
      })),
    };
  },
  "state.getMemorySlice": (params) => ({
    baseAddress: Number(params.address),
    data: Array.from({ length: Number(params.length) }, (_, index) => (Number(params.address) + index) & 0xff),
    validity: "ok",
  }),
  "state.getCallstack": (params) => ({ target: params.target, frames: [] }),
};

/** What the scripted server answers to one of the three reads when the test gave it no handler: generated data. */
export const defaultAnswer = (method: "state.getDisassembly" | "state.getMemorySlice" | "state.getCallstack", params: Json): unknown =>
  DEFAULT_ANSWERS[method](params);

const initialRegisters = (): Record<string, ScriptedRegister[]> => ({
  dc: [{ name: "SYSCLK", value: "200MHz", width: 0 }],
  "dc.sh4.cpu": [
    { name: "PC", value: "0x8C001000", width: 32 },
    { name: "PR", value: "0x8C000F00", width: 32 },
    { name: "R15", value: "0x8CFFF000", width: 32 },
  ],
  "dc.sh4.tmu": [{ name: "TCNT0", value: "0xFFFFFFFF", width: 32 }],
  "dc.aica.arm7": [{ name: "PC", value: "0x00000100", width: 32 }],
  "dc.aica.dsp": [{ name: "STEP", value: "0x0000", width: 16 }],
  "dc.timing": [{ name: "SH4_CYCLES", value: "0x0000000000000000", width: 64 }],
});

const describeV3 = (registers: Record<string, ScriptedRegister[]>): Json => {
  const node = (path: string, label: string, extra: Json = {}): Json => ({
    path,
    label,
    description: `${label} of the scripted server`,
    ...(registers[path] ? { registers: registers[path].map((register) => ({ ...register })) } : {}),
    ...extra,
  });
  return {
    emulator: { name: "scripted", version: "e2e", build: "native" },
    protocol: 3,
    ui: "none",
    capabilities: ["event-breakpoints", "callstack"],
    targets: V3_TARGETS.map((target) => ({ ...target })),
    deviceTree: [
      node("dc", "Dreamcast", {
        events: ["dc.system.reset"],
        children: [
          node("dc.sh4", "SH4", {
            children: [
              node("dc.sh4.cpu", "Core", { actions: ["sh4-disassembly", "sh4-memory"] }),
              node("dc.sh4.tmu", "TMU", { actions: ["tmu-registers"] }),
            ],
          }),
          node("dc.aica", "AICA", {
            children: [
              node("dc.aica.arm7", "ARM7", { actions: ["arm7-disassembly", "arm7-memory"] }),
              node("dc.aica.dsp", "DSP", { actions: ["dsp-disassembly"] }),
            ],
          }),
          node("dc.system", "System", { children: [node("dc.timing", "Timing")] }),
        ],
      }),
    ],
  };
};

/**
 * Serves the scripted debugger to the page. The server starts paused, in stop 1 with reason
 * "pause", and describes itself as a protocol v3 server with the three targets.
 */
export const serveScriptedDebugger = async (page: Page): Promise<ScriptedDebugger> => {
  const state: ScriptedState = {
    execution: { state: "paused", stopId: 1, reason: "pause" },
    registers: initialRegisters(),
    breakpoints: {},
    eventLog: [],
    watches: [],
    callstacks: { sh4: [], arm7: [] },
    categories: {
      events: { muted: false, soloed: false },
      sh4: { muted: false, soloed: false },
      arm7: { muted: false, soloed: false },
      dsp: { muted: false, soloed: false },
    },
  };
  const requests: ScriptedDebugger["requests"] = [];
  const handlers = new Map<string, (params: Json) => unknown>();
  let socket: WebSocketRoute | undefined;
  let connections = 0;
  let tickId = 0;
  let describedOn = 0;
  let waiters: Array<() => void> = [];

  const server: ScriptedDebugger = {
    shape: describeV3(state.registers),
    describeAgain() {
      server.shape = describeV3(state.registers);
    },
    afterDescribe: undefined,
    state,
    requests,
    requestsOf: (method) => requests.filter((request) => request.method === method).map((request) => request.params),
    connections: () => connections,
    setRegister(path, name, value) {
      const register = state.registers[path]?.find((candidate) => candidate.name === name);
      if (!register) {
        throw new Error(`the scripted server has no register ${path}.${name}`);
      }
      register.value = value;
    },
    tick({ paths, patch } = {}) {
      const registers = Object.fromEntries(
        Object.entries(state.registers)
          .filter(([path]) => !paths || paths.includes(path))
          .map(([path, list]) => [path, list.map((register) => ({ ...register }))]),
      );
      const tick: Json = {
        tickId: tickId++,
        timestamp: Date.now(),
        executionState: state.execution,
        registers,
        breakpoints: state.breakpoints,
        eventLog: state.eventLog,
        watches: state.watches,
        callstacks: state.callstacks,
        categories: state.categories,
        ...patch,
      };
      // JSON.stringify leaves out what is undefined: the key is then absent
      server.send({ jsonrpc: "2.0", method: "event.tick", params: tick });
    },
    send(message) {
      socket?.send(typeof message === "string" ? message : JSON.stringify(message));
    },
    answer(method, handler) {
      handlers.set(method, handler);
    },
    drop() {
      void socket?.close();
      socket = undefined;
    },
    described() {
      if (describedOn === connections && connections > 0) {
        return Promise.resolve();
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
  };

  await page.routeWebSocket(/\/ws$/, (route) => {
    socket = route;
    connections++;
    const connection = connections;
    route.onMessage((message) => {
      const request = JSON.parse(String(message)) as { id: number; method: string; params?: Json };
      const params = request.params ?? {};
      requests.push({ method: request.method, params });
      const respond = (answer: unknown) => {
        const failure = typeof answer === "object" && answer !== null ? (answer as Partial<JsonRpcErrorAnswer>)[JSON_RPC_ERROR] : undefined;
        route.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(failure ? { error: failure } : { result: answer }) }));
      };
      const handler = handlers.get(request.method);
      if (handler) {
        const answer = handler(params);
        if (answer instanceof Promise) {
          void answer.then(respond);
        } else {
          respond(answer);
        }
      } else if (request.method === "debugger.describe") {
        // the response first, then a full tick to this client
        respond(server.shape);
        if (typeof server.afterDescribe === "function") {
          server.afterDescribe();
        } else {
          server.tick(server.afterDescribe);
        }
        describedOn = connection;
        waiters.splice(0).forEach((resolve) => resolve());
      } else if (DEFAULT_ANSWERS[request.method]) {
        respond(DEFAULT_ANSWERS[request.method](params));
      } else {
        respond({});
      }
    });
  });

  waiters = [];
  return server;
};

/** One frame of a protocol v2 session, as the mock sent it before protocol v3. */
export interface CapturedFrame {
  id?: number;
  method?: string;
  params?: Json;
  result?: Json;
}

/**
 * The frames of a session with the protocol v2 mock (src/lib/test-fixtures): the describe
 * result, running and paused ticks, and the tick of a breakpoint hit.
 */
export const loadV2Frames = (): CapturedFrame[] =>
  JSON.parse(readFileSync(join(REPO_ROOT, "src/lib/test-fixtures/protocol-v2-frames.json"), "utf8")) as CapturedFrame[];
