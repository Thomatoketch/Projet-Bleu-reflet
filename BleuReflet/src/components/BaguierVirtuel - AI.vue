<template>
  <div class="baguier-root">
    <div id="appcov" v-show="!isModalOpen">
      <button id="openModalButton" @click="openModal">Ouvrir l'Application</button>
    </div>

    <div id="modal" class="modal" :style="{ display: isModalOpen ? 'flex' : 'none' }">
      <div class="modal-content">
        <span class="close" @click="closeModal">&times;</span>
        <h1>Votre baguier virtuel</h1>

        <div id="initialMessage" v-show="showInitialMessage">
          Veuillez positionner votre main de manière à ce qu'elle s'aligne parfaitement avec la silhouette affichée à l'écran,
          en veillant à ce que tous les bords de votre main soient bien dans les limites du cadre vert.
        </div>

        <div id="videoContainer">
          <video ref="videoElement" id="video" autoplay playsinline muted></video>
          <canvas ref="debugCanvasEl" id="debugCanvas"></canvas>

          <img
            id="handMap"
            :src="currentHandFilter"
            alt="Contour de la main"
            :style="{ display: handDetected ? 'block' : 'none' }"
          />

          <div id="distanceCircle" :class="{ hidden: !distanceMessage || resultDisplayed }">
            <span id="distanceText">{{ distanceMessage }}</span>
          </div>

          <div id="resultCircle" :class="{ hidden: !resultDisplayed }">
            <span id="resultText">
              <span v-if="resultEU" class="result-bubble">
                {{ resultEU }} EU | {{ resultUS }} US
              </span>
            </span>

            <button
              id="newMeasurementButton"
              :class="{ hidden: !resultDisplayed }"
              @click="restart"
            >
              Nouvelle Mesure
            </button>
          </div>
        </div>

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
// ======================================================
// Imports
// ======================================================
import { ref, onUnmounted, nextTick } from "vue";
import { Hands } from "@mediapipe/hands";
import { Camera } from "@mediapipe/camera_utils";
import * as tf from "@tensorflow/tfjs";
import * as depthEstimation from "@tensorflow-models/depth-estimation";

// ======================================================
// Reactive UI State (ce que l’UI affiche)
// ======================================================
const isModalOpen = ref(false);
const showInitialMessage = ref(true);
const handDetected = ref(false);

const videoElement = ref(null);
const debugCanvasEl = ref(null);

const currentFinger = ref("None");
const currentHandFilter = ref("./images/filter_left.png");

const distanceMessage = ref("");   // message "rapprochez/éloignez"
const resultDisplayed = ref(false);
const resultEU = ref(null);
const resultUS = ref(null);

// Mode calibration (si true : on met à jour la constante CALIB_K)
const isCalibrating = ref(false);
const knownDiameterMm = ref(18.0);

// Debug depth (optionnel UI)
const depthReady = ref(false);

// ======================================================
// Constants / Configuration (réglages du système)
// ======================================================
const fingers = [
  { key: "thumb", label: "Pouce" },
  { key: "index", label: "Index" },
  { key: "middle", label: "Majeur" },
  { key: "ring", label: "Annulaire" },
  { key: "pinky", label: "Auriculaire" },
];

const MAX_MEASUREMENTS = 10;          // nombre max d’échantillons pour lisser
const DEPTH_INTERVAL_MS = 200;        // limite la fréquence de depth (~5 FPS)

// Conversion px -> mm via depth : mm = px * (CALIB_K * z)
// (CALIB_K se calibre une fois, z est la profondeur relative du modèle)
let CALIB_K = 0.06;

// ======================================================
// Non-reactive Runtime State (objets / buffers internes)
// ======================================================
let handsDetector = null;
let camera = null;

let lastLandmarks = null;
let lastVW = 0;
let lastVH = 0;

let diameterMeasurements = [];

let debugCtx = null;
let frozen = false;

// Depth model + buffers
let depthModel = null;
const depthMapIA = ref(null); // Float32Array
const depthW = ref(0);
const depthH = ref(0);
let depthBusy = false;
let lastDepthTs = 0;

// Canvas temporaire (lecture pixels vidéo)
const tmpCanvas = document.createElement("canvas");
const tmpCtx = tmpCanvas.getContext("2d", { willReadFrequently: true });

