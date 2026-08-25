const { completeJSONWithImages } = require('../utils/llmClient');

/**
 * Video & Audio Forensics — evidence-first visual screening.
 * This is intentionally not marketed as a laboratory deepfake detector. It
 * compares real timeline frames, asks a vision model to inspect temporal
 * consistency, and reports uncertainty when the available evidence is weak.
 */
async function analyzeVisual({ frames = [], title, hasTranscript, duration, frameExtractionMode = 'actual_timeline' }) {
  if (!Array.isArray(frames) || frames.length === 0) {
    return { performed: false, reason: 'No real video frames could be extracted. Install yt-dlp and ffmpeg, or upload the video file directly.' };
  }

  // Keep requests bounded. Eight actual timeline frames give the model enough
  // temporal context without making the multimodal prompt unnecessarily huge.
  const selected = frames.slice(0, 8);
  const system = `You are DeepTrust's Video & Audio Forensics agent. Analyze MULTIPLE REAL TIMELINE FRAMES extracted from the same video. This is a screening system, not a legal or laboratory-grade deepfake detector.

Your primary task is to assess whether the video appears AI-generated, face-swapped/manipulated, or naturally captured. Do NOT infer AI generation merely because a frame is unusually polished, cinematic, compressed, or low quality. Strong evidence requires visible, repeated inconsistencies across frames.

Compare frames for:
1. faceIdentity: identity drift, face geometry changing, teeth/eyes/ears/hair morphing, skin texture seams.
2. lipSyncAndExpression: mouth/phoneme mismatch or expression changes that do not track naturally. Do not claim audio sync unless audio was actually provided; treat this as visual mouth-motion only.
3. handsAndObjects: finger count, object shape/position, jewelry, text, logos, clothing details that morph or teleport.
4. backgroundGeometry: straight lines, architecture, reflections, shadows, crowds or textures changing unnaturally.
5. temporalConsistency: whether the same subject/background details remain stable from frame to frame.
6. renderingArtifacts: denoising halos, painterly textures, plastic skin, repeated patterns, inconsistent motion blur or edges.
7. textAndOverlays: unstable generated text/logos/captions or compositing seams.

Return strict JSON with:
{
  "aiGenerationVerdict":"likely_ai_generated|likely_manipulated|likely_authentic|inconclusive",
  "confidence":0,
  "riskScore":0,
  "summary":"short evidence-based summary",
  "categories":{
    "faceIdentity":{"flagged":false,"severity":"low|medium|high","note":"..."},
    "lipSyncAndExpression":{"flagged":false,"severity":"low|medium|high","note":"..."},
    "handsAndObjects":{"flagged":false,"severity":"low|medium|high","note":"..."},
    "backgroundGeometry":{"flagged":false,"severity":"low|medium|high","note":"..."},
    "temporalConsistency":{"flagged":false,"severity":"low|medium|high","note":"..."},
    "renderingArtifacts":{"flagged":false,"severity":"low|medium|high","note":"..."},
    "textAndOverlays":{"flagged":false,"severity":"low|medium|high","note":"..."}
  },
  "strongSignals":["..."],
  "limitations":["..."],
  "frameCountAnalyzed":0
}

Rules: confidence must reflect evidence quality, not certainty. If only subtle or ambiguous artifacts are visible, choose inconclusive. Never use the video title as evidence. Never invent a signal that is not visible in the frames.`;

  const user = `VIDEO TITLE: ${title || 'Unknown'}\nDURATION_SECONDS: ${duration || 'unknown'}\nTRANSCRIPT_AVAILABLE: ${hasTranscript ? 'yes' : 'no'}\n\nCompare the attached timeline frames in chronological order. Frame labels identify approximate timestamps. Focus on changes ACROSS frames, not just isolated image quality.`;

  const mockResponse = mockVisual(selected, title);
  const result = await completeJSONWithImages({
    system,
    user,
    images: selected,
    mockResponse,
  });

  const verdict = normalizeVerdict(result.aiGenerationVerdict || result.verdict);
  return {
    performed: true,
    scope: frameExtractionMode === 'actual_timeline' && selected.length > 1 ? 'Actual sampled video frames compared across the timeline; this remains a heuristic AI/manipulation screen, not definitive forensic proof.' : 'Only a fallback cover frame was available, so AI-generation detection is inconclusive and should not be treated as a full video scan.',
    frameCount: selected.length,
    frameTimestamps: selected.map(f => f.timestamp),
    duration: duration || null,
    ...result,
    aiGenerationVerdict: verdict,
    verdict,
  };
}

function normalizeVerdict(v) {
  const s = String(v || '').toLowerCase();
  if (s.includes('ai_generated')) return 'likely_ai_generated';
  if (s.includes('manipulated')) return 'likely_manipulated';
  if (s.includes('authentic')) return 'likely_authentic';
  return 'inconclusive';
}

function mockVisual(frames, title = '') {
  return {
    aiGenerationVerdict: 'inconclusive', confidence: 35, riskScore: 35,
    summary: `MOCK_MODE: ${frames.length} timeline frames were extracted, but no real vision model was used.`,
    categories: Object.fromEntries(['faceIdentity','lipSyncAndExpression','handsAndObjects','backgroundGeometry','temporalConsistency','renderingArtifacts','textAndOverlays'].map(k => [k,{flagged:false,severity:'low',note:'MOCK_MODE: visual model not connected.'}])),
    strongSignals: [],
    limitations: ['MOCK_MODE is enabled; this result is not an AI-generation prediction.'],
    frameCountAnalyzed: frames.length,
  };
}

module.exports = { analyzeVisual };
