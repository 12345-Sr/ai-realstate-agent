/**
 * Booking engine — server-side validation. LLM sirf "intent" deta hai; kya
 * book ho sakta hai ye yahan deterministic tarike se decide hota hai.
 *
 * Pehle: LLM jo bhi <<BOOKING_JSON>> bhejta, seedha DB me save — koi check nahi
 * ki doctor us din baithte hain, slot bhara hai, ya date bhi valid hai. README
 * me "slot full" handling likhi thi par code me thi hi nahi.
 */
const cfg = require("../config/realestateConfig");
const {
  getClock, addDaysIso, weekdayOfIso, isOpdDay, relativeDayLabel, spokenDate, DAY_HI,
} = require("./propertyKnowledge");

// Models lazily (tests me stub karne ke liye)
const models = {
  get SlotCounter() { return require("../models/SlotCounter"); },
  get Appointment() { return require("../models/Appointment"); },
};

const lc = (s) => String(s || "").toLowerCase().trim();

function normalizeDoctor(input) {
  const s = lc(input);
  if (!s) return null;
  const exact = cfg.doctors.find((d) => lc(d.name) === s || lc(d.hindiName) === s);
  if (exact) return exact;
  // Whole-word alias match ("ent" must not match "dentist", "कान" not "दुकान")
  const word = (a) => new RegExp(`(?<![\\u0900-\\u097Fa-z])${lc(a).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\u0900-\\u097Fa-z])`, "i");
  return (
    cfg.doctors.find((d) => d.aliases.some((a) => word(a).test(s))) ||
    cfg.doctors.find((d) => {
      const category = d.specialty || d.type; // hospital uses specialty, real estate uses type
      return category && word(category).test(s);
    }) ||
    null
  );
}

/** Returns one of cfg.shifts or null. Accepts "10:00 AM", "10", "सुबह", "5:30", "साढ़े पाँच", "evening"... */
function normalizeShift(input) {
  const s = lc(input);
  if (!s) return null;
  const direct = cfg.shifts.find((sh) => lc(sh.time) === s);
  if (direct) return direct;
  const [morning, noon, evening] = cfg.shifts;
  if (/(^|\D)5\s*[:.]?\s*30|साढ़े\s*पा[ँं]?च|साढे\s*पा|17:30|evening|शाम/.test(s)) return evening;
  if (/(^|\D)(2|14)(\s*[:.]\s*00)?\s*(pm|बजे|$)|(^|\s)दो\s*बजे|noon|afternoon|दोपहर/.test(s)) return noon;
  if (/(^|\D)10(\s*[:.]\s*00)?\s*(am|बजे|$)|(^|\s)दस\s*बजे|morning|सुबह/.test(s)) return morning;
  return null;
}

const WEEKDAY_WORDS = {
  Sunday: ["sunday", "रविवार", "इतवार"],
  Monday: ["monday", "सोमवार"],
  Tuesday: ["tuesday", "मंगलवार"],
  Wednesday: ["wednesday", "बुधवार"],
  Thursday: ["thursday", "गुरुवार", "बृहस्पतिवार", "वीरवार"],
  Friday: ["friday", "शुक्रवार"],
  Saturday: ["saturday", "शनिवार"],
};

/** Resolve LLM/caller date text to YYYY-MM-DD in IST. Null if unparseable. */
function resolveDate(input, clock = getClock()) {
  const s = lc(input);
  if (!s) return null;
  const iso = s.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  // NOTE: JS `\b` Devanagari pe kaam nahi karta — isliye lookarounds.
  if (/day\s*after|परसों/.test(s)) return clock.dayAfterIso;
  if (/tomorrow|(?<![ऀ-ॿ])कल(?![ऀ-ॿ])/.test(s)) return clock.tomorrowIso;
  if (/today|(?<![ऀ-ॿ])आज(?![ऀ-ॿ])/.test(s)) return clock.todayIso;
  for (const [day, words] of Object.entries(WEEKDAY_WORDS)) {
    if (words.some((w) => s.includes(w))) {
      for (let i = 0; i < 7; i++) {
        const d = addDaysIso(clock.todayIso, i);
        if (weekdayOfIso(d) === day) return d;
      }
    }
  }
  return null;
}

