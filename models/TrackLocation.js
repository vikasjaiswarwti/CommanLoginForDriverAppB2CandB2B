// models/TrackLocation.js
//
// READ-ONLY model of wischauffeur.TrackLocation, written by the .NET SignalR
// service (TrackingDataModel / MiscellaneousModel). Field names and types
// mirror what .NET stores — note Latitude / Longitude are strings (.NET
// decimal). Every write method is blocked; this service only reads.
//
// Existing indexes (owned by the .NET side): _id, BookingID.

const mongoose = require("mongoose");
const { getTrackingConnection } = require("../config/trackingDatabase");

const MiscellaneousSchema = new mongoose.Schema(
  {
    BatteryPercentage: Number,
    Speed: Number,
    GpsLoss: Boolean,
    NetworkLoss: Boolean,
    Accuracy: Number,
    Altitude: Number,
    Bearing: Number,
    BearingAccuracy: Number,
    SpeedAccuracy: Number,
    IsMocked: Boolean,
    OnCharging: Boolean,
    OnCall: Boolean,
    IsHasInternet: Boolean,
  },
  { _id: false },
);

const TrackLocationSchema = new mongoose.Schema(
  {
    AllocationID: Number,
    Latitude: String,
    Longitude: String,
    BookingID: Number,
    Status: Number,
    RecordDateTime: Date,
    IsB2C: Boolean,
    B2cBookingID: String,
    PassedBy: String,
    B2CStatus: Number,
    Miscellaneous: MiscellaneousSchema,
    CreatedAt: Date,
  },
  {
    collection: "TrackLocation",
    versionKey: false,
    autoIndex: false,
    autoCreate: false,
  },
);

// ── Read-only guard: any write through this model fails loudly ─────────────
const readOnly = function () {
  throw new Error("TrackLocation is read-only in this service");
};
TrackLocationSchema.pre("save", readOnly);
TrackLocationSchema.pre(
  [
    "updateOne",
    "updateMany",
    "findOneAndUpdate",
    "findOneAndReplace",
    "findOneAndDelete",
    "replaceOne",
    "deleteOne",
    "deleteMany",
  ],
  readOnly,
);
TrackLocationSchema.pre("insertMany", readOnly);
TrackLocationSchema.pre("bulkWrite", readOnly);

// Registered on the tracking connection (not the default one)
const getTrackLocationModel = () => {
  const conn = getTrackingConnection();
  return conn.models.TrackLocation || conn.model("TrackLocation", TrackLocationSchema);
};

module.exports = { getTrackLocationModel, TrackLocationSchema };
