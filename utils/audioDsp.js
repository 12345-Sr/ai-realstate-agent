/**
 * Telephony Audio DSP & Noise Cancellation Engine
 * 
 * Features:
 * 1. 4th-Order Cascaded Biquad Bandpass Filter (300Hz HPF + 3400Hz LPF):
 *    - Eliminates low-frequency vehicle rumble, AC hum (50/60Hz), microphone pop, wind, and DC offset.
 *    - Cuts high-frequency telephony line hiss, quantization noise, and carrier static (>3400Hz).
 * 2. Adaptive Spectral Noise Gate / Downward Expander:
 *    - Dynamically measures ambient noise floor across 20ms frames.
 *    - Suppresses background noise during inter-word pauses by 20-25dB with smooth attack/release envelopes.
 * 3. Voice Activity Detection (VAD) & SNR Verification:
 *    - Verifies whether accumulated audio contains genuine human voice or just background noise/clicks.
 * 4. Automatic Gain Control (AGC) / Speech Normalization:
 *    - Brings soft patient speech to clear, intelligible levels for Whisper STT.
 */

/**
 * Creates a digital Biquad IIR filter (Direct Form II Transposed).
 */
function createBiquad(type, freq, sampleRate = 8000, Q = 0.7071) {
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cosw0 = Math.cos(w0);
  const sinw0 = Math.sin(w0);
  const alpha = sinw0 / (2 * Q);

  let b0, b1, b2, a0, a1, a2;
  if (type === "highpass") {
    b0 = (1 + cosw0) / 2;
    b1 = -(1 + cosw0);
    b2 = (1 + cosw0) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cosw0;
    a2 = 1 - alpha;
  } else if (type === "lowpass") {
    b0 = (1 - cosw0) / 2;
    b1 = 1 - cosw0;
    b2 = (1 - cosw0) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cosw0;
    a2 = 1 - alpha;
  } else {
    throw new Error(`Unsupported filter type: ${type}`);
  }

  const b0_norm = b0 / a0;
  const b1_norm = b1 / a0;
  const b2_norm = b2 / a0;
  const a1_norm = a1 / a0;
  const a2_norm = a2 / a0;

  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;

  return {
    process(x) {
      const y = b0_norm * x + b1_norm * x1 + b2_norm * x2 - a1_norm * y1 - a2_norm * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      return y;
    },
    reset() {
      x1 = 0; x2 = 0; y1 = 0; y2 = 0;
    }
  };
}

/**
 * Calculates RMS energy of a 16-bit PCM chunk or buffer.
 */
function calculatePcmRms(buffer) {
  if (!buffer || buffer.length < 2) return 0;
  const int16 = new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.length / 2));
  let sum = 0;
  for (let i = 0; i < int16.length; i++) {
    sum += int16[i] * int16[i];
  }
  return Math.sqrt(sum / (int16.length || 1));
}

/**
 * Filters raw 16-bit PCM audio through a cascaded 300Hz-3400Hz telephony bandpass filter.
 */
function applyTelephonyBandpass(int16Array, sampleRate = 8000) {
  const hp1 = createBiquad("highpass", 300, sampleRate);
  const hp2 = createBiquad("highpass", 300, sampleRate);
  const lp1 = createBiquad("lowpass", Math.min(3400, sampleRate * 0.45), sampleRate);
  const lp2 = createBiquad("lowpass", Math.min(3400, sampleRate * 0.45), sampleRate);

  const out = new Int16Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    let s = int16Array[i];
    s = hp1.process(s);
    s = hp2.process(s);
    s = lp1.process(s);
    s = lp2.process(s);

    if (s > 32767) s = 32767;
    else if (s < -32768) s = -32768;
    out[i] = Math.round(s);
  }
  return out;
}

/**
 * Suppresses background noise during inter-word pauses using an adaptive downward expander.
 * Keeps patient's speech intact while dropping background noise by 20-25dB.
 */
