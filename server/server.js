require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { Parser } = require('json2csv');

// Import the Model
const Measurement = require('./models/Measurement');

const app = express();

app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", "frame-ancestors *");
    next();
});

app.use(cors());
app.use(express.json());


// Database Connection
const uri = process.env.MONGO_URI;
mongoose.connect(uri)
    .then(() => console.log("✅ MongoDB Connection Successful"))
    .catch((err) => console.error("❌ MongoDB Connection Error:", err));

// 1. Home Route
app.get('/', (req, res) => {
    res.send('API is running...');
});



// 2. Save Route
app.post('/api/measurements', async (req, res) => {
    try {
        const newMeasurement = new Measurement(req.body);
        const savedMeasurement = await newMeasurement.save();
        
        console.log("✅ New measurement saved:", savedMeasurement);
        res.status(201).json(savedMeasurement);
    } catch (error) {
        console.error("❌ Error saving measurement:", error);
        res.status(500).json({ error: "Could not save data" });
    }
});

// 3. Export CSV Route
app.get('/api/export', async (req, res) => {
    try {
        // Get all data from MongoDB
        const measurements = await Measurement.find({});

        const fields = [
            'clientId', 
            'fingerName', 
            'sizeEU', 
            'sizeUS', 
            'diameterMm', 
            'detectionMode', 
            'deviceModel', 
            'createdAt'
        ];

        const json2csvParser = new Parser({ fields });
        const csv = json2csvParser.parse(measurements);

        // Send file to download
        res.header('Content-Type', 'text/csv');
        res.attachment('baguier_stats.csv');
        res.send(csv);

    } catch (error) {
        console.error("❌ Error exporting CSV:", error);
        res.status(500).send("Error exporting data");
    }
});


// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server started on http://localhost:${PORT}`);
});