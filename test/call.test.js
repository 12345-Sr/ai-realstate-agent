/**
 * End-to-end call simulation: a fake Exotel client talks to the real WebSocket
 * handler over a real socket. STT / LLM / TTS / DB are stubbed; booking logic,
 * VAD, turn-taking, barge-in, framing and pacing are the real code.
 */
process.env.END_OF_TURN_MS = "300";
process.env.FILLER_AFTER_MS = "400";
process.env.IDLE_REPROMPT_MS = "60000";
process.env.BARGE_IN_GRACE_MS = "200";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const WebSocket = require("ws");
const { makeModels, pcm } = require("./helpers");
const booking = require("../services/bookingService");
const ai = require("../services/aiService");
const { setupExotelWebSocketServer, PHRASES } = require("../services/exotelWsService");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function harness({ sttQueue, aiScript, ttsMsPerChar = 12 }) {
  const mm = makeModels();
  Object.defineProperty(booking.models, "SlotCounter", { value: mm.SlotCounter, configurable: true });
  Object.defineProperty(booking.models, "Appointment", { value: mm.Appointment, configurable: true });
  booking.invalidateAvailabilityCache();

  const aiCalls = [];
  const stubAi = {
    parseReply: ai.parseReply,
    async getAIReply(messages, session, { signal }) {
      const last = messages[messages.length - 1].content;
      aiCalls.push(last);
      const step = aiScript(last, session, aiCalls.length);
      await new Promise((res, rej) => {
        const t = setTimeout(res, step.delay || 50);
        signal?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("aborted")); });
      });
      return step.reply;
    },
  };
  const spoken = [];
  const stubTts = {
    async speakToPcm(text, rate, { onChunk, signal }) {
      spoken.push(text);
      const total = Buffer.alloc(Math.round((text.length * ttsMsPerChar * rate * 2) / 1000), 1);
      // deliver in odd-sized pieces like a real stream
      for (let i = 0; i < total.length && !signal?.aborted; i += 1234) {
        await onChunk(total.subarray(i, i + 1234));
        await sleep(5);
      }
      return total.length;
    },
  };
  const stt = async () => sttQueue.shift() || "";

  const server = http.createServer();
  setupExotelWebSocketServer(server, { stt, ai: stubAi, tts: stubTts, CallLog: mm.CallLog });
  return { server, mm, aiCalls, spoken };
}

