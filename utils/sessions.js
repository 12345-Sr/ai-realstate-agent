/**
 * In-memory call sessions keyed by Exotel CallSid.
 *
 * Fix: /exotel/greeting aur /exotel/passthru HTTP routes sessions banate the
 * jo kabhi delete nahi hote the (WebSocket close hi clear karta tha) -> memory
 * leak. Ab 2 ghante purane sessions apne aap saaf.
 *
 * NOTE: single instance ke liye theek hai. Multiple instances / zero-downtime
 * deploy chahiye to Redis me shift karo.
 */
const sessions = new Map();
const TTL_MS = 2 * 60 * 60 * 1000;

function newSession() {
  return {
    messages: [], // { role: 'user' | 'assistant', content }
    patientName: null,
    nameConfirmed: false,
    doctorName: null,
    date: null,
    selectedTime: null,
    reason: null,
    appointmentBooked: false,
    appointments: [],
    callerPhone: null,
    createdAt: Date.now(),
    touchedAt: Date.now(),
  };
}

function getSession(callSid) {
  let s = sessions.get(callSid);
  if (!s) {
    s = newSession();
    sessions.set(callSid, s);
  }
  s.touchedAt = Date.now();
  return s;
}

function clearSession(callSid) {
  sessions.delete(callSid);
}

function activeSessionCount() {
  return sessions.size;
}

setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [sid, s] of sessions) if (s.touchedAt < cutoff) sessions.delete(sid);
}, 10 * 60 * 1000).unref();

module.exports = { getSession, clearSession, activeSessionCount };
