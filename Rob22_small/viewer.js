import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ─── State ───────────────────────────────────────────────────────────────────
let metadata = null;
let isWorldSpace = false;  // true when coord_space === 'world'
let verticesData = null;   // Float32Array (T * V * 3)
let facesData = null;      // Int32Array (F * 3)
let keypointsData = null;  // Float32Array (T * 70 * 3)
let hammerData = null;     // Float32Array (T * 3)
let fillTypeData = null;   // Int8Array (T) — provenance per frame

let currentFrame = 0;
let playing = false;
let lastFrameTime = 0;
let playbackSpeed = 1.0;

// Three.js objects
let renderer, scene, camera, controls;
let bodyMesh, hammerSphere, groundGroup;
let leftLegPlane, rightLegPlane, legPlanesGroup;
let circleGroup, circleLine;
let backPlanesGroup, backPlane;
let circlePositionsData = null;  // Float32Array (T * 3) — per-frame circle center (camera space)
let poleGroup;  // kept for legacy data compat — no longer rendered
let groundY = -Infinity;

// Separation metric
let separationAngles = null;   // Float32Array(T)
let separationEnabled = false;

// Support state
let supportStateData = null;   // Int8Array(T) — 1=SS, 0=DS

// PiP preloaded thumbnails
let pipFrames = null;          // Array of Image objects (preloaded)

// MHR70 keypoint indices
const KP_LEFT_HIP = 9, KP_RIGHT_HIP = 10;
const KP_LEFT_KNEE = 11, KP_RIGHT_KNEE = 12;
const KP_LEFT_ANKLE = 13, KP_RIGHT_ANKLE = 14;
const KP_LEFT_SHOULDER = 5, KP_RIGHT_SHOULDER = 6;
const PLANE_WIDTH = 0.35;   // meters
const PLANE_EXT = 0.30;     // ~1 foot past ankle

// SAM3D camera space: X-right, Y-down, Z-forward
// Three.js: X-right, Y-up, Z-backward
// Flip: (x, -y, -z)  — only for camera-space data
function camToThree(x, y, z) {
  if (isWorldSpace) return [x, y, z];
  return [x, -y, -z];
}

// ─── Keypoint Accessor ──────────────────────────────────────────────────────

function getKp(frame, idx) {
  const off = (frame * 70 + idx) * 3;
  if (isWorldSpace) {
    return new THREE.Vector3(keypointsData[off], keypointsData[off + 1], keypointsData[off + 2]);
  }
  return new THREE.Vector3(keypointsData[off], -keypointsData[off + 1], -keypointsData[off + 2]);
}

// ─── Grid Texture (one cell, tiles via repeat) ─────────────────────────────

function createPlaneTexture(r, g, b) {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = s; c.height = s;
  const ctx = c.getContext('2d');

  // Solid fill
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fillRect(0, 0, s, s);

  // Grid lines at left + top edges (tiling creates full grid)
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0.5, 0); ctx.lineTo(0.5, s); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, 0.5); ctx.lineTo(s, 0.5); ctx.stroke();

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ─── Data Loading ────────────────────────────────────────────────────────────

async function loadBinary(url, dtype) {
  const resp = await fetch(url);
  const buf = await resp.arrayBuffer();
  if (dtype === 'float32') return new Float32Array(buf);
  if (dtype === 'int32') return new Int32Array(buf);
  if (dtype === 'int8') return new Int8Array(buf);
  return new Uint8Array(buf);
}

async function loadData() {
  const resp = await fetch('metadata.json');
  metadata = await resp.json();
  isWorldSpace = metadata.coord_space === 'world';

  const [verts, faces, kps, hammer] = await Promise.all([
    loadBinary(metadata.files.vertices, 'float32'),
    loadBinary(metadata.files.faces, 'int32'),
    loadBinary(metadata.files.keypoints, 'float32'),
    loadBinary(metadata.files.hammer, 'float32'),
  ]);

  verticesData = verts;
  facesData = faces;
  keypointsData = kps;
  hammerData = hammer;

  // Load fill_type if available
  if (metadata.files.fill_type) {
    fillTypeData = await loadBinary(metadata.files.fill_type, 'int8');
  }

  // Load per-frame circle positions if available
  if (metadata.files.circle_positions) {
    circlePositionsData = await loadBinary(metadata.files.circle_positions, 'float32');
  }

  // Load support state (SS/DS) if available
  if (metadata.files.support_state) {
    supportStateData = await loadBinary(metadata.files.support_state, 'int8');
  }

  // Load leg alignment (precomputed from analytics) if available
  if (metadata.files.leg_alignment) {
    legAlignmentData = await loadBinary(metadata.files.leg_alignment, 'float32');
  }

  // Preload PiP thumbnail frames
  if (metadata.pip_thumbnails) {
    const thumbDir = metadata.pip_thumbnails.dir;
    const T = metadata.frame_count;
    pipFrames = new Array(T);
    const loadPromises = [];
    for (let f = 0; f < T; f++) {
      const padded = String(f).padStart(5, '0');
      const img = new window.Image();
      const promise = new Promise((resolve) => {
        img.onload = resolve;
        img.onerror = resolve;  // don't block on missing frames
      });
      img.src = `${thumbDir}/frame_${padded}.jpg`;
      pipFrames[f] = img;
      loadPromises.push(promise);
    }
    await Promise.all(loadPromises);
  } else {
    // Fallback: try to preload from ../frames/ (full-res, legacy path)
    const T = metadata.frame_count;
    pipFrames = new Array(T);
    const loadPromises = [];
    for (let f = 0; f < T; f++) {
      const padded = String(f).padStart(5, '0');
      const img = new window.Image();
      const promise = new Promise((resolve) => {
        img.onload = resolve;
        img.onerror = resolve;
      });
      img.src = `../frames/frame_${padded}.jpg`;
      pipFrames[f] = img;
      loadPromises.push(promise);
    }
    await Promise.all(loadPromises);
  }
}

// ─── Scene Setup ─────────────────────────────────────────────────────────────

