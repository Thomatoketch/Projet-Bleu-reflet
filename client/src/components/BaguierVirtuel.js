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
export const detectionMode = ref('Standard'); // 'LiDAR' ou 'Standard'
export { FINGERS_CONFIG };

// --- Variables internes ---
let handsDetector = null;
let camera = null;
let xrSession = null;
let xrRefSpace = null;
let depthInfo = null;
let freezeCtx = null;
const stabilityBuffer = []; 
const REQUIRED_STABLE_FRAMES = 10; // Plus strict pour le LiDAR
const TOLERANCE_MM = 0.4;
const FINGER_INDICES = { thumb: { pip: 3 }, index: { pip: 6 }, middle: { pip: 10 }, ring: { pip: 14 }, pinky: { pip: 18 } };

// --- 1. Initialisation Intelligente ---
export const openModal = async () => {
  isModalOpen.value = true;
  
  // A. Tentative LiDAR (WebXR)
  if ('xr' in navigator) {
    try {
      const isArSupported = await navigator.xr.isSessionSupported('immersive-ar');
      if (isArSupported) {
        // Demande une session AR avec Accès Profondeur + Overlay HTML
        xrSession = await navigator.xr.requestSession('immersive-ar', {
          requiredFeatures: ['depth-sensing', 'dom-overlay'],
          domOverlay: { root: document.body }, // IMPORTANT: Utiliser body pour éviter les bugs de style
          depthSensing: {
            usagePreference: ['cpu-optimized'],
            dataFormatPreference: ['luminance-alpha']
          }
        });
        
        detectionMode.value = 'LiDAR';
        initXR();
        return; // On sort, le mode AR prend le relais
      }
    } catch (e) {
      console.warn("Échec WebXR (LiDAR), passage en mode standard :", e);
    }
  }
  
  // B. Fallback : Mode Standard (MediaPipe seul)
  startStandardMode();
};

const startStandardMode = () => {
    detectionMode.value = 'Standard';
    setTimeout(() => initMediaPipe(), 100);
};

// --- 2. Logique WebXR (LiDAR) ---
const initXR = async () => {
  document.body.classList.add('ar-active'); // Active la transparence CSS
  
  // Écouteur de fin de session (bouton retour physique ou logiciel)
  xrSession.addEventListener('end', () => {
    document.body.classList.remove('ar-active');
    xrSession = null;
    startStandardMode(); // Si on quitte l'AR, on relance la caméra standard
  });

  xrRefSpace = await xrSession.requestReferenceSpace('viewer'); // 'viewer' est attaché à la caméra
  xrSession.requestAnimationFrame(onXRFrame);
  
  // On lance quand même MediaPipe en parallèle pour détecter les points de la main sur le flux vidéo
  initMediaPipe();
};

const onXRFrame = (time, frame) => {
  const pose = frame.getViewerPose(xrRefSpace);
  if (pose && xrSession) {
    const view = pose.views[0]; // La vue caméra unique sur mobile
    depthInfo = frame.getDepthInformation(view); // Récupère la map de profondeur (LiDAR)
    
    // MediaPipe a besoin qu'on lui envoie des frames manuellement en mode AR parfois
    if (videoElement.value && !isFrozen.value) {
        // En mode AR, videoElement peut être vide, on s'appuie sur le flux caméra natif géré par le navigateur
        // Note: L'implémentation exacte dépend du navigateur, parfois MediaPipe peut lire le canvas WebGL
    }
  }
  if(!isFrozen.value) xrSession.requestAnimationFrame(onXRFrame);
};

