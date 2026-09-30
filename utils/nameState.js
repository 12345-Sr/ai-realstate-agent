/**
 * Single source of truth for the patient's name during a call.
 *
 * THE BUG THIS FIXES:
 * Previously, session.patientName and session.nameConfirmed could be overwritten on
 * almost every turn from three different places (a regex heuristic on raw speech, the
 * AI's own "draft" JSON, and again from the AI's final booking JSON) with no lock. Once
 * the patient had confirmed their name, later turns could still silently replace it with
 * a different, mis-heard, or hallucinated name before the appointment was booked.
 *
 * THE FIX:
 * Once `session.nameConfirmed` is true, the name is FROZEN. Nothing below (heuristic
 * extraction, the AI's draft, or the AI's final booking JSON) is allowed to change it
 * again for the rest of the call. Only an explicit "no, that's wrong" from the caller
 * (detected deterministically, not by trusting the AI) unlocks it.
 */

/*
 * BUG FIX: purane AFFIRMATIVE/NEGATIVE regex `\b` use karte the. JavaScript me
 * `\b` sirf ASCII [A-Za-z0-9_] samajhta hai, Devanagari nahi. Nateeja:
 *   "नहीं, गलत है"          -> reject detect hi nahi hota tha
 *   "ठीक है पर नाम गलत है"  -> galat naam CONFIRM ho jaata tha
 * Ab Devanagari-aware boundaries + explicit priority rules.
 */
const B = "(?<![\\u0900-\\u097Fa-z])"; // word start
const E = "(?![\\u0900-\\u097Fa-z])"; // word end
const w = (alts) => new RegExp(`${B}(?:${alts})${E}`, "i");

const NEG_WORD = w("नहीं|नही|ना|गलत|ग़लत|wrong|no|nope|nahi|galat");
const STRONG_NEG = /(?:गलत|ग़लत|wrong|galat|सही\s*नहीं|ठीक\s*नहीं|ये\s*नहीं|यह\s*नहीं|नाम\s*नहीं|नहीं\s*है\s*(?:मेरा|नाम)|नहीं\s*,?\s*(?:मेरा\s*नाम|नाम))/i;
const AFF_WORD = w("हाँ|हां|हा|जी|जी\\s*हाँ|सही|ठीक|बिल्कुल|बिलकुल|यही|हांजी|हाँजी|yes|yeah|yep|correct|right|sure|haan|ha|ji|theek|sahi|ok|okay|ओके|कर\\s*दो|कर\\s*दीजिए");
const COLLOQUIAL_YES = /(?:यही\s*(?:नाम\s*)?है|सही\s*है|ठीक\s*है|बिल्कुल\s*सही)/i; // "नहीं नहीं, सही है" = haan

/** @returns "yes" | "no" | null (ambiguous / unrelated) */
function classifyConfirmation(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  if (STRONG_NEG.test(t)) return "no";
  if (COLLOQUIAL_YES.test(t)) return "yes";
  const neg = NEG_WORD.test(t);
  const aff = AFF_WORD.test(t);
  if (neg && !aff) return "no";
  if (aff && !neg) return "yes";
  if (neg && aff) return /^\s*जी\s*(नहीं|ना)/i.test(t) ? "no" : null;
  return null;
}

const ASKED_CONFIRM_RE =
  /(?:सही\s*है\s*[?]|क्या\s*यह\s*(?:नाम\s*)?सही|मैंने\s*आपका\s*नाम|नाम\s*नोट|बुक\s*कर\s*दूँ|बुक\s*कर\s*दूं|कन्फर्म|is\s*that\s*correct)/i;
const ASKED_SPELL_RE = /(?:स्पेलिंग|spell)/i;
const ASKED_NAME_RE =
  /(?:आपका\s*नाम|अपना\s*नाम|नाम\s*बताएं|नाम\s*बताओ|नाम\s*बताइए|नाम\s*क्या\s*है|your\s*name|full\s*name)/i;
const EXPLICIT_NAME_RE = /(?:मेरा\s*नाम|मरीज़?\s*का\s*नाम|नाम\s*है|my\s*name\s*is)/i;

const DOCTOR_NAME_PATTERNS = [
  /sanjay\s*gupta/i,
  /rohit\s*verma/i,
  /ananya\s*sharma/i,
  /priya\s*nair/i,
  /संजय\s*गुप्ता/i,
  /रोहित\s*वर्मा/i,
  /अनन्या\s*शर्मा/i,
  /प्रिया\s*नायर/i,
  /हॉस्पिटल|क्लिनिक/i
];

