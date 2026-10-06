// Model/CommonDriverApp/DriverLoginHistory.js

const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// Separate collection for driver login history.
// Keeps AuthModelForCommonDApp lean — no more embedded loginHistory array
// that grows unboundedly and makes the document heavy.
//
// Every login / OTP / logout attempt writes one entry — successes AND
// failures — holding exactly what was sent to each external API (Wise
// ValidateUser / ValidateOtp / Logout) and exactly what came back.
// No interpretation is stored here; server-side commentary goes to the
// console only (see utils/loginHistoryLogger.js).
// ─────────────────────────────────────────────────────────────────────────────

const ExternalCallSchema = new mongoose.Schema(
  {
    service: { type: String, enum: ["wise", "mmt"], required: true },

    // "ValidateUser" | "ValidateOtp" | "Logout"
    endpoint: { type: String, required: true },

    // ── What we sent ────────────────────────────────────────────────────────
    request: {
      method: { type: String, required: true },
      url: { type: String, required: true },
      // The exact params object passed to axios (only ApiPassword is masked)
      params: { type: mongoose.Schema.Types.Mixed, default: {} },
      sentAt: { type: Date, required: true },
    },

    // ── What we got back (null when no response arrived) ────────────────────
    response: {
      type: new mongoose.Schema(
        {
          status: { type: Number, default: null },
          // Raw response body, exactly as returned
          body: { type: mongoose.Schema.Types.Mixed, default: null },
          receivedAt: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: null,
    },

    // ── Transport error from axios (timeout, DNS, refused, non-2xx) ─────────
    error: {
      type: new mongoose.Schema(
        {
          code: { type: String, default: null }, // e.g. ECONNABORTED, ERR_BAD_RESPONSE
          message: { type: String, default: null },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { _id: false },
);

const DriverLoginHistorySchema = new mongoose.Schema(
  {
    vehicleNumber: {
      type: String,
      required: true,
      index: true,
    },

    // Reference back to the auth record — useful for cross-querying.
    // null when no auth record exists (e.g. vehicle not found → 404).
    authRecordId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AuthModelForCommonDApp",
      default: null,
      index: true,
    },

    // Action types:
    //   login_initiated    → login API succeeded, OTP dispatched
    //   login_failed       → login API failed (vehicle not found, 500, ...)
    //   login_success      → OTP verified, session opened
    //   otp_failed         → OTP validation rejected (wrong / expired / no session)
    //   wise_verify_failed → OTP matched locally but Wise ValidateOtp failed
    //   auto_login_success → autoLoginToB2BIfExistInMMT opened a session
    //   auto_login_failed  → autoLoginToB2BIfExistInMMT failed
    //   logout             → common logout API called, session(s) closed
    //   logout_failed      → common logout API failed
    action: {
      type: String,
      enum: [
        "login_initiated",
        "login_failed",
        "login_success",
        "otp_failed",
        "wise_verify_failed",
        "auto_login_success",
        "auto_login_failed",
        "logout",
        "logout_failed",
      ],
      required: true,
    },

    // "mmt" | "wise" | "both" | "none" (not found in any system / unknown)
    source: {
      type: String,
      enum: ["mmt", "wise", "both", "none"],
      required: true,
    },

    // Every external call made while serving this request, in order
    externalCalls: { type: [ExternalCallSchema], default: [] },
  },
  {
    timestamps: true, // createdAt = event time
    collection: "driver_login_histories",
  },
);

// Timeline of a single vehicle, and dashboards by action
DriverLoginHistorySchema.index({ vehicleNumber: 1, createdAt: -1 });
DriverLoginHistorySchema.index({ action: 1, createdAt: -1 });

// TTL index — auto-delete history older than 90 days to keep collection lean
DriverLoginHistorySchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 },
);

module.exports = mongoose.model("DriverLoginHistory", DriverLoginHistorySchema);
