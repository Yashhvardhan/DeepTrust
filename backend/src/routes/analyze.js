const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { requireAuth } = require('../middleware/auth');
const { db } = require('../db');

const { readContent } = require('../agents/contentReaderAgent');
const { extractClaims } = require('../agents/claimExtractorAgent');
const { verifyClaims } = require('../agents/factVerificationAgent');
const { generateReport } = require('../agents/reportGeneratorAgent');
const { analyzeVisual } = require('../agents/visualAnalysisAgent');
const { dedupeClaims } = require('../utils/claimDedup');

const INPUT_TYPES = ['url', 'newsUrl', 'blogArticle', 'videoUrl', 'videoFile', 'file', 'text'];

const router = express.Router();

const upload = multer({
  dest: path.join(__dirname, '..', '..', 'uploads'),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB for video uploads
  fileFilter: (req, file, cb) => {
    const ok = /\.(pdf|docx|txt|mp4|webm|mov|mkv|avi)$/i.test(file.originalname);
    cb(ok ? null : new Error('Supported uploads: PDF, DOCX, TXT, MP4, WEBM, MOV, MKV, AVI'), ok);
  },
});

// POST /api/analyze  — runs Agent1 -> Agent2 -> Agent3 -> Agent4 in sequence
router.post('/', requireAuth, upload.single('file'), async (req, res) => {
  const { inputType, url, text } = req.body;
  const settings = safeParseSettings(req.body.settings);
  const scoringConfig = safeParseScoringConfig(req.body.scoringConfig);
  // Fact Verification also needs to know the "require two independent
  // sources above the review threshold" policy, so it's attached to
  // `settings` (which is already threaded through every agent call).
  settings.scoringConfig = scoringConfig;

  if (!INPUT_TYPES.includes(inputType)) {
    return res.status(400).json({ error: `Unknown inputType: ${inputType}` });
  }

  try {
    // Agent 1: Content Reader
    const content = await readContent({
      inputType,
      url,
      filePath: req.file ? req.file.path : undefined,
      fileName: req.file ? req.file.originalname : undefined,
      text,
    });

    // Agent 2: Claim Extractor
    const extractedClaims = await extractClaims(content, settings);
    if (extractedClaims.length === 0 && inputType !== 'videoUrl') {
      return res.status(422).json({ error: 'No checkable factual claims were found in this content.' });
    }

    // De-duplicate near-identical claims (e.g. a headline stat restated in
    // the body) BEFORE verification, so the same underlying fact can't be
    // counted twice in the trust score. See utils/claimDedup.js.
    const { claims, mergedCount } = dedupeClaims(extractedClaims);

    // Agent 3: Fact Verification Agent
    const verifiedClaims = claims.length > 0 ? await verifyClaims(claims, settings) : [];

    // Agent 5: Visual Analysis (video only) — runs alongside/after verification,
    // screens the thumbnail frame for tampering signals. Never blocks the report.
    let visualAnalysis = null;
    if (inputType === 'videoUrl' || inputType === 'videoFile') {
      try {
        visualAnalysis = await analyzeVisual({
          frames: content.frames || [],
          title: content.title,
          hasTranscript: content.hasTranscript,
          duration: content.duration,
          frameExtractionMode: content.frameExtractionMode,
        });
      } catch (e) {
        visualAnalysis = { performed: false, reason: `Visual analysis failed: ${e.message}` };
      }
    }

    // Agent 4: Report Generator
    const report = await generateReport({
      title: content.title,
      sourceUrl: content.sourceUrl,
      verifiedClaims,
      settings,
      contentCategory: content.contentCategory || (inputType === 'file' ? 'file' : inputType === 'text' ? 'text' : 'news'),
      visualAnalysis,
      scoringConfig,
      mergedClaimCount: mergedCount,
    });

    // Persist
    const record = {
      id: uuidv4(),
      userId: req.user.id,
      inputType,
      inputRef: ['url', 'newsUrl', 'blogArticle', 'videoUrl'].includes(inputType)
        ? url
        : ['file', 'videoFile'].includes(inputType)
        ? req.file.originalname
        : 'Pasted text',
      settings,
      report,
      createdAt: new Date().toISOString(),
    };
    await db.read();
    db.data.reports.push(record);
    await db.write();

    res.json({ reportId: record.id, report });
  } catch (err) {
    console.error('[analyze] pipeline error:', err.message);
    res.status(400).json({ error: err.message || 'Analysis failed' });
  } finally {
    if (req.file?.path) {
      try { require('fs').unlinkSync(req.file.path); } catch {}
    }
  }
});

// GET /api/analyze/history — list past reports for the logged-in user
router.get('/history', requireAuth, async (req, res) => {
  await db.read();
  const reports = db.data.reports
    .filter((r) => r.userId === req.user.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((r) => ({
      id: r.id,
      inputType: r.inputType,
      inputRef: r.inputRef,
      trustScore: r.report.trustScore,
      claimsFound: r.report.claimsFound,
      verdict: r.report.verdict,
      breakdown: r.report.breakdown,
      evidenceCoverage: r.report.evidenceCoverage,
      createdAt: r.createdAt,
    }));
  res.json({ reports });
});

// GET /api/analyze/:id — fetch a single full report
router.get('/:id', requireAuth, async (req, res) => {
  await db.read();
  const record = db.data.reports.find((r) => r.id === req.params.id && r.userId === req.user.id);
  if (!record) return res.status(404).json({ error: 'Report not found' });
  res.json({ reportId: record.id, report: record.report });
});

function safeParseSettings(raw) {
  const defaults = { factChecking: true, fakeNewsDetection: false, businessReportVerification: false };
  if (!raw) return defaults;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

// Optional per-user scoring policy sent from the Settings > Scoring algorithm
// screen (factor weights + thresholds/penalties, stored client-side). Wiring
// this through means the Settings screen actually changes how a report is
// scored, instead of only writing to localStorage. Malformed/missing input
// falls back to generateReport's own defaults (which match the Settings UI
// defaults), so this is always safe to omit.
function safeParseScoringConfig(raw) {
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

module.exports = router;
