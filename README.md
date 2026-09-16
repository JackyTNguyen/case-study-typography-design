# Exactitudes Mirror (POC B)

Stand in front of the camera, take a photo, and get matched to one of the
202 real tribes from [Exactitudes](https://exactitudes.com) by Ari Versluis
& Ellie Uyttenbroek. Your photo gets slotted into a grid with 11 real
portraits from that tribe's actual series, pulled live from the
Exactitudes site.

No image generation, no downloaded dataset: the matched tribe's photos are
fetched live from exactitudes.com's own JSON API each time (see
`server.js` for the two endpoints used: `serie-index` and `serie?ID=`).

## Setup

1. `npm install`
2. Open `.env` (already created from `.env.example`) and put your own
   Gemini API key in it. Get a free one, no credit card needed, at
   https://aistudio.google.com/apikey. There's only one key per project;
   which model gets used is set in the code (`MODEL` constant in
   `server.js`), not something you pick when creating the key.
   Never commit `.env`.
3. `npm start`
4. Open http://localhost:3000, allow camera access.

## How it works

1. Browser captures a photo after a 3-2-1 countdown.
2. `POST /api/exactitude` sends that photo plus the full list of 202 real
   tribe titles to Gemini (model: `gemini-2.5-flash`, on the free tier),
   which picks the closest match and writes a one-line caption in the
   Exactitudes style, returned as structured JSON.
3. The server looks up that tribe's real WordPress post ID and fetches its
   actual 12 portraits from exactitudes.com.
4. The frontend lays out an 11-photo grid from the real series plus your
   own captured photo, Exactitudes-style: neutral crop, uniform grid, tribe
   name and location/year underneath.

## Known rough edges (day-one POC)

- Style matching quality depends entirely on the prompt in `server.js`;
  expect to tune it after a few live tests.
- The free Gemini tier has rate limits and Google may use free-tier
  prompts/images to improve their products; fine for a class demo, worth
  knowing before pointing this at real visitors at scale.
- No face/pose cropping yet: the visitor's photo is a plain square crop of
  the webcam frame, not normalized to match the archive photos' framing.
  A next pass could add pose-guide overlays during the countdown.
- No captured photos are saved anywhere; each session is stateless. If a
  growing on-wall archive becomes part of the concept, that's a deliberate
  addition, not an accident.
- Real people's real photographs from exactitudes.com are displayed live
  in the browser (not downloaded/redistributed) with an on-screen credit
  line. Fine for a class demo; if this ever goes public or gets exhibited
  beyond class, get in touch with the artists first.
