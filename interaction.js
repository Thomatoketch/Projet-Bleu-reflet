// Sélection des éléments DOM nécessaires
const videoElement = document.getElementById('video');
const handMapElement = document.getElementById('handMap');
const initialMessage = document.getElementById('initialMessage');
const resultCircle = document.getElementById('resultCircle');
const resultText = document.getElementById('resultText');
let currentFinger = 'None';
let resultDisplayed = false;
let eyeDistance = null;

// Configuration des paramètres de mesure
const pixelToMmRatio = 0.06;
const diameterMeasurements = [];
const maxMeasurements = 10;


// Initialisation de Mediapipe Hands
const hands = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
});

hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 1,
    minDetectionConfidence: 0.8,
    minTrackingConfidence: 0.8
});
hands.onResults(onResults);

// Activer la caméra pour capturer les mains
const camera = new Camera(videoElement, {
    onFrame: async () => {
        await hands.send({ image: videoElement });
    },
});
camera.start();

// Fonction pour gérer la sélection des doigts et déclencher la mesure immédiatement
function selectFinger(fingerType) {
    document.querySelectorAll('.finger-button').forEach(button => button.classList.remove('selected'));
    document.querySelector(`button[onclick="selectFinger('${fingerType}')"]`).classList.add('selected');
    currentFinger = fingerType;
    console.log(`Doigt sélectionné: ${fingerType}`);

    // Déclencher la mesure immédiatement après la sélection du doigt, si une mesure n'est pas déjà affichée
    if (currentFinger !== 'None' && !resultDisplayed) {
        triggerMeasurement();
    }
}

// Fonction pour afficher un message dans le cercle de distance
function displayDistanceMessage(message) {
    const distanceCircle = document.getElementById('distanceCircle');
    const distanceText = document.getElementById('distanceText');

    distanceText.innerText = message;
    distanceCircle.style.display = 'flex';
}

// Fonction pour masquer le message de distance
function hideDistanceMessage() {
    const distanceCircle = document.getElementById('distanceCircle');
    distanceCircle.style.display = 'none';
}

// Fonction pour gérer les résultats de la détection de la main
function onResults(results) {
    if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
        initialMessage.style.display = 'block';
        handMapElement.style.display = 'none';
        hideDistanceMessage();
        return;
    }

    // Afficher le filtre de la main
    initialMessage.style.display = 'none';
    handMapElement.style.display = 'block';

    // Une fois la main détectée, estimer la taille de la main
    const landmarks = results.multiHandLandmarks[0];
    estimateHandSize(landmarks);
	
		if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
		console.log('Pas de landmarks de main détectés');
	}
}

const expectedHandSizeAt25cm = 170;  // Taille moyenne d'une main à 25 cm en pixels
const minHandSizeAt25cm = 140;  // Taille min de la main à 25 cm en pixels
const maxHandSizeAt25cm = 190;  // Taille max de la main à 25 cm en pixels

function estimateHandSize(landmarks) {
    const wrist = landmarks[0];  // Repère pour le poignet
    const middleFingerTip = landmarks[12];  // Repère pour le bout du majeur

    // Calculer la distance entre le poignet et le bout du majeur
    const handSize = Math.sqrt(
        Math.pow((middleFingerTip.x - wrist.x), 2) + Math.pow((middleFingerTip.y - wrist.y), 2)
    );

    console.log(`Taille de la main détectée : ${handSize}px`);

    // Facteur basé sur la taille de main détectée
    const distanceFactor = handSize / expectedHandSizeAt25cm;

    if (handSize < minHandSizeAt25cm) {
        displayDistanceMessage("Rapprochez votre main.");  // Main trop petite, donc trop loin
    } else if (handSize > maxHandSizeAt25cm) {
        displayDistanceMessage("Éloignez votre main.");  // Main trop grande, donc trop proche
    } else if (distanceFactor < 1 - toleranceFactor) {
        displayDistanceMessage("Rapprochez votre main.");  // Utilisation de la tolérance
    } else if (distanceFactor > 1 + toleranceFactor) {
        displayDistanceMessage("Éloignez votre main.");  // Utilisation de la tolérance
    } else {
        displayDistanceMessage("Main bien positionnée.");  // Taille correcte
        setTimeout(() => {
            hideDistanceMessage();
        }, 2000);  // Cache le message après 2 secondes
    }
}

function displayDistanceMessage(message) {
    const distanceCircle = document.getElementById('distanceCircle');
    const distanceText = document.getElementById('distanceText');

    distanceText.innerText = message;
    distanceCircle.style.display = 'flex';  // Afficher le message de distance
}

function hideDistanceMessage() {
    const distanceCircle = document.getElementById('distanceCircle');
    distanceCircle.style.display = 'none';  // Cacher le message
}


// Fonction pour déclencher la mesure lorsque le doigt est sélectionné
function triggerMeasurement() {
    hands.onResults(results => {
        if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
            const landmarks = results.multiHandLandmarks[0];
            handleMeasurements(landmarks);
        }
    });
}

