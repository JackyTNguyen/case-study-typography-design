// The locally stored tribe index, plus defensive mapping of whatever the model
// returns onto a real entry. Never invents a tribe: no match means null.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'tribes.json');
let cache = null;

function loadTribes() {
  if (cache) return cache;
  if (!fs.existsSync(FILE)) throw new Error('data/tribes.json is missing. Run `npm run seed` first.');
  const { tribes } = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (!Array.isArray(tribes) || !tribes.length) throw new Error('data/tribes.json contains no tribes');
  cache = tribes;
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
