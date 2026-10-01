const test = require("node:test");
const assert = require("node:assert/strict");
const { makeModels } = require("./helpers");

const { classifyConfirmation, isInvalidPatientName } = require("../utils/nameState");
const booking = require("../services/bookingService");
const { getClock } = require("../services/propertyKnowledge");
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

// Regression test for the bug found when porting from the hospital project:
// DOCTOR_NAME_PATTERNS was hardcoded to the 4 hospital doctor names and never
// caught the AI writing a PROJECT name into patientName. Now derived from config.
test("isInvalidPatientName rejects project names, accepts real client names", () => {
  for (const n of ["City Greens Residency", "Royal Palm Villas", "रॉयल पाम विला", "Apex Commercial Plaza", "विला", "villa"]) {
    assert.equal(isInvalidPatientName(n), true, `should reject project name: ${n}`);
  }
  for (const n of ["Rahul Sharma", "श्रीकांत", "Sratanshu Shukla", "Amit Kumar", "Ananya Gupta"]) {
    assert.equal(isInvalidPatientName(n), false, `should accept real name: ${n}`);
  }
});

test("normalizers", () => {
  assert.equal(booking.normalizeDoctor("Royal Palm Villas").name, "Royal Palm Villas");
  assert.equal(booking.normalizeDoctor("ग्रीन वैली प्लॉट्स").name, "Green Valley Plots");
  assert.equal(booking.normalizeDoctor("villa").name, "Royal Palm Villas");
  assert.equal(booking.normalizeDoctor("विला").name, "Royal Palm Villas");
  assert.equal(booking.normalizeDoctor("plot chahiye").name, "Green Valley Plots");
  assert.equal(booking.normalizeDoctor("commercial shop").name, "Apex Commercial Plaza");
  assert.equal(booking.normalizeDoctor("rent pe lena hai"), null);

  // Regression: digit-leading input used to false-match the first project via a
  // broken fallback (word(d.specialty) where d.specialty was always undefined).
  for (const q of ["3", "3 lakh budget", "9876543210", "25 lakh wala dikhao"]) {
    assert.equal(booking.normalizeDoctor(q), null, `should NOT match any project: ${q}`);
  }
  // Regression: "2 bhk" / "3 bhk" (spoken with a space) must match same as "2bhk"/"3bhk"
  assert.equal(booking.normalizeDoctor("2 bhk").name, "City Greens Residency");
  assert.equal(booking.normalizeDoctor("3 bhk").name, "City Greens Residency");

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

test("slot rules (Apex Commercial Plaza is the only project closed on Sundays)", () => {
  const apex = booking.normalizeDoctor("apex");
  const [m, n, e] = require("../config/realestateConfig").shifts;
  assert.equal(booking.slotProblem(apex, "2026-09-30", m, CLOCK), "past_slot"); // 10 AM already gone today
  assert.equal(booking.slotProblem(apex, "2026-09-30", n, CLOCK), null);
  assert.equal(booking.slotProblem(apex, "2026-10-04", n, CLOCK), "doctor_off"); // Sunday, Apex closed
  assert.equal(booking.slotProblem(apex, "2026-10-04", n, CLOCK) && null, null); // (sanity no-op)
  assert.equal(booking.slotProblem(apex, "2026-09-29", n, CLOCK), "past_date");
  assert.equal(booking.slotProblem(apex, "2026-10-02", e, CLOCK), null); // Friday, fine

  // City Greens Residency is open all 7 days - Sunday is fine for it
  const greens = booking.normalizeDoctor("City Greens Residency");
  assert.equal(booking.slotProblem(greens, "2026-10-04", n, CLOCK), null);
});

test("validateAndBook: validation, capacity, idempotency", async () => {
  const mm = makeModels();
  Object.defineProperty(booking.models, "SlotCounter", { value: mm.SlotCounter, configurable: true });
  Object.defineProperty(booking.models, "Appointment", { value: mm.Appointment, configurable: true });
  const cfg = require("../config/realestateConfig");
  const cap = cfg.slotCapacity;
  cfg.slotCapacity = 2;
  try {
    const req = { doctorName: "Apex Commercial Plaza", date: "2026-10-04", time: "2:00 PM" }; // Sunday - closed
    let r = await booking.validateAndBook({ request: req, patientName: "Ramesh", phone: "1", callSid: "c1", clock: CLOCK });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "doctor_off");
    assert.match(r.speech, /रविवार को साइट विज़िट नहीं है/);

    const ok = { ...req, date: "2026-10-02" }; // Friday, Apex open
    r = await booking.validateAndBook({ request: ok, patientName: "Ramesh", phone: "1", callSid: "c1", clock: CLOCK });
    assert.equal(r.ok, true);
    assert.equal(r.appointment.date, "2026-10-02");
    assert.equal(r.appointment.department, "Commercial Retail Shops & Offices");

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

    r = await booking.validateAndBook({ request: { doctorName: "no such project" }, patientName: "X", callSid: "c4", clock: CLOCK });
    assert.equal(r.reason, "no_doctor");
    r = await booking.validateAndBook({ request: ok, patientName: null, callSid: "c5", clock: CLOCK });
    assert.equal(r.reason, "no_name");
  } finally {
    cfg.slotCapacity = cap;
  }
});

test("parseReply survives think tags, truncation, missing tags", () => {
  let p = parseReply('<think>hmm</think>अच्छा, 2 BHK चाहिए? सिटी ग्रीन्स रेजिडेंसी बढ़िया रहेगी।\n<<DRAFT_JSON>>{"doctorName":"City Greens Residency","time":""}<<END_DRAFT_JSON>>');
  assert.equal(p.speech, "अच्छा, 2 BHK चाहिए? सिटी ग्रीन्स रेजिडेंसी बढ़िया रहेगी।");
  assert.equal(p.draft.doctorName, "City Greens Residency");
  assert.equal(p.booking, null);

  p = parseReply('ठीक है, बुक कर रही हूँ।\n<<DRAFT_JSON>>{"patientName":"रमेश"}<<END_DRAFT_JSON>>\n<<BOOKING_JSON>>{"doctorName":"Royal Palm Villas","date":"2026-10-02","time":"2:00 PM"}<<END_BOOKING_JSON>>');
  assert.equal(p.booking.time, "2:00 PM");

  p = parseReply('जी बिल्कुल। <<DRAFT_JSON>>{"patientName":"रम'); // truncated by max_tokens
  assert.equal(p.speech, "जी बिल्कुल।");
  assert.equal(p.draft, null);

  p = parseReply("<think>still thinking forever");
  assert.equal(p.speech, "");
});

test("parseReply detects <<END_CALL>> tag and the closing-phrase fallback", () => {
  let p = parseReply("बात करने के लिए धन्यवाद, आपका दिन शुभ हो!\n<<END_CALL>>");
  assert.equal(p.endCall, true);

  // Fallback: AI said the closing line but forgot the tag
  p = parseReply("ठीक है, आपका दिन शुभ हो!");
  assert.equal(p.endCall, true);

  // Mid-conversation reply must NOT be mistaken for a closing line
  p = parseReply("ठीक है, City Greens Residency के बारे में बताती हूँ।");
  assert.equal(p.endCall, false);
});

test("normalizeMessages merges roles and starts with user", () => {
  const out = normalizeMessages([
    { role: "assistant", content: "नमस्ते" },
    { role: "user", content: "हेलो" },
    { role: "user", content: "2 BHK फ्लैट चाहिए" },
  ]);
  assert.deepEqual(out.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(out[2].content, "हेलो 2 BHK फ्लैट चाहिए");
});

test("sanitizeSpeechText", () => {
  assert.equal(sanitizeSpeechText("कल 5:30 PM बजे आइए"), "कल साढ़े पाँच बजे आइए");
  assert.equal(sanitizeSpeechText("सुबह 10:00 AM"), "सुबह दस बजे");
  assert.match(sanitizeSpeechText("नंबर 0512-2580123 है"), /0512-2580123/);
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
