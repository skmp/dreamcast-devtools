import { SgcChannelData, checkCapture, clampFrameIndex, type SgcCapture } from "../../lib/sgcChannelData";

export type SgcViewMode = 'pre-volpan' | 'post-volpan' | 'input';

/** A vertex is x (a frame index), y (normalized, 0 at the top, 1 at the bottom), r, g, b, a. */
export const FLOATS_PER_VERTEX = 6;
/** A bar or a line segment is two triangles. */
const FLOATS_PER_QUAD = 6 * FLOATS_PER_VERTEX;

type Rgba = readonly [number, number, number, number];

const BLUE: Rgba = [0.098, 0.463, 0.824, 0.8];
const PINK: Rgba = [0.824, 0.098, 0.463, 0.8];
const ORANGE: Rgba = [1.0, 0.596, 0.0, 0.8];
const PURPLE: Rgba = [0.612, 0.153, 0.690, 0.8];
const AEG_GREEN: Rgba = [0.298, 0.686, 0.314, 0.7];
const FEG_ORANGE: Rgba = [1.0, 0.596, 0.0, 0.7];
export const HOVER_COLOUR: Rgba = [1, 1, 1, 0.4];
export const PLAYBACK_COLOUR: Rgba = [1, 0.596, 0, 0.9];

/** How many vertices `vertices` holds. */
export const vertexCount = (vertices: Float32Array): number => vertices.length / FLOATS_PER_VERTEX;

/** A bar from x1 to x2 between y1 and y2. */
const putBar = (vertices: Float32Array, offset: number, x1: number, x2: number, y1: number, y2: number, [r, g, b, a]: Rgba) => {
  vertices.set([
    x1, y1, r, g, b, a,
    x2, y1, r, g, b, a,
    x1, y2, r, g, b, a,
    x2, y1, r, g, b, a,
    x2, y2, r, g, b, a,
    x1, y2, r, g, b, a,
  ], offset);
};

/** A line from (x1, y1) to (x2, y2), `thickness` tall. */
const putSegment = (vertices: Float32Array, offset: number, x1: number, y1: number, x2: number, y2: number, thickness: number, [r, g, b, a]: Rgba) => {
  vertices.set([
    x1, y1 - thickness, r, g, b, a,
    x2, y2 - thickness, r, g, b, a,
    x1, y1 + thickness, r, g, b, a,
    x2, y2 - thickness, r, g, b, a,
    x2, y2 + thickness, r, g, b, a,
    x1, y1 + thickness, r, g, b, a,
  ], offset);
};

/** What one channel of a capture draws: its waveform and its two envelopes. */
export interface SgcChannelGeometry {
  /** the capture's frame count: x runs over [0, frameCount) (a bar ends half a frame further) */
  frameCount: number;
  waveform: Float32Array;
  /** one segment between two neighbouring frames: none for a capture of fewer than two */
  aeg: Float32Array;
  feg: Float32Array;
}

/**
 * The vertices of one channel of a capture in a view mode, read from the capture in place
 * (one DataView on it, no copy per frame). A capture without frames draws nothing.
 */
