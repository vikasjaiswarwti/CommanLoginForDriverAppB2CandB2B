// controllers/CommonDriverApp/loginController.js

const ConfigDrivenDecision = require("../models/ConfigDrivenDecision");
const AuthModelForCommonDApp = require("../models/AuthModelForCommonDApp");
const DriverLoginHistory = require("../models/DriverLoginHistory");
const axios = require("axios");
const { verifyWiseOtp } = require("./validateOtpController");
const time = require("../utils/time");
const { sendLoginOtpSms } = require("../utils/smsGateway");
const {
  recordExternalCall,
  logLoginEvent,
  normalizeVehicle,
} = require("../utils/loginHistoryLogger");

// ─────────────────────────────────────────────
// Config endpoints
// ─────────────────────────────────────────────

const checkWhenToSwitchToB2BApp = async (req, res) => {
  try {
    const config = await ConfigDrivenDecision.findOne({});
    return res.status(200).json({
      success: true,
      isConfigDrivenSwitchForB2bonly:
        config?.isConfigDrivenSwitchForB2bonly || false,
    });
  } catch (error) {
    console.error("Config Fetch Error:", error.message);
    return res
      .status(500)
      .json({ success: false, message: "Internal Server Error" });
  }
};

const createOrUpdateConfig = async (req, res) => {
  try {
    const { isConfigDrivenSwitchForB2bonly } = req.body;

    if (typeof isConfigDrivenSwitchForB2bonly !== "boolean") {
      return res.status(400).json({
        success: false,
        message: "isConfigDrivenSwitchForB2bonly must be boolean",
      });
    }

    const updatedConfig = await ConfigDrivenDecision.findOneAndUpdate(
      { _id: "GLOBAL_CONFIG" },
      { $set: { isConfigDrivenSwitchForB2bonly } },
      { new: true, upsert: true },
    );

    return res.status(200).json({
      success: true,
      message: "Configuration saved successfully",
      data: updatedConfig,
    });
  } catch (error) {
    console.error("Config Save Error:", error.message);
    return res
      .status(500)
      .json({ success: false, message: "Internal Server Error" });
  }
};

// ─────────────────────────────────────────────
// Main login entry point
// ─────────────────────────────────────────────

