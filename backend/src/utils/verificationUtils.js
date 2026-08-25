/**
 * Evidence ranking + scoring used by the Fact Verification Agent (Agent 3).
 *
 * v2 (source-reputation-DB + semantic ranking):
 * - Reliability now comes from utils/domainReputation.js (a real hostname
 *   lookup, scored 0-10, with a proper reputation table) instead of ad-hoc
 *   substring checks.
 * - Relevance combines keyword overlap with a semantic-similarity score
 *   (utils/embeddingClient.js) so evidence that discusses the same fact in
 *   different words still ranks highly — not just literal keyword matches.
 * - Independence is enforced via domain de-duplication so "top 5 sources"
 *   can't secretly be one story echoed across near-duplicate domains.
 */
const { lookupReputation } = require('./domainReputation');
const { semanticScores } = require('./embeddingClient');

function getHostname(link = '') {
  try {
    return new URL(link).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

async function rankEvidence(evidence = [], claim = '', opts = {}) {
  const normalizedClaim = claim.toLowerCase();
  const semantic = await semanticScores(claim, evidence);

  const ranked = evidence.map((item, i) => {
    const title = (item.title || '').toLowerCase();
    const snippet = (item.snippet || '').toLowerCase();
    const text = `${title} ${snippet}`;
    const hostname = getHostname(item.link || '');

    const keywordScore = getKeywordScore(text, normalizedClaim, opts);
    const semanticScore = Math.round((semantic[i] || 0) * 10); // 0-10 scale, matches keyword/reliability magnitude
    const relevantScore = keywordScore + semanticScore;
    const reliabilityScore = getReliabilityScore(hostname, text);
    const recencyScore = getRecencyScore(item.snippet || '', item.title || '');
    const combinedScore = relevantScore + reliabilityScore + recencyScore;

    return {
      ...item,
      hostname,
      keywordScore,
      semanticScore: semantic[i] || 0, // keep raw 0-1 for downstream NLI/temporal logic
      relevantScore,
      reliabilityScore,
      recencyScore,
      combinedScore,
    };
  });

  ranked.sort((a, b) => b.combinedScore - a.combinedScore);
  return dedupeByDomain(ranked).slice(0, 5);
}

/**
 * Keep at most 2 results per hostname so "top 5 sources" can't secretly be
 * 5 links from the same outlet (which would make a single publisher's claim
 * look like broad, independent corroboration).
 */
function dedupeByDomain(rankedEvidence = []) {
  const perDomainCount = {};
  const result = [];
  for (const item of rankedEvidence) {
    const key = item.hostname || item.link || '';
    perDomainCount[key] = (perDomainCount[key] || 0) + 1;
    if (perDomainCount[key] <= 2) result.push(item);
  }
  return result;
}

/** Count of distinct hostnames present in a set of ranked evidence. */
function countIndependentDomains(rankedEvidence = []) {
  const domains = new Set(rankedEvidence.map((e) => e.hostname || getHostname(e.link || '')).filter(Boolean));
  return domains.size;
}

function summarizeEvidence(rankedEvidence = []) {
  if (!rankedEvidence.length) return 'No evidence found.';

  return rankedEvidence
    .slice(0, 3)
    .map((item, index) => `${index + 1}. ${item.title || item.link}`)
    .join('\n');
}

function getKeywordScore(text, claim, opts = {}) {
  let score = 0;
  if (!claim) return score;

  const claimTerms = claim.split(/\s+/).filter(Boolean);
  claimTerms.forEach((term) => {
    if (term.length < 3) return;
    if (text.includes(term.toLowerCase())) score += 2;
  });

  // Business-report-mode-only bonus — not applied to every claim.
  if (opts.businessMode && (text.includes('revenue') || text.includes('growth'))) score += 2;

  return score;
}

function getReliabilityScore(hostname = '', text = '') {
  const { score: reputationScore } = lookupReputation(hostname);
  let score = reputationScore;

  if (/\b(official|press release|statement)\b/.test(text)) score += 1;
  if (/\b(blog|forum|reddit|tweet|social media|viral post)\b/.test(text)) score -= 2;

  return Math.max(-8, score);
}

function getRecencyScore(snippet = '', title = '') {
  const text = `${snippet} ${title}`.toLowerCase();
  const currentYear = new Date().getFullYear();
  if (text.includes(String(currentYear)) || text.includes(String(currentYear - 1))) return 1;
  if (text.includes(String(currentYear - 2)) || text.includes(String(currentYear - 3))) return 0.5;
  return 0;
}

module.exports = {
  rankEvidence,
  summarizeEvidence,
  dedupeByDomain,
  countIndependentDomains,
  getHostname,
};