/** Why a given (doctor, date, shift) can't be booked — ignoring capacity. null = OK. */
function slotProblem(doctor, dateIso, shift, clock = getClock()) {
  if (dateIso < clock.todayIso) return "past_date";
  if (dateIso > addDaysIso(clock.todayIso, 14)) return "too_far";
  if (!isOpdDay(dateIso)) return "opd_closed";
  if (!doctor.availableDays.includes(weekdayOfIso(dateIso))) return "doctor_off";
  if (dateIso === clock.todayIso && clock.minutesNow + cfg.slotLeadMinutes > shift.minutes) return "past_slot";
  return null;
}

async function bookedCounts(doctorName, dates) {
  try {
    const rows = await models.SlotCounter.find({ doctorName, date: { $in: dates } }).lean();
    const map = {};
    for (const r of rows) map[`${r.date}|${r.time}`] = r.count;
    return map;
  } catch (err) {
    console.warn("[booking] availability lookup failed:", err.message);
    return {};
  }
}

/**
 * Next open slots for a doctor, up to `maxDays` bookable days.
 * => [{ date, label, shifts: [shift,...] }]
 */
async function getAvailability(doctor, { clock = getClock(), maxDays = 3, fromIso } = {}) {
  const candidates = [];
  for (let i = 0; i < 14 && candidates.length < maxDays; i++) {
    const d = addDaysIso(fromIso || clock.todayIso, i);
    const open = cfg.shifts.filter((sh) => !slotProblem(doctor, d, sh, clock));
    if (open.length) candidates.push({ date: d, shifts: open });
  }
  const counts = await bookedCounts(doctor.name, candidates.map((c) => c.date));
  return candidates
    .map((c) => ({
      date: c.date,
      label: relativeDayLabel(c.date, clock.todayIso),
      shifts: c.shifts.filter((sh) => (counts[`${c.date}|${sh.time}`] || 0) < cfg.slotCapacity),
    }))
    .filter((c) => c.shifts.length);
}

function describeAvailability(avail) {
  return avail
    .map((a) => `${a.label} (${a.date}): ${a.shifts.map((s) => s.spoken).join(", ")}`)
    .join(" | ");
}

let allAvailCache = { at: 0, text: "" };
/** Compact availability of ALL doctors for the prompt (cached 15s). */
async function getAllAvailabilityText(clock = getClock()) {
  if (Date.now() - allAvailCache.at < 15000 && allAvailCache.text) return allAvailCache.text;
  const lines = await Promise.all(
    cfg.doctors.map(async (d) => {
      const avail = await getAvailability(d, { clock });
      return `- ${d.name}: ${avail.length ? describeAvailability(avail) : "अगले दिनों में कोई स्लॉट नहीं"}`;
    })
  );
  allAvailCache = { at: Date.now(), text: lines.join("\n") };
  return allAvailCache.text;
}
function invalidateAvailabilityCache() {
  allAvailCache = { at: 0, text: "" };
}

function offerSentence(avail) {
  if (!avail.length) return "अगले कुछ दिनों में कोई स्लॉट खाली नहीं है।";
  const first = avail[0];
  const opts = first.shifts.map((s) => s.spoken);
  const list = opts.length > 1 ? `${opts.slice(0, -1).join(", ")} या ${opts[opts.length - 1]}` : opts[0];
  return `${first.label} ${list} खाली है।`;
}

async function reserveSlot(doctorName, date, time) {
  try {
    await models.SlotCounter.findOneAndUpdate(
      { doctorName, date, time, count: { $lt: cfg.slotCapacity } },
      { $inc: { count: 1 } },
      { upsert: true, new: true }
    );
    return true;
  } catch (err) {
    if (err && err.code === 11000) return false; // full
    throw err;
  }
}

async function releaseSlot(doctorName, date, time) {
  await models.SlotCounter.updateOne({ doctorName, date, time, count: { $gt: 0 } }, { $inc: { count: -1 } }).catch(() => {});
}

/**
 * Validate an LLM booking request and save it.
 * @returns {Promise<{ok:boolean, appointment?:object, speech?:string, reason?:string}>}
 *   ok=false => `speech` is what the bot should say instead of the LLM's confirmation.
 */
