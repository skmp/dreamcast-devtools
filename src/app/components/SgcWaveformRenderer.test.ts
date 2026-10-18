import { afterEach, describe, expect, it, vi } from "vitest";
import { SGC_BYTES_PER_CHANNEL, SGC_BYTES_PER_FRAME } from "../../lib/binaryFrame";
import type { SgcCapture } from "../../lib/sgcChannelData";
import { FLOATS_PER_VERTEX, PLAYBACK_COLOUR, buildChannelGeometry, buildCursorVertices, vertexCount, type SgcViewMode } from "./SgcWaveformRenderer";

/** Real, monotonic time (performance.now taken at module load): no fake timer replaces it, no step of the wall clock moves it. */
const monotonicNow = performance.now.bind(performance);

/**
 * The bound of the geometry of one channel of a capture of 4096 frames: read in place, 4 to 18 ms here. The canvas used
 * to copy a frame for every frame it read (five per frame: 160 MiB per channel and view, about 140 ms here); that copy
 * is what the spies on the copying methods catch, the bound keeps the build from being slow in any other way.
 */
const GEOMETRY_4096_BOUND_MS = 200;

const MODES: SgcViewMode[] = ["pre-volpan", "post-volpan", "input"];

const capture = (frameCount: number): SgcCapture => ({ frameCount, data: new ArrayBuffer(frameCount * SGC_BYTES_PER_FRAME) });

const record = (capture: SgcCapture, frame: number, channel: number) => {
  const view = new DataView(capture.data);
  const base = frame * SGC_BYTES_PER_FRAME + channel * SGC_BYTES_PER_CHANNEL;
  return {
    int16: (offset: number, value: number) => view.setInt16(base + offset, value, true),
    uint32: (offset: number, value: number) => view.setUint32(base + offset, value, true),
  };
};

