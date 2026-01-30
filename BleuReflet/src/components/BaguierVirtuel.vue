<template>
  <div class="baguier-root">
    <!-- Bouton d’ouverture -->
    <div id="appcov" v-show="!isModalOpen">
      <button id="openModalButton" @click="openModal">Ouvrir l'Application</button>
    </div>

    <!-- Modale -->
    <div id="modal" class="modal" v-show="isModalOpen" @click.self="closeModal">
      <div class="modal-content">
        <span class="close" @click="closeModal">&times;</span>

        <h1>Votre baguier virtuel</h1>

        <div id="initialMessage" v-show="showInitialMessage">
          Veuillez positionner votre main de manière à ce qu'elle s'aligne parfaitement avec la silhouette affichée à l'écran,
          en veillant à ce que tous les bords de votre main soient bien dans les limites du cadre vert.
        </div>

        <div id="videoContainer" :class="{ mirrored: isUserFacing }">
          <video ref="videoElement" id="video" autoplay playsinline muted></video>

          <!-- Canvas de freeze + debug (du code 2) -->
          <canvas ref="freezeCanvasEl" id="freezeCanvas"></canvas>
          <canvas ref="debugCanvasEl" id="debugCanvas"></canvas>
  
          <!-- 🔄 Switch caméra -->
          <button style="position:absolute; top:10px; right:10px; z-index:70; padding:6px 10px;" @click="switchCamera">🔄 Cam</button>
          <!-- Bouton reprendre (du code 2) -->
          <button id="resumeBtn" @click="resumeMeasurement" v-show="isFrozen">
            Reprendre la mesure
          </button>

          <!-- Hand map -->
          <img
            id="handMap"
            :src="currentHandFilter"
            alt="Contour de la main"
            :style="{ display: handDetected ? 'block' : 'none' }"
          />

          <!-- Cercle distance (pattern code 1 : visible si distanceMessage non vide) -->
          <div id="distanceCircle" :class="{ hidden: !distanceMessage }">
            <span id="distanceText">{{ distanceMessage }}</span>
          </div>

          <!-- Cercle résultat (pattern code 1 : EU/US en data, pas v-html) -->
          <div id="resultCircle" :class="{ hidden: !resultDisplayed }" v-show="resultDisplayed">
            <span id="resultText">
              <span v-if="resultEU != null" class="result-bubble">
                {{ resultEU }} EU | {{ resultUS }} US
              </span>
              <div class="methodText">
                {{
                  measurementMethod === 'lidar'
                    ? 'Avec LiDAR'
                    : measurementMethod === 'hand-scale'
                      ? 'Sans LiDAR (estimation)'
                      : 'Sans LiDAR'
                }}
              </div>
            </span>

            <button
              id="newMeasurementButton"
              :class="{ hidden: !resultDisplayed }"
              v-show="resultDisplayed"
              @click="restart"
            >
              Nouvelle Mesure
            </button>
          </div>
        </div>

        <!-- Boutons doigts (pattern code 1 : v-for) -->
        <div id="fingerSelection">
          <button
            v-for="finger in fingers"
            :key="finger.key"
            class="finger-button"
            :class="{ selected: currentFinger === finger.key }"
            @click="selectFinger(finger.key)"
          >
            {{ finger.label }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, nextTick, onUnmounted } from "vue";
import { Hands } from "@mediapipe/hands";
import { Camera } from "@mediapipe/camera_utils";

// ==============================
// Vue Reactive State (style code 1)
// ==============================
const isModalOpen = ref(false);
const showInitialMessage = ref(true);
const handDetected = ref(false);

const currentFinger = ref("None");
const currentHandFilter = ref("./images/filter_left.png");

const distanceMessage = ref("");

const resultDisplayed = ref(false);
const resultEU = ref(null);
const resultUS = ref(null);

const isFrozen = ref(false);

const desiredFacingMode = ref("environment"); // ✅ arrière par défaut
const isUserFacing = ref(false);              // miroir uniquement si caméra avant

const measurementMethod = ref("unknown"); 
// "lidar" | "hand-scale" | "none" | "unknown"

// ==============================
// DOM Refs (adaptés au naming code 1)
// ==============================
const videoElement = ref(null);
const freezeCanvasEl = ref(null);
const debugCanvasEl = ref(null);

// 2D contexts (non-réactifs)
let freezeCtx = null;
let debugCtx = null;

