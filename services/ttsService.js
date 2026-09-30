/**
 * Text -> 16-bit mono PCM at the call's sample rate.
 *
 * Engines (in order): ElevenLabs (streaming) -> Sarvam -> Microsoft Edge (free).
 *
 * Fixes vs old version:
 *  - ElevenLabs hamesha `pcm_8000` maangta tha, chahe call 16 kHz ho -> awaaz
 *    slow/mota. Ab call ka sample rate.
 *  - Poora audio banne ke baad hi bolna shuru hota tha. Ab ElevenLabs /stream se
 *    pehla chunk ~200-400 ms me caller tak.
 *  - Greeting/fillers har call pe dobara synthesize hote the. Ab cache.
 *  - google-tts-api (unofficial endpoint, axios@0.21 vulnerable) hataya.
 *  - Sarvam WAV header "44 bytes" maan ke kaat-ta tha; ab asli "data" chunk dhoondta hai.
 *  - Devanagari pe `\b` kaam nahi karta tha, isliye saare "breath comma" rules dead the.
 */
const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");
const { MPEGDecoder } = require("mpg123-decoder");

const EDGE_VOICE = process.env.TTS_VOICE || "hi-IN-SwaraNeural";
const EDGE_PROSODY = {
  rate: process.env.TTS_RATE || "-5%",
  pitch: process.env.TTS_PITCH || "-2Hz",
  volume: process.env.TTS_VOLUME || "+5%",
};

const NB = "(?<![\\u0900-\\u097F\\w])"; // Devanagari-aware "word start"
const NA = "(?![\\u0900-\\u097F\\w])"; // Devanagari-aware "word end"

const TIME_WORDS = {
  "1:30": "डेढ़ बजे", "2:30": "ढाई बजे", "5:30": "साढ़े पाँच बजे", "10:00": "दस बजे",
  "2:00": "दो बजे", "12:00": "बारह बजे",
};
const HOURS = ["बारह", "एक", "दो", "तीन", "चार", "पाँच", "छह", "सात", "आठ", "नौ", "दस", "ग्यारह", "बारह"];

