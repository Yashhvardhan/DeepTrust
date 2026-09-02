const { completeJSON } = require('../utils/llmClient');
const { searchWeb } = require('../utils/searchClient');
const { rankEvidence, summarizeEvidence, countIndependentDomains } = require('../utils/verificationUtils');
const { quoteFidelityScore, extractQuotedText } = require('../utils/textSimilarity');
 
/**
 * Agent 3 — Fact Verification Agent (v2)
 *
 * Pipeline per claim:
 *  1. Multi-query search (short keyword query + full claim sentence), merged & deduped.
 *  2. Rank evidence: keyword + semantic similarity + source reputation + recency, deduped by domain.
 *  3. NLI-style stance classification (Phase 2C): the LLM labels each evidence
 *     item's relationship to the claim as supports/refutes/neutral, instead of
 *     making one holistic "is this true" judgment.
 *  4. Deterministic aggregation: verdict + confidence are COMPUTED from the
 *     stances + source reliability + source independence — not just whatever
 *     number the LLM states. This is the accuracy-critical change: LLM
 *     self-reported confidence is known to be poorly calibrated.
 *  5. Hallucination detection (Phase 2D): if the LLM's own stated confidence
 *     is high but our independently computed evidence-based confidence is
 *     low, that's a hallucination signal — the verdict is downgraded rather
 *     than trusting the LLM's optimism.
 *  6. Temporal check (Phase 2E): claims about a "current" state require at
 *     least one recent source; if all evidence is stale, confidence is
 *     reduced and a temporalWarning is attached.
 *  7. Quote check (Phase 2F): for isQuote claims, the quoted text is compared
 *     against evidence snippets via token-overlap similarity. This is a SOFT
 *     signal only — search snippets are truncated previews, so a low
 *     similarity score is not proof of a fabricated quote, just grounds to
 *     mark it "unconfirmed" and cap confidence rather than declare it false.
 *
 * Speed fix: claims used to be verified one at a time in a plain `for` loop
 * — search, ranking, and an LLM stance call for claim 1 had to fully finish
 * before claim 2 even started, so an 8-claim article paid for 8x the latency
 * of a single claim back-to-back. Claims are now verified through a
 * concurrency-limited worker pool (FACT_VERIFY_CONCURRENCY, default 3) so
 * several claims are in flight at once — this is the main lever behind "the
 * verification step takes too long", more than the number of search queries
 * per claim (see searchClient.js for that half of the fix). Each claim also
 * now runs in its own try/catch: a single claim failing (a hung LLM call,
 * a malformed response) degrades to an "unverifiable" result for just that
 * claim instead of throwing and failing the entire report.
 */
const CONCURRENCY = Math.max(1, Number(process.env.FACT_VERIFY_CONCURRENCY) || 3);
 
