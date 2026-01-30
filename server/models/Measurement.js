const mongoose = require('mongoose');

// Schema for ring size measurements and app events
const MeasurementSchema = new mongoose.Schema({
    // Client Identifier (Brand name) - Required to separate data
    clientId: { 
        type: String, 
        required: true 
    },
    
    // Type of log: 'open' (app started) or 'success' (measurement completed)
    eventType: { 
        type: String, 
        default: 'success' 
    }, 
    
    // Selected Finger
    fingerName: { 
        type: String 
    },

    // Measured Ring Size (EU Standard)
    sizeEU: { 
        type: Number 
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

    // Number of measurement attempts during the session
    attemptsCount: { 
        type: Number, 
        default: 1 
    }, 

    // Timestamp
    createdAt: { 
        type: Date, 
        default: Date.now 
    }
});

// Export the model
module.exports = mongoose.model('Measurement', MeasurementSchema);