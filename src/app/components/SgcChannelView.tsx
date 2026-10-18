import { Box } from "@mui/material";
import { useRef, memo, useImperativeHandle, forwardRef, useState } from "react";
import { SgcChannelData, clampFrameIndex, type SgcCapture } from "../../lib/sgcChannelData";
import { SgcWaveformRenderer, type SgcViewMode } from "./SgcWaveformRenderer";
import { SgcChannelHeader } from "./SgcChannelHeader";
import { SgcChannelSidebar } from "./SgcChannelSidebar";
import { SgcWaveformCanvas } from "./SgcWaveformCanvas";
import type { SgcWaveformCanvasHandle } from "./SgcWaveformCanvas";

export interface SgcChannelViewHandle {
  setPanZoom: (scrollOffsetX: number, zoomLevel: number) => void;
  setPositions: (hoverPosition: number | null, playbackPosition: number) => void;
}

interface SgcChannelViewProps {
  channelIndex: number;
  isFullscreen: boolean;
  onFullscreenToggle: (index: number) => void;
  onHoverPositionChange: (position: number | null) => void;
  onPlaybackPositionChange: (position: number) => void;
  /** a capture with at least one frame */
  capture: SgcCapture;
  renderer: SgcWaveformRenderer;
}

export const SgcChannelView = memo(forwardRef<SgcChannelViewHandle, SgcChannelViewProps>(({
  channelIndex,
  isFullscreen,
  onFullscreenToggle,
  onHoverPositionChange,
  onPlaybackPositionChange,
  capture,
  renderer,
}, ref) => {
  const canvasRef = useRef<SgcWaveformCanvasHandle>(null);
  const [viewMode, setViewMode] = useState<SgcViewMode>('pre-volpan');
  const [hoverPosition, setHoverPosition] = useState<number | null>(null);
  const [playbackPosition, setPlaybackPosition] = useState<number>(0);

  // Get channel data from the active sample (hover position if available, otherwise playback
  // position), a frame of this capture: a position kept from a longer capture is clamped to it
  const activeSampleIndex = clampFrameIndex(hoverPosition ?? playbackPosition, capture.frameCount);
  const channelData = new SgcChannelData(capture.data, channelIndex, activeSampleIndex);

  // Expose setPanZoom and setPositions methods to parent
  useImperativeHandle(ref, () => ({
    setPanZoom: (scrollOffsetX: number, zoomLevel: number) => {
      canvasRef.current?.setPanZoom(scrollOffsetX, zoomLevel);
    },
    setPositions: (hover: number | null, playback: number) => {
      setHoverPosition(hover);
      setPlaybackPosition(playback);
      canvasRef.current?.setPositions(hover, playback);
    }
  }), []);

  return (
    <Box
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        p: 0.5,
        display: 'flex',
        flexDirection: 'column',
        height: isFullscreen ? '100%' : 'auto',
      }}
    >
      {/* Top bar - Channel number and info */}
      <SgcChannelHeader channelIndex={channelIndex} channelData={channelData} />

      {/* Bottom section - Action buttons and waveform */}
      <Box sx={{
        display: 'flex',
        flexDirection: 'row',
        height: isFullscreen ? 'calc(100% - 32px)' : '8em',
        gap: 0.5
      }}>
        {/* Left - Action buttons */}
        <SgcChannelSidebar
          channelIndex={channelIndex}
          viewMode={viewMode}
          isFullscreen={isFullscreen}
          onViewModeChange={setViewMode}
          onFullscreenToggle={onFullscreenToggle}
        />

        {/* Right - Waveform canvas */}
        <SgcWaveformCanvas
          ref={canvasRef}
          channelIndex={channelIndex}
          viewMode={viewMode}
          capture={capture}
          renderer={renderer}
          onHoverPositionChange={(position) => {
            setHoverPosition(position);
            onHoverPositionChange(position);
          }}
          onPlaybackPositionChange={(position) => {
            setPlaybackPosition(position);
            onPlaybackPositionChange(position);
          }}
        />
      </Box>
    </Box>
  );
}));

SgcChannelView.displayName = 'SgcChannelView';
