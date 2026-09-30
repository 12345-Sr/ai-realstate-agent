const express = require("express");
const CallLog = require("../models/CallLog");
const Appointment = require("../models/Appointment");
const { toEnglishName } = require("../utils/transliterate");

const router = express.Router();

function cleanPhone(p) {
  if (!p) return "";
  return String(p).replace(/\D/g, "").slice(-10);
}

function normalizeDoc(doc, phoneToPatientMap = {}) {
  const appt = doc.appointment || {};
  const isBooked =
    doc.appointmentBooked === true ||
    doc.booked === true ||
    (doc.status === "completed" && !!appt.patientName) ||
    /^(yes|true|1|booked)$/i.test(String(doc.booked || doc.appointment_booked || "").trim());

  let phone =
    (doc.direction === "inbound" ? doc.from : doc.to) ||
    doc.from ||
    doc.to ||
    appt.phone ||
    doc.phone ||
    "—";

  const phoneKey = cleanPhone(phone);
  let rawName =
    appt.patientName ||
    doc.patientName ||
    doc.callerName ||
    phoneToPatientMap[phoneKey] ||
    "New Patient";

  let name = toEnglishName(rawName);

  let callTimeStr = "—";
  const rawDate = doc.startedAt || doc.createdAt || doc.call_time;
  if (rawDate) {
    try {
      const d = new Date(rawDate);
      callTimeStr = d.toLocaleString("en-IN", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      });
    } catch {
      callTimeStr = String(rawDate);
    }
  }

  let duration = doc.durationSeconds || doc.duration_sec || doc.duration || 0;
  if (!duration && doc.startedAt && doc.endedAt) {
    duration = Math.max(0, Math.round((new Date(doc.endedAt) - new Date(doc.startedAt)) / 1000));
  }

  let timeSlot = "—";
  if (appt.time) {
    timeSlot = appt.doctorName ? `${appt.time} (${appt.doctorName})` : appt.time;
  } else if (doc.appointment_time) {
    timeSlot = doc.appointment_time;
  }

  return {
    id: doc._id ? doc._id.toString() : "",
    name: name,
    phone: phone,
    direction: (doc.direction || "inbound").toLowerCase().startsWith("out") ? "outbound" : "inbound",
    call_time: callTimeStr,
    duration_sec: duration,
    booked: isBooked ? "yes" : "no",
    appointment_date: appt.date || doc.appointment_date || "—",
    appointment_time: timeSlot,
    notes: appt.reason || doc.notes || "",
  };
}

/**
 * GET /api/calls
 * Returns normalized call & appointment records matching the dashboard format.
 * Pass ?raw=true for raw MongoDB documents.
 */
router.get("/calls", async (req, res) => {
  try {
    if (req.query.raw === "true") {
      const calls = await CallLog.find().sort({ createdAt: -1 }).limit(100);
      return res.json(calls);
    }

    const allAppts = await Appointment.find({}, { phone: 1, patientName: 1 }).sort({ createdAt: -1 }).limit(2000).lean();
    const phoneToPatientMap = {};
    for (const a of allAppts) {
      const pKey = cleanPhone(a.phone);
      if (pKey && a.patientName) {
        phoneToPatientMap[pKey] = a.patientName;
      }
    }

    const docs = await CallLog.aggregate([
      { $sort: { startedAt: -1, createdAt: -1, _id: -1 } },
      { $limit: 200 },
      {
        $lookup: {
          from: "appointments",
          localField: "callSid",
          foreignField: "callSid",
          as: "appointment",
        },
      },
      {
        $unwind: {
          path: "$appointment",
          preserveNullAndEmptyArrays: true,
        },
      },
    ]);

    res.json(docs.map((d) => normalizeDoc(d, phoneToPatientMap)));
  } catch (err) {
    console.error("[api] Error fetching calls:", err.message);
    res.status(500).json({ error: "Failed to fetch calls" });
  }
});

router.get("/appointments", async (req, res) => {
  try {
    const appts = await Appointment.find().sort({ createdAt: -1 }).limit(100);
    res.json(appts);
  } catch (err) {
    console.error("[api] appointments:", err.message);
    res.status(500).json({ error: "Failed to fetch appointments" });
  }
});

module.exports = router;