async function validateAndBook({ request, patientName, phone, callSid, clock = getClock() }) {
  const doctor = normalizeDoctor(request.doctorName);
  if (!doctor) {
    return { ok: false, reason: "no_doctor", speech: "बस यह बता दीजिए कि आप 2 BHK, 3 BHK, विला या किस तरह की प्रॉपर्टी देखना चाहते हैं?" };
  }
  if (!patientName) {
    return { ok: false, reason: "no_name", speech: "साइट विज़िट दर्ज करने के लिए आपका शुभ नाम बता दीजिए।" };
  }
  const shift = normalizeShift(request.time);
  const date = resolveDate(request.date, clock);
  if (!shift || !date) {
    const avail = await getAvailability(doctor, { clock });
    return { ok: false, reason: "no_slot", speech: `${doctor.hindiName} के लिए ${offerSentence(avail)} कौन सा समय ठीक रहेगा?` };
  }

  const problem = slotProblem(doctor, date, shift, clock);
  if (problem) {
    const avail = await getAvailability(doctor, { clock });
    const offer = offerSentence(avail);
    const day = DAY_HI[weekdayOfIso(date)];
    const msg = {
      past_date: `वो तारीख निकल चुकी है। ${offer}`,
      too_far: `अभी सिर्फ़ अगले दो हफ़्ते की साइट विज़िट बुक हो रही है। ${offer}`,
      opd_closed: `${day} को ऑफिस बंद रहता है। ${offer}`,
      doctor_off: `${doctor.hindiName} में ${day} को साइट विज़िट नहीं है। ${offer}`,
      past_slot: `आज का वो समय निकल चुका है। ${offer}`,
    }[problem];
    return { ok: false, reason: problem, speech: `माफ़ कीजिए, ${msg} कौन सा समय ठीक रहेगा?` };
  }

  // Same call + same slot already saved (LLM repeated the tag) => idempotent success
  const existing = await models.Appointment.findOne({ callSid, doctorName: doctor.name, date, time: shift.time }).lean().catch(() => null);
  if (existing) return { ok: true, appointment: existing, duplicate: true };

  const reserved = await reserveSlot(doctor.name, date, shift.time);
  if (!reserved) {
    const avail = await getAvailability(doctor, { clock });
    return {
      ok: false,
      reason: "full",
      speech: `माफ़ कीजिए, ${relativeDayLabel(date, clock.todayIso)} ${shift.spoken} का स्लॉट भर चुका है। ${offerSentence(avail)} कौन सा ठीक रहेगा?`,
    };
  }

  try {
    const appointment = await models.Appointment.create({
      patientName,
      phone: phone || "Unknown",
      doctorName: doctor.name,
      department: doctor.type || "Residential",
      date,
      dateLabel: spokenDate(date),
      time: shift.time,
      reason: String(request.reason || "Property Site Visit").slice(0, 200),
      callSid,
      source: "exotel_voicebot",
    });
    invalidateAvailabilityCache();
    return { ok: true, appointment: appointment.toObject ? appointment.toObject() : appointment, doctor, shift };
  } catch (err) {
    await releaseSlot(doctor.name, date, shift.time);
    if (err && err.code === 11000) {
      const again = await models.Appointment.findOne({ callSid, doctorName: doctor.name, date, time: shift.time }).lean().catch(() => null);
      if (again) return { ok: true, appointment: again, duplicate: true };
    }
    console.error("[booking] save failed:", err.message);
    return { ok: false, reason: "db_error", speech: "माफ़ कीजिए, अभी सिस्टम में साइट विज़िट सेव नहीं हो पाई। मैं आपको हमारे प्रॉपर्टी मैनेजर से जोड़ देती हूँ।" };
  }
}

/** Spoken confirmation built from the SAVED record for real estate. */
function confirmationSpeech(appt, { clock = getClock(), spokenName } = {}) {
  const doctor = normalizeDoctor(appt.doctorName);
  const shift = normalizeShift(appt.time);
  const firstName = String(spokenName || appt.patientName).split(/\s+/)[0];
  const projName = doctor ? doctor.hindiName : (appt.doctorName || "प्रॉपर्टी");
  return (
    `${firstName} जी, आपकी ${projName} के लिए ` +
    `${relativeDayLabel(appt.date, clock.todayIso)} ${shift ? shift.spoken : appt.time} साइट विज़िट बुक हो गई है। ` +
    `हमारा ऑफिस ${cfg.officeAddress} पर है, और हमारी टीम आपको लोकेशन भेज देगी। और कोई जानकारी चाहिए?`
  );
}

module.exports = {
  models,
  normalizeDoctor,
  normalizeShift,
  resolveDate,
  slotProblem,
  getAvailability,
  getAllAvailabilityText,
  invalidateAvailabilityCache,
  describeAvailability,
  offerSentence,
  validateAndBook,
  confirmationSpeech,
};
