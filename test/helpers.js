/** In-memory stand-ins for the Mongoose models (no DB needed for tests). */
function dupErr() {
  const e = new Error("E11000 duplicate key");
  e.code = 11000;
  return e;
}
const matches = (doc, q) =>
  Object.entries(q).every(([k, v]) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if ("$lt" in v) return doc[k] < v.$lt;
      if ("$gt" in v) return doc[k] > v.$gt;
      if ("$in" in v) return v.$in.includes(doc[k]);
    }
    return doc[k] === v;
  });
const lean = (v) => ({ lean: () => Promise.resolve(v), then: (a, b) => Promise.resolve(v).then(a, b), catch: (f) => Promise.resolve(v).catch(f) });

function makeModels() {
  const slots = [];
  const appts = [];
  const SlotCounter = {
    rows: slots,
    find: (q) => lean(slots.filter((d) => matches(d, q))),
    async findOneAndUpdate(q, upd) {
      const hit = slots.find((d) => matches(d, q));
      if (hit) {
        hit.count += upd.$inc.count;
        return hit;
      }
      const key = (d) => `${d.doctorName}|${d.date}|${d.time}`;
      if (slots.some((d) => key(d) === key(q))) throw dupErr();
      const row = { doctorName: q.doctorName, date: q.date, time: q.time, count: upd.$inc.count };
      slots.push(row);
      return row;
    },
    async updateOne(q, upd) {
      const hit = slots.find((d) => matches(d, q));
      if (hit) hit.count += upd.$inc.count;
    },
  };
  const Appointment = {
    rows: appts,
    findOne: (q) => lean(appts.find((d) => matches(d, q)) || null),
    async create(doc) {
      if (appts.some((a) => a.callSid === doc.callSid && a.doctorName === doc.doctorName && a.date === doc.date && a.time === doc.time)) throw dupErr();
      const row = { _id: `A${appts.length + 1}`, ...doc };
      appts.push(row);
      return row;
    },
  };
  const CallLog = {
    ops: [],
    updateOne: async (q, u) => CallLog.ops.push(["update", q, u]),
    findOneAndUpdate: async (q, u) => CallLog.ops.push(["upsert", q, u]),
  };
  return { SlotCounter, Appointment, CallLog };
}

/** 16-bit PCM: loud tone (speech-like) or near-silence. */
function pcm(ms, { rate = 8000, amp = 0, freq = 220 } = {}) {
  const n = Math.round((rate * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = amp ? Math.round(amp * Math.sin((2 * Math.PI * freq * i) / rate)) : Math.round((Math.random() - 0.5) * 60);
    b.writeInt16LE(v, i * 2);
  }
  return b;
}

module.exports = { makeModels, pcm };