function sanitizeSpeechText(text) {
  if (!text) return "";
  let s = String(text)
    .replace(/<<[A-Z_]+>>[\s\S]*?(<<END_[A-Z_]+>>|$)/g, " ")
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, " ")
    .replace(/[*_#~`\\|<>\[\]{}()"“”]/g, " ")
    .replace(/^\s*[-•]\s*/gm, "")
    // Dash between words = pause; dash inside numbers (phone) untouched
    .replace(/(\D)\s*[–—-]\s*(\D)/g, "$1, $2");

  // Times: "5:30 PM" / "10:00 बजे" -> spoken Hindi
  s = s.replace(/(\d{1,2}):(\d{2})\s*(?:AM|PM|am|pm)?(\s*बजे)?/g, (m, h, mm) => {
    const key = `${Number(h)}:${mm}`;
    if (TIME_WORDS[key]) return TIME_WORDS[key];
    const hw = HOURS[Number(h) % 12] || h;
    const mi = Number(mm);
    if (mi === 0) return `${hw} बजे`;
    if (mi === 30) return `साढ़े ${hw} बजे`;
    if (mi === 15) return `सवा ${hw} बजे`;
    return `${hw} बजकर ${mi} मिनट`;
  });
  s = s.replace(/बजे\s+बजे/g, "बजे").replace(/₹\s*500|500\s*रुपये|rs\.?\s*500/gi, "पाँच सौ रुपये");

  // Natural micro-pauses after discourse markers
  s = s.replace(new RegExp(`${NB}(नमस्ते|अच्छा|ठीक है|जी हाँ|जी बिल्कुल|धन्यवाद|हम्म)${NA}(?!\\s*[,.?!।])`, "g"), "$1,");

  return s
    .replace(/\s+/g, " ")
    .replace(/\s*([,?!।.])(\s*[,?!।.])+/g, "$1")
    .replace(/\s*([,?!।.])\s*/g, "$1 ")
    .trim();
}

// ---------------------------------------------------------------- resampling
function lowpass(samples, rate, cutoff) {
  const w0 = (2 * Math.PI * cutoff) / rate;
  const cos = Math.cos(w0), alpha = Math.sin(w0) / (2 * 0.7071);
  const a0 = 1 + alpha;
  const b0 = (1 - cos) / 2 / a0, b1 = (1 - cos) / a0, b2 = b0, a1 = (-2 * cos) / a0, a2 = (1 - alpha) / a0;
  const out = new Float32Array(samples.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y; out[i] = y;
  }
  return out;
}

/** Float32 [-1,1] at srcRate -> Int16 PCM Buffer at dstRate */
function floatToPcm(samples, srcRate, dstRate) {
  let src = samples;
  if (srcRate > dstRate) src = lowpass(lowpass(src, srcRate, dstRate * 0.45), srcRate, dstRate * 0.45);
  const ratio = srcRate / dstRate;
  const n = Math.floor(src.length / ratio);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio, i0 = Math.floor(pos), i1 = Math.min(i0 + 1, src.length - 1), f = pos - i0;
    const v = Math.max(-0.97, Math.min(0.97, src[i0] * (1 - f) + src[i1] * f));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return Buffer.from(out.buffer);
}

function int16BufToFloat(buf) {
  const i16 = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
  const f = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32768;
  return f;
}

async function mp3ToPcm(mp3, dstRate) {
  const decoder = new MPEGDecoder();
  await decoder.ready;
  try {
    const { channelData, sampleRate } = decoder.decode(new Uint8Array(mp3));
    return floatToPcm(channelData[0], sampleRate, dstRate);
  } finally {
    decoder.free();
  }
}

/** Parse a WAV buffer properly (find fmt + data chunks). */
function wavToPcm(wav, dstRate) {
  if (wav.toString("ascii", 0, 4) !== "RIFF") return wav;
  let off = 12, rate = dstRate, dataStart = -1, dataLen = 0;
  while (off + 8 <= wav.length) {
    const id = wav.toString("ascii", off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === "fmt ") rate = wav.readUInt32LE(off + 12);
    if (id === "data") { dataStart = off + 8; dataLen = Math.min(size, wav.length - dataStart); break; }
    off += 8 + size + (size % 2);
  }
  if (dataStart < 0) return Buffer.alloc(0);
  const pcm = wav.subarray(dataStart, dataStart + dataLen);
  return rate === dstRate ? Buffer.from(pcm) : floatToPcm(int16BufToFloat(pcm), rate, dstRate);
}

// ---------------------------------------------------------------- engines
const ELEVEN_RATES = [8000, 16000, 22050, 24000];

/** Streams PCM chunks to onChunk as they arrive. Returns total bytes, or 0 on failure. */
async function synthElevenLabsStream(text, rate, { signal, onChunk }) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return 0;
  const voiceId = process.env.ELEVENLABS_VOICE_ID || "EXAVITQu4vr4xnSDxMaL";
  const reqRate = ELEVEN_RATES.includes(rate) ? rate : 16000;
  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream` +
    `?output_format=pcm_${reqRate}&optimize_streaming_latency=${process.env.ELEVENLABS_LATENCY || 3}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: process.env.ELEVENLABS_MODEL || "eleven_flash_v2_5",
      language_code: "hi",
      voice_settings: {
        stability: Number(process.env.ELEVENLABS_STABILITY || 0.45),
        similarity_boost: 0.8,
        style: 0.2,
        use_speaker_boost: true,
      },
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
  });
  if (!res.ok || !res.body) {
    console.warn(`[tts] ElevenLabs ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
    return 0;
  }

  let total = 0;
  let carry = Buffer.alloc(0);
  for await (const part of res.body) {
    let buf = Buffer.concat([carry, Buffer.from(part)]);
    const even = buf.length - (buf.length % 2);
    carry = buf.subarray(even);
    buf = buf.subarray(0, even);
    if (!buf.length) continue;
    const out = reqRate === rate ? buf : floatToPcm(int16BufToFloat(buf), reqRate, rate);
    total += out.length;
    await onChunk(out);
    if (signal?.aborted) break;
  }
  return total;
}

async function synthSarvam(text, rate, signal) {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) return null;
  const res = await fetch("https://api.sarvam.ai/text-to-speech", {
    method: "POST",
    headers: { "api-subscription-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      inputs: [text],
      target_language_code: "hi-IN",
      speaker: process.env.SARVAM_SPEAKER || "anushka",
      model: process.env.SARVAM_MODEL || "bulbul:v2",
      pace: 1.0,
      speech_sample_rate: rate,
      enable_preprocessing: true,
    }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(6000)]) : AbortSignal.timeout(6000),
  });
  if (!res.ok) {
    console.warn(`[tts] Sarvam ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
    return null;
  }
  const data = await res.json();
  const b64 = data.audios?.[0];
  return b64 ? wavToPcm(Buffer.from(b64, "base64"), rate) : null;
}