function initScene() {
  const container = document.getElementById('canvas-container');

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x1a1a1a);
  container.appendChild(renderer.domElement);

  // Scene — no rotation needed, coordinate flip applied per-vertex
  scene = new THREE.Scene();

  // Camera
  if (isWorldSpace) {
    // World space: 60° FOV, position/target from metadata
    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 200);
    const cp = metadata.camera_position;
    const ct = metadata.camera_target;
    const cu = metadata.camera_up;
    camera.position.set(cp[0], cp[1], cp[2]);
    camera.up.set(cu[0], cu[1], cu[2]);
    camera.lookAt(ct[0], ct[1], ct[2]);
  } else {
    // Camera space: match SAM3D focal length
    const imageHeight = 1080;
    const focalLength = metadata.focal_length || 2200;
    const fovDeg = 2 * Math.atan(imageHeight / (2 * focalLength)) * (180 / Math.PI);
    camera = new THREE.PerspectiveCamera(fovDeg, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.set(0, 0, 0);
  }

  // Controls — orbit around the body center
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;

  // Lights
  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
  dirLight.position.set(2, 5, 5);
  scene.add(dirLight);

  // Resize handler
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

// ─── Mesh ────────────────────────────────────────────────────────────────────

function createBodyMesh() {
  const V = metadata.vertex_count;
  const F = metadata.face_count;

  const geometry = new THREE.BufferGeometry();

  // Position attribute — pre-allocate, will be updated each frame
  const posArray = new Float32Array(V * 3);
  const posAttr = new THREE.BufferAttribute(posArray, 3);
  posAttr.setUsage(THREE.StreamDrawUsage);
  geometry.setAttribute('position', posAttr);

  // Vertex colors — init to skin tone
  const colorArray = new Float32Array(V * 3);
  for (let i = 0; i < V; i++) {
    colorArray[i * 3]     = 0.831;
    colorArray[i * 3 + 1] = 0.647;
    colorArray[i * 3 + 2] = 0.455;
  }
  const colorAttr = new THREE.BufferAttribute(colorArray, 3);
  colorAttr.setUsage(THREE.StreamDrawUsage);
  geometry.setAttribute('color', colorAttr);

  // Index (faces) — set once
  const indexArray = new Uint32Array(F * 3);
  for (let i = 0; i < F * 3; i++) {
    indexArray[i] = facesData[i];
  }
  geometry.setIndex(new THREE.BufferAttribute(indexArray, 1));

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.6,
    metalness: 0.05,
    side: THREE.DoubleSide,
  });

  bodyMesh = new THREE.Mesh(geometry, material);
  scene.add(bodyMesh);
}

function updateMeshFrame(frame) {
  const V = metadata.vertex_count;
  const offset = frame * V * 3;
  const posAttr = bodyMesh.geometry.getAttribute('position');
  const arr = posAttr.array;

  if (isWorldSpace) {
    // World space: data already in Y-up, copy directly
    arr.set(verticesData.subarray(offset, offset + V * 3));
  } else {
    // Camera space: apply SAM3D→Three.js coordinate flip
    for (let i = 0; i < V; i++) {
      const si = offset + i * 3;
      const di = i * 3;
      arr[di]     =  verticesData[si];      // X unchanged
      arr[di + 1] = -verticesData[si + 1];  // Y flipped
      arr[di + 2] = -verticesData[si + 2];  // Z flipped
    }
  }

  posAttr.needsUpdate = true;
  bodyMesh.geometry.computeVertexNormals();
}

// ─── Hammer ──────────────────────────────────────────────────────────────────

// fill_type colors: 0=raw (orange), 1=manual (green), 2=propagated (cyan),
//                   3=kink_replaced (magenta), 4=spline (red)
const FILL_TYPE_COLORS = [
  { color: 0xff8c00, emissive: 0xff6600, label: 'Raw', css: '#ff8c00' },
  { color: 0x00cc66, emissive: 0x009944, label: 'Manual', css: '#00cc66' },
  { color: 0x00bbff, emissive: 0x0088cc, label: 'Propagated', css: '#00bbff' },
  { color: 0xdd44ff, emissive: 0xaa22cc, label: 'Kink Fix', css: '#dd44ff' },
  { color: 0xff3333, emissive: 0xcc1111, label: 'Spline', css: '#ff3333' },
];

function createHammer() {
  const geo = new THREE.SphereGeometry(0.08, 16, 16);
  const mat = new THREE.MeshStandardMaterial({
    color: 0xff8c00,
    emissive: 0xff6600,
    emissiveIntensity: 0.3,
    roughness: 0.3,
    metalness: 0.4,
  });
  hammerSphere = new THREE.Mesh(geo, mat);
  scene.add(hammerSphere);
}

function updateHammerFrame(frame) {
  const off = frame * 3;
  const [x, y, z] = camToThree(hammerData[off], hammerData[off + 1], hammerData[off + 2]);
  hammerSphere.position.set(x, y, z);

  // Hide hammer at invalid frames (NaN = post max-height, zero = legacy)
  const isInvalid = isNaN(hammerData[off]) || (hammerData[off] === 0 && hammerData[off+1] === 0 && hammerData[off+2] === 0);
  hammerSphere.visible = !isInvalid;

  // Color by fill_type provenance
  if (fillTypeData && !isInvalid) {
    const ft = fillTypeData[frame];
    const scheme = FILL_TYPE_COLORS[ft] || FILL_TYPE_COLORS[0];
    hammerSphere.material.color.setHex(scheme.color);
    hammerSphere.material.emissive.setHex(scheme.emissive);
  }
}

// ─── Ground Reference ────────────────────────────────────────────────────────

function createGround() {
  // Grid at the feet level for spatial reference
  // We'll position it after loading the first frame
  groundGroup = new THREE.Group();
  scene.add(groundGroup);
}

function positionGround(frame) {
  // Clear old ground
  while (groundGroup.children.length) groundGroup.remove(groundGroup.children[0]);

  const V = metadata.vertex_count;
  const offset = frame * V * 3;

  if (isWorldSpace) {
    // World space: ground_y from metadata, center grid on body XZ
    groundY = metadata.ground_y;
    const grid = new THREE.GridHelper(8, 16, 0x444444, 0x333333);
    grid.position.y = groundY;

    let cx = 0, cz = 0;
    for (let i = 0; i < V; i++) {
      cx += verticesData[offset + i * 3];
      cz += verticesData[offset + i * 3 + 2];
    }
    cx /= V;
    cz /= V;
    grid.position.x = cx;
    grid.position.z = cz;
    groundGroup.add(grid);
  } else {
    // Camera space: find lowest Y from vertex data
    let maxCamY = -Infinity;
    for (let i = 0; i < V; i++) {
      const cy = verticesData[offset + i * 3 + 1];
      if (cy > maxCamY) maxCamY = cy;
    }
    const feetY = -maxCamY;
    groundY = feetY;

    const grid = new THREE.GridHelper(6, 12, 0x444444, 0x333333);
    grid.position.y = feetY;

    let cx = 0, cz = 0;
    for (let i = 0; i < V; i++) {
      cx += verticesData[offset + i * 3];
      cz += verticesData[offset + i * 3 + 2];
    }
    cx /= V;
    cz /= V;
    grid.position.x = cx;
    grid.position.z = -cz;  // flip Z
    groundGroup.add(grid);
  }
}

