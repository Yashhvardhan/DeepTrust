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

## Manager review pass — real data instead of demo placeholders

The prior build's Account/Settings/Subscription/Team surfaces were all built
around a fixed fictional persona ("Gajendra Singh", "Caasaa AI", a hardcoded
"310 / 500" usage figure, a hardcoded "HDFC •••• 4218" card) instead of the
actually logged-in user's real data. This pass replaces that with genuine
per-user data end to end, and removes the pieces that had no real backing.

**Backend**
1. `routes/auth.js` — `/register` and `/login` now return a full profile
   (name/mobile/company/website/role/beats/notification prefs/plan) plus a
   real `usedThisCycle` count computed from that user's own reports this
   calendar month. New `GET /api/auth/me` and `PATCH /api/auth/me` so the
   Settings > Profile screen persists to the database instead of only
   `localStorage`.
2. `routes/account.js` (new) —
   - `GET /account/usage`: real verification count vs. plan limit, replacing
     every hardcoded "310 / 500" in the old UI.
   - `GET /account/notifications` + `POST /account/notifications/mark-read`:
     notifications are derived from the user's own reports (any run in the
     last 7 days that scored "Likely Fake" or under 40%), with unread state
     tracked against `lastSeenNotificationsAt`. This replaces the bell icon
     that always said "No new alerts".
   - `POST /account/upgrade-request`: there is no payment processor wired
     into this MVP, so instead of faking a checkout flow with someone else's
     card details, an upgrade click now genuinely logs a request record for
     manual follow-up.
3. `db.js` — added the `upgradeRequests` collection.

**Frontend**
1. **Report generation** — Results now has a real "Download report (PDF)"
   button (via `jspdf`) that generates an actual PDF from the on-screen
   report (verdict, trust score, claim ledger, what's-incorrect, evidence
   links, visual analysis). This was the missing piece in the fact
   verification flow the report generator agent's output was never
   exported into a document.
2. **My team** — removed entirely (page, route, nav entry, search-index
   entries). It had no real multi-user backing in this single-tenant MVP.
3. **My account** — removed the "Security and data" and "Team" cards
   (2FA/session/session-retention/team-roster figures that weren't backed
   by anything). Replaced with Plan, real usage, and a Profile summary that
   links to Settings.
4. **Settings > Profile** — now loads and saves the real logged-in user via
   `PATCH /api/auth/me` (with a visible "Saving…" / "Saved." state), instead
   of writing to `localStorage` under a fake identity. Removed the
   "Manage account" button.
5. **Subscription / Upgrade** — kept as informational screens showing real
   plan/usage; replaced the fake invoices table and payment-method card
   (someone else's card number) with a plain statement that no payment
   processor is connected yet. The full fake Payment → Summary → Thanks
   checkout flow (hardcoded billing entity, GSTIN, card, "amount charged")
   was removed and replaced with a single "Request this plan" action that
   hits `POST /account/upgrade-request`.
6. **Notifications bell** — now shows a real unread badge and a dropdown of
   the user's actual flagged verifications, linking straight to that report.
7. **Login page** — the "LIVE VERIFICATION EXAMPLE" panel was static sample
   data, not live; relabeled to "SAMPLE VERIFICATION REPORT" so it no longer
   overclaims.

Verified with `node --check` on all touched backend files, a full mock-mode
smoke test of the new endpoints (register → patch profile → usage →
notifications → upgrade-request → run a verification → usage increments
correctly), the existing backend test suite (`npm test`), and a clean
frontend `npm run build`.

## Round 2 — "not worth 7-8 days" review fixes (report presentation + evidence transparency)

Feedback: report reads like a generic chatbot summary, unclear what the
agents are actually doing, most screens felt static. Root causes found and
fixed:

1. **The pipeline was computing real per-claim signals and discarding them
   before they reached the UI.** `factVerificationAgent.js` already ran
   self-consistency re-checks, independent-source gating, hallucination
   detection (model-stated vs. evidence-computed confidence), temporal and
   quote-fidelity checks, and per-source NLI stance classification — but the
   final claim object only kept a collapsed prose `explanation`. Now each
   claim returns:
   - `sources[].stance` (supports/refutes/neutral) per source, instead of a
     flat link list
   - `queriesUsed` — the actual search query strings fired
   - `signals[]` — pass/flag badges for each detection layer that ran, with
     the real numbers behind each one
   - `rawEvidenceCount` — sources found before reliability ranking
2. **New `pipelineTrace` on the report** (`reportGeneratorAgent.js`): real
   counts of claims extracted/merged/fact-checked, search queries run,
   sources found vs. kept, and borderline claims double-checked. Rendered
   as a "Pipeline trace" panel at the top of the Results page — what each
   agent actually did on this run, in numbers, not narration.
3. **Results page rebuilt**: claim ledger now shows the search query used,
   a dual confidence bar (evidence-computed vs. model-stated — visually
   flags the hallucination gap), signal chips, and stance-colored source
   chips (green=supports/red=refutes/gray=neutral) instead of a paragraph +
   plain link list. PDF export updated to match.
4. **Settings > Sources tab was a hardcoded frontend array** with zero
   connection to the pipeline. New `GET /api/account/sources` serves the
   *actual* domain-reputation table the Fact Verification agent looks
   hostnames up against; the Sources tab now renders that live.
5. **New `GET /api/account/stats`** (real trend + verdict distribution from
   the user's own report history) — wired into Account (trust-score
   sparkline + verdict donut + real avg evidence coverage) and Subscription
   (usage trend).
6. **Found and fixed a separate, pre-existing bug while auditing this**:
   `.card`, `.btn`, `.btn-ghost`, `.btn-clay`, `.between`, `.wrap`, `.pad`,
   and several other utility classes used throughout Account/Subscription/
   Settings/Upgrade were never defined in `index.css` — those pages were
   rendering as unstyled divs and default browser buttons. Added the
   missing utility CSS matching the existing design tokens.

Not done in this pass (flagged, not fixed): the "verification in progress"
agent rail in `AnalysisForm.jsx` still steps on a fixed `setInterval` timer
disconnected from real backend progress. Fixing this properly needs a
streaming channel (SSE/polling against real per-agent completion) and was
deprioritized this round in favor of the report/evidence work above.

Verified with `node --check` on all touched backend files, the existing
backend test suite (`npm test`), a live mock-mode end-to-end run confirming
`pipelineTrace`, `signals`, `queriesUsed`, and stance-tagged `sources` all
populate correctly, a live check of the new `/api/account/sources` and
`/api/account/stats` endpoints, and a clean frontend `npm run build`. No
headless browser was available in this environment to capture a literal
screenshot — recommend a quick visual pass in a real browser before this
goes back to the reviewer.
