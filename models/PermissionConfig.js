const mongoose = require("mongoose");

const PermissionConfigSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: "GLOBAL_PERMISSION_CONFIG_DRIVER_APP",
    },
    battery: {
      type: Boolean,
      default: false,
    },
    overlay: {
      type: Boolean,
      default: false,
    },
    notification: {
      type: Boolean,
      default: false,
    },
    location: {
      type: Boolean,
      default: false,
    },
    background: {
      type: Boolean,
      default: false,
    },
    phone: {
      type: Boolean,
      default: false,
    },
    picturesAndRecordVideo: {
      type: Boolean,
      default: false,
    },
    // Minimum app version; anything lower gets "Update required" from
    // /check-version-if-require-dupdate. Format: "major.minor.patch"
    latestAppVersion: {
      type: String,
      default: "1.0.14",
      trim: true,
      match: /^\d+(\.\d+)*$/,
    },
  },
  { timestamps: true },
);

module.exports = mongoose.model("PermissionConfig", PermissionConfigSchema);
