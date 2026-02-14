/**
 * ThrowSage Annotate — app controller.
 *
 * Three modes: Circle | Tags | Ball, sharing a single video canvas.
 * Reuses tagger.js for state management.
 * Cherry-picks video engine patterns from tagger-app.js.
 */

import * as tagger from './tagger.js';

// ─── State ───────────────────────────────────────────────────────────────────

let currentFrame = 0;
let totalFrames = 0;
let playing = false;
let playbackSpeed = 1.0;
let fps = 30;
let metadata = null;
let postPipeline = false;
let videoReady = false;
let activeMode = 'circle';  // 'circle' | 'tags' | 'ball'

// Circle mode state
let placingCircle = false;       // awaiting tap to create ellipse
let definingCircle = false;      // awaiting clicks to define circle edge points
let definePoints = [];           // [{x, y}, ...] max 5 points for ellipse fit
let circleAccepted = false;      // ellipse locked (no handles)
let dragging = null;             // {type: 'move'|'handle'|'rotate'|'degLabel', ...}
let handleIndex = -1;            // which handle is being dragged (0-7)

// Ball mode state
let markingBall = false;

// Pinch-to-zoom state
let zoomScale = 1.0;
let zoomTx = 0;
let zoomTy = 0;
let pinchStart = null;  // {dist, scale, tx, ty}

// Auto markers visibility
let showAutoMarkers = true;
let showTrackedBalls = false;

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

// ─── Render Loop ─────────────────────────────────────────────────────────────

function renderLoop() {
  requestAnimationFrame(renderLoop);
  if (!videoReady || video.readyState < 2) return;

  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }

  ctx.drawImage(video, 0, 0);

  // Draw overlays based on mode
  drawEllipseOverlay();
  drawDefinePoints();
  drawBallOverlay();

  if (playing) {
    const range = getTimelineRange();
    const f = Math.round(video.currentTime * fps);
    if (f !== currentFrame && f >= range.min && f <= range.max) {
      currentFrame = f;
      scrubber.value = f;
      updateFrameInfo();
      updateButtonHighlights();
      tagSummary.textContent = tagger.summaryText();
    }
    if (video.ended || currentFrame >= range.max) {
      seekToFrame(range.min);
      playing = false;
      video.pause();
      playBtn.innerHTML = '&#9654;';
    }
  }
}

// ─── Ellipse Drawing ─────────────────────────────────────────────────────────

function drawEllipseOverlay() {
  const e = tagger.circleEllipse;
  if (!e) return;

  ctx.save();
  ctx.translate(e.cx, e.cy);
  ctx.rotate(e.rotation);

  // Fill
  ctx.beginPath();
  ctx.ellipse(0, 0, e.major, e.minor, 0, 0, Math.PI * 2);
  if (circleAccepted) {
    ctx.strokeStyle = 'rgba(220, 50, 50, 0.7)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(220, 50, 50, 0.12)';
  } else {
    ctx.strokeStyle = 'rgba(220, 50, 50, 0.85)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = 'rgba(220, 50, 50, 0.2)';
  }
  ctx.fill();

  // Draw handles if not accepted and in circle mode
  if (!circleAccepted && activeMode === 'circle') {
    drawEllipseHandles(e);
  }

  ctx.restore();

  // Draw degree labels if accepted
  if (circleAccepted) {
    drawDegreeLabels(e);
  }
}

function drawEllipseHandles(e) {
  // 8 handles: 0=right, 1=top-right, 2=top, 3=top-left, 4=left, 5=bottom-left, 6=bottom, 7=bottom-right
  const angles = [0, Math.PI / 4, Math.PI / 2, 3 * Math.PI / 4, Math.PI, 5 * Math.PI / 4, 3 * Math.PI / 2, 7 * Math.PI / 4];
  const handleSize = 6;

  for (let i = 0; i < 8; i++) {
    const a = angles[i];
    const hx = e.major * Math.cos(a);
    const hy = e.minor * Math.sin(a);

    ctx.fillStyle = '#4a9eff';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.fillRect(hx - handleSize, hy - handleSize, handleSize * 2, handleSize * 2);
    ctx.strokeRect(hx - handleSize, hy - handleSize, handleSize * 2, handleSize * 2);
  }

  // Rotation handle: line + circle above top
  const rotHandleDist = e.minor + 25;
  ctx.strokeStyle = 'rgba(74, 158, 255, 0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, -e.minor);
  ctx.lineTo(0, -rotHandleDist);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(0, -rotHandleDist, 7, 0, Math.PI * 2);
  ctx.fillStyle = '#4a9eff';
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.stroke();
}

