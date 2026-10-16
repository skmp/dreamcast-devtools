/**
 * Binary WebSocket frames of protocol v3. A v3 server prefixes every binary frame with a
 * 16-byte little-endian header:
 *
 *   offset 0   4 bytes  magic "NDB3" (4E 44 42 33)
 *   offset 4   u32      kind
 *   offset 8   u32      binaryId, the `binaryId` of the JSON result the frame belongs to
 *   offset 12  u32      payloadBytes, the `totalBytes` of that result
 *
 * The JSON response is sent first and the frame second, to the requesting client only.
 * A frame without the header belongs to no request, and no client takes it.
 */
export const BINARY_FRAME_MAGIC = "NDB3";
export const BINARY_FRAME_HEADER_BYTES = 16;

export const BinaryFrameKind = {
  SGC_FRAMES: 1,
  MEMORY: 2,
  CORE_CAPTURE: 3,
  TA_CAPTURE: 4,
} as const;

export type BinaryFrameKindValue = (typeof BinaryFrameKind)[keyof typeof BinaryFrameKind];

/** One recorded AICA sample: 64 channels of 128 bytes. */
export const SGC_CHANNELS_PER_FRAME = 64;
export const SGC_BYTES_PER_CHANNEL = 128;
export const SGC_BYTES_PER_FRAME = SGC_CHANNELS_PER_FRAME * SGC_BYTES_PER_CHANNEL;

export interface BinaryFrameHeader {
  kind: number;
  binaryId: number;
  payloadBytes: number;
}

export type ParsedBinaryFrame =
  | { ok: true; header: BinaryFrameHeader; payload: ArrayBuffer }
  | { ok: false; reason: string };

const MAGIC_BYTES = [0x4e, 0x44, 0x42, 0x33];

export const encodeBinaryFrameHeader = (header: BinaryFrameHeader): Uint8Array => {
  const bytes = new Uint8Array(BINARY_FRAME_HEADER_BYTES);
  bytes.set(MAGIC_BYTES, 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, header.kind, true);
  view.setUint32(8, header.binaryId, true);
  view.setUint32(12, header.payloadBytes, true);
  return bytes;
};

/** Header and payload as one frame, ready to send. */
export const encodeBinaryFrame = (kind: number, binaryId: number, payload: Uint8Array): Uint8Array => {
  const frame = new Uint8Array(BINARY_FRAME_HEADER_BYTES + payload.byteLength);
  frame.set(encodeBinaryFrameHeader({ kind, binaryId, payloadBytes: payload.byteLength }), 0);
  frame.set(payload, BINARY_FRAME_HEADER_BYTES);
  return frame;
};

/**
 * Splits a v3 binary frame into its header and payload. The payload is a copy, so the
 * caller may keep it without keeping the frame. A frame without the magic, shorter than
 * its header, or whose length differs from `payloadBytes` is not a v3 frame.
 */
export const parseBinaryFrame = (frame: ArrayBuffer | ArrayBufferView): ParsedBinaryFrame => {
  const bytes =
    frame instanceof ArrayBuffer
      ? new Uint8Array(frame)
      : new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength);
  if (bytes.byteLength < BINARY_FRAME_HEADER_BYTES) {
    return { ok: false, reason: `frame of ${bytes.byteLength} bytes is shorter than the 16-byte header` };
  }
  for (let index = 0; index < MAGIC_BYTES.length; index++) {
    if (bytes[index] !== MAGIC_BYTES[index]) {
      return { ok: false, reason: `frame does not start with "${BINARY_FRAME_MAGIC}"` };
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header: BinaryFrameHeader = {
    kind: view.getUint32(4, true),
    binaryId: view.getUint32(8, true),
    payloadBytes: view.getUint32(12, true),
  };
  const actual = bytes.byteLength - BINARY_FRAME_HEADER_BYTES;
  if (header.payloadBytes !== actual) {
    return { ok: false, reason: `header announces ${header.payloadBytes} payload bytes, the frame carries ${actual}` };
  }
  const payload = new ArrayBuffer(actual);
  new Uint8Array(payload).set(bytes.subarray(BINARY_FRAME_HEADER_BYTES));
  return { ok: true, header, payload };
};
