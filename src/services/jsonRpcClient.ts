import { z } from "zod";
import {
  JSON_RPC_VERSION,
  JsonRpcException,
  isJsonRpcError,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcSuccess,
} from "../lib/jsonRpc";
import type {
  JsonRpcError,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcSuccess,
  RpcParams,
  RpcResult,
  RpcSchema,
} from "../lib/jsonRpc";
import type { DebuggerTransport, TransportOptions } from "./transport";

export type RpcMethodSchemas = Record<string, { params: z.ZodType; result: z.ZodType }>;

/** One problem zod found: where in the message, and what. */
export interface RpcValidationIssue {
  /** dotted path into the params or result, e.g. "eventLog.3.severity"; empty for the value itself */
  path: string;
  message: string;
}

/**
 * A message from the server that the client could not use and dropped:
 * - "notification": a notification (a tick) that failed validation;
 * - "response": a result that failed validation (the call is rejected as well);
 * - "unparseable": a text frame that is not JSON, or not a JSON-RPC 2.0 message;
 * - "unexpected": a response without a numeric id, or to a request that is not pending.
 */
export interface InvalidMessageReport {
  kind: "notification" | "response" | "unparseable" | "unexpected";
  method?: string;
  id?: number;
  /** one line for a status bar or a log; names the first failing path */
  message: string;
  issues: RpcValidationIssue[];
}

export type InvalidMessageHandler = (report: InvalidMessageReport) => void;

export interface JsonRpcClientOptions<T extends RpcMethodSchemas = RpcMethodSchemas> {
  requestTimeoutMs?: number;
  validationSchemas?: T;
  /** validate results and notifications against `validationSchemas` (default true) */
  validateResponses?: boolean;
  /**
   * validate the params of outgoing calls against `validationSchemas` (default: as
   * `validateResponses`). A test client that sends invalid requests on purpose turns it off.
   */
  validateParams?: boolean;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  method?: string;
}

export type NotificationCallback = (notification: JsonRpcNotification) => void;

/** A result or a notification that does not match its schema. */
export class RpcValidationError extends Error {
  public readonly method: string;
  public readonly issues: RpcValidationIssue[];

  constructor(what: string, method: string, issues: RpcValidationIssue[]) {
    super(`${what} validation failed for ${method}: ${summarizeIssues(issues)}`);
    this.name = "RpcValidationError";
    this.method = method;
    this.issues = issues;
  }
}

const toIssues = (error: z.ZodError): RpcValidationIssue[] =>
  error.issues.map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }));

const summarizeIssues = (issues: RpcValidationIssue[]): string => {
  const shown = issues.slice(0, 3).map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message));
  const more = issues.length > shown.length ? ` (and ${issues.length - shown.length} more)` : "";
  return `${shown.join("; ")}${more}`;
};

export class JsonRpcClient<S extends RpcSchema> {
  private readonly transport: DebuggerTransport;
  private idCounter = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private notificationHandlers = new Set<NotificationCallback>();
  private invalidMessageHandlers = new Set<InvalidMessageHandler>();
  private readonly requestTimeoutMs: number;
  private readonly validationSchemas?: RpcMethodSchemas;
  private readonly validateResponses: boolean;
  private readonly validateParams: boolean;

  constructor(transport: DebuggerTransport, options?: JsonRpcClientOptions) {
    this.transport = transport;
    this.requestTimeoutMs = options?.requestTimeoutMs ?? 10_000;
    this.validationSchemas = options?.validationSchemas;
    this.validateResponses = options?.validateResponses ?? true;
    this.validateParams = options?.validateParams ?? this.validateResponses;
    this.transport.subscribe((payload) => this.handlePayload(payload));
    // A request that is still open when the connection goes away is never answered.
    this.transport.onStateChange((state) => {
      if (state === "closed") {
        this.clearPending((method) => new Error(`Connection closed before ${method} was answered`));
      }
    });
  }

  async connect(endpoint: string, options?: TransportOptions) {
    await this.transport.connect(endpoint, options);
  }

  disconnect() {
    this.clearPending(() => new Error("Transport disconnected"));
    this.transport.disconnect();
  }

  /** Number of requests that have not been answered yet. */
  get pendingCount(): number {
    return this.pending.size;
  }

