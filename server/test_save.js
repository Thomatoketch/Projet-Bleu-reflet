// Script to simulate a phone sending data to your server
async function testSave() {
    // 1. Fake data (like what the frontend will send)
    const fakeData = {
        clientId: "TEST_BRAND_PARIS",
        fingerName: "ring", // Annulaire
        sizeEU: 54,
        sizeUS: 7,
        diameterMm: 17.2,
        detectionMode: "Standard",
        deviceModel: "Simulation Script",
        sessionDurationSeconds: 12
    };

    console.log("1. Sending data to server...", fakeData);

    try {
        // 2. Send the POST request to your local API
        const response = await fetch('http://localhost:3000/api/measurements', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fakeData)
        });

        // 3. Show the server's answer
        const result = await response.json();
        console.log("2. Server Response (Success):", result);
        
    } catch (error) {
        console.error("Error connecting to server:", error);
    }
}


testSave();