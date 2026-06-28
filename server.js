const express = require('express');
const cors = require('cors');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── yt-dlp Cookie Authentication (for restricted videos) ────────
// Set COOKIES_FILE=/path/to/cookies.txt  OR  COOKIES_BROWSER=chrome|firefox|edge
// in your environment to authenticate with your YouTube account.
const COOKIES_FILE    = process.env.COOKIES_FILE    || '';
const COOKIES_BROWSER = process.env.COOKIES_BROWSER || '';

/**
 * Returns cookie args if configured, empty array otherwise.
 * We do NOT override player_client here — yt-dlp's default
 * (android_vr) already works best for most videos.
 */
function cookieArgs() {
  if (COOKIES_FILE && fs.existsSync(COOKIES_FILE)) {
    console.log('[AUTH] Using cookies file:', COOKIES_FILE);
    return ['--cookies', COOKIES_FILE];
  }
  if (COOKIES_BROWSER) {
    console.log('[AUTH] Using browser cookies from:', COOKIES_BROWSER);
    return ['--cookies-from-browser', COOKIES_BROWSER];
  }
  return [];
}

/** True if stderr indicates YouTube bot/sign-in detection */
function isBotError(stderr) {
  return stderr.includes('Sign in') ||
         stderr.includes('bot') ||
         stderr.includes('not available') ||
         stderr.includes('Requested format');
}

/** Run yt-dlp and return { stdout, stderr, code } */
function runYtDlp(args) {
  return new Promise((resolve) => {
    const proc = spawn('yt-dlp', args);
    let stdout = '', stderr = '';
    proc.stdout.on('data', c => { stdout += c.toString(); });
    proc.stderr.on('data', c => { stderr += c.toString(); });
    proc.on('close', code => resolve({ stdout, stderr, code }));
    proc.on('error', err => resolve({ stdout: '', stderr: err.message, code: 1 }));
  });
}

