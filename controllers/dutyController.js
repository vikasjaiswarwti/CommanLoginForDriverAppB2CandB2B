// controllers/dutyController.js
//
// Common Driver On/Off status API. Payloads and responses are identical to the
// MMT (B2C) "Driver On/Off Status API", whichever system the vehicle lives in:
//
//   update : { VehicleNumber, driveronoffstatus: boolean }
//   get    : { VehicleNumber }
//   200    : { VehicleNumber, Driverid, driveronoffstatus }
//   errors : { message }   (400 / 404 / 500, same messages as MMT)
//
// Routing, decided from the auth record (b2b.exist / b2c.exist):
//   Wise only → Wise   GET  /api/Chauffuer/OnOrOFFDuty       (update)
//                      GET  /api/internalapi/caronoroffduty  (get)
//   MMT only  → MMT    POST /0auth/Driver/updateDriverOnOffStatus
//                      POST /0auth/Driver/getDriverOnOffStatus (relayed as-is)
//   Both      → BOTH are called, Wise first. Wise is the authority: its
//               result is what is returned. If Wise fails nothing is sent to
//               MMT (so the two never diverge); if MMT fails after Wise
//               succeeded the request still succeeds and the failure is logged.

const axios = require("axios");
const AuthModelForCommonDApp = require("../models/AuthModelForCommonDApp");
const DriverDutyHistory = require("../models/DriverDutyHistory");
const { recordExternalCall } = require("../utils/loginHistoryLogger");
const time = require("../utils/time");

const TIMEOUT_MS = 5000;

const NOT_FOUND_VEHICLE = { message: "Vehicle not found" };
const NOT_FOUND_DRIVER = { message: "no Active Driver to this Vehicle" };
const SERVER_ERROR = { message: "Internal Server Error" };

// Same normalization as login: lower-case, spaces ignored
const normalize = (v) => String(v).toLowerCase().replace(/\s/g, "");

// ─────────────────────────────────────────────
// Duty history — one driver_duty_histories entry per API hit, holding the
// app's request, every Wise/MMT call (exact request + response) and the
// response we returned. Written after responding; never blocks or throws.
// ─────────────────────────────────────────────

const startDutyLog = (req, action) => {
  const log = {
    calls: [],
    authRecordId: null,
    send(res, status, body) {
      res.status(status).json(body);

      const rawVehicle = req.body?.VehicleNumber;
      DriverDutyHistory.create({
        vehicleNumber: rawVehicle ? normalize(rawVehicle) : "unknown",
        authRecordId: log.authRecordId,
        action,
        appRequest: { body: req.body ?? {} },
        externalCalls: log.calls,
        appResponse: { status, body: body ?? null },
      }).catch((err) =>
        console.error(`${time.tds()} [DUTY-HISTORY] Failed to write history:`, err.message),
      );
    },
  };
  return log;
};

// Which systems hold this vehicle? Returns { inWise, inMmt, authRecord }
// or { error: { status, body } } when there is nothing to call.
const resolveSystems = async (normalizedVehicle) => {
  const authRecord = await AuthModelForCommonDApp.findOne({
    vehicleNumber: normalizedVehicle,
  }).sort({ createdAt: -1 });

  const inWise = !!authRecord?.b2b?.exist;
  const inMmt = !!authRecord?.b2c?.exist;

  if (!authRecord || (!inWise && !inMmt)) {
    return { error: { status: 404, body: NOT_FOUND_VEHICLE } };
  }
  return { inWise, inMmt, authRecord };
};

// ─────────────────────────────────────────────
// Wise
// ─────────────────────────────────────────────

const wiseUrl = (path) => `${process.env.WISE_BASE_URL}${path}`;

// Wise needs the allocation and the session token saved at OTP verification
const hasWiseSession = (a) => !!(a.wiseAllocationId && a.wiseToken);

// GET a Wise endpoint, recording the exact params sent and the raw
// response/error into `calls`. Throws on transport errors, as before.
const wiseCall = async (endpoint, path, params, calls) => {
  const url = wiseUrl(path);
  const sentAt = new Date();
  try {
    const response = await axios.get(url, { params, timeout: TIMEOUT_MS });
    calls.push(
      recordExternalCall({ service: "wise", endpoint, url, params, sentAt, response }),
    );
    return response.data;
  } catch (error) {
    calls.push(
      recordExternalCall({ service: "wise", endpoint, url, params, sentAt, error }),
    );
    throw error;
  }
};

