/**
 * Converts a raw 16-bit PCM Buffer into a standard WAV Buffer with 44-byte header.
 */
function pcmToWav(pcmBuffer, sampleRate = 8000, channels = 1, bitDepth = 16) {
  const byteRate = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const wavHeader = Buffer.alloc(44);

  wavHeader.write("RIFF", 0);
  wavHeader.writeUInt32LE(36 + pcmBuffer.length, 4);
  wavHeader.write("WAVE", 8);
  wavHeader.write("fmt ", 12);
  wavHeader.writeUInt32LE(16, 16); // SubChunk1Size (16 for PCM)
  wavHeader.writeUInt16LE(1, 20);  // AudioFormat (1 for PCM)
  wavHeader.writeUInt16LE(channels, 22);
  wavHeader.writeUInt32LE(sampleRate, 24);
  wavHeader.writeUInt32LE(byteRate, 28);
  wavHeader.writeUInt16LE(blockAlign, 32);
  wavHeader.writeUInt16LE(bitDepth, 34);
  wavHeader.write("data", 36);
  wavHeader.writeUInt32LE(pcmBuffer.length, 40);

  return Buffer.concat([wavHeader, pcmBuffer]);
}

/**
 * Cleans up common telephony phonetic mishearings in Hindi.
 */
function cleanTelephonyHindi(t) {
  if (!t) return "";
  let s = t;

  // NOTE: Pehle yahan developer ke test-call wale naam hardcoded the
  // ("आयोग" -> "आयुष", "सक्ला" -> "शुक्ला", "स्रतांशु"...). Woh asli patients ke
  // shabd bigaadte the (e.g. "आयोग" ek real shabd hai). Hata diye.
  // Naam ki galti ko ab bot "naam padh ke confirm" karke pakadta hai.

  // 2. Standardized 3-Shift Time Slot corrections
  s = s.replace(/वजे/gi, "बजे");
  s = s.replace(/(?:तमाई|समई)/gi, "समय");
  // 5:30 PM (Evening)
  s = s.replace(/(?:पारे\s*पाबजे[म]?|पाबजे[म]?|साढ़े\s*पाँच|साढ़े\s*पांच|साडे\s*पाच|पाँच\s*तीस|पांच\s*तीस|5:30|5\s*30)\s*(?:मजे|बजे|मजी|बजी)?/gi, "शाम 5:30 बजे");
  // 2:00 PM (Noon)
  s = s.replace(/(?:दोले\s*ये\s*काफ़ी|दोले\s*ये\s*काफी|दोले\s*ये|दोले)/gi, "दोपहर 2:00 बजे");
  s = s.replace(/(?:दो|2)\s*(?:मजे|बजे|मजी|बजी)/gi, "दोपहर 2:00 बजे");
  // 10:00 AM (Morning)
  s = s.replace(/(?:दस|10)\s*(?:मजे|बजे|मजी|बजी)/gi, "सुबह 10:00 बजे");
  s = s.replace(/(?:चार|शार|सार|4)\s*(?:मजे|बजे|मजी|बजी)/gi, "4:00 बजे");
  s = s.replace(/(?:साढ़े\s*तीन|3:30)\s*(?:मजे|बजे|मजी|बजी)?/gi, "3:30 बजे");
  s = s.replace(/(?:पीन|तीन|3)\s*(?:मजे|बजे|मजी|बजी)/gi, "3:00 बजे");
  s = s.replace(/(?:ढाई|दो\s*तीस|2:30)\s*(?:मजे|बजे|मजी|बजी)?/gi, "2:30 बजे");

  // 3. Real Estate Telephony phrasing corrections
  s = s.replace(/(?:साइट\s*विजिट|साइड\s*विजिट|साइड\s*विज़िट|साइटविज़िट)/gi, "साइट विज़िट");
  s = s.replace(/अपाइनल\s*डू|अपाइनल\s*बुक|उपाइडमेंट|उपाइनल/gi, "साइट विज़िट");
  s = s.replace(/दिलचकता|दिलचक्ता|मिलचकता/gi, "मिल सकता");
  s = s.replace(/(?:मरग\s*यार\s*को|मरगवार|मरग\s*वार)/gi, "मंगलवार");
  s = s.replace(/(?:बुदवार|बुध\s*वार)/gi, "बुधवार");
  s = s.replace(/नेरा\s*नमाई|मेरा\s*नमाई|मेरा\s*नाँव/gi, "मेरा नाम");
  s = s.replace(/पिक्स\s*कराते|पिक्स\s*कर/gi, "फिक्स कराना");
  s = s.replace(/(?:नहीं\s*(?:है\s*)?तो\s*यही\s*नाम|यही\s*नाम\s*है|यही\s*नाम\s*तो\s*है)/gi, "हाँ यही नाम है");

  // 4. Request to repeat / pardon
  s = s.replace(/(?:प्रदिखो|प्रतिखो|फिर\s*खो)\s*(?:बोलियेगा|बोलिए|बताइए)/gi, "फिर से बोलिए");

  return s;
}

