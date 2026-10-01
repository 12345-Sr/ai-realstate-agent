/**
 * Exotel Voicebot (bidirectional AgentStream) WebSocket handler.
 *
 * Major fixes vs old version:
 *  1. Outbound audio 320-byte (20 ms) chunks me jaata tha. Exotel ka rule:
 *     "Minimum 3.2 KB, maximum 100 KB, multiple of 320" — chhote chunks = toota
 *     /robotic audio. Ab >= 3200-byte frames.
 *  2. Barge-in: bot bolte waqt caller ka SAARA audio ignore hota tha;
 *     `clearExotelBuffer()` kabhi call hi nahi hota tha. Ab caller bole to bot
 *     ruk jaata hai (Exotel "clear" + TTS abort).
 *  3. Overlapping turns: STT+LLM ke 2-3 s me caller "hello?" bole to doosra turn
 *     parallel chal jaata tha -> do jawab, messages ulte, double booking.
 *     Ab turns serialize; naya speech aaye to purana LLM call abort + text merge.
 *  4. Har turn pe regex se doctor/time overwrite ("हाथ" -> ortho, "शाम" -> 5:30)
 *     aur ek baar set hone ke baad caller badal nahi sakta tha. Hataya; LLM draft
 *     + server validation.
 *  5. Booking bina validation seedha DB me. Ab bookingService (doctor day, past
 *     slot, capacity, duplicate) — confirmation SAVED record se bolte hain.
 *  6. Dead air: LLM slow ho to chhota filler ("हम्म, एक सेकंड"); caller chup ho
 *     to reprompt; emergency keywords pe turant deterministic jawab; "इंसान से
 *     बात" pe handoff (stream close -> Exotel flow ka agla applet).
 *  7. Playback end "mark" event se track; end-of-turn 1.4 s -> 0.8 s.
 */
const { WebSocketServer } = require("ws");
const realestateConfig = require("../config/realestateConfig");
const { getSession, clearSession, detectRegion } = require("../utils/sessions");
const { extractPatientNameFromSpeech, parseSpelledName, toEnglishName } = require("../utils/transliterate");
const { applyCallerTurn, applyAiDraft, isInvalidPatientName, classifyConfirmation } = require("../utils/nameState");
const { getClock, relativeDayLabel } = require("./propertyKnowledge");
const { calculatePcmRms, analyzeVoiceActivity } = require("../utils/audioDsp");

const heuristics = { parseSpelledName, extractPatientNameFromSpeech };

const num = (v, d) => (v === undefined || v === "" || isNaN(Number(v)) ? d : Number(v));
const CONF = {
  endOfTurnMs: num(process.env.END_OF_TURN_MS, 850),
  maxUtteranceMs: num(process.env.MAX_UTTERANCE_MS, 15000),
  bargeIn: process.env.BARGE_IN !== "false",
  bargeInMs: num(process.env.BARGE_IN_MS, 180),
  bargeInGraceMs: num(process.env.BARGE_IN_GRACE_MS, 200),
  fillerAfterMs: num(process.env.FILLER_AFTER_MS, 2200),
  idleRepromptMs: num(process.env.IDLE_REPROMPT_MS, 9000),
  maxReprompts: num(process.env.MAX_REPROMPTS, 2),
  echoCooldownMs: num(process.env.ECHO_COOLDOWN_MS, 200),
  handoff: process.env.HUMAN_HANDOFF === "true",
};

const PHRASES = {
  greeting: realestateConfig.greeting,
  fillers: ["हम्म, एक सेकंड।", "जी, देख रही हूँ।", "अच्छा, एक पल।"],
  reprompts: ["हेलो, क्या आप लाइन पर हैं?", "मुझे आपकी आवाज़ नहीं आ रही, थोड़ा ज़ोर से बोलिए।"],
  goodbye: "लगता है लाइन में दिक्कत है। आप कभी भी दोबारा कॉल कर सकते हैं। धन्यवाद!",
  sorry: "माफ़ कीजिए, आवाज़ थोड़ी कट गई। एक बार फिर से बताएँगे?",
  emergency: "कृपया तुरंत आपातकालीन हेल्पलाइन 112 पर कॉल करें।",
  emergencyFollowUp: "क्या आप किसी प्रॉपर्टी की जानकारी या साइट विज़िट के लिए बात करना चाहते हैं?",
  handoff: realestateConfig.handoffReply,
};

