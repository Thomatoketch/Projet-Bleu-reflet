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
export const detectionMode = ref('Standard');
export { FINGERS_CONFIG };

// --- Variables internes ---
let handsDetector = null;
let camera = null;
let xrSession = null;
let xrRefSpace = null;
let depthInfo = null;
const stabilityBuffer = []; 
// J'ai réduit le nombre de frames requises pour que le calcul se fasse plus vite ("1 calcul")
// tout en gardant une toute petite sécurité pour éviter les erreurs aberrantes.
const REQUIRED_STABLE_FRAMES = 5; 
const TOLERANCE_MM = 0.5;
const FINGER_INDICES = { thumb: { pip: 3 }, index: { pip: 6 }, middle: { pip: 10 }, ring: { pip: 14 }, pinky: { pip: 18 } };
let currentFocalLengthPx = 600; 

// --- 1. Initialisation ---
export const openModal = async () => {
  isModalOpen.value = true;
  
  if ('xr' in navigator) {
    try {
      const isArSupported = await navigator.xr.isSessionSupported('immersive-ar');
      if (isArSupported) {
        xrSession = await navigator.xr.requestSession('immersive-ar', {
          requiredFeatures: ['depth-sensing', 'dom-overlay'],
          domOverlay: { root: document.querySelector('.baguier-root') || document.body },
          depthSensing: { usagePreference: ['cpu-optimized'], dataFormatPreference: ['luminance-alpha'] }
        });
        detectionMode.value = 'LiDAR';
        initXR();
        return;
      }
    } catch (e) { console.warn("Fallback Standard"); }
  }
  startStandardMode();
};

const startStandardMode = () => {
    detectionMode.value = 'Standard';
    setTimeout(() => initMediaPipe(), 100);
};

// --- 2. WebXR (LiDAR) ---
const initXR = async () => {
  // Ajoute la classe sur BODY et HTML
  document.body.classList.add('ar-active'); 
  document.documentElement.classList.add('ar-active');

  xrSession.addEventListener('end', () => {
    document.body.classList.remove('ar-active');
    document.documentElement.classList.remove('ar-active');
    xrSession = null;
    startStandardMode();
  });
  
  xrRefSpace = await xrSession.requestReferenceSpace('viewer');
  xrSession.requestAnimationFrame(onXRFrame);
  initMediaPipe();
};

const onXRFrame = (time, frame) => {
  // Si c'est gelé, on arrête de demander de nouvelles frames (Pause Logique)
  if (isFrozen.value) return;

  const pose = frame.getViewerPose(xrRefSpace);
  if (pose && xrSession) {
    const view = pose.views[0];
    depthInfo = frame.getDepthInformation(view);
    if (view.projectionMatrix) {
        const viewport = xrSession.renderState.baseLayer.getViewport(view);
        if (viewport) currentFocalLengthPx = (view.projectionMatrix[5] * viewport.height) / 2;
    }
  }
  xrSession.requestAnimationFrame(onXRFrame);
};

// --- 3. Calculs et Stabilisation ---
const handleMeasurements = (landmarks) => {
  // Si c'est gelé, on ne calcule plus rien (Sécurité supplémentaire)
  if (isFrozen.value) return;

  const width = videoElement.value.videoWidth || window.innerWidth;
  const height = videoElement.value.videoHeight || window.innerHeight;
  let currentMm = 0;

  const pxWidth = calculateFingerDiameter(landmarks, currentFinger.value, width, height);

  if (detectionMode.value === 'LiDAR' && depthInfo) {
    const fingerIdx = FINGER_INDICES[currentFinger.value].pip;
    const fingerPoint = landmarks[fingerIdx];
    const distanceMeters = depthInfo.getDepthInMeters(fingerPoint.x, fingerPoint.y);
    
    if (distanceMeters > 0 && distanceMeters < 1.0) {
      const distanceMm = distanceMeters * 1000;
      currentMm = (pxWidth * distanceMm) / currentFocalLengthPx;
      confidenceLevel.value = "Haute (LiDAR)";
      distanceMessage.value = `Distance : ${Math.round(distanceMm)}mm`;
    } else {
        distanceMessage.value = "Main trop loin";
        return;
    }
  } else {
    const ratio = estimateRatioFromHand(landmarks, width, height);
    currentMm = pixelsToMm(pxWidth, ratio);
    confidenceLevel.value = "Moyenne (Standard)";
  }

  if (currentMm > 10 && currentMm < 28) { 
    validateStability(currentMm);
  }
};

