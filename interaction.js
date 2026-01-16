// ====== Config / DOM ======
const videoElement = document.getElementById('video');
const handMapElement = document.getElementById('handMap');
const initialMessage = document.getElementById('initialMessage');
const subtleMessage = document.getElementById('subtleMessage');
const distanceCircle = document.getElementById('distanceCircle');
const distanceText = document.getElementById('distanceText');
const resultCircle = document.getElementById('resultCircle');
const resultText = document.getElementById('resultText');
const freezeCanvas = document.getElementById('freezeCanvas');
const freezeCtx = freezeCanvas.getContext('2d');
const resumeBtn = document.getElementById('resumeBtn');
const debugCanvas = document.getElementById('debugCanvas');
const debugCtx = debugCanvas.getContext('2d');
const newMeasurementButton = document.getElementById('newMeasurementButton');

// ====== State ======
let currentFinger = 'None';
let resultDisplayed = false;
let isFrozen = false;

// ====== Measurement config ======
const pixelToMmRatio = 0.06;
const maxMeasurements = 10;
const diameterMeasurements = [];

const expectedHandSizeAt25cm = 170;
const minHandSizeAt25cm = 140;
const maxHandSizeAt25cm = 190;
const toleranceFactor = 0.10;

const FINGER_MEASURE_POS = {
  thumb: 0.30,
  index: 0.55,
  middle: 0.55,
  ring: 0.55,
  pinky: 0.65,
};

// Évite de spam : log uniquement sur transitions main détectée / perdue
let hadHandPrevFrame = false;

// ====== MediaPipe Hands + Camera ======
const hands = new Hands({
  locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
});

hands.setOptions({
  maxNumHands: 1,
  modelComplexity: 1,
  minDetectionConfidence: 0.8,
  minTrackingConfidence: 0.8,
});

const camera = new Camera(videoElement, {
  onFrame: async () => {
    await hands.send({ image: videoElement });
  },
});

camera.start();

// UI events
newMeasurementButton.addEventListener('click', restart);
resumeBtn.addEventListener('click', resumeMeasurement);

// ====== UI helpers (distance) ======
function displayDistanceMessage(message) {
  distanceText.innerText = message;
  distanceCircle.style.display = 'flex';
}

function hideDistanceMessage() {
  distanceCircle.style.display = 'none';
}

// ====== Hand / UI ======
function classifyHand(landmarks) {
  const thumbTip = landmarks[4];
  const wrist = landmarks[0];
  return (thumbTip.x < wrist.x) ? "Left" : "Right";
}

function updateHandMap(handType) {
  const src = handType === "Right"
    ? "./images/filter_right.png"
    : "./images/filter_left.png";

  handMapElement.src = src;
  handMapElement.style.display = 'block';
}

function estimateHandSize(landmarks) {
  const vw = videoElement.videoWidth;
  const vh = videoElement.videoHeight;
  if (!vw || !vh) return { ok: false };

  const wrist = landmarks[0];
  const midTip = landmarks[12];

  // distance en pixels
  const dx = (midTip.x - wrist.x) * vw;
  const dy = (midTip.y - wrist.y) * vh;
  const handSizePx = Math.hypot(dx, dy);

  // fourchette 
  const minPx = 200;   
  const maxPx = 300;   

  if (handSizePx < minPx) {
    displayDistanceMessage("Rapprochez votre main.");
    return { ok: false, handSizePx };
  }
  if (handSizePx > maxPx) {
    displayDistanceMessage("Éloignez votre main.");
    return { ok: false, handSizePx };
  }

  displayDistanceMessage("");
  setTimeout(hideDistanceMessage, 1200);
  return { ok: true, handSizePx };
}


