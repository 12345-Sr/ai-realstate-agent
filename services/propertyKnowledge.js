/**
 * Real Estate Property knowledge + IST clock.
 *
 * Provides real-time calendar math, Devanagari spoken clock, and structured
 * property catalog knowledge for the AI Real Estate Calling Agent.
 */
const cfg = require("../config/realestateConfig");

const TZ = "Asia/Kolkata";
const DAY_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_HI = {
  Sunday: "रविवार", Monday: "सोमवार", Tuesday: "मंगलवार", Wednesday: "बुधवार",
  Thursday: "गुरुवार", Friday: "शुक्रवार", Saturday: "शनिवार",
};
const MONTH_HI = ["जनवरी", "फ़रवरी", "मार्च", "अप्रैल", "मई", "जून", "जुलाई", "अगस्त", "सितंबर", "अक्टूबर", "नवंबर", "दिसंबर"];
const HOUR_WORDS = ["बारह", "एक", "दो", "तीन", "चार", "पाँच", "छह", "सात", "आठ", "नौ", "दस", "ग्यारह"];

/** IST calendar parts for a Date (hourCycle h23 — avoids midnight bug). */
function istParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "long",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    iso: `${get("year")}-${get("month")}-${get("day")}`,
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: get("weekday"),
  };
}

/** "2026-09-30" + n days -> "2026-10-01" (pure calendar math, TZ-safe). */
function addDaysIso(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

function weekdayOfIso(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return DAY_EN[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** "2026-10-02" -> "शुक्रवार, 2 अक्टूबर" */
function spokenDate(iso) {
  const [, m, d] = iso.split("-").map(Number);
  return `${DAY_HI[weekdayOfIso(iso)]}, ${d} ${MONTH_HI[m - 1]}`;
}

/** Relative label: आज / कल / परसों / weekday */
function relativeDayLabel(iso, todayIso) {
  if (iso === todayIso) return "आज";
  if (iso === addDaysIso(todayIso, 1)) return "कल";
  if (iso === addDaysIso(todayIso, 2)) return "परसों";
  return spokenDate(iso);
}

function spokenClock(hour, minute) {
  const period = hour < 4 ? "रात" : hour < 12 ? "सुबह" : hour < 16 ? "दोपहर" : hour < 20 ? "शाम" : "रात";
  const h12 = hour % 12;
  const w = HOUR_WORDS[h12];
  let phrase;
  if (minute === 0) phrase = `${w} बजे`;
  else if (minute === 15) phrase = `सवा ${w} बजे`;
  else if (minute === 30) phrase = h12 === 1 ? "डेढ़ बजे" : h12 === 2 ? "ढाई बजे" : `साढ़े ${w} बजे`;
  else if (minute === 45) phrase = `पौने ${HOUR_WORDS[(h12 + 1) % 12]} बजे`;
  else phrase = `${w} बजकर ${minute} मिनट`;
  return `${period} के ${phrase}`;
}

function getClock(now = new Date()) {
  const p = istParts(now);
  return {
    now,
    todayIso: p.iso,
    tomorrowIso: addDaysIso(p.iso, 1),
    dayAfterIso: addDaysIso(p.iso, 2),
    weekday: p.weekday,
    minutesNow: p.hour * 60 + p.minute,
    spokenTime: spokenClock(p.hour, p.minute),
  };
}

function isOpdDay(iso) {
  return cfg.workingDays.includes(weekdayOfIso(iso));
}

/** Compact, token-efficient knowledge block for the LLM prompt. */
function buildKnowledgeText() {
  const projs = (cfg.projects || [])
    .map(
      (p, i) =>
        `${i + 1}. ${p.name} (${p.hindiName}) — ${p.type} / ${p.typeHindi}, ${p.location}. ` +
        `कीमत: ${p.startingPrice || "₹45 लाख"} से शुरू. ` +
        `सुविधाएँ: ${p.amenities}.`
    )
    .join("\n");
  const shifts = cfg.shifts.map((s) => `${s.time} (${s.spoken})`).join(", ");
  return `REAL ESTATE AGENCY: ${cfg.agencyNameEn} (${cfg.agencyName}), ${cfg.officeAddress}
OFFICE PHONE: ${cfg.officePhone} | HELPDESK: ${cfg.helpdeskMobile}
SITE VISIT HOURS: ${cfg.workingHoursText}
SITE VISIT APPOINTMENT SHIFTS (only these 3): ${shifts}
PROJECTS & PROPERTY CATALOG:
${projs}
FAQ (FINANCING, RERA, REGISTRY):
${cfg.faq.map((f) => "- " + f).join("\n")}`;
}

module.exports = {
  TZ,
  DAY_HI,
  istParts,
  addDaysIso,
  weekdayOfIso,
  spokenDate,
  relativeDayLabel,
  spokenClock,
  getClock,
  isOpdDay,
  buildKnowledgeText,
};
