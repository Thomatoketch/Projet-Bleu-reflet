import { ref } from 'vue';
import { Hands } from '@mediapipe/hands';
import { Camera } from '@mediapipe/camera_utils';
import { getRingSize, calculateFingerDiameter, pixelsToMm, estimateRatioFromHand, FINGERS_CONFIG } from '../utils/ringMath';
import { saveMeasurement } from '../services/api';

// --- États Réactifs ---
export const isModalOpen = ref(false);
export const showInitialMessage = ref(true);
export const handDetected = ref(false);
export const videoElement = ref(null);
export const freezeCanvasEl = ref(null);
export const debugCanvasEl = ref(null);
export const currentFinger = ref('None');
export const currentHandFilter = ref('./images/hand_filter_left_top.png');
export const distanceMessage = ref('');
export const resultDisplayed = ref(false);
export const isFrozen = ref(false);
export const resultEU = ref(null);
export const measuredDiameter = ref(0);
export const confidenceLevel = ref('Moyenne');
export { FINGERS_CONFIG };

// --- Variables internes ---
let diameterMeasurements = [];
let handsDetector = null;
let camera = null;
let freezeCtx = null;
let debugCtx = null;
const maxMeasurements = 15;
const tmpCanvas = document.createElement("canvas");
const tmpCtx = tmpCanvas.getContext("2d", { willReadFrequently: true });
let stabilityBuffer = []; 
const REQUIRED_STABLE_FRAMES = 7; // Nombre de mesures cohérentes avant de valider
const TOLERANCE_MM = 0.5; // Écart maximum autorisé entre les mesures pour être jugées "cohérentes"

const FINGER_INDICES = { thumb: { mcp: 2, pip: 3 }, index: { mcp: 5, pip: 6 }, middle: { mcp: 9, pip: 10 }, ring: { mcp: 13, pip: 14 }, pinky: { mcp: 17, pip: 18 } };
const THICKNESS_PARAMS = {
  thumb: { maxStepMin: 40, maxStepMax: 85, maxStepFactor: 0.55, minDistMin: 8, minDistMax: 16, minDistFactor: 0.12, fallbackMaxStep: 65, fallbackMinDist: 8 },
  others: { maxStepMin: 30, maxStepMax: 60, maxStepFactor: 0.35, minDistMin: 6, minDistMax: 12, minDistFactor: 0.08, fallbackMaxStep: 55, fallbackMinDist: 6 }
};
const FINGER_MEASURE_POS = { thumb: 0.30, index: 0.55, middle: 0.55, ring: 0.55, pinky: 0.65 };

// --- Méthodes d'interface ---
export const openModal = () => {
  isModalOpen.value = true;
  setTimeout(() => initMediaPipe(), 100);
};

export const closeModal = () => {
  isModalOpen.value = false;
  if (camera) camera.stop();
};

export const selectFinger = (f) => { currentFinger.value = f; };

export const resumeMeasurement = () => {
  isFrozen.value = false;
  if (freezeCanvasEl.value) freezeCanvasEl.value.style.display = "none";
  if (videoElement.value) videoElement.value.play();
  resultDisplayed.value = false;
  diameterMeasurements = [];
  requestAnimationFrame(predictWebcam);
};

export const restart = () => {
  resumeMeasurement();
  currentFinger.value = 'None';
};