const { cleanAndIsolateVoice } = require("../utils/audioDsp");

/**
 * Transcribes audio using Google Gemini Multimodal Audio API.
 * Uses the user's GEMINI_API_KEY without needing Groq or Whisper.
 */
async function transcribeWithGemini(wavBuffer, { signal } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return "";

  const base64Audio = wavBuffer.toString("base64");
  const models = [
    process.env.GEMINI_STT_MODEL || process.env.GEMINI_MODEL,
    "gemini-3-flash-preview",
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite",
  ].filter(Boolean);

  for (const model of models) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: "You are an accurate Hindi-English telephony transcriber. Transcribe what the caller said verbatim in Hindi (Devanagari) or English. If the caller was silent, breathed, or there is only line background noise/tone, respond with NOTHING (an empty string). Output ONLY the transcript, no greetings or explanations.",
                },
                { inlineData: { mimeType: "audio/wav", data: base64Audio } },
              ],
            },
          ],
          generationConfig: { maxOutputTokens: 120, temperature: 0.1 },
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        console.warn(`[sttService] Gemini STT (${model}) ${res.status}: ${(await res.text()).slice(0, 120)}`);
        continue;
      }

      const data = await res.json();
      const text = (data.candidates?.[0]?.content?.parts || [])
        .filter((p) => !p.thought)
        .map((p) => p.text || "")
        .join("")
        .trim();

      if (text) {
        // Discard typical silence hallucinations from multimodal LLMs
        if (/^(hello\?|hello\s*hello|can you hear me\?|none|empty|\.)$/i.test(text)) {
          return "";
        }
        return cleanTelephonyHindi(text);
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn(`[sttService] Gemini STT (${model}) error:`, err.message);
    }
  }
  return "";
}

/**
 * Transcribes audio using Deepgram Nova-2 (if DEEPGRAM_API_KEY is configured).
 */
async function transcribeWithDeepgram(wavBuffer, { signal } = {}) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) return "";

  try {
    const res = await fetch(
      "https://api.deepgram.com/v1/listen?model=nova-2-general&language=hi&smart_format=true&punctuate=true",
      {
        method: "POST",
        headers: {
          Authorization: `Token ${apiKey}`,
          "Content-Type": "audio/wav",
        },
        body: wavBuffer,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(4000)]) : AbortSignal.timeout(4000),
      }
    );

    if (!res.ok) return "";
    const data = await res.json();
    const text = data.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || "";
    return text ? cleanTelephonyHindi(text) : "";
  } catch (err) {
    console.warn("[sttService] Deepgram error:", err.message);
    return "";
  }
}

/**
 * Transcribes audio using Groq Whisper with bulletproof hallucination gating.
 */
