// controllers/bookingController.js
//
// Common booking list — one call returns the driver's B2B (Wise) and B2C (MMT)
// duties merged into a single list, in Wise's response format.
//
//   GET /fetch-booking-list?AllocationID&Gcm&Month&CabId&userid&token
//       (exactly the query Wise's BookingList takes; forwarded to Wise as-is)
//
//   200 { code: 1, Msg, BookingList: [...], driverMobile? }
//       BookingList sorted newest first by the date inside DutyType
//       ("Apt.Transfer / Office Drop | 13/Oct/2026 11:55 PM").
//
// Routing, decided from the auth record of `userid` (b2b.exist / b2c.exist):
//   Wise → GET  {WISE_BASE_URL}/api/Chauffuer/BookingList   (query forwarded)
//   MMT  → POST {MMT_BASE_URL}/0auth/Driver/getAlightBookingsByVehicle
//               { VehicleNumber }  — MMT has no month filter, so its bookings
//               are filtered to the requested Month here to match Wise.
//   Both → both called in parallel; a source that fails is left out (and
//          logged) instead of failing the whole list.

const axios = require("axios");
const AuthModelForCommonDApp = require("../models/AuthModelForCommonDApp");
const time = require("../utils/time");

const TIMEOUT_MS = 5000;

// Same normalization as login: lower-case, spaces ignored
const normalize = (v) => String(v).toLowerCase().replace(/\s/g, "");

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// "… | 13/Oct/2026 11:55 PM" → Date, or null when it can't be read
const dutyDate = (booking) => {
  const m = /\|\s*(\d{1,2})\/([A-Za-z]{3})\/(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(
    booking?.DutyType || "",
  );
  if (!m) return null;
  const month = MONTHS[m[2].toLowerCase()];
  if (month === undefined) return null;
  let hour = Number(m[4]) % 12;
  if (m[6].toUpperCase() === "PM") hour += 12;
  return new Date(Number(m[3]), month, Number(m[1]), hour, Number(m[5]));
};

// ─────────────────────────────────────────────
// Sources — each returns { ok, bookings, msg, extra } and never throws
// ─────────────────────────────────────────────

const fetchWiseBookings = async (query, vehicle) => {
  const url = `${process.env.WISE_BASE_URL}/api/Chauffuer/BookingList`;
  const params = { ...query }; // forwarded exactly as the app sent it
  console.log(`${time.tds()} [BOOKING] WISE BookingList called for vehicle=${vehicle}`);

  try {
    const response = await axios.get(url, { params, timeout: TIMEOUT_MS });
    const data = response.data;
    const ok = data?.code === 1;
    console.log(
      `${time.tds()} [BOOKING] WISE BookingList response for vehicle=${vehicle}: code=${data?.code}, count=${data?.BookingList?.length ?? 0}, Msg=${data?.Msg}`,
    );
    return {
      ok,
      bookings: ok && Array.isArray(data.BookingList) ? data.BookingList : [],
      msg: data?.Msg ?? null,
    };
  } catch (err) {
    console.error(`${time.tds()} [BOOKING] WISE BookingList FAILED for vehicle=${vehicle}: code=${err.code ?? "-"}, http=${err.response?.status ?? "-"}, msg=${err.message}`);
    return { ok: false, bookings: [], msg: null };
  }
};

const fetchMmtBookings = async (vehicle, month) => {
  const url = `${process.env.MMT_BASE_URL}/0auth/Driver/getAlightBookingsByVehicle`;
  const body = { VehicleNumber: vehicle };
  console.log(`${time.tds()} [BOOKING] MMT getAlightBookingsByVehicle called for vehicle=${vehicle}`);

  try {
    const response = await axios.post(url, body, {
      timeout: Number(process.env.MMT_TIMEOUT_MS) || TIMEOUT_MS,
      validateStatus: () => true,
    });
    const data = response.data;
    const ok = response.status === 200 && data?.code === 1;
    let bookings = ok && Array.isArray(data.BookingList) ? data.BookingList : [];

    // Wise answers for one Month; MMT returns everything — match Wise
    if (month) {
      bookings = bookings.filter((b) => {
        const d = dutyDate(b);
        return !d || d.getMonth() + 1 === month;
      });
    }

    console.log(
      `${time.tds()} [BOOKING] MMT getAlightBookingsByVehicle response for vehicle=${vehicle}: http ${response.status}, code=${data?.code}, count=${data?.BookingList?.length ?? 0}, inMonth=${bookings.length}`,
    );
    return {
      ok,
      bookings,
      msg: data?.Msg ?? null,
      extra: data?.driverMobile ? { driverMobile: data.driverMobile } : {},
    };
  } catch (err) {
    console.error(`${time.tds()} [BOOKING] MMT getAlightBookingsByVehicle FAILED for vehicle=${vehicle}: code=${err.code ?? "-"}, http=${err.response?.status ?? "-"}, msg=${err.message}`);
    return { ok: false, bookings: [], msg: null };
  }
};

// ─────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────

// Long secrets → first/last 6 chars only, for console logs
const shorten = (v) =>
  v == null ? "-" : String(v).length > 16 ? `${String(v).slice(0, 6)}…${String(v).slice(-6)}` : String(v);

const fetchBookingList = async (req, res) => {
  const startedAt = Date.now();
  const tag = `${time.tds()} [BOOKING]`;
  const { userid, Month, AllocationID, CabId, Gcm, token } = req.query;
  const vehicle = userid ? normalize(userid) : "-";

  // Logs the outcome of every response, then sends it
  const respond = (status, body) => {
    const ms = Date.now() - startedAt;
    const line =
      `${time.tds()} [BOOKING] ← fetchBookingList vehicle=${vehicle} http=${status} code=${body.code}` +
      ` bookings=${body.BookingList?.length ?? 0} Msg="${body.Msg}" (${ms}ms)`;
    (status >= 500 ? console.error : status >= 400 || body.code !== 1 ? console.warn : console.log)(line);
    return res.status(status).json(body);
  };

  console.log(
    `${tag} → fetchBookingList userid=${userid ?? "-"} vehicle=${vehicle} Month=${Month ?? "-"}` +
      ` AllocationID=${AllocationID ?? "-"} CabId=${CabId ?? "-"} Gcm=${shorten(Gcm)} token=${shorten(token)}`,
  );

  try {
    if (!userid) {
      return respond(400, { code: 0, Msg: "userid is required", BookingList: [] });
    }

    const authRecord = await AuthModelForCommonDApp.findOne({
      vehicleNumber: vehicle,
    }).sort({ createdAt: -1 });

    const inWise = !!authRecord?.b2b?.exist;
    const inMmt = !!authRecord?.b2c?.exist;

    console.log(
      `${time.tds()} [BOOKING] auth record for vehicle=${vehicle}: ${authRecord ? `found (${authRecord._id})` : "NOT FOUND"}, inWise(B2B)=${inWise}, inMmt(B2C)=${inMmt}`,
    );

    if (!authRecord || (!inWise && !inMmt)) {
      return respond(404, { code: 0, Msg: "Vehicle not found", BookingList: [] });
    }

    const month = Number(Month) || null;
    console.log(
      `${time.tds()} [BOOKING] routing vehicle=${vehicle}: calling ${[inWise && "WISE", inMmt && "MMT"].filter(Boolean).join(" + ")}${month ? `, month filter=${month}` : ", no month filter"}`,
    );

    const [wise, mmt] = await Promise.all([
      inWise ? fetchWiseBookings(req.query, vehicle) : null,
      inMmt ? fetchMmtBookings(vehicle, month) : null,
    ]);
    const sources = [wise, mmt].filter(Boolean);
    const succeeded = sources.filter((s) => s.ok);

    const summary =
      (inWise ? `wise=${wise.ok ? `ok(${wise.bookings.length})` : "FAILED"} ` : "") +
      (inMmt ? `mmt=${mmt.ok ? `ok(${mmt.bookings.length})` : "FAILED"}` : "");
    console.log(`${time.tds()} [BOOKING] sources for vehicle=${vehicle}: ${summary.trim()}`);

    if (!succeeded.length) {
      console.error(`${time.tds()} [BOOKING] No booking source succeeded for vehicle=${vehicle}`);
      return respond(200, {
        code: 0,
        Msg: sources.find((s) => s.msg)?.msg || "Unable to fetch booking list",
        BookingList: [],
      });
    }

    if (succeeded.length < sources.length) {
      console.warn(
        `${time.tds()} [BOOKING] PARTIAL list for vehicle=${vehicle}: ${sources.length - succeeded.length} source(s) failed and are left out`,
      );
    }

    // Newest first; bookings whose date can't be read go last
    const BookingList = succeeded
      .flatMap((s) => s.bookings)
      .sort((a, b) => (dutyDate(b)?.getTime() ?? -Infinity) - (dutyDate(a)?.getTime() ?? -Infinity));

    const undated = BookingList.filter((b) => !dutyDate(b)).length;
    if (undated) {
      console.warn(
        `${time.tds()} [BOOKING] ${undated} booking(s) for vehicle=${vehicle} have an unreadable date in DutyType — placed last`,
      );
    }

    return respond(200, {
      code: 1,
      Msg: succeeded[0].msg || "Booking list generated suceessfully.",
      ...Object.assign({}, ...succeeded.map((s) => s.extra || {})),
      BookingList,
    });
  } catch (error) {
    console.error(`${time.tds()} [BOOKING] fetchBookingList error for vehicle=${vehicle}:`, error.stack || error.message);
    return respond(500, { code: 0, Msg: "Internal Server Error", BookingList: [] });
  }
};

module.exports = { fetchBookingList };