const loginCommonForDriver = async (req, res) => {
  const externalCalls = [];
  let authRecordId = null;
  // Set by resendOtpCommonForDriver — same flow, logged / worded as a resend
  const isResend = req.otpResend === true;
  const successAction = isResend ? "otp_resent" : "login_initiated";
  const failAction = isResend ? "otp_resend_failed" : "login_failed";
  const successMessage = isResend ? "OTP resent successfully" : "Driver login flow initiated";
  try {
    const { vehicleNumber, gcm } = req.body;

    if (!vehicleNumber?.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Vehicle number is required" });
    }

    const normalizedVehicle = vehicleNumber.toLowerCase().replace(/\s/g, "");

    // ── STEP 1: Resolve Wise FIRST ────────────────────────────────────────────
    // Wise's ValidateUser call dispatches an OTP as a side effect of merely
    // checking existence, so we must know its outcome before deciding whether
    // MMT should generate/send a second, competing OTP.
    console.log(
      `${time.tds()} [OTP-SERVICE] loginCommonForDriver (flow=${isResend ? "resend" : "login"}): calling WISE OTP service (ValidateUser) for vehicle=${normalizedVehicle}`,
    );
    const wiseResult = await loginDriverForWiseService(
      normalizedVehicle,
      gcm,
    ).catch((err) => ({ __rejected: true, err }));

    const wiseData = wiseResult?.__rejected
      ? {
          success: false,
          existInWise: false,
          timeout: wiseResult.err?.code === "ECONNABORTED",
          error: wiseResult.err?.message,
        }
      : wiseResult;

    const existInWise = wiseData.existInWise || false;
    externalCalls.push(wiseData.callLog);

    // ── OTP source decision — purely data driven ─────────────────────────────
    //
    // Wise flow is active ONLY when Wise returned code:1 AND an otp value.
    const wiseOtp = wiseData.wiseData?.otp || null;
    const wiseCode = wiseData.wiseData?.code ?? null;

    const wiseFlowActive = existInWise && wiseCode === 1 && !!wiseOtp;

    console.log(
      `${time.tds()} [OTP-SERVICE] WISE OTP service result: existInWise=${existInWise}, wiseCode=${wiseCode}, otpReceived=${!!wiseOtp}, wiseFlowActive=${wiseFlowActive}`,
    );

    // ── STEP 2: Call the MMT (B2C) backend — always, whether or not Wise has it
    // Both systems are checked so we know Wise only / MMT only / both. B2C's
    // loginDriver generates an OTP and returns it, always with skipSms: true.
    // When the vehicle is in Wise, Wise already texted the driver and the Wise
    // OTP wins. For an MMT-only vehicle this service texts the MMT OTP itself
    // (STEP 3) — the driver gets exactly one SMS either way.
    console.log(
      `${time.tds()} [OTP-SERVICE] loginCommonForDriver (flow=${isResend ? "resend" : "login"}): calling MMT OTP service for vehicle=${normalizedVehicle}, skipSms=true`,
    );
    const mmtResult = await loginDriverForMMTService(normalizedVehicle).catch(
      (err) => ({ __rejected: true, err }),
    );

    const mmtData = mmtResult?.__rejected
      ? {
          success: false,
          existInMmt: false,
          error: mmtResult.err?.message,
        }
      : mmtResult;

    externalCalls.push(mmtData.callLog);

    const existInMmt = mmtData.existInMmt || false;

    const failLogin = async (httpStatus, code, message) => {
      await logLoginEvent(req, {
        vehicleNumber: normalizedVehicle,
        action: failAction,
        status: "failure",
        source: existInMmt ? (existInWise ? "both" : "mmt") : existInWise ? "wise" : "none",
        httpStatus,
        errorCode: code,
        message,
        externalCalls,
      });
      return res.status(httpStatus).json({
        success: false,
        existInMmt,
        existInWise,
        code,
        message,
      });
    };

    // ── Not in MMT and not in Wise — say exactly why ─────────────────────────
    if (!existInMmt && !existInWise) {
      // Wise call itself failed (timeout / non-2xx / network) — we could not
      // confirm the vehicle is absent from Wise, so this is NOT a "not found".
      if (!wiseData.success) {
        return failLogin(
          503,
          "WISE_UNAVAILABLE",
          "Could not reach Wise to verify this vehicle. Please try again.",
        );
      }
      if (mmtData.reason === "MMT_ERROR") {
        return failLogin(
          503,
          "MMT_UNAVAILABLE",
          "Could not verify this vehicle in MMT. Please try again.",
        );
      }
      if (mmtData.reason === "NO_ACTIVE_DRIVER") {
        return failLogin(
          404,
          "NO_ACTIVE_DRIVER",
          "Vehicle found but no active driver is assigned to it",
        );
      }
      if (mmtData.reason === "DRIVER_NOT_FOUND") {
        return failLogin(
          404,
          "DRIVER_NOT_FOUND",
          "Vehicle found but its assigned driver record is missing",
        );
      }
      return failLogin(404, "VEHICLE_NOT_FOUND", "Vehicle not found in any system");
    }

    // Wise OTP wins when active. Otherwise the MMT OTP (SMSed by B2C, never
    // visible to us) is the active one — it is verified through B2C later.
    const activeSource = wiseFlowActive ? "wise" : "mmt";
    // MMT OTP is stored only if B2C returned it in the loginDriver response
    // (mmtData.generatedOtp); otherwise it is null and B2C verifies it later.
    const activeOtp = wiseFlowActive ? wiseOtp : mmtData.generatedOtp || null;

    // ── STEP 3: MMT-only — text the MMT OTP to the driver ourselves ──────────
    // B2C was told skipSms:true, so nobody else will send it. Only for
    // vehicles NOT in Wise (Wise vehicles already got Wise's SMS).
    if (existInMmt && !existInWise && mmtData.generatedOtp) {
      if (!mmtData.mobile) {
        return failLogin(
          502,
          "MMT_MOBILE_MISSING",
          "Vehicle found but the driver's mobile number is not available to send the OTP.",
        );
      }

      const sms = await sendLoginOtpSms({
        mobile: mmtData.mobile,
        otp: mmtData.generatedOtp,
        vehicleNumber: normalizedVehicle,
      });
      externalCalls.push(sms.callLog);

      if (!sms.success) {
        return failLogin(
          502,
          "OTP_SEND_FAILED",
          "Vehicle found but the OTP could not be sent. Please try again.",
        );
      }
      mmtData.otpSent = true;
    }

    // The MMT OTP only counts when the vehicle is NOT in Wise (MMT-only).
    const otpIssued =
      wiseFlowActive || (existInMmt && !existInWise && !!mmtData.otpSent);

    // ── Vehicle exists but no OTP could be issued — don't pretend success ────
    // Wise: code:1 but no otp in the response (MMT OTP is not used when the
    // vehicle is in Wise). MMT-only: B2C returned no OTP to text.
    if (!otpIssued) {
      return failLogin(
        502,
        "OTP_NOT_AVAILABLE",
        "Vehicle found but no OTP was issued. Please try again.",
      );
    }

    console.log(
      `${time.tds()} [OTP-SERVICE] Active OTP source for vehicle=${normalizedVehicle}: ${activeSource.toUpperCase()}`,
    );

    // ── Driver identity ──────────────────────────────────────────────────────
    // B2C's loginDriver returns the driver's MobileNumber (used for the SMS);
    // name and id are not returned. Otherwise contact stays null until Wise
    // OTP verification supplies a mobile number.
    const driverContact =
      existInMmt && mmtData.mobile ? Number(mmtData.mobile) : null;
    const driverName = null;
    const driverId = null;

    const uniqueId = existInMmt
      ? `mmt_${normalizedVehicle}`
      : `wise_${normalizedVehicle}`;

    const now = new Date();
    const otpExpiry = new Date(now.getTime() + 5 * 60_000);

    // wise → we hold the code; mmt → B2C holds it, we only mark one as pending
    const buildOtpTracking = () => ({
      code: activeOtp,
      pending: activeSource === "mmt",
      generatedAt: now,
      expiresAt: otpExpiry,
      source: activeSource,
      attempts: 0,
    });

    // ── Find or create auth record ───────────────────────────────────────────
    let authRecord = await AuthModelForCommonDApp.findOne({
      $or: [{ uniqueId }, { vehicleNumber: normalizedVehicle }],
    }).sort({ createdAt: -1 });

    if (!authRecord) {
      // ── CREATE ───────────────────────────────────────────────────────────────
      authRecord = new AuthModelForCommonDApp({
        vehicleNumber: normalizedVehicle,
        driverContact,
        uniqueId,
        driver: { contact: driverContact, name: driverName, driverId },

        b2c: {
          exist: existInMmt,
          verified: false,
          otp: existInMmt ? mmtData.generatedOtp || null : null,
          token: "",
          isNewRegister: false,
        },

        b2b: {
          exist: existInWise,
          verified: false,
          otp: existInWise ? wiseOtp : null,
          token: "",
          isNewRegister: false,
        },

        wiseUserId: existInWise ? normalizedVehicle : null,
        wiseGcm: gcm || null,

        otpTracking: buildOtpTracking(),
      });
    } else {
      // ── UPDATE ───────────────────────────────────────────────────────────────
      authRecord.b2c.exist = existInMmt;
      authRecord.b2b.exist = existInWise;

      if (existInMmt) {
        authRecord.b2c.otp = mmtData.generatedOtp || null;
        if (driverContact) {
          authRecord.driverContact = driverContact;
          authRecord.driver.contact = driverContact;
        }
      }

      if (existInWise) {
        authRecord.wiseUserId = normalizedVehicle;
        authRecord.wiseGcm = gcm || authRecord.wiseGcm;
        authRecord.b2b.otp = wiseOtp;
      }

      // Always overwrite otpTracking — Wise OTP wins when wiseFlowActive
      authRecord.otpTracking = buildOtpTracking();
    }

    // Config flag stored for record-keeping — does NOT influence OTP source
    const config = await ConfigDrivenDecision.findOne({});
    authRecord.isConfigDrivenSwitchForB2bonly =
      config?.isConfigDrivenSwitchForB2bonly || false;

    await authRecord.save();
    authRecordId = authRecord._id;

    // ── Write login_initiated to history collection (not on the document) ────
    await logLoginEvent(req, {
      vehicleNumber: normalizedVehicle,
      authRecordId,
      action: successAction,
      status: "success",
      source: existInMmt ? (existInWise ? "both" : "mmt") : "wise",
      httpStatus: 200,
      message: successMessage,
      externalCalls,
      details: {
        b2cExists: existInMmt,
        b2bExists: existInWise,
        otpSource: activeSource,
        wiseFlowActive,
        otpSent: otpIssued,
        mmtReason: mmtData.reason || mmtData.error || null,
      },
    });

    // ── Build response ───────────────────────────────────────────────────────
    const response = {
      success: true,
      existInMmt,
      existInWise,
      vehicleId: mmtData.vehicleId || null,
      driverContact: authRecord.driverContact ?? null,
      message: successMessage,
      driverSource: existInMmt ? "mmt" : "wise",
      useWiseOtp: wiseFlowActive,
    };

    if (existInMmt) {
      response.b2c = {
        exist: true,
        verified: false,
        otpSent: !!mmtData.otpSent,
        otpExpiry: mmtData.otpSent ? otpExpiry : null,
      };
    }

    if (existInWise) {
      response.b2b = {
        exist: true,
        verified: false,
        message: wiseData.wiseData?.message || null,
        code: wiseCode,
      };
      if (wiseOtp) {
        response.b2bOtpSent = true;
        response.b2bOtpExpiry = otpExpiry;
        // NOTE: Remove b2bOtp in production; here for debugging only
        // response.b2bOtp = wiseOtp;
      }
    }

    return res.status(200).json(response);
  } catch (err) {
    console.error("Common Login Error:", err.message);
    await logLoginEvent(req, {
      vehicleNumber: normalizeVehicle(req.body?.vehicleNumber),
      authRecordId,
      action: failAction,
      status: "failure",
      httpStatus: 500,
      errorCode: "INTERNAL_ERROR",
      message: err.message,
      externalCalls,
    });
    return res
      .status(500)
      .json({ success: false, message: "Internal Server Error" });
  }
};

