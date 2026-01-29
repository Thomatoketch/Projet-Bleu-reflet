const mongoose = require('mongoose');

// Schema for ring size measurements and app events
const MeasurementSchema = new mongoose.Schema({
    // Brand or client name from URL
    clientId: { type: String, required: true },
    
    // Type of log: 'open' (app started) or 'success' (measurement completed)
    eventType: { type: String, default: 'success' }, 
    
    fingerName: { type: String },
    sizeEU: { type: Number },
    sizeUS: { type: Number },
    diameterMm: { type: Number },
    
    // Tech mode used: LiDAR (iPhone Pro) or Standard (Camera)
    detectionMode: { type: String, enum: ['LiDAR', 'Standard'], default: 'Standard' },
    
    // Browser/Device details
    deviceModel: { type: String },
    
    sessionDurationSeconds: { type: Number },
    
    // Number of measurement attempts during the session
    attemptsCount: { type: Number, default: 1 }, 
    
    // Automatic timestamp
    createdAt: { type: Date, default: Date.now }
});

// Export the model
module.exports = mongoose.model('Measurement', MeasurementSchema);