const test = require("node:test");
const assert = require("node:assert/strict");
const { makeModels } = require("./helpers");

const { classifyConfirmation } = require("../utils/nameState");
const booking = require("../services/bookingService");
const { getClock } = require("../services/hospitalKnowledge");
const { parseReply, normalizeMessages } = require("../services/aiService");
const { sanitizeSpeechText, wavToPcm } = require("../services/ttsService");

// Wed 30 Sep 2026, 11:30 IST
const CLOCK = getClock(new Date("2026-09-30T06:00:00Z"));

test("clock is IST", () => {
  assert.equal(CLOCK.todayIso, "2026-09-30");
  assert.equal(CLOCK.weekday, "Wednesday");
  assert.equal(CLOCK.minutesNow, 11 * 60 + 30);
  assert.equal(CLOCK.tomorrowIso, "2026-10-01");
});

test("name confirmation (Devanagari-safe)", () => {
  const cases = {
    "हाँ": "yes", "जी": "yes", "जी हाँ सही है": "yes", "हाँ कर दो": "yes", "नहीं नहीं, सही है": "yes",
    "नहीं, यही नाम है": "yes", "yes": "yes",
    "जी नहीं": "no", "नहीं, गलत है": "no", "ठीक है पर नाम गलत है": "no", "नहीं": "no",
    "ना ना, राकेश नहीं रमेश": "no", "सही नहीं है": "no",
    "कल सुबह आना है": null,
  };
  for (const [t, want] of Object.entries(cases)) assert.equal(classifyConfirmation(t), want, t);
});

test("normalizers", () => {
  assert.equal(booking.normalizeDoctor("City Greens Residency").name, "City Greens Residency");
  assert.equal(booking.normalizeDoctor("रॉयल पाम विला").name, "Royal Palm Villas");
  assert.equal(booking.normalizeDoctor("flat").name, "City Greens Residency");
  assert.equal(booking.normalizeDoctor("villa").name, "Royal Palm Villas");
  assert.equal(booking.normalizeDoctor("plot").name, "Green Valley Plots");
  assert.equal(booking.normalizeDoctor("commercial").name, "Apex Commercial Plaza");
  assert.equal(booking.normalizeDoctor("hospital"), null);

  for (const [t, want] of [["10:00 AM", "10:00 AM"], ["सुबह दस बजे", "10:00 AM"], ["2 PM", "2:00 PM"], ["दोपहर", "2:00 PM"],
    ["5:30 PM", "5:30 PM"], ["शाम साढ़े पाँच बजे", "5:30 PM"], ["2:30 PM", null], ["12 बजे", null]]) {
    assert.equal(booking.normalizeShift(t)?.time ?? null, want, t);
  }

  assert.equal(booking.resolveDate("2026-10-02", CLOCK), "2026-10-02");
  assert.equal(booking.resolveDate("कल", CLOCK), "2026-10-01");
  assert.equal(booking.resolveDate("Tomorrow (1 October 2026)", CLOCK), "2026-10-01");
  assert.equal(booking.resolveDate("परसों", CLOCK), "2026-10-02");
  assert.equal(booking.resolveDate("आज", CLOCK), "2026-09-30");
  assert.equal(booking.resolveDate("शुक्रवार", CLOCK), "2026-10-02");
  assert.equal(booking.resolveDate("कलम", CLOCK), null);
});

test("slot rules", () => {
  const apex = booking.normalizeDoctor("apex"); // Mon-Sat
  const [m, n, e] = require("../config/hospitalConfig").shifts;
  assert.equal(booking.slotProblem(apex, "2026-09-30", m, CLOCK), "past_slot"); // 10 AM already gone
  assert.equal(booking.slotProblem(apex, "2026-09-30", n, CLOCK), null);
  assert.equal(booking.slotProblem(apex, "2026-10-04", n, CLOCK), "doctor_off"); // Sunday off for Apex
  assert.equal(booking.slotProblem(apex, "2026-09-29", n, CLOCK), "past_date");
  assert.equal(booking.slotProblem(apex, "2026-10-02", e, CLOCK), null); // Friday
});

