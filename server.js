require("dotenv").config();
const http = require("http");
const express = require("express");
const mongoose = require("mongoose");
const connectDB = require("./config/db");

const dataRoutes = require("./routes/dataRoutes");
const exotelRoutes = require("./routes/exotelRoutes");
const { requireApiKey } = require("./middleware/auth");
const { setupExotelWebSocketServer, PHRASES } = require("./services/exotelWsService");
const { preWarmTTS } = require("./services/ttsService");

// Ek call ka unhandled error poore server (aur baaki live calls) ko na gira de
process.on("unhandledRejection", (reason) => console.error("[server] Unhandled rejection:", reason));
process.on("uncaughtException", (err) => console.error("[server] Uncaught exception:", err));

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");

// CORS: sirf allowed dashboard origins (pehle "*" — patient data sabke liye khula tha)
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.urlencoded({ extended: false, limit: "100kb" }));
app.use(express.json({ limit: "100kb" }));

const server = http.createServer(app);
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

app.get("/", (req, res) => res.json({ status: "online", service: "AI Real Estate Calling Agent (City Heights Realty)", wsEndpoint: "/exotel/media" }));

app.get("/health", (req, res) => {
  const dbUp = mongoose.connection.readyState === 1;
  res.status(dbUp ? 200 : 503).json({
    status: dbUp ? "healthy" : "degraded",
    db: dbUp ? "connected" : "disconnected",
    activeCalls: server.activeCalls ? server.activeCalls.size : 0,
    uptimeSec: Math.round(process.uptime()),
  });
});

app.use("/exotel", exotelRoutes);
app.use("/api", requireApiKey, dataRoutes);

setupExotelWebSocketServer(server);

const PORT = process.env.PORT || 3000;
connectDB()
  .then(() => {
    server.listen(PORT, () => {
      const domain = (process.env.BASE_URL || `localhost:${PORT}`).replace(/^https?:\/\//, "").replace(/\/$/, "");
      console.log(`[server] listening on ${PORT} | Exotel stream URL: wss://${domain}/exotel/media`);
      // Greeting + fillers pehle se render => call uthte hi awaaz, LLM slow ho to filler turant
      preWarmTTS([PHRASES.greeting, ...PHRASES.fillers, ...PHRASES.reprompts, PHRASES.goodbye, PHRASES.handoff], [8000]).catch(
        (err) => console.warn("[server] TTS pre-warm failed (non-fatal):", err.message)
      );
    });
  })
  .catch((err) => {
    console.error("[server] Failed to start:", err);
    process.exit(1);
  });

// Graceful shutdown: deploy pe Render SIGTERM bhejta hai — chal rahi calls ko khatam hone do
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${signal} — draining ${server.activeCalls?.size || 0} active call(s)`);
  server.close();
  const deadline = Date.now() + Number(process.env.SHUTDOWN_GRACE_MS || 25_000);
  const tick = setInterval(async () => {
    if ((server.activeCalls?.size || 0) === 0 || Date.now() > deadline) {
      clearInterval(tick);
      await mongoose.connection.close().catch(() => {});
      process.exit(0);
    }
  }, 500);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

module.exports = { app, server };