// ─────────────────────────────────────────────
// Common resend OTP
//
// POST /resend-common-otp { vehicleNumber, gcm? }  — same payload as login.
//
// Only allowed while a login is in progress (an OTP was issued and not yet
// verified) and at most once per OTP_RESEND_COOLDOWN_SECONDS (default 30).
// It then re-runs loginCommonForDriver, so routing is identical to login:
//   Wise vehicle  → Wise ValidateUser issues + texts a fresh OTP
//   MMT only      → MMT loginDriver issues a fresh OTP, we text it
// The new OTP replaces the old one (otpTracking, attempts reset). The response
// has the same shape as login; history logs otp_resent / otp_resend_failed.
// ─────────────────────────────────────────────

const resendOtpCommonForDriver = async (req, res) => {
  const startedAt = Date.now();
  const vehicleNumber = req.body?.vehicleNumber;
  const normalizedVehicle = normalizeVehicle(vehicleNumber);
  const TAG = "[OTP-RESEND]";
  // Long values (gcm) → first/last 6 chars only
  const short = (v) =>
    !v ? "-" : String(v).length > 16 ? `${String(v).slice(0, 6)}…${String(v).slice(-6)}` : String(v);

  // Final line for EVERY outcome — guards below and the delegated login flow
  if (typeof res.on === "function") {
    res.on("finish", () => {
      const line = `${time.tds()} ${TAG} ← resend finished for vehicle=${normalizedVehicle ?? "-"}: http=${res.statusCode} (${Date.now() - startedAt}ms)`;
      (res.statusCode >= 500 ? console.error : res.statusCode >= 400 ? console.warn : console.log)(line);
    });
  }

  const refuse = async (httpStatus, code, message, authRecordId = null, extra = {}) => {
    console.warn(`${time.tds()} ${TAG} refused for vehicle=${normalizedVehicle}: ${code} — ${message}`);
    await logLoginEvent(req, {
      vehicleNumber: normalizedVehicle,
      authRecordId,
      action: "otp_resend_failed",
      status: "failure",
      source: "none",
      httpStatus,
      errorCode: code,
      message,
    });
    return res.status(httpStatus).json({ success: false, code, message, ...extra });
  };

  console.log(
    `${time.tds()} ${TAG} → resend requested: vehicleNumber=${vehicleNumber ?? "-"} (normalized=${normalizedVehicle ?? "-"}), gcm=${short(req.body?.gcm)}`,
  );

  try {
    if (!vehicleNumber?.trim()) {
      console.warn(`${time.tds()} ${TAG} refused: vehicleNumber missing in request body`);
      return res
        .status(400)
        .json({ success: false, message: "Vehicle number is required" });
    }

    const authRecord = await AuthModelForCommonDApp.findOne({
      vehicleNumber: normalizedVehicle,
    }).sort({ createdAt: -1 });

    const otp = authRecord?.otpTracking;
    const loginInProgress = !!(otp && (otp.code || otp.pending));
    const ageSec = otp?.generatedAt
      ? Math.floor((Date.now() - new Date(otp.generatedAt).getTime()) / 1000)
      : null;
    const expired = otp?.expiresAt ? new Date() > new Date(otp.expiresAt) : null;

    console.log(
      `${time.tds()} ${TAG} auth record for vehicle=${normalizedVehicle}: ${authRecord ? `found (${authRecord._id})` : "NOT FOUND"}` +
        (authRecord
          ? `, b2b.exist=${!!authRecord.b2b?.exist}, b2c.exist=${!!authRecord.b2c?.exist}` +
            `, otp: source=${otp?.source ?? "-"}, active=${loginInProgress}, issued=${ageSec ?? "-"}s ago, expired=${expired ?? "-"}, wrongAttempts=${otp?.attempts ?? 0}`
          : ""),
    );

    if (!authRecord || !loginInProgress) {
      return refuse(
        400,
        "NO_LOGIN_IN_PROGRESS",
        "No login in progress for this vehicle. Please login first.",
        authRecord?._id,
      );
    }

    const cooldownSec = Number(process.env.OTP_RESEND_COOLDOWN_SECONDS) || 30;
    const elapsedSec = otp.generatedAt
      ? (Date.now() - new Date(otp.generatedAt).getTime()) / 1000
      : Infinity;

    if (elapsedSec < cooldownSec) {
      const retryAfterSeconds = Math.ceil(cooldownSec - elapsedSec);
      return refuse(
        429,
        "OTP_RESEND_TOO_SOON",
        `Please wait ${retryAfterSeconds} seconds before requesting a new OTP.`,
        authRecord._id,
        { retryAfterSeconds },
      );
    }

    // Keep the device's gcm if the app does not send it again
    const gcmSource = req.body.gcm ? "request" : authRecord.wiseGcm ? "auth record" : "none";
    req.body.gcm = req.body.gcm || authRecord.wiseGcm || undefined;
    req.otpResend = true;

    console.log(
      `${time.tds()} ${TAG} checks passed for vehicle=${normalizedVehicle} (cooldown ${cooldownSec}s, last OTP ${Math.floor(elapsedSec)}s ago); gcm from ${gcmSource}=${short(req.body.gcm)} → running login flow to issue a fresh OTP`,
    );

    return loginCommonForDriver(req, res);
  } catch (err) {
    console.error(`${time.tds()} ${TAG} error for vehicle=${normalizedVehicle}:`, err.stack || err.message);
    return refuse(500, "INTERNAL_ERROR", "Internal Server Error");
  }
};