// Fonction pour traiter les mesures de la main
function handleMeasurements(landmarks) {
    if (resultDisplayed) {
        return; // Prevent further calculations if the result is already shown
    }

    const { width, height } = videoElement.getBoundingClientRect();
    const diameterPixels = getFullFingerDiameter(landmarks, currentFinger, width, height);
    if (diameterPixels) {
        const diameterMm = diameterPixels * pixelToMmRatio;
        diameterMeasurements.push(diameterMm);
        if (diameterMeasurements.length > maxMeasurements) {
            diameterMeasurements.shift();
        }
        const stabilizedDiameter = getStabilizedDiameter();
        const { sizeEU, sizeUS } = getSize(stabilizedDiameter);
        displayMeasurements(sizeEU, sizeUS);
        
        // Stop further measurements by marking result as displayed
        resultDisplayed = true;
    } else {
        console.log("Pas de diamètre calculé.");
    }
}

function displayMeasurements(sizeEU, sizeUS) {
    if (!sizeEU || !sizeUS) {
        console.log("Les tailles ne sont pas disponibles, affichage ignoré.");
        return;
    }

    resultText.innerHTML = `<span style="border-radius: 50%; width: 250px;
            height: 250px; opacity: .95; display: block; background-color: black; position: absolute;
            top: 50%; left: 50%; transform: translate(-50%, -50%);
            display: flex; flex-direction: column; justify-content: center;
            align-items: center; color: green; font-size: 24px;
            font-family: Arial, sans-serif; text-align: center; z-index: 20;">${sizeEU} EU | ${sizeUS} US</span>`;
    
    // Mark result as displayed to prevent further modifications
    resultCircle.classList.remove('hidden');
    document.getElementById('newMeasurementButton').classList.remove('hidden'); // Show "New Measurement" button
    resultDisplayed = true; // Marks result as displayed
    console.log("Mesures affichées :", sizeEU, sizeUS);
}

// Fonction pour classifier la main comme gauche ou droite
function classifyHand(landmarks) {
    const thumbTip = landmarks[4];
    const wrist = landmarks[0];
    
    // If thumbTip is on the left of the wrist, it’s a left hand, otherwise, it's a right hand
    return thumbTip.x < wrist.x ? "Left" : "Right";
}

// Fonction pour mettre à jour la map de la main
function updateHandMap(handType) {
    const handMapElement = document.getElementById('handMap');

    // Display the correct hand filter based on the detected hand type
    if (handType === "Right") {
        handMapElement.src = "./images/filter_right.png"; // Make sure the image exists
    } else if (handType === "Left") {
        handMapElement.src = "./images/filter_left.png"; // Make sure the image exists
    }

    // Ensure the hand map element is visible
    handMapElement.style.display = 'block';
    console.log(`Hand filter updated for ${handType} hand`);
}


hands.onResults((results) => {
    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        const landmarks = results.multiHandLandmarks[0];
        const handType = classifyHand(landmarks); // Classify the hand
        updateHandMap(handType); // Update the hand filter based on the hand type
    } else {
        console.log('No hand landmarks detected.');
    }
});


// Fonction pour calculer le diamètre complet d'un doigt en pixels
function getFullFingerDiameter(landmarks, finger, width, height) {
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

    let maxDistance = 0;
    for (let i = 0; i < points.length; i++) {
        for (let j = i + 1; j < points.length; j++) {
            const distance = Math.sqrt(
                Math.pow(points[j].x - points[i].x, 2) + Math.pow(points[j].y - points[i].y, 2)
            );
            maxDistance = Math.max(maxDistance, distance);
        }
    }

    console.log(`Calculated diameter in pixels: ${maxDistance}`);
    return maxDistance;
}

// Fonction pour stabiliser le diamètre mesuré
function getStabilizedDiameter() {
    const sum = diameterMeasurements.reduce((a, b) => a + b, 0);
    return sum / diameterMeasurements.length;
}

// Fonction pour réinitialiser les mesures
function clearMeasurements() {
    diameterMeasurements.length = 0;
    resultDisplayed = false;
    resultCircle.classList.add('hidden');
    document.getElementById('newMeasurementButton').classList.add('hidden'); // Cache le bouton "Nouvelle Mesure"
}

// Fonction pour relancer une nouvelle mesure sans recharger la page
function restart() {
    // Reset all necessary variables and elements
    clearMeasurements(); 
    resultDisplayed = false;
    initialMessage.style.display = 'block'; // Show initial message again
    handMapElement.style.display = 'none';  // Hide the hand map for reset
    subtleMessage.style.display = 'none';   // Hide any subtle messages
    resultText.innerHTML = '';              // Clear the result text
    resultCircle.classList.add('hidden');   // Hide result circle
    document.getElementById('newMeasurementButton').classList.add('hidden'); // Hide "New Measurement" button
    currentFinger = 'None';  // Reset the selected finger

    console.log("Nouvelle mesure demandée");

    // Allow a small delay before showing the hand map again
    setTimeout(() => {
        handMapElement.style.display = 'block'; 
    }, 100); 
}

// Make sure the restart function is attached to the correct button
document.getElementById('newMeasurementButton').addEventListener('click', restart);





// Fonction pour obtenir la taille en EU et US en fonction du diamètre
function getSize(diameter) {
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
}



