// controllers/CommonDriverApp/loginController.js

const ConfigDrivenDecision = require("../models/ConfigDrivenDecision");
const AuthModelForCommonDApp = require("../models/AuthModelForCommonDApp");
const DriverLoginHistory = require("../models/DriverLoginHistory");
const { Driver } = require("../models/DriverModel");
const { Vehicle } = require("../models/VehicleModel");
const { Mobileotp } = require("../models/MobileOtp");
const axios = require("axios");
const { verifyWiseOtp } = require("./validateOtpController");
const time = require("../utils/time");
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
      `${time.tds()} [OTP-SERVICE] loginCommonForDriver: calling WISE OTP service (ValidateUser) for vehicle=${normalizedVehicle}`,
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

    // ── STEP 2: Only now call MMT, telling it whether to send its own OTP ────
    // If the vehicle exists in Wise at all, MMT is looked up for identity
    // fields only — no SMS. MMT OTP is generated ONLY when the vehicle does
    // NOT exist in Wise (i.e. MMT-only). Using existInWise here (rather than
    // wiseFlowActive) means the MMT OTP stays skipped even in the edge case
    // where Wise returns code:1 without an otp value.
    // We await this fully before moving on, so we always know for certain
    // whether the MMT OTP was actually sent before building the response.
    console.log(
      `${time.tds()} [OTP-SERVICE] loginCommonForDriver: calling MMT OTP service for vehicle=${normalizedVehicle}, sendOtp=${!existInWise}`,
    );
    const mmtResult = await loginDriverForMMTService(
      normalizedVehicle,
      !existInWise,
    ).catch((err) => ({ __rejected: true, err }));

    const mmtData = mmtResult?.__rejected
      ? {
          success: false,
          existInMmt: false,
          error: mmtResult.err?.message,
        }
      : mmtResult;

    console.log("mmtData", mmtData);

    const existInMmt = mmtData.existInMmt || false;

    const failLogin = async (httpStatus, code, message) => {
      await logLoginEvent(req, {
        vehicleNumber: normalizedVehicle,
        action: "login_failed",
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

    const activeOtp = wiseFlowActive ? wiseOtp : mmtData.generatedOtp || null;
    const activeSource = wiseFlowActive ? "wise" : "mmt";

    // ── Vehicle exists but no OTP could be issued — don't pretend success ────
    // MMT: SMS gateway failed (e.g. 403 when server IP is not whitelisted).
    // Wise: code:1 but no otp in the response, and MMT OTP was skipped.
    if (!activeOtp) {
      if (!existInWise && mmtData.reason === "OTP_SEND_FAILED") {
        return failLogin(
          502,
          "OTP_SEND_FAILED",
          "Vehicle found but the OTP could not be sent. Please try again.",
        );
      }
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
    const driverContact = existInMmt ? mmtData.driverContact : null;
    const driverName = existInMmt ? mmtData.driverName : null;
    const driverId = existInMmt ? mmtData.driverId : null;

    const uniqueId = existInMmt
      ? `${normalizedVehicle}_${driverContact}`
      : `wise_${normalizedVehicle}`;

    const now = new Date();
    const otpExpiry = new Date(now.getTime() + 5 * 60_000);

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
          otp: existInMmt ? mmtData.generatedOtp : null,
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

        otpTracking: activeOtp
          ? {
              code: activeOtp,
              generatedAt: now,
              expiresAt: otpExpiry,
              source: activeSource,
              attempts: 0,
            }
          : null,
      });
    } else {
      // ── UPDATE ───────────────────────────────────────────────────────────────
      authRecord.b2c.exist = existInMmt;
      authRecord.b2b.exist = existInWise;

      if (existInMmt) {
        authRecord.driverContact = mmtData.driverContact;
        authRecord.driver.contact = mmtData.driverContact;
        authRecord.driver.name = mmtData.driverName;
        authRecord.driver.driverId = mmtData.driverId;
        authRecord.b2c.otp = mmtData.generatedOtp;
      }

      if (existInWise) {
        authRecord.wiseUserId = normalizedVehicle;
        authRecord.wiseGcm = gcm || authRecord.wiseGcm;
        authRecord.b2b.otp = wiseOtp;
      }

      // Always overwrite otpTracking — Wise OTP wins when wiseFlowActive
      if (activeOtp) {
        authRecord.otpTracking = {
          code: activeOtp,
          generatedAt: now,
          expiresAt: otpExpiry,
          source: activeSource,
          attempts: 0,
        };
      }
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
      action: "login_initiated",
      status: "success",
      source: existInMmt ? (existInWise ? "both" : "mmt") : "wise",
      httpStatus: 200,
      message: "Driver login flow initiated",
      externalCalls,
      details: {
        b2cExists: existInMmt,
        b2bExists: existInWise,
        otpSource: activeSource,
        wiseFlowActive,
        otpSent: !!activeOtp,
        mmtOtpSkipped: !!mmtData.otpSkipped,
        mmtReason: mmtData.reason || mmtData.error || null,
      },
    });

    // ── Build response ───────────────────────────────────────────────────────
    const response = {
      success: true,
      existInMmt,
      existInWise,
      vehicleId: mmtData.vehicleId || null,
      driverContact,
      message: "Driver login flow initiated",
      driverSource: existInMmt ? "mmt" : "wise",
      useWiseOtp: wiseFlowActive,
    };

    if (existInMmt) {
      response.b2c = {
        exist: true,
        verified: false,
        otpSent: !!mmtData.generatedOtp,
        otpExpiry: mmtData.generatedOtp ? otpExpiry : null,
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
      action: "login_failed",
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
// MMT service login
// ─────────────────────────────────────────────

const loginDriverForMMTService = async (vehicleNumber, sendOtp = true) => {
  try {
    const foundVehicle = await Vehicle.findOne({
      VehicleNumber: vehicleNumber,
    });
    if (!foundVehicle)
      return { success: false, existInMmt: false, reason: "VEHICLE_NOT_FOUND" };

    const activeDriver = foundVehicle.ActiveDriver;
    if (!activeDriver)
      return { success: false, existInMmt: false, reason: "NO_ACTIVE_DRIVER" };

    const foundDriver = await Driver.findById(activeDriver);
    if (!foundDriver)
      return { success: false, existInMmt: false, reason: "DRIVER_NOT_FOUND" };

    // Wise already won this login (or caller doesn't want an OTP) — return
    // identity fields only, without generating/sending a second MMT OTP.
    if (!sendOtp) {
      console.log(
        `${time.tds()} [OTP-SERVICE] MMT OTP generation SKIPPED for vehicle=${vehicleNumber} (Wise OTP already active)`,
      );
      return {
        success: true,
        existInMmt: true,
        vehicleId: foundVehicle._id,
        driverId: foundDriver._id,
        driverContact: foundDriver.MobileNumber,
        driverName: foundDriver.Name,
        generatedOtp: null,
        otpSkipped: true,
      };
    }

    console.log(
      `${time.tds()} [OTP-SERVICE] Invoking MMT OTP service (generateOtpMobile) for vehicle=${vehicleNumber}, mobile=${foundDriver.MobileNumber}`,
    );
    // const otp = Math.floor(100000 + Math.random() * 900000);
    const generatedOtp = await generateOtpMobile(
      foundDriver.MobileNumber,
      vehicleNumber,
    );

    // Vehicle + driver DO exist in MMT — only the OTP/SMS step failed.
    // Keep existInMmt: true so the caller doesn't report "not found".
    if (!generatedOtp) {
      return {
        success: false,
        existInMmt: true,
        vehicleId: foundVehicle._id,
        driverId: foundDriver._id,
        driverContact: foundDriver.MobileNumber,
        driverName: foundDriver.Name,
        generatedOtp: null,
        reason: "OTP_SEND_FAILED",
        error: "Failed to generate/send OTP in MMT",
      };
    }

    return {
      success: true,
      existInMmt: true,
      vehicleId: foundVehicle._id,
      driverId: foundDriver._id,
      driverContact: foundDriver.MobileNumber,
      driverName: foundDriver.Name,
      generatedOtp: generatedOtp,
    };
  } catch (err) {
    console.error("MMT login error:", err.message);
    return {
      success: false,
      existInMmt: false,
      reason: "MMT_ERROR",
      error: err.message,
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

const generateOtpMobile = async (mobile, VehicleNumber) => {
  try {
    const normalizedVehicle = VehicleNumber.toLowerCase();

    const isTestVehicle = normalizedVehicle === "testvehicle12345";

    const currentOtp = await Mobileotp.findOne({
      VehicleNumber: VehicleNumber.toLowerCase(),
    });

    if (currentOtp) {
      await Mobileotp.deleteMany({
        VehicleNumber: VehicleNumber.toLowerCase(),
      });
      console.log(
        time.tds(),

        `generateOtpMobile()-- Previous otp deleted`,
      );
    }

    // const newOTP = isTestVehicle
    //   ? "123456"
    //   : `${Math.floor(1000 + Math.random() * 9000)}`;

    let newOTP;
    if (isTestVehicle) {
      newOTP = "123456"; // 6-digit for test vehicle
      console.log("Test vehicle detected - using hardcoded OTP:", newOTP);
    } else {
      // Generate 6-digit OTP to match what loginDriverForMMTService expects
      newOTP = Math.floor(100000 + Math.random() * 900000).toString();
      console.log("Regular vehicle - generated OTP:", newOTP);
    }

    console.log("isTestVehicle", isTestVehicle);
    console.log("newOTP", newOTP);

    // const hashedOtp=await bcrypt.hash(newOTP,10);
    const vehicle = await Vehicle.findOne({
      VehicleNumber: VehicleNumber.toLowerCase(),
    });

    const newOtp = new Mobileotp({
      VehicleNumber: VehicleNumber.toLowerCase(),
      otp: newOTP,
      createdAt: new Date(),
      expireAt: new Date(Date.now() + 30 * 60 * 1000), // 30 minutes from now
      vendorid: vehicle?.VendorId || null,
    });

    await newOtp.save();
    console.log(
      time.tds(),

      `generateOtpMobile()-- new otp saved`,
    );

    if (!isTestVehicle) {
      console.log(
        `${time.tds()} [OTP-SERVICE] MMT SMS gateway (myvfirst) called for mobile=${mobile}, vehicle=${VehicleNumber}`,
      );
      const externalApiUrl = `https://http.myvfirst.com/smpp/sendsms?username=wheelzonrent&password=wheel123&to=${mobile}&udh=0&from=wticab&text=Dear customer Your OTP for WTi Cabs Login is ${newOTP} Thanks WTICABS&action=send&category=bulk`;
      const response = await axios.get(externalApiUrl);

      console.log("response after generating mobile otp", response);
    } else {
      console.log(
        `${time.tds()} [OTP-SERVICE] MMT SMS gateway SKIPPED for test vehicle=${VehicleNumber} (hardcoded OTP used)`,
      );
    }

    // server ip need to be whitelist as hit ges to ser

    // console.log(response.data);
    return newOTP;
  } catch (err) {
    console.log(
      time.tds(),

      `generateOtpMobile()-- some error occur  ${err.message}`,
    );
    return;
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

    // ── STEP 1: Check if vehicle exists in MMT ───────────────────────────────
    const foundVehicle = await Vehicle.findOne({
      VehicleNumber: normalizedVehicle,
    });

    if (!foundVehicle) {
      return res.status(404).json({
        success: false,
        message: "Vehicle not found in MMT system",
        neverLoggedAsB2C: true,
      });
    }

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
    const { vehicleNumber, wiseToken, wiseUserId, wiseAllocationId } = req.body;

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
    // wiseToken/wiseUserId/wiseAllocationId can be passed in by the caller
    // (e.g. the app's current in-memory session values); anything not
    // passed falls back to what's stored on the auth record.
    if (wasLoggedIntoWise) {
      wiseLogoutResult = await logoutDriverFromWiseService(
        wiseToken || authRecord.wiseToken,
        wiseUserId || authRecord.wiseUserId || normalizedVehicle,
        wiseAllocationId || authRecord.wiseAllocationId,
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
  checkWhenToSwitchToB2BApp,
  createOrUpdateConfig,

  getCommanAuthDetailOnEveryHit,
  autoLoginToB2BIfExistInMMT,
  logoutCommonForDriver,
};