// ==============================
// Finger buttons (code 1)
// ==============================
const fingers = [
  { key: "thumb", label: "Pouce" },
  { key: "index", label: "Index" },
  { key: "middle", label: "Majeur" },
  { key: "ring", label: "Annulaire" },
  { key: "pinky", label: "Auriculaire" },
];

// ==============================
// Measurement config (du code 2)
// ==============================
const maxMeasurements = 10;
const diameterMeasurements = [];

const HAND_SIZE_MIN_PX = 200;
const HAND_SIZE_MAX_PX = 300;

const FINGER_INDICES = {
  thumb: { mcp: 2, pip: 3 },
  index: { mcp: 5, pip: 6 },
  middle: { mcp: 9, pip: 10 },
  ring: { mcp: 13, pip: 14 },
  pinky: { mcp: 17, pip: 18 },
};

const FINGER_MEASURE_POS = {
  thumb: 0.30,
  index: 0.55,
  middle: 0.55,
  ring: 0.55,
  pinky: 0.65,
};

const THICKNESS_PARAMS = {
  thumb: {
    maxStepMin: 40, maxStepMax: 85, maxStepFactor: 0.55,
    minDistMin: 8, minDistMax: 16, minDistFactor: 0.12,
    fallbackMaxStep: 65, fallbackMinDist: 8,
  },
  others: {
    maxStepMin: 30, maxStepMax: 60, maxStepFactor: 0.35,
    minDistMin: 6, minDistMax: 12, minDistFactor: 0.08,
    fallbackMaxStep: 55, fallbackMinDist: 6,
  },
};

const EXPECTED_HAND_LENGTH_MM = 180;

// ==============================
// MediaPipe Instances
// ==============================
let hands = null;
let camera = null;

// ==============================
// Modal actions
// ==============================
function openModal() {
  isModalOpen.value = true;
}
function closeModal() {
  isModalOpen.value = false;
}

// ==============================
// UI helpers (distance) — simplifié (pattern code 1)
// ==============================
function displayDistanceMessage(message) {
  distanceMessage.value = message;
}
function hideDistanceMessage() {
  distanceMessage.value = "";
}

// ==============================
// Hand / UI
// ==============================
function classifyHand(landmarks) {
  const thumbTip = landmarks[4];
  const wrist = landmarks[0];
  return (thumbTip.x < wrist.x) ? "Left" : "Right";
}
function updateHandMap(handType) {
  currentHandFilter.value =
    handType === "Right" ? "./images/filter_right.png" : "./images/filter_left.png";
}

function estimateHandSize(landmarks) {
  const vw = videoElement.value?.videoWidth;
  const vh = videoElement.value?.videoHeight;
  if (!vw || !vh) return { ok: false };

  const wrist = landmarks[0];
  const midTip = landmarks[12];

  const dx = (midTip.x - wrist.x) * vw;
  const dy = (midTip.y - wrist.y) * vh;
  const handSizePx = Math.hypot(dx, dy);

  if (handSizePx < HAND_SIZE_MIN_PX) {
    displayDistanceMessage("Rapprochez votre main.");
    return { ok: false, handSizePx };
  }
  if (handSizePx > HAND_SIZE_MAX_PX) {
    displayDistanceMessage("Éloignez votre main.");
    return { ok: false, handSizePx };
  }

  // OK
  displayDistanceMessage("Main bien positionnée.");
  setTimeout(() => {
    // On n’efface que si c’est toujours le même message
    if (distanceMessage.value === "Main bien positionnée.") hideDistanceMessage();
  }, 1200);

  return { ok: true, handSizePx };
}

// ==============================
// Pipeline (results)
// ==============================
function onHandResults(results) {
  const hasHand = !!(results.multiHandLandmarks && results.multiHandLandmarks.length > 0);

  if (!hasHand) {
    showInitialMessage.value = true;
    handDetected.value = false;
    hideDistanceMessage();
    return;
  }

  showInitialMessage.value = false;
  handDetected.value = true;

  const landmarks = results.multiHandLandmarks[0];

  if (!isFrozen.value) {
    drawLandmarkIndices(landmarks);
  }

  const handType = classifyHand(landmarks);
  updateHandMap(handType);

  // Distance UI
  estimateHandSize(landmarks);

  // Mesure (IMPORTANT : pas de resultDisplayed=true ici)
  if (currentFinger.value !== "None" && !resultDisplayed.value) {
    handleMeasurements(landmarks);
  }
}