// ======================================================
// Canvas Helpers (dessin debug + mapping cover/mirror)
// ======================================================
/**
 * Synchronise le canvas debug avec la taille affichée de la vidéo (CSS pixels).
 * clear=true : efface le canvas (redraw complet)
 */
const syncDebugCanvasToDisplay = (clear = true) => {
  const video = videoElement.value;
  const canvas = debugCanvasEl.value;
  if (!video || !canvas) return null;

  if (!debugCtx) debugCtx = canvas.getContext("2d");
  if (!debugCtx) return null;

  const rect = video.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;

  const w = Math.round(rect.width * dpr);
  const h = Math.round(rect.height * dpr);

  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }

  // on dessine en "CSS pixels"
  debugCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  if (clear) debugCtx.clearRect(0, 0, rect.width, rect.height);

  return { dw: rect.width, dh: rect.height };
};

/**
 * Convertit un point vidéo (px) -> point affiché (px) en mode cover + miroir.
 * mirrorX=true pour correspondre à la caméra frontale.
 */
const mapVideoToCover = (xVideo, yVideo, displayW, displayH, mirrorX = true) => {
  const vw = videoElement.value?.videoWidth;
  const vh = videoElement.value?.videoHeight;
  if (!vw || !vh) return { x: 0, y: 0 };

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

  const nx = (xVideo - sx) / sWidth;
  const ny = (yVideo - sy) / sHeight;

  let x = nx * displayW;
  let y = ny * displayH;

  if (mirrorX) x = displayW - x;
  return { x, y };
};

const drawLandmarkDots = (landmarks) => {
  if (!debugCtx) return;

  const vw = videoElement.value?.videoWidth;
  const vh = videoElement.value?.videoHeight;
  if (!vw || !vh) return;

  const s = syncDebugCanvasToDisplay(true);
  if (!s) return;

  debugCtx.fillStyle = "lime";
  debugCtx.strokeStyle = "black";
  debugCtx.lineWidth = 2;

  for (let i = 0; i < landmarks.length; i++) {
    const xV = landmarks[i].x * vw;
    const yV = landmarks[i].y * vh;
    const p = mapVideoToCover(xV, yV, s.dw, s.dh, true);

    debugCtx.beginPath();
    debugCtx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
    debugCtx.fill();
    debugCtx.stroke();
  }
};

const drawTwoFingerEdgeDots = (edgeL, edgeR) => {
  if (!debugCtx || !edgeL || !edgeR) return;

  const s = syncDebugCanvasToDisplay(false);
  if (!s) return;

  debugCtx.fillStyle = "cyan";
  debugCtx.strokeStyle = "black";
  debugCtx.lineWidth = 2;

  const pL = mapVideoToCover(edgeL.x, edgeL.y, s.dw, s.dh, true);
  const pR = mapVideoToCover(edgeR.x, edgeR.y, s.dw, s.dh, true);

  debugCtx.beginPath();
  debugCtx.arc(pL.x, pL.y, 6, 0, Math.PI * 2);
  debugCtx.fill();
  debugCtx.stroke();

  debugCtx.beginPath();
  debugCtx.arc(pR.x, pR.y, 6, 0, Math.PI * 2);
  debugCtx.fill();
  debugCtx.stroke();
};

// ======================================================
// Finger Edge Detection (mesure de largeur en pixels)
// ======================================================
/**
 * Copie la frame vidéo courante dans tmpCanvas pour lire des pixels.
 */
const updateTmpCanvasFromVideo = () => {
  const vw = videoElement.value?.videoWidth;
  const vh = videoElement.value?.videoHeight;
  if (!vw || !vh) return false;

  if (tmpCanvas.width !== vw || tmpCanvas.height !== vh) {
    tmpCanvas.width = vw;
    tmpCanvas.height = vh;
  }

  tmpCtx.drawImage(videoElement.value, 0, 0, vw, vh);
  return true;
};