// ─── Leg Planes ─────────────────────────────────────────────────────────────

function makeLegPlaneMesh(r, g, b) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(4 * 3);
  const pa = new THREE.BufferAttribute(pos, 3);
  pa.setUsage(THREE.StreamDrawUsage);
  geo.setAttribute('position', pa);

  const uv = new Float32Array([0,1, 1,1, 0,0, 1,0]);
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex([0,2,1, 1,2,3]);

  const tex = createPlaneTexture(r, g, b);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: 0.30,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  return { mesh: new THREE.Mesh(geo, mat), posAttr: pa, texture: tex };
}

function createLegPlanes() {
  legPlanesGroup = new THREE.Group();
  leftLegPlane  = makeLegPlaneMesh(70, 140, 220);   // blue
  rightLegPlane = makeLegPlaneMesh(220, 90, 70);     // coral
  legPlanesGroup.add(leftLegPlane.mesh);
  legPlanesGroup.add(rightLegPlane.mesh);
  legPlanesGroup.visible = false;
  scene.add(legPlanesGroup);
}

function updateOneLegPlane(frame, pl, hipIdx, kneeIdx, ankleIdx) {
  const hip   = getKp(frame, hipIdx);
  const knee  = getKp(frame, kneeIdx);
  const ankle = getKp(frame, ankleIdx);

  // Direction along the leg
  const mainDir = new THREE.Vector3().subVectors(ankle, hip).normalize();

  // Plane normal from hip-knee-ankle
  const v1 = new THREE.Vector3().subVectors(knee, hip);
  const v2 = new THREE.Vector3().subVectors(ankle, hip);
  const normal = new THREE.Vector3().crossVectors(v1, v2).normalize();

  // Width direction: in-plane, perpendicular to leg axis
  const widthDir = new THREE.Vector3().crossVectors(normal, mainDir).normalize();

  // Ensure width extends outward (away from body midline)
  const hipMid = getKp(frame, KP_LEFT_HIP).add(getKp(frame, KP_RIGHT_HIP)).multiplyScalar(0.5);
  const outward = new THREE.Vector3().subVectors(hip, hipMid);
  if (outward.dot(widthDir) < 0) widthDir.negate();

  // Extended ankle point
  const ankleExt = ankle.clone().addScaledVector(mainDir, PLANE_EXT);

  const wOff = widthDir.clone().multiplyScalar(PLANE_WIDTH);

  // Quad: A=hip, B=hip+w, D=ankleExt, C=ankleExt+w
  const verts = [
    [hip.x,           hip.y,           hip.z],
    [hip.x + wOff.x,  hip.y + wOff.y,  hip.z + wOff.z],
    [ankleExt.x,      ankleExt.y,      ankleExt.z],
    [ankleExt.x+wOff.x, ankleExt.y+wOff.y, ankleExt.z+wOff.z],
  ];

  // Clamp all vertices to ground level
  if (groundY > -Infinity) {
    for (const v of verts) {
      if (v[1] < groundY) v[1] = groundY;
    }
  }

  const a = pl.posAttr.array;
  for (let i = 0; i < 4; i++) {
    a[i*3] = verts[i][0]; a[i*3+1] = verts[i][1]; a[i*3+2] = verts[i][2];
  }
  pl.posAttr.needsUpdate = true;
  pl.mesh.geometry.computeVertexNormals();

  // Set grid density (~8 cm cells)
  const height = hip.distanceTo(ankleExt);
  const cellSize = 0.08;
  pl.texture.repeat.set(Math.max(1, PLANE_WIDTH / cellSize),
                        Math.max(1, height / cellSize));
}

function updateLegPlanes(frame) {
  // Always update graph if visible
  const kaContainer = document.getElementById('kneeangle-container');
  if (kaContainer && kaContainer.style.display !== 'none' && legAlignmentData) {
    drawLegCorotationGraph(frame);
  }

  if (!legPlanesGroup || !legPlanesGroup.visible) return;
  updateOneLegPlane(frame, leftLegPlane,  KP_LEFT_HIP,  KP_LEFT_KNEE,  KP_LEFT_ANKLE);
  updateOneLegPlane(frame, rightLegPlane, KP_RIGHT_HIP, KP_RIGHT_KNEE, KP_RIGHT_ANKLE);
}

// ─── Leg Co-rotation Graph ──────────────────────────────────────────────────

let legAlignmentData = null;  // Float32Array(T) — from analytics leg_alignment_deg

function drawLegCorotationGraph(frame) {
  const canvas = document.getElementById('kneeangle-graph');
  if (!canvas || !legAlignmentData) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const tw = metadata.throw_window || {};
  const fStart = tw.start || 0;
  const fEnd = tw.release || (legAlignmentData.length - 1);

  const pad = { left: 40, right: 10, top: 20, bottom: 20 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  // Y range: actual min/max with 5% buffer
  let dataMin = Infinity, dataMax = -Infinity;
  for (let i = fStart; i <= fEnd; i++) {
    const v = legAlignmentData[i];
    if (v < dataMin) dataMin = v;
    if (v > dataMax) dataMax = v;
  }
  const legBuf = Math.max((dataMax - dataMin) * 0.05, 1);
  const yMinVal = Math.floor((dataMin - legBuf) / 5) * 5;
  const yMaxVal = Math.ceil((dataMax + legBuf) / 5) * 5;
  const fRange = Math.max(1, fEnd - fStart);

  function xPx(f) { return pad.left + ((f - fStart) / fRange) * plotW; }
  function yPx(v) { return pad.top + (1 - (v - yMinVal) / (yMaxVal - yMinVal)) * plotH; }

  const inWindow = frame >= fStart && frame <= fEnd;

  const container = document.getElementById('kneeangle-container');
  if (container) container.style.borderColor = inWindow ? '#44aa66' : '#444';

  // SS/DS background shading
  if (supportStateData) {
    for (let i = fStart; i <= fEnd; i++) {
      const x0 = xPx(i - 0.5), x1 = xPx(i + 0.5);
      ctx.fillStyle = supportStateData[i] === 1
        ? 'rgba(100, 180, 255, 0.12)'   // SS: light blue
        : 'rgba(255, 180, 100, 0.12)';  // DS: light orange
      ctx.fillRect(x0, pad.top, x1 - x0, plotH);
    }
  }

  // Reference thresholds (matching analytics plot)
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255, 165, 0, 0.6)';  // orange at 15°
  ctx.beginPath(); ctx.moveTo(pad.left, yPx(15)); ctx.lineTo(w - pad.right, yPx(15)); ctx.stroke();
  ctx.strokeStyle = 'rgba(255, 60, 60, 0.6)';   // red at 30°
  ctx.beginPath(); ctx.moveTo(pad.left, yPx(30)); ctx.lineTo(w - pad.right, yPx(30)); ctx.stroke();
  ctx.setLineDash([]);

  // Y-axis labels + grid lines
  ctx.fillStyle = '#888';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const legStep = (yMaxVal - yMinVal) <= 30 ? 5 : 10;
  for (let v = yMinVal; v <= yMaxVal; v += legStep) {
    ctx.fillText(v + '\u00B0', pad.left - 4, yPx(v));
    if (v > yMinVal && v < yMaxVal) {
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.left, yPx(v)); ctx.lineTo(w - pad.right, yPx(v)); ctx.stroke();
    }
  }

  // Title
  ctx.fillStyle = '#ccc';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('Leg Co-rotation', pad.left, 3);

  // Current value
  if (inWindow) {
    ctx.fillStyle = '#44aa66';
    ctx.textAlign = 'right';
    ctx.fillText(legAlignmentData[frame].toFixed(1) + '\u00B0', w - pad.right, 3);
  }

  // Turn boundary markers
  drawTurnMarkers(ctx, xPx, pad, plotH, fStart, fEnd);

  // Plot line — DS bold green, SS faded green (matching analytics style)
  for (let i = fStart + 1; i <= fEnd; i++) {
    const isDS = supportStateData ? (supportStateData[i] === 0) : true;
    ctx.strokeStyle = isDS ? '#44aa66' : 'rgba(68, 170, 102, 0.3)';
    ctx.lineWidth = isDS ? 2.0 : 1.0;
    ctx.beginPath();
    ctx.moveTo(xPx(i - 1), yPx(legAlignmentData[i - 1]));
    ctx.lineTo(xPx(i), yPx(legAlignmentData[i]));
    ctx.stroke();
  }

  // Cursor line
  if (inWindow) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xPx(frame), pad.top);
    ctx.lineTo(xPx(frame), pad.top + plotH);
    ctx.stroke();
  }
}