// ─────────────────────────────────────────────
// MMT service login
// ─────────────────────────────────────────────

// B2C (MMT) backend, reached over HTTP — no direct DB access.
//
// POST {MMT_BASE_URL}/0auth/Auth/loginDriver { VehicleNumber }
//   200 { Vehicleid }  → vehicle + active driver exist, 4-digit OTP SMSed
//   404 { message }    → "Vehicle not found" | "no Active Driver to this
//                        Vehicle" | "this dRiver id not exist in driver db"
// B2C returns only Vehicleid — never the OTP, driver contact or name. The OTP
// is verified later through B2C's verifyOtpMobile (verifyMmtOtp in
// validateOtpController). B2C swallows SMS-gateway failures and still answers 200.
const loginDriverForMMTService = async (vehicleNumber) => {
  const mmtApiUrl = `${process.env.MMT_BASE_URL}/0auth/Auth/loginDriver`;
  // skipSms: true ALWAYS → B2C generates + saves + returns the OTP but never
  // texts. This service sends the SMS itself (utils/smsGateway) for MMT-only
  // vehicles; Wise vehicles are texted by Wise.
  const skipSms = true;
  const body = { VehicleNumber: vehicleNumber, skipSms };
  const sentAt = new Date();
  const record = (extra) =>
    recordExternalCall({
      service: "mmt",
      endpoint: "loginDriver",
      method: "POST",
      url: mmtApiUrl,
      params: body,
      sentAt,
      ...extra,
    });

  try {
    console.log(
      `${time.tds()} [OTP-SERVICE] MMT loginDriver API called (skipSms=${skipSms}) for vehicle=${vehicleNumber}, url=${mmtApiUrl}`,
    );

    const response = await axios.post(mmtApiUrl, body, {
      timeout: Number(process.env.MMT_TIMEOUT_MS) || 5000,
    });
    const callLog = record({ response });

    // 200 { Vehicleid } is the ONLY indicator that the vehicle exists in MMT
    if (!response.data?.Vehicleid) {
      return {
        success: false,
        existInMmt: false,
        reason: "MMT_ERROR",
        error: "MMT loginDriver returned no Vehicleid",
        callLog,
      };
    }

    return {
      success: true,
      existInMmt: true,
      vehicleId: response.data.Vehicleid,
      otpSent: false, // B2C never texts — set by the caller once our SMS goes out
      // Driver's mobile, needed to text the OTP. B2C must include it in the
      // loginDriver response as MobileNumber.
      mobile:
        response.data.MobileNumber != null
          ? String(response.data.MobileNumber).trim()
          : null,
      // B2C's loginDriver answers { Vehicleid, VehicleNumber, otp }. The OTP
      // is stored and checked locally, exactly like the Wise OTP. Kept as a
      // string so a leading zero survives.
      generatedOtp:
        response.data.otp != null ? String(response.data.otp).trim() : null,
      callLog,
    };
  } catch (err) {
    const callLog = record({ error: err });
    console.error(
      `${time.tds()} [OTP-SERVICE] MMT loginDriver failed for vehicle=${vehicleNumber}: code=${err.code}, status=${err.response?.status ?? "-"}, msg=${err.message}`,
    );

    if (err.response?.status === 404) {
      const msg = String(err.response.data?.message || "").toLowerCase();
      let reason = "VEHICLE_NOT_FOUND";
      if (msg.includes("no active driver")) reason = "NO_ACTIVE_DRIVER";
      else if (msg.includes("driver id not exist")) reason = "DRIVER_NOT_FOUND";
      return { success: false, existInMmt: false, reason, callLog };
    }

    // timeout / network / 5xx — NOT "vehicle not found"
    return {
      success: false,
      existInMmt: false,
      reason: "MMT_ERROR",
      error: err.message,
      callLog,
    };
  }
};

