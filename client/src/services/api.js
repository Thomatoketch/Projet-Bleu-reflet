// src/services/api.js

const API_URL = 'http://localhost:3000/api/measurements';

function getClientId() {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('client') || 'Unknown_Client';
}

export async function saveMeasurement(data) {
    // data contient : fingerName, sizeEU, sizeUS, diameterMm
    const payload = {
        clientId: getClientId(),
        fingerName: data.fingerName,
        sizeEU: data.sizeEU,
        sizeUS: data.sizeUS,
        diameterMm: data.diameterMm,
        detectionMode: "Standard",
        deviceModel: navigator.userAgent,
        sessionDurationSeconds: 0 
    };

    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const result = await response.json();
        console.log("✅ Données sauvegardées (Service API):", result);
        return result;
    } catch (error) {
        console.error("❌ Erreur API:", error);
        // On ne bloque pas l'app, mais on log l'erreur
    }
}