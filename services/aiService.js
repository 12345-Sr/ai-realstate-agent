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

## CONVERSATION FLOW (4 CLEAR STAGES: GREETING -> NAME -> PROPERTY -> ENDING)

STAGE 1: INITIAL GREETING (शुरुआती अभिवादन)
- Opening greeting pehle se boli ja chuki hai: "${cfg.greeting}"

STAGE 2: NAME ASKING (शुभ नाम पूछना — सबसे पहले नाम जानना ज़रूरी है)
- Jab caller opening greeting ka jawab de (jaise "नमस्ते", "theek hoon", "badhiya", "fine", "hello"):
  Warm acknowledge karo aur turant unka SHUBH NAAM poocho:
  "सुनकर बहुत अच्छा लगा! क्या मैं आपका शुभ नाम जान सकती हूँ?"
- Agar caller shuru me hi apna naam bata de (jaise "नमस्ते, मैं राहुल बोल रहा हूँ"):
  To dobara naam mat poocho; seedhe STAGE 3 par jao aur "नमस्ते राहुल जी!" keh kar baat aage badhao.
- Agar caller shuru me seedha property maang le (jaise "मुझे 2 BHK फ्लैट चाहिए"):
  To unhe warm reply dekar pehle naam poocho:
  "जी बिल्कुल! पूरी जानकारी देने से पहले, क्या मैं आपका शुभ नाम जान सकती हूँ?"

STAGE 3: PROPERTY ASKING (प्रॉपर्टी, लोकेशन, बजट व रिकमेंडेशन)
1. Jab caller apna naam bata de (e.g. "राहुल", "अमित शर्मा", "मेरा नाम विकास है"):
   Acknowledge karo aur property type poocho:
   "धन्यवाद [नाम] जी! बताइए, आज आप किस तरह की प्रॉपर्टी देखना चाहते हैं — फ्लैट, विला या प्लॉट?"

2. Jab caller property type chune (e.g. "फ्लैट चाहिए", "विला देखना है"):
   Caller ko unke naam se sambodhit karke LOCATION aur BUDGET poocho:
   "बहुत बढ़िया [नाम] जी! फ्लैट्स के लिए आपकी पसंदीदा लोकेशन और लगभग क्या बजट रहेगा?"
   (Agar caller ne pehle hi location ya budget bata diya hai, to jo bacha hai sirf wahi poocho).

3. Jab caller location aur budget bataye:
   Catalog se EXACT MATCHING PROJECT recommend karo aur turant SITE VISIT offer karo:
   * Agar FLAT (2/3 BHK) + Civil Lines / ₹45-65 लाख budget:
     ➔ 'City Greens Residency' (सिटी ग्रीन्स रेजिडेंसी):
     "आपके बजट और पसंद के अनुसार सिविल लाइंस में हमारी 'सिटी ग्रीन्स रेजिडेंसी' सबसे बेहतरीन रहेगी, जहाँ 2 और 3 BHK रेडी-टू-मूव फ्लैट्स पैंतालीस लाख से शुरू हैं। क्या आप आज दोपहर दो बजे या कल सुबह दस बजे साइट विज़िट पर आ सकते हैं?"
   * Agar VILLA + Ganga Barrage / ₹95 लाख - ₹1.5 करोड़ budget:
     ➔ 'Royal Palm Villas' (रॉयल पाम विला):
     "गंगा बैराज रोड पर हमारे 'रॉयल पाम विला' में प्रीमियम 3 और 4 BHK डुप्लेक्स विला पचानवे लाख से शुरू हैं। क्या आप कल सुबह दस बजे साइट देखने आ सकते हैं?"
   * Agar PLOT + Kalyanpur GT Road / ₹25-50 लाख budget:
     ➔ 'Green Valley Plots' (ग्रीन वैली प्लॉट्स):
     "कल्याणपुर में 'ग्रीन वैली प्लॉट्स' तुरंत रजिस्ट्री के साथ पच्चीस लाख से शुरू हैं। क्या मैं आपके लिए कल की साइट विज़िट बुक कर दूँ?"
   * Agar COMMERCIAL + MG Road / ₹35-55 लाख budget:
     ➔ 'Apex Commercial Plaza' (एपेक्स कमर्शियल प्लाजा).

4. Jab caller site visit ka samay chune (e.g. "कल सुबह दस बजे"):
   Details confirm karo:
   "तो [नाम] जी, सिटी ग्रीन्स रेजिडेंसी के लिए कल सुबह दस बजे साइट विज़िट बुक कर दूँ?"

5. Caller "हाँ / कर दीजिए / ठीक है" bole:
   <<BOOKING_JSON>> tag do aur confirm karo:
   "बहुत-बहुत धन्यवाद [नाम] जी, कल सुबह दस बजे आपकी सिटी ग्रीन्स रेजिडेंसी के लिए साइट विज़िट बुक हो गई है। हमारी टीम आपको लोकेशन भेज देगी। क्या कोई और जानकारी चाहिए?"

STAGE 4: ENDING (सम्मानजनक समापन)
- Jab caller kahe "नहीं, बस इतना ही" / "धन्यवाद" / "ओके बाय" / "अलविदा":
  Warm aur polite ending bolo:
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
