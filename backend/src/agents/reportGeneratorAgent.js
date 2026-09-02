const { completeJSON } = require('../utils/llmClient');

/**
 * Agent 4 — Report Generator
 * Aggregates verified claims into the final report: trust score, tallies by verdict,
 * a plain-English AI summary, and a recommendation.
 *
 * Accuracy fix applied here: the old trust score formula weighted "unverifiable"
 * claims at 0.2x — treating "we found no evidence either way" almost the same as
 * "this looks false". In practice "unverifiable" is very often just "search
 * hasn't indexed this yet" (e.g. breaking news minutes old), which unfairly
 * tanked the score for genuinely true, recent content — the same class of bug
 * as the earlier "future publish date" issue. Unverifiable claims are now
 * scored neutrally (0.5, not confidence-scaled) so they neither help nor hurt
 * the trust score, and `evidenceCoverage` is surfaced separately so the UI/
 * reader can see how much of the article was actually checkable.
 *
 * Two further accuracy fixes applied here:
 * - Claim importance weighting: previously every claim counted equally
 *   toward the trust score average, so one wrong incidental date pulled the
 *   score down by the same amount as a fabricated central event. Claims that
 *   Agent 2 tags "major" (central to the article's thesis) now count ~1.6x
 *   a "minor" (incidental) claim in the weighted average.
 * - "not-applicable" claims (opinion/satire/prediction, per Agent 2's
 *   claimType) are excluded from the trust score AND evidenceCoverage
 *   entirely — they were never fact-checked against evidence, so scoring
 *   them (even neutrally) or counting them against coverage would be
 *   misleading. They're still listed in `claims` and tallied in
 *   `breakdown.not-applicable` for transparency.
 *
 * Phase 3C — configurable scoring policy: the Settings > Scoring algorithm
 * screen already let a user set factor weights (source/evidence/claims/
 * visual), a fake/real verdict threshold, and document/media penalties —
 * but nothing on the backend ever read them, so changing them had no real
 * effect. `scoringConfig` (optional) is now actually applied: trust score
 * blends four components by the given weights instead of being purely a
 * function of per-claim verdicts, and the fake/real thresholds drive the
 * overall verdict. Omitting scoringConfig keeps the previous behavior
 * (equivalent to the same defaults shown in the Settings UI).
 */
const DEFAULT_WEIGHTS = { source: 25, evidence: 35, claims: 25, visual: 15 };
const DEFAULT_THRESHOLDS = { fake: 40, real: 75, docPenalty: 4, mediaPenalty: 3 };

