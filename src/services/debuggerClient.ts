import type { JsonRpcNotification } from "../lib/jsonRpc";
import type {
  BreakpointDescriptor,
  BreakpointId,
  DebuggerNotification,
  DebuggerRpcSchema,
  DebuggerTick,
  HollyCaptureKind,
  TableId,
  TargetProcessor,
  WatchId,
} from "../lib/debuggerSchema";
import { DebuggerRpcMethodSchemas, PROTOCOL_VERSION, RpcMethod } from "../lib/debuggerSchema";
import { BinaryFrameKind, SGC_BYTES_PER_FRAME, parseBinaryFrame } from "../lib/binaryFrame";
import { JsonRpcClient } from "./jsonRpcClient";
import type { InvalidMessageHandler, JsonRpcClientOptions } from "./jsonRpcClient";
import type { DebuggerTransport, TransportOptions, TransportState, TransportStateHandler } from "./transport";
import { createTransport } from "./transport";

export interface DebuggerClientConfig {
  mode: "native" | "wasm";
  endpoint: string;
  transportOptions?: TransportOptions;
  rpcOptions?: JsonRpcClientOptions;
  /** free text sent as `client` in debugger.describe; the server logs it */
  clientName?: string;
  /** replaces the transport that `mode` selects (tests) */
  transport?: DebuggerTransport;
}

/** How long a binary frame may take after the JSON response that announces it. */
const BINARY_FRAME_TIMEOUT_MS = 10_000;

const defaultClientName = (): string =>
  typeof __APP_VERSION__ === "string" ? `nullDC DevTools ${__APP_VERSION__}` : "nullDC DevTools";

/** What a binary request's JSON result says about the frame that follows it. */
interface BinaryAnnouncement {
  totalBytes: number;
  binaryId?: number;
}

export class DebuggerClient {
  private readonly transport: DebuggerTransport;
  private readonly rpc: JsonRpcClient<DebuggerRpcSchema>;
  private readonly config: DebuggerClientConfig;
  private notificationHandlers = new Set<(notification: DebuggerNotification) => void>();
  private describedProtocol: number | undefined;
  private described = false;

  constructor(config: DebuggerClientConfig) {
    this.config = config;
    this.transport = config.transport ?? createTransport(config.mode);
    this.rpc = new JsonRpcClient<DebuggerRpcSchema>(this.transport, {
      ...config.rpcOptions,
      validationSchemas: DebuggerRpcMethodSchemas,
      validateResponses: true,
    });
    this.rpc.onNotification((notification) => {
      const mapped = mapNotification(notification);
      if (mapped) {
        // as in JsonRpcClient: a handler that throws does not keep the tick from the others
        this.notificationHandlers.forEach((handler) => {
          try {
            handler(mapped);
          } catch (error) {
            console.error(`A handler of ${notification.method} failed`, error);
          }
        });
      }
    });
  }

  async connect() {
    await this.rpc.connect(this.config.endpoint, this.config.transportOptions);
  }

  disconnect() {
    this.rpc.disconnect();
  }

  /**
   * The server answers with its description and then sends a full tick. Register the
   * notification handler (`onNotification`) BEFORE calling this: the response and the tick
   * can be delivered in the same turn, and a handler added after `await describe()` then
   * misses that tick.
   */
  async describe() {
    const shape = await this.rpc.call(RpcMethod.DEBUGGER_DESCRIBE, {
      protocol: PROTOCOL_VERSION,
      client: this.config.clientName ?? defaultClientName(),
    });
    this.described = true;
    this.describedProtocol = shape.protocol;
    return shape;
  }

  /**
   * `protocol` of the last debugger.describe result. Undefined before the first describe
   * and for a v2 server, which does not report one.
   */
  get serverProtocol(): number | undefined {
    return this.describedProtocol;
  }

  async fetchCallstack(target: "sh4" | "arm7", maxFrames = 32) {
    return this.rpc.call(RpcMethod.STATE_GET_CALLSTACK, { target, maxFrames });
  }

  async watch(expressions: string[]) {
    if (!expressions.length) {
      return {};
    }
    return this.rpc.call(RpcMethod.STATE_WATCH, { expressions });
  }

  async unwatch(watchIds: WatchId[]) {
    if (!watchIds.length) {
      return {};
    }
    return this.rpc.call(RpcMethod.STATE_UNWATCH, { watchIds });
  }

  /** From M2: state.setRegister on the watched register. */
  async editWatch(watchId: WatchId, value: string) {
    return this.rpc.call(RpcMethod.STATE_EDIT_WATCH, { watchId, value });
  }

