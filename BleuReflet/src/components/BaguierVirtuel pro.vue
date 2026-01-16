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

// Configuration et Variables globales (comme dans interaction.js)
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
const toleranceFactor = 0.1; // Supposé d'après le contexte du code original (variable manquante dans l'extrait mais utilisée)

// --- Méthodes ---

const openModal = () => {
  isModalOpen.value = true;
  // Petit délai pour s'assurer que le DOM de la vidéo est prêt
  setTimeout(() => initMediaPipe(), 100);
};

const closeModal = () => {
  isModalOpen.value = false;
  stopCamera();
};

const initMediaPipe = () => {
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

  camera = new Camera(videoElement.value, {
    onFrame: async () => {
      if (handsDetector && videoElement.value) {
        await handsDetector.send({ image: videoElement.value });
      }
    },
    width: 1280,
    height: 720
  });
  camera.start();
};

const stopCamera = () => {
  if (camera && videoElement.value && videoElement.value.srcObject) {
     const stream = videoElement.value.srcObject;
     const tracks = stream.getTracks();
     tracks.forEach(track => track.stop());
  }
};

// Logique issue de interaction.js : onResults
const onResults = (results) => {
  if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
      // Pas de main
      if (!handDetected.value) { 
          // Si on n'avait pas de main avant, on garde le message initial
          showInitialMessage.value = true; 
      }
      // Note: interaction.js original ne remettait pas showInitialMessage à true si la main partait, 
      // il cachait juste handMap. Je respecte la logique "Si pas de main -> return".
      if (results.multiHandLandmarks && results.multiHandLandmarks.length === 0) {
        // console.log('Pas de landmarks'); 
      }
      return;
  }

  // Main détectée
  showInitialMessage.value = false; // "initialMessage.style.display = 'none'"
  handDetected.value = true;      // "handMapElement.style.display = 'block'"

  const landmarks = results.multiHandLandmarks[0];

  // 1. Classification main gauche/droite
  const handType = classifyHand(landmarks);
  updateHandMap(handType);

  // 2. Estimation de la taille (Distance)
  estimateHandSize(landmarks);

  // 3. Mesure si un doigt est choisi
  if (currentFinger.value !== 'None' && !resultDisplayed.value) {
      handleMeasurements(landmarks);
  }
};

// Logique issue de interaction.js : estimateHandSize
const estimateHandSize = (landmarks) => {
    const wrist = landmarks[0];
    const middleFingerTip = landmarks[12];
    
    // Récupérer dimensions réelles vidéo pour convertir les coordonnées normalisées (0..1) en pixels
    // Le code original utilisait des pixels directement car MediaPipe JS renvoie parfois des pixels selon config,
    // mais ici via npm c'est souvent normalisé. On multiplie par la taille vidéo.
    const width = videoElement.value.videoWidth || 640;
    const height = videoElement.value.videoHeight || 480;

    const xDiff = (middleFingerTip.x - wrist.x) * width;
    const yDiff = (middleFingerTip.y - wrist.y) * height;

    const handSize = Math.sqrt(Math.pow(xDiff, 2) + Math.pow(yDiff, 2));

    // Valeurs du fichier interaction.js
    const expectedHandSizeAt25cm = 170;
    const minHandSizeAt25cm = 140;
    const maxHandSizeAt25cm = 190;
    const distanceFactor = handSize / expectedHandSizeAt25cm;
    const tol = 0.1; // toleranceFactor

    let msg = "";
    if (handSize < minHandSizeAt25cm) {
        msg = "Rapprochez votre main.";
    } else if (handSize > maxHandSizeAt25cm) {
        msg = "Éloignez votre main.";
    } else if (distanceFactor < 1 - tol) {
        msg = "Rapprochez votre main.";
    } else if (distanceFactor > 1 + tol) {
        msg = "Éloignez votre main.";
    } else {
        msg = "Main bien positionnée.";
        // Cache le message après 2 secondes si c'est bon
        setTimeout(() => {
            if (distanceMessage.value === "Main bien positionnée.") {
                distanceMessage.value = "";
            }
        }, 2000);
    }
    distanceMessage.value = msg;
};

// Logique issue de interaction.js : classifyHand & updateHandMap
const classifyHand = (landmarks) => {
    const thumbTip = landmarks[4];
    const wrist = landmarks[0];
    return thumbTip.x < wrist.x ? "Left" : "Right";
};

const updateHandMap = (handType) => {
    if (handType === "Right") {
        currentHandFilter.value = "./images/filter_right.png";
    } else {
        currentHandFilter.value = "./images/filter_left.png";
    }
};

// Logique issue de interaction.js : Mesures
const handleMeasurements = (landmarks) => {
    if (resultDisplayed.value) return;

    const width = videoElement.value.videoWidth;
    const height = videoElement.value.videoHeight;
    const diameterPixels = getFullFingerDiameter(landmarks, currentFinger.value, width, height);

    if (diameterPixels) {
        const diameterMm = diameterPixels * pixelToMmRatio;
        diameterMeasurements.push(diameterMm);

        if (diameterMeasurements.length > maxMeasurements) {
            diameterMeasurements.shift();
        }

        // On affiche le résultat (ici simplifié : on prend la dernière ou moyenne)
        // Dans interaction.js, il appelle getStabilizedDiameter()
        const stabilized = diameterMeasurements.reduce((a,b)=>a+b,0) / diameterMeasurements.length;
        
        // Petite condition pour attendre stabilisation (ex: 5 frames)
        if (diameterMeasurements.length >= 5) {
            const { sizeEU, sizeUS } = getSize(stabilized);
            displayMeasurements(sizeEU, sizeUS);
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
    // Copie exacte des seuils de interaction.js
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
    // Si pas de résultat déjà affiché, la mesure se lance via onResults automatiquement
    if (!resultDisplayed.value) {
        // trigger logic is implicit in onResults check
    }
};

const restart = () => {
    diameterMeasurements = [];
    resultDisplayed.value = false;
    currentFinger.value = 'None';
    showInitialMessage.value = true;
    handDetected.value = false; // Pour masquer le filtre main temporairement comme dans restart() original
    setTimeout(() => {
        // Le code original avait un petit timeout pour réafficher la main
    }, 100);
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