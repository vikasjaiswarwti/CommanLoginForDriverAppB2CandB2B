const PermissionConfig = require("../models/PermissionConfig");

const checkversionifrequiredupdate = async (req, res) => {
  try {
    const { version } = req.body;

    if (!version) {
      return res
        .status(400)
        .json({ required: false, message: "Version is required" });
    }

    // Minimum version lives on GLOBAL_PERMISSION_CONFIG_DRIVER_APP — change it
    // via /create-or-update/permission-config { latestAppVersion: "x.y.z" }
    const config = await PermissionConfig.findOneAndUpdate(
      { _id: "GLOBAL_PERMISSION_CONFIG_DRIVER_APP" },
      {},
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );

    const isUpToDate = isVersionUpToDate(
      String(version),
      config.latestAppVersion,
    );

    if (isUpToDate) {
      return res
        .status(200)
        .json({ required: false, message: "Version is up-to-date" });
    } else {
      return res
        .status(200)
        .json({ required: true, message: "Update required" });
    }
  } catch (err) {
    console.error("Version Check Error:", err.message);
    return res
      .status(500)
      .json({ required: false, message: "Internal server error" });
  }
};

//return true if version is up-to date and false update is required
const isVersionUpToDate = (providedVersion, latestVersion) => {
  const provided = providedVersion.split(".").map(Number);
  const latest = latestVersion.split(".").map(Number);

  for (let i = 0; i < latest.length; i++) {
    if (provided[i] < latest[i]) {
      return false;
    } else if (provided[i] > latest[i]) {
      return true;
    }
  }
  return true;
};

module.exports = {
  checkversionifrequiredupdate,
};
