/**
 * ThrowSage Tagger — app controller.
 *
 * Uses <video> element for frame-accurate seeking (hardware-accelerated,
 * no per-frame HTTP requests). Continuous render loop draws video to canvas.
 *
 * Completely separate from viewer.js / index.html (the 3D mesh viewer).
 */

import * as tagger from './tagger.js';

// ─── State ───────────────────────────────────────────────────────────────────

let currentFrame = 0;
let totalFrames = 0;
let playing = false;
let playbackSpeed = 1.0;
let fps = 30;
let metadata = null;
let videoReady = false;

// ─── DOM refs ────────────────────────────────────────────────────────────────

const video = document.getElementById('video-source');
const canvas = document.getElementById('frame-canvas');
const ctx = canvas.getContext('2d');
const scrubber = document.getElementById('scrubber');
const frameInfo = document.getElementById('frame-info');
const throwName = document.getElementById('throw-name');
const tagSummary = document.getElementById('tag-summary');
const playBtn = document.getElementById('play-btn');
const stepBackBtn = document.getElementById('step-back-btn');
const stepFwdBtn = document.getElementById('step-fwd-btn');
const autoMarkersEl = document.getElementById('auto-markers');
const manualMarkersEl = document.getElementById('manual-markers');
const loadingEl = document.getElementById('loading');

// ─── Continuous render loop ──────────────────────────────────────────────────
// Draws from <video> to <canvas> every animation frame.
// Avoids all timing issues with seeked/timeupdate events.

function renderLoop() {
  requestAnimationFrame(renderLoop);
  if (!videoReady || video.readyState < 2) return;

  // Size canvas once
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }

  ctx.drawImage(video, 0, 0);

  // Draw overlays
  drawBallOverlay();
  drawCircleZeroOverlay();

  // During playback, sync frame counter from video time
  if (playing) {
    const f = Math.round(video.currentTime * fps);
    if (f !== currentFrame && f >= 0 && f < totalFrames) {
      currentFrame = f;
      scrubber.value = f;
      updateFrameInfo();
      updateButtonHighlights();
      tagSummary.textContent = tagger.summaryText();
    }
    // Loop
    if (video.ended || currentFrame >= totalFrames - 1) {
      video.currentTime = 0;
      currentFrame = 0;
    }
  }
}

// ─── Ball overlay ───────────────────────────────────────────────────────────

function drawBallOverlay() {
  const marker = tagger.getBallAt(currentFrame);
  if (!marker) return;

  const x = marker.x;
  const y = marker.y;
  const r = 8;

  // Crosshair
  ctx.strokeStyle = '#ffaa33';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x - r * 2, y);
  ctx.lineTo(x - r, y);
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + r * 2, y);
  ctx.moveTo(x, y - r * 2);
  ctx.lineTo(x, y - r);
  ctx.moveTo(x, y + r);
  ctx.lineTo(x, y + r * 2);
  ctx.stroke();

  // Circle
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.strokeStyle = '#ffaa33';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Center dot
  ctx.beginPath();
  ctx.arc(x, y, 2, 0, Math.PI * 2);
  ctx.fillStyle = '#ffaa33';
  ctx.fill();
}

// ─── Circle 0° overlay ──────────────────────────────────────────────────────

function drawCircleZeroOverlay() {
  if (!tagger.circleDegZero) return;

  const x = tagger.circleDegZero.x;
  const y = tagger.circleDegZero.y;

  // Diamond shape
  const s = 10;
  ctx.strokeStyle = '#dd66ff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.lineTo(x + s, y);
  ctx.lineTo(x, y + s);
  ctx.lineTo(x - s, y);
  ctx.closePath();
  ctx.stroke();

  // Label
  ctx.font = 'bold 12px sans-serif';
  ctx.fillStyle = '#dd66ff';
  ctx.textAlign = 'center';
  ctx.fillText('0°', x, y - s - 4);
}

// ─── Seeking ─────────────────────────────────────────────────────────────────

function seekToFrame(f) {
  if (f < 0) f = 0;
  if (f >= totalFrames) f = totalFrames - 1;
  currentFrame = f;
  video.currentTime = f / fps;
  scrubber.value = f;
  updateFrameInfo();
  updateButtonHighlights();
  tagSummary.textContent = tagger.summaryText();
}

function updateFrameInfo() {
  const timeS = fps > 0 ? (currentFrame / fps).toFixed(2) : '0.00';
  frameInfo.textContent = `Frame ${currentFrame} / ${totalFrames - 1}  (${timeS}s)`;
}

