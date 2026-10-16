import { SGC_BYTES_PER_CHANNEL, SGC_BYTES_PER_FRAME, SGC_CHANNELS_PER_FRAME } from "../src/lib/binaryFrame";

/** Number of channels the mock keys on in every capture. */
export const MOCK_SGC_ACTIVE_CHANNELS = 8;

export interface MockSgcCapture {
  frameCount: number;
  /** frameCount x 64 channels x 128 bytes, little-endian */
  data: Uint8Array;
  /** the channels that play in this capture, ascending */
  activeChannels: number[];
}

/**
 * A fabricated SGC capture: `frames` AICA samples of all 64 channels in the record layout of
 * protocol v3. Eight channels (chosen by `seed`) play a waveform through an envelope, the
 * others are silent. Offset 96 (`aeg_value`) is the level, 0 = silent and 0x3FF = loudest;
 * byte 109 is the flags byte; bytes 110..127 are zero.
 */
export const generateMockSgcCapture = (frames: number, seed: number): MockSgcCapture => {
  const buffer = new Uint8Array(frames * SGC_BYTES_PER_FRAME);
  const view = new DataView(buffer.buffer);
  const writeBits = (offset: number, value: number) => view.setUint32(offset, value >>> 0, true);
  const writeInt16 = (value: number, offset: number) => view.setInt16(offset, value, true);
  const writeUint16 = (value: number, offset: number) => view.setUint16(offset, value, true);
  const writeUint32 = (value: number, offset: number) => view.setUint32(offset, value >>> 0, true);
  const writeUint8 = (value: number, offset: number) => view.setUint8(offset, value);

  // Simple seeded random for deterministic data
  const seededRandom = (seedValue: number, min: number, max: number) => {
    const x = Math.sin(seedValue) * 10000;
    const normalized = x - Math.floor(x);
    return Math.floor(normalized * (max - min + 1)) + min;
  };

  // Select the active channels (deterministic based on seed)
  const activeChannels = new Set<number>();
  const channelSelectionSeed = 12345 + seed * 10000;
  let iteration = 0;
  while (activeChannels.size < MOCK_SGC_ACTIVE_CHANNELS) {
    const channelIdx = seededRandom(channelSelectionSeed + iteration, 0, SGC_CHANNELS_PER_FRAME - 1);
    activeChannels.add(channelIdx);
    iteration++;
  }

  for (let frame = 0; frame < frames; frame++) {
    const frameOffset = frame * SGC_BYTES_PER_FRAME;

    for (let channel = 0; channel < SGC_CHANNELS_PER_FRAME; channel++) {
      const channelOffset = frameOffset + (channel * SGC_BYTES_PER_CHANNEL);
      const seed = frame * 1000 + channel;
      const channelSeed = channel; // For values that should be constant per channel
      const isActive = activeChannels.has(channel);

      // ChannelCommonData struct (72 bytes of actual data, rest is padding)

      // +00 [0] - SA_hi, PCMS, LPCTL, SSCTL, KYONB, KYONEX
      const word0 =
        (seededRandom(seed + 0, 0, 0x7F) << 0) |      // SA_hi:7
        (seededRandom(channelSeed + 1, 0, 3) << 7) |  // PCMS:2 (constant per channel)
        (seededRandom(seed + 2, 0, 1) << 9) |         // LPCTL:1
        (seededRandom(seed + 3, 0, 1) << 10) |        // SSCTL:1
        (seededRandom(seed + 4, 0, 1) << 14) |        // KYONB:1
        (seededRandom(seed + 5, 0, 1) << 15);         // KYONEX:1
      writeBits(channelOffset + 0, word0);

      // +04 [1] - SA_low
      const word1 = seededRandom(seed + 6, 0, 0xFFFF);
      writeBits(channelOffset + 4, word1);

      // +08 [2] - LSA (Loop Start Address) - constant per channel
      const word2 = seededRandom(channelSeed + 7, 0, 0xFFFF);
      writeBits(channelOffset + 8, word2);

      // +0C [3] - LEA (Loop End Address) - constant per channel
      const word3 = seededRandom(channelSeed + 8, 0, 0xFFFF);
      writeBits(channelOffset + 12, word3);

      // +10 [4] - AR, D1R, D2R
      const word4 =
        (seededRandom(seed + 9, 0, 0x1F) << 0) |      // AR:5
        (seededRandom(seed + 10, 0, 0x1F) << 6) |     // D1R:5
        (seededRandom(seed + 11, 0, 0x1F) << 11);     // D2R:5
      writeBits(channelOffset + 16, word4);

      // +14 [5] - RR, DL, KRS, LPSLNK
      const word5 =
        (seededRandom(seed + 12, 0, 0x1F) << 0) |     // RR:5
        (seededRandom(seed + 13, 0, 0x1F) << 5) |     // DL:5
        (seededRandom(seed + 14, 0, 0xF) << 10) |     // KRS:4
        (seededRandom(seed + 15, 0, 1) << 14);        // LPSLNK:1
      writeBits(channelOffset + 20, word5);

      // +18 [6] - FNS, OCT - constant per channel
      const word6 =
        (seededRandom(channelSeed + 16, 0, 0x3FF) << 0) |    // FNS:10 (constant per channel)
        (seededRandom(channelSeed + 17, 0, 0xF) << 11);      // OCT:4 (constant per channel)
      writeBits(channelOffset + 24, word6);

      // +1C [7] - ALFOS, ALFOWS, PLFOS, PLFOWS, LFOF, LFORE
      const word7 =
        (seededRandom(seed + 18, 0, 7) << 0) |        // ALFOS:3
        (seededRandom(seed + 19, 0, 3) << 3) |        // ALFOWS:2
        (seededRandom(seed + 20, 0, 7) << 5) |        // PLFOS:3
        (seededRandom(seed + 21, 0, 3) << 8) |        // PLFOWS:2
        (seededRandom(seed + 22, 0, 0x1F) << 10) |    // LFOF:5
        (seededRandom(seed + 23, 0, 1) << 15);        // LFORE:1
      writeBits(channelOffset + 28, word7);

      // +20 [8] - ISEL, IMXL
      const word8 =
        (seededRandom(seed + 24, 0, 0xF) << 0) |      // ISEL:4
        (seededRandom(seed + 25, 0, 0xF) << 4);       // IMXL:4
      writeBits(channelOffset + 32, word8);

      // +24 [9] - DIPAN, DISDL
      const word9 =
        (seededRandom(seed + 26, 0, 0x1F) << 0) |     // DIPAN:5
        (seededRandom(seed + 27, 0, 0xF) << 8);       // DISDL:4
      writeBits(channelOffset + 36, word9);

      // +28 [10] - Q, TL
      const word10 =
        (seededRandom(seed + 28, 0, 0x1F) << 0) |     // Q:5
        (seededRandom(seed + 29, 0, 0xFF) << 8);      // TL:8
      writeBits(channelOffset + 40, word10);

      // +2C [11] - FLV0
      const word11 = seededRandom(seed + 30, 0, 0x1FFF);
      writeBits(channelOffset + 44, word11);

      // +30 [12] - FLV1
      const word12 = seededRandom(seed + 31, 0, 0x1FFF);
      writeBits(channelOffset + 48, word12);

      // +34 [13] - FLV2
      const word13 = seededRandom(seed + 32, 0, 0x1FFF);
      writeBits(channelOffset + 52, word13);

      // +38 [14] - FLV3
      const word14 = seededRandom(seed + 33, 0, 0x1FFF);
      writeBits(channelOffset + 56, word14);

      // +3C [15] - FLV4
      const word15 = seededRandom(seed + 34, 0, 0x1FFF);
      writeBits(channelOffset + 60, word15);

      // +40 [16] - FD1R, FAR
      const word16 =
        (seededRandom(seed + 35, 0, 0x1F) << 0) |     // FD1R:5
        (seededRandom(seed + 36, 0, 0x1F) << 8);      // FAR:5
      writeBits(channelOffset + 64, word16);

      // +44 [17] - FRR, FD2R
      const word17 =
        (seededRandom(seed + 37, 0, 0x1F) << 0) |     // FRR:5
        (seededRandom(seed + 38, 0, 0x1F) << 8);      // FD2R:5
      writeBits(channelOffset + 68, word17);

      // Sample data (72-89: 9 x int16)
      // Generate realistic audio sample values (-32768 to 32767)
      let sample_current = 0;
      let sample_previous = 0;
      let sample_filtered = 0;
      let aeg_value = 0;
      let feg_value = 0;
      /** position in the envelope's period, 0..1; the level is above zero in the first half */
      let aegEnvelopePhase = 0;

      if (isActive) {
        // Each channel gets a different waveform type based on channel number
        const waveformType = channel % 4; // 4 different waveform types
        const frequency = 0.05 + (channel * 0.01); // Different frequency per channel
        const amplitude = 12000 + seededRandom(channelSeed + 50, 0, 8000);
        const phaseOffset = channelSeed * 0.5;

        let waveValue = 0;
        switch (waveformType) {
          case 0: // Sine wave
            waveValue = Math.sin(frame * frequency + phaseOffset);
            break;
          case 1: // Square wave
            waveValue = Math.sin(frame * frequency + phaseOffset) > 0 ? 1 : -1;
            break;
          case 2: // Sawtooth wave
            waveValue = 2 * ((frame * frequency + phaseOffset) % 1) - 1;
            break;
          case 3: { // Triangle wave
            const sawValue = ((frame * frequency + phaseOffset) % 1);
            waveValue = sawValue < 0.5 ? sawValue * 4 - 1 : 3 - sawValue * 4;
            break;
          }
        }

        sample_current = Math.floor(waveValue * amplitude);
        sample_previous = Math.floor(Math.sin((frame - 1) * frequency + phaseOffset) * amplitude);
        sample_filtered = Math.floor((sample_current * 0.7 + sample_previous * 0.3));

        // Generate ADSR envelope for AEG (0 to 0x3FF)
        const aegPhase = (frame / frames) * Math.PI * 2 + channelSeed * 0.3;
        const aegEnvelope = Math.max(0, Math.sin(aegPhase)); // 0.0 to 1.0
        aeg_value = Math.floor(aegEnvelope * 0x3FF);
        aegEnvelopePhase = (aegPhase / (Math.PI * 2)) % 1;

        // Generate ADSR envelope for FEG (0 to 0x1FFF)
        const fegPhase = (frame / frames) * Math.PI * 4 + channel * 0.1;
        const fegEnvelope = Math.max(0, Math.cos(fegPhase)); // 0.0 to 1.0
        feg_value = Math.floor(fegEnvelope * 0x1FFF);
      }

      writeInt16(sample_current, channelOffset + 72);
      writeInt16(sample_previous, channelOffset + 74);
      writeInt16(sample_filtered, channelOffset + 76);

      // Sample after AEG (apply amplitude envelope)
      const aegEnvelopeNorm = aeg_value / 0x3FF; // Normalize back to 0.0-1.0
      const sample_post_aeg = Math.floor(sample_filtered * aegEnvelopeNorm);
      writeInt16(sample_post_aeg, channelOffset + 78);

      // Sample after FEG (apply filter envelope - affects brightness)
      const fegEnvelopeNorm = feg_value / 0x1FFF; // Normalize back to 0.0-1.0
      const filterAmount = fegEnvelopeNorm * 0.5 + 0.5; // 0.5 to 1.0
      const sample_post_feg = Math.floor(sample_post_aeg * filterAmount);
      writeInt16(sample_post_feg, channelOffset + 80);

      // Sample after TL (apply total level attenuation)
      const tlAttenuation = isActive ? (255 - seededRandom(seed + 29, 0, 255)) / 255 : 0;
      const sample_post_tl = Math.floor(sample_post_feg * tlAttenuation);
      writeInt16(sample_post_tl, channelOffset + 82);

      // Pan to left/right (simple equal-power pan)
      const panPosition = seededRandom(seed + 26, 0, 31) / 31; // 0.0 (left) to 1.0 (right)
      const panLeft = Math.cos(panPosition * Math.PI / 2);
      const panRight = Math.sin(panPosition * Math.PI / 2);
      const sample_left = Math.floor(sample_post_tl * panLeft);
      const sample_right = Math.floor(sample_post_tl * panRight);
      writeInt16(sample_left, channelOffset + 84);
      writeInt16(sample_right, channelOffset + 86);

      // DSP send (reduced level)
      const dspSendLevel = seededRandom(seed + 27, 0, 15) / 15; // 0.0 to 1.0
      const sample_dsp = Math.floor(sample_post_tl * dspSendLevel * 0.3);
      writeInt16(sample_dsp, channelOffset + 88);

      // Additional state (90-106)
      // CA fraction (10 bits in 16-bit word) - set to 0
      const ca_fraction = 0;
      writeUint16(ca_fraction, channelOffset + 90);

      // CA step (32-bit) - use unsigned bitwise OR
      const ca_step = (seededRandom(seed + 40, 0, 0xFFFF) | (seededRandom(seed + 41, 0, 0xFFFF) << 16)) >>> 0;
      writeUint32(ca_step, channelOffset + 92);

      // AEG value (32-bit) - computed above
      writeUint32(aeg_value, channelOffset + 96);

      // FEG value (32-bit) - computed above
      writeUint32(feg_value, channelOffset + 100);

      // LFO value (8-bit)
      const lfo_value = Math.floor((Math.sin(frame * 0.05) * 0.5 + 0.5) * 255);
      writeUint8(lfo_value, channelOffset + 104);

      // Amplitude LFO value (8-bit)
      const alfo_value = Math.floor((Math.sin(frame * 0.07 + channel) * 0.5 + 0.5) * 255);
      writeUint8(alfo_value, channelOffset + 105);

      // Pitch LFO value (8-bit)
      const plfo_value = Math.floor((Math.sin(frame * 0.03 + channel * 0.5) * 0.5 + 0.5) * 255);
      writeUint8(plfo_value, channelOffset + 106);

      // CA current (16-bit) - set to frame index to represent sample position
      const ca_current = frame & 0xFFFF;
      writeUint16(ca_current, channelOffset + 107);

      // Byte 109, flags: bit 0 channel enabled, bits 1-2 AEG state (0 attack, 1 decay 1,
      // 2 decay 2, 3 release). The envelope is one half sine: rising, top, falling, silent.
      const aegState = !isActive ? 3 : aegEnvelopePhase < 0.25 ? 0 : aegEnvelopePhase < 0.375 ? 1 : aegEnvelopePhase < 0.5 ? 2 : 3;
      buffer[channelOffset + 109] = (isActive ? 1 : 0) | (aegState << 1);

      // Bytes 110..127 stay zero
    }
  }

  return { frameCount: frames, data: buffer, activeChannels: Array.from(activeChannels).sort((a, b) => a - b) };
};