// ==============================
// User action
// ==============================
function selectFinger(fingerType) {
  currentFinger.value = fingerType;
}

// ==============================
// Geometry
// ==============================
function getFingerMeasurementFrame(landmarks, finger, width, height, t = 0.5) {
  const indices = FINGER_INDICES[finger];
  if (!indices) return null;

  const { mcp: mcpIndex, pip: pipIndex } = indices;
  const mcpPoint = { x: landmarks[mcpIndex].x * width, y: landmarks[mcpIndex].y * height };
  const pipPoint = { x: landmarks[pipIndex].x * width, y: landmarks[pipIndex].y * height };

  const dx = pipPoint.x - mcpPoint.x;
  const dy = pipPoint.y - mcpPoint.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;

  const center = { x: mcpPoint.x + t * dx, y: mcpPoint.y + t * dy };
  const nx = -dy / len;
  const ny = dx / len;

  return {
    center,
    normal: { x: nx, y: ny },
    axis: { x: dx, y: dy },
    mcp: mcpPoint,
    pip: pipPoint,
  };
}

// ==============================
// Pixel sampling (tmp canvas)
// ==============================
const tmpCanvas = document.createElement("canvas");
const tmpCtx = tmpCanvas.getContext("2d", { willReadFrequently: true });

function updateTmpCanvasFromVideo() {
  const vw = videoElement.value?.videoWidth;
  const vh = videoElement.value?.videoHeight;
  if (!vw || !vh) return false;

  if (tmpCanvas.width !== vw || tmpCanvas.height !== vh) {
    tmpCanvas.width = vw;
    tmpCanvas.height = vh;
  }
  tmpCtx.drawImage(videoElement.value, 0, 0, vw, vh);
  return true;
}

function clampInt(value, min, max) {
  const v = Math.floor(value);
  return v < min ? min : v > max ? max : v;
}
function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
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
      if (idx >= 0 && idx < n) { sum += values[idx]; count++; }
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
  if (!peaks.length) return null;

  let chosen = peaks[0];
  for (const p of peaks) {
    if (preferNear ? (p.t < chosen.t) : (p.score > chosen.score)) chosen = p;
  }
  return { x: chosen.x, y: chosen.y, t: chosen.t, score: chosen.score };
}

// ==============================
// Finger thickness measurement
// ==============================
function measureFingerThicknessPixels(frame, fingerType) {
  if (!updateTmpCanvasFromVideo()) return null;

  const { center, normal: n, axis } = frame;
  const len = axis ? Math.hypot(axis.x, axis.y) : null;

  let maxStepPx, minD;
  const params = (fingerType === "thumb") ? THICKNESS_PARAMS.thumb : THICKNESS_PARAMS.others;

  if (len) {
    maxStepPx = clamp(len * params.maxStepFactor, params.maxStepMin, params.maxStepMax);
    minD = clamp(len * params.minDistFactor, params.minDistMin, params.minDistMax);
  } else {
    maxStepPx = params.fallbackMaxStep;
    minD = params.fallbackMinDist;
  }

  const edgePos = findEdgePeakAlongNormal(center, n, {
    maxStepPx, stepPx: 1, halfSize: 1, minD, preferNear: true,
  });
  const edgeNeg = findEdgePeakAlongNormal(center, { x: -n.x, y: -n.y }, {
    maxStepPx, stepPx: 1, halfSize: 1, minD, preferNear: true,
  });

  if (!edgePos || !edgeNeg) return null;

  const thicknessPx = edgePos.t + edgeNeg.t;
  return {
    thicknessPx,
    edgeLeft: { x: edgeNeg.x, y: edgeNeg.y },
    edgeRight: { x: edgePos.x, y: edgePos.y },
  };
}

