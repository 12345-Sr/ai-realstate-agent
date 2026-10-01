const mongoose = require("mongoose");

const appointmentSchema = new mongoose.Schema(
  {
    clientName: { type: String },
    patientName: { type: String },
    phone: { type: String, required: true },
    projectName: { type: String },
    doctorName: { type: String },
    propertyType: String,
    department: String,
    // Site visit date in YYYY-MM-DD (IST)
    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    dateLabel: String, // "शुक्रवार, 2 अक्टूबर" (dashboard/SMS)
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

// Auto-fill clientName <-> patientName and projectName <-> doctorName to guarantee validation passes
appointmentSchema.pre("validate", function (next) {
  if (!this.clientName && this.patientName) this.clientName = this.patientName;
  if (!this.patientName && this.clientName) this.patientName = this.clientName;
  if (!this.projectName && this.doctorName) this.projectName = this.doctorName;
  if (!this.doctorName && this.projectName) this.doctorName = this.projectName;
  if (!this.clientName) this.clientName = "Valued Client";
  if (!this.patientName) this.patientName = this.clientName;
  if (!this.projectName) this.projectName = "City Greens Residency";
  if (!this.doctorName) this.doctorName = this.projectName;
  next();
});

appointmentSchema.index({ doctorName: 1, date: 1, time: 1 });
appointmentSchema.index({ projectName: 1, date: 1, time: 1 });
// Duplicate prevention within the same call session
appointmentSchema.index({ callSid: 1, doctorName: 1, date: 1, time: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model("Appointment", appointmentSchema);
