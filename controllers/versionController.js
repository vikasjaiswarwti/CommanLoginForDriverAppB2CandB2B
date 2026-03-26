const checkversionifrequiredupdate = async (req, res) => {
  try {
    const { version } = req.body;

    if (!version) {
      return res
        .status(400)
        .json({ required: false, message: "Version is required" });
    }

    const isUpToDate = isVersionUpToDate(version, "1.0.0");

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