export const buildChannelGeometry = (capture: SgcCapture, channelIndex: number, viewMode: SgcViewMode): SgcChannelGeometry => {
  checkCapture(capture);
  const { frameCount } = capture;
  const view = new DataView(capture.data);
  const channel = (frame: number) => new SgcChannelData(view, channelIndex, frame);
  // bars are 1.5 frames wide for a fatter appearance
  const barWidth = 1.5;

  let waveform: Float32Array;
  if (viewMode === 'post-volpan') {
    // three waveforms: left (blue) at 1/6, right (pink) at 1/2, DSP send (orange) at 5/6, each 12% tall
    const scale = 0.12;
    const lanes: Array<{ centre: number; colour: Rgba; sample: (data: SgcChannelData) => number }> = [
      { centre: 1.0 / 6.0, colour: BLUE, sample: (data) => data.sample_left },
      { centre: 0.5, colour: PINK, sample: (data) => data.sample_right },
      { centre: 5.0 / 6.0, colour: ORANGE, sample: (data) => data.sample_dsp },
    ];
    waveform = new Float32Array(frameCount * lanes.length * FLOATS_PER_QUAD);
    let offset = 0;
    for (let frame = 0; frame < frameCount; frame++) {
      const data = channel(frame);
      for (const { centre, colour, sample } of lanes) {
        // int16 to [-1, 1]
        const amplitude = sample(data) / 32768.0;
        const height = Math.abs(amplitude * scale);
        const top = amplitude >= 0 ? centre - height : centre;
        const bottom = amplitude >= 0 ? centre : centre + height;
        putBar(waveform, offset, frame, frame + barWidth, top, bottom, colour);
        offset += FLOATS_PER_QUAD;
      }
    }
  } else {
    // one waveform around the middle, 40% of the height: Pre-VolPan the sample after TL (blue),
    // Input the filtered sample (purple)
    const colour = viewMode === 'input' ? PURPLE : BLUE;
    const scale = 0.4;
    waveform = new Float32Array(frameCount * FLOATS_PER_QUAD);
    for (let frame = 0; frame < frameCount; frame++) {
      const data = channel(frame);
      const amplitude = (viewMode === 'input' ? data.sample_filtered : data.sample_post_tl) / 32768.0;
      const top = amplitude >= 0 ? 0.5 - amplitude * scale : 0.5;
      const bottom = amplitude >= 0 ? 0.5 : 0.5 - amplitude * scale;
      putBar(waveform, frame * FLOATS_PER_QUAD, frame, frame + barWidth, top, bottom, colour);
    }
  }

  // the envelopes over the full height: AEG 0x3FF (loudest) and FEG 0x1FFF at the top, 0 at the bottom
  const segments = Math.max(0, frameCount - 1);
  const thickness = 0.003;
  const aeg = new Float32Array(segments * FLOATS_PER_QUAD);
  const feg = new Float32Array(segments * FLOATS_PER_QUAD);
  for (let frame = 0; frame < segments; frame++) {
    const here = channel(frame);
    const next = channel(frame + 1);
    putSegment(aeg, frame * FLOATS_PER_QUAD, frame, 1 - here.aeg_value / 0x3FF, frame + barWidth, 1 - next.aeg_value / 0x3FF, thickness, AEG_GREEN);
    putSegment(feg, frame * FLOATS_PER_QUAD, frame, 1 - here.feg_value / 0x1FFF, frame + barWidth, 1 - next.feg_value / 0x1FFF, thickness, FEG_ORANGE);
  }

  return { frameCount, waveform, aeg, feg };
};

/**
 * A cursor over the full height at `position`, a frame of a capture of `frameCount`
 * frames (clamped to it), `halfWidth` frames to either side (the canvas makes that one
 * pixel, so a cursor on a short capture is not a wide band). None for a capture without frames.
 */
export const buildCursorVertices = (position: number, frameCount: number, halfWidth: number, colour: Rgba): Float32Array => {
  if (frameCount <= 0) {
    return new Float32Array(0);
  }
  const frame = clampFrameIndex(position, frameCount);
  const vertices = new Float32Array(FLOATS_PER_QUAD);
  putBar(vertices, 0, frame - halfWidth, frame + halfWidth, 0, 1, colour);
  return vertices;
};

/**
 * WebGL-based renderer for SGC waveform visualization
 * Renders to an offscreen canvas and can blit to multiple destination canvases
 */
export class SgcWaveformRenderer {
  private offscreenCanvas: OffscreenCanvas;
  private gl: WebGLRenderingContext;
  private program: WebGLProgram;
  private width: number = 0;
  private height: number = 0;

  constructor() {
    // Create offscreen canvas with initial size of 1x1
    this.offscreenCanvas = new OffscreenCanvas(1, 1);

    // Get WebGL context
    const glContext = this.offscreenCanvas.getContext('webgl');
    if (!glContext) {
      throw new Error('WebGL is not available');
    }
    this.gl = glContext as WebGLRenderingContext;

    // Initialize shaders and program
    this.program = this.initializeProgram();

    // Enable blending for transparency
    this.gl.enable(this.gl.BLEND);
    this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
  }

