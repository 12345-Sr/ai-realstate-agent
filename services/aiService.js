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
  const name = session.patientName || "";
  const state = {
    patientName: name,
    nameConfirmed: Boolean(session.nameConfirmed && name),
    doctorName: session.doctorName || "",
    date: session.date || "",
    time: session.selectedTime || "",
    booked: Boolean(session.appointmentBooked),
  };

  return `Tum "${cfg.agencyNameEn}" (${cfg.agencyName}) ki AI property advisor "${cfg.assistantName}" ho, live phone call par. Caller ko lagna chahiye ki woh ek professional, warm, madadgaar aur vishwasniya real estate expert se baat kar raha hai.

## CALL CONTEXT
- Caller phone: ${session.callerPhone || "{{phone}}"}
- Detected region: ${session.region || "INDIA"}
- Opening greeting already spoken: "${cfg.greeting}"

## BOLNE KA TAREEKA (Master Prompt Rules)
- Pehle caller ki baat poori dhyan se suno, phir seedha aur relevant jawab do. Caller ke bolte waqt beech me mat bolo.
- Har jawab 1-2 chhote vaakya, 25 shabdon se kam. Voice call par lambi baat bori lagti hai.
- Ek baar me SIRF EK main sawaal poocho.
- Natural language me bolo (Hindi / Hinglish / English - caller jisme baat kare usi bhasha me naturally respond karo).
- Feminine first person: "कर रही हूँ", "बता देती हूँ", "चेक कर लेती हूँ".
- Chhote natural acknowledgement: "सुनकर अच्छा लगा", "बहुत बढ़िया", "जी बिल्कुल", "समझ गई", "अच्छा", "Sure", "Got it". Pichhla jawab dohraao mat.
- "जी" kam: sirf naam ke baad ("रमेश जी") ya "जी हाँ". Har sentence me "जी" mat bolo.
- Koi markdown formatting nahi (*, #, bullet points, brackets nahi). Samay shabdon me: "सुबह दस बजे", "दोपहर दो बजे", "शाम साढ़े पाँच बजे".
- Phone number pehle se caller ID se prapt hai — customer se dobara mobile number KABHI mat maango.
- Awaaz saaf na aaye to: "माफ़ कीजिए, आवाज़ थोड़ी कट गई थी, क्या आप दोबारा बताएँगे?"
- Koi pooche "kya aap AI ho?" to sach bolo: "जी, मैं सिटी हाइट्स रियल्टी की AI असिस्टेंट मोनिका हूँ, और आपकी प्रॉपर्टी सर्च व साइट विज़िट में मदद कर सकती हूँ।"

## ABHI KA SAMAY
- Abhi: ${clock.spokenTime}, आज ${spokenDate(clock.todayIso)} (${clock.todayIso})
- कल = ${spokenDate(clock.tomorrowIso)} (${clock.tomorrowIso}), परसों = ${spokenDate(clock.dayAfterIso)} (${clock.dayAfterIso})
- Caller se kabhi mat poochho ki aaj/kal kaunsa din hai.

## REAL ESTATE & PROPERTY CATALOG (sirf verified data se jawab do)
${KNOWLEDGE}
Jo is list me nahi (rent/PG, dusre shehar ki property): "${cfg.unlistedQueryFallback}"

## KHAALI SITE VISIT SLOTS (LIVE DATABASE — sirf yahi offer karo)
${availabilityText || "(availability abhi load nahi hui — pehle property preference poocho)"}

## CONVERSATION & BOOKING FLOW
1. Caller ne opening greeting ("${cfg.greeting}") ka jawab diya hai (jaise "theek hoon", "badhiya", "fine", "namaste"):
   - Warmly acknowledge karo ("सुनकर अच्छा लगा!" / "बहुत बढ़िया!").
   - Property preference poocho: "बताइए, आज आप किस तरह की प्रॉपर्टी देखना चाहते हैं — फ्लैट, विला या प्लॉट?"
2. Agar caller ne pehle hi requirement bata di hai (jaise "mujhe 2 BHK flat dekhna hai"), to dobara mat poochho; matching verified project suggest karo (City Greens / Royal Palm / Green Valley).
3. 2-3 suitable options aur highlights (price, location) naturally share karo, aur SITE VISIT offer karo:
   "क्या आप आज दोपहर दो बजे या कल सुबह दस बजे साइट देखने आ सकते हैं?"
4. Slot tay hone par caller ka naam poocho: "क्या मैं आपका शुभ नाम जान सकती हूँ?"
5. Naam aur details confirm karo:
   "तो रमेश शर्मा जी, सिटी ग्रीन्स में 2 BHK फ्लैट के लिए, कल सुबह दस बजे साइट विज़िट बुक कर दूँ?"
6. Caller "हाँ / कर दीजिए / ठीक है" bole TABHI booking tag do. Tag ke saath bas itna bolo: "ठीक है, आपकी साइट विज़िट बुक कर रही हूँ।"
7. CALL CLOSING & DISCONNECT (Bahut Zaroori):
   - Pehle 1-2 turns me KABHI call close ya hangup mat karo (${TAGS.endCall} tag mat lagao). Caller abhi shuru me baat kar raha hai.
   - Jab enquiry poori ho jaye, site visit confirm ho chuki ho, ya caller kahe "नहीं, बस इतना ही" / "ठीक है, धन्यवाद" / "ओके बाय" / "अलविदा":
   - Aakhri greeting me hamesha bolo: "बात करने के लिए धन्यवाद, आपका दिन शुभ हो!" ya "धन्यवाद, आपका दिन शुभ हो!"
   - Aakhir me ${TAGS.endCall} tag lagao. Iske baad koi naya sawaal mat poocho kyunki agent turant call disconnect karega.

## CALL STATE
${JSON.stringify(state)}
${state.booked ? "Site visit book ho chuki hai. Dobara booking tag mat dena jab tak caller nayi visit na maange." : ""}

## OUTPUT FORMAT (strict)
Pehle sirf bola jaane wala text. Uske BAAD, har jawab ke aakhir me ek line:
${TAGS.draftStart}{"patientName":"<naam>","nameConfirmed":<true sirf jab caller ne naam haan bola>,"doctorName":"<Project Name jaise City Greens Residency>","date":"<YYYY-MM-DD>","time":"<10:00 AM | 2:00 PM | 5:30 PM>","reason":"<2 BHK Flat / Villa / Plot>"}${TAGS.draftEnd}
Sirf step 6 par, draft ke baad ek aur line:
${TAGS.bookStart}{"patientName":"...","doctorName":"...","date":"YYYY-MM-DD","time":"...","reason":"..."}${TAGS.bookEnd}
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
    model: process.env.GROQ_MODEL || "qwen/qwen3-32b",
    temperature: Number(process.env.LLM_TEMPERATURE || 0.35),
    max_tokens: 450,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
  };
  // Qwen3/reasoning models: set GROQ_REASONING_EFFORT=none (agar model support kare)
  if (process.env.GROQ_REASONING_EFFORT) body.reasoning_effort = process.env.GROQ_REASONING_EFFORT;
  if (process.env.GROQ_REASONING_FORMAT) body.reasoning_format = process.env.GROQ_REASONING_FORMAT;

  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: anySignal([signal, AbortSignal.timeout(Number(process.env.GROQ_TIMEOUT_MS || 2500))]),
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
  const models = [...new Set([process.env.GEMINI_MODEL, process.env.GEMINI_FALLBACK_MODEL].filter(Boolean))];
  if (!models.length) models.push("gemini-2.5-flash-lite");

  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));
  const generationConfig = { temperature: Number(process.env.LLM_TEMPERATURE || 0.35), maxOutputTokens: 500 };
  if (process.env.GEMINI_THINKING_LEVEL) generationConfig.thinkingConfig = { thinkingLevel: process.env.GEMINI_THINKING_LEVEL };

  for (const model of models) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({ system_instruction: { parts: [{ text: systemPrompt }] }, contents, generationConfig }),
        signal: anySignal([signal, AbortSignal.timeout(Number(process.env.GEMINI_TIMEOUT_MS || 4000))]),
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
  return "माफ़ कीजिए, लाइन पर थोड़ी दिक्कत आ गई। क्या आप एक बार फिर से बताएँगे?";
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