async function transcribeWithWhisper(wavBuffer, { signal } = {}) {
  const apiKey = (process.env.GROQ_API_KEY || "").replace(/^GROQ_API_KEY=/, "").trim();
  if (!apiKey) return "";

  const blob = new Blob([wavBuffer], { type: "audio/wav" });
  const formData = new FormData();
  formData.append("file", blob, "audio.wav");
  formData.append("model", process.env.STT_MODEL || "whisper-large-v3-turbo");
  if (process.env.STT_LANGUAGE) {
    formData.append("language", process.env.STT_LANGUAGE);
  }
  formData.append("temperature", "0");
  formData.append(
    "prompt",
    "नमस्ते, मैं मोनिका हूँ, Deific Digital से आपकी प्रॉपर्टी असिस्टेंट। प्रॉपर्टी, फ्लैट, 2 BHK, 3 BHK, विला, प्लॉट, साइट विज़िट, बजट।"
  );

  try {
    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(4000)]) : AbortSignal.timeout(4000),
    });

    if (!res.ok) {
      console.warn(`[sttService] Whisper error ${res.status}`);
      return "";
    }

    const data = await res.json();
    let text = (data.text || "").trim();

    // Filter foreign script hallucinations (Tamil, Telugu, Malayalam, Arabic, etc.)
    if (/[\u0B80-\u0BFF\u0C00-\u0C7F\u0D00-\u0D7F\u0A80-\u0AFF\u0600-\u06FF]/i.test(text)) {
      return "";
    }

    // Filter non-Indian/hallucinated noise words
    if (/adi[oó]s|manejar|obrigad[oa]|por\s*favor|subtitles/i.test(text)) {
      return "";
    }

    // Guard against Whisper repeating prompt hallucinations
    if (
      /मोनिका.*प्रॉपर्टी असिस्टेंट/i.test(text) ||
      /सिटी\s*ग्रीन्स.*रॉयल\s*पाम/i.test(text) ||
      /ग्राहक\s*का\s*नाम/i.test(text) ||
      text.includes("अपॉइंटमेंटमेंट")
    ) {
      return "";
    }

    // Robust noise & silence hallucination check: strip all surrounding punctuation & spaces
    const cleanCheck = text.replace(/[^\p{L}\p{N}]+/gu, " ").toLowerCase().trim();
    const noiseWords = new Set([
      "thank you",
      "thank you so much",
      "thanks",
      "you",
      "bye",
      "goodbye",
      "subtitles",
      "watching",
      "subscribe",
      "like and share",
      "amara",
      "झाल",
      "हूँ",
    ]);

    if (!cleanCheck || cleanCheck.length < 2 || noiseWords.has(cleanCheck)) {
      return "";
    }

    return cleanTelephonyHindi(text);
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn("[sttService] Whisper error:", err.message);
    return "";
  }
}

/**
 * Main STT Entry Point.
 * Selects engine based on STT_ENGINE env ('gemini' | 'whisper' | 'deepgram').
 * Automatically falls back to secondary engine if primary returns empty/fails.
 */
async function transcribePcmAudio(pcmBuffer, sampleRate = 8000, { signal } = {}) {
  // Discard audio shorter than 0.35 seconds (line noise, clicks, breaths)
  const minBytes = Math.floor(sampleRate * 2 * 0.35);
  if (!pcmBuffer || pcmBuffer.length < minBytes) {
    return "";
  }

  // Deep DSP telephony voice isolation
  const filteredPcm = cleanAndIsolateVoice(pcmBuffer, sampleRate);
  const wavBuffer = pcmToWav(filteredPcm, sampleRate);

  const engine = (process.env.STT_ENGINE || "whisper").toLowerCase();

  if (engine === "whisper" || process.env.GROQ_API_KEY) {
    const whisperText = await transcribeWithWhisper(wavBuffer, { signal });
    if (whisperText) return whisperText;
    // Fallback to Gemini if Whisper failed or was rate limited
    return await transcribeWithGemini(wavBuffer, { signal });
  }

  if (engine === "deepgram" && process.env.DEEPGRAM_API_KEY) {
    const deepgramText = await transcribeWithDeepgram(wavBuffer, { signal });
    if (deepgramText) return deepgramText;
  }

  // Gemini primary (if explicitly requested with no Groq key)
  const geminiText = await transcribeWithGemini(wavBuffer, { signal });
  if (geminiText) return geminiText;

  return await transcribeWithWhisper(wavBuffer, { signal });
}

module.exports = {
  pcmToWav,
  transcribePcmAudio,
  transcribeWithGemini,
  transcribeWithWhisper,
  transcribeWithDeepgram,
  cleanTelephonyHindi,
};