const wiseUpdate = async (authRecord, normalizedVehicle, status, calls) => {
  const params = {
    token: authRecord.wiseToken,
    userid: authRecord.wiseUserId || normalizedVehicle,
    AllocationID: authRecord.wiseAllocationId,
    Status: status,
    Gcm: authRecord.wiseGcm || "dummy_gcm_token",
  };
  console.log(
    `${time.tds()} [DUTY] WISE OnOrOFFDuty called for vehicle=${normalizedVehicle}, allocationId=${params.AllocationID}, status=${status}`,
  );
  const data = await wiseCall("OnOrOFFDuty", "/api/Chauffuer/OnOrOFFDuty", params, calls);
  console.log(
    `${time.tds()} [DUTY] WISE OnOrOFFDuty response for vehicle=${normalizedVehicle}: Code=${data?.Code}, Msg=${data?.Msg}`,
  );
  return data;
};

const wiseGet = async (authRecord, normalizedVehicle, calls) => {
  const params = {
    allocationid: authRecord.wiseAllocationId,
    apiid: process.env.WISE_API_ID || "WSId201",
    apipassword: process.env.WISE_API_PASSWORD || "WSPwd201",
  };
  console.log(
    `${time.tds()} [DUTY] WISE caronoroffduty called for vehicle=${normalizedVehicle}, allocationId=${params.allocationid}`,
  );
  const data = await wiseCall(
    "caronoroffduty",
    "/api/internalapi/caronoroffduty",
    params,
    calls,
  );
  console.log(
    `${time.tds()} [DUTY] WISE caronoroffduty response for vehicle=${normalizedVehicle}: Code=${data?.Code}, IsOnDuty=${data?.IsOnDuty}, IsLogout=${data?.IsLogout}`,
  );
  return data;
};

// Wise has no driver id; use the one stored on the auth record, if any
const wiseResponse = (normalizedVehicle, authRecord, driveronoffstatus) => ({
  VehicleNumber: normalizedVehicle,
  Driverid: authRecord.driver?.driverId ?? null,
  driveronoffstatus,
});

// ─────────────────────────────────────────────
// MMT — { status, data } exactly as MMT answers (never throws)
// ─────────────────────────────────────────────

const mmtCall = async (path, body, calls) => {
  const url = `${process.env.MMT_BASE_URL}${path}`;
  const endpoint = path.split("/").pop();
  const sentAt = new Date();
  console.log(`${time.tds()} [DUTY] MMT ${path} called for vehicle=${body.VehicleNumber}`);
  try {
    const r = await axios.post(url, body, {
      timeout: Number(process.env.MMT_TIMEOUT_MS) || TIMEOUT_MS,
      validateStatus: () => true,
    });
    calls.push(
      recordExternalCall({ service: "mmt", endpoint, method: "POST", url, body, sentAt, response: r }),
    );
    console.log(`${time.tds()} [DUTY] MMT ${path} response: http ${r.status}`);
    return { status: r.status, data: r.data };
  } catch (err) {
    calls.push(
      recordExternalCall({ service: "mmt", endpoint, method: "POST", url, body, sentAt, error: err }),
    );
    console.error(`${time.tds()} [DUTY] MMT ${path} failed: ${err.message}`);
    return { status: null, data: null, error: err.message };
  }
};


// ─────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────