// --- Initialisation Technique ---
const initMediaPipe = async () => {
  if (!videoElement.value) return;
  freezeCtx = freezeCanvasEl.value.getContext("2d");
  debugCtx = debugCanvasEl.value.getContext("2d");

  handsDetector = new Hands({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}` });
  handsDetector.setOptions({ maxNumHands: 1, modelComplexity: 1, minDetectionConfidence: 0.8, minTrackingConfidence: 0.8 });
  handsDetector.onResults(onResults);

  camera = new Camera(videoElement.value, {
    onFrame: async () => {
      if (videoElement.value && !isFrozen.value) {
        await handsDetector.send({ image: videoElement.value });
      }
    },
    width: 1280, height: 720
  });

  camera.start().catch(() => alert("Erreur Caméra. Vérifiez HTTPS."));
};

const predictWebcam = async () => {
  if (videoElement.value && handsDetector && isModalOpen.value && !isFrozen.value) {
    if (videoElement.value.videoWidth > 0 && videoElement.value.videoHeight > 0) {
      await handsDetector.send({ image: videoElement.value });
    }
    requestAnimationFrame(predictWebcam);
  }
};

const onResults = (results) => {
  if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
    if (!handDetected.value) showInitialMessage.value = true;
    return;
  }
  showInitialMessage.value = false;
  handDetected.value = true;
  const landmarks = results.multiHandLandmarks[0];
  updateHandMap(landmarks[4].x < landmarks[0].x ? "Left" : "Right");
  estimateHandSize(landmarks);
  if (currentFinger.value !== 'None' && !resultDisplayed.value && !isFrozen.value) handleMeasurements(landmarks);
};

// --- Logique de Mesure Stabilisée ---
const handleMeasurements = (landmarks) => {
  const width = videoElement.value.videoWidth;
  const height = videoElement.value.videoHeight;
  const t = FINGER_MEASURE_POS[currentFinger.value] ?? 0.55;

  // 1. Calcul LiDAR instantané
  const frame = getFingerMeasurementFrame(landmarks, currentFinger.value, width, height, t);
  const thicknessData = frame ? measureFingerThicknessPixels(frame, currentFinger.value) : null;

  if (thicknessData) {
    const ratio = estimateRatioFromHand(landmarks, width, height);
    const currentMm = pixelsToMm(thicknessData.thicknessPx, ratio);

    // Vérification de la cohérence avec la mesure précédente
    if (stabilityBuffer.length > 0) {
      const lastMm = stabilityBuffer[stabilityBuffer.length - 1].mm;
      if (Math.abs(currentMm - lastMm) > TOLERANCE_MM) {
        stabilityBuffer = []; // Si c'est trop différent, on recommence pour éviter les erreurs
      }
    }

    stabilityBuffer.push({ mm: currentMm, frame, thicknessData });

    // On ne valide que si on a assez de mesures stables
    if (stabilityBuffer.length >= REQUIRED_STABLE_FRAMES) {
      const finalAvgMm = stabilityBuffer.reduce((sum, val) => sum + val.mm, 0) / stabilityBuffer.length;
      
      confidenceLevel.value = "Haute (Vérifiée)";
      displayFinalResult(finalAvgMm, frame, thicknessData); // Affiche et fige
      stabilityBuffer = []; 
    }
  } else {
    stabilityBuffer = []; // Reset si on perd le doigt
    // 2. Repli Standard (votre ancienne méthode)
    const px = calculateFingerDiameter(landmarks, currentFinger.value, width, height);
    if (px > 0) {
      processAccumulatedMeasurement(pixelsToMm(px, estimateRatioFromHand(landmarks, width, height)));
    }
  }
};

/**
 * Affiche le résultat et fige la vidéo simultanément
 */
const displayFinalResult = (mm, frame = null, data = null) => {
  const { sizeEU, sizeUS } = getRingSize(mm);
  if (sizeEU) {
    resultEU.value = sizeEU;
    measuredDiameter.value = mm.toFixed(1);
    resultDisplayed.value = true;

    // On fige l'image sur la DERNIÈRE frame valide
    freezeOnCurrentFrame();

    if (frame && data) {
      drawDebugPointsOnFreeze(frame, data);
    }

    saveMeasurement({
      fingerName: currentFinger.value,
      sizeEU, sizeUS, diameterMm: mm
    });
  }
};

const processAccumulatedMeasurement = (mm) => {
  diameterMeasurements.push(mm);
  if (diameterMeasurements.length >= 10) {
    confidenceLevel.value = "Moyenne (Standard)";
    displayFinalResult(diameterMeasurements.reduce((a, b) => a + b, 0) / diameterMeasurements.length);
    diameterMeasurements = [];
  }
};

// --- Utilitaires de Vision ---
function getFingerMeasurementFrame(landmarks, finger, w, h, t) {
  const i = FINGER_INDICES[finger]; if (!i) return null;
  const mcp = { x: landmarks[i.mcp].x * w, y: landmarks[i.mcp].y * h };
  const pip = { x: landmarks[i.pip].x * h, y: landmarks[i.pip].y * h };
  const dx = pip.x - mcp.x; const dy = pip.y - mcp.y; const len = Math.hypot(dx, dy);
  return { center: { x: mcp.x + t * dx, y: mcp.y + t * dy }, normal: { x: -dy / len, y: dx / len } };
}

function measureFingerThicknessPixels(frame, type) {
  if (!updateTmpCanvasFromVideo()) return null;
  const p = (type === "thumb") ? THICKNESS_PARAMS.thumb : THICKNESS_PARAMS.others;
  const ePos = findEdgePeakAlongNormal(frame.center, frame.normal, { maxStepPx: p.fallbackMaxStep });
  const eNeg = findEdgePeakAlongNormal(frame.center, { x: -frame.normal.x, y: -frame.normal.y }, { maxStepPx: p.fallbackMaxStep });
  return (ePos && eNeg) ? { thicknessPx: ePos.t + eNeg.t, edgeLeft: eNeg, edgeRight: ePos } : null;
}

function findEdgePeakAlongNormal(center, normal, { maxStepPx }) {
  const samples = [];
  for (let t = 0; t <= maxStepPx; t++) samples.push(getGrayAtPatch(center.x + normal.x * t, center.y + normal.y * t));
  const grad = samples.map((v, i) => i === 0 ? 0 : Math.abs(v - samples[i - 1]));
  const maxG = Math.max(...grad); if (maxG < 10) return null;
  const idx = grad.indexOf(maxG); return { t: idx, x: center.x + normal.x * idx, y: center.y + normal.y * idx };
}

// DECLARATION UNIQUE DE getGrayAtPatch
function getGrayAtPatch(x, y) {
  const xi = Math.floor(Math.max(0, Math.min(x, tmpCanvas.width - 1)));
  const yi = Math.floor(Math.max(0, Math.min(y, tmpCanvas.height - 1)));
  const d = tmpCtx.getImageData(xi, yi, 1, 1).data;
  return 0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2];
}

function drawDebugPointsOnFreeze(frame, data) {
  const rect = videoElement.value.getBoundingClientRect();
  if (frame?.center) drawMappedPoint(freezeCtx, frame.center.x, frame.center.y, rect.width, rect.height, "yellow");
  if (data?.edgeLeft) drawMappedPoint(freezeCtx, data.edgeLeft.x, data.edgeLeft.y, rect.width, rect.height, "red");
  if (data?.edgeRight) drawMappedPoint(freezeCtx, data.edgeRight.x, data.edgeRight.y, rect.width, rect.height, "cyan");
}

function drawMappedPoint(ctx, xV, yV, dW, dH, color) {
  const vw = videoElement.value.videoWidth; const vh = videoElement.value.videoHeight;
  const videoAR = vw / vh; const destAR = dW / dH;
  let sx, sy, sW, sH;
  if (videoAR > destAR) { sH = vh; sW = vh * destAR; sx = (vw - sW) / 2; sy = 0; }
  else { sW = vw; sH = vw / destAR; sx = 0; sy = (vh - sH) / 2; }
  const x = ((xV - sx) / sW) * dW; const y = ((yV - sy) / sH) * dH;
  ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
}

function freezeOnCurrentFrame() {
  const rect = videoElement.value.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  freezeCanvasEl.value.width = rect.width * dpr; freezeCanvasEl.value.height = rect.height * dpr;
  freezeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const vw = videoElement.value.videoWidth; const vh = videoElement.value.videoHeight;
  const videoAR = vw / vh; const destAR = rect.width / rect.height;
  let sx, sy, sW, sH;
  if (videoAR > destAR) { sH = vh; sW = vh * destAR; sx = (vw - sW) / 2; sy = 0; }
  else { sW = vw; sH = vw / destAR; sx = 0; sy = (vh - sH) / 2; }
  freezeCtx.drawImage(videoElement.value, sx, sy, sW, sH, 0, 0, rect.width, rect.height);
  freezeCanvasEl.value.style.display = "block"; isFrozen.value = true; videoElement.value.pause();
}

const updateHandMap = (type) => currentHandFilter.value = type === "Right" ? "./images/filter_right.png" : "./images/filter_left.png";
const estimateHandSize = (landmarks) => {
  const handSize = Math.hypot((landmarks[12].x - landmarks[0].x) * videoElement.value.videoWidth, (landmarks[12].y - landmarks[0].y) * videoElement.value.videoHeight);
  distanceMessage.value = (handSize < 140) ? "Rapprochez votre main." : (handSize > 190) ? "Éloignez votre main." : "Main bien positionnée.";
};
function updateTmpCanvasFromVideo() {
  if (!videoElement.value) return false;
  tmpCanvas.width = videoElement.value.videoWidth; tmpCanvas.height = videoElement.value.videoHeight;
  tmpCtx.drawImage(videoElement.value, 0, 0); return true;
}