// ─── Back Tilt Plane + Graph ─────────────────────────────────────────────────

let backTiltAngles = null;  // Float32Array(T) — pre-computed signed tilt per frame

function computeBackTiltAngle(frame) {
  const lShoulder = getKp(frame, KP_LEFT_SHOULDER);
  const rShoulder = getKp(frame, KP_RIGHT_SHOULDER);
  const lHip = getKp(frame, KP_LEFT_HIP);
  const rHip = getKp(frame, KP_RIGHT_HIP);

  const hipMid = lHip.clone().add(rHip).multiplyScalar(0.5);
  const shoulderMid = lShoulder.clone().add(rShoulder).multiplyScalar(0.5);

  // Tilt magnitude: angle between torso vector and vertical
  const torsoDir = new THREE.Vector3().subVectors(shoulderMid, hipMid).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const dot = Math.min(1, Math.max(-1, torsoDir.dot(up)));
  const tiltRad = Math.acos(Math.abs(dot));

  // Sign: positive = leaning back, negative = leaning forward
  const nose = getKp(frame, 0);
  const torsoCenter = shoulderMid.clone().add(hipMid).multiplyScalar(0.5);
  const forwardDir = new THREE.Vector3().subVectors(nose, torsoCenter);
  forwardDir.y = 0;
  forwardDir.normalize();
  const shoulderDisp = new THREE.Vector3().subVectors(shoulderMid, hipMid);
  shoulderDisp.y = 0;
  const sign = shoulderDisp.dot(forwardDir) > 0 ? -1 : 1;

  return sign * tiltRad * (180 / Math.PI);
}

function precomputeBackTilt() {
  const T = metadata.frame_count;
  backTiltAngles = new Float32Array(T);
  for (let i = 0; i < T; i++) {
    backTiltAngles[i] = computeBackTiltAngle(i);
  }
}

function drawTurnMarkers(ctx, xPx, pad, plotH, fStart, fEnd) {
  if (!metadata.turn_boundaries) return;
  ctx.save();
  ctx.setLineDash([2, 3]);
  ctx.lineWidth = 1;
  ctx.font = '9px sans-serif';
  ctx.textAlign = 'center';

  metadata.turn_boundaries.forEach((f, i) => {
    if (f < fStart || f > fEnd) return;
    const x = xPx(f);
    ctx.strokeStyle = '#666';
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + plotH);
    ctx.stroke();
    const label = metadata.turn_labels ? metadata.turn_labels[i] : `T${i}`;
    ctx.fillStyle = '#888';
    ctx.textBaseline = 'bottom';
    ctx.fillText(label, x, pad.top + plotH + 12);
  });

  // Release marker
  const relFrame = metadata.throw_window && metadata.throw_window.release;
  if (relFrame && relFrame >= fStart && relFrame <= fEnd) {
    const x = xPx(relFrame);
    ctx.strokeStyle = '#ff6b6b';
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + plotH);
    ctx.stroke();
    ctx.fillStyle = '#ff6b6b';
    ctx.textBaseline = 'bottom';
    ctx.fillText('REL', x, pad.top + plotH + 12);
  }

  ctx.restore();
}

