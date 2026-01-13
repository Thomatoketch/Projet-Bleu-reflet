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
          Veuillez positionner votre main de manière à ce qu'elle s'aligne parfaitement avec la silhouette affichée à l'écran, en veillant à ce que tous les bords de votre main soient bien dans les limites du cadre vert.
        </div>

        <div id="videoContainer">
          <video ref="videoElement" id="video" autoplay playsinline></video>
          
          <img 
            id="handMap" 
            :src="currentHandFilter" 
            alt="Contour de la main"
            :style="{ display: handDetected ? 'block' : 'none' }"
          >

          <div id="distanceCircle" :class="{ hidden: !distanceMessage }">
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
import { ref, onUnmounted } from 'vue';
import { Hands } from '@mediapipe/hands';
import { Camera } from '@mediapipe/camera_utils';

// --- Données Réactives ---
const isModalOpen = ref(false);
const showInitialMessage = ref(true);
const handDetected = ref(false);
const videoElement = ref(null);
const currentFinger = ref('None');
const currentHandFilter = ref('./images/hand_filter_left_top.png');
const distanceMessage = ref('');
const resultDisplayed = ref(false);
const resultEU = ref(null);
const resultUS = ref(null);

// Configuration
const fingers = [
  { key: 'thumb', label: 'Pouce' },
  { key: 'index', label: 'Index' },
  { key: 'middle', label: 'Majeur' },
  { key: 'ring', label: 'Annulaire' },
  { key: 'pinky', label: 'Auriculaire' }
];

const pixelToMmRatio = 0.06;
const maxMeasurements = 10;
let diameterMeasurements = [];
let handsDetector = null;
let camera = null;

// --- NOUVEAU : Communication Backend ---

// 1. Récupérer l'ID Client depuis l'URL (ex: ?client=Pandora)
const getClientId = () => {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get('client') || 'Unknown_Client';
};

// 2. Envoyer les données au serveur Node.js
const sendDataToBackend = async (sizeEU, sizeUS, diameter) => {
    const measurementData = {
        clientId: getClientId(),
        fingerName: currentFinger.value,
        sizeEU: sizeEU,
        sizeUS: sizeUS,
        diameterMm: diameter,
        detectionMode: "Standard",
        deviceModel: navigator.userAgent, 
        sessionDurationSeconds: 0 
    };

    console.log("Envoi des données au backend...", measurementData);

    try {
        // Envoie une requête POST au serveur (port 3000 par défaut)
        const response = await fetch('http://localhost:3000/api/measurements', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(measurementData)
        });
        
        const result = await response.json();
        console.log("✅ Données sauvegardées dans MongoDB:", result);
    } catch (error) {
        console.error("❌ Erreur lors de l'envoi:", error);
    }
};

// --- Méthodes Existantes ---

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
  estimateHandSize(landmarks);

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

const handleMeasurements = (landmarks) => {
    if (resultDisplayed.value) return;

    const width = videoElement.value.videoWidth;
    const height = videoElement.value.videoHeight;
    const diameterPixels = getFullFingerDiameter(landmarks, currentFinger.value, width, height);

    if (diameterPixels) {
        const diameterMm = diameterPixels * pixelToMmRatio;
        diameterMeasurements.push(diameterMm);

        if (diameterMeasurements.length > maxMeasurements) diameterMeasurements.shift();

        // Une fois qu'on a assez de mesures
        if (diameterMeasurements.length >= 5) {
            const avgDiameter = diameterMeasurements.reduce((a,b)=>a+b,0) / diameterMeasurements.length;
            const { sizeEU, sizeUS } = getSize(avgDiameter);
            
            // Affichage du résultat
            displayMeasurements(sizeEU, sizeUS);
            
            // --- ENVOI AU BACKEND ---
            // C'est ici que la magie opère
            sendDataToBackend(sizeEU, sizeUS, avgDiameter);
        }
    }
};

