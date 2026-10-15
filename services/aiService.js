/**
 * AI brain: prompt + LLM calls (Groq fast path -> Gemini fallback).
 *
 * Fixes vs old version:
 *  - Booking JSON template me defaults pre-filled the ("Dr. Ananya Sharma",
 *    "General Physician", pehla shift) — LLM unhe copy kar deta tha, cardiology
 *    patient bhi "General Physician" me book hota tha. Ab koi default nahi.
 *  - max_tokens 220: Hindi + DRAFT JSON me truncate hota tha; aadha
 *    "<<DRAFT_JSON>>{..." TTS bol deta tha. Ab 450 tokens + unterminated tags strip.
 *  - Qwen3 jaise reasoning models ka <think>...</think> strip.
 *  - Worst case 3s (Groq) + 3x5s (Gemini) = 18s tak silence. Ab caller ka
 *    AbortSignal + per-provider chhote timeouts.
 *  - Gemini key URL (?key=) me thi -> logs me leak. Ab header me.
 *  - Gemini: first message "model" role / consecutive same roles -> 400. Normalised.
 */
const cfg = require("../config/realestateConfig");
const { buildKnowledgeText, getClock, spokenDate } = require("./propertyKnowledge");

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const TAGS = {
  draftStart: "<<DRAFT_JSON>>",
  draftEnd: "<<END_DRAFT_JSON>>",
  bookStart: "<<BOOKING_JSON>>",
  bookEnd: "<<END_BOOKING_JSON>>",
  endCall: "<<END_CALL>>",
};

const KNOWLEDGE = buildKnowledgeText();

