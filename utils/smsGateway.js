// utils/smsGateway.js

const axios = require("axios");
const time = require("./time");
const { recordExternalCall } = require("./loginHistoryLogger");

// ─────────────────────────────────────────────────────────────────────────────
// Login OTP SMS via myvfirst. Used for MMT-only vehicles: MMT's loginDriver is
// always called with skipSms:true and returns the OTP, and this service texts
// it to the driver. (Wise vehicles get their SMS from Wise itself.)
//
// GET {SMS_GATEWAY_URL}?username&password&to&udh=0&from&text&action=send&category=bulk
//
// Configured from .env: SMS_GATEWAY_URL, SMS_USERNAME, SMS_PASSWORD, SMS_FROM.
// The text is the registered template — keep it word-for-word.
// ─────────────────────────────────────────────────────────────────────────────

const loginOtpText = (otp) =>
  `Dear customer Your OTP for WTi Cabs Login is ${otp} Thanks WTICABS`;

// Returns { success, callLog, error } — never throws
const sendLoginOtpSms = async ({ mobile, otp, vehicleNumber }) => {
  const url = process.env.SMS_GATEWAY_URL;
  const { SMS_USERNAME, SMS_PASSWORD, SMS_FROM } = process.env;

  if (!url || !SMS_USERNAME || !SMS_PASSWORD || !SMS_FROM) {
    console.error(
      `${time.tds()} [OTP-SERVICE] SMS gateway not configured (SMS_GATEWAY_URL / SMS_USERNAME / SMS_PASSWORD / SMS_FROM) — OTP SMS NOT sent for vehicle=${vehicleNumber}`,
    );
    return { success: false, callLog: null, error: "SMS gateway not configured" };
  }

  const params = {
    username: SMS_USERNAME,
    password: SMS_PASSWORD,
    to: mobile,
    udh: 0,
    from: SMS_FROM,
    text: loginOtpText(otp),
    action: "send",
    category: "bulk",
  };
  const sentAt = new Date();
  const record = (extra) =>
    recordExternalCall({
      service: "sms",
      endpoint: "sendsms",
      url,
      params,
      maskKeys: ["password"],
      sentAt,
      ...extra,
    });

  try {
    console.log(
      `${time.tds()} [OTP-SERVICE] SMS gateway (myvfirst) called for mobile=${mobile}, vehicle=${vehicleNumber}`,
    );
    const response = await axios.get(url, { params, timeout: 5000 });
    console.log(
      `${time.tds()} [OTP-SERVICE] SMS gateway response for vehicle=${vehicleNumber}: http ${response.status}, body=${JSON.stringify(response.data)}`,
    );
    return { success: true, callLog: record({ response }) };
  } catch (err) {
    console.error(
      `${time.tds()} [OTP-SERVICE] SMS gateway FAILED for mobile=${mobile}, vehicle=${vehicleNumber}: code=${err.code}, status=${err.response?.status ?? "-"}, msg=${err.message}`,
    );
    return { success: false, callLog: record({ error: err }), error: err.message };
  }
};

module.exports = { sendLoginOtpSms };