const updateDriverOnOffStatus = async (req, res) => {
  const log = startDutyLog(req, "update");
  try {
    const { VehicleNumber, driveronoffstatus } = req.body;

    // MMT answers 500 when VehicleNumber is missing — kept for an identical contract
    if (!VehicleNumber) return log.send(res, 500, SERVER_ERROR);

    if (typeof driveronoffstatus !== "boolean") {
      return log.send(res, 400, {
        message: "driveronoffstatus must be true or false",
      });
    }

    const normalizedVehicle = normalize(VehicleNumber);
    const resolved = await resolveSystems(normalizedVehicle);
    if (resolved.error) {
      return log.send(res, resolved.error.status, resolved.error.body);
    }
    const { inWise, inMmt, authRecord } = resolved;
    log.authRecordId = authRecord._id;
    const mmtBody = { VehicleNumber: normalizedVehicle, driveronoffstatus };
    const mmtPath = "/0auth/Driver/updateDriverOnOffStatus";

    // ── MMT only: relay MMT's answer unchanged ───────────────────────────────
    if (!inWise) {
      const m = await mmtCall(mmtPath, mmtBody, log.calls);
      if (m.status === null) return log.send(res, 500, SERVER_ERROR);
      return log.send(res, m.status, m.data);
    }

    // ── Wise (alone, or first of both) ───────────────────────────────────────
    if (!hasWiseSession(authRecord)) {
      return log.send(res, 404, NOT_FOUND_DRIVER);
    }

    const data = await wiseUpdate(
      authRecord,
      normalizedVehicle,
      driveronoffstatus,
      log.calls,
    );

    if (data?.Code !== 1) {
      console.error(
        `${time.tds()} [DUTY] WISE rejected duty update for vehicle=${normalizedVehicle}: ${data?.Msg}`,
      );
      // MMT is deliberately NOT called, so Wise and MMT never diverge
      return log.send(res, 500, SERVER_ERROR);
    }

    // ── Vehicle is also in MMT: update it too (Wise result still wins) ───────
    if (inMmt) {
      const m = await mmtCall(mmtPath, mmtBody, log.calls);
      if (m.status !== 200 || m.data?.driveronoffstatus !== driveronoffstatus) {
        console.error(
          `${time.tds()} [DUTY] MMT update did NOT apply for vehicle=${normalizedVehicle} (Wise already set ${driveronoffstatus}): http ${m.status}, body=${JSON.stringify(m.data)}${m.error ? `, error=${m.error}` : ""}`,
        );
      }
    }

    return log.send(
      res,
      200,
      wiseResponse(normalizedVehicle, authRecord, driveronoffstatus),
    );
  } catch (error) {
    console.error(`${time.tds()} [DUTY] updateDriverOnOffStatus error:`, error.message);
    return log.send(res, 500, SERVER_ERROR);
  }
};

const getDriverOnOffStatus = async (req, res) => {
  const log = startDutyLog(req, "get");
  try {
    const { VehicleNumber } = req.body;

    if (!VehicleNumber) return log.send(res, 500, SERVER_ERROR);

    const normalizedVehicle = normalize(VehicleNumber);
    const resolved = await resolveSystems(normalizedVehicle);
    if (resolved.error) {
      return log.send(res, resolved.error.status, resolved.error.body);
    }
    const { inWise, inMmt, authRecord } = resolved;
    log.authRecordId = authRecord._id;
    const mmtBody = { VehicleNumber: normalizedVehicle };
    const mmtPath = "/0auth/Driver/getDriverOnOffStatus";

    // ── MMT only: relay MMT's answer unchanged ───────────────────────────────
    if (!inWise) {
      const m = await mmtCall(mmtPath, mmtBody, log.calls);
      if (m.status === null) return log.send(res, 500, SERVER_ERROR);
      return log.send(res, m.status, m.data);
    }

    // ── Wise (alone, or first of both) ───────────────────────────────────────
    if (!authRecord.wiseAllocationId) {
      return log.send(res, 404, NOT_FOUND_DRIVER);
    }

    const data = await wiseGet(authRecord, normalizedVehicle, log.calls);

    if (data?.Code !== 1) {
      console.error(
        `${time.tds()} [DUTY] WISE caronoroffduty failed for vehicle=${normalizedVehicle}: ${data?.Msg}`,
      );
      return log.send(res, 500, SERVER_ERROR);
    }

    // Wise returns IsOnDuty as 1 / 0
    const wiseStatus = Number(data.IsOnDuty) === 1;

    // ── Vehicle is also in MMT: read it too; Wise is returned, a mismatch is logged
    if (inMmt) {
      const m = await mmtCall(mmtPath, mmtBody, log.calls);
      if (m.status !== 200) {
        console.error(
          `${time.tds()} [DUTY] MMT get failed for vehicle=${normalizedVehicle}: http ${m.status}${m.error ? `, error=${m.error}` : ""}`,
        );
      } else if (m.data?.driveronoffstatus !== wiseStatus) {
        console.warn(
          `${time.tds()} [DUTY] Wise and MMT DISAGREE for vehicle=${normalizedVehicle}: wise=${wiseStatus}, mmt=${m.data?.driveronoffstatus}`,
        );
      }
    }

    return log.send(res, 200, wiseResponse(normalizedVehicle, authRecord, wiseStatus));
  } catch (error) {
    console.error(`${time.tds()} [DUTY] getDriverOnOffStatus error:`, error.message);
    return log.send(res, 500, SERVER_ERROR);
  }
};

module.exports = { updateDriverOnOffStatus, getDriverOnOffStatus };