// ====== Pipeline (results) ======
function onHandResults(results) {


  const hasHand = !!(results.multiHandLandmarks && results.multiHandLandmarks.length > 0);

  // Log transition main présente / absente
  if (hasHand !== hadHandPrevFrame) {
    hadHandPrevFrame = hasHand;
  }

  if (!hasHand) {
    initialMessage.style.display = 'block';
    handMapElement.style.display = 'none';
    hideDistanceMessage();
    return;
  }

  initialMessage.style.display = 'none';
  handMapElement.style.display = 'block';

  const landmarks = results.multiHandLandmarks[0];

  // Debug overlay (désactivé quand c'est frozen)
  if (!isFrozen) {
    drawLandmarkIndices(landmarks);
  }

  // UI feedback
  const handType = classifyHand(landmarks);
  updateHandMap(handType);
  estimateHandSize(landmarks);

  // Mesure à la demande
  if (currentFinger !== 'None' && !resultDisplayed) {
    handleMeasurements(landmarks);
    resultDisplayed = true; // identique au comportement que tu as posté
  }
}

hands.onResults(onHandResults);

// ====== User action ======
function selectFinger(fingerType) {
  document.querySelectorAll('.finger-button').forEach(btn => btn.classList.remove('selected'));
  const btn = document.querySelector(`button[onclick="selectFinger('${fingerType}')"]`);
  if (btn) btn.classList.add('selected');

  currentFinger = fingerType;
}

// ====== Geometry ======
function getFingerMeasurementFrame(landmarks, finger, width, height, t = 0.5) {
  const fingerIndices = {
    thumb:  { mcp: 2,  pip: 3  },
    index:  { mcp: 5,  pip: 6  },
    middle: { mcp: 9,  pip: 10 },
    ring:   { mcp: 13, pip: 14 },
    pinky:  { mcp: 17, pip: 18 },
  }[finger];
  if (!fingerIndices) return null;

  const mcp = { x: landmarks[fingerIndices.mcp].x * width, y: landmarks[fingerIndices.mcp].y * height };
  const pip = { x: landmarks[fingerIndices.pip].x * width, y: landmarks[fingerIndices.pip].y * height };

  const dx = pip.x - mcp.x;
  const dy = pip.y - mcp.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;

  const center = { x: mcp.x + t * dx, y: mcp.y + t * dy };
  const nx = -dy / len;
  const ny =  dx / len;

  return { center, normal: { x: nx, y: ny }, axis: { x: dx, y: dy }, mcp, pip };
}

// ====== Pixel sampling (tmp canvas) ======
const tmpCanvas = document.createElement('canvas');
const tmpCtx = tmpCanvas.getContext('2d', { willReadFrequently: true });

function updateTmpCanvasFromVideo() {
  const vw = videoElement.videoWidth;
  const vh = videoElement.videoHeight;
  if (!vw || !vh) return false;

  if (tmpCanvas.width !== vw || tmpCanvas.height !== vh) {
    tmpCanvas.width = vw;
    tmpCanvas.height = vh;
  }
  tmpCtx.drawImage(videoElement, 0, 0, vw, vh);
  return true;
}

function clampInt(value, min, max) {
  const v = Math.floor(value);
  return (v < min ? min : (v > max ? max : v));
}

