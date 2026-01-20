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
          Veuillez positionner votre main de manière à ce qu'elle s'aligne parfaitement avec la silhouette affichée à
          l'écran.
        </div>

        <div id="videoContainer">
          <video ref="videoElement" id="video" autoplay playsinline></video>

          <img id="handMap" :src="currentHandFilter" alt="Contour de la main"
            :style="{ display: handDetected ? 'block' : 'none' }">

          <div id="distanceCircle" :class="{ hidden: !distanceMessage }">
            <span id="distanceText">{{ distanceMessage }}</span>
          </div>

          <div id="resultCircle" :class="{ hidden: !resultDisplayed }">
            <span id="resultText">
              <span v-if="resultEU" class="result-bubble">
                <span style="font-size: 1.8rem; display:block;">{{ resultEU }}</span>
                <span style="font-size: 0.8rem; display:block; margin-top:5px;">Ø {{ measuredDiameter }} mm</span>
                <span style="font-size: 0.7rem; display:block; opacity:0.8; margin-top:5px;">
                  Confiance : {{ confidenceLevel }}
                </span>
              </span>
            </span>
            <button id="newMeasurementButton" :class="{ hidden: !resultDisplayed }" @click="restart">
              Recommencer
            </button>
          </div>
        </div>

        <div id="fingerSelection">
          <button v-for="finger in FINGERS_CONFIG" :key="finger.key" class="finger-button"
            :class="{ selected: currentFinger === finger.key }" @click="selectFinger(finger.key)">
            {{ finger.label }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onUnmounted } from 'vue';
import { Hands } from '@mediapipe/hands';
import { Camera } from '@mediapipe/camera_utils';

// Import des nouvelles fonctions mathématiques
import { getRingSize, calculateFingerDiameter, pixelsToMm, estimateRatioFromHand, FINGERS_CONFIG } from '../utils/ringMath';
import { saveMeasurement } from '../services/api';

// --- Données Réactives ---
const isModalOpen = ref(false);
const showInitialMessage = ref(true);
const handDetected = ref(false);
const videoElement = ref(null);
const currentFinger = ref('None');
const currentHandFilter = ref('./images/hand_filter_left_top.png');
const distanceMessage = ref('');
const resultDisplayed = ref(false);

// Nouvelles données pour l'affichage
const resultEU = ref(null);
const measuredDiameter = ref(0);
const confidenceLevel = ref('Moyenne');

const maxMeasurements = 15;
let diameterMeasurements = [];
let handsDetector = null;

// --- Méthodes ---

const openModal = () => {
  isModalOpen.value = true;
  setTimeout(() => initMediaPipe(), 100);
};

const closeModal = () => {
  isModalOpen.value = false;
  stopCamera();
};

const initMediaPipe = async () => {
  if (!videoElement.value) return;

  handsDetector = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
  });

  handsDetector.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.8,
    minTrackingConfidence: 0.8
  });

  handsDetector.onResults(onResults);

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 720 }
      }
    });

    videoElement.value.srcObject = stream;
    videoElement.value.onloadedmetadata = () => {
      videoElement.value.play();
      requestAnimationFrame(predictWebcam);
    };
  } catch (err) {
    console.error("Erreur caméra :", err);
    alert("Impossible d'accéder à la caméra.");
  }
};

const predictWebcam = async () => {
  if (videoElement.value && handsDetector && isModalOpen.value) {
    if (videoElement.value.videoWidth > 0 && videoElement.value.videoHeight > 0) {
      await handsDetector.send({ image: videoElement.value });
    }
    requestAnimationFrame(predictWebcam);
  }
};

