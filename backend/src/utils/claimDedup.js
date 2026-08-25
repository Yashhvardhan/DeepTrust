/**
 * Claim de-duplication (Accuracy pass v3).
 *
 * The Claim Extractor occasionally pulls out two near-identical claims from
 * the same article (e.g. the headline restates a stat that's also given in
 * the body: "Revenue grew 40% in Q3" and "The company posted 40% revenue
 * growth in the third quarter"). Left alone, each gets verified and scored
 * independently, which double-counts the same underlying fact in the trust
 * score average — one real claim being true (or false) ends up carrying 2x
 * the weight it should.
 *
 * This is a cheap, dependency-free token-overlap pass BEFORE claims go to
 * the Fact Verification Agent, so it doesn't cost extra search/LLM calls —
 * it only reduces how many claims reach that stage.
 */
const { jaccardSimilarity } = require('./textSimilarity');

const DUPLICATE_THRESHOLD = 0.6;

/**
 * Collapses near-duplicate claims (by token-overlap similarity of the claim
 * text) into a single representative claim, preferring the "major"-tagged
 * one when duplicates disagree on importance. Returns { claims, mergedCount }.
 */
function dedupeClaims(claims = []) {
  const kept = [];
  let mergedCount = 0;

  for (const claim of claims) {
    const dupIndex = kept.findIndex((k) => jaccardSimilarity(k.claim, claim.claim) >= DUPLICATE_THRESHOLD);
    if (dupIndex === -1) {
      kept.push(claim);
      continue;
    }
    mergedCount++;
    // Prefer keeping the "major" tag and the isQuote flag if either duplicate has it —
    // losing that information would under-weight or under-check the merged claim.
    const existing = kept[dupIndex];
    kept[dupIndex] = {
      ...existing,
      importance: existing.importance === 'major' || claim.importance === 'major' ? 'major' : existing.importance,
      isQuote: existing.isQuote || claim.isQuote,
    };
  }

  return { claims: kept, mergedCount };
}

module.exports = { dedupeClaims, DUPLICATE_THRESHOLD };
