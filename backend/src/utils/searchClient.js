/**
 * Web search wrapper used by the Fact Verification Agent to pull real, live sources
 * for each claim. Supports Serper.dev (Google Search API) out of the box; swap in
 * Bing/SerpAPI/Tavily by adding another branch here — the rest of the app doesn't change.
 *
 * Speed fix (this is the main reason verification was slow): the previous
 * version ALWAYS fired two full search queries per claim (a short keyword
 * query + the full claim sentence) in parallel, then also ran that same
 * pattern sequentially across every claim (see factVerificationAgent.js).
 * Two searches per claim isn't itself catastrophic, but stacked on top of a
 * non-parallelized claim loop it multiplied total latency a lot for
 * longer articles (up to 8 claims x 2 searches x network round-trip).
 *
 * `searchWeb` now runs the FIRST (short keyword) query only, and only fires
 * the second (full-sentence) query as a fallback if the first came back thin
 * (fewer than MIN_RESULTS_BEFORE_FALLBACK results). This keeps the common
 * case to a single network round-trip per claim while still getting the
 * broader query's recall on claims that are genuinely hard to find. Set
 * SEARCH_ALWAYS_MULTI_QUERY=true in .env to restore the old always-both
 * behavior if you'd rather trade speed for a bit more recall.
 */
const axios = require('axios');

const SEARCH_TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS) || 8000;
const MIN_RESULTS_BEFORE_FALLBACK = 2;

const isMock = () =>
  process.env.SEARCH_PROVIDER === 'mock' ||
  process.env.MOCK_MODE === 'true' ||
  !process.env.SERPER_API_KEY ||
  process.env.SERPER_API_KEY.includes('your_serper');

async function searchWeb(queryOrQueries, num = 5) {
  const queries = Array.isArray(queryOrQueries) ? queryOrQueries.filter(Boolean) : [queryOrQueries];

  if (isMock()) {
    await new Promise((r) => setTimeout(r, 200));
    return queries.slice(0, 1).map((q) => ({
      title: `[MOCK] Reference result for: ${q.slice(0, 60)}`,
      link: 'https://example.com/mock-source',
      snippet:
        'MOCK_MODE is active (no SERPER_API_KEY configured), so this is a placeholder source. ' +
        'Add a real search API key in .env to fetch live evidence for this claim.',
    }));
  }

  const alwaysMulti = process.env.SEARCH_ALWAYS_MULTI_QUERY === 'true';
  const primary = queries[0];
  const rest = queries.slice(1);

  let resultLists;
  if (alwaysMulti || rest.length === 0) {
    resultLists = await Promise.all(queries.map((q) => runSingleSearch(q, num)));
  } else {
    const first = await runSingleSearch(primary, num);
    if (first.length >= MIN_RESULTS_BEFORE_FALLBACK) {
      resultLists = [first];
    } else {
      // Thin result set — fire the remaining (broader) queries as a fallback
      // instead of always paying for them up front.
      const fallback = await Promise.all(rest.map((q) => runSingleSearch(q, num)));
      resultLists = [first, ...fallback];
    }
  }

  const seen = new Set();
  const merged = [];
  for (const list of resultLists) {
    for (const item of list) {
      const key = normalizeUrl(item.link);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
}

async function runSingleSearch(query, num = 5) {
  try {
    const resp = await axios.post(
      'https://google.serper.dev/search',
      { q: query, num },
      {
        headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
        timeout: SEARCH_TIMEOUT_MS,
      }
    );
    const organic = resp.data.organic || [];
    return organic.slice(0, num).map((r) => ({
      title: r.title,
      link: r.link,
      snippet: r.snippet || '',
    }));
  } catch (err) {
    // A failed sub-query shouldn't abort the whole claim — just contributes
    // no results, and the other query variant (or lack of evidence overall)
    // is handled downstream by the "unverifiable" verdict path.
    console.error('[searchClient] query failed:', query, err.message);
    return [];
  }
}

function normalizeUrl(link = '') {
  try {
    const u = new URL(link);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname}`.replace(/\/$/, '').toLowerCase();
  } catch {
    return link.toLowerCase();
  }
}

module.exports = { searchWeb, isMock };
