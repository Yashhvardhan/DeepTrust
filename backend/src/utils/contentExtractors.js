const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { extractFramesFromFile, extractFramesFromUrl } = require('./videoFrames');

/** Fetch a URL and strip it down to readable article text. */
async function extractFromURL(url) {
  const { data: html } = await axios.get(url, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (FactVerificationAgent/1.0)' },
  });

  const $ = cheerio.load(html);
  $('script, style, nav, footer, header, iframe, noscript, svg, form').remove();

  const title = $('title').first().text().trim() || $('h1').first().text().trim();

  // Prefer <article>, then common content containers, then fall back to <body>
  let bodyText = '';
  const candidates = ['article', 'main', '[role="main"]', '.article-body', '.post-content', 'body'];
  for (const sel of candidates) {
    const text = $(sel).text().replace(/\s+/g, ' ').trim();
    if (text.length > 300) {
      bodyText = text;
      break;
    }
  }
  if (!bodyText) bodyText = $('body').text().replace(/\s+/g, ' ').trim();

  return {
    title,
    text: bodyText.slice(0, 20000), // cap length for downstream LLM calls
    sourceUrl: url,
  };
}

/** Extract text from an uploaded file (pdf, docx, txt) given its buffer + mimetype/filename. */
async function extractFromFile(filePath, originalName) {
  const ext = originalName.split('.').pop().toLowerCase();

  if (ext === 'pdf') {
    const buffer = fs.readFileSync(filePath);
    const parsed = await pdfParse(buffer);
    return { title: originalName, text: parsed.text.slice(0, 20000) };
  }

  if (ext === 'docx') {
    const result = await mammoth.extractRawText({ path: filePath });
    return { title: originalName, text: result.value.slice(0, 20000) };
  }

  if (ext === 'txt') {
    const text = fs.readFileSync(filePath, 'utf-8');
    return { title: originalName, text: text.slice(0, 20000) };
  }

  throw new Error(`Unsupported file type: .${ext}. Supported: PDF, DOCX, TXT.`);
}

/**
 * Extract a checkable content package from a video URL — from ANY site, not
 * just YouTube.
 *
 * Scope note (this is intentionally a "basic" implementation): we do NOT
 * download/transcode the full video or run frame-by-frame computer vision —
 * that needs ffmpeg/yt-dlp-class tooling that isn't realistic for an MVP.
 * Instead we pull together everything that's *publicly and cheaply*
 * available for a given video link, via three tiers that degrade gracefully:
 *
 *  1. YouTube (special-cased — richest data): oEmbed metadata + a best-effort
 *     caption/transcript scrape + the maxres thumbnail.
 *  2. Generic oEmbed autodiscovery: many video platforms (Vimeo, Dailymotion,
 *     SoundCloud-hosted video, some news CMSs, etc.) advertise an oEmbed
 *     endpoint via a <link type="application/json+oembed"> tag on the page —
 *     we follow that link if present to get title/author/thumbnail without
 *     any platform-specific code.
 *  3. Open Graph / Twitter Card fallback: for everything else (Facebook,
 *     Instagram, X/Twitter, TikTok, news-site embedded players, etc.) we
 *     scrape the page's og:title / og:description / og:image / twitter:image
 *     meta tags, which almost every modern site sets for link previews.
 *
 * There is generally NO transcript available outside YouTube (no public,
 * keyless API for it), so for non-YouTube videos the Claim Extractor works
 * from the title + description only — a real limitation, surfaced to the
 * user via `hasTranscript: false`, not a bug.
 */
async function extractFromVideo(url) {
  const videoId = extractYouTubeId(url);
  if (videoId) return extractFromYouTube(url, videoId);
  return extractFromGenericVideo(url);
}