function drawBackTiltGraph(frame) {
  const canvas = document.getElementById('backtilt-graph');
  if (!canvas || !backTiltAngles) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Throw window bounds
  const tw = metadata.throw_window || {};
  const fStart = tw.start || 0;
  const fEnd = tw.release || (backTiltAngles.length - 1);

  const pad = { left: 40, right: 10, top: 20, bottom: 20 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  // Find data range within throw window — actual min/max with 5% buffer
  let dataMin = Infinity, dataMax = -Infinity;
  for (let i = fStart; i <= fEnd; i++) {
    const v = backTiltAngles[i];
    if (v < dataMin) dataMin = v;
    if (v > dataMax) dataMax = v;
  }
  const btBuf = Math.max((dataMax - dataMin) * 0.05, 1);
  const yMin = Math.floor((dataMin - btBuf) / 5) * 5;
  const yMax = Math.ceil((dataMax + btBuf) / 5) * 5;
  const fRange = Math.max(1, fEnd - fStart);

  function xPx(f) { return pad.left + ((f - fStart) / fRange) * plotW; }
  function yPx(v) { return pad.top + (1 - (v - yMin) / (yMax - yMin)) * plotH; }

  // Current tilt determines border color
  const curTilt = backTiltAngles[frame];
  const inWindow = frame >= fStart && frame <= fEnd;
  const borderColor = curTilt >= 0 ? '#44cc66' : '#cc4444';

  // Set container border color
  const container = document.getElementById('backtilt-container');
  if (container) container.style.borderColor = inWindow ? borderColor : '#444';

  // Zero line (only if 0 is within range)
  if (yMin <= 0 && yMax >= 0) {
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, yPx(0));
    ctx.lineTo(w - pad.right, yPx(0));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Y-axis labels + grid lines
  ctx.fillStyle = '#888';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const btStep = (yMax - yMin) <= 30 ? 5 : 10;
  for (let v = yMin; v <= yMax; v += btStep) {
    ctx.fillText(v + '\u00B0', pad.left - 4, yPx(v));
    if (v !== 0 && v > yMin && v < yMax) {
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.left, yPx(v)); ctx.lineTo(w - pad.right, yPx(v)); ctx.stroke();
    }
  }

  // Title
  ctx.fillStyle = '#ccc';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('Back Tilt', pad.left, 3);

  // Current value (only when in window)
  if (inWindow) {
    ctx.fillStyle = borderColor;
    ctx.textAlign = 'right';
    ctx.fillText(curTilt.toFixed(1) + '\u00B0', w - pad.right, 3);
  }

  // Turn boundary markers
  drawTurnMarkers(ctx, xPx, pad, plotH, fStart, fEnd);

  // Plot line within throw window — color segments by sign
  ctx.lineWidth = 1.5;
  for (let i = fStart + 1; i <= fEnd; i++) {
    const v0 = backTiltAngles[i - 1], v1 = backTiltAngles[i];
    ctx.strokeStyle = ((v0 + v1) / 2) >= 0 ? '#44cc66' : '#cc4444';
    ctx.beginPath();
    ctx.moveTo(xPx(i - 1), yPx(v0));
    ctx.lineTo(xPx(i), yPx(v1));
    ctx.stroke();
  }

  // Cursor line — only when frame is within throw window
  if (inWindow) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xPx(frame), pad.top);
    ctx.lineTo(xPx(frame), pad.top + plotH);
    ctx.stroke();
  }
}

function createBackPlane() {
  backPlanesGroup = new THREE.Group();

  // Quad for torso (green tint)
  backPlane = makeLegPlaneMesh(70, 180, 120);
  backPlanesGroup.add(backPlane.mesh);

  backPlanesGroup.visible = false;
  scene.add(backPlanesGroup);

  // Pre-compute tilt angles for graph
  precomputeBackTilt();
}

function updateBackPlane(frame) {
  // Always update graph if angles exist and container is visible
  const container = document.getElementById('backtilt-container');
  if (container && container.style.display !== 'none' && backTiltAngles) {
    drawBackTiltGraph(frame);
  }

  if (!backPlanesGroup || !backPlanesGroup.visible) return;

  const lShoulder = getKp(frame, KP_LEFT_SHOULDER);
  const rShoulder = getKp(frame, KP_RIGHT_SHOULDER);
  const lHip = getKp(frame, KP_LEFT_HIP);
  const rHip = getKp(frame, KP_RIGHT_HIP);

  const hipMid = lHip.clone().add(rHip).multiplyScalar(0.5);
  const shoulderMid = lShoulder.clone().add(rShoulder).multiplyScalar(0.5);

  // Compute plane normal pointing backward (away from chest)
  const shoulderVec = new THREE.Vector3().subVectors(rShoulder, lShoulder);
  const torsoVec = new THREE.Vector3().subVectors(hipMid, shoulderMid);
  const planeNormal = new THREE.Vector3().crossVectors(shoulderVec, torsoVec).normalize();

  // Ensure normal points backward: compare with direction toward nose (KP 0 = nose)
  const nose = getKp(frame, 0);
  const torsoCenter = shoulderMid.clone().add(hipMid).multiplyScalar(0.5);
  const toNose = new THREE.Vector3().subVectors(nose, torsoCenter);
  if (planeNormal.dot(toNose) > 0) planeNormal.negate();

  // Offset vertices behind the mesh along backward normal
  const backOff = 0.15;  // 15cm behind mesh surface
  const lsBack = lShoulder.clone().addScaledVector(planeNormal, backOff);
  const rsBack = rShoulder.clone().addScaledVector(planeNormal, backOff);
  const lhBack = lHip.clone().addScaledVector(planeNormal, backOff);
  const rhBack = rHip.clone().addScaledVector(planeNormal, backOff);

  // Set quad corners: 0=lShoulder, 1=rShoulder, 2=lHip, 3=rHip
  const a = backPlane.posAttr.array;
  a[0] = lsBack.x; a[1] = lsBack.y; a[2] = lsBack.z;
  a[3] = rsBack.x; a[4] = rsBack.y; a[5] = rsBack.z;
  a[6] = lhBack.x; a[7] = lhBack.y; a[8] = lhBack.z;
  a[9] = rhBack.x; a[10] = rhBack.y; a[11] = rhBack.z;
  backPlane.posAttr.needsUpdate = true;
  backPlane.mesh.geometry.computeVertexNormals();
  backPlane.mesh.geometry.computeBoundingSphere();

  // Grid density
  const height = shoulderMid.distanceTo(hipMid);
  const width = lShoulder.distanceTo(rShoulder);
  const cellSize = 0.08;
  backPlane.texture.repeat.set(Math.max(1, width / cellSize), Math.max(1, height / cellSize));
}

// ─── Hip-Shoulder Separation ─────────────────────────────────────────────────

function computeSeparationAngle(frame) {
  const lHip = getKp(frame, KP_LEFT_HIP);
  const rHip = getKp(frame, KP_RIGHT_HIP);
  const lShoulder = getKp(frame, KP_LEFT_SHOULDER);
  const rShoulder = getKp(frame, KP_RIGHT_SHOULDER);

  // Project hip and shoulder vectors onto XZ plane
  const hipVecX = rHip.x - lHip.x;
  const hipVecZ = rHip.z - lHip.z;
  const shoulderVecX = rShoulder.x - lShoulder.x;
  const shoulderVecZ = rShoulder.z - lShoulder.z;

  // Signed angle via atan2(cross, dot)
  const dot = hipVecX * shoulderVecX + hipVecZ * shoulderVecZ;
  const cross = hipVecX * shoulderVecZ - hipVecZ * shoulderVecX;
  return Math.atan2(cross, dot) * (180 / Math.PI);
}

function precomputeSeparation() {
  const T = metadata.frame_count;
  separationAngles = new Float32Array(T);
  for (let i = 0; i < T; i++) {
    separationAngles[i] = computeSeparationAngle(i);
  }
}

const SKIN_R = 0.831, SKIN_G = 0.647, SKIN_B = 0.455;
const GREEN_R = 0.2, GREEN_G = 1.0, GREEN_B = 0.2;
const RED_R = 1.0, RED_G = 0.2, RED_B = 0.2;

