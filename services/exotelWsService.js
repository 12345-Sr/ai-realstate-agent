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
  endOfTurnMs: num(process.env.END_OF_TURN_MS, 950),
  maxUtteranceMs: num(process.env.MAX_UTTERANCE_MS, 15000),
  bargeIn: process.env.BARGE_IN !== "false",
  bargeInMs: num(process.env.BARGE_IN_MS, 320),
  bargeInGraceMs: num(process.env.BARGE_IN_GRACE_MS, 400),
  fillerAfterMs: num(process.env.FILLER_AFTER_MS, 2800),
  idleRepromptMs: num(process.env.IDLE_REPROMPT_MS, 9000),
  maxReprompts: num(process.env.MAX_REPROMPTS, 2),
  echoCooldownMs: num(process.env.ECHO_COOLDOWN_MS, 80),
  handoff: process.env.HUMAN_HANDOFF === "true",
};

const PHRASES = {
  greeting: realestateConfig.greeting,
  fillers: ["हम्म, एक सेकंड।", "जी, देख रही हूँ।", "अच्छा, एक पल।"],
  reprompts: ["हेलो, क्या आप लाइन पर हैं?", "मुझे आपकी आवाज़ नहीं आ रही, थोड़ा ज़ोर से बोलिए।"],
  goodbye: "लगता है लाइन में दिक्कत है। आप कभी भी दोबारा कॉल कर सकते हैं। धन्यवाद!",
  sorry: "माफ़ कीजिए, आवाज़ थोड़ी कट गई। एक बार फिर से बताएँगे?",
  emergency: "यह इमरजेंसी लग रही है। कृपया तुरंत एक सौ बारह पर कॉल करें, या नज़दीकी अस्पताल जाएँ।",
  emergencyFollowUp: "क्या आप किसी प्रॉपर्टी की जानकारी या साइट विज़िट के लिए बात करना चाहते हैं?",
  handoff: realestateConfig.handoffReply,
  closing: realestateConfig.closingReply || "बात करने के लिए धन्यवाद, आपका दिन शुभ हो!",
};

const EMERGENCY_RE =
  /(?:सीने|छाती)\s*में\s*(?:बहुत\s*)?(?:तेज़?|भयंकर)\s*दर्द|हार्ट\s*अटैक|heart\s*attack|(?:सांस|साँस)\s*(?:नहीं\s*(?:आ|ले)|लेने\s*में\s*(?:बहुत\s*)?(?:दिक्कत|तकलीफ))|बेहोश|unconscious|एक्सीडेंट|accident|दुर्घटना|खून\s*(?:बह|निकल)|लकवा|स्ट्रोक|stroke|ज़हर|जहर\s*खा|दौरा\s*पड़|suicide|आत्महत्या/i;
const HANDOFF_RE =
  /(?:किसी\s*)?(?:इंसान|आदमी|व्यक्ति|एजेंट|प्रॉपर्टी\s*मैनेजर|मैनेजर|ऑपरेटर|staff|human|operator|agent|manager|real\s*person)\s*(?:से)?\s*(?:बात|जोड़|connect|transfer)/i;
const CALL_CLOSE_RE =
  /(?:आपका\s*दिन\s*शुभ\s*हो|दिन\s*शुभ\s*हो|apka\s*din\s*shubh\s*ho|shubh\s*din|have\s*a\s*(?:nice|great|good)\s*day)/i;
const USER_GOODBYE_RE =
  /(?:^(?:ठीक\s*है|अच्छा|ओके|ok)?\s*(?:बाय|अलविदा|bye|goodbye|tata|टाटा)\b)|(?:(?:बाय|bye)\s*(?:बाय|bye)?$)|(?:^(?:बस\s*इतना\s*ही|और\s*कुछ\s*नहीं)\s*$)/i;

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
    } catch { }
    console.log(`[ws-upgrade] 🔌 WebSocket connection request on: ${request.url} (path: ${pathname})`);
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });

  wss.on("connection", (ws, req) => handleCall(ws, deps, httpServer.activeCalls, req));
  return wss;
}

