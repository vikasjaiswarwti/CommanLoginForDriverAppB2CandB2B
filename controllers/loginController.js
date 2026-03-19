// controllers/CommonDriverApp/loginController.js

const ConfigDrivenDecision = require("../models/ConfigDrivenDecision");
const AuthModelForCommonDApp = require("../models/AuthModelForCommonDApp");
const DriverLoginHistory = require("../models/DriverLoginHistory");
const { Driver } = require("../models/DriverModel");
const { Vehicle } = require("../models/VehicleModel");
const { Mobileotp } = require("../models/MobileOtp");
const axios = require("axios");
const { verifyWiseOtp } = require("./validateOtpController");

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
  try {
    const { vehicleNumber, gcm } = req.body;

    if (!vehicleNumber?.trim()) {
      return res
        .status(400)
        .json({ success: false, message: "Vehicle number is required" });
    }

    const normalizedVehicle = vehicleNumber.toLowerCase().replace(/\s/g, "");

    // Call both services in parallel — neither failure blocks the other
    const [mmtResult, wiseResult] = await Promise.allSettled([
      loginDriverForMMTService(normalizedVehicle),
      loginDriverForWiseService(normalizedVehicle, gcm),
    ]);

    // Unwrap settled results
    const mmtData =
      mmtResult.status === "fulfilled"
        ? mmtResult.value
        : {
            success: false,
            existInMmt: false,
            error: mmtResult.reason?.message,
          };

    const wiseData =
      wiseResult.status === "fulfilled"
        ? wiseResult.value
        : {
            success: false,
            existInWise: false,
            timeout: wiseResult.reason?.code === "ECONNABORTED",
            error: wiseResult.reason?.message,
          };

    const existInMmt = mmtData.existInMmt || false;
    const existInWise = wiseData.existInWise || false;

    // ── Not found in any system ──────────────────────────────────────────────
    if (!existInMmt && !existInWise) {
      return res.status(404).json({
        success: false,
        existInMmt: false,
        existInWise: false,
        message: "Vehicle not found in any system",
      });
    }

    // ── OTP source decision — purely data driven ─────────────────────────────
    //
    // Wise flow is active ONLY when Wise returned code:1 AND an otp value.
    // This single condition covers all three cases:
    //   existInMmt && existInWise  → Wise OTP overrides MMT OTP
    //   existInMmt only            → MMT OTP (Wise never returned code:1 + otp)
    //   existInWise only           → Wise OTP
    //
    const wiseOtp = wiseData.wiseData?.otp || null;
    const wiseCode = wiseData.wiseData?.code || null;

    const wiseFlowActive = existInWise && wiseCode === 1 && !!wiseOtp;

    const activeOtp = wiseFlowActive ? wiseOtp : mmtData.generatedOtp || null;
    const activeSource = wiseFlowActive ? "wise" : "mmt";

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

    // ── Write login_initiated to history collection (not on the document) ────
    await DriverLoginHistory.create({
      vehicleNumber: normalizedVehicle,
      authRecordId: authRecord._id,
      action: "login_initiated",
      source: existInMmt ? (existInWise ? "both" : "mmt") : "wise",
      details: {
        b2cExists: existInMmt,
        b2bExists: existInWise,
        otpSource: activeSource,
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
        otpSent: true,
        otpExpiry,
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
        response.b2bOtp = wiseOtp;
      }
    }

    return res.status(200).json(response);
  } catch (err) {
    console.error("Common Login Error:", err.message);
    return res
      .status(500)
      .json({ success: false, message: "Internal Server Error" });
  }
};

// ─────────────────────────────────────────────
// MMT service login
// ─────────────────────────────────────────────

const loginDriverForMMTService = async (vehicleNumber) => {
  try {
    const foundVehicle = await Vehicle.findOne({
      VehicleNumber: vehicleNumber,
    });
    if (!foundVehicle) return { success: false, existInMmt: false };

    const activeDriver = foundVehicle.ActiveDriver;
    if (!activeDriver) return { success: false, existInMmt: false };

    const foundDriver = await Driver.findById(activeDriver);
    if (!foundDriver) return { success: false, existInMmt: false };

    const otp = Math.floor(100000 + Math.random() * 900000);
    await generateOtpMobile(foundDriver.MobileNumber, vehicleNumber, otp);

    return {
      success: true,
      existInMmt: true,
      vehicleId: foundVehicle._id,
      driverId: foundDriver._id,
      driverContact: foundDriver.MobileNumber,
      driverName: foundDriver.Name,
      generatedOtp: otp,
    };
  } catch (err) {
    console.error("MMT login error:", err.message);
    return { success: false, existInMmt: false };
  }
};