async function extractFromYouTube(url, videoId) {
  // 1) oEmbed metadata — public, no key needed.
  let title = 'Untitled video';
  let author = null;
  try {
    const { data } = await axios.get('https://www.youtube.com/oembed', {
      params: { url: `https://www.youtube.com/watch?v=${videoId}`, format: 'json' },
      timeout: 10000,
    });
    title = data.title || title;
    author = data.author_name || null;
  } catch (e) {
    // Video may be private/embedding-disabled — proceed with whatever we have.
  }

  // 2) Best-effort transcript scrape from the watch page.
  let transcript = '';
  try {
    transcript = await fetchYouTubeTranscript(videoId);
  } catch (e) {
    transcript = '';
  }

  // 3) Extract actual timeline frames with yt-dlp + ffmpeg. The old implementation
  // used one static thumbnail, which cannot reveal temporal morphing or identity drift.
  const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
  let frames = [];
  let duration = null;
  let frameExtractionMode = 'none';
  try {
    const sampled = extractFramesFromUrl(url, { count: Number(process.env.VIDEO_FRAME_COUNT) || 8, maxWidth: 768 });
    frames = sampled.frames;
    duration = sampled.duration;
    frameExtractionMode = 'actual_timeline';
  } catch (e) {
    console.warn('[video] real frame extraction unavailable:', e.message);
  }
  const fallback = await fetchImageAsBase64(thumbnailUrl);
  if (!frames.length && fallback.thumbnailBase64) { frameExtractionMode = 'thumbnail_fallback'; frames = [{ label: 'cover fallback', timestamp: null, base64: fallback.thumbnailBase64, mimeType: fallback.thumbnailMimeType, url: thumbnailUrl }]; }
  const cover = frames[0] || null;
  const thumbnailBase64 = cover?.base64 || fallback.thumbnailBase64;
  const thumbnailMimeType = cover?.mimeType || fallback.thumbnailMimeType;

  const descriptionAndTranscript = transcript
    ? `Spoken/caption content:\n${transcript}`
    : '(No captions/transcript could be retrieved for this video — analysis is based on title and metadata only, which significantly limits fact-checking coverage.)';

  const text = `TITLE: ${title}\nCHANNEL: ${author || 'unknown'}\n\n${descriptionAndTranscript}`.slice(0, 20000);

  return {
    title,
    text,
    sourceUrl: url,
    contentCategory: 'video',
    platform: 'youtube',
    videoId,
    author,
    thumbnailUrl,
    thumbnailBase64,
    thumbnailMimeType,
    frames,
    frameCount: frames.length,
    duration,
    frameExtractionMode,
    hasTranscript: !!transcript,
  };
}

/** Handles any non-YouTube video link via oEmbed autodiscovery, then Open Graph fallback. */
async function extractFromGenericVideo(url) {
  let html = '';
  try {
    const resp = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (FactVerificationAgent/1.0)' },
    });
    html = resp.data;
  } catch (e) {
    throw new Error(`Could not fetch the video page (${e.message}). The link may be private, broken, or blocking automated requests.`);
  }

  const $ = cheerio.load(html);
  const hostname = safeHostname(url);

  let title = null;
  let author = null;
  let thumbnailImageUrl = null;

  // 1) oEmbed autodiscovery: <link type="application/json+oembed" href="...">
  const oembedHref = $('link[type="application/json+oembed"]').attr('href');
  if (oembedHref) {
    try {
      const oembedResp = await axios.get(oembedHref, { timeout: 10000 });
      const data = oembedResp.data || {};
      title = data.title || title;
      author = data.author_name || null;
      thumbnailImageUrl = data.thumbnail_url || null;
    } catch (e) {
      // oEmbed endpoint advertised but unreachable — fall through to OG tags.
    }
  }

  // 2) Open Graph / Twitter Card fallback — covers most sites for link previews.
  const meta = (name) =>
    $(`meta[property="${name}"]`).attr('content') || $(`meta[name="${name}"]`).attr('content') || null;

  title = title || meta('og:title') || $('title').first().text().trim() || 'Untitled video';
  author = author || meta('og:site_name') || null;
  thumbnailImageUrl = thumbnailImageUrl || meta('og:image') || meta('twitter:image') || null;
  const description = meta('og:description') || meta('twitter:description') || meta('description') || '';

  // Prefer real timeline extraction for generic video URLs too.
  let frames = [];
  let duration = null;
  let frameExtractionMode = 'none';
  try {
    const sampled = extractFramesFromUrl(url, { count: Number(process.env.VIDEO_FRAME_COUNT) || 8, maxWidth: 768 });
    frames = sampled.frames;
    duration = sampled.duration;
    frameExtractionMode = 'actual_timeline';
  } catch (e) {
    console.warn('[video] generic real frame extraction unavailable:', e.message);
  }
  const fallback = thumbnailImageUrl ? await fetchImageAsBase64(thumbnailImageUrl) : { thumbnailBase64: null, thumbnailMimeType: null };
  const thumbnailBase64 = frames[0]?.base64 || fallback.thumbnailBase64;
  const thumbnailMimeType = frames[0]?.mimeType || fallback.thumbnailMimeType;
  if (!frames.length && thumbnailBase64) { frameExtractionMode = 'thumbnail_fallback'; frames = [{ label: 'cover fallback', timestamp: null, base64: thumbnailBase64, mimeType: thumbnailMimeType, url: thumbnailImageUrl }]; }

  const text = `TITLE: ${title}\nSOURCE: ${hostname}${author ? ` (${author})` : ''}\n\n${
    description
      ? `Description:\n${description}`
      : '(No description/captions could be retrieved for this video — only the title and page metadata are available, which significantly limits fact-checking coverage. Public transcript scraping is currently only supported for YouTube.)'
  }`.slice(0, 20000);

  return {
    title,
    text,
    sourceUrl: url,
    contentCategory: 'video',
    platform: hostname,
    videoId: null,
    author,
    thumbnailUrl: thumbnailImageUrl,
    thumbnailBase64,
    thumbnailMimeType,
    frames,
    frameCount: frames.length,
    duration,
    frameExtractionMode,
    hasTranscript: false,
  };
}