  async modifyWatchExpression(watchId: WatchId, newExpression: string) {
    return this.rpc.call(RpcMethod.STATE_MODIFY_WATCH_EXPRESSION, { watchId, newExpression });
  }

  /** Without `kind` the server takes "code" when `address` is given and "event" otherwise. */
  async addBreakpoint(event: string, address?: number, kind?: BreakpointDescriptor["kind"], enabled = true) {
    return this.rpc.call(RpcMethod.BREAKPOINTS_ADD, { event, address, kind: kind ?? (address === undefined ? "event" : "code"), enabled });
  }

  async removeBreakpoint(id: BreakpointId) {
    return this.rpc.call(RpcMethod.BREAKPOINTS_REMOVE, { id });
  }

  async toggleBreakpoint(id: BreakpointId, enabled: boolean) {
    return this.rpc.call(RpcMethod.BREAKPOINTS_TOGGLE, { id, enabled });
  }

  async setCategoryStates(categories: Record<string, { muted: boolean; soloed: boolean }>) {
    return this.rpc.call(RpcMethod.BREAKPOINTS_SET_CATEGORY_STATES, { categories });
  }

  // Run control. Every call is answered as soon as it is armed; a tick reports completion.
  // The result is `{}` or `{ error }` (in-band), and callers are expected to check it.

  async pause(target?: TargetProcessor) {
    return this.rpc.call(RpcMethod.CONTROL_PAUSE, { target });
  }

  async step(target: TargetProcessor) {
    return this.rpc.call(RpcMethod.CONTROL_STEP, { target });
  }

  async stepOver(target: TargetProcessor) {
    return this.rpc.call(RpcMethod.CONTROL_STEP_OVER, { target });
  }

  async stepOut(target: TargetProcessor) {
    return this.rpc.call(RpcMethod.CONTROL_STEP_OUT, { target });
  }

  async runUntil() {
    return this.rpc.call(RpcMethod.CONTROL_RUN_UNTIL, {});
  }

  /** Capability "reset". */
  async reset() {
    return this.rpc.call(RpcMethod.CONTROL_RESET, {});
  }

  async fetchMemorySlice(params: {
    target: TargetProcessor;
    address: number;
    length: number;
  }) {
    return this.rpc.call(RpcMethod.STATE_GET_MEMORY_SLICE, params);
  }

  /** Capability "memory-binary": like fetchMemorySlice for up to 16 MiB, the bytes in a binary frame. */
  async fetchMemoryBinary(params: { target: TargetProcessor; address: number; length: number }) {
    const { result, payload } = await this.callWithBinaryFrame(
      BinaryFrameKind.MEMORY,
      () => this.rpc.call(RpcMethod.STATE_GET_MEMORY_BINARY, params),
      (announced) => announced,
    );
    return { baseAddress: result.baseAddress, unreadable: result.unreadable, data: payload };
  }

  async fetchDisassembly(params: { target: TargetProcessor; address: number; count: number; context?: number }) {
    return this.rpc.call(RpcMethod.STATE_GET_DISASSEMBLY, params);
  }

  /** Capability "memory-write". All-or-nothing. */
  async writeMemory(params: { target: "sh4" | "arm7"; address: number; data: number[] }) {
    return this.rpc.call(RpcMethod.STATE_WRITE_MEMORY, params);
  }

  /** Capability "register-write". `value` is "0x" hex or decimal. */
  async setRegister(path: string, name: string, value: string) {
    return this.rpc.call(RpcMethod.STATE_SET_REGISTER, { path, name, value });
  }

  /**
   * Capability "sgc-capture". Records the next `frames` AICA samples (default 1024); the
   * answer arrives when the capture is complete. `{}` or `{ error }` (in-band).
   */
  async recordSgcFrames(frames?: number) {
    return this.rpc.call(RpcMethod.STATE_RECORD_SGC_FRAMES, { frames });
  }