async function generateReport({
  title,
  sourceUrl,
  verifiedClaims,
  settings,
  contentCategory,
  visualAnalysis,
  scoringConfig,
  mergedClaimCount,
}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(scoringConfig?.weights || {}) };
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(scoringConfig?.thresholds || {}) };

  const tally = { verified: 0, suspicious: 0, false: 0, unverifiable: 0, 'not-applicable': 0 };
  for (const c of verifiedClaims) tally[c.verdict] = (tally[c.verdict] || 0) + 1;

  const scoreDetails = computeScoreDetails(verifiedClaims, weights, thresholds, visualAnalysis, settings);
  const trustScore = scoreDetails.score;
  const evidenceCoverage = computeEvidenceCoverage(verifiedClaims);
  const flags = computeFlags(verifiedClaims);
  const overallVerdict = computeOverallVerdict(trustScore, tally, evidenceCoverage, visualAnalysis, thresholds);
  const whatsIncorrect = buildWhatsIncorrect(verifiedClaims);

  // Video-specific: make explicit that fact-checking the transcript/description
  // (below, in `claims`) and screening the thumbnail for tampering (`visualAnalysis`)
  // are two separate checks — a claim can verify true on manipulated footage,
  // or false on genuine footage. Additive field only; omitted for non-video content.
  const crossVerificationNote =
    contentCategory === 'video'
      ? 'For video content, claim verification (checking what is said/claimed against evidence) and visual analysis (screening the thumbnail image for tampering signs) are independent checks — see `claims` for the former and `visualAnalysis` for the latter. A claim can be verified true even if visual analysis flags concerns, or vice versa.'
      : null;

  const system = `You are a Report Generator agent. Given the results of a fact-verification pipeline,
write a short (3-5 sentence) plain-English summary of the overall credibility of the content, and a
1-2 sentence recommendation for the reader (e.g. "safe to share", "verify further before sharing", "do not share").
Do not describe a source's publish date as "in the future" or as evidence of fabrication unless it is genuinely after today's date as given to you.
Treat "unverifiable" claims as claims we could not check either way (e.g. no search results found) — do NOT describe them as suspicious or misleading; if MOST claims are unverifiable, say the content's credibility could not be fully assessed rather than implying it's low-credibility.
Treat "not-applicable" claims (opinions, satire, or predictions) as claims that are simply not fact-checkable — do NOT describe them as unverified, suspicious, or count them against the content's credibility in any way.
If any claims were flagged for possible hallucination, unconfirmed quotes, or outdated evidence for a "current state" claim, mention that specifically as a reason for caution.
Consider the analysis mode(s) selected: ${activeModes(settings)}.
Return strict JSON: {"summary": "...", "recommendation": "..."}`;

  const user = `TITLE: ${title}\nTRUST SCORE: ${trustScore}/100\nEVIDENCE COVERAGE: ${evidenceCoverage}% of claims had at least one search source found\nCLAIM BREAKDOWN: ${JSON.stringify(tally)}\nFLAGS: ${JSON.stringify(flags)}\n\nCLAIMS:\n${verifiedClaims
    .map((c) => `- [${c.verdict.toUpperCase()} ${c.confidence}%] ${c.claim} — ${c.explanation}`)
    .join('\n')}`;

  const mockResponse = mockSummary(trustScore, tally, evidenceCoverage, flags);

  const { summary, recommendation } = await completeJSON({ system, user, mockResponse });

  // Real, per-run pipeline stats — what each agent actually did on THIS
  // piece of content, in numbers pulled from the run itself. This is the
  // thing a generic chatbot summary can't produce: it's not narrated, it's
  // counted from what the Fact Verification agent (Agent 3) actually fired.
  const factCheckedClaims = verifiedClaims.filter((c) => c.verdict !== 'not-applicable');
  const pipelineTrace = {
    claimsExtracted: verifiedClaims.length + (mergedClaimCount || 0),
    claimsMerged: mergedClaimCount || 0,
    claimsFactChecked: factCheckedClaims.length,
    claimsSkippedNonFactual: verifiedClaims.length - factCheckedClaims.length,
    searchQueriesRun: factCheckedClaims.reduce((sum, c) => sum + (c.queriesUsed?.length || 0), 0),
    rawSourcesFound: factCheckedClaims.reduce((sum, c) => sum + (c.rawEvidenceCount || 0), 0),
    sourcesKeptAfterRanking: factCheckedClaims.reduce((sum, c) => sum + (c.sources?.length || 0), 0),
    borderlineDoubleChecked: factCheckedClaims.filter((c) => (c.signals || []).some((s) => s.key === 'consistency' && s.label.startsWith('Double'))).length,
    hallucinationFlags: flags.hallucinationRisk,
  };

  return {
    title,
    sourceUrl: sourceUrl || null,
    contentCategory: contentCategory || 'text',
    verdict: overallVerdict.verdict,
    verdictConfidence: overallVerdict.confidence,
    trustScore,
    evidenceCoverage,
    flags,
    claimsFound: verifiedClaims.length,
    breakdown: tally,
    claims: verifiedClaims,
    whatsIncorrect,
    visualAnalysis: visualAnalysis || null,
    crossVerificationNote,
    scoringPolicy: { weights, thresholds },
    scoringBreakdown: scoreDetails.breakdown,
    mergedClaimCount: mergedClaimCount || 0,
    pipelineTrace,
    summary,
    recommendation,
    generatedAt: new Date().toISOString(),
  };
}

