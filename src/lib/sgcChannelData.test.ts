import { afterEach, describe, expect, it, vi } from "vitest";
import { SGC_BYTES_PER_CHANNEL, SGC_BYTES_PER_FRAME, SGC_CHANNELS_PER_FRAME } from "./binaryFrame";
import {
  SGC_AEG_STATES,
  SGC_FLAGS_OFFSET,
  SgcChannelData,
  SgcFrameData,
  checkCapture,
  clampFrameIndex,
  findActiveChannels,
  type SgcCapture,
} from "./sgcChannelData";

/**
 * Real, monotonic time for the bound of the scan: performance.now taken at module load, before any fake timers could
 * replace it. Not Date.now: the wall clock of a host may step forward by seconds at any moment (a resync of the clock).
 */
const monotonicNow = performance.now.bind(performance);

/**
 * The bound of a scan of 4096 frames x 64 channels in which no channel plays: every record's flags byte is read. In
 * place that is 262144 one-byte reads, 10 to 15 ms here; with a copy of the frame per frame and channel, as the panel
 * had it, it is 2 GiB copied, about a second in node (seven in the browser).
 */
const SCAN_4096_BOUND_MS = 250;

const emptyCapture = (frameCount: number): SgcCapture => ({ frameCount, data: new ArrayBuffer(frameCount * SGC_BYTES_PER_FRAME) });

const recordOffset = (frame: number, channel: number) => frame * SGC_BYTES_PER_FRAME + channel * SGC_BYTES_PER_CHANNEL;

/** Writes a channel's level (offset 96) and flags byte (109) in one frame. */
const putRecord = (capture: SgcCapture, frame: number, channel: number, { level, flags }: { level: number; flags: number }) => {
  const view = new DataView(capture.data);
  view.setUint32(recordOffset(frame, channel) + 96, level, true);
  view.setUint8(recordOffset(frame, channel) + SGC_FLAGS_OFFSET, flags);
};

