/**
 * Baseline Tagger — tag state management, save/load, manual markers.
 *
 * Pure state module. No DOM manipulation except manual markers on the timeline.
 * NPZ format matches tools/baseline_tagger.py exactly.
 */

// ─── Tag State ────────────────────────────────────────────────────────────────

export let throwStart = null;
export let release = null;
export let turnBoundaries = [];   // all turn/wind boundaries (labeled dynamically vs T0)
export let ssBoundaries = [];
export let dsBoundaries = [];
export let ballMarkers = [];      // [{frame, x, y}, ...] — pixel coords on video
export let ballMode = false;      // toggle: click canvas to mark ball
export let circleDegZero = null;  // {x, y} — pixel coords for 0° reference on circle
export let circleZeroMode = false;
export let circleEllipse = null;  // {cx, cy, major, minor, rotation} — pixel-space ellipse params
export let circleZeroDegAngle = null;  // radians — 0° reference angle on ellipse
export let dirty = false;

let undoStack = [];
let _totalFrames = 0;
let _basename = '';

// ─── Init ────────────────────────────────────────────────────────────────────

export function init(totalFrames, basename) {
  _totalFrames = totalFrames;
  _basename = basename;
}

// ─── Tag Actions (return description string for toast) ───────────────────────

export function setT0(frame) {
  undoStack.push({ type: 'throw_start', prev: throwStart });
  throwStart = frame;
  dirty = true;
  return `T0 → frame ${frame}`;
}

export function setRelease(frame) {
  undoStack.push({ type: 'release', prev: release });
  release = frame;
  dirty = true;
  return `Release → frame ${frame}`;
}

export function addTurn(frame) {
  if (frame === throwStart) return null; // can't overlap T0
  if (turnBoundaries.includes(frame)) return null;
  undoStack.push({ type: 'turn_add', frame });
  turnBoundaries.push(frame);
  turnBoundaries.sort((a, b) => a - b);
  dirty = true;
  return `${getTurnLabel(frame)} → frame ${frame}`;
}

export function addSS(frame) {
  if (ssBoundaries.includes(frame)) return null;
  undoStack.push({ type: 'ss_add', frame });
  ssBoundaries.push(frame);
  ssBoundaries.sort((a, b) => a - b);
  // Remove from DS if present
  const dsIdx = dsBoundaries.indexOf(frame);
  if (dsIdx >= 0) dsBoundaries.splice(dsIdx, 1);
  dirty = true;
  return `SS → frame ${frame}`;
}

export function addDS(frame) {
  if (dsBoundaries.includes(frame)) return null;
  undoStack.push({ type: 'ds_add', frame });
  dsBoundaries.push(frame);
  dsBoundaries.sort((a, b) => a - b);
  // Remove from SS if present
  const ssIdx = ssBoundaries.indexOf(frame);
  if (ssIdx >= 0) ssBoundaries.splice(ssIdx, 1);
  dirty = true;
  return `DS → frame ${frame}`;
}

