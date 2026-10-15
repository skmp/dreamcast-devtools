import { afterEach, describe, expect, it, vi } from "vitest";
import { BinaryFrameKind, SGC_BYTES_PER_FRAME, encodeBinaryFrame } from "../lib/binaryFrame";
import { PROTOCOL_VERSION } from "../lib/debuggerSchema";
import { DebuggerClient } from "./debuggerClient";
import { FakeTransport } from "./test-support/fakeTransport";

const setup = () => {
  const transport = new FakeTransport();
  const client = new DebuggerClient({ mode: "native", endpoint: "ws://test/ws", transport, clientName: "unit test" });
  return { transport, client };
};

const v3Describe = { emulator: { name: "nullDC", version: "3.0.0", build: "native" }, protocol: 3, ui: "none", capabilities: [], targets: [], deviceTree: [] };
/** a describe result without `protocol`: the server that gets the version banner */
const describeWithoutProtocol = { emulator: { name: "mockServer", version: "unspecified", build: "native" }, deviceTree: [] };

const describeAs = async (client: DebuggerClient, transport: FakeTransport, shape: unknown) => {
  const described = client.describe();
  transport.respond(shape);
  await described;
};

const sgcPayload = (frames: number) => {
  const payload = new Uint8Array(frames * SGC_BYTES_PER_FRAME);
  payload[0] = 0xaa;
  payload[payload.length - 1] = 0x55;
  return payload;
};

