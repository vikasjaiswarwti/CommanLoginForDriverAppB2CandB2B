// controllers/deviceHealthController.js
//
// Device health of the driver's phone during a booking, read from the tracking
// data the .NET SignalR service writes (wischauffeur.TrackLocation). READ-ONLY.
//
// GET /device-health?BookingType=B2B|B2C&BookingID=…
//     [&cursor=<_id>]          → next (older) page, from the previous nextCursor
//     [&from=<ISO>&to=<ISO>]   → optional booking time window (strongly
//                                recommended for B2C, see "Performance")
//
// 20 points per call, newest first. No polling / live mode — on-demand reads only.
//   200 { success, data: [...], nextCursor, hasMore }
//   • Infinite scroll: call again with cursor=nextCursor while hasMore is true.
//
// Performance (TrackLocation is ~1 crore docs; indexes: _id, BookingID):
//   • B2B → BookingID index, then sorted in memory (one booking's points).
//   • B2C → B2cBookingID has NO index, so the query walks the _id index from
//     the cursor downward. from/to are turned into an _id range (ObjectId
//     carries the insert time) so only that window is scanned. Without from/to,
//     an old B2C booking may hit maxTimeMS → 504 asking for from/to.
//   • Pagination is by _id cursor, never skip.
//
// Auth: if DASHBOARD_API_KEY is set in .env, the x-api-key header must match.

const mongoose = require("mongoose");
const { getTrackLocationModel } = require("../models/TrackLocation");
const time = require("../utils/time");

const PAGE_SIZE = 20; // points per /device-health call
const BOOKINGS_PAGE_SIZE = 10; // bookings per /device-health/bookings call
const MAX_TIME_MS = Number(process.env.DEVICE_HEALTH_MAX_TIME_MS) || 8000;

const PROJECTION = {
  AllocationID: 1,
  Latitude: 1,
  Longitude: 1,
  BookingID: 1,
  B2cBookingID: 1,
  Status: 1,
  B2CStatus: 1,
  PassedBy: 1,
  RecordDateTime: 1,
  CreatedAt: 1,
  Miscellaneous: 1,
};

// "B2B" / "btob" → "b2b", "B2C" / "btoc" → "b2c"
const bookingSystem = (type) => {
  const t = String(type ?? "").toLowerCase();
  if (t === "b2b" || t === "btob") return "b2b";
  if (t === "b2c" || t === "btoc") return "b2c";
  return null;
};

const isObjectId = (v) => typeof v === "string" && /^[a-f\d]{24}$/i.test(v);

// Optional dashboard API key: when DASHBOARD_API_KEY is set, x-api-key must match
const hasValidApiKey = (req) => {
  const apiKey = process.env.DASHBOARD_API_KEY;
  return !apiKey || req.headers?.["x-api-key"] === apiKey;
};