/** Every way a buffer is copied whole or in part: none of them is called by a read in place. */
const spyOnCopies = () => [
  vi.spyOn(ArrayBuffer.prototype, "slice"),
  vi.spyOn(Uint8Array.prototype, "slice"),
  vi.spyOn(Uint8Array.prototype, "set"),
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the channel record of protocol v3 (design 3.4)", () => {
  it("flags is byte 109: enabled is its bit 0 and aegState its bits 1-2, whatever the bytes around it hold", () => {
    const capture = emptyCapture(3);
    const bytes = new Uint8Array(capture.data);
    // the bytes in front of and behind the flags byte are not read as part of it
    bytes[recordOffset(2, 5) + SGC_FLAGS_OFFSET - 1] = 0xff;
    bytes[recordOffset(2, 5) + SGC_FLAGS_OFFSET + 1] = 0xff;
    const channel = new SgcChannelData(capture.data, 5, 2);
    for (let value = 0; value < 256; value++) {
      bytes[recordOffset(2, 5) + SGC_FLAGS_OFFSET] = value;
      expect(channel.flags).toBe(value);
      expect(channel.enabled).toBe((value & 1) === 1);
      expect(channel.aegState).toBe((value >> 1) & 3);
      expect(channel.aegStateName).toBe(SGC_AEG_STATES[(value >> 1) & 3]);
    }
  });

  it("the AEG states are attack, decay 1, decay 2 and release", () => {
    expect(SGC_AEG_STATES).toEqual(["attack", "decay 1", "decay 2", "release"]);
    const capture = emptyCapture(1);
    const channel = new SgcChannelData(capture.data, 0);
    expect([0b000, 0b011, 0b101, 0b111].map((flags) => ((channel.flags = flags), channel.aegStateName))).toEqual([
      "attack",
      "decay 1",
      "decay 2",
      "release",
    ]);
  });

  it("the setters of enabled and aegState change their bits of byte 109 and nothing else", () => {
    const capture = emptyCapture(2);
    const bytes = new Uint8Array(capture.data);
    const channel = new SgcChannelData(capture.data, 9, 1);
    channel.flags = 0b1111_0110;
    channel.enabled = true;
    expect(channel.flags).toBe(0b1111_0111);
    channel.aegState = 1;
    expect(channel.flags).toBe(0b1111_0011);
    channel.enabled = false;
    expect(channel.flags).toBe(0b1111_0010);
    channel.aegState = 3;
    expect(channel.flags).toBe(0b1111_0110);
    // only the flags byte of that one record was written
    expect(bytes.findIndex((byte, index) => byte !== 0 && index !== recordOffset(1, 9) + SGC_FLAGS_OFFSET)).toBe(-1);
  });

  it("each field is read at its offset of the record", () => {
    const capture = emptyCapture(1);
    const view = new DataView(capture.data);
    const base = recordOffset(0, 33);
    const int16s = [72, 74, 76, 78, 80, 82, 84, 86, 88];
    int16s.forEach((offset, index) => view.setInt16(base + offset, -1000 - index, true));
    view.setUint16(base + 90, 0xfc00 | 0x2a5, true);
    view.setUint32(base + 92, 0x89abcdef, true);
    view.setUint32(base + 96, 0x3ff, true);
    view.setUint32(base + 100, 0x1abc, true);
    view.setUint8(base + 104, 0x11);
    view.setUint8(base + 105, 0x22);
    view.setUint8(base + 106, 0x33);
    // ca_current is 16 bits at an odd offset, in front of the flags byte
    view.setUint16(base + 107, 0xbeef, true);
    view.setUint8(base + 109, 0b101);
    const channel = new SgcChannelData(capture.data, 33);
    expect([
      channel.sample_current,
      channel.sample_previous,
      channel.sample_filtered,
      channel.sample_post_aeg,
      channel.sample_post_feg,
      channel.sample_post_tl,
      channel.sample_left,
      channel.sample_right,
      channel.sample_dsp,
    ]).toEqual(int16s.map((_, index) => -1000 - index));
    expect(channel.ca_fraction).toBe(0x2a5);
    expect(channel.ca_step).toBe(0x89abcdef);
    expect(channel.aeg_value).toBe(0x3ff);
    expect(channel.feg_value).toBe(0x1abc);
    expect([channel.lfo_value, channel.alfo_value, channel.plfo_value]).toEqual([0x11, 0x22, 0x33]);
    expect(channel.ca_current).toBe(0xbeef);
    expect([channel.flags, channel.enabled, channel.aegState]).toEqual([0b101, true, 2]);
    expect(channel.toObject()).toMatchObject({ aeg_value: 0x3ff, ca_current: 0xbeef, flags: 0b101, enabled: 1, aegState: 2 });
  });

  it("a record is read in place, at its frame and channel: a change of the buffer is seen, and nothing is copied", () => {
    const capture = emptyCapture(4);
    const copies = spyOnCopies();
    const last = new SgcChannelData(capture.data, SGC_CHANNELS_PER_FRAME - 1, 3);
    const frame = new SgcFrameData(capture.data, 3).getChannel(SGC_CHANNELS_PER_FRAME - 1);
    new Uint8Array(capture.data)[recordOffset(3, SGC_CHANNELS_PER_FRAME - 1) + SGC_FLAGS_OFFSET] = 0b111;
    expect([last.enabled, last.aegState]).toEqual([true, 3]);
    expect([frame.enabled, frame.aegState]).toEqual([true, 3]);
    // the record in front of it is another channel's
    expect(new SgcChannelData(capture.data, SGC_CHANNELS_PER_FRAME - 2, 3).flags).toBe(0);
    expect(new SgcFrameData(capture.data, 2).getChannel(SGC_CHANNELS_PER_FRAME - 1).flags).toBe(0);
    for (const copy of copies) {
      expect(copy).not.toHaveBeenCalled();
    }
  });

  it("a frame or channel outside the capture is a RangeError, not a read of nothing", () => {
    const { data } = emptyCapture(2);
    expect(() => new SgcChannelData(data, SGC_CHANNELS_PER_FRAME)).toThrow(RangeError);
    expect(() => new SgcChannelData(data, -1)).toThrow(RangeError);
    expect(() => new SgcChannelData(data, 0, 2)).toThrow(RangeError);
    expect(() => new SgcChannelData(data, 0, -1)).toThrow(RangeError);
    expect(() => new SgcChannelData(data, 0, 0.5)).toThrow(RangeError);
    expect(() => new SgcFrameData(data, 2)).toThrow(RangeError);
    expect(() => new SgcFrameData(data, -1)).toThrow(RangeError);
    expect(() => new SgcFrameData(data, 1).getChannel(SGC_CHANNELS_PER_FRAME)).toThrow(RangeError);
    expect(() => new SgcFrameData(emptyCapture(0).data, 0)).toThrow(RangeError);
    expect(new SgcFrameData(data, 1).getChannel(SGC_CHANNELS_PER_FRAME - 1).flags).toBe(0);
  });
});

