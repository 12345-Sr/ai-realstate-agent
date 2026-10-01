const express = require("express");
const realestateConfig = require("../config/realestateConfig");
const CallLog = require("../models/CallLog");
const { getSession, detectRegion } = require("../utils/sessions");
const { getAIReply, parseReply } = require("../services/aiService");
const { requireApiKey } = require("../middleware/auth");

const router = express.Router();

/**
 * Voicebot / AgentStream dynamic endpoint.
 * When Exotel Voicebot applet uses dynamic URL, Exotel sends HTTP GET/POST:
 * It expects JSON: { "url": "wss://..." }
 */
router.all(["/media", "/stream", "/voicebot", "/agentstream"], async (req, res) => {
  const domain = (process.env.BASE_URL || "ai-realstate-agent.onrender.com").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const wsUrl = `wss://${domain}/exotel/media`;
  const params = { ...req.query, ...req.body };
  const callSid = params.CallSid || params.CallUUID;
  const from = params.From || params.Caller;
  const to = params.To;

  console.log(`[exotel-http] 📞 Applet dynamic URL requested on ${req.originalUrl || req.url} | callSid=${callSid || "?"} from=${from || "?"} to=${to || "?"}`);

  if (callSid) {
    CallLog.findOneAndUpdate(
      { callSid },
      {
        $setOnInsert: {
          callSid,
          direction: "inbound",
          startedAt: new Date(),
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
        },
      },
      { upsert: true }
    ).catch((err) => console.error("[exotel-http] DB log error:", err.message));
  }

  res.status(200).json({
    url: wsUrl,
    stream_url: wsUrl,
    ws_url: wsUrl,
    endpoint: wsUrl,
    status: "ok",
  });
});

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
    if (from) {
      session.callerPhone = from;
      session.region = detectRegion(from);
    }
  }

  res.type("text/plain; charset=utf-8").send(realestateConfig.greeting);
});

/**
 * Passthru applet (DTMF menus). Kept for backward compatibility.
 */
router.all(["/inbound", "/passthru"], async (req, res) => {
  const params = { ...req.query, ...req.body };
  const callSid = params.CallSid || params.CallUUID || `EXO_${Date.now()}`;
  const digits = params.Digits || params.digits;
  const session = getSession(callSid);
  if (!session.callerPhone && params.From) {
    session.callerPhone = params.From;
    session.region = detectRegion(params.From);
  }

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
  res.type("text/plain; charset=utf-8").send(realestateConfig.greeting);
});

/**
 * Inbound-only verification endpoint: GET/POST /exotel/check
 */
router.all("/check", (req, res) => {
  const domain = (process.env.BASE_URL || "ai-realstate-agent.onrender.com").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const wsUrl = `wss://${domain}/exotel/media`;
  res.json({
    service: "AI Real Estate Calling Agent (City Heights Realty)",
    mode: "inbound_only",
    inboundPhone: process.env.EXOTEL_PHONE_NUMBER || "08047289335",
    exotelSid: process.env.EXOTEL_SID || "webtech8",
    flowId: process.env.EXOTEL_APP_ID || "1351362",
    wsEndpoint: wsUrl,
    dynamicUrl: `https://${domain}/exotel/media`,
    status: "ready_for_inbound_calls",
    outboundDisabled: true,
  });
});

/**
 * Outbound calls are disabled - system is inbound only.
 */
router.all("/outbound", (req, res) => {
  return res.status(403).json({
    error: "Outbound calling is disabled. This service only accepts inbound phone calls.",
    mode: "inbound_only",
    inboundNumber: process.env.EXOTEL_PHONE_NUMBER || "08047289335",
  });
});

module.exports = router;
