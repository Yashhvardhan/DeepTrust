# DeepTrust build notes

## Video accuracy upgrade

The previous implementation sent one static thumbnail to a vision model. That is not sufficient for AI-generated video screening because many artifacts only appear as temporal inconsistencies.

The current implementation: 

1. Accepts a public video URL or uploaded video file.
2. Uses yt-dlp to obtain the actual video when a URL is provided.
3. Uses FFmpeg/FFprobe to sample eight timeline positions.
4. Sends the sampled frames together to Gemini Vision or Ollama Vision.
5. Asks the model to compare identity, expressions, hands/objects, geometry, overlays, rendering artifacts and temporal consistency.
6. Uses a conservative confidence threshold before media evidence can force the overall report to `Likely Fake`.
7. Reports an explicit `inconclusive` state when only a cover frame is available.

## Prototype integration

The React workspace now exposes the main product surfaces shown by the supplied prototype: dashboard, latest intake, fake-news desk, history, new verification, settings, account, team, subscription and upgrade. The supplied HTML prototype is retained under `docs/DEEPTRUST-DESIGN-V1.html` as the visual reference.

## Not claimed

This is still not a certified deepfake forensic detector. A production-grade detector should add a trained video model, audio/voice-clone classifier and calibrated evaluation on a held-out dataset.

## Accuracy pass (Phase 3)

Applied on top of the existing NLI/semantic-ranking/source-reputation pipeline (Phase 2):

1. **Claim de-duplication** (`utils/claimDedup.js`) — near-identical claims
   (e.g. a stat restated in the headline and again in the body) are merged
   before verification, so the same underlying fact can no longer be
   double-counted in the trust score average.
2. **Self-consistency re-check** (`factVerificationAgent.js`) — when a
   claim's initial support/refute weights are nearly tied, or a "verified"
   call rests on only one independent source domain, a second independent
   LLM stance pass is run. If the two passes disagree on the direction of
   the verdict, the claim is downgraded to "suspicious" instead of trusting
   whichever call happened to run first — a cheap variance-reduction step
   applied only where it's actually needed, not on every claim.
3. **Independent-source gating** — a high-confidence "verified" verdict is
   now capped just under the configured "real" review threshold unless at
   least two independent source domains were found. This makes real the
   "Require two independent sources before any score above 75" policy that
   was already shown (but non-functional) in Settings > Scoring algorithm.
4. **Quote-fidelity metric upgrade** (`utils/textSimilarity.js`) — quote
   checks now blend the existing Jaccard (bag-of-words) score with an
   order-sensitive longest-common-subsequence ratio, so a quote that's been
   reordered/shuffled (same vocabulary, different meaning) is no longer
   scored identically to a verbatim match.
5. **Expanded + hardened source reputation table**
   (`utils/domainReputation.js`) — roughly 3x more recognized outlets,
   fact-checkers, and known-fabricated/satire domains, plus heuristic
   penalties for brand-impersonation-style hostnames (e.g.
   `reuters-news-alert.info`) and low-trust content-farm TLDs.
6. **Scoring policy actually wired to the backend** (`reportGeneratorAgent.js`,
   `routes/analyze.js`) — the Settings > Scoring algorithm screen's factor
   weights (source/evidence/claims/visual), fake/real thresholds, and
   document/media penalties previously only wrote to `localStorage` and had
   no effect on a report. They're now sent with every analysis request and
   genuinely change the trust score: the score blends four independently
   computed components (claim verdicts, average source reliability, evidence
   coverage, visual-analysis result) by the configured weights, the
   fake/real cutoffs drive the overall verdict, and the document/media
   penalty sliders apply real point deductions. Omitting the config (or an
   older cached frontend build) falls back to the same defaults shown in the
   Settings UI, so this is fully backward compatible.

All changes were verified with `node --check` on every touched file plus an
end-to-end mock-mode smoke test (extract → dedupe → verify → report) across
a plain-text scenario and a video + business-report scenario with a flagged
visual analysis, confirming the trust score, verdict, and scoring policy are
computed and returned as expected.