function handleCall(ws, deps, activeCalls, req) {
  const { ai, tts, booking, CallLog } = deps;
  const db = (p) => Promise.resolve(p).catch((e) => console.error("[db]", e.message));

  let streamSid = null;
  let callSid = null;
  let session = null;
  let sampleRate = 8000;
  let callStart = Date.now();
  let closed = false;

  // Extract query parameters from WS request URL if present
  let urlParams = {};
  if (req && req.url) {
    try {
      const parsed = new URL(req.url, "http://localhost");
      urlParams = Object.fromEntries(parsed.searchParams.entries());
    } catch {}
  }
  if (urlParams.CallSid || urlParams.callSid || urlParams.call_sid) {
    callSid = urlParams.CallSid || urlParams.callSid || urlParams.call_sid;
  }
  if (urlParams.stream_sid || urlParams.streamSid) {
    streamSid = urlParams.stream_sid || urlParams.streamSid;
  }

  // Frame math (Exotel: >= 3200 bytes, multiple of 320)
  let FRAME_BYTES = 3200;
  let FRAME_MS = 200;
  let LEAD_MS = 400;
  const setRate = (r) => {
    sampleRate = r;
    const bytesPer100ms = Math.round((r * 2 * 0.1) / 320) * 320;
    FRAME_BYTES = Math.max(3200, bytesPer100ms);
    FRAME_MS = (FRAME_BYTES / (r * 2)) * 1000;
    LEAD_MS = Math.max(1000, FRAME_MS * 4);
  };
  setRate(8000);

  const log = (...a) => console.log(`[call ${callSid ? callSid.slice(-6) : "------"}]`, ...a);

  // ------------------------------------------------------------ outbound
  let sentFrames = 0;
  let inFrames = 0;
  let chunkCount = 0;

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) {
      const payload = { ...obj };
      const sid = streamSid || "default";
      payload.stream_sid = sid;
      payload.streamSid = sid;
      try {
        ws.send(JSON.stringify(payload));
      } catch (err) {
        console.error("[ws-send] error:", err.message);
      }
    }
  };
  const sendMedia = (buf) => {
    sentFrames++;
    if (sentFrames === 1 || sentFrames % 40 === 0) {
      log(`🔊 Outbound audio frame #${sentFrames} (${buf.length}B, sid=${streamSid})`);
    }
    send({
      event: "media",
      media: {
        payload: buf.toString("base64"),
      },
    });
  };
  const sendClear = () => {
    send({ event: "clear" });
  };
  const sendMark = (name) => {
    send({
      event: "mark",
      mark: { name },
    });
  };

  let current = null; // active playback
  let playSeq = 0;
  let cooldownUntil = 0;
  const isBotSpeaking = () => Boolean(current);

  function play(text, { cacheable = false, noBargeIn = false } = {}) {
    if (!text || closed) return Promise.resolve(false);
    if (current) stopPlayback("replaced");
    clearIdle();
    const id = ++playSeq;
    const p = { id, ac: new AbortController(), pending: Buffer.alloc(0), sentMs: 0, startAt: 0, ttsDone: false, finished: false, startedAt: Date.now(), text, noBargeIn };
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
        if (frame.length < FRAME_BYTES) {
          const actualFrame = Buffer.from(frame);
          const sampleCount = Math.floor(actualFrame.length / 2);
          const rampSamples = Math.min(40, sampleCount);
          for (let i = 0; i < rampSamples; i++) {
            const idx = (sampleCount - rampSamples + i) * 2;
            const val = actualFrame.readInt16LE(idx);
            const factor = (rampSamples - i) / rampSamples;
            actualFrame.writeInt16LE(Math.round(val * factor), idx);
          }
          frame = Buffer.concat([actualFrame, Buffer.alloc(FRAME_BYTES - actualFrame.length)]);
        }
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
    while (preRollMs > 360 && preRoll.length > 1) preRollMs -= (preRoll.shift().length / (sampleRate * 2)) * 1000;

    const speechThr = Math.max(380, Math.min(1800, noiseFloor * 1.6 + 100));
    const keepThr = speechThr * 0.55;

    // Bot is talking: only a clear, sustained voice counts as barge-in
    if (isBotSpeaking()) {
      if (current?.noBargeIn) return;
      if (!CONF.bargeIn || Date.now() - current.startedAt < CONF.bargeInGraceMs) return;
      const bargeThr = Math.max(700, speechThr * 1.25);
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
        if (loudRun >= 40) {
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
    if (pcm.length < sampleRate * 2 * 0.15) return;
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
    const isFirstTurn = !session.messages || session.messages.filter((m) => m.role === "user").length === 0;

    // Caller goodbye: only allowed AFTER turn 1 (never hang up on the opening greeting)
    if (!isFirstTurn && USER_GOODBYE_RE.test(userText)) {
      commitUser(turn, userText);
      const name = session.clientName || session.patientName;
      const closing = name
        ? `बात करने के लिए बहुत-बहुत धन्यवाद ${String(name).split(/\s+/)[0]} जी! आपका दिन शुभ हो।`
        : PHRASES.closing;
      commitAssistant(closing);
      await play(closing, { cacheable: true });
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
          ...(session.patientName ? { $set: { patientName: session.patientName, clientName: session.patientName, callerName: session.patientName } } : {}),
        }
      )
    );
  }

  function applyDraft(draft) {
    if (!draft) return;
    const clientNameInput = draft.clientName || draft.patientName;
    if (clientNameInput && !draft.patientName) draft.patientName = clientNameInput;
    const projectNameInput = draft.projectName || draft.doctorName;
    if (projectNameInput && !draft.doctorName) draft.doctorName = projectNameInput;

    applyAiDraft(session, draft, toEnglishName);
    if (!session.nameConfirmed && /[ऀ-ॿ]/.test(clientNameInput || "") && !isInvalidPatientName(clientNameInput)) {
      session.patientNameSpoken = clientNameInput.trim();
    }
    if (draft.propertyType) session.propertyType = draft.propertyType;
    if (draft.budget) session.budget = draft.budget;
    if (draft.preferredLocation || draft.location) {
      session.preferredLocation = draft.preferredLocation || draft.location;
    }
    const doc = booking.normalizeDoctor(projectNameInput);
    if (doc) {
      session.doctorName = doc.name;
      session.projectName = doc.name;
    }
    const shift = booking.normalizeShift(draft.time);
    if (shift) session.selectedTime = shift.time;
    const date = booking.resolveDate(draft.date);
    if (date) session.date = date;
    if (draft.reason) session.reason = String(draft.reason).slice(0, 120);
  }

  async function handleBooking(req, llmSpeech, userText) {
    const rawReqName = req.clientName || req.patientName;
    let name = session.patientName && !isInvalidPatientName(session.patientName) ? session.patientName : null;
    if (!name && rawReqName && !isInvalidPatientName(rawReqName)) name = toEnglishName(rawReqName);
    const request = {
      doctorName: req.projectName || req.doctorName || session.doctorName,
      projectName: req.projectName || req.doctorName || session.doctorName,
      date: req.date || session.date,
      time: req.time || session.selectedTime,
      reason: req.reason || session.reason,
    };

    // Guard: LLM kabhi-kabhi caller ki "haan" ke bina hi booking tag de deta hai.
    // Caller ne abhi haan nahi bola => khud read-back karke poocho.
    if (classifyConfirmation(userText) !== "yes") {
      const doc = booking.normalizeDoctor(request.projectName || request.doctorName);
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
      clientName: name,
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
        { $set: { appointmentBooked: true, patientName: appt.patientName, clientName: appt.patientName, callerName: appt.patientName } }
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
    if (closed || handingOff) return;
    idleTimer = setTimeout(async () => {
      if (isBotSpeaking() || capturing || (inflight && !inflight.committed) || pendingText) return armIdle();
      if (reprompts >= CONF.maxReprompts) {
        log("💤 caller silent");
        const line = PHRASES.goodbye;
        session.messages.push({ role: "assistant", content: line });
        await play(line, { cacheable: true });
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

  let started = false;
  function onStart(data = {}) {
    if (started) return;
    started = true;
    clearTimeout(safetyStartTimer);
    const st = data.start || {};
    streamSid =
      data.stream_sid ||
      data.streamSid ||
      data.StreamSid ||
      st.stream_sid ||
      st.streamSid ||
      st.StreamSid ||
      data.stream_id ||
      st.stream_id ||
      data.streamId ||
      st.streamId ||
      streamSid ||
      "default";
    callSid =
      st.call_sid ||
      st.callSid ||
      st.CallSid ||
      data.call_sid ||
      data.callSid ||
      data.CallSid ||
      st.call_id ||
      st.callId ||
      data.call_id ||
      data.callId ||
      st.CallUUID ||
      data.CallUUID ||
      callSid ||
      `EXO_${Date.now()}`;
    callStart = Date.now();
    const rate = parseInt(
      st.media_format?.sample_rate ||
      st.mediaFormat?.sampleRate ||
      st.media_format?.sampleRate ||
      data.media_format?.sample_rate ||
      data.mediaFormat?.sampleRate ||
      st.sample_rate ||
      st.sampleRate ||
      8000,
      10
    );
    if ([8000, 16000, 24000].includes(rate)) setRate(rate);
    activeCalls.add(callSid);

    session = getSession(callSid);
    const from =
      st.from ||
      st.From ||
      st.caller ||
      st.Caller ||
      st.custom_parameters?.from ||
      st.customParameters?.from ||
      data.from ||
      data.From;
    if (from) {
      session.callerPhone = from;
      session.region = detectRegion(from);
    }
    const to = st.to || st.To || data.to || data.To;
    log(`📞 start from=${from || "?"} to=${to || "?"} sid=${streamSid} callSid=${callSid} rate=${sampleRate} frame=${FRAME_BYTES}B`);

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

  // Safety timer: agar Exotel ne explicit "start" event na bheja ho to 2500ms me greeting shuru
  const safetyStartTimer = setTimeout(() => {
    if (!started && !closed) {
      log("⚡ Safety: starting call greeting after 2500ms without explicit 'start' event");
      onStart({});
    }
  }, 2500);

  function finishCall(reason) {
    if (closed) return;
    closed = true;
    clearTimeout(safetyStartTimer);
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

    const incomingStream =
      data.stream_sid ||
      data.streamSid ||
      data.StreamSid ||
      data.start?.stream_sid ||
      data.start?.streamSid ||
      data.start?.StreamSid ||
      data.media?.stream_sid ||
      data.media?.streamSid ||
      data.stream_id ||
      data.streamId;
    if (incomingStream && (!streamSid || streamSid === "default")) {
      streamSid = incomingStream;
      log(`🎯 Captured streamSid=${streamSid} from event=${data.event}`);
    }

    if (data.event !== "media") {
      log(`📥 Exotel event: "${data.event}" | payload: ${JSON.stringify(data).slice(0, 300)}`);
    }

    switch (data.event) {
      case "connected":
        if (data.stream_sid || data.streamSid) streamSid = data.stream_sid || data.streamSid;
        log(`🔌 Exotel stream connected: ${streamSid || "ready"}`);
        break;
      case "start":
        onStart(data);
        break;
      case "media": {
        if (!started) {
          log("⚡ Starting call greeting on first incoming media event");
          onStart(data);
        }
        const payload = data.media?.payload || data.media?.Payload || data.payload;
        if (session && payload) onAudio(Buffer.from(payload, "base64"));
        break;
      }
      case "mark": {
        const name = data.mark?.name || data.mark?.Name || data.name;
        if (current && name === `p${current.id}` && current.ttsDone && !current.pending.length) current.finish(true);
        break;
      }
      case "dtmf": {
        const digit = data.dtmf?.digit || data.dtmf?.Digit || data.digit;
        log(`🔢 DTMF ${digit}`);
        if (digit === "0" && CONF.handoff && !handingOff) {
          stopPlayback("dtmf");
          handoff("dtmf_0");
        }
        break;
      }
      case "stop":
        finishCall(data.stop?.reason || data.reason || "stop");
        break;
    }
  });
  ws.on("close", (code, reason) => {
    clearTimeout(safetyStartTimer);
    log(`⚠️ WebSocket closed: code=${code}, reason="${reason?.toString() || ""}"`);
    finishCall(`ws_close_${code}`);
  });
  ws.on("error", (err) => console.error(`[call ${callSid ? callSid.slice(-6) : "------"}] ❌ WebSocket error:`, err.message));
}

module.exports = { setupExotelWebSocketServer, PHRASES, CONF };