export function undo() {
  if (undoStack.length === 0) return null;
  const action = undoStack.pop();
  dirty = true;
  switch (action.type) {
    case 'throw_start':
      throwStart = action.prev;
      return 'Undo: T0';
    case 'release':
      release = action.prev;
      return 'Undo: Release';
    case 'turn_add': {
      const idx = turnBoundaries.indexOf(action.frame);
      if (idx >= 0) turnBoundaries.splice(idx, 1);
      return 'Undo: Turn';
    }
    case 'ss_add': {
      const idx = ssBoundaries.indexOf(action.frame);
      if (idx >= 0) ssBoundaries.splice(idx, 1);
      return 'Undo: SS';
    }
    case 'ds_add': {
      const idx = dsBoundaries.indexOf(action.frame);
      if (idx >= 0) dsBoundaries.splice(idx, 1);
      return 'Undo: DS';
    }
    case 'circle_zero':
      circleDegZero = action.prev;
      return 'Undo: 0°';
    case 'circle_ellipse':
      circleEllipse = action.prev;
      return 'Undo: Circle Ellipse';
    case 'circle_zero_deg_angle':
      circleZeroDegAngle = action.prev;
      return 'Undo: 0° Angle';
    case 'ball_add': {
      const idx = ballMarkers.findIndex(m => m.frame === action.frame);
      if (idx >= 0) ballMarkers.splice(idx, 1);
      if (action.prev) {
        ballMarkers.push(action.prev);
        ballMarkers.sort((a, b) => a.frame - b.frame);
      }
      return 'Undo: Ball';
    }
    case 'delete': {
      if (action.tags.throwStart !== undefined) throwStart = action.tags.throwStart;
      if (action.tags.release !== undefined) release = action.tags.release;
      if (action.tags.turn !== undefined) {
        turnBoundaries.push(action.frame);
        turnBoundaries.sort((a, b) => a - b);
      }
      if (action.tags.ss !== undefined) {
        ssBoundaries.push(action.frame);
        ssBoundaries.sort((a, b) => a - b);
      }
      if (action.tags.ds !== undefined) {
        dsBoundaries.push(action.frame);
        dsBoundaries.sort((a, b) => a - b);
      }
      if (action.tags.ball !== undefined) {
        ballMarkers.push(action.tags.ball);
        ballMarkers.sort((a, b) => a.frame - b.frame);
      }
      return 'Undo: Delete';
    }
  }
  return null;
}

export function toggleBallMode() {
  ballMode = !ballMode;
  if (ballMode) circleZeroMode = false; // mutually exclusive
  return ballMode ? 'Ball mode ON — click video to mark' : 'Ball mode OFF';
}

export function addBall(frame, x, y) {
  // Remove existing marker at this frame (one per frame)
  const existing = ballMarkers.findIndex(m => m.frame === frame);
  const prev = existing >= 0 ? ballMarkers[existing] : null;
  if (existing >= 0) ballMarkers.splice(existing, 1);
  undoStack.push({ type: 'ball_add', frame, prev });
  ballMarkers.push({ frame, x, y });
  ballMarkers.sort((a, b) => a.frame - b.frame);
  dirty = true;
  return `Ball → frame ${frame} (${Math.round(x)}, ${Math.round(y)})`;
}

export function toggleCircleZeroMode() {
  circleZeroMode = !circleZeroMode;
  if (circleZeroMode) ballMode = false; // mutually exclusive
  return circleZeroMode ? '0° mode ON — click circle edge' : '0° mode OFF';
}

export function setCircleZeroPoint(x, y) {
  undoStack.push({ type: 'circle_zero', prev: circleDegZero });
  circleDegZero = { x, y };
  dirty = true;
  return `0° → (${Math.round(x)}, ${Math.round(y)})`;
}

export function setCircleEllipse(params) {
  undoStack.push({ type: 'circle_ellipse', prev: circleEllipse });
  circleEllipse = params ? { ...params } : null;
  dirty = true;
  if (!params) return 'Cleared circle ellipse';
  return `Circle → (${Math.round(params.cx)}, ${Math.round(params.cy)}) r=${Math.round(params.major)}x${Math.round(params.minor)}`;
}

export function clearCircleEllipse() {
  return setCircleEllipse(null);
}

export function setCircleZeroDegAngle(angle) {
  undoStack.push({ type: 'circle_zero_deg_angle', prev: circleZeroDegAngle });
  circleZeroDegAngle = angle;
  dirty = true;
  if (angle === null) return 'Cleared 0° angle';
  return `0° angle → ${(angle * 180 / Math.PI).toFixed(1)}°`;
}

