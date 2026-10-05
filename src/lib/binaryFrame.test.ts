import { describe, expect, it } from "vitest";
import {
  BINARY_FRAME_HEADER_BYTES,
  BinaryFrameKind,
  encodeBinaryFrame,
  encodeBinaryFrameHeader,
  parseBinaryFrame,
} from "./binaryFrame";

describe("binary frame header (protocol v3)", () => {
  it("is 16 bytes: magic NDB3, then kind, binaryId and payloadBytes as little-endian u32", () => {
    const header = encodeBinaryFrameHeader({ kind: BinaryFrameKind.SGC_FRAMES, binaryId: 0x01020304, payloadBytes: 524288 });
    expect(Array.from(header)).toEqual([
      0x4e, 0x44, 0x42, 0x33, // "NDB3"
      0x01, 0x00, 0x00, 0x00, // kind 1
      0x04, 0x03, 0x02, 0x01, // binaryId
      0x00, 0x00, 0x08, 0x00, // payloadBytes
    ]);
    expect(header.byteLength).toBe(BINARY_FRAME_HEADER_BYTES);
  });

  it("round-trips a frame and strips the header", () => {
    const payload = Uint8Array.from([1, 2, 3, 4, 5]);
    const frame = encodeBinaryFrame(BinaryFrameKind.MEMORY, 7, payload);
    const parsed = parseBinaryFrame(frame.buffer as ArrayBuffer);
    expect(parsed).toMatchObject({ ok: true, header: { kind: 2, binaryId: 7, payloadBytes: 5 } });
    if (parsed.ok) {
      expect(Array.from(new Uint8Array(parsed.payload))).toEqual([1, 2, 3, 4, 5]);
    }
  });

  it("accepts a view into a larger buffer and returns a payload that does not alias the frame", () => {
    const frame = encodeBinaryFrame(BinaryFrameKind.TA_CAPTURE, 1, Uint8Array.from([9, 8, 7]));
    const padded = new Uint8Array(frame.byteLength + 8);
    padded.set(frame, 4);
    const parsed = parseBinaryFrame(padded.subarray(4, 4 + frame.byteLength));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      padded.fill(0);
      expect(Array.from(new Uint8Array(parsed.payload))).toEqual([9, 8, 7]);
    }
  });

  it("accepts an empty payload", () => {
    const parsed = parseBinaryFrame(encodeBinaryFrame(BinaryFrameKind.SGC_FRAMES, 1, new Uint8Array(0)));
    expect(parsed).toMatchObject({ ok: true, header: { payloadBytes: 0 } });
  });

  it("rejects a frame without the magic (a v2 payload)", () => {
    const parsed = parseBinaryFrame(new Uint8Array(8192));
    expect(parsed).toEqual({ ok: false, reason: 'frame does not start with "NDB3"' });
  });

  it("rejects a frame that is shorter than the header", () => {
    expect(parseBinaryFrame(Uint8Array.from([0x4e, 0x44, 0x42, 0x33])).ok).toBe(false);
  });

  it("rejects a frame whose length differs from payloadBytes", () => {
    const frame = encodeBinaryFrame(BinaryFrameKind.SGC_FRAMES, 1, new Uint8Array(32));
    const truncated = parseBinaryFrame(frame.subarray(0, frame.byteLength - 1));
    expect(truncated).toEqual({ ok: false, reason: "header announces 32 payload bytes, the frame carries 31" });
    const extended = new Uint8Array(frame.byteLength + 1);
    extended.set(frame);
    expect(parseBinaryFrame(extended).ok).toBe(false);
  });
});
