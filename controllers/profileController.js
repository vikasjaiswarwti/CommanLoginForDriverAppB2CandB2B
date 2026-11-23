// controllers/profileController.js
//
// Common vehicle + driver profile (with document expiry), for Wise (B2B) and MMT (B2C).
//
// GET /get-driver-vehicle-profile?userid=<vehicle>&token=<session token>
//   401 { success:false, message }   token missing / not the driver's current session
//   404 { success:false, message }   vehicle is in neither system
//   502 { success:false, message, systems }   every system that was called failed
//   200 { success, source, vehicleNumber,
//         isDriverLinkedToVehicle, vehicle, driver,   ← MMT shape (null if not in MMT / MMT failed)
//         b2b,                                        ← Wise payload (when the vehicle is in Wise)
//         documentExpiry, systems }
//
// Routing, decided from the auth record (b2b.exist / b2c.exist):
//   Wise → GET  {WISE_DOC_BASE_URL | WISE_BASE_URL}/chauffeurscrd/getcabchauffeurdoc?cabno=<vehicle>
//   MMT  → POST {MMT_BASE_URL}/0auth/Driver/getVehicleAndDriverDetails { vehicleNumber, driverMobile }
//   Both → Wise only. MMT is called only when the vehicle is not in Wise.
//
// Every hit writes one driver_login_histories document (action profile_success /
// profile_failed) with the exact request + raw response of each Wise / MMT call.

const axios = require("axios");
const { recordExternalCall, normalizeVehicle, logLoginEvent } = require("../utils/loginHistoryLogger");
const { addExpiryInfo, summarize } = require("../utils/documentExpiry");
const { UNAUTHORIZED_MESSAGE, verifyDriverSession } = require("../utils/sessionAuth");
const time = require("../utils/time");

const TIMEOUT_MS = 5000;

// ─────────────────────────────────────────────
// History — written after responding; never blocks or throws
// ─────────────────────────────────────────────

const startProfileLog = (req) => {
  const log = {
    calls: [],
    authRecordId: null,
    source: "none",
    send(res, status, body) {
      res.status(status).json(body);

      const query = req.query || {};
      // logLoginEvent never throws; status / message are console-only
      logLoginEvent(req, {
        vehicleNumber: (query.userid && normalizeVehicle(String(query.userid))) || "unknown",
        authRecordId: log.authRecordId,
        action: status === 200 ? "profile_success" : "profile_failed",
        source: log.source,
        externalCalls: log.calls.filter(Boolean),
        status: status === 200 ? "success" : "failure",
        httpStatus: status,
        message: body?.message,
      });
    },
  };
  return log;
};

// ─────────────────────────────────────────────
// External calls — each returns { ok, status, data, error, call } and never throws.
// `call` is the history record (exact request sent + raw response / error).
// ─────────────────────────────────────────────

const isHttpOk = (status) => status >= 200 && status < 300;

const wiseProfileCall = async (vehicle) => {
  const url = `${process.env.WISE_DOC_BASE_URL || process.env.WISE_BASE_URL}/chauffeurscrd/getcabchauffeurdoc`;
  const params = { cabno: vehicle };
  const sentAt = new Date();
  console.log(`${time.tds()} [PROFILE] WISE getcabchauffeurdoc called for vehicle=${vehicle}, url=${url}`);
  try {
    const response = await axios.get(url, {
      params,
      timeout: Number(process.env.WISE_TIMEOUT_MS) || TIMEOUT_MS,
      validateStatus: () => true,
    });
    const call = recordExternalCall({
      service: "wise", endpoint: "getcabchauffeurdoc", url, params, sentAt, response,
    });
    const data = response.data;
    const ok = isHttpOk(response.status) && data != null && data !== "";
    console.log(`${time.tds()} [PROFILE] WISE getcabchauffeurdoc response for vehicle=${vehicle}: http ${response.status}`);
    return { ok, status: response.status, data, call, error: ok ? null : `Wise answered http ${response.status}` };
  } catch (err) {
    const call = recordExternalCall({
      service: "wise", endpoint: "getcabchauffeurdoc", url, params, sentAt, error: err,
    });
    console.error(`${time.tds()} [PROFILE] WISE getcabchauffeurdoc failed for vehicle=${vehicle}: ${err.message}`);
    return { ok: false, status: null, data: null, call, error: err.message };
  }
};

