// Live, per-visitor fetches from exactitudes.com. Nothing here is written to disk.
const { AppError } = require('./errors');

const SERIES_URL = 'https://exactitudes.com/wp-json/custom-rest/v1/serie?ID=';
const TIMEOUT_MS = 10000;

async function get(url, as) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new AppError('SOURCE_UNAVAILABLE', `exactitudes.com unreachable: ${err.message}`);
  }
  if (res.status === 429) throw new AppError('RATE_LIMITED', 'exactitudes.com is rate limiting requests', 429);
  if (!res.ok) throw new AppError('SOURCE_UNAVAILABLE', `exactitudes.com returned ${res.status}`);
  return as === 'buffer' ? Buffer.from(await res.arrayBuffer()) : res.json();
}

// Returns every portrait URL in the series (not capped). The API emits paths like
// "https://exactitudes.com/wp/../media/..." so they are normalised through URL().
async function fetchSeriesImages(wpId) {
  const data = await get(SERIES_URL + encodeURIComponent(wpId));
  const imgs = data && data.post && data.post.imgs;
  if (!Array.isArray(imgs)) throw new AppError('SOURCE_CHANGED', 'Unexpected series response shape');

  const urls = imgs
    .map((img) => (img && img.sizes && img.sizes.medium) || (img && img.url))
    .filter((u) => typeof u === 'string' && /^https?:\/\//.test(u))
    .map((u) => new URL(u).href);

  if (urls.length === 0) throw new AppError('SOURCE_CHANGED', 'Series has no usable images');
  return urls;
}

// Fetch image bytes into memory for compositing, a few at a time.
async function fetchImageBuffers(urls, concurrency = 4) {
  const out = new Array(urls.length);
  let next = 0;
  async function worker() {
    while (next < urls.length) {
      const i = next++;
      try {
        out[i] = await get(urls[i], 'buffer');
      } catch {
        out[i] = null; // one broken image shouldn't sink the whole download
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return out;
}

module.exports = { fetchSeriesImages, fetchImageBuffers };