// ==============================
// Size conversion (inchangé)
// ==============================
function getSizeFromDiameter(diameter) {
  if (diameter < 14) return { sizeEU: 44, sizeUS: 3 };
  if (diameter < 14.3) return { sizeEU: 45, sizeUS: 3.5 };
  if (diameter < 14.7) return { sizeEU: 46, sizeUS: 4 };
  if (diameter < 15) return { sizeEU: 47, sizeUS: 4.5 };
  if (diameter < 15.3) return { sizeEU: 48, sizeUS: 4.75 };
  if (diameter < 15.7) return { sizeEU: 49, sizeUS: 5 };
  if (diameter < 16.05) return { sizeEU: 50, sizeUS: 5.5 };
  if (diameter < 16.4) return { sizeEU: 51, sizeUS: 5.75 };
  if (diameter < 16.75) return { sizeEU: 52, sizeUS: 6 };
  if (diameter < 17.05) return { sizeEU: 53, sizeUS: 6.5 };
  if (diameter < 17.35) return { sizeEU: 54, sizeUS: 7 };
  if (diameter < 17.65) return { sizeEU: 55, sizeUS: 7.5 };
  if (diameter < 17.95) return { sizeEU: 56, sizeUS: 7.75 };
  if (diameter < 18.3) return { sizeEU: 57, sizeUS: 8 };
  if (diameter < 18.65) return { sizeEU: 58, sizeUS: 8.5 };
  if (diameter < 18.95) return { sizeEU: 59, sizeUS: 8.75 };
  if (diameter < 19.25) return { sizeEU: 60, sizeUS: 9 };
  if (diameter < 19.55) return { sizeEU: 61, sizeUS: 9.5 };
  if (diameter < 19.85) return { sizeEU: 62, sizeUS: 10 };
  if (diameter < 20.2) return { sizeEU: 63, sizeUS: 10.5 };
  if (diameter < 20.55) return { sizeEU: 64, sizeUS: 10.75 };
  if (diameter < 20.85) return { sizeEU: 65, sizeUS: 11 };
  if (diameter < 21.15) return { sizeEU: 66, sizeUS: 11.5 };
  if (diameter < 21.45) return { sizeEU: 67, sizeUS: 12 };
  if (diameter < 21.8) return { sizeEU: 68, sizeUS: 12.5 };
  if (diameter < 22.15) return { sizeEU: 69, sizeUS: 13 };
  if (diameter <= 22.3) return { sizeEU: 70, sizeUS: 13.5 };
  return { sizeEU: null, sizeUS: null };
}

function getStabilizedDiameter() {
  if (!diameterMeasurements.length) return 0;
  const sum = diameterMeasurements.reduce((a, b) => a + b, 0);
  return sum / diameterMeasurements.length;
}

// ==============================
// Result (pattern code 1)
// ==============================
function displayMeasurements(sizeEU, sizeUS) {
  if (sizeEU == null || sizeUS == null) return;
  resultEU.value = sizeEU;
  resultUS.value = sizeUS;
  resultDisplayed.value = true;
}

// ==============================
// Depth Provider (optionnel) + fallback hand-scale
// ==============================
const depthProvider = {
  type: "none",
  isReady: false,
  isAvailable() { return this.isReady; },
  getDepthMetersAt(_xPx, _yPx) { return null; },
  getFxPx() { return null; },
};

function handLengthPx(landmarks, vw, vh) {
  const wrist = landmarks[0];
  const middleTip = landmarks[12];
  const dx = (middleTip.x - wrist.x) * vw;
  const dy = (middleTip.y - wrist.y) * vh;
  return Math.hypot(dx, dy);
}

function diameterMmFromHandScale(thicknessPx, landmarks, vw, vh) {
  const hlPx = handLengthPx(landmarks, vw, vh);
  if (!hlPx || hlPx < 1) return null;
  const mmPerPx = EXPECTED_HAND_LENGTH_MM / hlPx;
  return thicknessPx * mmPerPx;
}

function computeDiameterMm({ thicknessPx, frameCenterPx, landmarks, vw, vh }) {
  if (depthProvider.isAvailable()) {
    const Zm = depthProvider.getDepthMetersAt(frameCenterPx.x, frameCenterPx.y);
    const fxPx = depthProvider.getFxPx();
    if (Zm && Zm > 0 && fxPx && fxPx > 0) {
      const mm = (thicknessPx * Zm / fxPx) * 1000;
      return { mm, method: depthProvider.type };
    }
  }
  const mmFallback = diameterMmFromHandScale(thicknessPx, landmarks, vw, vh);
  if (mmFallback != null) return { mm: mmFallback, method: "hand-scale" };
  return { mm: null, method: "none" };
}

