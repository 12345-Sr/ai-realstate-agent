const express = require("express");
const hospitalConfig = require("../config/hospitalConfig");
const CallLog = require("../models/CallLog");
const { getSession } = require("../utils/sessions");
const { getAIReply, parseReply } = require("../services/aiService");
const { requireApiKey } = require("../middleware/auth");

const router = express.Router();

/**
 * Exotel Greeting applet ("Read text from URL"). text/plain return karta hai.
 */
router.all("/greeting", async (req, res) => {
  const params = { ...req.query, ...req.body };
  const callSid = params.CallSid || params.CallUUID;
  const from = params.From || params.Caller;

  if (callSid) {
    CallLog.findOneAndUpdate(
      { callSid },
      {
        $setOnInsert: {
          callSid,
          direction: "inbound",
          ...(from ? { from } : {}),
          ...(params.To ? { to: params.To } : {}),
        },
      },
      { upsert: true }
    ).catch((err) => console.error("[exotel] DB log error:", err.message));
    const session = getSession(callSid);
    if (from) session.callerPhone = from;
  }

  res.type("text/plain; charset=utf-8").send(hospitalConfig.greeting);
});

/**
 * Passthru applet (DTMF menus). Kept for backward compatibility.
 */
router.all(["/inbound", "/passthru"], async (req, res) => {
  const params = { ...req.query, ...req.body };
  const callSid = params.CallSid || params.CallUUID || `EXO_${Date.now()}`;
  const digits = params.Digits || params.digits;
  const session = getSession(callSid);
  if (!session.callerPhone && params.From) session.callerPhone = params.From;

  if (digits) {
    session.messages.push({ role: "user", content: `Caller ne option ${digits} dabaya` });
    try {
      const { speech } = parseReply(await getAIReply(session.messages, session));
      session.messages.push({ role: "assistant", content: speech });
      return res.type("text/plain; charset=utf-8").send(speech);
    } catch (err) {
      console.error("[/exotel/passthru] AI error:", err.message);
    }
  }
  res.type("text/plain; charset=utf-8").send(hospitalConfig.greeting);
});

/**
 * Outbound call trigger.
 *
 * SECURITY FIX: pehle bina auth ke khula tha — internet pe koi bhi
 * POST /exotel/outbound {"to": "<koi bhi number>"} karke AAPKE Exotel account se
 * calls lagwa sakta tha (toll fraud / bill). Ab DASHBOARD_API_KEY zaroori.
 */
router.post("/outbound", requireApiKey, async (req, res) => {
  const { to, appId } = req.body || {};
  const digits = String(to || "").replace(/[^\d+]/g, "");
  if (!/^\+?\d{10,13}$/.test(digits)) {
    return res.status(400).json({ error: "Valid 'to' phone number required" });
  }

  const { EXOTEL_SID: sid, EXOTEL_API_KEY: key, EXOTEL_API_TOKEN: token } = process.env;
  const flowId = appId || process.env.EXOTEL_APP_ID;
  if (!sid || !key || !token || !flowId) {
    return res.status(500).json({ error: "Exotel credentials / EXOTEL_APP_ID not configured" });
  }
  const callerId = String(process.env.EXOTEL_PHONE_NUMBER || "").replace(/\D/g, "");

  const form = new URLSearchParams({
    From: digits,
    CallerId: callerId,
    Url: `https://my.exotel.com/${sid}/exoml/start_voice/${flowId}`,
  });

  try {
    const response = await fetch(`https://api.exotel.com/v1/Accounts/${sid}/Calls/connect.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${key}:${token}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
      signal: AbortSignal.timeout(10000),
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 500) };
    }
    return res.status(response.ok ? 200 : 502).json({ success: response.ok, exotelResponse: data });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
