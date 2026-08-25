
const { completeJSON } = require('../utils/llmClient');
 
/**
 * Agent 2 — Claim Extractor
 * Reads the normalized content and pulls out discrete, checkable factual claims
 * (numbers, named entities, dates, quoted statements, causal assertions).
 * Opinions, questions, and pure narrative are filtered out.
 *
 * Accuracy fixes applied here:
 * - Raised the hard cap from 5 to 8 claims. A flat 5-claim cap meant longer
 *   articles were under-checked (a 2000-word piece and a 200-word piece got
 *   the same amount of scrutiny). 8 keeps the pipeline fast while covering
 *   more of a substantial article.
 * - Each claim now also carries a short `searchQuery` (3-6 keywords) generated
 *   by the LLM specifically for retrieval — separate from the human-readable
 *   `claim` sentence, which is often too long/awkwardly phrased to make a good
 *   search query on its own.
 * - Quote claims are flagged (`isQuote` + `attributedTo`) so the Fact
 *   Verification Agent can specifically check quote fidelity (was this really
 *   said, and by this person) rather than just treating it like any other
 *   factual claim.
 * - Each claim now also carries a "claimType"
 *   (factual|opinion|satire|prediction|misleading-context) and an
 *   "importance" (major|minor). Previously anything that slipped through
 *   extraction was treated as an equally-weighted factual claim by the
 *   verifier — an opinion or a prediction that leaked through would get
 *   fact-checked as if it were a statistic, and a central fabricated claim
 *   counted the same as an incidental typo. claimType lets Agent 3 skip
 *   scoring non-factual claims as true/false instead of mis-verifying them;
 *   importance lets Agent 4 weight a central claim more heavily than a
 *   minor one in the overall trust score.
 */
async function extractClaims({ title, text }, settings) {
  const focus = describeFocus(settings);
 
  const system = `You are a Claim Extraction agent inside a fact-verification pipeline.
Given an article/document, extract a list of discrete, independently checkable factual claims.
Rules:
- Only extract claims that assert a verifiable fact (statistic, event, quote, date, named-entity action, causal claim) OR are a notable opinion/prediction/satirical statement worth flagging as such (see claimType below) — don't skip these, just tag them correctly so they aren't fact-checked as if they were factual assertions.
- Skip rhetorical questions, vague statements, and promotional filler entirely (don't extract these at all).
- Keep each claim as a short, self-contained sentence (don't require reading the original article to understand it).
- Prefer claims that are specific, concrete, and likely to be independently verifiable.
- Extract at most 8 of the most important/checkable claims, prioritizing claims that are central to the article's thesis, not incidental details.
- For each claim, also produce a short "searchQuery" of 3-6 keywords (proper nouns, numbers, key terms) suitable for a web search engine — NOT a full sentence.
- If a claim is a direct quotation attributed to a specific person/organization, set "isQuote": true and "attributedTo" to who it's attributed to, so the quote's accuracy and attribution can both be checked.
- Classify each claim's "temporalScope" as one of: "current" (asserts something is true right now / an ongoing superlative, e.g. "is the largest", "currently leads"), "dated-event" (a specific past event/date, e.g. "launched in 2024"), or "undated" (a general/timeless fact). This lets the verifier know whether stale evidence is acceptable.
- Classify each claim's "claimType" as one of: "factual" (a verifiable fact/statistic/event/quote), "opinion" (a subjective judgment, not a fact), "satire" (evidently comedic/absurdist, not meant literally), "prediction" (a forecast about the future that cannot yet be verified true or false), or "misleading-context" (the underlying fact may be accurate but the claim's framing/context looks designed to mislead — e.g. real footage/data presented as something it isn't). Default to "factual" when in doubt for a checkable assertion.
- Classify each claim's "importance" as "major" (central to the article's core thesis/headline claim — if this claim were false, the article's main point would be false) or "minor" (a supporting/incidental detail). Most articles should have at least one "major" claim.
- ${focus}
Return strict JSON: {"claims": [{"id": "c1", "claim": "...", "category": "statistic|event|quote|causal|other", "searchQuery": "...", "isQuote": false, "attributedTo": null, "temporalScope": "current|dated-event|undated", "claimType": "factual|opinion|satire|prediction|misleading-context", "importance": "major|minor"}]}`;
 
  const user = `TITLE: ${title}\n\nCONTENT:\n${text.slice(0, 8000)}`;
 
  const mockResponse = mockClaims(text);
 
  const result = await completeJSON({ system, user, mockResponse });
  if (!result.claims || !Array.isArray(result.claims)) {
    throw new Error('Claim Extractor Agent returned an unexpected format.');
  }
  return result.claims.map((c, i) => normalizeClaim(c, i));
}
 