/** Column `index` of every vertex: 0 is x (a frame index), 1 is y. */
const column = (vertices: Float32Array, index: number) =>
  Array.from({ length: vertexCount(vertices) }, (_, vertex) => vertices[vertex * FLOATS_PER_VERTEX + index]);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildChannelGeometry", () => {
  it("draws nothing for a capture without frames, in every view", () => {
    for (const mode of MODES) {
      const geometry = buildChannelGeometry(capture(0), 0, mode);
      expect([geometry.frameCount, geometry.waveform.length, geometry.aeg.length, geometry.feg.length], mode).toEqual([0, 0, 0, 0]);
    }
  });

  it("draws one bar per frame and lane, and an envelope segment between two neighbouring frames: none for one frame", () => {
    for (const frameCount of [1, 2, 64, 1024]) {
      for (const mode of MODES) {
        const geometry = buildChannelGeometry(capture(frameCount), 5, mode);
        const lanes = mode === "post-volpan" ? 3 : 1;
        expect(vertexCount(geometry.waveform), `${frameCount} ${mode}`).toBe(frameCount * lanes * 6);
        expect(vertexCount(geometry.aeg), `${frameCount} ${mode}`).toBe((frameCount - 1) * 6);
        expect(vertexCount(geometry.feg), `${frameCount} ${mode}`).toBe((frameCount - 1) * 6);
      }
    }
  });

  it("spans the capture's frames: x runs from 0 to the last frame, whatever the length", () => {
    for (const frameCount of [1, 64, 4096]) {
      const geometry = buildChannelGeometry(capture(frameCount), 0, "pre-volpan");
      const x = column(geometry.waveform, 0);
      expect([Math.min(...x), Math.max(...x)], `${frameCount} frames`).toEqual([0, frameCount - 1 + 1.5]);
      if (frameCount > 1) {
        const envelope = column(geometry.aeg, 0);
        expect([Math.min(...envelope), Math.max(...envelope)], `${frameCount} frames`).toEqual([0, frameCount - 2 + 1.5]);
      }
    }
  });

  it("each view draws its own samples of the record, and the envelopes the level and the FEG", () => {
    const sgc = capture(2);
    const channel = record(sgc, 1, 7);
    channel.int16(76, 16384); // filtered: Input
    channel.int16(82, -16384); // after TL: Pre-VolPan
    channel.int16(84, 32767); // left
    channel.int16(86, -32768); // right
    channel.int16(88, 8192); // DSP send
    channel.uint32(96, 0x3ff); // the level: at the top
    channel.uint32(100, 0); // FEG 0: at the bottom
    // frame 1's bar is the second: 0.5 is the middle, 0.4 of the height is full scale
    const pre = buildChannelGeometry(sgc, 7, "pre-volpan").waveform.subarray(36, 72);
    expect([Math.min(...column(pre, 1)), Math.max(...column(pre, 1))].map((value) => Number(value.toFixed(4)))).toEqual([0.5, 0.7]);
    const input = buildChannelGeometry(sgc, 7, "input").waveform.subarray(36, 72);
    expect([Math.min(...column(input, 1)), Math.max(...column(input, 1))].map((value) => Number(value.toFixed(4)))).toEqual([0.3, 0.5]);
    // Post-VolPan: three lanes per frame, around 1/6, 1/2 and 5/6, 0.12 of the height at full scale
    const post = buildChannelGeometry(sgc, 7, "post-volpan").waveform.subarray(3 * 36);
    const lane = (index: number) => {
      const y = column(post.subarray(index * 36, (index + 1) * 36), 1);
      return [Math.min(...y), Math.max(...y)].map((value) => Number(value.toFixed(4)));
    };
    expect([lane(0), lane(1), lane(2)]).toEqual([
      [Number((1 / 6 - 0.12 * (32767 / 32768)).toFixed(4)), Number((1 / 6).toFixed(4))],
      [0.5, 0.62],
      [Number((5 / 6 - 0.03).toFixed(4)), Number((5 / 6).toFixed(4))],
    ]);
    const geometry = buildChannelGeometry(sgc, 7, "pre-volpan");
    // the one segment runs from frame 0 (level 0, the bottom) to frame 1 (0x3FF, the top)
    const aegY = column(geometry.aeg, 1);
    expect([Math.min(...aegY), Math.max(...aegY)].map((value) => Number(value.toFixed(4)))).toEqual([-0.003, 1.003]);
    const fegY = column(geometry.feg, 1);
    expect([Math.min(...fegY), Math.max(...fegY)].map((value) => Number(value.toFixed(4)))).toEqual([0.997, 1.003]);
  });

  it("a buffer that does not hold the announced frames is refused", () => {
    expect(() => buildChannelGeometry({ frameCount: 3, data: new ArrayBuffer(SGC_BYTES_PER_FRAME) }, 0, "pre-volpan")).toThrow(RangeError);
  });

  it(`builds one channel of 4096 frames within ${GEOMETRY_4096_BOUND_MS} ms in every view, reading the records in place`, () => {
    const sgc = capture(4096);
    for (let frame = 0; frame < 4096; frame++) {
      const channel = record(sgc, frame, 63);
      channel.int16(82, (frame * 37) % 30000);
      channel.uint32(96, frame & 0x3ff);
    }
    const copies = [vi.spyOn(ArrayBuffer.prototype, "slice"), vi.spyOn(Uint8Array.prototype, "slice")];
    for (const mode of MODES) {
      const started = monotonicNow();
      const geometry = buildChannelGeometry(sgc, 63, mode);
      const elapsed = Math.round(monotonicNow() - started);
      expect(geometry.frameCount).toBe(4096);
      expect(elapsed, `${mode}: ${elapsed} ms`).toBeLessThan(GEOMETRY_4096_BOUND_MS);
    }
    for (const copy of copies) {
      expect(copy).not.toHaveBeenCalled();
    }
  });
});

describe("buildCursorVertices", () => {
  it("draws a cursor at a frame of the capture, clamped to it, halfWidth to either side, and none without frames", () => {
    const x = (position: number, frameCount: number, halfWidth = 1) => {
      const xs = column(buildCursorVertices(position, frameCount, halfWidth, PLAYBACK_COLOUR), 0);
      return [Math.min(...xs), Math.max(...xs)];
    };
    expect(x(10, 64)).toEqual([9, 11]);
    expect(x(10, 64, 0.25)).toEqual([9.75, 10.25]);
    // a position kept from a longer capture: at the last frame of this one
    expect(x(900, 64)).toEqual([62, 64]);
    expect(x(-5, 64)).toEqual([-1, 1]);
    expect(x(3000, 1, 0.5)).toEqual([-0.5, 0.5]);
    expect(buildCursorVertices(0, 0, 1, PLAYBACK_COLOUR).length).toBe(0);
    expect(column(buildCursorVertices(10, 64, 1, PLAYBACK_COLOUR), 1).sort()).toEqual([0, 0, 0, 1, 1, 1]);
  });
});