// ─────────────────────────────────────────────
// Wise service login
//
// ValidateUser response: { code: 1, otp: "920220", msg: "Welcome in WTI mobile app" }
// code: 1 is the ONLY indicator that this vehicle exists in Wise
// ─────────────────────────────────────────────

const loginDriverForWiseService = async (vehicleNumber, gcm) => {
  const wiseApiUrl = `${process.env.WISE_BASE_URL}/api/Login/ValidateUser`;
  const params = {
    UserID: vehicleNumber,
    LoginType: 0,
    password: 0,
    gcm: gcm || "dummy_gcm_token",
    ApiID: process.env.WISE_API_ID || "WSId201",
    ApiPassword: process.env.WISE_API_PASSWORD || "WSPwd201",
  };
  const sentAt = new Date();
  const record = (extra) =>
    recordExternalCall({
      endpoint: "ValidateUser",
      url: wiseApiUrl,
      params,
      sentAt,
      ...extra,
    });

  try {
    console.log(
      `${time.tds()} [OTP-SERVICE] WISE ValidateUser API called (dispatches OTP as side effect) for vehicle=${vehicleNumber}, url=${wiseApiUrl}`,
    );

    const response = await axios.get(wiseApiUrl, { params, timeout: 5000 });

    const exists = !!response.data && response.data.code === 1;
    const callLog = record({ response });

    if (!response.data) return { success: false, existInWise: false, callLog };

    console.log(
      `${time.tds()} [OTP-SERVICE] WISE ValidateUser response for vehicle=${vehicleNumber}: code=${response.data.code}, otpPresent=${!!response.data.otp}, msg=${response.data.msg}`,
    );

    return {
      success: true,
      existInWise: exists,
      callLog,
      wiseData: {
        code: response.data.code,
        message: response.data.msg,
        otp: response.data.otp || null,
        userId: vehicleNumber,
      },
    };
  } catch (err) {
    const callLog = record({ error: err });
    console.error(
      `${time.tds()} [OTP-SERVICE] WISE ValidateUser failed for vehicle=${vehicleNumber}: code=${err.code}, status=${err.response?.status ?? "-"}, msg=${err.message}`,
    );
    if (err.response) {
      const data = err.response.data || {};
      return {
        success: false,
        existInWise: false,
        wiseServerError: err.response.status >= 500,
        wiseData: { code: data.code, message: data.msg },
        error: err.message,
        callLog,
      };
    }
    if (err.code === "ECONNABORTED") {
      return {
        success: false,
        existInWise: false,
        timeout: true,
        error: "Wise service timeout",
        callLog,
      };
    }
    return { success: false, existInWise: false, error: err.message, callLog };
  }
};

