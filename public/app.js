/* TubeGrab — Frontend */

(function () {
  'use strict';

  const urlInput = document.getElementById('url-input');
  const fetchBtn = document.getElementById('fetch-btn');
  const btnLabel = fetchBtn.querySelector('.btn-label');
  const btnSpinner = fetchBtn.querySelector('.btn-spinner');

  const videoSection = document.getElementById('video-section');
  const videoThumbnail = document.getElementById('video-thumbnail');
  const videoDuration = document.getElementById('video-duration');
  const videoTitle = document.getElementById('video-title');
  const videoUploader = document.getElementById('video-uploader');
  const videoViews = document.getElementById('video-views');
  const qualitySelect = document.getElementById('quality-select');

  const downloadVideoBtn = document.getElementById('download-video-btn');
  const downloadMp3Btn = document.getElementById('download-mp3-btn');
  const toastContainer = document.getElementById('toast-container');

  let currentVideo = null;

  // Events
  fetchBtn.addEventListener('click', handleFetch);
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleFetch(); });
  urlInput.addEventListener('paste', () => {
    setTimeout(() => { if (isYT(urlInput.value.trim())) handleFetch(); }, 150);
  });
  downloadVideoBtn.addEventListener('click', () => download('video'));
  downloadMp3Btn.addEventListener('click', () => download('mp3'));

  // Fetch info
  async function handleFetch() {
    const url = urlInput.value.trim();
    if (!url) return toast('Paste a YouTube URL first', 'error');
    if (!isYT(url)) return toast('Not a valid YouTube URL', 'error');

    setLoading(true);
    videoSection.hidden = true;

    try {
      const res = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');

      currentVideo = data;
      videoThumbnail.src = data.thumbnail;
      videoDuration.textContent = data.duration_string;
      videoTitle.textContent = data.title;
      videoUploader.textContent = data.uploader;
      videoViews.textContent = views(data.view_count);

      qualitySelect.innerHTML = '';
      data.qualities.forEach((q, i) => {
        const o = document.createElement('option');
        o.value = q.format;
        o.textContent = q.label;
        if (i === 0) o.selected = true;
        qualitySelect.appendChild(o);
      });

      videoSection.hidden = false;
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  }

  // Download
  async function download(type) {
    if (!currentVideo) return toast('Fetch a video first', 'error');

    const url = urlInput.value.trim();
    const isAudio = type === 'mp3';
    const btn = isAudio ? downloadMp3Btn : downloadVideoBtn;
    const otherBtn = isAudio ? downloadVideoBtn : downloadMp3Btn;
    const origText = btn.textContent;

    btn.disabled = true;
    otherBtn.disabled = true;
    btn.classList.add('btn-downloading');
    btn.textContent = 'Preparing...';

    try {
      const prepRes = await fetch('/api/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          format: isAudio ? undefined : qualitySelect.value,
          type: isAudio ? 'mp3' : 'video',
        }),
      });
      const prep = await prepRes.json();
      if (!prepRes.ok) throw new Error(prep.error || 'Failed');

      toast(`${isAudio ? 'MP3' : 'Video'} preparing...`, 'info');

      // Poll progress
      const ok = await poll(prep.downloadId, (pct, speed) => {
        const s = speed ? ` · ${speed}` : '';
        btn.textContent = `${Math.round(pct)}%${s}`;
      });

      if (!ok) throw new Error('Download failed');

      btn.textContent = 'Saving...';
      const title = encodeURIComponent(currentVideo.title || 'download');
      const a = document.createElement('a');
      a.href = `/api/download/${prep.downloadId}?title=${title}`;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();

      toast('Download started!', 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.textContent = origText;
      btn.classList.remove('btn-downloading');
      btn.disabled = false;
      otherBtn.disabled = false;
    }
  }

  function poll(id, onProgress) {
    return new Promise((resolve) => {
      const iv = setInterval(async () => {
        try {
          const r = await fetch(`/api/progress/${id}`);
          const d = await r.json();
          if (d.status === 'ready') { clearInterval(iv); resolve(true); }
          else if (d.status === 'error') { clearInterval(iv); resolve(false); }
          else onProgress(d.progress || 0, d.speed || '');
        } catch { /* keep polling */ }
      }, 500);
      setTimeout(() => { clearInterval(iv); resolve(false); }, 600000);
    });
  }

  function setLoading(on) {
    fetchBtn.disabled = on;
    urlInput.disabled = on;
    btnLabel.hidden = on;
    btnSpinner.hidden = !on;
  }

  function toast(msg, type) {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    toastContainer.appendChild(el);
    setTimeout(() => {
      el.classList.add('toast-exit');
      el.addEventListener('animationend', () => el.remove());
    }, 3500);
  }

  function isYT(u) {
    return [
      /^(https?:\/\/)?(www\.)?youtube\.com\/watch\?v=[\w-]{11}/,
      /^(https?:\/\/)?(www\.)?youtube\.com\/shorts\/[\w-]{11}/,
      /^(https?:\/\/)?youtu\.be\/[\w-]{11}/,
      /^(https?:\/\/)?(www\.)?youtube\.com\/embed\/[\w-]{11}/,
    ].some(p => p.test(u));
  }

  function views(n) {
    if (!n) return '0 views';
    if (n >= 1e9) return (n/1e9).toFixed(1) + 'B views';
    if (n >= 1e6) return (n/1e6).toFixed(1) + 'M views';
    if (n >= 1e3) return (n/1e3).toFixed(1) + 'K views';
    return n + ' views';
  }
})();