const getGrayAtPatch = (x, y, halfSize = 1) => {
  const vw = tmpCanvas.width;
  const vh = tmpCanvas.height;

  const xi = Math.max(0, Math.min(vw - 1, Math.round(x)));
  const yi = Math.max(0, Math.min(vh - 1, Math.round(y)));

  const patch = 2 * halfSize + 1;
  const x0 = Math.max(0, Math.min(vw - patch, xi - halfSize));
  const y0 = Math.max(0, Math.min(vh - patch, yi - halfSize));

  const data = tmpCtx.getImageData(x0, y0, patch, patch).data;

  let sum = 0;
  const n = patch * patch;
  for (let i = 0; i < n; i++) {
    const k = i * 4;
    const r = data[k];
    const g = data[k + 1];
    const b = data[k + 2];
    sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  return sum / n;
};

const smooth1D = (arr, k = 2) => {
  const out = arr.slice();
  for (let i = 0; i < arr.length; i++) {
    let s = 0;
    let c = 0;
    for (let j = -k; j <= k; j++) {
      const idx = i + j;
      if (idx >= 0 && idx < arr.length) {
        s += arr[idx];
        c++;
      }
    }
    out[i] = s / c;
  }
  return out;
};

/**
 * Cherche un bord (fort gradient) en échantillonnant le long d’une normale.
 * Retourne le premier pic "solide" (le plus proche du centre).
 */
const findEdgePeakAlongNormal = (
  center,
  normal,
  { maxStepPx = 55, stepPx = 1, halfSize = 1, minD = 6 } = {}
) => {
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

  // Seuil adaptatif simple (p90)
  const sorted = grad.slice().sort((a, b) => a - b);
  const p90 = sorted[Math.floor(sorted.length * 0.9)] || 0;
  const threshold = Math.max(6, p90 * 0.55);

  let best = null;
  for (let i = 2; i < grad.length - 2; i++) {
    const t = coords[i].t;
    if (t < minD) continue;

    const g = grad[i];
    const isLocalMax =
      g > grad[i - 1] &&
      g >= grad[i + 1] &&
      g > grad[i - 2] &&
      g >= grad[i + 2];

    if (isLocalMax && g >= threshold) {
      if (!best || t < best.t) best = { x: coords[i].x, y: coords[i].y, t };
    }
  }
  return best;
};

// Indices MediaPipe pour définir l’axe du doigt (MCP -> PIP)
const FINGER_INDICES = {
  thumb: { mcp: 2, pip: 3 },
  index: { mcp: 5, pip: 6 },
  middle: { mcp: 9, pip: 10 },
  ring: { mcp: 13, pip: 14 },
  pinky: { mcp: 17, pip: 18 },
};

// Position du point de mesure le long du doigt (0..1)
const FINGER_MEASURE_POS = {
  thumb: 0.3,
  index: 0.55,
  middle: 0.55,
  ring: 0.55,
  pinky: 0.65,
};

/**
 * Calcule le repère local du doigt:
 * - center: point où mesurer (px)
 * - normal: direction perpendiculaire pour chercher les bords
 */
const getFingerFrame = (landmarks, fingerKey, vw, vh) => {
  const idx = FINGER_INDICES[fingerKey];
  if (!idx) return null;

  const mcp = { x: landmarks[idx.mcp].x * vw, y: landmarks[idx.mcp].y * vh };
  const pip = { x: landmarks[idx.pip].x * vw, y: landmarks[idx.pip].y * vh };

  const dx = pip.x - mcp.x;
  const dy = pip.y - mcp.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;

  const t = FINGER_MEASURE_POS[fingerKey] ?? 0.55;
  const center = { x: mcp.x + t * dx, y: mcp.y + t * dy };

  // normale à l’axe (dx,dy)
  const nx = -dy / len;
  const ny = dx / len;

  return { center, normal: { x: nx, y: ny } };
};

/**
 * Mesure les deux bords du doigt (gauche/droite) et renvoie thicknessPx.
 */
const measureFingerEdges = (frame, fingerKey) => {
  if (!updateTmpCanvasFromVideo()) return null;

  const maxStepPx = fingerKey === "thumb" ? 75 : 55;
  const minD = fingerKey === "thumb" ? 8 : 6;

  const pos = findEdgePeakAlongNormal(frame.center, frame.normal, { maxStepPx, minD });
  const neg = findEdgePeakAlongNormal(frame.center, { x: -frame.normal.x, y: -frame.normal.y }, { maxStepPx, minD });

  if (!pos || !neg) return null;

  return {
    edgeLeft: { x: neg.x, y: neg.y },
    edgeRight: { x: pos.x, y: pos.y },
    thicknessPx: pos.t + neg.t,
    center: frame.center,
  };
};

// ======================================================
// Freeze (figer l’image après sélection)
// ======================================================
/**
 * Dessine la frame vidéo figée dans le canvas debug (cover + mirror).
 */
const freezeCameraFrame = () => {
  if (!videoElement.value || !debugCtx) return;

  const s = syncDebugCanvasToDisplay(true);
  if (!s) return;

  const vw = videoElement.value.videoWidth;
  const vh = videoElement.value.videoHeight;
  if (!vw || !vh) return;

  const videoAR = vw / vh;
  const destAR = s.dw / s.dh;

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

  debugCtx.save();
  debugCtx.translate(s.dw, 0);
  debugCtx.scale(-1, 1);
  debugCtx.drawImage(videoElement.value, sx, sy, sWidth, sHeight, 0, 0, s.dw, s.dh);
  debugCtx.restore();
};

const freezeNow = () => {
  if (frozen) return;
  frozen = true;

  freezeCameraFrame();

  // stop loop MediaPipe (sans couper les tracks)
  try { camera?.stop?.(); } catch {}
  try { videoElement.value?.pause?.(); } catch {}
};

// ======================================================
// Camera Lifecycle (ouvrir/stopper proprement)
// ======================================================
const requestCamera = async () => {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user" },
    audio: false,
  });

  const video = videoElement.value;
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
};

