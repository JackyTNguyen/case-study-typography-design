// The locally stored tribe index, plus defensive mapping of whatever the model
// returns onto a real entry. Never invents a tribe: no match means null.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'tribes.json');
// Optional: a one-line dress-code description per tribe, keyed by id. Tribes
// without one (e.g. a series added by a later seed) are matched on title alone.
const DESCRIPTIONS = path.join(__dirname, '..', 'data', 'tribe-descriptions.json');
let cache = null;

function loadDescriptions() {
  if (!fs.existsSync(DESCRIPTIONS)) return new Map();
  try {
    const list = JSON.parse(fs.readFileSync(DESCRIPTIONS, 'utf8'));
    return new Map(
      (Array.isArray(list) ? list : [])
        .filter((d) => d && d.id && typeof d.dressCode === 'string' && d.dressCode.trim())
        .map((d) => [d.id, d.dressCode.trim()])
    );
  } catch (err) {
    console.warn(`! data/tribe-descriptions.json could not be read (${err.message}); matching on titles only.`);
    return new Map();
  }
}

function loadTribes() {
  if (cache) return cache;
  if (!fs.existsSync(FILE)) throw new Error('data/tribes.json is missing. Run `npm run seed` first.');
  const { tribes } = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (!Array.isArray(tribes) || !tribes.length) throw new Error('data/tribes.json contains no tribes');
  const dress = loadDescriptions();
  cache = tribes.map((t) => (dress.has(t.id) ? { ...t, dressCode: dress.get(t.id) } : t));
  return cache;
}

// Lowercase, strip accents and punctuation: "Première Ligne" -> "premiere ligne".
function fold(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// "200. Sad Ambient Boys" -> { num: 200, name: "sad ambient boys" }
function split(title) {
  const m = String(title).match(/^\s*#?(\d{1,3})\s*[.):-]?\s*(.*)$/);
  return m ? { num: Number(m[1]), name: fold(m[2]) } : { num: null, name: fold(title) };
}

function resolveTribe(raw) {
  if (!raw) return null;
  const tribes = loadTribes();

  let s = String(raw).trim().replace(/^["'“”]+|["'“”]+$/g, '');
  const exact = tribes.find((t) => t.title === s);
  if (exact) return exact;

  // Drop an echoed suffix: "— Rotterdam 1994", " - The Hague 2025", "(Paris, 2025)".
  s = s.replace(/\s*[—–|]\s.*$/, '').replace(/\s+-\s+.*$/, '').replace(/\s*\([^)]*\)\s*$/, '').trim();

  const folded = fold(s);
  const { num, name } = split(s);
  return (
    tribes.find((t) => fold(t.title) === folded) ||
    (name && tribes.find((t) => split(t.title).name === name)) ||
    (num !== null && tribes.find((t) => split(t.title).num === num)) ||
    (name.length >= 4 &&
      tribes.find((t) => {
        const tn = split(t.title).name;
        return tn && (tn.includes(name) || name.includes(tn));
      })) ||
    null
  );
}

module.exports = { loadTribes, resolveTribe };