const stopCamera = () => {
  if (videoElement.value && videoElement.value.srcObject) {
    const stream = videoElement.value.srcObject;
    stream.getTracks().forEach(track => track.stop());
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
  const handType = classifyHand(landmarks);
  updateHandMap(handType);
  estimateHandSize(landmarks); // Garde le message de distance pour l'UX

  if (currentFinger.value !== 'None' && !resultDisplayed.value) {
    handleMeasurements(landmarks);
  }
};

const estimateHandSize = (landmarks) => {
  const wrist = landmarks[0];
  const middleFingerTip = landmarks[12];
  const width = videoElement.value.videoWidth || 640;
  const height = videoElement.value.videoHeight || 480;
  const xDiff = (middleFingerTip.x - wrist.x) * width;
  const yDiff = (middleFingerTip.y - wrist.y) * height;
  const handSize = Math.sqrt(Math.pow(xDiff, 2) + Math.pow(yDiff, 2));

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

const classifyHand = (landmarks) => {
  const thumbTip = landmarks[4];
  const wrist = landmarks[0];
  return thumbTip.x < wrist.x ? "Left" : "Right";
};

const updateHandMap = (handType) => {
  if (handType === "Right") currentHandFilter.value = "./images/filter_right.png";
  else currentHandFilter.value = "./images/filter_left.png";
};

// --- NOUVELLE LOGIQUE DE MESURE (SANS TOUCHER AU DESIGN) ---
const handleMeasurements = (landmarks) => {
  if (resultDisplayed.value) return;

  const width = videoElement.value.videoWidth;
  const height = videoElement.value.videoHeight;

  // 1. Estimation Algorithmique du ratio
  const currentRatio = estimateRatioFromHand(landmarks, width, height);

  // 2. Calcul des pixels du doigt
  const diameterPixels = calculateFingerDiameter(landmarks, currentFinger.value, width, height);

  if (diameterPixels > 0) {
    // 3. Conversion en mm
    const diameterMm = pixelsToMm(diameterPixels, currentRatio);

    diameterMeasurements.push(diameterMm);

    if (diameterMeasurements.length > maxMeasurements) diameterMeasurements.shift();

    // On attend d'avoir assez de mesures
    if (diameterMeasurements.length >= 10) {
      const avgDiameter = diameterMeasurements.reduce((a, b) => a + b, 0) / diameterMeasurements.length;

      // Calcul de la confiance (Stabilité des mesures)
      const variance = diameterMeasurements.reduce((a, b) => a + Math.pow(b - avgDiameter, 2), 0) / diameterMeasurements.length;
      const stdDev = Math.sqrt(variance);
      let conf = 'Faible';
      if (stdDev < 0.5) conf = 'Haute';
      else if (stdDev < 1.0) conf = 'Moyenne';

      const { sizeEU, sizeUS } = getRingSize(avgDiameter);

      if (sizeEU && sizeUS) {
        // Mise à jour des variables d'affichage
        resultEU.value = sizeEU;
        measuredDiameter.value = avgDiameter.toFixed(1);
        confidenceLevel.value = conf;

        displayMeasurements();

        saveMeasurement({
          fingerName: currentFinger.value,
          sizeEU: sizeEU,
          sizeUS: sizeUS,
          diameterMm: avgDiameter
        });
      } else {
        // Si la mesure est aberrante, on recommence silencieusement
        diameterMeasurements = [];
      }
    }
  }
};

const displayMeasurements = () => {
  resultDisplayed.value = true;
};

const selectFinger = (fingerKey) => {
  currentFinger.value = fingerKey;
};

const restart = () => {
  diameterMeasurements = [];
  resultDisplayed.value = false;
  currentFinger.value = 'None';
  showInitialMessage.value = true;
  handDetected.value = false;
  setTimeout(() => { }, 100);
};

onUnmounted(() => {
  stopCamera();
});
</script>

<style scoped>
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
  background-color: #4CAF50;
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
  background-color: #4CAF50;
  color: white;
  border: none;
  border-radius: 5px;
  font-size: 14px;
}

.finger-button:hover {
  background-color: #000;
}

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
  z-index: 2000;
}

.result-bubble {
  border-radius: 50%;
  width: 250px;
  height: 250px;
  opacity: .95;
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
  z-index: 1000;
  width: 250px;
  height: 250px;
  border-radius: 50%;
  opacity: 0.9;
}
</style>