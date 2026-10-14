// routes.js
const { Router } = require("express");
const {
  checkWhenToSwitchToB2BApp,
  createOrUpdateConfig,
  loginCommonForDriver,
  getCommanAuthDetailOnEveryHit,
  logoutCommonForDriver,
} = require("../controllers/loginController");

const {
  checkversionifrequiredupdate,
} = require("../controllers/versionController");

const {
  validateOtp,
  getOtpByVehicleNumber,
} = require("../controllers/validateOtpController");

const {
  getPermissionConfig,
  createOrUpdatePermissionConfig,
} = require("../controllers/permissionConfigController");

const {
  updateDriverOnOffStatus,
  getDriverOnOffStatus,
} = require("../controllers/dutyController");

const {
  fetchBookingList,
  fetchBookingDetails,
} = require("../controllers/bookingController");

const {
  getHelpdesk,
  createOrUpdateHelpdesk,
} = require("../controllers/helpdeskController");

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

// logout api
DriverAppAuthRouter.post("/logout-common-driver", logoutCommonForDriver);

// validate after login
DriverAppAuthRouter.post("/validate-common-otp", validateOtp);

// fetch current otp for a vehicle (support/debug lookup)
DriverAppAuthRouter.post("/get-otp-by-vehicle-number", getOtpByVehicleNumber);

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

// permission config routes ----

DriverAppAuthRouter.get("/get-permission-config", getPermissionConfig);

DriverAppAuthRouter.post(
  "/create-or-update/permission-config",
  createOrUpdatePermissionConfig,
);

// driver on/off duty status (Wise or MMT, same payload + response) ----

DriverAppAuthRouter.post(
  "/update-driver-on-off-status",
  updateDriverOnOffStatus,
);

DriverAppAuthRouter.post("/get-driver-on-off-status", getDriverOnOffStatus);

// booking list — Wise (B2B) + MMT (B2C) merged, newest first.
// Same query as Wise BookingList: AllocationID, Gcm, Month, CabId, userid, token
DriverAppAuthRouter.get("/fetch-booking-list", fetchBookingList);

// booking details — ?BookingID=…&BookingType=B2B|B2C (B2B also: userid[, token, AllocationID])
DriverAppAuthRouter.get("/fetch-booking-details", fetchBookingDetails);

// helpdesk contacts ----

// ?type=B2B|B2C&branch=Delhi (both optional)
DriverAppAuthRouter.get("/get-helpdesk", getHelpdesk);

DriverAppAuthRouter.post("/create-or-update/helpdesk", createOrUpdateHelpdesk);

module.exports = DriverAppAuthRouter; // Export the router instance directly
