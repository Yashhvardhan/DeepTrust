/**
 * Source Reputation Database (Phase 4 of the accuracy roadmap).
 * Replaces the old flat "trusted / fact-check / low-quality" arrays with a
 * single scored table (0-10) plus a category tag, so reliability scoring has
 * one source of truth that's easy to extend without touching scoring logic.
 */
const DOMAIN_REPUTATION = {
  // Wire services / broadcasters — highest trust, primary reporting
  'reuters.com': { score: 9, category: 'wire-service' },
  'apnews.com': { score: 9, category: 'wire-service' },
  'afp.com': { score: 8, category: 'wire-service' },
  'bloomberg.com': { score: 8, category: 'wire-service' },
  'pti.com': { score: 8, category: 'wire-service' },
  'aninews.in': { score: 7, category: 'wire-service' },
  'bbc.com': { score: 8, category: 'broadcaster' },
  'bbc.co.uk': { score: 8, category: 'broadcaster' },
  'npr.org': { score: 8, category: 'broadcaster' },
  'cnn.com': { score: 7, category: 'broadcaster' },
  'aljazeera.com': { score: 7, category: 'broadcaster' },
  'ndtv.com': { score: 7, category: 'broadcaster' },
  'cnbc.com': { score: 7, category: 'broadcaster' },

  // Major newspapers
  'nytimes.com': { score: 8, category: 'newspaper' },
  'washingtonpost.com': { score: 8, category: 'newspaper' },
  'wsj.com': { score: 8, category: 'newspaper' },
  'theguardian.com': { score: 7, category: 'newspaper' },
  'ft.com': { score: 8, category: 'newspaper' },
  'economist.com': { score: 8, category: 'newspaper' },
  'thehindu.com': { score: 8, category: 'newspaper' },
  'indianexpress.com': { score: 7, category: 'newspaper' },
  'hindustantimes.com': { score: 7, category: 'newspaper' },
  'livemint.com': { score: 7, category: 'newspaper' },
  'economictimes.indiatimes.com': { score: 7, category: 'newspaper' },
  'timesofindia.indiatimes.com': { score: 6, category: 'newspaper' },
  'business-standard.com': { score: 7, category: 'newspaper' },

  // Institutional / government / international bodies
  'who.int': { score: 9, category: 'institutional' },
  'un.org': { score: 8, category: 'institutional' },
  'nasa.gov': { score: 9, category: 'institutional' },
  'cdc.gov': { score: 9, category: 'institutional' },
  'nih.gov': { score: 9, category: 'institutional' },
  'imf.org': { score: 8, category: 'institutional' },
  'worldbank.org': { score: 8, category: 'institutional' },
  'sec.gov': { score: 9, category: 'institutional' },
  'pib.gov.in': { score: 9, category: 'institutional' },
  'rbi.org.in': { score: 8, category: 'institutional' },
  'eci.gov.in': { score: 9, category: 'institutional' },
  'india.gov.in': { score: 8, category: 'institutional' },
  'sebi.gov.in': { score: 8, category: 'institutional' },

  // Peer-reviewed / scholarly primary sources
  'nature.com': { score: 9, category: 'academic' },
  'science.org': { score: 9, category: 'academic' },
  'thelancet.com': { score: 9, category: 'academic' },
  'nejm.org': { score: 9, category: 'academic' },
  'pubmed.ncbi.nlm.nih.gov': { score: 9, category: 'academic' },

  // Dedicated fact-checkers
  'factcheck.org': { score: 8, category: 'fact-check' },
  'politifact.com': { score: 8, category: 'fact-check' },
  'snopes.com': { score: 7, category: 'fact-check' },
  'fullfact.org': { score: 7, category: 'fact-check' },
  'altnews.in': { score: 7, category: 'fact-check' },
  'boomlive.in': { score: 7, category: 'fact-check' },
  'factly.in': { score: 7, category: 'fact-check' },
  'newschecker.in': { score: 7, category: 'fact-check' },
  'vishvasnews.com': { score: 6, category: 'fact-check' },

  // Known low-quality / fabricated-content / satire sources — negative score
  'theonion.com': { score: 1, category: 'satire' }, // real site, but not evidence for factual claims
  'babylonbee.com': { score: 1, category: 'satire' },
  'worldnewsdailyreport.com': { score: 0, category: 'fabricated' },
  'now8news.com': { score: 0, category: 'fabricated' },
  'empirenews.net': { score: 0, category: 'fabricated' },
  'nationalreport.net': { score: 0, category: 'fabricated' },
  'react365.com': { score: 0, category: 'fabricated' },
  'huzlers.com': { score: 0, category: 'fabricated' },
  'thebeaverton.com': { score: 1, category: 'satire' },
  'dailybuzzlive.com': { score: 0, category: 'fabricated' },
  'newswatch33.com': { score: 0, category: 'fabricated' },
  'yournewswire.com': { score: 0, category: 'fabricated' },
  'newspunch.com': { score: 0, category: 'fabricated' },
  'beforeitsnews.com': { score: 0, category: 'fabricated' },

  // Open, low-editorial-control platforms — can be a useful lead but should
  // never carry a fact-check on their own.
  'reddit.com': { score: 1, category: 'social' },
  'facebook.com': { score: 1, category: 'social' },
  'x.com': { score: 1, category: 'social' },
  'twitter.com': { score: 1, category: 'social' },
  'medium.com': { score: 2, category: 'blog-platform' },
  'substack.com': { score: 2, category: 'blog-platform' },
  'quora.com': { score: 1, category: 'social' },
  'blogspot.com': { score: 1, category: 'blog-platform' },
  'wordpress.com': { score: 1, category: 'blog-platform' },
};

