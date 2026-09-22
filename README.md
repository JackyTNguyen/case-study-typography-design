# Exactitudes Mirror

Stand in front of the camera, raise a hand over the on-screen button, and get
matched to one of the real tribes from [Exactitudes](https://exactitudes.com)
by Ari Versluis & Ellie Uyttenbroek. Your photo gets slotted into a grid with
11 real portraits from that tribe's actual series, pulled live from the
Exactitudes site, plus a QR code to download the result on your phone.

Built to the technical requirements in
`Project Resources/Technical Requirements - Exactitudes Mirror.md`.

## Setup

1. `npm install`
2. Open `.env` (already created from `.env.example`) and confirm:
   - `GEMINI_API_KEY` — a Gemini key from https://aistudio.google.com/apikey.
     The free tier can still return `429 RESOURCE_EXHAUSTED` until the
     project's prepay billing is actually funded at ai.studio/projects,
     regardless of any spend cap shown. Worth a throwaway test call before
     relying on it — `npm start` then open the app and take one photo.
   - `GEMINI_MODEL` — verify this is still the current model ID before
     relying on it; it has already changed once mid-project
     (`gemini-2.5-flash` → `gemini-3.6-flash`).
   - `PUBLIC_HOST` — leave blank to auto-detect a LAN IP (the server logs
     what it picked on startup), or set it explicitly if that's wrong. This
     is what the QR code on the result screen points to, so it has to be
     reachable from a visitor's own phone, not just from the laptop running
     the server. **If your Wi-Fi has client/AP isolation** (common on
     campus and public networks — devices on the same SSID can't reach each
     other directly, which looks like "can't connect to server" on the
     phone even though the IP is correct), the LAN IP will never work; use
     `USE_NGROK` instead.
   - `USE_NGROK` / `NGROK_AUTHTOKEN` / `NGROK_DOMAIN` — set `USE_NGROK=true`
     and put a free token from
     https://dashboard.ngrok.com/get-started/your-authtoken in
     `NGROK_AUTHTOKEN` to expose the server through an ngrok tunnel instead
     of the LAN IP. This works from any network, including isolated
     campus/public Wi-Fi. **Security note:** while this is on, the QR URL
     is reachable from anyone on the internet who has it, not just people
     in the room — they could hit the Gemini-backed endpoint and burn your
     API quota. Leave it `false` for normal local dev, only turn it on for
     an actual demo/exhibition, and stop the server (`Ctrl+C`, which also
     tears down the tunnel) when you're done. `NGROK_DOMAIN` is optional,
     only needed if you have a reserved static ngrok domain; otherwise you
     get a random `https://<random>.ngrok-free.app` URL each time the
     server starts.
3. `npm run seed` — fetches the ~202 real tribe titles/locations/years from
   exactitudes.com's public index once and writes `data/tribes.json`.
   Re-run this by hand whenever the archive adds new series; it's not
   fetched live on every request. `data/tribes.json` is gitignored — a
   fresh checkout needs to re-run this before the app will classify anyone.
4. `npm start`
5. Open `http://localhost:3000` on the machine running the server, allow
   camera access. To test the QR code, open the LAN URL the server logs
   from an actual phone on the same network (not the same laptop).

## How it works

1. Full-screen mirrored camera preview with a standing-guide outline and a
   consent notice, both visible before any capture.
2. **Hand-tracking capture**: [MediaPipe Tasks Vision](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker)
   (`HandLandmarker`, loaded client-side from a CDN, no camera frames leave
   the browser for this step) tracks the visitor's hand in screen space.
   Holding a hand over the capture button for ~1.2s (a visible ring fills
   in) triggers a 3-2-1 countdown, then a photo — no mouse, touchscreen, or
   physical button needed. The button is still a real, focusable `<button>`
   as a basic keyboard/click fallback.
3. The captured frame is cropped to a center square client-side (matching
   the archive photos' framing) and `POST`ed to `/api/exactitude`.
4. The server sends that photo plus the locally stored tribe list to Gemini
   (`GEMINI_MODEL`), which is instructed to match on clothing, hairstyle,
   and accessories only — explicitly **not** pose or background — and
   returns the matched tribe title plus a one-line Exactitudes-style
   caption as structured JSON. Matching is defensive: it falls back to
   substring/catalog-number matching if the model doesn't echo the title
   verbatim.
5. The server looks up that tribe's real WordPress post ID and fetches its
   actual portraits live from exactitudes.com (never cached to disk).
6. The frontend renders the grid on-screen. In parallel, the server
   composites a flattened PNG of the same result (grid + visitor photo +
   tribe name/location/year + caption + credit line) using `sharp` — done
   server-side because the hotlinked exactitudes.com photos have no CORS
   headers and would taint a client-side `<canvas>`. That PNG is served at
   a short-lived, random `/results/<uuid>.png` URL (default 20 minutes,
   `RESULT_TTL_MINUTES` in `.env`) and encoded into a QR code
   (`qrcode` npm package) shown on the result screen.
7. Any failure (AI provider down/rate-limited, exactitudes.com unreachable,
   camera denied) lands on a clear retry screen instead of a blank page or
   crash.

## Known rough edges / next steps

- **In-memory result expiry doesn't survive a server restart.** If the
  server crashes or restarts between a result being created and its TTL
  elapsing, that PNG is orphaned in `tmp/results/` (gitignored, but not
  auto-cleaned). Fine for a class demo; a cron-style sweep would be the fix
  before any longer-running deployment.
- **Standing-guide outline is a rough placeholder shape**, not tuned to
  match the actual framing of the archive photos — worth refining once
  there's a real target screen/kiosk to test against (see the tech spec's
  note on confirming screen size before building responsive behavior).
- Style-matching quality depends entirely on the prompt in `server.js`;
  expect to tune it after a few live tests with real visitors.
- `npm audit` currently flags a high-severity advisory in `sharp`'s
  bundled `libvips`/`libheif` (affects versions up to `0.35.4-rc.0`, i.e.
  no stable fixed release yet as of this build). Relevant risk here is
  processing images fetched live from exactitudes.com; low risk for a
  private class demo, worth re-checking (`npm audit`) before any public
  use.
- Real people's real photographs from exactitudes.com are displayed and
  composited live (not downloaded in bulk or redistributed beyond the
  single visitor's own result) with an on-screen credit line. Fine for a
  private class/demo context per the tech spec; get the artists'
  permission first before this goes public or gets exhibited beyond class.
- No captured photos or match results are stored beyond the single
  request/response, except the short-lived result PNG that exists only to
  make the QR code work (auto-deleted after `RESULT_TTL_MINUTES`).