  async call<M extends keyof S>(method: M, params: RpcParams<S, M>): Promise<RpcResult<S, M>> {
    this.checkParams(method as string, params);

    const id = ++this.idCounter;
    const request: JsonRpcRequest<RpcParams<S, M>> = {
      jsonrpc: JSON_RPC_VERSION,
      id,
      method: method as string,
      params,
    };
    const payload = JSON.stringify(request);

    const result = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request timed out: ${String(method)}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timeout);
          reject(reason);
        },
        method: method as string,
      });

      try {
        this.transport.send(payload);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        // Wrap the error with the method name for better error messages
        const errorMessage = error instanceof Error ? error.message : String(error);
        reject(new Error(`${String(method)}: ${errorMessage}`));
      }
    });

    return result as RpcResult<S, M>;
  }

  notify<M extends keyof S>(method: M, params: RpcParams<S, M>): void {
    this.checkParams(method as string, params);

    const notification: JsonRpcNotification<RpcParams<S, M>> = {
      jsonrpc: JSON_RPC_VERSION,
      method: method as string,
      params,
    };
    this.transport.send(JSON.stringify(notification));
  }

  onNotification(handler: NotificationCallback): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  /**
   * Reports every message the client drops: a tick that fails validation never reaches the
   * notification handlers, so without this the UI just stops updating.
   */
  onInvalidMessage(handler: InvalidMessageHandler): () => void {
    this.invalidMessageHandlers.add(handler);
    return () => this.invalidMessageHandlers.delete(handler);
  }

  private checkParams(method: string, params: unknown) {
    if (!this.validateParams || !this.validationSchemas) {
      return;
    }
    const schema = this.validationSchemas[method];
    if (!schema?.params) {
      return;
    }
    const parsed = schema.params.safeParse(params);
    if (!parsed.success) {
      throw new Error(`Parameter validation failed for ${method}: ${summarizeIssues(toIssues(parsed.error))}`);
    }
  }

  private reportInvalid(report: InvalidMessageReport) {
    this.invalidMessageHandlers.forEach((handler) => handler(report));
  }

  private handlePayload(payload: string) {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(payload);
    } catch (error) {
      console.error("Failed to parse JSON-RPC payload", error);
      this.reportInvalid({ kind: "unparseable", message: "The server sent a frame that is not JSON", issues: [] });
      return;
    }

    if (!message || message.jsonrpc !== JSON_RPC_VERSION) {
      console.warn("Ignoring invalid JSON-RPC message", message);
      this.reportInvalid({ kind: "unparseable", message: "The server sent a frame that is not a JSON-RPC 2.0 message", issues: [] });
      return;
    }

    if (isJsonRpcRequest(message) || isJsonRpcNotification(message)) {
      const notification = message as JsonRpcNotification;

      // Validate notification if schemas are provided
      if (this.validateResponses && this.validationSchemas && notification.method) {
        const schema = this.validationSchemas[notification.method];
        if (schema?.params) {
          const parsed = schema.params.safeParse(notification.params);
          if (!parsed.success) {
            const failure = new RpcValidationError("Notification", notification.method, toIssues(parsed.error));
            console.error(failure.message);
            this.reportInvalid({
              kind: "notification",
              method: notification.method,
              message: failure.message,
              issues: failure.issues,
            });
            return;
          }
        }
      }

      // Every handler gets the notification: one that throws does not keep it from the others,
      // and does not end the handling of the frame.
      this.notificationHandlers.forEach((handler) => {
        try {
          handler(notification);
        } catch (error) {
          console.error(`A handler of ${notification.method} failed`, error);
        }
      });
      return;
    }

    const response = message as JsonRpcSuccess | JsonRpcError;
    const id = (response as JsonRpcSuccess).id;

    if (typeof id !== "number") {
      console.warn("Received response without numeric id", response);
      this.reportInvalid({ kind: "unexpected", message: "The server sent a response without a numeric id", issues: [] });
      return;
    }

    const pending = this.pending.get(id);
    if (!pending) {
      console.warn("No pending request for id", id, response);
      this.reportInvalid({ kind: "unexpected", id, message: `The server answered request ${id}, which is not pending`, issues: [] });
      return;
    }

    this.pending.delete(id);

    if (isJsonRpcSuccess(response)) {
      // Validate response if schemas are provided
      if (this.validateResponses && this.validationSchemas && pending.method) {
        const schema = this.validationSchemas[pending.method];
        if (schema?.result) {
          const parsed = schema.result.safeParse(response.result);
          if (!parsed.success) {
            const failure = new RpcValidationError("Response", pending.method, toIssues(parsed.error));
            this.reportInvalid({
              kind: "response",
              method: pending.method,
              id,
              message: failure.message,
              issues: failure.issues,
            });
            pending.reject(failure);
            return;
          }
          pending.resolve(parsed.data);
          return;
        }
      }
      pending.resolve(response.result);
      return;
    }

    if (isJsonRpcError(response)) {
      pending.reject(new JsonRpcException(response.error));
      return;
    }

    pending.reject(new Error("Unknown JSON-RPC response"));
  }

  private clearPending(reason: (method: string) => Error) {
    const open = Array.from(this.pending.values());
    this.pending.clear();
    open.forEach((pending) => pending.reject(reason(pending.method ?? "the request")));
  }
}