// ─── Toast ───────────────────────────────────────────────────────────────────

function toast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  container.appendChild(el);
  el.offsetHeight;
  el.classList.add('show');
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 2000);
}

// ─── Tag button wiring ──────────────────────────────────────────────────────

function wireTagButtons() {
  const actions = {
    'tag-t0-btn': () => tagger.setT0(currentFrame),
    'tag-release-btn': () => tagger.setRelease(currentFrame),
    'tag-turn-btn': () => tagger.addTurn(currentFrame),
    'tag-ss-btn': () => tagger.addSS(currentFrame),
    'tag-ds-btn': () => tagger.addDS(currentFrame),
    'tag-undo-btn': () => tagger.undo(),
    'tag-delete-btn': () => tagger.deleteAtFrame(currentFrame),
  };

  for (const [id, fn] of Object.entries(actions)) {
    document.getElementById(id).addEventListener('click', () => {
      const msg = fn();
      if (msg) {
        toast(msg, 'success');
      } else {
        toast('No change', 'warn');
      }
      refreshTagUI();
    });
  }

  // Ball mode toggle
  document.getElementById('tag-ball-btn').addEventListener('click', () => {
    const msg = tagger.toggleBallMode();
    toast(msg, tagger.ballMode ? 'success' : 'info');
    updateMarkingModeUI();
  });

  // 0° mode toggle
  document.getElementById('tag-deg0-btn').addEventListener('click', () => {
    const msg = tagger.toggleCircleZeroMode();
    toast(msg, tagger.circleZeroMode ? 'success' : 'info');
    updateMarkingModeUI();
  });

  // Canvas click for ball marking or 0° marking
  canvas.addEventListener('click', (e) => {
    if (!tagger.ballMode && !tagger.circleZeroMode) return;

    // Convert click position to video pixel coordinates
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    if (tagger.ballMode) {
      const msg = tagger.addBall(currentFrame, x, y);
      if (msg) toast(msg, 'success');
    } else if (tagger.circleZeroMode) {
      const msg = tagger.setCircleZeroPoint(x, y);
      if (msg) toast(msg, 'success');
      // Auto-exit 0° mode after placing (single point)
      tagger.toggleCircleZeroMode();
      updateMarkingModeUI();
    }
    refreshTagUI();
  });

  document.getElementById('tag-save-btn').addEventListener('click', async () => {
    const result = await tagger.save();
    if (result.ok) {
      toast('Saved baseline.npz', 'success');
    } else {
      toast(result.error, 'error');
    }
    updateSaveBtn();
  });
}

function refreshTagUI() {
  updateButtonHighlights();
  updateSaveBtn();
  tagSummary.textContent = tagger.summaryText();
  tagger.renderManualMarkers(manualMarkersEl, f => seekToFrame(f));
}

function updateButtonHighlights() {
  const tags = tagger.tagsAtFrame(currentFrame);
  setActive('tag-t0-btn', tags.isT0);
  setActive('tag-release-btn', tags.isRelease);
  setActive('tag-turn-btn', tags.isTurn);
  setActive('tag-ss-btn', tags.isSS);
  setActive('tag-ds-btn', tags.isDS);
  setActive('tag-ball-btn', tags.isBall);
}

function updateMarkingModeUI() {
  const ballBtn = document.getElementById('tag-ball-btn');
  const deg0Btn = document.getElementById('tag-deg0-btn');

  // Ball mode
  if (tagger.ballMode) {
    ballBtn.classList.add('ball-mode-on');
    ballBtn.textContent = 'Ball ON';
    canvas.classList.add('ball-mode');
  } else {
    ballBtn.classList.remove('ball-mode-on');
    ballBtn.textContent = 'Ball';
    canvas.classList.remove('ball-mode');
  }

  // 0° mode
  if (tagger.circleZeroMode) {
    deg0Btn.classList.add('deg0-mode-on');
    deg0Btn.textContent = '0° ON';
    canvas.classList.add('deg0-mode');
  } else {
    deg0Btn.classList.remove('deg0-mode-on');
    deg0Btn.textContent = '0°';
    canvas.classList.remove('deg0-mode');
  }
}

function updateSaveBtn() {
  const btn = document.getElementById('tag-save-btn');
  if (tagger.dirty) {
    btn.classList.add('dirty');
    btn.textContent = 'Save *';
  } else {
    btn.classList.remove('dirty');
    btn.textContent = 'Save';
  }
}

function setActive(id, active) {
  const el = document.getElementById(id);
  if (active) el.classList.add('tag-active');
  else el.classList.remove('tag-active');
}

