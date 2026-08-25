/**
 * Lightweight text-similarity helpers — used for quote-fidelity checking
 * (Phase 2F). Deliberately dependency-free (no ML model, no external lib):
 * a token-overlap (Jaccard) score is enough to tell "quoted verbatim" apart
 * from "a completely different quote" or "paraphrased/altered quote".
 */
function tokenize(text = '') {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

/** Jaccard similarity (0-1) between the token sets of two strings. */
function jaccardSimilarity(a = '', b = '') {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Extracts the quoted portion of a claim string, e.g. `Name said "X"` -> "X". */
function extractQuotedText(claim = '') {
  const match = claim.match(/"([^"]{5,300})"/);
  return match ? match[1] : claim;
}

/**
 * Longest-common-substring length between two token sequences, normalized
 * by the length of the shorter sequence. Jaccard alone treats "the president
 * announced new tariffs" and "tariffs new announced president the" as
 * identical (same token set, any order) — a real fabricated/altered quote
 * often reorders or drops words while keeping much of the vocabulary, which
 * Jaccard can't catch but sequence order can. Used as a second, independent
 * signal alongside Jaccard rather than a replacement for it.
 */
function sequenceSimilarity(a = '', b = '') {
  const tokA = tokenize(a);
  const tokB = tokenize(b);
  if (tokA.length === 0 || tokB.length === 0) return 0;

  // Classic O(n*m) LCS-length DP over tokens — inputs here are short
  // (quotes/snippets), so this is cheap.
  const dp = Array(tokA.length + 1)
    .fill(null)
    .map(() => new Array(tokB.length + 1).fill(0));
  for (let i = 1; i <= tokA.length; i++) {
    for (let j = 1; j <= tokB.length; j++) {
      dp[i][j] = tokA[i - 1] === tokB[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const lcsLen = dp[tokA.length][tokB.length];
  return lcsLen / Math.min(tokA.length, tokB.length);
}

/**
 * Combined quote-fidelity score (0-1): the average of Jaccard (bag-of-words
 * overlap) and sequence similarity (order-sensitive). Blending both catches
 * both "different words entirely" (Jaccard) and "same words, different/
 * shuffled meaning" (sequence) instead of relying on one weak signal alone.
 */
function quoteFidelityScore(a = '', b = '') {
  const jac = jaccardSimilarity(a, b);
  const seq = sequenceSimilarity(a, b);
  return jac * 0.5 + seq * 0.5;
}

module.exports = { jaccardSimilarity, sequenceSimilarity, quoteFidelityScore, extractQuotedText, tokenize };