  private initializeProgram(): WebGLProgram {
    const gl = this.gl;

    const vertexShaderSource = `
      attribute vec2 a_position; // x: sample index [0-numFrames), y: normalized Y [0, 1]
      attribute vec4 a_color;
      uniform vec2 u_resolution;
      uniform vec2 u_transform; // x: scrollOffsetX, y: zoomLevel
      uniform float u_numFrames; // Number of frames in the data
      varying vec4 v_color;

      void main() {
        // Convert sample index to normalized X [0, 1]
        float normalizedX = a_position.x / u_numFrames;

        // Convert to pixel coordinates
        float pixelX = normalizedX * u_resolution.x;
        float pixelY = a_position.y * u_resolution.y;

        // Apply pan and zoom (only to X)
        vec2 transformed = vec2(
          (pixelX * u_transform.y) - u_transform.x,
          pixelY
        );

        // Convert from pixel coordinates to clip space (-1 to 1)
        vec2 clipSpace = (transformed / u_resolution) * 2.0 - 1.0;
        clipSpace.y = -clipSpace.y; // Flip Y axis

        gl_Position = vec4(clipSpace, 0.0, 1.0);
        v_color = a_color;
      }
    `;

    const fragmentShaderSource = `
      precision mediump float;
      varying vec4 v_color;

      void main() {
        gl_FragColor = v_color;
      }
    `;

    // Compile shaders
    const compileShader = (type: number, source: string): WebGLShader => {
      const shader = gl.createShader(type);
      if (!shader) {
        throw new Error('Failed to create shader');
      }

      gl.shaderSource(shader, source);
      gl.compileShader(shader);

      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const error = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`Shader compile error: ${error}`);
      }

      return shader;
    };

    const vertexShader = compileShader(gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource);

    // Link program
    const program = gl.createProgram();
    if (!program) {
      throw new Error('Failed to create program');
    }

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const error = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`Program link error: ${error}`);
    }

    // Cleanup shaders (they're no longer needed after linking)
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    return program;
  }

  /**
   * Create a vertex buffer from Float32Array data
   */
  createVertexBuffer(data: Float32Array): WebGLBuffer {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    if (!buffer) {
      throw new Error('Failed to create buffer');
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

    return buffer;
  }

  /**
   * Destroy a vertex buffer
   */
  destroyVertexBuffer(buffer: WebGLBuffer): void {
    this.gl.deleteBuffer(buffer);
  }

  /**
   * Clear the offscreen canvas
   * Automatically resizes to match destination canvas if needed
   */
  clear(width: number, height: number): void {
    // Resize if dimensions don't match
    if (this.width !== width || this.height !== height) {
      this.width = width;
      this.height = height;
      this.offscreenCanvas.width = width;
      this.offscreenCanvas.height = height;
    }

    const gl = this.gl;
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /**
   * Render vertex buffer to the offscreen canvas. `numFrames` is the capture's frame count,
   * the x range the canvas's width shows; a capture without frames draws nothing.
   */
  render(
    vertexBuffer: WebGLBuffer,
    vertexCount: number,
    scrollOffsetX: number,
    zoomLevel: number,
    numFrames: number
  ): void {
    if (numFrames <= 0 || vertexCount <= 0) {
      return;
    }
    const gl = this.gl;
    const program = this.program;

    // Set viewport
    gl.viewport(0, 0, this.width, this.height);

    // Use program
    gl.useProgram(program);

    // Set uniforms
    const u_resolution = gl.getUniformLocation(program, 'u_resolution');
    const u_transform = gl.getUniformLocation(program, 'u_transform');
    const u_numFrames = gl.getUniformLocation(program, 'u_numFrames');
    gl.uniform2f(u_resolution, this.width, this.height);
    gl.uniform2f(u_transform, scrollOffsetX, zoomLevel);
    gl.uniform1f(u_numFrames, numFrames);

    // Bind buffer and set up attributes
    const a_position = gl.getAttribLocation(program, 'a_position');
    const a_color = gl.getAttribLocation(program, 'a_color');

    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.enableVertexAttribArray(a_position);
    gl.vertexAttribPointer(a_position, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(a_color);
    gl.vertexAttribPointer(a_color, 4, gl.FLOAT, false, 24, 8);

    // Draw
    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
  }

  /**
   * Copy the offscreen canvas to a destination canvas
   */
  copyToCanvas(destinationCanvas: HTMLCanvasElement): void {
    const ctx = destinationCanvas.getContext('2d');
    if (!ctx) {
      console.warn('Failed to get 2D context from destination canvas');
      return;
    }

    ctx.clearRect(0, 0, destinationCanvas.width, destinationCanvas.height);
    ctx.drawImage(this.offscreenCanvas, 0, 0);
  }

  /**
   * Resize the renderer
   */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.offscreenCanvas.width = width;
    this.offscreenCanvas.height = height;
  }

  /**
   * Get current dimensions
   */
  getDimensions(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.gl.deleteProgram(this.program);
  }
}
