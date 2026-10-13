// controllers/CommonDriverApp/validateOtpController.js

const AuthModelForCommonDApp = require("../models/AuthModelForCommonDApp");
const {
  recordExternalCall,
  logLoginEvent,
  normalizeVehicle,
} = require("../utils/loginHistoryLogger");
const axios = require("axios");

// ─────────────────────────────────────────────────────────────────────────────
// Main OTP validation entry point
// ─────────────────────────────────────────────────────────────────────────────

const validateOtp = async (req, res) => {
  let authRecordId = null;
  try {
    const { vehicleNumber, otp, gcm, device_model, os_version, app_version } =
      req.body;
    const device_brand = req.body.device_brand ?? req.body.deviceBrand;
    const miscellaneous = req.body.miscellaneous ?? req.body.miscellenious;

    if (!vehicleNumber || !otp) {
      return res.status(400).json({
        success: false,
        message: "Vehicle number and OTP are required",
      });
    }

    const normalizedVehicle = vehicleNumber.toLowerCase().replace(/\s/g, "");

    // ── STEP 1: Fetch auth record ────────────────────────────────────────────
    const authRecord = await AuthModelForCommonDApp.findOne({
      vehicleNumber: normalizedVehicle,
    }).sort({ createdAt: -1 });

    if (!authRecord) {
      await logLoginEvent(req, {
        vehicleNumber: normalizedVehicle,
        action: "otp_failed",
        status: "failure",
        source: "none",
        httpStatus: 404,
        errorCode: "NO_SESSION_FOUND",
        message: "No login initiated for this vehicle",
      });
      return res.status(404).json({
        success: false,
        message: "No login initiated for this vehicle. Please login first.",
        code: "NO_SESSION_FOUND",
      });
    }
    authRecordId = authRecord._id;

    // ── STEP 2: Decide OTP flow from what was stored at login time ────────────
    // "wise" → Wise returned code:1 + otp during login → must call Wise API
    // "mmt"  → MMT only → validate locally, issue token directly
    const useWise = authRecord.otpTracking?.source === "wise";

    // ── STEP 3: Basic guards ─────────────────────────────────────────────────
    // wise: we hold the code. mmt: B2C holds it, we only track "pending".
    const hasActiveOtp = useWise
      ? !!authRecord.otpTracking?.code
      : !!authRecord.otpTracking?.pending;

    if (!authRecord.otpTracking || !hasActiveOtp) {
      await logLoginEvent(req, {
        vehicleNumber: normalizedVehicle,
        authRecordId,
        action: "otp_failed",
        status: "failure",
        source: authRecord.otpTracking?.source,
        httpStatus: 400,
        errorCode: "NO_OTP_FOUND",
        message: "No active OTP found",
      });
      return res.status(400).json({
        success: false,
        message: "No active OTP found. Please initiate login again.",
        code: "NO_OTP_FOUND",
      });
    }

    const isExpired = new Date() > new Date(authRecord.otpTracking.expiresAt);
    if (isExpired) {
      await logLoginEvent(req, {
        vehicleNumber: normalizedVehicle,
        authRecordId,
        action: "otp_failed",
        status: "failure",
        source: authRecord.otpTracking.source,
        httpStatus: 400,
        errorCode: "OTP_EXPIRED",
        message: "OTP has expired",
        details: { expiresAt: authRecord.otpTracking.expiresAt },
      });
      return res.status(400).json({
        success: false,
        message: "OTP has expired. Please initiate login again.",
        code: "OTP_EXPIRED",
      });
    }

    // ── STEP 4: Validate submitted OTP ───────────────────────────────────────
    // wise → compare with our stored otpTracking.code first (Wise re-checks in
    //        step 5). mmt → the OTP lives in the B2C backend; B2C verifies it
    //        in step 5, so there is nothing to compare locally.
    const submittedOtp = String(otp).trim();

    // Shared "wrong OTP" response (same shape as before) + attempts counter
    const rejectInvalidOtp = async (externalCalls = []) => {
      authRecord.otpTracking.attempts =
        (authRecord.otpTracking.attempts || 0) + 1;
      await authRecord.save();

      await logLoginEvent(req, {
        vehicleNumber: normalizedVehicle,
        authRecordId,
        action: "otp_failed",
        status: "failure",
        source: authRecord.otpTracking.source,
        httpStatus: 400,
        errorCode: "INVALID_OTP",
        message: "Invalid OTP",
        externalCalls,
        details: { attemptsUsed: authRecord.otpTracking.attempts },
      });

      return res.status(400).json({
        success: false,
        message: "Invalid OTP. Please try again.",
        code: "INVALID_OTP",
        attemptsUsed: authRecord.otpTracking.attempts,
      });
    };

    // A stored code exists for Wise always, and for MMT when B2C returned the
    // OTP at login. With a stored code we compare locally, as for Wise.
    const hasLocalCode = !!authRecord.otpTracking.code;

    if (hasLocalCode && String(authRecord.otpTracking.code).trim() !== submittedOtp) {
      return rejectInvalidOtp();
    }

    // ── STEP 5: OTP matched — complete auth via the correct flow ─────────────
    //
    // MMT flow:
    //   Call the B2C backend's verifyOtpMobile (verifyMmtOtp below) — B2C owns
    //   the OTP. Vehicle does NOT exist in Wise so there is nothing else to
    //   call. On success we issue our own session token.
    //
    // Wise flow:
    //   MUST call Wise ValidateOtp API because:
    //   ▸ Wise returns its own Token (data.Token) — this is the real session token,
    //     NOT a generated string. It must be stored and used for all Wise API calls.
    //   ▸ Wise returns driver details (MobileNo, CabID, AllocationID, CarType, etc.)
    //     that are only available from this response.
    //   ▸ data.Code === 1 is the final confirmation of success from Wise.
    //

    let wiseOtpToSend = submittedOtp; // otp,
    let shouldUseNewFormat = false;

    // if (useWise) {
    //   if (!device_model || !os_version || !app_version) {
    //     return res.status(400).json({
    //       success: false,
    //       message:
    //         "device_model, os_version, and app_version are required for this login",
    //       code: "DEVICE_INFO_REQUIRED",
    //     });
    //   }

    //   // New OTP format for Wise: <otp><device_model><os_version>~<app_version>
    //   wiseOtpToSend = `${submittedOtp}~${device_model}~${os_version}~${app_version}`;

    //   // wiseOtpToSend = `${submittedOtp}~${os_version}~${app_version}`;
    // }

    // Only use new format if we are in Wise flow AND ALL three device fields are present
    if (useWise && device_model && os_version && app_version) {
      shouldUseNewFormat = true;
      wiseOtpToSend = `${submittedOtp}~${device_model}~${os_version}~${app_version}`;
    }

    let verificationResult;

    if (useWise) {
      verificationResult = await verifyWiseOtp(
        authRecord.wiseUserId || normalizedVehicle,
        wiseOtpToSend,
        authRecord.wiseGcm || gcm,
      );
    } else {
      // MMT only. If the OTP was stored at login it was just matched locally;
      // otherwise B2C verifies it. Either way we issue the session token.
      verificationResult = hasLocalCode
        ? {
            success: true,
            source: "mmt",
            token: `mmt_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`,
            message: "OTP verified successfully",
          }
        : await verifyMmtOtp(normalizedVehicle, submittedOtp);

      if (!verificationResult.success) {
        if (verificationResult.reason === "MMT_UNAVAILABLE") {
          await logLoginEvent(req, {
            vehicleNumber: normalizedVehicle,
            authRecordId,
            action: "otp_failed",
            status: "failure",
            source: "mmt",
            httpStatus: 503,
            errorCode: "MMT_UNAVAILABLE",
            message: verificationResult.message,
            externalCalls: [verificationResult.callLog],
          });
          return res.status(503).json({
            success: false,
            message: "Could not verify the OTP right now. Please try again.",
            code: "MMT_UNAVAILABLE",
          });
        }

        if (verificationResult.reason === "NO_OTP_FOUND") {
          await logLoginEvent(req, {
            vehicleNumber: normalizedVehicle,
            authRecordId,
            action: "otp_failed",
            status: "failure",
            source: "mmt",
            httpStatus: 400,
            errorCode: "NO_OTP_FOUND",
            message: verificationResult.message,
            externalCalls: [verificationResult.callLog],
          });
          return res.status(400).json({
            success: false,
            message: "No active OTP found. Please initiate login again.",
            code: "NO_OTP_FOUND",
          });
        }

        // INVALID_OTP — B2C answers 204 for both a wrong and an expired OTP
        return rejectInvalidOtp([verificationResult.callLog]);
      }
    }

    // ── STEP 5b: Dual-flow — if Wise succeeded AND MMT also exists ────────────
    // When a vehicle exists in both systems, the Wise OTP is used for validation,
    // and the MMT session (b2c) is opened with the SAME B2B (Wise) token —
    // B2B wins, so b2c.token === b2b.token (single effective token).
    const existsInBoth = authRecord.b2c?.exist && authRecord.b2b?.exist;
    let mmtTokenForDualFlow = null;

    if (useWise && verificationResult.success && existsInBoth) {
      mmtTokenForDualFlow = verificationResult.token;
    }

    // ── STEP 6: Persist result if successful ─────────────────────────────────
    if (verificationResult.success) {
      const sessionToken = verificationResult.token;
      const now = new Date();

      // === STORE DEVICE INFORMATION (New) ===
      if (device_model) authRecord.deviceModel = device_model;
      if (os_version) authRecord.osVersion = os_version;
      if (app_version) authRecord.appVersion = app_version;
      if (device_brand) authRecord.deviceBrand = String(device_brand);
      if (
        miscellaneous &&
        typeof miscellaneous === "object" &&
        !Array.isArray(miscellaneous)
      ) {
        authRecord.miscellaneous = miscellaneous;
        authRecord.markModified("miscellaneous");
      }

      if (verificationResult.source === "mmt") {
        authRecord.b2c.verified = true;
        authRecord.b2c.token = sessionToken;
      } else {
        // Wise — use the REAL token from Wise response (data.Token)
        // and persist all driver detail fields
        authRecord.b2b.verified = true;
        authRecord.b2b.token = sessionToken; // this is data.Token from Wise

        const wd = verificationResult.wiseDetails || {};

        if (wd.mobileNo) {
          authRecord.wiseMobileNo = wd.mobileNo;
          authRecord.driverContact = Number(wd.mobileNo);
          authRecord.driver.contact = Number(wd.mobileNo);
        }

        // Store the real Wise token separately for direct Wise API usage
        if (wd.wiseToken) authRecord.wiseToken = wd.wiseToken;
        if (wd.cabId) authRecord.wiseCabId = wd.cabId;
        if (wd.allocationId) authRecord.wiseAllocationId = wd.allocationId;
        if (wd.carType) authRecord.wiseCarType = wd.carType;
        if (wd.isOnDuty !== undefined) authRecord.wiseIsOnDuty = wd.isOnDuty;
        if (wd.cabNo) authRecord.driver.name = wd.cabNo;
        if (wd.vendorId) authRecord.wiseVendorId = wd.vendorId;
        if (wd.branchId) authRecord.wiseBranchId = wd.branchId;
      }

      // Dual-flow: vehicle exists in both — also open the MMT (b2c) session
      if (mmtTokenForDualFlow) {
        authRecord.b2c.verified = true;
        authRecord.b2c.token = mmtTokenForDualFlow;
      }

      // Clear OTP now that session is open
      authRecord.otpTracking.code = null;
      authRecord.otpTracking.pending = false;

      authRecord.activeSession = {
        token: sessionToken,
        loginTime: now,
        source: verificationResult.source,
      };
      authRecord.lastLoginAt = now;

      await authRecord.save();

      await logLoginEvent(req, {
        vehicleNumber: normalizedVehicle,
        authRecordId,
        action: "login_success",
        status: "success",
        source: mmtTokenForDualFlow ? "both" : verificationResult.source,
        httpStatus: 200,
        message: verificationResult.message || null,
        externalCalls: [verificationResult.callLog],
        details: {
          token: sessionToken,
          mmtToken: mmtTokenForDualFlow || undefined,
          driverContact: authRecord.driverContact,
        },
      });
    } else {
      // Wise API returned failure after OTP matched locally — log it
      await logLoginEvent(req, {
        vehicleNumber: normalizedVehicle,
        authRecordId,
        action: "wise_verify_failed",
        status: "failure",
        source: "wise",
        httpStatus: 200, // response below is 200 with success:false / Code:0
        errorCode: "WISE_VERIFY_FAILED",
        message: verificationResult.message || null,
        externalCalls: [verificationResult.callLog],
        details: { usedNewOtpFormat: shouldUseNewFormat },
      });
    }

    // ── STEP 7: Respond ──────────────────────────────────────────────────────
    //
    // Single effective token — B2B (Wise) wins over B2C (MMT):
    //
    // Wise-only : Token = <wise_token>
    // Both      : Token = <wise_token>   (MMT token still stored on b2c.token)
    // MMT-only  : Token = <mmt_token>
    //
    // verificationResult.token is already the Wise token on the Wise flow and
    // the MMT token on the MMT-only flow, so it is the effective token as-is.
    //
    const wd = verificationResult.wiseDetails || {};

    const finalResponse = {
      success: verificationResult.success,
      Code: verificationResult.success ? 1 : 0,
      Msg: verificationResult.message || null,
      source: verificationResult.source || null,
      MobileNo: wd.mobileNo || null,
      Token: verificationResult.success ? verificationResult.token || null : null,
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
    console.error("OTP Validation Error:", error.message);
    await logLoginEvent(req, {
      vehicleNumber: normalizeVehicle(req.body?.vehicleNumber),
      authRecordId,
      action: "otp_failed",
      status: "failure",
      httpStatus: 500,
      errorCode: "INTERNAL_ERROR",
      message: error.message,
    });
    return res
      .status(500)
      .json({ success: false, message: "Internal Server Error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Get current OTP for a vehicle (support/debug lookup)
// ─────────────────────────────────────────────────────────────────────────────

const getOtpByVehicleNumber = async (req, res) => {
  try {
    const { vehicleNumber } = req.body;

    if (!vehicleNumber?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Vehicle number is required",
      });
    }

    const normalizedVehicle = vehicleNumber.toLowerCase().replace(/\s/g, "");

    const authRecord = await AuthModelForCommonDApp.findOne({
      vehicleNumber: normalizedVehicle,
    }).sort({ createdAt: -1 });

    if (!authRecord || !authRecord.otpTracking?.code) {
      return res.status(404).json({
        success: false,
        message: "No active OTP found for this vehicle",
        code: "NO_OTP_FOUND",
      });
    }

    const isExpired = new Date() > new Date(authRecord.otpTracking.expiresAt);
    if (isExpired) {
      return res.status(400).json({
        success: false,
        message: "OTP has expired. Please initiate login again.",
        code: "OTP_EXPIRED",
      });
    }

    return res.status(200).json({
      success: true,
      vehicleNumber: normalizedVehicle,
      otp: authRecord.otpTracking.code,
      source: authRecord.otpTracking.source,
      generatedAt: authRecord.otpTracking.generatedAt,
      expiresAt: authRecord.otpTracking.expiresAt,
      attemptsUsed: authRecord.otpTracking.attempts || 0,
    });
  } catch (error) {
    console.error("Get OTP Error:", error.message);
    return res
      .status(500)
      .json({ success: false, message: "Internal Server Error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Wise OTP verification
//
// Wise ValidateOtp strict response contract:
// {
//   "Code": 1,              ← must be 1 for success
//   "Msg": "...",
//   "MobileNo": "8588822913",
//   "Token": "<hex_string>",  ← REAL session token — use this, never generate one
//   "AllocationID": 22010,
//   "CabID": 5135,
//   "CabNo": "DL1N0337",
//   "CarType": "Dzire",
//   "OTP": null,
//   "IsOnDuty": true,
//   "VendorID": 0,
//   "BranchID": 0
// }
// ─────────────────────────────────────────────────────────────────────────────

const verifyWiseOtp = async (userId, otp, gcm) => {
  const wiseApiUrl = `${process.env.WISE_BASE_URL}/api/Login/ValidateOtp`;
  const params = {
    UserID: userId,
    OTP: otp,
    gcm: gcm || "dummy_gcm_token",
    ApiID: process.env.WISE_API_ID || "WSId201",
    ApiPassword: process.env.WISE_API_PASSWORD || "WSPwd201",
  };
  const sentAt = new Date();
  const record = (extra) =>
    recordExternalCall({
      endpoint: "ValidateOtp",
      url: wiseApiUrl,
      params,
      sentAt,
      ...extra,
    });

  try {
    const response = await axios.get(wiseApiUrl, { params, timeout: 5000 });

    const data = response.data;

    // Code: 1 is the primary factor
    const success = !!data && data.Code === 1;

    const callLog = record({ response });

    if (!data) {
      return {
        success: false,
        source: "wise",
        message: "Empty response from Wise",
        callLog,
      };
    }

    if (!success) {
      return {
        success: false,
        source: "wise",
        message: data.Msg || "Wise OTP verification failed",
        callLog,
      };
    }

    return {
      success: true,
      source: "wise",
      callLog,
      // Use data.Token directly — this is the real Wise session token
      // Never generate a fake token here; Wise API calls require this exact value
      token: data.Token,
      message: data.Msg || "OTP verified successfully",
      wiseDetails: {
        mobileNo: data.MobileNo || null,
        wiseToken: data.Token || null, // stored separately on authRecord
        cabId: data.CabID ?? null,
        allocationId: data.AllocationID ?? null,
        cabNo: data.CabNo || null,
        carType: data.CarType || null,
        isOnDuty: data.IsOnDuty ?? null,
        vendorId: data.VendorID ?? null,
        branchId: data.BranchID ?? null,
      },
    };
  } catch (error) {
    console.error("Wise OTP verification error:", error.message);
    return {
      success: false,
      source: "wise",
      message: "Wise service unavailable",
      callLog: record({ error }),
    };
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// MMT (B2C) OTP verification — mirrors verifyWiseOtp
//
// POST {MMT_BASE_URL}/0auth/DriverApp/verifyOtpMobile { VehicleNumber, otp }
//   201 { otpValid: true }  → correct (OTP consumed)
//   401                     → no OTP stored for this vehicle
//   204 (no body)           → wrong OR expired (B2C does not say which)
//   500                     → internal error
// B2C never returns a session token, so one is issued here on success.
// Pass the SAME normalized vehicle number that was sent to loginDriver.
// ─────────────────────────────────────────────────────────────────────────────

const verifyMmtOtp = async (vehicleNumber, otp) => {
  const mmtApiUrl = `${process.env.MMT_BASE_URL}/0auth/DriverApp/verifyOtpMobile`;
  const body = { VehicleNumber: vehicleNumber, otp: String(otp).trim() };
  const sentAt = new Date();
  const record = (extra) =>
    recordExternalCall({
      service: "mmt",
      endpoint: "verifyOtpMobile",
      method: "POST",
      url: mmtApiUrl,
      params: body,
      sentAt,
      ...extra,
    });

  try {
    const response = await axios.post(mmtApiUrl, body, {
      timeout: Number(process.env.MMT_TIMEOUT_MS) || 5000,
      // 401 / 204 are normal answers here, not transport errors
      validateStatus: (status) => status < 500,
    });
    const callLog = record({ response });

    if (response.status === 201 && response.data?.otpValid === true) {
      return {
        success: true,
        source: "mmt",
        callLog,
        token: `mmt_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`,
        message: "OTP verified successfully",
      };
    }

    if (response.status === 401) {
      return {
        success: false,
        source: "mmt",
        reason: "NO_OTP_FOUND",
        message: "No active OTP found in MMT",
        callLog,
      };
    }

    if (response.status === 204) {
      return {
        success: false,
        source: "mmt",
        reason: "INVALID_OTP",
        message: "OTP wrong or expired in MMT",
        callLog,
      };
    }

    return {
      success: false,
      source: "mmt",
      reason: "MMT_UNAVAILABLE",
      message: `Unexpected MMT response ${response.status}`,
      callLog,
    };
  } catch (error) {
    console.error("MMT OTP verification error:", error.message);
    return {
      success: false,
      source: "mmt",
      reason: "MMT_UNAVAILABLE",
      message: error.message,
      callLog: record({ error }),
    };
  }
};

module.exports = {
  validateOtp,
  verifyWiseOtp,
  verifyMmtOtp,
  getOtpByVehicleNumber,
};
