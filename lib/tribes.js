// Local tribe index (seeded by scripts/seed-tribes.js) and defensive title resolution.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'tribes.json');
let cache = null;

function loadTribes() {
  if (cache) return cache;
  if (!fs.existsSync(FILE)) {
    throw new Error('data/tribes.json is missing. Run `npm run seed` once before starting the server.');
  }
  const { tribes } = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (!Array.isArray(tribes) || tribes.length === 0) throw new Error('data/tribes.json has no tribes');
  cache = tribes;
  return cache;
}

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
  const m = String(title).match(/^\s*#?(\d{1,3})\s*[.)\-:]?\s*(.*)$/);
  return m ? { num: Number(m[1]), name: fold(m[2]) } : { num: null, name: fold(title) };
}

// Map whatever the model returned onto a real index entry, or null. Never invents a tribe.
function resolveTribe(raw) {
  const tribes = loadTribes();
  if (!raw) return null;

  let s = String(raw).trim().replace(/^["'“”]+|["'“”]+$/g, '');
  const exact = tribes.find((t) => t.title === s);
  if (exact) return exact;

  // Strip an echoed "— Rotterdam 1994" / "(Rotterdam, 1994)" / " - The Hague 2025" suffix.
  s = s.replace(/\s*[—–|]\s.*$/, '').replace(/\s+-\s+.*$/, '').replace(/\s*\([^)]*\)\s*$/, '').trim();

  const folded = fold(s);
  const byFold = tribes.find((t) => fold(t.title) === folded);
  if (byFold) return byFold;

  const { num, name } = split(s);
  if (name) {
    const byName = tribes.find((t) => split(t.title).name === name);
    if (byName) return byName;
  }
  if (num !== null) {
    const byNum = tribes.find((t) => split(t.title).num === num);
    if (byNum) return byNum;
  }
  if (name && name.length >= 4) {
    const bySub = tribes.find((t) => {
      const tn = split(t.title).name;
      return tn && (tn.includes(name) || name.includes(tn));
    });
    if (bySub) return bySub;
  }
  return null;
}

module.exports = { loadTribes, resolveTribe };
