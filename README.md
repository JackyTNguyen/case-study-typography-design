# Exactitudes Mirror

An interactive installation. A visitor stands in front of a camera and a screen, raises a hand to take a photo, and the app matches their clothing, hair and accessories to one of the real tribes in the [Exactitudes](https://exactitudes.com) archive by Ari Versluis & Ellie Uyttenbroek. The result screen fills with that tribe's actual portraits, with the visitor's photo among them, plus a QR code to take the image home.

## Setup

```bash
npm install
cp .env.example .env         # then add GEMINI_API_KEY
npm run seed                 # writes data/tribes.json (the tribe index, ~202 entries)
npm run fetch-hand-model     # optional: saves the MediaPipe hand model locally
npm start
```

Open `http://localhost:3000` in Chrome on the kiosk machine, full screen (F11 / ⌃⌘F), and allow the camera and microphone.

- `?mouse=1` makes the mouse act as a tracked hand, for testing without a camera.
- Space/Enter takes a photo (or retries), and Esc/R resets. These are backups for the operator; visitors don't need them.

Re-run `npm run seed` by hand when Exactitudes publishes a new series.

## AI provider (the fragile bit)

| | |
|---|---|
| Provider | Google Gemini via `@google/genai` |
| Model | `GEMINI_MODEL`, tested with `gemini-3.6-flash` on 2026-09-23 |
| Billing | Prepay must be funded at ai.studio/projects. An unfunded "free tier" project returns `429 RESOURCE_EXHAUSTED` regardless of spend cap |

Before an exhibition, make one throwaway call to confirm the model ID still exists and billing works. Model IDs get deprecated (2.5-flash already was, mid-project).

Classification uses a forced JSON schema where `title` is an `enum` of the 202 real titles, so the model can't invent a tribe. `lib/tribes.js` then resolves the title defensively anyway (strips echoed "— City Year", folds accents, falls back to name, catalogue number, or substring). Pose, stance and background are explicitly excluded in the prompt.

## How it's wired

```
browser (kiosk, localhost:3000)             server
  camera → mirrored full-screen preview
  MediaPipe hands → dwell on button
  countdown → square crop → JPEG  ──POST /api/match──▶ Gemini (photo + local tribe list)
                                                      exactitudes.com /serie?ID= (live, full series)
                                  ◀── tribe, context, caption, image URLs, QR svg
  grid of hotlinked portraits + visitor              composite PNG rendered in memory (sharp)

phone ──── http://<LAN-IP>:3001/results/<random> ──▶ results-only server
```

- **Two servers.** The kiosk + API listen on `127.0.0.1:3000` only. A second server on `0.0.0.0:3001` serves nothing but `/results/<id>` (a bare viewer page that requests the PNG in the phone's own screen shape) and `/results/<id>.png`, so phones on the network can't reach the Gemini endpoint.
- **Stateless by default.** Visitor photos are never written to disk. The composite PNG is kept in memory under a 144-bit random ID and deleted after `RESULT_TTL_MINUTES` (default 20). That is the one deliberate exception, made so the QR code works.
- **No image caching.** Exactitudes portraits are fetched live, per match, and only for the matched series. The browser hotlinks them and the compositor fetches them into memory once.
- **Grid layout** is shared (`public/js/layout.js`) between the screen and the PNG, so the download matches what's shown. Cells are uniform and fill edge to edge. The column count is chosen to keep cells near square and gaps minimal, and any leftover slots are pastel.

## Deployment checklist

- **Screen size:** not confirmed yet. The layout adapts to any viewport, but the standing guide's position (right of the consent panel on landscape screens, centred on portrait) should be checked on the real kiosk screen and camera.
- **Phone reachability:** the QR points at the machine's LAN IP (auto-detected, or set `PUBLIC_HOST`). Scan it from a real phone on the same Wi-Fi. If the venue Wi-Fi isolates clients, set `USE_NGROK=true` with an authtoken.
- **Voice** uses Chrome's Web Speech API, which sends audio to Google's speech service and needs internet. Commands: "take my photo", "cheese", "photo" / "again", "restart".
- **Rate limits:** 429s from Gemini or exactitudes.com show a "Busy" retry screen. Revisit before any high-traffic use.

## Copyright

The portraits are Ari Versluis & Ellie Uyttenbroek's copyrighted work. Live-fetching with an on-screen credit line is the agreed approach for a private, class or demo context. **Any public exhibition or deployment needs the artists' permission first.**

## Out of scope

Pose or face normalisation, a persistent growing archive, image caching, multi-language UI, analytics, and full screen-reader support.
