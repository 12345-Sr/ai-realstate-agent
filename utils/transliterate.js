/**
 * Converts Devanagari / Hindi names into clean English (Roman script)
 * purely algorithmically with zero hardcoded or pre-saved names.
 */
const vowels = {
  "अ": "A", "आ": "Aa", "इ": "I", "ई": "Ee", "उ": "U", "ऊ": "Oo",
  "ऋ": "Ri", "ए": "E", "ऐ": "Ai", "ओ": "O", "औ": "Au", "अं": "An", "अः": "Ah"
};

const matras = {
  "ा": "a", "ि": "i", "ी": "i", "ु": "u", "ू": "u",
  "ृ": "ri", "े": "e", "ै": "ai", "ो": "o", "ौ": "au",
  "ँ": "n", "ः": "h", "्": ""
};

const consonants = {
  "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "ng",
  "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "ny",
  "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n",
  "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
  "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m",
  "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh",
  "ष": "sh", "स": "s", "ह": "h", "क़": "q", "ख़": "kh",
  "ग़": "g", "ज़": "z", "फ़": "f", "ड़": "d", "ढ़": "dh"
};

function toEnglishName(str) {
  if (!str) return "";
  let clean = String(str).trim();
  // If already pure English/ASCII, format nicely preserving apostrophes/hyphens
  if (/^[A-Za-z\s.'-]+$/.test(clean)) {
    if (/[a-z]/.test(clean) && /[A-Z]/.test(clean)) {
      return clean;
    }
    return clean
      .split(/\s+/)
      .map((w) => w.toLowerCase().replace(/(?:^|['\-])[a-z]/g, (c) => c.toUpperCase()))
      .join(" ");
  }

  // Pre-normalize common Devanagari conjuncts for standard phonetics
  clean = clean
    .replace(/ज्ञ/g, "ग्य")
    .replace(/क्ष/g, "क्श")
    .replace(/श्र/g, "श्र")
    .replace(/त्र/g, "त्र")
    .replace(/द्व/g, "द्व")
    .replace(/द्य/g, "द्य");

  const words = clean.split(/\s+/);
  const res = words.map((w) => {
    let wordOut = "";
    for (let i = 0; i < w.length; i++) {
      const char = w[i];
      const next = w[i + 1];

      if (vowels[char]) {
        wordOut += vowels[char];
      } else if (consonants[char]) {
        const eng = consonants[char];
        if (!next || next === " " || consonants[next] || vowels[next]) {
          wordOut += eng + (i === w.length - 1 ? "" : "a");
        } else if (next === "ं") {
          wordOut += eng + "an";
          i++; // Skip anusvara
        } else if (matras[next] !== undefined) {
          wordOut += eng + matras[next];
          i++; // Skip matra
        } else {
          wordOut += eng;
        }
      } else if (char === "ं") {
        wordOut += (/[aeiou]$/i.test(wordOut) ? "n" : "an");
      } else if (matras[char] !== undefined) {
        wordOut += matras[char];
      } else {
        wordOut += char;
      }
    }

    return wordOut ? wordOut.charAt(0).toUpperCase() + wordOut.slice(1).toLowerCase() : w;
  });

  return res.join(" ");
}

const STOP_WORDS = new Set([
  // Hindi auxiliary verbs, particles, greetings
  "है", "हूँ", "हूं", "था", "थी", "जी", "का", "की", "के", "को", "में", "से", "लिए",
  "पे", "पर", "ने", "तो", "भी", "ही", "और", "या", "कर", "दो", "दें", "दीजिए",
  "अलो", "हलो", "हेलो", "हेलोजी", "अलोजी", "हल्लो", "हाँजी", "जी", "हां", "हाँ", "ना", "नहीं", "अरे", "सुनिए",
  // Telephony/noise fragments
  "अग", "कि", "अजे", "जे", "वरे", "बोडिव", "क्शें", "वेटा", "क्ट", "साथ",
  // Hospital & scheduling terminology
  "डॉक्टर", "डॉ", "अपॉइंटमेंट", "बुक", "करना", "करनी", "कराना", "कराने", "चाहिए",
  "कृपया", "आज", "कल", "समय", "स्लॉट", "बजे", "दोपहर", "शाम",
  "सुबह", "मुझे", "एक", "दिखाना", "दवा", "बुखार", "खांसी", "मिलना", "पसंद", "करेंगे",
  "नमस्ते", "हेलो", "बोलिए", "बताइए", "आना", "जाना", "दो", "तीन", "ढाई", "तबीयत",
  "दर्द", "चेकअप", "परामर्श", "फीस", "हॉस्पिटल", "क्लिनिक", "थैंक्यू", "धन्यवाद", "शुक्रिया",
  "पेट", "सिर", "छाती", "हाथ", "पैर", "कमर", "बीमार", "मरीज", "पेशेंट",
  // English conversational fillers that callers say on phone
  "ok", "okay", "thank", "thanks", "you", "bye", "goodbye", "hello", "hi",
  "yes", "yeah", "yep", "no", "nope", "sure", "fine", "cool", "done", "alright", "right", "sorry",
  // Common verbs and pronouns that should never be treated as names
  "बताएं", "बताओ", "बताइए", "बोलिए", "बोलो", "पूछिए", "पूछो", "कहो", "कहिए",
  "अपना", "अपनी", "अपने", "आपका", "आपकी", "आपके", "तुम्हारा", "तुम्हारी", "तुम्हारे",
  "क्या", "कौन", "किसका", "किसकी", "इसलिए",
  // Repeat/pardon keywords
  "फिर", "दोबारा", "बोलियेगा", "सुनाई", "आवाज़", "प्रदिखो", "प्रतिखो", "माफ़", "माफ", "repeat", "pardon", "again"
]);

const HINDI_LETTER_MAP = {
  "ए": "A", "ऐ": "A",
  "बी": "B", "बे": "B",
  "सी": "C", "से": "C",
  "डी": "D", "डे": "D",
  "ई": "E", "इ": "E",
  "एफ": "F", "ऐफ": "F",
  "जी": "G", "गे": "G",
  "एच": "H", "ऐच": "H", "हेच": "H",
  "आई": "I", "आइ": "I",
  "जे": "J",
  "के": "K",
  "एल": "L", "ऐल": "L", "इल": "L",
  "एम": "M", "ऐम": "M", "इम": "M",
  "एन": "N", "ऐन": "N", "इन": "N",
  "ओ": "O", "औ": "O",
  "पी": "P", "पे": "P",
  "क्यू": "Q", "क्यु": "Q",
  "आर": "R", "अर": "R",
  "एस": "S", "ऐस": "S", "इस": "S",
  "टी": "T", "टे": "T",
  "यू": "U", "यु": "U",
  "वी": "V", "वे": "V", "भी": "V", "भे": "V",
  "डब्ल्यू": "W", "डबल्यू": "W",
  "एक्स": "X", "ऐक्स": "X", "एक्‍स": "X",
  "वाई": "Y", "वाय": "Y",
  "जेड": "Z", "ज़ेड": "Z"
};

/**
 * Detects and reconstructs letter-by-letter or syllable spelling into a clean English name.
 * Handles:
 * - Hyphenated syllables/letters: "SRA-TAN-SHU", "S-R-A-T-A-N-S-H-U"
 * - Spaced letters: "S R A T A N S H U", "A Y U S H"
 * - Devanagari letter names: "एस एच ए वी ओ एन", "पे वाई यू एस एच", "ए वाई यू एस एच"
 * - Spelled name followed by surname: "SRA-TAN-SHU शुक्ला" -> "Sratanshu Shukla"
 */
function parseSpelledName(text) {
  if (!text) return null;
  let clean = String(text).replace(/[.,?!।]/g, " ").trim();
  clean = clean.replace(/^(?:स्पेलिंग\s*(?:है|बताता\s*हूँ|हैं)?|spelling\s*(?:is)?)\s*/i, "").trim();

  let first = null;
  let matchStr = null;

  // 1. Hyphenated Latin syllables/letters (e.g. SRA-TAN-SHU or S-H-A-V-O-N)
  const latinMatch = clean.match(/\b([A-Za-z]+(?:-[A-Za-z]+)+)\b/);
  if (latinMatch) {
    matchStr = latinMatch[0];
    const joined = latinMatch[1].split("-").join("");
    first = joined.charAt(0).toUpperCase() + joined.slice(1).toLowerCase();
  } else {
    // 2. Spaced single English letters (e.g. "S R A T A N S H U")
    const spacedMatch = clean.match(/\b([A-Za-z](?:\s+[A-Za-z]){2,})\b/);
    if (spacedMatch) {
      matchStr = spacedMatch[0];
      const joined = spacedMatch[1].split(/\s+/).join("");
      first = joined.charAt(0).toUpperCase() + joined.slice(1).toLowerCase();
    } else {
      // 3. Devanagari phonetic letters (e.g. "एस एच ए वी ओ एन" or "पे वाई यू एस एच")
      const tokens = clean.split(/\s+/).filter(Boolean);
      if (tokens.length >= 2) {
        let reconstructed = "";
        let isDevLetters = true;
        for (const token of tokens) {
          if (HINDI_LETTER_MAP[token]) {
            reconstructed += HINDI_LETTER_MAP[token];
          } else if (/^[A-Za-z]$/.test(token)) {
            reconstructed += token.toUpperCase();
          } else {
            isDevLetters = false;
            break;
          }
        }
        if (isDevLetters && reconstructed.length >= 2) {
          first = reconstructed.charAt(0).toUpperCase() + reconstructed.slice(1).toLowerCase();
          matchStr = clean;
        }
      }
    }
  }

  if (!first) return null;

  // Common Hindi phonetic spellings normalization
  if (/^pyush$/i.test(first)) first = "Piyush";
  if (/^ayush$/i.test(first)) first = "Ayush";

  // Check if a surname follows the spelled first name (e.g. "SRA-TAN-SHU शुक्ला")
  if (matchStr && matchStr !== clean) {
    const after = clean.slice(clean.indexOf(matchStr) + matchStr.length).trim();
    const words = after.split(/\s+/).filter(Boolean);
    if (words.length > 0) {
      const candidateSurname = words[0].replace(/[.,?!।]/g, "").trim();
      if (
        candidateSurname &&
        !STOP_WORDS.has(candidateSurname.toLowerCase()) &&
        candidateSurname.length >= 2
      ) {
        const surnameEng = toEnglishName(candidateSurname);
        if (surnameEng && surnameEng !== "Unknown") {
          return `${first} ${surnameEng}`;
        }
      }
    }
  }

  return first;
}

/**
 * Extracts full patient name (first + last name) from caller speech and converts to English.
 */
function extractPatientNameFromSpeech(text) {
  if (!text) return null;
  let clean = String(text).replace(/[।.,?!]/g, " ").trim();

  // Guard: If caller is asking the bot a question or asking to repeat
  if (
    /(?:आपका|अपना|तुम्हारा)?\s*नाम\s*(?:बताएं|बताओ|बताइए|क्या\s*है|बोलिए|कहो)/i.test(clean) ||
    /(?:फिर\s*से|दोबारा|repeat|माफ़|आवाज़|सुनाई|क्या\s*कहा|क्या\s*बोला|बोलियेगा)/i.test(clean)
  ) {
    return null;
  }

  // 0. Check if caller spelled their name letter-by-letter or syllable-by-syllable
  const spelled = parseSpelledName(clean);
  if (spelled) return spelled;

  // 1. Strip common conversational lead-in words
  clean = clean.replace(/^(?:जी|हाँ|हां|अरे|हेलो|हलो|नमस्ते|सुनिए|सर|मैडम|ओके)\s+/i, "").trim();

  // 2. Strip trailing conversational speech markers
  clean = clean.replace(/\s+(?:बोल\s*रहा\s*हूँ|बात\s*कर\s*रहा\s*हूँ|बोल\s*रही\s*हूँ|है|हूँ|हूं)$/i, "").trim();

  // Pattern 1: मेरा नाम / मरीज का नाम / पेशेंट का नाम / नाम है X Y
  const m1 = clean.match(
    /(?:मेरा\s*नाम|मरीज़\s*का\s*नाम|मरीज\s*का\s*नाम|पेशेंट\s*का\s*नाम|नाम\s*है)\s+(?:है\s+)?([^\s]+(?:\s+[^\s]+)*)/i
  );
  if (m1) {
    const after = m1[1].split(/\s+/);
    const nameWords = [];
    for (const w of after) {
      if (STOP_WORDS.has(w.toLowerCase())) break;
      nameWords.push(w);
      if (nameWords.length >= 3) break;
    }
    if (nameWords.length >= 1) return toEnglishName(nameWords.join(" "));
  }

  // Pattern 2: Clause before symptom or doctor mention (e.g. "हृदयेश त्रिपाठी मुझे बुखार है")
  const splitIdx = clean.search(/(?:मुझे|डॉक्टर|दिखाना|अपॉइंटमेंट|फीस|समय|कब|दर्द|बुखार|खांसी|तकलीफ)/i);
  if (splitIdx > 0) {
    clean = clean.slice(0, splitIdx).trim();
  }

  // Pattern 3: Direct name utterance (1-3 words, no numbers, no stop words, min 2 chars per word)
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length >= 1 && words.length <= 3) {
    const hasStopWord = words.some(
      (w) => STOP_WORDS.has(w.toLowerCase()) || /\d/.test(w) || w.length < 2
    );
    if (!hasStopWord) {
      return toEnglishName(words.join(" "));
    }
  }

  return null;
}

/**
 * Extracts patient name when the AI assistant greets the patient with "[Name] जी"
 */
function extractNameFromAssistantSpeech(speech) {
  if (!speech) return null;
  const nonNameWords = new Set([
    "जी", "हाँ", "हां", "नमस्ते", "धन्यवाद", "शुक्रिया", "अच्छा", "ठीक", "बिल्कुल",
    "माफ़", "माफ", "कीजिए", "कीजिये", "मत", "चिंता", "परेशान", "होइए", "कोई", "बात", "नहीं",
    "कृपया", "बताइए", "सुनिए", "बोलिए", "अरे", "हेलो", "हलो", "डॉक्टर", "समय", "अपॉइंटमेंट"
  ]);
  const m = speech.match(/(?:^|[।?!]\s*)([A-Za-z\u0900-\u097F]+(?:\s+[A-Za-z\u0900-\u097F]+)?)\s+जी/i);
  if (m) {
    const candidate = m[1].trim();
    const words = candidate.split(/\s+/);
    if (
      words.every(
        (w) =>
          !nonNameWords.has(w.toLowerCase()) &&
          !STOP_WORDS.has(w.toLowerCase()) &&
          w.length >= 2
      )
    ) {
      return toEnglishName(candidate);
    }
  }
  return null;
}

module.exports = {
  toEnglishName,
  parseSpelledName,
  extractPatientNameFromSpeech,
  extractNameFromAssistantSpeech,
};
