// controllers/CommonDriverApp/permissionConfigController.js

const PermissionConfig = require("../models/PermissionConfig");

// ─────────────────────────────────────────────
// Permission config endpoints
// ─────────────────────────────────────────────

const getPermissionConfig = async (req, res) => {
  try {
    const config = await PermissionConfig.findOneAndUpdate(
      { _id: "GLOBAL_PERMISSION_CONFIG_DRIVER_APP" },
      {},
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    return res.status(200).json({
      success: true,
      data: {
        Battery: config.battery,
        Overlay: config.overlay,
        Notification: config.notification,
        Location: config.location,
        Background: config.background,
        Phone: config.phone,
        picturesAndRecordVideo: config.picturesAndRecordVideo,
      },
    });
  } catch (error) {
    console.error("Permission Config Fetch Error:", error.message);
    return res
      .status(500)
      .json({ success: false, message: "Internal Server Error" });
  }
};

const createOrUpdatePermissionConfig = async (req, res) => {
  try {
    const {
      battery,
      overlay,
      notification,
      location,
      background,
      phone,
      picturesAndRecordVideo,
    } = req.body;

    const update = {};
    if (typeof battery === "boolean") update.battery = battery;
    if (typeof overlay === "boolean") update.overlay = overlay;
    if (typeof notification === "boolean") update.notification = notification;
    if (typeof location === "boolean") update.location = location;
    if (typeof background === "boolean") update.background = background;
    if (typeof phone === "boolean") update.phone = phone;
    if (typeof picturesAndRecordVideo === "boolean")
      update.picturesAndRecordVideo = picturesAndRecordVideo;

    const updatedConfig = await PermissionConfig.findOneAndUpdate(
      { _id: "GLOBAL_PERMISSION_CONFIG_DRIVER_APP" },
      { $set: update },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    return res.status(200).json({
      success: true,
      message: "Permission configuration saved successfully",
      data: updatedConfig,
    });
  } catch (error) {
    console.error("Permission Config Save Error:", error.message);
    return res
      .status(500)
      .json({ success: false, message: "Internal Server Error" });
  }
};

module.exports = {
  getPermissionConfig,
  createOrUpdatePermissionConfig,
};