// ==============================
// Measurement pipeline (du code 2)
// ==============================
function handleMeasurements(landmarks) {
  if (!currentFinger.value || currentFinger.value === "None") return;

  const vw = videoElement.value?.videoWidth;
  const vh = videoElement.value?.videoHeight;
  if (!vw || !vh) return;

  const t = FINGER_MEASURE_POS[currentFinger.value] ?? 0.55;
  const frame = getFingerMeasurementFrame(landmarks, currentFinger.value, vw, vh, t);
  if (!frame) return;

  const thicknessData = measureFingerThicknessPixels(frame, currentFinger.value);

  // freeze + debug (du code 2)
  freezeOnCurrentFrame();
  drawDebugPointsOnFreeze(frame, thicknessData);

  if (!thicknessData) return;

  const { mm: diameterMm, method } = computeDiameterMm({
    thicknessPx: thicknessData.thicknessPx,
    frameCenterPx: frame.center,
    landmarks,
    vw,
    vh,
  });

  measurementMethod.value = method;
  console.log("[MEASURE] method =", method, "diameterMm =", diameterMm);

  if (diameterMm == null || !Number.isFinite(diameterMm)) return;

  diameterMeasurements.push(diameterMm);
  if (diameterMeasurements.length > maxMeasurements) diameterMeasurements.shift();

  const stabilizedDiameter = getStabilizedDiameter();
  const { sizeEU, sizeUS } = getSizeFromDiameter(stabilizedDiameter);
  displayMeasurements(sizeEU, sizeUS);
}

// ==============================
// Freeze / Resume / Restart (du code 2, adapté)
// ==============================
function freezeOnCurrentFrame() {
  const rect = videoElement.value.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  const freezeCanvas = freezeCanvasEl.value;
  freezeCanvas.width = Math.round(rect.width * dpr);
  freezeCanvas.height = Math.round(rect.height * dpr);
  freezeCanvas.style.width = rect.width + "px";
  freezeCanvas.style.height = rect.height + "px";

  freezeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  freezeCtx.clearRect(0, 0, rect.width, rect.height);
  drawVideoCover(freezeCtx, videoElement.value, rect.width, rect.height);

  debugCanvasEl.value.style.display = "none";
  freezeCanvas.style.display = "block";
  isFrozen.value = true;

  videoElement.value.pause();
  try { if (camera && camera.stop) camera.stop(); } catch {}
  return true;
}

function drawVideoCover(ctx, video, destW, destH) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;

  const { sx, sy, sWidth, sHeight } = getCoverCrop(vw, vh, destW, destH);
  ctx.drawImage(video, sx, sy, sWidth, sHeight, 0, 0, destW, destH);
}

function resumeMeasurement() {
  if (!isFrozen.value) return;

  freezeCanvasEl.value.style.display = "none";
  isFrozen.value = false;

  debugCanvasEl.value.style.display = "block";

  videoElement.value.play().catch(() => {});
  try { if (camera && camera.start) camera.start(); } catch {}

  // On remet l'utilisateur en mode “choix doigt” / “nouvelle mesure”
  resultDisplayed.value = false;
  resultEU.value = null;
  resultUS.value = null;
  currentFinger.value = "None";
  measurementMethod.value = "unknown";
}

function restart() {
  // Reprend le flux vidéo
  resumeMeasurement();

  // Reset mesures
  diameterMeasurements.length = 0;

  // Reset UI
  resultDisplayed.value = false;
  resultEU.value = null;
  resultUS.value = null;

  currentFinger.value = "None";
  showInitialMessage.value = true;
  handDetected.value = false;

  measurementMethod.value = "unknown";

  hideDistanceMessage();
  setTimeout(() => { handDetected.value = true; }, 100);
}

// ==============================
// Debug overlay (du code 2, adapté au naming)
// ==============================
function drawLandmarkIndices(landmarks) {
  const vw = videoElement.value?.videoWidth;
  const vh = videoElement.value?.videoHeight;
  if (!vw || !vh) return;

  const { dw, dh } = syncDebugCanvasToDisplay();

  debugCtx.font = "14px Arial";
  debugCtx.fillStyle = "lime";
  debugCtx.strokeStyle = "black";
  debugCtx.lineWidth = 3;

  for (let i = 0; i < landmarks.length; i++) {
    const p = mapVideoToCover(landmarks[i].x * vw, landmarks[i].y * vh, dw, dh, isUserFacing.value);
    debugCtx.beginPath();
    debugCtx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
    debugCtx.fill();
    debugCtx.strokeText(String(i), p.x + 4, p.y - 4);
    debugCtx.fillText(String(i), p.x + 4, p.y - 4);
  }
}

