// src/utils/ringMath.js

// --- CONSTANTES ANTHROPOMÉTRIQUES ---
// Largeur moyenne de la paume (Squelette Index <-> Auriculaire)
// 64.0 mm est la valeur calibrée pour une main standard
export const AVG_PALM_WIDTH_MM = 64.0; 

export const FINGERS_CONFIG = [
  { key: 'thumb', label: 'Pouce' },
  { key: 'index', label: 'Index' },
  { key: 'middle', label: 'Majeur' },
  { key: 'ring', label: 'Annulaire' },
  { key: 'pinky', label: 'Auriculaire' }
];

// 1. Estimation du ratio (Échelle)
export function estimateRatioFromHand(landmarks, width, height) {
    // On utilise la largeur de la paume (Points 5 à 17) pour définir l'échelle
    const indexMCP = landmarks[5];
    const pinkyMCP = landmarks[17];

    const x1 = indexMCP.x * width;
    const y1 = indexMCP.y * height;
    const x2 = pinkyMCP.x * width;
    const y2 = pinkyMCP.y * height;

    const palmWidthPx = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));

    if (palmWidthPx <= 0) return 0.06; 

    return AVG_PALM_WIDTH_MM / palmWidthPx;
}

// 2. Conversion
export function pixelsToMm(pixels, ratio) {
    return pixels * ratio;
}

// 3. Tailles de bague (Formule : Diamètre x PI)
export function getRingSize(diameterMm) {
    if (!diameterMm || diameterMm < 10 || diameterMm > 28) {
        return { sizeEU: null, sizeUS: null };
    }
    
    const sizeEU = Math.round(diameterMm * Math.PI);
    const sizeUS = Math.round((diameterMm - 11.5) / 0.83);

    return { sizeEU, sizeUS };
}

// 4. Calcul de la largeur du doigt
export function calculateFingerDiameter(landmarks, fingerKey, width, height) {
    let p1_idx, p2_idx;
    let correction = 1.0;

    // --- CORRECTION POUCE ---
    if (fingerKey === 'thumb') {
        // On mesure la base Index/Majeur (très stable)
        p1_idx = 5; // Index MCP
        p2_idx = 9; // Middle MCP
        correction = 1.0; 
    } 
    else if (fingerKey === 'index') { p1_idx = 5; p2_idx = 9; }
    else if (fingerKey === 'middle') { p1_idx = 9; p2_idx = 13; }
    
    // === MODIFICATION ICI ===
    else if (fingerKey === 'ring') { 
        p1_idx = 13; // Ring MCP
        p2_idx = 17; // Pinky MCP
        // On applique une réduction de 7% à 10% pour compenser l'écartement des os
        correction = 0.90; 
    }
    // ========================

    else if (fingerKey === 'pinky') { 
        p1_idx = 13; p2_idx = 17; 
        correction = 0.85; // Le petit doigt est plus fin
    }
    else { return 0; }

    const p1 = landmarks[p1_idx];
    const p2 = landmarks[p2_idx];

    const x1 = p1.x * width;
    const y1 = p1.y * height;
    const x2 = p2.x * width;
    const y2 = p2.y * height;

    const widthPx = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
    
    return widthPx * correction;
}