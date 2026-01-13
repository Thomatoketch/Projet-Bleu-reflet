// src/utils/ringMath.js

// Configuration
export const PIXEL_TO_MM_RATIO = 0.06; // Ratio fixe pour l'instant

// Liste des doigts pour l'affichage
export const FINGERS_CONFIG = [
  { key: 'thumb', label: 'Pouce' },
  { key: 'index', label: 'Index' },
  { key: 'middle', label: 'Majeur' },
  { key: 'ring', label: 'Annulaire' },
  { key: 'pinky', label: 'Auriculaire' }
];

// Tableau de conversion diamètre -> taille
export function getRingSize(diameter) {
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

// Calcul géométrique
export function calculateFingerDiameter(landmarks, fingerKey, width, height) {
    const fingerIndices = {
        thumb: [1, 2, 3, 4],
        index: [5, 6, 7, 8],
        middle: [9, 10, 11, 12],
        ring: [13, 14, 15, 16],
        pinky: [17, 18, 19, 20]
    }[fingerKey];

    if (!fingerIndices) return 0;

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
}