const mmtProfileCall = async (vehicle, driverMobile) => {
  const url = `${process.env.MMT_BASE_URL}/0auth/Driver/getVehicleAndDriverDetails`;
  // driverMobile is only known once Wise supplied it (or the auth record has it)
  const body = { vehicleNumber: vehicle, ...(driverMobile ? { driverMobile } : {}) };
  const sentAt = new Date();
  console.log(`${time.tds()} [PROFILE] MMT getVehicleAndDriverDetails called for vehicle=${vehicle}, driverMobile=${driverMobile || "-"}`);
  try {
    const response = await axios.post(url, body, {
      timeout: Number(process.env.MMT_TIMEOUT_MS) || TIMEOUT_MS,
      validateStatus: () => true,
    });
    const call = recordExternalCall({
      service: "mmt", endpoint: "getVehicleAndDriverDetails", method: "POST", url, body, sentAt, response,
    });
    const data = response.data;
    const ok = isHttpOk(response.status) && !!data && typeof data === "object";
    console.log(`${time.tds()} [PROFILE] MMT getVehicleAndDriverDetails response for vehicle=${vehicle}: http ${response.status}`);
    return {
      ok, status: response.status, data, call,
      error: ok ? null : data?.message || `MMT answered http ${response.status}`,
    };
  } catch (err) {
    const call = recordExternalCall({
      service: "mmt", endpoint: "getVehicleAndDriverDetails", method: "POST", url, body, sentAt, error: err,
    });
    console.error(`${time.tds()} [PROFILE] MMT getVehicleAndDriverDetails failed for vehicle=${vehicle}: ${err.message}`);
    return { ok: false, status: null, data: null, call, error: err.message };
  }
};

// ─────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────

const getDriverVehicleProfile = async (req, res) => {
  const startedAt = Date.now();
  const log = startProfileLog(req);
  const userid = req.query.userid;
  const send = (status, body) => {
    console.log(
      `${time.tds()} [PROFILE] ← vehicle=${userid ?? "-"} http=${status} (${Date.now() - startedAt}ms)`,
    );
    return log.send(res, status, body);
  };

  try {
    if (!userid) {
      return send(400, { success: false, message: "userid (vehicle number) is required" });
    }

    // Session check — app's token must be the driver's current token
    const session = await verifyDriverSession(userid, req.query.token);
    log.authRecordId = session.authRecord?._id ?? null;
    if (!session.ok) {
      console.warn(`${time.tds()} [PROFILE] 401 for userid=${userid}: ${session.log}`);
      return send(401, { success: false, message: UNAUTHORIZED_MESSAGE });
    }

    const { authRecord } = session;
    const inWise = !!authRecord.b2b?.exist;
    const inMmt = !!authRecord.b2c?.exist;
    if (!inWise && !inMmt) {
      return send(404, { success: false, message: "Vehicle not found" });
    }

    log.source = inWise && inMmt ? "both" : inWise ? "wise" : "mmt";

    const vehicle = authRecord.vehicleNumber;
    const driverMobile =
      authRecord.driverContact ?? authRecord.driver?.contact ?? authRecord.wiseMobileNo ?? null;

    // Wise only, MMT only, or both → Wise only (Wise is the authority).
    // MMT is called only when the vehicle is NOT in Wise.
    const wise = inWise ? await wiseProfileCall(vehicle) : null;
    const mmt = !inWise
      ? await mmtProfileCall(vehicle, driverMobile ? String(driverMobile) : null)
      : null;
    log.calls.push(wise?.call, mmt?.call);

    const systems = {};
    if (wise) systems.b2b = { success: wise.ok, httpStatus: wise.status, message: wise.error };
    if (mmt) systems.b2c = { success: mmt.ok, httpStatus: mmt.status, message: mmt.error };

    if (!wise?.ok && !mmt?.ok) {
      return send(502, { success: false, message: "Unable to fetch the profile right now", systems });
    }

    // Expiry info per system, plus one combined summary
    const wiseExpiry = wise?.ok ? addExpiryInfo(wise.data, "b2b") : null;
    const mmtExpiry = mmt?.ok ? addExpiryInfo(mmt.data, "b2c") : null;
    const documentExpiry = summarize([...(wiseExpiry?.items ?? []), ...(mmtExpiry?.items ?? [])]);

    return send(200, {
      success: true,
      // the system that was actually called (a vehicle in both is served by Wise)
      source: inWise ? "b2b" : "b2c",
      vehicleNumber: vehicle,
      // MMT shape, as getVehicleAndDriverDetails answers it
      isDriverLinkedToVehicle: mmtExpiry ? !!mmtExpiry.data.isDriverLinkedToVehicle : null,
      vehicle: mmtExpiry?.data.vehicle ?? null,
      driver: mmtExpiry?.data.driver ?? null,
      // Wise payload, as getcabchauffeurdoc answers it
      ...(wise ? { b2b: wiseExpiry?.data ?? null } : {}),
      documentExpiry,
      systems,
    });
  } catch (error) {
    console.error(`${time.tds()} [PROFILE] getDriverVehicleProfile error:`, error.stack || error.message);
    return send(500, { success: false, message: "Internal Server Error" });
  }
};

module.exports = { getDriverVehicleProfile };
