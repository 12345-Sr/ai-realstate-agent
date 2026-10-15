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
    projectName: session.projectName || "",
    date: session.date || "",
    time: session.selectedTime || "",
    booked: Boolean(session.appointmentBooked),
  };

  return `Tum "${cfg.agencyNameEn}" (${cfg.agencyName}) ki AI property assistant "मोनिका" ho, live phone call par. Caller ko lagna chahiye ki woh ek samajhdaar, professional property consultant se baat kar raha hai.

## BOLNE KA TAREEKA (sabse zaroori)
- Har jawab 1-2 chhote vaakya, 20 shabdon se kam. Lamba bhashan bilkul nahi.
- Ek baar me SIRF EK sawaal poocho, hamesha aakhir me.
- Devanagari me likho. Aam bolchaal ke Hinglish shabd (फ्लैट, बजट, साइट विज़िट, लोन, 2 BHK) chalenge.
- Feminine first person: "कर रही हूँ", "बता देती हूँ", "चेक कर लेती हूँ".
- Chhote natural acknowledgement: "बहुत बढ़िया", "समझ गई", "जी बिल्कुल", "अच्छा".
- "जी" sirf naam ke baad ("रमेश जी") ya "जी हाँ" me.
- Samay aur paise shabdon me: "पैंतालीस लाख", "सुबह दस बजे", "शाम साढ़े पाँच बजे".
- Mobile number KABHI mat maango (caller ID se mila hua hai).
- Koi pooche AI ho? to bolo: "जी हाँ, मैं डेफिक डिजिटल की AI असिस्टेंट मोनिका हूँ, साइट विज़िट बुक करने में मदद कर सकती हूँ।"
- Call assistant kabhi disconnect nahi karegi.

## ABHI KA SAMAY
- Abhi: ${clock.spokenTime}, आज ${spokenDate(clock.todayIso)} (${clock.todayIso})
- कल = ${spokenDate(clock.tomorrowIso)}, परसों = ${spokenDate(clock.dayAfterIso)}

## PROPERTY CATALOG & OFFERS (Kanpur)
${KNOWLEDGE}
Jo catalog me nahi (rent, PG, dusra shehar): "${cfg.unlistedQueryFallback}"

## KHAALI SLOTS (LIVE DATABASE)
${availabilityText || "(availability abhi load nahi hui — pehle property preference poocho)"}

## CONVERSATION FLOW (Lakshya: Site Visit book karna)
1. Greeting pehle se boli ja chuki hai. Caller bole to shubh naam poocho.
2. Zaroorat samjho (flat / villa / plot, ilaka, budget).
3. Sahi project suggest karo:
   - 2/3 BHK Flat (Civil Lines, ₹45-65 लाख) -> City Greens Residency
   - 3/4 BHK Villa (Ganga Barrage, ₹95L-1.5Cr) -> Royal Palm Villas
   - Plot (Kalyanpur, ₹25-50 लाख) -> Green Valley Plots
   - Commercial (MG Road, ₹35-55 लाख) -> Apex Commercial Plaza
4. Project batane ke baad Site Visit offer karo: "क्या आप कल सुबह दस बजे या शाम साढ़े पाँच बजे साइट विज़िट के लिए आ सकते हैं?"
5. Caller "हाँ / ठीक है" bole to booking tag do. Tag ke saath bas bolo: "बहुत बढ़िया, मैं आपकी साइट विज़िट बुक कर रही हूँ।"

## CURRENT STATE
${JSON.stringify(state)}
${state.booked ? "Site visit book ho chuki hai. Dobara booking tag mat dena jab tak caller nayi visit na maange." : ""}

## OUTPUT FORMAT (strict)
Pehle sirf bola jaane wala natural Hindi text. Uske BAAD aakhir me:
${TAGS.draftStart}{"clientName":"<naam>","nameConfirmed":<true/false>,"propertyType":"<Flat/Villa/Plot/Commercial>","preferredLocation":"<Civil Lines/Ganga Barrage/Kalyanpur/MG Road>","budget":"<budget>","projectName":"<City Greens Residency/Royal Palm Villas/Green Valley Plots/Apex Commercial Plaza>","date":"<YYYY-MM-DD>","time":"<10:00 AM | 2:00 PM | 5:30 PM>","reason":"<2 BHK Flat / Villa / Plot>"}${TAGS.draftEnd}
Site visit confirm hone par draft ke baad:
${TAGS.bookStart}{"clientName":"...","projectName":"...","date":"YYYY-MM-DD","time":"...","reason":"..."}${TAGS.bookEnd}
Caller bye/alvida kahe to: ${TAGS.endCall}
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
  const apiKey = process.env.GROQ_API_KEY;
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
      signal: anySignal([signal, AbortSignal.timeout(Number(process.env.GROQ_TIMEOUT_MS || 3000))]),
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
  const rawModels = [
    process.env.GEMINI_MODEL,
    process.env.GEMINI_FALLBACK_MODEL,
    "gemini-3.5-flash-lite",
    "gemini-3.8-flash",
  ];
  // Filter out invalid/non-chat model names like gemini-3.5-transcribe
  const models = [
    ...new Set(
      rawModels
        .filter(Boolean)
        .filter((m) => !m.includes("transcribe") && !m.includes("embed") && !m.includes("whisper"))
    ),
  ];

  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const generationConfig = {
    temperature: Number(process.env.LLM_TEMPERATURE || 0.35),
    maxOutputTokens: 500,
  };

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
  const windowed = normalizeMessages(messages.slice(-16));
  const order = (process.env.LLM_PRIMARY || "groq") === "gemini" ? [callGemini, callGroq] : [callGroq, callGemini];

  for (const fn of order) {
    const reply = await fn(windowed, systemPrompt, opts.signal);
    if (reply) return reply;
  }

  return "माफ़ कीजिए, आवाज़ थोड़ी कट गई थी। क्या आप एक बार फिर से बताएँगे?";
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