// --- 3. Cœur du Calcul (Hybride) ---
const handleMeasurements = (landmarks) => {
  const width = videoElement.value.videoWidth || window.innerWidth;
  const height = videoElement.value.videoHeight || window.innerHeight;
  let currentMm = 0;

  // Calcul de la largeur en pixels (commun aux deux méthodes)
  const pxWidth = calculateFingerDiameter(landmarks, currentFinger.value, width, height);

  if (detectionMode.value === 'LiDAR' && depthInfo) {
    // === MÉTHODE LIDAR ===
    const fingerIdx = FINGER_INDICES[currentFinger.value].pip;
    const fingerPoint = landmarks[fingerIdx];
    
    // On demande au LiDAR : "Quelle est la distance (en mètres) au pixel X,Y ?"
    // fingerPoint.x/y sont normalisés (0 à 1), le LiDAR attend aussi du normalisé ou des pixels selon l'API
    // L'API WebXR getDepthInMeters utilise des coordonnées normalisées (0.0 à 1.0) dans la vue
    const distanceMeters = depthInfo.getDepthInMeters(fingerPoint.x, fingerPoint.y);
    
    if (distanceMeters > 0 && distanceMeters < 1.0) { // On ignore si > 1m (trop loin)
      const distanceMm = distanceMeters * 1000;
      
      // Formule de projection inverse (Thalès)
      // FOCALE_ESTIMEE : Peut être ajustée. 600 est une moyenne mobile standard.
      const FOCALE_ESTIMEE = 600; 
      currentMm = (pxWidth * distanceMm) / FOCALE_ESTIMEE;
      
      confidenceLevel.value = "Haute (LiDAR)";
      distanceMessage.value = `Distance : ${Math.round(distanceMm)}mm`;
    } else {
        distanceMessage.value = "Main trop loin ou signal LiDAR perdu";
        return;
    }
  } else {
    // === MÉTHODE STANDARD (FALLBACK) ===
    // Utilise le ratio anthropométrique (largeur paume estimée à 64mm)
    const ratio = estimateRatioFromHand(landmarks, width, height);
    currentMm = pixelsToMm(pxWidth, ratio);
    confidenceLevel.value = "Moyenne (Standard)";
  }

  // Stabilisation (Moyenne glissante)
  if (currentMm > 10 && currentMm < 25) { // Filtre les valeurs absurdes
    validateStability(currentMm);
  }
};

const validateStability = (mm) => {
  // Reset si saut brutal (> 0.4mm)
  if (stabilityBuffer.length > 0) {
    const lastMm = stabilityBuffer[stabilityBuffer.length - 1];
    if (Math.abs(mm - lastMm) > TOLERANCE_MM) stabilityBuffer.length = 0;
  }
  
  stabilityBuffer.push(mm);

  // Validation si X frames stables consécutives
  if (stabilityBuffer.length >= REQUIRED_STABLE_FRAMES) {
    const avgMm = stabilityBuffer.reduce((a, b) => a + b) / stabilityBuffer.length;
    displayFinalResult(avgMm);
    stabilityBuffer.length = 0; // Stop
  }
};

// ... (Le reste : displayFinalResult, initMediaPipe, onResults, close, restart sont inchangés) ...
// Assurez-vous juste que initMediaPipe gère bien l'attachement à la vidéo.

// FONCTIONS UTILITAIRES DE BASE (à conserver telles quelles)
const initMediaPipe = async () => {
    if (!videoElement.value) return;
    handsDetector = new Hands({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}` });
    handsDetector.setOptions({ maxNumHands: 1, modelComplexity: 1, minDetectionConfidence: 0.8 });
    handsDetector.onResults(onResults);
    
    if(detectionMode.value === 'Standard') {
        camera = new Camera(videoElement.value, {
            onFrame: async () => { await handsDetector.send({ image: videoElement.value }); },
            width: 1280, height: 720
        });
        camera.start();
    }
};

const onResults = (results) => {
    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        handDetected.value = true;
        showInitialMessage.value = false;
        handleMeasurements(results.multiHandLandmarks[0]);
    } else {
        handDetected.value = false;
    }
};

const displayFinalResult = (mm) => {
    const { sizeEU, sizeUS } = getRingSize(mm);
    resultEU.value = sizeEU;
    measuredDiameter.value = mm.toFixed(1);
    resultDisplayed.value = true;
    isFrozen.value = true;
    saveMeasurement({ fingerName: currentFinger.value, sizeEU, diameterMm: mm, detectionMode: detectionMode.value });
};

export const closeModal = () => {
    isModalOpen.value = false;
    if (xrSession) xrSession.end();
    if (camera) camera.stop();
    document.body.classList.remove('ar-active');
};

export const selectFinger = (f) => currentFinger.value = f;
export const restart = () => { 
    isFrozen.value = false; 
    resultDisplayed.value = false; 
    stabilityBuffer.length = 0; 
};