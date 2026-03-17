const mongoose = require("mongoose");

const MobileotpSchema = new mongoose.Schema({
  VehicleNumber: {
    type: String,
    required: true,
    // unique: true,
    // trim: true,
  },
  otp: {
    type: String,
    required: true,
    trim: true,
  },
  createdAt: {
    type: Date,
    required: true,
  },
  expireAt: {
    type: Date,
    required: true,
    // Indexing expireAt field for better performance
    index: { expires: 0 }, // This creates a TTL (Time-To-Live) index that automatically deletes documents after the specified time
  },
  vendorid: {
    type: String,
    default: null,
  },
});

const Mobileotp = mongoose.model("Mobileotp", MobileotpSchema);

module.exports = { Mobileotp };
