const mongoose = require("mongoose");

const turnSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ["assistant", "caller"], required: true },
    text: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false }
);

const callLogSchema = new mongoose.Schema(
  {
    callSid: { type: String, required: true, unique: true, index: true },
    direction: { type: String, enum: ["inbound", "outbound"], required: true },
    from: String,
    to: String,
    status: {
      type: String,
      enum: ["in-progress", "completed", "no-answer", "failed", "busy"],
      default: "in-progress",
    },
    transcript: [turnSchema],
    patientName: String,
    callerName: String,
    appointmentBooked: { type: Boolean, default: false },
    flagged: String, // "emergency"
    handoff: String, // "caller_request" | "dtmf_0"
    startedAt: { type: Date, default: Date.now },
    endedAt: Date,
    durationSeconds: Number,
  },
  { timestamps: true }
);

module.exports = mongoose.model("CallLog", callLogSchema);