function getGrayAtPatch(x, y, halfSize = 1) {
  const vw = tmpCanvas.width;
  const vh = tmpCanvas.height;

  const xi = clampInt(Math.round(x), 0, vw - 1);
  const yi = clampInt(Math.round(y), 0, vh - 1);

  const patchSize = 2 * halfSize + 1;
  const x0 = clampInt(xi - halfSize, 0, vw - patchSize);
  const y0 = clampInt(yi - halfSize, 0, vh - patchSize);

  const imgData = tmpCtx.getImageData(x0, y0, patchSize, patchSize).data;

  let sum = 0;
  const pixelCount = patchSize * patchSize;
  for (let i = 0; i < pixelCount; i++) {
    const idx = i * 4;
    const r = imgData[idx], g = imgData[idx + 1], b = imgData[idx + 2];
    sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  return sum / pixelCount;
}

function smooth1D(values, k = 2) {
  const n = values.length;
  const out = values.slice();
  for (let i = 0; i < n; i++) {
    let sum = 0, count = 0;
    for (let j = -k; j <= k; j++) {
      const idx = i + j;
      if (idx >= 0 && idx < n) {
        sum += values[idx];
        count++;
      }
    }
    out[i] = sum / count;
  }
  return out;
}

function findEdgePeakAlongNormal(center, normal, {
  maxStepPx = 60,
  stepPx = 1,
  halfSize = 1,
  minD = 4,
  preferNear = true,
  debugTag = ""
} = {}) {
  const samples = [];
  const coords = [];

  for (let t = 0; t <= maxStepPx; t += stepPx) {
    const x = center.x + normal.x * t;
    const y = center.y + normal.y * t;
    coords.push({ x, y, t });
    samples.push(getGrayAtPatch(x, y, halfSize));
  }

  const sm = smooth1D(samples, 2);

  const grad = new Array(sm.length).fill(0);
  for (let i = 1; i < sm.length; i++) grad[i] = Math.abs(sm[i] - sm[i - 1]);

  const sorted = grad.slice().sort((a, b) => a - b);
  const p90 = sorted[Math.floor(sorted.length * 0.90)] || 0;
  const threshold = Math.max(6, p90 * 0.55);

  const peaks = [];

  for (let i = 2; i < grad.length - 2; i++) {
    const t = coords[i].t;
    if (t < minD) continue;

    const g = grad[i];
    const isLocalMax =
      g > grad[i - 1] && g >= grad[i + 1] &&
      g > grad[i - 2] && g >= grad[i + 2];

    if (isLocalMax && g >= threshold) {
      peaks.push({ i, t, score: g, x: coords[i].x, y: coords[i].y });
    }
  }

  if (!peaks.length) { return null; }

  let chosen = peaks[0];
  for (const p of peaks) {
    if (preferNear ? (p.t < chosen.t) : (p.score > chosen.score)) chosen = p;
  }

  return { x: chosen.x, y: chosen.y, t: chosen.t, score: chosen.score };
}

function measureFingerThicknessPixels(frame) {
  if (!updateTmpCanvasFromVideo()) return null;

  const { center, normal: n, axis } = frame;

  // Longueur MCP -> PIP (première phalange) en pixels
  const len = axis ? Math.hypot(axis.x, axis.y) : null;

  // Fallback si axis n'existe pas (ne devrait pas arriver si frame est bien construit)
   if (currentFinger === "thumb") {
    // Pouce : plus large, plus court
    maxStepPx = len
      ? Math.max(40, Math.min(len * 0.55, 85))
      : 65;

    minD = len
      ? Math.max(8, Math.min(16, len * 0.12))
      : 8;
  } else if (currentFinger === 'pinky') {
      maxStepPx = len
      ? Math.max(40, Math.min(len * 0.18, 85))
      : 65;

    minD = len
      ? Math.max(8, Math.min(16, len * 0.12))
      : 8;
  } else {
    // Autres doigts
    maxStepPx = len
      ? Math.max(30, Math.min(len * 0.25, 60))
      : 55;

    minD = len
      ? Math.max(6, Math.min(12, len * 0.08))
      : 6;
  }

  const edgePos = findEdgePeakAlongNormal(center, n, {
    maxStepPx, stepPx: 1, halfSize: 1, minD, preferNear: true, debugTag: "POS"
  });

  const edgeNeg = findEdgePeakAlongNormal(center, { x: -n.x, y: -n.y }, {
    maxStepPx, stepPx: 1, halfSize: 1, minD, preferNear: true, debugTag: "NEG"
  });

  if (!edgePos || !edgeNeg) { return null; }

  const thicknessPx = edgePos.t + edgeNeg.t;

  return {
    thicknessPx,
    edgeLeft: { x: edgeNeg.x, y: edgeNeg.y },
    edgeRight: { x: edgePos.x, y: edgePos.y },
  };
}

// ====== Size conversion ======
function getSizeFromDiameter(diameter) {
  if (diameter < 14) return { resultEU: 44, resultUS: 3 };
  if (diameter < 14.3) return { resultEU: 45, resultUS: 3.5 };
  if (diameter < 14.7) return { resultEU: 46, resultUS: 4 };
  if (diameter < 15) return { resultEU: 47, resultUS: 4.5 };
  if (diameter < 15.3) return { resultEU: 48, resultUS: 4.75 };
  if (diameter < 15.7) return { resultEU: 49, resultUS: 5 };
  if (diameter < 16.05) return { resultEU: 50, resultUS: 5.5 };
  if (diameter < 16.4) return { resultEU: 51, resultUS: 5.75 };
  if (diameter < 16.75) return { resultEU: 52, resultUS: 6 };
  if (diameter < 17.05) return { resultEU: 53, resultUS: 6.5 };
  if (diameter < 17.35) return { resultEU: 54, resultUS: 7 };
  if (diameter < 17.65) return { resultEU: 55, resultUS: 7.5 };
  if (diameter < 17.95) return { resultEU: 56, resultUS: 7.75 };
  if (diameter < 18.3) return { resultEU: 57, resultUS: 8 };
  if (diameter < 18.65) return { resultEU: 58, resultUS: 8.5 };
  if (diameter < 18.95) return { resultEU: 59, resultUS: 8.75 };
  if (diameter < 19.25) return { resultEU: 60, resultUS: 9 };
  if (diameter < 19.55) return { resultEU: 61, resultUS: 9.5 };
  if (diameter < 19.85) return { resultEU: 62, resultUS: 10 };
  if (diameter < 20.2) return { resultEU: 63, resultUS: 10.5 };
  if (diameter < 20.55) return { resultEU: 64, resultUS: 10.75 };
  if (diameter < 20.85) return { resultEU: 65, resultUS: 11 };
  if (diameter < 21.15) return { resultEU: 66, resultUS: 11.5 };
  if (diameter < 21.45) return { resultEU: 67, resultUS: 12 };
  if (diameter < 21.8) return { resultEU: 68, resultUS: 12.5 };
  if (diameter < 22.15) return { resultEU: 69, resultUS: 13 };
  if (diameter <= 22.3) return { resultEU: 70, resultUS: 13.5 };
  return { resultEU: null, resultUS: null };
}

function getStabilizedDiameter() {
  if (!diameterMeasurements.length) return 0;
  const sum = diameterMeasurements.reduce((a, b) => a + b, 0);
  return sum / diameterMeasurements.length;
}

// ====== Measurement pipeline ======
function handleMeasurements(landmarks) {
  // 1) Préconditions
  if (!currentFinger || currentFinger === "None") { return; }

  const vw = videoElement.videoWidth;
  const vh = videoElement.videoHeight;
  if (!vw || !vh) { return; }

  // 2) Construit la frame de mesure (centre + normale + axis)
  const t = FINGER_MEASURE_POS[currentFinger] ?? 0.55;
  const frame = getFingerMeasurementFrame(landmarks, currentFinger, vw, vh, t);
  if (!frame) { return; }

  // Debug timing (si tu as canLog)
  const doTiming = typeof canLog === "function" ? canLog("debug") : false;

  // 3) Mesure épaisseur en pixels
  const thicknessData = measureFingerThicknessPixels(frame);

  // 4) Freeze + debug overlay (toujours, comme ton comportement actuel)
  freezeOnCurrentFrame();
  drawDebugPointsOnFreeze(frame, thicknessData);

  if (!thicknessData) return;

  // 5) Conversion px -> mm (Depth si dispo, sinon fallback main-scale)
  const { mm: diameterMm, method } = computeDiameterMm({
    thicknessPx: thicknessData.thicknessPx,
    frameCenterPx: frame.center,
    landmarks,
    vw,
    vh,
  });

  if (diameterMm == null || !Number.isFinite(diameterMm)) return;

  // 6) Stabilisation (moyenne glissante)
  diameterMeasurements.push(diameterMm);
  if (diameterMeasurements.length > maxMeasurements) diameterMeasurements.shift();

  const stabilizedDiameter = getStabilizedDiameter();
  const { resultEU, resultUS } = getSizeFromDiameter(stabilizedDiameter);

  displayMeasurements(resultEU, resultUS);
}


// ====== Result / Freeze ======
function displayMeasurements(resultEU, resultUS) {
  if (!resultEU || !resultUS) { 
      resultEU = 0;
      resultUS = 0;
  }

  resultText.innerHTML =
    `<span style="border-radius:50%; width:250px; height:250px;
        opacity:0.95; background-color:black; position:absolute;
        top:50%; left:50%; transform:translate(-50%, -50%);
        display:flex; flex-direction:column; justify-content:center;
        align-items:center; color:green; font-size:24px;
        font-family:Arial,sans-serif; text-align:center; z-index:20;">
      ${resultEU} EU | ${resultUS} US
    </span>`;

  resultCircle.classList.remove('hidden');
  newMeasurementButton.classList.remove('hidden');
  resumeBtn.style.display = 'none';
  resultDisplayed = true;
}

function freezeOnCurrentFrame() {
  const rect = videoElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  // canvas = même taille que l'affichage
  freezeCanvas.width  = Math.round(rect.width  * dpr);
  freezeCanvas.height = Math.round(rect.height * dpr);
  freezeCanvas.style.width  = rect.width + "px";
  freezeCanvas.style.height = rect.height + "px";

  freezeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // IMPORTANT : reproduire le cadrage "cover"
  freezeCtx.clearRect(0, 0, rect.width, rect.height);
  drawVideoCover(freezeCtx, videoElement, rect.width, rect.height);

  debugCanvas.style.display = "none";
  freezeCanvas.style.display = "block";
  resumeBtn.style.display = "block";

  isFrozen = true;
  videoElement.pause();
  if (camera && camera.stop) camera.stop();

  return true;
}


function drawVideoCover(ctx, video, destW, destH) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;

  const videoAR = vw / vh;
  const destAR  = destW / destH;

  let sx, sy, sWidth, sHeight;

  if (videoAR > destAR) {
    // vidéo plus large -> on crop à gauche/droite
    sHeight = vh;
    sWidth  = vh * destAR;
    sx = (vw - sWidth) / 2;
    sy = 0;
  } else {
    // vidéo plus haute -> on crop en haut/bas
    sWidth  = vw;
    sHeight = vw / destAR;
    sx = 0;
    sy = (vh - sHeight) / 2;
  }

  ctx.drawImage(video, sx, sy, sWidth, sHeight, 0, 0, destW, destH);
}