const stopTracksOnly = () => {
  const v = videoElement.value;
  if (!v?.srcObject) return;
  v.srcObject.getTracks().forEach((t) => t.stop());
  v.srcObject = null;
};

const stopLoopOnly = () => {
  try { camera?.stop?.(); } catch {}
  camera = null;
  frozen = false;
};

const stopAllHard = () => {
  try { camera?.stop?.(); } catch {}
  camera = null;

  try { handsDetector?.close?.(); } catch {}
  handsDetector = null;

  stopTracksOnly();
  frozen = false;
};

// ======================================================
// Depth Model (charge + update depth map)
// ======================================================
/**
 * Initialise le backend TFJS + charge le modèle depth.
 */
const initDepthModel = async () => {
  if (depthModel) {
    depthReady.value = true;
    return;
  }

  // backend préféré : webgl, sinon wasm
  try {
    await tf.setBackend("webgl");
    await tf.ready();
  } catch {
    await tf.setBackend("wasm");
    await tf.ready();
  }

  const model = depthEstimation.SupportedModels.ARPortraitDepth;
  depthModel = await depthEstimation.createEstimator(model, { quantizationBytes: 2 });
  depthReady.value = true;
};

/**
 * Met à jour depthMapIA en limitant la fréquence (DEPTH_INTERVAL_MS).
 * Stocke toujours un buffer 1D + ses dimensions (depthW/depthH).
 */
const updateDepthMapIA = async () => {
  if (!depthReady.value || !videoElement.value || !depthModel) return;
  if (depthBusy) return;

  const now = performance.now();
  if (now - lastDepthTs < DEPTH_INTERVAL_MS) return;

  const vw = videoElement.value.videoWidth;
  const vh = videoElement.value.videoHeight;
  if (!vw || !vh) return;

  depthBusy = true;
  lastDepthTs = now;

  // capture frame -> canvas pour le modèle depth
  const canvas = document.createElement("canvas");
  canvas.width = vw;
  canvas.height = vh;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(videoElement.value, 0, 0);

  try {
    const estimation = await depthModel.estimateDepth(canvas, { minDepth: 0.1, maxDepth: 1.0 });

    if (estimation?.depthMap) {
      depthMapIA.value = estimation.depthMap;
      depthW.value = estimation.width ?? estimation.depthMapWidth ?? vw;
      depthH.value = estimation.height ?? estimation.depthMapHeight ?? vh;
      return;
    }

    if (estimation?.depthTensor) {
      const t = estimation.depthTensor;
      depthMapIA.value = await t.data();
      depthH.value = t.shape?.[0] ?? vh;
      depthW.value = t.shape?.[1] ?? vw;
      return;
    }
  } finally {
    depthBusy = false;
  }
};

