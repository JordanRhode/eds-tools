const fs = require('fs');
const path = require('path');

// --- Config ---------------------------------------------------------------
const INPUT_FILE = path.join(__dirname, 'all-pages.txt');
const CONCURRENCY = 20; // number of URLs checked in parallel
const MIN_DELAY_MS = 10; // minimum spacing between request starts (~100 req/sec, half the 200/sec host limit)
const TIMEOUT_MS = 30000; // per-request timeout
const RETRIES = 5; // retries on network/timeout/rate-limit errors
const BACKOFF_BASE_MS = 1000; // base for exponential backoff on 429/5xx
const MAX_BACKOFF_MS = 60000; // cap for a single backoff wait

// Output files (timestamped, in a git-ignored output folder)
const OUTPUT_DIR = path.join(__dirname, 'output');
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_SUCCESS = path.join(OUTPUT_DIR, `${TIMESTAMP}-results-success.txt`);
const OUT_FAILURES = path.join(OUTPUT_DIR, `${TIMESTAMP}-results-failures.txt`);
const OUT_REDIRECTS = path.join(OUTPUT_DIR, `${TIMESTAMP}-results-redirects.txt`);

// --- Helpers --------------------------------------------------------------
function readUrls(file) {
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Parse a Retry-After header (either seconds or an HTTP date). Returns ms or null.
function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

// Exponential backoff with jitter, capped at MAX_BACKOFF_MS.
function backoffDelay(attempt) {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return base / 2 + Math.random() * (base / 2); // full-ish jitter
}

async function checkUrl(url) {
  let lastError;
  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'manual', // so we can detect 3xx instead of following them
        signal: controller.signal,
      });
      clearTimeout(timer);

      const status = res.status;
      const location = res.headers.get('location') || '';

      // Rate-limited or transient server error: wait and retry.
      if ((status === 429 || status === 503) && attempt < RETRIES) {
        const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
        const wait = retryAfter != null ? retryAfter : backoffDelay(attempt);
        await sleep(wait);
        continue;
      }

      let category;
      if (status >= 200 && status < 300) category = 'success';
      else if (status >= 300 && status < 400) category = 'redirect';
      else category = 'failure';

      return { url, status, location, category };
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (attempt < RETRIES) await sleep(backoffDelay(attempt));
    }
  }
  return {
    url,
    status: 0,
    location: '',
    category: 'failure',
    error: lastError ? lastError.message : 'unknown error',
  };
}

// Simple worker-pool to limit concurrency.
async function runPool(urls, worker) {
  const results = new Array(urls.length);
  let next = 0;
  let done = 0;
  let nextStartAt = 0; // shared clock so request starts are spaced by MIN_DELAY_MS

  async function runWorker() {
    while (next < urls.length) {
      const i = next;
      next += 1;

      // Throttle: ensure at least MIN_DELAY_MS between any two request starts.
      const now = Date.now();
      const startAt = Math.max(now, nextStartAt);
      nextStartAt = startAt + MIN_DELAY_MS;
      if (startAt > now) await sleep(startAt - now);

      results[i] = await worker(urls[i]);
      done += 1;
      if (done % 25 === 0 || done === urls.length) {
        process.stdout.write(`\rChecked ${done}/${urls.length}`);
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, urls.length) }, runWorker);
  await Promise.all(workers);
  process.stdout.write('\n');
  return results;
}

// --- Main -----------------------------------------------------------------
(async () => {
  const urls = readUrls(INPUT_FILE);
  console.log(
    `Checking ${urls.length} URLs (concurrency ${CONCURRENCY}, ${MIN_DELAY_MS}ms spacing)...`,
  );

  const results = await runPool(urls, checkUrl);

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const success = results.filter((r) => r.category === 'success');
  const redirects = results.filter((r) => r.category === 'redirect');
  const failures = results.filter((r) => r.category === 'failure');

  fs.writeFileSync(
    OUT_SUCCESS,
    success.map((r) => `${r.status}\t${r.url}`).join('\n') + '\n',
  );
  fs.writeFileSync(
    OUT_REDIRECTS,
    redirects.map((r) => `${r.status}\t${r.url} -> ${r.location}`).join('\n') + '\n',
  );
  fs.writeFileSync(
    OUT_FAILURES,
    failures
      .map((r) => `${r.status || 'ERR'}\t${r.url}${r.error ? `\t${r.error}` : ''}`)
      .join('\n') + '\n',
  );

  console.log('\nDone.');
  console.log(`  Success:   ${success.length}  -> ${path.basename(OUT_SUCCESS)}`);
  console.log(`  Redirects: ${redirects.length}  -> ${path.basename(OUT_REDIRECTS)}`);
  console.log(`  Failures:  ${failures.length}  -> ${path.basename(OUT_FAILURES)}`);
})();