function drawDegreeLabels(e) {
  const baseAngle = tagger.circleZeroDegAngle || 0;
  const labels = ['0\u00B0', '90\u00B0', '180\u00B0', '270\u00B0'];
  const offsets = [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2];
  const colors = ['#ff44ff', '#aaa', '#aaa', '#aaa'];

  // Pulsating alpha for 0° label — only pulse when draggable (dirty = unsaved)
  const zeroPulse = tagger.dirty;
  const pulseAlpha = zeroPulse ? 0.6 + 0.4 * Math.sin(Date.now() / 240) : 1.0;

  for (let i = 0; i < 4; i++) {
    const theta = baseAngle + offsets[i];
    const px = e.cx + e.major * Math.cos(theta) * Math.cos(e.rotation) - e.minor * Math.sin(theta) * Math.sin(e.rotation);
    const py = e.cy + e.major * Math.cos(theta) * Math.sin(e.rotation) + e.minor * Math.sin(theta) * Math.cos(e.rotation);

    // Background pill
    const text = labels[i];
    ctx.font = 'bold 24px sans-serif';
    const tw = ctx.measureText(text).width;
    const pw = tw + 16;
    const ph = 34;

    const isZero = i === 0;
    const bgAlpha = isZero && zeroPulse ? 0.6 + 0.25 * Math.sin(Date.now() / 240) : 0.7;
    ctx.fillStyle = isZero ? `rgba(80, 0, 80, ${bgAlpha})` : 'rgba(0, 0, 0, 0.7)';
    ctx.beginPath();
    ctx.roundRect(px - pw / 2, py - ph / 2, pw, ph, 6);
    ctx.fill();

    if (isZero) {
      // Pulsating glow border for 0°
      ctx.strokeStyle = `rgba(255, 68, 255, ${pulseAlpha})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.fillStyle = isZero ? `rgba(255, 68, 255, ${pulseAlpha})` : colors[i];
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, px, py);
  }
}

// ─── Define Circle (click-to-fit) ───────────────────────────────────────────

function drawDefinePoints() {
  if (!definingCircle && definePoints.length === 0) return;

  // Draw collected points
  for (const pt of definePoints) {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 8, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 221, 255, 0.8)';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Draw fitted ellipse preview only at 5 points (not shown — auto-commits)
  if (false && definePoints.length >= 5) {
    const fit = fitEllipse(definePoints);
    if (fit) {
      ctx.save();
      ctx.translate(fit.cx, fit.cy);
      ctx.rotate(fit.rotation);
      ctx.beginPath();
      ctx.ellipse(0, 0, fit.major, fit.minor, 0, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0, 221, 255, 0.7)';
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
    }
  }
}

function fitEllipse(points) {
  // Algebraic ellipse fit using least squares on Ax² + Bxy + Cy² + Dx + Ey + F = 0
  // with constraint B² - 4AC < 0 (ensures ellipse, not hyperbola)
  // Simplified: fit general conic then extract params
  const n = points.length;
  if (n < 3) return null;

  // For 3-4 points, use circle fit (cx, cy, r) then return as ellipse
  if (n <= 4) {
    return fitCircleAsEllipse(points);
  }

  // 5 points: full ellipse fit via SVD-free least squares
  // Build design matrix D = [x², xy, y², x, y, 1]
  // Solve for null space of D (SVD approximation via normal equations)
  return fitEllipseFull(points);
}

function fitCircleAsEllipse(points) {
  // Least-squares circle fit: minimize Σ(sqrt((x-cx)²+(y-cy)²) - r)²
  // Linearized: x² + y² = 2cx·x + 2cy·y + (r² - cx² - cy²)
  const n = points.length;
  let Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Sxxx = 0, Syyy = 0, Sxxy = 0, Sxyy = 0;
  for (const p of points) {
    Sx += p.x; Sy += p.y;
    Sxx += p.x * p.x; Syy += p.y * p.y; Sxy += p.x * p.y;
    Sxxx += p.x * p.x * p.x; Syyy += p.y * p.y * p.y;
    Sxxy += p.x * p.x * p.y; Sxyy += p.x * p.y * p.y;
  }

  const A = n * Sxx - Sx * Sx;
  const B = n * Sxy - Sx * Sy;
  const C = n * Syy - Sy * Sy;
  const D = 0.5 * (n * (Sxxx + Sxyy) - Sx * (Sxx + Syy));
  const E = 0.5 * (n * (Sxxy + Syyy) - Sy * (Sxx + Syy));

  const det = A * C - B * B;
  if (Math.abs(det) < 1e-10) return null;

  const cx = (D * C - B * E) / det;
  const cy = (A * E - B * D) / det;
  const r = Math.sqrt((Sxx + Syy - 2 * cx * Sx - 2 * cy * Sy) / n + cx * cx + cy * cy);

  if (r < 10 || r > canvas.width) return null;
  return { cx, cy, major: r, minor: r, rotation: 0 };
}

function fitEllipseFull(points) {
  // General conic fit: Ax² + Bxy + Cy² + Dx + Ey + F = 0, set F = 1
  // => Ax² + Bxy + Cy² + Dx + Ey = -1
  const n = points.length;

  // Build n×5 system and solve via least squares (Gaussian elimination on normal equations)
  // For exactly 5 points, this is a direct 5×5 solve
  const M = [];
  const rhs = [];
  for (let i = 0; i < n; i++) {
    const xi = points[i].x, yi = points[i].y;
    M.push([xi * xi, xi * yi, yi * yi, xi, yi]);
    rhs.push(-1);
  }

  // If more than 5 points, form normal equations M'M x = M'b
  let sys;
  if (n === 5) {
    sys = M.map((row, i) => [...row, rhs[i]]);
  } else {
    // M'M (5x5) and M'b (5x1)
    sys = Array.from({ length: 5 }, (_, i) => {
      const row = new Array(6);
      for (let j = 0; j < 5; j++) {
        let s = 0;
        for (let k = 0; k < n; k++) s += M[k][i] * M[k][j];
        row[j] = s;
      }
      let s = 0;
      for (let k = 0; k < n; k++) s += M[k][i] * rhs[k];
      row[5] = s;
      return row;
    });
  }

  // Gaussian elimination with partial pivoting
  const rows = sys.length;
  for (let col = 0; col < 5; col++) {
    let maxVal = Math.abs(sys[col][col]);
    let maxRow = col;
    for (let row = col + 1; row < rows; row++) {
      if (Math.abs(sys[row][col]) > maxVal) {
        maxVal = Math.abs(sys[row][col]);
        maxRow = row;
      }
    }
    if (maxVal < 1e-12) return fitCircleAsEllipse(points);
    [sys[col], sys[maxRow]] = [sys[maxRow], sys[col]];
    for (let row = col + 1; row < rows; row++) {
      const factor = sys[row][col] / sys[col][col];
      for (let j = col; j <= 5; j++) sys[row][j] -= factor * sys[col][j];
    }
  }

  // Back substitution
  const sol = new Array(5);
  for (let i = 4; i >= 0; i--) {
    sol[i] = sys[i][5];
    for (let j = i + 1; j < 5; j++) sol[i] -= sys[i][j] * sol[j];
    sol[i] /= sys[i][i];
  }

  const [A, B, C, D, E] = sol;
  const F = 1;

  // Ellipse check: B² - 4AC < 0
  const disc = B * B - 4 * A * C;
  if (disc >= 0) return fitCircleAsEllipse(points);

  // Center
  const denom = 4 * A * C - B * B;
  const cx = (B * E - 2 * C * D) / denom;
  const cy = (B * D - 2 * A * E) / denom;

  // Rotation angle
  const rotation = 0.5 * Math.atan2(B, A - C);

  // Semi-axes via eigenvalues of [[A, B/2], [B/2, C]]
  const J = A * cx * cx + B * cx * cy + C * cy * cy + D * cx + E * cy + F;
  const trace = A + C;
  const det = A * C - (B / 2) * (B / 2);
  const sqrtDisc = Math.sqrt(Math.max(0, trace * trace / 4 - det));
  const lambda1 = trace / 2 + sqrtDisc;
  const lambda2 = trace / 2 - sqrtDisc;

  const a2 = -J / lambda1;
  const b2 = -J / lambda2;
  if (a2 <= 0 || b2 <= 0) return fitCircleAsEllipse(points);

  const a = Math.sqrt(a2);
  const b = Math.sqrt(b2);
  const major = Math.max(a, b);
  const minor = Math.min(a, b);

  // Adjust rotation if axes swapped
  let finalRotation = rotation;
  if (b > a) finalRotation += Math.PI / 2;

  if (major < 10 || major > canvas.width) return fitCircleAsEllipse(points);
  return { cx, cy, major, minor, rotation: finalRotation };
}

function updateDefineInfo() {
  const info = document.getElementById('define-count');
  const row = document.getElementById('define-info');
  if (definingCircle) {
    row.style.display = '';
    info.textContent = `Click circle edge: ${definePoints.length}/5 points`;
  } else {
    row.style.display = 'none';
  }
}

// ─── Ellipse Hit Testing ─────────────────────────────────────────────────────

function canvasCoords(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY,
  };
}

function toEllipseLocal(px, py, e) {
  const dx = px - e.cx;
  const dy = py - e.cy;
  const cos = Math.cos(-e.rotation);
  const sin = Math.sin(-e.rotation);
  return {
    lx: dx * cos - dy * sin,
    ly: dx * sin + dy * cos,
  };
}

function hitTestHandle(px, py, e) {
  const { lx, ly } = toEllipseLocal(px, py, e);
  const angles = [0, Math.PI / 4, Math.PI / 2, 3 * Math.PI / 4, Math.PI, 5 * Math.PI / 4, 3 * Math.PI / 2, 7 * Math.PI / 4];
  const threshold = 22;

  // Check rotation handle first
  const rotDist = e.minor + 25;
  const rotDx = lx - 0;
  const rotDy = ly - (-rotDist);
  if (Math.sqrt(rotDx * rotDx + rotDy * rotDy) < threshold) {
    return { type: 'rotate' };
  }

  for (let i = 0; i < 8; i++) {
    const hx = e.major * Math.cos(angles[i]);
    const hy = e.minor * Math.sin(angles[i]);
    const dx = lx - hx;
    const dy = ly - hy;
    if (Math.sqrt(dx * dx + dy * dy) < threshold) {
      return { type: 'handle', index: i };
    }
  }

  return null;
}

function hitTestEllipseInterior(px, py, e) {
  const { lx, ly } = toEllipseLocal(px, py, e);
  return (lx / e.major) ** 2 + (ly / e.minor) ** 2 <= 1;
}

function hitTestDegreeLabel(px, py, e) {
  if (!circleAccepted) return -1;
  const baseAngle = tagger.circleZeroDegAngle || 0;
  const offsets = [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2];
  const threshold = 36;

  for (let i = 0; i < 4; i++) {
    const theta = baseAngle + offsets[i];
    const lx = e.cx + e.major * Math.cos(theta) * Math.cos(e.rotation) - e.minor * Math.sin(theta) * Math.sin(e.rotation);
    const ly = e.cy + e.major * Math.cos(theta) * Math.sin(e.rotation) + e.minor * Math.sin(theta) * Math.cos(e.rotation);
    const dx = px - lx;
    const dy = py - ly;
    if (Math.sqrt(dx * dx + dy * dy) < threshold) return i;
  }
  return -1;
}

// ─── Canvas Pointer Handling ─────────────────────────────────────────────────

function onPointerDown(evt) {
  if (activeMode !== 'circle' && activeMode !== 'ball') return;
  const { x, y } = canvasCoords(evt);

  if (activeMode === 'ball') {
    if (markingBall) {
      const msg = tagger.addBall(currentFrame, x, y);
      if (msg) toast(msg, 'success');
      updateBallCount();
      updateSaveBtn();
      tagSummary.textContent = tagger.summaryText();
    }
    return;
  }

  // Circle mode
  const e = tagger.circleEllipse;

  // Define mode: collect edge points (need exactly 5 for ellipse)
  if (definingCircle && definePoints.length < 5) {
    definePoints.push({ x, y });
    updateDefineInfo();
    if (definePoints.length >= 5) {
      // Auto-commit fitted ellipse at 5 points
      const fit = fitEllipse(definePoints);
      if (fit) {
        tagger.setCircleEllipse(fit);
        circleAccepted = true;
        if (tagger.circleZeroDegAngle === null) {
          tagger.setCircleZeroDegAngle(0);
        }
        definingCircle = false;
        canvas.classList.remove('crosshair');
        updateCircleButtons();
        toast('Ellipse defined. Drag 0\u00B0 to set reference.', 'info');
      } else {
        toast('Could not fit ellipse — try again', 'error');
        definePoints = [];
        updateDefineInfo();
      }
    }
    return;
  }

  // Placing new circle
  if (placingCircle && !e) {
    const defaultRadius = canvas.height * 0.1;
    tagger.setCircleEllipse({ cx: x, cy: y, major: defaultRadius, minor: defaultRadius, rotation: 0 });
    placingCircle = false;
    updateCircleButtons();
    toast('Circle placed. Drag to move, handles to resize.', 'info');
    return;
  }

  if (!e) return;

  // Check degree label drag (only when accepted, only 0° is draggable)
  if (circleAccepted) {
    const labelIdx = hitTestDegreeLabel(x, y, e);
    if (labelIdx === 0) {
      dragging = { type: 'degLabel' };
      evt.preventDefault();
      return;
    }
    return; // accepted = no other interactions
  }

  // Check handles
  const hit = hitTestHandle(x, y, e);
  if (hit) {
    dragging = hit;
    if (hit.type === 'handle') handleIndex = hit.index;
    evt.preventDefault();
    return;
  }

  // Check interior for move
  if (hitTestEllipseInterior(x, y, e)) {
    dragging = { type: 'move', startX: x, startY: y, origCx: e.cx, origCy: e.cy };
    evt.preventDefault();
    return;
  }
}

function onPointerMove(evt) {
  if (!dragging) return;
  // Safety: if mouse button was released but mouseup was lost
  if (evt.buttons !== undefined && evt.buttons === 0) {
    dragging = null;
    handleIndex = -1;
    updateSaveBtn();
    tagSummary.textContent = tagger.summaryText();
    return;
  }
  const { x, y } = canvasCoords(evt);
  const e = tagger.circleEllipse;
  if (!e) return;

  if (dragging.type === 'move') {
    tagger.circleEllipse.cx = dragging.origCx + (x - dragging.startX);
    tagger.circleEllipse.cy = dragging.origCy + (y - dragging.startY);
    tagger.dirty = true;
  } else if (dragging.type === 'handle') {
    const { lx, ly } = toEllipseLocal(x, y, e);
    const i = handleIndex;
    // Cardinal handles scale one axis, diagonal handles scale both
    if (i === 0 || i === 4) {
      tagger.circleEllipse.major = Math.max(10, Math.abs(lx));
    } else if (i === 2 || i === 6) {
      tagger.circleEllipse.minor = Math.max(10, Math.abs(ly));
    } else {
      tagger.circleEllipse.major = Math.max(10, Math.abs(lx) / Math.cos(Math.PI / 4));
      tagger.circleEllipse.minor = Math.max(10, Math.abs(ly) / Math.sin(Math.PI / 4));
    }
    tagger.dirty = true;
  } else if (dragging.type === 'rotate') {
    const angle = Math.atan2(y - e.cy, x - e.cx) + Math.PI / 2;
    tagger.circleEllipse.rotation = angle;
    tagger.dirty = true;
  } else if (dragging.type === 'degLabel') {
    // Drag 0° label around ellipse perimeter
    const angle = Math.atan2(y - e.cy, x - e.cx);
    // Convert from world angle to ellipse-local angle
    const localAngle = angle - e.rotation;
    tagger.setCircleZeroDegAngle(localAngle);
  }
}

function onPointerUp(evt) {
  if (dragging) {
    const wasDegLabel = dragging.type === 'degLabel';
    if (!wasDegLabel) {
      // Push final state to undo stack for move/handle/rotate
      if (tagger.circleEllipse) {
        tagger.dirty = true;
      }
    }
    dragging = null;
    handleIndex = -1;
    updateCircleButtons();
    tagSummary.textContent = tagger.summaryText();
    // Auto-save when 0° label drag ends
    if (wasDegLabel) {
      doSave();
    }
  }
}

// ─── Ball Overlay ────────────────────────────────────────────────────────────

function drawBallOverlay() {
  // Manual ball marker at current frame
  const marker = tagger.getBallAt(currentFrame);
  if (marker) {
    drawBallCrosshair(marker.x, marker.y, '#ffaa33');
  }

  // Tracked balls from pipeline (if enabled)
  if (showTrackedBalls && metadata && metadata.ball_positions) {
    const tracked = metadata.ball_positions[currentFrame];
    if (tracked) {
      drawBallCrosshair(tracked[0], tracked[1], '#4488ff');
    }
  }
}

function drawBallCrosshair(x, y, color) {
  const r = 8;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x - r * 2, y); ctx.lineTo(x - r, y);
  ctx.moveTo(x + r, y); ctx.lineTo(x + r * 2, y);
  ctx.moveTo(x, y - r * 2); ctx.lineTo(x, y - r);
  ctx.moveTo(x, y + r); ctx.lineTo(x, y + r * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(x, y, 2, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}

// ─── Seeking ─────────────────────────────────────────────────────────────────

function seekToFrame(f) {
  if (f < 0) f = 0;
  if (f >= totalFrames) f = totalFrames - 1;
  currentFrame = f;
  scrubber.value = f;
  updateFrameInfo();
  updateButtonHighlights();
  tagSummary.textContent = tagger.summaryText();
  // Set currentTime and force canvas redraw once the decoder has the new frame
  video.currentTime = f / fps;
  if (!playing) {
    video.addEventListener('seeked', () => {
      ctx.drawImage(video, 0, 0);
      drawEllipseOverlay();
      drawBallOverlay();
    }, { once: true });
  }
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

// ─── Mode Switching ──────────────────────────────────────────────────────────

function switchMode(mode) {
  activeMode = mode;

  // Update tabs
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.mode === mode);
  });

  // Update toolbars
  document.querySelectorAll('.mode-toolbar').forEach(tb => tb.classList.remove('active'));
  const toolbar = document.getElementById(`toolbar-${mode}`);
  if (toolbar) toolbar.classList.add('active');

  // Update canvas cursor
  canvas.classList.remove('crosshair');
  if (mode === 'ball' && markingBall) canvas.classList.add('crosshair');
  if (mode === 'circle' && placingCircle) canvas.classList.add('crosshair');

  // Reset transient states
  if (mode !== 'ball') markingBall = false;
  if (mode !== 'circle') {
    placingCircle = false;
    definingCircle = false;
    definePoints = [];
    updateDefineInfo();
  }
}

function initModeTabs() {
  document.querySelectorAll('.mode-tab').forEach(tab => {
    tab.addEventListener('click', () => switchMode(tab.dataset.mode));
  });
}

// ─── Circle Mode Buttons ─────────────────────────────────────────────────────

function initCircleButtons() {
  const placeBtn = document.getElementById('btn-place-circle');
  const defineBtn = document.getElementById('btn-define-circle');
  const acceptBtn = document.getElementById('btn-accept-circle');
  const resetBtn = document.getElementById('btn-reset-circle');

  placeBtn.addEventListener('click', () => {
    // Mutual exclusion: exit define mode
    if (definingCircle) {
      definingCircle = false;
      definePoints = [];
      updateDefineInfo();
    }
    if (tagger.circleEllipse && !circleAccepted) {
      placingCircle = false;
    } else if (!tagger.circleEllipse) {
      placingCircle = !placingCircle;
    }
    updateCircleButtons();
    canvas.classList.toggle('crosshair', placingCircle);
  });

  defineBtn.addEventListener('click', () => {
    // Mutual exclusion: exit place mode
    if (placingCircle) {
      placingCircle = false;
    }
    definingCircle = !definingCircle;
    if (definingCircle) {
      // Clear existing ellipse and points to start fresh
      if (tagger.circleEllipse && !circleAccepted) {
        tagger.clearCircleEllipse();
      }
      definePoints = [];
    } else {
      definePoints = [];
    }
    updateDefineInfo();
    updateCircleButtons();
    canvas.classList.toggle('crosshair', definingCircle);
  });

  acceptBtn.addEventListener('click', async () => {
    // If define points collected (3+), commit the fitted ellipse first
    if (definePoints.length >= 3) {
      const fit = fitEllipse(definePoints);
      if (fit) {
        tagger.setCircleEllipse(fit);
        definingCircle = false;
        definePoints = [];
        updateDefineInfo();
      } else {
        toast('Could not fit ellipse to points', 'error');
        return;
      }
    }
    if (!tagger.circleEllipse) return;
    circleAccepted = true;
    if (tagger.circleZeroDegAngle === null) {
      tagger.setCircleZeroDegAngle(0);
    }
    updateCircleButtons();
    await doSave();
    toast('Circle saved. Drag 0\u00B0 label to set reference direction.', 'info');
  });

  resetBtn.addEventListener('click', () => {
    const msg = tagger.clearCircleEllipse();
    if (msg) toast(msg, 'success');
    tagger.setCircleZeroDegAngle(null);
    circleAccepted = false;
    placingCircle = false;
    definingCircle = false;
    definePoints = [];
    updateDefineInfo();
    updateCircleButtons();
    refreshTagUI();
  });
}

function updateCircleButtons() {
  const placeBtn = document.getElementById('btn-place-circle');
  const defineBtn = document.getElementById('btn-define-circle');
  const acceptBtn = document.getElementById('btn-accept-circle');

  const hasEllipse = !!tagger.circleEllipse;
  placeBtn.classList.toggle('placing', placingCircle);
  placeBtn.textContent = placingCircle ? 'Tap Canvas...' : 'Place';
  defineBtn.classList.toggle('placing', definingCircle);
  defineBtn.textContent = definingCircle ? `${definePoints.length}/5` : 'Click-5 pts';
  // Save enabled when: ellipse exists and (not yet accepted OR dirty), OR define mode has 3+ points
  const defineReady = definePoints.length >= 3;
  acceptBtn.disabled = !(hasEllipse && (!circleAccepted || tagger.dirty)) && !defineReady;
  updateSaveBtn();
}

// ─── Tag Mode Buttons ────────────────────────────────────────────────────────

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
      if (msg) toast(msg, 'success');
      else toast('No change', 'warn');
      refreshTagUI();
    });
  }

  // Show auto toggle — ON: auto colored + baseline grey; OFF: baseline colored, auto hidden
  document.getElementById('btn-show-auto').addEventListener('click', () => {
    showAutoMarkers = !showAutoMarkers;
    document.getElementById('btn-show-auto').classList.toggle('on', showAutoMarkers);
    autoMarkersEl.style.display = showAutoMarkers ? '' : 'none';
    manualMarkersEl.classList.toggle('subdued', showAutoMarkers);
  });

  // Save button in tags toolbar
  document.getElementById('tag-save-btn').addEventListener('click', doSave);
}

// ─── Ball Mode Buttons ───────────────────────────────────────────────────────

function initBallButtons() {
  document.getElementById('btn-mark-ball').addEventListener('click', () => {
    markingBall = !markingBall;
    const btn = document.getElementById('btn-mark-ball');
    btn.classList.toggle('marking', markingBall);
    btn.textContent = markingBall ? 'Marking...' : 'Mark Ball';
    canvas.classList.toggle('crosshair', markingBall && activeMode === 'ball');
  });

  document.getElementById('btn-show-tracked').addEventListener('click', () => {
    showTrackedBalls = !showTrackedBalls;
    document.getElementById('btn-show-tracked').classList.toggle('on', showTrackedBalls);
  });

  document.getElementById('btn-save-ball').addEventListener('click', doSave);
}

function updateBallCount() {
  const el = document.getElementById('ball-count');
  if (el) el.textContent = `${tagger.ballMarkers.length} marks`;
}

// ─── Save ────────────────────────────────────────────────────────────────────

async function doSave() {
  const result = await tagger.save();
  if (result.ok) {
    toast('Saved baseline.npz', 'success');
  } else {
    toast(result.error, 'error');
  }
  updateSaveBtn();
}

function updateSaveBtn() {
  document.querySelectorAll('.tool-save').forEach(btn => {
    if (tagger.dirty) {
      btn.classList.add('dirty');
      btn.textContent = 'Save *';
    } else {
      btn.classList.remove('dirty');
      btn.textContent = 'Save';
    }
  });
}

// ─── UI Refresh ──────────────────────────────────────────────────────────────

function refreshTagUI() {
  updateButtonHighlights();
  updateSaveBtn();
  tagSummary.textContent = tagger.summaryText();
  applyTimelineRange();  // Recompute range (T0/Release may have changed)
}

function updateButtonHighlights() {
  const tags = tagger.tagsAtFrame(currentFrame);
  setActive('tag-t0-btn', tags.isT0);
  setActive('tag-release-btn', tags.isRelease);
  setActive('tag-turn-btn', tags.isTurn);
  setActive('tag-ss-btn', tags.isSS);
  setActive('tag-ds-btn', tags.isDS);
}

function setActive(id, active) {
  const el = document.getElementById(id);
  if (!el) return;
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

// ─── Speed Buttons ───────────────────────────────────────────────────────────

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

// ─── Range Buttons (All / Wind / Throw) ─────────────────────────────────────

let activeRange = 'all';

function getVideoEndFrame() {
  // Highpoint from metadata if available, else release + 1 second, else total frames
  if (metadata && metadata.hammer_highpoint_frame) {
    return metadata.hammer_highpoint_frame;
  }
  const rel = tagger.release;
  if (rel !== null) {
    return Math.min(rel + Math.round(fps), totalFrames - 1);
  }
  return totalFrames - 1;
}

function getTimelineRange() {
  const t0 = tagger.throwStart;
  const rel = tagger.release;
  const endFrame = getVideoEndFrame();
  if (activeRange === 'wind' && t0 !== null) {
    return { min: 0, max: t0 };
  }
  if (activeRange === 'throw' && t0 !== null) {
    return { min: t0, max: endFrame };
  }
  return { min: 0, max: endFrame };
}

function applyTimelineRange() {
  const range = getTimelineRange();
  scrubber.min = range.min;
  scrubber.max = range.max;
  if (currentFrame < range.min) seekToFrame(range.min);
  if (currentFrame > range.max) seekToFrame(range.max);
  tagger.renderManualMarkers(manualMarkersEl, f => seekToFrame(f), range.min, range.max);
  renderAutoMarkers();
}

function initRangeButtons() {
  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeRange = btn.dataset.range;
      applyTimelineRange();
    });
  });
}

// ─── Navigation ──────────────────────────────────────────────────────────────

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

// ─── Pinch-to-Zoom ──────────────────────────────────────────────────────────

function initPinchZoom() {
  const display = document.getElementById('display-area');
  let touches = new Map();

  display.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (touches.size === 2) {
        const pts = [...touches.values()];
        const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        pinchStart = { dist, scale: zoomScale, tx: zoomTx, ty: zoomTy };
      }
    }
  });

  display.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
      touches.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (touches.size === 2 && pinchStart) {
        const pts = [...touches.values()];
        const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        const newScale = Math.max(1.0, Math.min(4.0, pinchStart.scale * (dist / pinchStart.dist)));
        zoomScale = newScale;
        applyZoom();
      } else if (touches.size === 1 && zoomScale > 1) {
        // Single-finger pan when zoomed
        const pt = touches.get(e.pointerId);
        if (pt._prev) {
          zoomTx += e.clientX - pt._prev.x;
          zoomTy += e.clientY - pt._prev.y;
          applyZoom();
        }
        pt._prev = { x: e.clientX, y: e.clientY };
      }
    }
  });

  display.addEventListener('pointerup', (e) => {
    if (e.pointerType === 'touch') {
      touches.delete(e.pointerId);
      if (touches.size < 2) pinchStart = null;
    }
  });

  display.addEventListener('pointercancel', (e) => {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinchStart = null;
  });

  // Double-tap to reset zoom
  let lastTap = 0;
  display.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch') return;
    const now = Date.now();
    if (now - lastTap < 300) {
      zoomScale = 1.0;
      zoomTx = 0;
      zoomTy = 0;
      applyZoom();
    }
    lastTap = now;
  });
}

function applyZoom() {
  canvas.style.transform = `scale(${zoomScale}) translate(${zoomTx / zoomScale}px, ${zoomTy / zoomScale}px)`;
}

// ─── Auto Markers (from pipeline) ───────────────────────────────────────────

function renderAutoMarkers() {
  if (!metadata || !autoMarkersEl) return;
  autoMarkersEl.innerHTML = '';
  const range = getTimelineRange();
  const span = range.max - range.min;
  if (span <= 0) return;

  function addAutoMarker(frame, label, cls) {
    if (frame < range.min || frame > range.max) return;
    const pct = ((frame - range.min) / span) * 100;
    const el = document.createElement('div');
    el.className = `auto-marker ${cls}`;
    el.style.left = pct + '%';
    el.innerHTML = `<div class="auto-tick"></div><div class="auto-label">${label}</div>`;
    el.addEventListener('click', (e) => { e.stopPropagation(); seekToFrame(frame); });
    autoMarkersEl.appendChild(el);
  }

  // T0 from throw_window
  if (metadata.throw_window && metadata.throw_window.start > 0) {
    addAutoMarker(metadata.throw_window.start, 'T0', 'auto-t0');
  }

  // Turn/wind boundaries
  if (metadata.turn_boundaries) {
    metadata.turn_boundaries.forEach((frame, i) => {
      const label = metadata.turn_labels ? metadata.turn_labels[i] : `T${i}`;
      const isTurn = label.startsWith('T');
      const isWind = label.startsWith('W');
      const colorClass = isTurn ? 'auto-turn' : isWind ? 'auto-wind' : '';
      addAutoMarker(frame, label, colorClass);
    });
  }

  // Release from throw_window
  if (metadata.throw_window && metadata.throw_window.release > 0) {
    addAutoMarker(metadata.throw_window.release, 'REL', 'auto-release');
  }
}

// ─── Load ────────────────────────────────────────────────────────────────────

async function loadVideoInfo() {
  const resp = await fetch('video-info.json');
  return await resp.json();
}

async function loadMetadata() {
  try {
    const resp = await fetch('metadata.json');
    if (resp.ok) {
      metadata = await resp.json();
      postPipeline = true;
    }
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
  throwName.textContent = info.basename || '';

  await loadMetadata();
  tagger.init(totalFrames, info.basename || '');

  // Load video with progress bar (XHR → blob URL)
  const loadLabel = document.getElementById('loading-label');
  const loadBar = document.getElementById('loading-bar');
  const loadBytes = document.getElementById('loading-bytes');
  loadLabel.textContent = 'Loading video...';

  const videoBlob = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', 'video.mp4');
    xhr.responseType = 'blob';
    xhr.onprogress = (e) => {
      if (e.lengthComputable) {
        loadBar.style.width = Math.round((e.loaded / e.total) * 100) + '%';
        loadBytes.textContent = `${(e.loaded / 1048576).toFixed(1)} / ${(e.total / 1048576).toFixed(1)} MB`;
      }
    };
    xhr.onload = () => resolve(xhr.response);
    xhr.onerror = () => reject(new Error('Video download failed'));
    xhr.send();
  });

  video.src = URL.createObjectURL(videoBlob);
  await new Promise((resolve, reject) => {
    video.addEventListener('loadeddata', resolve, { once: true });
    video.addEventListener('error', () => reject(new Error('Video decode failed')), { once: true });
  });

  videoReady = true;
  video.pause();
  video.currentTime = 0;

  requestAnimationFrame(renderLoop);

  // Init all UI
  initModeTabs();
  initScrubber();
  initSpeedButtons();
  initRangeButtons();
  initNavButtons();
  initCircleButtons();
  wireTagButtons();
  initBallButtons();
  initPinchZoom();
  renderAutoMarkers();

  // Canvas pointer events for circle/ball interaction
  // Use mouse events for reliable desktop drag; touch handled by pinch-zoom
  canvas.addEventListener('mousedown', onPointerDown);
  document.addEventListener('mousemove', onPointerMove);
  document.addEventListener('mouseup', onPointerUp);
  // Touch: single-touch also triggers canvas interaction
  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      onPointerDown({ clientX: t.clientX, clientY: t.clientY, preventDefault() {} });
    }
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1 && dragging) {
      e.preventDefault();
      const t = e.touches[0];
      onPointerMove({ clientX: t.clientX, clientY: t.clientY });
    }
  }, { passive: false });
  canvas.addEventListener('touchend', (e) => {
    onPointerUp({});
  });

  // Load existing baseline
  const loaded = await tagger.load();
  if (loaded) {
    toast('Loaded existing baseline', 'info');
    // Restore circle accepted state
    if (tagger.circleEllipse) {
      circleAccepted = true;
      updateCircleButtons();
    }
  }

  updateFrameInfo();
  updateBallCount();
  applyTimelineRange();  // Set scrubber range based on release/highpoint
  refreshTagUI();

  // Show auto toggle initial state
  const hasBaselineTags = tagger.throwStart !== null || tagger.turnBoundaries.length > 0;
  if (hasBaselineTags || !postPipeline) {
    // Baseline exists OR no pipeline data — hide auto, show baseline in color
    document.getElementById('btn-show-auto').style.display = 'none';
    autoMarkersEl.style.display = 'none';
    manualMarkersEl.classList.remove('subdued');
  } else if (postPipeline) {
    // Pipeline data but no baseline tags — show auto in color
    document.getElementById('btn-show-auto').classList.toggle('on', showAutoMarkers);
    autoMarkersEl.style.display = showAutoMarkers ? '' : 'none';
    manualMarkersEl.classList.toggle('subdued', showAutoMarkers);
  }
  if (!postPipeline) {
    document.getElementById('btn-show-tracked').style.display = 'none';
  }

  loadingEl.classList.add('hidden');
}

main();
