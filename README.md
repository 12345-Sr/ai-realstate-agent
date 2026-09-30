# AI Real Estate Calling Agent: Hindi Voice Agent (Exotel)

Real Estate agency ke liye AI calling & property advisor agent. Real phone calls handle karta hai, Hindi/Hinglish mein natural baat karta hai, projects/flats/villas/plots ki details aur pricing samjhata hai, aur site visit **validate karke** MongoDB mein book karta hai.

```
Caller ──PSTN──► Exotel number ──► Voicebot applet ──wss──► /exotel/media
                                                         │
     ┌───────────── caller audio (8 kHz PCM) ◄───────────┤
     │  VAD + barge-in + end-of-turn (utils/audioDsp)     │
     ▼                                                    │
  Groq Whisper STT ──► LLM (Groq → Gemini fallback)       │
                         │  speech + DRAFT/BOOKING tags   │
                         ▼                                │
                 bookingService (server validation,       │
                 slot capacity, visit slots, idempotent)  │
                         ▼                                │
         TTS: ElevenLabs stream → Sarvam → Edge ──► ≥3200-byte frames
```

## Features & Highlights

| Area | Real Estate Implementation |
|---|---|
| Agency & Advisor | **सिटी हाइट्स रियल्टी** (City Heights Realty, Kanpur), Agent: **मोनिका** (Monika) |
| Projects & Catalog | Luxury Flats (City Greens), Villas (Royal Palm), Plots (Green Valley), Commercial (Apex Plaza) |
| Site Visit Booking | Morning (10:00 AM), Afternoon (2:00 PM), Evening (5:30 PM) |
| Document / Brain | `data/realestate_properties.pdf` + `config/realestateConfig.js` memory brain |
| Loan & Policies | 80% Bank Loan (SBI/HDFC/ICICI), RERA Certified, 10% Token Booking |
| Outbound audio | 3200-byte+ frames, 320 ke multiple (Exotel standard) |
| Barge-in | Caller interrupts → immediate audio cut & context preservation |
| Overlapping turns | Turns serialize; slow LLM abort + text merge |
| Natural Phrasing | Professional consultative Hindi without excessive "जी" repetition |

## Setup & Running

```bash
cp .env.example .env     # values bharo
npm install
npm run dev              # Dev server with watch mode
# or
npm start                # Production server
```

## Projects & Configuration

Sirf `config/realestateConfig.js` edit karein: projects, pricing, amenities, visit shifts, FAQs. Prompt aur availability dynamically isi single source of truth se generate hote hain.

## API (header `X-API-Key: $DASHBOARD_API_KEY`)

- `GET /api/calls`: dashboard format
- `GET /api/appointments`: site visits format
- `POST /exotel/outbound` `{ "to": "98xxxxxxxx" }`
- `GET /health`: DB status + active calls