// ─── Playback ────────────────────────────────────────────────────────────────

function togglePlay() {
  playing = !playing;
  playBtn.innerHTML = playing ? '&#9646;&#9646;' : '&#9654;';
  if (playing) {
    video.playbackRate = playbackSpeed;
    video.play();
  } else {
    video.pause();
    currentFrame = Math.round(video.currentTime * fps);
    scrubber.value = currentFrame;
    updateFrameInfo();
  }
}

// ─── Scrubber ────────────────────────────────────────────────────────────────

function initScrubber() {
  scrubber.max = totalFrames - 1;
  scrubber.value = 0;
  scrubber.addEventListener('input', () => {
    if (playing) { playing = false; video.pause(); playBtn.innerHTML = '&#9654;'; }
    seekToFrame(parseInt(scrubber.value, 10));
  });
}

// ─── Speed buttons ───────────────────────────────────────────────────────────

function initSpeedButtons() {
  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      playbackSpeed = parseFloat(btn.dataset.speed);
      if (playing) video.playbackRate = playbackSpeed;
    });
  });
}

// ─── Navigation buttons ─────────────────────────────────────────────────────

function initNavButtons() {
  playBtn.addEventListener('click', togglePlay);
  stepBackBtn.addEventListener('click', () => seekToFrame(currentFrame - 1));
  stepFwdBtn.addEventListener('click', () => seekToFrame(currentFrame + 1));

  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); seekToFrame(currentFrame - 1); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); seekToFrame(currentFrame + 1); }
    else if (e.code === 'Home') { e.preventDefault(); seekToFrame(0); }
    else if (e.code === 'End') { e.preventDefault(); seekToFrame(totalFrames - 1); }
  });
}

// ─── Auto-detected markers (from pipeline metadata.json) ────────────────────

function renderAutoMarkers() {
  if (!metadata || !autoMarkersEl) return;
  autoMarkersEl.innerHTML = '';

  const T = totalFrames;
  if (T <= 1) return;

  if (metadata.turn_boundaries) {
    metadata.turn_boundaries.forEach((frame, i) => {
      const pct = (frame / (T - 1)) * 100;
      const label = metadata.turn_labels ? metadata.turn_labels[i] : `T${i}`;
      const el = document.createElement('div');
      el.className = 'auto-marker';
      el.style.left = pct + '%';
      el.innerHTML = `<div class="auto-tick"></div><div class="auto-label">${label}</div>`;
      el.addEventListener('click', (e) => { e.stopPropagation(); seekToFrame(frame); });
      autoMarkersEl.appendChild(el);
    });
  }

  if (metadata.throw_window && metadata.throw_window.release > 0) {
    const frame = metadata.throw_window.release;
    const pct = (frame / (T - 1)) * 100;
    const el = document.createElement('div');
    el.className = 'auto-marker auto-release';
    el.style.left = pct + '%';
    el.innerHTML = `<div class="auto-tick"></div><div class="auto-label">REL</div>`;
    el.addEventListener('click', (e) => { e.stopPropagation(); seekToFrame(frame); });
    autoMarkersEl.appendChild(el);
  }
}

// ─── Load video info + metadata ──────────────────────────────────────────────

async function loadVideoInfo() {
  const resp = await fetch('/video-info');
  return await resp.json();
}

async function loadMetadata() {
  try {
    const resp = await fetch('metadata.json');
    if (resp.ok) metadata = await resp.json();
  } catch {}
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  let info;
  try {
    info = await loadVideoInfo();
  } catch (e) {
    loadingEl.innerHTML = `<div class="label" style="color:#ff6b6b;">Failed to load video info: ${e.message}</div>`;
    return;
  }

  fps = info.fps;
  totalFrames = info.total_frames;
  throwName.textContent = info.basename || '—';

  await loadMetadata();
  tagger.init(totalFrames, info.basename || '');

  // Load video
  video.src = '/video.mp4';
  await new Promise((resolve, reject) => {
    video.addEventListener('canplaythrough', resolve, { once: true });
    video.addEventListener('error', () => reject(new Error('Video load failed')), { once: true });
  });

  videoReady = true;
  video.pause();
  video.currentTime = 0;

  // Start continuous render loop
  requestAnimationFrame(renderLoop);

  // Init UI
  initScrubber();
  initSpeedButtons();
  initNavButtons();
  wireTagButtons();
  renderAutoMarkers();

  const loaded = await tagger.load();
  if (loaded) toast('Loaded existing baseline', 'info');

  updateFrameInfo();
  refreshTagUI();
  loadingEl.classList.add('hidden');
}

main();