function syncDebugCanvasToDisplay() {
  const rect = videoElement.value.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.round(rect.width * dpr);
  const targetH = Math.round(rect.height * dpr);

  const dbg = debugCanvasEl.value;
  if (dbg.width !== targetW || dbg.height !== targetH) {
    dbg.width = targetW;
    dbg.height = targetH;
  }

  debugCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  debugCtx.clearRect(0, 0, rect.width, rect.height);
  return { dw: rect.width, dh: rect.height, dpr };
}

function mapVideoToCover(xVideo, yVideo, displayW, displayH, mirrorX = true) {
  const vw = videoElement.value?.videoWidth;
  const vh = videoElement.value?.videoHeight;
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
  if (!freezeCanvasEl.value || freezeCanvasEl.value.style.display === "none") return;

  const rect = videoElement.value.getBoundingClientRect();
  const W = rect.width;
  const H = rect.height;

  const mirror = isUserFacing.value;
  freezeCtx.lineWidth = 4;

  if (frame?.center) {
    drawMappedPoint(freezeCtx, frame.center.x, frame.center.y, W, H, "yellow", 6, mirror);
  }
  if (thicknessData?.edgeLeft) {
    drawMappedPoint(freezeCtx, thicknessData.edgeLeft.x, thicknessData.edgeLeft.y, W, H, "red", 6, mirror);
  }
  if (thicknessData?.edgeRight) {
    drawMappedPoint(freezeCtx, thicknessData.edgeRight.x, thicknessData.edgeRight.y, W, H, "cyan", 6, mirror);
  }

  const leftOk = !!thicknessData?.edgeLeft;
  const rightOk = !!thicknessData?.edgeRight;

}

async function switchCamera() {
  desiredFacingMode.value =
    (desiredFacingMode.value === "environment") ? "user" : "environment";

  isUserFacing.value = (desiredFacingMode.value === "user");

  stopMediaPipe();
  await nextTick();
  initMediaPipe();
}

function getCoverCrop(vw, vh, displayW, displayH) {
  const videoAR = vw / vh;
  const destAR = displayW / displayH;

  let sx, sy, sWidth, sHeight;

  if (videoAR > destAR) {
    sHeight = vh;
    sWidth = vh * destAR;
    sx = (vw - sWidth) / 2;
    sy = 0;
  } else {
    sWidth = vw;
    sHeight = vw / destAR;
    sx = 0;
    sy = (vh - sHeight) / 2;
  }
  return { sx, sy, sWidth, sHeight };
}

// ==============================
// Lifecycle: init/cleanup mediapipe (du code 2)
// ==============================
async function initMediaPipe() {
  if (!videoElement.value) return;

  // contexts
  freezeCtx = freezeCanvasEl.value.getContext("2d");
  debugCtx = debugCanvasEl.value.getContext("2d");

  hands = new Hands({
    locateFile: (file) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
  });

  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.8,
    minTrackingConfidence: 0.8,
  });

  hands.onResults(onHandResults);

  // ✅ ICI : on synchronise le mode caméra → miroir ou non
  isUserFacing.value = (desiredFacingMode.value === "user");

  camera = new Camera(videoElement.value, {
    onFrame: async () => {
      await hands.send({ image: videoElement.value });
    },
    facingMode: desiredFacingMode.value, // "environment" ou "user"
  });

  camera.start();
}


function stopMediaPipe() {
  try { if (camera?.stop) camera.stop(); } catch {}
  hands = null;
  camera = null;
}

watch(isModalOpen, async (open) => {
  if (open) {
    await nextTick();
    initMediaPipe();
  } else {
    stopMediaPipe();

    // reset UI
    showInitialMessage.value = true;
    handDetected.value = false;
    hideDistanceMessage();

    resultDisplayed.value = false;
    resultEU.value = null;
    resultUS.value = null;

    isFrozen.value = false;
    currentFinger.value = "None";

    // visuels
    try {
      if (freezeCanvasEl.value) freezeCanvasEl.value.style.display = "none";
      if (debugCanvasEl.value) debugCanvasEl.value.style.display = "block";
    } catch {}
  }
});

