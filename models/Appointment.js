const mongoose = require("mongoose");

const appointmentSchema = new mongoose.Schema(
  {
    patientName: { type: String, required: true },
    phone: { type: String, required: true },
    doctorName: { type: String, required: true },
    department: String,
    // Pehle "Today (30 September 2026)" jaisa free text tha — query/sort nahi ho sakta tha.
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ }, // YYYY-MM-DD (IST)
    dateLabel: String, // "शुक्रवार, 2 अक्टूबर" (dashboard/SMS ke liye)
    time: { type: String, required: true }, // "10:00 AM"
    reason: String,
    status: {
      type: String,
      enum: ["pending_confirmation", "confirmed", "cancelled"],
      default: "confirmed",
    },
    callSid: { type: String, index: true },
    source: {
      type: String,
      enum: ["inbound_call", "outbound_call", "exotel_voicebot", "voicebot"],
      default: "inbound_call",
    },
  },
  { timestamps: true }
);

appointmentSchema.index({ doctorName: 1, date: 1, time: 1 });
// Ek hi call me LLM do baar booking tag bhej de to duplicate row na bane
appointmentSchema.index({ callSid: 1, doctorName: 1, date: 1, time: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("Appointment", appointmentSchema);