const getFullFingerDiameter = (landmarks, finger, width, height) => {
    const fingerIndices = {
        thumb: [1, 2, 3, 4],
        index: [5, 6, 7, 8],
        middle: [9, 10, 11, 12],
        ring: [13, 14, 15, 16],
        pinky: [17, 18, 19, 20]
    }[finger];
    if (!fingerIndices) return null;

    const points = fingerIndices.map(i => ({
        x: landmarks[i].x * width,
        y: landmarks[i].y * height
    }));

    let maxDist = 0;
    for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
            const d = Math.sqrt(Math.pow(points[j].x - points[i].x, 2) + Math.pow(points[j].y - points[i].y, 2));
            maxDist = Math.max(maxDist, d);
        }
    }
    return maxDist;
};

const getSize = (diameter) => {
    if (diameter < 14) return {sizeEU: 44, sizeUS: 3};
    if (diameter < 14.3) return {sizeEU: 45, sizeUS: 3.5};
    if (diameter < 14.7) return {sizeEU: 46, sizeUS: 4};
    if (diameter < 15) return {sizeEU: 47, sizeUS: 4.5};
    if (diameter < 15.3) return {sizeEU: 48, sizeUS: 4.75};
    if (diameter < 15.7) return {sizeEU: 49, sizeUS: 5};
    if (diameter < 16.05) return {sizeEU: 50, sizeUS: 5.5};
    if (diameter < 16.4)  return {sizeEU: 51, sizeUS: 5.75};
    if (diameter < 16.75) return {sizeEU:52, sizeUS:6};
    if (diameter < 17.05 )return {sizeEU:53, sizeUS:6.5};
    if (diameter < 17.35 )return {sizeEU:54, sizeUS:7};
    if (diameter < 17.65) return {sizeEU:55, sizeUS:7.5};
    if (diameter < 17.95) return {sizeEU:56, sizeUS:7.75};
    if (diameter < 18.3) return {sizeEU:57, sizeUS:8};
    if (diameter < 18.65) return {sizeEU:58, sizeUS:8.5};
    if (diameter < 18.95) return {sizeEU:59, sizeUS:8.75};
    if (diameter < 19.25) return {sizeEU:60, sizeUS:9};
    if (diameter < 19.55) return {sizeEU:61, sizeUS:9.5};
    if (diameter < 19.85) return {sizeEU:62, sizeUS:10};
    if (diameter < 20.2) return {sizeEU:63, sizeUS:10.5};
    if (diameter < 20.55) return {sizeEU:64, sizeUS:10.75};
    if (diameter < 20.85) return {sizeEU:65, sizeUS:11};
    if (diameter < 21.15) return {sizeEU:66, sizeUS:11.5};
    if (diameter < 21.45) return {sizeEU:67, sizeUS:12};
    if (diameter < 21.8) return {sizeEU:68, sizeUS:12.5};
    if (diameter < 22.15) return {sizeEU:69, sizeUS:13};
    if (diameter <= 22.3) return {sizeEU:70, sizeUS:13.5};
    return {sizeEU: null, sizeUS: null};
};

const displayMeasurements = (eu, us) => {
    if (!eu || !us) return;
    resultEU.value = eu;
    resultUS.value = us;
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
    /* Assurez-vous que l'image est bien dans public/images/ */
    background-image: url("/images/base-sizing.jpg");
    background-repeat: no-repeat;
    background-position: center;
    background-size: cover; /* Ajout pour s'assurer que ça couvre l'écran */
}

/* Le bouton d'ouverture original */
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

/* La modale */
.modal {
    display: none; /* Géré par Vue mais style de base ici */
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
.close:hover, .close:focus {
    color: black;
    text-decoration: none;
}

#videoContainer {
    position: relative;
    width: 100%;
    padding-top: 177.78%; /* Ratio 9:16 */
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

#fingerSelection, #restartButton {
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
    background-color: #4CAF50; /* Note: le CSS original avait la même couleur pour selected */
    color: white;
    /* Pour différencier, on peut ajouter une bordure ou changer un peu, 
       mais le code original mettait la meme couleur. Je garde fidèle. */
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
    /* display: none; géré par Vue */
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
    z-index: 20;
}

/* Style de la bulle de résultat injectée via innerHTML dans l'original */
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
    /* display: none; géré par Vue */
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
    /* background-color: black; commentaire original */
}
</style>