function buildSystemPrompt(session = {}, { availabilityText = "", clock = getClock() } = {}) {
  const clientName = session.clientName || session.patientName || "";
  const state = {
    clientName,
    nameConfirmed: Boolean(session.nameConfirmed && clientName),
    propertyType: session.propertyType || "",
    budget: session.budget || "",
    preferredLocation: session.preferredLocation || session.location || "",
    projectName: session.projectName || session.doctorName || "",
    date: session.date || "",
    time: session.selectedTime || "",
    booked: Boolean(session.appointmentBooked),
  };

  return `Tum "${cfg.agencyNameEn}" (${cfg.agencyName}) ki expert property advisor "${cfg.assistantName}" ho, live phone call par. Caller ko lagna chahiye ki woh ek genuine, professional aur helpful real estate expert se seedhi baat kar raha hai.

## STRICT RULES (HUMAN FLOW & SPEAKERPHONE AWARE)
1. "आपसे बात करके अच्छा लगा" या "सुनकर बहुत अच्छा लगा" बातचीत में KABHI MAT BOLO. Yeh extremely robotic aur unnatural lagta hai.
2. Har jawab 1-2 chhote vaakya (sirf 15-20 shabd). Caller phone speaker par ho sakta hai — baat seedhi, saaf aur bina kisi faltu formality ke rakho.
3. Ek baar me SIRF EK zaroori sawaal poocho. Pichhla bola hua mat dohrao.
4. Natural conversational tone: "जी बिल्कुल", "ज़रूर", "जी बढ़िया", "समझ गई", "हाँ जी".
5. Feminine first person: "कर रही हूँ", "बता देती हूँ", "चेक कर लेती हूँ".
6. Phone number caller ID se mil chuka hai — caller se mobile number dobara KABHI mat maango.
7. Assistant call kabhi disconnect nahi karega. Shanti se line par bane raho jab tak caller phone na kaat de.

## CALL CONTEXT
- Caller phone: ${session.callerPhone || "{{phone}}"}
- Opening greeting already spoken: "${cfg.greeting}"
- Abhi: ${clock.spokenTime}, आज ${spokenDate(clock.todayIso)} (${clock.todayIso}) | कल: ${spokenDate(clock.tomorrowIso)}

## PROPERTY CATALOG & KNOWLEDGE
${KNOWLEDGE}
Jo list me na ho (rent/PG/dusre shehar): "${cfg.unlistedQueryFallback}"

## SITE VISIT SLOTS
${availabilityText || "Slots: सुबह 10:00 बजे, दोपहर 2:00 बजे, शाम 5:30 बजे उपलब्ध हैं।"}

## CONVERSATION FLOW (Natural & Human-like):
1. GREETING RESPONSE:
   Jab caller greeting ka jawab de ("नमस्ते", "हाँ", "theek hoon", "badhiya", "fine", "hello"):
   Seedhe warm acknowledge karke unka naam poocho:
   -> "जी बहुत बढ़िया! क्या मैं आपका शुभ नाम जान सकती हूँ?"
   (Agar caller direct property pooche jaise "flat dekhna hai", to pehle jawab do: "ज़रूर! सिविल लाइंस में हमारे 2 और 3 BHK फ्लैट्स 45 लाख से शुरू हैं। आपका शुभ नाम क्या है?")

2. REQUIREMENT / PROPERTY TYPE:
   Caller apna naam bataye (e.g. "राहुल"):
   -> "धन्यवाद राहुल जी! आप फ्लैट, विला या प्लॉट — किस तरह की प्रॉपर्टी देख रहे हैं?"

3. RECOMMENDATION:
   - Flat (2/3 BHK, Civil Lines, ₹45-65L) -> 'City Greens Residency' (रेडी-टू-मूव, मॉड्यूलर किचन फ्री)
   - Villa (3/4 BHK, Ganga Barrage, ₹95L-1.5Cr) -> 'Royal Palm Villas' (डुप्लेक्स विला)
   - Plot (Kalyanpur GT Road, ₹25-50L) -> 'Green Valley Plots' (तुरंत रजिस्ट्री)
   - Commercial / Shop (MG Road, ₹35-55L) -> 'Apex Commercial Plaza' (मेन रोड दुकानें)
   Recommendation ke saath hi site visit offer karo:
   -> "क्या आप इसके लिए साइट विज़िट पर आना चाहेंगे? आज दोपहर दो बजे या कल सुबह दस बजे — कौन सा समय सही रहेगा?"

4. SITE VISIT CONFIRMATION:
   Jab caller samay chune (e.g. "कल सुबह दस बजे"):
   Confirm karo aur <<BOOKING_JSON>> tag do:
   -> "बिल्कुल [नाम] जी, कल सुबह दस बजे आपकी साइट विज़िट तय हो गई है। हमारे प्रॉपर्टी एक्सपर्ट आपको वहीं मिलेंगे।"

5. ENDING:
   Jab caller kahe "नहीं बस इतना ही" / "बाय" / "धन्यवाद":
   Sirf tab warm closing do:
   -> "जी धन्यवाद [नाम] जी! आपका दिन शुभ हो।"

## CURRENT STATE
${JSON.stringify(state)}
${state.booked ? "Site visit book ho chuki hai. Dobara booking tag mat dena jab tak caller nayi visit na maange." : ""}

## OUTPUT FORMAT (strict)
Pehle sirf bola jaane wala natural Hindi response. Uske BAAD, aakhir me:
${TAGS.draftStart}{"clientName":"<naam>","nameConfirmed":<true/false>,"propertyType":"<Flat/Villa/Plot/Commercial>","preferredLocation":"<Civil Lines/Ganga Barrage/Kalyanpur/MG Road>","budget":"<e.g. ₹45-50 लाख>","projectName":"<City Greens Residency/Royal Palm Villas/Green Valley Plots/Apex Commercial Plaza>","date":"<YYYY-MM-DD>","time":"<10:00 AM | 2:00 PM | 5:30 PM>","reason":"<2 BHK Flat / Villa / Plot>"}${TAGS.draftEnd}
Site visit confirm hone par draft ke baad:
${TAGS.bookStart}{"clientName":"...","projectName":"...","date":"YYYY-MM-DD","time":"...","reason":"..."}${TAGS.bookEnd}
Placeholder ya anumaan se value mat bharo; jo pata nahi woh khaali chhodo.`;
}

/** Merge consecutive same-role turns; Gemini needs the first turn to be "user". */
function normalizeMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (!m || !m.content) continue;
    const role = m.role === "assistant" ? "assistant" : "user";
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += " " + m.content;
    else out.push({ role, content: String(m.content) });
  }
  if (out.length && out[0].role === "assistant") out.unshift({ role: "user", content: "(call connected)" });
  return out;
}

function anySignal(signals) {
  const valid = signals.filter(Boolean);
  if (AbortSignal.any) return AbortSignal.any(valid);
  const ac = new AbortController();
  for (const s of valid) {
    if (s.aborted) ac.abort(s.reason);
    else s.addEventListener("abort", () => ac.abort(s.reason), { once: true });
  }
  return ac.signal;
}

async function callGroq(messages, systemPrompt, signal) {
  const apiKey = (process.env.GROQ_API_KEY || "").replace(/^GROQ_API_KEY=/, "").trim();
  if (!apiKey) return null;
  const body = {
    model: process.env.GROQ_MODEL || "qwen/qwen3.8-27b",
    temperature: Number(process.env.LLM_TEMPERATURE || 0.35),
    max_tokens: 350,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
  };
  if (process.env.GROQ_REASONING_EFFORT) body.reasoning_effort = process.env.GROQ_REASONING_EFFORT;
  if (process.env.GROQ_REASONING_FORMAT) body.reasoning_format = process.env.GROQ_REASONING_FORMAT;

  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: anySignal([signal, AbortSignal.timeout(Number(process.env.GROQ_TIMEOUT_MS || 3200))]),
    });
    if (!res.ok) {
      console.warn(`[ai] Groq ${res.status}: ${(await res.text()).slice(0, 160)}`);
      return null;
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    if (signal?.aborted) throw err;
    console.warn("[ai] Groq error:", err.message);
    return null;
  }
}