onUnmounted(() => {
  stopMediaPipe();
});
</script>

<style scoped>
/* Style global (proche de tes versions) */
.baguier-root {
  margin: 0;
  padding: 0;
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100vh;
  width: 100vw;
  background-color: #f0f0f0;
  background-image: url("/images/base-sizing.jpg");
  background-repeat: no-repeat;
  background-position: center;
  background-size: cover;
}

/* bouton open */
#openModalButton {
  padding: 10px 20px;
  background-color: #4CAF50;
  color: white;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  font-size: 18px;
}
#openModalButton:hover { background-color: #000; }

/* modale */
.modal {
  position: fixed;
  z-index: 1000;
  left: 0; top: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0,0,0,0.5);
  justify-content: center;
  align-items: center;
  display: flex;
}

.modal-content {
  background-color: #fff;
  width: 90%;
  max-width: 400px;
  border-radius: 10px;
  position: relative;
  padding: 20px;
  box-shadow: 0 4px 8px rgba(0,0,0,0.2);
}

.close {
  color: #aaa;
  position: absolute;
  top: 10px;
  right: 15px;
  font-size: 28px;
  font-weight: bold;
  cursor: pointer;
}
.close:hover, .close:focus {
  color: black;
  text-decoration: none;
}

#videoContainer {
  position: relative;
  width: 100%;
  padding-top: 177.78%; /* 9:16 */
  overflow: hidden;
  background-color: black;
}

#videoContainer.mirrored #video { transform: scaleX(-1); }
#videoContainer.mirrored #freezeCanvas { transform: scaleX(-1); }

#video {
  position: absolute;
  top: 0; left: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: none;
}

#handMap {
  position: absolute;
  top: 0; left: 0;
  width: 100%;
  height: 100%;
  opacity: 0.5;
  pointer-events: none;
  z-index: 10;
}

#fingerSelection {
  text-align: center;
  margin-top: 10px;
}

.finger-button {
  margin: 3px;
  padding: 12px;
  cursor: pointer;
  background-color: #4CAF50;
  color: white;
  border: none;
  border-radius: 5px;
  font-size: 14px;
}
.finger-button:hover { background-color: #000; }

.selected {
  background-color: #4CAF50;
  color: white;
  border: 2px solid #000;
}

#initialMessage {
  display: flex;
  justify-content: center;
  align-items: center;
  width: 350px;
  height: 660px;
  background-color: #000;
  color: #fff;
  font-size: 22px;
  text-align: center;
  pointer-events: none;
  animation: fadeOut 10s forwards;
  position: absolute;
  z-index: 1000;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  opacity: 1;
  padding: 25px;
  font-family: arial;
  line-height: 1.2;
}

@keyframes fadeOut {
  0% { opacity: 1; }
  80% { opacity: 0.7; }
  100% { opacity: 0; visibility: hidden; }
}

h1 {
  font-size: 24px;
  margin-top: 10px;
  text-align: center;
  font-family: arial;
}

#resultCircle {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  color: green;
  font-size: 24px;
  font-family: Arial, sans-serif;
  text-align: center;
  z-index: 30;
}

.result-bubble {
  border-radius: 50%;
  width: 250px;
  height: 250px;
  opacity: 0.95;
  background-color: black;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  color: green;
  font-size: 24px;
  font-family: Arial, sans-serif;
  text-align: center;
  z-index: 20;
}

.methodText{
  margin-top: 10px;
  font-size: 14px;
  opacity: 0.9;
  color: #9aff9a;
}

#newMeasurementButton {
  padding: 10px 10px;
  background-color: #4CAF50;
  color: white;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  position: absolute;
  bottom: -50px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 21;
  width: 150px;
}

#distanceCircle {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  color: green;
  font-size: 24px;
  font-family: Arial, sans-serif;
  text-align: center;
  z-index: 1000;
  width: 250px;
  height: 250px;
  border-radius: 50%;
  opacity: 0.9;
}

#debugCanvas {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 25;
  pointer-events: none;
}

#freezeCanvas {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 20;
  display: none;
  pointer-events: none;
  transform: none;
}

#resumeBtn {
  position: absolute;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 60;
  padding: 10px 14px;
  background: #4CAF50;
  color: white;
  border: none;
  border-radius: 5px;
  font-size: 14px;
  cursor: pointer;
}

.hidden { display: none !important; }
</style>
