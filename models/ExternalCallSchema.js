// models/ExternalCallSchema.js

const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// One outbound call to an external service (Wise / MMT), stored exactly as it
// happened: what we sent and what came back. Shared by DriverLoginHistory and
// DriverDutyHistory. Build entries with utils/loginHistoryLogger.recordExternalCall.
// ─────────────────────────────────────────────────────────────────────────────

const ExternalCallSchema = new mongoose.Schema(
  {
    // "sms" → myvfirst SMS gateway (login OTP for MMT-only vehicles)
    service: { type: String, enum: ["wise", "mmt", "sms"], required: true },

    // e.g. "ValidateUser" | "ValidateOtp" | "Logout" | "OnOrOFFDuty" | ...
    endpoint: { type: String, required: true },

    // ── What we sent ────────────────────────────────────────────────────────
    request: {
      method: { type: String, required: true },
      url: { type: String, required: true },
      // The exact query params object passed to axios (passwords masked)
      params: { type: mongoose.Schema.Types.Mixed, default: {} },
      // The exact JSON body passed to axios (POST calls only)
      body: { type: mongoose.Schema.Types.Mixed, default: undefined },
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

module.exports = ExternalCallSchema;