const validateStability = (mm) => {
  if (stabilityBuffer.length > 0) {
    const lastMm = stabilityBuffer[stabilityBuffer.length - 1];
    if (Math.abs(mm - lastMm) > TOLERANCE_MM) stabilityBuffer.length = 0;
  }
  
  stabilityBuffer.push(mm);

  // Dès qu'on a atteint le quota de stabilité (5 frames), on déclenche le résultat FINAL
  if (stabilityBuffer.length >= REQUIRED_STABLE_FRAMES) {
    const avgMm = stabilityBuffer.reduce((a, b) => a + b) / stabilityBuffer.length;
    displayFinalResult(avgMm);
    stabilityBuffer.length = 0; 
  }
};

// --- 4. Affichage et Pause (Modifié) ---
const displayFinalResult = (mm) => {
    const { sizeEU } = getRingSize(mm);
    resultEU.value = sizeEU;
    measuredDiameter.value = mm.toFixed(1);
    resultDisplayed.value = true;
    isFrozen.value = true; // Déclenche l'état de pause

    // --- PAUSE VISUELLE (CAPTURE DU CANVAS) ---
    if (videoElement.value && freezeCanvasEl.value) {
        const width = videoElement.value.videoWidth;
        const height = videoElement.value.videoHeight;
        
        // On dimensionne le canvas de pause à la taille de la vidéo
        freezeCanvasEl.value.width = width;
        freezeCanvasEl.value.height = height;
        
        const ctx = freezeCanvasEl.value.getContext('2d');
        
        // On dessine l'image actuelle de la vidéo dans le canvas (avec effet miroir)
        ctx.save();
        ctx.translate(width, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(videoElement.value, 0, 0, width, height);
        ctx.restore();
        
        // On affiche le canvas figé et on cache la vidéo pour économiser les ressources
        freezeCanvasEl.value.style.display = 'block';
        videoElement.value.style.display = 'none';
    }

    // --- ARRÊT DES PROCESSUS ---
    if (camera) camera.stop(); // Arrête la caméra MediaPipe standard
    // Pour le LiDAR (XR), la boucle s'arrête grâce au check "if (isFrozen.value) return" dans onXRFrame

    saveMeasurement({ fingerName: currentFinger.value, sizeEU, diameterMm: mm, detectionMode: detectionMode.value });
};

// --- 5. Redémarrage (Modifié) ---
export const restart = () => { 
    isFrozen.value = false; 
    resultDisplayed.value = false; 
    stabilityBuffer.length = 0; 

    // Réinitialisation visuelle
    if (freezeCanvasEl.value) freezeCanvasEl.value.style.display = 'none';
    if (videoElement.value) videoElement.value.style.display = 'block';

    // --- CORRECTION ---
    // On redémarre TOUJOURS la caméra MediaPipe, même en mode LiDAR.
    // (Car MediaPipe doit continuer à analyser les mains en arrière-plan)
    if (camera) {
        camera.start();
    }

    // Si on est en mode LiDAR, on relance AUSSI la boucle WebXR
    if (detectionMode.value === 'LiDAR' && xrSession) {
        xrSession.requestAnimationFrame(onXRFrame);
    }
};

const initMediaPipe = async () => {
    if (!videoElement.value) return;
    handsDetector = new Hands({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}` });
    handsDetector.setOptions({ maxNumHands: 1, modelComplexity: 1, minDetectionConfidence: 0.8 });
    handsDetector.onResults(onResults);
    
    // --- CORRECTION : On lance TOUJOURS la caméra ---
    // En mode Standard : on voit la vidéo.
    // En mode LiDAR : le CSS cache la vidéo (opacity:0) mais elle tourne en fond pour MediaPipe.
    camera = new Camera(videoElement.value, {
        onFrame: async () => { 
            // Si gelé, on n'envoie plus d'images à analyser
            if (!isFrozen.value) await handsDetector.send({ image: videoElement.value }); 
        },
        width: 1280, height: 720
    });
    camera.start();
};

const onResults = (results) => {
    // Bloque tout nouveau résultat si on est gelé
    if (isFrozen.value) return;

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        handDetected.value = true;
        showInitialMessage.value = false;
        handleMeasurements(results.multiHandLandmarks[0]);
    } else {
        handDetected.value = false;
    }
};

export const closeModal = () => {
    isModalOpen.value = false;
    if (xrSession) xrSession.end();
    if (camera) camera.stop();
    document.body.classList.remove('ar-active');
    document.documentElement.classList.remove('ar-active'); // Nettoyage HTML
};

export const selectFinger = (f) => currentFinger.value = f;