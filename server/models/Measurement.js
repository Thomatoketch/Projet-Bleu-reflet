const mongoose = require('mongoose');

const MeasurementSchema = new mongoose.Schema({
    // Client Identifier (Brand name) - Required to separate data
    clientId: { 
        type: String, 
        required: true 
    },

    // Selected Finger
    fingerName: { 
        type: String, 
        required: true 
    },

    // Measured Ring Size (EU Standard)
    sizeEU: { 
        type: Number, 
        required: true 
    },

    // Measured Ring Size (US Standard)
    sizeUS: { 
        type: Number 
    },

    // Diameter in millimeters
    diameterMm: { 
        type: Number 
    },

    // Technology used: 'LiDAR' or 'Standard' 
    detectionMode: { 
        type: String, 
        enum: ['LiDAR', 'Standard'], 
        default: 'Standard' 
    },

    // Device information
    deviceModel: { 
        type: String 
    },

    // How long the user spent measuring (in seconds)
    sessionDurationSeconds: { 
        type: Number 
    },

    // Timestamp
    createdAt: { 
        type: Date, 
        default: Date.now 
    }
});

// Export the model
module.exports = mongoose.model('Measurement', MeasurementSchema);