// ISO string or epoch ms → Date, or null when not a valid date
const toDate = (v) => {
  if (v == null || v === "") return null;
  const d = /^\d+$/.test(String(v)) ? new Date(Number(v)) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

// Date → smallest ObjectId created at that second (for _id range bounds)
const idAt = (date) =>
  mongoose.Types.ObjectId.createFromTime(Math.floor(date.getTime() / 1000));

const toNumber = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const formatPoint = (p) => {
  const m = p.Miscellaneous || {};
  return {
    id: String(p._id),
    recordDateTime: p.RecordDateTime ?? null,
    receivedAt: p.CreatedAt ?? null,
    latitude: toNumber(p.Latitude),
    longitude: toNumber(p.Longitude),
    allocationId: p.AllocationID ?? null,
    status: p.Status ?? null,
    b2cStatus: p.B2CStatus ?? null,
    passedBy: p.PassedBy ?? null,
    health: {
      batteryPercentage: m.BatteryPercentage ?? null,
      onCharging: m.OnCharging ?? null,
      hasInternet: m.IsHasInternet ?? null,
      networkLoss: m.NetworkLoss ?? null,
      gpsLoss: m.GpsLoss ?? null,
      isMocked: m.IsMocked ?? null,
      onCall: m.OnCall ?? null,
      accuracy: m.Accuracy ?? null,
      speed: m.Speed ?? null,
      speedAccuracy: m.SpeedAccuracy ?? null,
      altitude: m.Altitude ?? null,
      bearing: m.Bearing ?? null,
      bearingAccuracy: m.BearingAccuracy ?? null,
    },
  };
};

const getDeviceHealth = async (req, res) => {
  const startedAt = Date.now();
  const { BookingType, BookingID, cursor, from, to } = req.query;
  const system = bookingSystem(BookingType);

  const respond = (status, body) => {
    const line =
      `${time.tds()} [DEVICE-HEALTH] ← type=${system ?? "-"} BookingID=${BookingID ?? "-"}` +
      ` http=${status} points=${body.data?.length ?? 0} hasMore=${body.hasMore ?? "-"} (${Date.now() - startedAt}ms)`;
    (status >= 500 ? console.error : status >= 400 ? console.warn : console.log)(line);
    return res.status(status).json(body);
  };
  const fail = (status, message) => respond(status, { success: false, message });

  console.log(
    `${time.tds()} [DEVICE-HEALTH] → BookingType=${BookingType ?? "-"} BookingID=${BookingID ?? "-"}` +
      ` cursor=${cursor ?? "-"} from=${from ?? "-"} to=${to ?? "-"}`,
  );

  try {
    if (!hasValidApiKey(req)) return fail(401, "Unauthorized");

    // ── Validate input ─────────────────────────────────────────────────────
    if (!system) return fail(400, 'BookingType must be "B2B" or "B2C"');
    if (!BookingID || !String(BookingID).trim()) return fail(400, "BookingID is required");
    if (cursor && !isObjectId(cursor)) return fail(400, "cursor is invalid");

    const fromDate = toDate(from);
    const toDateValue = toDate(to);
    if (from && !fromDate) return fail(400, "from must be an ISO date or epoch ms");
    if (to && !toDateValue) return fail(400, "to must be an ISO date or epoch ms");
    if (fromDate && toDateValue && fromDate > toDateValue) {
      return fail(400, "from must be before to");
    }

    // ── Build the query ────────────────────────────────────────────────────
    const filter = {};
    let hint;
    if (system === "b2b") {
      const id = Number(BookingID);
      // BookingID 0 is what every B2C point carries — never allow it here
      if (!Number.isInteger(id) || id <= 0) {
        return fail(400, "BookingID must be a positive number for B2B");
      }
      filter.BookingID = id;
      hint = { BookingID: 1 };
    } else {
      filter.B2cBookingID = String(BookingID).trim();
      hint = { _id: 1 };
    }

    // _id range: time window + pagination cursor (all served by the _id index)
    const idRange = {};
    if (fromDate) idRange.$gte = idAt(fromDate);
    if (toDateValue) idRange.$lt = idAt(new Date(toDateValue.getTime() + 1000));
    if (cursor) {
      const c = new mongoose.Types.ObjectId(cursor);
      if (!idRange.$lt || c < idRange.$lt) idRange.$lt = c;
    }
    if (Object.keys(idRange).length) filter._id = idRange;

    // Newest first; each page continues below the previous page's last _id
    const TrackLocation = getTrackLocationModel();
    const rows = await TrackLocation.find(filter, PROJECTION)
      .sort({ _id: -1 })
      .limit(PAGE_SIZE + 1)
      .hint(hint)
      .maxTimeMS(MAX_TIME_MS)
      .lean();

    const hasMore = rows.length > PAGE_SIZE;
    const data = rows.slice(0, PAGE_SIZE).map(formatPoint);

    return respond(200, {
      success: true,
      data,
      // next older page (infinite scroll)
      nextCursor: hasMore ? data[data.length - 1].id : null,
      hasMore,
    });
  } catch (error) {
    // 50 = MaxTimeMSExpired
    if (error?.code === 50 || error?.codeName === "MaxTimeMSExpired") {
      return fail(
        504,
        "Search took too long. Pass from and to (booking start / end time) to narrow it.",
      );
    }
    console.error(`${time.tds()} [DEVICE-HEALTH] error:`, error.stack || error.message);
    return fail(500, "Internal Server Error");
  }
};

// ─────────────────────────────────────────────
// Bookings with tracking data on one day (the B2B / B2C tabs)
//
// GET /device-health/bookings?BookingType=B2B|B2C[&date=YYYY-MM-DD][&BookingID=…][&cursor=<_id>]
//   date      → IST calendar day, 00:00:00 – 23:59:59 (default: today in IST)
//   BookingID → optional search: B2B exact booking number (uses the BookingID
//               index); B2C case-insensitive "contains" (e.g. "17919")
//   cursor    → nextCursor from the previous page (infinite scroll)
//
// 10 bookings per call, most recently active first.
//   200 { success, date, bookingType, data: [{ bookingType, bookingId,
//         allocationId, firstSeen, lastSeen, points, isLive }], nextCursor, hasMore }
// Pass a booking's firstSeen / lastSeen as from / to to /device-health — that
// keeps the B2C points query inside the booking's own time window.
//
// Performance: the day becomes an _id range (ObjectId carries the insert
// time), so only that day's points are read via the _id index, then grouped
// per booking. Read-only aggregation, capped by maxTimeMS.
// ─────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const LIVE_WINDOW_MS = (Number(process.env.DEVICE_HEALTH_LIVE_MINUTES) || 5) * 60 * 1000;

// "2026-10-23" (IST) → { start, end } as UTC Dates; null if not a valid date
const istDayRange = (dateStr) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  const startUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - IST_OFFSET_MS;
  const check = new Date(startUtc + IST_OFFSET_MS);
  if (check.getUTCDate() !== Number(m[3])) return null; // e.g. 2026-02-31
  return { start: new Date(startUtc), end: new Date(startUtc + 24 * 60 * 60 * 1000) };
};

