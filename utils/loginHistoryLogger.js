// utils/loginHistoryLogger.js

const axios = require("axios");
const DriverLoginHistory = require("../models/DriverLoginHistory");
const time = require("./time");

// Credentials that must never be persisted, even in a raw log
const MASKED_PARAMS = ["ApiPassword"];

const maskParams = (params = {}) => {
  const copy = { ...params };
  for (const key of MASKED_PARAMS) {
    if (copy[key] !== undefined) copy[key] = "***";
  }
  return copy;
};

// ─────────────────────────────────────────────────────────────────────────────
// Records one external call exactly as it happened: the method, URL and
// params object that were handed to axios, and the raw status + body that
// came back (or the axios error if nothing / a non-2xx came back).
//
// Pass the SAME `url` and `params` objects that were given to axios.
// ─────────────────────────────────────────────────────────────────────────────

const recordExternalCall = ({
  service = "wise",
  endpoint,
  method = "GET",
  url,
  params,
  sentAt,
  response,
  error,
}) => {
  const res = response || error?.response;

  return {
    service,
    endpoint,
    request: {
      method,
      url,
      params: maskParams(params),
      sentAt,
    },
    response: res
      ? { status: res.status ?? null, body: res.data ?? null, receivedAt: new Date() }
      : null,
    error: error ? { code: error.code || null, message: error.message || null } : null,
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Server console output — this is where the interpretation lives
// (status / errorCode / message are printed, never persisted), e.g.
//   [2026-10-06 15:25:38.876 IST] [LOGIN-HISTORY] login_failed FAILURE vehicle=testveh129 source=none http=404 error=VEHICLE_NOT_FOUND
//   [2026-10-06 15:25:38.876 IST] [LOGIN-HISTORY]   ↳ wise ValidateUser GET http://.../api/Login/ValidateUser?UserID=... → 200 {"code":0,"msg":"..."} (225ms)
// ─────────────────────────────────────────────────────────────────────────────

const printLoginEvent = (entry, externalCalls) => {
  const stamp = `${time.tds()} [LOGIN-HISTORY]`;
  const print = entry.status === "failure" ? console.warn : console.log;

  print(
    `${stamp} ${entry.action} ${String(entry.status || "").toUpperCase()}` +
      ` vehicle=${entry.vehicleNumber} source=${entry.source}` +
      ` http=${entry.httpStatus ?? "-"}` +
      (entry.errorCode ? ` error=${entry.errorCode}` : "") +
      (entry.message ? ` msg="${entry.message}"` : ""),
  );

  for (const call of externalCalls) {
    const fullUrl = axios.getUri({
      url: call.request.url,
      params: call.request.params,
    });
    const outcome = call.response
      ? `${call.response.status} ${JSON.stringify(call.response.body)}`
      : `NO RESPONSE`;
    const tookMs = call.response
      ? call.response.receivedAt - call.request.sentAt
      : Date.now() - call.request.sentAt;

    print(
      `${stamp}   ↳ ${call.service} ${call.endpoint} ${call.request.method} ${fullUrl}` +
        ` → ${outcome} (${tookMs}ms)` +
        (call.error ? ` error=${call.error.code} "${call.error.message}"` : ""),
    );
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Prints the event to the console and persists ONLY the raw facts:
// vehicleNumber, authRecordId, action, source, externalCalls.
// `status`, `httpStatus`, `errorCode`, `message` are console-only.
// Never throws — a logging failure must never break the login flow itself.
// ─────────────────────────────────────────────────────────────────────────────

const logLoginEvent = async (req, entry) => {
  const vehicleNumber = entry.vehicleNumber || "unknown";
  const source = entry.source || "none";
  const externalCalls = (entry.externalCalls || []).filter(Boolean);

  try {
    printLoginEvent({ ...entry, vehicleNumber, source }, externalCalls);
  } catch (err) {
    console.error(`${time.tds()} [LOGIN-HISTORY] Failed to print:`, err.message);
  }

  try {
    await DriverLoginHistory.create({
      vehicleNumber,
      authRecordId: entry.authRecordId || null,
      action: entry.action,
      source,
      externalCalls,
    });
  } catch (err) {
    console.error(
      `${time.tds()} [LOGIN-HISTORY] Failed to write history:`,
      err.message,
    );
  }
};

const normalizeVehicle = (vehicleNumber) =>
  typeof vehicleNumber === "string"
    ? vehicleNumber.toLowerCase().replace(/\s/g, "")
    : null;

module.exports = { recordExternalCall, logLoginEvent, normalizeVehicle };