async function connect(server) {
  await new Promise((r) => server.listen(0, r));
  const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/exotel/media`);
  const events = [];
  ws.on("message", (m) => {
    const d = JSON.parse(m);
    events.push({ ...d, at: Date.now() });
    if (d.event === "mark") ws.send(JSON.stringify({ event: "mark", stream_sid: "S1", mark: d.mark })); // echo like Exotel
  });
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ event: "connected" }));
  ws.send(JSON.stringify({
    event: "start", stream_sid: "S1",
    start: { stream_sid: "S1", call_sid: "CALL1", from: "+919999900000", to: "+918047289047", media_format: { encoding: "raw", sample_rate: "8000" } },
  }));
  return { ws, events };
}

/** Stream caller audio in real time (20 ms chunks). */
async function say(ws, speechMs = 600, silenceMs = 500) {
  const send = async (buf) => {
    for (let i = 0; i < buf.length; i += 320) {
      ws.send(JSON.stringify({ event: "media", stream_sid: "S1", media: { payload: buf.subarray(i, i + 320).toString("base64") } }));
      await sleep(20);
    }
  };
  await send(pcm(speechMs, { amp: 9000 }));
  await send(pcm(silenceMs));
}

async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(25);
  }
  return false;
}

test("full booking call: framing, turn-taking, validated booking", async () => {
  const doctor = booking.normalizeDoctor("Dr. Ananya Sharma");
  let slotDate, slotTime;
  const h = harness({
    sttQueue: ["मुझे दो दिन से बुखार है", "रमेश कुमार", "हाँ कर दो"],
    aiScript: (last) => {
      if (/बुखार/.test(last)) return { reply: `अरे, बुखार में तो तकलीफ़ होती है। डॉक्टर अनन्या शर्मा ठीक रहेंगी। मरीज़ का नाम बताइए?\n<<DRAFT_JSON>>{"doctorName":"Dr. Ananya Sharma","date":"${slotDate}","time":"${slotTime}","reason":"बुखार"}<<END_DRAFT_JSON>>` };
      if (/रमेश/.test(last)) return { reply: `तो रमेश कुमार जी, डॉक्टर अनन्या शर्मा — बुक कर दूँ?\n<<DRAFT_JSON>>{"patientName":"रमेश कुमार","doctorName":"Dr. Ananya Sharma","date":"${slotDate}","time":"${slotTime}"}<<END_DRAFT_JSON>>` };
      return { reply: `ठीक है, बुक कर रही हूँ।\n<<DRAFT_JSON>>{}<<END_DRAFT_JSON>>\n<<BOOKING_JSON>>{"patientName":"Galat Naam","doctorName":"Dr. Ananya Sharma","date":"${slotDate}","time":"${slotTime}","reason":"बुखार"}<<END_BOOKING_JSON>>` };
    },
  });
  const avail = await booking.getAvailability(doctor); // after stubs are installed
  slotDate = avail[0].date;
  slotTime = avail[0].shifts[0].time;
  const { ws, events } = await connect(h.server);
  try {
    assert.ok(await waitFor(() => h.spoken.includes(PHRASES.greeting)), "greeting spoken");
    await waitFor(() => events.some((e) => e.event === "mark"), 6000);
    await sleep(300);

    for (const n of [2, 3, 4]) {
      await say(ws);
      assert.ok(await waitFor(() => h.aiCalls.length >= n - 1 && h.spoken.length >= n), `reply ${n}`);
      await waitFor(() => events.filter((e) => e.event === "mark").length >= n, 8000);
      await sleep(300);
    }

    // Exotel framing rule: every media frame >= 3200 bytes and a multiple of 320
    const frames = events.filter((e) => e.event === "media").map((e) => Buffer.from(e.media.payload, "base64").length);
    assert.ok(frames.length > 5);
    assert.ok(frames.every((b) => b >= 3200 && b % 320 === 0), `bad frame sizes: ${[...new Set(frames)]}`);
    assert.ok(events.filter((e) => e.event === "media").every((e) => e.stream_sid === "S1"));

    // Booking saved with the CONFIRMED session name, not the LLM's "Galat Naam"
    assert.equal(h.mm.Appointment.rows.length, 1);
    const appt = h.mm.Appointment.rows[0];
    assert.equal(appt.patientName, "Ramesh Kumar");
    assert.equal(appt.phone, "+919999900000");
    assert.equal(appt.date, slotDate);
    assert.equal(appt.department, "Residential Apartments (2 & 3 BHK)");
    // Confirmation spoken from the saved record
    assert.match(h.spoken[h.spoken.length - 1], /^रमेश जी/);
    assert.match(h.spoken[h.spoken.length - 1], /साइट विज़िट बुक हो गई है|पक्की हो गई/);
  } finally {
    ws.close();
    h.server.close();
  }
});

test("barge-in: caller talking over the bot sends Exotel 'clear' and stops audio", async () => {
  const h = harness({ sttQueue: ["रुकिए रुकिए"], aiScript: () => ({ reply: "जी, बोलिए।" }), ttsMsPerChar: 60 });
  const { ws, events } = await connect(h.server);
  try {
    assert.ok(await waitFor(() => events.some((e) => e.event === "media")), "greeting audio started");
    await sleep(400);
    await say(ws, 700, 500);
    assert.ok(await waitFor(() => events.some((e) => e.event === "clear")), "clear sent");
    assert.ok(await waitFor(() => h.spoken.includes("जी, बोलिए।")), "answered the interruption");
  } finally {
    ws.close();
    h.server.close();
  }
});

test("overlapping speech: slow LLM turn is cancelled and merged, only one reply", async () => {
  const h = harness({
    sttQueue: ["मुझे अपॉइंटमेंट", "डॉक्टर रोहित वर्मा के साथ"],
    aiScript: (last) => ({ reply: `ठीक है।`, delay: /रोहित/.test(last) ? 50 : 3000 }),
  });
  const { ws, events } = await connect(h.server);
  try {
    await waitFor(() => events.some((e) => e.event === "mark"), 6000);
    await sleep(300);
    await say(ws, 600, 400);
    await sleep(200);
    await say(ws, 600, 400);
    assert.ok(await waitFor(() => h.spoken.includes("ठीक है।")));
    await sleep(500);
    assert.deepEqual(h.aiCalls, ["मुझे अपॉइंटमेंट", "मुझे अपॉइंटमेंट डॉक्टर रोहित वर्मा के साथ"]);
    assert.equal(h.spoken.filter((s) => s === "ठीक है।").length, 1, "only one reply spoken");
  } finally {
    ws.close();
    h.server.close();
  }
});

test("emergency keywords get an immediate deterministic reply (no LLM)", async () => {
  const h = harness({ sttQueue: ["पापा को सीने में तेज़ दर्द हो रहा है"], aiScript: () => ({ reply: "x" }) });
  const { ws, events } = await connect(h.server);
  try {
    await waitFor(() => events.some((e) => e.event === "mark"), 6000);
    await sleep(300);
    await say(ws);
    assert.ok(await waitFor(() => h.spoken.some((s) => s.includes("112") || s.includes("एक सौ बारह"))));
    assert.equal(h.aiCalls.length, 0);
  } finally {
    ws.close();
    h.server.close();
  }
});

test("booking tag without caller's 'yes' is NOT saved; bot reads back and asks", async () => {
  const doctor = booking.normalizeDoctor("City Greens Residency");
  let d, t;
  const h = harness({
    sttQueue: ["मेरा नाम सुनीता वर्मा है"],
    aiScript: () => ({ reply: `ठीक है, बुक कर रही हूँ।\n<<DRAFT_JSON>>{"patientName":"सुनीता वर्मा"}<<END_DRAFT_JSON>>\n<<BOOKING_JSON>>{"doctorName":"City Greens Residency","date":"${d}","time":"${t}"}<<END_BOOKING_JSON>>` }),
  });
  const avail = await booking.getAvailability(doctor);
  d = avail[0].date; t = avail[0].shifts[0].time;
  const { ws, events } = await connect(h.server);
  try {
    await waitFor(() => events.some((e) => e.event === "mark"), 6000);
    await sleep(300);
    await say(ws);
    assert.ok(await waitFor(() => h.spoken.some((s) => /^तो सुनीता जी, सिटी ग्रीन्स रेजिडेंसी, .* बुक कर दूँ\?$/.test(s))), `spoken: ${h.spoken}`);
    assert.equal(h.mm.Appointment.rows.length, 0);
  } finally {
    ws.close();
    h.server.close();
  }
});
