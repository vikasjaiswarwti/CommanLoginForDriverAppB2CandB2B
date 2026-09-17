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
  },
  { timestamps: true },
);

module.exports = mongoose.model("PermissionConfig", PermissionConfigSchema);