/**
 * Lit la profondeur au point (xVideo,yVideo) exprimé en pixels vidéo.
 */
const getDepthAtIA = (xVideo, yVideo) => {
  const map = depthMapIA.value;
  if (!map) return null;

  const vw = videoElement.value?.videoWidth || 0;
  const vh = videoElement.value?.videoHeight || 0;
  const w = depthW.value;
  const h = depthH.value;
  if (!vw || !vh || !w || !h) return null;

  const x = xVideo * (w / vw);
  const y = yVideo * (h / vh);

  const xi = Math.max(0, Math.min(w - 1, Math.round(x)));
  const yi = Math.max(0, Math.min(h - 1, Math.round(y)));
  const idx = yi * w + xi;

  if (idx < 0 || idx >= map.length) return null;

  const z = map[idx];
  return Number.isFinite(z) ? z : null;
};

// ======================================================
// MediaPipe Hands (détection + callback résultats)
// ======================================================
const initMediaPipe = () => {
  if (!videoElement.value) return;
  if (debugCanvasEl.value && !debugCtx) debugCtx = debugCanvasEl.value.getContext("2d");

  if (!handsDetector) {
    handsDetector = new Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
    });

    handsDetector.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.8,
      minTrackingConfidence: 0.8,
    });

    handsDetector.onResults(onResults);
  }

  camera = new Camera(videoElement.value, {
    onFrame: async () => {
      const video = videoElement.value;
      if (!video) return;
      if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return;

      if (depthReady.value) await updateDepthMapIA();

      if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return;
      await handsDetector.send({ image: video });
    },
    width: 1280,
    height: 720,
  });

  camera.start();
};

const onResults = (results) => {
  if (frozen) return;

  const hasHand = results.multiHandLandmarks?.length > 0;
  if (!hasHand) {
    handDetected.value = false;
    showInitialMessage.value = true;

    lastLandmarks = null;
    lastVW = 0;
    lastVH = 0;

    syncDebugCanvasToDisplay(true);
    return;
  }

  showInitialMessage.value = false;
  handDetected.value = true;

  const landmarks = results.multiHandLandmarks[0];

  lastLandmarks = landmarks;
  lastVW = videoElement.value?.videoWidth || 0;
  lastVH = videoElement.value?.videoHeight || 0;

  updateHandMap(classifyHand(landmarks));
  estimateHandSize(landmarks);

  syncDebugCanvasToDisplay(true);
  drawLandmarkDots(landmarks);
};

// ======================================================
// Hand Guidance (message "rapprochez / éloignez")
// ======================================================
const estimateHandSize = (landmarks) => {
  const wrist = landmarks[0];
  const middleFingerTip = landmarks[12];

  const width = videoElement.value?.videoWidth || 640;
  const height = videoElement.value?.videoHeight || 480;

  const xDiff = (middleFingerTip.x - wrist.x) * width;
  const yDiff = (middleFingerTip.y - wrist.y) * height;

  const handSize = Math.sqrt(xDiff * xDiff + yDiff * yDiff);

  const expectedHandSizeAt25cm = 170;
  const minHandSizeAt25cm = 140;
  const maxHandSizeAt25cm = 190;

  const distanceFactor = handSize / expectedHandSizeAt25cm;
  const tol = 0.1;

  let msg = "";
  if (handSize < minHandSizeAt25cm) msg = "Rapprochez votre main.";
  else if (handSize > maxHandSizeAt25cm) msg = "Éloignez votre main.";
  else if (distanceFactor < 1 - tol) msg = "Rapprochez votre main.";
  else if (distanceFactor > 1 + tol) msg = "Éloignez votre main.";
  else {
    msg = "Main bien positionnée.";
    setTimeout(() => {
      if (distanceMessage.value === "Main bien positionnée.") distanceMessage.value = "";
    }, 2000);
  }

  distanceMessage.value = msg;
};

// ======================================================
// Hand Side (Left/Right) + Overlay (filtre)
// ======================================================
const classifyHand = (landmarks) => {
  const thumbTip = landmarks[4];
  const wrist = landmarks[0];
  return thumbTip.x < wrist.x ? "Left" : "Right";
};