describe("DebuggerClient", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("describe sends the client's protocol version and name, and remembers the server's protocol", async () => {
    const { transport, client } = setup();
    expect(client.serverProtocol).toBeUndefined();
    const described = client.describe();
    expect(transport.sent).toEqual([
      { jsonrpc: "2.0", id: 1, method: "debugger.describe", params: { protocol: PROTOCOL_VERSION, client: "unit test" } },
    ]);
    transport.respond(v3Describe);
    await expect(described).resolves.toMatchObject({ protocol: 3, ui: "none", targets: [] });
    expect(client.serverProtocol).toBe(3);

    await describeAs(client, transport, describeWithoutProtocol);
    expect(client.serverProtocol).toBeUndefined();
  });

  it("describe names the UI Dreamcast DevTools, with the version of the build when it has one", async () => {
    const clientOf = async () => {
      const transport = new FakeTransport();
      const described = new DebuggerClient({ mode: "native", endpoint: "ws://test/ws", transport }).describe();
      const client = (transport.sent[0] as { params: { client: string } }).params.client;
      transport.respond(v3Describe);
      await described;
      return client;
    };
    try {
      // the build defines __APP_VERSION__ (vite.config.ts); the unit tests do not
      expect(await clientOf()).toBe("Dreamcast DevTools");
      vi.stubGlobal("__APP_VERSION__", "3.0.0-pre+d59336b");
      expect(await clientOf()).toBe("Dreamcast DevTools 3.0.0-pre+d59336b");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("delivers ticks to handlers that were registered before describe, in the same turn as the response", async () => {
    const { transport, client } = setup();
    const ticks: number[] = [];
    client.onNotification((notification) => ticks.push(notification.payload.tickId));
    const described = client.describe();
    transport.respond(v3Describe);
    transport.deliver({
      jsonrpc: "2.0",
      method: "event.tick",
      params: { tickId: 7, timestamp: 1, executionState: { state: "running", stopId: 0 }, registers: {}, breakpoints: {}, eventLog: [] },
    });
    expect(ticks).toEqual([7]);
    await described;
  });

  it("a tick handler that throws does not keep the tick from the handlers after it", () => {
    const { transport, client } = setup();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ticks: number[] = [];
    client.onNotification(() => {
      throw new Error("Maximum update depth exceeded");
    });
    client.onNotification((notification) => ticks.push(notification.payload.tickId));
    const frame = (tickId: number) => ({
      jsonrpc: "2.0",
      method: "event.tick",
      params: { tickId, timestamp: 1, executionState: { state: "running", stopId: 0 }, registers: {}, breakpoints: {}, eventLog: [] },
    });
    expect(() => transport.deliver(frame(1))).not.toThrow();
    transport.deliver(frame(2));
    expect(ticks).toEqual([1, 2]);
    expect(error).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith("A handler of event.tick failed", expect.objectContaining({ message: "Maximum update depth exceeded" }));
    vi.restoreAllMocks();
  });

  it("uses typed methods for every v3 request", async () => {
    const { transport, client } = setup();
    const calls = [
      client.reset(),
      client.setRegister("dc.sh4.cpu", "R0", "0x1"),
      client.writeMemory({ target: "sh4", address: 0x8c010000, data: [1, 2] }),
      client.fetchTable("sq"),
      client.recordSgcFrames(64),
      client.recordSgcFrames(),
      client.addBreakpoint("dc.holly.core.vblank"),
      client.addBreakpoint("dc.sh4.cpu.pc", 0x8c010000),
    ];
    expect(transport.sent.map(({ method, params }) => ({ method, params }))).toEqual([
      { method: "control.reset", params: {} },
      { method: "state.setRegister", params: { path: "dc.sh4.cpu", name: "R0", value: "0x1" } },
      { method: "state.writeMemory", params: { target: "sh4", address: 0x8c010000, data: [1, 2] } },
      { method: "state.getTable", params: { id: "sq" } },
      { method: "state.recordSgcFrames", params: { frames: 64 } },
      { method: "state.recordSgcFrames", params: {} },
      { method: "breakpoints.add", params: { event: "dc.holly.core.vblank", kind: "event", enabled: true } },
      { method: "breakpoints.add", params: { event: "dc.sh4.cpu.pc", address: 0x8c010000, kind: "code", enabled: true } },
    ]);
    client.disconnect();
    for (const call of calls) {
      await expect(call).rejects.toThrow("Transport disconnected");
    }
  });

  describe("binary frames", () => {
    it("subscribes before sending, takes the frame with its kind and binaryId, and strips the header", async () => {
      const { transport, client } = setup();
      await describeAs(client, transport, v3Describe);

      const fetched = client.fetchSgcFrameData();
      expect(transport.sent.at(-1)).toMatchObject({ method: "state.getSgcFrameData", params: {} });
      expect(transport.binarySubscribersAtSend.at(-1)).toBe(1);

      const payload = sgcPayload(2);
      transport.respond({ frameCount: 2, channelsPerFrame: 64, bytesPerChannel: 128, totalBytes: payload.length, binaryId: 5 });
      // frames of other requests on this connection, and something that is not a v3 frame
      transport.deliverBinary(encodeBinaryFrame(BinaryFrameKind.SGC_FRAMES, 4, sgcPayload(2)));
      transport.deliverBinary(encodeBinaryFrame(BinaryFrameKind.MEMORY, 5, sgcPayload(2)));
      transport.deliverBinary(new Uint8Array(100));
      transport.deliverBinary(encodeBinaryFrame(BinaryFrameKind.SGC_FRAMES, 5, payload));

      const { frameCount, data } = await fetched;
      expect(frameCount).toBe(2);
      expect(data.byteLength).toBe(2 * SGC_BYTES_PER_FRAME);
      expect(new Uint8Array(data)[0]).toBe(0xaa);
      expect(new Uint8Array(data)[data.byteLength - 1]).toBe(0x55);
      expect(transport.binarySubscribers).toBe(0);
    });

    it("accepts a frame that arrives in the same turn as the response", async () => {
      const { transport, client } = setup();
      await describeAs(client, transport, v3Describe);
      const fetched = client.fetchMemoryBinary({ target: "sh4", address: 0x8c010000, length: 4 });
      transport.respond({ baseAddress: 0x8c010000, totalBytes: 4, unreadable: [[2, 2]], binaryId: 1 });
      transport.deliverBinary(encodeBinaryFrame(BinaryFrameKind.MEMORY, 1, Uint8Array.from([1, 2, 0, 0])));
      const result = await fetched;
      expect(result.baseAddress).toBe(0x8c010000);
      expect(result.unreadable).toEqual([[2, 2]]);
      expect(Array.from(new Uint8Array(result.data))).toEqual([1, 2, 0, 0]);
    });

    it("selects kind 3 for a CORE capture and kind 4 for a TA capture", async () => {
      const { transport, client } = setup();
      await describeAs(client, transport, v3Describe);
      const ta = client.captureHolly("ta");
      transport.respond({ what: "ta", format: "taframe4", totalBytes: 8, binaryId: 2 });
      transport.deliverBinary(encodeBinaryFrame(BinaryFrameKind.CORE_CAPTURE, 2, new TextEncoder().encode("REFSW2LO")));
      transport.deliverBinary(encodeBinaryFrame(BinaryFrameKind.TA_CAPTURE, 2, new TextEncoder().encode("TAFRAME4")));
      const capture = await ta;
      expect(capture.format).toBe("taframe4");
      expect(new TextDecoder().decode(capture.data)).toBe("TAFRAME4");
    });

    it("rejects a frame whose payloadBytes differs from totalBytes, and unsubscribes", async () => {
      const { transport, client } = setup();
      await describeAs(client, transport, v3Describe);
      const fetched = client.fetchSgcFrameData();
      transport.respond({ frameCount: 2, channelsPerFrame: 64, bytesPerChannel: 128, totalBytes: 2 * SGC_BYTES_PER_FRAME, binaryId: 1 });
      transport.deliverBinary(encodeBinaryFrame(BinaryFrameKind.SGC_FRAMES, 1, sgcPayload(1)));
      await expect(fetched).rejects.toThrow("The binary frame carries 8192 bytes, the server announced 16384");
      expect(transport.binarySubscribers).toBe(0);
    });

    it("rejects a result whose totalBytes is not frameCount x 8192", async () => {
      const { transport, client } = setup();
      await describeAs(client, transport, v3Describe);
      const fetched = client.fetchSgcFrameData();
      transport.respond({ frameCount: 2, channelsPerFrame: 64, bytesPerChannel: 128, totalBytes: 8192, binaryId: 1 });
      await expect(fetched).rejects.toThrow("state.getSgcFrameData: 2 frames are 16384 bytes, the server announced 8192");
      expect(transport.binarySubscribers).toBe(0);
    });

    it("rejects with the server's error and unsubscribes; no frame is expected after an error", async () => {
      const { transport, client } = setup();
      await describeAs(client, transport, v3Describe);
      const fetched = client.fetchSgcFrameData();
      transport.respondError(-32011, "no capture available");
      await expect(fetched).rejects.toMatchObject({ code: -32011, message: "no capture available" });
      expect(transport.binarySubscribers).toBe(0);
    });

    it("times out after 10 s when the frame does not arrive, and unsubscribes", async () => {
      vi.useFakeTimers();
      const { transport, client } = setup();
      await describeAs(client, transport, v3Describe);
      const fetched = client.fetchSgcFrameData();
      const outcome = expect(fetched).rejects.toThrow("The binary frame announced by the server did not arrive within 10 s");
      transport.respond({ frameCount: 1, channelsPerFrame: 64, bytesPerChannel: 128, totalBytes: 8192, binaryId: 1 });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(transport.binarySubscribers).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      await outcome;
      expect(transport.binarySubscribers).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("a binary frame without the header", () => {
    const NOT_ARRIVED = "The binary frame announced by the server did not arrive within 10 s";

    /** What the server described itself as makes no difference: no describe yet, protocol 3, no `protocol`. */
    const servers: Array<[string, unknown]> = [
      ["a client that has not asked for debugger.describe", undefined],
      ["a server of protocol 3", v3Describe],
      ["a server whose describe result has no `protocol`", describeWithoutProtocol],
    ];

    for (const [who, shape] of servers) {
      it(`is not taken, and the request ends in the error of the frame that did not arrive: ${who}`, async () => {
        vi.useFakeTimers();
        const { transport, client } = setup();
        if (shape !== undefined) {
          await describeAs(client, transport, shape);
        }
        const fetched = client.fetchSgcFrameData();
        const outcome = expect(fetched).rejects.toThrow(NOT_ARRIVED);
        const payload = sgcPayload(1);
        transport.respond({ frameCount: 1, channelsPerFrame: 64, bytesPerChannel: 128, totalBytes: payload.length, binaryId: 1 });
        await vi.advanceTimersByTimeAsync(0);
        // the bare payload, with exactly the announced number of bytes
        transport.deliverBinary(payload);
        await vi.advanceTimersByTimeAsync(9_999);
        expect(transport.binarySubscribers).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        await outcome;
        expect(transport.binarySubscribers).toBe(0);
      });

      it(`a result that names no binaryId has no frame, with a header or without: ${who}`, async () => {
        vi.useFakeTimers();
        const { transport, client } = setup();
        if (shape !== undefined) {
          await describeAs(client, transport, shape);
        }
        const fetched = client.fetchSgcFrameData();
        const outcome = expect(fetched).rejects.toThrow(NOT_ARRIVED);
        const payload = sgcPayload(1);
        transport.respond({ frameCount: 1, channelsPerFrame: 64, bytesPerChannel: 128, totalBytes: payload.length });
        await vi.advanceTimersByTimeAsync(0);
        transport.deliverBinary(payload);
        transport.deliverBinary(encodeBinaryFrame(BinaryFrameKind.SGC_FRAMES, 0, payload));
        transport.deliverBinary(encodeBinaryFrame(BinaryFrameKind.SGC_FRAMES, 1, payload));
        await vi.advanceTimersByTimeAsync(10_000);
        await outcome;
        expect(transport.binarySubscribers).toBe(0);
      });
    }

    it("the frame with the header that follows it is taken", async () => {
      const { transport, client } = setup();
      const fetched = client.fetchMemoryBinary({ target: "sh4", address: 0x8c010000, length: 4 });
      transport.respond({ baseAddress: 0x8c010000, totalBytes: 4, binaryId: 9 });
      transport.deliverBinary(Uint8Array.from([9, 9, 9, 9]));
      transport.deliverBinary(encodeBinaryFrame(BinaryFrameKind.MEMORY, 9, Uint8Array.from([1, 2, 3, 4])));
      expect(Array.from(new Uint8Array((await fetched).data))).toEqual([1, 2, 3, 4]);
      expect(transport.binarySubscribers).toBe(0);
    });
  });

  it("an in-band error object is no result of state.getSgcFrameData: \"no capture\" is the JSON-RPC error -32011", async () => {
    const { transport, client } = setup();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const problems: string[] = [];
    client.onInvalidMessage((report) => problems.push(`${report.kind} ${report.method}`));
    await describeAs(client, transport, v3Describe);
    const fetched = client.fetchSgcFrameData();
    transport.respond({ error: { code: -32001, message: "No SGC frame data available. Record some data first." } });
    await expect(fetched).rejects.toThrow("Response validation failed for state.getSgcFrameData: frameCount:");
    expect(transport.binarySubscribers).toBe(0);
    expect(problems).toEqual(["response state.getSgcFrameData"]);
    vi.restoreAllMocks();
  });

  it("reports a dropped tick through onInvalidMessage", () => {
    const { transport, client } = setup();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const problems: string[] = [];
    client.onInvalidMessage((report) => problems.push(`${report.kind} ${report.issues.map((issue) => issue.path).join(",")}`));
    transport.deliver({ jsonrpc: "2.0", method: "event.tick", params: { tickId: 1 } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^notification timestamp,executionState,registers,breakpoints,eventLog$/);
    vi.restoreAllMocks();
  });
});