async function fetchImageAsBase64(imageUrl) {
  if (!imageUrl) return { thumbnailBase64: null, thumbnailMimeType: null };
  try {
    const imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 10000 });
    return {
      thumbnailBase64: Buffer.from(imgResp.data).toString('base64'),
      thumbnailMimeType: imgResp.headers['content-type'] || 'image/jpeg',
    };
  } catch (e) {
    // No thumbnail available — visual analysis will be skipped downstream.
    return { thumbnailBase64: null, thumbnailMimeType: null };
  }
}

function safeHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function extractYouTubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1).split('/')[0] || null;
    if (u.hostname.includes('youtube.com')) {
      if (u.searchParams.get('v')) return u.searchParams.get('v');
      const shortsMatch = u.pathname.match(/\/shorts\/([^/?]+)/);
      if (shortsMatch) return shortsMatch[1];
      const embedMatch = u.pathname.match(/\/embed\/([^/?]+)/);
      if (embedMatch) return embedMatch[1];
    }
    return null;
  } catch {
    return null;
  }
}

// Scrapes the auto-generated/uploaded caption track from a YouTube watch page.
// This is a best-effort technique using only public endpoints (no API key) —
// it can and will fail for many videos (captions disabled, age-gated, etc.),
// which is expected and handled by the caller.
async function fetchYouTubeTranscript(videoId) {
  const { data: html } = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
    timeout: 12000,
    headers: { 'User-Agent': 'Mozilla/5.0 (FactVerificationAgent/1.0)', 'Accept-Language': 'en-US' },
  });

  const match = html.match(/"captionTracks":(\[.*?\])/);
  if (!match) return '';

  let tracks;
  try {
    tracks = JSON.parse(match[1]);
  } catch {
    return '';
  }
  if (!Array.isArray(tracks) || tracks.length === 0) return '';

  // Prefer an English track, fall back to the first available.
  const track = tracks.find((t) => (t.languageCode || '').startsWith('en')) || tracks[0];
  if (!track || !track.baseUrl) return '';

  const { data: xml } = await axios.get(track.baseUrl, { timeout: 12000 });
  const lines = [...xml.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) =>
    m[1]
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .trim()
  );
  return lines.join(' ').slice(0, 12000);
}

module.exports = { extractFromURL, extractFromFile, extractFromVideo };