function resumeMeasurement() {
  if (!isFrozen) return;

  freezeCanvas.style.display = "none";
  resumeBtn.style.display = "none";
  isFrozen = false;
  debugCanvas.style.display = "block";

  videoElement.play().catch(() => {});
  if (camera && camera.start) camera.start();

  resultDisplayed = false;
  currentFinger = 'None';
}

// ====== Restart ======
function restart() {
  resumeMeasurement();

  diameterMeasurements.length = 0;
  resultDisplayed = false;
  currentFinger = 'None';

  initialMessage.style.display = 'block';
  handMapElement.style.display = 'none';
  if (subtleMessage) subtleMessage.style.display = 'none';

  resultText.innerHTML = '';
  resultCircle.classList.add('hidden');
  newMeasurementButton.classList.add('hidden');

  setTimeout(() => { handMapElement.style.display = 'block'; }, 100);
}

// ====== Debug overlay ======
function drawLandmarkIndices(landmarks) {
  const vw = videoElement.videoWidth;
  const vh = videoElement.videoHeight;
  if (!vw || !vh) return;

  const { dw, dh } = syncDebugCanvasToDisplay();

  debugCtx.font = "14px Arial";
  debugCtx.fillStyle = "lime";
  debugCtx.strokeStyle = "black";
  debugCtx.lineWidth = 3;

  for (let i = 0; i < landmarks.length; i++) {
    const p = mapVideoToDisplay(landmarks[i].x * vw, landmarks[i].y * vh, dw, dh);

    debugCtx.beginPath();
    debugCtx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
    debugCtx.fill();

    debugCtx.strokeText(String(i), p.x + 4, p.y - 4);
    debugCtx.fillText(String(i), p.x + 4, p.y - 4);
  }
}

