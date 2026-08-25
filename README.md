# DeepTrust — Evidence-First Verification Workspace

DeepTrust combines the original multi-agent fake-news pipeline with the DeepTrust prototype workflow and a stronger video-forensics path.

## What is included

- News URL, Blog/Article, Text, Document, Video URL and direct Video File intake.
- Evidence-backed claim extraction and web verification.
- Actual video timeline sampling with **yt-dlp + FFmpeg** instead of relying on one static thumbnail.
- Multi-frame vision analysis for AI-generation/manipulation signals: face identity drift, mouth/expression consistency, hands/objects, background geometry, temporal consistency, rendering artifacts and unstable overlays.
- Conservative visual verdicts: `likely_ai_generated`, `likely_manipulated`, `likely_authentic`, or `inconclusive`. A visual flag only changes the overall verdict when confidence is strong.
- DeepTrust-style workspace navigation: Overview, Latest News, Fake News Desk, History, Settings, Team, Account, Subscription and Upgrade.
- Detailed report dossier with claim ledger, evidence coverage, recommendation, visual forensics, frame timestamps and strong signals.
- JWT authentication, persistent local JSON history, graceful LLM/search fallbacks and upload cleanup.

## Important video setup

The biggest accuracy limitation in the old build was that it analyzed a single thumbnail. This build attempts to download the actual public video, samples eight real frames across its timeline, and sends them together to the vision model.

Install the video tools on Windows:

```powershell
cd DeepTrust
.\setup-video-tools.ps1
```

Then verify:

```powershell
yt-dlp --version
ffmpeg -version
ffprobe -version
```

If yt-dlp/FFmpeg are unavailable, DeepTrust does **not** pretend that a thumbnail is a full forensic scan; it falls back to a limited cover-frame screen and tells the report what happened.

## Backend

```powershell
cd backend
copy .env.example .env
# add your Gemini + Serper keys
npm install
npm start
```

For Gemini, set `GEMINI_API_KEY`. For live claim verification, set `SERPER_API_KEY`. Keep `MOCK_MODE=false` for real analysis.

## Frontend

```powershell
cd frontend
npm install
npm run dev
```

The frontend expects the backend at `http://localhost:5000/api`. To change it, set `VITE_API_URL`.

## Accuracy notes

AI-generated video detection is an inherently probabilistic problem. A multimodal LLM can screen visible evidence but cannot guarantee authenticity from a handful of frames. The system therefore separates **claim truth** from **media authenticity** and keeps an `inconclusive` outcome instead of forcing a fake/real answer when evidence is weak.

For production-grade forensic detection, add a dedicated trained video-deepfake classifier and audio/voice-clone model alongside this evidence pipeline; do not treat an LLM-only screen as laboratory proof.

## Prototype parity update (18 Aug 2026)
The React frontend now includes the major DeepTrust prototype workspace surfaces that were previously missing: account dropdown, My account, My team, Settings (Profile/Sources/Scoring algorithm), My subscription, Upgrade plan with compare table, payment-method step, order summary, and completion/receipt step. These flows are local/demo-safe and do not process real payments.

## Prototype parity (added)
The React frontend now includes the DeepTrust prototype workspace surfaces shown in the reference design: Dashboard, Latest news, Fake news desk, History, New DeepTrust intake, Verification Report, Settings (Profile/Sources/Scoring algorithm), My account, My team, My subscription, Upgrade plan, Payment, Order summary and Done/receipt. The avatar dropdown exposes Search, My subscription, Upgrade plan, My account, My team, Settings and Sign out, and Search opens a working DeepTrust navigation overlay.

The prototype reference is retained at `docs/DEEPTRUST-DESIGN-V1.html`.