export function deleteAtFrame(frame) {
  const deleted = {};
  let any = false;

  if (throwStart === frame) { deleted.throwStart = throwStart; throwStart = null; any = true; }
  if (release === frame) { deleted.release = release; release = null; any = true; }
  const tIdx = turnBoundaries.indexOf(frame);
  if (tIdx >= 0) { deleted.turn = true; turnBoundaries.splice(tIdx, 1); any = true; }
  const ssIdx = ssBoundaries.indexOf(frame);
  if (ssIdx >= 0) { deleted.ss = true; ssBoundaries.splice(ssIdx, 1); any = true; }
  const dsIdx = dsBoundaries.indexOf(frame);
  if (dsIdx >= 0) { deleted.ds = true; dsBoundaries.splice(dsIdx, 1); any = true; }
  const bIdx = ballMarkers.findIndex(m => m.frame === frame);
  if (bIdx >= 0) { deleted.ball = ballMarkers[bIdx]; ballMarkers.splice(bIdx, 1); any = true; }

  if (!any) return null;

  undoStack.push({ type: 'delete', frame, tags: deleted });
  dirty = true;
  return `Deleted tags at frame ${frame}`;
}

// ─── Query ───────────────────────────────────────────────────────────────────

export function tagsAtFrame(frame) {
  return {
    isT0: throwStart === frame,
    isRelease: release === frame,
    isTurn: turnBoundaries.includes(frame),
    isSS: ssBoundaries.includes(frame),
    isDS: dsBoundaries.includes(frame),
    isBall: ballMarkers.some(m => m.frame === frame),
  };
}

export function getBallAt(frame) {
  return ballMarkers.find(m => m.frame === frame) || null;
}

/**
 * Dynamic label for a turn boundary based on position relative to T0.
 * Boundaries before T0 → W1, W2, ... (winds)
 * Boundaries after T0  → T1, T2, ... (turns)
 * If T0 not set, all are numbered sequentially as T1, T2, ...
 */
export function getTurnLabel(frame) {
  if (throwStart === null) {
    const idx = turnBoundaries.indexOf(frame);
    return `T${idx + 1}`;
  }
  const winds = turnBoundaries.filter(f => f < throwStart);
  const turns = turnBoundaries.filter(f => f > throwStart);
  const wIdx = winds.indexOf(frame);
  if (wIdx >= 0) return `W${wIdx + 1}`;
  const tIdx = turns.indexOf(frame);
  if (tIdx >= 0) return `T${tIdx + 1}`;
  return '?';
}

/**
 * Returns all turn labels in order: [{frame, label}, ...]
 */
export function getAllTurnLabels() {
  return turnBoundaries.map(f => ({ frame: f, label: getTurnLabel(f) }));
}

export function summaryText() {
  const parts = [];
  if (throwStart !== null) parts.push(`T0:${throwStart}`);
  if (release !== null) parts.push(`REL:${release}`);
  if (throwStart !== null) {
    const nWinds = turnBoundaries.filter(f => f < throwStart).length;
    const nTurns = turnBoundaries.filter(f => f > throwStart).length;
    if (nWinds) parts.push(`W:${nWinds}`);
    if (nTurns) parts.push(`T:${nTurns}`);
  } else if (turnBoundaries.length) {
    parts.push(`Turns:${turnBoundaries.length}`);
  }
  const ssds = ssBoundaries.length + dsBoundaries.length;
  if (ssds) parts.push(`SS/DS:${ssds}`);
  if (ballMarkers.length) parts.push(`Ball:${ballMarkers.length}`);
  if (circleDegZero) parts.push('0°');
  if (circleEllipse) parts.push('Circle');
  if (circleZeroDegAngle !== null) parts.push(`Ref:${(circleZeroDegAngle * 180 / Math.PI).toFixed(0)}°`);
  return parts.join('  ') || 'No tags';
}

// ─── Save / Load ─────────────────────────────────────────────────────────────