function syncDebugCanvasToDisplay() {
  const rect = videoElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  const targetW = Math.round(rect.width * dpr);
  const targetH = Math.round(rect.height * dpr);

  if (debugCanvas.width !== targetW || debugCanvas.height !== targetH) {
    debugCanvas.width = targetW;
    debugCanvas.height = targetH;
  }

  debugCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  debugCtx.clearRect(0, 0, rect.width, rect.height);

  return { dw: rect.width, dh: rect.height, dpr };
}

function mapVideoToDisplay(xVideo, yVideo, displayW, displayH) {
  const vw = videoElement.videoWidth;
  const vh = videoElement.videoHeight;

  const scale = Math.max(displayW / vw, displayH / vh);
  const sw = vw * scale;
  const sh = vh * scale;

  const offsetX = (displayW - sw) / 2;
  const offsetY = (displayH - sh) / 2;

  let x = offsetX + xVideo * scale;
  let y = offsetY + yVideo * scale;

  x = displayW - x; // miroir horizontal

  return { x, y };
}

// ==============================
// Depth Provider (WebXR Depth Sensing) - OPTIONAL
// ==============================

const depthProvider = {
  type: "none",
  isReady: false,

  isAvailable() {
    return this.isReady;
  },

  // Doit retourner la profondeur en mètres au pixel (x,y) de la vidéo
  getDepthMetersAt(_xPx, _yPx) {
    return null;
  },

  // Focale en pixels (fx)
  getFxPx() {
    return null;
  },
};

