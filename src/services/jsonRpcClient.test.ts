import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JsonRpcException } from "../lib/jsonRpc";
import { DebuggerRpcMethodSchemas } from "../lib/debuggerSchema";
import type { DebuggerRpcSchema } from "../lib/debuggerSchema";
import { JsonRpcClient, RpcValidationError } from "./jsonRpcClient";
import type { InvalidMessageReport } from "./jsonRpcClient";
import { FakeTransport } from "./test-support/fakeTransport";

const setup = (options: { requestTimeoutMs?: number; validateParams?: boolean } = {}) => {
  const transport = new FakeTransport();
  const client = new JsonRpcClient<DebuggerRpcSchema>(transport, {
    ...options,
    validationSchemas: DebuggerRpcMethodSchemas,
  });
  const reports: InvalidMessageReport[] = [];
  client.onInvalidMessage((report) => reports.push(report));
  return { transport, client, reports };
};

const tick = (overrides: Record<string, unknown> = {}) => ({
  tickId: 1,
  timestamp: 1791150000000,
  executionState: { state: "paused" },
  registers: {},
  breakpoints: {},
  eventLog: [],
  ...overrides,
});

describe("JsonRpcClient", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs without a window object", () => {
    expect(typeof window).toBe("undefined");
  });

  it("sends a JSON-RPC 2.0 request with ids counting from 1 and resolves with the validated result", async () => {
    const { transport, client } = setup();
    const call = client.call("state.getDisassembly", { target: "sh4", address: 0x8c0000a0, count: 1 });
    expect(transport.sent).toEqual([
      { jsonrpc: "2.0", id: 1, method: "state.getDisassembly", params: { target: "sh4", address: 0x8c0000a0, count: 1 } },
    ]);
    transport.respond({ lines: [{ address: 0x8c0000a0, bytes: "09 00", disassembly: "nop", extra: "stripped" }] });
    // unknown keys are stripped, so a newer server does not break an older client
    await expect(call).resolves.toEqual({ lines: [{ address: 0x8c0000a0, bytes: "09 00", disassembly: "nop" }] });

    void client.call("control.runUntil", {});
    expect(transport.sent[1].id).toBe(2);
    expect(client.pendingCount).toBe(1);
  });

  it("rejects with JsonRpcException for a JSON-RPC error", async () => {
    const { transport, client } = setup();
    const call = client.call("state.getMemorySlice", { target: "sh4", address: 0x10000000, length: 16 });
    transport.respondError(-32010, "address not readable");
    await expect(call).rejects.toBeInstanceOf(JsonRpcException);
    await expect(call).rejects.toMatchObject({ code: -32010, message: "address not readable" });
  });

  it("rejects a request that is not answered within the timeout, and reports the late answer", async () => {
    vi.useFakeTimers();
    const { transport, client, reports } = setup({ requestTimeoutMs: 10_000 });
    const call = client.call("control.pause", {});
    const outcome = expect(call).rejects.toThrow("Request timed out: control.pause");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(client.pendingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;
    expect(client.pendingCount).toBe(0);

    transport.respond({});
    expect(reports).toEqual([
      { kind: "unexpected", id: 1, message: "The server answered request 1, which is not pending", issues: [] },
    ]);
  });

  it("clears the timeout when the answer arrives", async () => {
    vi.useFakeTimers();
    const { transport, client } = setup();
    const call = client.call("control.pause", {});
    transport.respond({});
    await expect(call).resolves.toEqual({});
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects every open request when the connection closes", async () => {
    const { transport, client } = setup();
    const first = client.call("control.pause", {});
    const second = client.call("state.getCallstack", { target: "sh4" });
    transport.close();
    await expect(first).rejects.toThrow("Connection closed before control.pause was answered");
    await expect(second).rejects.toThrow("Connection closed before state.getCallstack was answered");
    expect(client.pendingCount).toBe(0);
  });

  it("rejects every open request on disconnect()", async () => {
    const { client } = setup();
    const call = client.call("control.pause", {});
    client.disconnect();
    await expect(call).rejects.toThrow("Transport disconnected");
  });

  it("rejects a result that fails validation, names the path, and reports it", async () => {
    const { transport, client, reports } = setup();
    const call = client.call("state.getMemorySlice", { target: "sh4", address: 0, length: 4 });
    transport.respond({ baseAddress: 0, data: [1, 2, "three", 4], validity: "ok" });
    await expect(call).rejects.toBeInstanceOf(RpcValidationError);
    await expect(call).rejects.toThrow(/^Response validation failed for state\.getMemorySlice: data\.2: /);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ kind: "response", method: "state.getMemorySlice", id: 1 });
    expect(reports[0].issues.map((issue) => issue.path)).toEqual(["data.2"]);
  });

  it("drops a tick that fails validation and reports the zod path instead of delivering it", () => {
    const { transport, client, reports } = setup();
    const received: unknown[] = [];
    client.onNotification((notification) => received.push(notification.params));

    transport.deliver({ jsonrpc: "2.0", method: "event.tick", params: tick() });
    expect(received).toHaveLength(1);

    transport.deliver({
      jsonrpc: "2.0",
      method: "event.tick",
      params: tick({ executionState: { state: "stopped" }, breakpoints: { "1": { id: 1, event: "x", kind: "code" } } }),
    });
    expect(received).toHaveLength(1);
    expect(reports).toHaveLength(1);
    expect(reports[0].kind).toBe("notification");
    expect(reports[0].method).toBe("event.tick");
    expect(reports[0].issues.map((issue) => issue.path).sort()).toEqual(["breakpoints.1.enabled", "executionState.state"]);
    expect(reports[0].message).toMatch(/^Notification validation failed for event\.tick: /);
    expect(reports[0].message).toContain("executionState.state");
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("delivers notifications of methods it has no schema for", () => {
    const { transport, client, reports } = setup();
    const methods: string[] = [];
    client.onNotification((notification) => methods.push(notification.method));
    transport.deliver({ jsonrpc: "2.0", method: "event.somethingNew", params: { any: "thing" } });
    expect(methods).toEqual(["event.somethingNew"]);
    expect(reports).toEqual([]);
  });

  it("reports frames that are not JSON-RPC and responses it cannot match", () => {
    const { transport, reports } = setup();
    transport.deliver("{nope");
    transport.deliver("[]");
    transport.deliver({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    expect(reports.map((report) => report.kind)).toEqual(["unparseable", "unparseable", "unexpected"]);
  });

  it("refuses to send params that do not match the schema", async () => {
    const { transport, client } = setup();
    await expect(client.call("state.getMemorySlice", { address: 0, length: 0 })).rejects.toThrow(
      /^Parameter validation failed for state\.getMemorySlice: length: /,
    );
    await expect(
      client.call("control.step", { target: 4 } as never),
    ).rejects.toThrow(/^Parameter validation failed for control\.step: target: /);
    expect(transport.sent).toEqual([]);
  });

  it("sends invalid params when param validation is off (the contract runner tests the server's)", async () => {
    const { transport, client } = setup({ validateParams: false });
    const call = client.call("control.step", { target: 4 } as never);
    expect(transport.sent[0]).toMatchObject({ method: "control.step", params: { target: 4 } });
    transport.respond({ error: { code: -32602, message: "invalid params: target" } });
    await expect(call).resolves.toEqual({ error: { code: -32602, message: "invalid params: target" } });
  });

  it("rejects with the method name when the transport cannot send", async () => {
    vi.useFakeTimers();
    const { transport, client } = setup();
    transport.failSend = "Not Connected";
    await expect(client.call("control.pause", {})).rejects.toThrow("control.pause: Not Connected");
    expect(client.pendingCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