function isInvalidPatientName(name) {
  if (!name) return true;
  const clean = String(name).trim();
  if (
    !clean ||
    clean === "undefined" ||
    clean === "null" ||
    clean === "Unknown" ||
    clean === "Patient" ||
    /^spelling/i.test(clean) ||
    /^स्पेलिंग/i.test(clean)
  ) {
    return true;
  }
  for (const pat of DOCTOR_NAME_PATTERNS) {
    if (pat.test(clean)) return true;
  }
  return false;
}

function lastAssistantMessage(session) {
  return [...session.messages].reverse().find((m) => m.role === "assistant")?.content || "";
}

/**
 * Runs on every caller turn, BEFORE calling the AI. Returns context flags the caller
 * (exotelWsService) can use, and mutates session.patientName / session.nameConfirmed
 * ONLY when the name is not yet locked.
 */
function applyCallerTurn(session, callerText, heuristics) {
  // Safety guard: nameConfirmed can NEVER be true if there is no valid patient name!
  if (session.nameConfirmed && isInvalidPatientName(session.patientName)) {
    session.nameConfirmed = false;
    session.patientName = null;
  }

  const lastMsg = lastAssistantMessage(session);
  const wasAskedForConfirmation = ASKED_CONFIRM_RE.test(lastMsg);
  const wasAskedForSpelling = ASKED_SPELL_RE.test(lastMsg);
  const wasAskedForName = ASKED_NAME_RE.test(lastMsg);
  const verdict = classifyConfirmation(callerText);
  const isAffirmative = verdict === "yes";
  const isNegative = verdict === "no";

  if (session.nameConfirmed) {
    // LOCKED. Only an explicit rejection re-opens it.
    if (wasAskedForConfirmation && isNegative) {
      session.nameConfirmed = false;
      session.patientName = null;
    }
    return { wasAskedForConfirmation, wasAskedForSpelling, wasAskedForName, locked: session.nameConfirmed };
  }

  // Name confirmation can ONLY happen when there is an actual recognized valid patient name
  if (wasAskedForConfirmation && session.patientName && !isInvalidPatientName(session.patientName)) {
    if (isAffirmative) {
      session.nameConfirmed = true;
    } else if (isNegative) {
      session.nameConfirmed = false;
      session.patientName = null;
    }
  }

  if (!session.nameConfirmed) {
    const spelledCandidate = heuristics.parseSpelledName(callerText);
    if (spelledCandidate && !isInvalidPatientName(spelledCandidate)) {
      session.patientName = spelledCandidate;
    } else if (
      !session.appointmentBooked &&
      (!session.patientName || isInvalidPatientName(session.patientName))
    ) {
      // Only let name extraction fire when context actually supports it (asked for name or said "मेरा नाम")
      const contextSupportsGuess = wasAskedForName || EXPLICIT_NAME_RE.test(callerText);
      if (contextSupportsGuess && (!wasAskedForSpelling || EXPLICIT_NAME_RE.test(callerText))) {
        const candidateName = heuristics.extractPatientNameFromSpeech(callerText);
        if (candidateName && !isInvalidPatientName(candidateName)) {
          session.patientName = candidateName;
        }
      }
    }
  }

  return { wasAskedForConfirmation, wasAskedForSpelling, wasAskedForName, locked: session.nameConfirmed };
}

/** Applies the AI's own draft.patientName - but never blindly confirms or locks without a valid name. */
function applyAiDraft(session, draft, toEnglishName) {
  if (!draft) return;

  // Never accept invalid names or let AI draft override once confirmed
  if (
    !session.nameConfirmed &&
    draft.patientName &&
    draft.patientName !== "Unknown" &&
    draft.patientName !== "Patient" &&
    !draft.patientName.includes("[") &&
    draft.patientName.trim().length > 1 &&
    !isInvalidPatientName(draft.patientName)
  ) {
    session.patientName = toEnglishName(draft.patientName);
  }

  // Safety invariant: name can NEVER be marked confirmed if patientName is missing or invalid!
  if (session.nameConfirmed && isInvalidPatientName(session.patientName)) {
    session.nameConfirmed = false;
  }
}

/** The booked appointment ALWAYS uses the locked session name - never whatever the AI put in the booking JSON. */
function finalizeBookingName(session, booking) {
  if (session.patientName && !isInvalidPatientName(session.patientName)) {
    booking.patientName = session.patientName;
  }
  return booking;
}

module.exports = { applyCallerTurn, applyAiDraft, finalizeBookingName, isInvalidPatientName, classifyConfirmation };