// Free-content-farm / URL-shortener / link-aggregator TLDs and patterns that
// correlate with low-accountability publishing — a small penalty, not a
// hard block, since legitimate outlets occasionally sit on these too.
const LOW_TRUST_TLD_PATTERN = /\.(xyz|top|click|info|biz|buzz|win|loan|racing)$/i;

// Hostnames engineered to impersonate a known outlet (typosquat / lookalike
// subdomain stuffing, e.g. "reuters-news-update.info" or
// "bbc.com.newsalert.xyz") — flag distinctly from a generic unknown domain.
function looksLikeImpersonation(hostname = '') {
  const knownBrands = ['reuters', 'bbc', 'cnn', 'nytimes', 'who', 'nasa', 'apnews', 'bloomberg'];
  return knownBrands.some((brand) => hostname.includes(brand)) && !DOMAIN_REPUTATION[hostname] &&
    !Object.keys(DOMAIN_REPUTATION).some((d) => hostname === d || hostname.endsWith(`.${d}`));
}

/**
 * Look up a hostname's reputation. Checks exact match, then apex-domain
 * suffix match (so "www.reuters.com" and "in.reuters.com" both match
 * "reuters.com"), then generic .gov/.edu/.ac treatment, then heuristic
 * penalties for known-risky patterns, then an unknown-domain neutral score.
 */
function lookupReputation(hostname = '') {
  if (!hostname) return { score: 3, category: 'unknown' };

  if (DOMAIN_REPUTATION[hostname]) return DOMAIN_REPUTATION[hostname];

  const match = Object.keys(DOMAIN_REPUTATION).find(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
  );
  if (match) return DOMAIN_REPUTATION[match];

  if (hostname.endsWith('.gov') || hostname.endsWith('.gov.in') || hostname.endsWith('.gov.uk')) {
    return { score: 7, category: 'government' };
  }
  if (hostname.endsWith('.edu') || hostname.endsWith('.ac.in') || hostname.endsWith('.ac.uk')) {
    return { score: 6, category: 'academic' };
  }
  if (hostname.endsWith('.mil')) return { score: 6, category: 'government' };

  if (looksLikeImpersonation(hostname)) {
    return { score: -3, category: 'possible-impersonation' };
  }

  if (LOW_TRUST_TLD_PATTERN.test(hostname)) {
    return { score: 1, category: 'low-trust-tld' };
  }

  // Neutral baseline for an unrecognized domain — neither trusted nor penalized.
  return { score: 3, category: 'unknown' };
}

module.exports = { DOMAIN_REPUTATION, lookupReputation, looksLikeImpersonation };
