// Fetches the full Exactitudes tribe index (metadata only: titles, locations,
// years) once from exactitudes.com and writes it to data/tribes.json.
// Run by hand (`npm run seed`) whenever the archive gets new series -
// no automatic refresh, per the technical requirements.
const fs = require('fs');
const path = require('path');

const EXACTITUDES_BASE = 'https://exactitudes.com/wp-json/custom-rest/v1';
const OUT_PATH = path.join(__dirname, '..', 'data', 'tribes.json');

async function main() {
  console.log(`Fetching ${EXACTITUDES_BASE}/serie-index ...`);
  const res = await fetch(`${EXACTITUDES_BASE}/serie-index`);
  if (!res.ok) throw new Error(`serie-index fetch failed: ${res.status}`);
  const raw = await res.json();

  const tribes = raw.map(t => ({
    id: t.ID,
    title: t.post_title,
    name: t.post_title.replace(/^\d+\.\s*/, ''),
    location: t.ser__loc,
    year: t.ser__year,
  }));

  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(tribes, null, 2));
  console.log(`Wrote ${tribes.length} tribes to ${path.relative(process.cwd(), OUT_PATH)}`);
}

main().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