// ─────────────────────────────────────────────
// Wise service login
//
// ValidateUser response: { code: 1, otp: "920220", msg: "Welcome in WTI mobile app" }
// code: 1 is the ONLY indicator that this vehicle exists in Wise
// ─────────────────────────────────────────────

const loginDriverForWiseService = async (vehicleNumber, gcm) => {
  try {
    const wiseApiUrl = `${process.env.WISE_BASE_URL}/api/Login/ValidateUser`;

    const response = await axios.get(wiseApiUrl, {
      params: {
        UserID: vehicleNumber,
        LoginType: 0,
        password: 0,
        gcm: gcm || "dummy_gcm_token",
        ApiID: process.env.WISE_API_ID || "WSId201",
        ApiPassword: process.env.WISE_API_PASSWORD || "WSPwd201",
      },
      timeout: 5000,
    });

    if (!response.data) return { success: false, existInWise: false };

    const exists = response.data.code === 1;

    return {
      success: true,
      existInWise: exists,
      wiseData: {
        code: response.data.code,
        message: response.data.msg,
        otp: response.data.otp || null,
        userId: vehicleNumber,
      },
    };
  } catch (err) {
    if (err.response) {
      const data = err.response.data || {};
      return {
        success: false,
        existInWise: false,
        wiseServerError: err.response.status >= 500,
        wiseData: { code: data.code, message: data.msg },
        error: err.message,
      };
    }
    if (err.code === "ECONNABORTED") {
      return {
        success: false,
        existInWise: false,
        timeout: true,
        error: "Wise service timeout",
      };
    }
    return { success: false, existInWise: false, error: err.message };
  }
};

const generateOtpMobile = async (mobile, VehicleNumber) => {
  try {
    const currentOtp = await Mobileotp.findOne({
      VehicleNumber: VehicleNumber.toLowerCase(),
    });

    if (currentOtp) {
      await Mobileotp.deleteMany({
        VehicleNumber: VehicleNumber.toLowerCase(),
      });
      console.log(
        // time.tds(),

        `generateOtpMobile()-- Previous otp deleted`,
      );
    }

    const newOTP = `${Math.floor(1000 + Math.random() * 9000)}`;

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
      // time.tds(),

      `generateOtpMobile()-- new otp saved`,
    );

    const externalApiUrl = `https://http.myvfirst.com/smpp/sendsms?username=wheelzonrent&password=wheel123&to=${mobile}&udh=0&from=wticab&text=Dear customer Your OTP for WTi Cabs Login is ${newOTP} Thanks WTICABS&action=send&category=bulk`;
    const response = await axios.get(externalApiUrl);
    // console.log(response);
    // console.log(response.data);
    return;
  } catch (err) {
    console.log(
      // time.tds(),

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

    // If B2B token is null → take from DB
    if (!b2bToken && authRecord?.b2b?.token) {
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
      MobileNo: authRecord.mobileNo != null ? String(authRecord.mobileNo) : null,

      // Wise Token (B2B)
      Token: b2bToken || null,

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

    // Add B2C token separately (MMT token)
    if (b2cToken) {
      finalResponse.b2cToken = b2cToken;
    }

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

      // Dual-flow: also open B2C session
      if (existInWise) {
        record.b2c.verified = true;
        record.b2c.token = `mmt_${Date.now()}_${Math.random()
          .toString(36)
          .substring(2, 15)}`;
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

    await DriverLoginHistory.create({
      vehicleNumber: normalizedVehicle,
      authRecordId: record._id,
      action: "auto_login_success",
      source: verificationResult.source,
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
      Token: verificationResult.source === "wise" ? sessionToken : null,
      AllocationID: wd.allocationId ?? null,
      CabID: wd.cabId ?? null,
      CabNo: wd.cabNo || null,
      CarType: wd.carType || null,
      OTP: null,
      IsOnDuty: wd.isOnDuty ?? null,
      VendorID: wd.vendorId ?? null,
      BranchID: wd.branchId ?? null,
    };

    if (verificationResult.source === "mmt") {
      finalResponse.b2cToken = sessionToken;
    } else if (record.b2c?.token) {
      finalResponse.b2cToken = record.b2c.token;
    }

    return res.status(200).json(finalResponse);
  } catch (error) {
    console.error("autoLoginToB2BIfExistInMMT Error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Internal Server Error",
    });
  }
};

module.exports = {
  loginCommonForDriver,
  checkWhenToSwitchToB2BApp,
  createOrUpdateConfig,

  getCommanAuthDetailOnEveryHit,
  autoLoginToB2BIfExistInMMT,
};