// Tentative d'initialisation WebXR Depth 
async function tryInitWebXRDepthProvider() {
  try {
    if (!("xr" in navigator)) return;

    const isSupported = await navigator.xr.isSessionSupported?.("immersive-ar");
    if (!isSupported) return;

  } catch (e) {
    console.warn("[DEPTH] init failed", e);
  }
}

// Lance l'essai une fois au démarrage
tryInitWebXRDepthProvider();

// ==============================
// Fallback : scale dynamique via taille de la main
// ==============================

// Longueur moyenne poignet -> bout du majeur (mm) (à ajuster / calibrer)
const EXPECTED_HAND_LENGTH_MM = 180;

function handLengthPx(landmarks, vw, vh) {
  const wrist = landmarks[0];
  const middleTip = landmarks[12];

  const dx = (middleTip.x - wrist.x) * vw;
  const dy = (middleTip.y - wrist.y) * vh;
  return Math.hypot(dx, dy);
}

// Renvoie un diamètre en mm, via fallback
function diameterMmFromHandScale(thicknessPx, landmarks, vw, vh) {
  const hlPx = handLengthPx(landmarks, vw, vh);
  if (!hlPx || hlPx < 1) return null;

  const mmPerPx = EXPECTED_HAND_LENGTH_MM / hlPx;
  return thicknessPx * mmPerPx;
}

function computeDiameterMm({ thicknessPx, frameCenterPx, landmarks, vw, vh }) {
  // 1) Si profondeur dispo (LiDAR / WebXR depth)
  if (depthProvider.isAvailable()) {
    const Zm = depthProvider.getDepthMetersAt(frameCenterPx.x, frameCenterPx.y);
    const fxPx = depthProvider.getFxPx();

    if (Zm && Zm > 0 && fxPx && fxPx > 0) {
      const mm = (thicknessPx * Zm / fxPx) * 1000;
      return { mm, method: depthProvider.type };
    }
  }

  // 2) Fallback : main -> scale
  const mmFallback = diameterMmFromHandScale(thicknessPx, landmarks, vw, vh);
  if (mmFallback != null) return { mm: mmFallback, method: "hand-scale" };

  return { mm: null, method: "none" };
}