const EMERGENCY_RE =
  /(?:सीने|छाती)\s*में\s*(?:बहुत\s*)?(?:तेज़?|भयंकर)\s*दर्द|हार्ट\s*अटैक|heart\s*attack|(?:सांस|साँस)\s*(?:नहीं\s*(?:आ|ले)|लेने\s*में\s*(?:बहुत\s*)?(?:दिक्कत|तकलीफ))|बेहोश|unconscious|एक्सीडेंट|accident|दुर्घटना|खून\s*(?:बह|निकल)|लकवा|स्ट्रोक|stroke|ज़हर|जहर\s*खा|दौरा\s*पड़|suicide|आत्महत्या/i;
const HANDOFF_RE =
  /(?:किसी\s*)?(?:इंसान|आदमी|व्यक्ति|रिसेप्शन|रिसेप्शनिस्ट|ऑपरेटर|मैनेजर|staff|human|operator|receptionist|real\s*person)\s*(?:से)?\s*(?:बात|जोड़|connect|transfer)/i;

function defaultDeps() {
  return {
    stt: require("./sttService").transcribePcmAudio,
    ai: require("./aiService"),
    tts: require("./ttsService"),
    booking: require("./bookingService"),
    CallLog: require("../models/CallLog"),
  };
}

function setupExotelWebSocketServer(httpServer, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  httpServer.activeCalls = new Set();

  httpServer.on("upgrade", (request, socket, head) => {
    let pathname = "";
    try {
      pathname = new URL(request.url, "http://x").pathname;
    } catch {}
    if (["/exotel/media", "/media", "/stream"].includes(pathname)) {
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (ws) => handleCall(ws, deps, httpServer.activeCalls));
  return wss;
}

function handleCall(ws, deps, activeCalls) {
  const { ai, tts, booking, CallLog } = deps;
  const db = (p) => Promise.resolve(p).catch((e) => console.error("[db]", e.message));

  let streamSid = null;
  let callSid = null;
  let session = null;
  let sampleRate = 8000;
  let callStart = Date.now();
  let closed = false;

  // Frame math (Exotel: >= 3200 bytes, multiple of 320)
  let FRAME_BYTES = 3200;
  let FRAME_MS = 200;
  let LEAD_MS = 400;
  const setRate = (r) => {
    sampleRate = r;
    const bytesPer100ms = Math.round((r * 2 * 0.1) / 320) * 320;
    FRAME_BYTES = Math.max(3200, bytesPer100ms);
    FRAME_MS = (FRAME_BYTES / (r * 2)) * 1000;
    LEAD_MS = Math.max(400, FRAME_MS * 2);
  };
  setRate(8000);

  const log = (...a) => console.log(`[call ${callSid ? callSid.slice(-6) : "------"}]`, ...a);

  // ------------------------------------------------------------ outbound
  const send = (obj) => {
    if (ws.readyState === ws.OPEN && streamSid) ws.send(JSON.stringify({ ...obj, stream_sid: streamSid }));
  };
  const sendMedia = (buf) => send({ event: "media", media: { payload: buf.toString("base64") } });
  const sendClear = () => send({ event: "clear" });
  const sendMark = (name) => send({ event: "mark", mark: { name } });

  let current = null; // active playback
  let playSeq = 0;
  let cooldownUntil = 0;
  const isBotSpeaking = () => Boolean(current);

  function play(text, { cacheable = false } = {}) {
    if (!text || closed) return Promise.resolve(false);
    if (current) stopPlayback("replaced");
    clearIdle();
    const id = ++playSeq;
    const p = { id, ac: new AbortController(), pending: Buffer.alloc(0), sentMs: 0, startAt: 0, ttsDone: false, finished: false, startedAt: Date.now(), text };
    current = p;
    let resolveDone;
    p.done = new Promise((r) => (resolveDone = r));
    p.finish = (completed) => {
      if (p.finished) return;
      p.finished = true;
      clearInterval(p.timer);
      clearTimeout(p.endTimer);
      if (current === p) {
        current = null;
        cooldownUntil = Date.now() + CONF.echoCooldownMs;
        resetCapture();
        armIdle();
      }
      resolveDone(completed);
    };

    const pump = () => {
      if (p.finished) return;
      const now = Date.now();
      while (p.pending.length >= FRAME_BYTES || (p.ttsDone && p.pending.length > 0)) {
        const ahead = p.startAt ? p.sentMs - (now - p.startAt) : 0;
        if (ahead > LEAD_MS) break;
        let frame = p.pending.subarray(0, FRAME_BYTES);
        p.pending = p.pending.subarray(frame.length);
        if (frame.length < FRAME_BYTES) frame = Buffer.concat([frame, Buffer.alloc(FRAME_BYTES - frame.length)]);
        if (!p.startAt) p.startAt = now;
        sendMedia(frame);
        p.sentMs += FRAME_MS;
      }
      if (p.ttsDone && !p.pending.length && !p.endTimer) {
        if (!p.sentMs) return p.finish(false);
        sendMark(`p${id}`);
        const remaining = Math.max(0, p.sentMs - (Date.now() - p.startAt));
        p.endTimer = setTimeout(() => p.finish(true), remaining + 200);
      }
    };
    p.timer = setInterval(pump, 20);

    log(`🤖 "${text}"`);
    tts
      .speakToPcm(text, sampleRate, {
        signal: p.ac.signal,
        cacheable,
        onChunk: async (b) => {
          if (p.finished) return;
          p.pending = p.pending.length ? Buffer.concat([p.pending, b]) : b;
          pump();
        },
      })
      .then((bytes) => {
        if (!bytes && !p.ac.signal.aborted) console.error("[tts] all engines failed for:", text);
      })
      .catch((err) => {
        if (!p.ac.signal.aborted) console.error("[tts] error:", err.message);
      })
      .finally(() => {
        p.ttsDone = true;
        pump();
      });

    return p.done;
  }

  function stopPlayback(reason) {
    if (!current) return;
    const p = current;
    log(`⚡ playback stopped (${reason})`);
    p.ac.abort();
    sendClear();
    p.finish(false);
  }

  // ------------------------------------------------------------ inbound VAD
  let capturing = false;
  let captureChunks = [];
  let captureMs = 0;
  let loudRun = 0;
  let silenceMs = 0;
  let bargeLoudMs = 0;
  let preRoll = [];
  let preRollMs = 0;
  let noiseFloor = 280;

  function resetCapture() {
    capturing = false;
    captureChunks = [];
    captureMs = 0;
    loudRun = 0;
    silenceMs = 0;
    bargeLoudMs = 0;
  }

  function onAudio(chunk) {
    const chunkMs = (chunk.length / (sampleRate * 2)) * 1000;
    if (!chunkMs) return;
    const rms = calculatePcmRms(chunk);

    preRoll.push(chunk);
    preRollMs += chunkMs;
    while (preRollMs > 240 && preRoll.length > 1) preRollMs -= (preRoll.shift().length / (sampleRate * 2)) * 1000;

    const speechThr = Math.max(700, Math.min(2400, noiseFloor * 2.2 + 200));
    const keepThr = speechThr * 0.65;

    // Bot is talking: only a clear, sustained voice counts as barge-in
    if (isBotSpeaking()) {
      if (!CONF.bargeIn || Date.now() - current.startedAt < CONF.bargeInGraceMs) return;
      const bargeThr = Math.max(650, speechThr * 1.15);
      bargeLoudMs = rms > bargeThr ? bargeLoudMs + chunkMs : Math.max(0, bargeLoudMs - chunkMs);
      if (bargeLoudMs >= CONF.bargeInMs) {
        stopPlayback("barge-in");
        cooldownUntil = 0;
        capturing = true;
        captureChunks = [...preRoll];
        captureMs = preRollMs;
      }
      return;
    }
    if (Date.now() < cooldownUntil) return;

    if (!capturing) {
      if (rms > speechThr) {
        loudRun += chunkMs;
        if (loudRun >= 60) {
          capturing = true;
          clearIdle();
          captureChunks = [...preRoll];
          captureMs = preRollMs;
          silenceMs = 0;
        }
      } else {
        loudRun = 0;
        noiseFloor = rms > noiseFloor ? noiseFloor * 0.94 + rms * 0.06 : noiseFloor * 0.98 + rms * 0.02;
        noiseFloor = Math.min(1400, Math.max(150, noiseFloor));
      }
      return;
    }

    captureChunks.push(chunk);
    captureMs += chunkMs;
    silenceMs = rms <= keepThr ? silenceMs + chunkMs : 0;

    if (silenceMs >= CONF.endOfTurnMs || captureMs >= CONF.maxUtteranceMs) {
      const pcm = Buffer.concat(captureChunks);
      resetCapture();
      onUtterance(pcm);
    }
  }

  // ------------------------------------------------------------ turns
  let sttChain = Promise.resolve();
  let pendingText = "";
  let inflight = null; // { ac, committed }
  let reprompts = 0;
  let emergencyWarned = false;
  let handingOff = false;

  function onUtterance(pcm) {
    if (pcm.length < sampleRate * 2 * 0.3) return;
    const vad = analyzeVoiceActivity(pcm, sampleRate);
    if (!vad.isGenuineSpeech) {
      armIdle();
      return;
    }
    // STT serialized => transcripts stay in spoken order
    sttChain = sttChain
      .then(() => deps.stt(pcm, sampleRate))
      .then((text) => {
        if (!text || text.length < 2) {
          armIdle();
          return;
        }
        log(`👤 "${text}"`);
        reprompts = 0;
        pendingText = pendingText ? `${pendingText} ${text}` : text;
        respond();
      })
      .catch((e) => console.error("[stt]", e.message));
  }

  async function respond() {
    if (closed || handingOff) return;
    // New speech before the previous reply was committed => cancel it, merge text
    if (inflight && !inflight.committed) {
      inflight.ac.abort();
      log("↩️  merged with previous unanswered turn");
    }
    const turn = { ac: new AbortController(), committed: false };
    inflight = turn;
    const userText = pendingText;
    clearIdle();

    // --- deterministic safety paths (no LLM) ---
    if (EMERGENCY_RE.test(userText) && !emergencyWarned) {
      emergencyWarned = true;
      commitUser(turn, userText);
      const line = `${PHRASES.emergency} ${PHRASES.emergencyFollowUp}`;
      commitAssistant(line);
      db(CallLog.updateOne({ callSid }, { $set: { flagged: "emergency" } }));
      await play(line);
      return;
    }
    if (CONF.handoff && HANDOFF_RE.test(userText)) {
      commitUser(turn, userText);
      commitAssistant(PHRASES.handoff);
      await handoff("caller_request");
      return;
    }

    applyCallerTurn(session, userText, heuristics);

    let fillerPlayback = null;
    const fillerTimer = setTimeout(() => {
      if (!turn.ac.signal.aborted && !isBotSpeaking() && !capturing) {
        fillerPlayback = play(PHRASES.fillers[Math.floor(Math.random() * PHRASES.fillers.length)], { cacheable: true });
      }
    }, CONF.fillerAfterMs);

    let raw;
    try {
      const availabilityText = await booking.getAllAvailabilityText();
      raw = await ai.getAIReply([...session.messages, { role: "user", content: userText }], session, {
        signal: turn.ac.signal,
        availabilityText,
      });
    } catch (err) {
      if (turn.ac.signal.aborted) return clearTimeout(fillerTimer);
      console.error("[ai]", err.message);
      raw = PHRASES.sorry;
    }
    clearTimeout(fillerTimer);
    if (turn.ac.signal.aborted || inflight !== turn || closed) return;

    commitUser(turn, userText);
    const { speech: llmSpeech, draft, booking: bookReq } = ai.parseReply(raw);
    applyDraft(draft);

    let speech = llmSpeech;
    if (bookReq) {
      try {
        speech = await handleBooking(bookReq, llmSpeech, userText);
      } catch (err) {
        console.error("[booking] error:", err.message);
        speech = "माफ़ कीजिए, अभी बुकिंग सेव नहीं हो पाई। थोड़ी देर में दोबारा कॉल कर लीजिए, या मैं रिसेप्शन का नंबर बता दूँ?";
      }
    }
    if (!speech) speech = PHRASES.sorry;

    commitAssistant(speech);
    if (fillerPlayback) await fillerPlayback; // filler ko beech me mat kaato
    if (inflight !== turn || closed) return;
    await play(speech);
  }

  function commitUser(turn, text) {
    turn.committed = true;
    pendingText = "";
    session.messages.push({ role: "user", content: text });
    db(CallLog.updateOne({ callSid }, { $push: { transcript: { role: "caller", text, timestamp: new Date() } } }));
  }

  function commitAssistant(text) {
    session.messages.push({ role: "assistant", content: text });
    db(
      CallLog.updateOne(
        { callSid },
        {
          $push: { transcript: { role: "assistant", text, timestamp: new Date() } },
          ...(session.patientName ? { $set: { patientName: session.patientName, callerName: session.patientName } } : {}),
        }
      )
    );
  }

  function applyDraft(draft) {
    if (!draft) return;
    applyAiDraft(session, draft, toEnglishName);
    if (!session.nameConfirmed && /[ऀ-ॿ]/.test(draft.patientName || "") && !isInvalidPatientName(draft.patientName)) {
      session.patientNameSpoken = draft.patientName.trim();
    }
    const doc = booking.normalizeDoctor(draft.doctorName);
    if (doc) session.doctorName = doc.name;
    const shift = booking.normalizeShift(draft.time);
    if (shift) session.selectedTime = shift.time;
    const date = booking.resolveDate(draft.date);
    if (date) session.date = date;
    if (draft.reason) session.reason = String(draft.reason).slice(0, 120);
  }

  async function handleBooking(req, llmSpeech, userText) {
    let name = session.patientName && !isInvalidPatientName(session.patientName) ? session.patientName : null;
    if (!name && req.patientName && !isInvalidPatientName(req.patientName)) name = toEnglishName(req.patientName);
    const request = {
      doctorName: req.doctorName || session.doctorName,
      date: req.date || session.date,
      time: req.time || session.selectedTime,
      reason: req.reason || session.reason,
    };

    // Guard: LLM kabhi-kabhi caller ki "haan" ke bina hi booking tag de deta hai.
    // Caller ne abhi haan nahi bola => khud read-back karke poocho.
    if (classifyConfirmation(userText) !== "yes") {
      const doc = booking.normalizeDoctor(request.doctorName);
      const shift = booking.normalizeShift(request.time);
      const date = booking.resolveDate(request.date);
      if (doc && shift && date && name) {
        const who = (session.patientNameSpoken || name).split(/\s+/)[0];
        log("📅 booking tag without caller 'yes' — asking read-back");
        return `तो ${who} जी, ${doc.hindiName}, ${relativeDayLabel(date, getClock().todayIso)} ${shift.spoken}, बुक कर दूँ?`;
      }
    }

    const result = await booking.validateAndBook({
      request,
      patientName: name,
      phone: session.callerPhone,
      callSid,
    });

    if (!result.ok) {
      log(`📅 booking rejected: ${result.reason}`);
      return result.speech || llmSpeech;
    }
    const appt = result.appointment;
    session.nameConfirmed = true;
    session.patientName = appt.patientName;
    session.appointmentBooked = true;
    session.appointments.push(String(appt._id));
    log(`✅ booked ${appt.patientName} | ${appt.doctorName} | ${appt.date} ${appt.time}${result.duplicate ? " (dup)" : ""}`);
    db(
      CallLog.updateOne(
        { callSid },
        { $set: { appointmentBooked: true, patientName: appt.patientName, callerName: appt.patientName } }
      )
    );
    return booking.confirmationSpeech(appt, { spokenName: session.patientNameSpoken });
  }

  async function handoff(reason) {
    handingOff = true;
    log(`☎️  handoff (${reason})`);
    db(CallLog.updateOne({ callSid }, { $set: { handoff: reason } }));
    await play(PHRASES.handoff, { cacheable: true });
    // Stream band => Exotel flow ka AGLA applet chalega (e.g. Connect -> reception)
    setTimeout(() => ws.close(1000, "handoff"), 300);
  }

  // ------------------------------------------------------------ idle reprompt
  let idleTimer = null;
  function clearIdle() {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  function armIdle() {
    clearIdle();
    if (closed || handingOff || !streamSid) return;
    idleTimer = setTimeout(async () => {
      if (isBotSpeaking() || capturing || (inflight && !inflight.committed) || pendingText) return armIdle();
      if (reprompts >= CONF.maxReprompts) {
        log("💤 caller silent — ending");
        handingOff = true;
        await play(PHRASES.goodbye, { cacheable: true });
        setTimeout(() => ws.close(1000, "silence"), 300);
        return;
      }
      const line = PHRASES.reprompts[reprompts++] || PHRASES.reprompts[0];
      session.messages.push({ role: "assistant", content: line });
      play(line, { cacheable: true });
    }, CONF.idleRepromptMs);
  }

  // ------------------------------------------------------------ Exotel events
  async function fetchCallDetails() {
    const { EXOTEL_API_KEY: k, EXOTEL_API_TOKEN: t, EXOTEL_SID: sid } = process.env;
    if (!k || !t || !sid || !callSid || callSid.startsWith("EXO_")) return;
    try {
      const res = await fetch(`https://api.exotel.com/v1/Accounts/${sid}/Calls/${callSid}.json`, {
        headers: { Authorization: "Basic " + Buffer.from(`${k}:${t}`).toString("base64") },
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return;
      const c = (await res.json())?.Call;
      if (!c) return;
      if (c.From && session && !session.callerPhone) {
        session.callerPhone = c.From;
        if (!session.region) session.region = detectRegion(c.From);
      }
      const duration = parseInt(c.Duration, 10) || 0;
      await db(CallLog.updateOne({ callSid }, { $set: { from: c.From, to: c.To, ...(duration ? { durationSeconds: duration } : {}) } }));
    } catch (err) {
      console.warn("[exotel] call details:", err.message);
    }
  }

  function onStart(data) {
    const st = data.start || {};
    streamSid = data.stream_sid || st.stream_sid;
    callSid = st.call_sid || data.call_sid || `EXO_${Date.now()}`;
    callStart = Date.now();
    const rate = parseInt(st.media_format?.sample_rate || 8000, 10);
    if ([8000, 16000, 24000].includes(rate)) setRate(rate);
    activeCalls.add(callSid);

    session = getSession(callSid);
    const from = st.from || st.custom_parameters?.from || data.from;
    if (from) {
      session.callerPhone = from;
      session.region = detectRegion(from);
    }
    log(`📞 start from=${from || "?"} rate=${sampleRate} frame=${FRAME_BYTES}B`);

    if (!session.messages.length || session.messages[session.messages.length - 1].content !== PHRASES.greeting) {
      session.messages.push({ role: "assistant", content: PHRASES.greeting });
    }
    db(
      CallLog.findOneAndUpdate(
        { callSid },
        {
          $setOnInsert: { callSid, direction: "inbound", startedAt: new Date(), ...(from ? { from } : {}), ...(st.to ? { to: st.to } : {}) },
          $push: { transcript: { role: "assistant", text: PHRASES.greeting, timestamp: new Date() } },
        },
        { upsert: true }
      )
    );
    if (!from) fetchCallDetails();
    play(PHRASES.greeting, { cacheable: true });
  }

  function finishCall(reason) {
    if (closed) return;
    closed = true;
    clearIdle();
    if (current) {
      current.ac.abort();
      current.finish(false);
    }
    if (inflight) inflight.ac.abort();
    if (!callSid) return;
    activeCalls.delete(callSid);
    log(`📴 ended (${reason})`);
    db(
      CallLog.updateOne(
        { callSid },
        { $set: { status: "completed", endedAt: new Date(), durationSeconds: Math.round((Date.now() - callStart) / 1000) } }
      )
    );
    fetchCallDetails();
    clearSession(callSid);
  }

  ws.on("message", (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    switch (data.event) {
      case "connected":
        break;
      case "start":
        onStart(data);
        break;
      case "media":
        if (session && data.media?.payload) onAudio(Buffer.from(data.media.payload, "base64"));
        break;
      case "mark": {
        const name = data.mark?.name;
        if (current && name === `p${current.id}` && current.ttsDone && !current.pending.length) current.finish(true);
        break;
      }
      case "dtmf": {
        const digit = data.dtmf?.digit;
        log(`🔢 DTMF ${digit}`);
        if (digit === "0" && CONF.handoff && !handingOff) {
          stopPlayback("dtmf");
          handoff("dtmf_0");
        }
        break;
      }
      case "stop":
        finishCall(data.stop?.reason || "stop");
        break;
    }
  });
  ws.on("close", () => finishCall("ws_close"));
  ws.on("error", (err) => console.error("[ws]", err.message));
}

module.exports = { setupExotelWebSocketServer, PHRASES, CONF };