export async function save() {
  if (throwStart === null) return { ok: false, error: 'Set T0 first' };
  if (release === null) return { ok: false, error: 'Set Release first' };
  if (release <= throwStart) return { ok: false, error: 'Release must be after T0' };

  const payload = {
    throw_start: throwStart,
    release: release,
    turn_boundaries: turnBoundaries,
    ss_boundaries: ssBoundaries,
    ds_boundaries: dsBoundaries,
    ball_markers: ballMarkers.map(m => [m.frame, m.x, m.y]),
    circle_deg_zero: circleDegZero ? [circleDegZero.x, circleDegZero.y] : null,
    circle_ellipse: circleEllipse ? [circleEllipse.cx, circleEllipse.cy, circleEllipse.major, circleEllipse.minor, circleEllipse.rotation] : null,
    circle_zero_deg_angle: circleZeroDegAngle,
    video_basename: _basename,
    total_frames: _totalFrames,
  };

  // Static deploy: save to localStorage
  try {
    localStorage.setItem('throwsage_baseline_' + _basename, JSON.stringify(payload));
    dirty = false;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function load() {
  // Static deploy: load from localStorage
  const stored = localStorage.getItem('throwsage_baseline_' + _basename);
  if (!stored) return false;
  const data = JSON.parse(stored);
  data.exists = true;

  if (data.throw_start !== undefined) throwStart = data.throw_start;
  if (data.release !== undefined) release = data.release;

  // Handle both formats: direct save (turn_boundaries) and NPZ (turn_boundaries_all)
  if (data.turn_boundaries) {
    turnBoundaries = data.turn_boundaries;
  } else if (data.turn_boundaries_all) {
    const all = data.turn_boundaries_all;
    turnBoundaries = throwStart !== null
      ? all.filter(f => f !== throwStart)
      : all.slice(1);
  }

  if (data.ss_boundaries) {
    ssBoundaries = data.ss_boundaries;
  }
  if (data.ds_boundaries) {
    dsBoundaries = data.ds_boundaries;
  }

  if (data.support_boundaries && data.support_states) {
    ssBoundaries = [];
    dsBoundaries = [];
    for (let i = 0; i < data.support_boundaries.length; i++) {
      const f = data.support_boundaries[i];
      const s = data.support_states[i];
      if (s === 1) ssBoundaries.push(f);
      else if (s === 2) dsBoundaries.push(f);
    }
  }

  if (data.ball_markers && data.ball_markers.length > 0) {
    ballMarkers = data.ball_markers.map(row => ({
      frame: row[0], x: row[1], y: row[2],
    }));
  }

  if (data.circle_deg_zero && data.circle_deg_zero.length === 2) {
    circleDegZero = { x: data.circle_deg_zero[0], y: data.circle_deg_zero[1] };
  }

  if (data.circle_ellipse && data.circle_ellipse.length === 5) {
    const [cx, cy, major, minor, rotation] = data.circle_ellipse;
    circleEllipse = { cx, cy, major, minor, rotation };
  }

  if (data.circle_zero_deg_angle !== undefined && data.circle_zero_deg_angle !== null) {
    circleZeroDegAngle = data.circle_zero_deg_angle;
  }

  dirty = false;
  return true;
}

// ─── Manual Markers on Timeline ──────────────────────────────────────────────

export function renderManualMarkers(container, onClickFrame, rangeMin, rangeMax) {
  container.innerHTML = '';
  const rMin = rangeMin !== undefined ? rangeMin : 0;
  const rMax = rangeMax !== undefined ? rangeMax : _totalFrames - 1;
  const span = rMax - rMin;
  if (span <= 0) return;

  function addMarker(frame, label, className) {
    if (frame < rMin || frame > rMax) return;
    const pct = ((frame - rMin) / span) * 100;
    const el = document.createElement('div');
    el.className = `manual-marker ${className}`;
    el.style.left = pct + '%';
    el.innerHTML = `<div class="marker-shape"></div><div class="marker-label">${label}</div>`;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      onClickFrame(frame);
    });
    container.appendChild(el);
  }

  if (throwStart !== null) addMarker(throwStart, 'T0', 'mm-t0');
  if (release !== null) addMarker(release, 'REL', 'mm-release');
  turnBoundaries.forEach(f => {
    const label = getTurnLabel(f);
    const cls = label.startsWith('W') ? 'mm-wind' : 'mm-turn';
    addMarker(f, label, cls);
  });
  ssBoundaries.forEach(f => addMarker(f, 'SS', 'mm-ss'));
  dsBoundaries.forEach(f => addMarker(f, 'DS', 'mm-ds'));
}
