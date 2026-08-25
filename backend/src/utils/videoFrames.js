const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function commandExists(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}

function runYtDlp(args) {
  const candidates = process.platform === 'win32' ? ['yt-dlp.exe','yt-dlp'] : ['yt-dlp'];
  for (const cmd of candidates) {
    if (!commandExists(cmd)) continue;
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
    if (r.status === 0) return r;
  }
  // Windows-friendly Python fallback.
  const pyCandidates = process.platform === 'win32' ? [['py',['-m','yt_dlp']],['python',['-m','yt_dlp']]] : [['python3',['-m','yt_dlp']],['python',['-m','yt_dlp']]];
  for (const [cmd,prefix] of pyCandidates) {
    const r = spawnSync(cmd, [...prefix, ...args], { encoding: 'utf8', timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
    if (r.status === 0) return r;
  }
  throw new Error('yt-dlp is not installed. Install it with: python -m pip install -U yt-dlp');
}

function runFfmpeg(args) {
  if (!commandExists('ffmpeg')) throw new Error('ffmpeg is not installed. Install FFmpeg and make sure ffmpeg is on PATH.');
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8', timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
  if (r.status !== 0) throw new Error((r.stderr || 'ffmpeg failed').split('\n').slice(-3).join(' '));
  return r;
}

function runFfprobe(args) {
  if (!commandExists('ffprobe')) return null;
  const r = spawnSync('ffprobe', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  if (r.status !== 0) return null;
  const n = Number(r.stdout.trim());
  return Number.isFinite(n) ? n : null;
}

function durationSeconds(file) {
  return runFfprobe(['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',file]);
}

function sampleTimes(duration, count = 8) {
  if (!duration || duration <= 0) return [0];
  const margin = Math.min(0.75, duration * 0.03);
  const start = Math.min(margin, duration / 4);
  const end = Math.max(start, duration - margin);
  if (count <= 1) return [Math.max(0, duration / 2)];
  return Array.from({length: count}, (_, i) => start + (end - start) * i / (count - 1));
}

function extractFramesFromFile(videoPath, { count = 8, maxWidth = 768 } = {}) {
  const duration = durationSeconds(videoPath);
  const times = sampleTimes(duration, count);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deeptrust-frames-'));
  try {
    const frames = [];
    times.forEach((t, i) => {
      const out = path.join(dir, `frame-${String(i).padStart(2,'0')}.jpg`);
      try {
        runFfmpeg(['-hide_banner','-loglevel','error','-i',videoPath,'-ss',String(t),'-frames:v','1','-vf',`scale=${maxWidth}:-2:force_original_aspect_ratio=decrease`,'-q:v','3','-y',out]);
      } catch (firstError) {
        // Near the final frame some codecs expose no decodable packet at the
        // exact requested timestamp. Retry slightly earlier instead of losing
        // the whole forensic run.
        const retry = Math.max(0, t - 0.35);
        runFfmpeg(['-hide_banner','-loglevel','error','-i',videoPath,'-ss',String(retry),'-frames:v','1','-vf',`scale=${maxWidth}:-2:force_original_aspect_ratio=decrease`,'-q:v','3','-y',out]);
      }
      if (fs.existsSync(out)) {
        const bytes = fs.readFileSync(out);
        frames.push({
          index: i,
          timestamp: Number(t.toFixed(2)),
          label: `${formatTime(t)} · frame ${i + 1}`,
          base64: bytes.toString('base64'),
          mimeType: 'image/jpeg',
        });
      }
    });
    return { frames, duration: duration || null };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function downloadVideo(url) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deeptrust-video-'));
  const output = path.join(dir, `${crypto.randomBytes(8).toString('hex')}.mp4`);
  try {
    runYtDlp(['--no-playlist','--no-warnings','--quiet','-f','bv*[height<=720]+ba/b[height<=720]/b','--merge-output-format','mp4','-o',output,url]);
    if (!fs.existsSync(output)) throw new Error('yt-dlp did not produce a video file.');
    return { file: output, dir };
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

function extractFramesFromUrl(url, opts = {}) {
  const downloaded = downloadVideo(url);
  try {
    return extractFramesFromFile(downloaded.file, opts);
  } finally {
    fs.rmSync(downloaded.dir, { recursive: true, force: true });
  }
}

function formatTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}` : `${m}:${String(r).padStart(2,'0')}`;
}

module.exports = { extractFramesFromFile, extractFramesFromUrl, durationSeconds, formatTime };
