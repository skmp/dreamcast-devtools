import { Box } from "@mui/material";
import React, { useRef, useEffect, memo, useImperativeHandle, forwardRef, useCallback } from "react";
import { clampFrameIndex, type SgcCapture } from "../../lib/sgcChannelData";
import {
  HOVER_COLOUR,
  PLAYBACK_COLOUR,
  SgcWaveformRenderer,
  buildChannelGeometry,
  buildCursorVertices,
  vertexCount,
  type SgcViewMode,
} from "./SgcWaveformRenderer";

export interface SgcWaveformCanvasHandle {
  setPanZoom: (scrollOffsetX: number, zoomLevel: number) => void;
  setPositions: (hoverPosition: number | null, playbackPosition: number) => void;
}

interface SgcWaveformCanvasProps {
  channelIndex: number;
  viewMode: SgcViewMode;
  capture: SgcCapture;
  renderer: SgcWaveformRenderer;
  onHoverPositionChange: (position: number | null) => void;
  onPlaybackPositionChange: (position: number) => void;
}

export const SgcWaveformCanvas = memo(forwardRef<SgcWaveformCanvasHandle, SgcWaveformCanvasProps>(({
  channelIndex,
  viewMode,
  capture,
  renderer,
  onHoverPositionChange,
  onPlaybackPositionChange,
}, ref) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const panZoomRef = useRef<{ scrollOffsetX: number; zoomLevel: number }>({ scrollOffsetX: 0, zoomLevel: 1 });
  const [hoverPosition, setHoverPosition] = React.useState<number | null>(null);
  const [playbackPosition, setPlaybackPosition] = React.useState<number>(0);

  // The frame count of the capture the cached buffers were built from: the x range of the
  // canvas, and the bound of every position drawn or reported.
  const frameCountRef = useRef<number>(capture.frameCount);

  // Rendering state
  const renderQueuedRef = useRef<boolean>(false);
  const animationFrameRef = useRef<number | undefined>(undefined);

  // Cached vertex buffers - only recreated when the capture, the channel or the view changes
  const waveformBufferRef = useRef<{ buffer: WebGLBuffer; vertices: number } | null>(null);
  const aegBufferRef = useRef<{ buffer: WebGLBuffer; vertices: number } | null>(null);
  const fegBufferRef = useRef<{ buffer: WebGLBuffer; vertices: number } | null>(null);

  // Position indicator buffers - recreated on every render
  const positionBuffersRef = useRef<WebGLBuffer[]>([]);

  // WebGL rendering function ref
  const renderCanvasRef = useRef<(() => void) | null>(null);

  // Queue a graph rerender using requestAnimationFrame
  const queueGraphRerender = useCallback(() => {
    if (renderQueuedRef.current) return; // Already queued
    renderQueuedRef.current = true;

    animationFrameRef.current = requestAnimationFrame(() => {
      renderQueuedRef.current = false;
      if (renderCanvasRef.current) {
        renderCanvasRef.current();
      }
    });
  }, []);

  // Calculate the frame under a mouse X coordinate: a frame of the capture, or null without one
  const calculateSamplePosition = useCallback((clientX: number): number | null => {
    const container = containerRef.current;
    const frameCount = frameCountRef.current;
    if (!container || frameCount <= 0) return null;

    const rect = container.getBoundingClientRect();
    const x = clientX - rect.left;
    const canvasWidth = rect.width;
    const { scrollOffsetX, zoomLevel } = panZoomRef.current;

    // Account for scroll offset and zoom
    const normalizedX = (x + scrollOffsetX) / (canvasWidth * zoomLevel);
    const constrainedNormalized = Math.max(0, Math.min(normalizedX, 1));

    // Convert to a frame index [0, frameCount)
    return clampFrameIndex(constrainedNormalized * frameCount, frameCount);
  }, []);

  // Handle mouse move for hover position
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const sampleIndex = calculateSamplePosition(e.clientX);
    setHoverPosition(sampleIndex);
    onHoverPositionChange(sampleIndex);
  }, [calculateSamplePosition, onHoverPositionChange]);

  // Handle mouse leave to clear hover position
  const handleMouseLeave = useCallback(() => {
    setHoverPosition(null);
    onHoverPositionChange(null);
  }, [onHoverPositionChange]);

  // Handle click to set playback position
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const sampleIndex = calculateSamplePosition(e.clientX);
    if (sampleIndex === null) return;
    setPlaybackPosition(sampleIndex);
    onPlaybackPositionChange(sampleIndex);
  }, [calculateSamplePosition, onPlaybackPositionChange]);

  // Create/update cached vertex buffers when the capture, the channel or the view changes
  useEffect(() => {
    const geometry = buildChannelGeometry(capture, channelIndex, viewMode);
    frameCountRef.current = geometry.frameCount;
    const upload = (vertices: Float32Array) =>
      vertices.length > 0 ? { buffer: renderer.createVertexBuffer(vertices), vertices: vertexCount(vertices) } : null;
    waveformBufferRef.current = upload(geometry.waveform);
    aegBufferRef.current = upload(geometry.aeg);
    fegBufferRef.current = upload(geometry.feg);

    // Trigger a render
    queueGraphRerender();

    // Cleanup on unmount or when buffers are recreated
    return () => {
      for (const cached of [waveformBufferRef, aegBufferRef, fegBufferRef]) {
        if (cached.current) {
          renderer.destroyVertexBuffer(cached.current.buffer);
          cached.current = null;
        }
      }
    };
  }, [renderer, capture, channelIndex, viewMode, queueGraphRerender]);

  // Render using cached buffers - only updates when pan/zoom or positions change
  useEffect(() => {
    const renderCanvas = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const { width, height } = canvas;
      if (width === 0 || height === 0) return;

      // the frame count of the capture the buffers hold (a ref: read when the frame is drawn)
      const numFrames = frameCountRef.current;

      // Get current pan/zoom values
      const { scrollOffsetX, zoomLevel } = panZoomRef.current;

      // Clear offscreen canvas (renderer will auto-resize to match canvas dimensions)
      renderer.clear(width, height);

      // Render waveform and the two envelopes (cached)
      for (const cached of [waveformBufferRef.current, aegBufferRef.current, fegBufferRef.current]) {
        if (cached) {
          renderer.render(cached.buffer, cached.vertices, scrollOffsetX, zoomLevel, numFrames);
        }
      }

      // Clean up old position buffers
      positionBuffersRef.current.forEach(buffer => renderer.destroyVertexBuffer(buffer));
      positionBuffersRef.current = [];

      // Render position indicators (not cached, recreated each frame), clamped to the capture,
      // one pixel to either side of their frame
      const halfWidth = numFrames / width;
      const cursors = [
        ...(hoverPosition !== null ? [buildCursorVertices(hoverPosition, numFrames, halfWidth, HOVER_COLOUR)] : []),
        buildCursorVertices(playbackPosition, numFrames, halfWidth, PLAYBACK_COLOUR),
      ];
      for (const vertices of cursors) {
        if (vertices.length === 0) continue;
        const buffer = renderer.createVertexBuffer(vertices);
        positionBuffersRef.current.push(buffer);
        renderer.render(buffer, vertexCount(vertices), 0, 1, numFrames); // No pan/zoom for indicators
      }

      // Copy offscreen canvas to display canvas
      renderer.copyToCanvas(canvas);
    };

    // Assign render function to ref
    renderCanvasRef.current = renderCanvas;

    // Trigger initial render
    renderCanvas();
    // a new capture redraws through queueGraphRerender (the buffer effect), with the frame count of frameCountRef
  }, [renderer, viewMode, hoverPosition, playbackPosition]);


  // Expose setPanZoom and setPositions methods to parent
  useImperativeHandle(ref, () => ({
    setPanZoom: (scrollOffsetX: number, zoomLevel: number) => {
      panZoomRef.current = { scrollOffsetX, zoomLevel };
      queueGraphRerender();
    },
    setPositions: (hover: number | null, playback: number) => {
      setHoverPosition(hover);
      setPlaybackPosition(playback);
    }
  }), [queueGraphRerender]);

  // Update canvas size on container resize using ResizeObserver
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const updateCanvasSize = () => {
      const rect = container.getBoundingClientRect();
      const newWidth = rect.width;
      const newHeight = rect.height;

      if (newWidth > 0 && newHeight > 0) {
        canvas.width = newWidth;
        canvas.height = newHeight;
        // Trigger a render after canvas is resized
        queueGraphRerender();
      }
    };

    // Use ResizeObserver to detect container size changes (fires initially when observed)
    const resizeObserver = new ResizeObserver(() => {
      updateCanvasSize();
    });

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, [queueGraphRerender]);

  return (
    <Box
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
      sx={{
        flex: 1,
        position: 'relative',
        minHeight: 0,
        overflow: 'hidden',
        cursor: 'crosshair',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
        }}
      />
    </Box>
  );
}));

SgcWaveformCanvas.displayName = 'SgcWaveformCanvas';
