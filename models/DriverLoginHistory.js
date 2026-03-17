// Model/CommonDriverApp/DriverLoginHistory.js

const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// Separate collection for driver login history.
// Keeps AuthModelForCommonDApp lean — no more embedded loginHistory array
// that grows unboundedly and makes the document heavy.
// ─────────────────────────────────────────────────────────────────────────────

const DriverLoginHistorySchema = new mongoose.Schema(
  {
    vehicleNumber: {
      type: String,
      required: true,
      index: true,
    },

    // Reference back to the auth record — useful for cross-querying
    authRecordId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AuthModelForCommonDApp",
      required: true,
      index: true,
    },

    // Action types:
    //   login_initiated  → login API called
    //   login_success    → OTP verified, session opened
    //   otp_failed       → wrong OTP submitted
    //   wise_verify_failed → OTP matched locally but Wise API returned failure
    action: {
      type: String,
      enum: [
        "login_initiated",
        "login_success",
        "otp_failed",
        "wise_verify_failed",
      ],
      required: true,
    },

    // "mmt" | "wise" | "both"
    source: {
      type: String,
      enum: ["mmt", "wise", "both"],
      required: true,
    },

    // Any extra context relevant to the action
    details: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true, // createdAt = event time
    collection: "driver_login_histories",
  },
);

// TTL index — auto-delete history older than 90 days to keep collection lean
DriverLoginHistorySchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 },
);

module.exports = mongoose.model("DriverLoginHistory", DriverLoginHistorySchema);