let edgeInstance = null;
async function edgeClient(fresh = false) {
  if (edgeInstance && !fresh) return edgeInstance;
  const tts = new MsEdgeTTS();
  await tts.setMetadata(EDGE_VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  edgeInstance = tts;
  return tts;
}

async function synthEdge(text, rate) {
  for (const fresh of [false, true]) {
    try {
      const tts = await edgeClient(fresh);
      const { audioStream } = tts.toStream(text, EDGE_PROSODY);
      const chunks = [];
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("edge timeout")), 8000);
        audioStream.on("data", (c) => chunks.push(c));
        audioStream.once("end", () => { clearTimeout(t); resolve(); });
        audioStream.once("close", () => { clearTimeout(t); resolve(); });
        audioStream.once("error", (e) => { clearTimeout(t); reject(e); });
      });
      audioStream.destroy();
      const mp3 = Buffer.concat(chunks);
      if (mp3.length) return await mp3ToPcm(mp3, rate);
    } catch (err) {
      console.warn(`[tts] Edge ${fresh ? "retry " : ""}failed:`, err.message);
      edgeInstance = null;
    }
  }
  return null;
}

// ---------------------------------------------------------------- public API
const cache = new Map(); // `${rate}|${text}` -> Buffer
const CACHE_MAX = 200;

/**
 * Synthesize and deliver PCM via onChunk (streamed when possible).
 * @returns {Promise<number>} bytes delivered (0 = all engines failed)
 */
async function speakToPcm(text, rate, { signal, onChunk, cacheable = false } = {}) {
  const clean = sanitizeSpeechText(text);
  if (!clean) return 0;
  const key = `${rate}|${clean}`;
  if (cache.has(key)) {
    const buf = cache.get(key);
    await onChunk(buf);
    return buf.length;
  }

  const collected = [];
  const tap = async (b) => {
    if (cacheable) collected.push(b);
    await onChunk(b);
  };

  let bytes = 0;
  if (process.env.ELEVENLABS_API_KEY) {
    try {
      bytes = await synthElevenLabsStream(clean, rate, { signal, onChunk: tap });
    } catch (err) {
      if (signal?.aborted) return 0;
      console.warn("[tts] ElevenLabs error:", err.message);
    }
  }
  if (!bytes && process.env.SARVAM_API_KEY) {
    try {
      const pcm = await synthSarvam(clean, rate, signal);
      if (pcm?.length) { await tap(pcm); bytes = pcm.length; }
    } catch (err) {
      if (signal?.aborted) return 0;
      console.warn("[tts] Sarvam error:", err.message);
    }
  }
  if (!bytes && !signal?.aborted) {
    const pcm = await synthEdge(clean, rate);
    if (pcm?.length) { await tap(pcm); bytes = pcm.length; }
  }

  if (cacheable && bytes && !signal?.aborted) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, Buffer.concat(collected));
  }
  return bytes;
}

/** Non-streaming helper (tests / scripts). */
async function textToPcm(text, rate = 8000) {
  const parts = [];
  await speakToPcm(text, rate, { onChunk: async (b) => parts.push(b) });
  return Buffer.concat(parts);
}

/** Pre-render fixed phrases (greeting, fillers) so they play instantly. */
async function preWarmTTS(phrases = [], rates = [8000]) {
  let ok = 0;
  for (const rate of rates) {
    for (const p of phrases) {
      const n = await speakToPcm(p, rate, { onChunk: async () => {}, cacheable: true }).catch(() => 0);
      if (n) ok++;
    }
  }
  console.log(`[tts] Pre-warmed ${ok}/${phrases.length * rates.length} phrases`);
}

module.exports = { speakToPcm, textToPcm, preWarmTTS, sanitizeSpeechText, wavToPcm, floatToPcm };
