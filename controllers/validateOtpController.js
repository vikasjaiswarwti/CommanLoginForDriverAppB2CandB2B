// controllers/CommonDriverApp/validateOtpController.js

const AuthModelForCommonDApp = require("../models/AuthModelForCommonDApp");
const DriverLoginHistory = require("../models/DriverLoginHistory");
const axios = require("axios");

// ─────────────────────────────────────────────────────────────────────────────
// Main OTP validation entry point
// ─────────────────────────────────────────────────────────────────────────────

const validateOtp = async (req, res) => {
  try {
    const { vehicleNumber, otp, gcm, device_model, os_version, app_version } =
      req.body;

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
      return res.status(404).json({
        success: false,
        message: "No login initiated for this vehicle. Please login first.",
        code: "NO_SESSION_FOUND",
      });
    }

    // ── STEP 2: Decide OTP flow from what was stored at login time ────────────
    // "wise" → Wise returned code:1 + otp during login → must call Wise API
    // "mmt"  → MMT only → validate locally, issue token directly
    const useWise = authRecord.otpTracking?.source === "wise";

    // ── STEP 3: Basic guards ─────────────────────────────────────────────────
    if (!authRecord.otpTracking || !authRecord.otpTracking.code) {
      return res.status(400).json({
        success: false,
        message: "No active OTP found. Please initiate login again.",
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

    // ── STEP 4: Validate submitted OTP against stored otpTracking.code ────────
    const storedOtp = String(authRecord.otpTracking.code).trim();
    const submittedOtp = String(otp).trim();

    if (storedOtp !== submittedOtp) {
      authRecord.otpTracking.attempts =
        (authRecord.otpTracking.attempts || 0) + 1;
      await authRecord.save();

      await DriverLoginHistory.create({
        vehicleNumber: normalizedVehicle,
        authRecordId: authRecord._id,
        action: "otp_failed",
        source: authRecord.otpTracking.source,
        details: { attemptsUsed: authRecord.otpTracking.attempts },
      });

      return res.status(400).json({
        success: false,
        message: "Invalid OTP. Please try again.",
        code: "INVALID_OTP",
        attemptsUsed: authRecord.otpTracking.attempts,
      });
    }

    // ── STEP 5: OTP matched — complete auth via the correct flow ─────────────
    //
    // MMT flow:
    //   OTP validated above against stored code — no external call needed.
    //   Vehicle does NOT exist in Wise so there is nothing to call.
    //   Issue a session token directly.
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
      // MMT only — OTP already verified, issue token directly
      verificationResult = {
        success: true,
        source: "mmt",
        token: `mmt_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`,
        message: "OTP verified successfully",
      };
    }

    // ── STEP 5b: Dual-flow — if Wise succeeded AND MMT also exists ────────────
    // When a vehicle exists in both systems, the Wise OTP is used for validation,
    // but the MMT session (b2c) must also be opened so the driver can access
    // MMT-side features without a separate login.
    const existsInBoth = authRecord.b2c?.exist && authRecord.b2b?.exist;
    let mmtTokenForDualFlow = null;

    if (useWise && verificationResult.success && existsInBoth) {
      mmtTokenForDualFlow = `mmt_${Date.now()}_${Math.random()
        .toString(36)
        .substring(2, 15)}`;
    }

    // ── STEP 6: Persist result if successful ─────────────────────────────────
    if (verificationResult.success) {
      const sessionToken = verificationResult.token;
      const now = new Date();

      // === STORE DEVICE INFORMATION (New) ===
      if (device_model) authRecord.deviceModel = device_model;
      if (os_version) authRecord.osVersion = os_version;
      if (app_version) authRecord.appVersion = app_version;

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

      authRecord.activeSession = {
        token: sessionToken,
        loginTime: now,
        source: verificationResult.source,
      };
      authRecord.lastLoginAt = now;

      await authRecord.save();

      await DriverLoginHistory.create({
        vehicleNumber: normalizedVehicle,
        authRecordId: authRecord._id,
        action: "login_success",
        source: verificationResult.source,
        details: {
          token: sessionToken,
          mmtToken: mmtTokenForDualFlow || undefined,
          driverContact: authRecord.driverContact,
        },
      });
    } else {
      // Wise API returned failure after OTP matched locally — log it
      await DriverLoginHistory.create({
        vehicleNumber: normalizedVehicle,
        authRecordId: authRecord._id,
        action: "wise_verify_failed",
        source: "wise",
        details: { message: verificationResult.message },
      });
    }

    // ── STEP 7: Respond ──────────────────────────────────────────────────────
    //
    // Token field  → ALWAYS the Wise token (null for MMT-only)
    // b2cToken     → ALWAYS the MMT token (present for MMT-only AND both flows)
    //
    // Wise-only : Token = <wise_token>,  b2cToken not present
    // Both      : Token = <wise_token>,  b2cToken = <mmt_token>
    // MMT-only  : Token = null,          b2cToken = <mmt_token>
    //
    const wd = verificationResult.wiseDetails || {};

    const finalResponse = {
      success: verificationResult.success,
      Code: verificationResult.success ? 1 : 0,
      Msg: verificationResult.message || null,
      source: verificationResult.source || null,
      MobileNo: wd.mobileNo || null,
      // Token is strictly the Wise session token — never an MMT token
      Token:
        verificationResult.source === "wise" && verificationResult.success
          ? verificationResult.token
          : null,
      AllocationID: wd.allocationId ?? null,
      CabID: wd.cabId ?? null,
      CabNo: wd.cabNo || null,
      CarType: wd.carType || null,
      OTP: null,
      IsOnDuty: wd.isOnDuty ?? null,
      VendorID: wd.vendorId ?? null,
      BranchID: wd.branchId ?? null,
    };

    // b2cToken is present for MMT-only AND dual-flow (both systems)
    if (verificationResult.source === "mmt") {
      // MMT-only: the verificationResult.token is the mmt token
      finalResponse.b2cToken = verificationResult.token;
    } else if (mmtTokenForDualFlow) {
      // Both: separately generated mmt token
      finalResponse.b2cToken = mmtTokenForDualFlow;
    }

    return res.status(200).json(finalResponse);
  } catch (error) {
    console.error("OTP Validation Error:", error.message);
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
  try {
    const wiseApiUrl = `${process.env.WISE_BASE_URL}/api/Login/ValidateOtp`;

    const response = await axios.get(wiseApiUrl, {
      params: {
        UserID: userId,
        OTP: otp,
        gcm: gcm || "dummy_gcm_token",
        ApiID: process.env.WISE_API_ID || "WSId201",
        ApiPassword: process.env.WISE_API_PASSWORD || "WSPwd201",
      },
      timeout: 5000,
    });

    const data = response.data;
    if (!data) {
      return {
        success: false,
        source: "wise",
        message: "Empty response from Wise",
      };
    }

    // Code: 1 is the primary factor
    const success = data.Code === 1;

    if (!success) {
      return {
        success: false,
        source: "wise",
        message: data.Msg || "Wise OTP verification failed",
      };
    }

    return {
      success: true,
      source: "wise",
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
    };
  }
};

module.exports = { validateOtp, verifyWiseOtp };