test("validateAndBook: validation, capacity, idempotency", async () => {
  const mm = makeModels();
  Object.defineProperty(booking.models, "SlotCounter", { value: mm.SlotCounter, configurable: true });
  Object.defineProperty(booking.models, "Appointment", { value: mm.Appointment, configurable: true });
  const cfg = require("../config/hospitalConfig");
  const cap = cfg.slotCapacity;
  cfg.slotCapacity = 2;
  try {
    const req = { doctorName: "Apex Commercial Plaza", date: "2026-10-04", time: "2:00 PM" }; // Sunday
    let r = await booking.validateAndBook({ request: req, patientName: "Ramesh", phone: "1", callSid: "c1", clock: CLOCK });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "doctor_off");
    assert.match(r.speech, /साइट विज़िट नहीं है/);

    const ok = { doctorName: "City Greens Residency", date: "2026-10-02", time: "2:00 PM" };
    r = await booking.validateAndBook({ request: ok, patientName: "Ramesh", phone: "1", callSid: "c1", clock: CLOCK });
    assert.equal(r.ok, true);
    assert.equal(r.appointment.date, "2026-10-02");
    assert.equal(r.appointment.doctorName, "City Greens Residency");

    // Same call repeats the tag -> no duplicate row, no extra seat used
    r = await booking.validateAndBook({ request: ok, patientName: "Ramesh", phone: "1", callSid: "c1", clock: CLOCK });
    assert.equal(r.ok, true);
    assert.equal(r.duplicate, true);
    assert.equal(mm.Appointment.rows.length, 1);

    r = await booking.validateAndBook({ request: ok, patientName: "Sita", phone: "2", callSid: "c2", clock: CLOCK });
    assert.equal(r.ok, true);
    r = await booking.validateAndBook({ request: ok, patientName: "Gita", phone: "3", callSid: "c3", clock: CLOCK });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "full");
    assert.match(r.speech, /भर चुका है/);

    r = await booking.validateAndBook({ request: { doctorName: "hospital" }, patientName: "X", callSid: "c4", clock: CLOCK });
    assert.equal(r.reason, "no_doctor");
    r = await booking.validateAndBook({ request: ok, patientName: null, callSid: "c5", clock: CLOCK });
    assert.equal(r.reason, "no_name");
  } finally {
    cfg.slotCapacity = cap;
  }
});

test("parseReply survives think tags, truncation, missing tags", () => {
  let p = parseReply('<think>hmm</think>अच्छा, बुखार है? डॉक्टर अनन्या शर्मा ठीक रहेंगी।\n<<DRAFT_JSON>>{"doctorName":"Dr. Ananya Sharma","time":""}<<END_DRAFT_JSON>>');
  assert.equal(p.speech, "अच्छा, बुखार है? डॉक्टर अनन्या शर्मा ठीक रहेंगी।");
  assert.equal(p.draft.doctorName, "Dr. Ananya Sharma");
  assert.equal(p.booking, null);

  p = parseReply('ठीक है, बुक कर रही हूँ।\n<<DRAFT_JSON>>{"patientName":"रमेश"}<<END_DRAFT_JSON>>\n<<BOOKING_JSON>>{"doctorName":"Dr. Rohit Verma","date":"2026-10-02","time":"2:00 PM"}<<END_BOOKING_JSON>>');
  assert.equal(p.booking.time, "2:00 PM");

  p = parseReply('जी बिल्कुल। <<DRAFT_JSON>>{"patientName":"रम'); // truncated by max_tokens
  assert.equal(p.speech, "जी बिल्कुल।");
  assert.equal(p.draft, null);

  p = parseReply("<think>still thinking forever");
  assert.equal(p.speech, "");
});

test("normalizeMessages merges roles and starts with user", () => {
  const out = normalizeMessages([
    { role: "assistant", content: "नमस्ते" },
    { role: "user", content: "हेलो" },
    { role: "user", content: "बुखार है" },
  ]);
  assert.deepEqual(out.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(out[2].content, "हेलो बुखार है");
});

test("sanitizeSpeechText", () => {
  assert.equal(sanitizeSpeechText("कल 5:30 PM बजे आइए"), "कल साढ़े पाँच बजे आइए");
  assert.equal(sanitizeSpeechText("सुबह 10:00 AM"), "सुबह दस बजे");
  assert.match(sanitizeSpeechText("नंबर 0512-2345678 है"), /0512-2345678/);
  assert.equal(sanitizeSpeechText('ठीक है। <<DRAFT_JSON>>{"a":1}<<END_DRAFT_JSON>>'), "ठीक है।");
  assert.equal(sanitizeSpeechText("**अच्छा** चलिए"), "अच्छा, चलिए");
});

test("wavToPcm finds the data chunk (not a fixed 44 bytes)", () => {
  const data = Buffer.alloc(320, 7);
  const list = Buffer.concat([Buffer.from("LIST"), Buffer.from([4, 0, 0, 0]), Buffer.from("INFO")]);
  const fmt = Buffer.alloc(24);
  fmt.write("fmt ", 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10);
  fmt.writeUInt32LE(8000, 12); fmt.writeUInt32LE(16000, 16); fmt.writeUInt16LE(2, 20); fmt.writeUInt16LE(16, 22);
  const dh = Buffer.alloc(8); dh.write("data", 0); dh.writeUInt32LE(320, 4);
  const hdr = Buffer.alloc(12); hdr.write("RIFF", 0); hdr.write("WAVE", 8);
  const wav = Buffer.concat([hdr, fmt, list, dh, data]);
  assert.deepEqual(wavToPcm(wav, 8000), data);
});