function updateTorsoColors(frame) {
  if (!bodyMesh) return;
  const colorAttr = bodyMesh.geometry.getAttribute('color');
  const arr = colorAttr.array;
  const V = metadata.vertex_count;

  if (!separationEnabled || !separationAngles) {
    // Reset all to skin color
    for (let i = 0; i < V; i++) {
      arr[i * 3]     = SKIN_R;
      arr[i * 3 + 1] = SKIN_G;
      arr[i * 3 + 2] = SKIN_B;
    }
    colorAttr.needsUpdate = true;
    return;
  }

  // Get torso Y range from hip/shoulder midpoints
  const lHip = getKp(frame, KP_LEFT_HIP);
  const rHip = getKp(frame, KP_RIGHT_HIP);
  const lShoulder = getKp(frame, KP_LEFT_SHOULDER);
  const rShoulder = getKp(frame, KP_RIGHT_SHOULDER);
  const hipMidY = (lHip.y + rHip.y) * 0.5;
  const shoulderMidY = (lShoulder.y + rShoulder.y) * 0.5;

  // Compute fill fraction and color from separation angle
  const angle = separationAngles[frame];
  let fraction, tR, tG, tB;
  if (angle >= 0) {
    fraction = Math.min(angle / 45, 1);
    tR = SKIN_R + (GREEN_R - SKIN_R) * fraction;
    tG = SKIN_G + (GREEN_G - SKIN_G) * fraction;
    tB = SKIN_B + (GREEN_B - SKIN_B) * fraction;
  } else {
    fraction = Math.min(-angle / 15, 1);
    tR = SKIN_R + (RED_R - SKIN_R) * fraction;
    tG = SKIN_G + (RED_G - SKIN_G) * fraction;
    tB = SKIN_B + (RED_B - SKIN_B) * fraction;
  }

  // Color region grows from hips toward shoulders by fraction
  const boundary = hipMidY + fraction * (shoulderMidY - hipMidY);
  const yLow = Math.min(hipMidY, boundary);
  const yHigh = Math.max(hipMidY, boundary);

  // Read vertex positions to check Y range
  const posAttr = bodyMesh.geometry.getAttribute('position');
  const posArr = posAttr.array;

  for (let i = 0; i < V; i++) {
    const vy = posArr[i * 3 + 1];
    if (vy >= yLow && vy <= yHigh) {
      arr[i * 3]     = tR;
      arr[i * 3 + 1] = tG;
      arr[i * 3 + 2] = tB;
    } else {
      arr[i * 3]     = SKIN_R;
      arr[i * 3 + 1] = SKIN_G;
      arr[i * 3 + 2] = SKIN_B;
    }
  }
  colorAttr.needsUpdate = true;
}

function drawSeparationGraph(frame) {
  const canvas = document.getElementById('separation-graph');
  if (!canvas || !separationAngles) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const tw = metadata.throw_window || {};
  const fStart = tw.start || 0;
  const fEnd = tw.release || (separationAngles.length - 1);

  const pad = { left: 40, right: 10, top: 20, bottom: 20 };
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  // Find data range within throw window — actual min/max with 5% buffer
  let dataMin = Infinity, dataMax = -Infinity;
  for (let i = fStart; i <= fEnd; i++) {
    const v = separationAngles[i];
    if (v < dataMin) dataMin = v;
    if (v > dataMax) dataMax = v;
  }
  const sepBuf = Math.max((dataMax - dataMin) * 0.05, 1);
  const yMin = Math.floor((dataMin - sepBuf) / 5) * 5;
  const yMax = Math.ceil((dataMax + sepBuf) / 5) * 5;
  const fRange = Math.max(1, fEnd - fStart);

  function xPx(f) { return pad.left + ((f - fStart) / fRange) * plotW; }
  function yPx(v) { return pad.top + (1 - (v - yMin) / (yMax - yMin)) * plotH; }

  const curAngle = separationAngles[frame];
  const inWindow = frame >= fStart && frame <= fEnd;
  const borderColor = curAngle >= 0 ? '#44cc66' : '#cc4444';

  const container = document.getElementById('separation-container');
  if (container) container.style.borderColor = inWindow ? borderColor : '#444';

  // Zero line (only if 0 is within range)
  if (yMin <= 0 && yMax >= 0) {
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pad.left, yPx(0));
    ctx.lineTo(w - pad.right, yPx(0));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Y-axis labels + grid lines
  ctx.fillStyle = '#888';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  const sepStep = (yMax - yMin) <= 30 ? 5 : 10;
  for (let v = yMin; v <= yMax; v += sepStep) {
    ctx.fillText(v + '\u00B0', pad.left - 4, yPx(v));
    if (v !== 0 && v > yMin && v < yMax) {
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pad.left, yPx(v)); ctx.lineTo(w - pad.right, yPx(v)); ctx.stroke();
    }
  }

  // Title
  ctx.fillStyle = '#ccc';
  ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('Separation', pad.left, 3);

  // Current value
  if (inWindow) {
    ctx.fillStyle = borderColor;
    ctx.textAlign = 'right';
    ctx.fillText(curAngle.toFixed(1) + '\u00B0', w - pad.right, 3);
  }

  // Turn boundary markers
  drawTurnMarkers(ctx, xPx, pad, plotH, fStart, fEnd);

  // Plot line — color segments by sign
  ctx.lineWidth = 1.5;
  for (let i = fStart + 1; i <= fEnd; i++) {
    const v0 = separationAngles[i - 1], v1 = separationAngles[i];
    ctx.strokeStyle = ((v0 + v1) / 2) >= 0 ? '#44cc66' : '#cc4444';
    ctx.beginPath();
    ctx.moveTo(xPx(i - 1), yPx(v0));
    ctx.lineTo(xPx(i), yPx(v1));
    ctx.stroke();
  }

  // Cursor line
  if (inWindow) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(xPx(frame), pad.top);
    ctx.lineTo(xPx(frame), pad.top + plotH);
    ctx.stroke();
  }
}

// ─── Throwing Circle ──────────────────────────────────────────────────────────

function createCircle() {
  circleGroup = new THREE.Group();
  circleGroup.visible = false;  // hidden until data loaded

  if (!metadata.circle || !metadata.circle.detected) return;

  const c = metadata.circle;
  const radius = c.radius;
  const segments = 64;

  // Circle geometry in XZ plane (Y-up in Three.js = ground plane)
  const points = [];
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    points.push(new THREE.Vector3(
      Math.cos(theta) * radius,
      0,
      Math.sin(theta) * radius,
    ));
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const material = new THREE.LineBasicMaterial({
    color: 0xffffff,
    linewidth: 2,
    transparent: true,
    opacity: 0.7,
  });
  circleLine = new THREE.Line(geometry, material);

  if (isWorldSpace && c.center) {
    // World space: fixed position from metadata
    circleLine.position.set(c.center[0], c.center[1], c.center[2]);
  } else if (c.center_cam) {
    // Camera space: flip (x, -y, -z)
    circleLine.position.set(c.center_cam[0], -c.center_cam[1], -c.center_cam[2]);
  }

  circleGroup.add(circleLine);
  circleGroup.visible = true;
  scene.add(circleGroup);
}

