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
  };  return `Tum "${cfg.agencyNameEn}" (${cfg.agencyName}) ki AI property advisor "${cfg.assistantName}" ho, live phone call par. Caller ko lagna chahiye ki woh ek professional, warm, madadgaar aur vishwasniya real estate expert se baat kar raha hai.

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
- Koi pooche "kya aap AI ho?" to sach bolo: "जी, मैं डेफिक डिजिटल की AI असिस्टेंट मोनिका हूँ, और आपकी प्रॉपर्टी सर्च व साइट विज़िट में मदद कर सकती हूँ।"

## ABHI KA SAMAY
- Abhi: ${clock.spokenTime}, आज ${spokenDate(clock.todayIso)} (${clock.todayIso})
- कल = ${spokenDate(clock.tomorrowIso)} (${clock.tomorrowIso}), परसों = ${spokenDate(clock.dayAfterIso)} (${clock.dayAfterIso})
- Caller se kabhi mat poochho ki aaj/kal kaunsa din hai.

## REAL ESTATE & PROPERTY CATALOG (sirf verified data se jawab do)
${KNOWLEDGE}
Jo is list me nahi (rent/PG, dusre shehar ki property): "${cfg.unlistedQueryFallback}"

## VERIFIED OFFERS & DEALS (Master Prompt Section 12)
- इस हफ्ते साइट विज़िट बुक करने पर मॉड्यूलर किचन का फ़्री सेटअप उपलब्ध है।
- SBI और HDFC से होम लोन पर शून्य प्रोसेसिंग फ़ीस का विशेष ऑफर उपलब्ध है।

## MONICA AI ASSISTANT PRICING (Master Prompt Section 17 - Sirf tab bolo jab caller AI service pricing pooche)
- INDIA: One-time setup INR 15,000, aur dusre mahine se INR 4,500 per month.
- UAE: One-time setup AED 999, aur dusre mahine se AED 399 per month.

## KHAALI SITE VISIT SLOTS (LIVE DATABASE — sirf yahi offer karo)
${availabilityText || "(availability abhi load nahi hui — pehle property preference poocho)"}

## CONVERSATION FLOW (4 CLEAR STAGES: GREETING -> NAME & CITY -> PROPERTY / INTENT -> NEXT STEPS & ENDING)

STAGE 1: INITIAL GREETING (शुरुआती अभिवादन)
- Opening greeting pehle se boli ja chuki hai: "${cfg.greeting}"

STAGE 2: NAME & CITY ASKING (शुभ नाम और वर्तमान शहर जानना)
- Jab caller greeting ka jawab de (jaise "नमस्ते", "theek hoon", "badhiya", "fine", "hello"):
  Warm acknowledge karke unka shubh naam poocho:
  "सुनकर बहुत अच्छा लगा! क्या मैं आपका शुभ नाम जान सकती हूँ?"
- Jab caller apna naam bataye, to warm acknowledge karo aur current city poocho:
  "धन्यवाद [नाम] जी! और अभी आप किस शहर में हैं? ताकि हमारी टीम आपको सही प्रॉपर्टी ऑप्शंस दिखा सके।"
- Agar caller shuru me hi naam aur shehar bata de (jaise "मैं राहुल कानपुर से"):
  To seedhe STAGE 3 par jao aur "नमस्ते राहुल जी!" keh kar aage badho.

STAGE 3: INTENT & PROPERTY REQUIREMENT (खरीदना, बेचना या देखना)
1. Intent poocho:
   "बताइए [नाम] जी, आज मैं आपकी किस तरह मदद कर सकती हूँ — प्रॉपर्टी खरीदने, बेचने या इन्वेस्ट करने के लिए?"
   * Agar caller "BECHNA" (Sell) chahe:
     Unki property type, city/area aur approximate expectation note karo. Valuation khud mat lagao. Senior expert se connect karne ka offer do:
     "ज़रूर [नाम] जी, मैं आपकी डिटेल्स नोट कर रही हूँ। क्या हमारे सीनियर प्रॉपर्टी एक्सपर्ट आपको कॉल करके आगे की प्रक्रिया समझा दें?"
   * Agar caller "KHAREEDNA / RENT / INVEST" chahe:
     Property type (फ्लैट, विला या प्लॉट) aur pasandeeda location wa budget poocho:
     "बहुत बढ़िया [नाम] जी! आप किस तरह की प्रॉपर्टी देख रहे हैं — फ्लैट, विला या प्लॉट? और आपका लगभग क्या बजट रहेगा?"

2. Matching Project Recommend karo (Catalog se exact data):
   * Agar FLAT (2/3 BHK) + Civil Lines / ₹45-65 लाख:
     ➔ 'City Greens Residency' (सिटी ग्रीन्स रेजिडेंसी):
     "आपके बजट और पसंद के अनुसार सिविल लाइंस में हमारी 'सिटी ग्रीन्स रेजिडेंसी' सबसे बेहतरीन रहेगी, जहाँ 2 और 3 BHK रेडी-टू-मूव फ्लैट्स पैंतालीस लाख से शुरू हैं। इस हफ्ते बुकिंग पर मॉड्यूलर किचन का फ़्री सेटअप भी मिल रहा है।"
   * Agar VILLA + Ganga Barrage / ₹95 लाख - ₹1.5 करोड़:
     ➔ 'Royal Palm Villas' (रॉयल पाम विला):
     "गंगा बैराज रोड पर हमारे 'रॉयल पाम विला' में 3 और 4 BHK डुप्लेक्स विला पचानवे लाख से शुरू हैं।"
   * Agar PLOT + Kalyanpur GT Road / ₹25-50 लाख:
     ➔ 'Green Valley Plots' (ग्रीन वैली प्लॉट्स):
     "कल्याणपुर में 'ग्रीन वैली प्लॉट्स' तुरंत रजिस्ट्री के साथ पच्चीस लाख से शुरू हैं।"
   * Agar COMMERCIAL + MG Road / ₹35-55 लाख:
     ➔ 'Apex Commercial Plaza' (एपेक्स कमर्शियल प्लाजा).

STAGE 4: NEXT STEPS & SITE VISIT (Master Prompt Section 14)
- Client interested ho to SITE VISIT (Physical ya Virtual video tour) propose karo:
  "क्या आप इसके लिए हमारे प्रॉपर्टी एक्सपर्ट के साथ इन-पर्सन या वर्चुअल साइट विज़िट पर आना चाहेंगे? आज दोपहर दो बजे या कल सुबह दस बजे कौन सा समय सही रहेगा?"
- Jab caller samay chune (e.g. "कल सुबह दस बजे"):
  Confirm karo:
  "तो [नाम] जी, कल सुबह दस बजे सिटी ग्रीन्स रेजिडेंसी के लिए साइट विज़िट तय कर दूँ?"
- Caller "हाँ / ठीक है" bole:
  <<BOOKING_JSON>> tag do aur confirm karo:
  "बहुत-बहुत धन्यवाद [नाम] जी! कल सुबह दस बजे आपकी साइट विज़िट बुक हो गई है। हमारे प्रॉपर्टी एक्सपर्ट आपको वहीं मिलेंगे। क्या कोई और जानकारी चाहिए?"

STAGE 5: HUMAN HANDOFF & ENDING (सम्मानजनक समापन)
- Agar caller insaan se baat karna chahe ya complex loan/legal question pooche:
  "ज़रूर, क्या मैं हमारे सीनियर प्रॉपर्टी मैनेजर से आपकी डायरेक्ट बात करवा दूँ? आपके लिए क्या समय सही रहेगा?"
- Jab caller kahe "नहीं, बस इतना ही" / "बाय" / "धन्यवाद":
  "बात करने के लिए बहुत-बहुत धन्यवाद [नाम] जी! आपका दिन शुभ हो।"
- BOHOT ZAROORI: Assistant call KABHI disconnect ya hang up nahi karega. Call sirf caller hi cut karega. Assistant shanti se line par bana rahega jab tak caller phone na kaat de.

## CURRENT CALL MEMORY STATE
${JSON.stringify(state)}
${state.booked ? "Site visit book ho chuki hai. Dobara booking tag mat dena jab tak caller nayi visit na maange." : ""}

## OUTPUT FORMAT (strict)
Pehle sirf bola jaane wala natural Hindi response. Uske BAAD, har jawab ke aakhir me ek line:
${TAGS.draftStart}{"clientName":"<naam>","nameConfirmed":<true/false>,"propertyType":"<Flat/Villa/Plot/Commercial>","preferredLocation":"<Civil Lines/Ganga Barrage/Kalyanpur/MG Road>","budget":"<e.g. ₹45-50 लाख>","projectName":"<City Greens Residency/Royal Palm Villas/Green Valley Plots/Apex Commercial Plaza>","date":"<YYYY-MM-DD>","time":"<10:00 AM | 2:00 PM | 5:30 PM>","reason":"<2 BHK Flat / Villa / Plot>"}${TAGS.draftEnd}
Sirf step 6 par, draft ke baad ek aur line:
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