function applyAdaptiveNoiseGate(int16Array, sampleRate = 8000) {
  const frameSize = Math.floor(sampleRate * 0.02); // 20ms frame
  const numFrames = Math.floor(int16Array.length / frameSize);
  if (numFrames < 2) return int16Array;

  // 1. Calculate energy of each 20ms frame
  const frameEnergies = new Float32Array(numFrames);
  for (let f = 0; f < numFrames; f++) {
    let sum = 0;
    const start = f * frameSize;
    for (let i = 0; i < frameSize; i++) {
      const s = int16Array[start + i];
      sum += s * s;
    }
    frameEnergies[f] = Math.sqrt(sum / frameSize);
  }

  // 2. Estimate ambient noise floor from lower 25th percentile of frame energies
  const sorted = Array.from(frameEnergies).sort((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(sorted.length * 0.25)] || 120;
  // Threshold above which audio is considered active voice
  const speechThreshold = Math.max(350, noiseFloor * 1.8);

  const out = new Int16Array(int16Array.length);
  let currentGain = 1.0;
  const floorGain = 0.08; // -22 dB reduction for background noise

  // Smooth attack (~5ms) and release (~35ms)
  const attackCoeff = 0.08;
  const releaseCoeff = 0.015;

  for (let f = 0; f < numFrames; f++) {
    const isVoice = frameEnergies[f] > speechThreshold;
    const targetGain = isVoice ? 1.0 : floorGain;
    const start = f * frameSize;

    for (let i = 0; i < frameSize; i++) {
      const coeff = targetGain > currentGain ? attackCoeff : releaseCoeff;
      currentGain += (targetGain - currentGain) * coeff;

      let val = int16Array[start + i] * currentGain;
      if (val > 32767) val = 32767;
      else if (val < -32768) val = -32768;
      out[start + i] = Math.round(val);
    }
  }

  // Copy any remaining samples
  const processedSamples = numFrames * frameSize;
  for (let i = processedSamples; i < int16Array.length; i++) {
    out[i] = Math.round(int16Array[i] * currentGain);
  }

  return out;
}

/**
 * Normalizes speech gain so quiet voices are brought to nominal level for Whisper.
 */
function normalizeSpeechGain(int16Array) {
  let peak = 0;
  for (let i = 0; i < int16Array.length; i++) {
    const abs = Math.abs(int16Array[i]);
    if (abs > peak) peak = abs;
  }

  // Target peak level ~24000 (leaves ~3dB headroom below 32767)
  const targetPeak = 24000;
  if (peak > 1500 && peak < 16000) {
    const multiplier = Math.min(3.5, targetPeak / peak);
    const out = new Int16Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) {
      let val = int16Array[i] * multiplier;
      if (val > 32767) val = 32767;
      else if (val < -32768) val = -32768;
      out[i] = Math.round(val);
    }
    return out;
  }
  return int16Array;
}

/**
 * Full DSP pipeline: Bandpass Filter -> Adaptive Noise Gate -> Normalization.
 */
function cleanAndIsolateVoice(pcmBuffer, sampleRate = 8000) {
  if (!pcmBuffer || pcmBuffer.length < 2) return pcmBuffer;

  const int16 = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, Math.floor(pcmBuffer.length / 2));
  
  // 1. Cut non-voice frequencies (below 300Hz, above 3400Hz)
  const bandpassed = applyTelephonyBandpass(int16, sampleRate);

  // 2. Suppress background noise in pauses
  const gated = applyAdaptiveNoiseGate(bandpassed, sampleRate);

  // 3. Normalize voice level
  const normalized = normalizeSpeechGain(gated);

  return Buffer.from(normalized.buffer, normalized.byteOffset, normalized.byteLength);
}

/**
 * Verifies if the audio contains genuine patient speech vs pure background noise.
 * Returns { isGenuineSpeech, voicedMs, speechRatio, peakRms }
 */
function analyzeVoiceActivity(pcmBuffer, sampleRate = 8000) {
  if (!pcmBuffer || pcmBuffer.length < 2) {
    return { isGenuineSpeech: false, voicedMs: 0, speechRatio: 0, peakRms: 0 };
  }

  const int16 = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, Math.floor(pcmBuffer.length / 2));
  const frameSize = Math.floor(sampleRate * 0.02); // 20ms
  const numFrames = Math.floor(int16.length / frameSize);

  if (numFrames < 3) {
    return { isGenuineSpeech: false, voicedMs: 0, speechRatio: 0, peakRms: 0 };
  }

  const frameRms = new Float32Array(numFrames);
  let maxRms = 0;
  for (let f = 0; f < numFrames; f++) {
    let sum = 0;
    const start = f * frameSize;
    for (let i = 0; i < frameSize; i++) {
      const s = int16[start + i];
      sum += s * s;
    }
    const rms = Math.sqrt(sum / frameSize);
    frameRms[f] = rms;
    if (rms > maxRms) maxRms = rms;
  }

  // Noise floor estimate (20th percentile)
  const sorted = Array.from(frameRms).sort((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(sorted.length * 0.20)] || 100;
  const voiceThreshold = Math.max(450, noiseFloor * 1.8);

  let voicedFrames = 0;
  for (let f = 0; f < numFrames; f++) {
    if (frameRms[f] > voiceThreshold) {
      voicedFrames++;
    }
  }

  const voicedMs = voicedFrames * 20;
  const speechRatio = voicedFrames / numFrames;

  // Genuine human speech turn requirements:
  // 1. Must contain at least 220ms (11 frames) of voiced audio
  // 2. Voiced ratio must be at least 15% of the total recording
  // 3. Peak RMS must be distinctly higher than the ambient noise floor
  const isGenuineSpeech =
    voicedMs >= 220 && speechRatio >= 0.14 && maxRms > noiseFloor * 1.6;

  return {
    isGenuineSpeech,
    voicedMs,
    speechRatio: Number(speechRatio.toFixed(2)),
    peakRms: Math.round(maxRms),
    noiseFloor: Math.round(noiseFloor),
  };
}

module.exports = {
  createBiquad,
  calculatePcmRms,
  applyTelephonyBandpass,
  applyAdaptiveNoiseGate,
  normalizeSpeechGain,
  cleanAndIsolateVoice,
  analyzeVoiceActivity,
};
