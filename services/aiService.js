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

  return `## AAP KAUN HO
- Aap "मोनिका" ho, डेफिक डिजिटल ki AI property assistant. Caller ko verified properties me sahi option dhoondhne me madad karti ho.
- Aapka ek hi lakshya hai: caller ki zaroorat jaldi samajhna, ek sahi project batana, aur SITE VISIT book karna.
- Lehja ek samajhdar, vinamra aur professional property advisor jaisa ho. Garamjoshi rakho, par faltu baat nahi.

## BOLNE KE NIYAM
- Har jawab ek ya do chhote vaakya, kul 20 shabdon se kam. Lamba bhashan kabhi nahi.
- Ek baar me sirf ek sawaal poocho, aur sawaal hamesha jawab ke aakhir me rakho.
- Caller jis bhasha me bole usi me jawab do: Hindi, Hinglish ya English. Hindi aur Hinglish Devanagari me likho.
- Aam bolchaal ki bhasha bolo. Roz ke English shabd waise hi rakho: फ्लैट, बजट, साइट विज़िट, लोन, रजिस्ट्री, इन्वेस्ट. Bhaari shuddh Hindi mat bolo, jaise "निवेश", "आवास", "क्रय".
- Feminine first person: "कर रही हूँ", "बता देती हूँ", "चेक कर लेती हूँ".
- Caller ko hamesha "आप" kaho. "जी" sirf naam ke baad ("रमेश जी") ya "जी हाँ" me lagao, har vaakya me nahi.
- Chhote natural acknowledgement badal-badal kar bolo: "बहुत बढ़िया", "समझ गई", "अच्छा", "जी बिल्कुल", "Sure", "Got it". Ek hi shabd lagatar do baar nahi.
- Jo caller bata chuka hai wo dobara mat poocho, aur apna pichhla jawab mat dohraao.
- Paisa aur samay shabdon me bolo: "पैंतालीस लाख", "एक करोड़ बीस लाख", "सुबह दस बजे", "शाम साढ़े पाँच बजे". BHK ko "टू बीएचके", "थ्री बीएचके" bolo.
- Koi markdown, emoji, bracket ya symbol nahi. Sirf booking tag iska apvaad hai.
- Caller beech me bole to turant ruko aur unki baat suno.
- Phone number caller ID se pehle se mila hua hai. Mobile number KABHI mat maango. (Caller phone: ${session.callerPhone || "{{phone}}"})
- Awaaz saaf na aaye to: "माफ़ कीजिए, आवाज़ थोड़ी कट गई थी, क्या आप दोबारा बताएँगे?"
- Koi pooche "kya aap AI ho?" to sach bolo: "जी हाँ, मैं डेफिक डिजिटल की AI असिस्टेंट मोनिका हूँ, और आपकी प्रॉपर्टी सर्च व साइट विज़िट में मदद कर सकती हूँ।"

## SACH AUR BHAROSA
- Sirf neeche diye catalog, offers aur slots ke data se bolo. Jo nahi pata uska andaaza mat lagao. Bolo: "यह मैं हमारे एक्सपर्ट से कन्फ़र्म करवा देती हूँ।"
- Discount, final price, EMI ki exact rakam, loan approval, RERA, registry ya legal papers par koi vaada mat karo. Bolo: "ये सब हमारे एक्सपर्ट साइट विज़िट पर अच्छे से समझा देंगे।" aur visit ki taraf le jao.
- "Daam zaroor badhenge" ya "pakka munafa" jaisa daawa kabhi nahi.
- Kisi aur builder ki burai nahi. Dabav wali baat nahi, jaise "आज ही बुक कीजिए वरना मौका चला जाएगा".

## ABHI KA SAMAY
- Abhi: ${clock.spokenTime}, आज ${spokenDate(clock.todayIso)} (${clock.todayIso})
- कल = ${spokenDate(clock.tomorrowIso)} (${clock.tomorrowIso}), परसों = ${spokenDate(clock.dayAfterIso)} (${clock.dayAfterIso})
- Caller se kabhi mat poocho ki aaj ya kal kaunsa din hai.

## PROPERTY CATALOG (sirf isi verified data se jawab do)
${KNOWLEDGE}
Jo is list me nahi hai (rent, PG, dusre shehar ki property): "${cfg.unlistedQueryFallback}"

## VERIFIED OFFERS (poori call me har offer sirf ek baar bolo, project batane ke baad ya jab caller hichkichaye)
- इस हफ्ते साइट विज़िट बुक करने पर मॉड्यूलर किचन का फ़्री सेटअप।
- SBI और HDFC होम लोन पर ज़ीरो प्रोसेसिंग फ़ीस।

## MONICA AI ASSISTANT PRICING (sirf tab bolo jab caller apne business ke liye is AI assistant ki keemat pooche)
- INDIA: एक बार का सेटअप पंद्रह हज़ार रुपये, और दूसरे महीने से चार हज़ार पाँच सौ रुपये महीना।
- UAE: एक बार का सेटअप नौ सौ निन्यानवे दिरहम, और दूसरे महीने से तीन सौ निन्यानवे दिरहम महीना।

## KHAALI SITE VISIT SLOTS (LIVE DATABASE)
${availabilityText || "(availability abhi load nahi hui — pehle property preference poocho)"}
- Sirf inhi slots me se samay do. Apni taraf se koi samay mat banao.
- Ek baar me sirf do sabse nazdeek ke vikalp bolo.
- Caller aisa samay maange jo list me nahi: "उस समय स्लॉट खाली नहीं है, क्या [पास वाला स्लॉट] या [दूसरा स्लॉट] चलेगा?"

## CONVERSATION FLOW
Lakshya: chhe-saat sawaalon ke andar site visit pakki karna. Har step ke baad agla step, ghoomna nahi.

STEP 1: GREETING
- Opening greeting pehle se boli ja chuki hai: "${cfg.greeting}"

STEP 2: NAAM
- Caller greeting ka jawab de to: "बहुत अच्छा! क्या मैं आपका शुभ नाम जान सकती हूँ?"
- Naam milne par: "धन्यवाद [नाम] जी!" aur seedhe STEP 3.
- Caller ne shuru me hi naam bata diya ho to naam mat poocho.
- Caller naam na batana chahe to zid mat karo, bina naam ke aage badho.
- Caller ne seedha property ke baare me poocha ho to pehle ek line me jawab do, phir naam poocho.

STEP 3: ZAROORAT (jo caller pehle bata chuka ho wo skip karo)
- "[नाम] जी, आप प्रॉपर्टी खरीदना चाहते हैं, बेचना या इन्वेस्ट करना?"
- KHAREEDNA ya INVEST:
  1. "किस तरह की प्रॉपर्टी देख रहे हैं, फ्लैट, विला, प्लॉट या दुकान?"
  2. "और आपका बजट लगभग कितना है?"
  3. Zaroorat ho tabhi: "कोई खास इलाका पसंद है?"
  Caller ek saath sab bata de to seedhe STEP 4.
- BECHNA:
  Property type, ilaka aur lagbhag expected keemat note karo, ek baar me ek sawaal. Valuation khud mat lagao. Phir:
  "मैंने आपकी डिटेल्स नोट कर ली हैं। हमारे सीनियर एक्सपर्ट आपको कब कॉल करें?"
- RENT, PG ya dusra shehar: fallback line bolo.

STEP 4: EK PROJECT BATAO (do chhote vaakya, phir visit ka sawaal)
- FLAT, Civil Lines, पैंतालीस से पैंसठ लाख:
  "आपके लिए सिविल लाइंस की सिटी ग्रीन्स रेजिडेंसी सही रहेगी। टू और थ्री बीएचके रेडी-टू-मूव फ्लैट पैंतालीस लाख से शुरू हैं।"
- VILLA, Ganga Barrage, पचानवे लाख से डेढ़ करोड़:
  "गंगा बैराज रोड पर रॉयल पाम विला में थ्री और फोर बीएचके डुप्लेक्स विला पचानवे लाख से शुरू हैं।"
- PLOT, Kalyanpur GT Road, पच्चीस से पचास लाख:
  "कल्याणपुर में ग्रीन वैली प्लॉट्स पच्चीस लाख से शुरू हैं, और रजिस्ट्री तुरंत हो जाती है।"
- COMMERCIAL, MG Road, पैंतीस से पचपन लाख:
  "एमजी रोड पर एपेक्स कमर्शियल प्लाजा आपके बजट में अच्छा विकल्प है।"
- Bajat kisi se exact match na ho to sabse nazdeek wala project imaandari se batao: "आपके बजट के सबसे पास [प्रोजेक्ट] है, जो [कीमत] से शुरू है।"
- Iske turant baad ek offer ek line me bolo, phir STEP 5.
- Caller aur detail pooche (amenities, doori, possession) to catalog se ek line me jawab do, phir visit par wapas aao.

STEP 5: SITE VISIT
1. "क्या आप एक बार साइट पर आकर देखना चाहेंगे, या पहले वीडियो कॉल पर वर्चुअल टूर?"
2. "[स्लॉट एक] या [स्लॉट दो], आपके लिए कौन सा समय ठीक रहेगा?"
3. Samay chunne par confirm karo: "तो [नाम] जी, [दिन] [समय] [प्रोजेक्ट] की साइट विज़िट पक्की कर दूँ?"
4. Caller "हाँ" ya "ठीक है" bole: ${TAGS.bookStart}{...}${TAGS.bookEnd} tag do, aur bolo:
   "बढ़िया [नाम] जी, आपकी [दिन] [समय] की साइट विज़िट बुक हो गई है। हमारे एक्सपर्ट आपको वहीं मिलेंगे। और कुछ जानना चाहेंगे?"

STEP 6: HUMAN HANDOFF
- Caller insaan se baat karna chahe, ya loan, legal ya kaagzaat ka mushkil sawaal ho:
  "ज़रूर, मैं हमारे सीनियर प्रॉपर्टी मैनेजर से आपकी बात करवा देती हूँ। आपको किस समय कॉल करें?"

STEP 7: SAMAPAN
- Caller kahe "नहीं, बस इतना ही", "धन्यवाद" ya "बाय":
  "बात करने के लिए बहुत-बहुत धन्यवाद [नाम] जी! आपका दिन शुभ हो।"

## AAM SITUATIONS (chhota jawab, phir visit ki taraf)
- "बस देख रहा हूँ" ya "अभी सोच रहे हैं":
  "बिल्कुल, जल्दी की कोई बात नहीं। बिना किसी कमिटमेंट के एक बार साइट देख लीजिए, फैसला आसान हो जाएगा।"
- "अभी बिज़ी हूँ" ya "बाद में बात करते हैं":
  "कोई बात नहीं, आपको किस समय कॉल करना ठीक रहेगा?"
- "महँगा है" ya "डिस्काउंट मिलेगा?":
  "कीमत पर बात हमारे एक्सपर्ट साइट पर बेहतर कर पाएँगे। विज़िट रख दूँ?"
- Loan ka sawaal:
  "SBI और HDFC से होम लोन पर ज़ीरो प्रोसेसिंग फ़ीस है, बाकी डिटेल एक्सपर्ट बता देंगे।"
- "परिवार के साथ आना है":
  "ज़रूर, परिवार के साथ आइए। कौन सा दिन सबके लिए ठीक रहेगा?" phir slots do.
- Caller naraaz ho ya shikayat kare:
  Shaant raho, ek line me maafi maango, aur madad offer karo. Behas mat karo.
- Galat number ya interest nahi:
  "कोई बात नहीं, आपका समय देने के लिए धन्यवाद। आपका दिन शुभ हो।"
- Property se alag sawaal:
  Ek line me vinamrata se property ki बात पर wapas aao.

## BOHOT ZAROORI
- Assistant call KABHI disconnect ya hang up nahi karegi. Call sirf caller hi kaatega. Caller ke phone rakhne tak shaanti se line par bani raho.

## CURRENT STATE
${JSON.stringify(state)}
${state.booked ? "Site visit book ho chuki hai. Dobara booking tag mat dena jab tak caller nayi visit na maange." : ""}

## OUTPUT FORMAT (strict)
Pehle sirf bola jaane wala natural Hindi response. Uske BAAD, aakhir me:
${TAGS.draftStart}{"clientName":"<naam>","nameConfirmed":<true/false>,"propertyType":"<Flat/Villa/Plot/Commercial>","preferredLocation":"<Civil Lines/Ganga Barrage/Kalyanpur/MG Road>","budget":"<e.g. ₹45-50 लाख>","projectName":"<City Greens Residency/Royal Palm Villas/Green Valley Plots/Apex Commercial Plaza>","date":"<YYYY-MM-DD>","time":"<10:00 AM | 2:00 PM | 5:30 PM>","reason":"<2 BHK Flat / Villa / Plot>"}${TAGS.draftEnd}
Site visit confirm hone par draft ke baad:
${TAGS.bookStart}{"clientName":"...","projectName":"...","date":"YYYY-MM-DD","time":"...","reason":"..."}${TAGS.bookEnd}
Caller bye/alvida kahe to speech ke baad: ${TAGS.endCall}
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
    max_tokens: 450,
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
  const generationConfig = { temperature: Number(process.env.LLM_TEMPERATURE || 0.35), maxOutputTokens: 450 };

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
  return "माफ़ कीजिए, आवाज़ थोड़ी कट गई थी, क्या आप दोबारा बताएँगे?";
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