const getCommanAuthDetailOnEveryHit = async (req, res) => {
  try {
    const { vehicleNumber, btobtoken, btoctoken } = req.body;

    if (!vehicleNumber) {
      return res.status(400).json({
        success: false,
        message: "vehicleNumber is required and must be a string",
        code: "INVALID_VEHICLE_NUMBER",
      });
    }

    const normalizedVehicle = vehicleNumber.toLowerCase().replace(/\s/g, "");

    const authRecord = await AuthModelForCommonDApp.findOne({
      vehicleNumber: normalizedVehicle,
    }).sort({ createdAt: -1 });

    if (!authRecord) {
      return res.status(404).json({
        success: false,
        message: "No auth record found",
      });
    }

    let b2bToken = btobtoken;
    let b2cToken = btoctoken;

    // If B2C token is null → take from DB
    if (!b2cToken && authRecord?.b2c?.token) {
      b2cToken = authRecord.b2c.token;
    }

    // If B2B token is null → take from DB, but only while the vehicle still
    // exists in B2B (a stale Wise token must not beat a valid B2C token)
    if (!b2bToken && authRecord?.b2b?.exist && authRecord?.b2b?.token) {
      b2bToken = authRecord.b2b.token;
    }

    // ─────────────────────────────────────────────
    // Prepare response (same as validateOtp format)
    // ─────────────────────────────────────────────

    const finalResponse = {
      success: true,
      Code: 1,
      Msg: "Token fetched successfully",
      source: authRecord?.activeSession?.source || null,

      // ✅ MobileNo → ALWAYS string
      MobileNo:
        authRecord.mobileNo != null ? String(authRecord.mobileNo) : null,

      // Single effective token — B2B (Wise) wins, else B2C (MMT)
      Token: b2bToken || b2cToken || null,

      AllocationID: authRecord?.wiseAllocationId ?? null,
      CabID: authRecord?.wiseCabId ?? null,
      CabNo: authRecord?.driver?.name || null,
      CarType: authRecord?.wiseCarType || null,
      OTP: null,
      IsOnDuty: authRecord?.wiseIsOnDuty ?? null,
      // VendorID: authRecord?.wiseVendorId ?? null,
      // BranchID: authRecord?.wiseBranchId ?? null,

      VendorID: authRecord.vendorId != null ? Number(authRecord.vendorId) : 0,
      BranchID: authRecord.branchId != null ? Number(authRecord.branchId) : 0,
    };

    return res.status(200).json(finalResponse);
  } catch (error) {
    console.error("getCommanAuthDetailOnEveryHit Error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
};

const autoLoginToB2BIfExistInMMT = async (req, res) => {
  try {
    const { vehicleNumber } = req.body;

    if (!vehicleNumber?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Vehicle number is required",
      });
    }

    const normalizedVehicle = vehicleNumber.toLowerCase().replace(/\s/g, "");

    // ── STEP 1: (MMT existence) ──────────────────────────────────────────────
    // The Vehicle DB lookup is gone. B2C's loginDriver sends an SMS, so
    // existence is inferred from a past successful B2C login (STEP 3).

    // ── STEP 2: Get GCM from auth model ─────────────────────────────────────
    const authRecord = await AuthModelForCommonDApp.findOne({
      vehicleNumber: normalizedVehicle,
    }).sort({ createdAt: -1 });

    const gcm = authRecord?.wiseGcm || null;

    // ── STEP 3: Check if driver has ever logged in as B2C ───────────────────
    const hasB2CHistory = await DriverLoginHistory.findOne({
      vehicleNumber: normalizedVehicle,
      source: { $in: ["mmt", "both"] },
      action: "login_success",
    });

    if (!hasB2CHistory) {
      return res.status(200).json({
        success: false,
        neverLoggedAsB2C: true,
        message: "Driver has never completed a B2C login",
      });
    }

    // Also attempt Wise login in parallel to mirror loginCommonForDriver logic
    console.log(
      `${time.tds()} [OTP-SERVICE] autoLoginToB2BIfExistInMMT: calling WISE OTP service (ValidateUser) for vehicle=${normalizedVehicle}`,
    );
    const wiseResult = await loginDriverForWiseService(
      normalizedVehicle,
      gcm,
    ).catch(() => ({ success: false, existInWise: false }));

    const existInWise = wiseResult?.existInWise || false;
    const wiseOtp = wiseResult?.wiseData?.otp || null;
    const wiseCode = wiseResult?.wiseData?.code || null;
    const wiseFlowActive = existInWise && wiseCode === 1 && !!wiseOtp;

    const activeOtp = wiseFlowActive ? wiseOtp : loginResult.generatedOtp;
    const activeSource = wiseFlowActive ? "wise" : "mmt";

    console.log(
      `${time.tds()} [OTP-SERVICE] autoLoginToB2BIfExistInMMT: active OTP source for vehicle=${normalizedVehicle}: ${activeSource.toUpperCase()}`,
    );

    const now = new Date();
    const otpExpiry = new Date(now.getTime() + 5 * 60_000);

    // ── STEP 5: Upsert auth record with fresh OTP ────────────────────────────
    let record = await AuthModelForCommonDApp.findOne({
      vehicleNumber: normalizedVehicle,
    }).sort({ createdAt: -1 });

    if (!record) {
      record = new AuthModelForCommonDApp({
        vehicleNumber: normalizedVehicle,
        driverContact: loginResult.driverContact,
        uniqueId: `${normalizedVehicle}_${loginResult.driverContact}`,
        driver: {
          contact: loginResult.driverContact,
          name: loginResult.driverName,
          driverId: loginResult.driverId,
        },
        b2c: {
          exist: true,
          verified: false,
          otp: loginResult.generatedOtp,
          token: "",
          isNewRegister: false,
        },
        b2b: {
          exist: existInWise,
          verified: false,
          otp: wiseOtp || null,
          token: "",
          isNewRegister: false,
        },
        wiseGcm: gcm,
        otpTracking: {
          code: activeOtp,
          generatedAt: now,
          expiresAt: otpExpiry,
          source: activeSource,
          attempts: 0,
        },
      });
    } else {
      record.b2c.exist = true;
      record.b2c.otp = loginResult.generatedOtp;
      record.b2c.verified = false;
      record.b2b.exist = existInWise;
      if (existInWise) record.b2b.otp = wiseOtp;
      record.otpTracking = {
        code: activeOtp,
        generatedAt: now,
        expiresAt: otpExpiry,
        source: activeSource,
        attempts: 0,
      };
    }

    await record.save();

    // ── STEP 6: Auto-verify the OTP internally ───────────────────────────────
    // Simulate what validateOtp does — call verifyWiseOtp if wise flow,
    // otherwise issue an MMT token directly.
    let verificationResult;

    if (wiseFlowActive) {
      verificationResult = await verifyWiseOtp(
        normalizedVehicle,
        activeOtp,
        gcm,
      );
    } else {
      verificationResult = {
        success: true,
        source: "mmt",
        token: `mmt_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`,
        message: "Auto login OTP verified",
      };
    }

    if (!verificationResult.success) {
      await logLoginEvent(req, {
        vehicleNumber: normalizedVehicle,
        authRecordId: record._id,
        action: "auto_login_failed",
        status: "failure",
        source: verificationResult.source,
        httpStatus: 400,
        errorCode: "WISE_VERIFY_FAILED",
        message: verificationResult.message || "Auto OTP verification failed",
        externalCalls: [wiseResult?.callLog, verificationResult.callLog],
      });
      return res.status(400).json({
        success: false,
        message: verificationResult.message || "Auto OTP verification failed",
      });
    }

    // ── STEP 7: Persist verified session ────────────────────────────────────
    const sessionToken = verificationResult.token;

    if (verificationResult.source === "mmt") {
      record.b2c.verified = true;
      record.b2c.token = sessionToken;
    } else {
      record.b2b.verified = true;
      record.b2b.token = sessionToken;

      const wd = verificationResult.wiseDetails || {};
      if (wd.mobileNo) record.driverContact = Number(wd.mobileNo);
      if (wd.wiseToken) record.wiseToken = wd.wiseToken;
      if (wd.cabId) record.wiseCabId = wd.cabId;
      if (wd.allocationId) record.wiseAllocationId = wd.allocationId;
      if (wd.carType) record.wiseCarType = wd.carType;
      if (wd.isOnDuty !== undefined) record.wiseIsOnDuty = wd.isOnDuty;
      if (wd.vendorId) record.wiseVendorId = wd.vendorId;
      if (wd.branchId) record.wiseBranchId = wd.branchId;

      // Dual-flow: also open B2C session with the same B2B (Wise) token
      if (existInWise) {
        record.b2c.verified = true;
        record.b2c.token = sessionToken;
      }
    }

    record.otpTracking.code = null;
    record.activeSession = {
      token: sessionToken,
      loginTime: now,
      source: verificationResult.source,
    };
    record.lastLoginAt = now;

    await record.save();

    await logLoginEvent(req, {
      vehicleNumber: normalizedVehicle,
      authRecordId: record._id,
      action: "auto_login_success",
      status: "success",
      source: verificationResult.source,
      httpStatus: 200,
      externalCalls: [wiseResult?.callLog, verificationResult.callLog],
      details: {
        autoLogin: true,
        token: sessionToken,
        driverContact: record.driverContact,
      },
    });

    // ── STEP 8: Return same shape as validateOtp ─────────────────────────────
    const wd = verificationResult.wiseDetails || {};

    const finalResponse = {
      success: true,
      Code: 1,
      Msg: "Auto B2B login successful",
      source: verificationResult.source,
      MobileNo: wd.mobileNo || record.driverContact || null,
      // Single effective token — Wise token on the Wise flow, else MMT token
      Token: sessionToken || null,
      AllocationID: wd.allocationId ?? null,
      CabID: wd.cabId ?? null,
      CabNo: wd.cabNo || null,
      CarType: wd.carType || null,
      OTP: null,
      IsOnDuty: wd.isOnDuty ?? null,
      VendorID: wd.vendorId ?? null,
      BranchID: wd.branchId ?? null,
    };

    return res.status(200).json(finalResponse);
  } catch (error) {
    console.error("autoLoginToB2BIfExistInMMT Error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
};

// ─────────────────────────────────────────────
// Wise service logout
//
// Ends the driver's Wise (B2B) session. Unlike ValidateUser/ValidateOtp,
// Logout is authenticated by the session token itself, not ApiID/ApiPassword.
// ─────────────────────────────────────────────

const logoutDriverFromWiseService = async (
  wiseToken,
  wiseUserId,
  wiseAllocationId,
) => {
  const wiseApiUrl = `${process.env.WISE_BASE_URL}/api/Chauffuer/Logout`;
  const params = {
    token: wiseToken,
    userid: wiseUserId,
    AllocationID: wiseAllocationId,
    Status: 0,
  };
  const sentAt = new Date();
  const record = (extra) =>
    recordExternalCall({
      endpoint: "Logout",
      url: wiseApiUrl,
      params,
      sentAt,
      ...extra,
    });

  try {
    console.log(
      `${time.tds()} [OTP-SERVICE] WISE Logout API called for userId=${wiseUserId}, allocationId=${wiseAllocationId}`,
    );

    const response = await axios.get(wiseApiUrl, { params, timeout: 5000 });

    console.log(
      `${time.tds()} [OTP-SERVICE] WISE Logout API response for userId=${wiseUserId}:`,
      response.data,
    );

    return {
      success: true,
      data: response.data,
      callLog: record({ response }),
    };
  } catch (err) {
    console.error(`${time.tds()} Wise logout error:`, err.message);
    return {
      success: false,
      error: err.message,
      callLog: record({ error: err }),
    };
  }
};

// ─────────────────────────────────────────────
// Common logout entry point
//
// Mirrors loginCommonForDriver's decision-driven approach: the caller only
// sends the vehicle number, and this figures out — purely from what's
// actually active on the auth record — which system(s) to log out of.
// A Wise session is closed via Wise's own Logout API; an MMT (B2C) session
// has no external session to invalidate, so it's cleared locally only.
// ─────────────────────────────────────────────

const logoutCommonForDriver = async (req, res) => {
  try {
    // Only the vehicle number is taken from the app — every Wise session value
    // (token, userid, AllocationID) comes from the auth record in our DB.
    const { vehicleNumber } = req.body;

    if (!vehicleNumber?.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Vehicle number is required" });
    }

    const normalizedVehicle = vehicleNumber.toLowerCase().replace(/\s/g, "");

    const authRecord = await AuthModelForCommonDApp.findOne({
      vehicleNumber: normalizedVehicle,
    }).sort({ createdAt: -1 });

    if (!authRecord) {
      await logLoginEvent(req, {
        vehicleNumber: normalizedVehicle,
        action: "logout_failed",
        status: "failure",
        source: "none",
        httpStatus: 404,
        errorCode: "NO_AUTH_RECORD",
        message: "No auth record found for this vehicle",
      });
      return res.status(404).json({
        success: false,
        message: "No auth record found for this vehicle",
      });
    }

    const wasLoggedIntoWise = !!(
      authRecord.b2b?.verified && authRecord.b2b?.token
    );
    const wasLoggedIntoMmt = !!(
      authRecord.b2c?.verified && authRecord.b2c?.token
    );

    if (!wasLoggedIntoWise && !wasLoggedIntoMmt) {
      return res.status(200).json({
        success: true,
        message: "No active session to log out",
        loggedOutFrom: [],
      });
    }

    const loggedOutFrom = [];
    let wiseLogoutResult = null;

    // ── Wise (B2B) logout — only when a Wise session is actually active ──────
    // Session values come only from the auth record (saved at OTP
    // verification); nothing from the request body is used.
    if (wasLoggedIntoWise) {
      const wiseToken = authRecord.wiseToken || authRecord.b2b.token;
      const wiseUserId = authRecord.wiseUserId || normalizedVehicle;
      const wiseAllocationId = authRecord.wiseAllocationId;

      console.log(
        `${time.tds()} [OTP-SERVICE] logoutCommonForDriver: Wise session from DB for vehicle=${normalizedVehicle}: userid=${wiseUserId}, AllocationID=${wiseAllocationId ?? "-"}, token=${wiseToken ? "present" : "MISSING"}`,
      );

      wiseLogoutResult = await logoutDriverFromWiseService(
        wiseToken,
        wiseUserId,
        wiseAllocationId,
      );

      authRecord.b2b.verified = false;
      authRecord.b2b.token = "";
      loggedOutFrom.push("wise");
    }

    // ── MMT (B2C) logout — nothing external to call, clear locally ──────────
    if (wasLoggedIntoMmt) {
      authRecord.b2c.verified = false;
      authRecord.b2c.token = "";
      loggedOutFrom.push("mmt");
    }

    authRecord.activeSession = null;

    await authRecord.save();

    await logLoginEvent(req, {
      vehicleNumber: normalizedVehicle,
      authRecordId: authRecord._id,
      action: "logout",
      status: "success",
      source: loggedOutFrom.length === 2 ? "both" : loggedOutFrom[0],
      httpStatus: 200,
      externalCalls: [wiseLogoutResult?.callLog],
      details: {
        loggedOutFrom,
        wiseLogoutSuccess: wiseLogoutResult?.success ?? null,
        wiseLogoutError:
          wiseLogoutResult?.success === false ? wiseLogoutResult.error : null,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Logout successful",
      loggedOutFrom,
      ...(wasLoggedIntoWise
        ? {
            wiseLogout: {
              success: wiseLogoutResult.success,
              data: wiseLogoutResult.data || null,
              error: wiseLogoutResult.error || null,
            },
          }
        : {}),
    });
  } catch (err) {
    console.error("Common Logout Error:", err.message);
    await logLoginEvent(req, {
      vehicleNumber: normalizeVehicle(req.body?.vehicleNumber),
      action: "logout_failed",
      status: "failure",
      httpStatus: 500,
      errorCode: "INTERNAL_ERROR",
      message: err.message,
    });
    return res
      .status(500)
      .json({ success: false, message: "Internal Server Error" });
  }
};

module.exports = {
  loginCommonForDriver,
  resendOtpCommonForDriver,
  checkWhenToSwitchToB2BApp,
  createOrUpdateConfig,

  getCommanAuthDetailOnEveryHit,
  autoLoginToB2BIfExistInMMT,
  logoutCommonForDriver,
};
