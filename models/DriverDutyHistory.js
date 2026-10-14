// models/DriverDutyHistory.js

const mongoose = require("mongoose");
const ExternalCallSchema = require("./ExternalCallSchema");

// ─────────────────────────────────────────────────────────────────────────────
// One entry per driver on/off duty API hit (get or update), successes AND
// failures. Stores raw facts only:
//   appRequest   → the body the app sent to us
//   externalCalls→ exactly what we sent to Wise / MMT and what came back
//   appResponse  → the status + body we returned to the app
// Kept apart from driver_login_histories: duty toggles are far more frequent
// and would bury the login timeline.
// ─────────────────────────────────────────────────────────────────────────────

const DriverDutyHistorySchema = new mongoose.Schema(
  {
    vehicleNumber: { type: String, required: true },

    // null when no auth record exists for the vehicle
    authRecordId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AuthModelForCommonDApp",
      default: null,
    },

    // "update" → /update-driver-on-off-status, "get" → /get-driver-on-off-status
    action: { type: String, enum: ["update", "get"], required: true },

    appRequest: {
      body: { type: mongoose.Schema.Types.Mixed, default: {} },
    },

    // Every external call made while serving this request, in order
    externalCalls: { type: [ExternalCallSchema], default: [] },

    appResponse: {
      status: { type: Number, required: true },
      body: { type: mongoose.Schema.Types.Mixed, default: null },
    },
  },
  {
    timestamps: true, // createdAt = event time
    collection: "driver_duty_histories",
  },
);

// Timeline of a single vehicle
DriverDutyHistorySchema.index({ vehicleNumber: 1, createdAt: -1 });

// TTL index — auto-delete history older than 90 days
DriverDutyHistorySchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 },
);

module.exports = mongoose.model("DriverDutyHistory", DriverDutyHistorySchema);