// Collapses the whole pipeline down to a single Real / Fake / Unclear call,
// per the "just tell me if it's fake or real" requirement — the detailed
// per-claim breakdown below still gives the reasoning behind it.
function computeOverallVerdict(trustScore, tally, evidenceCoverage, visualAnalysis, thresholds = DEFAULT_THRESHOLDS) {
  const totalChecked = tally.verified + tally.suspicious + tally.false;
  const visualFlagged = visualAnalysis && visualAnalysis.performed && ['likely_ai_generated','likely_manipulated'].includes(visualAnalysis.aiGenerationVerdict) && Number(visualAnalysis.confidence) >= 80;

  if (tally.unverifiable > totalChecked && evidenceCoverage < 40) {
    return { verdict: 'Unclear', confidence: 40 };
  }

  if (trustScore < thresholds.fake || (tally.false > 0 && tally.false >= tally.verified) || visualFlagged) {
    return { verdict: 'Likely Fake', confidence: Math.max(0, 100 - trustScore) };
  }

  if (trustScore >= thresholds.real) {
    return { verdict: 'Likely Real', confidence: trustScore };
  }

  return { verdict: 'Unclear', confidence: 50 };
}

// Pulls together the "if Fake — what is incorrect, with evidence and source
// proof" requirement: every false/suspicious claim, why it's wrong, and the
// actual sources the Fact Verification agent found for it.
function buildWhatsIncorrect(claims) {
  return claims
    .filter((c) => c.verdict === 'false' || c.verdict === 'suspicious')
    .map((c) => ({
      claim: c.claim,
      verdict: c.verdict,
      confidence: c.confidence,
      whatsWrong: c.explanation,
      evidence: (c.sources || []).map((s) => ({
        title: s.title,
        url: s.url,
        hostname: s.hostname,
        snippet: s.snippet || '',
        stance: s.stance || 'neutral',
        stanceReason: s.stanceReason || '',
        reliabilityScore: s.reliabilityScore,
      })),
    }));
}

// Counts of claims flagged by the newer detection layers (hallucination risk,
// temporal staleness, unconfirmed quotes) — surfaced separately from the
// verified/suspicious/false/unverifiable tally so the UI can call them out.
function computeFlags(claims) {
  return {
    hallucinationRisk: claims.filter((c) => c.hallucinationRisk).length,
    temporalWarning: claims.filter((c) => c.temporalWarning).length,
    unconfirmedQuote: claims.filter((c) => c.quoteCheck && c.quoteCheck.status === 'unconfirmed').length,
  };
}

// Weight a "major" (central to the article's thesis) claim more heavily
// than a "minor" (incidental) one, so a single wrong incidental detail
// doesn't sink the score the same way a fabricated central claim does.
const IMPORTANCE_WEIGHT = { major: 1.6, minor: 1 };

function computeScoreDetails(claims, weights = DEFAULT_WEIGHTS, thresholds = DEFAULT_THRESHOLDS, visualAnalysis = null, settings = {}) {
  const scorable = claims.filter((c) => c.verdict !== 'not-applicable');
  if (scorable.length === 0) {
    return { score: 50, breakdown: { claims: 50, source: 50, evidence: 0, visual: null, activeWeights: { claims: 25, source: 25, evidence: 35 }, penalties: 0 } };
  }
  let weightedTotal = 0, weightSum = 0;
  for (const c of scorable) {
    const w = IMPORTANCE_WEIGHT[c.importance] || 1;
    weightedTotal += scoreForClaim(c) * w; weightSum += w;
  }
  const claimComponent = weightSum ? weightedTotal / weightSum : 0.5;
  const allSources = scorable.flatMap((c) => c.sources || []);
  const sourceComponent = allSources.length === 0 ? 0.5 : clamp01((allSources.reduce((sum, s) => sum + (Number(s.reliabilityScore) || 0), 0) / allSources.length + 8) / 18);
  const evidenceComponent = computeEvidenceCoverage(claims) / 100;
  let visualComponent = null;
  if (visualAnalysis?.performed) {
    if (visualAnalysis.aiGenerationVerdict === 'likely_authentic') visualComponent = 1;
    else if (visualAnalysis.aiGenerationVerdict === 'inconclusive') visualComponent = 0.5;
    else visualComponent = clamp01(1 - Number(visualAnalysis.confidence || 50) / 100);
  }
  const activeWeights = { source: Number(weights.source) || 0, evidence: Number(weights.evidence) || 0, claims: Number(weights.claims) || 0 };
  if (visualComponent !== null) activeWeights.visual = Number(weights.visual) || 0;
  const weightTotal = Object.values(activeWeights).reduce((a, b) => a + b, 0) || 100;
  let score = Math.round(((claimComponent * activeWeights.claims) + (sourceComponent * activeWeights.source) + (evidenceComponent * activeWeights.evidence) + (visualComponent !== null ? visualComponent * activeWeights.visual : 0)) / weightTotal * 100);
  let penalties = 0;
  if (settings?.businessReportVerification) {
    const failed = scorable.filter((c) => c.verdict === 'false').length;
    penalties += Math.min(failed, 3) * (Number(thresholds.docPenalty) || 0);
  }
  if (visualAnalysis?.performed && visualAnalysis.categories) {
    const flagged = Object.values(visualAnalysis.categories).filter((c) => c?.flagged).length;
    penalties += Math.min(flagged * (Number(thresholds.mediaPenalty) || 0), 6);
  }
  score = Math.max(0, Math.min(100, score - penalties));
  return { score, breakdown: {
    claims: Math.round(claimComponent * 100), source: Math.round(sourceComponent * 100),
    evidence: Math.round(evidenceComponent * 100), visual: visualComponent === null ? null : Math.round(visualComponent * 100),
    activeWeights, penalties
  }};
}

