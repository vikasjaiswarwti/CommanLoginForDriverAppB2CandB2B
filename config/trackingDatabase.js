// config/trackingDatabase.js
//
// Separate, READ-ONLY connection to the tracking database written by the .NET
// SignalR service (wischauffeur.TrackLocation). This service never writes there:
//   • autoIndex / autoCreate off → mongoose never creates indexes or collections
//   • readPreference secondaryPreferred → dashboard reads stay off the primary
//     that SignalR is writing to
//   • the TrackLocation model blocks every write method (models/TrackLocation.js)
//
// .env:
//   TRACKING_MONGODB_URI   (optional) — defaults to MONGODB_URI (same cluster)
//   TRACKING_DB_NAME       (optional) — defaults to "wischauffeur"

require("./database"); // applies the DNS_SERVERS fix needed for mongodb+srv
const mongoose = require("mongoose");

let connection = null;

// Opened lazily on first use and then reused
const getTrackingConnection = () => {
  if (!connection) {
    const uri = process.env.TRACKING_MONGODB_URI || process.env.MONGODB_URI;
    if (!uri) throw new Error("TRACKING_MONGODB_URI / MONGODB_URI is not set in .env");

    connection = mongoose.createConnection(uri, {
      dbName: process.env.TRACKING_DB_NAME || "wischauffeur",
      readPreference: "secondaryPreferred",
      autoIndex: false,
      autoCreate: false,
    });
    connection.on("error", (err) =>
      console.error("Tracking DB connection error:", err.message),
    );
  }
  return connection;
};

module.exports = { getTrackingConnection };