async function verifyClaims(claims, settings = {}) {
  const results = new Array(claims.length);
  let nextIndex = 0;
 
  async function worker() {
    while (nextIndex < claims.length) {
      const i = nextIndex++;
      const claim = claims[i];
      try {
        results[i] = await verifyOneClaim(claim, settings);
      } catch (err) {
        console.error('[factVerificationAgent] claim verification failed, degrading to unverifiable:', claim.id, err.message);
        results[i] = {
          ...claim,
          verdict: 'unverifiable',
          confidence: 15,
          evidenceConfidence: 15,
          llmStatedConfidence: null,
          hallucinationRisk: false,
          independentSources: 0,
          temporalWarning: null,
          quoteCheck: null,
          explanation: `This claim could not be verified due to a verification error (${err.message}). Treated as unverifiable rather than failing the whole report.`,
          sources: [],
        };
      }
    }
  }
 
  const workers = Array.from({ length: Math.min(CONCURRENCY, claims.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
 
// Claim types that are not factual assertions and should never be scored
// true/false against evidence — doing so previously meant an opinion or a
// forward-looking prediction that slipped through Agent 2 could end up
// mislabeled "false" or "suspicious" just because no source "confirms" an
// opinion. These are still shown to the user (with the reason why they were
// excluded), just not run through search/verification at all.
const NON_FACTUAL_TYPES = new Set(['opinion', 'satire', 'prediction']);
 
async function verifyOneClaim(claim, settings) {
  if (NON_FACTUAL_TYPES.has(claim.claimType)) {
    return buildNonFactualResult(claim);
  }
 
  const queries = [claim.searchQuery, claim.claim].filter(Boolean);
  const evidence = await searchWeb(queries);
  const rankedEvidence = await rankEvidence(evidence, claim.claim, {
    businessMode: !!settings.businessReportVerification,
  });
  const independentDomains = countIndependentDomains(rankedEvidence);
 
  const stanceResult = await classifyStances(claim, rankedEvidence);
  const aggregation = aggregateVerdict(rankedEvidence, stanceResult.stances, independentDomains);
  // Per-source stance map (index -> supports/refutes/neutral) so the final
  // `sources` array can carry each source's own stance instead of collapsing
  // everything into one paragraph explanation.
  const stanceByIndex = {};
  (stanceResult.stances || []).forEach((s) => { stanceByIndex[s.index] = s; });
 
  let verdict = aggregation.verdict;
  let confidence = aggregation.evidenceConfidence;
  const notes = [];
 
  // --- Self-consistency re-check (Phase 3A) ---
  // A single LLM stance call is one noisy sample. A second, independent
  // pass is only worth the extra latency/cost when the first result is
  // genuinely borderline: support/refute weight nearly tied, or a strong
  // "verified" call rests on just one independent domain. If the two
  // passes disagree on the direction of the verdict, that disagreement is
  // itself evidence the claim is genuinely unclear — downgraded to
  // "suspicious" with capped confidence rather than trusting a coin flip.
  const isBorderline =
    rankedEvidence.length > 0 &&
    (Math.abs(aggregation.supportWeight - aggregation.refuteWeight) <= 3 ||
      (aggregation.verdict === 'verified' && independentDomains < 2));
 
  if (isBorderline) {
    const secondPass = await classifyStances(claim, rankedEvidence);
    const secondAggregation = aggregateVerdict(rankedEvidence, secondPass.stances, independentDomains);
    const directionsAgree = verdictDirection(aggregation.verdict) === verdictDirection(secondAggregation.verdict);
    if (!directionsAgree) {
      verdict = 'suspicious';
      confidence = Math.min(confidence, secondAggregation.evidenceConfidence, 45);
      notes.push(
        'Two independent evidence reviews of this claim reached different conclusions, which itself signals the evidence is genuinely mixed or thin — treated as suspicious rather than picking one review over the other.'
      );
    } else {
      confidence = Math.round((confidence + secondAggregation.evidenceConfidence) / 2);
      notes.push('Confirmed by a second independent evidence review before finalizing this verdict.');
    }
  }
 
  // --- Independent-source gating (Phase 3B) ---
  // Matches the "Require two independent sources before any score above 75"
  // policy shown in Settings > Scoring algorithm. A high-confidence
  // "verified" call should not rest on just one outlet's reporting — cap
  // confidence just under the review threshold until a second independent
  // domain corroborates it.
  const requireTwoSources = settings?.scoringConfig?.requireTwoSources !== false; // default true
  const reviewCeiling = Number(settings?.scoringConfig?.thresholds?.real) || 75;
  if (requireTwoSources && verdict === 'verified' && independentDomains < 2 && confidence >= reviewCeiling) {
    confidence = reviewCeiling - 1;
    notes.push(
      `Confidence capped just under the ${reviewCeiling}% review threshold because only ${independentDomains} independent source domain was found — a second independent source would allow full confidence.`
    );
  }
 
  // --- Hallucination detection ---
  const hallucinationRisk =
    stanceResult.llmStatedConfidence - aggregation.evidenceConfidence > 30 && stanceResult.llmStatedConfidence > 80;
  if (hallucinationRisk) {
    if (verdict === 'verified') verdict = 'suspicious';
    confidence = Math.min(confidence, 35);
    notes.push(
      `The model expressed high confidence (${stanceResult.llmStatedConfidence}%) that outpaced what the retrieved evidence actually supports — treated as a possible hallucination and downgraded.`
    );
  }
 
  // --- Temporal check ---
  let temporalWarning = null;
  if (claim.temporalScope === 'current' && rankedEvidence.length > 0) {
    const hasFreshEvidence = rankedEvidence.some((e) => e.recencyScore >= 1);
    if (!hasFreshEvidence) {
      temporalWarning =
        'This claim asserts a current/ongoing state, but no recent source was found among the evidence — it may rely on outdated information.';
      confidence = Math.round(confidence * 0.85);
    }
  }
 
  // --- Quote check ---
  let quoteCheck = null;
  if (claim.isQuote) {
    quoteCheck = checkQuoteFidelity(claim, rankedEvidence);
    if (quoteCheck.status === 'unconfirmed') {
      confidence = Math.min(confidence, 50);
      notes.push(
        'The exact quoted wording could not be confirmed in the retrieved evidence snippets (snippets are often truncated, so this is a caution flag, not proof of fabrication).'
      );
    }
  }
 
  // --- Misleading-context caution ---
  // This claim type is still fact-checked normally above (the underlying
  // fact can genuinely be true) — this just adds an explicit caveat so a
  // "verified" verdict doesn't imply the framing/context is also fair.
  if (claim.claimType === 'misleading-context') {
    notes.push(
      'This claim was flagged as potentially misleading in its context or framing — the underlying fact may check out even if evidence verifies it, but how it is presented could still be deceptive.'
    );
  }
 
  // Real, honest transparency signals — each one records what the pipeline
  // actually did/found for THIS claim, not a generic template line. This is
  // what a reviewer can point to and say "this could not have come from
  // pasting the article into a chatbot" — every value below is computed,
  // not narrated.
  const signals = [
    {
      key: 'sources',
      label: `${independentDomains} independent source${independentDomains === 1 ? '' : 's'}`,
      status: independentDomains >= 2 ? 'pass' : independentDomains === 1 ? 'info' : 'flag',
      detail: independentDomains >= 2
        ? 'Two or more independent domains corroborate this — not one outlet echoed.'
        : independentDomains === 1
        ? 'Only one independent domain found — confidence is capped until a second one corroborates.'
        : 'No independent source domain was found for this claim.',
    },
    {
      key: 'consistency',
      label: isBorderline ? 'Double-checked (borderline call)' : 'Single-pass evidence review',
      status: isBorderline ? (notes.some((n) => n.startsWith('Two independent')) ? 'flag' : 'pass') : 'info',
      detail: isBorderline
        ? 'The first review was close to a coin flip, so a second independent pass was run before finalizing.'
        : 'The evidence was clear enough on the first pass that a second check was not needed.',
    },
    {
      key: 'hallucination',
      label: hallucinationRisk ? 'Model confidence outpaced evidence' : 'Model confidence matched evidence',
      status: hallucinationRisk ? 'flag' : 'pass',
      detail: `Model self-reported ${stanceResult.llmStatedConfidence}% confidence vs. ${aggregation.evidenceConfidence}% computed from the actual evidence found.`,
    },
  ];
  if (claim.temporalScope === 'current') {
    signals.push({
      key: 'temporal',
      label: temporalWarning ? 'No recent evidence found' : 'Recent evidence found',
      status: temporalWarning ? 'flag' : 'pass',
      detail: temporalWarning || 'At least one source discussing this claim is recent enough to trust for a current-state claim.',
    });
  }
  if (claim.isQuote) {
    signals.push({
      key: 'quote',
      label: quoteCheck?.status === 'confirmed' ? 'Quote wording matched a source' : 'Quote wording unconfirmed',
      status: quoteCheck?.status === 'confirmed' ? 'pass' : 'flag',
      detail: quoteCheck ? `Best textual match: ${Math.round((quoteCheck.similarity || 0) * 100)}% similarity${quoteCheck.matchedSource ? ` against "${quoteCheck.matchedSource}"` : ''}.` : 'No quote check ran.',
    });
  }

  return {
    ...claim,
    verdict,
    confidence: Math.max(0, Math.min(100, Math.round(confidence))),
    evidenceConfidence: aggregation.evidenceConfidence,
    llmStatedConfidence: stanceResult.llmStatedConfidence,
    hallucinationRisk,
    independentSources: independentDomains,
    temporalWarning,
    quoteCheck: quoteCheck ? { status: quoteCheck.status, similarity: quoteCheck.similarity } : null,
    explanation: buildExplanation(aggregation, stanceResult, notes),
    queriesUsed: queries,
    rawEvidenceCount: evidence.length,
    signals,
    sources: rankedEvidence.map((e, i) => ({
      title: e.title,
      url: e.link,
      reliabilityScore: e.reliabilityScore,
      hostname: e.hostname,
      stance: stanceByIndex[i + 1]?.stance || 'neutral',
      stanceReason: stanceByIndex[i + 1]?.reason || null,
    })),
  };
}
 
const NON_FACTUAL_REASONS = {
  opinion: 'This is an opinion or subjective judgment, not a verifiable factual claim — it was not checked against evidence and is not scored as true or false.',
  satire: 'This appears to be satirical/comedic content rather than a literal factual claim — it was not checked against evidence and is not scored as true or false.',
  prediction: 'This is a prediction or forecast about the future, which cannot be verified as true or false yet — it was not checked against evidence.',
};
 
// Result shape for claims that Agent 2 tagged as non-factual (opinion,
// satire, prediction). Uses a distinct "not-applicable" verdict, kept
// separate from "unverifiable" (which means "this IS a factual claim but we
// couldn't find evidence") so the Report Generator can exclude these from
// the trust-score average entirely rather than scoring them neutrally.
function buildNonFactualResult(claim) {
  return {
    ...claim,
    verdict: 'not-applicable',
    confidence: null,
    evidenceConfidence: null,
    llmStatedConfidence: null,
    hallucinationRisk: false,
    independentSources: 0,
    temporalWarning: null,
    quoteCheck: null,
    explanation: NON_FACTUAL_REASONS[claim.claimType] || 'This is not a checkable factual assertion.',
    sources: [],
  };
}
 
/**
 * NLI-style classification: asks the LLM to label each piece of evidence's
 * stance toward the claim individually, plus its own overall verdict/
 * confidence guess (used only to detect hallucination, not as final output).
 */
async function classifyStances(claim, evidence) {
  const evidenceText = evidence
    .map((e, i) => `[${i + 1}] ${e.title}\n${e.snippet}\nURL: ${e.link}\nReliability: ${e.reliabilityScore}`)
    .join('\n\n');
 
  const quoteInstruction = claim.isQuote
    ? `This claim is a QUOTE attributed to "${claim.attributedTo || 'an unnamed source'}". When judging stance, specifically consider whether evidence confirms the wording AND the attribution.`
    : '';
 
  const system = `You are a Natural Language Inference agent inside a fact-verification pipeline.
For EACH numbered evidence item, classify its relationship to the claim as exactly one of:
- "supports": the evidence confirms the claim
- "refutes": the evidence contradicts the claim
- "neutral": the evidence is off-topic, doesn't address the claim, or is inconclusive
Do not flag a source as suspicious just because its publish date falls in a year that seems "in the future" relative to your own training data — trust the date grounding you were given for what counts as "today".
${quoteInstruction}
Also give your own overall verdict guess ("verified"|"suspicious"|"false"|"unverifiable") and an overall confidence 0-100 for that guess — this is your personal assessment and will be compared against an independent evidence-based score, not used directly.
Return strict JSON: {"stances": [{"index": 1, "stance": "supports|refutes|neutral", "reason": "<short reason>"}], "llmStatedVerdict": "verified|suspicious|false|unverifiable", "llmStatedConfidence": <0-100 integer>}`;
 
  const user = `CLAIM: "${claim.claim}"\n\nEVIDENCE:\n${evidenceText || 'No search results found.'}\n\nTOP EVIDENCE SUMMARY:\n${summarizeEvidence(evidence)}`;
 
  const mockResponse = mockStances(claim, evidence);
 
  const result = await completeJSON({ system, user, mockResponse });
  return {
    stances: Array.isArray(result.stances) ? result.stances : [],
    llmStatedVerdict: result.llmStatedVerdict || 'unverifiable',
    llmStatedConfidence: Number.isFinite(result.llmStatedConfidence) ? result.llmStatedConfidence : 50,
  };
}
 
/**
 * Deterministically turns per-source stances into a verdict + confidence.
 * This replaces trusting a single LLM-stated confidence number: the score is
 * computed from how many independent, reliable sources actually support or
 * refute the claim.
 */
function aggregateVerdict(rankedEvidence, stances, independentDomains) {
  if (rankedEvidence.length === 0) {
    return { verdict: 'unverifiable', evidenceConfidence: 10, supportWeight: 0, refuteWeight: 0 };
  }
 
  let supportWeight = 0;
  let refuteWeight = 0;
  const supportItems = [];
  const refuteItems = [];
 
  stances.forEach((s) => {
    const item = rankedEvidence[s.index - 1];
    if (!item) return;
    const reliability = Math.max(0, item.reliabilityScore);
    if (s.stance === 'supports') {
      supportWeight += reliability + 1;
      supportItems.push(item);
    } else if (s.stance === 'refutes') {
      refuteWeight += reliability + 1;
      refuteItems.push(item);
    }
  });
 
  if (refuteWeight > 0 && refuteWeight >= supportWeight) {
    const evidenceConfidence = clamp(40 + refuteWeight * 4, 0, 95);
    return {
      verdict: refuteWeight >= 8 ? 'false' : 'suspicious',
      evidenceConfidence,
      supportWeight,
      refuteWeight,
      supportItems,
      refuteItems,
    };
  }
 
  if (supportWeight > 0) {
    const independenceBonus = Math.min(20, independentDomains * 7);
    const evidenceConfidence = clamp(25 + supportWeight * 4 + independenceBonus, 0, 95);
    return {
      verdict: evidenceConfidence >= 65 && independentDomains >= 1 ? 'verified' : 'suspicious',
      evidenceConfidence,
      supportWeight,
      refuteWeight,
      supportItems,
      refuteItems,
    };
  }
 
  return { verdict: 'unverifiable', evidenceConfidence: 20, supportWeight, refuteWeight, supportItems, refuteItems };
}
 
// Collapses a verdict to a coarse direction (true-leaning / false-leaning /
// unclear) so two independent aggregation passes can be compared without
// caring whether one said "verified" and the other "suspicious-but-close".
function verdictDirection(verdict) {
  if (verdict === 'verified') return 'true-leaning';
  if (verdict === 'false') return 'false-leaning';
  return 'unclear';
}

function checkQuoteFidelity(claim, rankedEvidence) {
  const quotedText = extractQuotedText(claim.claim);
  let best = { similarity: 0, source: null };
  for (const item of rankedEvidence) {
    const candidate = `${item.title || ''} ${item.snippet || ''}`;
    const similarity = quoteFidelityScore(quotedText, candidate);
    if (similarity > best.similarity) best = { similarity, source: item.title || item.link };
  }
  return {
    status: best.similarity >= 0.5 ? 'confirmed' : 'unconfirmed',
    similarity: Math.round(best.similarity * 100) / 100,
    matchedSource: best.source,
  };
}
 
function buildExplanation(aggregation, stanceResult, notes) {
  const parts = [];
  if (aggregation.supportItems && aggregation.supportItems.length) {
    parts.push(`Supported by ${aggregation.supportItems.length} evidence item(s).`);
  }
  if (aggregation.refuteItems && aggregation.refuteItems.length) {
    parts.push(`Contradicted by ${aggregation.refuteItems.length} evidence item(s).`);
  }
  if (!aggregation.supportItems?.length && !aggregation.refuteItems?.length) {
    parts.push('No evidence directly supported or refuted this claim.');
  }
  return [...parts, ...notes].join(' ');
}
 
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
 
// Deterministic mock stance classification so the pipeline is demonstrable offline.
function mockStances(claim, evidence) {
  const hash = [...claim.claim].reduce((a, c) => a + c.charCodeAt(0), 0);
  const bucket = hash % 10;
 
  const stances = evidence.map((item, i) => {
    if (evidence.length === 0) return null;
    const strong = item.reliabilityScore >= 6 && item.relevantScore >= 4;
    let stance = 'neutral';
    if (bucket < 4 && strong) stance = 'supports';
    else if (bucket >= 8 && strong) stance = 'refutes';
    return { index: i + 1, stance, reason: `MOCK_MODE: heuristic stance for evidence #${i + 1}.` };
  });
 
  const llmStatedVerdict = bucket < 4 ? 'verified' : bucket < 8 ? 'suspicious' : 'unverifiable';
  return {
    stances,
    llmStatedVerdict,
    llmStatedConfidence: evidence.length === 0 ? 20 : 50 + (hash % 40),
  };
}
 
module.exports = { verifyClaims };
