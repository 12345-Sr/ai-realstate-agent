const crypto = require("crypto");

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Protects dashboard + admin endpoints with DASHBOARD_API_KEY.
 * Send as header `X-API-Key: <key>` or `Authorization: Bearer <key>`.
 */
function requireApiKey(req, res, next) {
  const expected = process.env.DASHBOARD_API_KEY;
  if (!expected) {
    if (process.env.NODE_ENV === "production") {
      return res.status(503).json({ error: "DASHBOARD_API_KEY not configured" });
    }
    return next(); // local dev
  }
  const provided = req.get("X-API-Key") || (req.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!provided || !safeEqual(provided, expected)) return res.status(401).json({ error: "Unauthorized" });
  next();
}

module.exports = { requireApiKey };
