// Model/CommonDriverApp/AuthModelForCommonDApp.js
const mongoose = require("mongoose");

const authSubSchema = {
  verified: { type: Boolean, default: false },
  exist: { type: Boolean, default: false },
  otp: { type: Number },
  token: { type: String, default: "" },
  isNewRegister: { type: Boolean, default: false },
  registerDate: { type: Date },
};

const AuthSchemaDefinition = new mongoose.Schema(
  {
    vehicleNumber: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },

    // driverContact: For MMT drivers, their real mobile number.
    // For Wise-only drivers, this is populated AFTER OTP verification
    // from the Wise ValidateOtp response (MobileNo field).
    // We make it NOT required at schema level and handle it in the app.
    driverContact: {
      type: Number,
      default: null,
    },

    uniqueId: {
      type: String,
      unique: true,
      required: true,
    },

    driver: {
      contact: { type: Number },
      name: { type: String },
      driverId: { type: String },
    },

    // b2c = MMT (your internal system)
    b2c: authSubSchema,

    // b2b = Wise (external system)
    b2b: authSubSchema,

    isAutoLogin: { type: Boolean, default: false },

    // Config-driven flag: if true, always use Wise OTP flow
    isConfigDrivenSwitchForB2bonly: { type: Boolean, default: false },

    // Wise-specific fields populated after successful Wise OTP verification
    wiseUserId: { type: String, default: null }, // = vehicleNumber in Wise system
    wiseGcm: { type: String, default: null },
    wiseCabId: { type: Number, default: null }, // CabID from ValidateOtp response
    wiseAllocationId: { type: Number, default: null }, // AllocationID from ValidateOtp response
    wiseMobileNo: { type: String, default: null }, // MobileNo from ValidateOtp response
    wiseToken: { type: String, default: null }, // Token from ValidateOtp response
    wiseIsOnDuty: { type: Boolean, default: null },
    wiseCarType: { type: String, default: null },

    // Track active session
    activeSession: {
      token: { type: String },
      loginTime: { type: Date },
      source: { type: String, enum: ["mmt", "wise"] },
    },

    lastLoginAt: { type: Date, default: null },

    // OTP Tracking
    otpTracking: {
      code: { type: Number },
      generatedAt: { type: Date },
      expiresAt: { type: Date },
      source: { type: String, enum: ["mmt", "wise"] },
      attempts: { type: Number, default: 0 },
      lastAttemptAt: { type: Date },
      verifiedAt: { type: Date },
    },

    // Login History (capped at 20 entries via app logic)
    loginHistory: [
      {
        action: { type: String },
        timestamp: { type: Date, default: Date.now },
        source: { type: String },
        details: { type: mongoose.Schema.Types.Mixed },
      },
    ],

    // TTL index field — set this to auto-expire records if needed
    expiresAt: { type: Date, index: { expires: 0 } },
  },
  { timestamps: true },
);

// Indexes
AuthSchemaDefinition.index({ vehicleNumber: 1, driverContact: 1 });
AuthSchemaDefinition.index({ "activeSession.token": 1 });
AuthSchemaDefinition.index({ updatedAt: 1 });

module.exports = mongoose.model("AuthModelForCommonDApp", AuthSchemaDefinition);