const CLAIM_TYPES = ['factual', 'opinion', 'satire', 'prediction', 'misleading-context'];
const IMPORTANCE_LEVELS = ['major', 'minor'];
 
function normalizeClaim(c, i) {
  return {
    id: c.id || `c${i + 1}`,
    claim: c.claim,
    category: c.category || 'other',
    searchQuery: c.searchQuery && c.searchQuery.trim() ? c.searchQuery.trim() : fallbackQuery(c.claim),
    isQuote: !!c.isQuote,
    attributedTo: c.attributedTo || null,
    temporalScope: ['current', 'dated-event', 'undated'].includes(c.temporalScope) ? c.temporalScope : guessTemporalScope(c.claim),
    claimType: CLAIM_TYPES.includes(c.claimType) ? c.claimType : guessClaimType(c.claim),
    importance: IMPORTANCE_LEVELS.includes(c.importance) ? c.importance : 'major',
  };
}
 
// Heuristic fallback when the LLM/mock doesn't set claimType explicitly.
// Deliberately conservative — defaults to "factual" unless a claim reads
// unmistakably like an opinion or a forward-looking prediction, since
// mis-tagging a real factual claim as "opinion" would wrongly exempt it
// from verification.
function guessClaimType(claim = '') {
  if (/\b(i think|i believe|in my opinion|arguably|should be|is the best|is the worst|disgusting|wonderful|terrible|amazing)\b/i.test(claim)) {
    return 'opinion';
  }
  if (/\b(will|is expected to|is set to|is likely to|forecast|predict|by 20\d\d)\b/i.test(claim) && /\b(will|forecast|predict)\b/i.test(claim)) {
    return 'prediction';
  }
  return 'factual';
}
 
// Heuristic fallback when the LLM/mock doesn't set temporalScope explicitly.
function guessTemporalScope(claim = '') {
  if (/\b(is|are|currently|now|remains|leads|largest|biggest|highest|lowest)\b/i.test(claim) && !/\b(19|20)\d{2}\b/.test(claim)) {
    return 'current';
  }
  if (/\b(19|20)\d{2}\b/.test(claim) || /\b(yesterday|last week|last month|launched|announced|held|occurred)\b/i.test(claim)) {
    return 'dated-event';
  }
  return 'undated';
}
 
// If the LLM (or mock) didn't produce a searchQuery, fall back to the first
// ~10 significant words of the claim rather than the full sentence.
function fallbackQuery(claim = '') {
  return claim
    .replace(/[^\w\s%$.-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 10)
    .join(' ');
}
 
function describeFocus(settings = {}) {
  const parts = [];
  if (settings.factChecking) parts.push('Prioritize discrete factual/statistical claims for fact-checking.');
  if (settings.fakeNewsDetection)
    parts.push('Also flag sensationalized or emotionally-loaded claims typical of fake news.');
  if (settings.businessReportVerification)
    parts.push('Also prioritize financial figures, business metrics, dates, and named-company claims.');
  return parts.join(' ') || 'Extract general factual claims.';
}
 
// Simple heuristic mock so the pipeline is demonstrable without an API key.
function mockClaims(text) {
  const sentences = text
    .replace(/\n+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40 && s.length < 240)
    .filter((s) => !/^(this|these|those|it|they)/i.test(s));
 
  // Prefer sentences containing numbers, capitalized names, or dates — likely factual.
  const scored = sentences
    .map((s) => ({
      s,
      score:
        (s.match(/\d/g) || []).length * 3 +
        (s.match(/[A-Z][a-z]+/g) || []).length * 0.6 +
        (s.match(/\b(today|yesterday|last week|in 202|in 20\d\d|percent|million|billion)\b/i) || []).length * 1.5,
    }))
    .filter((item) => item.score >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
 
  if (scored.length === 0) {
    return { claims: [{ id: 'c1', claim: text.slice(0, 150), category: 'other' }] };
  }
 
  return {
    claims: scored.map((item, i) => {
      const quoteMatch = item.s.match(/"([^"]{10,150})"/);
      return {
        id: `c${i + 1}`,
        claim: item.s,
        category: quoteMatch ? 'quote' : /\d/.test(item.s) ? 'statistic' : 'event',
        searchQuery: fallbackQuery(item.s),
        isQuote: !!quoteMatch,
        attributedTo: null,
        claimType: guessClaimType(item.s),
        importance: i < 2 ? 'major' : 'minor', // top-scored sentences treated as the article's central claims
      };
    }),
  };
}
 
module.exports = { extractClaims };