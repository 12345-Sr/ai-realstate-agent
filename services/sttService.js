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

  // 3. Telephony phrasing corrections
  s = s.replace(/होस्पिनल|हस्पताल|होस्पाइडल/gi, "हॉस्पिटल");
  s = s.replace(/अपार्टमेंट|अपार्टमेन्ट|अपाइनल\s*डू|अपाइनल\s*बुक|उपाइडमेंट|उपाइनल/gi, "अपॉइंटमेंट");
  s = s.replace(/दिलचकता|दिलचक्ता|मिलचकता/gi, "मिल सकता");
  s = s.replace(/(?:^|\s+)ते\s*अपॉइंटमेंट/gi, " का अपॉइंटमेंट");
  s = s.replace(/(?:मरग\s*यार\s*को|मरगवार|मरग\s*वार)/gi, "मंगलवार");
  s = s.replace(/(?:बुदवार|बुध\s*वार)/gi, "बुधवार");
  s = s.replace(/(?:मारीफ|मरीज|मरीफ|मरीस|मरीज़)\s*का\s*नाम/gi, "मरीज़ का नाम");
  s = s.replace(/नेरा\s*नमाई|मेरा\s*नमाई|मेरा\s*नाँव/gi, "मेरा नाम");
  s = s.replace(/पिक्स\s*कराते|पिक्स\s*कर/gi, "फिक्स कराना");
  s = s.replace(/(?:नहीं\s*(?:है\s*)?तो\s*यही\s*नाम|यही\s*नाम\s*है|यही\s*नाम\s*तो\s*है)/gi, "हाँ यही नाम है");

  // 4. Common telephony illness and symptom phonetic mishearings
  s = s.replace(/(?:^|\s+)(?:देख|देश|तेस|देस)\s*(?:बुकार|बुखार|बुखारह)/gi, " तेज बुखार");
  s = s.replace(/(?:^|\s+)(?:देख|देश|तेस|देस)\s*(?:जुवा|जुकाम|जुखाम|जुवाम)/gi, " तेज जुकाम");
  s = s.replace(/(?:^|\s+)(?:बुकार|बुखारह|बुकारु)(?:\s+|$)/gi, " बुखार ");
  s = s.replace(/(?:^|\s+)(?:जुवा|जुखाम|जुवाम)(?:\s+|$)/gi, " जुकाम ");
  s = s.replace(/(?:पेश\s*पेन|तेज\s*पेन)/gi, "तेज दर्द");
  s = s.replace(/(?:^|\s+)(?:दरद|पेन)(?:\s+|$)/gi, " दर्द ");
  s = s.replace(/(?:^|\s+)(?:खासी|घांसी)(?:\s+|$)/gi, " खांसी ");

  // 5. Request to repeat / pardon
  s = s.replace(/(?:प्रदिखो|प्रतिखो|फिर\s*खो)\s*(?:बोलियेगा|बोलिए|बताइए)/gi, "फिर से बोलिए");

  return s;
}

const { cleanAndIsolateVoice } = require("../utils/audioDsp");

/**
 * Transcribes audio buffer using Groq Whisper after deep DSP voice isolation and noise gating.
 */
async function transcribePcmAudio(pcmBuffer, sampleRate = 8000, { signal } = {}) {
  // Discard audio shorter than 0.35 seconds (line noise, clicks, breaths)
  const minBytes = Math.floor(sampleRate * 2 * 0.35);
  if (!pcmBuffer || pcmBuffer.length < minBytes) {
    return "";
  }

  // Deep DSP telephony voice isolation: 300Hz-3400Hz bandpass, adaptive noise gating, and AGC normalization
  const filteredPcm = cleanAndIsolateVoice(pcmBuffer, sampleRate);
  const wavBuffer = pcmToWav(filteredPcm, sampleRate);
  const blob = new Blob([wavBuffer], { type: "audio/wav" });
  const formData = new FormData();
  formData.append("file", blob, "audio.wav");
  // whisper-large-v3 = Hindi me zyada accurate; "-turbo" = tez. Env se chuno.
  formData.append("model", process.env.STT_MODEL || "whisper-large-v3");
  formData.append("language", "hi");
  formData.append("temperature", "0");
  formData.append(
    "prompt",
    "नमस्ते, सिटी केयर हॉस्पिटल, अपॉइंटमेंट, डॉक्टर अनन्या शर्मा, डॉक्टर रोहित वर्मा, डॉक्टर संजय गुप्ता, डॉक्टर प्रिया नायर, सुबह दस बजे, दोपहर दो बजे, शाम साढ़े पाँच बजे, आज, कल, बुधवार, समय, बुखार, छाती में दर्द।"
  );

  try {
    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: formData,
      // 15s pehle tha — caller 15 second chup sunta. 6s ke baad "phir se boliye" behtar hai.
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(6000)]) : AbortSignal.timeout(6000),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[sttService] Groq Whisper error ${res.status}:`, errText);
      return "";
    }

    const data = await res.json();
    let text = (data.text || "").trim();

    // Guard against Whisper repeating prompt hallucinations on background silence / noise
    if (
      /रोहित\s*वर्मा.*संजय\s*गुप्ता/i.test(text) ||
      /अनन्या\s*शर्मा.*रोहित/i.test(text) ||
      /मरीज\s*का\s*नाम\s*spelling/i.test(text) ||
      /बुक्क\s*रोहित/i.test(text) ||
      /नाम\s*की\s*स्पेलिंग\s*नाम\s*की/i.test(text) ||
      /मरीज\s*की\s*समस्या|लक्षण\s*डॉक्टर/i.test(text) ||
      text.includes("अपॉइंटमेंटमेंट")
    ) {
      console.log(`[sttService] 🔇 Dropped Whisper prompt hallucination: "${text}"`);
      return "";
    }

    // Clean common telephony distortions
    text = cleanTelephonyHindi(text);

    // Filter out common Whisper hallucination artifacts from background noise
    const noiseWords = ["झाल", "you", "bye", ".", "...", "thank you", "subtitles"];
    // Whisper ke famous silence-hallucinations (YouTube subtitles se seekhe hue)
    if (/सब्सक्राइब|subscribe|like\s*and\s*share|अमारा\.org|amara\.org/i.test(text)) return "";
    if (noiseWords.includes(text.toLowerCase()) || text.length < 2) {
      return "";
    }

    return text;
  } catch (err) {
    console.error("[sttService] Transcription error:", err.message);
    return "";
  }
}

module.exports = { pcmToWav, transcribePcmAudio, cleanTelephonyHindi };
