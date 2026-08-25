const { extractFromURL, extractFromFile, extractFromVideo } = require('../utils/contentExtractors');

/**
 * Agent 1 — Content Reader
 * Normalizes any input type (URL / uploaded file / pasted text / video) into a single
 * { title, text, sourceUrl? } shape that downstream agents can work with.
 *
 * 'url', 'newsUrl' and 'blogArticle' all use the same page-scraping extractor —
 * they're kept as separate inputTypes because the UI, report framing, and (for
 * 'blogArticle') the claim-extraction focus differ slightly, not because the
 * underlying fetch mechanism does.
 */
async function readContent({ inputType, url, filePath, fileName, text }) {
  if (inputType === 'url' || inputType === 'newsUrl' || inputType === 'blogArticle') {
    if (!url) throw new Error(`URL is required for inputType=${inputType}`);
    const result = await extractFromURL(url);
    if (!result.text || result.text.length < 50) {
      throw new Error('Could not extract meaningful text from this URL. The page may block scraping.');
    }
    return { ...result, contentCategory: inputType === 'blogArticle' ? 'blog' : 'news' };
  }

  if (inputType === 'videoUrl') {
    if (!url) throw new Error('A video URL is required for inputType=videoUrl');
    const result = await extractFromVideo(url);
    return result;
  }

  if (inputType === 'videoFile') {
    if (!filePath) throw new Error('A video file is required for inputType=videoFile');
    const sampled = require('../utils/videoFrames').extractFramesFromFile(filePath, { count: Number(process.env.VIDEO_FRAME_COUNT) || 8, maxWidth: 768 });
    return { frameExtractionMode: 'actual_timeline', title: fileName || 'Uploaded video', text: `VIDEO FILE: ${fileName || 'uploaded video'}`, contentCategory: 'video', frames: sampled.frames, frameCount: sampled.frames.length, duration: sampled.duration, thumbnailBase64: sampled.frames[0]?.base64 || null, thumbnailMimeType: sampled.frames[0]?.mimeType || null, hasTranscript: false };
  }

  if (inputType === 'file') {
    if (!filePath) throw new Error('A file is required for inputType=file');
    const result = await extractFromFile(filePath, fileName);
    if (!result.text || result.text.length < 20) {
      throw new Error('Could not extract text from this file.');
    }
    return result;
  }

  if (inputType === 'text') {
    if (!text || text.trim().length < 20) {
      throw new Error('Pasted text is too short to analyze (minimum 20 characters).');
    }
    return { title: 'Pasted Text', text: text.trim() };
  }

  throw new Error(`Unknown inputType: ${inputType}`);
}

module.exports = { readContent };
