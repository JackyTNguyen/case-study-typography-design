// Fetches the full Exactitudes tribe index once and writes it to data/tribes.json.
// Re-run by hand (npm run seed) to pick up newly published series.
const fs = require('fs');
const path = require('path');

const INDEX_URL = 'https://exactitudes.com/wp-json/custom-rest/v1/serie-index';
const OUT = path.join(__dirname, '..', 'data', 'tribes.json');

async function main() {
  const res = await fetch(INDEX_URL, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`exactitudes.com returned ${res.status}`);
  const raw = await res.json();
  if (!Array.isArray(raw)) throw new Error('Unexpected index shape: expected an array');

  const tribes = raw
    .filter((t) => t && t.ID && t.post_title)
    .map((t) => ({
      id: t.ID,
      title: String(t.post_title).trim(),
      slug: t.slug,
      link: t.link,
      location: t.ser__loc || '',
      year: t.ser__year || '',
    }));

  if (tribes.length === 0) throw new Error('Index was empty; not overwriting data/tribes.json');

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ fetchedAt: new Date().toISOString(), tribes }, null, 2));
  console.log(`Wrote ${tribes.length} tribes to ${path.relative(process.cwd(), OUT)}`);
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
