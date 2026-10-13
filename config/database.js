const dns = require("dns");
const mongoose = require("mongoose");

// mongodb+srv:// needs an SRV lookup through Node's own resolver, which fails
// (ECONNREFUSED) when the system DNS is a local stub such as 127.0.0.1.
// Override with DNS_SERVERS="8.8.8.8,1.1.1.1"; set it empty to keep system DNS.
const dnsServers = (process.env.DNS_SERVERS ?? "8.8.8.8,1.1.1.1")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (dnsServers.length) dns.setServers(dnsServers);

const connectDB = async () => {
  try {
    // The URI has no database in its path, so the database is chosen here:
    //   APP_ENV=test (default) → MONGODB_DB_NAME_TEST  (test-comman-service)
    //   APP_ENV=live           → MONGODB_DB_NAME_LIVE  (live-comman-service)
    // MONGODB_URI_TEST / MONGODB_URI_LIVE may override MONGODB_URI per
    // environment (e.g. a separate live cluster).
    const appEnv = (process.env.APP_ENV || "test").toLowerCase();
    if (!["test", "live"].includes(appEnv)) {
      throw new Error(`APP_ENV must be "test" or "live", got "${appEnv}"`);
    }
    const suffix = appEnv.toUpperCase();
    const uri = process.env[`MONGODB_URI_${suffix}`] || process.env.MONGODB_URI;
    const dbName = process.env[`MONGODB_DB_NAME_${suffix}`];
    if (!dbName) {
      throw new Error(`MONGODB_DB_NAME_${suffix} is not set in .env`);
    }

    const conn = await mongoose.connect(uri, { dbName });
    console.log(`APP_ENV=${appEnv}, database=${dbName}`);

    console.log(`MongoDB Connected Successfully!`);
    console.log(`Host: ${conn.connection.host}`);
    console.log(`Database: ${conn.connection.name}`);
    console.log(`Port: ${conn.connection.port}`);

    // Handle connection events
    mongoose.connection.on("error", (err) => {
      console.error("MongoDB connection error:", err);
    });

    mongoose.connection.on("disconnected", () => {
      console.log("MongoDB disconnected");
    });

    // Handle application termination
    process.on("SIGINT", async () => {
      await mongoose.connection.close();
      console.log("MongoDB connection closed through app termination");
      process.exit(0);
    });
  } catch (error) {
    console.error("Database connection error:", error.message);
    process.exit(1);
  }
};

module.exports = connectDB;
