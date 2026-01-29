require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const { Parser } = require('json2csv'); 

const Measurement = require('./models/Measurement');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
const uri = process.env.MONGO_URI;
mongoose.connect(uri)
    .then(() => console.log("✅ MongoDB Connected"))
    .catch((err) => console.error("❌ Connection Error:", err));

// 1. Root Route
app.get('/', (req, res) => {
    res.send('API is active');
});

// 2. POST Route: Save event or measurement
app.post('/api/measurements', async (req, res) => {
    try {
        const newMeasurement = new Measurement(req.body);
        const savedData = await newMeasurement.save();
        res.status(201).json(savedData);
    } catch (error) {
        console.error("❌ Save Error:", error);
        res.status(500).json({ error: "Storage failed" });
    }
});

// 3. GET Route: Export all data to CSV
app.get('/api/export', async (req, res) => {
    try {
        const data = await Measurement.find({});
        
        // Define columns for the CSV file (including new tracking fields)
        const fields = [
            'clientId', 
            'eventType',
            'fingerName', 
            'sizeEU', 
            'sizeUS', 
            'diameterMm', 
            'attemptsCount',
            'detectionMode', 
            'deviceModel', 
            'createdAt'
        ];

        const json2csvParser = new Parser({ fields });
        const csv = json2csvParser.parse(data);

        res.header('Content-Type', 'text/csv');
        res.attachment('baguier_analytics.csv');
        res.send(csv);

    } catch (error) {
        res.status(500).send("Export error");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server on http://localhost:${PORT}`);
});