async function callGemini(messages, systemPrompt, signal) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const models = [...new Set([process.env.GEMINI_MODEL, "gemini-3.5-flash-lite", "gemini-2.5-flash-lite"].filter(Boolean))];

  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const generationConfig = { temperature: Number(process.env.LLM_TEMPERATURE || 0.35), maxOutputTokens: 350 };

  for (const model of models) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({ system_instruction: { parts: [{ text: systemPrompt }] }, contents, generationConfig }),
        signal: anySignal([signal, AbortSignal.timeout(Number(process.env.GEMINI_TIMEOUT_MS || 4500))]),
      });
      if (!res.ok) {
        console.warn(`[ai] Gemini (${model}) ${res.status}: ${(await res.text()).slice(0, 160)}`);
        continue;
      }
      const data = await res.json();
      const text = (data.candidates?.[0]?.content?.parts || [])
        .filter((p) => !p.thought)
        .map((p) => p.text || "")
        .join("")
        .trim();
      if (text) return text;
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn(`[ai] Gemini (${model}) error:`, err.message);
    }
  }
  return null;
}

/**
 * @param {Array} messages  [{role, content}]
 * @param {object} session
 * @param {{signal?: AbortSignal, availabilityText?: string}} opts
 * @returns raw LLM text (or a safe fallback line)
 */
async function getAIReply(messages, session = {}, opts = {}) {
  const systemPrompt = buildSystemPrompt(session, opts);
  const windowed = normalizeMessages(messages.slice(-12));
  const order = (process.env.LLM_PRIMARY || "groq") === "gemini" ? [callGemini, callGroq] : [callGroq, callGemini];

  for (const fn of order) {
    const reply = await fn(windowed, systemPrompt, opts.signal);
    if (reply) return reply;
  }
  return "माफ़ कीजिए, आपकी आवाज़ साफ़ नहीं आ पाई। क्या आप एक बार फिर बताएँगे?";
}

function safeJson(str) {
  try {
    const m = String(str).match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch {
    return null;
  }
}

/**
 * Split raw LLM output into { speech, draft, booking }.
 * Robust to: <think> blocks, missing END tags (truncation), code fences, stray JSON.
 */
function parseReply(raw) {
  let text = String(raw || "");
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*$/i, "");

  const grab = (start, end) => {
    const s = text.indexOf(start);
    if (s === -1) return null;
    const e = text.indexOf(end, s);
    return safeJson(text.slice(s + start.length, e === -1 ? undefined : e));
  };
  const draft = grab(TAGS.draftStart, TAGS.draftEnd);
  const booking = grab(TAGS.bookStart, TAGS.bookEnd);

  if (draft) {
    if (!draft.clientName && draft.patientName) draft.clientName = draft.patientName;
    if (!draft.patientName && draft.clientName) draft.patientName = draft.clientName;
    if (!draft.projectName && draft.doctorName) draft.projectName = draft.doctorName;
    if (!draft.doctorName && draft.projectName) draft.doctorName = draft.projectName;
  }
  if (booking) {
    if (!booking.clientName && booking.patientName) booking.clientName = booking.patientName;
    if (!booking.patientName && booking.clientName) booking.patientName = booking.clientName;
    if (!booking.projectName && booking.doctorName) booking.projectName = booking.doctorName;
    if (!booking.doctorName && booking.projectName) booking.doctorName = booking.projectName;
  }

  // Speech = everything before the first tag/JSON-ish marker
  let speech = text.split(/<<|```|\{\s*"/)[0];
  speech = speech
    .replace(/[*_#`~>|\[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const endCall = Boolean(
    text.includes(TAGS.endCall) ||
    /<<END_CALL>>|<<HANGUP>>/i.test(text) ||
    /(?:आपका\s*दिन\s*शुभ\s*हो|दिन\s*शुभ\s*हो|apka\s*din\s*shubh\s*ho|shubh\s*din|have\s*a\s*(?:nice|great|good)\s*day)/i.test(speech)
  );

  return { speech, draft, booking, endCall };
}

module.exports = { getAIReply, parseReply, buildSystemPrompt, normalizeMessages, TAGS };