// Today's date in IST as "YYYY-MM-DD"
const todayIst = () => new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);

const getDeviceHealthBookings = async (req, res) => {
  const startedAt = Date.now();
  const { BookingType, cursor } = req.query;
  const system = bookingSystem(BookingType);
  const search = String(req.query.BookingID ?? "").trim();
  const date = req.query.date || todayIst();

  const respond = (status, body) => {
    const line =
      `${time.tds()} [DEVICE-HEALTH] ← bookings type=${system ?? "-"} date=${date} BookingID=${search || "-"}` +
      ` http=${status} bookings=${body.data?.length ?? 0} hasMore=${body.hasMore ?? "-"} (${Date.now() - startedAt}ms)`;
    (status >= 500 ? console.error : status >= 400 ? console.warn : console.log)(line);
    return res.status(status).json(body);
  };
  const fail = (status, message) => respond(status, { success: false, message });

  console.log(
    `${time.tds()} [DEVICE-HEALTH] → bookings BookingType=${BookingType ?? "-"} date=${date} BookingID=${search || "-"} cursor=${cursor ?? "-"}`,
  );

  try {
    if (!hasValidApiKey(req)) return fail(401, "Unauthorized");
    if (!system) return fail(400, 'BookingType must be "B2B" or "B2C"');
    if (cursor && !isObjectId(cursor)) return fail(400, "cursor is invalid");

    const day = istDayRange(date);
    if (!day) return fail(400, "date must be YYYY-MM-DD");

    const isB2c = system === "b2c";
    const bookingField = isB2c ? "$B2cBookingID" : "$BookingID";

    // ── Optional BookingID search ───────────────────────────────────────────
    let bookingFilter;
    let hint = { _id: 1 };
    if (!isB2c) {
      bookingFilter = { $gt: 0 };
      if (search) {
        const id = Number(search);
        if (!Number.isInteger(id) || id <= 0) {
          return fail(400, "BookingID must be a positive number for B2B");
        }
        bookingFilter = id;
        hint = { BookingID: 1 }; // exact booking → index seek instead of the day scan
      }
    } else {
      bookingFilter = { $nin: [null, ""] };
      if (search) {
        if (search.length > 100) return fail(400, "BookingID is too long");
        // contains, case-insensitive; user text escaped so it is matched literally
        const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        bookingFilter = { $regex: escaped, $options: "i" };
      }
    }

    const pipeline = [
      // One IST day of points, read through the _id index
      {
        $match: {
          _id: { $gte: idAt(day.start), $lt: idAt(day.end) },
          ...(isB2c
            ? { IsB2C: true, B2cBookingID: bookingFilter }
            : { IsB2C: { $ne: true }, BookingID: bookingFilter }),
        },
      },
      // One row per booking
      {
        $group: {
          _id: bookingField,
          lastPointId: { $max: "$_id" },
          firstPointId: { $min: "$_id" },
          firstSeen: { $min: "$RecordDateTime" },
          lastSeen: { $max: "$RecordDateTime" },
          allocationId: { $max: "$AllocationID" },
          points: { $sum: 1 },
        },
      },
      // Pagination: most recently active booking first, cursor = its last point
      ...(cursor
        ? [{ $match: { lastPointId: { $lt: new mongoose.Types.ObjectId(cursor) } } }]
        : []),
      { $sort: { lastPointId: -1 } },
      { $limit: BOOKINGS_PAGE_SIZE + 1 },
    ];

    const TrackLocation = getTrackLocationModel();
    const rows = await TrackLocation.aggregate(pipeline).option({
      maxTimeMS: MAX_TIME_MS,
      hint,
    });

    const hasMore = rows.length > BOOKINGS_PAGE_SIZE;
    const now = Date.now();
    const data = rows.slice(0, BOOKINGS_PAGE_SIZE).map((r) => {
      const lastSeen = r.lastSeen ?? r.lastPointId.getTimestamp();
      return {
        bookingType: system.toUpperCase(),
        bookingId: r._id,
        allocationId: r.allocationId ?? null,
        // pass these as from / to to /device-health
        firstSeen: r.firstSeen ?? r.firstPointId.getTimestamp(),
        lastSeen,
        points: r.points,
        isLive: now - new Date(lastSeen).getTime() <= LIVE_WINDOW_MS,
        lastPointId: String(r.lastPointId),
      };
    });

    return respond(200, {
      success: true,
      date,
      bookingType: system.toUpperCase(),
      data,
      nextCursor: hasMore ? data[data.length - 1].lastPointId : null,
      hasMore,
    });
  } catch (error) {
    if (error?.code === 50 || error?.codeName === "MaxTimeMSExpired") {
      return fail(504, "Loading bookings took too long. Please try again.");
    }
    console.error(`${time.tds()} [DEVICE-HEALTH] bookings error:`, error.stack || error.message);
    return fail(500, "Internal Server Error");
  }
};

module.exports = { getDeviceHealth, getDeviceHealthBookings };
