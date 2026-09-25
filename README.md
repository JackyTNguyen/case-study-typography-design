# Exactitudes Mirror (V4)

An interactive installation. A visitor stands in front of a camera and screen and raises a hand to take a photo. The app matches their clothing, hair and accessories to one of the real tribes in the [Exactitudes](https://exactitudes.com) archive by Ari Versluis & Ellie Uyttenbroek. The result screen fills with that tribe's actual portraits, with the visitor among them, cut out and placed on the archive's grey (#F3F3F3). A QR code lets them take the image home.

## Setup

```bash
npm install
cp .env.example .env    # add GEMINI_API_KEY
npm run setup           # tribe index -> data/tribes.json, MediaPipe models -> public/models/
npm start
```

Open `http://localhost:3000` in Chrome on the kiosk machine, full screen, and allow the camera and microphone.

Re-run `npm run seed` by hand when Exactitudes publishes a new series.

**Testing aids:**
- `?mouse=1`: the mouse acts as a tracked hand.
- `?fakecam=<image url>`: feeds a still image in as the camera. The image must be same-origin or CORS-enabled.
- Space/Enter captures or retries, and Esc/R resets. These are for the operator; visitors never need them.

## AI provider (the fragile bit)

| | |
|---|---|
| Provider | Google Gemini via `@google/genai` |
| Model | `GEMINI_MODEL`, tested with `gemini-3.6-flash` on 2026-09-25 |
| Billing | Prepay must be funded at ai.studio/projects. An unfunded "free tier" project returns `429 RESOURCE_EXHAUSTED` regardless of spend cap |

Before an exhibition, make one throwaway call to confirm the model ID still exists and billing works. `gemini-2.5-flash` was already deprecated once mid-project.

Each tribe in the prompt carries a one-line dress-code description from `data/tribe-descriptions.json` (matched by ID). In a quick test of five archive portraits, titles alone put 0 of 5 back in their own series and the descriptions put back all 5, with no extra wait. Tribes without a description, such as a new series picked up by a later `npm run seed`, are matched on title alone, so write a description for each new series. The prompt tells the model to ignore any age, gender or physique wording in the descriptions.

The response schema makes `title` an enum of the ~202 real titles, so the model can't invent a tribe. `lib/tribes.js` still resolves the answer defensively: it strips an echoed "— City Year", folds accents, and falls back to the name, catalogue number or a substring match. The prompt explicitly excludes pose, stance and background. One Gemini quirk: `maxItems > 1` alongside that large enum is rejected with `INVALID_ARGUMENT`, so multi-match mode caps the count in code instead.

## How a capture flows

```
capture ─┬─ original JPEG ── POST /api/match {captureId} ──▶ Gemini + live series fetch ──┐
         │                                                                                  ├─▶ result screen
         └─ MediaPipe segmenter (browser) ─▶ cut-out on #F3F3F3 ─┬─ shown in visitor's tile ┘   (when both are ready)
                                                                 └─ POST /api/cutout {captureId} ─▶ PNG for the QR code
```

- **Background removal** uses MediaPipe's `selfie_multiclass_256x256` in the browser. Everything except the "background" class is kept, so hats, bags and loose hair survive. The mask edge gets a 1.5px blur. The model is warmed up at startup: a cold first run took about 1–5s, while a warm run takes about 50ms against about 4–7s for the AI match.
- **Centring:** the person's outline is measured from the same mask, and they're moved to the centre of the square (shrunk only if they'd fill more than 92% of it). The grid then fills the visitor's cell like the archive photos, unless that would crop the person, in which case it scales down just enough to show all of them. The flat grey makes both steps seamless. The kiosk and the PNG share this logic (`fitVisitor` in `layout.js`).
- **Fallback:** if the segmenter fails, errors, or finds under 3% of a person in frame, the original photo is used. The PNG compositor waits up to 15s from capture for the cut-out, then uses the original. The visitor never sees an error because of this step.
- **Two servers.** The kiosk + API listen on `127.0.0.1:3000` only. A second server on `0.0.0.0:3001` serves just `/results/<id>` (a phone viewer) and `/results/<id>.png`, so phones on the network can't reach the Gemini endpoint.
- **Memory only.** Cut-outs are held by captureId for at most 3 minutes, and only until the result picks them up. Results sit under a 144-bit random ID for `RESULT_TTL_MINUTES` (default 20), then they're deleted. Nothing about a visitor is written to disk.
- **No image caching.** Exactitudes portraits are fetched live, per match, and only for the matched series.
- **Layout** (`public/js/layout.js`) is shared by the screen and the PNG. Photos are split across full-height columns, so the grid always fills the screen with no empty slots. The PNG is re-rendered in the shape of whatever screen opens the QR link.

## Deployment checklist

- **Screen size and camera:** not confirmed yet. Both orientations work: in portrait the guide sits in the top part of the screen with the consent panel below, and in landscape the guide sits right of the panel. Check framing with the real screen and camera.
- **Segmentation speed on the installation laptop:** watch the browser console for `[timing]` lines. The cut-out must finish before the AI match. If MediaPipe's edges look poor on real outfits, the backup is `@imgly/background-removal`: cleaner, but a much larger download, slower, and AGPL. Re-check timing if you switch.
- **Phone reachability:** the QR code points at the machine's LAN IP (auto-detected, or set `PUBLIC_HOST`). Scan it from a real phone on the same Wi-Fi. If the venue isolates Wi-Fi clients, use `USE_NGROK=true`.
- **Voice** uses Chrome's Web Speech API, which sends audio to Google and needs internet. Commands: "take my photo" / "cheese" / "photo", and "again" / "restart".
- **Rate limits:** a 429 from Gemini or exactitudes.com shows a "Busy" retry screen. Revisit before any high-traffic use.

## Copyright

The portraits are Ari Versluis & Ellie Uyttenbroek's copyrighted work. Live-fetching with an on-screen credit line is the agreed approach for a private, class or demo context. **Any public exhibition or deployment needs the artists' permission first.**

## Out of scope

Pose or face normalisation, a persistent growing archive, image caching, multi-language UI, analytics, and full screen-reader support.