function updateCircleFrame(frame) {
  // World space: circle is fixed, no per-frame update needed
  if (isWorldSpace) return;

  if (!circleLine || !circlePositionsData) return;
  if (!metadata.circle || !metadata.circle.per_frame) return;

  const off = frame * 3;
  const cx = circlePositionsData[off];
  const cy = circlePositionsData[off + 1];
  const cz = circlePositionsData[off + 2];
  circleLine.position.set(cx, -cy, -cz);
}

// ─── Poles ───────────────────────────────────────────────────────────────────

function createPoles() {
  poleGroup = new THREE.Group();
  poleGroup.visible = false;  // hidden until toggled on

  if (!metadata.poles || metadata.poles.count === 0) return;

  const poleColor = 0x88ccff;
  const poleMaterial = new THREE.LineBasicMaterial({
    color: poleColor,
    linewidth: 2,
    transparent: true,
    opacity: 0.8,
  });

  if (isWorldSpace && metadata.poles.positions) {
    // World space: static vertical lines at known positions
    const height = metadata.poles.height || 3.0;
    const gy = metadata.ground_y || 0;

    for (const pos of metadata.poles.positions) {
      const points = [
        new THREE.Vector3(pos[0], gy, pos[2]),
        new THREE.Vector3(pos[0], gy + height, pos[2]),
      ];
      const geom = new THREE.BufferGeometry().setFromPoints(points);
      const line = new THREE.Line(geom, poleMaterial.clone());
      poleGroup.add(line);
    }
  } else if (polePositionsData && metadata.poles.per_frame) {
    // Camera space: create placeholder lines, updated per-frame
    const nPoles = metadata.poles.count;
    for (let i = 0; i < nPoles; i++) {
      const points = [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 1, 0),
      ];
      const geom = new THREE.BufferGeometry().setFromPoints(points);
      geom.setAttribute('position', new THREE.Float32BufferAttribute(
        [0, 0, 0, 0, 1, 0], 3
      ));
      const line = new THREE.Line(geom, poleMaterial.clone());
      line.visible = false;
      poleGroup.add(line);
    }
  }

  scene.add(poleGroup);
}

function updatePolesFrame(frame) {
  if (!poleGroup || !poleGroup.visible) return;

  // World space: poles are static, no per-frame update
  if (isWorldSpace) return;

  // Camera space: update from per-frame 2D positions
  if (!polePositionsData || !metadata.poles || !metadata.poles.per_frame) return;

  const nPoles = metadata.poles.count;
  const T = metadata.frame_count;

  // Approximate body depth from first vertex Z
  const V = metadata.vertex_count;
  const vOff = frame * V * 3;
  let avgZ = 0;
  for (let i = 0; i < Math.min(V, 100); i++) {
    avgZ += verticesData[vOff + i * 3 + 2];
  }
  avgZ /= Math.min(V, 100);
  const depth = Math.abs(avgZ);

  const focalLength = metadata.focal_length || 2200;
  const poleHeightPx = 200;  // approximate visual height in pixels

  for (let i = 0; i < nPoles; i++) {
    const line = poleGroup.children[i];
    if (!line) continue;

    const off = (i * T + frame) * 2;
    const px = polePositionsData[off];
    const py = polePositionsData[off + 1];

    // NaN check — hide pole during occlusion gaps
    if (isNaN(px) || isNaN(py)) {
      line.visible = false;
      continue;
    }

    // Back-project 2D to approximate 3D at body depth
    const cx = (px - 960) * depth / focalLength;
    const cy = (py - 540) * depth / focalLength;

    // Vertical line in camera-space (flip Y/Z for Three.js)
    const baseY = -cy;
    const topY = baseY + (poleHeightPx * depth / focalLength);
    const posArr = line.geometry.attributes.position.array;
    posArr[0] = cx;  posArr[1] = baseY;  posArr[2] = -depth;
    posArr[3] = cx;  posArr[4] = topY;   posArr[5] = -depth;
    line.geometry.attributes.position.needsUpdate = true;
    line.visible = true;
  }
}

// ─── Camera Framing ──────────────────────────────────────────────────────────

let initialCameraPos = null;
let initialTarget = null;

function frameCameraOnBody() {
  if (isWorldSpace) {
    // World space: use camera position/target from metadata
    const cp = metadata.camera_position;
    const ct = metadata.camera_target;
    const cu = metadata.camera_up;
    camera.position.set(cp[0], cp[1], cp[2]);
    camera.up.set(cu[0], cu[1], cu[2]);
    controls.target.set(ct[0], ct[1], ct[2]);
    controls.update();
  } else {
    // Camera space: compute body center from first-frame vertices
    const V = metadata.vertex_count;
    let cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < V; i++) {
      cx += verticesData[i * 3];
      cy += -verticesData[i * 3 + 1];
      cz += -verticesData[i * 3 + 2];
    }
    cx /= V;
    cy /= V;
    cz /= V;

    controls.target.set(cx, cy, cz);
    const bodyDist = Math.abs(cz);
    camera.position.set(0, 0, bodyDist * 0.4);
    controls.update();
  }

  // Save initial state for reset
  initialCameraPos = camera.position.clone();
  initialTarget = controls.target.clone();
}

function resetView() {
  if (initialCameraPos && initialTarget) {
    camera.position.copy(initialCameraPos);
    controls.target.copy(initialTarget);
    controls.update();
  }
}

// ─── UI ──────────────────────────────────────────────────────────────────────

