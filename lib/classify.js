// Gemini vision call: the visitor's photo + the local tribe list in, a
// structured match out. The title field is an enum of the real titles, so the
// model can't invent a tribe; resolveTribe() still cleans up the answer.
const { GoogleGenAI } = require('@google/genai');
const { loadTribes, resolveTribe } = require('./tribes');
const { AppError } = require('./errors');

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const MULTI_MATCH = String(process.env.MULTI_MATCH || 'false').toLowerCase() === 'true';
const MAX_MATCHES = MULTI_MATCH ? 3 : 1;

let client = null;
function ai() {
  if (!process.env.GEMINI_API_KEY) throw new AppError('AI_UNAVAILABLE', 'GEMINI_API_KEY is not set', 500);
  client = client || new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

function prompt(tribes) {
  const list = tribes.map((t) => `${t.title} — ${t.location} ${t.year}`).join('\n');
  const howMany = MULTI_MATCH
    ? `Return 1 to ${MAX_MATCHES} matches, best first. Only return more than one when the person's style genuinely overlaps several tribes; a single clear match is the normal case.`
    : 'Return exactly one match: the single best tribe.';

  return `You are the cataloguer for Exactitudes, the photographic archive by Ari Versluis and Ellie Uyttenbroek that documents the dress codes of social groups. Every tribe below is a real series from the archive.

Match the person in the photo to the tribe whose dress code they share.

Judge ONLY what the person wears and how they have styled themselves:
- clothing (garments, cut, fit, fabrics, colours, logos, layering)
- hairstyle (cut, colour, styling, facial hair)
- accessories (glasses, jewellery, headwear, bags, watches, visible shoes)

Explicitly IGNORE, and do not let any of these influence the match:
- pose, stance, posture, gestures, raised arms or hands, facial expression
- the background, the room, the surroundings, lighting, camera quality, framing

${howMany}

For each match:
- "title": the tribe title copied EXACTLY from the list, e.g. "001. Gabbers". Title only, no location or year.
- "styleDescription": one sentence naming the specific clothing, hair and accessory cues that tie this person to the tribe.
- "caption": one sentence in the Exactitudes tone: dry, observational, deadpan, like a museum wall label written by an anthropologist. No marketing language, no compliments, no exclamation marks, no "you".

If no tribe fits well, still choose the closest one. Never name a tribe that is not on the list.

Tribes:
${list}`;
}

const isRateLimit = (err) => /429|RESOURCE_EXHAUSTED|rate/i.test(`${err && err.status} ${err && err.message}`);

async function classify(jpegBase64) {
  const tribes = loadTribes();
  const schema = {
    type: 'object',
    properties: {
      matches: {
        type: 'array',
        minItems: 1,
        // Gemini rejects maxItems > 1 alongside a ~200-value enum, so in multi
        // mode the cap is enforced by the prompt and the slice below.
        ...(MULTI_MATCH ? {} : { maxItems: 1 }),
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', enum: tribes.map((t) => t.title) },
            styleDescription: { type: 'string' },
            caption: { type: 'string' },
          },
          required: ['title', 'styleDescription', 'caption'],
        },
      },
    },
    required: ['matches'],
  };

  let response;
  try {
    response = await ai().models.generateContent({
      model: MODEL,
      contents: [
        {
          role: 'user',
          parts: [{ inlineData: { mimeType: 'image/jpeg', data: jpegBase64 } }, { text: prompt(tribes) }],
        },
      ],
      config: { responseMimeType: 'application/json', responseJsonSchema: schema },
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (isRateLimit(err)) throw new AppError('RATE_LIMITED', 'The AI provider is rate limiting', 429);
    throw new AppError('AI_UNAVAILABLE', `Gemini call failed: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(response.text);
  } catch {
    throw new AppError('AI_BAD_RESPONSE', 'Gemini did not return valid JSON');
  }

  const seen = new Set();
  const matches = (Array.isArray(parsed.matches) ? parsed.matches : [])
    .map((m) => ({ m, tribe: resolveTribe(m && m.title) }))
    .filter(({ tribe }) => tribe && !seen.has(tribe.id) && seen.add(tribe.id))
    .slice(0, MAX_MATCHES)
    .map(({ m, tribe }) => ({
      tribe,
      styleDescription: String(m.styleDescription || '').trim(),
      caption: String(m.caption || '').trim(),
    }));

  if (!matches.length) {
    throw new AppError('AI_BAD_RESPONSE', `No recognisable tribe in: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  return matches;
}

module.exports = { classify, MODEL, MULTI_MATCH };