const updateHandMap = (handType) => {
  currentHandFilter.value = handType === "Right"
    ? "./images/filter_right.png"
    : "./images/filter_left.png";
};

// ======================================================
// Depth Sampling Utilities (robust: median of 3 points)
// ======================================================
const median3 = (a, b, c) => {
  const arr = [a, b, c].filter((v) => Number.isFinite(v));
  if (arr.length === 0) return null;
  arr.sort((x, y) => x - y);
  return arr[Math.floor(arr.length / 2)];
};

/**
 * Prend z à gauche, droite, centre -> médiane (stable).
 */
const getDepthForEdges = (edgeLeft, edgeRight, center) => {
  const zL = getDepthAtIA(edgeLeft.x, edgeLeft.y);
  const zR = getDepthAtIA(edgeRight.x, edgeRight.y);
  const zC = center ? getDepthAtIA(center.x, center.y) : null;
  return { zL, zR, zC, z: median3(zL, zR, zC) };
};

// ======================================================
// Ring Measurement (px -> mm -> EU/US)
// ======================================================
const pxToMmWithDepth = (px, z) => {
  if (!Number.isFinite(px) || !Number.isFinite(z)) return null;
  return px * (CALIB_K * z);
};

const calibrateK = (pxWidth, z, knownMm) => {
  if (!Number.isFinite(pxWidth) || !Number.isFinite(z) || !Number.isFinite(knownMm)) return;
  CALIB_K = knownMm / (pxWidth * z);
};

/**
 * Ajoute un échantillon, lisse, convertit en tailles.
 */
const handleMeasurements = (widthPx, z) => {
  if (!Number.isFinite(widthPx) || !Number.isFinite(z)) return;

  const diameterMm = pxToMmWithDepth(widthPx, z);
  if (!Number.isFinite(diameterMm)) return;

  diameterMeasurements.push(diameterMm);
  if (diameterMeasurements.length > MAX_MEASUREMENTS) diameterMeasurements.shift();

  const stabilized =
    diameterMeasurements.reduce((a, b) => a + b, 0) / diameterMeasurements.length;

  const { sizeEU, sizeUS } = getSize(stabilized);
  displayMeasurements(sizeEU, sizeUS);
};

const displayMeasurements = (eu, us) => {
  if (!eu || !us) return;
  distanceMessage.value = "";
  resultEU.value = eu;
  resultUS.value = us;
  resultDisplayed.value = true;
};

// ======================================================
// Size Table (diamètre mm -> taille EU/US)
// ======================================================
const getSize = (diameter) => {
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
};

// ======================================================
// Finger Selection (clic utilisateur -> mesure + freeze)
// ======================================================
const resetResults = () => {
  diameterMeasurements = [];
  resultDisplayed.value = false;
  resultEU.value = null;
  resultUS.value = null;
};

const selectFinger = async (fingerKey) => {
  currentFinger.value = fingerKey;
  resetResults();

  if (!lastLandmarks || !lastVW || !lastVH) return;

  const frame = getFingerFrame(lastLandmarks, fingerKey, lastVW, lastVH);
  if (!frame) return;

  const edges = measureFingerEdges(frame, fingerKey);
  if (!edges) return;

  // Depth fraîche au moment du clic
  await updateDepthMapIA();

  const center = edges.center ?? frame.center;
  const { z } = getDepthForEdges(edges.edgeLeft, edges.edgeRight, center);
  if (z == null) return;

  // Freeze + dessin debug
  freezeNow();
  drawTwoFingerEdgeDots(edges.edgeLeft, edges.edgeRight);

  console.log("Largeur actuele est Z : ", z);
  // Calibration ou mesure
  if (isCalibrating.value) {
    calibrateK(edges.thicknessPx, z, knownDiameterMm.value);
    isCalibrating.value = false;
    return;
  }

  handleMeasurements(edges.thicknessPx, z);
};

// ======================================================
// Modal Lifecycle (open/close/restart/reset)
// ======================================================
const resetUIState = () => {
  resetResults();
  showInitialMessage.value = true;
  handDetected.value = false;
  distanceMessage.value = "";
  currentFinger.value = "None";

  lastLandmarks = null;
  lastVW = 0;
  lastVH = 0;

  frozen = false;
  if (debugCtx) syncDebugCanvasToDisplay(true);
};

