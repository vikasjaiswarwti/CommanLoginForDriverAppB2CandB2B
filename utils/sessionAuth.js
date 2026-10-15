// utils/sessionAuth.js
//
// Driver session check shared by the app APIs (booking list / details,
// on/off status, helpdesk): the token the app sends must equal the driver's
// current token on the auth record, otherwise the API answers 401 and the app
// logs the driver out.

const AuthModelForCommonDApp = require("../models/AuthModelForCommonDApp");

const UNAUTHORIZED_MESSAGE =
  "Unauthorized: session expired or invalid. Please login again.";

// Same normalization as login: lower-case, spaces ignored
const normalize = (v) => String(v).toLowerCase().replace(/\s/g, "");

// DISPLAY ONLY — long secrets → first/last 6 chars, for console logs.
// Never used for the token check: tokensMatch compares the full strings.
const shorten = (v) =>
  v == null || v === ""
    ? "-"
    : String(v).length > 16
      ? `${String(v).slice(0, 6)}…${String(v).slice(-6)}`
      : String(v);

// The driver's current session token on the auth record — the same single
// effective token login returns: B2B (Wise) token when the vehicle is in B2B,
// otherwise the B2C (MMT) token. Logout clears b2b.token / b2c.token (but NOT
// wiseToken), so wiseToken is deliberately not used — a logged-out driver
// must get 401.
const currentSessionToken = (authRecord) =>
  (authRecord?.b2b?.exist && authRecord.b2b?.token) ||
  authRecord?.b2c?.token ||
  null;

// Full, exact, case-sensitive comparison of the complete token strings;
// missing on either side never matches
const tokensMatch = (sent, expected) =>
  !!sent && !!expected && String(sent) === String(expected);

// Checks `token` against an already-loaded auth record.
// → { ok: true } | { ok: false, reason, log } (log = one line for the console)
const checkSessionToken = (authRecord, token) => {
  const expected = currentSessionToken(authRecord);
  if (tokensMatch(token, expected)) return { ok: true };

  const reason = !token
    ? "token missing in request"
    : !expected
      ? "token sent but no active session in DB"
      : "token does not match DB";
  return {
    ok: false,
    reason,
    log: `${reason} (sent=${shorten(token)}, db=${shorten(expected)})`,
  };
};

// Loads the auth record for `vehicleNumber` and checks `token`.
// → { ok: true, authRecord } | { ok: false, status: 400 | 401, reason, log, authRecord }
const verifyDriverSession = async (vehicleNumber, token) => {
  if (!vehicleNumber) {
    return { ok: false, status: 400, reason: "vehicle number missing", log: "vehicle number missing in request" };
  }
  const authRecord = await AuthModelForCommonDApp.findOne({
    vehicleNumber: normalize(vehicleNumber),
  }).sort({ createdAt: -1 });

  if (!authRecord) {
    return { ok: false, status: 401, reason: "no auth record", log: "no auth record for this vehicle", authRecord: null };
  }
  const check = checkSessionToken(authRecord, token);
  return check.ok
    ? { ok: true, authRecord }
    : { ok: false, status: 401, reason: check.reason, log: check.log, authRecord };
};

module.exports = {
  UNAUTHORIZED_MESSAGE,
  shorten,
  currentSessionToken,
  tokensMatch,
  checkSessionToken,
  verifyDriverSession,
};