  /**
   * The last capture: `frameCount` frames of 64 channels x 128 bytes. Rejects with the
   * server's error when nothing has been recorded.
   */
  async fetchSgcFrameData(): Promise<{ frameCount: number; data: ArrayBuffer }> {
    const { result, payload } = await this.callWithBinaryFrame(
      BinaryFrameKind.SGC_FRAMES,
      async () => {
        const answer = await this.rpc.call(RpcMethod.STATE_GET_SGC_FRAME_DATA, {});
        if ("error" in answer) {
          // the v2 mock's way of saying that nothing has been recorded
          throw new Error(answer.error.message || "Failed to fetch SGC frame data");
        }
        return answer;
      },
      (announced) => {
        if (announced.totalBytes !== announced.frameCount * SGC_BYTES_PER_FRAME) {
          throw new Error(
            `state.getSgcFrameData: ${announced.frameCount} frames are ${announced.frameCount * SGC_BYTES_PER_FRAME} bytes, the server announced ${announced.totalBytes}`,
          );
        }
        return announced;
      },
    );
    return { frameCount: result.frameCount, data: payload };
  }

  /** Capability "tables". */
  async fetchTable(id: TableId) {
    return this.rpc.call(RpcMethod.STATE_GET_TABLE, { id });
  }

  /** Capability "holly-capture": a refsw2 render log (gzip) or a TAFRAME4 image. */
  async captureHolly(what: HollyCaptureKind) {
    const { result, payload } = await this.callWithBinaryFrame(
      what === "core" ? BinaryFrameKind.CORE_CAPTURE : BinaryFrameKind.TA_CAPTURE,
      () => this.rpc.call(RpcMethod.STATE_CAPTURE_HOLLY, { what }),
      (announced) => announced,
    );
    return { what: result.what, format: result.format, data: payload };
  }

  async sendNotification(method: keyof DebuggerRpcSchema, params: unknown) {
    this.rpc.notify(method, params as never);
  }

  onNotification(handler: (notification: DebuggerNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  /**
   * Called for every message of the server that the client had to drop, with the zod path
   * of what was wrong. A dropped tick is otherwise only visible as a UI that stops updating.
   */
  onInvalidMessage(handler: InvalidMessageHandler): () => void {
    return this.rpc.onInvalidMessage(handler);
  }

  onTransportStateChange(handler: TransportStateHandler): () => void {
    return this.transport.onStateChange(handler);
  }

  get transportState(): TransportState {
    return this.transport.state;
  }

  /**
   * A request whose JSON result is followed by one binary frame. The subscription is made
   * before the request is sent and removed on every path.
   *
   * v3 server: the frame carries a header; only the frame whose magic, kind and binaryId
   * match is taken (the transport hands every binary frame to every subscriber), its
   * payloadBytes must equal the announced totalBytes, and the header is stripped.
   * v2 server (no `protocol` in debugger.describe): the next binary frame is the payload.
   */
  private async callWithBinaryFrame<R extends BinaryAnnouncement>(
    kind: number,
    request: () => Promise<R>,
    check: (result: R) => R,
  ): Promise<{ result: R; payload: ArrayBuffer }> {
    const frames: ArrayBuffer[] = [];
    let wake: (() => void) | undefined;
    const unsubscribe = this.transport.subscribeBinary((frame) => {
      frames.push(frame);
      wake?.();
    });
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const result = check(await request());
      const headerExpected = this.described ? (this.describedProtocol ?? 0) >= 3 : result.binaryId !== undefined;

      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`The binary frame announced by the server did not arrive within ${BINARY_FRAME_TIMEOUT_MS / 1000} s`)),
          BINARY_FRAME_TIMEOUT_MS,
        );
      });

      const nextPayload = async (): Promise<ArrayBuffer> => {
        for (;;) {
          while (frames.length > 0) {
            const frame = frames.shift()!;
            if (!headerExpected) {
              return frame;
            }
            const parsed = parseBinaryFrame(frame);
            // not ours: a frame of another request on this connection, or not a v3 frame
            if (!parsed.ok || parsed.header.kind !== kind || parsed.header.binaryId !== result.binaryId) {
              continue;
            }
            if (parsed.header.payloadBytes !== result.totalBytes) {
              throw new Error(
                `The binary frame carries ${parsed.header.payloadBytes} bytes, the server announced ${result.totalBytes}`,
              );
            }
            return parsed.payload;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      };

      const payload = await Promise.race([nextPayload(), deadline]);
      if (!headerExpected && payload.byteLength !== result.totalBytes) {
        throw new Error(`The binary frame carries ${payload.byteLength} bytes, the server announced ${result.totalBytes}`);
      }
      return { result, payload };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      unsubscribe();
    }
  }
}

const mapNotification = (notification: JsonRpcNotification): DebuggerNotification | undefined => {
  const { method, params } = notification;
  switch (method) {
    case RpcMethod.EVENT_TICK:
      return {
        topic: "tick",
        payload: params as DebuggerTick,
      };
    default:
      return undefined;
  }
};