// ─── Ensure temp directory exists ───────────────────────────────
const TEMP_DIR = path.join(__dirname, '.downloads');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ─── Clean old temp files on startup ────────────────────────────
function cleanTempDir() {
  try {
    const files = fs.readdirSync(TEMP_DIR);
    const now = Date.now();
    for (const file of files) {
      const fp = path.join(TEMP_DIR, file);
      try {
        const stat = fs.statSync(fp);
        // Remove files older than 10 minutes
        if (now - stat.mtimeMs > 10 * 60 * 1000) {
          fs.unlinkSync(fp);
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}
cleanTempDir();
setInterval(cleanTempDir, 5 * 60 * 1000); // Clean every 5 minutes

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Validate YouTube URL ───────────────────────────────────────
function isValidYouTubeUrl(url) {
  const patterns = [
    /^(https?:\/\/)?(www\.)?youtube\.com\/watch\?v=[\w-]{11}/,
    /^(https?:\/\/)?(www\.)?youtube\.com\/shorts\/[\w-]{11}/,
    /^(https?:\/\/)?youtu\.be\/[\w-]{11}/,
    /^(https?:\/\/)?(www\.)?youtube\.com\/embed\/[\w-]{11}/,
  ];
  return patterns.some(p => p.test(url));
}

// ─── Track active downloads ─────────────────────────────────────
const activeDownloads = new Map();

// ─── GET /api/info — Fetch video metadata ───────────────────────
app.get('/api/info', async (req, res) => {
  const { url } = req.query;

  if (!url || !isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  console.log(`[INFO] Fetching info for: ${url}`);

  const baseArgs = ['--dump-json', '--no-warnings', '--no-playlist'];

  // Attempt 1: default (yt-dlp picks best client automatically)
  let result = await runYtDlp([...baseArgs, ...cookieArgs(), url]);

  // Attempt 2: if bot/sign-in error and no cookies set, try mweb client
  if (result.code !== 0 && isBotError(result.stderr)) {
    console.warn('[INFO] Bot detection hit, retrying with mweb client...');
    result = await runYtDlp([
      ...baseArgs,
      '--extractor-args', 'youtube:player_client=mweb,web',
      ...cookieArgs(),
      url,
    ]);
  }

  if (result.code !== 0) {
    console.error('[INFO] yt-dlp error:', result.stderr);
    let errMsg = result.stderr || 'Unknown error';
    if (errMsg.includes('Sign in') || errMsg.includes('bot')) {
      errMsg = 'This video requires YouTube sign-in. Set the environment variable COOKIES_BROWSER=chrome (or firefox/edge) to authenticate.';
    } else if (errMsg.includes('not available') || errMsg.includes('Requested format')) {
      errMsg = 'This video is age-restricted or unavailable in your region. Set COOKIES_BROWSER=chrome in your environment.';
    } else if (errMsg.includes('Private video')) {
      errMsg = 'This video is private.';
    } else if (errMsg.includes('Video unavailable')) {
      errMsg = 'This video is unavailable.';
    }
    return res.status(500).json({ error: 'Failed to fetch video info. ' + errMsg });
  }

  try {
    const info = JSON.parse(result.stdout);

    // Find max available height
    let maxHeight = 0;
    if (info.formats) {
      for (const f of info.formats) {
        if (f.height && f.height > maxHeight) maxHeight = f.height;
      }
    }

    // Standard quality presets — only show what's available
    const allPresets = [
      { label: 'Best Quality', height: 99999, format: 'bestvideo+bestaudio/best' },
      { label: '4K (2160p)', height: 2160, format: 'bestvideo[height<=2160]+bestaudio/best[height<=2160]' },
      { label: '1440p (2K)', height: 1440, format: 'bestvideo[height<=1440]+bestaudio/best[height<=1440]' },
      { label: '1080p (Full HD)', height: 1080, format: 'bestvideo[height<=1080]+bestaudio/best[height<=1080]' },
      { label: '720p (HD)', height: 720, format: 'bestvideo[height<=720]+bestaudio/best[height<=720]' },
      { label: '480p', height: 480, format: 'bestvideo[height<=480]+bestaudio/best[height<=480]' },
      { label: '360p', height: 360, format: 'bestvideo[height<=360]+bestaudio/best[height<=360]' },
    ];

    const qualities = allPresets.filter(p => p.height > maxHeight ? p.label === 'Best Quality' : p.height <= maxHeight);

    const videoInfo = {
      id: info.id,
      title: info.title || info.fulltitle || 'Unknown',
      thumbnail: info.thumbnail || info.thumbnails?.[info.thumbnails.length - 1]?.url || '',
      duration: info.duration || 0,
      duration_string: info.duration_string || formatDuration(info.duration || 0),
      uploader: info.uploader || info.channel || 'Unknown',
      view_count: info.view_count || 0,
      qualities,
    };

    console.log(`[INFO] Success: "${videoInfo.title}" (${qualities.length} quality options)`);
    res.json(videoInfo);
  } catch (e) {
    console.error('[INFO] JSON parse error:', e.message);
    res.status(500).json({ error: 'Failed to parse video info' });
  }
});

// ─── POST /api/prepare — Start download to temp file ────────────
app.post('/api/prepare', express.json(), (req, res) => {
  const { url, format, type } = req.body;

  if (!url || !isValidYouTubeUrl(url)) {
    return res.status(400).json({ error: 'Invalid YouTube URL' });
  }

  const isAudio = type === 'mp3';
  const downloadId = crypto.randomBytes(8).toString('hex');
  const ext = isAudio ? 'mp3' : 'mp4';
  const tmpFilename = `${downloadId}.${ext}`;
  const tmpPath = path.join(TEMP_DIR, tmpFilename);

  console.log(`[DOWNLOAD] Starting ${isAudio ? 'MP3' : 'Video'} download: ${downloadId}`);

  // Build yt-dlp args
  let args;
  if (isAudio) {
    args = [
      '-f', 'bestaudio/best',
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '0',
      '--no-warnings',
      '--no-playlist',
      '--newline',
      ...cookieArgs(),
      '-o', tmpPath.replace('.mp3', '.%(ext)s'),
      url,
    ];
  } else {
    const formatArg = format || 'bestvideo+bestaudio/best';
    args = [
      '-f', formatArg,
      '--merge-output-format', 'mp4',
      '--no-warnings',
      '--no-playlist',
      '--newline',
      ...cookieArgs(),
      '-o', tmpPath,
      url,
    ];
  }

  const ytdlp = spawn('yt-dlp', args);

  // Track download state
  const downloadState = {
    id: downloadId,
    status: 'downloading',
    progress: 0,
    speed: '',
    eta: '',
    filename: '',
    tmpPath: '',
    error: null,
  };
  activeDownloads.set(downloadId, downloadState);

  // Parse progress from yt-dlp output
  ytdlp.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    // Parse progress lines like: [download] 45.2% of 12.34MiB at 5.67MiB/s ETA 00:02
    const progressMatch = text.match(/(\d+\.?\d*)%/);
    const speedMatch = text.match(/at\s+(\S+)/);
    const etaMatch = text.match(/ETA\s+(\S+)/);

    if (progressMatch) downloadState.progress = parseFloat(progressMatch[1]);
    if (speedMatch) downloadState.speed = speedMatch[1];
    if (etaMatch) downloadState.eta = etaMatch[1];
  });

  ytdlp.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    const progressMatch = text.match(/(\d+\.?\d*)%/);
    const speedMatch = text.match(/at\s+(\S+)/);
    const etaMatch = text.match(/ETA\s+(\S+)/);

    if (progressMatch) downloadState.progress = parseFloat(progressMatch[1]);
    if (speedMatch) downloadState.speed = speedMatch[1];
    if (etaMatch) downloadState.eta = etaMatch[1];
  });

  ytdlp.on('close', (code) => {
    if (code !== 0) {
      console.error(`[DOWNLOAD] Failed: ${downloadId}`);
      downloadState.status = 'error';
      downloadState.error = 'Download failed';
      return;
    }

    // For audio, yt-dlp may change the extension during conversion
    // Find the actual output file
    let actualPath = tmpPath;
    if (isAudio) {
      // yt-dlp with --extract-audio may create file with original ext first, then convert
      // The final file should be .mp3
      const mp3Path = tmpPath.replace(/\.[^.]+$/, '.mp3');
      const possiblePaths = [mp3Path, tmpPath];
      
      // Also check for files with the downloadId prefix
      try {
        const files = fs.readdirSync(TEMP_DIR);
        for (const f of files) {
          if (f.startsWith(downloadId)) {
            possiblePaths.push(path.join(TEMP_DIR, f));
          }
        }
      } catch { /* ignore */ }

      for (const p of possiblePaths) {
        if (fs.existsSync(p) && fs.statSync(p).size > 0) {
          actualPath = p;
          break;
        }
      }
    }

    if (!fs.existsSync(actualPath) || fs.statSync(actualPath).size === 0) {
      console.error(`[DOWNLOAD] File not found or empty: ${actualPath}`);
      downloadState.status = 'error';
      downloadState.error = 'Downloaded file is empty or missing';
      return;
    }

    downloadState.status = 'ready';
    downloadState.progress = 100;
    downloadState.tmpPath = actualPath;
    console.log(`[DOWNLOAD] Ready: ${downloadId} (${(fs.statSync(actualPath).size / 1024 / 1024).toFixed(1)} MB)`);
  });

  ytdlp.on('error', (err) => {
    console.error(`[DOWNLOAD] Spawn error: ${err.message}`);
    downloadState.status = 'error';
    downloadState.error = 'yt-dlp not found';
  });

  // Return the download ID immediately so client can poll progress
  res.json({ downloadId, message: 'Download started' });
});

// ─── GET /api/progress/:id — Check download progress ────────────
app.get('/api/progress/:id', (req, res) => {
  const state = activeDownloads.get(req.params.id);
  if (!state) {
    return res.status(404).json({ error: 'Download not found' });
  }
  res.json({
    status: state.status,
    progress: state.progress,
    speed: state.speed,
    eta: state.eta,
    error: state.error,
  });
});

// ─── GET /api/download/:id — Serve the completed file ───────────
app.get('/api/download/:id', (req, res) => {
  const state = activeDownloads.get(req.params.id);
  if (!state) {
    return res.status(404).json({ error: 'Download not found' });
  }

  if (state.status !== 'ready') {
    return res.status(400).json({ error: 'Download not ready yet' });
  }

  const filePath = state.tmpPath;
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  // Get a clean filename from the URL or use default
  const ext = path.extname(filePath) || '.mp4';
  const safeTitle = (req.query.title || 'download')
    .replace(/[<>:"/\\|?*]/g, '_')
    .substring(0, 100);

  const stat = fs.statSync(filePath);

  res.setHeader('Content-Length', stat.size);
  res.setHeader('Content-Type', ext === '.mp3' ? 'audio/mpeg' : 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}${ext}"`);

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);

  stream.on('error', (err) => {
    console.error('[DOWNLOAD] Stream error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'Stream error' });
  });

  // Clean up after download completes
  res.on('finish', () => {
    console.log(`[DOWNLOAD] Served: ${req.params.id}`);
    // Delete temp file after a short delay
    setTimeout(() => {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        activeDownloads.delete(req.params.id);
      } catch { /* ignore */ }
    }, 5000);
  });

  res.on('close', () => {
    // Client disconnected early — still clean up later
    setTimeout(() => {
      try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        activeDownloads.delete(req.params.id);
      } catch { /* ignore */ }
    }, 60000);
  });
});

// ─── Helper: format duration ────────────────────────────────────
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ─── Global error handlers — prevent EPIPE crashes ──────────────
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ECONNRESET' || err.code === 'ERR_STREAM_PREMATURE_CLOSE') {
    console.warn('[WARN] Stream error (ignored):', err.code);
    return;
  }
  console.error('[FATAL] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});

// ─── Start server ───────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ⚡ TubeGrab is running at http://localhost:${PORT}\n`);
});
