const mongoose = require("mongoose");

/**
 * Per (doctor, date, shift) booking counter. Atomic capacity check:
 *   findOneAndUpdate({..., count: {$lt: cap}}, {$inc: {count: 1}}, {upsert: true})
 * Agar slot full hai to filter match nahi karega, upsert insert try karega aur
 * unique index duplicate-key error dega => "full". Do callers ek saath aakhri
 * seat book karein to bhi sirf ek jeetega (race-safe).
 */
const slotCounterSchema = new mongoose.Schema(
  {
    doctorName: { type: String, required: true },
    date: { type: String, required: true }, // YYYY-MM-DD (IST)
    time: { type: String, required: true }, // "10:00 AM" | "2:00 PM" | "5:30 PM"
    count: { type: Number, default: 0 },
  },
  { timestamps: true }
);

slotCounterSchema.index({ doctorName: 1, date: 1, time: 1 }, { unique: true });

module.exports = mongoose.model("SlotCounter", slotCounterSchema);
