// routes.js
const { Router } = require("express");
const {
  checkWhenToSwitchToB2BApp,
  createOrUpdateConfig,
  loginCommonForDriver,
  getCommanAuthDetailOnEveryHit,
} = require("../controllers/loginController");

const {
  checkversionifrequiredupdate,
} = require("../controllers/versionController");

const { validateOtp } = require("../controllers/validateOtpController");

const DriverAppAuthRouter = Router(); // Create an instance of the Router

// login
DriverAppAuthRouter.get(
  "/check-when-to-switch-b2b-app",
  checkWhenToSwitchToB2BApp,
);

DriverAppAuthRouter.post(
  "/create-or-update/config-for-app",
  createOrUpdateConfig,
);

// login api
DriverAppAuthRouter.post("/login-common-driver", loginCommonForDriver);

// validate after login
DriverAppAuthRouter.post("/validate-common-otp", validateOtp);

//
DriverAppAuthRouter.post(
  "/get-comman-auth-detail-on-every-hit",
  getCommanAuthDetailOnEveryHit,
);

// version route ----

DriverAppAuthRouter.post(
  "/check-version-if-require-dupdate",
  checkversionifrequiredupdate,
);

module.exports = DriverAppAuthRouter; // Export the router instance directly