const openModal = async () => {
  isModalOpen.value = true;
  await nextTick();

  frozen = false;
  resetUIState();

  if (debugCanvasEl.value) debugCtx = debugCanvasEl.value.getContext("2d");

  try {
    await requestCamera();
  } catch (e) {
    console.error("Camera error:", e);
    distanceMessage.value = "Caméra bloquée (HTTPS/permissions).";
    return;
  }

  try {
    await initDepthModel();
    await updateDepthMapIA(); // warmup
  } catch (e) {
    console.error("Depth error:", e);
  }

  initMediaPipe();
};

const closeModal = () => {
  isModalOpen.value = false;
  stopAllHard();
  resetUIState();
};

const restart = async () => {
  stopLoopOnly();
  resetUIState();

  try {
    await requestCamera();
  } catch (e) {
    console.error("Camera error:", e);
    distanceMessage.value = "Caméra bloquée (HTTPS/permissions).";
    return;
  }

  camera = new Camera(videoElement.value, {
    onFrame: async () => {
      const video = videoElement.value;
      if (!video) return;
      if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return;

      if (depthReady.value) await updateDepthMapIA();

      if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return;
      await handsDetector.send({ image: video });
    },
    width: 1280,
    height: 720,
  });

  camera.start();
};

// ======================================================
// Cleanup
// ======================================================
onUnmounted(() => {
  stopAllHard();
});

// ======================================================
// Exports implicites (utilisés dans le template)
// - openModal, closeModal, restart
// - selectFinger, fingers
// - state: isModalOpen, currentFinger, currentHandFilter, distanceMessage, resultDisplayed, resultEU, resultUS, handDetected, showInitialMessage
// - calibration: isCalibrating, knownDiameterMm
// ======================================================
</script>


<style scoped>
/* CSS COPIÉ DEPUIS index.html POUR UNE FIDÉLITÉ PARFAITE */

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

#openModalButton {
  padding: 10px 20px;
  background-color: #4caf50;
  color: white;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  font-size: 18px;
}
#openModalButton:hover {
  background-color: #000;
}

.modal {
  display: none;
  position: fixed;
  z-index: 1000;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.5);
  justify-content: center;
  align-items: center;
}

.modal-content {
  background-color: #fff;
  width: 90%;
  max-width: 400px;
  border-radius: 10px;
  position: relative;
  padding: 20px;
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
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
.close:hover,
.close:focus {
  color: black;
  text-decoration: none;
}

#videoContainer {
  position: relative;
  width: 100%;
  padding-top: 177.78%;
  overflow: hidden;
  background-color: black;
}

#video {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scaleX(-1);
}

#debugCanvas {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 100;
  pointer-events: none;
}

#handMap {
  display: none;
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  opacity: 0.5;
  pointer-events: none;
  z-index: 10;
}

#fingerSelection,
#restartButton {
  text-align: center;
  margin-top: 10px;
}

.finger-button {
  margin: 3px;
  padding: 12px;
  cursor: pointer;
  background-color: #4caf50;
  color: white;
  border: none;
  border-radius: 5px;
  font-size: 14px;
}
.finger-button:hover {
  background-color: #000;
}

.selected {
  background-color: #4caf50;
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
  z-index: 100;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  opacity: 1;
  padding: 25px;
  font-family: arial;
  line-height: 1.2;
}

@keyframes fadeOut {
  0% {
    opacity: 1;
  }
  80% {
    opacity: 0.7;
  }
  100% {
    opacity: 0;
    visibility: hidden;
  }
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
  z-index: 200;
}

.result-bubble {
  border-radius: 50%;
  width: 250px;
  height: 250px;
  opacity: 0.95;
  display: block;
  background-color: black;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  color: green;
  font-size: 24px;
  font-family: Arial, sans-serif;
  text-align: center;
}

#newMeasurementButton {
  padding: 10px 10px;
  background-color: #4caf50;
  color: white;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  position: absolute;
  bottom: -50px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 200;
  width: 150px;
}

.hidden {
  display: none !important;
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
  z-index: 190;
  width: 250px;
  height: 250px;
  border-radius: 50%;
  opacity: 0.9;
}
</style>