function getCoverCrop(vw, vh, displayW, displayH) {
  const videoAR = vw / vh;
  const destAR  = displayW / displayH;

  let sx, sy, sWidth, sHeight;

  if (videoAR > destAR) {
    // crop gauche/droite
    sHeight = vh;
    sWidth  = vh * destAR;
    sx = (vw - sWidth) / 2;
    sy = 0;
  } else {
    // crop haut/bas
    sWidth  = vw;
    sHeight = vw / destAR;
    sx = 0;
    sy = (vh - sHeight) / 2;
  }
  return { sx, sy, sWidth, sHeight };
}

function mapVideoToCover(xVideo, yVideo, displayW, displayH, mirrorX = true) {
  const vw = videoElement.videoWidth;
  const vh = videoElement.videoHeight;
  if (!vw || !vh) return { x: 0, y: 0 };

  const { sx, sy, sWidth, sHeight } = getCoverCrop(vw, vh, displayW, displayH);

  const nx = (xVideo - sx) / sWidth;
  const ny = (yVideo - sy) / sHeight;

  let x = nx * displayW;
  let y = ny * displayH;

  if (mirrorX) x = displayW - x;
  return { x, y };
}

function drawMappedPoint(ctx, xVideo, yVideo, displayW, displayH, color, r = 6, mirrorX = true) {
  const p = mapVideoToCover(xVideo, yVideo, displayW, displayH, mirrorX);
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.stroke();
  return p;
}

function drawDebugPointsOnFreeze(frame, thicknessData) {
  if (!freezeCanvas || freezeCanvas.style.display === "none") return;

  const rect = videoElement.getBoundingClientRect();
  const W = rect.width;
  const H = rect.height;

  // IMPORTANT :
  // - si ta vidéo live est miroir via CSS ET que ton freeze aussi, mets true
  // - si ton freeze est NON-miroir (souvent le cas avec drawImage direct), mets false
  const mirror = false;

  freezeCtx.lineWidth = 4;

  if (frame?.center) {
    drawFreezePoint(freezeCtx, frame.center.x, frame.center.y, W, H, "yellow", 6, mirror);
  }

  if (thicknessData?.edgeLeft) {
    drawFreezePoint(freezeCtx, thicknessData.edgeLeft.x, thicknessData.edgeLeft.y, W, H, "red", 6, mirror);
  }

  if (thicknessData?.edgeRight) {
    drawFreezePoint(freezeCtx, thicknessData.edgeRight.x, thicknessData.edgeRight.y, W, H, "cyan", 6, mirror);
  }

  const leftOk = !!thicknessData?.edgeLeft;
  const rightOk = !!thicknessData?.edgeRight;

  freezeCtx.fillStyle = "white";
  freezeCtx.font = "20px Arial";
  freezeCtx.fillText(`edges: left=${leftOk} right=${rightOk}`, 20, 30);
}


function mapVideoToFreeze(xVideo, yVideo, destW, destH, mirrorX = false) {
  const vw = videoElement.videoWidth;
  const vh = videoElement.videoHeight;
  if (!vw || !vh) return { x: 0, y: 0 };

  // même crop que drawVideoCover()
  const { sx, sy, sWidth, sHeight } = getCoverCrop(vw, vh, destW, destH);

  // normaliser dans la zone crop
  const nx = (xVideo - sx) / sWidth;
  const ny = (yVideo - sy) / sHeight;

  let x = nx * destW;
  let y = ny * destH;

  // miroir optionnel (à activer seulement si ton freeze est mirroir)
  if (mirrorX) x = destW - x;

  return { x, y };
}

function drawFreezePoint(ctx, xVideo, yVideo, destW, destH, color, r = 6, mirrorX = false) {
  const p = mapVideoToFreeze(xVideo, yVideo, destW, destH, mirrorX);
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.stroke();
  return p;
}