function computeTrustScore(claims, weights = DEFAULT_WEIGHTS, thresholds = DEFAULT_THRESHOLDS, visualAnalysis = null, settings = {}) {
  // "not-applicable" claims (opinion/satire/prediction) were never
  // fact-checked against evidence — including them (even neutrally) would
  // dilute or misrepresent the score, so they're excluded entirely here.
  const scorable = claims.filter((c) => c.verdict !== 'not-applicable');
  if (scorable.length === 0) return 50;

  // --- Claims component (0-1): importance-weighted average of per-claim scores ---
  let weightedTotal = 0;
  let weightSum = 0;
  for (const c of scorable) {
    const weight = IMPORTANCE_WEIGHT[c.importance] || 1;
    weightedTotal += scoreForClaim(c) * weight;
    weightSum += weight;
  }
  const claimComponent = weightSum > 0 ? weightedTotal / weightSum : 0.5;

  // --- Source component (0-1): average reliability of every source actually
  // cited across all claims, normalized. Reliability scores from
  // domainReputation range roughly -8..10; a claim resting on wire
  // services/institutions should lift the score, one resting on fabricated/
  // impersonation domains should pull it down, independent of the verdict
  // the LLM assigned.
  const allSources = scorable.flatMap((c) => c.sources || []);
  const sourceComponent =
    allSources.length === 0
      ? 0.5
      : clamp01(
          (allSources.reduce((sum, s) => sum + (Number(s.reliabilityScore) || 0), 0) / allSources.length + 8) / 18
        );

  // --- Evidence component (0-1): how much of the article was even checkable ---
  const evidenceComponent = computeEvidenceCoverage(claims) / 100;

  // --- Visual component (0-1): only meaningful for video content; excluded
  // (weight redistributed) when no visual analysis ran at all.
  let visualComponent = null;
  if (visualAnalysis && visualAnalysis.performed) {
    if (visualAnalysis.aiGenerationVerdict === 'likely_authentic') visualComponent = 1;
    else if (visualAnalysis.aiGenerationVerdict === 'inconclusive') visualComponent = 0.5;
    else visualComponent = clamp01(1 - Number(visualAnalysis.confidence || 50) / 100);
  }

  const activeWeights = { source: weights.source, evidence: weights.evidence, claims: weights.claims };
  if (visualComponent !== null) activeWeights.visual = weights.visual;
  const weightTotal = Object.values(activeWeights).reduce((a, b) => a + Number(b || 0), 0) || 100;

  const blended =
    (claimComponent * (activeWeights.claims || 0) +
      sourceComponent * (activeWeights.source || 0) +
      evidenceComponent * (activeWeights.evidence || 0) +
      (visualComponent !== null ? visualComponent * (activeWeights.visual || 0) : 0)) /
    weightTotal;

  let score = Math.round(blended * 100);

  // --- Penalties (flat point deductions, per Settings > thresholds) ---
  // Document penalty: a "false" claim in Business Report Verification mode
  // means a primary document/figure failed to resolve, which is a harder
  // failure than an ordinary false claim — apply once per such claim.
  if (settings?.businessReportVerification) {
    const failedDocClaims = scorable.filter((c) => c.verdict === 'false').length;
    score -= Math.min(failedDocClaims, 3) * (Number(thresholds.docPenalty) || 0);
  }
  // Media-manipulation penalty: one deduction per confirmed-flagged visual
  // category, capped (matches the "capped at 6" note in the Settings UI).
  if (visualAnalysis?.performed && visualAnalysis.categories) {
    const flaggedCategories = Object.values(visualAnalysis.categories).filter((c) => c?.flagged).length;
    const mediaPenaltyTotal = Math.min(flaggedCategories * (Number(thresholds.mediaPenalty) || 0), 6);
    score -= mediaPenaltyTotal;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

function scoreForClaim(c) {
  switch (c.verdict) {
    case 'verified':
      return c.confidence / 100;

    case 'suspicious':
      return 0.35 * (c.confidence / 100);

    case 'false':
      return 0;

    case 'unverifiable':
    default:
      // Neutral contribution — absence of evidence is not evidence of falsehood.
      return 0.5;
  }
}

// Fraction of claims for which at least one search source was actually found
// (as opposed to zero results, which is what makes a claim unverifiable
// due to lack of coverage). Claims that were never sent to search
// (opinion/satire/prediction) are excluded from both the numerator and
// denominator — they shouldn't count against coverage.
function computeEvidenceCoverage(claims) {
  const checkable = claims.filter((c) => c.verdict !== 'not-applicable');
  if (checkable.length === 0) return 0;

  const withEvidence = checkable.filter(
    (c) => Array.isArray(c.sources) && c.sources.length > 0
  ).length;

  return Math.round((withEvidence / checkable.length) * 100);
}

function activeModes(settings = {}) {
  const modes = [];

  if (settings.factChecking) modes.push('Fact Checking');
  if (settings.fakeNewsDetection) modes.push('Fake News Detection');
  if (settings.businessReportVerification) modes.push('Business Report Verification');

  return modes.join(', ') || 'General analysis';
}

function mockSummary(trustScore, tally, evidenceCoverage, flags = {}) {
  let summary;

  if (tally.unverifiable > (tally.verified + tally.suspicious + tally.false)) {
    summary = `Most extracted claims (${tally.unverifiable} of them) could not be checked against available search evidence, so overall credibility could not be fully assessed. Only ${evidenceCoverage}% of claims had any matching source found.`;
  } else if (trustScore >= 70) {
    summary = `Most extracted claims (${tally.verified} verified) were supported by available evidence. Overall the content appears largely credible, though some claims (${tally.suspicious} suspicious, ${tally.unverifiable} unverifiable) could not be fully confirmed.`;
  } else if (trustScore >= 40) {
    summary = `The content shows a mixed credibility profile — ${tally.verified} claims verified, ${tally.suspicious} suspicious, ${tally.false} false/misleading, and ${tally.unverifiable} unverifiable. Readers should treat some claims with caution.`;
  } else {
    summary = `A significant portion of the extracted claims (${tally.false} false, ${tally.suspicious} suspicious) lack solid supporting evidence, suggesting the content may be misleading.`;
  }

  if (flags.hallucinationRisk || flags.temporalWarning || flags.unconfirmedQuote) {
    summary += ` Additional caution flags: ${flags.hallucinationRisk} possible hallucination(s), ${flags.temporalWarning} outdated-evidence warning(s), ${flags.unconfirmedQuote} unconfirmed quote(s).`;
  }

  if (tally['not-applicable']) {
    summary += ` ${tally['not-applicable']} statement(s) were opinion/satire/prediction and were not fact-checked (excluded from the credibility score).`;
  }

  const recommendation =
    tally.unverifiable > (tally.verified + tally.suspicious + tally.false)
      ? 'Could not be fully verified — treat with normal caution and check for additional sources before sharing.'
      : trustScore >= 70
      ? 'Reasonably safe to share, but verify any high-stakes claims independently.'
      : trustScore >= 40
      ? 'Verify further before sharing — several claims are unconfirmed.'
      : 'Do not share without independent verification — multiple claims appear false or unsupported.';

  return { summary, recommendation };
}

module.exports = { generateReport };