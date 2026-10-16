import type {
  BinaryMessageHandler,
  DebuggerTransport,
  TransportMessageHandler,
  TransportState,
  TransportStateHandler,
} from "../transport";

/**
 * A transport for unit tests: nothing is sent anywhere. The test plays the server with
 * `deliver`, `deliverBinary` and `close`, and reads what the client sent from `sent`.
 */
export class FakeTransport implements DebuggerTransport {
  public readonly kind = "websocket" as const;
  public state: TransportState = "idle";
  /** every payload the client sent, parsed */
  public readonly sent: Array<{ id?: number; method: string; params?: unknown }> = [];
  /** number of binary subscribers at the moment each payload was sent */
  public readonly binarySubscribersAtSend: number[] = [];
  /** makes `send` throw, like a socket that is not open */
  public failSend: string | undefined;
  private readonly messageHandlers = new Set<TransportMessageHandler>();
  private readonly binaryHandlers = new Set<BinaryMessageHandler>();
  private readonly stateHandlers = new Set<TransportStateHandler>();

  async connect(): Promise<void> {
    this.setState("open");
  }

  disconnect(): void {
    this.setState("closed");
  }

  send(payload: string): void {
    if (this.failSend) {
      throw new Error(this.failSend);
    }
    this.sent.push(JSON.parse(payload));
    this.binarySubscribersAtSend.push(this.binaryHandlers.size);
  }

  subscribe(handler: TransportMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  subscribeBinary(handler: BinaryMessageHandler): () => void {
    this.binaryHandlers.add(handler);
    return () => this.binaryHandlers.delete(handler);
  }

  onStateChange(handler: TransportStateHandler): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  get binarySubscribers(): number {
    return this.binaryHandlers.size;
  }

  /** The server sends a text frame. An object is sent as JSON. */
  deliver(message: unknown): void {
    const payload = typeof message === "string" ? message : JSON.stringify(message);
    Array.from(this.messageHandlers).forEach((handler) => handler(payload));
  }

  /** The server answers the request the client sent last. */
  respond(result: unknown): void {
    this.deliver({ jsonrpc: "2.0", id: this.lastId(), result });
  }

  respondError(code: number, message: string): void {
    this.deliver({ jsonrpc: "2.0", id: this.lastId(), error: { code, message } });
  }

  deliverBinary(frame: ArrayBuffer | Uint8Array): void {
    const buffer = frame instanceof ArrayBuffer ? frame : frame.slice().buffer;
    Array.from(this.binaryHandlers).forEach((handler) => handler(buffer as ArrayBuffer));
  }

  /** The connection goes away. */
  close(): void {
    this.setState("closed");
  }

  private lastId(): number {
    const id = this.sent.at(-1)?.id;
    if (id === undefined) {
      throw new Error("the client has not sent a request");
    }
    return id;
  }

  private setState(state: TransportState): void {
    this.state = state;
    Array.from(this.stateHandlers).forEach((handler) => handler(state));
  }
}