function initUI() {
  const T = metadata.frame_count;

  // Header
  document.getElementById('throw-name').textContent = metadata.throw;

  // Scrubber
  const scrubber = document.getElementById('scrubber');
  scrubber.max = T - 1;
  scrubber.value = 0;

  scrubber.addEventListener('input', (e) => {
    currentFrame = parseInt(e.target.value, 10);
    updateFrame(currentFrame);
  });

  // Play/pause
  const playBtn = document.getElementById('play-btn');
  playBtn.addEventListener('click', () => {
    playing = !playing;
    playBtn.innerHTML = playing ? '&#9646;&#9646;' : '&#9654;';
    if (playing) lastFrameTime = performance.now();
  });

  // Speed buttons
  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      playbackSpeed = parseFloat(btn.dataset.speed);
    });
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      playBtn.click();
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      setFrame(Math.max(0, currentFrame - 1));
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      setFrame(Math.min(T - 1, currentFrame + 1));
    } else if (e.code === 'Home') {
      e.preventDefault();
      setFrame(0);
    } else if (e.code === 'End') {
      e.preventDefault();
      setFrame(T - 1);
    }
  });

  // View reset button
  document.getElementById('reset-view-btn').addEventListener('click', () => {
    resetView();
  });

  // Hamburger menu toggle
  const hamburgerBtn = document.getElementById('hamburger-btn');
  const togglesPanel = document.getElementById('toggles');
  if (hamburgerBtn && togglesPanel) {
    hamburgerBtn.addEventListener('click', () => {
      togglesPanel.classList.toggle('open');
    });
    // Close menu when tapping outside (on the 3D canvas)
    document.getElementById('canvas-container').addEventListener('click', () => {
      togglesPanel.classList.remove('open');
    });
  }

  // Turn markers
  createMarkers();

  // Visibility toggles
  document.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
      const target = btn.dataset.target;
      const visible = btn.classList.contains('active');
      if (target === 'mesh') bodyMesh.visible = visible;
      if (target === 'hammer') hammerSphere.visible = visible;
      if (target === 'planes') {
        legPlanesGroup.visible = visible;
        const kaContainer = document.getElementById('kneeangle-container');
        if (kaContainer) kaContainer.style.display = visible ? 'block' : 'none';
        if (visible) {
          updateLegPlanes(currentFrame);
          if (legAlignmentData) drawLegCorotationGraph(currentFrame);
        }
      }
      if (target === 'backtilt') {
        backPlanesGroup.visible = visible;
        const btContainer = document.getElementById('backtilt-container');
        if (btContainer) btContainer.style.display = visible ? 'block' : 'none';
        if (visible) updateBackPlane(currentFrame);
      }
      if (target === 'separation') {
        separationEnabled = visible;
        const sepContainer = document.getElementById('separation-container');
        if (sepContainer) sepContainer.style.display = visible ? 'block' : 'none';
        updateTorsoColors(currentFrame);
        if (visible) drawSeparationGraph(currentFrame);
      }
      if (target === 'circle' && circleGroup) circleGroup.visible = visible;
    });
  });
}

function createMarkers() {
  const container = document.getElementById('markers');
  const T = metadata.frame_count;

  // Turn boundary markers
  metadata.turn_boundaries.forEach((frame, i) => {
    const pct = (frame / (T - 1)) * 100;
    const label = metadata.turn_labels ? metadata.turn_labels[i] : `T${i}`;
    const el = document.createElement('div');
    el.className = 'turn-marker';
    el.style.left = pct + '%';
    el.innerHTML = `<div class="tick"></div><div class="label">${label}</div>`;
    container.appendChild(el);
  });

  // Release marker
  const relFrame = metadata.throw_window.release;
  if (relFrame > 0) {
    const pct = (relFrame / (T - 1)) * 100;
    const el = document.createElement('div');
    el.className = 'turn-marker release';
    el.style.left = pct + '%';
    el.innerHTML = `<div class="tick"></div><div class="label">REL</div>`;
    container.appendChild(el);
  }
}

function setFrame(f) {
  currentFrame = f;
  document.getElementById('scrubber').value = f;
  updateFrame(f);
}

function updateFrame(frame) {
  updateMeshFrame(frame);
  updateHammerFrame(frame);
  updateLegPlanes(frame);
  updateBackPlane(frame);
  updateTorsoColors(frame);
  updateCircleFrame(frame);
  updateFrameDisplay(frame);

  // Update separation graph if visible
  const sepContainer = document.getElementById('separation-container');
  if (sepContainer && sepContainer.style.display !== 'none' && separationAngles) {
    drawSeparationGraph(frame);
  }
}

function updateFrameDisplay(frame) {
  const T = metadata.frame_count;
  const timeS = (frame / metadata.fps).toFixed(2);
  document.getElementById('frame-info').textContent =
    `Frame ${frame} / ${T - 1}  (${timeS}s)`;

  // Update PiP video frame from preloaded thumbnails
  const pipFrame = document.getElementById('pip-frame');
  if (pipFrame && pipFrames && pipFrames[frame] && pipFrames[frame].complete) {
    pipFrame.src = pipFrames[frame].src;
    const pipLabel = document.getElementById('pip-label');
    if (pipLabel) pipLabel.textContent = `Frame ${frame} (${timeS}s)`;
  }
}

// ─── Animation Loop ──────────────────────────────────────────────────────────

function animate() {
  requestAnimationFrame(animate);

  if (playing) {
    const now = performance.now();
    const elapsed = now - lastFrameTime;
    const frameDuration = 1000 / (metadata.fps * playbackSpeed);

    if (elapsed >= frameDuration) {
      lastFrameTime = now - (elapsed % frameDuration);
      currentFrame++;
      if (currentFrame >= metadata.frame_count) {
        currentFrame = 0;
      }
      document.getElementById('scrubber').value = currentFrame;
      updateFrame(currentFrame);
    }
  }

  controls.update();
  renderer.render(scene, camera);
}

// ─── Color Legend ─────────────────────────────────────────────────────────────

function createColorLegend() {
  if (!fillTypeData) return;
  const legend = document.getElementById('color-legend');
  if (!legend) return;

  // Count occurrences of each fill_type
  const counts = [0, 0, 0, 0, 0];
  for (let i = 0; i < fillTypeData.length; i++) {
    const v = fillTypeData[i];
    if (v >= 0 && v <= 4) counts[v]++;
  }

  // Only show types that actually appear
  for (let i = 0; i < FILL_TYPE_COLORS.length; i++) {
    if (counts[i] === 0) continue;
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `<span class="legend-dot" style="background:${FILL_TYPE_COLORS[i].css}"></span>${FILL_TYPE_COLORS[i].label} <span class="legend-count">${counts[i]}</span>`;
    legend.appendChild(item);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  try {
    await loadData();
  } catch (err) {
    document.getElementById('loading').innerHTML =
      `<div class="label" style="color:#ff6b6b;">Failed to load data: ${err.message}</div>`;
    return;
  }

  initScene();
  createBodyMesh();
  createHammer();
  createGround();
  createLegPlanes();
  createBackPlane();
  precomputeSeparation();
  createCircle();

  // Set initial frame — positionGround first so groundY is available
  positionGround(0);
  updateFrame(0);
  frameCameraOnBody();

  initUI();
  createColorLegend();

  // Hide loading, start render loop
  document.getElementById('loading').classList.add('hidden');
  animate();
}

main();