describe("clampFrameIndex", () => {
  it("keeps a position inside a capture of frameCount frames, and at 0 for a capture without frames", () => {
    expect([0, 5, 63, 64, 1023, -3, 2.7, Number.NaN, Infinity].map((index) => clampFrameIndex(index, 64))).toEqual([
      0, 5, 63, 63, 63, 0, 2, 0, 0,
    ]);
    expect(clampFrameIndex(1023, 1)).toBe(0);
    expect(clampFrameIndex(1023, 0)).toBe(0);
    expect(clampFrameIndex(4000, 4096)).toBe(4000);
  });
});

describe("findActiveChannels", () => {
  it("a channel plays when flags bit 0 is set in a frame: a level above 0 with bit 0 clear does not make it active", () => {
    const capture = emptyCapture(64);
    for (let frame = 0; frame < 64; frame++) {
      // loud, in release, not enabled: a channel that has run to its end with its level kept
      putRecord(capture, frame, 3, { level: 0x3ff, flags: 0b110 });
      // every other bit of the flags byte set, bit 0 clear
      putRecord(capture, frame, 4, { level: 0x200, flags: 0b1111_1110 });
    }
    // enabled at level 0, in one frame only: the attack of a channel keyed on in that frame
    putRecord(capture, 17, 7, { level: 0, flags: 0b001 });
    // enabled in the last frame only
    putRecord(capture, 63, 63, { level: 0, flags: 0b011 });
    expect([...findActiveChannels(capture)].sort((a, b) => a - b)).toEqual([7, 63]);
  });

  it("scans the frames the capture has: 1, 64 and 1024", () => {
    for (const frameCount of [1, 64, 1024]) {
      const capture = emptyCapture(frameCount);
      putRecord(capture, frameCount - 1, 0, { level: 1, flags: 1 });
      putRecord(capture, 0, 1, { level: 1, flags: 1 });
      expect([...findActiveChannels(capture)].sort((a, b) => a - b), `${frameCount} frames`).toEqual([0, 1]);
    }
  });

  it("a capture of 0 frames has no channel that plays", () => {
    expect(findActiveChannels(emptyCapture(0)).size).toBe(0);
  });

  it("a buffer that does not hold frameCount frames is no capture", () => {
    expect(() => findActiveChannels({ frameCount: 2, data: new ArrayBuffer(SGC_BYTES_PER_FRAME) })).toThrow(RangeError);
    expect(() => findActiveChannels({ frameCount: 1, data: new ArrayBuffer(SGC_BYTES_PER_FRAME + 1) })).toThrow(RangeError);
    expect(() => checkCapture({ frameCount: -1, data: new ArrayBuffer(0) })).toThrow(RangeError);
    expect(() => checkCapture({ frameCount: 0, data: new ArrayBuffer(0) })).not.toThrow();
  });

  it(`scans 4096 frames in which no channel plays within ${SCAN_4096_BOUND_MS} ms, reading every record in place`, () => {
    const capture = emptyCapture(4096);
    for (let frame = 0; frame < 4096; frame++) {
      for (let channel = 0; channel < SGC_CHANNELS_PER_FRAME; channel++) {
        putRecord(capture, frame, channel, { level: 0x3ff, flags: 0b110 });
      }
    }
    const copies = spyOnCopies();
    const started = monotonicNow();
    const active = findActiveChannels(capture);
    const elapsed = Math.round(monotonicNow() - started);
    expect(active.size).toBe(0);
    expect(elapsed, `${elapsed} ms`).toBeLessThan(SCAN_4096_BOUND_MS);
    for (const copy of copies) {
      expect(copy).not.toHaveBeenCalled();
    }
  });
});
