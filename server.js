require('dotenv').config();
const express = require('express');
const { GoogleGenAI, Type } = require('@google/genai');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static('public'));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = 'gemini-3.6-flash';

const EXACTITUDES_BASE = 'https://exactitudes.com/wp-json/custom-rest/v1';

// In-memory cache of the real 202-tribe index, fetched once from exactitudes.com.
let tribeCache = null;
let tribeCacheAt = 0;
const CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour is plenty for a one-day demo

async function getTribes() {
  const fresh = tribeCache && (Date.now() - tribeCacheAt) < CACHE_TTL_MS;
  if (fresh) return tribeCache;

  const res = await fetch(`${EXACTITUDES_BASE}/serie-index`);
  if (!res.ok) throw new Error(`serie-index fetch failed: ${res.status}`);
  const raw = await res.json();

  // raw items look like: { ID, post_title, slug, link, ser__loc, ser__year }
  tribeCache = raw.map(t => ({
    id: t.ID,
    title: t.post_title,           // e.g. "018. Mohawks"
    name: t.post_title.replace(/^\d+\.\s*/, ''), // e.g. "Mohawks"
    location: t.ser__loc,
    year: t.ser__year,
  }));
  tribeCacheAt = Date.now();
  return tribeCache;
}

async function getSeriesImages(wpId) {
  const res = await fetch(`${EXACTITUDES_BASE}/serie?ID=${wpId}`);
  if (!res.ok) throw new Error(`serie fetch failed: ${res.status}`);
  const data = await res.json();
  const imgs = (data.post && data.post.imgs) || [];
  // "medium" is a consistent square-ish crop close to the original grid framing.
  return imgs
    .map(img => (img.sizes && (img.sizes.medium || img.sizes.large)) || img.url)
    .filter(Boolean);
}

function parseDataUrl(dataUrl) {
  const match = /^data:(.+?);base64,(.+)$/.exec(dataUrl || '');
  if (!match) throw new Error('Expected a base64 data URL image');
  return { mediaType: match[1], base64: match[2] };
}

async function classifyStyle(image, tribes) {
  const { mediaType, base64 } = parseDataUrl(image);
  const tribeListText = tribes
    .map(t => `${t.title} — ${t.location} ${t.year}`)
    .join('\n');

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text:
              'You are doing a visual style match for an Exactitudes-style installation. ' +
              'Exactitudes (Ari Versluis & Ellie Uyttenbroek) groups people into visual "tribes" by dress code. ' +
              'Given the attached photo of a visitor and the full list of real Exactitudes tribes below ' +
              '(each line is "<title> \u2014 <location> <year>"), pick the ONE tribe whose dress code most closely ' +
              'matches the visitor\'s clothing, colors, silhouette and accessories. ' +
              'matched_title MUST be ONLY the title portion of that line, the text before the \u2014 character, ' +
              'copied exactly, character for character. Do NOT include the location or year in matched_title. ' +
              'For example, if the matching line is "200. Sad Ambient Boys \u2014 The Hague 2025", ' +
              'matched_title must be exactly "200. Sad Ambient Boys".\n\n' +
              `Tribe list:\n${tribeListText}`,
          },
          { inlineData: { mimeType: mediaType, data: base64 } },
        ],
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          matched_title: {
            type: Type.STRING,
            description: 'Exact tribe title string, copied verbatim from the provided list.',
          },
          style_notes: {
            type: Type.STRING,
            description: 'One sentence on what was seen: colors, garments, silhouette, accessories.',
          },
          caption: {
            type: Type.STRING,
            description: 'One dry, observational sentence in the Exactitudes style, not a marketing tone.',
          },
        },
        required: ['matched_title', 'style_notes', 'caption'],
      },
    },
  });

  if (!response.text) throw new Error('Gemini returned no text output');
  return JSON.parse(response.text);
}

function findTribe(tribes, rawTitle) {
  const raw = String(rawTitle || '').trim();
  if (!raw) return null;

  // The model sometimes echoes the whole "<title> \u2014 <location> <year>" line
  // instead of just the title, so strip anything from an em/en dash or hyphen onward.
  const cleaned = raw.split(/\s[\u2014\u2013-]\s/)[0].trim();

  return (
    tribes.find(t => t.title === raw) ||
    tribes.find(t => t.title === cleaned) ||
    tribes.find(t => t.title.toLowerCase() === cleaned.toLowerCase()) ||
    // fall back to matching the leading catalog number, e.g. "200." in "200. Sad Ambient Boys"
    tribes.find(t => {
      const num = cleaned.match(/^(\d+)\./);
      return num && t.title.startsWith(`${num[1]}.`);
    }) ||
    tribes.find(t => t.title.toLowerCase().includes(cleaned.toLowerCase())) ||
    tribes.find(t => cleaned.toLowerCase().includes(t.title.toLowerCase())) ||
    null
  );
}

app.get('/api/tribes', async (req, res) => {
  try {
    const tribes = await getTribes();
    res.json(tribes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load tribe index from exactitudes.com' });
  }
});

app.post('/api/exactitude', async (req, res) => {
  try {
    const { image } = req.body; // data URL, e.g. "data:image/jpeg;base64,...."
    if (!image) return res.status(400).json({ error: 'Missing image' });

    const tribes = await getTribes();
    const parsed = await classifyStyle(image, tribes);

    const matched = findTribe(tribes, parsed.matched_title);

    if (!matched) {
      return res.status(502).json({ error: 'Model did not return a recognizable tribe title', raw: parsed });
    }

    const images = await getSeriesImages(matched.id);

    res.json({
      tribe: matched.name,
      location: matched.location,
      year: matched.year,
      styleNotes: parsed.style_notes,
      caption: parsed.caption,
      // Leave one slot open for the visitor's own captured photo on the frontend.
      images: images.slice(0, 11),
      credit: 'Portraits: Exactitudes by Ari Versluis & Ellie Uyttenbroek, exactitudes.com',
    });
  } catch (err) {
    console.error(err);
    // TEMP for debugging today: include the real message in the response.
    // Remove err.message from here before this ever goes public.
    res.status(500).json({ error: 'Something went wrong building your Exactitude', detail: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Exactitudes mirror running on http://localhost:${PORT}`));
